/**
 * The catalog a company starts with (P5-T4, ADR-0033).
 *
 * **A company's starting shelf, not the platform's truth.** It is copied into a company when that
 * company is created, and the company owns it from then on: Super Admin adds, renames, closes and
 * withdraws products from there.
 *
 * **Generated from the frozen prototypes, merged** (parity F-14). The shelf is declared four times
 * and the copies have diverged, so this takes each field from the file that owns it, by the rule in
 * `prototype-sources.md`: `Sales_Catalog.html` for the catalog's own content and order — it carries
 * the fuller benefits and prose — and the age and budget bands from the copy in `Overall.html`,
 * which Phase 14's fit check reads. The bands are the one place the copies disagree in **meaning**:
 * `Overall.html` scores budget on seven bands and `Sales_Attack_Plan.html` on five, where its
 * fourth band swallows three of the other's. The seven-band scale is the one the ERD and the flow
 * doc record, and it keeps a distinction the coarser one throws away — an affluent product and a
 * mid-income one land in different bands. The age bands are identical in both copies.
 *
 * **The attack plan is seven named fields**, the ones the Owner's override modal already names
 * (`KPM_Owner.html:1786-1793`), rather than one paragraph whose structure is parsed out of its `<b>`
 * tags. `opening` and `nextAction` are derived once here by the prototype's own two rules
 * (`extractOpening`, `extractClosing`); the two run-off products have no authored script, so those
 * two fields are blank rather than invented.
 *
 * **No commission.** The prototype falls back to a fabricated 40% / 20% when a product carries none
 * (parity F-15). A company supplies its own schedule; nothing here makes one up.
 *
 * 31 products: 10 life, 10 health (two of them accident-only riders), 4 critical illness,
 * 1 education, 6 investment — 15 conventional, 16 Syariah.
 */

export const PRODUCT_CHANNELS = ['conventional', 'syariah'] as const;
export type ProductChannel = (typeof PRODUCT_CHANNELS)[number];

export const PRODUCT_CATEGORIES = ['life', 'health', 'ci', 'education', 'investment'] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

/** What a customer needs. `accident` is a need and not a category: those products sit under health. */
export const PRODUCT_NEEDS = [
  'life-protection', 'health', 'ci', 'accident', 'education', 'investment', 'retirement', 'legacy',
] as const;
export type ProductNeed = (typeof PRODUCT_NEEDS)[number];

/**
 * The three document slots a product carries, in the prototype's own order and wording
 * (`KPM_Owner.html:2389-2391`).
 *
 * Named slots rather than a list: an agent looking for the illustration is looking for **the**
 * illustration, and a list would make "which one is the brochure" a question about ordering.
 *
 * The labels are the English source of words the API serves in the reader's language (P18.98-T7; ADR-0179 §7):
 * `modules/products/products.messages.ts` (`PRODUCTS_MESSAGES`) holds each beside its Indonesian — as it does
 * *Lump-sum*, the one budget band below that is a word. The keys never change.
 */
export const PRODUCT_DOCUMENT_SLOTS = [
  { key: 'brochure', label: 'Brochure' },
  { key: 'illustration', label: 'Illustration / Simulation' },
  { key: 'productDoc', label: 'Product Document' },
] as const;
export type ProductDocumentSlot = (typeof PRODUCT_DOCUMENT_SLOTS)[number]['key'];

/**
 * **An office's own product documents** (P17-T9): the office's folder they land in, fixed by the server
 * (ADR-0032) as the pitch documents' `RECRUITMENT.PITCH_UPLOAD_FOLDER` is, and the longest label a slot
 * carries — a longer one is cut to it rather than refused, since the screen offers the file's name.
 */
export const PRODUCT_DOCUMENT_FOLDER = 'products';
export const PRODUCT_DOCUMENT_LABEL_MAX_LENGTH = 200;

/**
 * Whether an office's own wording may reach its agents yet (ADR-0037).
 *
 * `none` is a row with no script override at all — most rows, most of the time. The approval is
 * the **office's own**, not an independent review, which is the thing the manual has to say
 * plainly so nobody reads a tick as a compliance sign-off somebody else gave.
 */
export const SCRIPT_REVIEW_STATES = ['none', 'pending', 'approved', 'rejected'] as const;
export type ScriptReviewState = (typeof SCRIPT_REVIEW_STATES)[number];

/** The seven that make up the script, so approving one approves a coherent whole. */
export const SCRIPT_OVERRIDE_FIELDS = [
  'goodFit', 'opening', 'benefits', 'fullScript',
  'objectionTheySay', 'objectionYouSay', 'nextAction',
] as const;

/**
 * What an office may replace on a product it sells (P5-T5 AC-6; ADR-0120).
 *
 * The display name, the *Short description (shown to agents)* and the seven attack-plan fields —
 * exactly what the prototype's product modal offers (`KPM_Owner.html:1781-1793`). Everything else
 * is the company's: a code, a channel, a category, the bands and the commission are facts about the
 * product rather than words about it, and an office rewriting one would be describing a different
 * product under the same code.
 */
export const OVERRIDABLE_PRODUCT_FIELDS = [
  'displayName', 'description', ...SCRIPT_OVERRIDE_FIELDS,
] as const;
export type OverridableProductField = (typeof OVERRIDABLE_PRODUCT_FIELDS)[number];

/**
 * The fields held for the office's own approval before agents read them (ADR-0037, ADR-0120).
 *
 * The seven script fields, and the **description** since OD-136: a tagline is a sentence an agent
 * may repeat to a customer, which is what the approval is for. The display name is not here — it
 * is a label, and it reaches agents as soon as it is saved.
 */
export const APPROVED_PRODUCT_FIELDS = ['description', ...SCRIPT_OVERRIDE_FIELDS] as const;

/**
 * The longest tagline a product carries, and so the longest description an office may put in its
 * place (OD-136): the office's sentence stands where the company's does, on the same card.
 */
export const PRODUCT_TAGLINE_MAX_LENGTH = 300;

/** `legacy: true` in the prototype, which could not say what replaced a product (P5-T4 AC-4). */
export const PRODUCT_LIFECYCLES = ['active', 'closed_to_new_business', 'withdrawn'] as const;
export type ProductLifecycle = (typeof PRODUCT_LIFECYCLES)[number];

/** The five age bands and the seven budget bands the fit check scores against (Phase 14). */
export const PRODUCT_AGE_BANDS = [1, 2, 3, 4, 5] as const;
export const PRODUCT_BUDGET_BANDS = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * What each band means, from `Overall.html:9527-9533`. The screens read these; nothing keys on them.
 *
 * The budget bands' sums are written compact, as ADR-0167 §1 writes a chip — *Rp 500 rb*, *Rp 2 jt* — where the
 * prototype wrote *Rp500K* and *Rp2M*, its `M` a million (*juta*, `jt`; `M` is *miliar*). Literal strings, so the
 * frontend's pin (`lib/product-catalog.spec.ts`) can read them from this file's text.
 */
export const PRODUCT_AGE_BAND_LABELS: Readonly<Record<number, string>> = {
  1: '< 25', 2: '25–34', 3: '35–49', 4: '50–64', 5: '65+',
};
export const PRODUCT_BUDGET_BAND_LABELS: Readonly<Record<number, string>> = {
  1: '< Rp 500 rb', 2: 'Rp 500 rb–Rp 2 jt', 3: 'Rp 2 jt–Rp 5 jt', 4: 'Rp 5 jt–Rp 10 jt',
  5: 'Rp 10 jt–Rp 20 jt', 6: '> Rp 20 jt', 7: 'Lump-sum',
};

/**
 * **The one budget band that is not a monthly premium**: *Lump-sum*, a single payment (ADR-0167; the client's
 * UI review of 2026-10-26, UI-030; P18.95-T6 AC-3, parity I-422).
 *
 * The prototype drew it as the seventh chip under *Monthly premium budget* (`Overall.html:3826-3834`), which
 * reads a single premium as a monthly one. The brief now asks it as an option of its own, beside that
 * question. **The band keeps its number**: a product's `eligibleBudgetBands`, the scorer and every address
 * (`?budget=7`) mean the same thing as before, so nothing stored or linked has to move. Bands 1 to 6 are
 * the monthly ones.
 */
export const PRODUCT_LUMP_SUM_BUDGET_BAND = 7;

/** The seven fields the Owner's override modal names, in its order. */
export interface SeedAttackPlan {
  readonly goodFit: string;
  readonly opening: string;
  readonly benefits: readonly string[];
  readonly fullScript: string;
  readonly objectionTheySay: string;
  readonly objectionYouSay: string;
  readonly nextAction: string;
}

export interface SeedProduct {
  readonly code: string;
  readonly name: string;
  readonly channel: ProductChannel;
  readonly category: ProductCategory;
  readonly primaryNeeds: readonly ProductNeed[];
  readonly eligibleAgeBands: readonly number[];
  readonly eligibleBudgetBands: readonly number[];
  readonly tagline: string;
  readonly benefits: readonly string[];
  readonly differentiator: string;
  readonly bestFor: string;
  readonly lifecycle: ProductLifecycle;
  /** What an office sells before its Owner has an opinion (ADR-0033). Never a run-off product. */
  readonly activeByDefault: boolean;
  readonly sortOrder: number;
  readonly defaultAttackPlan: SeedAttackPlan;
}

/**
 * *4b · If they push back — you say*, per primary need: the reply `Overall.html` renders
 * (`REPLY_BY_NEED`, `:9497-9506`, and its twin at `:10086-10095`), paired with the need's
 * objection, which is `objectionTheySay`.
 *
 * **Not the differentiator** (D-reply, Phase 14). P5-T4 took the differentiator from the stale
 * comment above the table (`:9482-9484`) and the retired section file; the governing file renders
 * this, and the differentiator already prints under *How it stands out* in the same drawer. The
 * Owner's own modal ships the same words for PRUmapan (`KPM_Owner.html:2326`). Migration
 * `0024-attack-plan-reply` rewrites the seeded differentiator a company still holds.
 */
export const SEED_REPLY_BY_NEED: Readonly<Record<ProductNeed, string>> = {
  'life-protection': "I get that — nobody wants another bill. But this isn't really about adding insurance, it's about making sure the people who depend on you can keep going if you're suddenly not there. Can I show you what that would actually look like for your family, so you can decide for yourself if it's worth it?",
  health: "That's great, and I'm glad you already have something. Can I ask — what happens to that coverage the day you leave that job, or once you retire? Most office plans are borrowed, not owned. This is about having something that's yours no matter where you work.",
  ci: "I hope you never have to use it either — honestly, that's the whole point. This isn't about expecting the worst, it's about making sure that if it ever happened, money would be one less thing you'd have to think about while you focus on getting better.",
  accident: "That's good to hear. Do you know exactly what it covers, though? A lot of people only find out the details once they're already filing a claim. This is just a way to make sure there are no surprises if something ever happens.",
  education: "That's a great habit, and I really respect that. The one thing saving alone can't guarantee is what happens if something happens to you along the way. This just makes sure your child's education still happens, no matter what.",
  investment: "That's a fair question — I'd want to understand that too before putting money in. Can I show you how the fund options actually work, so you can see exactly how much risk you're taking and choose what you're comfortable with?",
  retirement: "I hear that a lot — it doesn't feel urgent yet. But that's actually the best reason to start now: the earlier you begin, the less it costs you each month to get to the same place later. This isn't about retiring tomorrow, it's about giving your future self a lot less to worry about.",
  legacy: "That's great, being debt-free already puts you ahead. This isn't really about debt, though — it's about what you'd want to leave behind for the people you love, on your terms. Think of it less as insurance and more as a gift you're setting up now.",
};

export const SEED_PRODUCTS: readonly SeedProduct[] = [
  {
    code: 'PRUMAPAN',
    name: "PRUMapan",
    channel: 'conventional',
    category: 'life',
    primaryNeeds: ["retirement"],
    eligibleAgeBands: [1, 2, 3],
    eligibleBudgetBands: [1, 2, 3],
    tagline: "Endowment-style life with guaranteed retirement payouts from age 55.",
    benefits: [
      "Manfaat Dana Mapan paid annually from age 55 to 75 (21 installments), up to ~5.8× annual premium in total payouts.",
      "Death cover (natural and accidental) with up to +100% additional accidental death benefit (cap Rp2 billion).",
      "Premium entry from ~Rp200K / month; designed for milenial and Gen Z.",
      "No medical exam up to Rp250M annual premium.",
      "Option to accelerate Dana Mapan from age 45 (or after 11 premium payments).",
    ],
    differentiator: "The accessible retirement-income option (~Rp200K entry). 21-installment Dana Mapan structure provides scheduled income from age 55 to 75, up to 5.8× annual premium. Companion product PRUAnugerah is the affluent-tier conventional retirement product with hybrid life + pension positioning.",
    bestFor: "Sandwich-generation milenial and Gen Z building long-term financial certainty.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 1,
    defaultAttackPlan: {
      goodFit: "Sandwich-generation milenial and Gen Z building long-term financial certainty.",
      opening: "Setting up retirement income alongside daily expenses isn't easy, especially when you're supporting both kids and parents.",
      benefits: [
        "Manfaat Dana Mapan paid annually from age 55 to 75 (21 installments), up to ~5.8× annual premium in total payouts.",
        "Death cover (natural and accidental) with up to +100% additional accidental death benefit (cap Rp2 billion).",
        "Premium entry from ~Rp200K / month; designed for milenial and Gen Z.",
        "No medical exam up to Rp250M annual premium.",
        "Option to accelerate Dana Mapan from age 45 (or after 11 premium payments).",
      ],
      fullScript: "Setting up retirement income alongside daily expenses isn't easy, especially when you're supporting both kids and parents. PRUMapan was built exactly for that situation. From around Rp200K monthly, you build cover that pays you back annually from age 55 through 75. That's 21 installments of guaranteed income, up to roughly 5.8 times the annual premium you contributed. Compared with PRUAnugerah, which targets affluent customers wanting hybrid life-plus-pension at a higher tier, PRUMapan starts where most milenial and Gen Z professionals actually are today. Shall I prepare an illustration showing the exact Dana Mapan payouts for your specific premium level?",
      objectionTheySay: "Retirement is too far away to think about right now.",
      objectionYouSay: SEED_REPLY_BY_NEED['retirement'],
      nextAction: "Shall I prepare an illustration showing the exact Dana Mapan payouts for your specific premium level?",
    },
  },
  {
    code: 'PRUSMART_PLAN',
    name: "PRUSmart Plan",
    channel: 'conventional',
    category: 'life',
    primaryNeeds: ["life-protection"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [3, 4, 5, 6],
    tagline: "20-year endowment, money back larger than premiums paid.",
    benefits: [
      "Short premium term: 6 or 8 years for a 20-year cover.",
      "Annual cash benefit ~25% of annual premium, escalating each year from policy year 7 or 9.",
      "End-of-term cash payout up to ~920% of annual premium.",
      "Death benefit 100%–150% of annual premium depending on premium term selected.",
      "No medical exam up to Rp250M annual premium.",
    ],
    differentiator: "The cash-payout-focused life option: shortest premium term (6 or 8 years) for full 20-year cover, with maturity payout mathematically larger than total premiums paid. PRUFuture is the whole-life conventional alternative; PRUCinta is the sharia 20-year alternative.",
    bestFor: "Mid-income families with a defined 20-year financial goal.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 2,
    defaultAttackPlan: {
      goodFit: "Mid-income families with a defined 20-year financial goal.",
      opening: "You mentioned wanting protection that also returns more than you put in.",
      benefits: [
        "Short premium term: 6 or 8 years for a 20-year cover.",
        "Annual cash benefit ~25% of annual premium, escalating each year from policy year 7 or 9.",
        "End-of-term cash payout up to ~920% of annual premium.",
        "Death benefit 100%–150% of annual premium depending on premium term selected.",
        "No medical exam up to Rp250M annual premium.",
      ],
      fullScript: "You mentioned wanting protection that also returns more than you put in. PRUSmart Plan is structured to do exactly that across a 20-year horizon. You pay for only 6 or 8 years; the policy covers you for 20. From year 7 or year 9, you start receiving annual cash benefits at around 25% of premium, escalating each year. At the end of the 20 years, you get an end-of-term payout that can reach 920% of your annual premium. So the maths works out: total payouts larger than total premiums paid. Compared with PRUFuture which covers you for life but doesn't pay out cash along the way, this one rewards you for sticking with the plan. Would you like an illustration with the exact cash schedule for your contribution level?",
      objectionTheySay: "That sounds like more than I already pay for insurance.",
      objectionYouSay: SEED_REPLY_BY_NEED['life-protection'],
      nextAction: "Would you like an illustration with the exact cash schedule for your contribution level?",
    },
  },
  {
    code: 'PRUFUTURE',
    name: "PRUFuture",
    channel: 'conventional',
    category: 'life',
    primaryNeeds: ["life-protection"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [2, 3, 4, 5, 6],
    tagline: "Affordable whole-life to age 100, with optional CI premium waiver.",
    benefits: [
      "Cover to age 100.",
      "Minimum sum assured from Rp500 juta / USD 50,000.",
      "Premium term 5, 10, or 15 years.",
      "Plan Waiver option: premium-payment waiver if insured diagnosed with a critical condition during premium term.",
      "Available in Rupiah and USD.",
    ],
    differentiator: "The whole-life conventional life option with USD currency choice and an optional CI premium waiver. Most cost-conscious whole-life on the shelf. PRUSmart Plan is the 20-year endowment alternative; PRUWarisan is the dedicated legacy alternative.",
    bestFor: "Cost-conscious customers wanting long-tenure life with currency flexibility.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 3,
    defaultAttackPlan: {
      goodFit: "Cost-conscious customers wanting long-tenure life with currency flexibility.",
      opening: "The advantage of starting whole-life cover now, while you're healthy, is that the premium locks in and stays affordable.",
      benefits: [
        "Cover to age 100.",
        "Minimum sum assured from Rp500 juta / USD 50,000.",
        "Premium term 5, 10, or 15 years.",
        "Plan Waiver option: premium-payment waiver if insured diagnosed with a critical condition during premium term.",
        "Available in Rupiah and USD.",
      ],
      fullScript: "The advantage of starting whole-life cover now, while you're healthy, is that the premium locks in and stays affordable. PRUFuture gives you protection to age 100 with a minimum sum assured of Rp500 million, or USD 50,000 if you prefer hard currency. You pay for 5, 10, or 15 years; the cover runs for life. There's also a Plan Waiver option: if you're diagnosed with a critical condition during the premium term, future premiums are waived but the cover continues. PRUSmart Plan is the 20-year cash-payout alternative; PRUFuture is for clients who prioritize lifelong protection certainty over scheduled cash returns. Would you like to see both side by side?",
      objectionTheySay: "That sounds like more than I already pay for insurance.",
      objectionYouSay: SEED_REPLY_BY_NEED['life-protection'],
      nextAction: "Would you like to see both side by side?",
    },
  },
  {
    code: 'PRUWARISAN',
    name: "PRUWarisan",
    channel: 'conventional',
    category: 'life',
    primaryNeeds: ["legacy"],
    eligibleAgeBands: [3, 4],
    eligibleBudgetBands: [3, 4, 5, 6],
    tagline: "Estate-legacy whole-life to age 99 with sum-assured booster.",
    benefits: [
      "Life cover to age 99.",
      "Premium term 5, 10, or 15 years (paid-up after that).",
      "PRUWarisan Booster progressively lifts the sum assured over time.",
      "100% sum assured + Booster on death, less any liabilities.",
      "Maturity benefit if insured survives to age 99.",
    ],
    differentiator: "The flagship conventional legacy product. PRUWarisan Booster compounds the inheritance value over time. Sharia counterpart PRUHeritage Syariah extends one year longer (to 100) with USD option. PRUAnugerah Syariah is the more accessible sharia legacy alternative (from ~Rp500K).",
    bestFor: "Affluent customers planning intergenerational wealth transfer.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 4,
    defaultAttackPlan: {
      goodFit: "Affluent customers planning intergenerational wealth transfer.",
      opening: "What you're describing, ensuring something solid passes to your children, is exactly what PRUWarisan was designed for.",
      benefits: [
        "Life cover to age 99.",
        "Premium term 5, 10, or 15 years (paid-up after that).",
        "PRUWarisan Booster progressively lifts the sum assured over time.",
        "100% sum assured + Booster on death, less any liabilities.",
        "Maturity benefit if insured survives to age 99.",
      ],
      fullScript: "What you're describing, ensuring something solid passes to your children, is exactly what PRUWarisan was designed for. The cover runs to age 99. You pay for just 5, 10, or 15 years; after that, the policy is paid-up for life. The unique feature is the PRUWarisan Booster: your sum assured progressively increases over time, so the inheritance grows rather than erodes with inflation. If you'd like sharia-compliant alternatives, PRUHeritage Syariah extends a year longer to age 100 and adds a USD option. Shall I prepare a projected legacy value at age 99 for your intended sum assured?",
      objectionTheySay: "I don't need life insurance — I don't have any debts.",
      objectionYouSay: SEED_REPLY_BY_NEED['legacy'],
      nextAction: "Shall I prepare a projected legacy value at age 99 for your intended sum assured?",
    },
  },
  {
    code: 'PRUANUGERAH',
    name: "PRUAnugerah",
    channel: 'conventional',
    category: 'life',
    primaryNeeds: ["retirement"],
    eligibleAgeBands: [3, 4],
    eligibleBudgetBands: [3, 4, 5, 6],
    tagline: "Hybrid life and retirement income; structured pension feel.",
    benefits: [
      "Long-tenor life protection combined with retirement-income features.",
      "Structured payouts oriented toward retirement-stage funding needs.",
      "Death and survival benefits along the policy timeline.",
      "Family-protection elements alongside the retirement focus.",
    ],
    differentiator: "The affluent-tier conventional retirement product. Hybrid life + pension positioning. More comprehensive than PRUMapan (which is the entry-level retirement option at ~Rp200K targeting milenial and Gen Z).",
    bestFor: "Pre-retirement professionals wanting structured retirement payouts without unit-linked market risk.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 5,
    defaultAttackPlan: {
      goodFit: "Pre-retirement professionals wanting structured retirement payouts without unit-linked market risk.",
      opening: "Pre-retirement clients in your stage often want one product covering both life protection and structured retirement payouts, not two separate policies.",
      benefits: [
        "Long-tenor life protection combined with retirement-income features.",
        "Structured payouts oriented toward retirement-stage funding needs.",
        "Death and survival benefits along the policy timeline.",
        "Family-protection elements alongside the retirement focus.",
      ],
      fullScript: "Pre-retirement clients in your stage often want one product covering both life protection and structured retirement payouts, not two separate policies. PRUAnugerah is built around that combined need. Unlike pure-protection products, it builds toward retirement-stage income while keeping the family-protection layer in place throughout. Compared with PRUMapan, which is the entry-tier retirement option at around Rp200K monthly targeting milenial buyers, PRUAnugerah is the affluent-tier consolidated planning option. Would you like a projection showing how the protection and retirement payouts compound over your remaining working years?",
      objectionTheySay: "Retirement is too far away to think about right now.",
      objectionYouSay: SEED_REPLY_BY_NEED['retirement'],
      nextAction: "Would you like a projection showing how the protection and retirement payouts compound over your remaining working years?",
    },
  },
  {
    code: 'PRUHERITAGE_SYARIAH',
    name: "PRUHeritage Syariah",
    channel: 'syariah',
    category: 'life',
    primaryNeeds: ["legacy"],
    eligibleAgeBands: [3, 4],
    eligibleBudgetBands: [3, 4, 5, 6],
    tagline: "Long-term sharia legacy protection to age 100.",
    benefits: [
      "Sharia-compliant whole-life cover up to age 100.",
      "Premium options that pair short payment terms with long coverage tenure.",
      "USD currency variant available for hard-currency legacy planning.",
      "Cash-value accumulation under sharia management; tabarru and ujrah structures.",
    ],
    differentiator: "The longest-tenor legacy product across both books (to age 100). Available in USD for hard-currency legacy planning. Sharia-managed. PRUAnugerah Syariah is the lower-tier sharia legacy alternative (from ~Rp500K); PRUWarisan is the conventional counterpart.",
    bestFor: "Affluent muslim clients planning multi-generational legacy.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 6,
    defaultAttackPlan: {
      goodFit: "Affluent muslim clients planning multi-generational legacy.",
      opening: "Multi-generational legacy planning under sharia governance has specific requirements, and PRUHeritage Syariah is built to meet them.",
      benefits: [
        "Sharia-compliant whole-life cover up to age 100.",
        "Premium options that pair short payment terms with long coverage tenure.",
        "USD currency variant available for hard-currency legacy planning.",
        "Cash-value accumulation under sharia management; tabarru and ujrah structures.",
      ],
      fullScript: "Multi-generational legacy planning under sharia governance has specific requirements, and PRUHeritage Syariah is built to meet them. Cover extends to age 100, the longest tenor of any product in the catalog. The fund is managed under tabarru and ujrah principles, ensuring the structure remains sharia-compliant throughout. You can also denominate the policy in USD, useful if part of the inheritance is intended for children studying or settling abroad. If accessibility is more important than tenor, PRUAnugerah Syariah is the entry-tier sharia legacy option starting from around Rp500K monthly. Shall I prepare illustrations in both Rupiah and USD?",
      objectionTheySay: "I don't need life insurance — I don't have any debts.",
      objectionYouSay: SEED_REPLY_BY_NEED['legacy'],
      nextAction: "Shall I prepare illustrations in both Rupiah and USD?",
    },
  },
  {
    code: 'PRUCINTA',
    name: "PRUCinta",
    channel: 'syariah',
    category: 'life',
    primaryNeeds: ["life-protection"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [2, 3],
    tagline: "20-year sharia life with Ramadan accidental-death boost.",
    benefits: [
      "Sharia cover for 20 years.",
      "100% sum assured + cash value on death.",
      "300% sum assured + cash value on accidental death before age 70.",
      "400% on accidental death in the 6-week Ramadan window each year.",
      "Tabarru' contribution at 17% of contribution paid.",
    ],
    differentiator: "The standard 20-year sharia life option, with a distinctive 4× accidental death payout in the Ramadan travel window not found anywhere else in the catalog. PRUTahapan Cemerlang is the milestone-staged sharia alternative; PRUTect Care is the digital-entry sharia alternative.",
    bestFor: "Young muslim families wanting strong sharia accidental-death protection during Ramadan mudik.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 7,
    defaultAttackPlan: {
      goodFit: "Young muslim families wanting strong sharia accidental-death protection during Ramadan mudik.",
      opening: "For young muslim families, the Ramadan period brings both spiritual focus and a lot of mudik travel.",
      benefits: [
        "Sharia cover for 20 years.",
        "100% sum assured + cash value on death.",
        "300% sum assured + cash value on accidental death before age 70.",
        "400% on accidental death in the 6-week Ramadan window each year.",
        "Tabarru' contribution at 17% of contribution paid.",
      ],
      fullScript: "For young muslim families, the Ramadan period brings both spiritual focus and a lot of mudik travel. PRUCinta acknowledges that reality with a 400% accidental death benefit during the six-week Ramadan window each year, on top of 300% in the rest of the year. The cover runs 20 years and is sharia-managed with tabarru contribution at 17%. Compared with PRUTahapan Cemerlang which structures payouts around life-stage milestones, PRUCinta is the straightforward sharia 20-year option with the strongest Ramadan-specific protection. Would you like an illustration that quantifies the accidental death benefit at your chosen sum assured?",
      objectionTheySay: "That sounds like more than I already pay for insurance.",
      objectionYouSay: SEED_REPLY_BY_NEED['life-protection'],
      nextAction: "Would you like an illustration that quantifies the accidental death benefit at your chosen sum assured?",
    },
  },
  {
    code: 'PRUANUGERAH_SYARIAH',
    name: "PRUAnugerah Syariah",
    channel: 'syariah',
    category: 'life',
    primaryNeeds: ["legacy"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [2, 3],
    tagline: "Sharia legacy from ~Rp500K monthly contribution.",
    benefits: [
      "Sharia-compliant long-term life protection.",
      "Cash-value building under tabarru / mudharabah structure.",
      "Inheritance-focused payout structure for ahli waris.",
      "Accessible entry contribution starting from ~Rp500K/month.",
    ],
    differentiator: "The accessible sharia legacy option (from ~Rp500K monthly). Brings inheritance planning within reach of mass-affluent muslim customers. Higher-tier PRUHeritage Syariah extends to age 100 with USD currency.",
    bestFor: "Middle-class muslim clients building inheritance gradually.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 8,
    defaultAttackPlan: {
      goodFit: "Middle-class muslim clients building inheritance gradually.",
      opening: "Legacy planning shouldn't require waiting until you're affluent.",
      benefits: [
        "Sharia-compliant long-term life protection.",
        "Cash-value building under tabarru / mudharabah structure.",
        "Inheritance-focused payout structure for ahli waris.",
        "Accessible entry contribution starting from ~Rp500K/month.",
      ],
      fullScript: "Legacy planning shouldn't require waiting until you're affluent. PRUAnugerah Syariah brings inheritance protection within reach from around Rp500K monthly. The fund is managed under tabarru and mudharabah principles, and the cash value builds over time alongside the life cover. The eventual payout to your ahli waris is structured as sharia-compliant inheritance. The higher-tier option is PRUHeritage Syariah, which extends to age 100 and offers USD currency, but it's positioned for affluent customers. Would you like to compare the two side by side at your preferred contribution level?",
      objectionTheySay: "I don't need life insurance — I don't have any debts.",
      objectionYouSay: SEED_REPLY_BY_NEED['legacy'],
      nextAction: "Would you like to compare the two side by side at your preferred contribution level?",
    },
  },
  {
    code: 'PRUTECT_CARE',
    name: "PRUTect Care",
    channel: 'syariah',
    category: 'life',
    primaryNeeds: ["life-protection"],
    eligibleAgeBands: [1, 2, 3],
    eligibleBudgetBands: [1],
    tagline: "Digital sharia life via OVO; entry-tier hospital cash benefit.",
    benefits: [
      "Distribution through the OVO digital wallet app.",
      "Hospital cash benefit on inpatient admission.",
      "Simple sharia-compliant cover with minimal underwriting friction.",
      "Designed for first-time digital insurance buyers.",
    ],
    differentiator: "The digital-only sharia entry product. Lowest acquisition friction across the entire shelf; bought through OVO app rather than an agent. PRUCinta is the agent-distributed 20-year sharia alternative.",
    bestFor: "Tech-savvy first-time insurance buyers in the mass market.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 9,
    defaultAttackPlan: {
      goodFit: "Tech-savvy first-time insurance buyers in the mass market.",
      opening: "You'd prefer to handle this digitally without a long agent meeting, and that's precisely what PRUTect Care offers.",
      benefits: [
        "Distribution through the OVO digital wallet app.",
        "Hospital cash benefit on inpatient admission.",
        "Simple sharia-compliant cover with minimal underwriting friction.",
        "Designed for first-time digital insurance buyers.",
      ],
      fullScript: "You'd prefer to handle this digitally without a long agent meeting, and that's precisely what PRUTect Care offers. You buy it through the OVO app: sharia-compliant life cover with hospital cash benefit, set up in minutes. The underwriting is simplified, so onboarding friction is minimal. If you eventually want a more comprehensive sharia life policy with stronger accidental death cover, PRUCinta from your regular agent is the natural upgrade path. For now, would you like me to walk you through the OVO setup?",
      objectionTheySay: "That sounds like more than I already pay for insurance.",
      objectionYouSay: SEED_REPLY_BY_NEED['life-protection'],
      nextAction: "For now, would you like me to walk you through the OVO setup?",
    },
  },
  {
    code: 'PRUTAHAPAN_CEMERLANG',
    name: "PRUTahapan Cemerlang",
    channel: 'syariah',
    category: 'life',
    primaryNeeds: ["life-protection"],
    eligibleAgeBands: [2, 3],
    eligibleBudgetBands: [2, 3],
    tagline: "Milestone-staged sharia life protection across life events.",
    benefits: [
      "Sharia life cover structured around life-stage milestones.",
      "Benefits that adapt as the participant moves through life events.",
      "Sharia-compliant fund management with tabarru contribution.",
      "Designed as a complement to other sharia products in the household portfolio.",
    ],
    differentiator: "The milestone-staged sharia life option with adaptive benefits across life events. PRUCinta is the standard 20-year sharia alternative; PRUTect Care is the digital-entry sharia alternative.",
    bestFor: "Sharia customers wanting protection that scales with life events.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 10,
    defaultAttackPlan: {
      goodFit: "Sharia customers wanting protection that scales with life events.",
      opening: "Sharia protection that adapts as you move through marriage, having children, and other life events is what this product is structured for.",
      benefits: [
        "Sharia life cover structured around life-stage milestones.",
        "Benefits that adapt as the participant moves through life events.",
        "Sharia-compliant fund management with tabarru contribution.",
        "Designed as a complement to other sharia products in the household portfolio.",
      ],
      fullScript: "Sharia protection that adapts as you move through marriage, having children, and other life events is what this product is structured for. PRUTahapan Cemerlang stages the benefits around milestones rather than treating the policy as static. The underlying fund is sharia-managed, and the structure ensures protection scales with the household's evolving needs. Compared with PRUCinta which is the straightforward 20-year sharia option, this one is for clients expecting their needs to change over the policy life. Would you like me to map this against your expected life milestones over the next 10 years?",
      objectionTheySay: "That sounds like more than I already pay for insurance.",
      objectionYouSay: SEED_REPLY_BY_NEED['life-protection'],
      nextAction: "Would you like me to map this against your expected life milestones over the next 10 years?",
    },
  },
  {
    code: 'PRUSEHAT',
    name: "PRUSehat",
    channel: 'conventional',
    category: 'health',
    primaryNeeds: ["health"],
    eligibleAgeBands: [1, 2, 3, 4, 5],
    eligibleBudgetBands: [2, 3, 4, 5, 6],
    tagline: "Pure as-billed health with No Claim Bonus.",
    benefits: [
      "8 plan options covering room type, room price ceiling, and region.",
      "As-billed inpatient reimbursement.",
      "Annual limit up to Rp65 billion with Limit Booster.",
      "30 days pre and 90 days post outpatient surgery covered.",
      "Outpatient cancer treatment and dialysis covered without prior inpatient.",
      "No Claim Bonus: +10% annual limit per claim-free year, capped at +50%.",
    ],
    differentiator: "The pure traditional health option with No Claim Bonus and 8 plan tiers (most flexibility on the shelf). Lowest entry barrier in health. PRUWell Medical is the wellness-rewarded alternative; PRUWell Health and PRUPrime Healthcare Plus Pro are PAYDI rider versions.",
    bestFor: "Customers wanting straightforward bill-payer health cover with rewards for not claiming.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 11,
    defaultAttackPlan: {
      goodFit: "Customers wanting straightforward bill-payer health cover with rewards for not claiming.",
      opening: "You want bill-payer health cover without complications, and PRUSehat delivers that cleanly.",
      benefits: [
        "8 plan options covering room type, room price ceiling, and region.",
        "As-billed inpatient reimbursement.",
        "Annual limit up to Rp65 billion with Limit Booster.",
        "30 days pre and 90 days post outpatient surgery covered.",
        "Outpatient cancer treatment and dialysis covered without prior inpatient.",
        "No Claim Bonus: +10% annual limit per claim-free year, capped at +50%.",
      ],
      fullScript: "You want bill-payer health cover without complications, and PRUSehat delivers that cleanly. You pick from 8 plan tiers based on room type, room price ceiling, and region. Each claim-free year gives you a 10% boost to the annual limit, capped at 50%, so being healthy is directly rewarded. The annual limit can reach Rp65 billion with Limit Booster, and outpatient cancer or dialysis is covered without requiring prior inpatient. PRUWell Medical is the alternative if you want premium discounts for engaging with wellness; PRUSehat is the simpler bill-payer choice. Shall I run an illustration at the plan tier that matches your preferred hospital and room?",
      objectionTheySay: "I already have health coverage through my office.",
      objectionYouSay: SEED_REPLY_BY_NEED['health'],
      nextAction: "Shall I run an illustration at the plan tier that matches your preferred hospital and room?",
    },
  },
  {
    code: 'PRUWELL_MEDICAL',
    name: "PRUWell Medical",
    channel: 'conventional',
    category: 'health',
    primaryNeeds: ["health"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [2, 3, 4, 5, 6],
    tagline: "Wellness-rewarded health; up to 20% premium discount.",
    benefits: [
      "PRUWell fairness feature: up to 20% premium discount the following year based on healthy lifestyle and claims behavior.",
      "Plans from Bronze A to Diamond with region, room type, and room ceiling flexibility.",
      "Annual benefit up to Rp72.5 billion with Limit Booster.",
      "Telehealth in Indonesia; cancer telehealth in Malaysia and Singapore (select plans).",
      "Palliative care, traditional treatment, physiotherapy, occupational and speech therapy.",
    ],
    differentiator: "The wellness-priced traditional health option. Higher annual cap (Rp72.5B) than PRUSehat. Pure traditional structure, not a PAYDI rider. PRUSehat is the No-Claim-Bonus alternative; PRUWell Health is the unit-linked rider version.",
    bestFor: "Health-conscious customers willing to engage with wellness for ongoing premium savings.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 12,
    defaultAttackPlan: {
      goodFit: "Health-conscious customers willing to engage with wellness for ongoing premium savings.",
      opening: "You're health-conscious, and the wellness reward in PRUWell Medical converts that directly into premium savings.",
      benefits: [
        "PRUWell fairness feature: up to 20% premium discount the following year based on healthy lifestyle and claims behavior.",
        "Plans from Bronze A to Diamond with region, room type, and room ceiling flexibility.",
        "Annual benefit up to Rp72.5 billion with Limit Booster.",
        "Telehealth in Indonesia; cancer telehealth in Malaysia and Singapore (select plans).",
        "Palliative care, traditional treatment, physiotherapy, occupational and speech therapy.",
      ],
      fullScript: "You're health-conscious, and the wellness reward in PRUWell Medical converts that directly into premium savings. You can receive up to 20% premium discount the following year based on your healthy lifestyle and claims behavior. Annual benefit reaches Rp72.5 billion with Limit Booster, which is higher than PRUSehat. The plan range spans Bronze A to Diamond with telehealth in Indonesia and cancer telehealth in Malaysia and Singapore at select tiers. Compared with PRUWell Health which packages the same wellness mechanic as a unit-linked rider, PRUWell Medical is the pure traditional structure. Would you like an illustration showing your projected premium with the wellness discount applied?",
      objectionTheySay: "I already have health coverage through my office.",
      objectionYouSay: SEED_REPLY_BY_NEED['health'],
      nextAction: "Would you like an illustration showing your projected premium with the wellness discount applied?",
    },
  },
  {
    code: 'PRUWELL_HEALTH',
    name: "PRUWell Health",
    channel: 'conventional',
    category: 'health',
    primaryNeeds: ["health"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [3, 4, 5, 6],
    tagline: "Same fairness benefits, packaged as a unit-linked rider.",
    benefits: [
      "Same benefit table and PRUWell mechanic as PRUWell Medical.",
      "Attached as a rider to a unit-linked (PAYDI) base policy; insurance cost paid from cash value.",
      "Premium holiday possible once policy builds sufficient cash value.",
      "Entry up to age 75; annual benefit up to Rp72.5 billion.",
    ],
    differentiator: "The PAYDI rider version of PRUWell Medical. Adds cash-value flexibility (premium holiday) to the wellness pricing engine. Requires PAYDI base. PRUWell Medical is the pure traditional alternative; PRUPrime Healthcare Plus Pro is the premium-tier PAYDI rider.",
    bestFor: "Existing PAYDI policyholders consolidating wellness-priced health into one statement.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 13,
    defaultAttackPlan: {
      goodFit: "Existing PAYDI policyholders consolidating wellness-priced health into one statement.",
      opening: "Since you already have a PAYDI base policy, the smart move is to add health cover that draws from your existing cash value.",
      benefits: [
        "Same benefit table and PRUWell mechanic as PRUWell Medical.",
        "Attached as a rider to a unit-linked (PAYDI) base policy; insurance cost paid from cash value.",
        "Premium holiday possible once policy builds sufficient cash value.",
        "Entry up to age 75; annual benefit up to Rp72.5 billion.",
      ],
      fullScript: "Since you already have a PAYDI base policy, the smart move is to add health cover that draws from your existing cash value. PRUWell Health gives you the same wellness reward mechanism as PRUWell Medical, up to 20% premium discount, but the insurance cost is paid from your unit-linked cash value. After the cash value builds sufficiently, you can take a premium holiday. Annual benefit reaches Rp72.5 billion with Limit Booster. PRUWell Medical is the pure traditional alternative if you'd rather not link it to your investment policy. Shall I model how this would attach to your current PAYDI policy?",
      objectionTheySay: "I already have health coverage through my office.",
      objectionYouSay: SEED_REPLY_BY_NEED['health'],
      nextAction: "Shall I model how this would attach to your current PAYDI policy?",
    },
  },
  {
    code: 'PRUPRIME_HEALTHCARE_PLUS_PRO',
    name: "PRUPrime Healthcare Plus Pro",
    channel: 'conventional',
    category: 'health',
    primaryNeeds: ["health"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [3, 4, 5, 6],
    tagline: "Premium as-billed health rider for unit-linked policies.",
    benefits: [
      "Plans Bronze A through Diamond with room and region tiers.",
      "As-billed inpatient including 2 lowest-bed-class room rate flexibility.",
      "Pro-rata claim if insured stays in higher room class or treats outside region.",
      "PRUPrime Limit Booster lifts annual cap.",
      "Renewable cover to age 99 (within PAYDI base policy).",
    ],
    differentiator: "The premium-tier PAYDI rider. Deeper plan range than PRUWell Health and a pro-rata claim mechanic for over-class room or out-of-region treatment. Two distinct pricing philosophies in the unit-linked health stack; PRUWell Health emphasizes wellness, this one emphasizes plan depth.",
    bestFor: "PAYDI policyholders wanting top-tier hospital and surgical bill cover.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 14,
    defaultAttackPlan: {
      goodFit: "PAYDI policyholders wanting top-tier hospital and surgical bill cover.",
      opening: "For clients who want premium-tier hospital cover packaged with their unit-linked policy, this is the top of the PAYDI rider shelf.",
      benefits: [
        "Plans Bronze A through Diamond with room and region tiers.",
        "As-billed inpatient including 2 lowest-bed-class room rate flexibility.",
        "Pro-rata claim if insured stays in higher room class or treats outside region.",
        "PRUPrime Limit Booster lifts annual cap.",
        "Renewable cover to age 99 (within PAYDI base policy).",
      ],
      fullScript: "For clients who want premium-tier hospital cover packaged with their unit-linked policy, this is the top of the PAYDI rider shelf. PRUPrime Healthcare Plus Pro spans Bronze A through Diamond plans with as-billed inpatient cover. The pro-rata claim mechanic kicks in if you stay in a higher room class or treat outside your covered region, so you have flexibility without losing all the cover. PRUPrime Limit Booster lifts the annual cap further. Compared with PRUWell Health which rewards wellness behavior, PRUPrime Healthcare Plus Pro focuses on plan depth and claim flexibility. Would you like to compare the two at your typical room and region preferences?",
      objectionTheySay: "I already have health coverage through my office.",
      objectionYouSay: SEED_REPLY_BY_NEED['health'],
      nextAction: "Would you like to compare the two at your typical room and region preferences?",
    },
  },
  {
    code: 'PRUSEHAT_SYARIAH',
    name: "PRUSehat Syariah",
    channel: 'syariah',
    category: 'health',
    primaryNeeds: ["health"],
    eligibleAgeBands: [1, 2, 3, 4, 5],
    eligibleBudgetBands: [2, 3, 4, 5, 6],
    tagline: "Sharia mirror of PRUSehat; surplus underwriting potential.",
    benefits: [
      "Same 8-plan structure, room and region flexibility as PRUSehat.",
      "As-billed inpatient, annual limit up to Rp65 billion with Limit Booster.",
      "Outpatient cancer and dialysis covered without prior inpatient.",
      "Surplus underwriting: share of unused tabarru fund returned to participants if no claims (if available).",
      "Manfaat Berkembang: 10% annual limit growth if claim-free, up to 50% of initial limit.",
    ],
    differentiator: "The sharia counterpart of PRUSehat. Adds surplus underwriting and growing benefit on top of the standard No-Claim-Bonus mechanic. Same plan structure and economics as conventional PRUSehat with sharia governance overlay.",
    bestFor: "Muslim customers wanting straightforward as-billed health with sharia governance.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 15,
    defaultAttackPlan: {
      goodFit: "Muslim customers wanting straightforward as-billed health with sharia governance.",
      opening: "For sharia-compliant bill-payer health, PRUSehat Syariah mirrors the conventional PRUSehat structure with the same 8 plan tiers and Rp65 billion annual cap.",
      benefits: [
        "Same 8-plan structure, room and region flexibility as PRUSehat.",
        "As-billed inpatient, annual limit up to Rp65 billion with Limit Booster.",
        "Outpatient cancer and dialysis covered without prior inpatient.",
        "Surplus underwriting: share of unused tabarru fund returned to participants if no claims (if available).",
        "Manfaat Berkembang: 10% annual limit growth if claim-free, up to 50% of initial limit.",
      ],
      fullScript: "For sharia-compliant bill-payer health, PRUSehat Syariah mirrors the conventional PRUSehat structure with the same 8 plan tiers and Rp65 billion annual cap. The two sharia-specific features are surplus underwriting potential and Manfaat Berkembang. Surplus underwriting means any unused tabarru fund may be returned to participants if no claims are made. Manfaat Berkembang grows your annual limit by 10% each claim-free year, capped at 50% of initial limit. The plan structure and economics are identical to conventional PRUSehat with the sharia governance overlay. Shall I model the projected surplus return at your preferred plan tier?",
      objectionTheySay: "I already have health coverage through my office.",
      objectionYouSay: SEED_REPLY_BY_NEED['health'],
      nextAction: "Shall I model the projected surplus return at your preferred plan tier?",
    },
  },
  {
    code: 'PRUWELL_MEDICAL_SYARIAH',
    name: "PRUWell Medical Syariah",
    channel: 'syariah',
    category: 'health',
    primaryNeeds: ["health"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [2, 3, 4, 5, 6],
    tagline: "Sharia mirror of PRUWell Medical; wellness reward mechanic.",
    benefits: [
      "Same PRUWell fairness feature: up to 20% next-year contribution discount.",
      "Same plan range, room and region flexibility, Rp72.5B cap with Limit Booster.",
      "Telehealth Indonesia plus cancer telehealth Malaysia and Singapore (select plans).",
      "Sharia fund management under tabarru / ujrah structure.",
    ],
    differentiator: "The sharia counterpart of PRUWell Medical. Adds sharia governance to the wellness-priced fairness engine. PRUWell Health Syariah is the PAYDI rider version with surplus underwriting potential.",
    bestFor: "Health-conscious muslim customers wanting wellness-priced sharia health.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 16,
    defaultAttackPlan: {
      goodFit: "Health-conscious muslim customers wanting wellness-priced sharia health.",
      opening: "The wellness reward mechanism in PRUWell Medical Syariah is sharia-compliant:",
      benefits: [
        "Same PRUWell fairness feature: up to 20% next-year contribution discount.",
        "Same plan range, room and region flexibility, Rp72.5B cap with Limit Booster.",
        "Telehealth Indonesia plus cancer telehealth Malaysia and Singapore (select plans).",
        "Sharia fund management under tabarru / ujrah structure.",
      ],
      fullScript: "The wellness reward mechanism in PRUWell Medical Syariah is sharia-compliant: up to 20% next-year contribution discount based on healthy lifestyle. The plan range, room and region flexibility, and Rp72.5 billion cap with Limit Booster mirror conventional PRUWell Medical. Sharia fund management runs under tabarru and ujrah structures. Compared with PRUWell Health Syariah which packages this as a rider with surplus underwriting potential, the standalone version doesn't require a PAYDI base. Shall I run an illustration showing the wellness contribution discount at your chosen plan?",
      objectionTheySay: "I already have health coverage through my office.",
      objectionYouSay: SEED_REPLY_BY_NEED['health'],
      nextAction: "Shall I run an illustration showing the wellness contribution discount at your chosen plan?",
    },
  },
  {
    code: 'PRUWELL_HEALTH_SYARIAH',
    name: "PRUWell Health Syariah",
    channel: 'syariah',
    category: 'health',
    primaryNeeds: ["health"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [3, 4, 5, 6],
    tagline: "Sharia PRUWell rider with surplus underwriting potential.",
    benefits: [
      "Same benefit and fairness mechanic as PRUWell Health.",
      "Rider attached to a sharia PAYDI base.",
      "Insurance cost charged from cash value; premium holiday possible after build-up.",
      "Surplus underwriting potential each calendar year (if available).",
    ],
    differentiator: "The sharia rider version of PRUWell Medical. Wellness pricing plus sharia surplus return possibility unavailable to conventional buyers. PRUPrime Healthcare Plus Pro Syariah is the premium-tier sharia PAYDI health rider alternative.",
    bestFor: "Sharia PAYDI policyholders wanting wellness-priced health with surplus participation.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 17,
    defaultAttackPlan: {
      goodFit: "Sharia PAYDI policyholders wanting wellness-priced health with surplus participation.",
      opening: "Since you have a sharia PAYDI base, this rider gives you the same wellness mechanic plus a sharia-specific feature unavailable on the conventional side:",
      benefits: [
        "Same benefit and fairness mechanic as PRUWell Health.",
        "Rider attached to a sharia PAYDI base.",
        "Insurance cost charged from cash value; premium holiday possible after build-up.",
        "Surplus underwriting potential each calendar year (if available).",
      ],
      fullScript: "Since you have a sharia PAYDI base, this rider gives you the same wellness mechanic plus a sharia-specific feature unavailable on the conventional side: surplus underwriting potential each calendar year. The contribution is charged from your cash value, and once the cash value builds sufficiently, you can take a contribution holiday. The wellness fairness engine and the surplus return work together: healthy lifestyle reduces your contribution, and unused tabarru can come back to participants. Shall I model both the contribution discount and projected surplus return?",
      objectionTheySay: "I already have health coverage through my office.",
      objectionYouSay: SEED_REPLY_BY_NEED['health'],
      nextAction: "Shall I model both the contribution discount and projected surplus return?",
    },
  },
  {
    code: 'PRUPRIME_HEALTHCARE_PLUS_PRO_SYARIAH',
    name: "PRUPrime Healthcare Plus Pro Syariah",
    channel: 'syariah',
    category: 'health',
    primaryNeeds: ["health"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [3, 4, 5, 6],
    tagline: "Top-tier sharia health rider, sharia-governed.",
    benefits: [
      "Plan range Bronze A to Diamond, same as conventional.",
      "As-billed inpatient with pro-rata claim mechanic.",
      "PRUPrime Limit Booster up to high-tier coverage.",
      "Sharia fund management.",
    ],
    differentiator: "The premium-tier sharia PAYDI rider. Plan-depth focused, with a pro-rata claim mechanic for over-class room or out-of-region treatment. PRUWell Health Syariah is the wellness-priced sharia rider alternative.",
    bestFor: "Sharia PAYDI policyholders wanting top-tier hospital and surgical cover.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 18,
    defaultAttackPlan: {
      goodFit: "Sharia PAYDI policyholders wanting top-tier hospital and surgical cover.",
      opening: "For premium sharia health cover attached to your PAYDI base, this is the top tier.",
      benefits: [
        "Plan range Bronze A to Diamond, same as conventional.",
        "As-billed inpatient with pro-rata claim mechanic.",
        "PRUPrime Limit Booster up to high-tier coverage.",
        "Sharia fund management.",
      ],
      fullScript: "For premium sharia health cover attached to your PAYDI base, this is the top tier. The plan range spans Bronze A to Diamond with as-billed inpatient cover, and the pro-rata claim mechanic gives you flexibility on room class or region treatment without losing the cover entirely. PRUPrime Limit Booster lifts the annual cap to top-tier levels. Compared with PRUWell Health Syariah which emphasizes wellness rewards, this product emphasizes plan depth and claim flexibility. Shall I compare both options at your typical hospital and region preferences?",
      objectionTheySay: "I already have health coverage through my office.",
      objectionYouSay: SEED_REPLY_BY_NEED['health'],
      nextAction: "Shall I compare both options at your typical hospital and region preferences?",
    },
  },
  {
    code: 'PRUPERSONAL_ACCIDENT_D_D_PLUS',
    name: "PRUPersonal Accident D&D Plus",
    channel: 'conventional',
    category: 'health',
    primaryNeeds: ["accident"],
    eligibleAgeBands: [1, 2, 3, 4],
    eligibleBudgetBands: [1, 2],
    tagline: "Accident-only rider: death, disability, fractures, burns.",
    benefits: [
      "Accidental death cover.",
      "Total and permanent disability cover from accident.",
      "Complex fracture lump-sum benefit.",
      "Burns benefit based on burn severity.",
      "Emergency outpatient reimbursement from accident.",
    ],
    differentiator: "The conventional accident-only product. Does not cover illness. Affordable, typically attached as a rider over a life or health policy. Sharia counterpart is PRUPersonal Accident D&D Plus Syariah with identical economic structure.",
    bestFor: "High-mobility customers and clients wanting accident top-up over a base policy.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 19,
    defaultAttackPlan: {
      goodFit: "High-mobility customers and clients wanting accident top-up over a base policy.",
      opening: "Given the lifestyle you described, the accident-specific risk is real and the cover should match it.",
      benefits: [
        "Accidental death cover.",
        "Total and permanent disability cover from accident.",
        "Complex fracture lump-sum benefit.",
        "Burns benefit based on burn severity.",
        "Emergency outpatient reimbursement from accident.",
      ],
      fullScript: "Given the lifestyle you described, the accident-specific risk is real and the cover should match it. PRUPersonal Accident D&D Plus is purpose-built for accident risk: accidental death, total and permanent disability, complex fractures, burns, and emergency outpatient costs. It doesn't cover illness, by design, which keeps the premium affordable. This product attaches as a rider on top of a base policy, so it complements rather than replaces your main health cover. Shall I show you the benefit amounts at different sum assured levels?",
      objectionTheySay: "I think I'm already covered for that.",
      objectionYouSay: SEED_REPLY_BY_NEED['accident'],
      nextAction: "Shall I show you the benefit amounts at different sum assured levels?",
    },
  },
  {
    code: 'PRUPERSONAL_ACCIDENT_D_D_PLUS_SYARIAH',
    name: "PRUPersonal Accident D&D Plus Syariah",
    channel: 'syariah',
    category: 'health',
    primaryNeeds: ["accident"],
    eligibleAgeBands: [1, 2, 3, 4],
    eligibleBudgetBands: [1, 2],
    tagline: "Sharia accident rider: death, disability, fractures, burns.",
    benefits: [
      "Accidental death, total and permanent disability, complex fracture, burns, emergency outpatient.",
      "Sharia fund management with tabarru contribution.",
    ],
    differentiator: "The sharia accident-only product. Mirror of PRUPersonal Accident D&D Plus with sharia fund management overlay.",
    bestFor: "Muslim customers wanting sharia-compliant accident top-up.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 20,
    defaultAttackPlan: {
      goodFit: "Muslim customers wanting sharia-compliant accident top-up.",
      opening: "The sharia version of accident cover mirrors the conventional structure under sharia governance.",
      benefits: [
        "Accidental death, total and permanent disability, complex fracture, burns, emergency outpatient.",
        "Sharia fund management with tabarru contribution.",
      ],
      fullScript: "The sharia version of accident cover mirrors the conventional structure under sharia governance. Accidental death, total and permanent disability, complex fractures, burns, and emergency outpatient costs are all covered, with tabarru contribution. It doesn't cover illness, by design. This rider attaches over a sharia base policy. Shall I outline the benefit amounts at different sum assured tiers?",
      objectionTheySay: "I think I'm already covered for that.",
      objectionYouSay: SEED_REPLY_BY_NEED['accident'],
      nextAction: "Shall I outline the benefit amounts at different sum assured tiers?",
    },
  },
  {
    code: 'PRUCRITICAL_BENEFIT_88',
    name: "PRUCritical Benefit 88",
    channel: 'conventional',
    category: 'ci',
    primaryNeeds: ["ci"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [2, 3, 4, 5, 6],
    tagline: "Premium critical-illness lump-sum with death benefit.",
    benefits: [
      "Lump-sum payout on diagnosis of a covered critical condition.",
      "Death benefit if no CI claim has been triggered.",
      "Coverage profile extending to age 88.",
      "Premium options: regular premium and single premium.",
      "Designed for income-replacement during recovery and lifestyle-adjustment.",
    ],
    differentiator: "The flagship conventional standalone CI product. Single-premium variant is rare and capital-efficient. Death benefit ensures the contribution is not lost if no CI ever triggers. PRULady is the women-specific breast-cancer alternative.",
    bestFor: "Wage-earners seeking large lump-sum income replacement on critical diagnosis.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 21,
    defaultAttackPlan: {
      goodFit: "Wage-earners seeking large lump-sum income replacement on critical diagnosis.",
      opening: "Critical illness is the financial event that derails most working families: the income stops, the bills don't.",
      benefits: [
        "Lump-sum payout on diagnosis of a covered critical condition.",
        "Death benefit if no CI claim has been triggered.",
        "Coverage profile extending to age 88.",
        "Premium options: regular premium and single premium.",
        "Designed for income-replacement during recovery and lifestyle-adjustment.",
      ],
      fullScript: "Critical illness is the financial event that derails most working families: the income stops, the bills don't. PRUCritical Benefit 88 pays a lump-sum on diagnosis of a covered critical condition, giving you income replacement during treatment and recovery. There's also a death benefit, so if you never need the CI payout, the contribution isn't lost. You can pay regular premium or single premium, which is rare in CI and capital-efficient for clients with available capital. PRULady is the women-specific alternative focused on breast cancer; PRUCritical Benefit 88 is the broad-CI choice. Shall I prepare an illustration showing both regular and single premium structures?",
      objectionTheySay: "I hope I never have to use it.",
      objectionYouSay: SEED_REPLY_BY_NEED['ci'],
      nextAction: "Shall I prepare an illustration showing both regular and single premium structures?",
    },
  },
  {
    code: 'PRULADY',
    name: "PRULady",
    channel: 'conventional',
    category: 'ci',
    primaryNeeds: ["ci"],
    eligibleAgeBands: [2, 3],
    eligibleBudgetBands: [1, 2],
    tagline: "Breast cancer protection for women, up to 140% of sum assured.",
    benefits: [
      "Early-stage breast cancer benefit.",
      "Late-stage breast cancer benefit.",
      "Surgery and reconstructive surgery benefit.",
      "Additional late-stage critical condition benefit for female-only conditions.",
      "Cumulative payout up to 140% of sum assured.",
      "PRULady Save: premium discount for regular health check-up.",
    ],
    differentiator: "The only women-specific CI product on the shelf. Stage-based payouts and reconstructive surgery cover are unusual in the broader CI category. PRUCritical Benefit 88 is the broad-CI alternative if breast cancer is not the primary concern.",
    bestFor: "Women prioritizing breast-cancer cover with reconstructive options.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 22,
    defaultAttackPlan: {
      goodFit: "Women prioritizing breast-cancer cover with reconstructive options.",
      opening: "For women, breast cancer is a real and well-documented risk, and PRULady is built specifically around it.",
      benefits: [
        "Early-stage breast cancer benefit.",
        "Late-stage breast cancer benefit.",
        "Surgery and reconstructive surgery benefit.",
        "Additional late-stage critical condition benefit for female-only conditions.",
        "Cumulative payout up to 140% of sum assured.",
        "PRULady Save: premium discount for regular health check-up.",
      ],
      fullScript: "For women, breast cancer is a real and well-documented risk, and PRULady is built specifically around it. The payouts are staged: early stage, late stage, surgery, and reconstructive surgery, with cumulative payouts up to 140% of sum assured. The reconstructive surgery cover specifically is unusual in the broader CI category. There's also a PRULady Save feature: premium discount for regular health check-ups. PRUCritical Benefit 88 is the alternative if you'd prefer broad-CI cover instead of dedicated breast-cancer protection. Shall I model the staged payouts at your preferred sum assured?",
      objectionTheySay: "I hope I never have to use it.",
      objectionYouSay: SEED_REPLY_BY_NEED['ci'],
      nextAction: "Shall I model the staged payouts at your preferred sum assured?",
    },
  },
  {
    code: 'PRUSOLUSI_KONDISI_KRITIS_SYARIAH',
    name: "PRUSolusi Kondisi Kritis Syariah",
    channel: 'syariah',
    category: 'ci',
    primaryNeeds: ["ci"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [1, 2],
    tagline: "Affordable sharia CI with stage-based payouts.",
    benefits: [
      "Coverage across critical conditions with stage-based payouts (early and late).",
      "Tabarru-based with potential surplus underwriting return.",
      "Economical contribution positioning for mass-affluent muslim market.",
      "Sharia-compliant fund management.",
    ],
    differentiator: "The entry-level sharia CI option. Positioned below PRUCritical Amanah on price; aimed at broadening sharia CI penetration in the mass-affluent segment.",
    bestFor: "Mass-affluent muslim customers needing CI at affordable contribution.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 23,
    defaultAttackPlan: {
      goodFit: "Mass-affluent muslim customers needing CI at affordable contribution.",
      opening: "For mass-affluent muslim customers wanting CI without a premium-tier contribution, this is the entry point.",
      benefits: [
        "Coverage across critical conditions with stage-based payouts (early and late).",
        "Tabarru-based with potential surplus underwriting return.",
        "Economical contribution positioning for mass-affluent muslim market.",
        "Sharia-compliant fund management.",
      ],
      fullScript: "For mass-affluent muslim customers wanting CI without a premium-tier contribution, this is the entry point. The stage-based payouts cover early and late stages, and the fund is tabarru-based with potential surplus underwriting return. The economics are positioned to broaden sharia CI penetration. Compared with PRUCritical Amanah which covers 61 conditions including early diagnoses at a premium-tier contribution, this one prioritizes affordability. Shall I show both contribution levels for comparison?",
      objectionTheySay: "I hope I never have to use it.",
      objectionYouSay: SEED_REPLY_BY_NEED['ci'],
      nextAction: "Shall I show both contribution levels for comparison?",
    },
  },
  {
    code: 'PRUCRITICAL_AMANAH',
    name: "PRUCritical Amanah",
    channel: 'syariah',
    category: 'ci',
    primaryNeeds: ["ci"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [2, 3, 4, 5, 6],
    tagline: "Comprehensive sharia CI with 61 conditions, early diagnosis cover.",
    benefits: [
      "Coverage of 61 critical conditions, including early-stage diagnoses.",
      "Premium sharia CI positioning, comparable to PRUCritical Benefit 88 on the conventional side.",
      "Multi-stage payout structure; lump-sum on diagnosis.",
      "Sharia fund management.",
    ],
    differentiator: "The premium-tier sharia CI option. 61 conditions, early-stage capture. Equivalent of conventional PRUCritical Benefit 88 on the sharia side. PRUSolusi Kondisi Kritis Syariah is the affordable entry-level sharia CI alternative.",
    bestFor: "Affluent muslim clients wanting top-tier CI with early-diagnosis payout.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 24,
    defaultAttackPlan: {
      goodFit: "Affluent muslim clients wanting top-tier CI with early-diagnosis payout.",
      opening: "Comprehensive sharia CI with early-stage capture is what PRUCritical Amanah delivers.",
      benefits: [
        "Coverage of 61 critical conditions, including early-stage diagnoses.",
        "Premium sharia CI positioning, comparable to PRUCritical Benefit 88 on the conventional side.",
        "Multi-stage payout structure; lump-sum on diagnosis.",
        "Sharia fund management.",
      ],
      fullScript: "Comprehensive sharia CI with early-stage capture is what PRUCritical Amanah delivers. The product covers 61 critical conditions, including diagnoses at the early stage when treatment is most effective. The multi-stage payout structure gives you lump-sum on diagnosis at each covered stage. This is the sharia equivalent of conventional PRUCritical Benefit 88 in coverage depth. PRUSolusi Kondisi Kritis Syariah is the affordable entry-level sharia CI alternative. Shall I prepare a contribution illustration at the cover level appropriate for your income?",
      objectionTheySay: "I hope I never have to use it.",
      objectionYouSay: SEED_REPLY_BY_NEED['ci'],
      nextAction: "Shall I prepare a contribution illustration at the cover level appropriate for your income?",
    },
  },
  {
    code: 'PRUCERAH',
    name: "PRUCerah",
    channel: 'syariah',
    category: 'education',
    primaryNeeds: ["education"],
    eligibleAgeBands: [2, 3],
    eligibleBudgetBands: [2, 3],
    tagline: "Sharia child-education insurance covering 4 years of college.",
    benefits: [
      "Guaranteed education-fund disbursement during the child's college years (4 years).",
      "Parent protection: premium waiver if the parent dies or is critically ill.",
      "Sharia-compliant fund management.",
      "Designed around Indonesia's education-inflation profile.",
    ],
    differentiator: "The only dedicated education product across both books. Sharia-managed. No conventional alternative exists; conventional clients typically meet education funding through PAYDI (PRULink NextGen).",
    bestFor: "Parents prioritizing dedicated college-fund certainty within a sharia framework.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 25,
    defaultAttackPlan: {
      goodFit: "Parents prioritizing dedicated college-fund certainty within a sharia framework.",
      opening: "You want certainty that your child's college years are funded regardless of what happens to you.",
      benefits: [
        "Guaranteed education-fund disbursement during the child's college years (4 years).",
        "Parent protection: premium waiver if the parent dies or is critically ill.",
        "Sharia-compliant fund management.",
        "Designed around Indonesia's education-inflation profile.",
      ],
      fullScript: "You want certainty that your child's college years are funded regardless of what happens to you. PRUCerah delivers exactly that: guaranteed sharia-compliant education fund disbursement during the four college years. Critically, if you as the parent die or are diagnosed with a critical illness, future contributions are waived but the fund continues to build for your child. It's the only dedicated education product across both books, conventional and sharia. If you're conventional, the typical alternative is to use PRULink NextGen as a long-term investment vehicle targeting the same goal. Shall I prepare an education fund projection based on your child's current age and target university tier?",
      objectionTheySay: "I'll just save for it myself.",
      objectionYouSay: SEED_REPLY_BY_NEED['education'],
      nextAction: "Shall I prepare an education fund projection based on your child's current age and target university tier?",
    },
  },
  {
    code: 'PRULINK_NEXTGEN',
    name: "PRULink NextGen",
    channel: 'conventional',
    category: 'investment',
    primaryNeeds: ["investment"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [3, 4, 5, 6],
    tagline: "Current flagship regular-premium PAYDI; OJK 2022-compliant.",
    benefits: [
      "Entry age up to 75; cover to 75 / 85 / 99 years.",
      "Lower upfront acquisition cost (~40%) spread over 10 years, vs PGB's ~70% over 5 years.",
      "Loyalty Bonus: extra investment allocation in policy years 11 through 20.",
      "200% sum assured on accidental death; 300% during New Year or Idulfitri holiday window.",
      "Life-events benefit: +10% sum assured on marriage or childbirth (no medical check).",
    ],
    differentiator: "The current conventional PAYDI flagship. Compliant with SE OJK 5/SEOJK.05/2022. Better early cash-value formation than PGB. PRULink Investor Account is the single-premium alternative; PRULink Generasi Baru is the pre-2023 legacy product (in run-off).",
    bestFor: "New PAYDI customers seeking long-term protection plus investment.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 26,
    defaultAttackPlan: {
      goodFit: "New PAYDI customers seeking long-term protection plus investment.",
      opening: "You want long-term protection plus investment exposure, and PRULink NextGen is the current conventional PAYDI flagship.",
      benefits: [
        "Entry age up to 75; cover to 75 / 85 / 99 years.",
        "Lower upfront acquisition cost (~40%) spread over 10 years, vs PGB's ~70% over 5 years.",
        "Loyalty Bonus: extra investment allocation in policy years 11 through 20.",
        "200% sum assured on accidental death; 300% during New Year or Idulfitri holiday window.",
        "Life-events benefit: +10% sum assured on marriage or childbirth (no medical check).",
      ],
      fullScript: "You want long-term protection plus investment exposure, and PRULink NextGen is the current conventional PAYDI flagship. The acquisition cost is structured at around 40% spread over 10 years, much lower than the previous PGB structure which front-loaded around 70% over 5 years. Loyalty Bonus kicks in from policy year 11 through 20, giving you extra investment allocation just when the cash value is compounding most usefully. There's a 200% sum assured on accidental death, climbing to 300% during the New Year or Idulfitri holiday window. Life events like marriage or childbirth automatically add 10% sum assured, no medical check. PRULink Investor Account is the single-premium alternative if you'd rather contribute as a lump sum. Shall I prepare a projection at your chosen contribution and investment fund mix?",
      objectionTheySay: "Isn't unit-linked risky?",
      objectionYouSay: SEED_REPLY_BY_NEED['investment'],
      nextAction: "Shall I prepare a projection at your chosen contribution and investment fund mix?",
    },
  },
  {
    code: 'PRULINK_INVESTOR_ACCOUNT',
    name: "PRULink Investor Account",
    channel: 'conventional',
    category: 'investment',
    primaryNeeds: ["investment"],
    eligibleAgeBands: [3, 4, 5],
    eligibleBudgetBands: [7],
    tagline: "Single-premium PAYDI; investment-first with life cover.",
    benefits: [
      "Single lump-sum premium; no recurring premium obligation.",
      "Death benefit = 125% of single premium + cash value (if any).",
      "Total and permanent disability cover (ages 6 to 60), paid 20% then 80% one year later.",
      "Maturity = cash value at end of policy term.",
    ],
    differentiator: "The only single-premium PAYDI in the catalog. Investment-led with thin protection wrapper. Designed for lump-sum allocation rather than savings discipline. PRULink NextGen is the regular-premium flagship alternative.",
    bestFor: "Lump-sum investors wanting investment exposure with light life cover.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 27,
    defaultAttackPlan: {
      goodFit: "Lump-sum investors wanting investment exposure with light life cover.",
      opening: "For clients with available capital who want investment exposure without recurring premium obligations, the single-premium structure is the right fit.",
      benefits: [
        "Single lump-sum premium; no recurring premium obligation.",
        "Death benefit = 125% of single premium + cash value (if any).",
        "Total and permanent disability cover (ages 6 to 60), paid 20% then 80% one year later.",
        "Maturity = cash value at end of policy term.",
      ],
      fullScript: "For clients with available capital who want investment exposure without recurring premium obligations, the single-premium structure is the right fit. PRULink Investor Account accepts your lump-sum contribution, gives you 125% of premium as sum assured plus accumulated cash value as death benefit, and provides total and permanent disability cover for ages 6 to 60 with a 20%-then-80% payout structure. At maturity, you receive the cash value. Compared with PRULink NextGen which builds investment via regular premium discipline, this product is for lump-sum allocators. Shall I model fund performance scenarios at your contribution level?",
      objectionTheySay: "Isn't unit-linked risky?",
      objectionYouSay: SEED_REPLY_BY_NEED['investment'],
      nextAction: "Shall I model fund performance scenarios at your contribution level?",
    },
  },
  {
    code: 'PRULINK_GENERASI_BARU_PGB',
    name: "PRULink Generasi Baru (PGB)",
    channel: 'conventional',
    category: 'investment',
    primaryNeeds: ["investment"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [3, 4, 5, 6],
    tagline: "Pre-2023 regular-premium PAYDI; in run-off for new business.",
    benefits: [
      "PRUbooster Investasi: automatic annual investment top-up allocation.",
      "PRUbooster Proteksi: automatic annual sum-assured increase without medical declaration.",
      "Investment allocation from day 1.",
      "200% sum assured on accidental death.",
      "Wide range of fund options.",
    ],
    differentiator: "Pre-2023 conventional PAYDI, replaced by PRULink NextGen for new business post-6 March 2023. Higher upfront acquisition cost (~70%) but over a shorter 5-year amortization. In run-off; not actively issued.",
    bestFor: "Existing PGB policyholders (legacy book); not actively issued to new applicants.",
    lifecycle: 'closed_to_new_business',
    activeByDefault: false,
    sortOrder: 28,
    defaultAttackPlan: {
      goodFit: "Existing PGB policyholders (legacy book); not actively issued to new applicants.",
      opening: "",
      benefits: [
        "PRUbooster Investasi: automatic annual investment top-up allocation.",
        "PRUbooster Proteksi: automatic annual sum-assured increase without medical declaration.",
        "Investment allocation from day 1.",
        "200% sum assured on accidental death.",
        "Wide range of fund options.",
      ],
      fullScript: "",
      objectionTheySay: "Isn't unit-linked risky?",
      objectionYouSay: SEED_REPLY_BY_NEED['investment'],
      nextAction: "",
    },
  },
  {
    code: 'PRULINK_NEXTGEN_SYARIAH',
    name: "PRULink NextGen Syariah",
    channel: 'syariah',
    category: 'investment',
    primaryNeeds: ["investment"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [3, 4, 5, 6],
    tagline: "Flagship sharia PAYDI with Umroh / Haji accident enhancement.",
    benefits: [
      "Same NextGen structure: entry to 75; cover to 75 / 85 / 99 years.",
      "Loyalty Bonus year 11 through 20.",
      "300% sum assured on accidental death during Umroh, Haji, or holiday windows.",
      "Life-events benefit: +10% sum assured on marriage or childbirth.",
      "Sharia-compliant fund management.",
    ],
    differentiator: "The current sharia PAYDI flagship. Same structure as PRULink NextGen with Umroh / Haji windows substituted for New Year / Idulfitri on the 300% accidental death enhancement. PRULink Syariah Investor Account is the single-contribution alternative; PRULink Syariah Generasi Baru is the legacy product (in run-off).",
    bestFor: "Muslim clients wanting comprehensive long-term sharia PAYDI.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 29,
    defaultAttackPlan: {
      goodFit: "Muslim clients wanting comprehensive long-term sharia PAYDI.",
      opening: "For muslim clients planning Umroh or Haji, this product builds specifically around that life context.",
      benefits: [
        "Same NextGen structure: entry to 75; cover to 75 / 85 / 99 years.",
        "Loyalty Bonus year 11 through 20.",
        "300% sum assured on accidental death during Umroh, Haji, or holiday windows.",
        "Life-events benefit: +10% sum assured on marriage or childbirth.",
        "Sharia-compliant fund management.",
      ],
      fullScript: "For muslim clients planning Umroh or Haji, this product builds specifically around that life context. PRULink NextGen Syariah pays 300% sum assured on accidental death during the Umroh, Haji, or holiday windows, on top of the regular 200% accidental death cover. The NextGen structure, including Loyalty Bonus from year 11 through 20 and life-events benefit on marriage or childbirth, applies in sharia-compliant form. The fund management runs under sharia principles throughout. PRULink Syariah Investor Account is the single-contribution alternative for lump-sum investors. Shall I prepare a projection that accounts for your Umroh or Haji timing?",
      objectionTheySay: "Isn't unit-linked risky?",
      objectionYouSay: SEED_REPLY_BY_NEED['investment'],
      nextAction: "Shall I prepare a projection that accounts for your Umroh or Haji timing?",
    },
  },
  {
    code: 'PRULINK_SYARIAH_INVESTOR_ACCOUNT',
    name: "PRULink Syariah Investor Account",
    channel: 'syariah',
    category: 'investment',
    primaryNeeds: ["investment"],
    eligibleAgeBands: [3, 4, 5],
    eligibleBudgetBands: [7],
    tagline: "Single-contribution sharia PAYDI for lump-sum investors.",
    benefits: [
      "One-time sharia contribution; no recurring commitment.",
      "Sharia-managed investment fund options.",
      "Sum assured at 125% of single contribution plus cash value.",
      "TPD and maturity benefits matching conventional structure.",
    ],
    differentiator: "The sharia mirror of PRULink Investor Account. Only single-contribution PAYDI on the sharia shelf.",
    bestFor: "Muslim lump-sum investors wanting sharia-compliant investment exposure.",
    lifecycle: 'active',
    activeByDefault: true,
    sortOrder: 30,
    defaultAttackPlan: {
      goodFit: "Muslim lump-sum investors wanting sharia-compliant investment exposure.",
      opening: "The sharia single-contribution PAYDI is for muslim clients with available capital who want investment exposure with light life cover.",
      benefits: [
        "One-time sharia contribution; no recurring commitment.",
        "Sharia-managed investment fund options.",
        "Sum assured at 125% of single contribution plus cash value.",
        "TPD and maturity benefits matching conventional structure.",
      ],
      fullScript: "The sharia single-contribution PAYDI is for muslim clients with available capital who want investment exposure with light life cover. You contribute once, receive 125% of the contribution as sum assured plus accumulated cash value, and the fund is managed under sharia principles. TPD and maturity benefits mirror the conventional structure. Compared with PRULink NextGen Syariah which builds investment via regular contribution, this product is for lump-sum allocators. Shall I walk through the sharia fund options at your intended contribution level?",
      objectionTheySay: "Isn't unit-linked risky?",
      objectionYouSay: SEED_REPLY_BY_NEED['investment'],
      nextAction: "Shall I walk through the sharia fund options at your intended contribution level?",
    },
  },
  {
    code: 'PRULINK_SYARIAH_GENERASI_BARU_PSGB',
    name: "PRULink Syariah Generasi Baru (PSGB)",
    channel: 'syariah',
    category: 'investment',
    primaryNeeds: ["investment"],
    eligibleAgeBands: [2, 3, 4],
    eligibleBudgetBands: [3, 4, 5, 6],
    tagline: "Pre-2023 sharia regular-contribution PAYDI; in run-off.",
    benefits: [
      "Sharia PRUbooster Investasi: automatic annual investment top-up.",
      "Sharia PRUbooster Proteksi: automatic annual sum-assured increase without health declaration.",
      "Sharia fund options across multiple risk profiles.",
    ],
    differentiator: "Pre-2023 sharia PAYDI. Replaced by PRULink NextGen Syariah for new business post-6 March 2023. In run-off.",
    bestFor: "Existing PSGB policyholders (legacy book); not actively issued to new applicants.",
    lifecycle: 'closed_to_new_business',
    activeByDefault: false,
    sortOrder: 31,
    defaultAttackPlan: {
      goodFit: "Existing PSGB policyholders (legacy book); not actively issued to new applicants.",
      opening: "",
      benefits: [
        "Sharia PRUbooster Investasi: automatic annual investment top-up.",
        "Sharia PRUbooster Proteksi: automatic annual sum-assured increase without health declaration.",
        "Sharia fund options across multiple risk profiles.",
      ],
      fullScript: "",
      objectionTheySay: "Isn't unit-linked risky?",
      objectionYouSay: SEED_REPLY_BY_NEED['investment'],
      nextAction: "",
    },
  },
] as const;
