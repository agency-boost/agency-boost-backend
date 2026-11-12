/**
 * **Home** (UI V1, 2026-10-30; UI-100, UI-101; the owner's D-16 and his Home v2 of 30 October; ADR-0180 §10): the
 * numbers and the daily rotation `GET /home` reads, defined once here, documented once in
 * `docs/00-product/metrics-and-definitions.md` §B.29 and pinned by `home.spec.ts` (invariant §7).
 *
 * **The quotes are content, not catalogue strings**: shown in their original language whatever the reader's (the owner,
 * 2026-10-30), so they live here, on the server, and never in `frontend/src/i18n`. The list is the owner's, in his
 * order — `#1` first — and the person is named as he wrote them, the name alone with no dash.
 */

import { PERIOD } from './index';

/** One quote of the day: its words as said, and who said them. */
export interface HomeQuote {
  text: string;
  person: string;
}

/** The owner-approved list (UI-100), in order. Twenty: the rotation is `dayNumber mod 20`. */
export const HOME_QUOTES: readonly HomeQuote[] = [
  { text: 'Well done is better than well said.', person: 'Benjamin Franklin' },
  { text: 'You miss 100% of the shots you don\'t take.', person: 'Wayne Gretzky' },
  { text: 'Success is the sum of small efforts, repeated day in and day out.', person: 'Robert Collier' },
  { text: 'Don\'t watch the clock; do what it does. Keep going.', person: 'Sam Levenson' },
  { text: 'Do what you can, with what you have, where you are.', person: 'Theodore Roosevelt' },
  { text: 'Try again. Fail again. Fail better.', person: 'Samuel Beckett' },
  { text: 'Gantungkan cita-citamu setinggi langit.', person: 'Soekarno' },
  { text: 'Ing ngarsa sung tuladha.', person: 'Ki Hajar Dewantara' },
  { text: 'Whether you think you can, or you think you can\'t, you\'re right.', person: 'Henry Ford' },
  { text: 'You don\'t have to be great to start, but you have to start to be great.', person: 'Zig Ziglar' },
  { text: 'Genius is one percent inspiration and ninety-nine percent perspiration.', person: 'Thomas Edison' },
  { text: 'The only way to do great work is to love what you do.', person: 'Steve Jobs' },
  { text: 'It\'s not whether you get knocked down, it\'s whether you get up.', person: 'Vince Lombardi' },
  { text: 'Discipline is the bridge between goals and accomplishment.', person: 'Jim Rohn' },
  { text: 'Patience, persistence and perspiration make an unbeatable combination for success.', person: 'Napoleon Hill' },
  {
    text: 'There are no secrets to success. It is the result of preparation, hard work, and learning from failure.',
    person: 'Colin Powell',
  },
  { text: 'Plans are only good intentions unless they immediately degenerate into hard work.', person: 'Peter Drucker' },
  { text: 'Habis gelap terbitlah terang.', person: 'R.A. Kartini' },
  { text: 'Hard work beats talent when talent doesn\'t work hard.', person: 'Tim Notke' },
  { text: 'Don\'t quit. Suffer now and live the rest of your life as a champion.', person: 'Muhammad Ali' },
];

/**
 * **Boost's four quote poses, in the owner's order** (UI-100: *thinking → celebrating → pointing → phone*; UI-102). The
 * frontend draws them from `BOOST_QUOTE_POSES`, the same four in the same order; the server names the day's.
 */
export const HOME_QUOTE_POSES = ['thinking', 'celebrating', 'pointing', 'phone'] as const;
export type HomeQuotePose = (typeof HOME_QUOTE_POSES)[number];

export const HOME = {
  /**
   * *Aksi hari ini*: the top three things on the reader's list, never more (the owner, 30 Oct) — **today's alone**
   * (P19.11-T1 AC-3, UX-2), so fewer, or none, when today holds fewer.
   */
  ACTIONS_SHOWN: 3,
  /** *Aktivitas 7 hari terakhir*: the seven office days ending today, rolling — `ROLLING_7D`, never a second seven. */
  CHART_DAYS: PERIOD.ROLLING_7D_DAYS,
  /** *Coaching 7 hari*: `COACHED_7D`'s window, `DAYS_SINCE_LAST_COACHING ≤ 7` (§A.3) — never a second rule. */
  COACHED_WINDOW_DAYS: PERIOD.ROLLING_7D_DAYS,
} as const;

/** 1 January 1970 as a calendar date: day number 0. */
const EPOCH = Date.UTC(1970, 0, 1);
const DAY_MS = 86_400_000;

/**
 * **`HOME_DAY_NUMBER`** — the office's day as a whole number: the calendar days from 1 January 1970 to the office's
 * today (`YYYY-MM-DD`, already resolved in the office's zone, Asia/Jakarta — invariant §9). Calendar arithmetic, in UTC
 * on purpose, as `addDays` is: a date has no zone in it, so the number changes at the office's midnight and nowhere
 * else. 30 October 2026 is 20756.
 */
export function homeDayNumber(today: string): number {
  const [y, m, d] = today.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY_MS);
}

/**
 * **The quote and the pose of the day** (UI-100): quote = day number mod 20, pose = day number mod 4 — both turn at the
 * office's midnight, the same for everybody in the office on the same day. `index` is the quote's place in the list,
 * from 0, so a test or a reader can name it (`#17` is index 16).
 */
export function quoteOfTheDay(today: string): HomeQuote & { index: number; pose: HomeQuotePose } {
  const day = homeDayNumber(today);
  const index = ((day % HOME_QUOTES.length) + HOME_QUOTES.length) % HOME_QUOTES.length;
  const pose = HOME_QUOTE_POSES[((day % HOME_QUOTE_POSES.length) + HOME_QUOTE_POSES.length) % HOME_QUOTE_POSES.length];
  return { ...HOME_QUOTES[index], index, pose };
}
