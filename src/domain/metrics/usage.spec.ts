import { SUBGROUP } from '@/domain/constants/advanced-analytics';
import { USAGE, USAGE_STATUSES } from '@/domain/constants/usage';
import { daysFrom, powerUserWindow, usageOf, usageStatus, usedCount } from './usage';

const TODAY = '2026-11-20';

/**
 * **One person's use of AgencyBoost** (P19.17-T1 AC-4; ADR-0267 §4; `metrics-and-definitions.md` §A.20, §B.42):
 * *Pakai*, *Pernah pakai*, *Pakai 14 hari terakhir*, *Power user ★* and the bucket a page draws — every number pinned.
 */
describe('usage per person (P19.17-T1 AC-4, ADR-0267 §4)', () => {
  it('pins every number: 14 days, 10 of the last 30, and the three buckets in the pages’ order', () => {
    expect(USAGE).toEqual({ RECENT_MAX_DAYS: 14, POWER_USER_MIN_DAYS: 10, POWER_USER_WINDOW_DAYS: 30 });
    expect(USAGE_STATUSES).toEqual(['never', 'lapsed', 'recent']);
  });

  it('keeps one source: Advanced analytics’ template defaults start from these two (invariant §7)', () => {
    expect(SUBGROUP.POWER_USER_DAYS_DEFAULT).toBe(USAGE.POWER_USER_MIN_DAYS);
    expect(SUBGROUP.POWER_USER_WINDOW_DAYS_DEFAULT).toBe(USAGE.POWER_USER_WINDOW_DAYS);
  });

  it('counts whole calendar days between office dates, across a month and a year', () => {
    expect(daysFrom(TODAY, TODAY)).toBe(0);
    expect(daysFrom('2026-11-06', TODAY)).toBe(14);
    expect(daysFrom('2026-10-31', '2026-11-01')).toBe(1);
    expect(daysFrom('2025-12-31', '2026-01-01')).toBe(1);
    expect(daysFrom('2024-02-28', '2024-03-01')).toBe(2);
  });

  it('reads the power-user window as the last 30 office days, today included', () => {
    expect(powerUserWindow(TODAY)).toEqual({ from: '2026-10-22', to: TODAY });
    expect(daysFrom(powerUserWindow(TODAY).from, TODAY) + 1).toBe(USAGE.POWER_USER_WINDOW_DAYS);
  });

  it('buckets by the days since the latest day logged: never, ≤ 14 recent, > 14 lapsed', () => {
    expect(usageStatus(null)).toBe('never');
    expect(usageStatus(0)).toBe('recent');
    expect(usageStatus(14)).toBe('recent');
    expect(usageStatus(15)).toBe('lapsed');
    expect(usageStatus(400)).toBe('lapsed');
  });

  it('reads somebody who never logged as Belum pernah: no day, no use, no power user', () => {
    expect(usageOf({ lastLoggedOn: null, daysLoggedLast30: 0 }, TODAY)).toEqual({
      lastLoggedOn: null, everLogged: false, daysSinceLastLogged: null, usedLast14Days: false,
      daysLoggedLast30: 0, powerUser: false, status: 'never', usedInPeriod: null,
    });
  });

  it('reads the 14th day back as within, and the 15th as > 14 hari', () => {
    expect(usageOf({ lastLoggedOn: '2026-11-06', daysLoggedLast30: 1 }, TODAY)).toMatchObject({
      everLogged: true, daysSinceLastLogged: 14, usedLast14Days: true, status: 'recent',
    });
    expect(usageOf({ lastLoggedOn: '2026-11-05', daysLoggedLast30: 1 }, TODAY)).toMatchObject({
      everLogged: true, daysSinceLastLogged: 15, usedLast14Days: false, status: 'lapsed',
    });
  });

  it('makes a power user at 10 days of the last 30, not at 9', () => {
    expect(usageOf({ lastLoggedOn: TODAY, daysLoggedLast30: 10 }, TODAY).powerUser).toBe(true);
    expect(usageOf({ lastLoggedOn: TODAY, daysLoggedLast30: 9 }, TODAY).powerUser).toBe(false);
  });

  it('answers Pakai only for a period asked about', () => {
    expect(usageOf({ lastLoggedOn: TODAY, daysLoggedLast30: 1, loggedInPeriod: true }, TODAY).usedInPeriod).toBe(true);
    expect(usageOf({ lastLoggedOn: TODAY, daysLoggedLast30: 1, loggedInPeriod: false }, TODAY).usedInPeriod).toBe(false);
    expect(usageOf({ lastLoggedOn: TODAY, daysLoggedLast30: 1 }, TODAY).usedInPeriod).toBeNull();
  });

  it('reads a latest day after today — a clock moved back — as today', () => {
    expect(usageOf({ lastLoggedOn: '2026-11-21', daysLoggedLast30: 1 }, TODAY)).toMatchObject({
      daysSinceLastLogged: 0, status: 'recent',
    });
  });

  it('counts Pakai over the people read', () => {
    const read = (used: boolean | null) => usageOf({ lastLoggedOn: TODAY, daysLoggedLast30: 1, loggedInPeriod: used }, TODAY);
    expect(usedCount([read(true), read(false), read(true), read(null)])).toBe(2);
    expect(usedCount([])).toBe(0);
  });
});
