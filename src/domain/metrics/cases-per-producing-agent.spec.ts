import { casesPerProducingAgent } from './cases-per-producing-agent';

/**
 * **P18.97-T1 AC-5 — `CASES_PER_PRODUCING_AGENT`, *Cases/producing agents*** (ADR-0175 §2; `metrics-and-definitions.md`
 * §A.12): *Case submission* ÷ *Annual Active Agents* over the same period, exact; *—* over nobody; *pending data* while
 * either is.
 */
describe('P18.97-T1 AC-5 CASES_PER_PRODUCING_AGENT — Case submission ÷ Annual Active Agents', () => {
  it('P18.97-T1 AC-5 divides the period’s policies by its producing members, exact — the screen writes a tenth', () => {
    expect(casesPerProducingAgent(48, 20)).toBe(2.4);
    expect(casesPerProducingAgent(27, 5)).toBe(5.4);
    expect(casesPerProducingAgent(10, 3)).toBe(10 / 3);
    // Policies with nobody producing cannot happen on one file, but nothing assumes it: zero over somebody is 0.
    expect(casesPerProducingAgent(0, 4)).toBe(0);
  });

  it('P18.97-T1 AC-5 over nobody producing is none — *—* — never a division by zero', () => {
    expect(casesPerProducingAgent(12, 0)).toBe('none');
    expect(casesPerProducingAgent(0, 0)).toBe('none');
  });

  it('P18.97-T1 AC-5 pending while either figure is: no month held is never 0', () => {
    expect(casesPerProducingAgent(null, 5)).toBeNull();
    expect(casesPerProducingAgent(12, null)).toBeNull();
    expect(casesPerProducingAgent(null, null)).toBeNull();
  });
});
