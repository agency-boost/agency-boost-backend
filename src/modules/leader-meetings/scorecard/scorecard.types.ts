/**
 * **The forum's scorecard as it is computed** (OD-144, ADR-0129, `functional/leader-forum.md` *Overview & Stats*):
 * the frontend's `Scorecard` (`frontend/src/lib/leader-meetings.ts`) without what the meeting itself adds — each
 * row's typed *Monthly Target* and the instant it was frozen. The meeting overlays both.
 */

/** The five computed columns, in the prototype's order (`KPM_Owner.html:2456`); *Monthly Target* is typed. */
export type ColumnKey = 'fy' | 'ytd' | 'thisMonthLastYear' | 'lastMonth' | 'thisMonth';
export const COLUMN_KEYS: readonly ColumnKey[] = ['fy', 'ytd', 'thisMonthLastYear', 'lastMonth', 'thisMonth'];

/** The nine rows, in the prototype's order (`:2461-2473`). */
export type RowKey =
  | 'ape' | 'manpower' | 'flc' | 'producing_agents' | 'new_aa' | 'new_agent_3m'
  | 'avg_monthly_aa' | 'case_submission' | 'average_case_size';
export const ROW_KEYS: readonly RowKey[] = [
  'ape', 'manpower', 'flc', 'producing_agents', 'new_aa', 'new_agent_3m',
  'avg_monthly_aa', 'case_submission', 'average_case_size',
];

/**
 * The three rows the prototype blocks to the right of *YTD* (`blockedCols`, `:2465`, `:2468`, `:2472`): their
 * three single-month cells are `blocked` and they take no *Monthly Target*.
 */
export const BLOCKED_ROW_KEYS: readonly RowKey[] = ['producing_agents', 'new_agent_3m', 'average_case_size'];

/** The six rows whose *Monthly Target* is typed: every row but the three blocked. */
export type TargetRowKey = 'ape' | 'manpower' | 'flc' | 'new_aa' | 'avg_monthly_aa' | 'case_submission';
export const TARGET_ROW_KEYS: readonly TargetRowKey[] = [
  'ape', 'manpower', 'flc', 'new_aa', 'avg_monthly_aa', 'case_submission',
];

/** The single-month columns: the ones a blocked row draws blocked. */
export const MONTH_COLUMN_KEYS: readonly ColumnKey[] = ['thisMonthLastYear', 'lastMonth', 'thisMonth'];

export type ScorecardCell =
  /** `value` exact: minor units for `idr_minor`, a whole or fractional count, a percentage. */
  | { kind: 'figure'; value: number; leavesOut: string[] /* YYYY-MM months of the period not held */ }
  /** *pending data*: no source holds the figure for its period. */
  | { kind: 'pending' }
  /** *—*: a ratio over nothing whose months are held (*Average Case Size* over no policies). */
  | { kind: 'none' }
  /** Drawn blocked, as the prototype draws it. */
  | { kind: 'blocked' };

export type ScorecardUnit = 'idr_minor' | 'count' | 'percentage';

export interface ComputedScorecardRow {
  key: RowKey;
  unit: ScorecardUnit;
  cells: Record<ColumnKey, ScorecardCell>;
}

export interface ScorecardChips {
  manpower: number;
  agents: number;
  units: number;
  ab: number;
  aab: number;
}

export interface ComputedScorecard {
  /** `YYYY` for `fy` and `ytd`; `YYYY-MM` for the three months. */
  periods: Record<ColumnKey, string>;
  chips: ScorecardChips;
  /** Nine, in the prototype's order. */
  rows: ComputedScorecardRow[];
}

/** What a scorecard is computed for: the office, its calendar, and the meeting's own date. */
export interface ScorecardInput {
  kpmId: string;
  timezone: string;
  /** `YYYY-MM-DD`, an office date. */
  meetingDate: string;
}
