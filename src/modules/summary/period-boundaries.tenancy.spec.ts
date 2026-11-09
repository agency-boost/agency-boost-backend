import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { FixedClock } from '@/common/clock/clock.port';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import { Goal } from '@/modules/goals/goal.schema';

const KPM = '66f0000000000000000000a1';
const COMPANY = '66f0000000000000000000c1';
const ME = '66f000000000000000000103';
const M = 1_000_000 * 100;

/** 23:59 on 30 September in Jakarta — the last minute of the month, and of its last day. */
const BEFORE = '2026-09-30T16:59:00Z';
/** 00:01 on 1 October in Jakarta — and still 30 September in UTC, which is the whole point. */
const AFTER = '2026-09-30T17:01:00Z';

const agent = (over: Record<string, unknown> = {}) => new RequestContext('u-me', 'none', {
  membershipId: ME, kpmId: KPM, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
} as never);

/**
 * **Every range on Phase 10's three screens is a named period in the office's timezone** (P10-T8 AC-1),
 * pinned where it turns over: a minute before midnight in Jakarta and a minute after.
 *
 * A minute after midnight in Jakarta is 17:01 UTC on the day before, so a boundary computed in the
 * server's clock — the prototype's `new Date()`, and invariant §9's defect — puts every one of these a day
 * behind for seven hours a day. The Dashboard, the ratios and the Summary each read the office's day.
 */
describe('Phase 10’s periods, at midnight in Jakarta (P10-T8)', () => {
  let wired: ReturnType<typeof configModule>;
  const at = (instant: string) => (wired.clock as FixedClock).set(new Date(instant));

  beforeAll(async () => {
    await startMongo();
    wired = configModule(new Date(BEFORE));
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    at(BEFORE);
    await clearCollections();
    await mongoose.model(Goal.name).syncIndexes();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
    ]);
    await wired.orgLevels.seedDefaultLadder(COMPANY);
    await provisionOffice(wired, KPM, COMPANY);
  });

  const day = (localDate: string, counts: Record<string, number>) =>
    mongoose.connection.db!.collection('activityLogs').insertOne({
      kpmId: KPM, membershipId: ME, localDate,
      entries: Object.entries(counts).map(([code, count]) => ({ activityTypeId: `t-${code}`, activityTypeCode: code, count })),
      totalCount: Object.values(counts).reduce((t, n) => t + n, 0),
      source: 'self', version: 1, frozenAt: null, corrections: [], deletedAt: null,
    } as never);

  describe('the Activity Dashboard', () => {
    it('Last 7 days keeps its first day until midnight, and lets it go at it', async () => {
      await day('2026-09-24', { SELL_PRESENTATION: 1 });

      const before = await wired.activityLogs.dashboard(agent(), { range: 'ROLLING_7D' });
      at(AFTER);
      const after = await wired.activityLogs.dashboard(agent(), { range: 'ROLLING_7D' });

      expect(before).toMatchObject({ from: '2026-09-24', to: '2026-09-30', total: 1 });
      expect(after).toMatchObject({ from: '2026-09-25', to: '2026-10-01', total: 0 });
    });

    it('Last 30 days turns over at the same minute', async () => {
      await day('2026-09-01', { SELL_PRESENTATION: 1 });

      const before = await wired.activityLogs.dashboard(agent(), { range: 'ROLLING_30D' });
      at(AFTER);
      const after = await wired.activityLogs.dashboard(agent(), { range: 'ROLLING_30D' });

      expect(before).toMatchObject({ from: '2026-09-01', to: '2026-09-30', total: 1 });
      expect(after).toMatchObject({ from: '2026-09-02', to: '2026-10-01', total: 0 });
    });

    it('a custom range may end on the office’s today, and not a minute before it is today', async () => {
      await expect(wired.activityLogs.dashboard(agent(), { range: 'CUSTOM', from: '2026-09-25', to: '2026-10-01' }))
        .rejects.toMatchObject({ status: 400 });
      at(AFTER);
      await expect(wired.activityLogs.dashboard(agent(), { range: 'CUSTOM', from: '2026-09-25', to: '2026-10-01' }))
        .resolves.toMatchObject({ days: 7 });
    });
  });

  describe('the ratios', () => {
    it('are the thirty days ending on the office’s today', async () => {
      await day('2026-09-01', { SELL_PRESENTATION: 10, SELL_SUBMISSION: 2 });

      const before = await wired.activityLogs.ratios(agent());
      at(AFTER);
      const after = await wired.activityLogs.ratios(agent());

      const ssr = (view: typeof before) => view.ratios.find((r) => r.code === 'SELLING_SUCCESS_RATE')!;
      expect(before).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
      expect(ssr(before)).toMatchObject({ denominatorCount: 10, value: 0.2 });
      expect(after).toMatchObject({ from: '2026-09-02', to: '2026-10-01' });
      expect(ssr(after)).toMatchObject({ denominatorCount: 0, value: null });
    });
  });

  describe('the Personal Summary', () => {
    it('this month is the office’s calendar month — September at 23:59, October at 00:01', async () => {
      await wired.goals.save(agent(), {
        period: '2026', mode: 'direct', annualApeTargetMinor: 500 * M, savingsTargetMinor: 0, commissionRatePct: 10,
        monthsLeft: 4, apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30, closingRatePct: 30,
      });
      await day('2026-09-30', { SELL_SUBMISSION: 1 });

      const before = await wired.summary.read(agent());
      at(AFTER);
      const after = await wired.summary.read(agent());

      const closings = (view: typeof before, period: 'monthly' | 'yearly') => view.activity[period].targets[2].logged;
      expect(before).toMatchObject({ month: '2026-09', today: '2026-09-30', activity: { monthly: { from: '2026-09-01', to: '2026-09-30' } } });
      expect(before.pace).toMatchObject({ dayOfMonth: 30, daysInMonth: 30, weeksLeft: 1, closingsLast30Days: 1 });
      expect(closings(before, 'monthly')).toBe(1);

      expect(after).toMatchObject({ month: '2026-10', today: '2026-10-01', activity: { monthly: { from: '2026-10-01', to: '2026-10-01' } } });
      // The month turned over; the last 30 days did not lose the 30th (ADR-0109).
      expect(after.pace).toMatchObject({ dayOfMonth: 1, daysInMonth: 31, weeksLeft: 5, closingsLast30Days: 1 });
      expect(closings(after, 'monthly')).toBe(0);
      // The year still holds September's.
      expect(closings(after, 'yearly')).toBe(1);
    });

    it('P13.1-T5 AC-2: the pace’s last 30 days are the office’s, and let their first day go at its midnight', async () => {
      await wired.goals.save(agent(), {
        period: '2026', mode: 'direct', annualApeTargetMinor: 500 * M, savingsTargetMinor: 0, commissionRatePct: 10,
        monthsLeft: 4, apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30, closingRatePct: 30,
      });
      await day('2026-09-01', { SELL_SUBMISSION: 2 });
      await day('2026-09-30', { SELL_SUBMISSION: 1 });

      const before = await wired.summary.read(agent());
      at(AFTER);
      const after = await wired.summary.read(agent());

      // 1 to 30 September at 23:59 in Jakarta; 2 September to 1 October a minute later — still 30 September
      // in UTC, where a server-clock window would keep the 1st for seven more hours.
      expect(before.pace?.closingsLast30Days).toBe(3);
      expect(after.pace?.closingsLast30Days).toBe(1);
    });

    it('this year turns over at midnight on 31 December in Jakarta, not in UTC', async () => {
      at('2026-12-31T16:59:00Z');
      const before = await wired.summary.read(agent());
      at('2026-12-31T17:01:00Z');
      const after = await wired.summary.read(agent());

      expect(before).toMatchObject({ year: '2026', month: '2026-12', activity: { yearly: { from: '2026-01-01' } } });
      expect(after).toMatchObject({ year: '2027', month: '2027-01', activity: { yearly: { from: '2027-01-01', to: '2027-01-01' } } });
    });

    it('P18.5-T11 AC-1 September closes at midnight in Jakarta: current to 23:59, read whole and with no pace at 00:01', async () => {
      // Opened in August, in the office's zone (`TenantDay.calendar`).
      await mongoose.connection.db!.collection('kpms').updateOne(
        { _id: new mongoose.Types.ObjectId(KPM) }, { $set: { createdAt: new Date('2026-07-31T17:00:00Z') } },
      );
      await day('2026-09-30', { SELL_SUBMISSION: 1 });

      const before = await wired.summary.read(agent(), undefined, { month: '2026-09' });
      await expect(wired.summary.read(agent(), undefined, { month: '2026-10' })).rejects.toMatchObject({ status: 400 });
      at(AFTER);
      const after = await wired.summary.read(agent(), undefined, { month: '2026-09' });

      expect(before).toMatchObject({ month: '2026-09', period: { currentMonth: true, firstMonth: '2026-08' }, activity: { monthly: { to: '2026-09-30' } } });
      expect(after).toMatchObject({
        month: '2026-09', pace: null, period: { currentMonth: false, thisMonth: '2026-10' },
        activity: { monthly: { from: '2026-09-01', to: '2026-09-30', total: 1 } },
      });
      expect((await wired.summary.read(agent(), undefined, { month: '2026-10' })).period.currentMonth).toBe(true);
    });

    it('the logging window behind *Nothing logged* is the office’s last seven days', async () => {
      await day('2026-09-24', { SELL_PRESENTATION: 0 });

      const before = await wired.summary.read(agent());
      at(AFTER);
      const after = await wired.summary.read(agent());

      expect(before.insights.map((c) => c.rule)).not.toContain('NOTHING_LOGGED');
      expect(after.insights[0]).toMatchObject({ rule: 'NOTHING_LOGGED', facts: { lastLoggedOn: '2026-09-24' } });
    });
  });

  describe('nothing per-user is kept between requests (P10-T8 AC-4)', () => {
    it('each read answers from what is stored now — a day saved between two reads is in the second', async () => {
      const summary = await wired.summary.read(agent());
      const dashboard = await wired.activityLogs.dashboard(agent(), { range: 'ROLLING_7D' });
      const ratios = await wired.activityLogs.ratios(agent());

      await day('2026-09-29', { SELL_PRESENTATION: 5, SELL_SUBMISSION: 1 });

      expect(summary.activity.monthly.total).toBe(0);
      expect((await wired.summary.read(agent())).activity.monthly.total).toBe(6);
      expect(dashboard.total).toBe(0);
      expect((await wired.activityLogs.dashboard(agent(), { range: 'ROLLING_7D' })).total).toBe(6);
      expect(ratios.ratios.find((r) => r.code === 'SELLING_SUCCESS_RATE')!.value).toBeNull();
      expect((await wired.activityLogs.ratios(agent())).ratios.find((r) => r.code === 'SELLING_SUCCESS_RATE')!.value).toBe(0.2);
    });
  });
});
