import { goalSet, goalSetRate, type PlannedGoalForRate } from './goal-set';

const M = 1_000_000 * 100;
const saved = (annualApeTargetMinor: number | null): PlannedGoalForRate => ({
  savedAt: '2026-01-05T02:00:00.000Z',
  projected: annualApeTargetMinor === null ? null : { annualApeTargetMinor },
});
const offered: PlannedGoalForRate = { savedAt: null, projected: { annualApeTargetMinor: 300 * M } };

describe('a goal set, and GOAL_SET_RATE (P18.6-T1 AC-5; OD-160 → option 1)', () => {
  it('P18.6-T1 AC-5 a goal saved for the year with an annual target above zero is set', () => {
    expect(goalSet(saved(500 * M))).toBe(true);
    expect(goalSet(saved(1))).toBe(true);
  });

  it.each([
    ['the defaults a first-time reader is offered', offered],
    ['a saved goal with a zero target', saved(0)],
    ['a saved goal whose assumptions make no plan', saved(null)],
    ['no plan at all', undefined],
    ['a null plan', null],
  ])('P18.6-T1 AC-5 %s is not set', (_, goal) => {
    expect(goalSet(goal as PlannedGoalForRate | null | undefined)).toBe(false);
  });

  it('P18.6-T1 AC-5 counts the members given with a goal set, over all of them; a member with no plan is not set', () => {
    const plans = new Map([['a', saved(500 * M)], ['b', saved(0)], ['c', offered]]);
    expect(goalSetRate(['a', 'b', 'c', 'd'], plans)).toEqual({ count: 1, of: 4, pct: 25 });
  });

  it('P18.6-T1 AC-5 over nobody is no rate: null, never 0%', () => {
    expect(goalSetRate([], new Map())).toEqual({ count: 0, of: 0, pct: null });
  });
});
