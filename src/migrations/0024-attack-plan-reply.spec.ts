import mongoose from 'mongoose';
import { SEED_PRODUCTS, SEED_REPLY_BY_NEED } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up as seedCatalog } from './0013-seed-product-catalog';
import { up } from './0024-attack-plan-reply';

const SEEDED = new Date('2026-09-18T02:00:00Z');
const NOW = new Date('2026-10-08T02:00:00Z');

/**
 * D-reply (Phase 14, P14-T7 AC-9). The push-back's *You say* becomes the need's reply the
 * prototype renders, on every company product that still holds the differentiator P5-T4 seeded —
 * and on nothing else: not a reply the Super Admin edited, not a product the company added, and
 * never an office's own override.
 */
describe('0024 — the attack plan’s reply, for the catalogs already seeded', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const col = (name: string) => db().collection(name);
  const MAPAN = SEED_PRODUCTS.find((p) => p.code === 'PRUMAPAN')!;
  const FUTURE = SEED_PRODUCTS.find((p) => p.code === 'PRUFUTURE')!;

  /**
   * Two companies' catalogs as P5-T4 seeded them: `0013` over today's constants, then every reply
   * put back to the differentiator, which is what a database seeded before the correction holds.
   */
  async function seedAsBefore(): Promise<{ prudential: string; allianz: string }> {
    const { insertedIds } = await col('companies').insertMany([
      { name: 'Prudential', slug: 'prudential', deletedAt: null },
      { name: 'Allianz Life', slug: 'allianz-life', deletedAt: null },
    ]);
    await seedCatalog(db(), SEEDED);
    for (const seed of SEED_PRODUCTS) {
      await col('products').updateMany(
        { code: seed.code },
        { $set: { 'defaultAttackPlan.objectionYouSay': seed.differentiator } },
      );
    }
    return { prudential: String(insertedIds[0]), allianz: String(insertedIds[1]) };
  }

  beforeEach(async () => {
    await clearCollections();
    for (const name of ['companies', 'products', 'kpmProductConfigs']) await col(name).deleteMany({});
  });

  it('rewrites every seeded reply to its need’s, in both companies, once', async () => {
    await seedAsBefore();

    expect(await up(db(), NOW)).toEqual({ rewritten: 62, current: 0, edited: 0 });

    const rows = await col('products').find({}).toArray();
    for (const row of rows) {
      const seed = SEED_PRODUCTS.find((p) => p.code === row.code)!;
      expect(row.defaultAttackPlan.objectionYouSay).toBe(SEED_REPLY_BY_NEED[seed.primaryNeeds[0]]);
      // The words moved, so the version moves with them — as any other edit to a product.
      expect(row).toMatchObject({ version: 2, updatedAt: NOW });
      // Only the reply: the objection it answers, and the differentiator, are as they were.
      expect(row.differentiator).toBe(seed.differentiator);
      expect(row.defaultAttackPlan.objectionTheySay).toBe(seed.defaultAttackPlan.objectionTheySay);
    }
    expect((rows.find((r) => r.code === 'PRUMAPAN'))!.defaultAttackPlan.objectionYouSay)
      .toBe(SEED_REPLY_BY_NEED.retirement);
  });

  it('runs twice with the same result as running once', async () => {
    await seedAsBefore();

    await up(db(), NOW);
    const after = await col('products').find({}).sort({ _id: 1 }).toArray();

    expect(await up(db(), new Date('2026-10-09T02:00:00Z')))
      .toEqual({ rewritten: 0, current: 62, edited: 0 });
    // Not a field nor a version moved on the second run.
    expect(await col('products').find({}).sort({ _id: 1 }).toArray()).toEqual(after);
  });

  it('leaves a reply the Super Admin edited as the company wrote it', async () => {
    const { prudential, allianz } = await seedAsBefore();
    const theirs = 'Kami paham. Mari lihat angkanya bersama dulu, baru Bapak/Ibu putuskan.';
    await col('products').updateOne(
      { companyId: prudential, code: 'PRUMAPAN' },
      { $set: { 'defaultAttackPlan.objectionYouSay': theirs } },
    );
    // Edited by one character is edited: the comparison is exact.
    await col('products').updateOne(
      { companyId: prudential, code: 'PRUFUTURE' },
      { $set: { 'defaultAttackPlan.objectionYouSay': `${FUTURE.differentiator} ` } },
    );

    for (const run of [1, 2]) {
      const result = await up(db(), NOW);
      expect(result.edited).toBe(2);
      expect(result.rewritten).toBe(run === 1 ? 60 : 0);
    }

    const mapan = await col('products').findOne({ companyId: prudential, code: 'PRUMAPAN' });
    expect(mapan).toMatchObject({ defaultAttackPlan: { objectionYouSay: theirs }, version: 1 });
    const future = await col('products').findOne({ companyId: prudential, code: 'PRUFUTURE' });
    expect(future!.defaultAttackPlan.objectionYouSay).toBe(`${FUTURE.differentiator} `);
    // The other company's untouched copy of the same code is still corrected.
    expect((await col('products').findOne({ companyId: allianz, code: 'PRUMAPAN' }))!
      .defaultAttackPlan.objectionYouSay).toBe(SEED_REPLY_BY_NEED.retirement);
  });

  it('leaves a product the company added alone, whatever its reply says', async () => {
    const { prudential } = await seedAsBefore();
    await col('products').insertOne({
      companyId: prudential, code: 'OWN_ONE', name: 'Their own', sortOrder: 32,
      differentiator: MAPAN.differentiator,
      defaultAttackPlan: { objectionYouSay: MAPAN.differentiator },
      version: 1, deletedAt: null,
    });

    await up(db(), NOW);

    expect(await col('products').findOne({ code: 'OWN_ONE' }))
      .toMatchObject({ defaultAttackPlan: { objectionYouSay: MAPAN.differentiator }, version: 1 });
  });

  it('never reads or writes an office’s override, drafted or approved', async () => {
    const { prudential } = await seedAsBefore();
    const mapan = await col('products').findOne({ companyId: prudential, code: 'PRUMAPAN' });
    // An office whose own words happen to be the old seeded ones: they are the office's now.
    const override = {
      kpmId: '66f0000000000000000000a1', productId: String(mapan!._id), active: true,
      overrides: { objectionYouSay: MAPAN.differentiator },
      approvedOverrides: { objectionYouSay: MAPAN.differentiator },
      reviewState: 'approved', version: 2, deletedAt: null,
    };
    await col('kpmProductConfigs').insertOne({ ...override });

    await up(db(), NOW);
    await up(db(), NOW);

    expect(await col('kpmProductConfigs').findOne({ kpmId: override.kpmId }))
      .toMatchObject({
        overrides: { objectionYouSay: MAPAN.differentiator },
        approvedOverrides: { objectionYouSay: MAPAN.differentiator },
        version: 2,
      });
  });

  it('finds nothing to do over a catalog seeded today', async () => {
    await col('companies').insertOne({ name: 'Prudential', slug: 'prudential', deletedAt: null });
    await seedCatalog(db(), SEEDED);

    expect(await up(db(), NOW)).toEqual({ rewritten: 0, current: 31, edited: 0 });
  });
});
