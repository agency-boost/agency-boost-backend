import { EVENT_ATTENDANCE_STATUSES } from '@/domain/constants';
import { eventAttendanceRate, eventAttendanceStatus, type AttendanceFacts } from './event-attendance';

const facts = (over: Partial<AttendanceFacts> = {}): AttendanceFacts => ({
  ended: true, rsvp: null, claimed: false, confirmed: null, ...over,
});

describe('EVENT_ATTENDANCE_STATUS (P18.5-T5 AC-8; OD-31, D-status)', () => {
  it('P18.5-T5 AC-8 has the five values, unconfirmed among them (D-status)', () => {
    expect(EVENT_ATTENDANCE_STATUSES).toEqual(['attended', 'registered', 'unconfirmed', 'no_show', 'not_registered']);
  });

  describe('P18.5-T5 AC-6 a claim is not attendance — exit test 2', () => {
    it.each([
      ['an RSVP', { rsvp: 'going' as const }],
      ['a claim', { claimed: true }],
      ['both together', { rsvp: 'going' as const, claimed: true }],
      ['a cancelled RSVP and a claim', { rsvp: 'cancelled' as const, claimed: true }],
    ])('P18.5-T5 AC-6 %s never yields attended, before or after the end', (_name, over) => {
      expect(eventAttendanceStatus(facts({ ...over, ended: true }))).not.toBe('attended');
      expect(eventAttendanceStatus(facts({ ...over, ended: false }))).not.toBe('attended');
    });

    it('P18.5-T5 AC-6 only a confirmation makes attended', () => {
      expect(eventAttendanceStatus(facts({ confirmed: true }))).toBe('attended');
      expect(eventAttendanceStatus(facts({ rsvp: 'going', claimed: true, confirmed: true }))).toBe('attended');
    });
  });

  it('P18.5-T5 AC-8 before the end: an RSVP is registered, anything else not registered', () => {
    expect(eventAttendanceStatus(facts({ ended: false, rsvp: 'going' }))).toBe('registered');
    expect(eventAttendanceStatus(facts({ ended: false, rsvp: 'cancelled' }))).toBe('not_registered');
    expect(eventAttendanceStatus(facts({ ended: false }))).toBe('not_registered');
  });

  it('P18.5-T5 AC-8 after the end, said but unmarked is unconfirmed, never no_show (D-status)', () => {
    expect(eventAttendanceStatus(facts({ rsvp: 'going' }))).toBe('unconfirmed');
    expect(eventAttendanceStatus(facts({ claimed: true }))).toBe('unconfirmed');
    expect(eventAttendanceStatus(facts({ rsvp: 'cancelled' }))).toBe('not_registered');
    expect(eventAttendanceStatus(facts())).toBe('not_registered');
  });

  it('P18.5-T5 AC-8 no_show only once a confirmer marks them absent', () => {
    expect(eventAttendanceStatus(facts({ rsvp: 'going', confirmed: false }))).toBe('no_show');
    expect(eventAttendanceStatus(facts({ confirmed: false }))).toBe('no_show');
  });
});

describe('EVENT_ATTENDANCE_RATE (P18.5-T5 AC-8)', () => {
  it('P18.5-T5 AC-8 2 of 5 is 40%', () => {
    expect(eventAttendanceRate(['attended', 'attended', 'unconfirmed', 'no_show', 'not_registered'], true)).toBe(40);
  });

  it('P18.5-T5 AC-8 is null before the end, and for an empty audience', () => {
    expect(eventAttendanceRate(['attended'], false)).toBeNull();
    expect(eventAttendanceRate([], true)).toBeNull();
  });

  it('P18.5-T5 AC-8 rounds once, over whole numbers: 201 of 400 is 50.3 (the float quotient read 50.2), 1 of 8 is 12.5', () => {
    const of = (attended: number, n: number) =>
      [...Array<'attended'>(attended).fill('attended'), ...Array<'no_show'>(n - attended).fill('no_show')];
    expect(eventAttendanceRate(of(201, 400), true)).toBe(50.3);
    expect(eventAttendanceRate(of(1, 8), true)).toBe(12.5);
    expect(eventAttendanceRate(of(2, 3), true)).toBe(66.7);
  });

  it('P18.5-T5 AC-8 reads one decimal: 1 of 3 is 33.3%, nobody is 0', () => {
    expect(eventAttendanceRate(['attended', 'no_show', 'unconfirmed'], true)).toBe(33.3);
    expect(eventAttendanceRate(['no_show', 'unconfirmed'], true)).toBe(0);
  });
});
