import type { EventAttendanceStatus } from '@/domain/constants';

/**
 * `EVENT_ATTENDANCE_STATUS` and `EVENT_ATTENDANCE_RATE` (P18.5-T5 AC-8; OD-31, D-status; `metrics-and-definitions.md`).
 *
 * **Only a confirmation makes `attended`** (OD-31, exit test 2). An RSVP is an intention, and a claim — the agent's
 * *"I actually attended this event"* — is the member's own word: each unlocks the feedback form, neither moves the
 * office's number. The Owner or an Admin confirms, in the roll call; nobody confirms their own.
 *
 * **`no_show` is a confirmer's mark, never the absence of one** (D-status): after the end, a member who RSVP'd or
 * claimed and whom nobody has marked is `unconfirmed`.
 *
 * Pure: the facts in, the status out. The caller reads the facts from `eventRsvps` and decides `ended` from the clock.
 */

/** What one member's row says about one event. */
export interface AttendanceFacts {
  /** `now >= endsAt`. */
  readonly ended: boolean;
  /** The RSVP as it stands: going, cancelled, or never made. */
  readonly rsvp: 'going' | 'cancelled' | null;
  /** The member said they came (a claim). */
  readonly claimed: boolean;
  /** A confirmer's mark: attended, marked absent, or nothing yet. */
  readonly confirmed: boolean | null;
}

/** `EVENT_ATTENDANCE_STATUS` for one member and one event. */
export function eventAttendanceStatus(facts: AttendanceFacts): EventAttendanceStatus {
  if (facts.confirmed === true) return 'attended';
  if (facts.confirmed === false) return 'no_show';
  const said = facts.rsvp === 'going' || facts.claimed;
  if (!facts.ended) return facts.rsvp === 'going' ? 'registered' : 'not_registered';
  return said ? 'unconfirmed' : 'not_registered';
}

/**
 * `EVENT_ATTENDANCE_RATE`: the share of the audience **as at the event's start** that a confirmer marked attended,
 * as a percentage with one decimal (2 of 5 → 40). `null` before the event ends — nobody can have attended an event
 * that has not finished — and for an empty audience, where there is nothing to divide by.
 */
export function eventAttendanceRate(
  statuses: readonly EventAttendanceStatus[], ended: boolean,
): number | null {
  if (!ended || statuses.length === 0) return null;
  const attended = statuses.filter((s) => s === 'attended').length;
  // Whole numbers until the one division (the exit review): `attended / n * 1000` carries the quotient's float error
  // into the rounding, and 201 of 400 read 50.2 where it is 50.25 → 50.3.
  return Math.round((attended * 1000) / statuses.length) / 10;
}
