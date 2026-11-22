import { EVENT_FEEDBACK_BANDS, EVENT_KEHADIRAN } from '@/domain/constants';
import type { EventAttendanceStatus } from '@/domain/constants';
import { eventNps } from './event-nps';
import { wholePercent } from './rate';

/**
 * **`EVENT_KEHADIRAN` — hadir or tidak hadir** (P19.25-T1, T2; ADR-0281 §1, §3, §5; `metrics-and-definitions.md`;
 * `revisions/2026-11-19/DATA-DEFINITIONS.md`, *Events*).
 *
 * - **Every member the event was for is expected** — its audience as at its start (ADR-0039, ADR-0135), test accounts
 *   never counted (ADR-0267 §1). There is no *tidak diundang*: somebody outside the audience is simply not expected, and
 *   is drawn as no mark at all.
 * - **Hadir is the office's roll call** (ADR-0138, kept): a confirmer marked them attended. **Tidak hadir is everything
 *   else** in a recorded event — marked absent, said they came with nobody confirming it, RSVP'd, or nothing.
 * - **An event is recorded** once its roll call has been taken — at least one member marked either way. Until then it
 *   reads *Belum dicatat* and is left out of every average: nobody has said who came, so nobody is *tidak hadir* yet.
 *
 * Pure: the facts in, the figures out. The reading (`EventAnalytics`) reads the rows.
 */

/** A share's colour (`DESIGN-RULES.md`, *Status colours*). */
export type KehadiranTone = 'green' | 'yellow' | 'red';

/** One member at one event: `'1'` hadir, `'0'` tidak hadir, `'.'` not expected (outside its audience), `'?'` not recorded. */
export type KehadiranMark = '1' | '0' | '.' | '?';

/** A share hadir, coloured: green from 80%, yellow from 50%, red below; `null` with no share. */
export function kehadiranTone(pct: number | null): KehadiranTone | null {
  if (pct === null) return null;
  if (pct >= EVENT_KEHADIRAN.GREEN_FROM_PCT) return 'green';
  if (pct >= EVENT_KEHADIRAN.YELLOW_FROM_PCT) return 'yellow';
  return 'red';
}

/** An event's NPS, coloured: green from +30, yellow from 0, red below; `null` with no answer. */
export function eventNpsTone(nps: number | null): KehadiranTone | null {
  if (nps === null) return null;
  if (nps >= EVENT_FEEDBACK_BANDS.GREEN_FROM) return 'green';
  if (nps >= EVENT_FEEDBACK_BANDS.YELLOW_FROM) return 'yellow';
  return 'red';
}

/** One member's mark at one event, from the roll call's status, whether they were expected, and whether it is recorded. */
export function kehadiranMark(expected: boolean, recorded: boolean, status: EventAttendanceStatus | null): KehadiranMark {
  if (!expected) return '.';
  if (!recorded) return '?';
  return status === 'attended' ? '1' : '0';
}

/** Whether an ended event's roll call has been taken: somebody in it was marked, attended or absent. */
export function isRecorded(statuses: readonly EventAttendanceStatus[]): boolean {
  return statuses.some((s) => s === 'attended' || s === 'no_show');
}

/**
 * **A share over many events** — *"rata-rata 7,1 dari 10 orang"*: the people hadir per event and the people expected per
 * event, each averaged over the events (`decimals` places, half up), and the share **from the two sums**, rounded once —
 * never from the rounded averages. `null` everywhere over no event or nobody expected.
 */
export interface KehadiranFigure {
  /** Hadir per event, averaged; a count when over one event. */
  hadir: number | null;
  /** Expected per event, averaged. */
  expected: number | null;
  /** `Σ hadir / Σ expected` as a whole percent. */
  pct: number | null;
  tone: KehadiranTone | null;
  /** How many events it is over. */
  events: number;
}

export function kehadiranFigure(
  perEvent: readonly { hadir: number; expected: number }[], decimals: 0 | 1,
): KehadiranFigure {
  const events = perEvent.length;
  const hadir = perEvent.reduce((s, e) => s + e.hadir, 0);
  const expected = perEvent.reduce((s, e) => s + e.expected, 0);
  if (events === 0 || expected === 0) return { hadir: null, expected: null, pct: null, tone: null, events };
  const pct = wholePercent(hadir, expected);
  return { hadir: roundTo(hadir / events, decimals), expected: roundTo(expected / events, decimals), pct, tone: kehadiranTone(pct), events };
}

/**
 * **One member over the period's recorded events** (*Per orang*), from their marks **newest first**:
 *
 * - `attended` of `expected` — *"Hadir 2 dari 12 event"*, every recorded event of the period they were expected at;
 * - `recent…` — the same over the last `EVENT_KEHADIRAN.RECENT_EVENTS` recorded events (the strip's);
 * - `lastIndex` — the position of the newest event they attended, `null` for none; `since` — the events they were
 *   expected at that came after it (all of them when they attended none); `stale` — `since` above
 *   `STALE_AFTER_EVENTS`, drawn red;
 * - `underHalf` — under `WHATSAPP_UNDER_PCT` of the events they were expected at: offered WhatsApp.
 *
 * `'?'` (an unrecorded event) and `'.'` (not expected) count for nothing.
 */
export interface MemberKehadiran {
  attended: number;
  expected: number;
  pct: number | null;
  tone: KehadiranTone | null;
  recentAttended: number;
  recentExpected: number;
  lastIndex: number | null;
  since: number;
  stale: boolean;
  underHalf: boolean;
}

export function memberKehadiran(marksNewestFirst: readonly KehadiranMark[]): MemberKehadiran {
  let attended = 0;
  let expected = 0;
  let recentAttended = 0;
  let recentExpected = 0;
  let recorded = 0;
  let lastIndex: number | null = null;
  let since = 0;
  marksNewestFirst.forEach((mark, i) => {
    if (mark === '?') return;
    const recent = recorded < EVENT_KEHADIRAN.RECENT_EVENTS;
    recorded += 1;
    if (mark === '.') return;
    expected += 1;
    if (recent) recentExpected += 1;
    if (mark === '1') {
      attended += 1;
      if (recent) recentAttended += 1;
      if (lastIndex === null) lastIndex = i;
    } else if (lastIndex === null) {
      since += 1;
    }
  });
  const pct = expected === 0 ? null : wholePercent(attended, expected);
  return {
    attended,
    expected,
    pct,
    tone: kehadiranTone(pct),
    recentAttended,
    recentExpected,
    lastIndex,
    since,
    stale: expected > 0 && since > EVENT_KEHADIRAN.STALE_AFTER_EVENTS,
    underHalf: pct !== null && pct < EVENT_KEHADIRAN.WHATSAPP_UNDER_PCT,
  };
}

/**
 * **An event's feedback, as *Feedback* reads it** (P19.25-T2 AC-1, AC-2; ADR-0281 §5): `EVENT_NPS` over the answers of
 * the members who were hadir (ADR-0138 §6, kept), the average score to one decimal, the count, the three buckets' shares
 * as whole percents (for the slim bar; they need not sum to 100), the NPS's tone, and *sedikit jawaban* under three.
 */
export interface FeedbackFigure {
  nps: number | null;
  average: number | null;
  answers: number;
  shares: { promoter: number; passive: number; detractor: number } | null;
  tone: KehadiranTone | null;
  few: boolean;
}

export function feedbackFigure(scores: readonly number[]): FeedbackFigure {
  const reading = eventNps(scores);
  const n = reading.n;
  return {
    nps: reading.nps,
    average: n === 0 ? null : roundTo(scores.reduce((s, x) => s + x, 0) / n, 1),
    answers: n,
    shares: n === 0 ? null : {
      promoter: wholePercent(reading.promoters, n),
      passive: wholePercent(reading.passives, n),
      detractor: wholePercent(reading.detractors, n),
    },
    tone: eventNpsTone(reading.nps),
    few: n < EVENT_FEEDBACK_BANDS.FEW_UNDER,
  };
}

/** `value` to `decimals` places, half up — `Math.round` on the scaled value, which is exact for the tenths used here. */
function roundTo(value: number, decimals: 0 | 1): number {
  const scale = decimals === 1 ? 10 : 1;
  return Math.round(value * scale + Number.EPSILON) / scale;
}
