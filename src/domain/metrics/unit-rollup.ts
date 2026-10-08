import { PERFORMANCE } from '@/domain/constants';

/**
 * **The Unit Dashboard's rollups** (Phase 15, D-metrics; `metrics-and-definitions.md`, *the rollup rule*,
 * `POTENTIAL_MAA_COUNT_IN_UNIT` and `CASCADE_ACTIVITY_TOUCHES`). Pure: rows in, a figure out, so every
 * rule is a unit test and exit criterion 1 — *a unit figure is the sum of the rows beneath it* — is
 * asserted where it can fail.
 *
 * **The rollup rule, stated once.** A unit's figure is **a sum of its rows' figures**; a percentage is
 * **recomputed from the sums, never averaged**; and **a missing figure is not 0** — it is left out of the
 * sum and counted, so the total can say how many of its rows hold none. A total of nobody's figures is
 * `null`, never 0: *Not uploaded yet* rather than *Rp 0*.
 */

/** One row's goal figures, as the Summary computes them for the period (`summary-figures.ts`). */
export interface GoalFigure {
  /** `null` with no goal to measure against (ADR-0080). */
  targetMinor: number | null;
  /** `null` when the office holds no figure yet — this month before its file arrives. Not zero. */
  actualMinor: number | null;
}

/** A unit's goal figures: the rows' sums, and the percentage from the sums. */
export interface RolledUpGoal {
  /** The sum of the targets the rows hold; `null` when none holds one. */
  targetMinor: number | null;
  /** The sum of the actuals the rows hold; `null` when none holds one. */
  actualMinor: number | null;
  /** `APE_ATTAINMENT_PCT` of the two sums, capped as the row's is; `null` without both, or on a zero target. */
  attainmentPct: number | null;
  /** How many rows hold no actual — named in the total's tooltip, never counted as 0. */
  missing: number;
}

/** The sum of the figures held, or `null` when none is. */
function sumHeld(values: readonly (number | null)[]): number | null {
  const held = values.filter((v): v is number => v !== null);
  return held.length === 0 ? null : held.reduce((sum, v) => sum + v, 0);
}

/** **The rollup rule** over goal figures: sums of what is held, and the percentage of the sums. */
export function rollUpGoal(rows: readonly GoalFigure[]): RolledUpGoal {
  const targetMinor = sumHeld(rows.map((row) => row.targetMinor));
  const actualMinor = sumHeld(rows.map((row) => row.actualMinor));
  return {
    targetMinor,
    actualMinor,
    attainmentPct: targetMinor !== null && targetMinor > 0 && actualMinor !== null
      ? Math.min(PERFORMANCE.ATTAINMENT_PCT_CAP, Math.round((actualMinor / targetMinor) * 100))
      : null,
    missing: rows.filter((row) => row.actualMinor === null).length,
  };
}

/** Something logged against a target: `target` is `null` where there is no APE target to derive it from. */
export interface CountAgainst {
  logged: number;
  target: number | null;
}

/**
 * **`CASCADE_ACTIVITY_TOUCHES`** — one person's *touches* for a period: the goal's three cascade codes
 * logged, against the three targets summed (`Overall.html:7057-7073`). A count of those three codes only,
 * never the glossary's *touch* of any item. **The target is `null` if any of the three is**: a sum that
 * silently dropped one target would read as a smaller target met.
 */
export function cascadeActivityTouches(chips: readonly CountAgainst[]): CountAgainst {
  const logged = chips.reduce((sum, chip) => sum + chip.logged, 0);
  const target = chips.some((chip) => chip.target === null)
    ? null
    : chips.reduce((sum, chip) => sum + (chip.target as number), 0);
  return { logged, target };
}

/**
 * **The rollup rule** over counts against targets — a unit's *touches*: the logged counts summed, and
 * the targets that exist summed. The target is `null` only when no row has one.
 */
export function rollUpCounts(rows: readonly CountAgainst[]): CountAgainst {
  return {
    logged: rows.reduce((sum, row) => sum + row.logged, 0),
    target: sumHeld(rows.map((row) => row.target)),
  };
}

/**
 * **`POTENTIAL_MAA_COUNT_IN_UNIT`** — how many of a group are `PACING_TO_MAA`, out of how many people the
 * group holds (`Overall.html:7239`, `:7465`). A person with no target (`null`) is in `of` and not in
 * `count`. Always labelled *potential* (§A.1): it projects, it does not count the month's file, so it is
 * never `MAA_COUNT_IN_UNIT`.
 */
export function potentialMaaCountInUnit(pacing: readonly (boolean | null)[]): { count: number; of: number } {
  return { count: pacing.filter((p) => p === true).length, of: pacing.length };
}

/** A person's four lead counts (D-leads; `lead-counts.ts`). */
export interface LeadCountsRow {
  salesOpen: number;
  salesClosing: number;
  recruitOpen: number;
  recruitNominated: number;
}

/** **The rollup rule** over lead counts: each count summed. */
export function rollUpLeadCounts(rows: readonly LeadCountsRow[]): LeadCountsRow {
  const sum = (key: keyof LeadCountsRow) => rows.reduce((total, row) => total + row[key], 0);
  return {
    salesOpen: sum('salesOpen'),
    salesClosing: sum('salesClosing'),
    recruitOpen: sum('recruitOpen'),
    recruitNominated: sum('recruitNominated'),
  };
}
