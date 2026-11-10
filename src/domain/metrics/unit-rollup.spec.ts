import { PERFORMANCE } from '@/domain/constants';
import { personLeadCounts } from './lead-counts';
import {
  activeAgentSplit, cascadeActivityTouches, potentialMaaCountInUnit, rollUpCounts, rollUpGoal, rollUpGoalPaired,
  rollUpLeadCounts, rollUpProduction, type ProductionRow,
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

    it('P18.9-T3 F-254 rounds the sums’ attainment half up in integers: Rp 23 Jt of Rp 40 Jt is 58%, never 57', () => {
      const total = rollUpGoal([{ targetMinor: 25 * M, actualMinor: 15 * M }, { targetMinor: 15 * M, actualMinor: 8 * M }]);
      expect(Math.round(((23 * M) / (40 * M)) * 100)).toBe(57);
      expect(total).toEqual({ targetMinor: 40 * M, actualMinor: 23 * M, attainmentPct: 58, missing: 0 });
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
   * ADR-0165 §1 (P18.5-T15 AC-6; the client's UI review, UI-004): the Unit Dashboard's totals pair each target with the
   * production it measures. The client's unit read *5% · Rp 264.666.667 short · Rp 13.000.000 of Rp 277.666.667*: the
   * target held Budi's Rp 37 Jt and Yanti's Rp 98 Jt, whose production was not uploaded.
   */
  describe('the paired rollup — the Unit Dashboard’s totals (ADR-0165 §1)', () => {
    it('P18.5-T15 AC-6 counts a member in the target only when their production is held, and works the gap from the pairs', () => {
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

    it('P18.5-T15 AC-6 the client’s unit: the two not uploaded no longer make it 5%', () => {
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

    it('P18.5-T15 AC-6 a pair over its target is over, not short', () => {
      expect(rollUpGoalPaired([{ targetMinor: 20 * M, actualMinor: 25 * M }, { targetMinor: 80 * M, actualMinor: null }]))
        .toEqual({ targetMinor: 20 * M, actualMinor: 25 * M, attainmentPct: 125, missing: 1, gapMinor: 0, overMinor: 5 * M });
    });

    it('P18.5-T15 AC-6 with nobody’s production held reads Not uploaded yet beside the targets, as a row does', () => {
      expect(rollUpGoalPaired([{ targetMinor: 37 * M, actualMinor: null }, { targetMinor: 98 * M, actualMinor: null }]))
        .toEqual({ targetMinor: 135 * M, actualMinor: null, attainmentPct: null, missing: 2, gapMinor: null, overMinor: null });
      expect(rollUpGoalPaired([{ targetMinor: null, actualMinor: null }]))
        .toEqual({ targetMinor: null, actualMinor: null, attainmentPct: null, missing: 1, gapMinor: null, overMinor: null });
      expect(rollUpGoalPaired([]))
        .toEqual({ targetMinor: null, actualMinor: null, attainmentPct: null, missing: 0, gapMinor: null, overMinor: null });
    });

    it('P18.5-T15 AC-6 production held for people with no goal is production, and measures no target', () => {
      expect(rollUpGoalPaired([{ targetMinor: null, actualMinor: 10 * M }, { targetMinor: 40 * M, actualMinor: null }]))
        .toEqual({ targetMinor: null, actualMinor: 10 * M, attainmentPct: null, missing: 1, gapMinor: null, overMinor: null });
    });

    it('P18.5-T15 AC-6 everybody held is the rollup rule unchanged, with its gap', () => {
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

    it('UI-013 counts out of manpower when the caller names it: the pacing of those who sell, over everybody', () => {
      expect(potentialMaaCountInUnit([true, false, true], 5)).toEqual({ count: 2, of: 5 });
    });
  });

  /**
   * **ADR-0172 §2, P18.8-T5 AC-2** — the totals read the people who can sell. A new hire before their first sale is in
   * the team and in neither figure: the seed's Yanti, rejoined 28 days ago, *on pace* and with no sale yet.
   */
  describe('the totals over the people who count for production (ADR-0172 §2)', () => {
    const row = (over: Partial<ProductionRow>): ProductionRow => ({
      goal: { targetMinor: 50 * M, actualMinor: 20 * M }, pacingToMaa: true, newHireBeforeFirstSale: false, ...over,
    });

    it('UI-013 leaves a new hire before a first sale out of the production and of on pace’s count — never its of', () => {
      const rows = [
        row({}),
        row({ goal: { targetMinor: 100 * M, actualMinor: 0 }, pacingToMaa: true, newHireBeforeFirstSale: true }),
        row({ goal: { targetMinor: 30 * M, actualMinor: 30 * M }, pacingToMaa: false }),
      ];
      expect(rollUpProduction(rows)).toEqual({
        goal: rollUpGoalPaired([rows[0].goal, rows[2].goal]),
        // Pacing, the new hire is still not in `count` (the numerator rule is unchanged); she is in `of`, manpower.
        potentialActive: { count: 1, of: 3 },
        newHires: 1,
      });
      // Counted, the new hire's Rp 100 Jt target with nothing sold would read 28%, not 63%.
      expect(rollUpGoalPaired(rows.map((r) => r.goal)).attainmentPct).toBe(28);
      expect(rollUpProduction(rows).goal).toMatchObject({ targetMinor: 80 * M, actualMinor: 50 * M, attainmentPct: 63, missing: 0 });
    });

    it('P18.8-T5 AC-2 a new hire with no production held is left out, not counted as missing', () => {
      const rows = [row({ goal: { targetMinor: 98 * M, actualMinor: null }, newHireBeforeFirstSale: true }), row({})];
      expect(rollUpProduction(rows).goal).toMatchObject({ targetMinor: 50 * M, actualMinor: 20 * M, missing: 0 });
      expect(rollUpProduction(rows).newHires).toBe(1);
    });

    it('P18.8-T5 AC-2 nobody left out is the paired rollup and the potential count unchanged', () => {
      const rows = [row({}), row({ goal: { targetMinor: 40 * M, actualMinor: null }, pacingToMaa: null })];
      expect(rollUpProduction(rows)).toEqual({
        goal: rollUpGoalPaired(rows.map((r) => r.goal)),
        potentialActive: potentialMaaCountInUnit(rows.map((r) => r.pacingToMaa)),
        newHires: 0,
      });
    });

    it('UI-013 a unit of new hires only is a production total of nobody — Not uploaded yet — and 0 of 2 on pace', () => {
      expect(rollUpProduction([row({ newHireBeforeFirstSale: true }), row({ newHireBeforeFirstSale: true })])).toEqual({
        goal: { targetMinor: null, actualMinor: null, attainmentPct: null, missing: 0, gapMinor: null, overMinor: null },
        potentialActive: { count: 0, of: 2 },
        newHires: 2,
      });
    });

    it('UI-013 the report’s Active Agent: 4 of 12 (33%) — Unit 1 of 4, AAB 3 of 8, adding up to the total', () => {
      // Agus's Unit: himself and three direct agents, one pacing. The AAB side: eight people, three pacing, one of them a
      // new hire before a first sale (Yanti) — in the eight, never in the three.
      const unit = [row({}), row({ pacingToMaa: false }), row({ pacingToMaa: null }), row({ pacingToMaa: false })];
      const aab = [
        row({}), row({}), row({}), row({ pacingToMaa: true, newHireBeforeFirstSale: true }),
        ...Array.from({ length: 4 }, () => row({ pacingToMaa: false })),
      ];
      const split = activeAgentSplit(unit, aab);
      expect(split).toEqual({ count: 4, of: 12, unit: { count: 1, of: 4 }, aab: { count: 3, of: 8 } });
      expect(split.unit.count + split.aab.count).toBe(split.count);
      expect(split.unit.of + split.aab.of).toBe(split.of);
      // The tile reads it whole: 4 of 12 is 33%.
      expect(Math.round((split.count / split.of) * 100)).toBe(33);
      // And the total is the rollup over everybody: the split is a partition of it.
      expect(rollUpProduction([...unit, ...aab]).potentialActive).toEqual({ count: 4, of: 12 });
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
