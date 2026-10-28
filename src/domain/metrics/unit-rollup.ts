import { PERFORMANCE } from '@/domain/constants';
import { wholePercent } from './rate';

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
  /**
   * `APE_ATTAINMENT_PCT` of the two sums, capped as the row's is, half up in integers (`wholePercent`; P18.97-T3,
   * parity F-254); `null` without both, or on a zero target.
   */
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
      ? Math.min(PERFORMANCE.ATTAINMENT_PCT_CAP, wholePercent(actualMinor, targetMinor))
      : null,
    missing: rows.filter((row) => row.actualMinor === null).length,
  };
}

/** A unit's goal figures paired (ADR-0165 §1): the sums of the members whose production is held, and how far apart. */
export interface PairedGoal extends RolledUpGoal {
  /** How far the paired actual falls short of the paired target; 0 when it is met; `null` without both. */
  gapMinor: number | null;
  /** How far the paired actual is over the paired target; 0 when short; `null` without both. */
  overMinor: number | null;
}

/**
 * **The Unit Dashboard's totals, paired** (ADR-0165 §1, P18.8-T15 AC-6; the client's UI review, UI-004) — a unit's
 * total and *Direct Group production*. `rollUpGoal` summed every target that exists against the production held, so a
 * member whose file was late counted as producing nothing: *5% · Rp 264.666.667 short* for a unit two of whose
 * members were *Not uploaded yet*, beside a tooltip saying they were *not counted*. Their targets were.
 *
 * - **A member counts in the target only when their production for the period is held**, and the actual is the same
 *   members' production. The percentage, the shortfall and the excess are worked out from those two sums.
 * - **The members left out are `missing`**, as before — the rows holding no actual, which the total's tooltip names.
 * - **With nobody's production held** the actual is `null` and the total reads *Not uploaded yet* beside the targets
 *   that exist, as a row does (*of {target} target*); no percentage, no shortfall.
 *
 * Only the Unit Dashboard pairs. The Owner's office figures (`kpm-overview`, `kpm-analytics`) keep `rollUpGoal` and
 * their own documented rules, which name the months not held separately.
 *
 * **The Unit Dashboard passes only the people who count for production** (`rollUpProduction`, ADR-0172 §2): a new hire
 * before their first sale is in neither sum, nor in `missing`.
 */
export function rollUpGoalPaired(rows: readonly GoalFigure[]): PairedGoal {
  const held = rows.filter((row) => row.actualMinor !== null);
  if (held.length === 0) {
    return {
      targetMinor: sumHeld(rows.map((row) => row.targetMinor)),
      actualMinor: null,
      attainmentPct: null,
      missing: rows.length,
      gapMinor: null,
      overMinor: null,
    };
  }
  const paired = rollUpGoal(held);
  const { targetMinor, actualMinor } = paired;
  const both = targetMinor !== null && actualMinor !== null;
  return {
    ...paired,
    missing: rows.length - held.length,
    gapMinor: both ? Math.max(0, targetMinor - actualMinor) : null,
    overMinor: both ? Math.max(0, actualMinor - targetMinor) : null,
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
 * never `MAA_COUNT_IN_UNIT`. **The Unit Dashboard passes only the people who count for production**
 * (`rollUpProduction`, ADR-0172 §2): a new hire before their first sale is in neither `count` nor `of`.
 */
export function potentialMaaCountInUnit(pacing: readonly (boolean | null)[]): { count: number; of: number } {
  return { count: pacing.filter((p) => p === true).length, of: pacing.length };
}

/** What a unit's production and *on pace* read of a row (ADR-0172 §2). */
export interface ProductionRow {
  goal: GoalFigure;
  /** `PACING_TO_MAA`; `null` without a target. */
  pacingToMaa: boolean | null;
  /** `!COUNTS_FOR_PRODUCTION` on the office's day (`counts-for-production.ts`): left out of both figures below. */
  newHireBeforeFirstSale: boolean;
}

/** A unit's production and *on pace*, over the rows that count for production, and how many it left out. */
export interface ProductionRollup {
  goal: PairedGoal;
  potentialActive: { count: number; of: number };
  /** The new hires before a first sale it left out — named in the totals' ⓘ, never counted as missing. */
  newHires: number;
}

/**
 * **A unit's production total and *On pace to be active*, over the people who can sell** (ADR-0172 §2, P18.96-T5
 * AC-2). A new hire before their first sale is in the team (§1) and **in neither figure**: not their target, not their
 * production, not in `missing`, and not in *on pace*'s `count` or its `of`. Everybody else is the paired rollup
 * (`rollUpGoalPaired`) and `POTENTIAL_MAA_COUNT_IN_UNIT` unchanged. The rows left out are counted in `newHires`, so the
 * total can say so. Who is left out is decided once, by `newHireBeforeFirstSale`, before a row reaches here.
 */
export function rollUpProduction(rows: readonly ProductionRow[]): ProductionRollup {
  const selling = rows.filter((row) => !row.newHireBeforeFirstSale);
  return {
    goal: rollUpGoalPaired(selling.map((row) => row.goal)),
    potentialActive: potentialMaaCountInUnit(selling.map((row) => row.pacingToMaa)),
    newHires: rows.length - selling.length,
  };
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
