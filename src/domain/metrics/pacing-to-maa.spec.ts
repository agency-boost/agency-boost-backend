import { PERFORMANCE } from '@/domain/constants';
import { pacingToMaa, projectedSubmissions } from './pacing-to-maa';

/** The cascade on Rp 85 M at Rp 18 M a case, 30% and 30%: 5 closings, 17 appointments, 57 leads. */
const MONTH = { leads: 57, appointments: 17, closings: 5 };

/**
 * `PACING_TO_MAA` (`metrics-and-definitions.md` §A.2, P11-T6 AC-4). Its place among the definitions of
 * *active* it must not be confused with is `production.tenancy.spec.ts`'s conflict-regression fixture.
 */
describe('PACING_TO_MAA (§A.2)', () => {
  it('P11-T6 AC-4 projects the closing target times the share of the month’s cascade targets logged', () => {
    // 79 targets in all; 16 logged is 16/79 of the month, and 5 × 16/79 ≈ 1.01 closings.
    expect(projectedSubmissions({ targets: MONTH, logged: 16 })).toBeCloseTo((5 * 16) / 79, 10);
  });

  it('P11-T6 AC-4 is pacing at one projected policy, and not just below it', () => {
    // 5 × 16 / 79 ≈ 1.013, and 5 × 15 / 79 ≈ 0.949.
    expect(pacingToMaa({ targets: MONTH, logged: 16 })).toBe(true);
    expect(pacingToMaa({ targets: MONTH, logged: 15 })).toBe(false);
  });

  it('P11-T6 AC-4 is exactly the gate at MAA_PROJECTED_SUBMISSIONS_MIN, which is inclusive', () => {
    // 1 closing in a month of 10 targets, all 10 logged: exactly one projected policy.
    const one = { targets: { leads: 6, appointments: 3, closings: 1 }, logged: 10 };
    expect(projectedSubmissions(one)).toBe(PERFORMANCE.MAA_PROJECTED_SUBMISSIONS_MIN);
    expect(pacingToMaa(one)).toBe(true);
  });

  it('P11-T6 AC-4 a member who logged nothing on the cascade codes is not pacing', () => {
    expect(projectedSubmissions({ targets: MONTH, logged: 0 })).toBe(0);
    expect(pacingToMaa({ targets: MONTH, logged: 0 })).toBe(false);
  });

  it('P11-T6 AC-4 a month whose targets sum to zero projects nothing, never NaN', () => {
    // This month's APE target is zero: the year's target was met before the month began (ADR-0047).
    const made = { targets: { leads: 0, appointments: 0, closings: 0 }, logged: 40 };
    expect(projectedSubmissions(made)).toBe(0);
    expect(pacingToMaa(made)).toBe(false);
  });
});
