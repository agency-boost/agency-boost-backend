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
 * **The phases are the current plan's** (P10.1-T2 AC-6, 2026-10-01). The 2026-09-29 re-plan moved
 * the old Phases 11–15 to 13, 14, 15, 18 and 20 and brought coaching forward to 11
 * (`roadmap-and-phases.md`, *The 2026-09-29 re-plan*), and every `phase` below moved by that
 * crosswalk in one change with the document's index. Old 13 split by the task that first computes
 * each metric: what coaching computes — the session metrics, coverage, and the roster's pace status
 * and pacing (P11-T5 to P11-T10) — is 11; the unit rollups (P15-T1) are 15. `registry.spec.ts`
 * pins every moved phase by key, so a number from the old plan cannot come back unnoticed.
 *
 * *Amended 2026-10-08 (the re-plan that puts training, events and campaigns last):* the three
 * enablement metrics — training completion, event attendance status and campaign qualification —
 * moved from 14 to 18.2 (P18.2-T1, P18.2-T5, P18.2-T8; were P14-T1, P14-T3, P14-T6). Phase 14 is
 * Sales tools now and computes none. `registry.spec.ts` pins this move by key too.
 *
 * *Amended 2026-10-08 again (P15-T0, D-metrics):* the Unit Dashboard draws neither unit rollup the old
 * plan gave it, so `MAA_COUNT_IN_UNIT` and `ACTIVITY_COMPLIANCE_RATE` moved from 15 to 18, the Owner's
 * reporting, whose screens draw them (`KPM_Owner.html:1248`, `:982-985`) — still before campaigns are
 * evaluated (18.2), so a requirement may still name them. Phase 15 registers the five figures its roster
 * does draw instead, each computed once under `domain/metrics/`: the three lead counts, the potential
 * active count and the touches.
 *
 * A campaign requirement or a qualification rule may only name a metric this product can compute
 * (ADR-0035). The prototype's requirements are display strings — *"Net APE ≥ Rp 600 juta"* — which
 * nothing can evaluate and nothing can refuse, so a campaign could promise a reward against a number
 * the product never produces. (*Net APE* itself is retired since P19.3-T1, ADR-0201: *"APE is APE"*.)
 */
/**
 * A roadmap phase as the roadmap writes it: `'9'`, `'18.1'`, `'18.11'` (ADR-0188). Numbered like a version,
 * so it compares part by part — `'18.10'` comes after `'18.9'` — never as a decimal, which would read
 * `18.10` as `18.1` and `18.11` as before `18.2`.
 */
export type Phase = string;

/** Negative when `a` comes before `b` in the roadmap, zero when they are the same phase, positive after. */
export function comparePhases(a: Phase, b: Phase): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface MetricDefinition {
  readonly key: string;
  readonly name: string;
  readonly unit: MetricUnit;
  /** The roadmap phase that first computes it for real, as the roadmap writes it (`'18.11'`; compare with `comparePhases`). */
  readonly phase: Phase;
  /**
   * `false` for a metric about **an office rather than a member** (P13.2-T4): no campaign requirement
   * and no qualification rule may name it, whatever its phase, because nobody could qualify by it. Absent
   * on every metric a requirement may name. `REQUIREMENT_METRICS` below is the list without them.
   */
  readonly requirable?: false;
  /**
   * **What a campaign requirement reads, on the small set a campaign may name** (Phase 18.2, D-evaluable).
   * Present only on that set and absent everywhere else: **a second flag, separate from `requirable`**, which
   * stays what a carrier rule may name. A target, an enum, a boolean, a per-event rate or a self-declared toggle
   * is not something anybody *achieves* over a window, so none carries one. `CAMPAIGN_METRICS` below is the set.
   */
  readonly campaign?: CampaignReading;
}

/**
 * How a campaign requirement reads a metric over its window (D-evaluable, D-windows), through the owning
 * module's own functions — never a second copy:
 *
 * - `source`: `file` — the office's monthly production file (`monthlyAgentData`), read in whole office months;
 *   `activity` — the member's logged days, any days.
 * - `aggregate`: `sum` — the months' or days' figures added (a year to date, for a calendar year, the file's own
 *   year-to-date cell); `latest` — the latest month held in the window; `ratio` — the office's ratio definition
 *   over the window's counts.
 * - `subject`: `self` — the member's own figure; `unit` — over the member's Direct Unit (their direct reports on
 *   the Agent rung) and themselves.
 *
 * The evaluator asserts each `aggregate` agrees with the metric's `period` (D-period, `campaign-evaluation.ts`).
 */
export interface CampaignReading {
  readonly source: 'file' | 'activity';
  readonly aggregate: 'sum' | 'latest' | 'ratio';
  readonly subject: 'self' | 'unit';
}

/**
 * What a metric's number means.
 *
 * `idr_minor` is integer sen, never a float and never a display string (invariant §9): the
 * prototype stores *"Rp 600,000,000"* and one campaign's reward in **pesos**. `tri_state` is
 * boolean-or-unknown, and the unknown is load-bearing: an office that has not uploaded a month has
 * no Monthly Active Agents to count, which is not zero of them. `months` is a decimal count of them. `date` is an
 * office date, `YYYY-MM-DD` — since P18.8-T4, the first sale's day.
 */
export const METRIC_UNITS = [
  'boolean', 'tri_state', 'count', 'percentage', 'percentage_points', 'ratio', 'days', 'months', 'idr_minor', 'enum', 'score',
  'date',
] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

export const METRIC_REGISTRY: readonly MetricDefinition[] = [
  { key: 'MONTHLY_ACTIVE_AGENT', name: 'Monthly Active Agent (MAA)', unit: 'tri_state', phase: '9' },
  { key: 'MAA_COUNT_IN_UNIT', name: 'Active agents in unit', unit: 'count', phase: '18', campaign: { source: 'file', aggregate: 'latest', subject: 'unit' } },
  { key: 'PACING_TO_MAA', name: 'Pacing to MAA', unit: 'boolean', phase: '11' },
  { key: 'ACTIVITY_COMPLIANCE_7D', name: 'Activity-logging compliance, last 7 days', unit: 'boolean', phase: '6' },
  { key: 'ACTIVITY_COMPLIANCE_MONTH', name: 'Activity-logging compliance, this month', unit: 'boolean', phase: '6' },
  { key: 'ACTIVITY_COMPLIANCE_RATE', name: 'Activity-logging compliance rate', unit: 'percentage', phase: '18' },
  { key: 'ACTIVITY_TOTAL_BY_CATEGORY', name: 'Logged touches by category', unit: 'count', phase: '6' },
  { key: 'COACHED_7D', name: 'Coached in the last 7 days', unit: 'boolean', phase: '11' },
  { key: 'COACHED_30D', name: 'Coached in the last 30 days', unit: 'boolean', phase: '11' },
  { key: 'DAYS_SINCE_LAST_COACHING', name: 'Days since last 1:1', unit: 'days', phase: '11' },
  { key: 'COACHING_COVERAGE', name: 'Coaching coverage', unit: 'percentage', phase: '11' },
  { key: 'LEADER_COACHING_FREQUENCY', name: 'AB / AAB coaching frequency', unit: 'percentage', phase: '18' },
  { key: 'APE_ACHIEVED', name: 'APE achieved', unit: 'idr_minor', phase: '9', campaign: { source: 'file', aggregate: 'sum', subject: 'self' } },
  { key: 'APE_TARGET', name: 'APE target', unit: 'idr_minor', phase: '8' },
  { key: 'APE_ATTAINMENT_PCT', name: 'APE achieved vs target', unit: 'percentage', phase: '10' },
  { key: 'APE_GAP_TO_TARGET', name: 'Gap to target', unit: 'idr_minor', phase: '10' },
  { key: 'POLICIES_NEEDED', name: 'Policies still needed', unit: 'count', phase: '10' },
  { key: 'MONTHS_LEFT_IN_YEAR', name: 'Months left in the year', unit: 'months', phase: '8' },
  { key: 'POLICY_COUNT_TARGET', name: 'Policies to close this month', unit: 'count', phase: '8' },
  { key: 'APPOINTMENT_TARGET', name: 'Appointments to hold this month', unit: 'count', phase: '8' },
  { key: 'LEAD_TARGET', name: 'Leads to contact this month', unit: 'count', phase: '8' },
  { key: 'GOAL_PACE_STATUS', name: 'On-track / pace status', unit: 'enum', phase: '11' },
  { key: 'SELLING_RECRUITMENT_BALANCE', name: 'Selling vs Recruitment balance', unit: 'percentage_points', phase: '6', campaign: { source: 'activity', aggregate: 'ratio', subject: 'self' } },
  { key: 'SELLING_SUCCESS_RATE', name: 'Selling success rate', unit: 'ratio', phase: '6', campaign: { source: 'activity', aggregate: 'ratio', subject: 'self' } },
  { key: 'RECRUITMENT_SUCCESS_RATE', name: 'Recruitment success rate', unit: 'ratio', phase: '6', campaign: { source: 'activity', aggregate: 'ratio', subject: 'self' } },
  { key: 'LEADS_PER_ACTIVITY', name: 'Leads per activity', unit: 'ratio', phase: '6', campaign: { source: 'activity', aggregate: 'ratio', subject: 'self' } },
  { key: 'MEETING_PER_APPROACH', name: 'Set appointment to meeting', unit: 'ratio', phase: '6', campaign: { source: 'activity', aggregate: 'ratio', subject: 'self' } },
  { key: 'MEASURED_LEAD_TO_APPOINTMENT_RATE', name: 'Your logged leads-to-appointment rate', unit: 'ratio', phase: '10' },
  { key: 'MEASURED_CLOSING_RATE', name: 'Your logged closing rate', unit: 'ratio', phase: '10' },
  { key: 'MONTHLY_APE_TARGET', name: 'This month’s APE target', unit: 'idr_minor', phase: '10' },
  // P13.1-T5 (ADR-0109): the pace sentence's *tracking to close N*. It replaced ADR-0057's
  // `PROJECTED_CLOSINGS_THIS_MONTH`, a run-rate, which is no longer measured.
  { key: 'CLOSINGS_LAST_30_DAYS', name: 'Closings over the last 30 days', unit: 'count', phase: '13.1' },
  { key: 'CLOSINGS_NEEDED_PER_WEEK', name: 'Closings needed per week', unit: 'count', phase: '10' },
  { key: 'SUMMARY_ACTIVITY_TARGET', name: 'Activity target for the period', unit: 'count', phase: '10' },
  { key: 'ACTIVITY_TARGET_ATTAINMENT_PCT', name: 'Logged against the activity target', unit: 'percentage', phase: '10' },
  // The coaching session's Activity card: this month's activity targets pro-rated to the last 7 days (P11-T4).
  { key: 'SUB_PERIOD_ACTIVITY_TARGET', name: 'Activity target for the last 7 days, pro-rated', unit: 'count', phase: '11' },
  { key: 'ACTIVATION_COMPLETION_PCT', name: 'Activation completion', unit: 'percentage', phase: '13' },
  { key: 'ACTIVATION_DAY_INDEX', name: 'Activation day', unit: 'days', phase: '13' },
  { key: 'TRAINING_COMPLETION_PCT', name: 'Training completion', unit: 'percentage', phase: '18.2' },
  { key: 'EVENT_ATTENDANCE_STATUS', name: 'Event attendance status', unit: 'enum', phase: '18.2' },
  /*
   * *Moved 2026-10-09 (P18-T0, D-registry): 18 → 18.2.* Every reader of theirs is the compliance, events and
   * campaigns tree, which moved to 18.2 on 2026-10-08; a metric of Phase 18 that read event records would be a
   * roadmap defect. 18.2 is `CAMPAIGN_EVALUATION_PHASE`, so neither becomes unrequirable.
   */
  { key: 'EVENT_ATTENDANCE_RATE', name: 'Event attendance rate', unit: 'percentage', phase: '18.2' },
  { key: 'EVENT_NPS', name: 'Event NPS', unit: 'score', phase: '18.2' },
  { key: 'CAMPAIGN_QUALIFICATION_STATUS', name: 'Campaign qualification', unit: 'enum', phase: '18.2' },
  { key: 'MOC_STATUS', name: 'Maintenance of Contract', unit: 'boolean', phase: '18' },
  { key: 'PRODUCTION_CLUB_TIER', name: 'Production club tier', unit: 'enum', phase: '18' },
  // Computed since P7-T6, in `LeadService.summary` — the document's index said 14 (the old plan's
  // Owner reporting, 18 now) until P10-T8.
  { key: 'RECRUITMENT_PIPELINE_NOW', name: 'Recruitment pipeline now', unit: 'count', phase: '7' },
  { key: 'RECRUITMENT_EXPECTED_TO_CLOSE', name: 'Expected to close', unit: 'count', phase: '7' },
  /*
   * Phase 15 (D-leads, D-metrics): the Unit Dashboard's roster, per person and summed by the rollup rule
   * (`domain/metrics/unit-rollup.ts`, `domain/metrics/lead-counts.ts`).
   */
  { key: 'OPEN_SALES_LEADS', name: 'Open sales leads', unit: 'count', phase: '15' },
  { key: 'SALES_LEADS_CLOSING_THIS_MONTH', name: 'Sales leads closing this month', unit: 'count', phase: '15' },
  { key: 'RECRUITMENT_NOMINATED_THIS_MONTH', name: 'Recruitment candidates nominated this month', unit: 'count', phase: '15' },
  // UI V1 (Phase 18.11 T4; UI-028, O-4): the Unit Dashboard roster's *Closing*.
  { key: 'SALES_LEADS_CLOSED_IN_PERIOD', name: 'Closing (sales leads paid and issued in the period)', unit: 'count', phase: '18.11', requirable: false },
  { key: 'POTENTIAL_MAA_COUNT_IN_UNIT', name: 'Potential Monthly Active Agents in unit', unit: 'count', phase: '15' },
  { key: 'CASCADE_ACTIVITY_TOUCHES', name: 'Touches on the goal activities', unit: 'count', phase: '15', campaign: { source: 'activity', aggregate: 'sum', subject: 'self' } },
  { key: 'NEW_ACTIVE_AGENTS', name: 'New active agents', unit: 'count', phase: '9', campaign: { source: 'file', aggregate: 'sum', subject: 'self' } },
  { key: 'ROLLING_PERSISTENCY', name: 'Rolling persistency', unit: 'percentage', phase: '9', campaign: { source: 'file', aggregate: 'latest', subject: 'self' } },
  /*
   * Phase 18.2 (OD-152 → option 3): **the file's `recruitment` column, as a campaign reads it**
   * — the prototype's *New Hire* requirement (`Overall.html:7930`, `:7941`, `:7984`). The carrier's count, monthly
   * and year to date, as `NEW_ACTIVE_AGENTS` is; **not** the glossary's *New hire*, a person in their activation.
   */
  { key: 'NEW_HIRES', name: 'New Hire', unit: 'count', phase: '18.2', campaign: { source: 'file', aggregate: 'sum', subject: 'self' } },
  // P13.2-T4 (ADR-0113): the office's active ABs and AABs, which its leader limit bounds. An office's
  // seats, not anybody's work: no campaign or qualification rule may name it.
  { key: 'LEADERS_USED', name: 'Leaders used', unit: 'count', phase: '13.2', requirable: false },
  /*
   * Phase 18 (D-registry): the Owner's reporting. Each is computed once under `domain/metrics/` and pinned there.
   *
   * **The headcount and its new members are `requirable: false`**, as `LEADERS_USED` is: they are about an
   * office, so nobody could qualify by one. The other nine count or sum a scope's members and stay requirable,
   * as the unit rollups do.
   */
  { key: 'OFFICE_HEADCOUNT', name: 'Headcount', unit: 'count', phase: '18', requirable: false },
  { key: 'OFFICE_NEW_MEMBERS_THIS_MONTH', name: 'New members this month', unit: 'count', phase: '18', requirable: false },
  // `ACTIVITY_LOGGED_THIS_MONTH` (*Agents who logged activity this month*, 18; OD-142) was here: retired by ADR-0200 §3
  // (P19.3-T1). The Overview's first tile counts production (`MAA_COUNT_IN_UNIT`, *Aktif bulan ini*), and logging is the
  // compliance family's, *Pengguna aktif* on every screen.
  /*
   * P19.3-T1 (ADR-0200 §5, the data sources' D2): the upload's `RECRUITMENT` for the previous calendar month, summed over
   * the office's rows — where it counted recruitment leads closed won. **The code stays**, a stable identity and an API
   * field; the name is the Overview's *Recruitment last month*.
   */
  { key: 'RECRUITMENT_CLOSED_LAST_MONTH', name: 'Recruitment last month', unit: 'count', phase: '18' },
  { key: 'APE_YEAR_PROJECTION', name: 'Projected APE for the year', unit: 'idr_minor', phase: '18' },
  /*
   * MOC's inputs (OD-22 → option 1, D-moc): the names the seeded carrier rules have always used, a stated
   * reading of each over the office's file, which the client corrected on 3 November (ADR-0201).
   *
   * `NET_APE` (*Net APE*, 18) was here: retired by ADR-0201 §1 (P19.3-T1; D5, *"APE is APE"*). Its definition carries on
   * as `MOC_APE`, below, and migration `0051-moc-ape-key` renamed the seeded rules' key in place.
   */
  { key: 'MONTHLY2_AA', name: 'Monthly2 AA', unit: 'count', phase: '18' },
  { key: 'MONTHLY2_AA_DU', name: 'Monthly2 AA, Direct Unit', unit: 'count', phase: '18' },
  { key: 'MONTHLY2_AA_DG', name: 'Monthly2 AA, Direct Group', unit: 'count', phase: '18' },
  { key: 'DIRECT_AB_COUNT', name: 'Direct AB (AB on AB)', unit: 'count', phase: '18' },
  { key: 'MOC_PERSISTENCY', name: 'MOC rolling persistency', unit: 'percentage', phase: '18' },
  /*
   * Phase 18.1 (P18.1-T1 AC-1, AC-4; D-cohort, OD-144): the Strategic Leader Forum's scorecard, and the activation
   * cohort its *3M new agent %* row read until P18.8-T6. Each is computed once under `domain/metrics/`
   * (`activation-cohort.ts`, `producing-agents.ts`, `held-months.ts`) and pinned there.
   *
   * **All of them are `requirable: false`**, as the office's headcount is: each is computed over an office — the
   * scorecard is the office's, `functional/leader-forum.md` — and nothing computes one for a member, so a requirement
   * naming one could never be evaluated for anybody.
   */
  { key: 'ACTIVATION_COHORT', name: 'Activation cohort', unit: 'count', phase: '18.1', requirable: false },
  // `NEW_AGENT_3M_ACTIVE_PCT` (*3M new agent %*, 18.1) was here: retired by ADR-0171 §2 (P18.8-T6) for
  // `ACTIVATION_3M_PCT`, below — the one 3M metric, which the forum's row reads now (invariant §8).
  // `NEW_ACTIVE_AGENTS_MONTHLY_AVG` (*New AA (avg. monthly)*, 18.1) was here: retired by ADR-0175 §2 (P18.9-T1 AC-6) —
  // the client's reference slide has no such row. Its frozen figures stay on the meetings that froze them.
  // P18.9-T1 AC-4 (ADR-0175 §2, UI-004, UI-041): *Producing agents* reads **Annual Active Agents**, its definition the same.
  { key: 'PRODUCING_AGENTS', name: 'Annual Active Agents', unit: 'count', phase: '18.1', requirable: false },
  { key: 'MAA_MONTHLY_AVG', name: 'Avg. Monthly AA', unit: 'count', phase: '18.1', requirable: false },
  { key: 'CASE_SUBMISSIONS', name: 'Case submission', unit: 'count', phase: '18.1', requirable: false },
  { key: 'AVERAGE_CASE_SIZE_REALISED', name: 'Average Case Size', unit: 'idr_minor', phase: '18.1', requirable: false },
  /*
   * Phase 18.6 (P18.9-T1 AC-5; ADR-0175 §2, OD-228): the reference slide's *Cases/producing agents* — `CASE_SUBMISSIONS`
   * ÷ `PRODUCING_AGENTS` over the same period, computed once (`domain/metrics/cases-per-producing-agent.ts`).
   * **`requirable: false`**, as the forum's others: computed over an office alone, never for a member.
   */
  { key: 'CASES_PER_PRODUCING_AGENT', name: 'Cases/producing agents', unit: 'ratio', phase: '18.9', requirable: false },
  /*
   * Phase 18.3 (P18.3-T1 AC-5, AC-7; OD-159, OD-160): the Owner's compliance tree's two chips that needed a definition,
   * each computed once under `domain/metrics/` (`activation-completion-rate.ts`, `goal-set.ts`). **Both are
   * `requirable: false`**: each is a share of a set of members, and nobody qualifies by one. `ACTIVATION_COMPLETION_RATE`
   * is a set's graduations, never `ACTIVATION_COMPLETION_PCT` — one hire's items.
   */
  { key: 'ACTIVATION_COMPLETION_RATE', name: 'Activation completion rate', unit: 'percentage', phase: '18.3', requirable: false },
  { key: 'GOAL_SET_RATE', name: 'Goal set', unit: 'percentage', phase: '18.3', requirable: false },
  /*
   * Phase 18.5 (P18.8-T4 AC-1; ADR-0171 §1): a person's first sale — a paid and issued case — kept on the membership
   * and computed once (`domain/metrics/first-sale.ts`). **`requirable: false`**: a day, not something anybody achieves
   * over a window, so no campaign requirement names it.
   */
  { key: 'FIRST_SALE_DATE', name: 'First sale', unit: 'date', phase: '18.8', requirable: false },
  /*
   * Phase 18.5 (P18.8-T5 AC-2; ADR-0172 §2): who a unit's production totals and *On pace to be active* read — an
   * existing agent always, a new hire from their first sale's day — computed once (`counts-for-production.ts`).
   * **`requirable: false`**: a rule about whom a total covers, not something anybody achieves over a window.
   */
  { key: 'COUNTS_FOR_PRODUCTION', name: 'Counts for production', unit: 'boolean', phase: '18.8', requirable: false },
  /*
   * Phase 18.5 (P18.8-T6 AC-1, AC-2; ADR-0171 §2, ADR-0173): a new hire's **3M activation** — in progress through day
   * 90 of the join date, then locked *activated* or *not activated* — and the share of new hires activated, by join
   * month, unit and office. Computed once (`domain/metrics/activation-3m.ts`); the share replaces
   * `NEW_AGENT_3M_ACTIVE_PCT`. **Both `requirable: false`**: a result decided once, and a share of a set of members —
   * nobody achieves either over a window.
   */
  { key: 'ACTIVATION_3M', name: '3M activation', unit: 'enum', phase: '18.8', requirable: false },
  { key: 'ACTIVATION_3M_PCT', name: '3M activation %', unit: 'percentage', phase: '18.8', requirable: false },
  /*
   * Phase 19.1 (P19.1-T6; ADR-0193, OD-249 by its default; UI-153, UI-155): the Unit Dashboard's *Potensi* tab — a lead's
   * switch for the month, the tab's *AA* (a sales lead marked *Berhasil* in the month, or the month's file showing a
   * policy — **never** `MONTHLY_ACTIVE_AGENT`), and a kandidat who became *rekrut*. Each computed once
   * (`domain/metrics/potensi.ts`). **All three `requirable: false`**: registered after campaign evaluation, and a
   * switch, a tab's mark and a kandidat are nothing a campaign requirement names. No key holds `ACTIVE_AGENT`.
   */
  { key: 'LEAD_POTENSI_THIS_MONTH', name: 'Potensi', unit: 'boolean', phase: '19.1', requirable: false },
  { key: 'AA_THIS_MONTH', name: 'AA (the Potensi tab’s)', unit: 'boolean', phase: '19.1', requirable: false },
  { key: 'REKRUT_THIS_MONTH', name: 'Rekrut', unit: 'boolean', phase: '19.1', requirable: false },
  /*
   * Phase 19.3 (P19.3-T1; ADR-0201 to ADR-0203, the owner's data sources of 3 November): four named metrics.
   *
   * - **`MOC_APE` is requirable**, as `NET_APE` was: it takes `NET_APE`'s place in the company's `moc` rules, under the
   *   owner's word (D5). **Its phase is 18**, `NET_APE`'s: the same definition, computed since P18-T2 under the old
   *   name — so it stays measured before campaigns are evaluated, and `GET /metrics` never calls it *not measured yet*.
   *   No campaign reading: a carrier rule names it, never a campaign requirement.
   * - **The other three are `requirable: false`, at 19.3**: a leader row's uploaded figure, and two of the forum's rows
   *   over an office. None names `ACTIVE_AGENT` (the registry's guard).
   */
  { key: 'MOC_APE', name: 'APE, MOC scope', unit: 'idr_minor', phase: '18' },
  { key: 'UNIT_PERSISTENCY', name: 'Unit persistency', unit: 'percentage', phase: '19.3', requirable: false },
  { key: 'NEW_AGENT_ACTIVATION_3M_PCT', name: '3M new agent %', unit: 'percentage', phase: '19.3', requirable: false },
  { key: 'RECRUITMENT_MONTHLY_AVG', name: 'Recruitment, avg. monthly', unit: 'count', phase: '19.3', requirable: false },
  /*
   * Phase 19.5 (P19.5-T4; ADR-0216 §4): **the surveys' six**, each over one survey run and its own snapshot
   * (`modules/surveys/survey-results.ts`, `survey-rules.ts`, `coaching-survey.service.ts`). None is requirable — a run's
   * figure about an office, or one person's answers read under ADR-0216 §3's conditions — and none names an active agent.
   */
  { key: 'NPS_SCORE', name: 'Survey NPS', unit: 'score', phase: '19.5', requirable: false },
  { key: 'SURVEY_RESPONSE_RATE', name: 'Survey responses', unit: 'percentage', phase: '19.5', requirable: false },
  { key: 'QUAL_ITEM_ISSUE_PCT', name: 'Item with an issue', unit: 'percentage', phase: '19.5', requirable: false },
  { key: 'QUAL_PERSON_ISSUE_COUNT', name: 'Items with an issue, per person', unit: 'count', phase: '19.5', requirable: false },
  { key: 'QUAL_LEADER_SUPPORT', name: 'Leader support', unit: 'percentage', phase: '19.5', requirable: false },
  { key: 'QUAL_COACHING_DOWNLINE_PCT', name: 'Coaching downline', unit: 'percentage', phase: '19.5', requirable: false },
  /*
   * Phase 19.5 (P19.5-T2; ADR-0214 §10, §11): **the Data upload's month and its calculated year to date**
   * (`modules/production/upload-completeness.ts`, `production-readings.ts`'s `sumHeld`). Neither is requirable: a state of an
   * office's month, and the sum every reader of a year to date reads — `APE_ACHIEVED` is what a requirement names.
   */
  { key: 'UPLOAD_MONTH_COMPLETE', name: 'Month complete', unit: 'enum', phase: '19.5', requirable: false },
  { key: 'COLUMN_YEAR_TO_DATE', name: 'Year to date (calculated)', unit: 'idr_minor', phase: '19.5', requirable: false },
  /*
   * Phase 19.5 (P19.5-T3; ADR-0215): **the KPM's *Advanced analytics* page** — Demographics, the events' NPS for a
   * period, seven Quant metrics (B1, C2 and D1 are registered already), the peers' median and status, and Sub-group's
   * eight (`domain/metrics/demographics.ts`, `quant.ts`, `subgroup.ts`). None is requirable: each is a figure about an
   * office or a group of it, read on one page. A2, A3, B3, C1 and C3 count D1's active agents.
   */
  { key: 'MANPOWER_BY_DIMENSION', name: 'Demographics', unit: 'count', phase: '19.5', requirable: false },
  { key: 'EVENT_NPS_FOR_PERIOD', name: 'Event NPS, for a period', unit: 'score', phase: '19.5', requirable: false },
  { key: 'QUANT_RECRUITS_PER_LEADER', name: 'A1 Recruitment per leader', unit: 'ratio', phase: '19.5', requirable: false },
  { key: 'QUANT_ANNUAL_ACTIVE_NET_GROWTH', name: 'A2 Net growth in annual active agents', unit: 'count', phase: '19.5', requirable: false },
  { key: 'QUANT_ACTIVE_PER_LEADER', name: 'A3 Active agents per leader', unit: 'ratio', phase: '19.5', requirable: false },
  { key: 'QUANT_ACTIVATION_12M_PCT', name: 'B2 Activation within 12 months', unit: 'percentage', phase: '19.5', requirable: false },
  { key: 'QUANT_TENURED_ACTIVE_PCT', name: 'B3 Tenured agents active', unit: 'percentage', phase: '19.5', requirable: false },
  { key: 'QUANT_AVG_MAA_PER_LEADER', name: 'C1 Avg. monthly active agents per leader', unit: 'ratio', phase: '19.5', requirable: false },
  { key: 'QUANT_AVG_ACTIVE_MONTHS', name: 'C3 Avg. active months', unit: 'months', phase: '19.5', requirable: false },
  { key: 'QUANT_PEER_MEDIAN', name: 'Peer median', unit: 'ratio', phase: '19.5', requirable: false },
  { key: 'QUANT_PEER_STATUS', name: 'Peer status', unit: 'enum', phase: '19.5', requirable: false },
  { key: 'SUBGROUP_MAA_BASELINE', name: 'Sub-group MAA baseline', unit: 'count', phase: '19.5', requirable: false },
  { key: 'SUBGROUP_HEAD_ACTIVE_DAYS', name: 'Head of group adoption', unit: 'days', phase: '19.5', requirable: false },
  { key: 'SUBGROUP_DOWNLINE_ADOPTION_PCT', name: 'Downline adoption', unit: 'percentage', phase: '19.5', requirable: false },
  { key: 'POWER_USER_COUNT', name: 'Power users', unit: 'count', phase: '19.5', requirable: false },
  { key: 'SUBGROUP_ONE_ON_ONES_PER_WEEK', name: 'One-on-ones a week', unit: 'ratio', phase: '19.5', requirable: false },
  { key: 'SUBGROUP_WEEKLY_ACTIVITY_TARGET', name: 'Weekly activity target', unit: 'count', phase: '19.5', requirable: false },
  { key: 'SUBGROUP_RECRUITMENT_BASELINE', name: 'Sub-group recruitment baseline', unit: 'count', phase: '19.5', requirable: false },
  { key: 'SUBGROUP_TARGET_ATTAINMENT_PCT', name: 'Sub-group target met', unit: 'percentage', phase: '19.5', requirable: false },
  /*
   * Phase 19.7 (P19.7-T2; ADR-0221 §7; the proposal spec's decision 4): **the one figure a leader reads about a member's
   * proposals** — those first saved as a PDF in the period (`domain/metrics/proposals-made.ts`). Not requirable: a count
   * of a member's own working documents, nothing a campaign requirement names, registered after campaign evaluation.
   */
  { key: 'PROPOSALS_MADE', name: 'Proposals made', unit: 'count', phase: '19.7', requirable: false },
];

/**
 * **Metric keys a stored rule may still hold, and the metric each now reads** (P19.3-T1; ADR-0201 §1): a rule written
 * before a rename, which migration `0051-moc-ape-key` did not reach — a rule of an office's own, a row restored later —
 * is read as the metric that took its place, never as a metric nobody registered. A key retired with no successor is
 * not here: it reads *not measured*, as ADR-0035 says.
 */
export const RENAMED_METRIC_KEYS: Readonly<Record<string, string>> = {
  NET_APE: 'MOC_APE',
};

/** The registered key a stored key reads: itself, or the metric that took its place (`RENAMED_METRIC_KEYS`). */
export const currentMetricKey = (key: string): string => RENAMED_METRIC_KEYS[key] ?? key;

export const metricByKey = (key: string): MetricDefinition | undefined =>
  METRIC_REGISTRY.find((m) => m.key === key);

/**
 * **What a campaign requirement or a qualification rule may name** (ADR-0035): every metric but those
 * about an office rather than a member (`requirable: false`). `GET /metrics` serves this list, the
 * requirement DTO enumerates it, and `checkCampaign` refuses a key outside it by name.
 */
export const REQUIREMENT_METRICS: readonly MetricDefinition[] = METRIC_REGISTRY
  .filter((m) => m.requirable !== false);

/**
 * **What a campaign requirement may name** (Phase 18.2, D-evaluable): the metrics carrying a `campaign` reading —
 * a member's own production over whole months, their logged activity, the office's five ratios, and their Direct
 * Unit's active agents. `GET /metrics` serves the flag, the Owner's picker offers only these, `checkCampaign`
 * refuses anything else by name, and a requirement stored before the set existed reads *Not measured yet*.
 *
 * **Not in it, and why**: `TRAINING_COMPLETION_PCT` (a self-declared toggle), `EVENT_ATTENDANCE_RATE` and
 * `EVENT_NPS` (two figures per event, not per member), every target and pro-rated target —
 * `SUB_PERIOD_ACTIVITY_TARGET` among them, which answers Phase 11's carried question — every enum and boolean,
 * `CAMPAIGN_QUALIFICATION_STATUS` itself, and every office count.
 */
export const CAMPAIGN_METRICS: readonly MetricDefinition[] = METRIC_REGISTRY.filter((m) => m.campaign !== undefined);

/** Is this key one a campaign requirement may name? */
export const isCampaignMetric = (key: string): boolean => metricByKey(key)?.campaign !== undefined;

/**
 * The phase that evaluates a campaign, which is what a requirement has to be computable by.
 *
 * A requirement naming a metric computed after this is refused, saying the metric is not measured
 * yet and naming no phase (P10.1-T2 AC-3, ADR-0062 §3), rather than being accepted and silently
 * never qualifying anybody. `GET /metrics` reports the same comparison as `computed`.
 *
 * **14 is Phase 14, campaigns (P14-T5, P14-T6)** — the old plan's 12, moved by the crosswalk with
 * the metrics above (P10.1-T2 AC-6). The move has one behavioural consequence, decided rather than
 * inherited (AC-7): coaching is Phase 11 now and precedes campaign evaluation, so the six metrics
 * coaching computes — `COACHED_7D`, `COACHED_30D`, `DAYS_SINCE_LAST_COACHING`, `COACHING_COVERAGE`,
 * `GOAL_PACE_STATUS`, `PACING_TO_MAA` — are measured by the time a campaign is evaluated, and a
 * campaign may require one. Nothing else changed sides: the unit rollups (15) and the Owner's
 * reporting metrics (18) were refused before and are refused still. `registry.spec.ts` pins both
 * sets by key, and the difference between them.
 *
 * *Amended 2026-10-08 (the re-plan that puts training, events and campaigns last):* **18.2 is
 * Phase 18.2, campaigns (P18.2-T7, P18.2-T8; were P14-T5, P14-T6)**, which comes after the Unit
 * Dashboard (15) and the Owner's reporting (18). The move has one behavioural consequence, decided
 * and recorded with the re-plan: the unit rollups (15) and the Owner's reporting metrics (18) are
 * now measured before campaigns are evaluated, so a campaign may require one of those seven, and no
 * metric registered today is refused as not measured yet. The refusal stays for a metric registered
 * after campaign evaluation. `LEADERS_USED` stays out of every requirement: it is `requirable: false`
 * whatever its phase. `registry.spec.ts` pins the new set by key, and the difference from the old.
 */
export const CAMPAIGN_EVALUATION_PHASE: Phase = '18.2';

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
 * `MOC_PERSISTENCY_MIN_PCT` (§B.6): the rolling persistency a leader's MOC asks for, AB and AAB alike — the
 * prototype's *"Rolling Persistency DU/DG ≥ 75%"* (`KPM_Owner.html:1248`, `:3305`, `:3313`). The seeded rules
 * lacked it until migration `0026-moc-persistency` added it (P18-T2, D-moc).
 */
export const MOC_PERSISTENCY_MIN_PCT = 75;

/*
 * `NEW_AGENT_ACTIVE_MONTHS` (4, Phase 18.1) was here: the months `NEW_AGENT_3M_ACTIVE_PCT` read of a hire. Retired with
 * it by ADR-0171 §2 (P18.8-T6); 3M activation counts days from the join date (`ACTIVATION_3M.DAYS`, `joining.ts`).
 */

/**
 * Maintenance of Contract, as the carrier states it (ADR-0026, P5-T7 AC-6).
 *
 * **The thresholds are ported; none of the prototype's derivations are.** The prototype fabricates
 * `monthly2Aa` from a headcount it has to hand, which is a different number wearing the carrier's
 * name. Each criterion below names the metric it needs. Until Phase 18 registered them (D-registry) the
 * ones the registry did not define were listed on the rule as `waitingOnMetrics`, so a screen could say
 * what it waited on rather than show a rule that silently never passes; every one is registered now, and
 * `MOC_STATUS` evaluates them (`domain/metrics/moc-status.ts`).
 */
export const SEED_MOC_RULES = [
  {
    code: 'MOC_AB',
    name: 'Maintenance of Contract — AB',
    appliesToOrgLevelCodes: ['AB'],
    /** APE **and** both Monthly2 AA counts **and** persistency, **or** five direct ABs. */
    criteriaGroups: [
      {
        mode: 'all' as const,
        criteria: [
          // `NET_APE` until P19.3-T1 (ADR-0201 §1, D5): the same APE, under its own name.
          { metricKey: 'MOC_APE', comparator: 'gte' as const, value: 600_000_000 * IDR },
          { metricKey: 'MONTHLY2_AA_DU', comparator: 'gte' as const, value: 4 },
          { metricKey: 'MONTHLY2_AA_DG', comparator: 'gte' as const, value: 6 },
          // P18-T2, D-moc: the criterion the prototype draws and the first seed left out (`0026-moc-persistency`).
          { metricKey: 'MOC_PERSISTENCY', comparator: 'gte' as const, value: MOC_PERSISTENCY_MIN_PCT },
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
          { metricKey: 'MOC_APE', comparator: 'gte' as const, value: 200_000_000 * IDR },
          { metricKey: 'MONTHLY2_AA', comparator: 'gte' as const, value: 2 },
          { metricKey: 'MOC_PERSISTENCY', comparator: 'gte' as const, value: MOC_PERSISTENCY_MIN_PCT },
        ],
      },
    ],
    groupMode: 'any' as const,
  },
] as const;
