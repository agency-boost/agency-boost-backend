import { DEFAULT_ORG_LADDER, LEADER_RUNG_CODES, MINOR_UNITS_PER_MAJOR, SUBSCRIPTION } from './index';

/**
 * The subscription's registered bounds and the leader limit's rungs (ADR-0112, ADR-0113), pinned so a
 * change to one fails here before it reaches the console or the API. Each is documented once in
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

describe('the leader limit’s rungs (ADR-0113 §1)', () => {
  it('counts the AB and the AAB, and never the Agent', () => {
    expect([...LEADER_RUNG_CODES]).toEqual(['AB', 'AAB']);
    expect(LEADER_RUNG_CODES).not.toContain('AGENT');
  });

  it('names rungs the seeded ladder has', () => {
    const ladder = DEFAULT_ORG_LADDER.map((rung) => rung.code as string);
    for (const code of LEADER_RUNG_CODES) expect(ladder).toContain(code);
  });
});
