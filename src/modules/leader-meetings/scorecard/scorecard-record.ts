import { columnPeriods } from './scorecard.service';
import {
  BLOCKED_ROW_KEYS, COLUMN_KEYS, MONTH_COLUMN_KEYS, ROW_KEYS, ROW_UNITS, SCORECARD_DEFINITIONS, type ColumnKey, type ColumnPeriod,
  type ComputedScorecard, type ComputedScorecardRow, type RowKey, type ScorecardCell, type ScorecardChips,
  type ScorecardDefinitions,
} from './scorecard.types';

/**
 * ***AS OF*** as a read serves it (P18.9-T1 AC-13, AC-19): the day, or **`none`** — the office has no file yet, and
 * nothing is drawn — or **`unrecorded`**: a scorecard frozen before *AS OF* existed, which reads *—*.
 */
export type ScorecardAsOf = { kind: 'date'; date: string } | { kind: 'none' } | { kind: 'unrecorded' };

/**
 * **A scorecard as a read serves it, live or frozen** — the current columns and rows, in the slide's order, whatever
 * shape it was stored in. What the meeting's view lays the typed targets over (`leader-meeting.view.ts`).
 */
export interface ScorecardRecord {
  periods: Record<ColumnKey, ColumnPeriod>;
  chips: ScorecardChips;
  rows: ComputedScorecardRow[];
  asOf: ScorecardAsOf;
  /**
   * **The definitions its rows were computed with** (P19.3-T1; ADR-0202 §4): `data_sources` for a live scorecard and one
   * frozen since, `reference_slide` for one frozen before — so a footnote never describes a figure it is not.
   */
  definitions: ScorecardDefinitions;
}

const BLOCKED: ScorecardCell = { kind: 'blocked' };
const UNRECORDED: ScorecardCell = { kind: 'unrecorded' };

/** A live scorecard, as computed a moment ago: every cell its computation's. */
export function liveRecord(computed: ComputedScorecard): ScorecardRecord {
  return {
    periods: computed.periods,
    chips: computed.chips,
    rows: computed.rows,
    asOf: computed.asOf === null ? { kind: 'none' } : { kind: 'date', date: computed.asOf },
    definitions: computed.definitions,
  };
}

/** A stored cell, if it is one a computation writes; anything else is not read as a figure. */
function cellOf(stored: unknown): ScorecardCell | null {
  if (!stored || typeof stored !== 'object') return null;
  const cell = stored as { kind?: unknown; value?: unknown; leavesOut?: unknown };
  if (cell.kind === 'pending' || cell.kind === 'none' || cell.kind === 'blocked' || cell.kind === 'not_uploaded') return { kind: cell.kind };
  if (cell.kind === 'figure' && typeof cell.value === 'number' && Number.isFinite(cell.value)) {
    const leavesOut = Array.isArray(cell.leavesOut) ? cell.leavesOut.filter((m): m is string => typeof m === 'string') : [];
    return { kind: 'figure', value: cell.value, leavesOut };
  }
  return null;
}

/** A stored chip: the number it froze with. */
const chipOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * **A frozen scorecard, read tolerantly** (ADR-0129 §7, ADR-0175 §8; P18.9-T1 AC-19) — whatever shape it was frozen
 * in. **Nothing is recomputed, and nothing is written**:
 *
 * - **what it lacks reads *—*** (`unrecorded`): the *YTD {Y−1}* column of a scorecard frozen before 2026-10-28, its
 *   *Cases/producing agents* row's year cells, its *AS OF*. A cell the row never tracks in the *Monthly View* is *Not
 *   tracked*, as on any meeting — that is the row's shape, not a figure;
 * - **what it has that the table no longer draws is kept and not served**: *New AA (avg. monthly)*'s row stays on the
 *   meeting, untouched;
 * - **its *# of units* is the one it froze with** — the AB agencies, for a meeting frozen before — so a past meeting
 *   reads the units it was discussed with, and its targets' multiplier follows them;
 * - its periods are named from the meeting's own date, as a live one's are (`columnPeriods`), since a frozen
 *   meeting's date never moves (ADR-0130 §4);
 * - **its definitions are the ones it was frozen with** (P19.3-T1; ADR-0202 §4): a scorecard frozen since P19.3-T1
 *   stores `data_sources`; **one that stores none was frozen before, under `reference_slide`** — its *3M new agent %*
 *   ADR-0171's day-90 share, its *FLC* pending, its *Cases/producing agents* over *Annual Active Agents* — and its
 *   footnotes say so. A value nobody wrote is read as the older one, never as today's.
 */
export function frozenRecord(stored: unknown, meetingDate: string): ScorecardRecord {
  const card = (stored && typeof stored === 'object' ? stored : {}) as {
    chips?: Partial<Record<keyof ScorecardChips, unknown>>;
    rows?: unknown;
    asOf?: unknown;
    definitions?: unknown;
  };
  const storedRows = Array.isArray(card.rows) ? (card.rows as { key?: unknown; cells?: Record<string, unknown> }[]) : [];
  const rows = ROW_KEYS.map((key: RowKey): ComputedScorecardRow => {
    const row = storedRows.find((r) => r && r.key === key);
    const tracked = (column: ColumnKey) => !(BLOCKED_ROW_KEYS.includes(key) && MONTH_COLUMN_KEYS.includes(column));
    const cells = Object.fromEntries(COLUMN_KEYS.map((column) => [
      column,
      cellOf(row?.cells?.[column]) ?? (tracked(column) ? UNRECORDED : BLOCKED),
    ])) as Record<ColumnKey, ScorecardCell>;
    return { key, unit: ROW_UNITS[key], cells };
  });
  const chips = card.chips ?? {};
  const asOf: ScorecardAsOf = !('asOf' in card)
    ? { kind: 'unrecorded' }
    : typeof card.asOf === 'string' ? { kind: 'date', date: card.asOf } : { kind: 'none' };
  return {
    periods: columnPeriods(meetingDate),
    chips: {
      manpower: chipOf(chips.manpower), agents: chipOf(chips.agents), units: chipOf(chips.units),
      ab: chipOf(chips.ab), aab: chipOf(chips.aab),
    },
    rows,
    asOf,
    definitions: (SCORECARD_DEFINITIONS as readonly unknown[]).includes(card.definitions)
      ? card.definitions as ScorecardDefinitions
      : 'reference_slide',
  };
}
