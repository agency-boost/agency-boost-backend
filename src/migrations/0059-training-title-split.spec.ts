import mongoose from 'mongoose';
import { startMongo, stopMongo } from '../../test/mongo';
import { TITLE_SPLIT, up } from './0059-training-title-split';

type Row = Record<string, unknown>;

const NOW = new Date('2026-11-06T02:00:00.000Z');
const COMPANY = '66f0000000000000000000c1';
const TEMPLATE = '66f0000000000000000000d1';
const KPM_SAME = '66f0000000000000000000a1';
const KPM_EDITED = '66f0000000000000000000a2';
const LONG = `Nama: ${'x'.repeat(161)}`;

/** The template's training, as production's owner wrote it: names with their description after a colon. */
const PAYLOAD = {
  categories: [{ code: 'SALES', label: 'Sales: jual', description: 'Temukan prospek.' }],
  skills: [
    { code: 'LEADS_GEN', categoryCode: 'SALES', label: 'Leads generation: 8 cara mendapat calon nasabah' },
    { code: 'CLOSING', categoryCode: 'SALES', label: 'Closing' },
    { code: 'TOO_LONG', categoryCode: 'SALES', label: LONG },
  ],
  modules: [
    { code: 'SOCIAL', skillCode: 'LEADS_GEN', title: 'Media sosial & leads tracker: dari konten ke janji temu', publishState: 'published' },
    { code: 'CLOSE_101', skillCode: 'CLOSING', title: 'Closing', publishState: 'published' },
  ],
};

/**
 * **The title split** (P19.6-T4 AC-2; ADR-0220 §3): every template's newest published training split as a new version, a
 * draft in place; every KPM's skills and modules split, each a new version, its agents' copy published again; an
 * unchanged KPM's `seededFrom` moved; nothing else moved; twice is once.
 */
describe('0059 — the training title split (P19.6-T4 AC-2)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const c = (name: string) => db().collection(name);
  const everything = async () => {
    const out: Record<string, unknown[]> = {};
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) {
      out[name] = await c(name).find({}).sort({ _id: 1 }).toArray();
    }
    return out;
  };

  beforeAll(startMongo);
  afterAll(stopMongo);

  /** A KPM as provisioning before P19.6-T4 left it: rows without `description`, a snapshot carrying them. */
  async function office(kpmId: string, edited: boolean) {
    await c('kpms').insertOne({
      _id: kpmId as never, companyId: COMPANY, code: kpmId.slice(-4),
      startedFrom: { source: 'template', templateId: TEMPLATE, templateName: 'Prudential' },
      seededFrom: { training_taxonomy: { templateId: TEMPLATE, version: 1 } },
    });
    const ids: Record<string, mongoose.Types.ObjectId> = {};
    await c('trainingCategories').insertOne({ kpmId, code: 'SALES', label: 'Sales: jual', description: 'Temukan prospek.', version: 1, status: 'active', displayOrder: 1, deletedAt: null });
    for (const [i, s] of PAYLOAD.skills.entries()) {
      const { insertedId } = await c('trainingSkills').insertOne({ kpmId, ...s, version: 1, status: 'active', displayOrder: i + 1, deletedAt: null });
      ids[s.code] = insertedId;
    }
    for (const [i, m] of PAYLOAD.modules.entries()) {
      const { insertedId } = await c('trainingModules').insertOne({
        kpmId, ...m, version: 1, status: 'active', displayOrder: i + 1, deletedAt: null,
        companyContent: { files: [], videos: [], links: [{ id: 'l1', label: 'Baca', url: 'https://example.com/' }] },
        officeContent: null, contentHistory: [],
      });
      ids[m.code] = insertedId;
    }
    // An archived module, split too: its title still renders in a member's history.
    await c('trainingModules').insertOne({
      kpmId, code: 'OLD', skillCode: 'CLOSING', title: 'Lama: modul yang ditarik', publishState: 'published',
      version: 2, status: 'archived', displayOrder: 3, deletedAt: null, companyContent: { files: [], videos: [], links: [] }, officeContent: null,
    });
    const tree = [{
      id: 'cat', code: 'SALES', label: 'Sales: jual', description: 'Temukan prospek.', version: 1,
      skills: PAYLOAD.skills.map((s) => ({
        id: String(ids[s.code]), code: s.code, label: s.label, version: 1,
        modules: PAYLOAD.modules.filter((m) => m.skillCode === s.code).map((m) => ({ id: String(ids[m.code]), code: m.code, title: m.title, version: 1 })),
      })),
    }];
    await c('configSnapshots').insertOne({
      kpmId, version: 1, sourceVersion: 1, payload: { activity: [], training: tree }, publishedAt: NOW, publishedBy: null, origin: null, deletedAt: null,
    });
    if (edited) {
      // The Owner renamed a skill after publishing, colon and all: its published copy is version 1, the live row 2.
      await c('trainingSkills').updateOne({ _id: ids.CLOSING }, { $set: { label: 'Closing: teknik menutup' }, $inc: { version: 1 } });
    }
    await c('trainingProgress').insertOne({ kpmId, membershipId: 'm1', moduleCode: 'SOCIAL', status: 'done', deletedAt: null });
    return ids;
  }

  let report: Awaited<ReturnType<typeof up>>;
  let ids: Record<string, mongoose.Types.ObjectId>;

  beforeAll(async () => {
    await c('companyTemplates').insertMany([
      { companyId: COMPANY, templateId: TEMPLATE, kind: 'training_taxonomy', version: 1, revision: 1, status: 'published', payload: PAYLOAD, deletedAt: null },
      { companyId: COMPANY, templateId: TEMPLATE, kind: 'training_taxonomy', version: 2, revision: 2, status: 'draft', payload: PAYLOAD, deletedAt: null },
    ]);
    ids = await office(KPM_SAME, false);
    await office(KPM_EDITED, true);
    // A row an Owner wrote after the split, with a colon: it holds `description`, so it is theirs.
    await c('trainingSkills').insertOne({ kpmId: KPM_EDITED, code: 'MINE', categoryCode: 'SALES', label: 'Milik saya: dengan titik dua', description: null, version: 1, status: 'active', displayOrder: 9, deletedAt: null });
    report = await up(db(), NOW);
  });

  it('P19.6-T4 AC-2 gives the template a new published version split at the first colon, and splits its open draft in place', async () => {
    const rows = await c('companyTemplates').find({ templateId: TEMPLATE }).sort({ version: 1 }).toArray();
    expect(rows.map((r) => [r.version, r.status])).toEqual([[1, 'published'], [2, 'published'], [3, 'draft']]);
    // The published version never changes.
    expect(rows[0].payload).toEqual(PAYLOAD);
    const split = rows[1].payload as { skills: Row[]; modules: Row[]; categories: Row[] };
    expect(split.skills.map((s) => [s.code, s.label, s.description])).toEqual([
      ['LEADS_GEN', 'Leads generation', '8 cara mendapat calon nasabah'],
      ['CLOSING', 'Closing', null],
      ['TOO_LONG', LONG, null],
    ]);
    expect(split.modules[0]).toMatchObject({ code: 'SOCIAL', title: 'Media sosial & leads tracker', description: 'dari konten ke janji temu' });
    // A category is never split.
    expect(split.categories).toEqual(PAYLOAD.categories);
    expect(rows[1]).toMatchObject({ createdBy: TITLE_SPLIT, publishedAt: NOW });
    expect(rows[2].payload).toEqual(split);
    expect(Number(rows[2].revision)).toBeGreaterThan(Number(rows[1].revision));
    expect(report).toMatchObject({ templateVersions: 1, drafts: 1 });
  });

  it('P19.6-T4 AC-2 splits a KPM’s skills and modules, archived ones too, each a new version — no code, order, material or progress moved', async () => {
    const skill = (await c('trainingSkills').findOne({ _id: ids.LEADS_GEN }))!;
    expect(skill).toMatchObject({ code: 'LEADS_GEN', label: 'Leads generation', description: '8 cara mendapat calon nasabah', version: 2, displayOrder: 1, status: 'active' });
    const whole = (await c('trainingSkills').findOne({ _id: ids.CLOSING }))!;
    expect(whole).toMatchObject({ label: 'Closing', description: null, version: 1 });
    const module = (await c('trainingModules').findOne({ _id: ids.SOCIAL }))!;
    expect(module).toMatchObject({
      code: 'SOCIAL', title: 'Media sosial & leads tracker', description: 'dari konten ke janji temu', version: 2,
      publishState: 'published', displayOrder: 1, officeContent: null,
      companyContent: { files: [], videos: [], links: [{ id: 'l1', label: 'Baca', url: 'https://example.com/' }] },
    });
    expect(await c('trainingModules').findOne({ kpmId: KPM_SAME, code: 'OLD' })).toMatchObject({
      title: 'Lama', description: 'modul yang ditarik', status: 'archived', version: 3,
    });
    expect(await c('trainingProgress').countDocuments({ moduleCode: 'SOCIAL', status: 'done' })).toBe(2);
    // An Owner's own colon, written after the field existed, is left alone.
    expect(await c('trainingSkills').findOne({ kpmId: KPM_EDITED, code: 'MINE' })).toMatchObject({ label: 'Milik saya: dengan titik dua', version: 1 });
  });

  it('P19.6-T4 AC-2 reports every split and every title left whole for a reason, per KPM and template', () => {
    expect(report.lines).toContainEqual({
      where: `kpm:${KPM_SAME}`, level: 'skill', code: 'LEADS_GEN', from: 'Leads generation: 8 cara mendapat calon nasabah',
      result: { name: 'Leads generation', description: '8 cara mendapat calon nasabah' },
    });
    expect(report.lines).toContainEqual({
      where: `template:${COMPANY}/${TEMPLATE}`, level: 'skill', code: 'TOO_LONG', from: LONG, result: { leftWhole: 'too_long' },
    });
    // A title with no colon is not a line.
    expect(report.lines.some((l) => l.code === 'CLOSE_101')).toBe(false);
    expect(report.kpms).toBe(2);
  });

  it('P19.6-T4 AC-2 publishes the split to agents, origin migration; a row edited since the last publish waits', async () => {
    const [same] = await c('configSnapshots').find({ kpmId: KPM_SAME }).sort({ version: -1 }).limit(1).toArray();
    expect(same).toMatchObject({ version: 2, origin: { source: 'migration', migration: TITLE_SPLIT } });
    const skills = (same.payload.training as { skills: Row[] }[])[0].skills;
    expect(skills[0]).toMatchObject({ code: 'LEADS_GEN', label: 'Leads generation', description: '8 cara mendapat calon nasabah', version: 2 });
    expect((skills[0].modules as Row[])[0]).toMatchObject({ title: 'Media sosial & leads tracker', version: 2 });

    const [edited] = await c('configSnapshots').find({ kpmId: KPM_EDITED }).sort({ version: -1 }).limit(1).toArray();
    const theirs = (edited.payload.training as { skills: Row[] }[])[0].skills;
    // The renamed skill was split live, but its published copy is the older one: agents keep it until the KPM publishes.
    expect(await c('trainingSkills').findOne({ kpmId: KPM_EDITED, code: 'CLOSING' }))
      .toMatchObject({ label: 'Closing', description: 'teknik menutup', version: 3 });
    expect(theirs.find((s) => s.code === 'CLOSING')).toMatchObject({ label: 'Closing', version: 1 });
    expect(theirs.find((s) => s.code === 'LEADS_GEN')).toMatchObject({ label: 'Leads generation', version: 2 });
    expect(report.republished).toBe(2);
  });

  it('P19.6-T4 AC-2 keeps “changed by the KPM” true: the unchanged KPM stands on the split version, the edited one where it was', async () => {
    const same = (await c('kpms').findOne({ _id: KPM_SAME as never }))!;
    expect(same.seededFrom).toEqual({ training_taxonomy: { templateId: TEMPLATE, version: 2 } });
    const edited = (await c('kpms').findOne({ _id: KPM_EDITED as never }))!;
    expect(edited.seededFrom).toEqual({ training_taxonomy: { templateId: TEMPLATE, version: 1 } });
    expect(report.seededFromMoved).toBe(1);
  });

  it('P19.6-T4 AC-2 twice is once: a second run writes nothing', async () => {
    const before = await everything();
    const again = await up(db(), new Date('2026-11-07T00:00:00Z'));
    expect(again).toMatchObject({ templateVersions: 0, drafts: 0, kpms: 0, republished: 0, seededFromMoved: 0 });
    expect(await everything()).toEqual(before);
  });
});
