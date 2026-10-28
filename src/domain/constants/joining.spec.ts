import { INVITES, JOINED_AS, JOINING, REGISTRATION, joinDateViolation, joinedAsFor } from './index';

/**
 * Who a join date makes somebody (ADR-0169, P18.96-T2), pinned so a change fails here before it reaches an approval,
 * a tag, a leader's code or the migration. Documented once in `docs/00-product/metrics-and-definitions.md`.
 */
describe('the join date and its classification (ADR-0169)', () => {
  it('P18.96-T2 AC-1 pins a new hire at 90 days back at most, and the earliest join date at 1980', () => {
    expect(JOINING.NEW_HIRE_MAX_DAYS_BACK).toBe(90);
    expect(JOINING.EARLIEST_JOIN_DATE).toBe('1980-01-01');
    expect([...JOINED_AS]).toEqual(['new_hire', 'existing_agent']);
  });

  it('P18.96-T2 AC-1 classifies 90 days back as a new hire and 91 as an existing agent', () => {
    const today = '2026-10-27';
    expect(joinedAsFor('2026-10-27', today)).toBe('new_hire');
    expect(joinedAsFor('2026-07-29', today)).toBe('new_hire'); // 90 days before
    expect(joinedAsFor('2026-07-28', today)).toBe('existing_agent'); // 91 days before
    expect(joinedAsFor('2015-03-01', today)).toBe('existing_agent');
  });

  it('P18.96-T2 AC-1 counts across a month and a leap day by the calendar, not by milliseconds', () => {
    // 2028 is a leap year: 90 days before 2028-05-29 is 2028-02-29.
    expect(joinedAsFor('2028-02-29', '2028-05-29')).toBe('new_hire');
    expect(joinedAsFor('2028-02-28', '2028-05-29')).toBe('existing_agent');
  });

  it('P18.96-T2 AC-1 takes a real day up to today, refuses a future day, a non-day and one before 1980', () => {
    const today = '2026-10-27';
    expect(joinDateViolation('2026-10-27', today)).toBeNull();
    expect(joinDateViolation('1980-01-01', today)).toBeNull();
    expect(joinDateViolation('2004-06-15', today)).toBeNull();
    expect(joinDateViolation('2026-10-28', today)).toBe('joinDate cannot be after today.');
    expect(joinDateViolation('1979-12-31', today)).toBe('joinDate cannot be before 1980.');
    for (const no of ['2026-02-30', '27/10/2026', '', 20261027, null]) {
      expect(joinDateViolation(no, today)).toBe('joinDate must be a real date, written YYYY-MM-DD.');
    }
  });
});

describe('sign-ups from one address (the P18.96 exit review)', () => {
  it('P18.96-T8 L2 pins twenty sign-ups an hour per client address', () => {
    expect(REGISTRATION).toEqual({ MAX_PER_ADDRESS: 20, WINDOW_SECONDS: 3600 });
  });
});

describe('an invite (ADR-0170 §2)', () => {
  it('P18.96-T3 AC-2 pins an invite’s 14 days and the name’s 120 characters', () => {
    expect(INVITES.EXPIRY_DAYS).toBe(14);
    expect(INVITES.NAME_MAX).toBe(120);
  });
});
