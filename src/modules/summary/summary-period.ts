import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Sentence } from '@/common/i18n/sentence';
import { endOfMonth, type LocalDate } from '@/common/time/local-day';
import { SUMMARY_REFUSALS } from './summary.messages';

/** What a reader asked for: a month, a year, or neither — the office's current month (P18.5-T11). */
export interface SummaryPeriodQuery {
  /** `YYYY-MM`. */
  month?: string;
  /** `YYYY`. */
  year?: string;
}

/** The office's calendar as `TenantDay.calendar` answers it: today, this month, and the month it opened. */
export interface OfficeCalendar {
  today: LocalDate;
  /** `YYYY-MM`. */
  month: string;
  /** `YYYY-MM`, never after `month`. */
  firstMonth: string;
}

/**
 * **The period a Summary is for** (P18.5-T11, ADR-0161 §4, amending ADR-0056's *this month and this year only*).
 *
 * One month and its year, always — the payload carries both views, *Monthly* and *Yearly*:
 *
 * - **`?month=YYYY-MM`** is that month, and its year;
 * - **`?year=YYYY`** is that year, and its last month — **December** for a year that has ended, this month for
 *   this year;
 * - **neither** is this month, and this year, as before.
 *
 * **A closed period is read whole** — the month to its last day, the year to 31 December — so it shows its final
 * figures. **The current one runs to today**, as it always has. Every boundary is the office's calendar day
 * (invariant §9): `today` and the first month arrive already in its zone.
 */
export interface SummaryPeriod {
  /** `YYYY-MM`: the month *Monthly* is about, whose own APE and whose fixed target it measures. */
  month: string;
  /** `YYYY`: the year *Yearly* is about, and the goal's period. */
  year: string;
  /** The days *Monthly*'s activity counts: the whole month, or the month to today. */
  monthWindow: { from: LocalDate; to: LocalDate };
  /** The days *Yearly*'s activity counts: 1 January to 31 December, or to today. */
  yearWindow: { from: LocalDate; to: LocalDate };
  /** `month` is the office's current month: the pace is said, and the gap. */
  currentMonth: boolean;
  /** `year` is the office's current year. */
  currentYear: boolean;
}

/**
 * **Resolve and check a reader's period** against the office's calendar. Refused `400 VALIDATION_FAILED`, with
 * `details.field` naming what was wrong and `earliest` / `latest` the range there is:
 *
 * - **both** a month and a year — one period at a time;
 * - **the future** — a month after this one, a year after this one;
 * - **before the office** — a month before its first month, a year before its first month's year.
 *
 * The shapes (`YYYY-MM`, `YYYY`) are the DTO's to refuse; this decides what they may name.
 */
export function summaryPeriod(office: OfficeCalendar, asked: SummaryPeriodQuery = {}): SummaryPeriod {
  const thisMonth = office.month;
  const thisYear = thisMonth.slice(0, 4);
  const firstMonth = office.firstMonth < thisMonth ? office.firstMonth : thisMonth;
  const firstYear = firstMonth.slice(0, 4);

  // The words name no office (ADR-0084): a coachee's *Personal Summary* tab shows a refusal as its banner. In both
  // languages, a month in the reader's figures (P18.10-T5 AC-2).
  const SAY = SUMMARY_REFUSALS.VALIDATION_FAILED;
  const refuse = (field: 'month' | 'year', message: Sentence<'VALIDATION_FAILED'>): never => {
    throw new DomainException(ErrorCode.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, {
      field,
      earliest: field === 'year' ? firstYear : firstMonth,
      latest: field === 'year' ? thisYear : thisMonth,
    });
  };

  let month = thisMonth;
  if (asked.month !== undefined && asked.year !== undefined) {
    refuse('year', SAY.monthOrYear);
  } else if (asked.year !== undefined) {
    if (asked.year > thisYear) refuse('year', SAY.yearNotBegun({ year: asked.year, latest: thisYear }));
    if (asked.year < firstYear) refuse('year', SAY.yearBeforeFirst({ year: asked.year, first: firstYear }));
    month = asked.year === thisYear ? thisMonth : `${asked.year}-12`;
  } else if (asked.month !== undefined) {
    if (asked.month > thisMonth) refuse('month', SAY.monthNotBegun({ month: asked.month, latest: thisMonth }));
    if (asked.month < firstMonth) refuse('month', SAY.monthBeforeFirst({ month: asked.month, first: firstMonth }));
    month = asked.month;
  }

  const year = month.slice(0, 4);
  const currentMonth = month === thisMonth;
  const currentYear = year === thisYear;
  return {
    month,
    year,
    monthWindow: { from: `${month}-01`, to: currentMonth ? office.today : endOfMonth(`${month}-01`) },
    yearWindow: { from: `${year}-01-01`, to: currentYear ? office.today : `${year}-12-31` },
    currentMonth,
    currentYear,
  };
}
