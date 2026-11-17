import { daysBetween, endingSoon, inForceOn, nextScheduled, statusOf, type VersionFacts } from './rate-table-status';

const ON = new Date('2026-11-01T00:00:00Z');
const v = (id: string, version: number, effectiveFrom: string, over: Partial<VersionFacts> = {}): VersionFacts => ({
  id, version, effectiveFrom, effectiveTo: null, activatedAt: ON, turnedOffAt: null, deletedAt: null, ...over,
});

describe('P19.15-T1 AC-3 a version’s state, worked out on every read (ADR-0258 §2)', () => {
  const april = v('a', 1, '2026-04-01');
  const december = v('b', 2, '2026-12-01');
  const all = [april, december];

  it('the version in force today is the latest Berlaku mulai on or before it', () => {
    expect(inForceOn(all, '2026-11-12')?.id).toBe('a');
    expect(inForceOn(all, '2026-12-01')?.id).toBe('b');
    expect(inForceOn(all, '2026-03-31')).toBeNull();
  });

  it('P19.15-T1 AC-3 a scheduled version is in force from 00:00 on its date, with no job', () => {
    expect(statusOf(december, '2026-11-30', all)).toBe('scheduled');
    expect(statusOf(december, '2026-12-01', all)).toBe('active');
    expect(statusOf(april, '2026-12-01', all)).toBe('old');
  });

  it('draft, off, past its Berlaku sampai', () => {
    expect(statusOf(v('c', 3, '2026-01-01', { activatedAt: null }), '2026-11-12', all)).toBe('draft');
    expect(statusOf(v('d', 4, '2026-01-01', { turnedOffAt: ON }), '2026-11-12', all)).toBe('off');
    const ended = v('e', 5, '2026-01-01', { effectiveTo: '2026-06-30' });
    expect(statusOf(ended, '2026-11-12', [ended])).toBe('old');
    expect(statusOf(ended, '2026-06-30', [ended])).toBe('active');
  });

  it('turning the newest off brings back the one before it, where its dates still cover the day (P1b Undo)', () => {
    const off = { ...december, turnedOffAt: ON };
    expect(inForceOn([april, off], '2026-12-05')?.id).toBe('a');
    expect(inForceOn([{ ...april, effectiveTo: '2026-11-30' }, off], '2026-12-05')).toBeNull();
    expect(inForceOn([{ ...april, deletedAt: ON }], '2026-12-05')).toBeNull();
  });

  it('two versions of one day: the higher version', () => {
    expect(inForceOn([v('x', 1, '2026-04-01'), v('y', 2, '2026-04-01'), v('z', 3, '2026-04-01', { activatedAt: null })], '2026-05-01')?.id).toBe('y');
    expect(inForceOn([v('y', 2, '2026-04-01'), v('x', 1, '2026-04-01')], '2026-05-01')?.id).toBe('y');
  });

  it('the next scheduled one: the earliest after today, not off, not deleted', () => {
    const later = v('f', 6, '2027-01-01');
    expect(nextScheduled([april, later, december], '2026-11-12')?.id).toBe('b');
    expect(nextScheduled([april, { ...december, turnedOffAt: ON }, { ...later, deletedAt: ON }], '2026-11-12')).toBeNull();
    expect(nextScheduled([v('g', 7, '2027-01-01'), v('h', 8, '2027-01-01')], '2026-11-12')?.id).toBe('g');
    expect(nextScheduled([v('h', 8, '2027-01-01'), v('g', 7, '2027-01-01')], '2026-11-12')?.id).toBe('g');
  });

  it('P19.15-T4 AC-1 ending soon: within 30 days, nothing scheduled after it', () => {
    expect(daysBetween('2026-11-12', '2026-12-12')).toBe(30);
    const ending = v('i', 1, '2026-01-01', { effectiveTo: '2026-12-12' });
    expect(endingSoon(ending, null, '2026-11-12')).toBe(true);
    expect(endingSoon(ending, null, '2026-11-11')).toBe(false);
    expect(endingSoon(ending, december, '2026-11-12')).toBe(false);
    expect(endingSoon(april, null, '2026-11-12')).toBe(false);
    expect(endingSoon(null, null, '2026-11-12')).toBe(false);
  });
});
