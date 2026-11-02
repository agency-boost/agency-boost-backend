import mongoose from 'mongoose';
import { MOTIVATION_CATEGORY } from '@/domain/constants/training-taxonomy';
import { platformDefaultPayload } from '@/modules/config/template-defaults';
import { TEMPLATE_LIBRARY } from '@/modules/tenants/template-library';
import { startMongo, stopMongo } from '../../test/mongo';
import { up } from './0048-default-template-motivation';

type Row = Record<string, unknown>;

const KPM_A = '66f0000000000000000000a1';
const NOW = new Date('2026-10-30T02:00:00.000Z');
const MOTIVATION = { code: MOTIVATION_CATEGORY.code, label: MOTIVATION_CATEGORY.label, description: MOTIVATION_CATEGORY.description };

/** Today's default training payload, and the one every environment made before UI V1 holds: the six, no Motivation. */
const today = () => platformDefaultPayload('training_taxonomy') as { categories: Row[]; skills: Row[]; modules: Row[] };
const before = () => ({ ...today(), categories: today().categories.filter((c) => c.code !== 'MOTIVATION') });
const codes = (payload: unknown) => ((payload as { categories: Row[] }).categories).map((c) => c.code);

/**
 * **Motivation in the platform's Default template** (Phase 18.99 T10; UI V1, UI-063): migration 0048 gives the Template
 * company's Default template the owner's seventh training category — every version, after *Team Management*, the
 * seed's words — where it holds none, and touches nothing else: no office's taxonomy or snapshot, no insurer's
 * template, no other named template, no deleted row. Twice is once; a template already holding it is current.
 */
describe('0048 — Motivation in the Default template (P18.99-T10, UI-063)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const templates = () => db().collection('companyTemplates');
  const defaults = { companyId: TEMPLATE_LIBRARY.companyId, templateId: TEMPLATE_LIBRARY.defaultTemplateId };
  const doc = (payload: unknown, over: Row = {}) => ({
    ...defaults, kind: 'training_taxonomy', version: 1, status: 'published', payload, deletedAt: null,
    createdBy: null, updatedBy: null, ...over,
  });
  const everything = async () => {
    const out: Record<string, unknown[]> = {};
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) {
      out[name] = await db().collection(name).find({}).sort({ _id: 1 }).toArray();
    }
    return out;
  };

  beforeAll(startMongo);
  afterAll(stopMongo);
  // Emptied, not dropped (`jest.config.ts`, *What the ceiling was*): a drop takes WiredTiger's schema lock and waits
  // behind the other workers' index builds, which on GitHub's runner took this suite's first test past 30 s
  // (production's first release, 2026-11-02). No test here needs a collection to be missing.
  beforeEach(async () => {
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) {
      await db().collection(name).deleteMany({});
    }
  });

  it('UI-063 gives a Default template made before the seed’s Motivation, fifth, after Team Management, version kept', async () => {
    await templates().insertOne(doc(before()));

    expect(await up(db())).toEqual({ templates: 1, current: 0 });

    const row = await templates().findOne(defaults);
    expect(row!.payload).toEqual(today());
    expect(codes(row!.payload)).toEqual(['SALES', 'PRODUCT', 'RECRUITING', 'TEAM_MANAGEMENT', 'MOTIVATION', 'SOFT_SKILLS', 'COMPANY_AND_KPM']);
    expect((row!.payload.categories as Row[])[4]).toEqual(MOTIVATION);
    expect({ version: row!.version, status: row!.status }).toEqual({ version: 1, status: 'published' });
  });

  it('UI-063 gives it to every version of the Default template, drafts included', async () => {
    await templates().insertMany([doc(before()), doc(before(), { version: 2, status: 'draft' })]);
    expect(await up(db())).toEqual({ templates: 2, current: 0 });
    for (const row of await templates().find(defaults).toArray()) expect(codes(row.payload)).toContain('MOTIVATION');
  });

  it('UI-063 places it before Soft Skills where Team Management is gone, and at the end where both are', async () => {
    const noTeam = { ...before(), categories: before().categories.filter((c) => c.code !== 'TEAM_MANAGEMENT') };
    const neither = { ...before(), categories: before().categories.filter((c) => !['TEAM_MANAGEMENT', 'SOFT_SKILLS'].includes(String(c.code))) };
    await templates().insertMany([doc(noTeam), doc(neither, { version: 2 })]);
    await up(db());
    const [one, two] = await templates().find(defaults).sort({ version: 1 }).toArray();
    expect(codes(one.payload)).toEqual(['SALES', 'PRODUCT', 'RECRUITING', 'MOTIVATION', 'SOFT_SKILLS', 'COMPANY_AND_KPM']);
    expect(codes(two.payload)).toEqual(['SALES', 'PRODUCT', 'RECRUITING', 'COMPANY_AND_KPM', 'MOTIVATION']);
  });

  it('UI-063 leaves a template already holding Motivation as it is — today’s 0037, or the Super Admin’s own words', async () => {
    const own = { ...before(), categories: [...before().categories, { code: 'MOTIVATION', label: 'Semangat', description: null }] };
    await templates().insertMany([doc(today()), doc(own, { version: 2 })]);
    const was = await everything();
    expect(await up(db())).toEqual({ templates: 0, current: 2 });
    expect(await everything()).toEqual(was);
  });

  it('UI-063 never touches an office, its snapshot, an insurer’s template, another named template or a deleted row (ADR-0018)', async () => {
    await db().collection('trainingCategories').insertMany(before().categories.map((c, i) => ({
      kpmId: KPM_A, ...c, displayOrder: i + 1, version: 1, status: 'active', archivedAt: null, deletedAt: null,
    })));
    await db().collection('configSnapshots').insertOne({ kpmId: KPM_A, version: 1, deletedAt: null, payload: { training: before().categories } });
    await templates().insertMany([
      { ...doc(before()), companyId: '66f00000000000000000c001', templateId: 't1' },
      { ...doc(before()), templateId: '66f00000000000000000d001' },
      doc(before(), { deletedAt: NOW }),
    ]);
    const was = await everything();
    expect(await up(db())).toEqual({ templates: 0, current: 0 });
    expect(await everything()).toEqual(was);
  });

  it('UI-063 is idempotent: a second run writes nothing, and an empty database is given nothing', async () => {
    expect(await up(db())).toEqual({ templates: 0, current: 0 });
    await templates().insertOne(doc(before()));
    await up(db());
    const once = await everything();
    expect(await up(db())).toEqual({ templates: 0, current: 1 });
    expect(await everything()).toEqual(once);
  });
});
