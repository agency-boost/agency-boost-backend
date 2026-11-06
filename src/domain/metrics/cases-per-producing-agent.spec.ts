import { casesPerProducingAgent } from './cases-per-producing-agent';

const month = (policies: number | null, activeAgents: number | null) => ({ policies, activeAgents });

/**
 * **`CASES_PER_PRODUCING_AGENT`, *Cases/producing agents*** (P18.9-T1 AC-5; ADR-0175 §2) — **per active agent per month
 * since P19.3-T1** (ADR-0203 §5; `metrics-and-definitions.md` §A.12): Σ policies ÷ Σ monthly active agents over the same
 * months held, recomputed, never an average of ratios; *—* over nobody; *pending data* while no month holds both.
 */
describe('P19.3-T1 AC-15 CASES_PER_PRODUCING_AGENT — the policies per active agent per month (ADR-0203 §5)', () => {
  it('P19.3-T1 AC-15 Σ policies ÷ Σ active agents over the months held, exact — the screen writes a tenth', () => {
    // 3 + 4 + 5 policies over 2 + 2 + 3 active agents: 12 ÷ 7.
    expect(casesPerProducingAgent([month(3, 2), month(4, 2), month(5, 3)])).toBe(12 / 7);
    expect(casesPerProducingAgent([month(48, 20)])).toBe(2.4);
  });

  it('P19.3-T1 AC-15 recomputed from the sums, never the mean of each month’s ratio', () => {
    // Monthly ratios 10 and 1 average 5.5; the sums give 11 ÷ 2 = 5.5 only by chance — here 20 ÷ 11.
    const months = [month(10, 1), month(10, 10)];
    expect(casesPerProducingAgent(months)).toBe(20 / 11);
    expect(casesPerProducingAgent(months)).not.toBe((10 / 1 + 10 / 10) / 2);
  });

  it('P19.3-T1 AC-15 a month missing either half is left out of both sums', () => {
    expect(casesPerProducingAgent([month(6, 2), month(null, 4), month(9, null)])).toBe(3);
  });

  it('P18.9-T1 AC-5 over nobody active is none — *—* — never a division by zero; zero over somebody is 0', () => {
    expect(casesPerProducingAgent([month(12, 0), month(0, 0)])).toBe('none');
    expect(casesPerProducingAgent([month(0, 4)])).toBe(0);
  });

  it('P18.9-T1 AC-5 pending while no month holds both: no month held is never 0', () => {
    expect(casesPerProducingAgent([])).toBeNull();
    expect(casesPerProducingAgent([month(null, 5), month(12, null)])).toBeNull();
  });
});
