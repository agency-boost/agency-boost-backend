import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0049-calendar-all-day';

const KPM_A = '66f0000000000000000000a1';

/**
 * **Every calendar entry says whether it is all-day** (UI V1, UI-104 point 8): a trip written before the field is
 * all-day, every other entry is not, a row that says either keeps it, and a second run writes nothing.
 */
describe('0049 — every calendar entry says whether it is all-day (UI-104)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    await db().collection('calendarEvents').deleteMany({});
  });

  const entry = (title: string, type: string, extra: Record<string, unknown> = {}) => ({
    _id: new mongoose.Types.ObjectId(), kpmId: KPM_A, title, type, deletedAt: null, ...extra,
  });

  it('UI-104 gives an old trip allDay true and every other entry false, keeps a stated value, and runs twice as a no-op', async () => {
    await db().collection('calendarEvents').insertMany([
      entry('old trip', 'travel'),
      entry('null trip', 'travel', { allDay: null }),
      entry('timed trip', 'travel', { allDay: false }),
      entry('standup', 'meeting'),
      entry('1:1', 'coaching', { allDay: false }),
    ]);

    expect(await up(db())).toEqual({ trips: 2, timed: 1 });
    const rows = Object.fromEntries((await db().collection('calendarEvents').find().toArray()).map((r) => [r.title, r.allDay]));
    expect(rows).toEqual({ 'old trip': true, 'null trip': true, 'timed trip': false, standup: false, '1:1': false });

    expect(await up(db())).toEqual({ trips: 0, timed: 0 });
  });

  it('UI-104 writes nothing on a database with no calendar, twice', async () => {
    await db().collection('calendarEvents').drop().catch(() => undefined);
    expect(await up(db())).toEqual({ trips: 0, timed: 0 });
    expect(await up(db())).toEqual({ trips: 0, timed: 0 });
  });
});
