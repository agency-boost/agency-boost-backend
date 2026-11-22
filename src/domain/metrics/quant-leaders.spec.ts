import { QUANT } from '@/domain/constants';
import { leaderDistribution, leaderUnits, nearestLeaderOf } from './quant-leaders';
import { periodMonths } from './quant';

describe('P19.22-T4 Analisa kuantitatif: half-years and the distribution per leader (ADR-0275 §4; §A.15)', () => {
  it('P19.22-T4 AC-1 a run’s own months are its half-year: January–June or July–December', () => {
    expect(QUANT.SEMESTER_MONTHS).toBe(6);
    expect(periodMonths('2026-06')).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
    expect(periodMonths('2026-12')).toEqual(['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12']);
  });

  const people = [
    { membershipId: 'ab1', role: 'ab', leaderId: null },
    { membershipId: 'aab1', role: 'aab', leaderId: 'ab1' },
    { membershipId: 'ag1', role: 'agent', leaderId: 'ab1' },
    { membershipId: 'ag2', role: 'agent', leaderId: 'aab1' },
    { membershipId: 'ag3', role: 'agent', leaderId: 'ag2' },
    { membershipId: 'loose', role: 'agent', leaderId: null },
  ];

  it('P19.22-T4 AC-2 each person stands in their nearest leader’s unit; an AAB’s team is the AAB’s', () => {
    const nearest = nearestLeaderOf(people);
    expect(nearest.get('ab1')).toBe('ab1');
    expect(nearest.get('aab1')).toBe('aab1');
    expect(nearest.get('ag1')).toBe('ab1');
    expect(nearest.get('ag3')).toBe('aab1');
    expect(nearest.get('loose')).toBeNull();
    expect(leaderUnits(people)).toEqual(new Map([['ab1', ['ab1', 'ag1']], ['aab1', ['aab1', 'ag2', 'ag3']]]));
  });

  it('P19.22-T4 AC-2 the leaders high to low, their median and how many stand at or above it', () => {
    const d = leaderDistribution([
      { membershipId: 'a', value: 1.2 }, { membershipId: 'b', value: 1.7 }, { membershipId: 'c', value: 0.6 },
      { membershipId: 'd', value: 1.3 }, { membershipId: 'e', value: 1.1 },
    ]);
    expect(d.leaders.map((l) => l.membershipId)).toEqual(['b', 'd', 'a', 'e', 'c']);
    expect(d.median).toBe(1.2);
    expect(d.atOrAbove).toBe(3);
    expect(leaderDistribution([{ membershipId: 'a', value: 2 }, { membershipId: 'b', value: 4 }]).median).toBe(3);
    expect(leaderDistribution([])).toEqual({ leaders: [], median: null, atOrAbove: 0 });
  });
});
