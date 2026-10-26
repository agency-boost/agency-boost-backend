import { MINOR_UNITS_PER_MAJOR, SUBSCRIPTION } from './index';

/**
 * The subscription's registered bounds (ADR-0112), pinned so a change to one fails here before it reaches the
 * console or the API. The leader limit's classes are `leader-tier.spec.ts`'s (ADR-0156). Each is documented once in
 * `docs/00-product/metrics-and-definitions.md`.
 */
describe('the subscription constants (ADR-0112)', () => {
  it('caps the price per leader at Rp 100,000,000 a month, in minor units', () => {
    expect(SUBSCRIPTION.PRICE_PER_LEADER_MAX_MINOR).toBe(100_000_000 * MINOR_UNITS_PER_MAJOR);
    expect(Number.isSafeInteger(SUBSCRIPTION.PRICE_PER_LEADER_MAX_MINOR)).toBe(true);
  });

  it('prices in whole rupiah: one rupiah of minor units is the step', () => {
    expect(SUBSCRIPTION.PRICE_STEP_MINOR).toBe(MINOR_UNITS_PER_MAJOR);
    expect(SUBSCRIPTION.PRICE_PER_LEADER_MAX_MINOR % SUBSCRIPTION.PRICE_STEP_MINOR).toBe(0);
  });

  it('takes a leader limit from 1 to 10,000', () => {
    expect(SUBSCRIPTION.MAX_LEADERS_MIN).toBe(1);
    expect(SUBSCRIPTION.MAX_LEADERS_MAX).toBe(10_000);
  });
});
