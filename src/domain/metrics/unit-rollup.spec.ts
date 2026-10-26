import { PERFORMANCE } from '@/domain/constants';
import { personLeadCounts } from './lead-counts';
import {
  cascadeActivityTouches, potentialMaaCountInUnit, rollUpCounts, rollUpGoal, rollUpGoalPaired, rollUpLeadCounts,
} from './unit-rollup';

const M = 1_000_000 * 100;

describe('the Unit Dashboard’s rollups (Phase 15, D-metrics)', () => {
  describe('the rollup rule: a sum of the rows’ figures, a percentage from the sums, a missing figure not 0', () => {
    it('P15-T1 AC-4 sums the targets and the actuals the rows hold, and recomputes the percentage from the sums', () => {
      // 30% and 100% average to 65%; the sums say 80 of 120, 67%.
      const total = rollUpGoal([
        { targetMinor: 100 * M, actualMinor: 60 * M },
        { targetMinor: 20 * M, actualMinor: 20 * M },
      ]);
      expect(total).toEqual({ targetMinor: 120 * M, actualMinor: 80 * M, attainmentPct: 67, missing: 0 });
    });

    it('P15-T1 AC-3 leaves a row with no figure out of the actual, and counts it — never as 0', () => {
      const total = rollUpGoal([
        { targetMinor: 100 * M, actualMinor: 60 * M },
        { targetMinor: 50 * M, actualMinor: null },
        { targetMinor: null, actualMinor: 10 * M },
      ]);
      // The target is every target held (150); the actual every actual held (70); one row holds none.
      expect(total).toEqual({ targetMinor: 150 * M, actualMinor: 70 * M, attainmentPct: 47, missing: 1 });
    });

    it('P15-T1 AC-3 a total of nobody’s figures is null, not Rp 0 — Not uploaded yet and No goal set', () => {
      expect(rollUpGoal([{ targetMinor: null, actualMinor: null }, { targetMinor: null, actualMinor: null }]))
        .toEqual({ targetMinor: null, actualMinor: null, attainmentPct: null, missing: 2 });
      expect(rollUpGoal([])).toEqual({ targetMinor: null, actualMinor: null, attainmentPct: null, missing: 0 });
    });

    it('P15-T1 AC-4 a percentage needs both sums and a target above zero, and is capped as a row’s is', () => {
      expect(rollUpGoal([{ targetMinor: 0, actualMinor: 5 * M }]).attainmentPct).toBeNull();
      expect(rollUpGoal([{ targetMinor: 10 * M, actualMinor: null }]).attainmentPct).toBeNull();
      expect(rollUpGoal([{ targetMinor: 1, actualMinor: 100 * M }]).attainmentPct).toBe(PERFORMANCE.ATTAINMENT_PCT_CAP);
    });

    it('P15-T1 AC-4 sums logged counts, and the targets that exist; null only when no row has one', () => {
      expect(rollUpCounts([{ logged: 5, target: 10 }, { logged: 3, target: null }, { logged: 2, target: 4 }]))
        .toEqual({ logged: 10, target: 14 });
      expect(rollUpCounts([{ logged: 5, target: null }])).toEqual({ logged: 5, target: null });
      expect(rollUpCounts([])).toEqual({ logged: 0, target: null });
    });

    it('P15-T1 AC-4 sums each of the four lead counts', () => {
      expect(rollUpLeadCounts([
        { salesOpen: 3, salesClosing: 1, recruitOpen: 2, recruitNominated: 1 },
        { salesOpen: 1, salesClosing: 0, recruitOpen: 0, recruitNominated: 1 },
      ])).toEqual({ salesOpen: 4, salesClosing: 1, recruitOpen: 2, recruitNominated: 2 });
      expect(rollUpLeadCounts([])).toEqual({ salesOpen: 0, salesClosing: 0, recruitOpen: 0, recruitNominated: 0 });
    });
  });

  /*
   * ADR-0165 §1 (P18.8-T15 AC-6; the client's UI review, UI-004): the Unit Dashboard's totals pair each target with the
   * production it measures. The client's unit read *5% · Rp 264.666.667 short · Rp 13.000.000 of Rp 277.666.667*: the
   * target held Budi's Rp 37 jt and Yanti's Rp 98 jt, whose production was not uploaded.
   */
  describe('the paired rollup — the Unit Dashboard’s totals (ADR-0165 §1)', () => {
    it('P18.8-T15 AC-6 counts a member in the target only when their production is held, and works the gap from the pairs', () => {
      const total = rollUpGoalPaired([
        { targetMinor: 100 * M, actualMinor: 60 * M },
        { targetMinor: 50 * M, actualMinor: null },
        { targetMinor: null, actualMinor: 10 * M },
      ]);
      // Not 150 against 70: the 50 whose production is not held is left out of the target too.
      expect(total).toEqual({
        targetMinor: 100 * M, actualMinor: 70 * M, attainmentPct: 70, missing: 1, gapMinor: 30 * M, overMinor: 0,
      });
    });

    it('P18.8-T15 AC-6 the client’s unit: the two not uploaded no longer make it 5%', () => {
      const rows = [
        { targetMinor: 37 * M, actualMinor: null },
        { targetMinor: 98 * M, actualMinor: null },
        { targetMinor: 142_666_667_00, actualMinor: 13 * M },
      ];
      expect(rollUpGoal(rows)).toMatchObject({ targetMinor: 277_666_667_00, attainmentPct: 5 });
      expect(rollUpGoalPaired(rows)).toEqual({
        targetMinor: 142_666_667_00, actualMinor: 13 * M, attainmentPct: 9, missing: 2,
        gapMinor: 129_666_667_00, overMinor: 0,
      });
    });

    it('P18.8-T15 AC-6 a pair over its target is over, not short', () => {
      expect(rollUpGoalPaired([{ targetMinor: 20 * M, actualMinor: 25 * M }, { targetMinor: 80 * M, actualMinor: null }]))
        .toEqual({ targetMinor: 20 * M, actualMinor: 25 * M, attainmentPct: 125, missing: 1, gapMinor: 0, overMinor: 5 * M });
    });

    it('P18.8-T15 AC-6 with nobody’s production held reads Not uploaded yet beside the targets, as a row does', () => {
      expect(rollUpGoalPaired([{ targetMinor: 37 * M, actualMinor: null }, { targetMinor: 98 * M, actualMinor: null }]))
        .toEqual({ targetMinor: 135 * M, actualMinor: null, attainmentPct: null, missing: 2, gapMinor: null, overMinor: null });
      expect(rollUpGoalPaired([{ targetMinor: null, actualMinor: null }]))
        .toEqual({ targetMinor: null, actualMinor: null, attainmentPct: null, missing: 1, gapMinor: null, overMinor: null });
      expect(rollUpGoalPaired([]))
        .toEqual({ targetMinor: null, actualMinor: null, attainmentPct: null, missing: 0, gapMinor: null, overMinor: null });
    });

    it('P18.8-T15 AC-6 production held for people with no goal is production, and measures no target', () => {
      expect(rollUpGoalPaired([{ targetMinor: null, actualMinor: 10 * M }, { targetMinor: 40 * M, actualMinor: null }]))
        .toEqual({ targetMinor: null, actualMinor: 10 * M, attainmentPct: null, missing: 1, gapMinor: null, overMinor: null });
    });

    it('P18.8-T15 AC-6 everybody held is the rollup rule unchanged, with its gap', () => {
      const rows = [{ targetMinor: 100 * M, actualMinor: 60 * M }, { targetMinor: 20 * M, actualMinor: 20 * M }];
      expect(rollUpGoalPaired(rows)).toEqual({ ...rollUpGoal(rows), gapMinor: 40 * M, overMinor: 0 });
    });
  });

  describe('CASCADE_ACTIVITY_TOUCHES', () => {
    it('P15-T1 AC-3 sums the three cascade codes logged against the three targets summed', () => {
      expect(cascadeActivityTouches([{ logged: 20, target: 67 }, { logged: 5, target: 20 }, { logged: 1, target: 6 }]))
        .toEqual({ logged: 26, target: 93 });
    });

    it('P15-T1 AC-3 has no target when any of the three has none: no APE target to derive it from', () => {
      expect(cascadeActivityTouches([{ logged: 2, target: 10 }, { logged: 1, target: null }, { logged: 0, target: 1 }]))
        .toEqual({ logged: 3, target: null });
    });

    it('P15-T1 AC-3 a month that needs nothing more targets zero, which is met, not unmeasured', () => {
      expect(cascadeActivityTouches([{ logged: 0, target: 0 }, { logged: 0, target: 0 }, { logged: 0, target: 0 }]))
        .toEqual({ logged: 0, target: 0 });
    });
  });

  describe('POTENTIAL_MAA_COUNT_IN_UNIT', () => {
    it('P15-T1 AC-3 counts who is pacing, out of everybody the group holds — somebody with no target included', () => {
      expect(potentialMaaCountInUnit([true, false, null, true])).toEqual({ count: 2, of: 4 });
      expect(potentialMaaCountInUnit([])).toEqual({ count: 0, of: 0 });
    });
  });

  describe('the four lead counts (D-leads)', () => {
    const month = '2026-09';
    const office = { month, terminalRecruitmentCodes: ['AGENT_CODE_ISSUED'] };
    const lead = (over: Partial<Parameters<typeof personLeadCounts>[0][number]>) => ({
      type: 'sales' as const, outcome: null, statusCode: null, commitments: [], ...over,
    });

    it('P15-T1 AC-3 OPEN_SALES_LEADS and SALES_LEADS_CLOSING_THIS_MONTH: open sales leads, and those promised for the office’s month', () => {
      expect(personLeadCounts([
        lead({}),
        lead({ commitments: [{ month }] }),
        // Promised for last month: open, not closing this month.
        lead({ commitments: [{ month: '2026-08' }] }),
        // Won or lost is not open, whatever was promised.
        lead({ outcome: 'won', commitments: [{ month }] }),
        lead({ outcome: 'lost' }),
      ], office)).toEqual({ salesOpen: 3, salesClosing: 1, recruitOpen: 0, recruitNominated: 0 });
    });

    it('P15-T1 AC-3 RECRUITMENT_PIPELINE_NOW per person: open candidates not on the office’s terminal stage, a first status included', () => {
      expect(personLeadCounts([
        lead({ type: 'recruitment', statusCode: 'BOP_ATTENDED' }),
        lead({ type: 'recruitment', statusCode: null }),
        lead({ type: 'recruitment', statusCode: 'AGENT_CODE_ISSUED' }),
        lead({ type: 'recruitment', outcome: 'lost', statusCode: 'BOP_ATTENDED' }),
      ], office).recruitOpen).toBe(2);
    });

    it('P15-T1 AC-3 RECRUITMENT_NOMINATED_THIS_MONTH: open recruitment leads promised for the month — the potential recruits', () => {
      expect(personLeadCounts([
        lead({ type: 'recruitment', commitments: [{ month: '2026-07' }, { month }] }),
        lead({ type: 'recruitment', commitments: [{ month: '2026-07' }] }),
        lead({ type: 'recruitment', outcome: 'won', commitments: [{ month }] }),
        // A sales promise is not a nomination.
        lead({ type: 'sales', commitments: [{ month }] }),
      ], office)).toEqual({ salesOpen: 1, salesClosing: 1, recruitOpen: 2, recruitNominated: 1 });
    });

    it('P15-T1 AC-3 a lead of neither type, or with no commitments recorded, counts nowhere it should not', () => {
      expect(personLeadCounts([lead({ type: null, commitments: [{ month }] }), lead({ commitments: null })], office))
        .toEqual({ salesOpen: 1, salesClosing: 0, recruitOpen: 0, recruitNominated: 0 });
      expect(personLeadCounts([], office)).toEqual({ salesOpen: 0, salesClosing: 0, recruitOpen: 0, recruitNominated: 0 });
    });
  });
});
