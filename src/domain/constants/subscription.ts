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

/*
 * `LEADER_RUNG_CODES` (`['AB', 'AAB']`) stood here until P18.5-T1. What the leader limit counts is now a
 * class, not a code — `LEADER_CLASSES` in `leader-tier.ts` (ADR-0156 §4) — so a leader on a rung a company
 * named itself is counted too.
 */
