import 'reflect-metadata';
import type { Writable } from 'node:stream';
import type { ConfigService } from '@nestjs/config';
import mongoose, { Model, Types } from 'mongoose';
import { SystemClock, type Clock } from '@/common/clock/clock.port';
import { MongoTarget, mongoTargetFrom } from '@/config/mongo-target';
import { Asset, AssetSchema } from '@/modules/assets/asset.schema';
import type { StoragePort } from '@/modules/assets/storage.port';
import { storageFor } from '@/modules/assets/storage.provider';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { CompanyTemplate, CompanyTemplateSchema } from '@/modules/config/company-template.schema';
import { LessonFilesError, loadLessonSet, type LessonSet } from '@/modules/config/lesson-files';
import {
  importLessons, LessonImportError, lessonMapFromOffice, type LessonImportReport,
} from '@/modules/config/lesson-import';
import { NamedTemplate, NamedTemplateSchema } from '@/modules/config/named-template.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { TrainingModule, TrainingModuleSchema } from '@/modules/training/training-module.schema';

/**
 * **The owner's 23 lessons, attached to one company's template modules** (P19.6-T3 AC-1, AC-2; the 11-03 handover's
 * §B6 *Then upload the HTML*). The operator runs it per company, over IAP SSH, pointing it at a copy of the delivered
 * folder on the VM (`revisions/2026-11-03/files/training-modules`, copied there first):
 *
 *   sudo /opt/agencyboost/bin/import-lessons.sh prod <company id or slug> <folder> --from-kpm <KaiZen's id> --dry-run
 *   sudo /opt/agencyboost/bin/import-lessons.sh prod <company id or slug> <folder> --from-kpm <KaiZen's id>
 *
 * which copies the folder into that environment's API container and runs `node dist/cli/import-lessons.js` there, with
 * the API's own database and storage settings. **The lessons are never in the image**: the folder is an argument.
 *
 * - **`--from-kpm`** names the KPM whose own PDFs say which lesson each module takes — production's KaiZen, whose 31
 *   modules each hold one A4 lesson PDF (Part A). Read, never written. Without it a module takes the lesson titled as
 *   it is, and any other module is reported unmapped.
 * - **`--dry-run`** prints what would be attached, and the table by module code `training.md` records, and writes and
 *   sends nothing. Run it first.
 * - **`--template <id>`** limits it to one of the company's templates; otherwise every active one.
 * - **Running it twice changes nothing**: the second run's last line counts no module attached, no version published,
 *   no file sent and no asset recorded.
 * - Each version it publishes is audited `company_template.published`, `reason: 'lesson_import'`, its actor the job.
 * - Exits `0` when it ran (whatever it wrote), `2` on a usage error and `1` on any other failure.
 */
export const USAGE = 'Usage: node dist/cli/import-lessons.js <company id or slug> <lessons folder>'
  + ' [--from-kpm <KPM id or code>] [--template <template id>] [--dry-run]\n'
  + '       Attaches each lesson (its HTML, and its A4 PDF beside it) first in the company\'s template modules.';

/** Who the versions and the audit rows name: a job, as `RequestContext.forJob` names one. */
export const IMPORT_ACTOR = 'job:import-lessons';

const SERVER_SELECTION_TIMEOUT_MS = 10_000;

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

export interface Args {
  company: string;
  folder: string;
  fromKpm: string | null;
  templateId: string | null;
  dryRun: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  if (argv.some((arg) => arg === '--help' || arg === '-h')) throw new CliError(USAGE, 2);
  const positional: string[] = [];
  const args: Args = { company: '', folder: '', fromKpm: null, templateId: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--from-kpm' || arg === '--template') {
      const value = argv[i + 1]?.trim();
      if (!value || value.startsWith('-')) throw new CliError(`${arg} needs a value.\n${USAGE}`, 2);
      if (arg === '--from-kpm') args.fromKpm = value;
      else args.templateId = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new CliError(`Unknown option ${arg}.\n${USAGE}`, 2);
    } else {
      positional.push(arg.trim());
    }
  }
  if (positional.length !== 2 || positional.some((p) => p === '')) throw new CliError(USAGE, 2);
  [args.company, args.folder] = positional;
  return args;
}

/**
 * **The report**: per template what happened, and per module its lesson and outcome; with `--dry-run`, the table by
 * module code that `training.md` records; and **one summary line, last**, which a second run prints with zeros.
 */
export function describeReport(companyName: string, set: LessonSet, report: LessonImportReport): string {
  const folderOf = new Map(set.lessons.map((lesson) => [lesson.number, lesson.folder]));
  const say = report.dryRun ? { attached: 'would attach', published: 'would publish version' } : { attached: 'attached', published: 'published version' };
  const lines: string[] = [];
  for (const template of report.templates) {
    const state = template.outcome === 'skipped'
      ? `skipped: ${template.reason}`
      : template.outcome === 'unchanged'
        ? `unchanged at version ${template.version}`
        : `${say.published} ${template.version}`;
    lines.push(`Template "${template.name}" (${template.templateId}): ${state}`);
    for (const module of template.modules) {
      const lesson = module.lesson === null ? '' : `lesson ${String(module.lesson).padStart(2, '0')} ${folderOf.get(module.lesson)} (by ${module.source})`;
      const outcome = {
        attached: say.attached, unchanged: 'unchanged', unmapped: 'no lesson', full: 'not attached: its File section is full',
      }[module.outcome];
      lines.push(`  ${module.code.padEnd(32)} ${outcome}${lesson ? `: ${lesson}` : ` (title "${module.title}")`}`);
    }
  }
  if (report.dryRun) {
    lines.push('', 'For training.md, "The lessons in the modules", the table by module code:', '',
      '| Module code | Module title | Lesson | Folder | By |', '|---|---|---|---|---|');
    const seen = new Set<string>();
    for (const module of report.templates.flatMap((t) => t.modules)) {
      if (module.lesson === null || seen.has(module.code)) continue;
      seen.add(module.code);
      lines.push(`| \`${module.code}\` | ${module.title} | ${String(module.lesson).padStart(2, '0')} | \`${folderOf.get(module.lesson)}\` | ${module.source} |`);
    }
    lines.push('');
  }
  lines.push(`import-lessons ${companyName}${report.dryRun ? ' (dry run, nothing written)' : ''}: `
    + `${report.templates.length} template(s), ${report.attached} module(s) ${say.attached}, ${report.unchanged} unchanged, `
    + `${report.unmapped} unmapped, ${report.full} full; ${report.published} version(s) published, `
    + `${report.sent} file(s) sent, ${report.recorded} asset(s) recorded`);
  return `${lines.join('\n')}\n`;
}

export interface Io {
  stdout: Writable;
  stderr: Writable;
  env: Readonly<Record<string, string | undefined>>;
  /** The storage to use instead of the environment's: a spec's stub. */
  storage?: StoragePort | null;
  clock?: Clock;
}

/** The environment's storage (`GCS_BUCKET`), or `null` where none is configured. */
function storageOf(env: Io['env'], clock: Clock): StoragePort | null {
  if (!env.GCS_BUCKET?.trim()) return null;
  const read = (key: string) => env[key]?.trim() || undefined;
  const config = {
    get: read,
    getOrThrow: (key: string) => {
      const value = read(key);
      if (value === undefined) throw new Error(`${key} is not set.`);
      return value;
    },
  } as unknown as ConfigService;
  return storageFor(config, clock);
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  let connection: mongoose.Connection | null = null;
  try {
    const args = parseArgs(argv);
    const set = loadLessonSet(args.folder);
    const clock = io.clock ?? new SystemClock();
    const storage = io.storage !== undefined ? io.storage : storageOf(io.env, clock);
    if (!storage && !args.dryRun) {
      throw new CliError('GCS_BUCKET is not set: run it where the API runs, with the API\'s environment, or with --dry-run.');
    }
    const target: MongoTarget | null = mongoTargetFrom(io.env);
    if (!target) throw new CliError('MONGODB_URI is not set. Run it where the API runs, with the API\'s environment.');
    io.stderr.write(`Connecting to database "${target.dbName}" on ${target.hosts}\n`);
    const selection = /[?&]serverSelectionTimeoutMS=/i.test(target.uri)
      ? {}
      : { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS };
    connection = await mongoose.createConnection(target.uri, { dbName: target.dbName, ...selection }).asPromise();
    const companies = connection.model(Company.name, CompanySchema);
    const kpms = connection.model(Kpm.name, KpmSchema);
    const audit = connection.model(AuditLog.name, AuditLogSchema);
    const deps = {
      namedTemplates: connection.model(NamedTemplate.name, NamedTemplateSchema) as unknown as Model<NamedTemplate>,
      companyTemplates: connection.model(CompanyTemplate.name, CompanyTemplateSchema) as unknown as Model<CompanyTemplate>,
      assets: connection.model(Asset.name, AssetSchema) as unknown as Model<Asset>,
      trainingModules: connection.model(TrainingModule.name, TrainingModuleSchema) as unknown as Model<TrainingModule>,
    };

    const byId = (value: string) => Types.ObjectId.isValid(value) && value.length === 24;
    const found = await companies.findOne({
      deletedAt: null, ...(byId(args.company) ? { _id: args.company } : { slug: args.company.toLowerCase() }),
    }).lean().exec() as { _id: unknown; name: string } | null;
    if (!found) throw new CliError(`No company "${args.company}". Give its id or its slug, as /admin/companies shows it.`);
    const companyId = String(found._id);

    let byCode: Record<string, number> = {};
    if (args.fromKpm) {
      const offices = await kpms.find({
        deletedAt: null, ...(byId(args.fromKpm) ? { _id: args.fromKpm } : { code: args.fromKpm }),
      }).limit(2).lean().exec() as unknown as { _id: unknown; code: string }[];
      if (offices.length === 0) throw new CliError(`No KPM "${args.fromKpm}". Give its id, or a code only one KPM has.`);
      if (offices.length > 1) throw new CliError(`More than one KPM has the code "${args.fromKpm}": give its id.`);
      const read = await lessonMapFromOffice(deps, String(offices[0]._id), set);
      byCode = read.byCode;
      io.stderr.write(`KPM ${offices[0].code}: ${Object.keys(read.byCode).length} module(s) hold a lesson's PDF`
        + `${read.unread.length ? `; read none from ${read.unread.join(', ')}` : ''}\n`);
    }

    const report = await importLessons(
      {
        ...deps,
        storage,
        clock,
        actor: IMPORT_ACTOR,
        audit: async (entry) => {
          await audit.create({
            ...entry, kpmId: null, actorUserId: IMPORT_ACTOR, effectiveUserId: IMPORT_ACTOR, actorMembershipId: null,
          });
        },
      },
      companyId,
      set,
      { byCode, ...(args.templateId ? { templateId: args.templateId } : {}), dryRun: args.dryRun },
    );
    io.stdout.write(describeReport(found.name, set, report));
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    if (err instanceof LessonFilesError || err instanceof LessonImportError) {
      io.stderr.write(`${err.message}\n`);
      return 1;
    }
    io.stderr.write(`import-lessons failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    await connection?.close().catch(() => undefined);
  }
}

// Run as the command, never on import: the spec imports `run` and drives it itself.
if (require.main === module) {
  void run(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env })
    .then((code) => process.exit(code));
}
