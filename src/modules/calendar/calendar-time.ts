import { DateTime } from 'luxon';
import { addDays, daysBetween, endOfMonth, isLocalDate, type LocalDate } from '@/common/time/local-day';
import type { FieldSentence } from '@/common/validation/fields';
import { VALIDATION_REFUSALS } from '@/common/validation/validation.messages';
import { CALENDAR, CALENDAR_ALL_DAY_TYPE, type CalendarEntryType } from '@/domain/constants';
import { CALENDAR_REFUSALS } from './calendar.messages';

/** An entry's timing refused field by field, each sentence in both languages (P18.10-T5 AC-3). */
const SAY = CALENDAR_REFUSALS.VALIDATION_FAILED;
const REQUIRED = VALIDATION_REFUSALS.VALIDATION_FAILED.required;

/**
 * **The calendar's clock, in the office's zone and nowhere else** (invariant §9; P12-T2 AC-3, P12-T3
 * AC-5; `functional/calendar.md`, *Time*).
 *
 * Pure: every function takes the zone, and none reads the process's clock or its `TZ`. Calendar
 * arithmetic on a `YYYY-MM-DD` is done with `local-day.ts`, which has no zone in it; a wall-clock time
 * becomes an instant, and an instant a wall-clock time, only through luxon with the office's zone named.
 * So the same request answers the same entries whether the server runs in UTC, Jakarta or New York.
 */

/**
 * What a read answers: a week (Monday to Sunday), a month padded to whole weeks, **the Agenda** — `CALENDAR.AGENDA_DAYS`
 * from the day asked for — or **3 Hari**, `CALENDAR.THREE_DAYS` from it (UI V1, 2026-10-30, UI-104 points 5 and 10).
 */
export const CALENDAR_VIEWS = ['week', 'month', 'agenda', 'three_days'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

/** One day of a period, and whether it is the period's own or a month's padding. */
export interface PeriodDay {
  date: LocalDate;
  inPeriod: boolean;
}

/** What a read answers about its period, before any entry. */
export interface Period {
  view: CalendarView;
  /** The first and last office dates drawn, inclusive: a week's Monday and Sunday, a month's padded rows. */
  from: LocalDate;
  to: LocalDate;
  /** `YYYY-MM` in Month, `null` in every other view. */
  month: string | null;
  days: PeriodDay[];
  /**
   * The `date` ‹ and › ask for: the Monday of the week before and after, the first of the month, or — in the Agenda and
   * 3 Hari — the day as many days before and after.
   */
  previous: LocalDate;
  next: LocalDate;
}

/** `HH:mm`, the office's wall clock. `00:00` as an end is midnight at the end of the date. */
const WALL_CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const MIDNIGHT = '00:00';
const MINUTES_PER_DAY = 1440;

/** Monday 0 … Sunday 6, for an office date. Weeks run Monday to Sunday (`metrics-and-definitions.md`). */
export function weekdayOf(date: LocalDate): number {
  const [y, m, d] = date.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** The Monday of the week `date` is in. */
export function mondayOf(date: LocalDate): LocalDate {
  return addDays(date, -weekdayOf(date));
}

/**
 * **The period a read answers**: the week holding `date`, Monday to Sunday; or the month holding it,
 * padded to whole weeks — from the Monday on or before the 1st to the Sunday on or after the last day,
 * four to six rows — with the padding's days marked as not the month's own.
 */
export function periodOf(view: CalendarView, date: LocalDate): Period {
  if (view === 'agenda' || view === 'three_days') {
    // From the day asked for, never its week's Monday: the Agenda opens on today with no past day (UI-104 point 10).
    const length = view === 'agenda' ? CALENDAR.AGENDA_DAYS : CALENDAR.THREE_DAYS;
    const to = addDays(date, length - 1);
    return {
      view, from: date, to, month: null,
      days: daysBetween(date, to).map((day) => ({ date: day, inPeriod: true })),
      previous: addDays(date, -length),
      next: addDays(date, length),
    };
  }
  if (view === 'week') {
    const from = mondayOf(date);
    const to = addDays(from, 6);
    return {
      view, from, to, month: null,
      days: daysBetween(from, to).map((day) => ({ date: day, inPeriod: true })),
      previous: addDays(from, -7),
      next: addDays(from, 7),
    };
  }
  const month = date.slice(0, 7);
  const first = `${month}-01`;
  const last = endOfMonth(first);
  const from = mondayOf(first);
  const to = addDays(mondayOf(last), 6);
  return {
    view, from, to, month,
    days: daysBetween(from, to).map((day) => ({ date: day, inPeriod: day.slice(0, 7) === month })),
    previous: `${addDays(first, -1).slice(0, 7)}-01`,
    next: addDays(last, 1),
  };
}

/**
 * An office date and wall-clock time as the instant it is. `24:00` is the next midnight. Set as a wall
 * clock rather than added to midnight, so a zone with a daylight-saving day reads 10:00 as 10:00.
 */
function instantOf(timezone: string, date: LocalDate, minutes: number): Date {
  const day = minutes === MINUTES_PER_DAY ? addDays(date, 1) : date;
  const [year, month, dayOfMonth] = day.split('-').map(Number);
  const minute = minutes % MINUTES_PER_DAY;
  return DateTime.fromObject(
    { year, month, day: dayOfMonth, hour: Math.floor(minute / 60), minute: minute % 60 },
    { zone: timezone },
  ).toUTC().toJSDate();
}

/** The office's midnight that begins `date`, as an instant. */
export function startOfOfficeDay(timezone: string, date: LocalDate): Date {
  return instantOf(timezone, date, 0);
}

/** `HH:mm` as minutes since midnight. */
function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** The office's wall clock for an instant: its date, its `HH:mm`, and its minute of the day (0 to 1439). */
export function officeClockOf(timezone: string, at: Date): { date: LocalDate; time: string; minute: number } {
  const local = DateTime.fromJSDate(at, { zone: 'utc' }).setZone(timezone);
  return { date: local.toFormat('yyyy-MM-dd'), time: local.toFormat('HH:mm'), minute: local.hour * 60 + local.minute };
}

/** An entry's timing as a request states it: a timed entry's date and times, or Travel's two dates. */
export interface TimingInput {
  /**
   * **Travel only** (UI V1, UI-104 point 8, *Sepanjang hari*): `true` or absent, the trip's two office dates; `false`,
   * a start date and time and an end date and time. A timed type is never all-day, and saying so is refused.
   */
  allDay?: boolean | null;
  date?: string | null;
  start?: string | null;
  end?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
}

/** An entry's timing as it is stored. */
export interface StoredTiming {
  /** An all-day trip; `false` on a timed trip and on every other type. */
  allDay: boolean;
  startsAt: Date;
  endsAt: Date;
  startsOn: LocalDate | null;
  endsOn: LocalDate | null;
}

const TIMED_FIELDS = ['date', 'start', 'end'] as const;
const TRAVEL_FIELDS = ['startsOn', 'endsOn'] as const;
/** A trip with times (UI-104 point 8): its two dates, and a time on each. */
const TIMED_TRIP_FIELDS = ['startsOn', 'start', 'endsOn', 'end'] as const;
const ALL_TIMING_FIELDS = ['date', 'start', 'end', 'startsOn', 'endsOn'] as const;

/** Whether a stored or requested trip is all-day: only `false` makes it timed, so a row older than the field is all-day. */
export function isAllDayTrip(entry: { type: CalendarEntryType; allDay?: boolean | null }): boolean {
  return entry.type === CALENDAR_ALL_DAY_TYPE && entry.allDay !== false;
}

/**
 * **An entry's timing, checked and converted** (P12-T2 AC-5; `functional/calendar.md`, *Its fields*):
 * the stored instants, or every rule it breaks, each naming its field.
 *
 * - A timed type takes `date`, `start` and `end`, all three: `end` after `start` on that date, an `end`
 *   of `00:00` being midnight at the end of the date — so nothing but Travel crosses midnight, and a drag
 *   to the grid's foot is `00:00`, never `24:00`.
 * - Travel takes `startsOn` and `endsOn`: on or after it, at most `CALENDAR.TRAVEL_DAYS_MAX` days
 *   inclusive. Its instants are the office's midnight before `startsOn` and after `endsOn`.
 * - The other type's fields are refused rather than ignored: a request that sends both did not mean one.
 */
export function timingOf(
  type: CalendarEntryType, input: TimingInput, timezone: string,
): { timing: StoredTiming } | { violations: FieldSentence[] } {
  const violations: FieldSentence[] = [];
  const travel = type === CALENDAR_ALL_DAY_TYPE;
  const allDay = travel && input.allDay !== false;
  if (!travel && input.allDay === true) violations.push(SAY.notPartOf({ field: 'allDay', travel: false }));
  const own: readonly (keyof TimingInput)[] = allDay ? TRAVEL_FIELDS : travel ? TIMED_TRIP_FIELDS : TIMED_FIELDS;
  for (const field of ALL_TIMING_FIELDS) {
    if (own.includes(field)) continue;
    if (input[field] !== undefined && input[field] !== null) {
      violations.push(SAY.notPartOf({ field, travel }));
    }
  }
  for (const field of own) {
    if (input[field] === undefined || input[field] === null) violations.push(REQUIRED({ field }));
  }
  if (violations.length) return { violations };

  if (travel) {
    const startsOn = input.startsOn as string;
    const endsOn = input.endsOn as string;
    if (!isLocalDate(startsOn)) violations.push(SAY.dayShape({ field: 'startsOn' }));
    if (!isLocalDate(endsOn)) violations.push(SAY.dayShape({ field: 'endsOn' }));
    if (!allDay) {
      if (!WALL_CLOCK.test(input.start as string)) violations.push(SAY.timeShape({ field: 'start' }));
      if (!WALL_CLOCK.test(input.end as string)) violations.push(SAY.timeShape({ field: 'end' }));
    }
    if (violations.length) return { violations };
    if (endsOn < startsOn) return { violations: [SAY.endsBeforeStarts] };
    if (daysBetween(startsOn, endsOn).length > CALENDAR.TRAVEL_DAYS_MAX) {
      return { violations: [SAY.tripTooLong({ max: CALENDAR.TRAVEL_DAYS_MAX })] };
    }
    if (allDay) {
      return {
        timing: {
          allDay: true,
          startsAt: startOfOfficeDay(timezone, startsOn),
          endsAt: startOfOfficeDay(timezone, addDays(endsOn, 1)),
          startsOn,
          endsOn,
        },
      };
    }
    // A timed trip: the office's wall clock on each of its two dates, the end after the start.
    const startsAt = instantOf(timezone, startsOn, minutesOf(input.start as string));
    const endsAt = instantOf(timezone, endsOn, minutesOf(input.end as string));
    if (endsAt <= startsAt) return { violations: [SAY.tripEndBeforeStart] };
    return { timing: { allDay: false, startsAt, endsAt, startsOn, endsOn } };
  }

  const date = input.date as string;
  const start = input.start as string;
  const end = input.end as string;
  if (!isLocalDate(date)) violations.push(SAY.dayShape({ field: 'date' }));
  if (!WALL_CLOCK.test(start)) violations.push(SAY.timeShape({ field: 'start' }));
  if (!WALL_CLOCK.test(end)) violations.push(SAY.timeShape({ field: 'end' }));
  if (violations.length) return { violations };
  const from = minutesOf(start);
  const to = end === MIDNIGHT ? MINUTES_PER_DAY : minutesOf(end);
  if (to <= from) return { violations: [SAY.endBeforeStart] };
  return {
    timing: {
      allDay: false,
      startsAt: instantOf(timezone, date, from),
      endsAt: instantOf(timezone, date, to),
      startsOn: null,
      endsOn: null,
    },
  };
}

/** An entry's timing as a reader is answered it, in the office's dates and wall clock. */
export interface OfficeTiming {
  allDay: boolean;
  date: LocalDate | null;
  start: string | null;
  end: string | null;
  startsOn: LocalDate | null;
  endsOn: LocalDate | null;
}

/**
 * **A stored entry, read back in the office's terms**: Travel's two dates, or a timed entry's date and
 * `HH:mm` times, an end at the next midnight answered `00:00`.
 */
export function officeTimingOf(
  entry: {
    type: CalendarEntryType; allDay?: boolean | null; startsAt: Date; endsAt: Date; startsOn: string | null; endsOn: string | null;
  },
  timezone: string,
): OfficeTiming {
  if (isAllDayTrip(entry)) {
    return { allDay: true, date: null, start: null, end: null, startsOn: entry.startsOn, endsOn: entry.endsOn };
  }
  const start = officeClockOf(timezone, entry.startsAt);
  const end = officeClockOf(timezone, entry.endsAt);
  // A timed trip (UI-104 point 8) keeps its two dates beside its date and times: it may run over several days.
  if (entry.type === CALENDAR_ALL_DAY_TYPE) {
    return { allDay: false, date: start.date, start: start.time, end: end.time, startsOn: entry.startsOn, endsOn: entry.endsOn };
  }
  return { allDay: false, date: start.date, start: start.time, end: end.time, startsOn: null, endsOn: null };
}

/** The office date a notice names for an entry: a timed entry's date, Travel's departure. */
export function officeDateOf(
  entry: { type: CalendarEntryType; startsAt: Date; startsOn: string | null },
  timezone: string,
): LocalDate {
  return entry.type === CALENDAR_ALL_DAY_TYPE ? (entry.startsOn as LocalDate) : officeClockOf(timezone, entry.startsAt).date;
}
