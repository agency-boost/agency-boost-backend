import mongoose from 'mongoose';
import { ACTIVITY } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0015-kpm-activity-backdate-grace';

/**
 * ADR-0042. Every existing office gets the activity correction window (P6-T1).
 *
 * The migration exists rather than a `??` fallback in the service for a reason worth pinning: a
 * setting an office cannot see on its own Branch info screen is one nobody can change, and *"the
 * default is applied invisibly"* is how a knob quietly becomes a constant again.
 */
describe('0015 — the activity backdating grace window', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const kpms = () => db().collection('kpms');

  beforeEach(async () => {
    await clearCollections();
    await kpms().deleteMany({});
  });

  const office = (over: Record<string, unknown> = {}) => ({
    companyId: 'co-1', code: `0${Math.floor(Math.random() * 900) + 100}`,
    branchName: 'A', timezone: 'Asia/Jakarta', ...over,
  });

  it('gives the window to every office that does not have one', async () => {
    await kpms().insertMany([
      office({ settings: { activityDailyMaxCount: 999, complianceWindowDays: 7 } }),
      office({ settings: { activityDailyMaxCount: 999 } }),
    ]);

    const { updated } = await up(db());

    expect(updated).toBe(2);
    const rows = await kpms().find({}).toArray();
    for (const row of rows) {
      expect((row.settings as Record<string, number>).activityBackdateGraceDays)
        .toBe(ACTIVITY.BACKDATE_GRACE_DAYS);
      // Every other knob is left exactly as it was: this adds one field, it does not reseed.
      expect((row.settings as Record<string, number>).activityDailyMaxCount).toBe(999);
    }
  });

  it('leaves an office that already chose one alone', async () => {
    // The whole point of a tenant setting: an office whose month-end differs has already said so,
    // and a migration that overwrote it would take the choice back without asking.
    await kpms().insertOne(office({ settings: { activityBackdateGraceDays: 3 } }));

    const { updated } = await up(db());

    expect(updated).toBe(0);
    const row = await kpms().findOne({});
    expect((row!.settings as Record<string, number>).activityBackdateGraceDays).toBe(3);
  });

  it('is idempotent — a second run writes nothing', async () => {
    await kpms().insertOne(office({ settings: {} }));

    const first = await up(db());
    const second = await up(db());

    expect(first.updated).toBe(1);
    expect(second.updated).toBe(0);
  });

  it('takes an office with no settings object at all', async () => {
    // Older rows predate `KpmSettings`; `settings.x` on a missing parent is still a missing field,
    // and the dotted `$set` creates the object rather than throwing.
    await kpms().insertOne(office());

    const { updated } = await up(db());

    expect(updated).toBe(1);
    const row = await kpms().findOne({});
    expect((row!.settings as Record<string, number>).activityBackdateGraceDays)
      .toBe(ACTIVITY.BACKDATE_GRACE_DAYS);
  });
});
