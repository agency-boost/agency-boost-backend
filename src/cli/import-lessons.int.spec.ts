import { Writable } from 'node:stream';
import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { configModule, provisionFrom } from '../../test/config-module';
import { DELIVERED_LESSONS, pdfSize, writeLessonFolder, type LessonFolder } from '../../test/lesson-folder';
import { StubStorage } from '../../test/stub-storage';
import { IMPORT_ACTOR, parseArgs, run, USAGE } from './import-lessons';

const NOW = new Date('2026-11-06T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const sa = RequestContext.platform('root');
const col = (name: string) => mongoose.connection.db!.collection(name);

function capture(): Writable & { text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _e, done) { chunks.push(String(chunk)); done(); } });
  return Object.assign(stream, { text: () => chunks.join('') });
}

/** Production's 31 modules: 23 titled as the lessons, and the 8 newer Manajemen tim modules. */
function thirtyOneModules() {
  return {
    categories: [{ code: 'SALES', label: 'Sales', description: null }, { code: 'TEAM_MANAGEMENT', label: 'Manajemen tim', description: null }],
    skills: [
      { code: 'ALL', categoryCode: 'SALES', label: 'Semua' },
      { code: 'TEAM', categoryCode: 'TEAM_MANAGEMENT', label: 'Tim' },
    ],
    modules: [
      ...DELIVERED_LESSONS.map((lesson, i) => ({
        code: `LESSON_MODULE_${String(i + 1).padStart(2, '0')}`, skillCode: 'ALL', title: lesson.title, publishState: 'published',
      })),
      ...[16, 17, 20, 16, 17, 20, 16, 20].map((_, k) => ({
        code: `TEAM_EXTRA_${k + 1}`, skillCode: 'TEAM', title: `Modul tim tambahan ${k + 1}`, publishState: 'published',
      })),
    ],
  };
}

/**
 * **P19.6-T3 AC-1, AC-2 — the operator's import** (the 11-03 handover's §B6): the command against the in-memory database
 * the way the VM runs it — its own connection, the environment it is given, the folder as an argument — onto
 * Prudential's template, with KaiZen's own PDFs as the mapping. Storage is the port's stub: a spec never reaches the
 * vendor.
 */
describe('P19.6-T3 import-lessons', () => {
  let env: Record<string, string>;
  let wired: ReturnType<typeof configModule>;
  let folder: LessonFolder;
  let storage: StubStorage;
  let templateId: string;
  let kaizen: string;

  beforeAll(async () => {
    const uri = await startMongo();
    env = { MONGODB_URI: uri, MONGODB_DB_NAME: mongoose.connection.db!.databaseName };
    wired = configModule(NOW);
    folder = writeLessonFolder();
  });
  afterAll(async () => {
    folder.remove();
    await stopMongo();
  });
  beforeEach(async () => {
    await clearCollections();
    storage = new StubStorage();
    const companies = wired.companies as unknown as mongoose.Model<never>;
    const prudential = await companies.create({ _id: COMPANY, name: 'Prudential', slug: 'prudential' } as never);
    templateId = String((await wired.namedTemplates.createFirst(sa, prudential as never))._id);
    await wired.templateService.saveDraft(sa, COMPANY, 'training_taxonomy', thirtyOneModules(), templateId);
    await wired.templateService.publish(sa, COMPANY, 'training_taxonomy', templateId);

    // KaiZen, made from the template, with one A4 lesson PDF of its own in each module (Part A).
    const kpms = wired.kpms as unknown as mongoose.Model<never>;
    const _id = new mongoose.Types.ObjectId();
    const startFrom = { kind: 'template' as const, templateId };
    const plan = await wired.provisioning.planFor(COMPANY, startFrom);
    await kpms.create({ _id, companyId: COMPANY, code: '00001', branchName: 'KaiZen Family', startedFrom: plan.startedFrom } as never);
    await provisionFrom(wired, String(_id), COMPANY, startFrom);
    kaizen = String(_id);
    const lessons: [string, number][] = [
      ...DELIVERED_LESSONS.map((_, i) => [`LESSON_MODULE_${String(i + 1).padStart(2, '0')}`, i + 1] as [string, number]),
      ...[16, 17, 20, 16, 17, 20, 16, 20].map((n, k) => [`TEAM_EXTRA_${k + 1}`, n] as [string, number]),
    ];
    for (const [code, n] of lessons) {
      await col('trainingModules').updateOne({ kpmId: kaizen, code }, { $set: { officeContent: {
        files: [{ id: `own-${code}`, label: 'default.pdf', storageKey: `dev/${kaizen}/training/${code}`, mimeType: 'application/pdf', bytes: pdfSize(n) }],
        videos: [], links: [],
      } } });
    }
  });

  const io = (over: { storage?: StubStorage | null; env?: Record<string, string> } = {}) => {
    const out = capture();
    const err = capture();
    return {
      stdout: out, stderr: err, env: over.env ?? env, out, err,
      storage: over.storage === undefined ? storage : over.storage, clock: new FixedClock(NOW),
    };
  };
  const lastLine = (text: string) => text.trim().split('\n').at(-1);

  describe('its arguments', () => {
    it('P19.6-T3 AC-2 takes the company and the folder, with --from-kpm, --template and --dry-run', () => {
      expect(parseArgs(['prudential', '/lessons'])).toEqual({
        company: 'prudential', folder: '/lessons', fromKpm: null, templateId: null, dryRun: false,
      });
      expect(parseArgs(['prudential', '/lessons', '--from-kpm', '00001', '--dry-run', '--template', 'abc'])).toEqual({
        company: 'prudential', folder: '/lessons', fromKpm: '00001', templateId: 'abc', dryRun: true,
      });
    });

    it.each([[[]], [['prudential']], [['a', 'b', 'c']], [['a', 'b', '--from-kpm']], [['a', 'b', '--from-kpm', '--dry-run']], [['a', 'b', '--force']], [['--help']]])(
      'P19.6-T3 AC-2 %j is a usage error, exit 2',
      async (argv) => {
        const call = io();
        expect(await run(argv as string[], call)).toBe(2);
        expect(call.err.text()).toContain(USAGE.split('\n')[0]);
      },
    );
  });

  it('P19.6-T3 AC-1 the dry run prints each module’s lesson and the table by module code, and writes and sends nothing', async () => {
    const rows = await col('companyTemplates').countDocuments({});
    const call = io({ storage: null });
    expect(await run(['prudential', folder.dir, '--from-kpm', '00001', '--dry-run'], call)).toBe(0);
    const text = call.out.text();
    expect(text).toContain(`Template "Prudential template" (${templateId}): would publish version`);
    expect(text).toMatch(/TEAM_EXTRA_3\s+would attach: lesson 20 20-coaching-grow-5-whys \(by code\)/);
    expect(text).toContain('| `LESSON_MODULE_01` | Leads generation: 8 cara mendapat calon nasabah | 01 | `01-leads-generation-tactics` | code |');
    expect(text).toContain('| `TEAM_EXTRA_2` | Modul tim tambahan 2 | 17 | `17-new-agent-activation` | code |');
    expect(lastLine(text)).toBe('import-lessons Prudential (dry run, nothing written): 1 template(s), 31 module(s) would attach, '
      + '0 unchanged, 0 unmapped, 0 full; 0 version(s) published, 0 file(s) sent, 0 asset(s) recorded');
    expect(call.err.text()).toContain('KPM 00001: 31 module(s) hold a lesson\'s PDF');
    expect(await col('companyTemplates').countDocuments({})).toBe(rows);
  });

  it('P19.6-T3 AC-2 attaches every module’s lesson, reports each attachment, and a second run logs zeros', async () => {
    const call = io();
    expect(await run(['prudential', folder.dir, '--from-kpm', kaizen], call)).toBe(0);
    const text = call.out.text();
    expect(text).toMatch(/LESSON_MODULE_16\s+attached: lesson 16 16-1on1-checkin-goal-setting \(by code\)/);
    expect(lastLine(text)).toBe('import-lessons Prudential: 1 template(s), 31 module(s) attached, 0 unchanged, 0 unmapped, 0 full; '
      + '1 version(s) published, 46 file(s) sent, 46 asset(s) recorded');
    const audit = await col('auditLog').findOne({ action: 'company_template.published', actorUserId: IMPORT_ACTOR });
    expect(audit).toMatchObject({ kpmId: null, effectiveUserId: IMPORT_ACTOR, after: { reason: 'lesson_import', templateId } });

    const again = io();
    expect(await run(['prudential', folder.dir, '--from-kpm', kaizen], again)).toBe(0);
    expect(lastLine(again.out.text())).toBe('import-lessons Prudential: 1 template(s), 0 module(s) attached, 31 unchanged, 0 unmapped, 0 full; '
      + '0 version(s) published, 0 file(s) sent, 0 asset(s) recorded');
    expect(again.out.text()).toContain('unchanged at version');
    expect(await col('auditLog').countDocuments({ actorUserId: IMPORT_ACTOR })).toBe(1);
  });

  it('P19.6-T3 AC-1 without --from-kpm, the 8 newer modules are reported with their titles and left as they were', async () => {
    const call = io();
    expect(await run([COMPANY, folder.dir], call)).toBe(0);
    expect(call.out.text()).toContain('TEAM_EXTRA_1                     no lesson (title "Modul tim tambahan 1")');
    expect(lastLine(call.out.text())).toContain('23 module(s) attached, 0 unchanged, 8 unmapped');
  });

  it('P19.6-T3 AC-2 refuses what it cannot run, exit 1, and writes nothing', async () => {
    const rows = await col('companyTemplates').countDocuments({});
    const cases: [string[], ReturnType<typeof io>, RegExp][] = [
      [['allianz', folder.dir], io(), /No company "allianz"/],
      [['prudential', '/no/such/folder'], io(), /holds no index\.html/],
      [['prudential', folder.dir], io({ storage: null }), /GCS_BUCKET is not set/],
      [['prudential', folder.dir, '--from-kpm', '99999'], io(), /No KPM "99999"/],
      [['prudential', folder.dir, '--template', 'nope'], io(), /not a template id/],
      [['prudential', folder.dir], io({ env: {} }), /MONGODB_URI is not set/],
    ];
    for (const [argv, call, said] of cases) {
      expect([argv, await run(argv, call)]).toEqual([argv, 1]);
      expect(call.err.text()).toMatch(said);
    }
    expect(await col('companyTemplates').countDocuments({})).toBe(rows);
  });

  it('P19.6-T3 AC-2 builds the environment’s storage when GCS_BUCKET names one, and a dry run never calls it', async () => {
    const call = { ...io(), storage: undefined, env: { ...env, GCS_BUCKET: 'agencyboost-test-assets', STORAGE_KEY_PREFIX: 'dev' } };
    expect(await run(['prudential', folder.dir, '--dry-run'], call)).toBe(0);
    expect(lastLine(call.out.text())).toContain('(dry run, nothing written)');
  });

  it('P19.6-T3 AC-2 a database it cannot reach is a failure, exit 1, said as one', async () => {
    const call = io({ env: { MONGODB_URI: 'mongodb://127.0.0.1:9/lessons?serverSelectionTimeoutMS=200', MONGODB_DB_NAME: 'lessons' } });
    expect(await run(['prudential', folder.dir], call)).toBe(1);
    expect(call.err.text()).toContain('import-lessons failed:');
  });

  it('P19.6-T3 AC-2 a KPM code two KPMs share must be given by id', async () => {
    await col('kpms').insertOne({ companyId: '66f0000000000000000000c2', code: '00001', branchName: 'Other', deletedAt: null });
    const call = io();
    expect(await run(['prudential', folder.dir, '--from-kpm', '00001'], call)).toBe(1);
    expect(call.err.text()).toContain('More than one KPM has the code "00001": give its id.');
  });
});
