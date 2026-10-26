/**
 * An office's campaigns, as the agent's *Campaigns* screen draws them (Phase 18.5, P18.5-T7, T8; D-fields,
 * D-windows, D-lists; `metrics-and-definitions.md` §B.22).
 *
 * Every word and number a campaign screen needs that is not the office's own data lives here once, and is served
 * to the screen rather than re-declared there (invariant §7).
 */

/** *Seasonal* — a dated contest; *Structural* — a standing programme: a promotion path or an ongoing incentive (`Overall.html:3667-3670`). */
export const CAMPAIGN_KINDS = ['seasonal', 'structural'] as const;
export type CampaignKind = (typeof CAMPAIGN_KINDS)[number];

/** A structural campaign's section: *Promotion Criteria* or *Production Clubs* (`Overall.html:3697-3701`). */
export const CAMPAIGN_SUBTYPES = ['promotion', 'ongoing'] as const;
export type CampaignSubtype = (typeof CAMPAIGN_SUBTYPES)[number];

/**
 * **The three windows v1 evaluates over** (D-windows), all in the office's calendar (`Asia/Jakarta`, ADR-0016):
 *
 * - `campaign_dates` — the campaign's own dates; **whole office months** when any requirement reads the monthly
 *   file, any days for activity. A seasonal campaign's only window.
 * - `calendar_year` — January to December, recurring: a year to date while it runs (MDRT). Keyed by the year.
 * - `rolling_12m` — the last twelve months the office holds, as of today (the promotion paths). Never final.
 *
 * The prototype's *first 90 days of licensing* and *per month* are deferred (two of its nine examples).
 */
export const CAMPAIGN_WINDOWS = ['campaign_dates', 'calendar_year', 'rolling_12m'] as const;
export type CampaignWindow = (typeof CAMPAIGN_WINDOWS)[number];

/** The windows a structural campaign may take; a seasonal one is always `campaign_dates`. */
export const STRUCTURAL_CAMPAIGN_WINDOWS: readonly CampaignWindow[] = ['calendar_year', 'rolling_12m'];

/**
 * **The poster's colours, as token names** — the prototype's seven raw hexes (`Overall.html:7925-8021`: `#F2994A`,
 * `#D97F30`, `#1B2B4B`, `#2E4370`, `#5F5E5A`, `#3B6D11`, `#C9A227`) mapped to the design tokens the screen paints
 * with (`tokens.md`); never a hex in the record.
 */
export const CAMPAIGN_POSTER_COLORS = ['amber', 'amber-dark', 'navy', 'navy-soft', 'muted', 'success', 'gold'] as const;
export type CampaignPosterColor = (typeof CAMPAIGN_POSTER_COLORS)[number];

/** A campaign with no poster of its own — and every campaign written before the field (migration `0027`). */
export const DEFAULT_CAMPAIGN_POSTER: { readonly emoji: string; readonly color: CampaignPosterColor } = {
  emoji: '🎯', color: 'navy',
};

/** The bounds of what an Owner types into a campaign's new fields (D-fields). */
export const CAMPAIGN_LIMITS = {
  /** The card's one-line blurb (`Overall.html:8040-8074`); the prototype's longest is 81 characters. */
  BLURB_MAX: 200,
  /** One emoji, which may be several code points (🎖️ is two, a flag four); a word is refused by length. */
  POSTER_EMOJI_MAX: 8,
} as const;

/**
 * **The code *Chasing MDRT* binds to** (ADR-0122, glossary *MDRT*): the Unit Dashboard's ✓ is a member chasing the
 * office's campaign of this code, not ended. The column is drawn whether or not the office runs one.
 */
export const MDRT_CAMPAIGN_CODE = 'MDRT_QUALIFICATION';

/**
 * **What a window reads as on the card and in the dialog**, verbatim where the prototype writes one
 * (`Overall.html:7972`, `:8012`) but for its dates, which are written the Indonesian way (ADR-0167 §1) — *1 Jan –
 * 31 Des* where it wrote *Jan 1 – Dec 31*; a campaign's own dates are composed in the office's calendar instead.
 */
export const CAMPAIGN_DURATION_WORDS: Readonly<Record<Exclude<CampaignWindow, 'campaign_dates'>, string>> = {
  calendar_year: 'Standing — evaluated per calendar year (1 Jan – 31 Des)',
  rolling_12m: 'Rolling 12-month window',
};

/** The rolling window's length, in months held (`Overall.html:7972`, *"Rolling 12-month window"*). */
export const CAMPAIGN_ROLLING_MONTHS = 12;

/**
 * *Chasing MDRT*'s header tooltip (OD-152 → option 3, D-18): the prototype's opening, then the office's MDRT
 * requirement in words — or, with no MDRT campaign running, saying so. *"…based on annual FYC pace"* is not
 * shipped: the ✓ is a chase, not a pace, and FYC is not in the file.
 */
export const MDRT_TOOLTIP = {
  OPENING: 'Chasing MDRT (Million Dollar Round Table) this year',
  /** ADR-0142 §3, verbatim: *"Chasing MDRT (Million Dollar Round Table) this year. No MDRT campaign is running."* */
  NONE: 'No MDRT campaign is running.',
} as const;

/**
 * `CAMPAIGN_QUALIFICATION_STATUS`'s values (§A.6; ADR-0143): a chaser is `qualified`, `in_progress`, `not_met` or
 * `unknown`; a member who did not chase is `not_joined` — only a chaser can qualify, and the Phase 18.6 tree reads
 * `not_joined` as *Not achieved*.
 */
export const CAMPAIGN_QUALIFICATION_STATUSES = ['qualified', 'in_progress', 'not_met', 'unknown', 'not_joined'] as const;
export type CampaignQualificationStatus = (typeof CAMPAIGN_QUALIFICATION_STATUSES)[number];

/** A campaign code the agent's routes reserve: `/campaigns/chasing` is the chases read, not a campaign. */
export const RESERVED_CAMPAIGN_CODES: readonly string[] = ['CHASING'];
