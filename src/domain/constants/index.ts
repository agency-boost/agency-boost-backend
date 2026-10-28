/**
 * The single source of truth for every benchmark, threshold and conversion factor.
 *
 * Each value is documented once in docs/00-product/metrics-and-definitions.md with a
 * prototype citation, and pinned here by a test that fails if it drifts. Nothing may
 * re-declare these — not another module, not the frontend. See
 * .claude/rules/domain-invariants.md §7.
 *
 * "Tenant-configurable" values are the *platform defaults* copied into a KPM at
 * provisioning. Runtime code reads the tenant's own value; these are the seed.
 */

import type { LeaderTier } from './leader-tier';

export { RATIO_BENCHMARKS } from './benchmarks';
export {
  RATIO_DISPLAY_UNITS,
  type RatioDisplayUnit,
  type DisplayUnitResolution,
  resolveDisplayUnit,
  defaultDisplayUnitFor,
} from './ratio-display';

/** Goal calculator defaults. Overall.html:2872-2996, :5919-5940. All tenant-configurable. */
export const GOAL_DEFAULTS = {
  ANNUAL_APE_TARGET_MINOR: 500_000_000_00,
  ANNUAL_SAVINGS_TARGET_MINOR: 50_000_000_00,
  COMMISSION_RATE_PCT: 10,
  CASE_SIZE_MINOR: 18_000_000_00,
  /**
   * The two conversion percentages, **now the fallback** (ADR-0160 §3): a new plan opens on the office's
   * own benchmarks (`GOAL_DEFAULT_RATIOS`), and these only where the office has no usable one.
   */
  LEADS_TO_APPOINTMENT_PCT: 30,
  CLOSING_RATE_PCT: 30,
  /** Months-left is clamped to this floor so the cascade never divides by ~0. Overall.html:5752. */
  MONTHS_LEFT_MIN: 0.1,
} as const;

/**
 * **Which of the office's ratios each of the goal's two percentages defaults from** (ADR-0160 §3), by
 * ratio code (invariant §4). The client relates *Closing rate* to *Selling success rate* and *Appointment
 * to Sales meeting* to *Set appointment to meeting*; with the seeded benchmarks those are 30% and 50%.
 *
 * A **benchmark**, not the agent's measured history, so ADR-0048's rejection of "default from measured"
 * stands; a saved goal keeps its own percentages. An office without the ratio — or whose benchmark is no
 * percentage a plan can use — falls back to `GOAL_DEFAULTS`.
 */
export const GOAL_DEFAULT_RATIOS = {
  closingRatePct: 'SELLING_SUCCESS_RATE',
  leadsToApptPct: 'MEETING_PER_APPROACH',
} as const;

/**
 * The three activity codes the goal cascade's columns count against (P8-T1).
 *
 * **Codes, and the whole point is that they are not numbers.** The prototype's tip reads *"Maps to
 * activities #3, #4, #6 in Activity Management"* (`Overall.html:3010`) — and those are **display
 * order**, which the Owner's settings screen lets an office drag. An office that reordered its list
 * would silently rebind every goal in it to three different activities, which is invariant §4 in one
 * sentence.
 *
 * Here rather than in the goals module because two things will read them: the cascade, and whatever
 * measures an agent against it (Phase 10). One source, per invariant §7.
 *
 * **The default binding's codes, and no longer what anything counts** (ADR-0163, P18.9-T2). Each office binds
 * its own codes to the three roles (`activityBindings`), and every count reads them through
 * `ActivityBindingService.resolveCascadeBinding`. These are what `defaultBinding()` names: what a template
 * without a binding gives its offices, and what migration `0034` wrote into every office and template.
 */
export const CASCADE_ACTIVITY_CODES = {
  leadsCode: 'LEADS_CONTACTED',
  appointmentsCode: 'SELL_PRESENTATION',
  closingsCode: 'SELL_SUBMISSION',
} as const;

/**
 * **The most activity type codes one cascade stage may bind** (ADR-0163 §1): an activity replaced, and replaced
 * again, with room to spare. A binding naming more is refused by `bindingProblems`.
 */
export const BINDING_CODES_MAX = 10;

/**
 * Time conversion. These are *projection* constants for the goal cascade — they never
 * define a period boundary. A calendar month is a calendar month in the tenant timezone.
 * Overall.html:5751, :5818, :7023.
 */
export const TIME = {
  AVG_DAYS_PER_MONTH: 30.44,
  WEEKS_PER_MONTH: 4.33,
  MONTHS_PER_YEAR: 12,
  MS_PER_DAY: 86_400_000,
} as const;

/**
 * The named periods' lengths (ADR-0022, resolving OD-11).
 *
 * **Fixed, not an office setting.** *"Last 30 days"* has to mean thirty days in every office, or two
 * offices' ratios under one name are two different numbers. `kpms.settings.ratioWindowDays` exists and
 * was read for `ROLLING_30D` until P10-T1, against ADR-0022 and against `metrics-and-definitions.md`
 * §B.1, which class the window *Fixed*; no route ever wrote it, so no office moved.
 */
export const PERIOD = {
  ROLLING_7D_DAYS: 7,
  ROLLING_30D_DAYS: 30,
} as const;

/** Activity logging. Overall.html clamp helper. */
export const ACTIVITY = {
  COUNT_MIN: 0,
  /** Per item, per day. Tenant-configurable via kpms.settings.activityDailyMaxCount. */
  COUNT_MAX: 999,
  /**
   * How many days into the next month a day stays freely editable (ADR-0042, resolving OD-17).
   *
   * An agent logs freely within the **current calendar month** plus this many days into the next,
   * and a future date is never valid. After the window the day is frozen: a correction is still
   * possible and writes a new version carrying a reason, so this bounds *silent* editing rather
   * than editing. Tenant-configurable, because month-end differs by office.
   */
  BACKDATE_GRACE_DAYS: 7,
  /**
   * The Activity Dashboard (P10-T1). A custom range up to this many days is shown a column a day —
   * a month fits whatever its length …
   */
  DASHBOARD_DAILY_MAX_DAYS: 31,
  /** … and above it, in blocks of this many days counted back from the range's end, as *Last 30 days* is. */
  DASHBOARD_BLOCK_DAYS: 7,
  /**
   * The longest range the Dashboard shows: a year, a leap day included. Longer is **refused, not cut** —
   * the prototype silently kept the latest 30 days of whatever was asked for.
   */
  DASHBOARD_RANGE_MAX_DAYS: 366,
} as const;

/** The Personal Summary (P10-T4). */
export const SUMMARY = {
  /**
   * `SUMMARY_PACE_WINDOW_DAYS`: the days, today included, whose closings the pace sentence says the
   * member is *tracking to close* (ADR-0109) — the prototype's `days = 30` for the month
   * (`Overall.html:6295`), summed by `sumActivitySharedDays(6, days)` (`:6316`). Derived, not restated:
   * it is `ROLLING_30D` (ADR-0022). It replaced ADR-0057's run-rate and its `PACE_MIN_DAYS` of 7.
   */
  PACE_WINDOW_DAYS: PERIOD.ROLLING_30D_DAYS,
  /**
   * How many of a member's open leads *Leads that need you* lists, nearest next action first (P10-T6).
   * The prototype lists every one; a summary of two hundred rows is the Leads screen without its search,
   * so the card shows the nearest and counts the rest, with the way to all of them.
   */
  LEADS_SHOWN: 10,
} as const;

/**
 * A monthly activity target pro-rated to the last 7 days (P11-T4): `SUB_PERIOD_ACTIVITY_TARGET`, the
 * coaching session's Activity card (`Overall.html:7023`, `:7055-7061`). Both **Fixed**
 * (`metrics-and-definitions.md` §B.3, §B.4).
 */
export const SUB_PERIOD = {
  /**
   * `SUB_PERIOD_TARGET_SCALING`: the prototype's `PERIOD_MULT['7'] = 7 / 30.44`. Derived, not restated —
   * the 7-day window over `DAYS_PER_MONTH_AVG` — so neither number has a second home (invariant §7).
   */
  TARGET_SCALING: PERIOD.ROLLING_7D_DAYS / TIME.AVG_DAYS_PER_MONTH,
  /**
   * `SUB_PERIOD_CLOSING_TARGET_FLOOR`: a week of a month that needs any closing at all asks for at least
   * one (`Overall.html:7061`). A month that needs none asks for none.
   */
  CLOSING_TARGET_FLOOR: 1,
} as const;

/**
 * The Personal Summary's insight cards (P10-T7, ADR-0060): named rules over registered metrics, computed
 * on read. Every threshold a rule reads is here, once (invariant §7).
 */
export const INSIGHTS = {
  /** At most this many cards, taken in the rules' fixed priority (ADR-0060). */
  MAX_CARDS: 4,
  /**
   * A ratio says something about a member only over this many of its denominator. The engine answers any
   * denominator above zero — correctly — but *1 of 2 presentations* is an anecdote, and a card built on
   * one tells an agent to change what they do on the strength of a coin toss.
   */
  RATIO_MIN_DENOMINATOR: 5,
  /** *Well above* its benchmark — a strength worth naming — is at least this multiple of it. */
  STRENGTH_FACTOR: 1.5,
} as const;

/** 90-day activation programme. Overall.html:3270-3352. Tenant-configurable window. */
export const ACTIVATION = {
  WINDOW_DAYS: 90,
  /** The day counter is 1-based: the start date itself is Day 1. Overall.html:6615. */
  DAY_INDEX_BASE: 1,
  /**
   * **How long an activation, and its menu, last** (OD-120): until graduation, or this many calendar
   * months after the start date in the office's timezone, whichever is first — the footer's own rule,
   * *"Visible only to new agents, for their first 6 months"* (Overall.html:3349). A month-end start
   * ends on the last day of the shorter month: 31 August ends on the last day of February. Derived on
   * every read from the start date and the office's today, never by a job.
   */
  VISIBLE_MONTHS: 6,
  /**
   * **How far back a leader may correct a start date** (OD-118): the office's today at the latest, and
   * at most this many days before it. A date further back would start an activation that ended long ago.
   */
  START_DATE_MAX_DAYS_BACK: 365,
  /** The hire's own *Note (optional)* on a manual item (`:6603`), in characters. */
  HIRE_NOTE_MAX: 500,
  /** The leader's *Coaching note* to a hire (`:3408-3412`, OD-117), in characters, after trimming. */
  COACHING_NOTE_MAX: 1000,
} as const;

/** Leader and owner surfaces. Overall.html:7040, KPM_Owner.html:1006-1048. */
export const PERFORMANCE = {
  /**
   * At or above this share of expected goal pace reads as On track. Overall.html:7043. The document's
   * `PACE_ON_TRACK_RATIO`: one constant under two names, and the office's `onTrackPaceThreshold`
   * falls back to it (ADR-0080).
   */
  ON_TRACK_PACE_THRESHOLD: 0.9,
  /**
   * `PACING_TO_MAA`'s gate (P11-T6): a month whose logged activity projects at least this many policy
   * submissions is pacing to MAA. Overall.html:7038, :3932. **Fixed**, not an office setting: it encodes
   * *at least one policy*, which is what active means, and a setting would let an office redefine it
   * (`metrics-and-definitions.md` §B.4).
   */
  MAA_PROJECTED_SUBMISSIONS_MIN: 1,
  /** A 1:1 older than this is rendered overdue. Overall.html:7359. */
  COACHING_OVERDUE_DAYS: 7,
  /** Activity-logging compliance window. KPM_Owner.html:964. */
  COMPLIANCE_WINDOW_DAYS: 7,
  /** Ratio computation window. Overall.html:5200. **Fixed** — it is `ROLLING_30D` (ADR-0022). */
  RATIO_WINDOW_DAYS: PERIOD.ROLLING_30D_DAYS,
  /** Attainment percentages are displayed capped at this. Overall.html:6303. */
  ATTAINMENT_PCT_CAP: 999,
} as const;

/** Coaching sessions (P11-T5; `functional/coaching.md`, *The session*). */
export const COACHING = {
  /**
   * `COACHING_REOPEN_WINDOW_DAYS` (§B.8, ADR-0079): a finalized session may be reopened, with a reason,
   * until this many days after its `date` — the office's day of its **first** finalize — inclusive.
   * Finalizing a correction does not restart it. **Fixed**, not an office setting: coverage, promotion
   * cases and MOC evidence rely on these records, and the window binds the coach, the Owner and the
   * Admin alike.
   */
  REOPEN_WINDOW_DAYS: 7,
  /**
   * `COACHING_COVERAGE_WINDOWS` (§B.4, P11-T10 AC-5): the two windows `COACHING_COVERAGE` is read over,
   * the primary first — `COACHED_7D`'s and `COACHED_30D`'s, the named periods' own lengths
   * (`KPM_Owner.html:1014`, `:1018`). **Fixed**: the window is part of the label, always.
   */
  COVERAGE_WINDOWS: [PERIOD.ROLLING_7D_DAYS, PERIOD.ROLLING_30D_DAYS] as readonly number[],
} as const;

/**
 * The tenant's canonical timezone default. Not from the prototype — the prototype
 * generates date keys in UTC, which is the defect this replaces
 * (docs/02-specs/design-system/prototype-parity.md F-01).
 */
export const DEFAULT_TENANT_TIMEZONE = 'Asia/Jakarta';

/**
 * The ladder a new company starts with — Prudential's, which every company in v1 shares
 * (`AgencyBoost_Superadmin.html:311`).
 *
 * A company **must** have one. `memberships.orgLevelId` references a rung, and every join
 * resolves it from the office's company, so a company with no ladder is an office nobody
 * can join — and nothing would say so until somebody tried. ADR-0012 §3 settles that v1
 * ships one seeded ladder, so this is the seed, not a guess.
 *
 * The codes are upper-cased `HierarchyRole` values, which is what makes v1's reference and
 * enum one-to-one and lets the enum keep working while the reference becomes the truth.
 *
 * Super Admin edits it afterwards at `/admin/org-levels`. Junior first.
 *
 * **Each rung carries its leader tier** (ADR-0156): AB is the *Senior Leader*, AAB the *Associate Leader*,
 * Agent none — the tiers migration 0030 gives every existing company's rungs of those codes.
 */
export const DEFAULT_ORG_LADDER = [
  { code: 'AGENT', label: 'Agent', displayOrder: 1, leaderTier: null },
  { code: 'AAB', label: 'AAB', displayOrder: 2, leaderTier: 'associate' },
  { code: 'AB', label: 'AB', displayOrder: 3, leaderTier: 'senior' },
] as const satisfies ReadonlyArray<{ code: string; label: string; displayOrder: number; leaderTier: LeaderTier | null }>;

/** Currency minor units. IDR sen: 100 minor units to the rupiah. */
export const MINOR_UNITS_PER_MAJOR = 100;
export const DEFAULT_CURRENCY = 'IDR';

export {
  SEED_RATIO_DEFINITIONS,
  SEED_RATIO_PURPOSES,
  type SeedRatioDefinition,
  SEED_ACTIVITY_CATEGORIES,
  SEED_ACTIVITY_TYPES,
  SEED_LEAD_STATUSES,
  // P18.95-T9 AC-6 (ADR-0167 §10): the recruitment first status's earlier words, for migration 0038 only.
  SEEDED_LEAD_STATUS_LABELS_BEFORE_ADR_0167,
  type SeedActivityCategory,
  type SeedActivityType,
  type SeedLeadStatus,
} from './activity-taxonomy';

export {
  TRAINING_PUBLISH_STATES,
  type TrainingPublishState,
  TRAINING_STATUSES,
  type TrainingStatus,
  SEED_TRAINING_CATEGORIES,
  SEED_TRAINING_SKILLS,
  SEED_TRAINING_MODULES,
  type SeedTrainingCategory,
  type SeedTrainingSkill,
  type SeedTrainingModule,
} from './training-taxonomy';

export {
  ACTIVATION_FEATURE_LINKS,
  type ActivationFeatureLink,
  ACTIVATION_TRAINING_LINK_PREFIX,
  ACTIVATION_LINK_KINDS,
  ACTIVATION_TRAINING_LINK,
  ACTIVATION_ACTIVITY_WEEKS,
  ACTIVATION_FIRST_CASE_CODE,
  type ActivationLinkKind,
  SEED_ACTIVATION_ASPECTS,
  SEED_ACTIVATION_ITEMS,
  type SeedActivationAspect,
  type SeedActivationItem,
  activationLinkKind,
  activationLinkKinds,
  mayTickByHand,
  // P18.96-T4 (ADR-0171 §3): the data-backed items, bound by code.
  ACTIVATION_DATA_LINKS,
  type ActivationDataLink,
  type ActivationNamedLink,
  ACTIVATION_DATA_LINK_KINDS,
  type ActivationDataLinkKind,
  ACTIVATION_CODE_BOUND_LINKS,
  ACTIVATION_INDEPENDENT_CLOSINGS,
  ACTIVATION_WEEKLY_CHECK_INS,
  FIRST_SALE_STAGE_CODE,
  type ActivationRecordForm,
  isActivationDataLink,
  effectiveAutoLink,
  recordFormOf,
  dataItemHandWrite,
} from './activation-checklist';

export {
  PRODUCT_CHANNELS,
  type ProductChannel,
  PRODUCT_CATEGORIES,
  type ProductCategory,
  PRODUCT_NEEDS,
  type ProductNeed,
  PRODUCT_LIFECYCLES,
  type ProductLifecycle,
  PRODUCT_AGE_BANDS,
  PRODUCT_BUDGET_BANDS,
  PRODUCT_AGE_BAND_LABELS,
  PRODUCT_BUDGET_BAND_LABELS,
  // P18.95-T6 (UI-030): the band the brief asks as its own option, not a monthly one.
  PRODUCT_LUMP_SUM_BUDGET_BAND,
  SEED_PRODUCTS,
  type SeedProduct,
  type SeedAttackPlan,
  // P5-T5: what an office decides about a product it sells.
  PRODUCT_DOCUMENT_SLOTS,
  type ProductDocumentSlot,
  PRODUCT_DOCUMENT_FOLDER,
  PRODUCT_DOCUMENT_LABEL_MAX_LENGTH,
  SCRIPT_REVIEW_STATES,
  type ScriptReviewState,
  OVERRIDABLE_PRODUCT_FIELDS,
  type OverridableProductField,
  SCRIPT_OVERRIDE_FIELDS,
  // Phase 14: the office's description held for approval (OD-136), and the seeded reply (D-reply).
  APPROVED_PRODUCT_FIELDS,
  PRODUCT_TAGLINE_MAX_LENGTH,
  SEED_REPLY_BY_NEED,
} from './product-catalog';

/** The Sales Attack Plan's scorer, and the words the two sales screens print (D-scoring, D-copy). */
export {
  ATTACK_PLAN,
  PRODUCT_NEED_LABELS,
  PRODUCT_CATEGORY_LABELS,
  PRODUCT_CHANNEL_LABELS,
  PRODUCT_RUN_OFF_NOTE,
} from './attack-plan';

export { ASSET_LIMITS, DOCUMENT_MIME_TYPES } from './assets';
export { PRODUCTION, PRODUCTION_UPLOAD } from './production';

// Phase 15: the Unit Dashboard's periods, its save's bound, and the reason a leader's correction carries.
export {
  UNIT_DASHBOARD,
  UNIT_DASHBOARD_CORRECTION_REASON,
  type UnitDashboardPeriod,
} from './unit-dashboard';

export {
  EVENT_ISSUERS,
  type EventIssuer,
  EVENT_AUDIENCE_SCOPES,
  type EventAudienceScope,
  SELECT_AUDIENCE_SCOPES,
  EVENT_PHASES,
  type EventPhase,
  SEED_EVENT_TYPES,
  // P18.5-T5, T6: the attendance statuses (D-status), the NPS scale and the feedback text's limit.
  EVENT_ATTENDANCE_STATUSES,
  type EventAttendanceStatus,
  NPS,
  EVENT_FEEDBACK_TEXT_MAX,
} from './events';

export {
  METRIC_UNITS,
  type MetricUnit,
  type MetricDefinition,
  METRIC_REGISTRY,
  metricByKey,
  REQUIREMENT_METRICS,
  CAMPAIGN_METRICS,
  isCampaignMetric,
  type CampaignReading,
  CAMPAIGN_EVALUATION_PHASE,
  REQUIREMENT_COMPARATORS,
  type RequirementComparator,
  QUALIFICATION_RULE_KINDS,
  type QualificationRuleKind,
  QUALIFICATION_RULE_SCOPES,
  type QualificationRuleScope,
  CRITERIA_MODES,
  type CriteriaMode,
  SEED_PRODUCTION_CLUB_TIERS,
  SEED_MOC_RULES,
  MOC_PERSISTENCY_MIN_PCT,
} from './metrics';

// Phase 18.5: an office's campaigns as the agent reads them — kinds, windows, the poster palette, MDRT's code.
export {
  CAMPAIGN_KINDS,
  type CampaignKind,
  CAMPAIGN_SUBTYPES,
  type CampaignSubtype,
  CAMPAIGN_WINDOWS,
  type CampaignWindow,
  STRUCTURAL_CAMPAIGN_WINDOWS,
  CAMPAIGN_POSTER_COLORS,
  type CampaignPosterColor,
  DEFAULT_CAMPAIGN_POSTER,
  CAMPAIGN_LIMITS,
  MDRT_CAMPAIGN_CODE,
  CAMPAIGN_DURATION_WORDS,
  CAMPAIGN_ROLLING_MONTHS,
  MDRT_TOOLTIP,
  CAMPAIGN_QUALIFICATION_STATUSES,
  type CampaignQualificationStatus,
  RESERVED_CAMPAIGN_CODES,
} from './campaigns';

// Phase 18: the Owner's reporting — the analytics' periods, the monthly chart's length and MOC's two months.
export {
  KPM_REPORTING,
  type KpmAnalyticsPeriod,
} from './reporting';

// Phase 18.1: the Strategic Leader Forum — how long a shared link opens, and the bounds of what leaders type.
export {
  LEADER_MEETING_SHARE_DAYS,
  LEADER_MEETING_SHARE_TOKEN_BYTES,
  LEADER_MEETING_LIMITS,
} from './leader-forum';

export {
  type CapabilityMilestone,
  type CapabilityStage,
  type CapabilityGridItem,
  type CapabilityGrid,
  SEED_CAPABILITY_MILESTONES,
  SEED_CAPABILITY_STAGES,
  SEED_CAPABILITY_GRIDS,
  capabilityStageFor,
} from './capability';

export {
  CALENDAR,
  CALENDAR_ENTRY_TYPES,
  type CalendarEntryType,
  CALENDAR_ALL_DAY_TYPE,
} from './calendar';

export { INBOX_PAGE } from './notifications';

// P13.2-T2: the quote tool's price table, served to the Super Admin alone (ADR-0111).
export {
  BILLING_CURRENCY,
  BILLING_ANNUAL_DISCOUNT_PCT,
  BILLING_PRICE_TIERS,
  type BillingTier,
} from './billing';

/** An office's subscription bounds (ADR-0112; P13.2-T3). */
export { SUBSCRIPTION } from './subscription';

/** A rung's leader tier, the class it gives its members, and the classes the leader limit counts (ADR-0156). */
export {
  LEADER_TIERS,
  LEADER_CLASSES,
  LEGACY_TIER_BY_CODE,
  ROLE_CLASS_BY_TIER,
  RUNG_SHORT_CODE_MAX_LENGTH,
  isLeaderClass,
  roleClassOf,
  shortOfRung,
  tierOfRung,
  type LeaderTier,
  type RoleClass,
} from './leader-tier';

/** A person's join date in an office and who it makes them, decided once (ADR-0169; P18.96-T2). */
export {
  JOINING,
  INVITES,
  // The P18.96 exit review, L2: sign-ups from one address an hour.
  REGISTRATION,
  // P18.96-T6 (ADR-0171 §2, ADR-0173): the 90 days a first sale activates in, and the year `/new-hires` lists.
  ACTIVATION_3M,
  JOINED_AS,
  type JoinedAs,
  joinedAsFor,
  joinDateViolation,
} from './joining';

/** A named template's name bounds (ADR-0115 §3; P13.2-T6, T7), which the frontend's constant is pinned to. */
export { TEMPLATE } from './templates';

// Phase 17: the candidate brief's vocabulary, the office's four pitch slots and their completion rule, and
// the playbook a company started from the defaults is given (D-vocabulary, D-slots, OD-88).
export {
  RECRUITMENT,
  RECRUITMENT_CANDIDATE_TYPES,
  RECRUITMENT_MOTIVATIONS,
  RECRUITMENT_HESITATIONS,
  RECRUITMENT_PITCH_SLOTS,
  RECRUITMENT_PITCH_STATES,
  SEED_RECRUITMENT_PLAYBOOK,
  recruitmentPitchState,
  recruitmentPitchDone,
  type RecruitmentTypeCode,
  type RecruitmentMotivationCode,
  type RecruitmentHesitationCode,
  type RecruitmentWords,
  type RecruitmentProfileWords,
  type RecruitmentPlaybookBody,
  type RecruitmentPitchSlotCode,
  type RecruitmentPitchState,
} from './recruitment';

// Phase 18.8: what a person records — the minimum age, gender and work status codes, the agent code's shape (ADR-0158).
export {
  PERSONAL_DATA,
  GENDERS,
  type Gender,
  WORK_STATUSES,
  type WorkStatus,
  AGENT_CODE_PATTERN,
} from './personal-data';
