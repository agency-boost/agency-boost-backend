import { DateTime } from 'luxon';

/**
 * Time is injected, never read from the ambient environment.
 *
 * Two reasons, both learned from the prototype:
 *  1. `new Date()` in a service is untestable — you cannot exercise a month boundary.
 *  2. The prototype generates date keys with `toISOString()`, which is UTC. For a
 *     Jakarta user before 07:00 that is *yesterday*. Every "today" in the app was
 *     wrong for seven hours a day (prototype-parity F-01).
 *
 * A calendar day belongs to the tenant, not the server. `localDateFor` is the only
 * sanctioned way to turn an instant into a date key.
 */
export abstract class Clock {
  /** The current instant, in UTC. */
  abstract now(): Date;

  /** `YYYY-MM-DD` for the given instant in the tenant's zone. Defaults to now. */
  localDateFor(timezone: string, at?: Date): string {
    return DateTime.fromJSDate(at ?? this.now(), { zone: 'utc' })
      .setZone(timezone)
      .toFormat('yyyy-MM-dd');
  }

  /** Inclusive start of the tenant-local calendar day, as a UTC instant. */
  startOfLocalDay(timezone: string, localDate: string): Date {
    return DateTime.fromFormat(localDate, 'yyyy-MM-dd', { zone: timezone })
      .startOf('day')
      .toUTC()
      .toJSDate();
  }

  /** Exclusive end of the tenant-local calendar day, as a UTC instant. */
  endOfLocalDay(timezone: string, localDate: string): Date {
    return DateTime.fromFormat(localDate, 'yyyy-MM-dd', { zone: timezone })
      .plus({ days: 1 })
      .startOf('day')
      .toUTC()
      .toJSDate();
  }

  /**
   * Calendar month bounds in the tenant zone, as UTC instants. `month` is `YYYY-MM`.
   * Used wherever the product says "this month" — which is a *calendar* month, never
   * a rolling 30 days. The prototype conflates the two (OD-11).
   */
  monthBounds(timezone: string, month: string): { start: Date; endExclusive: Date } {
    const first = DateTime.fromFormat(month, 'yyyy-MM', { zone: timezone }).startOf('month');
    return {
      start: first.toUTC().toJSDate(),
      endExclusive: first.plus({ months: 1 }).toUTC().toJSDate(),
    };
  }

  /** Monday-based week bounds in the tenant zone, as UTC instants. */
  weekBounds(timezone: string, at?: Date): { start: Date; endExclusive: Date } {
    const local = DateTime.fromJSDate(at ?? this.now(), { zone: 'utc' }).setZone(timezone);
    const monday = local.startOf('week');
    return {
      start: monday.toUTC().toJSDate(),
      endExclusive: monday.plus({ weeks: 1 }).toUTC().toJSDate(),
    };
  }

  /**
   * Whole days between two tenant-local dates. Used by the activation day counter and
   * the lead overdue flag, both of which the prototype computes by dividing epoch
   * milliseconds — which is off by one across a DST boundary.
   */
  daysBetween(timezone: string, fromLocalDate: string, toLocalDate: string): number {
    const a = DateTime.fromFormat(fromLocalDate, 'yyyy-MM-dd', { zone: timezone }).startOf('day');
    const b = DateTime.fromFormat(toLocalDate, 'yyyy-MM-dd', { zone: timezone }).startOf('day');
    return Math.round(b.diff(a, 'days').days);
  }
}

/** Production implementation. The only place the ambient clock is read. */
export class SystemClock extends Clock {
  now(): Date {
    // This is the sanctioned boundary the lint rule exists to funnel everything
    // through: every other caller injects Clock, and here the real clock is finally
    // read — exactly once, in one place.
    // eslint-disable-next-line no-restricted-syntax
    return new Date();
  }
}

/** Test implementation. Time only moves when a test moves it. */
export class FixedClock extends Clock {
  constructor(private current: Date) {
    super();
  }
  now(): Date {
    return this.current;
  }
  set(at: Date): void {
    this.current = at;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
