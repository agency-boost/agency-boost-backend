import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0018-lead-commitments';

/**
 * P7-T5. The boolean that had to be swept becomes a month that never goes stale.
 *
 * The case worth the test is the **zone**: a lead updated at 23:30 Jakarta on the last of the
 * month belongs to that month, and reading the instant in UTC files it in the next one — which is
 * exactly the defect the whole day-boundary rule exists to stop (invariant §9).
 */
describe('0018 — a commitment carries the month it was made for', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const leads = () => db().collection('leads');
  const kpms = () => db().collection('kpms');

  const JAKARTA = '66f0000000000000000000a1';
  const NEW_YORK = '66f0000000000000000000b1';

  beforeEach(async () => {
    // `clearCollections` empties what the models registered; these two are reached through the
    // raw driver, as `0016`'s spec does with `leadStatuses`.
    await clearCollections();
    await leads().deleteMany({});
    await kpms().deleteMany({});
    await kpms().insertMany([
      { _id: new mongoose.Types.ObjectId(JAKARTA), timezone: 'Asia/Jakarta' },
      { _id: new mongoose.Types.ObjectId(NEW_YORK), timezone: 'America/New_York' },
    ] as never);
  });

  /** A lead as it was written before the month existed: a bare boolean and no `commitments`. */
  const old = (over: Record<string, unknown> = {}) => ({
    kpmId: JAKARTA, ownerMembershipId: 'mem-1', name: 'Pak Budi', type: 'sales',
    thisMonth: true, updatedAt: new Date('2026-09-20T04:00:00Z'), deletedAt: null, ...over,
  });

  it('turns a promise into the month it was made in', async () => {
    await leads().insertOne(old() as never);

    const { migrated, promised } = await up(db());

    expect({ migrated, promised }).toEqual({ migrated: 1, promised: 1 });
    const row = await leads().findOne({ name: 'Pak Budi' });
    expect(row!.commitments).toEqual([
      { month: '2026-09', at: new Date('2026-09-20T04:00:00Z'), byMembershipId: 'mem-1' },
    ]);
    expect(row).not.toHaveProperty('thisMonth');
  });

  it('reads the month in the office’s zone, not the server’s', async () => {
    // 2026-09-30T23:30Z is still September in New York and already October in Jakarta.
    const at = new Date('2026-09-30T23:30:00Z');
    await leads().insertMany([
      old({ name: 'Jakarta', kpmId: JAKARTA, updatedAt: at }),
      old({ name: 'New York', kpmId: NEW_YORK, updatedAt: at }),
    ] as never);

    await up(db());

    const month = async (name: string) =>
      ((await leads().findOne({ name }))!.commitments as { month: string }[])[0].month;
    expect(await month('Jakarta')).toBe('2026-10');
    expect(await month('New York')).toBe('2026-09');
  });

  it('leaves an uncommitted lead with an empty archive rather than a stray month', async () => {
    await leads().insertOne(old({ name: 'Never promised', thisMonth: false }) as never);

    const { promised } = await up(db());

    expect(promised).toBe(0);
    expect((await leads().findOne({ name: 'Never promised' }))!.commitments).toEqual([]);
  });

  it('falls back to the platform zone for an office the row cannot name', async () => {
    await leads().insertOne(old({ name: 'Orphan', kpmId: '66f0000000000000000000ff' }) as never);

    await up(db());

    // 2026-09-20T04:00Z is 11:00 in Jakarta — the same month either way, but the fallback is what
    // stops a missing office from throwing part-way through a forward-only migration.
    expect((await leads().findOne({ name: 'Orphan' }))!.commitments).toHaveLength(1);
  });

  it('is idempotent: a second run matches nothing', async () => {
    await leads().insertOne(old() as never);
    await up(db());

    const second = await up(db());

    expect(second).toEqual({ migrated: 0, promised: 0 });
    expect((await leads().findOne({ name: 'Pak Budi' }))!.commitments).toHaveLength(1);
  });
});
