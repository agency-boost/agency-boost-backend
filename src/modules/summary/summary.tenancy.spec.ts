import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { FixedClock } from '@/common/clock/clock.port';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import { Goal } from '@/modules/goals/goal.schema';

/** 09:00 in Jakarta on 14 September — day 14 of a 30-day month, 17 days left today included. */
const NOW = new Date('2026-09-14T02:00:00Z');
const KPM = '66f0000000000000000000a1';
const OTHER_KPM = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';
const ME = '66f000000000000000000103';
const M = 1_000_000 * 100;

const agent = (over: Record<string, unknown> = {}) => new RequestContext('u-me', 'none', {
  membershipId: ME, kpmId: KPM, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
} as never);
const owner = () => agent({ membershipId: 'mem-owner', isKpmOwner: true, orgLevelCode: null, hierarchyRole: null });

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
    // Every office has its record: the insight rules read its compliance window (P10-T7).
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: OTHER_KPM, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
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
    await day('2026-08-31', { SELL_SUBMISSION: 9 }); // last month, but inside the last 30 days: the pace's
    await day('2026-08-15', { SELL_SUBMISSION: 50 }); // the 31st day back: nobody's pace

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
    // P13.1-T5 (ADR-0109): a closing target of ceil(75 / 18) = 5; 11 closings from 16 August to today;
    // three weeks left today included; Rp 45 M short is ceil(45 / 18) = 3 policies, one a week.
    expect(view.pace).toEqual({
      closingTarget: 5, closingsLast30Days: 11, dayOfMonth: 14, daysInMonth: 30,
      weeksLeft: 3, policiesNeeded: 3, neededPerWeek: 1, targetMet: false,
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

    // A case size of nothing is a plan with no policies in it: no target to divide the chips by either.
    await mongoose.connection.db!.collection('goals').updateOne(
      { membershipId: ME }, { $set: { closingRatePct: 30, caseSizeMinor: 0 } },
    );
    const noCaseSize = await wired.summary.read(agent());
    expect(noCaseSize).toMatchObject({ pace: null, yearly: { targetMinor: null } });
    expect(noCaseSize.activity.monthly.targets.map((t) => t.target)).toEqual([null, null, null]);
  });

  it('AC-3: says the year is made, needs nothing more, and the pace asks for nothing (ADR-0047)', async () => {
    await wired.goals.save(agent(), plan());
    await production('2026-09', { apeMonthly: cell(90 * M), apeYtd: cell(520 * M) });

    const view = await wired.summary.read(agent());

    expect(view.yearly).toMatchObject({ targetMet: true, gapMinor: 0, overMinor: 20 * M, policiesNeeded: 0 });
    expect(view.pace).toMatchObject({ targetMet: true, neededPerWeek: 0 });
  });

  it('P13.1-T5 AC-1, AC-3: says reached only when the APE is — closings past their target still need the APE’s policies', async () => {
    await wired.goals.save(agent(), plan());
    await production('2026-08', { apeYtd: cell(200 * M) });
    await production('2026-09', { apeMonthly: cell(60 * M), apeYtd: cell(260 * M) }); // 60 of 75
    await day('2026-09-10', { SELL_SUBMISSION: 6 }); // past a closing target of 5

    const view = await wired.summary.read(agent());
    expect(view.monthly.targetMet).toBe(false);
    // Rp 15 M short of Rp 75 M is one policy, over three weeks: one a week, whatever the closings say.
    expect(view.pace).toMatchObject({ targetMet: false, closingsLast30Days: 6, policiesNeeded: 1, neededPerWeek: 1 });

    await mongoose.connection.db!.collection('monthlyAgentData').updateOne(
      { month: '2026-09' }, { $set: { 'apeMonthly.value': 80 * M } },
    );
    expect((await wired.summary.read(agent())).pace?.targetMet).toBe(true);
  });

  it('P13.1-T5 AC-1, AC-2: on the 3rd the pace is there, over the last 30 days — last month’s included', async () => {
    at('2026-09-03T02:00:00Z');
    await wired.goals.save(agent(), plan());
    await production('2026-08', { apeYtd: cell(200 * M) });
    await day('2026-09-02', { SELL_SUBMISSION: 1 });
    await day('2026-08-20', { SELL_SUBMISSION: 2 });
    await day('2026-08-04', { SELL_SUBMISSION: 5 }); // 4 August to 3 September is 31 days: outside

    // September's file has not landed: nothing counted as produced, so all ceil(75 / 18) = 5 policies are
    // needed over ceil(28 / 7) = 4 weeks.
    expect((await wired.summary.read(agent())).pace).toEqual({
      closingTarget: 5, closingsLast30Days: 3, dayOfMonth: 3, daysInMonth: 30,
      weeksLeft: 4, policiesNeeded: 5, neededPerWeek: 2, targetMet: false,
    });
  });

  it('P13.1-T5 AC-2: counts the closing code, SELL_SUBMISSION, and no other activity', async () => {
    await wired.goals.save(agent(), plan());
    await day('2026-09-10', { SELL_SUBMISSION: 2, SELL_PRESENTATION: 7, RECRUIT_AGENT_CODE: 4 });

    expect((await wired.summary.read(agent())).pace?.closingsLast30Days).toBe(2);
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
    expect(view.pace?.closingsLast30Days).toBe(1);
  });

  describe('P10-T5 — your sales activity targets, and the rest of your sections', () => {
    beforeEach(async () => {
      await wired.orgLevels.seedDefaultLadder(COMPANY);
      await provisionOffice(wired, KPM, COMPANY);
    });

    const chips = (view: Awaited<ReturnType<typeof wired.summary.read>>['activity']['monthly']) =>
      Object.fromEntries(view.targets.map((t) => [t.key, t]));

    it('AC-1: this month against the cascade on this month’s fixed target, the year to date against the year’s', async () => {
      await wired.goals.save(agent(), plan());
      await production('2026-08', { apeYtd: cell(200 * M) });
      await day('2026-09-02', { LEADS_CONTACTED: 12, SELL_PRESENTATION: 4, SELL_SUBMISSION: 1 });
      await day('2026-09-10', { LEADS_CONTACTED: 8, SELL_PRESENTATION: 2, SELL_SUBMISSION: 1 });
      await day('2026-08-31', { LEADS_CONTACTED: 100, SELL_PRESENTATION: 30, SELL_SUBMISSION: 9 }); // the year's, not the month's

      const view = await wired.summary.read(agent());
      const month = chips(view.activity.monthly);
      const year = chips(view.activity.yearly);

      // 75 this month: ceil(75 / 18) = 5 closings, ceil(5 / 0.3) = 17 appointments, ceil(17 / 0.3) = 57 leads.
      expect(view.activity.monthly).toMatchObject({ from: '2026-09-01', to: '2026-09-14' });
      expect(month.leads).toEqual({ key: 'leads', code: 'LEADS_CONTACTED', logged: 20, target: 57, attainmentPct: 35, targetMet: false });
      expect(month.appointments).toMatchObject({ code: 'SELL_PRESENTATION', logged: 6, target: 17, attainmentPct: 35 });
      expect(month.closings).toMatchObject({ code: 'SELL_SUBMISSION', logged: 2, target: 5, attainmentPct: 40 });
      // The closings chip and the pace sentence name one number.
      expect(view.pace?.closingTarget).toBe(month.closings.target);

      // The year: 500 through the cascade once — ceil(500 / 18) = 28, ceil(28 / 0.3) = 94, ceil(94 / 0.3) = 314.
      expect(view.activity.yearly).toMatchObject({ from: '2026-01-01', to: '2026-09-14' });
      expect(year.closings).toMatchObject({ logged: 11, target: 28, attainmentPct: 39 });
      expect(year.appointments).toMatchObject({ logged: 36, target: 94 });
      expect(year.leads).toMatchObject({ logged: 120, target: 314, attainmentPct: 38 });
    });

    it('AC-1: holds this month’s chip targets when this month’s own APE arrives (ADR-0056)', async () => {
      await wired.goals.save(agent(), plan());
      await production('2026-08', { apeYtd: cell(200 * M) });
      const before = (await wired.summary.read(agent())).activity.monthly.targets;

      await production('2026-09', { apeMonthly: cell(60 * M), apeYtd: cell(260 * M) });

      expect((await wired.summary.read(agent())).activity.monthly.targets).toEqual(before);
    });

    it('AC-1: no goal is no target — the counts still show, with nothing to divide them by', async () => {
      await day('2026-09-10', { LEADS_CONTACTED: 5, SELL_SUBMISSION: 1 });

      const view = await wired.summary.read(agent());

      for (const period of [view.activity.monthly, view.activity.yearly]) {
        expect(period.targets.map((t) => [t.logged, t.target, t.attainmentPct, t.targetMet]))
          .toEqual([[5, null, null, false], [0, null, null, false], [1, null, null, false]]);
      }
    });

    it('AC-1: a year made before this month began leaves the chips met at 0, not unmeasured (ADR-0047)', async () => {
      await wired.goals.save(agent(), plan());
      await production('2026-08', { apeYtd: cell(520 * M) });
      await day('2026-09-10', { SELL_SUBMISSION: 2 });

      const month = chips((await wired.summary.read(agent())).activity.monthly);

      expect(month.closings).toMatchObject({ logged: 2, target: 0, attainmentPct: null, targetMet: true });
      expect(month.leads).toMatchObject({ logged: 0, target: 0, targetMet: true });
    });

    it('AC-1: counts a cascade code whose type the office archived since', async () => {
      await wired.goals.save(agent(), plan());
      await day('2026-09-10', { SELL_PRESENTATION: 4 });
      const type = (await wired.activity.list(owner())).flatMap((c) => c.types).find((t) => t.code === 'SELL_PRESENTATION')!;
      await wired.activity.archiveType(owner(), type.id);

      expect(chips((await wired.summary.read(agent())).activity.monthly).appointments.logged).toBe(4);
    });

    it('AC-2, P10.1-T6 AC-5: one chip per other summary tile — the seed’s two — with its total, its rows, and the total across every category', async () => {
      await day('2026-09-03', { RECRUIT_PRESENTATION: 3, RECRUIT_FOLLOWUP: 2, DEV_TRAINING_ATTEND: 1, SELL_SUBMISSION: 1 });
      await day('2026-09-10', { RECRUIT_AGENT_CODE: 1, DEV_TEAM_ACTIVITY: 4, LEADS_NEW_PROSPECT: 6 });

      const view = await wired.summary.read(agent());
      const sections = view.activity.monthly.sections;

      // Leads Generation and Selling hold the cascade's codes, so the three target chips stand for them.
      // Personal and Team Development share the tile DEVELOPMENT (ADR-0064): the prototype's two chips.
      expect(sections.map((s) => [s.code, s.label, s.total])).toEqual([
        ['RECRUITMENT', 'Recruitment', 6], ['DEVELOPMENT', 'Development', 5],
      ]);
      expect(sections[0].rows.map((r) => [r.code, r.count])).toEqual([
        ['RECRUIT_PRESENTATION', 3], ['RECRUIT_FOLLOWUP', 2], ['RECRUIT_AGENT_CODE', 1],
      ]);
      expect(sections[1].rows.map((r) => [r.code, r.count])).toEqual([
        ['DEV_TRAINING_ATTEND', 1], ['DEV_COACHING_RECEIVED', 0], ['DEV_TEAM_ACTIVITY', 4],
      ]);
      expect(view.activity.yearly.sections.map((s) => s.code)).toEqual(['RECRUITMENT', 'DEVELOPMENT']);
      expect(view.activity.monthly.total).toBe(18);
    });

    it('P10.1-T6 AC-5: a tile counts only the sections this rung is shown, and a section left ungrouped is a chip of its own', async () => {
      await mongoose.connection.db!.collection('activityCategories').updateOne(
        { code: 'TEAM_DEVELOPMENT' }, { $set: { appliesToOrgLevelCodes: ['AB', 'AAB'] } },
      );
      await day('2026-09-03', { DEV_TRAINING_ATTEND: 2, DEV_TEAM_ACTIVITY: 4 });

      const asAgent = (await wired.summary.read(agent())).activity.monthly.sections;
      expect(asAgent.find((s) => s.code === 'DEVELOPMENT')).toMatchObject({ label: 'Development', total: 2 });

      await mongoose.connection.db!.collection('activityCategories').updateMany(
        { code: { $in: ['PERSONAL_DEVELOPMENT', 'TEAM_DEVELOPMENT'] } },
        { $set: { summaryGroupCode: null, summaryGroupLabel: null, appliesToOrgLevelCodes: [] } },
      );
      const ungrouped = (await wired.summary.read(agent())).activity.monthly.sections;
      expect(ungrouped.map((s) => [s.code, s.label, s.total])).toEqual([
        ['RECRUITMENT', 'Recruitment', 0], ['PERSONAL_DEVELOPMENT', 'Personal Development', 2], ['TEAM_DEVELOPMENT', 'Team Development', 4],
      ]);
    });

    it('AC-2: shows no chip for a section the office keeps from this rung (ADR-0020)', async () => {
      await mongoose.connection.db!.collection('activityCategories').updateOne(
        { code: 'RECRUITMENT' }, { $set: { appliesToOrgLevelCodes: ['AB', 'AAB'] } },
      );
      await day('2026-09-03', { RECRUIT_PRESENTATION: 3 });

      const asAgent = await wired.summary.read(agent());
      const asLeader = await wired.summary.read(agent({ orgLevelCode: 'AB', hierarchyRole: 'ab' }));

      expect(asAgent.activity.monthly.sections.map((s) => s.code)).toEqual(['DEVELOPMENT']);
      // The total is every category's, so a history the reader is not shown still adds up.
      expect(asAgent.activity.monthly.total).toBe(3);
      expect(asLeader.activity.monthly.sections.map((s) => s.code)).toContain('RECRUITMENT');
    });

    it('AC-2: a member with no rung is shown only the sections every rung is', async () => {
      await mongoose.connection.db!.collection('activityCategories').updateOne(
        { code: 'RECRUITMENT' }, { $set: { appliesToOrgLevelCodes: ['AB', 'AAB'] } },
      );

      const sections = (await wired.summary.read(agent({ orgLevelCode: null }))).activity.monthly.sections;

      expect(sections.map((s) => s.code)).toEqual(['DEVELOPMENT']);
    });

    it('AC-2: keeps an archived type’s row while the period holds a count against it, and drops it after', async () => {
      await day('2026-09-03', { DEV_COACHING_RECEIVED: 2 });
      const type = (await wired.activity.list(owner())).flatMap((c) => c.types).find((t) => t.code === 'DEV_COACHING_RECEIVED')!;
      await wired.activity.archiveType(owner(), type.id);

      const view = await wired.summary.read(agent());
      const development = view.activity.monthly.sections.find((s) => s.code === 'DEVELOPMENT')!;
      expect(development).toMatchObject({ total: 2 });
      expect(development.rows.map((r) => r.code)).toEqual(['DEV_TRAINING_ATTEND', 'DEV_COACHING_RECEIVED', 'DEV_TEAM_ACTIVITY']);

      at('2026-10-14T02:00:00Z'); // a month on: nothing logged against it this month
      const later = (await wired.summary.read(agent())).activity.monthly.sections.find((s) => s.code === 'DEVELOPMENT')!;
      expect(later.rows.map((r) => r.code)).toEqual(['DEV_TRAINING_ATTEND', 'DEV_TEAM_ACTIVITY']);
    });

    it('reads its own office’s sections and days — another office’s names and counts do not reach it', async () => {
      await provisionOffice(wired, OTHER_KPM, COMPANY);
      await mongoose.connection.db!.collection('activityCategories').updateOne(
        { kpmId: OTHER_KPM, code: 'RECRUITMENT' }, { $set: { label: 'Office B recruiting' } },
      );
      await day('2026-09-03', { RECRUIT_PRESENTATION: 1 });
      await day('2026-09-03', { RECRUIT_PRESENTATION: 50 }, { kpmId: OTHER_KPM });

      const recruitment = (await wired.summary.read(agent())).activity.monthly.sections[0];
      const theirs = await wired.summary.read(agent({ kpmId: OTHER_KPM }));

      expect(recruitment).toMatchObject({ code: 'RECRUITMENT', label: 'Recruitment', total: 1 });
      // The same member id in office B reads office B's — the fixture is real, not a no-op.
      expect(theirs.activity.monthly.sections[0]).toMatchObject({ label: 'Office B recruiting', total: 50 });
    });
  });

  describe('P10-T6 — leads that need you', () => {
    beforeEach(async () => {
      await wired.orgLevels.seedDefaultLadder(COMPANY);
      await provisionOffice(wired, KPM, COMPANY);
    });

    let registered = 0;
    const lead = (name: string, over: Record<string, unknown> = {}) => {
      registered += 1;
      return mongoose.connection.db!.collection('leads').insertOne({
        kpmId: KPM, ownerMembershipId: ME, type: 'sales', name, statusCode: 'FOLLOW_UP', commitments: [],
        remarks: 'Hobi golf', nextActionDate: null, nextActionNote: null, outcome: null, source: null,
        contact: { phone: null, email: null }, lawfulBasis: null, consentAt: null, statusHistory: [],
        dateRegistered: new Date(Date.UTC(2026, 0, registered)), version: 1, deletedAt: null,
        createdAt: NOW, updatedAt: NOW, createdBy: ME, updatedBy: ME, ...over,
      } as never);
    };
    const names = async (ctx = agent()) => (await wired.summary.read(ctx)).leads.rows.map((r) => r.name);

    it('AC-1: your own open leads, nearest next action first and undated last', async () => {
      await lead('Undated, registered first');
      await lead('Next week', { nextActionDate: '2026-09-20' });
      await lead('Four days late', { nextActionDate: '2026-09-10' });
      await lead('Today', { nextActionDate: '2026-09-14' });
      await lead('Undated, registered second');

      expect(await names()).toEqual(['Four days late', 'Today', 'Next week', 'Undated, registered first', 'Undated, registered second']);
    });

    it('AC-1: leaves out a closed lead, a deleted one, and anybody else’s — a leader’s downline included', async () => {
      await lead('Mine');
      await lead('Won', { outcome: 'won' });
      await lead('Lost', { outcome: 'lost' });
      await lead('Deleted', { deletedAt: NOW });
      await lead('My downline’s', { ownerMembershipId: 'mem-downline' });
      await lead('Another office’s', { kpmId: OTHER_KPM });

      const asLeader = await wired.summary.read(agent({ orgLevelCode: 'AB', hierarchyRole: 'ab', directCount: 1 }));

      expect(asLeader.leads).toMatchObject({ total: 1, rows: [{ name: 'Mine' }] });
    });

    it('AC-1: each with its flags as the Leads screen derives them — the commitment hiding none (I-103)', async () => {
      await lead('Late and promised', { nextActionDate: '2026-09-10', commitments: [{ month: '2026-09', at: NOW }] });
      await lead('Nothing written', { remarks: null, statusCode: null, type: null });

      const [late, blank] = (await wired.summary.read(agent())).leads.rows;

      expect(late).toMatchObject({
        name: 'Late and promised', thisMonth: true, flags: ['overdue'], overdueDays: 4,
        statusCode: 'FOLLOW_UP', statusLabel: 'Follow-up', type: 'sales', nextActionDate: '2026-09-10',
      });
      expect(blank).toMatchObject({
        thisMonth: false, flags: ['no-next-action', 'no-remarks'], overdueDays: null, statusLabel: null, type: null,
      });
    });

    it('AC-1: still names a stage the office has since archived', async () => {
      await mongoose.connection.db!.collection('leadStatuses').updateOne({ code: 'FOLLOW_UP' }, { $set: { status: 'archived' } });
      await lead('On an archived stage');

      expect((await wired.summary.read(agent())).leads.rows[0].statusLabel).toBe('Follow-up');
    });

    it('lists the nearest ten and counts the rest', async () => {
      for (let i = 1; i <= 12; i += 1) await lead(`Lead ${i}`, { nextActionDate: `2026-09-${String(i + 14).padStart(2, '0')}` });

      const view = await wired.summary.read(agent());

      expect(view.leads.total).toBe(12);
      expect(view.leads.rows.map((r) => r.name)).toEqual(Array.from({ length: 10 }, (_, i) => `Lead ${i + 1}`));
    });

    it('reads its own office’s leads and stage names — another office’s do not reach it', async () => {
      await provisionOffice(wired, OTHER_KPM, COMPANY);
      await mongoose.connection.db!.collection('leadStatuses').updateOne(
        { kpmId: OTHER_KPM, code: 'FOLLOW_UP' }, { $set: { label: 'Office B follow-up' } },
      );
      await lead('Mine');
      await lead('Theirs', { kpmId: OTHER_KPM });

      const mine = await wired.summary.read(agent());
      const theirs = await wired.summary.read(agent({ kpmId: OTHER_KPM }));

      expect(mine.leads.rows).toEqual([expect.objectContaining({ name: 'Mine', statusLabel: 'Follow-up' })]);
      // The same member id in office B reads office B's — the fixture is real, not a no-op.
      expect(theirs.leads.rows).toEqual([expect.objectContaining({ name: 'Theirs', statusLabel: 'Office B follow-up' })]);
    });
  });

  describe('P10-T7 — the insight cards, from the reader’s own numbers', () => {
    beforeEach(async () => {
      await wired.orgLevels.seedDefaultLadder(COMPANY);
      await provisionOffice(wired, KPM, COMPANY);
    });

    const lead = (name: string, over: Record<string, unknown> = {}) => mongoose.connection.db!.collection('leads').insertOne({
      kpmId: KPM, ownerMembershipId: ME, type: 'sales', name, statusCode: 'FOLLOW_UP', commitments: [],
      remarks: 'Hobi golf', nextActionDate: '2026-09-20', nextActionNote: null, outcome: null, source: null,
      dateRegistered: NOW, version: 1, deletedAt: null, ...over,
    } as never);
    const cards = async (ctx = agent()) => (await wired.summary.read(ctx)).insights;

    it('AC-1, AC-3: each rule that fired, from the reader’s pace, leads and ratios, in the fixed priority', async () => {
      await wired.goals.save(agent(), plan());
      await production('2026-08', { apeYtd: cell(200 * M) });
      // One closing in the last 30 days against a target of 5 (ADR-0109). Ten presentations, one submission:
      // a selling success rate of 0.10 against 0.15, over enough of them to say so.
      await day('2026-09-10', { SELL_SUBMISSION: 1, SELL_PRESENTATION: 10 });
      await lead('Pak Heri', { nextActionDate: '2026-09-06' });
      await lead('Pak Alvin', { nextActionDate: null, remarks: null });

      const view = await cards();

      expect(view.map((c) => c.rule)).toEqual(['BEHIND_PACE', 'LEAD_OVERDUE', 'LEAD_NEGLECTED', 'RATIO_BELOW']);
      expect(view[0]).toMatchObject({ kind: 'action', facts: { closingsLast30Days: 1, closingTarget: 5, weeksLeft: 3, neededPerWeek: 2 } });
      expect(view[1]).toMatchObject({ facts: { name: 'Pak Heri', overdueDays: 8, others: 0 } });
      expect(view[3]).toMatchObject({
        kind: 'improve', facts: { code: 'SELLING_SUCCESS_RATE', label: 'Selling success rate', value: 0.1, benchmark: 0.15 },
      });
    });

    it('AC-1: nothing logged in the window leads, and says when the last day was', async () => {
      expect(await cards()).toEqual([{ rule: 'NOTHING_LOGGED', kind: 'action', facts: { windowDays: 7, lastLoggedOn: null } }]);

      await day('2026-09-01', { SELL_PRESENTATION: 0 });
      expect((await cards())[0]).toMatchObject({ rule: 'NOTHING_LOGGED', facts: { lastLoggedOn: '2026-09-01' } });

      // A day of zeroes inside the window is a statement that nothing happened, not silence (ADR-0042).
      await day('2026-09-12', { SELL_PRESENTATION: 0 });
      expect((await cards()).map((c) => c.rule)).not.toContain('NOTHING_LOGGED');
    });

    it('AC-1: a ratio that is not a question about the reader’s rung makes no card (ADR-0020)', async () => {
      await day('2026-09-10', { RECRUIT_PRESENTATION: 10 }); // a recruitment success rate of 0

      expect((await cards()).map((c) => c.rule)).not.toContain('RATIO_BELOW');
      expect(await cards(agent({ orgLevelCode: 'AB', hierarchyRole: 'ab' }))).toContainEqual(
        expect.objectContaining({ rule: 'RATIO_BELOW', facts: expect.objectContaining({ code: 'RECRUITMENT_SUCCESS_RATE', value: 0 }) }),
      );
    });

    it('AC-1: names a strength only well above its benchmark', async () => {
      // Leads per activity: 6 new prospects over 10 activities is 0.6 against 0.3 — twice the benchmark.
      await day('2026-09-10', { LEADS_NEW_PROSPECT: 6, LEADS_GEN_ACTIVITY: 10 });

      expect(await cards()).toContainEqual(
        expect.objectContaining({ rule: 'RATIO_STRENGTH', kind: 'improve', facts: expect.objectContaining({ code: 'LEADS_PER_ACTIVITY', value: 0.6 }) }),
      );
    });

    it('reads nobody else’s leads or days — the same member id in another office included', async () => {
      await provisionOffice(wired, OTHER_KPM, COMPANY);
      await day('2026-09-12', { SELL_PRESENTATION: 1 });
      await day('2026-09-10', { SELL_PRESENTATION: 20 }, { kpmId: OTHER_KPM });
      await lead('Office B’s overdue lead', { kpmId: OTHER_KPM, nextActionDate: '2026-09-01' });

      expect(await cards()).toEqual([]);
      // The fixture is real: office B's reader gets office B's cards.
      expect((await cards(agent({ kpmId: OTHER_KPM }))).map((c) => c.rule)).toEqual(['LEAD_OVERDUE', 'RATIO_BELOW']);
    });
  });

  it('refuses somebody with no membership — a Super Admin has no Summary of their own', async () => {
    await expect(wired.summary.read(RequestContext.platform('root'))).rejects.toMatchObject({ status: 403, code: 'TENANT_NO_MEMBERSHIP' });
  });
});
