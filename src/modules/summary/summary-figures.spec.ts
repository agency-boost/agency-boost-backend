import { CASCADE_ACTIVITY_CODES, SEED_ACTIVITY_CATEGORIES, SEED_ACTIVITY_TYPES } from '@/domain/constants';
import {
  activityTargets, madeFigures, monthlyApeTarget, paceFor, periodFigures, sectionChips, summaryPlan, totalLogged,
  ytdBeforeThisMonth, type PlannedGoal, type ShownSection,
} from './summary-figures';

const RP = 100; // minor units per rupiah
const M = 1_000_000 * RP;

/** The Personal Summary's arithmetic (P10-T4). */
describe('the Personal Summary’s figures (P10-T4)', () => {
  describe('AC-1, AC-3, AC-5 — a period’s goal against what was produced', () => {
    it('measures attainment, the gap and the policies still needed', () => {
      expect(periodFigures(100 * M, 45 * M, 18 * M)).toEqual({
        targetMinor: 100 * M, actualMinor: 45 * M, attainmentPct: 45, gapMinor: 55 * M, overMinor: 0,
        policiesNeeded: 4, targetMet: false,
      });
    });

    it('says the target is met, with how far over, and needs nothing more', () => {
      expect(periodFigures(100 * M, 130 * M, 18 * M)).toMatchObject({
        attainmentPct: 130, gapMinor: 0, overMinor: 30 * M, policiesNeeded: 0, targetMet: true,
      });
    });

    it('caps the printed attainment at 999', () => {
      expect(periodFigures(1 * M, 50 * M, 18 * M).attainmentPct).toBe(999);
    });

    it('P18.97-T3 F-254 rounds an exact half up in integers: Rp 23 jt of Rp 40 jt is 58%, which the float read 57', () => {
      expect(Math.round(((23 * M) / (40 * M)) * 100)).toBe(57);
      expect(periodFigures(40 * M, 23 * M, 18 * M).attainmentPct).toBe(58);
      // The cap and the zero target's null are kept: only the rounding changed.
      expect(periodFigures(40 * M, 23 * M * 100, 18 * M).attainmentPct).toBe(999);
    });

    it('AC-5: has no attainment without a goal — null, not 0%', () => {
      expect(periodFigures(null, 45 * M, 18 * M)).toMatchObject({ targetMinor: null, attainmentPct: null, gapMinor: null });
      expect(periodFigures(0, 45 * M, 18 * M)).toMatchObject({ targetMinor: null, attainmentPct: null });
    });

    it('has no attainment without an actual — a month not uploaded is not a month of nothing', () => {
      expect(periodFigures(100 * M, null, 18 * M)).toMatchObject({
        targetMinor: 100 * M, actualMinor: null, attainmentPct: null, gapMinor: null, policiesNeeded: null, targetMet: false,
      });
    });

    it('does not divide by a zero case size', () => {
      expect(periodFigures(100 * M, 45 * M, 0).policiesNeeded).toBeNull();
    });
  });

  describe('AC-1 — this month’s target, fixed against this month’s own figure (ADR-0056)', () => {
    it('divides what last month left by the months left including this one', () => {
      // October: 500M a year, 200M through September, three months left including October.
      expect(monthlyApeTarget(500 * M, 200 * M, 10)).toBe(100 * M);
    });

    it('is the whole year over twelve in January, and never below zero once the year is made', () => {
      expect(monthlyApeTarget(600 * M, 0, 1)).toBe(50 * M);
      expect(monthlyApeTarget(500 * M, 700 * M, 6)).toBe(0);
    });

    it('rounds to a whole minor unit — money is never a float', () => {
      expect(Number.isInteger(monthlyApeTarget(100 * M + 1, 0, 6))).toBe(true);
    });
  });

  describe('AC-1 — the year to date before this month, never zero for want of a file (ADR-0056)', () => {
    const before = (over: Record<string, unknown>) => ytdBeforeThisMonth({
      month: 9, throughLastMonthMinor: null, thisMonth: null, ownFigureMinor: null, ...over,
    });

    it('takes the office’s year to date through last month first', () => {
      expect(before({ throughLastMonthMinor: 200 * M, thisMonth: { ytdMinor: 999 * M, monthlyMinor: 1 }, ownFigureMinor: 5 })).toBe(200 * M);
    });

    it('takes this month’s year to date less this month when this month’s file is the first', () => {
      expect(before({ thisMonth: { ytdMinor: 510 * M, monthlyMinor: 30 * M } })).toBe(480 * M);
    });

    it('takes the agent’s own figure when nothing is uploaded at all', () => {
      expect(before({ ownFigureMinor: 120 * M })).toBe(120 * M);
    });

    it('is zero in January, whatever is held, and only where nothing at all is known', () => {
      expect(before({ month: 1, throughLastMonthMinor: 50 * M, ownFigureMinor: 9 })).toBe(0);
      expect(before({})).toBe(0);
    });
  });

  it('AC-3: a month whose target was made before it began is met, and needs nothing (ADR-0047)', () => {
    expect(madeFigures(30 * M)).toEqual({
      targetMinor: 0, actualMinor: 30 * M, attainmentPct: null, gapMinor: 0, overMinor: 30 * M, policiesNeeded: 0, targetMet: true,
    });
    expect(madeFigures(null)).toMatchObject({ targetMet: true, overMinor: null });
  });

  /*
   * **P13.1-T5 — the prototype's sentence, by the prototype's arithmetic** (ADR-0109, superseding
   * ADR-0057; `Overall.html:6326-6347`). N is what the caller counted over the last 30 days; W comes from
   * the office's calendar; K is the APE gap in policies over W.
   */
  describe('P13.1-T5 — the pace (ADR-0109)', () => {
    const base = {
      closingTarget: 6, closingsLast30Days: 2, dayOfMonth: 17, daysInMonth: 30,
      apeTargetMinor: 100 * M, apeProducedMinor: 45 * M, caseSizeMinor: 18 * M, apeTargetMet: false,
    };

    it('P13.1-T5 AC-3 the prototype’s own month: Rp 45 M of Rp 100 M at Rp 18 M a case, two weeks left', () => {
      // `:6261-6263`, `:3134`: ceil(55 / 18) = 4 policies still needed, ceil(4 / 2) = 2 a week.
      expect(paceFor(base)).toEqual({
        closingTarget: 6, closingsLast30Days: 2, dayOfMonth: 17, daysInMonth: 30,
        weeksLeft: 2, policiesNeeded: 4, neededPerWeek: 2, targetMet: false,
      });
    });

    it('P13.1-T5 AC-3 the client’s sentence: 21 closed against a target of 10, still 4 a week to catch up', () => {
      // Rp 40 M of Rp 180 M: ceil(140 / 18) = 8 policies over 2 weeks. N past M does not reach the APE.
      expect(paceFor({ ...base, closingTarget: 10, closingsLast30Days: 21, apeTargetMinor: 180 * M, apeProducedMinor: 40 * M }))
        .toMatchObject({ closingsLast30Days: 21, closingTarget: 10, weeksLeft: 2, policiesNeeded: 8, neededPerWeek: 4, targetMet: false });
    });

    it('P13.1-T5 AC-3 day 1 of a 31-day month is five weeks left, and the file not landed counts nothing produced', () => {
      // ceil(31 / 7) = 5; Rp 75 M with nothing uploaded is ceil(75 / 18) = 5 policies, one a week.
      expect(paceFor({ ...base, dayOfMonth: 1, daysInMonth: 31, apeTargetMinor: 75 * M, apeProducedMinor: null }))
        .toMatchObject({ weeksLeft: 5, policiesNeeded: 5, neededPerWeek: 1 });
    });

    it('P13.1-T5 AC-3 never divides by zero weeks: the month’s last day is one week left', () => {
      expect(paceFor({ ...base, dayOfMonth: 30 })).toMatchObject({ weeksLeft: 1, policiesNeeded: 4, neededPerWeek: 4 });
      // February's last day, and a 28-day month's first: four whole weeks.
      expect(paceFor({ ...base, dayOfMonth: 28, daysInMonth: 28 }).weeksLeft).toBe(1);
      expect(paceFor({ ...base, dayOfMonth: 1, daysInMonth: 28 }).weeksLeft).toBe(4);
    });

    it('P13.1-T5 AC-3 rounds each step up, as the prototype does', () => {
      // Rp 1 short is one policy; one policy over three weeks is one a week, not a third.
      expect(paceFor({ ...base, dayOfMonth: 10, apeProducedMinor: 100 * M - 1 }))
        .toMatchObject({ weeksLeft: 3, policiesNeeded: 1, neededPerWeek: 1 });
    });

    it('P13.1-T5 AC-1 the APE target reached — this month’s or the year’s — is met, and asks for nothing (ADR-0047)', () => {
      expect(paceFor({ ...base, apeProducedMinor: 100 * M, apeTargetMet: true }))
        .toMatchObject({ targetMet: true, policiesNeeded: 0, neededPerWeek: 0 });
      // A year made before the month: a target of 0, met whatever the closings say.
      expect(paceFor({ ...base, closingTarget: 0, closingsLast30Days: 0, apeTargetMinor: 0, apeProducedMinor: null, apeTargetMet: true }))
        .toMatchObject({ targetMet: true, policiesNeeded: 0, neededPerWeek: 0 });
    });

    it('P13.1-T5 AC-4 says nothing of a run-rate, or of a first week without one', () => {
      expect(Object.keys(paceFor(base)).sort()).toEqual([
        'closingTarget', 'closingsLast30Days', 'dayOfMonth', 'daysInMonth', 'neededPerWeek', 'policiesNeeded', 'targetMet', 'weeksLeft',
      ]);
    });
  });

  describe('P10-T5 AC-1 — the three chips, logged against the period’s targets', () => {
    const mapping = { leads: ['LEADS_CONTACTED'], appointments: ['SELL_PRESENTATION'], closings: ['SELL_SUBMISSION'] };
    const logged = new Map([['LEADS_CONTACTED', 62], ['SELL_PRESENTATION', 18], ['SELL_SUBMISSION', 2], ['RECRUIT_FOLLOWUP', 9]]);

    it('reads each count by the office’s bound codes, in the prototype’s order', () => {
      expect(activityTargets({ leads: 80, appointments: 24, policies: 6 }, mapping, logged)).toEqual([
        { key: 'leads', code: 'LEADS_CONTACTED', codes: ['LEADS_CONTACTED'], logged: 62, target: 80, attainmentPct: 78, targetMet: false },
        { key: 'appointments', code: 'SELL_PRESENTATION', codes: ['SELL_PRESENTATION'], logged: 18, target: 24, attainmentPct: 75, targetMet: false },
        { key: 'closings', code: 'SELL_SUBMISSION', codes: ['SELL_SUBMISSION'], logged: 2, target: 6, attainmentPct: 33, targetMet: false },
      ]);
    });

    it('follows an office bound to other codes (invariant §4)', () => {
      const [leads] = activityTargets({ leads: 10, appointments: 1, policies: 1 }, { ...mapping, leads: ['RECRUIT_FOLLOWUP'] }, logged);
      expect(leads).toMatchObject({ code: 'RECRUIT_FOLLOWUP', logged: 9 });
    });

    it('P18.9-T2 AC-2 a role bound to [A, B] counts both: the replaced activity’s history and its replacement', () => {
      const [leads] = activityTargets(
        { leads: 80, appointments: 1, policies: 1 }, { ...mapping, leads: ['LEADS_CONTACTED', 'RECRUIT_FOLLOWUP'] }, logged,
      );
      expect(leads).toMatchObject({
        code: 'LEADS_CONTACTED', codes: ['LEADS_CONTACTED', 'RECRUIT_FOLLOWUP'], logged: 71, attainmentPct: 89,
      });
    });

    it('F-25: no target is null, never NaN% — and a code with nothing logged is 0, not missing', () => {
      expect(activityTargets(null, mapping, new Map()).map((t) => [t.logged, t.target, t.attainmentPct, t.targetMet]))
        .toEqual([[0, null, null, false], [0, null, null, false], [0, null, null, false]]);
    });

    it('a target of 0 is a month that needs nothing more: met, with no percentage to show', () => {
      const [, , closings] = activityTargets({ leads: 0, appointments: 0, policies: 0 }, mapping, logged);
      expect(closings).toMatchObject({ target: 0, attainmentPct: null, targetMet: true });
    });

    it('P18.97-T3 F-254 rounds an exact half up in integers: 23 logged of a target of 40 is 58%, never 57', () => {
      const [leads] = activityTargets({ leads: 40, appointments: 1, policies: 1 }, mapping, new Map([['LEADS_CONTACTED', 23]]));
      expect(leads).toMatchObject({ logged: 23, target: 40, attainmentPct: 58, targetMet: false });
    });

    it('meets a target on reaching it, and caps the percentage past it', () => {
      const [leads, , closings] = activityTargets({ leads: 6, appointments: 24, policies: 2 }, mapping, logged);
      expect(closings).toMatchObject({ attainmentPct: 100, targetMet: true });
      expect(leads).toMatchObject({ attainmentPct: 999, targetMet: true });
    });
  });

  describe('P10-T5 AC-2 — one chip per other section', () => {
    const sections = [
      { code: 'LEADS_GENERATION', label: 'Leads Generation', types: [{ code: 'LEADS_CONTACTED', label: 'Leads', status: 'active' as const }] },
      { code: 'SELLING', label: 'Selling', types: [{ code: 'SELL_SUBMISSION', label: 'Submission', status: 'archived' as const }] },
      {
        code: 'RECRUITMENT',
        label: 'Recruitment',
        types: [
          { code: 'RECRUIT_PRESENTATION', label: 'Presentasi', status: 'active' as const },
          { code: 'RECRUIT_OLD', label: 'Retired, with history', status: 'archived' as const },
          { code: 'RECRUIT_GONE', label: 'Retired, nothing this period', status: 'archived' as const },
        ],
      },
    ];
    const cascade = ['LEADS_CONTACTED', 'SELL_PRESENTATION', 'SELL_SUBMISSION'];

    it('leaves out every section holding a cascade code — archived ones too — and keeps the office’s order', () => {
      expect(sectionChips(sections, new Map(), cascade).map((s) => s.code)).toEqual(['RECRUITMENT']);
    });

    it('lists active types at zero, and an archived one only while it holds a count, so the rows add up', () => {
      const [recruitment] = sectionChips(sections, new Map([['RECRUIT_PRESENTATION', 3], ['RECRUIT_OLD', 2]]), cascade);
      expect(recruitment).toEqual({
        code: 'RECRUITMENT', label: 'Recruitment', total: 5,
        rows: [
          { code: 'RECRUIT_PRESENTATION', label: 'Presentasi', count: 3 },
          { code: 'RECRUIT_OLD', label: 'Retired, with history', count: 2 },
        ],
      });
    });

    it('P18.9-T2 AC-5 an archived section keeps, on its tile, the types the period holds counts for', () => {
      const archived: ShownSection[] = [
        { code: 'COMMUNITY', label: 'Community', summaryGroupCode: 'OUTREACH', summaryGroupLabel: 'Outreach', types: [
          { code: 'COMMUNITY_EVENT', label: 'Event', status: 'active' },
        ] },
        { code: 'OLD_OUTREACH', label: 'Old outreach', summaryGroupCode: 'OUTREACH', summaryGroupLabel: 'Outreach', status: 'archived', types: [
          { code: 'FLYERS', label: 'Flyers', status: 'archived' },
          { code: 'BOOTH', label: 'Booth', status: 'archived' },
        ] },
        { code: 'RETIRED', label: 'Retired', status: 'archived', types: [{ code: 'CANVAS', label: 'Canvas', status: 'archived' }] },
      ];
      // A period holding Flyers: the tile keeps it beside the live section, and Booth with nothing is gone.
      expect(sectionChips(archived, new Map([['COMMUNITY_EVENT', 1], ['FLYERS', 4]]), cascade)).toEqual([
        { code: 'OUTREACH', label: 'Outreach', total: 5, rows: [
          { code: 'COMMUNITY_EVENT', label: 'Event', count: 1 }, { code: 'FLYERS', label: 'Flyers', count: 4 },
        ] },
      ]);
      // A tile of its own, archived, is a chip only for a period that counted it.
      expect(sectionChips(archived, new Map([['CANVAS', 2]]), cascade).map((c) => [c.code, c.total])).toEqual([
        ['OUTREACH', 0], ['RETIRED', 2],
      ]);
    });

    it('P18.9-T2 AC-5 an archived section holding a bound code never takes a live tile out with it', () => {
      const archived: ShownSection[] = [
        { code: 'COMMUNITY', label: 'Community', summaryGroupCode: 'OUTREACH', summaryGroupLabel: 'Outreach', types: [
          { code: 'COMMUNITY_EVENT', label: 'Event', status: 'active' },
        ] },
        { code: 'OLD_SELLING', label: 'Old selling', summaryGroupCode: 'OUTREACH', summaryGroupLabel: 'Outreach', status: 'archived', types: [
          { code: 'SELL_SUBMISSION', label: 'Submission', status: 'archived' },
        ] },
      ];
      // The bound code's count is the target chips': the tile keeps its live row and does not repeat it.
      expect(sectionChips(archived, new Map([['SELL_SUBMISSION', 3]]), cascade)).toEqual([
        { code: 'OUTREACH', label: 'Outreach', total: 0, rows: [{ code: 'COMMUNITY_EVENT', label: 'Event', count: 0 }] },
      ]);
    });

    it('totals every code logged, in any section or none', () => {
      expect(totalLogged(new Map([['A', 3], ['B', 0], ['C', 4]]))).toBe(7);
      expect(totalLogged(new Map())).toBe(0);
    });
  });

  describe('P10.1-T6 AC-5 — one chip per summary tile (ADR-0064)', () => {
    const cascade = Object.values(CASCADE_ACTIVITY_CODES);
    const type = (code: string, status: 'active' | 'archived' = 'active') => ({ code, label: code, status });
    /** The seed's sections, as `ActivityReadings.sectionsShown` hands them over. */
    const seed: ShownSection[] = [...SEED_ACTIVITY_CATEGORIES]
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((c) => ({
        code: c.code,
        label: c.label,
        summaryGroupCode: c.summaryGroupCode,
        summaryGroupLabel: c.summaryGroupLabel,
        types: SEED_ACTIVITY_TYPES.filter((t) => t.categoryCode === c.code)
          .map((t) => ({ code: t.code, label: t.label, status: 'active' as const })),
      }));

    it('the seed gives the prototype’s two: Recruitment and Development (`Overall.html:3164-3183`)', () => {
      const chips = sectionChips(seed, new Map(), cascade);
      expect(chips.map((c) => [c.code, c.label])).toEqual([
        ['RECRUITMENT', 'Recruitment'],
        ['DEVELOPMENT', 'Development'],
      ]);
    });

    it('a group’s rows are its sections’ rows, in the office’s order, and its total is theirs', () => {
      const counts = new Map([['DEV_TRAINING_ATTEND', 2], ['DEV_COACHING_RECEIVED', 1], ['DEV_TEAM_ACTIVITY', 4]]);
      const development = sectionChips(seed, counts, cascade).find((c) => c.code === 'DEVELOPMENT');
      expect(development?.rows.map((r) => [r.code, r.count])).toEqual([
        ['DEV_TRAINING_ATTEND', 2], ['DEV_COACHING_RECEIVED', 1], ['DEV_TEAM_ACTIVITY', 4],
      ]);
      expect(development?.total).toBe(7);
    });

    it('a section with neither field is a chip of its own, under its own code and label', () => {
      const sections: ShownSection[] = [
        { code: 'COMMUNITY', label: 'Community', summaryGroupCode: null, summaryGroupLabel: null, types: [type('COMMUNITY_EVENT')] },
        { code: 'MENTORING', label: 'Mentoring', types: [type('MENTOR_SESSION')] },
      ];
      expect(sectionChips(sections, new Map([['COMMUNITY_EVENT', 3]]), cascade)).toEqual([
        { code: 'COMMUNITY', label: 'Community', total: 3, rows: [{ code: 'COMMUNITY_EVENT', label: 'COMMUNITY_EVENT', count: 3 }] },
        { code: 'MENTORING', label: 'Mentoring', total: 0, rows: [{ code: 'MENTOR_SESSION', label: 'MENTOR_SESSION', count: 0 }] },
      ]);
    });

    it('reads a blank group code as none, and a group with no label takes its first section’s', () => {
      const sections: ShownSection[] = [
        { code: 'COMMUNITY', label: 'Community', summaryGroupCode: '  ', summaryGroupLabel: null, types: [type('C1')] },
        { code: 'A', label: 'Alpha', summaryGroupCode: 'PAIR', summaryGroupLabel: ' ', types: [type('A1')] },
        { code: 'B', label: 'Beta', summaryGroupCode: 'PAIR', summaryGroupLabel: ' ', types: [type('B1')] },
      ];
      expect(sectionChips(sections, new Map(), cascade).map((c) => [c.code, c.label])).toEqual([
        ['COMMUNITY', 'Community'],
        ['PAIR', 'Alpha'],
      ]);
    });

    it('a tile sits where its first section sits, and a group never absorbs a section whose own code it shares', () => {
      const sections: ShownSection[] = [
        { code: 'A', label: 'Alpha', summaryGroupCode: 'PAIR', summaryGroupLabel: 'Pair', types: [type('A1')] },
        { code: 'PAIR', label: 'Loner', types: [type('P1')] },
        { code: 'B', label: 'Beta', summaryGroupCode: 'PAIR', summaryGroupLabel: 'Pair', types: [type('B1')] },
      ];
      const chips = sectionChips(sections, new Map([['A1', 1], ['P1', 5], ['B1', 2]]), cascade);
      expect(chips.map((c) => [c.label, c.total, c.rows.map((r) => r.code)])).toEqual([
        ['Pair', 3, ['A1', 'B1']],
        ['Loner', 5, ['P1']],
      ]);
    });

    it('the cascade exclusion is unchanged: a tile holding a cascade code is not a chip — archived ones too', () => {
      const sections: ShownSection[] = [
        { code: 'SELLING', label: 'Selling', summaryGroupCode: 'FIELD', summaryGroupLabel: 'Field work', types: [type('SELL_SUBMISSION', 'archived')] },
        { code: 'RECRUITMENT', label: 'Recruitment', summaryGroupCode: 'FIELD', summaryGroupLabel: 'Field work', types: [type('RECRUIT_PRESENTATION')] },
        { code: 'COMMUNITY', label: 'Community', types: [type('COMMUNITY_EVENT')] },
      ];
      expect(sectionChips(sections, new Map(), cascade).map((c) => c.code)).toEqual(['COMMUNITY']);
    });

    it('regrouping moves a count between chips and never changes one', () => {
      const counts = new Map([['RECRUIT_PRESENTATION', 3], ['DEV_TRAINING_ATTEND', 2], ['DEV_TEAM_ACTIVITY', 4]]);
      const ungrouped = seed.map((s) => ({ ...s, summaryGroupCode: null, summaryGroupLabel: null }));
      const sum = (chips: ReturnType<typeof sectionChips>) => chips.reduce((n, c) => n + c.total, 0);
      expect(sectionChips(ungrouped, counts, cascade)).toHaveLength(3);
      expect(sum(sectionChips(ungrouped, counts, cascade))).toBe(sum(sectionChips(seed, counts, cascade)));
    });
  });

  /*
   * The month's and the year's targets, computed once (P11-T4): `GET /summary` and `GET /activity/summary`'s
   * 7-day targets read the same function, so the session's Activity card and the Summary tab agree.
   */
  describe('P11-T4 AC-4 — summaryPlan, the one place the month’s targets are set', () => {
    /** Rp 500 M for the year at Rp 18 M a case, 30% and 30%, saved; the office holds the year to date. */
    const goal = (over: Partial<PlannedGoal> = {}): PlannedGoal => ({
      savedAt: '2026-01-05T02:00:00.000Z',
      projected: { annualApeTargetMinor: 500 * M },
      achieved: { minor: 240 * M, month: '2026-09', provenance: 'imported' },
      caseSizeMinor: 18 * M, leadsToApptPct: 30, closingRatePct: 30,
      ...over,
    });

    it('sets September’s target from the year to date through August, and runs the cascade on it', () => {
      // (500 − 160) ÷ 4 months left = 85 M; 85 ÷ 18 → 5 closings, ÷ 0.3 → 17 appointments, ÷ 0.3 → 57 leads.
      expect(summaryPlan({ goal: goal(), month: '2026-09', throughLastMonthMinor: 160 * M, thisMonthMinor: 80 * M }))
        .toEqual({
          annualTargetMinor: 500 * M,
          monthlyTargetMinor: 85 * M,
          monthlyCounts: { policies: 5, appointments: 17, leads: 57 },
          yearlyCounts: { policies: 28, appointments: 94, leads: 314 },
        });
    });

    it('never moves with this month’s own figure: the month’s file alone stands in for last month', () => {
      // Nothing held through August, September's year to date 240 M of which 80 M is September's own.
      const plan = summaryPlan({ goal: goal(), month: '2026-09', throughLastMonthMinor: null, thisMonthMinor: 80 * M });
      expect(plan.monthlyTargetMinor).toBe(85 * M);
    });

    it('reads the agent’s own figure only while the office holds none (P9-T6)', () => {
      const own = goal({ achieved: { minor: 160 * M, month: null, provenance: 'self_reported' } });
      expect(summaryPlan({ goal: own, month: '2026-09', throughLastMonthMinor: null, thisMonthMinor: null })
        .monthlyTargetMinor).toBe(85 * M);
    });

    it('is no target for an unsaved default, a target of zero, or a plan that cannot be made', () => {
      const none = { annualTargetMinor: null, monthlyTargetMinor: null, monthlyCounts: null, yearlyCounts: null };
      const args = { month: '2026-09', throughLastMonthMinor: 160 * M, thisMonthMinor: null };
      expect(summaryPlan({ goal: goal({ savedAt: null }), ...args })).toEqual(none);
      expect(summaryPlan({ goal: goal({ projected: { annualApeTargetMinor: 0 } }), ...args })).toEqual(none);
      expect(summaryPlan({ goal: goal({ projected: null }), ...args })).toEqual(none);
    });

    it('a year made before the month began asks this month for nothing — zero, not no target (ADR-0047)', () => {
      const plan = summaryPlan({ goal: goal(), month: '2026-09', throughLastMonthMinor: 600 * M, thisMonthMinor: null });
      expect(plan.monthlyTargetMinor).toBe(0);
      expect(plan.monthlyCounts).toEqual({ policies: 0, appointments: 0, leads: 0 });
    });

    it('has a target and no plan for it without a case size to divide by', () => {
      const plan = summaryPlan({
        goal: goal({ caseSizeMinor: 0 }), month: '2026-09', throughLastMonthMinor: 160 * M, thisMonthMinor: null,
      });
      expect(plan).toMatchObject({ monthlyTargetMinor: 85 * M, monthlyCounts: null, yearlyCounts: null });
    });
  });
});
