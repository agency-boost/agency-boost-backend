import { RATIO_BENCHMARKS } from './benchmarks';
import type { RatioDisplayUnit } from './ratio-display';

/**
 * The activity taxonomy a new office starts with (P4-T1).
 *
 * **The seed, not the truth.** Every office owns its own copy from provisioning onward and
 * may rename, reorder, add and archive freely — which is the whole point of Phase 4. This
 * is what gets copied when a company has published no template of its own (ADR-0018).
 *
 * **The KPM Owner wording wins.** The two prototypes disagree: the agent app has items 7–9
 * in English (`Recruitment presentation to prospective agent`), the Owner app has them in
 * Indonesian NBO/NPA terms. The Owner app is the configuration screen — it is the one
 * depicting what an Owner edits — so it is authoritative, and
 * `activity-management.md:170-173` already recorded that.
 *
 * **Codes, never numbers.** The prototype keys everything off the integers 1–12: the
 * `data-item` attribute, the ratio formulas, the goal cascade chips. Those integers are
 * display order, and display order is reorderable — so they are `displayOrder` here and
 * nothing references them. `code` is the identity (ADR-0006, invariant §4).
 */

export interface SeedActivityCategory {
  readonly code: string;
  readonly label: string;
  readonly displayOrder: number;
  /**
   * The summary tile this section counts toward (ADR-0064), and that tile's label.
   *
   * **Both or neither.** Sections sharing a code share a tile, and every one of them carries the
   * same label; a section with neither gets a tile of its own under its own label. Presentation
   * only: no ratio, metric or cascade reads either field — they bind to type codes (invariant §4).
   */
  readonly summaryGroupCode: string | null;
  readonly summaryGroupLabel: string | null;
}

export interface SeedActivityType {
  readonly code: string;
  readonly categoryCode: string;
  readonly label: string;
  readonly description: string | null;
  readonly displayOrder: number;
}

/**
 * `KPM_Owner.html:1340-1440`. Five sections, and four summary tiles.
 *
 * **The last two share the tile *Development*** (ADR-0064), which is the prototype's strip:
 * *Leads Generation*, *Selling*, *Recruitment*, *Development* (`Overall.html:2720-2726`). The
 * prototype did it with item ranges — *Development* summed items 10–12 — and OD-63 took the
 * ranges out; the grouping now lives here, as data the office owns, so a section an office adds
 * is counted somewhere rather than nowhere.
 *
 * **A section with a tile of its own carries neither field** (OD-101, resolved 2026-10-01 as
 * ADR-0064 has it): its tile's label *is* the section's, so renaming *Selling* renames its tile,
 * with no second field for the Owner to remember. Only a tile of two or more sections carries a
 * code and a label.
 */
export const SEED_ACTIVITY_CATEGORIES: readonly SeedActivityCategory[] = [
  {
    code: 'LEADS_GENERATION', label: 'Leads Generation', displayOrder: 1,
    summaryGroupCode: null, summaryGroupLabel: null,
  },
  {
    code: 'SELLING', label: 'Selling', displayOrder: 2,
    summaryGroupCode: null, summaryGroupLabel: null,
  },
  {
    code: 'RECRUITMENT', label: 'Recruitment', displayOrder: 3,
    summaryGroupCode: null, summaryGroupLabel: null,
  },
  {
    code: 'PERSONAL_DEVELOPMENT', label: 'Personal Development', displayOrder: 4,
    summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development',
  },
  {
    code: 'TEAM_DEVELOPMENT', label: 'Team Development', displayOrder: 5,
    summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development',
  },
];

/** The twelve. Labels verbatim from `KPM_Owner.html`, descriptions included where it has them. */
export const SEED_ACTIVITY_TYPES: readonly SeedActivityType[] = [
  {
    code: 'LEADS_GEN_ACTIVITY',
    categoryCode: 'LEADS_GENERATION',
    label: 'Melakukan aktivitas leads generation',
    description: 'networking, canvassing, posting social media, dll',
    displayOrder: 1,
  },
  {
    code: 'LEADS_NEW_PROSPECT',
    categoryCode: 'LEADS_GENERATION',
    label: 'Mendapatkan calon prospek baru',
    description: null,
    displayOrder: 2,
  },
  {
    code: 'LEADS_CONTACTED',
    categoryCode: 'LEADS_GENERATION',
    label: 'Menghubungi prospek yang sudah ada',
    description: 'telepon, WhatsApp, tatap muka, dll',
    displayOrder: 3,
  },
  {
    code: 'SELL_PRESENTATION',
    categoryCode: 'SELLING',
    label: 'Melakukan presentasi penjualan untuk calon atau existing nasabah',
    description: null,
    displayOrder: 4,
  },
  {
    code: 'SELL_FOLLOWUP',
    categoryCode: 'SELLING',
    label: 'Melakukan diskusi follow up dari presentasi penjualan sebelumnya',
    description: null,
    displayOrder: 5,
  },
  {
    code: 'SELL_SUBMISSION',
    categoryCode: 'SELLING',
    label: 'Submission polis',
    description: null,
    displayOrder: 6,
  },
  {
    code: 'RECRUIT_PRESENTATION',
    categoryCode: 'RECRUITMENT',
    label: 'Presentasi NBO ke calon agen',
    description: 'secara mandiri atau melalui BOP',
    displayOrder: 7,
  },
  {
    code: 'RECRUIT_FOLLOWUP',
    categoryCode: 'RECRUITMENT',
    label: 'Melakukan diskusi follow up dari presentasi NBO sebelumnya',
    description: null,
    displayOrder: 8,
  },
  {
    code: 'RECRUIT_AGENT_CODE',
    categoryCode: 'RECRUITMENT',
    label: 'Proses NPA',
    description: null,
    displayOrder: 9,
  },
  {
    code: 'DEV_TRAINING_ATTEND',
    categoryCode: 'PERSONAL_DEVELOPMENT',
    label: 'Menghadiri meeting atau training dari KPM atau Prudential',
    description: null,
    displayOrder: 10,
  },
  {
    code: 'DEV_COACHING_RECEIVED',
    categoryCode: 'PERSONAL_DEVELOPMENT',
    label: '1-on-1 coaching dengan leader saya',
    description: null,
    displayOrder: 11,
  },
  {
    code: 'DEV_TEAM_ACTIVITY',
    categoryCode: 'TEAM_DEVELOPMENT',
    label: 'Aktivitas team development',
    // `KPM_Owner.html:1440`. Dropped when this was first transcribed, and it is the one
    // description an agent most needs: without it the item reads as a category heading
    // rather than as something to log.
    description: '1-on-1 coaching, unit meeting, role-play, JFW, memberikan training',
    displayOrder: 12,
  },
];

/**
 * The two lead pipelines a new office starts with (P4-T3).
 *
 * **Referenced by code, and that is the fix.** The prototype stores the status *label* on
 * the lead (`leads-management.md:214`), so renaming a status in settings would orphan
 * every lead holding the old text. Here a lead holds `code` and the label is free to
 * change.
 *
 * **`isTerminal` is a property, not a position.** The prototype gates *mark successful* by
 * comparing against the last element of a hardcoded array. An office that adds a stage
 * after *Paid and issued* would, in that model, silently move the gate. Naming the stage
 * that closes the pipeline means adding one after it changes nothing.
 *
 * `rank` orders the ladder for sorting and for the colour ramp. It is reorderable, so
 * nothing binds to it.
 */
export interface SeedLeadStatus {
  readonly pipeline: 'sales' | 'recruitment';
  readonly code: string;
  readonly label: string;
  readonly rank: number;
  readonly isTerminal: boolean;
  /**
   * Far enough along to be expected to convert this period (ADR-0043). Feeds
   * `RECRUITMENT_EXPECTED_TO_CLOSE`. Never true where `isTerminal` is.
   */
  readonly isLateStage: boolean;
}

/**
 * `Overall.html:5366-5367`, five and seven.
 *
 * **`isLateStage` marks the stages after which the work is the counterparty's** (ADR-0043):
 * underwriting has the sales case, and a recruit with an agent code is waiting on AAJI and
 * on a field-work date. That is what *"expected to convert this month"* means, and it is
 * what the prototype's *Offer / Onboarding* stub was reaching for with stage names that
 * exist in neither ladder (`metrics-and-definitions.md:302`).
 *
 * The office owns these flags from provisioning onward, like every other field here.
 */
export const SEED_LEAD_STATUSES: readonly SeedLeadStatus[] = [
  { pipeline: 'sales', code: 'NOT_YET_APPROACHED', label: 'Not yet approached', rank: 1, isTerminal: false, isLateStage: false },
  { pipeline: 'sales', code: 'FOLLOW_UP', label: 'Follow-up', rank: 2, isTerminal: false, isLateStage: false },
  { pipeline: 'sales', code: 'POLICY_SUBMITTED', label: 'Policy submitted', rank: 3, isTerminal: false, isLateStage: true },
  { pipeline: 'sales', code: 'APPROVED_NOT_PAID', label: 'Approved, not paid', rank: 4, isTerminal: false, isLateStage: true },
  { pipeline: 'sales', code: 'PAID_AND_ISSUED', label: 'Paid and issued', rank: 5, isTerminal: true, isLateStage: false },

  { pipeline: 'recruitment', code: 'NOT_APPROACHED', label: 'Not approached', rank: 1, isTerminal: false, isLateStage: false },
  { pipeline: 'recruitment', code: 'MEETING_SCHEDULED', label: 'Meeting scheduled', rank: 2, isTerminal: false, isLateStage: false },
  { pipeline: 'recruitment', code: 'RECRUITMENT_PRESENTATION', label: 'Recruitment presentation', rank: 3, isTerminal: false, isLateStage: false },
  { pipeline: 'recruitment', code: 'AGENT_CODE_CREATED', label: 'Agent code created', rank: 4, isTerminal: false, isLateStage: true },
  { pipeline: 'recruitment', code: 'AAJI_LICENSED', label: 'AAJI licensed', rank: 5, isTerminal: false, isLateStage: true },
  { pipeline: 'recruitment', code: 'JOINT_FIELD_WORK_PLANNED', label: 'Joint field work planned', rank: 6, isTerminal: false, isLateStage: true },
  { pipeline: 'recruitment', code: 'NEW_ACTIVE_AGENT', label: 'New active agent', rank: 7, isTerminal: true, isLateStage: false },
];

/**
 * The five ratios a new office starts with (P4-T2).
 *
 * **Formulas reference activity `code`s, never the prototype's numbers.** `Overall.html`
 * writes them as `6 / (4+5)` — item ids — and the same prototype lets an Owner reorder
 * those items. An office that dragged a row would silently rebind every formula in it.
 *
 * The benchmarks are `RATIO_BENCHMARKS`, the single source pinned by
 * `constants.spec.ts`; they are copied in as the office's starting values and owned by
 * the office afterwards.
 *
 * `comparison` is how a value is judged. `gte` is "at or above the benchmark"; `band` is
 * the balance ratio's `abs(sellingPct − 50) × 2 ≤ benchmark`, which is a different shape
 * and is the reason this is a named enum rather than an operator string.
 */
export interface SeedRatioDefinition {
  readonly code: string;
  readonly label: string;
  /** Activity type codes summed for the numerator. */
  readonly numerator: readonly string[];
  /** Activity type codes summed for the denominator. */
  readonly denominator: readonly string[];
  readonly benchmark: number;
  readonly comparison: 'gte' | 'band';
  /**
   * How the benchmark is written (P4-T25) — the unit `metrics-and-definitions.md` states for
   * each of the five. The stored `benchmark` is a proportion either way; this is what turns
   * `0.15` into `15.0%` on screen and leaves `0.30` as `0.30`.
   */
  readonly displayUnit: RatioDisplayUnit;
  readonly displayOrder: number;
  /**
   * Ladder rung codes this ratio is a question about (ADR-0020). Omitted means every rung.
   *
   * A **seed default**, not a rule. An office whose agents do recruit adds `AGENT` and the
   * ratio returns for everyone; nothing here is enforced after provisioning.
   */
  readonly appliesToOrgLevelCodes?: readonly string[];
}

/** `activity-management.md:211-215`, bound to codes. */
export const SEED_RATIO_DEFINITIONS: readonly SeedRatioDefinition[] = [
  {
    code: 'SELLING_VS_RECRUITMENT',
    label: 'Selling vs Recruitment',
    numerator: ['SELL_PRESENTATION', 'SELL_FOLLOWUP', 'SELL_SUBMISSION'],
    denominator: ['RECRUIT_PRESENTATION', 'RECRUIT_FOLLOWUP', 'RECRUIT_AGENT_CODE'],
    benchmark: RATIO_BENCHMARKS.BALANCE_BAND_PP,
    comparison: 'band',
    displayUnit: 'points',
    displayOrder: 1,
    /*
     * The rungs that carry a recruiting mandate on v1's ladder (ADR-0020).
     *
     * An agent with no such mandate logs no recruitment activity, so their denominator is
     * zero every month: they read 100% Selling, sit outside the ±30pp band, and carry a
     * standing alert for doing their job exactly as instructed.
     */
    appliesToOrgLevelCodes: ['AB', 'AAB'],
  },
  {
    code: 'SELLING_SUCCESS_RATE',
    label: 'Selling success rate',
    numerator: ['SELL_SUBMISSION'],
    denominator: ['SELL_PRESENTATION', 'SELL_FOLLOWUP'],
    benchmark: RATIO_BENCHMARKS.SELLING_SUCCESS_RATE,
    comparison: 'gte',
    displayUnit: 'percent',
    displayOrder: 2,
  },
  {
    code: 'RECRUITMENT_SUCCESS_RATE',
    label: 'Recruitment success rate',
    numerator: ['RECRUIT_AGENT_CODE'],
    denominator: ['RECRUIT_PRESENTATION', 'RECRUIT_FOLLOWUP'],
    benchmark: RATIO_BENCHMARKS.RECRUITMENT_SUCCESS_RATE,
    comparison: 'gte',
    displayUnit: 'percent',
    displayOrder: 3,
    // Same shape, same reason: a denominator that is structurally zero for this rung.
    appliesToOrgLevelCodes: ['AB', 'AAB'],
  },
  {
    code: 'LEADS_PER_ACTIVITY',
    label: 'Leads per activity',
    numerator: ['LEADS_NEW_PROSPECT'],
    denominator: ['LEADS_GEN_ACTIVITY'],
    benchmark: RATIO_BENCHMARKS.LEADS_PER_ACTIVITY,
    comparison: 'gte',
    displayUnit: 'decimal',
    displayOrder: 4,
  },
  {
    code: 'MEETING_PER_APPROACH',
    label: 'Meeting per approach',
    numerator: ['SELL_PRESENTATION', 'RECRUIT_PRESENTATION'],
    denominator: ['LEADS_CONTACTED'],
    benchmark: RATIO_BENCHMARKS.MEETING_PER_APPROACH,
    comparison: 'gte',
    displayUnit: 'decimal',
    displayOrder: 5,
  },
];

/**
 * What each platform ratio measures, in the prototype's own words (`Overall.html:5215-5268`).
 *
 * Keyed by code and **shown only for a platform ratio whose formula the office has not changed**: an
 * office that moves `SELLING_SUCCESS_RATE` to count something else has a ratio this sentence no longer
 * describes, and the card shows its formula alone (P10-T2, ADR-0024).
 */
export const SEED_RATIO_PURPOSES: Readonly<Record<string, string>> = {
  SELLING_VS_RECRUITMENT: 'Memantau keseimbangan fokus antara aktivitas selling dan recruitment',
  SELLING_SUCCESS_RATE: 'Mengukur tingkat konversi aktivitas selling menjadi submission',
  RECRUITMENT_SUCCESS_RATE: 'Mengukur tingkat konversi aktivitas recruitment menjadi agen baru',
  LEADS_PER_ACTIVITY: 'Mengukur efektivitas aktivitas pencarian prospek dalam menghasilkan prospek baru',
  MEETING_PER_APPROACH: 'Mengukur efektivitas pendekatan prospek dalam menghasilkan pertemuan',
};

