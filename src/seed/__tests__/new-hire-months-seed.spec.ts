import mongoose from 'mongoose';
import { joinedAsFor } from '@/domain/constants';
import { startMongo, stopMongo } from '../../../test/mongo';
import { seedNewHireMonthsFixture } from '../new-hire-months-fixture';

const KPM = '66f0000000000000000000a1';
const OTHER = '66f0000000000000000000b1';

/**
 * **P19.16-T2 AC-3 (ADR-0264): the seed's company join months agree with its new hires**, so migration 0064 leaves the
 * New Hires walk's cast as it is and the member page reads a month that fits the badge.
 */
describe('the new hires’ company join months (P19.16-T2 AC-3)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const id = () => new mongoose.Types.ObjectId();
  const account = (companyJoinMonth: unknown) => ({ _id: id(), email: `${String(Math.random())}@kpm.test`, companyJoinMonth });
  const place = (kpmId: string, user: { _id: mongoose.Types.ObjectId }, joinedAs: string, joinDate: string) => ({
    _id: id(), kpmId, userId: String(user._id), joinedAs, joinDate, status: 'active', deletedAt: null,
  });
  const monthOf = async (user: { _id: mongoose.Types.ObjectId }) =>
    (await db().collection('users').findOne({ _id: user._id }))?.companyJoinMonth ?? null;

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) await db().collection(name).drop();
  });

  it('P19.16-T2 AC-3 moves a new hire’s month to their join month and an existing agent’s a year back; blanks and other offices stay; runs once', async () => {
    const hire = account('2019-04');
    const fitting = account('2026-02');
    const veteran = account('2026-07');
    const blank = account(null);
    const elsewhere = account('2018-01');
    await db().collection('users').insertMany([hire, fitting, veteran, blank, elsewhere]);
    const rows = [
      place(KPM, hire, 'new_hire', '2026-10-09'),
      place(KPM, fitting, 'new_hire', '2026-09-01'),
      place(KPM, veteran, 'existing_agent', '2026-08-20'),
      place(KPM, blank, 'new_hire', '2026-10-01'),
      place(OTHER, elsewhere, 'new_hire', '2026-10-01'),
    ];
    await db().collection('memberships').insertMany(rows);

    expect((await seedNewHireMonthsFixture({ kpmIds: [KPM] })).aligned).toBe(2);

    expect(await monthOf(hire)).toBe('2026-10');
    expect(await monthOf(fitting)).toBe('2026-02');
    expect(await monthOf(veteran)).toBe('2025-08');
    expect(await monthOf(blank)).toBeNull();
    expect(await monthOf(elsewhere)).toBe('2018-01');
    // Each now classifies as the seed placed it.
    expect(joinedAsFor('2026-10-09', '2026-11-17', await monthOf(hire))).toBe('new_hire');
    expect(joinedAsFor('2026-08-20', '2026-11-17', await monthOf(veteran))).toBe('existing_agent');

    expect((await seedNewHireMonthsFixture({ kpmIds: [KPM] })).aligned).toBe(0);
  });
});
