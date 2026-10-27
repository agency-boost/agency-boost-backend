import { DateTime } from 'luxon';
import {
  formatDateRange, formatDayMonth, formatMonth, formatMonthName, formatMonthRange,
} from '@/common/format/format';
import { addDays, endOfMonth, localDayOf, type LocalDate } from '@/common/time/local-day';
import {
  CAMPAIGN_DURATION_WORDS, CAMPAIGN_ROLLING_MONTHS, type CampaignWindow,
} from '@/domain/constants';

/**
 * **What a campaign is read over** (P18.5-T8 AC-2; D-windows), in the office's calendar — pure: a campaign's
 * window, its dates and the office's day in; the months its file metrics read, the days its activity reads, the
 * key its standing is stored under and the words the dialog writes, out.
 *
 * - `campaign_dates` — its own dates. **Whole office months** when a requirement reads the monthly file
 *   (`isWholeMonths`, which the Owner's write enforces); any days for activity.
 * - `calendar_year` — January to December of the office's current year, recurring; a year to date while it runs.
 * - `rolling_12m` — the twelve months ending with the latest month the office holds, as of today. Never final.
 *
 * Every edge is a local day: a campaign that ends on 30 September is running at 23:59 that night in Jakarta and
 * ended at 00:01 on 1 October, whatever the server's clock says (invariant §9).
 */

export interface CampaignDates {
  window: CampaignWindow;
  startsAt: Date;
  endsAt: Date | null;
}

export interface ResolvedWindow {
  /** What a final standing is stored under: `2026-07..2026-09`, `2026-08-15..2026-09-15`, `2026`, `rolling`. */
  key: string;
  /** Every month the monthly file is read over, oldest first (`YYYY-MM`). */
  months: string[];
  /** The days activity is counted over, no later than today. `null` before the window has begun. */
  days: { from: LocalDate; to: LocalDate } | null;
  /** The window's last day, today or not. */
  lastDay: LocalDate;
  /** The dialog's words for what is read: *Jul – Sep 2026*, *Jan – Des 2026*, *Okt 2025 – Sep 2026*. */
  label: string;
  /** `rolling_12m` never is: it moves with every month held. */
  finalisable: boolean;
}

/** `YYYY-MM` plus `n` months. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Every month from `from` to `to` inclusive, oldest first. */
export function monthsFrom(from: string, to: string): string[] {
  const out: string[] = [];
  for (let month = from; month <= to; month = addMonths(month, 1)) out.push(month);
  return out;
}

/** *Jul – Sep 2026*, *Nov 2026 – Jan 2027*, *Sep 2026* — the shared formatter's (ADR-0167 §1). */
export function monthRangeWords(from: string, to: string): string {
  return formatMonthRange(from, to);
}

/**
 * *1 Jul – 30 Sep 2026*, *1 Nov 2026 – 31 Jan 2027* — the card's duration (`Overall.html:7930`), written the
 * Indonesian way through the shared formatter (ADR-0167 §1) where the prototype wrote *Jul 1 – Sep 30, 2026*.
 */
export function dayRangeWords(from: LocalDate, to: LocalDate): string {
  return formatDateRange(from, to);
}

/**
 * **A campaign's last local day.** `endsAt` is its last instant; one exactly at local midnight is an exclusive end
 * and belongs to the day before it — so `2026-10-01T00:00+07:00` and `2026-09-30T23:59+07:00` both end on the 30th.
 */
export function lastLocalDay(endsAt: Date, timezone: string): LocalDate {
  const local = DateTime.fromJSDate(endsAt, { zone: 'utc' }).setZone(timezone);
  const day = localDayOf(endsAt, timezone);
  return local.hour === 0 && local.minute === 0 && local.second === 0 && local.millisecond === 0
    ? addDays(day, -1)
    : day;
}

/**
 * **A campaign's last instant, as stored** (the review, item 8): `endsAt` is inclusive, so a campaign ending on the
 * 30th ends at **23:59:59.999** that day in the office's calendar — an end typed to the minute (*23:59*) or given as
 * the next midnight is moved there, so its last minute is not read as ended. Any other end is kept as given.
 */
export function inclusiveEnd(endsAt: Date, timezone: string): Date {
  const local = DateTime.fromJSDate(endsAt, { zone: 'utc' }).setZone(timezone);
  const midnight = local.hour === 0 && local.minute === 0 && local.second === 0 && local.millisecond === 0;
  if (!midnight && !(local.hour === 23 && local.minute === 59)) return endsAt;
  const day = lastLocalDay(endsAt, timezone);
  return DateTime.fromISO(day, { zone: timezone }).endOf('day').toUTC().toJSDate();
}

/**
 * **Whole office months** (D-windows): it starts at local midnight on a 1st and ends with a month's last day — at
 * 23:59 or later that day, or exactly at midnight after it. What a campaign reading the monthly file must be,
 * because the file is a month at a time (ADR-0050): a window of 15 August to 15 September would read two whole
 * months and claim half of each.
 */
export function isWholeMonths(startsAt: Date, endsAt: Date | null, timezone: string): boolean {
  if (endsAt === null) return false;
  const start = DateTime.fromJSDate(startsAt, { zone: 'utc' }).setZone(timezone);
  if (start.day !== 1 || start.hour !== 0 || start.minute !== 0 || start.second !== 0 || start.millisecond !== 0) {
    return false;
  }
  const last = lastLocalDay(endsAt, timezone);
  if (last !== endOfMonth(last)) return false;
  const end = DateTime.fromJSDate(endsAt, { zone: 'utc' }).setZone(timezone);
  const exclusiveMidnight = end.hour === 0 && end.minute === 0 && end.second === 0 && end.millisecond === 0;
  return exclusiveMidnight || (end.hour === 23 && end.minute === 59);
}

/** *Running*, *Upcoming* or *Ended*, from its instants — never stored (F-48). No end is running once started. */
export function campaignPhase(startsAt: Date, endsAt: Date | null, now: Date): 'upcoming' | 'running' | 'ended' {
  if (now.getTime() < startsAt.getTime()) return 'upcoming';
  if (endsAt === null || now.getTime() <= endsAt.getTime()) return 'running';
  return 'ended';
}

/** The card's duration, composed in the office's calendar, or the window's verbatim words. */
export function durationWords(campaign: CampaignDates, timezone: string): string {
  if (campaign.window !== 'campaign_dates') return CAMPAIGN_DURATION_WORDS[campaign.window];
  const from = localDayOf(campaign.startsAt, timezone);
  if (campaign.endsAt === null) return `From ${formatDayMonth(from)}`;
  return dayRangeWords(from, lastLocalDay(campaign.endsAt, timezone));
}

/**
 * **The Personal Summary row's one line: the months the campaign runs** (P18.95-T7 AC-1, ADR-0167 §7; the client's
 * *Grey text* table, row 23). It read *"Ongoing incentive · Standing — evaluated per calendar year (1 Jan – 31 Des)"*;
 * the client's line is *Runs Jan–Des*, and each window's is composed the same way, in the office's calendar:
 *
 * - `calendar_year` — *Runs Jan – Des*: January to December, no year, because it runs every year;
 * - `campaign_dates` — the months its own dates touch: *Runs Agu – Okt 2026*, *Runs Okt 2026* for one month,
 *   *Runs Nov 2026 – Jan 2027* across a year, and *Runs from Okt 2026* with no end;
 * - `rolling_12m` — *Runs over the last 12 months*: its months move with every file the office holds, so no two
 *   months would stay true for long.
 *
 * Month names and the range's en dash are the shared formatter's (ADR-0167 §1). The card and the dialog keep
 * `durationWords`, the prototype's words, at every size.
 */
export function runsWords(campaign: CampaignDates, timezone: string): string {
  if (campaign.window === 'calendar_year') {
    // The formatter's range, its year dropped: `formatMonthRange` would write *Jan – Des 2026*.
    const [first, last] = [formatMonthName('2000-01'), formatMonthName('2000-12')];
    return `Runs ${first} – ${last}`;
  }
  if (campaign.window === 'rolling_12m') return `Runs over the last ${CAMPAIGN_ROLLING_MONTHS} months`;
  const from = localDayOf(campaign.startsAt, timezone).slice(0, 7);
  if (campaign.endsAt === null) return `Runs from ${formatMonth(from)}`;
  return `Runs ${formatMonthRange(from, lastLocalDay(campaign.endsAt, timezone).slice(0, 7))}`;
}

/**
 * **The window, as of the office's day.** `latestHeldMonth` is the latest month the office holds a file for — what
 * `rolling_12m` ends on; `null` when it holds none, and the window then ends with last month.
 */
export function resolveWindow(
  campaign: CampaignDates,
  office: { today: LocalDate; timezone: string; latestHeldMonth: string | null },
  /** A calendar year other than today's: the year before, when its standings are frozen. */
  year?: string,
): ResolvedWindow {
  const thisMonth = office.today.slice(0, 7);
  if (campaign.window === 'calendar_year') {
    const y = year ?? office.today.slice(0, 4);
    const lastDay = `${y}-12-31`;
    return {
      key: y,
      months: monthsFrom(`${y}-01`, `${y}-12`),
      days: daysUpTo(`${y}-01-01`, lastDay, office.today),
      lastDay,
      label: monthRangeWords(`${y}-01`, `${y}-12`),
      finalisable: true,
    };
  }
  if (campaign.window === 'rolling_12m') {
    const anchor = office.latestHeldMonth !== null && office.latestHeldMonth <= thisMonth
      ? office.latestHeldMonth
      : addMonths(thisMonth, -1);
    const first = addMonths(anchor, -(CAMPAIGN_ROLLING_MONTHS - 1));
    // The days are the months': activity over the same twelve months the file is read for (the review, item 5).
    const lastDay = endOfMonth(`${anchor}-01`);
    return {
      key: 'rolling',
      months: monthsFrom(first, anchor),
      days: daysUpTo(`${first}-01`, lastDay, office.today),
      lastDay,
      label: monthRangeWords(first, anchor),
      finalisable: false,
    };
  }
  const from = localDayOf(campaign.startsAt, office.timezone);
  // A seasonal campaign always has an end (`campaign-input.ts`); one without reads to today.
  const lastDay = campaign.endsAt === null ? office.today : lastLocalDay(campaign.endsAt, office.timezone);
  const months = monthsFrom(from.slice(0, 7), lastDay.slice(0, 7));
  const whole = campaign.endsAt !== null && isWholeMonths(campaign.startsAt, campaign.endsAt, office.timezone);
  return {
    key: whole ? `${months[0]}..${months[months.length - 1]}` : `${from}..${lastDay}`,
    months,
    days: daysUpTo(from, lastDay, office.today),
    lastDay,
    label: whole ? monthRangeWords(months[0], months[months.length - 1]) : dayRangeWords(from, lastDay),
    finalisable: true,
  };
}

/** The window's days no later than today, or `null` before it begins. */
function daysUpTo(from: LocalDate, to: LocalDate, today: LocalDate): { from: LocalDate; to: LocalDate } | null {
  if (today < from) return null;
  return { from, to: to < today ? to : today };
}
