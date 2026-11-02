import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { Goal } from './goal.schema';

/** 09:00 in Jakarta on 26 September: the last 30 days are 28 August to 26 September. */
const NOW = new Date('2026-09-26T02:00:00Z');
const KPM = '66f0000000000000000000a1';
const OTHER_KPM = '66f0000000000000000000b1';

const AB = '66f000000000000000000101';
const AAB = '66f000000000000000000102';
const AGENT = '66f000000000000000000103';

const ctxFor = (membershipId: string, orgLevelCode: string) => new RequestContext('u-' + membershipId, 'none', {
  membershipId, kpmId: KPM, orgLevelCode, hierarchyRole: orgLevelCode.toLowerCase(),
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 1,
} as never);
const aab = () => ctxFor(AAB, 'AAB');
const agent = () => ctxFor(AGENT, 'AGENT');

/**
 * The measured line under each conversion assumption (P10-T9, ADR-0055): the subject's own rates over
 * the last 30 days, over the goal's own cascade codes, read only.
 */
describe('the measured rates beside the conversion assumptions (P10-T9)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await mongoose.model(Goal.name).syncIndexes();
    const person = (id: string, rung: string, leaderId: string | null, ancestorIds: string[]) => ({
      _id: new mongoose.Types.ObjectId(id), kpmId: KPM, userId: `66f00000000000000000020${id.slice(-1)}`,
      leaderCode: `LC-${id.slice(-3)}`, orgLevelCode: rung, hierarchyRole: rung.toLowerCase(),
      leaderId, ancestorIds, status: 'active', deletedAt: null,
    });
    await mongoose.connection.db!.collection('memberships').insertMany([
      person(AB, 'AB', null, []), person(AAB, 'AAB', AB, [AB]), person(AGENT, 'AGENT', AAB, [AB, AAB]),
    ] as never);
  });

  const day = (localDate: string, counts: Record<string, number>, { kpmId = KPM, membershipId = AGENT } = {}) =>
    mongoose.connection.db!.collection('activityLogs').insertOne({
      kpmId, membershipId, localDate,
      entries: Object.entries(counts).map(([code, count]) => ({ activityTypeId: `t-${code}`, activityTypeCode: code, count })),
      totalCount: Object.values(counts).reduce((t, n) => t + n, 0),
      source: 'self', version: 1, frozenAt: null, corrections: [], deletedAt: null,
    } as never);

  const plan = {
    period: '2026', mode: 'direct', annualApeTargetMinor: 500_000_000_00, savingsTargetMinor: 50_000_000_00,
    commissionRatePct: 10, monthsLeft: 4, apeAchievedMinor: 0, caseSizeMinor: 18_000_000_00,
    leadsToApptPct: 30, closingRatePct: 30,
  };

  it('AC-1: measures the subject’s last 30 days on the defaults a first-time reader opens on', async () => {
    await day('2026-09-26', { LEADS_CONTACTED: 20, SELL_PRESENTATION: 5, SELL_SUBMISSION: 1 });
    await day('2026-08-28', { LEADS_CONTACTED: 20, SELL_PRESENTATION: 5, SELL_SUBMISSION: 1 }); // the 30th day
    await day('2026-08-27', { LEADS_CONTACTED: 500 }); // the 31st: outside

    const view = await wired.goals.readOrDefaults(agent(), '2026');

    expect(view.measured).toEqual({
      from: '2026-08-28', to: '2026-09-26', days: 30, leadToAppointmentRate: 0.25, closingRate: 0.2,
    });
  });

  it('AC-1: measures a saved goal the same way, and after it is saved', async () => {
    await day('2026-09-20', { LEADS_CONTACTED: 10, SELL_PRESENTATION: 4, SELL_SUBMISSION: 1 });

    const saved = await wired.goals.save(agent(), plan);
    const read = await wired.goals.readOrDefaults(agent(), '2026');

    expect(saved.measured).toMatchObject({ leadToAppointmentRate: 0.4, closingRate: 0.25 });
    expect(read.measured).toEqual(saved.measured);
  });

  it('AC-1: follows the codes the office binds, not the seeded ones (ADR-0163)', async () => {
    await wired.goals.save(agent(), plan);
    // The office's activity binding, as the Super Admin keeps it — not the goal's stored mapping, which is a record.
    await mongoose.connection.db!.collection('activityBindings').insertOne({
      kpmId: KPM, leads: ['CALLS'], appointments: ['MEETINGS'], closings: ['SALES'], version: 2, status: 'active',
      archivedAt: null, deletedAt: null,
    });
    await day('2026-09-20', { CALLS: 10, MEETINGS: 5, SALES: 1, LEADS_CONTACTED: 999 });

    const read = await wired.goals.readOrDefaults(agent(), '2026');
    expect(read.measured).toMatchObject({ leadToAppointmentRate: 0.5, closingRate: 0.2 });
    // The plan was saved before the rebind: its record still names what it was first counted against.
    expect(read.cascadeMapping).toEqual({
      leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION',
    });
    expect(read.cascadeBinding).toEqual({ leads: ['CALLS'], appointments: ['MEETINGS'], closings: ['SALES'] });
  });

  it('AC-2: is not enough data — null, never 0% — where there is nothing to divide by', async () => {
    await day('2026-09-20', { SELL_SUBMISSION: 3 });
    expect((await wired.goals.readOrDefaults(agent(), '2026')).measured)
      .toMatchObject({ leadToAppointmentRate: null, closingRate: null });
  });

  /*
   * **Rewritten 2026-10-02 (P11-T7 AC-10, the phase file's D-rates).** This was P10-T9's AC-3, *gives a
   * leader reading a downline's plan the downline's rates, not their own* — the opposite of the decision:
   * two rates from another member's log, served by a read that writes no §3.5 entry, are retired from the
   * subject read. The member's own read keeps them.
   */
  it('P11-T7 AC-10 D-rates: a leader reading a downline’s plan gets measured null, and their own read keeps theirs', async () => {
    await day('2026-09-20', { LEADS_CONTACTED: 10, SELL_PRESENTATION: 1 });
    await day('2026-09-20', { LEADS_CONTACTED: 10, SELL_PRESENTATION: 9 }, { membershipId: AAB });
    const counted = jest.spyOn(wired.activityReadings, 'countsOver');

    const theirs = await wired.goals.readOrDefaults(aab(), '2026', AGENT);
    // Their log is not read at all for somebody else's plan: nothing of it can leave by this route.
    expect(counted).not.toHaveBeenCalled();
    const mine = await wired.goals.readOrDefaults(aab(), '2026');
    const own = await wired.goals.readOrDefaults(agent(), '2026');

    expect(theirs.measured).toBeNull();
    expect(mine.measured?.leadToAppointmentRate).toBe(0.9);
    expect(own.measured?.leadToAppointmentRate).toBe(0.1);
    // The rest of the plan is the subject's, as it was.
    expect(theirs).toMatchObject({ period: '2026', cascadeMapping: { leadsCode: 'LEADS_CONTACTED' } });
    counted.mockRestore();
  });

  it('P11-T7 AC-10 D-rates: a saved plan read by a leader, and the answer to their save of it, carry no rate either', async () => {
    await day('2026-09-20', { LEADS_CONTACTED: 10, SELL_PRESENTATION: 4, SELL_SUBMISSION: 1 });
    await wired.goals.save(agent(), plan);

    const read = await wired.goals.readOrDefaults(aab(), '2026', AGENT);
    const viaRead = await wired.goals.read(aab(), '2026', AGENT);
    const saved = await wired.goals.save(aab(), { ...plan, annualApeTargetMinor: 600_000_000_00 }, AGENT);
    const own = await wired.goals.readOrDefaults(agent(), '2026');

    expect([read.measured, viaRead.measured, saved.measured]).toEqual([null, null, null]);
    // The leader's save is the agent's plan now (ADR-0046), and the agent still reads their own rates.
    expect(own).toMatchObject({ annualApeTargetMinor: 600_000_000_00, savedByMembershipId: AAB });
    expect(own.measured).toMatchObject({ leadToAppointmentRate: 0.4, closingRate: 0.25 });
  });

  it('counts nobody else’s days, and no other office’s under the same member id', async () => {
    await day('2026-09-20', { LEADS_CONTACTED: 10, SELL_PRESENTATION: 2 });
    await day('2026-09-20', { LEADS_CONTACTED: 10, SELL_PRESENTATION: 10 }, { membershipId: AB });
    await day('2026-09-20', { LEADS_CONTACTED: 90, SELL_PRESENTATION: 0 }, { kpmId: OTHER_KPM });

    expect((await wired.goals.readOrDefaults(agent(), '2026')).measured?.leadToAppointmentRate).toBe(0.2);
  });

  it('AC-4: fills nothing in — the assumptions stay what the agent typed', async () => {
    await day('2026-09-20', { LEADS_CONTACTED: 10, SELL_PRESENTATION: 8, SELL_SUBMISSION: 4 });
    const saved = await wired.goals.save(agent(), plan);

    const read = await wired.goals.readOrDefaults(agent(), '2026');

    expect(read).toMatchObject({ leadsToApptPct: 30, closingRatePct: 30, version: saved.version });
    expect(read.measured).toMatchObject({ leadToAppointmentRate: 0.8, closingRate: 0.5 });
  });

  it('carries the same measurement on every goal in a history, from one read of the log', async () => {
    await day('2026-09-20', { LEADS_CONTACTED: 4, SELL_PRESENTATION: 1 });
    await wired.goals.save(agent(), plan);
    await wired.goals.save(agent(), { ...plan, period: '2027' }).catch(() => undefined);

    const goals = await wired.goals.list(agent());
    expect(goals.length).toBeGreaterThan(0);
    for (const goal of goals) expect(goal.measured?.leadToAppointmentRate).toBe(0.25);
  });
});
