import mongoose from 'mongoose';
import { SEED_PRODUCTS } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0013-seed-product-catalog';

const NOW = new Date('2026-09-18T02:00:00Z');

/**
 * P5-T4. Companies that already exist get the catalog a new one is created with — once, and never
 * over the top of a shelf its Super Admin has since curated.
 */
describe('0013 — the product catalog for companies that already exist', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const col = (name: string) => db().collection(name);

  beforeEach(async () => {
    await clearCollections();
    for (const name of ['companies', 'products']) await col(name).deleteMany({});
  });

  const company = (over: Record<string, unknown> = {}) => ({
    name: 'Prudential Indonesia', slug: 'prudential-indonesia', deletedAt: null, ...over,
  });

  it('seeds every live company with the 31 products', async () => {
    await col('companies').insertMany([
      company(),
      company({ name: 'Allianz Life', slug: 'allianz-life' }),
    ]);

    expect(await up(db(), NOW)).toEqual({ seeded: 2, products: 62, skipped: 0 });

    const rows = await col('products').find({}).sort({ companyId: 1, sortOrder: 1 }).toArray();
    expect(rows).toHaveLength(62);
    expect(new Set(rows.map((r) => r.companyId)).size).toBe(2);
    expect(rows[0]).toMatchObject({
      code: SEED_PRODUCTS[0].code,
      name: SEED_PRODUCTS[0].name,
      lifecycle: 'active',
      version: 1,
      deletedAt: null,
      createdAt: NOW,
    });
  });

  it('states no commission for anybody (parity F-15)', async () => {
    await col('companies').insertOne(company());
    await up(db(), NOW);

    const rows = await col('products').find({}).toArray();
    expect(rows.every((r) => Array.isArray(r.commissionSchedule)
      && r.commissionSchedule.length === 0)).toBe(true);
  });

  it('carries the two run-off products as closed to new business, sold by no office by default', async () => {
    await col('companies').insertOne(company());
    await up(db(), NOW);

    const runOff = await col('products').find({ lifecycle: { $ne: 'active' } }).toArray();
    expect(runOff.map((r) => r.code))
      .toEqual(['PRULINK_GENERASI_BARU_PGB', 'PRULINK_SYARIAH_GENERASI_BARU_PSGB']);
    expect(runOff.every((r) => r.activeByDefault === false)).toBe(true);
  });

  it('skips a company that already has a product, and never tops one up', async () => {
    const { insertedId } = await col('companies').insertOne(company());
    const companyId = String(insertedId);
    await col('products').insertOne({
      companyId, code: 'OWN_ONE', name: 'Their own', sortOrder: 1, deletedAt: null,
    });

    expect(await up(db(), NOW)).toEqual({ seeded: 0, products: 0, skipped: 1 });

    // A Super Admin who withdrew a seeded product should not find it back after a deployment.
    expect(await col('products').countDocuments({ companyId })).toBe(1);
  });

  it('runs twice with the same result as running once', async () => {
    await col('companies').insertOne(company());

    await up(db(), NOW);
    expect(await up(db(), NOW)).toEqual({ seeded: 0, products: 0, skipped: 1 });
    expect(await col('products').countDocuments({})).toBe(31);
  });

  it('leaves a deleted company without a catalog', async () => {
    await col('companies').insertOne(company({ deletedAt: NOW }));

    expect(await up(db(), NOW)).toEqual({ seeded: 0, products: 0, skipped: 0 });
    expect(await col('products').countDocuments({})).toBe(0);
  });
});
