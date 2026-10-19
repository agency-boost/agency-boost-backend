import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0009-ratio-standard-formula';

/**
 * ADR-0024. The pair worth pinning: a provisioned row gets its own formula recorded as the
 * standard — exact, because nothing could change it before this — and an office's own row
 * gets nothing, because it never had a standard to move away from.
 */
describe('0009 — the formula an office was seeded with', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const ratios = () => db().collection('ratioDefinitions');

  beforeEach(async () => {
    await clearCollections();
    await ratios().deleteMany({});
  });

  const row = (over: Record<string, unknown>) => ({
    kpmId: 'kpm-a', label: 'x', numerator: ['A'], denominator: ['B', 'C'],
    benchmark: 1, comparison: 'gte', displayUnit: 'decimal', displayOrder: 1, version: 1,
    origin: 'platform', status: 'active', archivedAt: null, deletedAt: null, ...over,
  });

  it('records a provisioned row’s own formula as its standard', async () => {
    await ratios().insertOne(row({ code: 'SELLING_SUCCESS_RATE' }));

    expect(await up(db())).toEqual({ recorded: 1 });

    const saved = (await ratios().findOne({ code: 'SELLING_SUCCESS_RATE' }))!;
    expect(saved.standardNumerator).toEqual(['A']);
    expect(saved.standardDenominator).toEqual(['B', 'C']);
  });

  it('leaves an office’s own ratio without one', async () => {
    await ratios().insertOne(row({ code: 'REFERRAL_RATE', origin: 'office' }));

    expect(await up(db())).toEqual({ recorded: 0 });
    expect((await ratios().findOne({ code: 'REFERRAL_RATE' }))!.standardNumerator).toBeUndefined();
  });

  it('never overwrites a standard already recorded', async () => {
    await ratios().insertOne(row({
      code: 'SELLING_SUCCESS_RATE', numerator: ['CHANGED'],
      standardNumerator: ['A'], standardDenominator: ['B', 'C'],
    }));

    expect(await up(db())).toEqual({ recorded: 0 });
    expect((await ratios().findOne({}))!.standardNumerator).toEqual(['A']);
  });

  it('is idempotent', async () => {
    await ratios().insertOne(row({ code: 'SELLING_SUCCESS_RATE' }));
    await up(db());
    expect(await up(db())).toEqual({ recorded: 0 });
  });

  it('does nothing to an empty collection', async () => {
    expect(await up(db())).toEqual({ recorded: 0 });
  });
});
