/**
 * **The forum's scorecard as it is computed** (OD-144, ADR-0129, ADR-0175; `functional/leader-forum.md` *Overview &
 * Stats*): the frontend's `Scorecard` (`frontend/src/lib/leader-meetings.ts`) without what the meeting itself adds —
 * each row's typed *Monthly Target*, the instant it was frozen, and what the read derives from the cells (the change a
 * phone's card shows, the partial periods the (\*) notes name). The meeting overlays those.
 */

/**
 * The six computed columns, in the client's reference slide's order (ADR-0175 §1, P18.97-T1 AC-1): *Full Year {Y−1}* ·
 * ***YTD {Y−1}*** · *YTD {Y}* — the *Full Year & YTD View* — then *This Month, Last Year* · *Last Month* · *This Month*,
 * the *Monthly View* with the typed *Monthly Target*. **The keys are the stored shape's**: `ytdLastYear` is the one
 * added, and a scorecard frozen before it has no such cells (`scorecard-record.ts`).
 */
export type ColumnKey = 'fy' | 'ytdLastYear' | 'ytd' | 'thisMonthLastYear' | 'lastMonth' | 'thisMonth';
export const COLUMN_KEYS: readonly ColumnKey[] = ['fy', 'ytdLastYear', 'ytd', 'thisMonthLastYear', 'lastMonth', 'thisMonth'];

/** *Full Year & YTD View*: the three year columns. */
export const YEAR_COLUMN_KEYS: readonly ColumnKey[] = ['fy', 'ytdLastYear', 'ytd'];

/** *Monthly View*'s computed columns: the ones a row the table does not track in a month draws *Not tracked*. */
export const MONTH_COLUMN_KEYS: readonly ColumnKey[] = ['thisMonthLastYear', 'lastMonth', 'thisMonth'];

/**
 * The nine rows, **in the slide's order** (ADR-0175 §2, P18.97-T1 AC-4): *APE (Rp M)* · *Manpower* · *FLC* · *Annual
 * Active Agents* · *Activation*: *3M new agent %*, *Avg. monthly AA* · *Productivity*: *Case submission*,
 * *Cases/producing agents* · *Avg. Case Size (Rp jt)*. **The keys are the stored shape's** — `producing_agents` is the
 * row labelled *Annual Active Agents*, `PRODUCING_AGENTS`, renamed and not redefined — so no frozen scorecard's key
 * moves (AC-19).
 */
export type RowKey =
  | 'ape' | 'manpower' | 'flc' | 'producing_agents' | 'new_agent_3m'
  | 'avg_monthly_aa' | 'case_submission' | 'cases_per_producing_agent' | 'average_case_size';
export const ROW_KEYS: readonly RowKey[] = [
  'ape', 'manpower', 'flc', 'producing_agents', 'new_agent_3m',
  'avg_monthly_aa', 'case_submission', 'cases_per_producing_agent', 'average_case_size',
];

/**
 * **Rows a scorecard frozen before 2026-10-28 holds and no table draws** (ADR-0175 §2, AC-6): *New AA (avg.
 * monthly)*, `NEW_ACTIVE_AGENTS_MONTHLY_AVG`, retired. Kept on every meeting that froze it, never served.
 */
export const RETIRED_ROW_KEYS = ['new_aa'] as const;

/**
 * **The rows the table does not track in the *Monthly View*** — their three month cells *Not tracked* and no *Monthly
 * Target* (the prototype's `blockedCols`, `KPM_Owner.html:2465`, `:2468`, `:2472`, and *Cases/producing agents*, not
 * tracked where *Annual Active Agents* is not, AC-5).
 */
export const BLOCKED_ROW_KEYS: readonly RowKey[] = [
  'producing_agents', 'new_agent_3m', 'cases_per_producing_agent', 'average_case_size',
];

/**
 * **The five rows whose *Monthly Target* is typed — as a rate per unit** (ADR-0175 §4, P18.97-T1 AC-10): *APE*,
 * *Manpower*, *FLC*, *Avg. monthly AA* and *Case submission*. *New AA*'s targets typed before stay stored, and none is
 * typed again.
 */
export type TargetRowKey = 'ape' | 'manpower' | 'flc' | 'avg_monthly_aa' | 'case_submission';
export const TARGET_ROW_KEYS: readonly TargetRowKey[] = ['ape', 'manpower', 'flc', 'avg_monthly_aa', 'case_submission'];

export type ScorecardCell =
  /** `value` exact: minor units for `idr_minor`, a whole or fractional count, a percentage, a ratio. */
  | { kind: 'figure'; value: number; leavesOut: string[] /* YYYY-MM months of the period not held */ }
  /** *pending data*: no source holds the figure for its period. */
  | { kind: 'pending' }
  /** *—*: a ratio over nothing whose months are held (*Avg. Case Size* over no policies, *Cases/producing agents* over nobody). */
  | { kind: 'none' }
  /** *Not tracked*: a row the table leaves empty in this column. */
  | { kind: 'blocked' }
  /**
   * *—*: **a column or a row a scorecard frozen before it existed does not hold** (ADR-0175 §8, AC-19) — never
   * computed for it, since nothing recomputes a frozen scorecard. Never written by a computation.
   */
  | { kind: 'unrecorded' };

/** `ratio` is *Cases/producing agents*, a count over a count, drawn to a tenth. */
export type ScorecardUnit = 'idr_minor' | 'count' | 'percentage' | 'ratio';

/** Each row's unit, the current rows'. */
export const ROW_UNITS: Readonly<Record<RowKey, ScorecardUnit>> = {
  ape: 'idr_minor',
  manpower: 'count',
  flc: 'count',
  producing_agents: 'count',
  new_agent_3m: 'percentage',
  avg_monthly_aa: 'count',
  case_submission: 'count',
  cases_per_producing_agent: 'ratio',
  average_case_size: 'idr_minor',
};

export interface ComputedScorecardRow {
  key: RowKey;
  unit: ScorecardUnit;
  cells: Record<ColumnKey, ScorecardCell>;
}

export interface ScorecardChips {
  manpower: number;
  agents: number;
  /** *# of units* = *# of AB* + *# of AAB* since 2026-10-28 (ADR-0175 §3); the AB agencies before it, as frozen. */
  units: number;
  ab: number;
  aab: number;
}

/**
 * **The months a column names**, `YYYY-MM` to `YYYY-MM`, from the meeting's own month (AC-2): what its header's second
 * line reads (*(Jan-Okt '26)*). The period a figure is computed over may end sooner — on the meeting's day or today —
 * and the months it leaves out are each cell's `leavesOut`.
 */
export interface ColumnPeriod {
  from: string;
  to: string;
}

export interface ComputedScorecard {
  periods: Record<ColumnKey, ColumnPeriod>;
  chips: ScorecardChips;
  /** Nine, in the slide's order. */
  rows: ComputedScorecardRow[];
  /**
   * ***AS OF***: the office's day its latest production file was uploaded, of the months the table reads (AC-13) —
   * `YYYY-MM-DD` in its calendar — or `null` while it has none. Frozen with the scorecard.
   */
  asOf: string | null;
}

/** What a scorecard is computed for: the office, its calendar, and the meeting's own date. */
export interface ScorecardInput {
  kpmId: string;
  timezone: string;
  /** `YYYY-MM-DD`, an office date. */
  meetingDate: string;
}
