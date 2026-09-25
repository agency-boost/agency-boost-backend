import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0019-goal-months-left-override';

/**
 * P8-T5. The divisor stops being stored and starts being derived.
 *
 * The case worth the test is the **choice the data cannot express**: a row does not say whether its
 * figure was the office's calendar or the agent's own, so the migration keeps it as an override —
 * the reading that cannot lose a deliberate decision.
 */
describe('0019 — months left becomes an override', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const goals = () => db().collection('goals');

  beforeEach(async () => {
    await clearCollections();
    await goals().deleteMany({});
  });

  const old = (over: Record<string, unknown> = {}) => ({
    kpmId: 'kpm-1', membershipId: 'mem-1', period: '2026', mode: 'direct',
    monthsLeft: 11.9, deletedAt: null, ...over,
  });

  it('keeps the figure, as an override', async () => {
    await goals().insertOne(old() as never);

    const { migrated } = await up(db());

    expect(migrated).toBe(1);
    const row = await goals().findOne({ membershipId: 'mem-1' });
    expect(row!.monthsLeftOverride).toBe(11.9);
    expect(row).not.toHaveProperty('monthsLeft');
  });

  it('takes a row whose figure was never written', async () => {
    await goals().insertOne(old({ membershipId: 'mem-2', monthsLeft: null }) as never);

    await up(db());

    expect((await goals().findOne({ membershipId: 'mem-2' }))!.monthsLeftOverride).toBeNull();
  });

  it('leaves a row that already has the new shape alone', async () => {
    await goals().insertOne({
      kpmId: 'kpm-1', membershipId: 'mem-3', period: '2026', monthsLeftOverride: 4, deletedAt: null,
    } as never);

    const { migrated } = await up(db());

    expect(migrated).toBe(0);
    expect((await goals().findOne({ membershipId: 'mem-3' }))!.monthsLeftOverride).toBe(4);
  });

  it('is idempotent: a second run matches nothing', async () => {
    await goals().insertOne(old() as never);
    await up(db());

    expect(await up(db())).toEqual({ migrated: 0 });
  });
});
