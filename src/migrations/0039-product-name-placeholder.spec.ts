import mongoose from 'mongoose';
import { SEED_PRODUCTS } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up as seedCatalog } from './0013-seed-product-catalog';
import { SEEDED_DISPLAY_NAME_SUFFIX, up } from './0039-product-name-placeholder';

const SEEDED = new Date('2026-09-18T02:00:00Z');
const NOW = new Date('2026-10-26T02:00:00Z');

/**
 * **P18.95-T6 AC-4 — the name fix and migration `0039`** (UI-023, ADR-0167; parity I-424). *PRUMapan (nama
 * kami)*, the demo seed's rename, is given back to the company's name in every office still holding it — and
 * nothing else is touched: not a name an Owner typed, not a row for another product, not a soft-deleted row,
 * not the rest of the row.
 */
describe('P18.95-T6 AC-4 migration 0039 — a product’s name without the seed’s placeholder', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const col = (name: string) => db().collection(name);
  const MAPAN = SEED_PRODUCTS.find((p) => p.code === 'PRUMAPAN')!;

  /** Two companies' catalogs, as every database has them since 0013. */
  async function catalogs(): Promise<{ prudential: string; allianz: string }> {
    const { insertedIds } = await col('companies').insertMany([
      { name: 'Prudential', slug: 'prudential', deletedAt: null },
      { name: 'Allianz Life', slug: 'allianz-life', deletedAt: null },
    ]);
    await seedCatalog(db(), SEEDED);
    return { prudential: String(insertedIds[0]), allianz: String(insertedIds[1]) };
  }
  const productId = async (companyId: string, code: string) =>
    String((await col('products').findOne({ companyId, code }))!._id);

  /** An office's row for a product, as `configure` in `demo.ts` wrote it. */
  const row = (kpmId: string, product: string, fields: Record<string, unknown> = {}) => ({
    kpmId, productId: product, active: null, overrides: {}, reviewState: 'none',
    approvedOverrideVersion: 0, approvedOverrides: {}, documents: {},
    version: 1, deletedAt: null, createdBy: null, updatedBy: null, ...fields,
  });

  beforeEach(async () => {
    await clearCollections();
    for (const name of ['companies', 'products', 'kpmProductConfigs']) await col(name).deleteMany({});
  });

  it('P18.95-T6 AC-4 the name fix + migration: on an empty database it does nothing, and creates nothing', async () => {
    expect(await up(db(), NOW)).toEqual({ cleared: 0 });
    expect(await up(db(), NOW)).toEqual({ cleared: 0 });
    expect(await col('kpmProductConfigs').countDocuments({})).toBe(0);
  });

  it('P18.95-T6 AC-4 the name fix + migration: gives the seeded rename back to the company’s name, in every company', async () => {
    const { prudential, allianz } = await catalogs();
    const description = 'Dana pensiun yang cair rutin dari usia 55.';
    await col('kpmProductConfigs').insertMany([
      // 0417 as the seed left it: the rename, and the approved description laid onto the same row.
      row('kpm-0417', await productId(prudential, 'PRUMAPAN'), {
        overrides: { displayName: `PRUMapan${SEEDED_DISPLAY_NAME_SUFFIX}`, description },
        approvedOverrides: { description }, approvedOverrideVersion: 2, reviewState: 'approved', version: 2,
      }),
      row('kpm-0555', await productId(prudential, 'PRUMAPAN'), { overrides: { displayName: 'PRUMapan (nama kami)' } }),
      // An office of the other company, which the seed renamed the same way.
      row('kpm-allianz', await productId(allianz, 'PRUMAPAN'), { overrides: { displayName: 'PRUMapan (nama kami)' } }),
    ]);

    expect(await up(db(), NOW)).toEqual({ cleared: 3 });

    const rows = await col('kpmProductConfigs').find({}).toArray();
    for (const r of rows) {
      // Given back, not rewritten: no display name of its own, so the office reads the company's, *PRUMapan*.
      expect(r.overrides).not.toHaveProperty('displayName');
      expect(r.updatedAt).toEqual(NOW);
    }
    expect(MAPAN.name).toBe('PRUMapan');
    // The rest of the row is the office's, as it was: its description, drafted and approved, its review.
    expect(rows.find((r) => r.kpmId === 'kpm-0417')).toMatchObject({
      overrides: { description }, approvedOverrides: { description }, reviewState: 'approved',
      approvedOverrideVersion: 2, version: 3,
    });
    expect(rows.find((r) => r.kpmId === 'kpm-0555')).toMatchObject({ overrides: {}, version: 2 });
  });

  it('P18.95-T6 AC-4 the name fix + migration: touches only the seeded default — an Owner’s own name stays', async () => {
    const { prudential } = await catalogs();
    const mapan = await productId(prudential, 'PRUMAPAN');
    const future = await productId(prudential, 'PRUFUTURE');
    const kept = [
      // A name an Owner typed.
      row('kpm-a', mapan, { overrides: { displayName: 'PRUMapan BSD' } }),
      // The suffix with something after it, or another word before it: theirs, not the seed's.
      row('kpm-b', mapan, { overrides: { displayName: 'PRUMapan (nama kami) BSD' } }),
      row('kpm-c', mapan, { overrides: { displayName: 'PRUMapan Plus (nama kami)' } }),
      // Another product's name with the suffix, on this product's row: not what the seed wrote for it.
      row('kpm-d', future, { overrides: { displayName: 'PRUMapan (nama kami)' } }),
      // A soft-deleted row is history and is not rewritten.
      row('kpm-e', mapan, { overrides: { displayName: 'PRUMapan (nama kami)' }, deletedAt: SEEDED }),
      // A row with no rename at all, and one naming a product that is not there.
      row('kpm-f', mapan, { active: false }),
      row('kpm-g', '66f0000000000000000000ff', { overrides: { displayName: 'PRUMapan (nama kami)' } }),
      row('kpm-h', 'not-an-id', { overrides: { displayName: 'PRUMapan (nama kami)' } }),
    ];
    await col('kpmProductConfigs').insertMany(kept.map((r) => ({ ...r })));
    const before = await col('kpmProductConfigs').find({}).sort({ kpmId: 1 }).toArray();

    expect(await up(db(), NOW)).toEqual({ cleared: 0 });

    expect(await col('kpmProductConfigs').find({}).sort({ kpmId: 1 }).toArray()).toEqual(before);
  });

  it('P18.95-T6 AC-4 the name fix + migration: run twice, the second run changes nothing', async () => {
    const { prudential } = await catalogs();
    await col('kpmProductConfigs').insertMany([
      row('kpm-0417', await productId(prudential, 'PRUMAPAN'), { overrides: { displayName: 'PRUMapan (nama kami)' } }),
      row('kpm-a', await productId(prudential, 'PRUMAPAN'), { overrides: { displayName: 'PRUMapan BSD' } }),
    ]);

    expect(await up(db(), NOW)).toEqual({ cleared: 1 });
    const after = await col('kpmProductConfigs').find({}).sort({ _id: 1 }).toArray();

    expect(await up(db(), new Date('2026-10-27T02:00:00Z'))).toEqual({ cleared: 0 });
    // Not a field, a version nor a timestamp moved on the second run.
    expect(await col('kpmProductConfigs').find({}).sort({ _id: 1 }).toArray()).toEqual(after);
    // The company's products were never written.
    expect(await col('products').countDocuments({ version: { $ne: 1 } })).toBe(0);
  });
});
