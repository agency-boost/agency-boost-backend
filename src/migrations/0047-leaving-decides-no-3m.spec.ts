import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0047-leaving-decides-no-3m';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';

/**
 * **A leaving decides no 3M result** (UI V1, UI-023; the owner's D-24): a result kept by *Mark left* — on or before the
 * hire's day 90 — is cleared, one kept after day 90 stays, `leftAt` stays, and a second run writes nothing.
 */
describe('0047 — a leaving decides no 3M result (UI-023, D-24)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    await Promise.all(['kpms', 'memberships'].map((name) => db().collection(name).deleteMany({})));
    await db().collection('kpms').insertMany([
      { _id: new mongoose.Types.ObjectId(KPM_A), timezone: 'Asia/Jakarta' },
      { _id: new mongoose.Types.ObjectId(KPM_B), timezone: 'Asia/Jakarta' },
    ]);
  });

  /** A new hire who joined on 1 August 2026 — day 90 is 29 October — marked left, their result kept at `lockedAt`. */
  const hire = (name: string, kpmId: string, lockedAt: Date | null, lock: string | null = 'not_activated') => ({
    _id: new mongoose.Types.ObjectId(), kpmId, name, joinedAs: 'new_hire', joinDate: '2026-08-01',
    leftAt: new Date('2026-09-04T03:00:00Z'), activation3M: lock, activation3MLockedAt: lockedAt, deletedAt: null,
  });

  it('UI-023 clears a result a leaving kept inside the 90 days, keeps one kept after day 90, and keeps leftAt', async () => {
    await db().collection('memberships').insertMany([
      // Tari: marked left on day 35 with no sale; *Mark left* kept *not activated* that day.
      hire('tari', KPM_A, new Date('2026-09-04T03:00:00Z')),
      // Day 90 itself, 23:30 in Jakarta: still inside the 90 days.
      hire('day90', KPM_A, new Date('2026-10-29T16:30:00Z')),
      // Kept on day 91 by a read: what the records gave at the end of day 90 — it stays.
      hire('day91', KPM_A, new Date('2026-10-29T17:30:00Z')),
      // Another office's, kept by a leaving: cleared too, in its own office.
      hire('other', KPM_B, new Date('2026-09-04T03:00:00Z'), 'activated'),
    ]);

    expect(await up(db())).toEqual({ cleared: 3, kept: 1 });
    const rows = Object.fromEntries((await db().collection('memberships').find().toArray()).map((m) => [m.name, m]));
    for (const name of ['tari', 'day90', 'other']) {
      expect(rows[name]).toMatchObject({ activation3M: null, activation3MLockedAt: null });
      expect(rows[name].leftAt).toEqual(new Date('2026-09-04T03:00:00Z'));
    }
    expect(rows.day91).toMatchObject({ activation3M: 'not_activated' });

    // A second run finds nothing kept before day 91.
    expect(await up(db())).toEqual({ cleared: 0, kept: 1 });
  });

  it('UI-023 leaves alone anybody who did not leave, or holds no result', async () => {
    const stayed = { ...hire('stayed', KPM_A, new Date('2026-09-04T03:00:00Z')), leftAt: null };
    const open = hire('open', KPM_A, null, null);
    await db().collection('memberships').insertMany([stayed, open]);
    expect(await up(db())).toEqual({ cleared: 0, kept: 0 });
    expect(await db().collection('memberships').countDocuments({ activation3M: 'not_activated' })).toBe(1);
  });
});
