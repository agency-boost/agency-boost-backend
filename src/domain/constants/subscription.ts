/**
 * An office's subscription (ADR-0112) and its leader limit (ADR-0113).
 *
 * **Bounds, not prices.** Nothing is charged, totalled or invoiced from a subscription: the price
 * per leader is informational, and the quote tool's tiers (`billing.ts`, ADR-0111) are not
 * connected to it. These are the limits the Super Admin's *Edit subscription* dialog and
 * `PATCH /admin/tenants/:kpmId/subscription` hold a value to, so a typing slip of three extra
 * zeros is refused rather than stored.
 *
 * Documented once in `docs/00-product/metrics-and-definitions.md` and pinned by
 * `subscription.spec.ts`.
 */
export const SUBSCRIPTION = {
  /**
   * The largest price per leader per month the console accepts: **Rp 100,000,000**, in IDR minor
   * units (invariant §9). The prototype's dearest public rate is Rp 400,000 a leader; a ceiling two
   * hundred and fifty times that refuses a slip and never a real contract.
   */
  PRICE_PER_LEADER_MAX_MINOR: 100_000_000_00,
  /**
   * A price is **whole rupiah**: a multiple of this many minor units. The console types rupiah and
   * the quote tool never prices in sen, so a fraction of a rupiah can only be a mistake.
   */
  PRICE_STEP_MINOR: 100,
  /** The smallest leader limit: an office of one AB (its Owner) is the smallest office there is. */
  MAX_LEADERS_MIN: 1,
  /**
   * The largest leader limit the console accepts. Far above any office in v1 — the quote tool's top
   * public tier is *101+* — so it refuses a slip and nothing else.
   */
  MAX_LEADERS_MAX: 10_000,
} as const;

/**
 * **What a leader is, for the leader limit** (ADR-0113 §1): the rungs whose active members count
 * towards *Leaders used*. The Owner counts at the AB rung they are created on, and an Admin at
 * whichever of the two they stand on.
 *
 * Not ADR-0087's *leader* — anybody with direct reports — which governs coaching, the landing and
 * the nav. An AAB with nobody under them counts here; an Agent with a direct report does not.
 */
export const LEADER_RUNG_CODES = ['AB', 'AAB'] as const;
