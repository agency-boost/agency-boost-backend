/**
 * **Langganan & akses: the price list and every number the calculator works with** (ADR-0279 §1–§4, amending ADR-0111
 * §3 and ADR-0211 §5; `functional/billing.md`; `metrics-and-definitions.md`, *Langganan*).
 *
 * The client's table of 20 November 2026 (`SPEC-SUPERADMIN-2026-11-20.md` §9, *Paket & harga*), in **integer IDR minor
 * units** (sen, invariant §9): per tier a stable code, the leader-count bounds (the last open), the standard price struck
 * through and the offer price, per leader per month. **The 101+ tier has neither**: it is *Harga khusus*, priced per KPM
 * by the Super Admin, so no hidden rate is held for it any more (ADR-0279 §1, retiring ADR-0111 option 3's secret rates).
 *
 * **Held once, here** (invariant §7). `GET /admin/billing/prices` serves it to the Super Admin alone, and the browser's
 * calculator reads it from there, never from a copy of its own.
 *
 * **The inversions are the table, not a defect** (ADR-0066 §1): 20 leaders cost more a month than 21, 44 to 50 more than
 * 51. `billing.spec.ts` pins them as expected behaviour. A price change is a release (*Harga baru berlaku di periode
 * berikutnya*: a confirmed package keeps the rate it was confirmed at, ADR-0279 §3).
 */

/** The currency every figure below is in. Not an office's `currency`: these are AgencyBoost's prices. */
export const BILLING_CURRENCY = 'IDR' as const;

/**
 * **The annual discount, in percent** — *Tahunan · HEMAT 5%* (§9). Taken off the period's total (leaders × price ×
 * 12), rounded half up to the whole rupiah, before any bulk discount (ADR-0279 §2).
 */
export const BILLING_ANNUAL_DISCOUNT_PCT = 5;

/** One tier of the table. Prices are per leader per month; `null` on the *Harga khusus* tier. */
export interface BillingTier {
  /** The identity. Stable: a quote, a manual chapter or a test names a tier by it, never by position. */
  readonly code: string;
  /** The smallest leader count the tier prices, inclusive. */
  readonly minLeaders: number;
  /** The largest, inclusive; `null` for the open last tier. */
  readonly maxLeaders: number | null;
  /** *Harga standar*, struck through. `null`: *Harga khusus*. */
  readonly standardMinor: number | null;
  /** *Harga penawaran*, the price the calculator starts from. `null`: *Harga khusus*, typed per KPM. */
  readonly offerMinor: number | null;
  /** *Harga khusus · diatur per KPM*: the tier draws no price. */
  readonly customPricing: boolean;
}

/** Rupiah to sen, for the figures below only: the client writes whole rupiah. */
const rupiah = (major: number) => major * 100;

/** §9's table, in order, smallest count first. */
export const BILLING_PRICE_TIERS: readonly BillingTier[] = [
  { code: 'TIER_1_10', minLeaders: 1, maxLeaders: 10, standardMinor: rupiah(500_000), offerMinor: rupiah(400_000), customPricing: false },
  { code: 'TIER_11_20', minLeaders: 11, maxLeaders: 20, standardMinor: rupiah(475_000), offerMinor: rupiah(375_000), customPricing: false },
  { code: 'TIER_21_50', minLeaders: 21, maxLeaders: 50, standardMinor: rupiah(450_000), offerMinor: rupiah(350_000), customPricing: false },
  { code: 'TIER_51_100', minLeaders: 51, maxLeaders: 100, standardMinor: rupiah(425_000), offerMinor: rupiah(300_000), customPricing: false },
  { code: 'TIER_101_PLUS', minLeaders: 101, maxLeaders: null, standardMinor: null, offerMinor: null, customPricing: true },
];

/**
 * **A subscription's plan** (ADR-0211 §1): *6 bulan* or *Tahunan*, on `kpms.subscription.plan`, `null` for none — a
 * trial has none (ADR-0279 §4).
 */
export const SUBSCRIPTION_PLANS = ['six_months', 'annual'] as const;
export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];

/** **The months a plan runs**: the calculator's period, and what choosing one proposes for the end date. */
export const SUBSCRIPTION_PLAN_MONTHS: Readonly<Record<SubscriptionPlan, 6 | 12>> = {
  six_months: 6,
  annual: 12,
};

/**
 * **The subscription's clock and the calculator's derived figures** (ADR-0279 §2, §4, §5). Every number the client named
 * in §9 that is not a price.
 */
export const BILLING = Object.freeze({
  /** *Trial 30 hari untuk KPM baru*: a new KPM's subscription runs 30 office days, its creation day the first. */
  TRIAL_DAYS: 30,
  /**
   * *Tidak diperpanjang 7 hari setelah berakhir = KPM otomatis ditangguhkan*: the office days after the end date its
   * members are still served. The daily run suspends the KPM on the eighth.
   */
  GRACE_DAYS: 7,
  /** *Berakhir ≤ 30 hari*: an end date within this many days of the office's today needs a renewal. */
  ENDING_SOON_DAYS: 30,
  /** *Per leader / hari = total ÷ bulan ÷ 30 ÷ leader*: the days a month is counted as for the per-day figures. */
  DAYS_PER_MONTH: 30,
  /** The per-day figures are rounded half up to the nearest Rp 100 (the mockup's *Rp 11.900*). */
  PER_DAY_ROUNDING_MINOR: rupiah(100),
  /** *Diskon bulk order* in percent: a whole number from 0 to 100. */
  BULK_PERCENT_MAX: 100,
  /** *Catatan*: at most this many characters. */
  NOTE_MAX: 500,
  /** *Nama KPM* typed for a KPM that does not exist yet (the offer's PDF), at most this many characters. */
  KPM_NAME_MAX: 120,
  /** *Jumlah leader* and *Jumlah agent*: a whole number up to this. */
  COUNT_MAX: 10_000,
});

/**
 * **Balik modal jika 1 KPM jual tambahan** (§9; §13.2): the policies a KPM sells to pay for its subscription — the
 * period's total ÷ the income one policy brings: APE Rp 20.000.000 × (komisi 20% + overriding 10% + bonus 10%) =
 * Rp 8.000.000.
 *
 * **Overriding 10% and bonus 10% are placeholders** the owner accepted *"for now"* (§13.2; OD-425): change them here
 * and every figure follows.
 */
export const BILLING_BREAK_EVEN = Object.freeze({
  /** One policy's APE. */
  POLICY_APE_MINOR: rupiah(20_000_000),
  COMMISSION_PCT: 20,
  /** Placeholder (§13.2). */
  OVERRIDING_PCT: 10,
  /** Placeholder (§13.2). */
  BONUS_PCT: 10,
});

/** The income one policy brings: APE × (komisi + overriding + bonus) — Rp 8.000.000. */
export const BILLING_INCOME_PER_POLICY_MINOR = BILLING_BREAK_EVEN.POLICY_APE_MINOR
  * (BILLING_BREAK_EVEN.COMMISSION_PCT + BILLING_BREAK_EVEN.OVERRIDING_PCT + BILLING_BREAK_EVEN.BONUS_PCT) / 100;

/**
 * **The reason the daily run writes on a KPM it suspends** (ADR-0279 §5). A KPM suspended with exactly this reason is
 * reactivated by the next confirmed package; one the Super Admin suspended themselves is not.
 */
export const BILLING_LAPSE_SUSPENSION_REASON = 'Langganan tidak diperpanjang';
