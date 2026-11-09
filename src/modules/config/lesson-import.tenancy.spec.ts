import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import type { Asset } from '@/modules/assets/asset.schema';
import type { TrainingModule } from '@/modules/training/training-module.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionFrom } from '../../../test/config-module';
import { StubStorage } from '../../../test/stub-storage';
import { DELIVERED_LESSONS, pdfSize, writeLessonFolder, type LessonFolder } from '../../../test/lesson-folder';
import type { CompanyTemplate } from './company-template.schema';
import { loadLessonSet, type LessonSet } from './lesson-files';
import {
  importLessons, LessonImportError, lessonItemId, lessonMapFromOffice, type LessonImportAuditEntry, type LessonImportDeps,
} from './lesson-import';
import type { NamedTemplate } from './named-template.schema';

const NOW = new Date('2026-11-06T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const OTHER = '66f0000000000000000000c2';
const sa = RequestContext.platform('root');
const col = (name: string) => mongoose.connection.db!.collection(name);

/** The index's headings as category codes, as production's Training v7 has seven. */
const CATEGORY: Record<string, string> = {
  Sales: 'SALES', Produk: 'PRODUCT', Recruitment: 'RECRUITING', 'Manajemen tim': 'TEAM_MANAGEMENT',
  'Soft skills': 'SOFT_SKILLS', Motivasi: 'MOTIVATION', 'Perusahaan dan agency': 'COMPANY_AND_KPM',
};
/** Lesson n's module, titled as the lesson: production's 23. Codes of our own, since production's are not ours to guess. */
const moduleOf = (n: number) => `LESSON_MODULE_${String(n).padStart(2, '0')}`;
/** §B6: "the 8 newer Manajemen tim modules use lessons 16, 17 and 20" — which one each, KaiZen's PDFs say. */
const EXTRA: readonly [string, number][] = [
  ['TEAM_EXTRA_1', 16], ['TEAM_EXTRA_2', 17], ['TEAM_EXTRA_3', 20], ['TEAM_EXTRA_4', 16],
  ['TEAM_EXTRA_5', 17], ['TEAM_EXTRA_6', 20], ['TEAM_EXTRA_7', 16], ['TEAM_EXTRA_8', 20],
];

/** Production's shape: seven categories, a skill each, 31 modules — 23 titled as the lessons, 8 more in Manajemen tim. */
function thirtyOneModules() {
  return {
    categories: Object.entries(CATEGORY).map(([label, code]) => ({ code, label, description: null })),
    skills: Object.values(CATEGORY).map((code) => ({ code: `${code}_SKILL`, categoryCode: code, label: `Skill ${code}` })),
    modules: [
      ...DELIVERED_LESSONS.map((lesson, i) => ({
        code: moduleOf(i + 1), skillCode: `${CATEGORY[lesson.category]}_SKILL`, title: lesson.title, publishState: 'published',
      })),
      ...EXTRA.map(([code], k) => ({
        code, skillCode: 'TEAM_MANAGEMENT_SKILL', title: `Modul tim tambahan ${k + 1}`, publishState: 'published',
      })),
    ],
  };
}

/** The Owner of one office, as a signed-in context. */
const ownerOf = (kpmId: string) => new RequestContext(`owner-${kpmId}`, 'none', {
  membershipId: `m-owner-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);

/**
 * **The owner's lessons, attached to a company's template modules** (P19.6-T3 AC-1 to AC-4, AC-6; ADR-0208, ADR-0217),
 * against MongoDB with the services wired as the app wires them: Prudential's template holding production's 31
 * modules, **KaiZen** made from it holding one lesson PDF of its own in each (Part A), **0417** made from it holding
 * nothing of its own, and Allianz's template beside them.
 */
describe('P19.6-T3 the 23 lessons in the 31 modules', () => {
  let wired: ReturnType<typeof configModule>;
  let folder: LessonFolder;
  let set: LessonSet;
  let templateId: string;
  let otherTemplateId: string;
  let kaizen: string;
  let office0417: string;
  const audits: LessonImportAuditEntry[] = [];
  /** Storage as the run finds it: empty for each test, so what one test stored is not another's. */
  let storage: StubStorage;

  const deps = (over: Partial<LessonImportDeps> = {}): LessonImportDeps => ({
    namedTemplates: wired.namedTemplateRows as unknown as mongoose.Model<NamedTemplate>,
    companyTemplates: wired.templates as unknown as mongoose.Model<CompanyTemplate>,
    assets: wired.assetRows as unknown as mongoose.Model<Asset>,
    storage,
    clock: wired.clock,
    actor: 'job:import-lessons',
    audit: async (entry) => { audits.push(entry); },
    ...over,
  });
  const readers = () => ({
    trainingModules: mongoose.model('TrainingModuleModel') as unknown as mongoose.Model<TrainingModule>,
    assets: wired.assetRows as unknown as mongoose.Model<Asset>,
  });

  /** An office made from a company's template, recorded as `createKpm` records it, its first version published. */
  async function office(code: string, companyId: string, template: string): Promise<string> {
    const kpms = wired.kpms as unknown as mongoose.Model<never>;
    const _id = new mongoose.Types.ObjectId();
    const startFrom = { kind: 'template' as const, templateId: template };
    const plan = await wired.provisioning.planFor(companyId, startFrom);
    await kpms.create({ _id, companyId, code, branchName: `${code} Branch`, startedFrom: plan.startedFrom } as never);
    const done = await provisionFrom(wired, String(_id), companyId, startFrom);
    await kpms.updateOne({ _id } as never, { $set: { seededFrom: done.seededFrom } } as never);
    await wired.provisioning.publishInitialSnapshotFor(String(_id), RequestContext.superAdminInTenant('root', String(_id)));
    return String(_id);
  }

  /** KaiZen's own lesson PDFs (Part A): one per module, half named as uploaded, half `default.pdf` (its size decides). */
  async function kaizenOwnPdfs(kpmId: string) {
    const lessonOf = new Map<string, number>([
      ...DELIVERED_LESSONS.map((_, i) => [moduleOf(i + 1), i + 1] as [string, number]), ...EXTRA,
    ]);
    for (const [code, n] of lessonOf) {
      const storageKey = `dev/${kpmId}/training/${code}`;
      const label = n % 2 ? `${String(n).padStart(2, '0')} ${DELIVERED_LESSONS[n - 1].title}.pdf` : 'default.pdf';
      await col('assets').insertOne({
        kpmId, companyId: null, storageKey, mimeType: 'application/pdf', bytes: pdfSize(n), originalFilename: label,
        refCount: 1, uploadState: 'confirmed', deletedAt: null,
      });
      await col('trainingModules').updateOne({ kpmId, code }, { $set: { officeContent: {
        files: [{ id: `own-${code}`, label, storageKey, mimeType: 'application/pdf', bytes: pdfSize(n) }], videos: [], links: [],
      } } });
    }
  }

  /** The template's newest published training, and one module of it. */
  async function newest(template = templateId, companyId = COMPANY) {
    return (await col('companyTemplates').find({ companyId, templateId: template, kind: 'training_taxonomy', status: 'published' })
      .sort({ version: -1 }).limit(1).toArray())[0];
  }
  const filesOf = (row: { payload: { modules: { code: string; content?: { files?: Record<string, unknown>[] } }[] } }, code: string) =>
    row.payload.modules.find((m) => m.code === code)!.content?.files ?? [];

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    folder = writeLessonFolder();
    set = loadLessonSet(folder.dir);
  });
  afterAll(async () => {
    folder.remove();
    await stopMongo();
  });

  beforeEach(async () => {
    await clearCollections();
    audits.length = 0;
    storage = new StubStorage();
    const companies = wired.companies as unknown as mongoose.Model<never>;
    const prudential = await companies.create({ _id: COMPANY, name: 'Prudential', slug: 'prudential' } as never);
    const allianz = await companies.create({ _id: OTHER, name: 'Allianz Life', slug: 'allianz' } as never);
    templateId = String((await wired.namedTemplates.createFirst(sa, prudential as never))._id);
    otherTemplateId = String((await wired.namedTemplates.createFirst(sa, allianz as never))._id);
    for (const [companyId, template] of [[COMPANY, templateId], [OTHER, otherTemplateId]]) {
      await wired.templateService.saveDraft(sa, companyId, 'training_taxonomy', thirtyOneModules(), template);
      await wired.templateService.publish(sa, companyId, 'training_taxonomy', template);
    }
    kaizen = await office('00001', COMPANY, templateId);
    await kaizenOwnPdfs(kaizen);
    office0417 = await office('0417', COMPANY, templateId);
  });

  describe('the mapping (AC-1)', () => {
    it('P19.6-T3 AC-1 reads production’s mapping from KaiZen’s own PDFs: lesson n for module n, and 16, 17 and 20 for the 8 newer Manajemen tim modules', async () => {
      const read = await lessonMapFromOffice(readers(), kaizen, set);
      expect(read.unread).toEqual([]);
      expect(Object.keys(read.byCode)).toHaveLength(31);
      DELIVERED_LESSONS.forEach((_, i) => expect([moduleOf(i + 1), read.byCode[moduleOf(i + 1)]]).toEqual([moduleOf(i + 1), i + 1]));
      for (const [code, n] of EXTRA) expect([code, read.byCode[code]]).toEqual([code, n]);
    });

    it('P19.6-T3 AC-1 a KPM PDF that is no lesson, or two different lessons in one module, is read as nothing', async () => {
      await col('trainingModules').updateOne({ kpmId: kaizen, code: moduleOf(1) }, { $set: { 'officeContent.files': [
        { id: 'x', label: 'Brosur.pdf', storageKey: 'dev/x/1', mimeType: 'application/pdf', bytes: 5 },
      ] } });
      await col('trainingModules').updateOne({ kpmId: kaizen, code: moduleOf(2) }, { $push: { 'officeContent.files':
        { id: 'y', label: '05 Cross-sell.pdf', storageKey: 'dev/x/2', mimeType: 'application/pdf', bytes: 7 } } as never });
      const read = await lessonMapFromOffice(readers(), kaizen, set);
      expect(read.unread.sort()).toEqual([moduleOf(1), moduleOf(2)]);
      expect(read.byCode[moduleOf(1)]).toBeUndefined();
    });

    it('P19.6-T3 AC-1 with KaiZen’s mapping, each of the 31 modules holds its lesson first and the A4 PDF beside it, the material it had after them', async () => {
      // A module that already holds the company's link keeps it, after the lesson.
      const before = await newest();
      const read = await lessonMapFromOffice(readers(), kaizen, set);
      const report = await importLessons(deps(), COMPANY, set, { byCode: read.byCode });
      expect(report).toMatchObject({ attached: 31, unchanged: 0, unmapped: 0, full: 0, published: 1, sent: 46, recorded: 46 });
      expect(report.templates).toEqual([expect.objectContaining({ templateId, outcome: 'published', version: before.version + 1 })]);

      const row = await newest();
      expect(row.version).toBe(before.version + 1);
      expect(row).toMatchObject({ status: 'published', createdBy: 'job:import-lessons', revision: before.revision + 1 });
      const lessonFor = new Map<string, number>([...DELIVERED_LESSONS.map((_, i) => [moduleOf(i + 1), i + 1] as [string, number]), ...EXTRA]);
      for (const [code, n] of lessonFor) {
        const lesson = set.lessons[n - 1];
        const files = filesOf(row as never, code);
        expect([code, files.map((f) => f.mimeType)]).toEqual([code, ['text/html', 'application/pdf']]);
        expect(files[0]).toMatchObject({
          id: lessonItemId(code, lesson.folder, 'html'), label: lesson.title, bytes: lesson.html.length,
          storageKey: `dev/company/${COMPANY}/training/lessons/${lesson.htmlName}`,
        });
        expect(files[1]).toMatchObject({ label: `${lesson.title}.pdf`, storageKey: `dev/company/${COMPANY}/training/lessons/${lesson.pdfName}` });
      }
      // Stored once per lesson, as the company's: 23 lessons and their 23 PDFs.
      const stored = await col('assets').find({ companyId: COMPANY, storageKey: { $regex: '/training/lessons/' } }).toArray();
      expect(stored).toHaveLength(46);
      expect(stored.every((a) => a.kpmId === null && a.uploadState === 'confirmed' && a.refCount === 1)).toBe(true);
      expect(audits).toEqual([expect.objectContaining({
        action: 'company_template.published', targetCollection: 'companyTemplates',
        after: expect.objectContaining({ reason: 'lesson_import', templateId, version: row.version, kind: 'training_taxonomy' }),
      })]);
      expect((audits[0].after.modules as unknown[])).toHaveLength(31);
    });

    it('P19.6-T3 AC-1 keeps a module’s own material after the lesson and its PDF', async () => {
      await wired.templateService.saveDraft(sa, COMPANY, 'training_taxonomy', {
        ...thirtyOneModules(),
        modules: thirtyOneModules().modules.map((m) => (m.code === moduleOf(4)
          ? { ...m, content: { links: [{ id: 'link-1', label: 'Bacaan', url: 'https://example.com/closing' }] } }
          : m)),
      }, templateId);
      await wired.templateService.publish(sa, COMPANY, 'training_taxonomy', templateId);
      await importLessons(deps(), COMPANY, set);
      const module = (await newest()).payload.modules.find((m: { code: string }) => m.code === moduleOf(4));
      expect(module.content.files.map((f: { mimeType: string }) => f.mimeType)).toEqual(['text/html', 'application/pdf']);
      expect(module.content.links).toEqual([{ id: 'link-1', label: 'Bacaan', url: 'https://example.com/closing' }]);
    });

    it('P19.6-T3 AC-1 without KaiZen, a module takes the lesson titled as it is; the 8 newer modules are reported unmapped and left as they were', async () => {
      const report = await importLessons(deps(), COMPANY, set);
      expect(report).toMatchObject({ attached: 23, unmapped: 8, published: 1 });
      const modules = report.templates[0].modules;
      expect(modules.filter((m) => m.outcome === 'unmapped').map((m) => m.code)).toEqual(EXTRA.map(([code]) => code));
      expect(modules.filter((m) => m.source === 'title')).toHaveLength(23);
      const row = await newest();
      for (const [code] of EXTRA) expect(filesOf(row as never, code)).toEqual([]);
    });

    it('P19.6-T3 AC-1 matches a module whose title P19.6-T4 split into a name and a description', async () => {
      const split = thirtyOneModules();
      split.modules = split.modules.map((m) => {
        if (!m.title.includes(': ')) return m;
        const [name, ...rest] = m.title.split(': ');
        return { ...m, title: name, description: rest.join(': ') };
      });
      await wired.templateService.saveDraft(sa, COMPANY, 'training_taxonomy', split, templateId);
      await wired.templateService.publish(sa, COMPANY, 'training_taxonomy', templateId);
      const report = await importLessons(deps(), COMPANY, set);
      expect(report.attached).toBe(23);
    });

    it('P19.6-T3 AC-1 a lesson with no PDF in the folder is attached alone', async () => {
      const partial = writeLessonFolder({ withoutPdf: [3] });
      try {
        await importLessons(deps(), COMPANY, loadLessonSet(partial.dir));
        expect(filesOf(await newest() as never, moduleOf(3)).map((f) => f.mimeType)).toEqual(['text/html']);
      } finally {
        partial.remove();
      }
    });
  });

  describe('re-runnable (AC-2)', () => {
    it('P19.6-T3 AC-2 a second run changes nothing: every module unchanged, no version, no file sent, no asset recorded, no audit row', async () => {
      const { byCode } = await lessonMapFromOffice(readers(), kaizen, set);
      await importLessons(deps(), COMPANY, set, { byCode });
      const rows = await col('companyTemplates').countDocuments({});
      const assets = await col('assets').find({}).toArray();
      const puts = storage.puts.length;
      audits.length = 0;
      const again = await importLessons(deps(), COMPANY, set, { byCode });
      expect(again).toMatchObject({ attached: 0, unchanged: 31, unmapped: 0, published: 0, sent: 0, recorded: 0 });
      expect(again.templates[0]).toMatchObject({ outcome: 'unchanged' });
      expect(await col('companyTemplates').countDocuments({})).toBe(rows);
      expect(await col('assets').find({}).toArray()).toEqual(assets);
      expect(storage.puts).toHaveLength(puts);
      expect(audits).toEqual([]);
    });

    it('P19.6-T3 AC-2 a dry run reports what it would attach and writes and sends nothing; it needs no storage', async () => {
      const rows = await col('companyTemplates').countDocuments({});
      const report = await importLessons(deps({ storage: null }), COMPANY, set, { dryRun: true });
      expect(report).toMatchObject({ dryRun: true, attached: 23, unmapped: 8, published: 0, sent: 0, recorded: 0 });
      expect(report.templates[0]).toMatchObject({ outcome: 'would publish' });
      expect(await col('companyTemplates').countDocuments({})).toBe(rows);
      expect(await col('assets').countDocuments({ storageKey: { $regex: '/training/lessons/' } })).toBe(0);
      await expect(importLessons(deps({ storage: null }), COMPANY, set)).rejects.toThrow(LessonImportError);
    });

    it('P19.6-T3 AC-2 a refreshed lesson replaces the old one’s items, keeping their ids, in a new version', async () => {
      await importLessons(deps(), COMPANY, set);
      const first = filesOf(await newest() as never, moduleOf(1));
      const refreshed = writeLessonFolder({ marker: 'Versi baru' });
      try {
        const report = await importLessons(deps(), COMPANY, loadLessonSet(refreshed.dir));
        expect(report).toMatchObject({ attached: 23, published: 1, sent: 23 });
        const files = filesOf(await newest() as never, moduleOf(1));
        expect(files).toHaveLength(2);
        expect(files[0].id).toBe(first[0].id);
        expect(files[0].storageKey).not.toBe(first[0].storageKey);
        // The PDF did not change: the same file, not sent again.
        expect(files[1].storageKey).toBe(first[1].storageKey);
      } finally {
        refreshed.remove();
      }
    });

    it('P19.6-T3 AC-2 never publishes past a Super Admin’s draft: the template is skipped and says why', async () => {
      await wired.templateService.saveDraft(sa, COMPANY, 'training_taxonomy', thirtyOneModules(), templateId);
      const rows = await col('companyTemplates').countDocuments({});
      const report = await importLessons(deps(), COMPANY, set);
      expect(report.templates[0]).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('draft') });
      expect(report).toMatchObject({ attached: 0, published: 0, sent: 0 });
      expect(await col('companyTemplates').countDocuments({})).toBe(rows);
    });

    it('P19.6-T3 AC-2 skips a template with no published Training, and one whose Training would not publish, and says why', async () => {
      await col('companyTemplates').updateMany({ templateId: otherTemplateId, kind: 'training_taxonomy' }, { $set: { deletedAt: NOW } });
      const none = await importLessons(deps(), OTHER, set);
      expect(none.templates[0]).toMatchObject({ outcome: 'skipped', reason: 'its Training has no published version' });

      const head = await newest();
      await col('companyTemplates').insertOne({
        companyId: COMPANY, templateId, kind: 'training_taxonomy', version: head.version + 1, revision: head.revision + 1,
        status: 'published', deletedAt: null,
        payload: { categories: [], skills: [], modules: [{ code: moduleOf(1), skillCode: 'NO_SUCH_SKILL', title: DELIVERED_LESSONS[0].title }] },
      });
      const rows = await col('companyTemplates').countDocuments({});
      const broken = await importLessons(deps(), COMPANY, set);
      expect(broken.templates[0]).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('would not publish') });
      expect(broken).toMatchObject({ attached: 0, published: 0 });
      expect(await col('companyTemplates').countDocuments({})).toBe(rows);
    });

    it('P19.6-T3 AC-2 a version that lands between the read and the write is not overwritten: the template is skipped; any other fault is raised', async () => {
      const model = deps().companyTemplates;
      const create = jest.spyOn(model, 'create').mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }));
      try {
        const raced = await importLessons(deps(), COMPANY, set);
        expect(raced.templates[0]).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('run this again') });
        expect(raced).toMatchObject({ attached: 0, published: 0 });
        create.mockRejectedValueOnce(new Error('the database went away'));
        await expect(importLessons(deps(), COMPANY, set)).rejects.toThrow('the database went away');
      } finally {
        create.mockRestore();
      }
    });

    it('P19.6-T3 AC-1 a module whose File section has no room for the lesson and its PDF is reported full and left as it is', async () => {
      const crowded = thirtyOneModules();
      const files = Array.from({ length: 19 }, (_, i) => ({
        id: `f${i}`, label: `Lembar ${i + 1}.pdf`, storageKey: `dev/company/${COMPANY}/training/x${i}`, mimeType: 'application/pdf', bytes: 10,
      }));
      crowded.modules = crowded.modules.map((m) => (m.code === moduleOf(2) ? { ...m, content: { files } } : m));
      await wired.templateService.saveDraft(sa, COMPANY, 'training_taxonomy', crowded, templateId);
      await wired.templateService.publish(sa, COMPANY, 'training_taxonomy', templateId);
      const report = await importLessons(deps(), COMPANY, set);
      expect(report.templates[0].modules.find((m) => m.code === moduleOf(2))).toMatchObject({ lesson: 2, outcome: 'full' });
      expect(report).toMatchObject({ full: 1, attached: 22 });
      expect(filesOf(await newest() as never, moduleOf(2))).toHaveLength(19);
    });

    it('P19.6-T3 AC-1 refuses a lesson storage already holds as something else, before any version is written', async () => {
      const lesson = set.lessons[0];
      storage.setStored(`dev/company/${COMPANY}/training/lessons/${lesson.htmlName}`, {
        storageKey: `dev/company/${COMPANY}/training/lessons/${lesson.htmlName}`, mimeType: 'application/octet-stream', bytes: 3,
      });
      const rows = await col('companyTemplates').countDocuments({});
      await expect(importLessons(deps(), COMPANY, set)).rejects.toThrow(/as application\/octet-stream, not text\/html/);
      expect(await col('companyTemplates').countDocuments({})).toBe(rows);
    });

    it('P19.6-T3 AC-2 runs per company: one named template of it, or none it does not have', async () => {
      const report = await importLessons(deps(), COMPANY, set, { templateId });
      expect(report.templates.map((t) => t.templateId)).toEqual([templateId]);
      await expect(importLessons(deps(), COMPANY, set, { templateId: otherTemplateId })).rejects.toThrow(/no active template/);
      await expect(importLessons(deps(), COMPANY, set, { templateId: 'nope' })).rejects.toThrow(/not a template id/);
    });
  });

  describe('a new KPM, a KPM’s own copy, and the cross-company line', () => {
    it('P19.6-T3 AC-3 a new KPM made from the template shows material in all 31 modules with nothing uploaded: 31 of 31', async () => {
      const { byCode } = await lessonMapFromOffice(readers(), kaizen, set);
      await importLessons(deps(), COMPANY, set, { byCode });
      const fresh = await office('0602', COMPANY, templateId);
      const owner = ownerOf(fresh);
      const modules = (await wired.training.list(owner)).flatMap((c) => c.skills.flatMap((s) => s.modules));
      expect(modules).toHaveLength(31);
      expect(modules.filter((m) => m.material === 'company')).toHaveLength(31);
      expect(await col('assets').countDocuments({ kpmId: fresh })).toBe(0);
      const content = await wired.training.readContent(owner, moduleOf(16));
      expect(content.content.files.map((f) => f.mimeType)).toEqual(['text/html', 'application/pdf']);
      // Delivered through the company's registry, to a member of an office of the company.
      await expect(wired.training.contentUrl(owner, moduleOf(16), content.content.files[0].storageKey)).resolves.toMatch(/^https:/);
    });

    it('P19.6-T3 AC-4 a KPM holding its own copy keeps it, and no existing KPM is written by the import', async () => {
      const kaizenBefore = await col('trainingModules').find({ kpmId: kaizen }).toArray();
      const before0417 = await col('trainingModules').find({ kpmId: office0417 }).toArray();
      const { byCode } = await lessonMapFromOffice(readers(), kaizen, set);
      await importLessons(deps(), COMPANY, set, { byCode });
      expect(await col('trainingModules').find({ kpmId: kaizen }).toArray()).toEqual(kaizenBefore);
      expect(await col('trainingModules').find({ kpmId: office0417 }).toArray()).toEqual(before0417);
      const owner = ownerOf(kaizen);
      const modules = (await wired.training.list(owner)).flatMap((c) => c.skills.flatMap((s) => s.modules));
      expect(modules.every((m) => m.material === 'own')).toBe(true);
    });

    it('P19.6-T3 AC-4 the Super Admin’s confirmed push puts the company’s lesson in place of KaiZen’s own, kept in history', async () => {
      const { byCode } = await lessonMapFromOffice(readers(), kaizen, set);
      await importLessons(deps(), COMPANY, set, { byCode });
      await wired.templatePush.apply(sa, COMPANY, templateId, {
        kinds: ['training_taxonomy'], kpmIds: [kaizen], replaceChanged: [kaizen],
      });
      const module = await col('trainingModules').findOne({ kpmId: kaizen, code: moduleOf(1) });
      expect(module!.officeContent).toBeNull();
      expect(module!.companyContent.files.map((f: { mimeType: string }) => f.mimeType)).toEqual(['text/html', 'application/pdf']);
      expect(module!.contentHistory[0].content.files[0].storageKey).toBe(`dev/${kaizen}/training/${moduleOf(1)}`);
    });

    it('P19.6-T3 AC-4 a KPM that reverted its own copy with Urungkan perubahan saya takes the lesson by the push, unconfirmed', async () => {
      const { byCode } = await lessonMapFromOffice(readers(), kaizen, set);
      await importLessons(deps(), COMPANY, set, { byCode });
      const owner = ownerOf(kaizen);
      for (const code of Object.keys(byCode)) await wired.training.resetContent(owner, code);
      const answer = await wired.templatePush.apply(sa, COMPANY, templateId, { kinds: ['training_taxonomy'], kpmIds: [kaizen] });
      expect(answer.offices[0].results[0]).toMatchObject({ outcome: 'applied' });
      const content = await wired.training.readContent(owner, moduleOf(20));
      expect(content.content.files.map((f) => f.mimeType)).toEqual(['text/html', 'application/pdf']);
    });

    it('P19.6-T3 AC-2 another company’s template, its files and its KPMs are untouched; its own run stores its own copies', async () => {
      const other = await newest(otherTemplateId, OTHER);
      await importLessons(deps(), COMPANY, set);
      expect(await newest(otherTemplateId, OTHER)).toEqual(other);
      expect(await col('assets').countDocuments({ companyId: OTHER })).toBe(0);
      await importLessons(deps(), OTHER, set);
      const stored = await col('assets').find({ storageKey: { $regex: '/training/lessons/' } }).toArray();
      expect(stored.filter((a) => a.companyId === OTHER).every((a) => String(a.storageKey).startsWith(`dev/company/${OTHER}/`))).toBe(true);
      expect(stored.filter((a) => a.companyId === COMPANY)).toHaveLength(46);
      expect(stored.filter((a) => a.companyId === OTHER)).toHaveLength(46);
    });

    it('P19.6-T3 AC-6 index.html is never uploaded as material', async () => {
      await importLessons(deps(), COMPANY, set);
      expect(storage.puts).toHaveLength(46);
      expect(storage.puts.some((key) => /index/i.test(key))).toBe(false);
      expect(await col('assets').countDocuments({ originalFilename: { $regex: 'index' } })).toBe(0);
    });
  });
});
