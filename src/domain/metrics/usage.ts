import { addDays, type LocalDate } from '@/common/time/local-day';
import { USAGE, type UsageStatus } from '@/domain/constants/usage';

/**
 * **One person's use of AgencyBoost** (`APP_USE_IN_PERIOD`, `APP_EVER_USED`, `APP_USED_LAST_14D`, `POWER_USER`;
 * `metrics-and-definitions.md` §A.20; ADR-0267 §4). Pure: the reading behind it is `ActivityReadings.usageOf`.
 *
 * **One fact, the family's own** (ADR-0042, ADR-0200 §3): a day counts as *logged* when the person saved an entry for
 * it, an all-zero day included — *did this person report* — exactly as *Pengguna aktif* and `POWER_USER_COUNT` read it.
 * Every day is an **office day** (`YYYY-MM-DD` in `kpms.timezone`, invariant §9): the caller passes the office's today
 * from `TenantDay`, never the server's.
 */
export interface UsageReading {
  /** The latest office day the person saved, ever; `null`: never. */
  lastLoggedOn: LocalDate | null;
  /** *Pernah pakai*: at least one day saved, ever. */
  everLogged: boolean;
  /** Whole days from `lastLoggedOn` to today (today is 0); `null` with none. */
  daysSinceLastLogged: number | null;
  /** *Pakai 14 hari terakhir*: `daysSinceLastLogged ≤ USAGE.RECENT_MAX_DAYS`. */
  usedLast14Days: boolean;
  /** Days saved in the last `USAGE.POWER_USER_WINDOW_DAYS`, today included. */
  daysLoggedLast30: number;
  /** *Power user ★*: `daysLoggedLast30 ≥ USAGE.POWER_USER_MIN_DAYS`. */
  powerUser: boolean;
  /** `never` *Belum pernah* · `lapsed` *> 14 hari* · `recent` *≤ 14 hari*. */
  status: UsageStatus;
  /** *Pakai*: at least one day saved in the period asked about; `null` when no period was asked about. */
  usedInPeriod: boolean | null;
}

/** Whole calendar days from `from` to `to` — office dates, so no zone moves them (`local-day.ts`, UTC arithmetic). */
export function daysFrom(from: LocalDate, to: LocalDate): number {
  const at = (d: LocalDate) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((at(to) - at(from)) / 86_400_000);
}

/** The last `USAGE.POWER_USER_WINDOW_DAYS` office days, today included: the window *Power user* counts over. */
export function powerUserWindow(today: LocalDate): { from: LocalDate; to: LocalDate } {
  return { from: addDays(today, -(USAGE.POWER_USER_WINDOW_DAYS - 1)), to: today };
}

/** The usage bucket from the days since the latest day logged: `null` is *Belum pernah*. */
export function usageStatus(daysSinceLastLogged: number | null): UsageStatus {
  if (daysSinceLastLogged === null) return 'never';
  return daysSinceLastLogged <= USAGE.RECENT_MAX_DAYS ? 'recent' : 'lapsed';
}

/**
 * **A person's usage, from three facts read once**: the latest day ever saved, how many of the power-user window's days
 * were saved, and — for *Pakai* — whether any day of the period was. A latest day after today (a clock that moved back)
 * reads as today.
 */
export function usageOf(
  facts: { lastLoggedOn: LocalDate | null; daysLoggedLast30: number; loggedInPeriod?: boolean | null },
  today: LocalDate,
): UsageReading {
  const last = facts.lastLoggedOn;
  const days = last === null ? null : Math.max(0, daysFrom(last, today));
  return {
    lastLoggedOn: last,
    everLogged: last !== null,
    daysSinceLastLogged: days,
    usedLast14Days: days !== null && days <= USAGE.RECENT_MAX_DAYS,
    daysLoggedLast30: facts.daysLoggedLast30,
    powerUser: facts.daysLoggedLast30 >= USAGE.POWER_USER_MIN_DAYS,
    status: usageStatus(days),
    usedInPeriod: facts.loggedInPeriod ?? null,
  };
}

/** *Pakai* as a count: of the people given, how many used the app in the period (`usedInPeriod`). */
export function usedCount(readings: Iterable<UsageReading>): number {
  let n = 0;
  for (const r of readings) if (r.usedInPeriod === true) n += 1;
  return n;
}
