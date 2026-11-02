import mongoose from 'mongoose';

export interface CalendarAllDayResult {
  /** Trips given `allDay: true`: every one written before the field, each all-day as Travel then was. */
  trips: number;
  /** Every other entry given `allDay: false`. */
  timed: number;
}

/**
 * **Every calendar entry says whether it is all-day** (UI V1, 2026-10-30, UI-104 point 8; ADR-0180 §11). Until now a
 * trip was all-day by its type alone; since UI V1 a trip may have times (*Sepanjang hari* off), so `calendarEvents`
 * carries `allDay`. Every trip written before the field was all-day, and is given `true`; every other entry `false`.
 * A row that already says either keeps it. Reads treat a missing value as its type did, so the order of deploy and
 * migration changes nothing anybody sees.
 *
 * **Idempotent and forward-only**: each write is conditional on the field being absent or `null`; a second run finds
 * none and writes nothing. On an empty database there is no collection to read, and it writes nothing.
 */
export async function up(db: mongoose.mongo.Db): Promise<CalendarAllDayResult> {
  const entries = db.collection('calendarEvents');
  const unset = { $in: [null] };
  const trips = await entries.updateMany({ type: 'travel', allDay: unset }, { $set: { allDay: true } });
  const timed = await entries.updateMany({ type: { $ne: 'travel' }, allDay: unset }, { $set: { allDay: false } });
  return { trips: trips.modifiedCount, timed: timed.modifiedCount };
}
