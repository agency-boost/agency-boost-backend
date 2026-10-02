import { SUB_PERIOD } from '@/domain/constants';
import { subPeriodActivityTarget } from './sub-period-activity-target';

/** The cascade on Rp 85 M at Rp 18 M a case, 30% and 30%: 5 closings, 17 appointments, 57 leads. */
const MONTH = { leads: 57, appointments: 17, policies: 5 };

/** `SUB_PERIOD_ACTIVITY_TARGET` (`metrics-and-definitions.md` §A.4, P11-T4 AC-4). */
describe('SUB_PERIOD_ACTIVITY_TARGET (§A.4)', () => {
  it('P11-T4 AC-4 scales each monthly target by 7 / 30.44 and rounds it', () => {
    // 57 × 0.22996 = 13.11, 17 × 0.22996 = 3.91, 5 × 0.22996 = 1.15.
    expect(subPeriodActivityTarget(MONTH)).toEqual({ leads: 13, appointments: 4, policies: 1 });
  });

  it('P11-T4 AC-4 reproduces the prototype’s card: Rina’s 70, 20 and 5 a month are 16, 5 and 1 a week (Overall.html:4224-4236, :6933)', () => {
    expect(subPeriodActivityTarget({ leads: 70, appointments: 20, policies: 5 }))
      .toEqual({ leads: 16, appointments: 5, policies: 1 });
  });

  it('P11-T4 AC-4 rounds half up and down as Math.round does, on each target alone', () => {
    // 2 × 0.22996 = 0.46 → 0; 3 × 0.22996 = 0.69 → 1; 100 × 0.22996 = 23.0 → 23.
    expect(subPeriodActivityTarget({ leads: 100, appointments: 3, policies: 0 }))
      .toEqual({ leads: 23, appointments: 1, policies: 0 });
    expect(subPeriodActivityTarget({ leads: 2, appointments: 2, policies: 0 }))
      .toEqual({ leads: 0, appointments: 0, policies: 0 });
  });

  it('P11-T4 AC-4 floors the closings at SUB_PERIOD_CLOSING_TARGET_FLOOR when the month asks for any', () => {
    // One closing a month is 0.23 a week, which rounds to nothing: the floor asks for one.
    expect(subPeriodActivityTarget({ leads: 12, appointments: 4, policies: 1 })!.policies)
      .toBe(SUB_PERIOD.CLOSING_TARGET_FLOOR);
    // Above the floor the scaled figure stands: 30 a month is 6.9, so 7.
    expect(subPeriodActivityTarget({ leads: 334, appointments: 100, policies: 30 })!.policies).toBe(7);
  });

  it('P11-T4 AC-4 asks for nothing in a month that needs nothing more (ADR-0047): the floor does not apply', () => {
    expect(subPeriodActivityTarget({ leads: 0, appointments: 0, policies: 0 }))
      .toEqual({ leads: 0, appointments: 0, policies: 0 });
  });

  it('P11-T4 AC-4 is null without a monthly target to derive it from', () => {
    expect(subPeriodActivityTarget(null)).toBeNull();
  });
});
