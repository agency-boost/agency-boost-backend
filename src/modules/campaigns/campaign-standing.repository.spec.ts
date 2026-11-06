import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

const KPM = '66f0000000000000000000a1';
const AT = new Date('2026-09-14T03:00:00Z');
const ctx = new RequestContext('u1', 'none', {
  membershipId: 'm1', kpmId: KPM, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);
const row = (membershipId: string, status: 'qualified' | 'not_met' = 'qualified') => ({
  campaignCode: 'AUGUST_PUSH', campaignVersion: 1, windowKey: '2026-08..2026-08', membershipId, status,
  chasing: true, eligible: true, requirements: [], finalisedAt: new Date('2026-09-14T03:00:00Z'),
});

/**
 * **A window's standings are frozen in one write, once** (P18.2-T8 AC-5, AC-9; OD-154): the office stamped on every row,
 * and a row a concurrent first read already froze meets the unique index and is skipped — the first freeze stands.
 */
describe('freezing standings (P18.2-T8 AC-5)', () => {
  let wired: ReturnType<typeof configModule>;
  const standings = () => mongoose.connection.db!.collection('campaignStandings');

  beforeAll(async () => {
    await startMongo();
    wired = configModule(new Date('2026-09-14T03:00:00Z'));
    await mongoose.model('CampaignStanding').syncIndexes();
  });
  afterAll(stopMongo);
  beforeEach(clearCollections);

  it('P18.2-T8 AC-5 writes every row in one insert, the office stamped from the context', async () => {
    await wired.campaignStandings.insertFinal(ctx, [row('a'), row('b')], AT);
    expect((await standings().find({}).toArray()).map((s) => [s.kpmId, s.membershipId, s.deletedAt])).toEqual([[KPM, 'a', null], [KPM, 'b', null]]);
    // P18.2-T8 review (item 22): stamped with the clock port's instant, never the wall clock's.
    expect((await standings().find({}).toArray()).every((s) => s.createdAt.getTime() === AT.getTime() && s.updatedAt.getTime() === AT.getTime())).toBe(true);
  });

  it('P18.2-T8 AC-5 a second freeze of the same rows writes nothing and changes nothing', async () => {
    await wired.campaignStandings.insertFinal(ctx, [row('a', 'qualified')], AT);
    await wired.campaignStandings.insertFinal(ctx, [row('a', 'not_met'), row('c')], AT);
    expect((await standings().find({}).sort({ membershipId: 1 }).toArray()).map((s) => [s.membershipId, s.status]))
      .toEqual([['a', 'qualified'], ['c', 'qualified']]);
    // All duplicates: nothing to write, and no failure either.
    await wired.campaignStandings.insertFinal(ctx, [row('a', 'not_met')], AT);
    expect(await standings().countDocuments({})).toBe(2);
  });

  it('P18.2-T8 AC-5 writes nothing for nobody, and rethrows a failure that is not a duplicate', async () => {
    await wired.campaignStandings.insertFinal(ctx, [], AT);
    expect(await standings().countDocuments({})).toBe(0);
    await expect(wired.campaignStandings.insertFinal(ctx, [{ ...row('a'), status: 'nonsense' as never }], AT)).rejects.toThrow();
  });

  it('P18.2-T8 AC-5 refuses to write with no office in the context', async () => {
    await expect(wired.campaignStandings.insertFinal(RequestContext.platform('root'), [row('a')], AT)).rejects.toThrow();
  });
});
