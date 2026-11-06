import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { SEED_TRAINING_MODULES } from '@/domain/constants';
import type { TrainingProgressView } from '@/modules/training/training-progress.view';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { StubStorage } from '../../../test/stub-storage';
import { seedDemo, type SeedResult } from '../demo';
import { SNIFF_SAMPLE_BYTES, sniffedContentType } from '@/modules/assets/content-sniff';
import { demonstrationLesson, TRAINING_SEED_LESSON, TRAINING_SEED_LINK } from '../training-fixture';

/** A seeded module's title, as the seed gives it — in Bahasa Indonesia since P18.10-T7 (OD-238). */
const titleOf = (code: string) => SEED_TRAINING_MODULES.find((m) => m.code === code)!.title;

const RUN_MS = 300_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

/** The account's membership in an office — the live one unless `removed` — as a signed-in context. */
async function as(
  code: string, email: string, flags: { owner?: boolean; removed?: boolean } = {},
): Promise<RequestContext> {
  const kpm = await col('kpms').findOne({ code });
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').find({
    kpmId: String(kpm!._id), userId: String(account!._id), status: flags.removed ? 'removed' : 'active',
  }).sort({ joinedAt: 1 }).limit(1).toArray())[0];
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
    status: 'active', isKpmOwner: flags.owner ?? false, isKpmAdmin: false, directCount: 0,
  } as never);
}

/** A member's Sales counts and their statuses, as the person tab draws them. */
function sales(view: TrainingProgressView) {
  const category = view.categories.find((c) => c.code === 'SALES')!;
  const rows = category.skills.flatMap((s) => s.modules);
  return {
    done: category.done,
    total: category.total,
    inProgress: rows.filter((m) => m.status === 'in_progress').map((m) => m.code),
    archived: category.skills.flatMap((s) => s.archived.map((a) => a.code)),
  };
}

/**
 * **Phase 18.2 — training, seeded** (P18.2-T1 AC-11, P18.2-T3 AC-8; `training-fixture.ts`, whose header says which
 * account shows what). The seed run as the command runs it — without storage, as a spec has none — at 10:00 on
 * Saturday 10 October 2026 in Jakarta, then read back through the training module's own readings: what is asserted
 * is what each account sees on a fresh seed. Run a second time to prove it writes nothing.
 */
describe('Phase 18.2 the training seed — a run at 10:00 on 10 October 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-10-10T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;
  let seeded: SeedResult;
  const of = async (code: string, email: string, flags: { removed?: boolean } = {}) => {
    const ctx = await as(code, email, flags);
    return wired.trainingReadings.of(ctx, ctx.membershipId!);
  };

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    seeded = await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  }, RUN_MS);
  afterAll(stopMongo);

  it('P18.2-T1 AC-11 writes forty-nine rows in 0417 and three in 0555, nowhere else; the PDFs skipped without storage', async () => {
    const kpm0417 = String((await col('kpms').findOne({ code: '0417' }))!._id);
    const kpm0555 = String((await col('kpms').findOne({ code: '0555' }))!._id);
    // *Amended 2026-10-10 (P18.3-T3 AC-1):* the compliance fixture adds twenty-five rows for Phase 18's cast in 0417
    // (`compliance-seed.spec.ts`), beside this fixture's forty-nine for the coaching cast.
    const compliance = 25;
    expect(await col('trainingProgress').countDocuments({ kpmId: kpm0417 })).toBe(49 + compliance);
    expect(await col('trainingProgress').countDocuments({ kpmId: kpm0555 })).toBe(3);
    expect(await col('trainingProgress').countDocuments({})).toBe(52 + compliance);
    expect(seeded.training.files).toBe('skipped: storage is not configured');
    expect(seeded.written.trainingProgress).toBe(52 + compliance);
    expect(seeded.compliance.written - 1).toBe(compliance);
  });

  it('P18.2-T1 AC-11 Rina: four Sales modules Done, Discovery Questions In progress, the Closing link already opened', async () => {
    const view = await of('0417', 'rina@kpm0417.test');
    expect(sales(view)).toEqual({ done: 4, total: 10, inProgress: ['DISCOVERY_QUESTIONS'], archived: [] });
    const rina = await as('0417', 'rina@kpm0417.test');
    const page = await wired.trainingProgress.module(rina, 'CLOSING_TECHNIQUES');
    expect(page.items).toEqual([{ id: TRAINING_SEED_LINK.id, kind: 'link', label: TRAINING_SEED_LINK.label, mimeType: null, bytes: null, url: TRAINING_SEED_LINK.url }]);
    expect(page).toMatchObject({ status: 'not_started', openedItemIds: [TRAINING_SEED_LINK.id] });
  });

  it.each([
    ['agus@kpm0417.test', 10, []],
    ['indah@kpm0417.test', 5, ['OBJECTION_FUNDAMENTALS', 'CLOSING_TECHNIQUES']],
    ['dimas@kpm0417.test', 4, ['CLOSING_TECHNIQUES']],
    ['novi@kpm0417.test', 0, []],
    ['wahyu@kpm0417.test', 2, []],
    ['siti@kpm0417.test', 10, []],
    ['budi@kpm0417.test', 0, ['PROSPECT_LIST']],
    ['dewi@kpm0417.test', 3, []],
    ['admin@kpm0417.test', 2, []],
  ] as const)('P18.2-T1 AC-11 %s: %i done, in progress %j', async (email, done, inProgress) => {
    expect(sales(await of('0417', email))).toEqual({ done, total: 10, inProgress: [...inProgress], archived: [] });
  });

  it('P18.2-T2 AC-5 Yanti’s re-join: three done on her first, removed membership; nothing on the current one', async () => {
    expect(sales(await of('0417', 'removed@kpm0417.test'))).toMatchObject({ done: 0, total: 10 });
    expect(sales(await of('0417', 'removed@kpm0417.test', { removed: true }))).toMatchObject({ done: 3, total: 10 });
  });

  it('P18.2-T2 AC-4 Lina in 0555: Client Retention archived after she did it — history, outside Sales (1/9); the draft not offered', async () => {
    const view = await of('0555', 'agent@kpm0555.test');
    expect(sales(view)).toEqual({ done: 1, total: 9, inProgress: ['FINANCIAL_NEEDS_ANALYSIS'], archived: ['CLIENT_RETENTION'] });
    expect(JSON.stringify(view)).not.toContain('PRUMAPAN_BASICS');
    // The office's catalog holds the draft; it is just not offered.
    const kpm0555 = String((await col('kpms').findOne({ code: '0555' }))!._id);
    expect(await col('trainingModules').findOne({ kpmId: kpm0555, code: 'PRUMAPAN_BASICS' })).toMatchObject({ publishState: 'draft' });
  });

  it('P18.2-T3 AC-8 D-seed-link: Lina’s item 9 is bound to Closing Techniques That Work, live, waiting; her day and prospects item kept', async () => {
    const lina = await as('0555', 'agent@kpm0555.test');
    const view = await wired.activationProgress.mine(lina);
    const item = (code: string) => view.aspects.flatMap((a) => a.items).find((i) => i.code === code)!;
    expect(item('MANDATORY_TRAINING')).toMatchObject({
      done: false,
      link: {
        kind: 'training:CLOSING_TECHNIQUES', label: titleOf('CLOSING_TECHNIQUES'), live: true,
        route: '/training/SALES/CLOSING_TECHNIQUES',
      },
    });
    expect(item('ADD_PROSPECTS').done).toBe(true);
    expect(view.day).toBe(61);
  });

  /*
   * 0555 holds unpublished ratio and type edits on purpose — it is the office holding the states — so its publish bar
   * speaks before this fixture runs. What is pinned is that the fixture adds nothing to it: its published copy —
   * still version 1, as P13.1-T3's walk reads it — offers exactly the training the working copy does, at the same
   * versions, and carries the checklist's version 2.
   */
  it('P18.2-T3 AC-8 0555’s Owner sees item 9 Auto; the snapshot the fixture publishes matches the working training and checklist', async () => {
    const hendra = await as('0555', 'owner@kpm0555.test', { owner: true });
    const checklist = await wired.activation.read(hendra);
    const item = checklist.published!.aspects.flatMap((a) => a.items).find((i) => i.code === 'MANDATORY_TRAINING')!;
    expect(item.link).toMatchObject({ kind: 'training:CLOSING_TECHNIQUES', live: true });
    expect(checklist.draft).toBeNull();

    const keys = (tree: { id: string; version: number; skills: { id: string; version: number; modules: { id: string; version: number }[] }[] }[]) =>
      tree.flatMap((c) => [`c:${c.id}:${c.version}`, ...c.skills.flatMap((s) => [`s:${s.id}:${s.version}`, ...s.modules.map((m) => `m:${m.id}:${m.version}`)])]).sort();
    const [newest] = await col('configSnapshots').find({ kpmId: hendra.kpmId }).sort({ version: -1 }).limit(1).toArray();
    expect(newest.version).toBe(1);
    expect(keys(newest.payload.training)).toEqual(keys(await wired.training.offered(hendra)));
    expect(newest.payload.activationChecklist).toMatchObject({ id: checklist.published!.id, version: checklist.published!.version });
  });

  it('P18.2-T1 AC-11 no reviewed walk moves: 0417’s checklist binds nothing to training, and its publish bar is silent', async () => {
    const owner = await as('0417', 'owner@kpm0417.test', { owner: true });
    const checklist = await wired.activation.read(owner);
    const links = checklist.published!.aspects.flatMap((a) => a.items).map((i) => i.autoLink).filter((l) => l?.startsWith('training:'));
    expect(links).toEqual([]);
    expect((await wired.config.state(owner)).hasUnpublishedChanges).toBe(false);
  });

  it('P19.4-T1 AC-3 Prudential\u2019s template carries the company\u2019s material: a KPM made from it shows it with nothing uploaded', async () => {
    const prudential = String((await col('companies').findOne({ slug: 'prudential' }))!._id);
    const template = await col('templates').findOne({ companyId: prudential, isDefault: true, deletedAt: null });
    const templateId = String(template!._id);
    // Without storage, the material is Closing's link: what 0417's module holds from the company.
    expect(seeded.training.templateMaterial).toEqual({ written: 1, version: 2, modules: [TRAINING_SEED_LINK.moduleCode] });
    const training = await wired.templateService.read(prudential, 'training_taxonomy', templateId);
    // *Amended 2026-11-06 (P19.6-T4):* version 3, the newer names `training-names-fixture.ts` publishes on top of
    // version 2's material, which it keeps.
    expect(training).toMatchObject({ status: 'published', version: 3 });
    const closing = (training.payload.modules as { code: string; content?: { links: { url: string }[] } }[])
      .find((m) => m.code === TRAINING_SEED_LINK.moduleCode)!;
    expect(closing.content!.links.map((l) => l.url)).toEqual([TRAINING_SEED_LINK.url]);

    // A new KPM made from the template: its module shows the link, and it uploaded nothing.
    const kpmId = String(new mongoose.Types.ObjectId());
    await wired.provisioning.provision(kpmId, await wired.provisioning.planFor(prudential, { kind: 'template', templateId }));
    const module = await col('trainingModules').findOne({ kpmId, code: TRAINING_SEED_LINK.moduleCode });
    expect(module!.companyContent.links.map((l: { url: string }) => l.url)).toEqual([TRAINING_SEED_LINK.url]);
    expect(module!.officeContent).toBeNull();
    expect(await col('assets').countDocuments({ kpmId })).toBe(0);
    await col('trainingModules').updateMany({ kpmId }, { $set: { deletedAt: new Date() } });
  });

  it('P18.2-T1 AC-11 a second run writes nothing', async () => {
    const again = await seedDemo({ clock, log: quiet });
    expect(again.training.written).toBe(0);
    expect(again.written.trainingProgress ?? 0).toBe(0);
    expect(again.written.configSnapshots ?? 0).toBe(0);
    expect(again.written.activationTemplates ?? 0).toBe(0);
  }, RUN_MS);

  /*
   * The second training review (c): on a database seeded before, `version + 1` collided with an Owner's draft
   * (E11000), and a Lina pinned to another version was not repinned.
   */
  it('P18.2 exit review (c) an existing database: Lina is repinned whatever her version; a draft checklist is never published past', async () => {
    const kpmId = String((await col('kpms').findOne({ code: '0555' }))!._id);
    const lina = await as('0555', 'agent@kpm0555.test');
    const open = () => col('activationProgress').findOne({ kpmId, membershipId: lina.membershipId, graduatedAt: null });
    const versions = await col('activationTemplates').find({ kpmId, status: 'published' }).sort({ version: 1 }).toArray();
    const [v1, binding] = versions;
    expect(binding.aspects.flatMap((a: { items: { code: string; autoLink: string | null }[] }) => a.items)
      .find((i: { code: string }) => i.code === 'MANDATORY_TRAINING').autoLink).toBe('training:CLOSING_TECHNIQUES');

    // Lina back on version 1, as an earlier run or a walk left her: the next run repins her.
    await col('activationProgress').updateOne({ _id: (await open())!._id }, { $set: { templateId: String(v1._id), templateVersion: v1.version } });
    await seedDemo({ clock, log: quiet });
    expect((await open())!.templateVersion).toBe(binding.version);

    // The fixture's version gone and an Owner's draft held at the next number: nothing is published past it.
    await col('activationTemplates').deleteOne({ _id: binding._id });
    await col('activationProgress').updateOne({ _id: (await open())!._id }, { $set: { templateId: String(v1._id), templateVersion: v1.version } });
    await col('activationTemplates').insertOne({
      kpmId, version: v1.version + 1, status: 'draft', publishedAt: null, aspects: v1.aspects,
      createdBy: null, updatedBy: null, deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const third = await seedDemo({ clock, log: quiet });
    expect(third.training.checklist).toMatch(/draft checklist/);
    expect(await col('activationTemplates').countDocuments({ kpmId, status: 'published' })).toBe(1);
    expect((await open())!.templateVersion).toBe(v1.version);
  }, RUN_MS);
});

/**
 * **The company's material, where storage is configured** (the phase file's *Seed*, *Content*): a one-page PDF per Sales
 * module, written once into **Prudential's** folder and registered as the company's confirmed asset, referenced by both
 * offices' modules — so 0417 still holds no training file of its own — and opened by a learner through the company's
 * registry. A second run sends nothing.
 */
describe('Phase 18.2 the training seed — storage configured', () => {
  const clock = new FixedClock(new Date('2026-10-10T03:00:00Z'));
  const storage = new StubStorage();
  let wired: ReturnType<typeof configModule>;
  let seeded: SeedResult;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    seeded = await seedDemo({ clock, log: quiet, storage });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  }, RUN_MS);
  afterAll(stopMongo);

  it('P18.2-T1 AC-11 ten PDFs, the company’s, referenced by both offices’ Sales modules; no office holds one of its own', async () => {
    const prudential = String((await col('companies').findOne({ slug: 'prudential' }))!._id);
    // Ten PDFs and, since P19.6-T2, one HTML lesson.
    const training = storage.puts.filter((key) => key.includes('/training/'));
    expect(seeded.training).toMatchObject({ files: 'stored', sent: 11 });
    expect(training).toHaveLength(11);
    expect(training.every((key) => key.startsWith(`dev/company/${prudential}/training/`))).toBe(true);
    expect(await col('assets').countDocuments({ companyId: prudential, storageKey: { $in: training }, uploadState: 'confirmed', kpmId: null })).toBe(11);
    for (const code of ['0417', '0555']) {
      const kpmId = String((await col('kpms').findOne({ code }))!._id);
      const modules = await col('trainingModules').find({ kpmId, skillCode: { $in: ['PROSPECTING', 'NEEDS_ANALYSIS', 'OBJECTION_HANDLING', 'CLOSING', 'CROSS_SELL', 'RETENTION'] } }).toArray();
      // Every Sales module carries its PDF; *Building Your Prospect List* the lesson before it.
      expect([code, modules.filter((m) => m.companyContent.files.some((f: { mimeType: string }) => f.mimeType === 'application/pdf')).length]).toEqual([code, 10]);
      expect([code, modules.filter((m) => m.companyContent.files.length === 2).map((m) => m.code)]).toEqual([code, ['PROSPECT_LIST']]);
      expect([code, modules.every((m) => m.officeContent === null)]).toEqual([code, true]);
      expect(await col('assets').countDocuments({ kpmId, storageKey: { $regex: '/training/' } })).toBe(0);
    }
  });

  it('P18.2-T1 AC-6 Rina opens a module’s PDF through the company’s registry', async () => {
    const rina = await as('0417', 'rina@kpm0417.test');
    const page = await wired.trainingProgress.module(rina, 'PROSPECT_LIST');
    expect(page.items.map((i) => [i.kind, i.label])).toEqual([
      ['file', `Pelajaran: ${titleOf('PROSPECT_LIST')}`], ['file', `${titleOf('PROSPECT_LIST')}.pdf`],
    ]);
    const opened = await wired.trainingProgress.open(rina, 'PROSPECT_LIST', page.items[1].id);
    expect(opened.url).toContain('/training/PROSPECT_LIST-demonstration');
  });

  it('P19.6-T2 AC-1 Rina’s first item on Building Your Prospect List is an HTML lesson, the company’s, opened by its link', async () => {
    const rina = await as('0417', 'rina@kpm0417.test');
    const page = await wired.trainingProgress.module(rina, 'PROSPECT_LIST');
    expect(page.items[0]).toMatchObject({ id: TRAINING_SEED_LESSON.id, kind: 'file', mimeType: 'text/html', url: null });
    const opened = await wired.trainingProgress.open(rina, 'PROSPECT_LIST', page.items[0].id);
    expect(opened.url).toContain(`/training/${TRAINING_SEED_LESSON.name}`);
    const asset = await col('assets').findOne({ storageKey: { $regex: `/training/${TRAINING_SEED_LESSON.name}$` } });
    expect(asset).toMatchObject({ kpmId: null, mimeType: 'text/html', uploadState: 'confirmed' });
  });

  it('P19.6-T2 AC-1 the seeded lesson is one the confirm step accepts as HTML: self-contained, its colours in the fragment', () => {
    const lesson = demonstrationLesson('Building Your Prospect List');
    expect(sniffedContentType('text/html', lesson.subarray(0, SNIFF_SAMPLE_BYTES))).toBe('text/html');
    const html = lesson.toString('utf8');
    // Nothing from anywhere else (ADR-0217 §7): no outside address, no relative file.
    expect(html).not.toMatch(/\b(src|href)="(?!#)/);
    // The reader of ADR-0217 §5: the three names, six lower-case hex digits, nothing else.
    expect(html).toContain("{ accent: '--accent', accentSoft: '--accent-soft', ink: '--ink' }");
    expect(html).toContain('/^[0-9a-f]{6}$/');
    expect(demonstrationLesson('<b>x</b>').toString('utf8')).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('P19.4-T1 AC-3 with storage, the template\u2019s Sales modules carry the company\u2019s PDFs, by reference', async () => {
    const prudential = String((await col('companies').findOne({ slug: 'prudential' }))!._id);
    expect(seeded.training.templateMaterial.modules).toHaveLength(10);
    // The ten PDFs, and the lesson on *Building Your Prospect List* (P19.6-T2).
    const template = await col('templates').findOne({ companyId: prudential, isDefault: true, deletedAt: null });
    const row = await col('companyTemplates').findOne({ templateId: String(template!._id), kind: 'training_taxonomy', version: 2 });
    const files = (row!.payload.modules as { content?: { files?: { storageKey: string }[] } }[])
      .flatMap((m) => m.content?.files ?? []).map((f) => f.storageKey);
    expect(files).toHaveLength(11);
    // The same company files the offices reference: no byte copied (ADR-0032).
    expect(await col('assets').countDocuments({ companyId: prudential, storageKey: { $in: files }, kpmId: null })).toBe(11);
  });

  it('P18.2-T1 AC-11 a second run sends nothing and writes nothing', async () => {
    const again = await seedDemo({ clock, log: quiet, storage });
    expect(again.training).toMatchObject({ written: 0, sent: 0, files: 'stored' });
  }, RUN_MS);
});
