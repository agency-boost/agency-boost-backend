import { monthlyActiveAgent } from './monthly-active-agent';
import { metric } from './registry';

/**
 * `MONTHLY_ACTIVE_AGENT` (ADR-0054). `metrics-and-definitions.md` asks for all three of `true`,
 * `false` and `null`; the partial-file cases are what ADR-0054 added to the prototype's rule.
 */
describe('MONTHLY_ACTIVE_AGENT (ADR-0054)', () => {
  it('is registered as the tri-state, calendar-month metric this computes', () => {
    expect(metric('MONTHLY_ACTIVE_AGENT')).toMatchObject({
      unit: 'tri_state', period: 'CALENDAR_MONTH', threshold: null, phase: 9,
    });
  });

  describe('true — APE above zero or a policy written', () => {
    it.each([
      ['APE and a policy', 150_000_000_00, 2],
      ['APE alone', 1, 0],
      ['a policy alone', 0, 1],
      ['APE, with the policy count not reported', 150_000_000_00, null],
      ['a policy, with APE not reported', null, 3],
    ])('%s', (_, ape, policies) => {
      expect(monthlyActiveAgent(ape, policies)).toBe(true);
    });
  });

  it('false — both reported, and both zero', () => {
    expect(monthlyActiveAgent(0, 0)).toBe(false);
  });

  describe('null — not reported, which is not false', () => {
    it.each([
      ['nothing reported', null, null],
      ['APE zero, the policy count not reported', 0, null],
      ['no policy, APE not reported', null, 0],
    ])('%s', (_, ape, policies) => {
      expect(monthlyActiveAgent(ape, policies)).toBeNull();
    });
  });
});
