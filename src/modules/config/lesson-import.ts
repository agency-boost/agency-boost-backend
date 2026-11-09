import { createHash } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { SOURCE_READER } from '@/common/i18n/reader';
import { render } from '@/common/i18n/sentence';
import { HTML_MIME_TYPE, LESSONS } from '@/domain/constants';
import type { Asset } from '@/modules/assets/asset.schema';
import type { StoragePort } from '@/modules/assets/storage.port';
import { CONTENT_BOUNDS } from '@/modules/training/training-content';
import type { TrainingModule } from '@/modules/training/training-module.schema';
import {
  trainingTaxonomyProblems, type TrainingContentPayload, type TrainingTaxonomyPayload,
} from '@/modules/training/training-payload';
import type { CompanyTemplate } from './company-template.schema';
import { titleKey, type Lesson, type LessonSet } from './lesson-files';
import type { NamedTemplate } from './named-template.schema';

/**
 * **The owner's 23 lessons, attached to a company's template modules** (P19.6-T3 AC-1, AC-2; the 11-03 handover's §B6
 * *Then upload the HTML*; ADR-0208 §1, ADR-0217). Run by the operator per company (`cli/import-lessons.ts`) and by the
 * demo seed.
 *
 * **Through P19.4-T1's template material** (ADR-0208 §1): each lesson's served copy and its A4 PDF are stored once per
 * company as **company assets** (`companyId`, no `kpmId`), under `<prefix>/company/<companyId>/training/lessons/`, and
 * every module mapped to the lesson names them **first**, the lesson then its PDF, before whatever material the module
 * already holds. The template's *Training* section gets **a new published version** holding them — the draft-then-
 * *Terbitkan* a Super Admin would make — so a KPM made from the template afterwards has them on day one (UI-162 *Done
 * when*, ADR-0208 §2). **No KPM is written**: a KPM that exists receives them by the Super Admin's push from *Dipakai N
 * KPM*, which keeps a KPM's own copy unless confirmed a second time (AC-4; ADR-0208 §4).
 *
 * **Which lesson a module takes** (AC-1; §B6 *"as the PDFs are mapped now"*), first that answers:
 * 1. **by code**, from `byCode`: production's KaiZen mapping, read from that KPM's own PDFs (`lessonMapFromOffice`), or
 *    the demo seed's own table;
 * 2. **by title**: a module titled as a lesson in `index.html` — name and description together, as P19.6-T4 splits
 *    them, or the name alone where only one lesson has it.
 *
 * A module neither names stays as it is, reported **unmapped**.
 *
 * **Re-runnable, and a second run changes nothing** (AC-2): a module whose first items are already the lesson's current
 * files is *unchanged*; a template none of whose modules changes gets no version; a file storage already holds is not
 * sent again, and an asset already recorded is not recorded again. A refreshed lesson is a new file (its name carries
 * its hash), which replaces the old one's items, so a published version's files never change (ADR-0032).
 *
 * **It refuses to publish past a draft** — the Super Admin's draft carries the next version's number — and says so.
 * Plain models, as `importProposalFields` takes them: the operator's command connects with mongoose alone.
 */

/** Where a module's lesson came from: `byCode` (production's mapping, or the seed's) or its title. */
export type LessonSource = 'code' | 'title';

/** What happened to one module. */
export type ModuleOutcome = 'attached' | 'unchanged' | 'unmapped' | 'full';

export interface ModuleReport {
  code: string;
  title: string;
  /** The lesson's number, or `null` when unmapped. */
  lesson: number | null;
  source: LessonSource | null;
  outcome: ModuleOutcome;
}

export interface TemplateReport {
  templateId: string;
  name: string;
  /** `would publish` is a dry run's. */
  outcome: 'published' | 'would publish' | 'unchanged' | 'skipped';
  /** Why a template was skipped. */
  reason: string | null;
  /** The version published (or a dry run's next), else the newest published read. */
  version: number | null;
  modules: ModuleReport[];
}

export interface LessonImportReport {
  dryRun: boolean;
  templates: TemplateReport[];
  /** Modules given their lesson in this run (or that a dry run would give it). */
  attached: number;
  unchanged: number;
  unmapped: number;
  /** Modules mapped to a lesson whose *File* section has no room for two more (`CONTENT_BOUNDS.perSection`). */
  full: number;
  /** Template versions published. */
  published: number;
  /** Files sent to storage. */
  sent: number;
  /** Asset rows recorded. */
  recorded: number;
}

/** The audit row left for each version the import publishes. */
export interface LessonImportAuditEntry {
  action: 'company_template.published';
  targetCollection: 'companyTemplates';
  targetId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface LessonImportDeps {
  namedTemplates: Model<NamedTemplate>;
  companyTemplates: Model<CompanyTemplate>;
  assets: Model<Asset>;
  /** Where the lessons are stored; `null` only for a dry run, which stores nothing. */
  storage: StoragePort | null;
  clock: Clock;
  /** Who the version names (`createdBy`, `updatedBy`): a job, never a person. */
  actor: string;
  /** The audit row of each version published; absent, none is written (the demo seed). */
  audit?: (entry: LessonImportAuditEntry) => Promise<void>;
}

export interface LessonImportOptions {
  /** The lesson each module takes, by module code: wins over the title. */
  byCode?: Readonly<Record<string, number>>;
  /** One template of the company; absent, every active one. */
  templateId?: string;
  /** Report what would be attached, and write and send nothing. */
  dryRun?: boolean;
}

/** The import cannot run as asked: what is wrong, in the operator's words. */
export class LessonImportError extends Error {}

type ContentFile = NonNullable<TrainingContentPayload['files']>[number];
type PayloadModule = TrainingTaxonomyPayload['modules'][number] & { description?: string | null };
interface Resolved { lesson: Lesson; source: LessonSource }
interface StoredFile { storageKey: string; mimeType: string; bytes: number }
interface StoredLesson { html: StoredFile; pdf: StoredFile | null }

const PDF_MIME_TYPE = 'application/pdf';

/**
 * **A lesson item's id**: derived from the module, the lesson's folder and the kind, so a second run names the same
 * item, a refreshed lesson keeps its id — an agent who opened it keeps *Sudah dibuka* — and another lesson is another
 * item.
 */
export function lessonItemId(moduleCode: string, folder: string, kind: 'html' | 'pdf'): string {
  return createHash('sha256').update(['lesson', moduleCode.toUpperCase(), folder, kind].join('\u0000')).digest('hex').slice(0, 24);
}

/** The label each item carries: the index's title; the PDF's with `.pdf`, as a file's name reads. */
const labelsOf = (lesson: Lesson) => ({ html: lesson.title, pdf: `${lesson.title}.pdf` });

/** Whether an item is one the import made: by its folder, so an older copy of a lesson is recognised too. */
const isLessonFile = (file: { storageKey?: string }) => typeof file.storageKey === 'string'
  && file.storageKey.includes(`/${LESSONS.FOLDER}/`);

/** The items a module takes for its lesson, against what storage holds (or, unstored yet, the names it will hold). */
function itemsFor(code: string, lesson: Lesson, stored: StoredLesson | null): ContentFile[] {
  const labels = labelsOf(lesson);
  const at = (name: string) => `…/${LESSONS.FOLDER}/${name}`;
  const items: ContentFile[] = [{
    id: lessonItemId(code, lesson.folder, 'html'), label: labels.html, mimeType: HTML_MIME_TYPE,
    storageKey: stored?.html.storageKey ?? at(lesson.htmlName), bytes: stored?.html.bytes ?? lesson.html.length,
  }];
  if (lesson.pdf && lesson.pdfName) {
    items.push({
      id: lessonItemId(code, lesson.folder, 'pdf'), label: labels.pdf, mimeType: PDF_MIME_TYPE,
      storageKey: stored?.pdf?.storageKey ?? at(lesson.pdfName), bytes: stored?.pdf?.bytes ?? lesson.pdf.length,
    });
  }
  return items;
}

/** Whether a module's files already begin with this lesson's current items, and hold no other lesson's. */
function isCurrent(files: readonly ContentFile[], wanted: readonly ContentFile[]): boolean {
  const leaf = (key: string) => key.slice(key.lastIndexOf('/') + 1);
  const same = wanted.every((item, i) => {
    const held = files[i];
    return !!held && held.id === item.id && held.label === item.label && held.mimeType === item.mimeType
      && typeof held.storageKey === 'string' && isLessonFile(held) && leaf(held.storageKey) === leaf(item.storageKey);
  });
  return same && !files.slice(wanted.length).some(isLessonFile);
}

/** The resolver of AC-1: by code, then by title. */
function resolverOf(set: LessonSet, byCode: Readonly<Record<string, number>>) {
  const byNumber = new Map(set.lessons.map((lesson) => [lesson.number, lesson]));
  const group = (keyOf: (lesson: Lesson) => string) => {
    const map = new Map<string, Lesson[]>();
    for (const lesson of set.lessons) map.set(keyOf(lesson), [...(map.get(keyOf(lesson)) ?? []), lesson]);
    return map;
  };
  const whole = group((lesson) => titleKey(lesson.title));
  const name = group((lesson) => titleKey(lesson.title.split(':')[0]));
  const one = (hits: Lesson[] | undefined) => (hits?.length === 1 ? hits[0] : null);
  const codes = new Map(Object.entries(byCode).map(([code, number]) => [code.trim().toUpperCase(), number]));

  return (module: PayloadModule): Resolved | null => {
    const numbered = codes.get(String(module.code).trim().toUpperCase());
    const coded = numbered === undefined ? undefined : byNumber.get(numbered);
    if (coded) return { lesson: coded, source: 'code' };
    const title = String(module.title ?? '');
    const lesson = one(whole.get(titleKey(`${title} ${module.description ?? ''}`)))
      ?? one(whole.get(titleKey(title)))
      ?? one(name.get(titleKey(title)));
    return lesson ? { lesson, source: 'title' } : null;
  };
}

/**
 * **Attach the lessons to one company's template modules** (AC-1, AC-2). Every active template of the company, or the
 * one named; the report says, per template and module, what was attached, left, or could not be mapped.
 */
export async function importLessons(
  deps: LessonImportDeps,
  companyId: string,
  set: LessonSet,
  options: LessonImportOptions = {},
): Promise<LessonImportReport> {
  const dryRun = options.dryRun === true;
  if (!dryRun && !deps.storage) {
    throw new LessonImportError('Storage is not configured (GCS_BUCKET): the lessons have nowhere to be stored.');
  }
  if (options.templateId !== undefined && !Types.ObjectId.isValid(options.templateId)) {
    throw new LessonImportError(`"${options.templateId}" is not a template id.`);
  }
  const templates = await deps.namedTemplates.find({
    companyId, status: 'active', deletedAt: null, ...(options.templateId ? { _id: options.templateId } : {}),
  }).sort({ isDefault: -1, _id: 1 }).lean().exec();
  if (options.templateId && templates.length === 0) {
    throw new LessonImportError(`The company has no active template ${options.templateId}.`);
  }

  const report: LessonImportReport = {
    dryRun, templates: [], attached: 0, unchanged: 0, unmapped: 0, full: 0, published: 0, sent: 0, recorded: 0,
  };
  const resolve = resolverOf(set, options.byCode ?? {});
  const stored = new Map<number, StoredLesson>();

  /** A lesson's two files in storage and the registry, once per run: a key storage holds is not sent again. */
  const store = async (lesson: Lesson): Promise<StoredLesson> => {
    const known = stored.get(lesson.number);
    if (known) return known;
    const put = async (name: string, mimeType: string, body: Buffer, filename: string): Promise<StoredFile> => {
      const held = await deps.storage!.putObject({
        owner: { kind: 'company', companyId }, folder: LESSONS.FOLDER, name, mimeType, body,
      });
      if (held.mimeType !== mimeType) {
        throw new LessonImportError(`Storage holds ${held.storageKey} as ${held.mimeType}, not ${mimeType}.`);
      }
      if (held.sent) report.sent += 1;
      if (!(await deps.assets.exists({ storageKey: held.storageKey }))) {
        await deps.assets.create({
          kpmId: null, companyId, templateId: null, storageKey: held.storageKey, mimeType: held.mimeType,
          bytes: held.bytes, originalFilename: filename, uploadedByMembershipId: null, refCount: 0,
          uploadState: 'confirmed', deletedAt: null,
        });
        report.recorded += 1;
      }
      return { storageKey: held.storageKey, mimeType: held.mimeType, bytes: held.bytes };
    };
    const entry: StoredLesson = {
      html: await put(lesson.htmlName, HTML_MIME_TYPE, lesson.html, `${lesson.folder}.html`),
      pdf: lesson.pdf && lesson.pdfName ? await put(lesson.pdfName, PDF_MIME_TYPE, lesson.pdf, `${lesson.folder}.pdf`) : null,
    };
    stored.set(lesson.number, entry);
    return entry;
  };

  for (const template of templates) {
    const templateId = String(template._id);
    const one: TemplateReport = {
      templateId, name: template.name, outcome: 'unchanged', reason: null, version: null, modules: [],
    };
    report.templates.push(one);
    const scope = { companyId, templateId, kind: 'training_taxonomy' as const, deletedAt: null };
    if (await deps.companyTemplates.exists({ ...scope, status: 'draft' })) {
      Object.assign(one, { outcome: 'skipped', reason: 'a draft of its Training waits: publish or discard it, then run this again' });
      continue;
    }
    const newest = await deps.companyTemplates.findOne({ ...scope, status: 'published' }).sort({ version: -1 }).lean().exec();
    if (!newest) {
      Object.assign(one, { outcome: 'skipped', reason: 'its Training has no published version' });
      continue;
    }
    one.version = newest.version;
    const payload = structuredClone(newest.payload) as unknown as Partial<TrainingTaxonomyPayload>;

    const changes: { module: PayloadModule; lesson: Lesson }[] = [];
    for (const module of (payload.modules ?? []) as PayloadModule[]) {
      const found = resolve(module);
      const row: ModuleReport = {
        code: module.code, title: module.title, lesson: found?.lesson.number ?? null, source: found?.source ?? null,
        outcome: 'unmapped',
      };
      one.modules.push(row);
      if (!found) continue;
      const files = module.content?.files ?? [];
      const wanted = itemsFor(module.code, found.lesson, stored.get(found.lesson.number) ?? null);
      if (isCurrent(files, wanted)) {
        row.outcome = 'unchanged';
      } else if (files.filter((f) => !isLessonFile(f)).length + wanted.length > CONTENT_BOUNDS.perSection) {
        row.outcome = 'full';
      } else {
        row.outcome = 'attached';
        changes.push({ module, lesson: found.lesson });
      }
    }
    if (changes.length === 0) continue;
    if (dryRun) {
      Object.assign(one, { outcome: 'would publish', version: newest.version + 1 });
      continue;
    }

    const before = new Set((payload.modules ?? []).flatMap((m) => (m.content?.files ?? []).map((f) => f.storageKey)));
    for (const { module, lesson } of changes) {
      const items = itemsFor(module.code, lesson, await store(lesson));
      const content = module.content ?? {};
      module.content = {
        files: [...items, ...(content.files ?? []).filter((f) => !isLessonFile(f))],
        videos: content.videos ?? [],
        links: content.links ?? [],
      };
    }
    const problems = trainingTaxonomyProblems(payload);
    if (problems.length > 0) {
      Object.assign(one, { outcome: 'skipped', reason: `its Training would not publish: ${render(problems[0], SOURCE_READER)}` });
      one.modules.forEach((m) => { if (m.outcome === 'attached') m.outcome = 'unchanged'; });
      continue;
    }

    const version = newest.version + 1;
    const now = deps.clock.now();
    let created: { _id: unknown } | null;
    try {
      created = await deps.companyTemplates.create({
        ...scope, version, revision: (newest.revision ?? 0) + 1, status: 'published',
        payload: payload as unknown as Record<string, unknown>, publishedAt: now, migratedFrom: null,
        createdBy: deps.actor, updatedBy: deps.actor,
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      created = null;
    }
    if (!created) {
      // A Super Admin's draft or publish landed between the read and the write: nothing of this template was written.
      Object.assign(one, { outcome: 'skipped', reason: 'its Training changed while this ran: run this again' });
      one.modules.forEach((m) => { if (m.outcome === 'attached') m.outcome = 'unchanged'; });
      continue;
    }
    Object.assign(one, { outcome: 'published', version });
    report.published += 1;

    // A file a template names is held, so the orphan sweep does not report it (as `retainCompanyCopies` does).
    const added = [...new Set((payload.modules ?? []).flatMap((m) => (m.content?.files ?? []).map((f) => f.storageKey)))]
      .filter((key) => !before.has(key));
    if (added.length > 0) {
      await deps.assets.updateMany(
        { companyId, storageKey: { $in: added }, deletedAt: null }, { $inc: { refCount: 1 } },
      ).exec();
    }
    await deps.audit?.({
      action: 'company_template.published',
      targetCollection: 'companyTemplates',
      targetId: String(created._id),
      before: { version: newest.version },
      after: {
        companyId, templateId, kind: 'training_taxonomy', version, reason: 'lesson_import',
        modules: changes.map(({ module, lesson }) => ({ code: module.code, lesson: lesson.number })),
      },
    });
  }

  for (const template of report.templates) {
    for (const module of template.modules) {
      if (module.outcome === 'attached') report.attached += 1;
      else if (module.outcome === 'unchanged') report.unchanged += 1;
      else if (module.outcome === 'full') report.full += 1;
      else report.unmapped += 1;
    }
  }
  return report;
}

/** How a KPM's own PDF was recognised as a lesson. */
export interface OfficeLessonMap {
  /** The lesson each module's own PDF is, by module code. */
  byCode: Record<string, number>;
  /** Modules holding a PDF that is no lesson of the set, or two different lessons. */
  unread: string[];
}

/**
 * **Production's mapping, read from the KPM that holds it** (AC-1; the 11-03 handover's Part A: *"each of the 31 KaiZen
 * training modules now has exactly one A4 lesson PDF … The 8 extra Manajemen tim modules reuse PDFs 16, 17 and 20"*).
 *
 * Each module's own material (`officeContent`, else what it was given) is read, never written. A PDF is a lesson's when
 * its size is one that lesson's PDF was delivered at, the size alone deciding where only one lesson has it; otherwise
 * when its label, or the file's original name, starts with the lesson's number (`"16 1-on-1 check-in … .pdf"`). A module
 * whose PDFs are two different lessons, or none of the set, is `unread`.
 */
export async function lessonMapFromOffice(
  deps: { trainingModules: Model<TrainingModule>; assets: Model<Asset> },
  kpmId: string,
  set: LessonSet,
): Promise<OfficeLessonMap> {
  const modules = await deps.trainingModules.find({ kpmId, deletedAt: null }).lean().exec();
  const bySize = new Map<number, number[]>();
  for (const lesson of set.lessons) {
    for (const size of lesson.pdfSizes) bySize.set(size, [...(bySize.get(size) ?? []), lesson.number]);
  }
  const numbers = new Set(set.lessons.map((lesson) => lesson.number));
  const leading = (text: string | null | undefined) => {
    const match = /^\s*(\d{1,2})(?!\d)/.exec(text ?? '');
    return match && numbers.has(Number(match[1])) ? Number(match[1]) : null;
  };

  const pdfsOf = (m: (typeof modules)[number]) => ((m.officeContent ?? m.companyContent)?.files ?? [])
    .filter((f) => f.mimeType === PDF_MIME_TYPE);
  const keys = modules.flatMap((m) => pdfsOf(m).map((f) => f.storageKey));
  const names = new Map((await deps.assets.find({ storageKey: { $in: keys } }).lean().exec())
    .map((a) => [a.storageKey, a.originalFilename]));

  const map: OfficeLessonMap = { byCode: {}, unread: [] };
  for (const module of modules) {
    const pdfs = pdfsOf(module);
    if (pdfs.length === 0) continue;
    const found = new Set(pdfs.map((file) => {
      const sized = bySize.get(file.bytes);
      if (sized?.length === 1) return sized[0];
      return leading(file.label) ?? leading(names.get(file.storageKey));
    }).filter((n): n is number => n !== null));
    if (found.size === 1) map.byCode[module.code] = [...found][0];
    else map.unread.push(module.code);
  }
  return map;
}
