import mongoose from 'mongoose';
import { startMongo, stopMongo } from '../../test/mongo';
import { down, up } from './0064-new-hire-by-company-year';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';

/**
 * **ADR-0264 for the memberships that came before** (P19.16-T2 AC-2): a new hire who joined the company in an earlier
 * year than the office becomes an existing agent, kept for `down`; one who joined it that year stays; no month, no
 * change; nobody is made a new hire; a second run writes nothing.
 */
describe('0064 — a new hire joined the company the year they joined the office (ADR-0264)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const id = () => new mongoose.Types.ObjectId();
  const person = (companyJoinMonth: unknown) => ({ _id: id(), email: `${String(Math.random())}@kpm.test`, companyJoinMonth });
  const membership = (kpmId: string, userId: mongoose.Types.ObjectId | null, joinedAs: string, joinDate: string | null, extra = {}) => ({
    _id: id(), kpmId, userId: userId === null ? null : String(userId), joinedAs, joinDate, status: 'active', deletedAt: null, ...extra,
  });
  const read = async (m: { _id: mongoose.Types.ObjectId }) =>
    db().collection('memberships').findOne({ _id: m._id }, { projection: { _id: 0, joinedAs: 1, migrated0064: 1 } });

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) await db().collection(name).drop();
  });

  it('P19.16-T2 AC-2 reclassifies a new hire who joined the company in an earlier year, keeps the rest, and runs once', async () => {
    const tenured = person('2019-06');
    const lastDecember = person('2025-12');
    const thisYear = person('2026-03');
    const decemberHire = person('2025-12');
    const noMonth = person(null);
    const unreadable = person('2026-3');
    const twoOffices = person('2018-01');
    const setBack = person('2026-01');
    await db().collection('users').insertMany([tenured, lastDecember, thisYear, decemberHire, noMonth, unreadable, twoOffices, setBack]);

    const rows = {
      tenured: membership(KPM_A, tenured._id, 'new_hire', '2026-11-03'),
      lastDecember: membership(KPM_A, lastDecember._id, 'new_hire', '2026-11-04', { status: 'removed' }),
      thisYear: membership(KPM_A, thisYear._id, 'new_hire', '2026-11-05'),
      decemberHire: membership(KPM_A, decemberHire._id, 'new_hire', '2025-12-15'),
      noMonth: membership(KPM_A, noMonth._id, 'new_hire', '2026-11-05'),
      unreadable: membership(KPM_A, unreadable._id, 'new_hire', '2026-11-05'),
      noAccount: membership(KPM_A, null, 'new_hire', '2026-11-05'),
      noDate: membership(KPM_A, tenured._id, 'new_hire', null),
      // Never made a new hire, though the new rule would call them one: a 3M clock already behind them.
      existing: membership(KPM_A, thisYear._id, 'existing_agent', '2026-02-01'),
      officeB: membership(KPM_B, twoOffices._id, 'new_hire', '2026-10-01'),
      // A join date set back into the year before the month: the rule says existing agent, so does 0064.
      setBack: membership(KPM_A, setBack._id, 'new_hire', '2025-11-01'),
    };
    await db().collection('memberships').insertMany(Object.values(rows));

    expect(await up(db())).toEqual({ reclassified: 4, kept: 2, noMonth: 4 });

    for (const key of ['tenured', 'lastDecember', 'officeB', 'setBack'] as const) {
      expect(await read(rows[key])).toEqual({ joinedAs: 'existing_agent', migrated0064: { joinedAs: 'new_hire' } });
    }
    for (const key of ['thisYear', 'decemberHire', 'noMonth', 'unreadable', 'noAccount', 'noDate'] as const) {
      expect(await read(rows[key])).toEqual({ joinedAs: 'new_hire' });
    }
    expect(await read(rows.existing)).toEqual({ joinedAs: 'existing_agent' });

    // A second run finds no new hire with a month in another year.
    expect(await up(db())).toEqual({ reclassified: 0, kept: 2, noMonth: 4 });
  });

  it('P19.16-T2 AC-2 down makes each reclassified membership a new hire again, and touches nothing else', async () => {
    const tenured = person('2019-06');
    await db().collection('users').insertOne(tenured);
    const hire = membership(KPM_A, tenured._id, 'new_hire', '2026-11-03');
    const existing = membership(KPM_A, tenured._id, 'existing_agent', '2026-01-03');
    await db().collection('memberships').insertMany([hire, existing]);
    await up(db());

    expect(await down(db())).toEqual({ restored: 1 });
    expect(await read(hire)).toEqual({ joinedAs: 'new_hire' });
    expect(await read(existing)).toEqual({ joinedAs: 'existing_agent' });
  });

  it('P19.16-T2 AC-2 on an empty database it reads nothing and creates no collection', async () => {
    expect(await up(db())).toEqual({ reclassified: 0, kept: 0, noMonth: 0 });
    expect(await db().listCollections({}, { nameOnly: true }).toArray()).toEqual([]);
  });
});
