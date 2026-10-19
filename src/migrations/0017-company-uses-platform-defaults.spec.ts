import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0017-company-uses-platform-defaults';

/**
 * Client feedback, 2026-09-24. A company created before the switch existed was seeded, so `true`
 * is what happened to it rather than a default being guessed at.
 */
describe('0017 — every existing company took the defaults', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const companies = () => db().collection('companies');

  beforeEach(async () => {
    await clearCollections();
    await companies().deleteMany({});
  });

  const company = (over: Record<string, unknown> = {}) => ({
    name: 'Prudential', slug: `p-${Math.random().toString(36).slice(2, 8)}`,
    defaultCurrency: 'IDR', defaultLocale: 'id-ID', defaultTimezone: 'Asia/Jakarta',
    status: 'active', deletedAt: null, ...over,
  });

  it('marks every company that has no answer', async () => {
    await companies().insertMany([company(), company()]);

    const { updated } = await up(db());

    expect(updated).toBe(2);
    const rows = await companies().find({}).toArray();
    expect(rows.every((r) => r.usesPlatformDefaults === true)).toBe(true);
  });

  it('leaves a company that already answered alone', async () => {
    // A blank company created after the switch shipped must not be told it took the defaults.
    await companies().insertOne(company({ usesPlatformDefaults: false }));

    const { updated } = await up(db());

    expect(updated).toBe(0);
    expect((await companies().findOne({}))!.usesPlatformDefaults).toBe(false);
  });

  it('reaches a soft-deleted company too', async () => {
    // The console does not list it, but the audit log names it — and a field the product
    // branches on should not depend on which query found the row.
    await companies().insertOne(company({ deletedAt: new Date() }));

    expect((await up(db())).updated).toBe(1);
  });

  it('is idempotent — a second run writes nothing', async () => {
    await companies().insertOne(company());

    expect((await up(db())).updated).toBe(1);
    expect((await up(db())).updated).toBe(0);
  });
});
