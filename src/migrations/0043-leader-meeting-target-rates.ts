import type mongoose from 'mongoose';
import { emptyIfMissing } from './missing-collection';

/**
 * The scorecard's rows whose *Monthly Target* is a rate per unit since 2026-10-28 (ADR-0175 §4): *APE*, *Manpower*,
 * *FLC*, *Avg. monthly AA* and *Case submission*. Kept here, as every migration keeps what it reads, so the code may
 * move on and this stays what it ran as. *New AA*'s cells are not among them: they stay as typed (ADR-0175 §2).
 */
export const RATE_ROWS = ['ape', 'manpower', 'flc', 'avg_monthly_aa', 'case_submission'] as const;

/** IDR minor units in one *miliar*: *APE (Rp M)*'s rate was typed in the row's unit, and is kept in sen (invariant §9). */
const MINOR_UNITS_PER_MILIAR = 1_000_000_000 * 100;

/** *"{n} ({r} @ unit)"* — the leaders' own way of typing a rate and its product (`KPM_Owner.html:2463`, `:2470`). */
const RATE_TEXT = /^\s*\d[\d.,]*\s*\(\s*(\d+(?:[.,]\d+)?)\s*@\s*unit\s*\)\s*$/i;

/** *TBD*, or nothing: no target. */
const NO_TARGET = /^\s*(?:tbd)?\s*$/i;

/** A cell as it is stored once read as a rate: what `LeaderMeetingRepository.setMonthlyTarget` writes. */
export interface RateCell {
  rate: number | null;
  typed: string | null;
  version: number;
}

/**
 * **One typed target, read as a rate** (P18.9-T1 AC-11): *"{n} ({r} @ unit)"* is the rate *r* — in sen for *APE*, a
 * count to two places for the others, the places a rate is typed to — *TBD* and an empty cell are no target, and any
 * other text is kept as typed (`typed`), shown so until an editor enters a rate. The *n* a leader typed is not kept:
 * it is the rate times the units, which the table computes now, and where they disagreed (UI-008) it was the wrong half.
 * The cell's version stays: this is not an edit, and a page open on it still writes.
 */
export function rateCellOf(row: string, value: string, version: number): { cell: RateCell; read: 'rate' | 'none' | 'kept' } {
  const match = RATE_TEXT.exec(value);
  if (match) {
    const r = Number(match[1].replace(',', '.'));
    const rate = row === 'ape' ? Math.round(r * MINOR_UNITS_PER_MILIAR) : Math.round(r * 100) / 100;
    return { cell: { rate, typed: null, version }, read: 'rate' };
  }
  if (NO_TARGET.test(value)) return { cell: { rate: null, typed: null, version }, read: 'none' };
  return { cell: { rate: null, typed: value.trim(), version }, read: 'kept' };
}

/**
 * **The forum's typed targets, as rates** (ADR-0175 §4, reversing ADR-0129 §5's free text; the client's KPM Owner
 * findings of 2026-10-27, UI-008; P18.9-T1 AC-11, parity I-487).
 *
 * A *Monthly Target* was free text, and the leaders typed *"8 (1 @ unit)"* beside 5 units, with nothing to check the
 * sum. It is a rate per unit now, shown as the rate times the meeting's *# of units*. This reads each meeting's cells
 * of the five rows that take a rate (`rateCellOf`): a rate where the text says one, no target for *TBD*, and the text
 * kept as typed otherwise. **A *New AA* cell is not touched** — its data stays (AC-6) — and nor is anything else on the
 * meeting: no scorecard, no version, no `writtenAt`, no timestamp.
 *
 * **Idempotent**: a cell already a rate (`rate` present) is counted `current` and left; each write is matched on the
 * text it read, so a cell changed between the read and the write is left for the next run. On an empty database it
 * reads nothing at all.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ meetings: number; rates: number; none: number; kept: number; current: number }> {
  const collection = db.collection('leaderMeetings');
  const meetings = await emptyIfMissing(collection.find({}, { projection: { monthlyTargets: 1 } }).toArray());
  const counts = { meetings: 0, rates: 0, none: 0, kept: 0, current: 0 };

  for (const meeting of meetings) {
    const targets = (meeting.monthlyTargets ?? {}) as Record<string, { value?: unknown; rate?: unknown; version?: unknown } | null>;
    let touched = false;
    for (const row of RATE_ROWS) {
      const stored = targets[row];
      if (!stored || typeof stored !== 'object') continue;
      if ('rate' in stored) {
        counts.current += 1;
        continue;
      }
      if (typeof stored.value !== 'string') continue;
      const version = typeof stored.version === 'number' ? stored.version : 1;
      const { cell, read } = rateCellOf(row, stored.value, version);
      const path = `monthlyTargets.${row}`;
      const result = await collection.updateOne(
        { _id: meeting._id, [`${path}.value`]: stored.value, [`${path}.rate`]: { $exists: false } },
        { $set: { [path]: cell } },
      );
      if (result.modifiedCount === 0) continue;
      touched = true;
      counts[read === 'rate' ? 'rates' : read] += 1;
    }
    if (touched) counts.meetings += 1;
  }

  return counts;
}
