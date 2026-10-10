import { activityComplianceRate, activityLogged, lastMonthToSameDay, loggedWithin } from './activity-logged';

describe('ACTIVITY_LOGGED_THIS_MONTH and ACTIVITY_COMPLIANCE_RATE over the office (OD-142, D-figures)', () => {
  const latest = new Map([['a', '2026-10-08'], ['b', '2026-09-30'], ['c', '2026-10-01']]);

  it('P18-T1 AC-4 a member logged in a window when their latest day on or before its end falls inside it', () => {
    const window = { from: '2026-10-01', to: '2026-10-09' };
    expect(loggedWithin('2026-10-01', window)).toBe(true);
    expect(loggedWithin('2026-09-30', window)).toBe(false);
    expect(loggedWithin('2026-10-10', window)).toBe(false);
    expect(loggedWithin(null, window)).toBe(false);
    expect(loggedWithin(undefined, window)).toBe(false);
  });

  it('P18-T1 AC-4 counts this month’s loggers over everybody, a never-logged member in the denominator', () => {
    expect(activityLogged(['a', 'b', 'c', 'never'], latest, { from: '2026-10-01', to: '2026-10-09' }))
      .toEqual({ count: 2, of: 4, pct: 50 });
    expect(activityLogged([], latest, { from: '2026-10-01', to: '2026-10-09' })).toEqual({ count: 0, of: 0, pct: null });
  });

  it('P18-T1 AC-4 the week card: logged, not logged, and the share', () => {
    expect(activityComplianceRate(['a', 'b', 'c', 'never'], latest, { from: '2026-10-03', to: '2026-10-09' }))
      .toEqual({ logged: 1, notLogged: 3, pct: 25 });
  });

  it('P18-T1 AC-4 the trend compares last month to the same day, never a whole month against part of one', () => {
    expect(lastMonthToSameDay('2026-10-09')).toEqual({ from: '2026-09-01', to: '2026-09-09' });
    // Last month shorter: its last day.
    expect(lastMonthToSameDay('2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(lastMonthToSameDay('2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-15' });
  });
});
