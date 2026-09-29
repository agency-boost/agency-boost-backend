/**
 * The metric registry, as code (invariant §7, ADR-0035).
 *
 * `docs/00-product/metrics-and-definitions.md` Part A is the definition of each of these; this is
 * the **set of names a requirement may use**, and the phase that first computes each one for real.
 *
 * **One list, not two** (P10-T8). `domain/metrics/registry.ts` carried its own copy — its own names,
 * its own units, and an *available from* that meant something else — and the two disagreed on
 * seventeen phases and a dozen names before anybody compared them. It now **derives** from this one,
 * adding only what a computation needs — the period and the threshold — and refuses at load a metric
 * either side has and the other lacks. `registry.spec.ts` holds both to the document's index.
 *
 * A campaign requirement or a qualification rule may only name a metric this product can compute
 * (ADR-0035). The prototype's requirements are display strings — *"Net APE ≥ Rp 600 juta"* — which
 * nothing can evaluate and nothing can refuse, so a campaign could promise a reward against a number
 * the product never produces.
 */
export interface MetricDefinition {
  readonly key: string;
  readonly name: string;
  readonly unit: MetricUnit;
  /** The roadmap phase that first computes it for real. */
  readonly phase: number;
}

/**
 * What a metric's number means.
 *
 * `idr_minor` is integer sen, never a float and never a display string (invariant §9): the
 * prototype stores *"Rp 600,000,000"* and one campaign's reward in **pesos**. `tri_state` is
 * boolean-or-unknown, and the unknown is load-bearing: an office that has not uploaded a month has
 * no Monthly Active Agents to count, which is not zero of them. `months` is a decimal count of them.
 */
export const METRIC_UNITS = [
  'boolean', 'tri_state', 'count', 'percentage', 'percentage_points', 'ratio', 'days', 'months', 'idr_minor', 'enum', 'score',
] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

export const METRIC_REGISTRY: readonly MetricDefinition[] = [
  { key: 'MONTHLY_ACTIVE_AGENT', name: 'Monthly Active Agent (MAA)', unit: 'tri_state', phase: 9 },
  { key: 'MAA_COUNT_IN_UNIT', name: 'Active agents in unit', unit: 'count', phase: 13 },
  { key: 'PACING_TO_MAA', name: 'Pacing to MAA', unit: 'boolean', phase: 13 },
  { key: 'ACTIVITY_COMPLIANCE_7D', name: 'Activity-logging compliance, last 7 days', unit: 'boolean', phase: 6 },
  { key: 'ACTIVITY_COMPLIANCE_MONTH', name: 'Activity-logging compliance, this month', unit: 'boolean', phase: 6 },
  { key: 'ACTIVITY_COMPLIANCE_RATE', name: 'Activity-logging compliance rate', unit: 'percentage', phase: 13 },
  { key: 'ACTIVITY_TOTAL_BY_CATEGORY', name: 'Logged touches by category', unit: 'count', phase: 6 },
  { key: 'COACHED_7D', name: 'Coached in the last 7 days', unit: 'boolean', phase: 13 },
  { key: 'COACHED_30D', name: 'Coached in the last 30 days', unit: 'boolean', phase: 13 },
  { key: 'DAYS_SINCE_LAST_COACHING', name: 'Days since last 1:1', unit: 'days', phase: 13 },
  { key: 'COACHING_COVERAGE', name: 'Coaching coverage', unit: 'percentage', phase: 13 },
  { key: 'LEADER_COACHING_FREQUENCY', name: 'AB / AAB coaching frequency', unit: 'percentage', phase: 14 },
  { key: 'APE_ACHIEVED', name: 'APE achieved', unit: 'idr_minor', phase: 9 },
  { key: 'APE_TARGET', name: 'APE target', unit: 'idr_minor', phase: 8 },
  { key: 'APE_ATTAINMENT_PCT', name: 'APE achieved vs target', unit: 'percentage', phase: 10 },
  { key: 'APE_GAP_TO_TARGET', name: 'Gap to target', unit: 'idr_minor', phase: 10 },
  { key: 'POLICIES_NEEDED', name: 'Policies still needed', unit: 'count', phase: 10 },
  { key: 'MONTHS_LEFT_IN_YEAR', name: 'Months left in the year', unit: 'months', phase: 8 },
  { key: 'POLICY_COUNT_TARGET', name: 'Policies to close this month', unit: 'count', phase: 8 },
  { key: 'APPOINTMENT_TARGET', name: 'Appointments to hold this month', unit: 'count', phase: 8 },
  { key: 'LEAD_TARGET', name: 'Leads to contact this month', unit: 'count', phase: 8 },
  { key: 'GOAL_PACE_STATUS', name: 'On-track / pace status', unit: 'enum', phase: 13 },
  { key: 'SELLING_RECRUITMENT_BALANCE', name: 'Selling vs Recruitment balance', unit: 'percentage_points', phase: 6 },
  { key: 'SELLING_SUCCESS_RATE', name: 'Selling success rate', unit: 'ratio', phase: 6 },
  { key: 'RECRUITMENT_SUCCESS_RATE', name: 'Recruitment success rate', unit: 'ratio', phase: 6 },
  { key: 'LEADS_PER_ACTIVITY', name: 'Leads per activity', unit: 'ratio', phase: 6 },
  { key: 'MEETING_PER_APPROACH', name: 'Meeting per approach', unit: 'ratio', phase: 6 },
  { key: 'MEASURED_LEAD_TO_APPOINTMENT_RATE', name: 'Your logged leads-to-appointment rate', unit: 'ratio', phase: 10 },
  { key: 'MEASURED_CLOSING_RATE', name: 'Your logged closing rate', unit: 'ratio', phase: 10 },
  { key: 'MONTHLY_APE_TARGET', name: 'This month’s APE target', unit: 'idr_minor', phase: 10 },
  { key: 'PROJECTED_CLOSINGS_THIS_MONTH', name: 'Closings at your current pace', unit: 'count', phase: 10 },
  { key: 'CLOSINGS_NEEDED_PER_WEEK', name: 'Closings needed per week', unit: 'count', phase: 10 },
  { key: 'SUMMARY_ACTIVITY_TARGET', name: 'Activity target for the period', unit: 'count', phase: 10 },
  { key: 'ACTIVITY_TARGET_ATTAINMENT_PCT', name: 'Logged against the activity target', unit: 'percentage', phase: 10 },
  { key: 'ACTIVATION_COMPLETION_PCT', name: 'Activation completion', unit: 'percentage', phase: 11 },
  { key: 'ACTIVATION_DAY_INDEX', name: 'Activation day', unit: 'days', phase: 11 },
  { key: 'TRAINING_COMPLETION_PCT', name: 'Training completion', unit: 'percentage', phase: 12 },
  { key: 'EVENT_ATTENDANCE_STATUS', name: 'Event attendance status', unit: 'enum', phase: 12 },
  { key: 'EVENT_ATTENDANCE_RATE', name: 'Event attendance rate', unit: 'percentage', phase: 14 },
  { key: 'EVENT_NPS', name: 'Event NPS', unit: 'score', phase: 14 },
  { key: 'CAMPAIGN_QUALIFICATION_STATUS', name: 'Campaign qualification', unit: 'enum', phase: 12 },
  { key: 'MOC_STATUS', name: 'Maintenance of Contract', unit: 'boolean', phase: 14 },
  { key: 'PRODUCTION_CLUB_TIER', name: 'Production club tier', unit: 'enum', phase: 14 },
  // Computed since P7-T6, in `LeadService.summary` — the document's index said 14 until P10-T8.
  { key: 'RECRUITMENT_PIPELINE_NOW', name: 'Recruitment pipeline now', unit: 'count', phase: 7 },
  { key: 'RECRUITMENT_EXPECTED_TO_CLOSE', name: 'Expected to close', unit: 'count', phase: 7 },
  { key: 'NEW_ACTIVE_AGENTS', name: 'New active agents', unit: 'count', phase: 9 },
  { key: 'ROLLING_PERSISTENCY', name: 'Rolling persistency', unit: 'percentage', phase: 9 },
];

export const metricByKey = (key: string): MetricDefinition | undefined =>
  METRIC_REGISTRY.find((m) => m.key === key);

/**
 * The phase that evaluates a campaign, which is what a requirement has to be computable by.
 *
 * A requirement naming a metric that arrives later is refused **saying which phase brings it**,
 * rather than being accepted and silently never qualifying anybody.
 */
export const CAMPAIGN_EVALUATION_PHASE = 12;

/** How a requirement compares. */
export const REQUIREMENT_COMPARATORS = ['gte', 'gt', 'lte', 'lt', 'eq'] as const;
export type RequirementComparator = (typeof REQUIREMENT_COMPARATORS)[number];

/** A qualification rule's kinds, and whose they are (ADR-0026, ADR-0035). */
export const QUALIFICATION_RULE_KINDS = ['moc', 'production_club', 'promotion_path'] as const;
export type QualificationRuleKind = (typeof QUALIFICATION_RULE_KINDS)[number];

export const QUALIFICATION_RULE_SCOPES = ['company', 'kpm'] as const;
export type QualificationRuleScope = (typeof QUALIFICATION_RULE_SCOPES)[number];

/** `all` — every criterion; `any` — one is enough. The prototype's MOC has both. */
export const CRITERIA_MODES = ['all', 'any'] as const;
export type CriteriaMode = (typeof CRITERIA_MODES)[number];

const IDR = 100; // sen per rupiah

/**
 * The annual-APE recognition tiers (ADR-0026, P5-T7 AC-5).
 *
 * **The insurer's, not an office's.** A branch manager cannot delete Chairman's Club any more than
 * they can retag their office to another company — which is why the screen shows them read-only,
 * with the reason on the card (parity I-76).
 *
 * Stored in **integer IDR minor units**: the prototype's *"Rp 1.2B"* is a display string, and one of
 * its campaigns is denominated in pesos.
 */
export const SEED_PRODUCTION_CLUB_TIERS = [
  { code: 'STAR_CLUB', name: 'Star Club', minAnnualApe: 1_200_000_000 * IDR, reward: 'Promotion bonus', rank: 1 },
  { code: 'ELITE_CLUB', name: 'Elite Club', minAnnualApe: 2_000_000_000 * IDR, reward: 'Trip qualification', rank: 2 },
  { code: 'CHAIRMANS_CLUB', name: "Chairman's Club", minAnnualApe: 3_500_000_000 * IDR, reward: 'AB override + unit budget', rank: 3 },
] as const;

/**
 * Maintenance of Contract, as the carrier states it (ADR-0026, P5-T7 AC-6).
 *
 * **The thresholds are ported; none of the prototype's derivations are.** The prototype fabricates
 * `monthly2Aa` from a headcount it has to hand, which is a different number wearing the carrier's
 * name. Each criterion below names the metric it needs, and the three the registry does not define
 * yet are listed on the rule — so a screen can say *"waiting on Net APE, which Phase 9 computes"*
 * rather than showing a rule that silently never passes.
 */
export const SEED_MOC_RULES = [
  {
    code: 'MOC_AB',
    name: 'Maintenance of Contract — AB',
    appliesToOrgLevelCodes: ['AB'],
    /** Net APE **and** both Monthly2 AA counts, **or** five direct ABs. */
    criteriaGroups: [
      {
        mode: 'all' as const,
        criteria: [
          { metricKey: 'NET_APE', comparator: 'gte' as const, value: 600_000_000 * IDR },
          { metricKey: 'MONTHLY2_AA_DU', comparator: 'gte' as const, value: 4 },
          { metricKey: 'MONTHLY2_AA_DG', comparator: 'gte' as const, value: 6 },
        ],
      },
      {
        mode: 'all' as const,
        criteria: [{ metricKey: 'DIRECT_AB_COUNT', comparator: 'gte' as const, value: 5 }],
      },
    ],
    /** Groups are ORed: the carrier's own *"or"*. */
    groupMode: 'any' as const,
  },
  {
    code: 'MOC_AAB',
    name: 'Maintenance of Contract — AAB',
    appliesToOrgLevelCodes: ['AAB'],
    criteriaGroups: [
      {
        mode: 'all' as const,
        criteria: [
          { metricKey: 'NET_APE', comparator: 'gte' as const, value: 200_000_000 * IDR },
          { metricKey: 'MONTHLY2_AA', comparator: 'gte' as const, value: 2 },
        ],
      },
    ],
    groupMode: 'any' as const,
  },
] as const;
