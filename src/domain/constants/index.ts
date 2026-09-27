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
  LEADS_TO_APPOINTMENT_PCT: 30,
  CLOSING_RATE_PCT: 30,
  /** Months-left is clamped to this floor so the cascade never divides by ~0. Overall.html:5752. */
  MONTHS_LEFT_MIN: 0.1,
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
 */
export const CASCADE_ACTIVITY_CODES = {
  leadsCode: 'LEADS_CONTACTED',
  appointmentsCode: 'SELL_PRESENTATION',
  closingsCode: 'SELL_SUBMISSION',
} as const;

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
} as const;

/** 90-day activation programme. Overall.html:3270-3352. Tenant-configurable window. */
export const ACTIVATION = {
  WINDOW_DAYS: 90,
  /** The day counter is 1-based: the start date itself is Day 1. Overall.html:6615. */
  DAY_INDEX_BASE: 1,
} as const;

/** Leader and owner surfaces. Overall.html:7040, KPM_Owner.html:1006-1048. */
export const PERFORMANCE = {
  /** At or above this share of expected goal pace reads as On track. Overall.html:7043. */
  ON_TRACK_PACE_THRESHOLD: 0.9,
  /** A 1:1 older than this is rendered overdue. Overall.html:7359. */
  COACHING_OVERDUE_DAYS: 7,
  /** Activity-logging compliance window. KPM_Owner.html:964. */
  COMPLIANCE_WINDOW_DAYS: 7,
  /** Ratio computation window. Overall.html:5200. Tenant-configurable. */
  RATIO_WINDOW_DAYS: 30,
  /** Attainment percentages are displayed capped at this. Overall.html:6303. */
  ATTAINMENT_PCT_CAP: 999,
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
 */
export const DEFAULT_ORG_LADDER = [
  { code: 'AGENT', label: 'Agent', displayOrder: 1 },
  { code: 'AAB', label: 'AAB', displayOrder: 2 },
  { code: 'AB', label: 'AB', displayOrder: 3 },
] as const;

/** Currency minor units. IDR sen: 100 minor units to the rupiah. */
export const MINOR_UNITS_PER_MAJOR = 100;
export const DEFAULT_CURRENCY = 'IDR';

export {
  SEED_RATIO_DEFINITIONS,
  type SeedRatioDefinition,
  SEED_ACTIVITY_CATEGORIES,
  SEED_ACTIVITY_TYPES,
  SEED_LEAD_STATUSES,
  type SeedActivityCategory,
  type SeedActivityType,
  type SeedLeadStatus,
} from './activity-taxonomy';

export {
  TRAINING_PUBLISH_STATES,
  type TrainingPublishState,
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
  type ActivationLinkKind,
  SEED_ACTIVATION_ASPECTS,
  SEED_ACTIVATION_ITEMS,
  type SeedActivationAspect,
  type SeedActivationItem,
  activationLinkKind,
  mayTickByHand,
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
  SEED_PRODUCTS,
  type SeedProduct,
  type SeedAttackPlan,
  // P5-T5: what an office decides about a product it sells.
  PRODUCT_DOCUMENT_SLOTS,
  type ProductDocumentSlot,
  SCRIPT_REVIEW_STATES,
  type ScriptReviewState,
  OVERRIDABLE_PRODUCT_FIELDS,
  type OverridableProductField,
  SCRIPT_OVERRIDE_FIELDS,
} from './product-catalog';

export { ASSET_LIMITS } from './assets';
export { PRODUCTION, PRODUCTION_UPLOAD } from './production';

export {
  EVENT_ISSUERS,
  type EventIssuer,
  EVENT_AUDIENCE_SCOPES,
  type EventAudienceScope,
  SELECT_AUDIENCE_SCOPES,
  EVENT_PHASES,
  type EventPhase,
  SEED_EVENT_TYPES,
} from './events';

export {
  METRIC_UNITS,
  type MetricUnit,
  type MetricDefinition,
  METRIC_REGISTRY,
  metricByKey,
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
} from './metrics';

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
