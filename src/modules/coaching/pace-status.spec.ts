import { PERFORMANCE } from '@/domain/constants';
import type { HeldFigure, MonthStanding } from '@/modules/production/production-readings';
import { monthPaceOf, type GoalPlan } from './pace-status';

const M = 1_000_000 * 100;
const RATIO = PERFORMANCE.ON_TRACK_PACE_THRESHOLD;
const CODES = { leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION' };

/** Rp 500 M for the year at Rp 18 M a case, 30% and 30% — the Summary's performance fixture. */
const goal = (over: Partial<GoalPlan> = {}): GoalPlan => ({
  savedAt: new Date('2026-01-05T02:00:00Z'), mode: 'direct', annualApeTargetMinor: 500 * M,
  savingsTargetMinor: 0, commissionRatePct: 0, apeAchievedMinor: 0, caseSizeMinor: 18 * M,
  leadsToApptPct: 30, closingRatePct: 30, cascadeMapping: CODES, ...over,
} as GoalPlan);

const held = (minor: number, month: string, provenance: HeldFigure['provenance'] = 'imported'): HeldFigure =>
  ({ minor, month, provenance, correctedBy: null, correctedAt: null });

/** September: Rp 160 M through August, Rp 20 M of its own, Rp 180 M for the year so far. */
const SEPTEMBER: MonthStanding = {
  yearToDate: held(180 * M, '2026-09'), throughLastMonth: held(160 * M, '2026-08'), thisMonth: held(20 * M, '2026-09'),
};
const NOTHING: MonthStanding = { yearToDate: null, throughLastMonth: null, thisMonth: null };

/** The month's count on the three cascade codes, as `ActivityReadings` answers it. */
const logged = (leads: number, appointments = 0, closings = 0, other = 0) => new Map([
  ['LEADS_CONTACTED', leads], ['SELL_PRESENTATION', appointments], ['SELL_SUBMISSION', closings],
  ['RECRUIT_FOLLOWUP', other],
]);

const pace = (over: Partial<Parameters<typeof monthPaceOf>[0]> = {}) => monthPaceOf({
  goal: goal(), standing: SEPTEMBER, counts: logged(16), recentCounts: new Map(), month: '2026-09', onTrackRatio: RATIO, ...over,
});

/**
 * One member's month: `GOAL_PACE_STATUS` over `PACING_TO_MAA`, from the rows (P11-T6 AC-4, ADR-0080).
 * `coaching-roster.tenancy.spec.ts` holds the same answer to the Summary's own figures on a database.
 */
describe('a member’s month (P11-T6 AC-4)', () => {
  describe('no target is No goal set, tested first (ADR-0080)', () => {
    it('P11-T6 AC-4 no goal saved for the year', () => {
      expect(pace({ goal: null })).toEqual({ status: 'no_goal_set', pacingToMaa: null, monthlyTargetMinor: null });
    });

    it('P11-T6 AC-4 an unsaved default is an offer, not a goal', () => {
      expect(pace({ goal: goal({ savedAt: null }) }).status).toBe('no_goal_set');
    });

    it('P11-T6 AC-4 an annual target of zero, and a plan whose assumptions cannot make one', () => {
      expect(pace({ goal: goal({ annualApeTargetMinor: 0 }) }).status).toBe('no_goal_set');
      expect(pace({ goal: goal({ caseSizeMinor: 0 }) }).status).toBe('no_goal_set');
      // A savings plan with no commission rate divides by nothing.
      expect(pace({ goal: goal({ mode: 'from_savings', savingsTargetMinor: 50 * M, commissionRatePct: 0 }) }).status)
        .toBe('no_goal_set');
    });

    it('P11-T6 AC-4 a savings plan is a goal, at the target it resolves to', () => {
      // Rp 50 M of savings at 10% commission is Rp 500 M of APE — the same month as the direct plan.
      const savings = pace({ goal: goal({ mode: 'from_savings', annualApeTargetMinor: 0, savingsTargetMinor: 50 * M, commissionRatePct: 10 }) });
      expect(savings).toEqual(pace());
    });
  });

  describe('this month’s target is the Summary’s (ADR-0056)', () => {
    it('P11-T6 AC-4 what is left after August, over the four months left including September', () => {
      // (500 − 160) / 4 = 85, and its cascade is 5 closings, 17 appointments and 57 leads.
      expect(pace().monthlyTargetMinor).toBe(85 * M);
    });

    it('P11-T6 AC-4 never moves with this month’s own upload', () => {
      const more: MonthStanding = { ...SEPTEMBER, yearToDate: held(260 * M, '2026-09'), thisMonth: held(100 * M, '2026-09') };
      expect(pace({ standing: more }).monthlyTargetMinor).toBe(85 * M);
    });

    it('P11-T6 AC-4 this month’s file being the first, takes the year to date before it from that file', () => {
      // Nothing through August: Rp 180 M for the year less Rp 20 M of September's own is Rp 160 M.
      const first: MonthStanding = { ...SEPTEMBER, throughLastMonth: null };
      expect(pace({ standing: first }).monthlyTargetMinor).toBe(85 * M);
    });

    it('P11-T6 AC-4 with nothing uploaded at all, the agent’s own figure stands in (P9-T6)', () => {
      expect(pace({ standing: NOTHING, goal: goal({ apeAchievedMinor: 160 * M }) }).monthlyTargetMinor).toBe(85 * M);
    });

    it('P11-T6 AC-4 subtracts this month’s APE only from this month’s own year to date', () => {
      /*
       * A constructed standing, to pin the Summary's first-file rule on its own: September's APE is
       * taken off a year to date only when that year to date is September's. Here the latest one is
       * July's, so nothing is subtracted; with nothing through last month and a figure held by the
       * office, the agent's own typed figure does not stand in either, and the year starts from zero.
       */
      const odd: MonthStanding = { yearToDate: held(150 * M, '2026-07'), throughLastMonth: null, thisMonth: held(20 * M, '2026-09') };
      expect(pace({ standing: odd, goal: goal({ apeAchievedMinor: 400 * M }) }).monthlyTargetMinor).toBe(125 * M);
    });

    it('P11-T6 AC-4 January has nothing before it', () => {
      const january: MonthStanding = { yearToDate: null, throughLastMonth: held(400 * M, '2025-12'), thisMonth: null };
      expect(pace({ month: '2026-01', standing: january }).monthlyTargetMinor).toBe(Math.round((500 * M) / 12));
    });
  });

  describe('the three verdicts, in the prototype’s order', () => {
    it('P11-T6 AC-4 pacing to MAA, under 90% of this month’s APE target: Watch closely', () => {
      // 16 of the month's 79 targets logged projects 5 × 16 / 79 ≈ 1.01 closings; Rp 20 M of Rp 85 M.
      expect(pace()).toEqual({ status: 'watch_closely', pacingToMaa: true, monthlyTargetMinor: 85 * M });
    });

    it('P11-T6 AC-4 pacing to MAA, at 90% or more of this month’s APE target: On track', () => {
      const ahead: MonthStanding = { ...SEPTEMBER, thisMonth: held(77 * M, '2026-09'), yearToDate: held(237 * M, '2026-09') };
      // 77 / 85 ≈ 0.906.
      expect(pace({ standing: ahead }).status).toBe('on_track');
    });

    it('P11-T6 AC-4 not pacing to MAA is Needs attention, whatever the APE says', () => {
      const ahead: MonthStanding = { ...SEPTEMBER, thisMonth: held(120 * M, '2026-09'), yearToDate: held(280 * M, '2026-09') };
      // 15 of 79 projects ≈ 0.95 of a closing.
      expect(pace({ standing: ahead, counts: logged(15) })).toMatchObject({ status: 'needs_attention', pacingToMaa: false });
    });

    it('P11-T6 AC-4 counts the three cascade codes together, and nothing else', () => {
      expect(pace({ counts: logged(10, 4, 2) }).pacingToMaa).toBe(true);
      expect(pace({ counts: logged(0, 0, 0, 500) })).toMatchObject({ status: 'needs_attention', pacingToMaa: false });
      expect(pace({ counts: new Map() }).pacingToMaa).toBe(false);
    });

    it('P11-T6 AC-4 counts the goal’s own codes when the office binds others (invariant §4)', () => {
      const rebound = goal({ cascadeMapping: { leadsCode: 'RECRUIT_FOLLOWUP', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION' } });
      expect(pace({ goal: rebound, counts: logged(0, 0, 0, 16) }).pacingToMaa).toBe(true);
    });

    it('P11-T6 AC-4 nothing uploaded and no closing logged: Watch closely while pacing', () => {
      // Amended 2026-10-02 (OD-110): the pace is the activity's until the file lands, and none projects 0.
      const unfiled: MonthStanding = { ...SEPTEMBER, thisMonth: null, yearToDate: held(160 * M, '2026-08') };
      expect(pace({ standing: unfiled }).status).toBe('watch_closely');
    });

    it('P11-T6 AC-4 reads the office’s own on-track ratio', () => {
      expect(pace({ onTrackRatio: 0.2 }).status).toBe('on_track');
    });

  });

  /*
   * **OD-109, option 2 (decided 2026-10-02).** Until then a member whose year was met before the month
   * began read *Needs attention* whatever they logged: this month's targets were zero, so the MAA gate
   * projected nothing. The gate now asks for one policy at the goal's own rates — the cascade on one
   * Rp 18 M case at 30% and 30% is 1 closing, 4 appointments and 14 leads, 19 in all — and the pace,
   * against a month that needs nothing more, reads met.
   */
  describe('OD-109: a year already met', () => {
    const made: MonthStanding = {
      yearToDate: held(530 * M, '2026-09'), throughLastMonth: held(520 * M, '2026-08'), thisMonth: held(10 * M, '2026-09'),
    };

    it('OD-109 a member who made their year and is still working reads On track, with a goal and a target of 0', () => {
      expect(pace({ standing: made, counts: logged(60, 20, 6) }))
        .toEqual({ status: 'on_track', pacingToMaa: true, monthlyTargetMinor: 0 });
    });

    it('OD-109 one who made their year and stopped submitting reads Needs attention: the prototype’s full stop', () => {
      expect(pace({ standing: made, counts: logged(10, 4, 0) }))
        .toEqual({ status: 'needs_attention', pacingToMaa: false, monthlyTargetMinor: 0 });
      expect(pace({ standing: made, counts: new Map() }).status).toBe('needs_attention');
    });

    it('OD-109 the gate is one policy’s cascade, inclusive: 19 logged passes and 18 does not', () => {
      expect(pace({ standing: made, counts: logged(14, 4, 1) }).pacingToMaa).toBe(true);
      expect(pace({ standing: made, counts: logged(14, 4, 0) }).pacingToMaa).toBe(false);
    });

    it('OD-109 the one policy is at the goal’s own rates: a weaker closing rate asks for more activity', () => {
      // At 10% closing: 1 closing, 10 appointments, 34 leads — 45 in all.
      const slow = goal({ closingRatePct: 10 });
      expect(pace({ goal: slow, standing: made, counts: logged(30, 14, 1) }).pacingToMaa).toBe(true);
      expect(pace({ goal: slow, standing: made, counts: logged(30, 13, 1) }).pacingToMaa).toBe(false);
    });

    it('OD-109 a year met reads met before this month’s file lands as well (OD-110 never divides by zero)', () => {
      const unfiled: MonthStanding = { ...made, thisMonth: null, yearToDate: held(520 * M, '2026-08') };
      expect(pace({ standing: unfiled, counts: logged(60, 20, 6) }).status).toBe('on_track');
    });

    it('OD-109 a month with a target is gated on its own cascade, not on one policy’s', () => {
      // 16 of September's 79 passes and 15 does not: one policy's 19 is asked only of a month that needs nothing.
      expect(pace({ counts: logged(15) }).pacingToMaa).toBe(false);
    });
  });

  /*
   * **OD-110, option 3 (decided 2026-10-02).** This month's APE comes only from the office's file, which
   * lands after the month ends (ADR-0050). Until it does, the last two branches read the Summary's own
   * pace sentence: its *tracking to close N* over its *target of M* — September's Rp 85 M at Rp 18 M a
   * case is 5 — at the on-track ratio. *Amended 2026-10-07 (ADR-0109): N is the closings of the last
   * 30 days, today included (`recentCounts`), where it was this month's closings run forward to the
   * month's end, with no answer before the 7th.*
   */
  describe('OD-110: until this month’s file lands, the pace is the activity’s', () => {
    const unfiled: MonthStanding = { ...SEPTEMBER, thisMonth: null, yearToDate: held(160 * M, '2026-08') };

    it('OD-110 a member pacing to MAA whose last 30 days reach the on-track share reads On track before the file', () => {
      expect(pace({ standing: unfiled, recentCounts: logged(0, 0, 5) }))
        .toEqual({ status: 'on_track', pacingToMaa: true, monthlyTargetMinor: 85 * M });
    });

    it('OD-110 closings below the on-track share read Watch closely', () => {
      // 4 of 5 is 0.8.
      expect(pace({ standing: unfiled, recentCounts: logged(0, 0, 4) }).status).toBe('watch_closely');
    });

    it('P13.1-T5 AC-2 reads the last 30 days for the pace and the calendar month for the gate', () => {
      // Five closings this month but none in the window cannot happen on the office's calendar; the two
      // counts are held apart here to pin which one each branch reads.
      expect(pace({ standing: unfiled, counts: logged(16, 0, 5), recentCounts: new Map() }).status).toBe('watch_closely');
      expect(pace({ standing: unfiled, counts: logged(16), recentCounts: logged(0, 0, 5) }).status).toBe('on_track');
    });

    it('P13.1-T5 AC-4 has an answer on the 1st: last month’s closings inside the window count, as on the Summary', () => {
      // On 1 October the month has no closings yet, and the last 30 days hold September's six — against
      // October's (500 − 180) / 3 ≈ Rp 106.7 M, ceil(106.7 / 18) = 6 closings.
      const october: MonthStanding = { yearToDate: held(180 * M, '2026-09'), throughLastMonth: held(180 * M, '2026-09'), thisMonth: null };
      expect(pace({ month: '2026-10', standing: october, counts: logged(30, 10, 0), recentCounts: logged(0, 0, 6) }).status)
        .toBe('on_track');
      expect(pace({ month: '2026-10', standing: october, counts: logged(30, 10, 0), recentCounts: new Map() }).status)
        .toBe('watch_closely');
    });

    it('OD-110 once the file lands APE decides, whatever the closings say', () => {
      // Rp 20 M of Rp 85 M, though 10 closings are twice the target.
      expect(pace({ recentCounts: logged(0, 0, 10) }).status).toBe('watch_closely');
    });

    it('OD-110 counts the goal’s own closing code (invariant §4)', () => {
      const rebound = goal({ cascadeMapping: { ...CODES, closingsCode: 'RECRUIT_FOLLOWUP' } });
      expect(pace({ goal: rebound, standing: unfiled, counts: logged(16, 0, 0, 3), recentCounts: logged(0, 0, 0, 5) }).status).toBe('on_track');
      expect(pace({ goal: rebound, standing: unfiled, counts: logged(16, 0, 3, 0), recentCounts: logged(0, 0, 5, 0) }).status).toBe('watch_closely');
    });

    it('OD-110 the gate still comes first: closings at the target do not lift a member who is not pacing', () => {
      // 3 + 3 cascade counts of 79 project well under one policy.
      expect(pace({ standing: unfiled, counts: logged(3, 0, 3), recentCounts: logged(0, 0, 5) }).status).toBe('needs_attention');
    });
  });
});
