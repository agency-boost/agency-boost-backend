import mongoose from 'mongoose';
import {
  SEED_TRAINING_CATEGORIES, SEEDED_TRAINING_DESCRIPTIONS_BEFORE_P18_97, SEEDED_TRAINING_WORDINGS_BEFORE_OD_238,
} from '@/domain/constants/training-taxonomy';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0045-training-category-descriptions';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const OLD_SALES = SEEDED_TRAINING_DESCRIPTIONS_BEFORE_P18_97.SALES;
/** The English lines it was written for — the seed's Indonesian since P18.98-T7 is `0046`'s to give a template. */
const NEW = Object.fromEntries(
  Object.entries(SEEDED_TRAINING_WORDINGS_BEFORE_OD_238.categories).map(([code, c]) => [code, c.description]),
);
/**
 * The six this migration was written for. *Motivation*, the owner's seventh (UI V1, P18.99-T10), came after it, was never
 * seeded without a line, and is `0048`'s to give a template.
 */
const SIX = SEED_TRAINING_CATEGORIES.filter((c) => c.code in SEEDED_TRAINING_DESCRIPTIONS_BEFORE_P18_97);
const CODES = SIX.map((c) => c.code);

/**
 * **A real line for each default training category, for offices that already exist** (P18.97-T4 AC-9, ADR-0176 §9;
 * UI-031): in the working copy, each office's newest snapshot and every `training_taxonomy` template — only where the
 * seeded words are still held, an office's own words and an edited category untouched, no version moved, and a second
 * run writing nothing.
 */
describe('0045 — the default training categories’ descriptions (P18.97-T4 AC-9)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  /** The six as seeded, Sales with OD-150's sentence and the rest with none, at version 1 unless edited. */
  const seeded = (kpmId: string, over: Record<string, { description?: string | null; version?: number }> = {}) =>
    SIX.map((c, i) => ({
      kpmId, code: c.code, label: c.label, description: SEEDED_TRAINING_DESCRIPTIONS_BEFORE_P18_97[c.code],
      displayOrder: i + 1, version: 1, status: 'active', archivedAt: null, deletedAt: null, ...over[c.code],
    }));
  const snapshot = (kpmId: string, version: number, training: unknown[]) => ({
    kpmId, version, sourceVersion: 1, publishedAt: new Date(), publishedBy: null, deletedAt: null,
    payload: { training, ratios: [{ code: 'SELLING_SUCCESS_RATE' }] },
  });
  const templateCategories = (over: Record<string, string | null> = {}) => SIX.map((c) => ({
    code: c.code, label: c.label,
    description: c.code in over ? over[c.code] : SEEDED_TRAINING_DESCRIPTIONS_BEFORE_P18_97[c.code],
  }));
  const descriptions = async (kpmId: string) => Object.fromEntries(
    (await db().collection('trainingCategories').find({ kpmId }).toArray()).map((c) => [c.code, c.description]),
  );

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    // Written through the driver, so no model registers them and `clearCollections` would not empty them.
    for (const name of ['trainingCategories', 'configSnapshots', 'companyTemplates']) await db().collection(name).deleteMany({});
    await db().collection('trainingCategories').insertMany([
      ...seeded(KPM_A, { RECRUITING: { description: null, version: 1 } }),
      // Office B wrote its own Sales line, and cleared Product's after writing one (version 2): both are its choices.
      ...seeded(KPM_B, { SALES: { description: 'Kalimat kami sendiri.', version: 4 }, PRODUCT: { description: null, version: 2 } }),
    ]);
    await db().collection('trainingCategories').updateOne({ kpmId: KPM_A, code: 'SOFT_SKILLS' }, { $set: { description: '' } });
    await db().collection('configSnapshots').insertMany([
      snapshot(KPM_A, 1, seeded(KPM_A)),
      snapshot(KPM_A, 2, seeded(KPM_A)),
      snapshot(KPM_B, 1, seeded(KPM_B, { SALES: { description: 'Kalimat kami sendiri.', version: 4 }, PRODUCT: { description: null, version: 2 } })),
    ]);
    await db().collection('companyTemplates').insertMany([
      // The Template company's Default template, as 0037 wrote it.
      { companyId: 'template', kind: 'training_taxonomy', status: 'published', version: 1, payload: { categories: templateCategories() } },
      // A company's draft somebody has edited: its own Sales line, Product cleared.
      { companyId: 'c1', kind: 'training_taxonomy', status: 'draft', version: 3, payload: { categories: templateCategories({ SALES: 'Edited.', PRODUCT: null }) } },
      { companyId: 'c1', kind: 'activity_taxonomy', status: 'published', version: 1, payload: { categories: [{ code: 'SALES', description: OLD_SALES }] } },
    ]);
  });

  it('P18.97-T4 AC-9 gives every seeded category of the working copy its line, versions kept', async () => {
    // Office A's six, and office B's four it never touched; both offices' newest snapshots; the Default template.
    expect(await up(db())).toEqual({ categories: 10, snapshots: 2, templates: 1 });

    expect(await descriptions(KPM_A)).toEqual(NEW);
    // P18.98-T7 (OD-238): the English it was written for, never the seed's Indonesian — an office keeps its language.
    expect(Object.values(await descriptions(KPM_A))).not.toContain(SEED_TRAINING_CATEGORIES[0].description);
    const versions = (await db().collection('trainingCategories').find({ kpmId: KPM_A }).toArray()).map((c) => c.version);
    expect(versions).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('P18.97-T4 AC-9 leaves an office’s own words, and a description it cleared, as they are', async () => {
    await up(db());
    expect(await descriptions(KPM_B)).toEqual({
      ...NEW, SALES: 'Kalimat kami sendiri.', PRODUCT: null,
    });
    const snapshotB = await db().collection('configSnapshots').findOne({ kpmId: KPM_B });
    const sold = (snapshotB!.payload.training as { code: string; description: string | null }[]);
    expect(sold.find((c) => c.code === 'SALES')!.description).toBe('Kalimat kami sendiri.');
    expect(sold.find((c) => c.code === 'PRODUCT')!.description).toBeNull();
    expect(sold.find((c) => c.code === 'RECRUITING')!.description).toBe(NEW.RECRUITING);
  });

  it('P18.97-T4 AC-9 rewrites the newest snapshot agents read, and leaves the older ones as the history they are', async () => {
    await up(db());
    const snaps = await db().collection('configSnapshots').find({ kpmId: KPM_A }).sort({ version: 1 }).toArray();
    const words = (s: (typeof snaps)[number]) => (s.payload.training as { description: string | null }[]).map((c) => c.description);
    expect(words(snaps[1])).toEqual(CODES.map((code) => NEW[code]));
    expect(words(snaps[0])).toEqual(CODES.map((code) => SEEDED_TRAINING_DESCRIPTIONS_BEFORE_P18_97[code]));
    // Nothing else in the payload moved.
    expect(snaps[1].payload.ratios).toEqual([{ code: 'SELLING_SUCCESS_RATE' }]);
    // Office B's newest also held seeded words for its untouched four, so it was written too.
    const snapB = await db().collection('configSnapshots').findOne({ kpmId: KPM_B });
    expect((snapB!.payload.training as { code: string; description: string | null }[])
      .find((c) => c.code === 'TEAM_MANAGEMENT')!.description).toBe(NEW.TEAM_MANAGEMENT);
  });

  it('P18.97-T4 AC-9 gives the Default template its six lines, and a template somebody edited none', async () => {
    await up(db());
    const templates = await db().collection('companyTemplates').find({}).sort({ companyId: 1, kind: 1 }).toArray();
    const byWho = Object.fromEntries(templates.map((t) => [`${t.companyId}:${t.kind}`, t]));
    expect((byWho['template:training_taxonomy'].payload.categories as { description: string }[]).map((c) => c.description))
      .toEqual(CODES.map((code) => NEW[code]));
    expect(byWho['template:training_taxonomy'].version).toBe(1);
    const edited = byWho['c1:training_taxonomy'].payload.categories as { code: string; description: string | null }[];
    expect(edited.find((c) => c.code === 'SALES')!.description).toBe('Edited.');
    expect(edited.find((c) => c.code === 'PRODUCT')!.description).toBeNull();
    expect(edited.find((c) => c.code === 'RECRUITING')!.description).toBeNull();
    // Another kind's Sales is not a training category.
    expect(byWho['c1:activity_taxonomy'].payload.categories[0].description).toBe(OLD_SALES);
  });

  it('P18.97-T4 AC-9 is idempotent: a second run writes nothing, and a line an Owner clears afterwards stays cleared', async () => {
    const first = await up(db());
    // The migration's printout (`run.ts` logs it).
    // eslint-disable-next-line no-console
    console.log('0045-training-category-descriptions', JSON.stringify(first));
    expect(await up(db())).toEqual({ categories: 0, snapshots: 0, templates: 0 });

    // The Owner clears Product's line through Settings, which moves the row's version, and the next deploy runs again.
    await db().collection('trainingCategories').updateOne(
      { kpmId: KPM_A, code: 'PRODUCT' }, { $set: { description: null }, $inc: { version: 1 } },
    );
    expect(await up(db())).toEqual({ categories: 0, snapshots: 0, templates: 0 });
    expect((await descriptions(KPM_A)).PRODUCT).toBeNull();
  });

  it('P18.97-T4 AC-9 passes over what holds none of the defaults: another code, a snapshot without training, a template without Sales', async () => {
    for (const name of ['trainingCategories', 'configSnapshots', 'companyTemplates']) await db().collection(name).deleteMany({});
    await db().collection('trainingCategories').insertOne({
      kpmId: KPM_A, code: 'OUR_OWN', label: 'Our own', description: null, version: 1, status: 'active', deletedAt: null,
    });
    await db().collection('configSnapshots').insertMany([
      { kpmId: KPM_A, version: 1, deletedAt: null, payload: { ratios: [] } },
      { kpmId: KPM_B, version: 1, deletedAt: null, payload: { training: [{ code: 7 }, { label: 'no code' }] } },
    ]);
    await db().collection('companyTemplates').insertMany([
      { companyId: 'c2', kind: 'training_taxonomy', status: 'draft', version: 1, payload: { categories: [{ code: 'PRODUCT', description: null }] } },
      { companyId: 'c3', kind: 'training_taxonomy', status: 'draft', version: 1, payload: {} },
    ]);

    expect(await up(db())).toEqual({ categories: 0, snapshots: 0, templates: 0 });
    expect(await db().collection('trainingCategories').findOne({ code: 'OUR_OWN' })).toMatchObject({ description: null });
    expect((await db().collection('companyTemplates').findOne({ companyId: 'c2' }))!.payload.categories[0].description).toBeNull();
  });
});
