import type { EventPhase } from '@/domain/constants';

/**
 * **Where an event sits relative to now, from its instants** (P5-T6 AC-3; P18.2-T5, F-42 amended).
 *
 * One boundary for everything that turns on it: **an event has ended from `endsAt`** (`now >= endsAt`). Until then it
 * takes an RSVP and a cancellation, and a running event sits with the upcoming ones (*"share feedback once they
 * wrap up"*, `Overall.html:10413`); from then the claim, the feedback and the roll call open. The phase badge and the
 * write rules read this one function, so the screen cannot say *Past* while the API still takes an RSVP.
 */
export function hasEnded(event: { endsAt: Date }, now: Date): boolean {
  return now.getTime() >= event.endsAt.getTime();
}

export function eventPhase(event: { startsAt: Date; endsAt: Date }, now: Date): EventPhase {
  if (now.getTime() < event.startsAt.getTime()) return 'upcoming';
  return hasEnded(event, now) ? 'past' : 'running';
}

/** `HH:mm` (24-hour) in the office's zone — the card's *"{date} · {time}"* time, formatted by the screen. */
export function localTimeOf(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(instant);
}
