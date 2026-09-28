import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { FixedClock } from '@/common/clock/clock.port';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { Goal } from '@/modules/goals/goal.schema';

/** 09:00 in Jakarta on 14 September — day 14 of a 30-day month, 17 days left today included. */
const NOW = new Date('2026-09-14T02:00:00Z');
const KPM = '66f0000000000000000000a1';
const OTHER_KPM = '66f0000000000000000000b1';
const ME = '66f000000000000000000103';
const M = 1_000_000 * 100;

const agent = () => new RequestContext('u-me', 'none', {
  membershipId: ME, kpmId: KPM, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never);

/** The Personal Summary (P10-T4): the goal against the office's production and the member's log. */
describe('the Personal Summary — goal versus actual, and the gap (P10-T4)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);
  const at = (instant: string) => (wired.clock as FixedClock).set(new Date(instant));
  afterEach(() => at(NOW.toISOString()));

  beforeEach(async () => {
    await clearCollections();
    await mongoose.model(Goal.name).syncIndexes();
  });

  const plan = (over: Record<string, unknown> = {}) => ({
    period: '2026', mode: 'direct', annualApeTargetMinor: 500 * M, savingsTargetMinor: 50 * M, commissionRatePct: 10,
    monthsLeft: 4, apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30, closingRatePct: 30, ...over,
  });
  const cell = (value: number | null, provenance: string | null = 'imported') => ({ value, provenance, sourceBatchId: null });
  const production = (month: string, cells: Record<string, unknown>, { kpmId = KPM, membershipId = ME } = {}) =>
    mongoose.connection.db!.collection('monthlyAgentData').insertOne({
      kpmId, membershipId, month, agentCode: 'PRU-103', deletedAt: null, ...cells,
    } as never);
  const day = (localDate: string, counts: Record<string, number>, { kpmId = KPM, membershipId = ME } = {}) =>
    mongoose.connection.db!.collection('activityLogs').insertOne({
      kpmId, membershipId, localDate,
      entries: Object.entries(counts).map(([code, count]) => ({ activityTypeId: `t-${code}`, activityTypeCode: code, count })),
      totalCount: 0, source: 'self', version: 1, frozenAt: null, corrections: [], deletedAt: null,
    } as never);

  it('AC-5: measures nobody against a plan they never saved — no goal, no attainment, no pace', async () => {
    await production('2026-08', { apeYtd: cell(200 * M) });

    const view = await wired.summary.read(agent());

    expect(view).toMatchObject({ year: '2026', month: '2026-09', today: '2026-09-14', goal: { set: false, savedAt: null }, pace: null });
    expect(view.monthly).toMatchObject({ targetMinor: null, attainmentPct: null, gapMinor: null });
    expect(view.yearly).toMatchObject({ targetMinor: null, attainmentPct: null, actualMinor: 200 * M });
  });

  it('AC-1, AC-3, AC-4: this month and this year against the plan, the gap, and the pace', async () => {
    await wired.goals.save(agent(), plan());
    await production('2026-08', { apeYtd: cell(200 * M) });
    await production('2026-09', { apeMonthly: cell(30 * M), apeYtd: cell(230 * M) });
    await day('2026-09-02', { SELL_SUBMISSION: 1 });
    await day('2026-09-10', { SELL_SUBMISSION: 1, SELL_PRESENTATION: 4 });
    await day('2026-08-31', { SELL_SUBMISSION: 9 }); // last month: not this month's pace

    const view = await wired.summary.read(agent());

    // (500 − 200 through August) over the four months left including September.
    expect(view.monthly).toMatchObject({
      targetMinor: 75 * M, actualMinor: 30 * M, attainmentPct: 40, gapMinor: 45 * M, policiesNeeded: 3,
      targetMet: false, source: { provenance: 'imported', month: '2026-09' },
    });
    expect(view.yearly).toMatchObject({
      targetMinor: 500 * M, actualMinor: 230 * M, attainmentPct: 46, gapMinor: 270 * M, policiesNeeded: 15,
      source: { provenance: 'imported', month: '2026-09' },
    });
    // A closing target of ceil(75 / 18) = 5; two closings by the 14th of 30 run forward to 4; three weeks
    // left today included; three still needed, one a week.
    expect(view.pace).toEqual({
      closingTarget: 5, closingsLogged: 2, dayOfMonth: 14, daysInMonth: 30,
      projected: 4, weeksLeft: 3, neededPerWeek: 1, targetMet: false,
    });
  });

  it('AC-1: says this month is not uploaded yet rather than zero, and still knows its target', async () => {
    await wired.goals.save(agent(), plan());
    await production('2026-08', { apeYtd: cell(200 * M) });

    const view = await wired.summary.read(agent());

    expect(view.monthly).toMatchObject({ targetMinor: 75 * M, actualMinor: null, attainmentPct: null, gapMinor: null, source: null });
  });

  it('AC-1: holds this month’s target when this month’s own figure arrives (ADR-0056)', async () => {
    await wired.goals.save(agent(), plan());
    await production('2026-08', { apeYtd: cell(200 * M) });
    const before = (await wired.summary.read(agent())).monthly.targetMinor;

    await production('2026-09', { apeMonthly: cell(60 * M), apeYtd: cell(260 * M) });
    const after = await wired.summary.read(agent());

    expect(after.monthly.targetMinor).toBe(before);
    expect(after.monthly.attainmentPct).toBe(80);
  });

  it('AC-1: says a figure corrected by hand is one', async () => {
    await wired.goals.save(agent(), plan());
    await production('2026-09', { apeMonthly: cell(40 * M, 'corrected'), apeYtd: cell(40 * M, 'corrected') });

    const view = await wired.summary.read(agent());

    expect(view.monthly.source).toEqual({ provenance: 'corrected', month: '2026-09' });
    expect(view.yearly.source).toEqual({ provenance: 'corrected', month: '2026-09' });
  });

  it('AC-1: measures the year against the agent’s own figure until the office holds one (P9-T6)', async () => {
    await wired.goals.save(agent(), plan({ apeAchievedMinor: 120 * M }));

    const view = await wired.summary.read(agent());

    expect(view.yearly).toMatchObject({ actualMinor: 120 * M, attainmentPct: 24, source: { provenance: 'self_reported', month: null } });
    // Nothing uploaded, so the year so far is the agent's own figure: (500 − 120) over four months.
    // Counting it as zero set a target the year had long outgrown — the review of P10-T4.
    expect(view.monthly).toMatchObject({ targetMinor: 95 * M, actualMinor: null });
  });

  it('AC-1: takes the year so far from this month’s file when it is the office’s first', async () => {
    // No file through August: September's is the first, and its year to date says what came before.
    await wired.goals.save(agent(), plan());
    await production('2026-09', { apeMonthly: cell(30 * M), apeYtd: cell(510 * M) });

    const view = await wired.summary.read(agent());

    // 510 − 30 = 480 before September: 20 left over four months is 5 a month, and 30 is past it.
    expect(view.monthly).toMatchObject({ targetMinor: 5 * M, actualMinor: 30 * M, targetMet: true });
    expect(view.yearly.targetMet).toBe(true);
    expect(view.pace?.targetMet).toBe(true);
  });

  it('AC-3: a year made before this month began leaves the month met, not blank (ADR-0047)', async () => {
    await wired.goals.save(agent(), plan());
    await production('2026-08', { apeYtd: cell(520 * M) });
    await production('2026-09', { apeMonthly: cell(30 * M), apeYtd: cell(550 * M) });

    const view = await wired.summary.read(agent());

    expect(view.monthly).toEqual({
      targetMinor: 0, actualMinor: 30 * M, attainmentPct: null, gapMinor: 0, overMinor: 30 * M, policiesNeeded: 0,
      targetMet: true, source: { provenance: 'imported', month: '2026-09' },
    });
    expect(view.pace).toMatchObject({ targetMet: true, neededPerWeek: 0 });
  });

  it('AC-5: a saved goal with no APE target — zero, or a plan its inputs cannot produce — measures nothing', async () => {
    await wired.goals.save(agent(), plan({ annualApeTargetMinor: 0 }));
    await day('2026-09-10', { SELL_SUBMISSION: 3 });

    const zero = await wired.summary.read(agent());
    expect(zero.goal.set).toBe(true);
    expect(zero).toMatchObject({ pace: null });
    expect(zero.yearly.targetMinor).toBeNull();

    await mongoose.connection.db!.collection('goals').updateOne(
      { membershipId: ME }, { $set: { annualApeTargetMinor: 500 * M, closingRatePct: 0 } },
    );
    const unusable = await wired.summary.read(agent());
    expect(unusable).toMatchObject({ pace: null, monthly: { targetMinor: null }, yearly: { targetMinor: null } });
  });

  it('AC-3: says the year is made, needs nothing more, and the pace asks for nothing (ADR-0047)', async () => {
    await wired.goals.save(agent(), plan());
    await production('2026-09', { apeMonthly: cell(90 * M), apeYtd: cell(520 * M) });

    const view = await wired.summary.read(agent());

    expect(view.yearly).toMatchObject({ targetMet: true, gapMinor: 0, overMinor: 20 * M, policiesNeeded: 0 });
    expect(view.pace).toMatchObject({ targetMet: true, neededPerWeek: 0 });
  });

  it('AC-4: says reached only when the APE is — a closings count at its target is on pace, not reached', async () => {
    await wired.goals.save(agent(), plan());
    await production('2026-08', { apeYtd: cell(200 * M) });
    await production('2026-09', { apeMonthly: cell(60 * M), apeYtd: cell(260 * M) }); // 60 of 75
    await day('2026-09-10', { SELL_SUBMISSION: 6 }); // past a closing target of 5

    const view = await wired.summary.read(agent());
    expect(view.monthly.targetMet).toBe(false);
    expect(view.pace).toMatchObject({ targetMet: false, neededPerWeek: 0, closingsLogged: 6 });

    await mongoose.connection.db!.collection('monthlyAgentData').updateOne(
      { month: '2026-09' }, { $set: { 'apeMonthly.value': 80 * M } },
    );
    expect((await wired.summary.read(agent())).pace?.targetMet).toBe(true);
  });

  it('AC-4: does not project before the 7th of the month', async () => {
    at('2026-09-03T02:00:00Z');
    await wired.goals.save(agent(), plan());
    await day('2026-09-02', { SELL_SUBMISSION: 1 });

    expect((await wired.summary.read(agent())).pace).toMatchObject({ closingsLogged: 1, projected: null, dayOfMonth: 3 });
  });

  it('AC-1: in January there is no last month, and the target is the year over twelve', async () => {
    at('2026-01-14T02:00:00Z');
    await wired.goals.save(agent(), plan({ annualApeTargetMinor: 600 * M }));

    expect((await wired.summary.read(agent())).monthly.targetMinor).toBe(50 * M);
  });

  it('counts nobody else’s production or days, and no other office’s under the same member id', async () => {
    await wired.goals.save(agent(), plan());
    await production('2026-09', { apeMonthly: cell(10 * M), apeYtd: cell(10 * M) });
    await production('2026-09', { apeMonthly: cell(99 * M), apeYtd: cell(99 * M) }, { kpmId: OTHER_KPM });
    await day('2026-09-10', { SELL_SUBMISSION: 1 });
    await day('2026-09-10', { SELL_SUBMISSION: 40 }, { kpmId: OTHER_KPM });
    await day('2026-09-10', { SELL_SUBMISSION: 40 }, { membershipId: 'someone-else' });

    const view = await wired.summary.read(agent());

    expect(view.monthly.actualMinor).toBe(10 * M);
    expect(view.pace?.closingsLogged).toBe(1);
  });

  it('refuses somebody with no membership — a Super Admin has no Summary of their own', async () => {
    await expect(wired.summary.read(RequestContext.platform('root'))).rejects.toMatchObject({ status: 403, code: 'TENANT_NO_MEMBERSHIP' });
  });
});
