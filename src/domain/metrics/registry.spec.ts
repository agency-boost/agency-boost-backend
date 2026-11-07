import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVATION, ACTIVATION_3M, PERFORMANCE, RATIO_BENCHMARKS } from '@/domain/constants';
import {
  CAMPAIGN_EVALUATION_PHASE, CAMPAIGN_METRICS, comparePhases, currentMetricKey, METRIC_REGISTRY as SERVED, RENAMED_METRIC_KEYS,
  REQUIREMENT_METRICS, SEED_MOC_RULES, isCampaignMetric,
} from '@/domain/constants/metrics';
import { METRIC_IDS, METRIC_REGISTRY, metric, define, join as joinLists } from './registry';

const DOC = join(__dirname, '../../../../docs/00-product/metrics-and-definitions.md');

/**
 * The document's index table — `| \`ID\` | Name | Unit | Phase |` — one row per metric, or one row for
 * two ids written `A` / `B`.
 */
function indexRows(): { ids: string[]; name: string; phase: string }[] {
  const text = readFileSync(DOC, 'utf8');
  const table = text.slice(text.indexOf('| Code | Name | Unit | Phase |'));
  const rows: { ids: string[]; name: string; phase: string }[] = [];
  for (const line of table.split('\n').slice(2)) {
    if (!line.startsWith('| `')) break;
    const [, codes, name, , phase] = line.split('|').map((cell) => cell.trim());
    rows.push({ ids: [...codes.matchAll(/`([A-Z_0-9]+)`/g)].map((m) => m[1]), name, phase });
  }
  return rows;
}

/** Every `### \`ID\`` heading in the registry document. */
function documentedIds(): string[] {
  // A heading may define two — `COACHED_7D` and `COACHED_30D` share one — so every id before its dash.
  return [...readFileSync(DOC, 'utf8').matchAll(/^### (`[A-Z_0-9]+`(?:(?: and |, | \/ )`[A-Z_0-9]+`)*)/gm)]
    .flatMap((m) => [...m[1].matchAll(/`([A-Z_0-9]+)`/g)].map((id) => id[1]));
}

describe('the metric registry (P4-T4)', () => {
  describe('one definition per metric (AC-1, AC-3)', () => {
    it('registers each id exactly once', () => {
      // The module throws at load on a duplicate, so reaching here proves it. This pins
      // that the guard is still there rather than quietly removed.
      expect(METRIC_IDS.length).toBe(new Set(METRIC_IDS).size);
      expect(METRIC_REGISTRY.size).toBe(METRIC_IDS.length);
    });

    it('names every metric the document defines, and no others', () => {
      /*
       * The pair that makes invariant §8 enforceable rather than aspirational. A metric
       * added to code without a definition is the thing that produced three conflicting
       * "active agent"s; one added to the document without code is a definition nobody
       * can bind to.
       */
      expect([...METRIC_IDS].sort()).toEqual([...documentedIds()].sort());
    });

    it('refuses a metric nobody registered, naming what to do instead', () => {
      // `undefined` would surface three layers away as a blank card.
      expect(() => metric('ACTIVE_AGENT')).toThrow(/No metric called ACTIVE_AGENT/);
      expect(() => metric('ACTIVE_AGENT')).toThrow(/registers a new named metric/);
    });

    it('has exactly one metric whose name is the resolved "active agent"', () => {
      /*
       * The conflict this registry exists to end. Four surfaces in the two prototypes use
       * "active" for a member and no two mean the same thing; the document resolves it to
       * D1 — production, not activity — and rescues D2 and D3 under their own names.
       */
      const activeish = METRIC_IDS.filter((id) => id.includes('ACTIVE_AGENT'));
      // P18.9-T1 AC-6: *New AA (avg. monthly)*, `NEW_ACTIVE_AGENTS_MONTHLY_AVG`, is retired (ADR-0175 §2). *Annual
      // Active Agents* is `PRODUCING_AGENTS`' name, the same definition over a year — `MONTHLY_ACTIVE_AGENT` in a month.
      expect(activeish.sort()).toEqual(['MONTHLY_ACTIVE_AGENT', 'NEW_ACTIVE_AGENTS']);
      // And the engagement measure is not called an active agent anywhere.
      expect(metric('ACTIVITY_COMPLIANCE_MONTH').label).toBe('Activity-logging compliance, this month');
    });
  });

  describe('numbers live once (AC-2, invariant §7)', () => {
    it('reads its thresholds from the constants module rather than restating them', () => {
      expect(metric('SELLING_SUCCESS_RATE').threshold)
        .toBe(RATIO_BENCHMARKS.SELLING_SUCCESS_RATE);
      expect(metric('SELLING_RECRUITMENT_BALANCE').threshold)
        .toBe(RATIO_BENCHMARKS.BALANCE_BAND_PP);
      expect(metric('GOAL_PACE_STATUS').threshold)
        .toBe(PERFORMANCE.ON_TRACK_PACE_THRESHOLD);
      expect(metric('COACHED_7D').threshold).toBe(PERFORMANCE.COACHING_OVERDUE_DAYS);
      expect(metric('ACTIVATION_DAY_INDEX').threshold).toBe(ACTIVATION.WINDOW_DAYS);
      expect(metric('PACING_TO_MAA').threshold).toBe(PERFORMANCE.MAA_PROJECTED_SUBMISSIONS_MIN);
    });

    it('P11-T6 AC-4 evaluates GOAL_PACE_STATUS and PACING_TO_MAA on the calendar month (ADR-0080)', () => {
      // `CALENDAR_YEAR` until the first task to compute it: the stale half `metrics-and-definitions.md`
      // §A.4 named. The document and the prototype's tooltip both say the calendar month.
      expect(metric('GOAL_PACE_STATUS').period).toBe('CALENDAR_MONTH');
      expect(metric('PACING_TO_MAA').period).toBe('CALENDAR_MONTH');
    });

    it('declares no threshold where there is nothing to compare against', () => {
      // A count has no benchmark. A zero would read as one, and a screen would draw a bar.
      expect(metric('MAA_COUNT_IN_UNIT').threshold).toBeNull();
      expect(metric('EVENT_NPS').threshold).toBeNull();
      // The closing floor is part of the formula, not a benchmark the target is judged against.
      expect(metric('SUB_PERIOD_ACTIVITY_TARGET').threshold).toBeNull();
    });

    it('P13.1-T5 AC-2, AC-4 registers the pace sentence’s N over the last 30 days, and no run-rate (ADR-0109)', () => {
      expect(metric('CLOSINGS_LAST_30_DAYS')).toMatchObject({
        period: 'ROLLING_30D', unit: 'count', phase: '13.1', threshold: null, label: 'Closings over the last 30 days',
      });
      // The needed pace is still this month's: the weeks left are the office's calendar month.
      expect(metric('CLOSINGS_NEEDED_PER_WEEK').period).toBe('CALENDAR_MONTH');
      expect(() => metric('PROJECTED_CLOSINGS_THIS_MONTH')).toThrow(/No metric called PROJECTED_CLOSINGS_THIS_MONTH/);
    });

    it('P11-T4 AC-6 registers SUB_PERIOD_ACTIVITY_TARGET before it is served: the last 7 days, a count, Phase 11', () => {
      expect(metric('SUB_PERIOD_ACTIVITY_TARGET')).toMatchObject({
        period: 'ROLLING_7D', unit: 'count', phase: '11', label: 'Activity target for the last 7 days, pro-rated',
      });
    });

    it('restates no number as a literal', () => {
      /*
       * Structural: every threshold in the file must be an expression reading a constant,
       * never a number typed in place. A literal here is a second source for a benchmark,
       * which is exactly what invariant §7 forbids.
       */
      const source = readFileSync(join(__dirname, 'registry.ts'), 'utf8');
      const literals = [...source.matchAll(/threshold:\s*([^,\n]+)/g)]
        .map((m) => m[1].trim())
        .filter((value) => value !== 'null' && /^-?[\d._]+$/.test(value));
      expect(literals).toEqual([]);
    });
  });

  describe('what each metric answers with', () => {
    it('keeps Monthly Active Agent tri-state, because the unknown is load-bearing', () => {
      // `null` means "no production uploaded for this month", which is not `false`. An
      // office that has not uploaded September must show an em dash, not "0 active agents".
      expect(metric('MONTHLY_ACTIVE_AGENT').unit).toBe('tri_state');
    });

    it('keeps a rolling window and a calendar month apart', () => {
      // Scaling one into the other is how a 7-day compliance figure comes to be compared
      // against a monthly target and quietly reads three times too low.
      expect(metric('ACTIVITY_COMPLIANCE_7D').period).toBe('ROLLING_7D');
      expect(metric('ACTIVITY_COMPLIANCE_MONTH').period).toBe('CALENDAR_MONTH');
      expect(metric('MONTHLY_ACTIVE_AGENT').period).toBe('CALENDAR_MONTH');
    });

    it('says which phase each one becomes real in, honestly', () => {
      // Most of these cannot be computed yet, and saying so is what stops a screen being
      // built against a definition whose data does not exist.
      expect(metric('MONTHLY_ACTIVE_AGENT').phase).toBe('9');
      expect(metric('SELLING_SUCCESS_RATE').phase).toBe('6');
      // Computed since P7-T6 — the index said 14, and a campaign asking was told it could not be.
      expect(metric('RECRUITMENT_PIPELINE_NOW').phase).toBe('7');
      // Coaching is Phase 11 since the 2026-09-29 re-plan; the old plan's 13 is the Unit Dashboard's 15.
      expect(metric('COACHED_7D').phase).toBe('11');
      for (const id of METRIC_IDS) {
        expect(comparePhases(metric(id).phase, '4')).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('P10.1-T2 AC-6, AC-7 — the phases are the current plan’s, and what each move changed', () => {
    /*
     * The 2026-09-29 re-plan moved the old Phases 11–15 to 13, 14, 15, 18 and 20 and brought
     * coaching forward to 11 (`roadmap-and-phases.md`, *The 2026-09-29 re-plan*). `metrics.ts`
     * carried the old numbers until 2026-10-01. This is the crosswalk as applied, by key, so a
     * number from the old plan put back fails here by name rather than as a diff in a 47-row index.
     * Old 13 split by the task that first computes each metric.
     *
     * *Amended 2026-10-08:* that day's re-plan put training, events and campaigns last, in a new
     * Phase 18.2, and moved four numbers a second time: the three enablement metrics and campaign
     * evaluation, 14 → 18.2. The tests of the first move read the 2026-09-29 plan's phases — today's,
     * with `MOVED_2026_10_08` undone — so they still say what that move did. The block at the end
     * pins the second move, and the line campaigns are evaluated at today.
     */
    const MOVED: Record<string, { from: string; to: string }> = {
      // Coaching's six → 11: the session metrics (P11-T5, P11-T8), coverage (P11-T10), and the
      // roster's Status, `GOAL_PACE_STATUS` over `PACING_TO_MAA` (P11-T6).
      COACHED_7D: { from: '13', to: '11' },
      COACHED_30D: { from: '13', to: '11' },
      DAYS_SINCE_LAST_COACHING: { from: '13', to: '11' },
      COACHING_COVERAGE: { from: '13', to: '11' },
      GOAL_PACE_STATUS: { from: '13', to: '11' },
      PACING_TO_MAA: { from: '13', to: '11' },
      // The unit rollups → 15 (P15-T1).
      MAA_COUNT_IN_UNIT: { from: '13', to: '15' },
      ACTIVITY_COMPLIANCE_RATE: { from: '13', to: '15' },
      // Activation, 11 → 13 (P13-T1, P13-T2).
      ACTIVATION_COMPLETION_PCT: { from: '11', to: '13' },
      ACTIVATION_DAY_INDEX: { from: '11', to: '13' },
      // Enablement, 12 → 14 (then P14-T1, P14-T3, P14-T6; 18.2 since 2026-10-08, below).
      TRAINING_COMPLETION_PCT: { from: '12', to: '14' },
      EVENT_ATTENDANCE_STATUS: { from: '12', to: '14' },
      CAMPAIGN_QUALIFICATION_STATUS: { from: '12', to: '14' },
      // Owner reporting, 14 → 18 (P18-T1 to P18-T3; P18-T3 is P18.2-T10 since 2026-10-08).
      LEADER_COACHING_FREQUENCY: { from: '14', to: '18' },
      EVENT_ATTENDANCE_RATE: { from: '14', to: '18' },
      EVENT_NPS: { from: '14', to: '18' },
      MOC_STATUS: { from: '14', to: '18' },
      PRODUCTION_CLUB_TIER: { from: '14', to: '18' },
    };
    /** Campaigns were the old plan's Phase 12; the 2026-09-29 plan made them 14 (then P14-T5, P14-T6). */
    const OLD_CAMPAIGN_EVALUATION_PHASE = '12';

    /**
     * The 2026-10-08 re-plan (`roadmap-and-phases.md`, *Amended 2026-10-08*): training, events and
     * campaigns go last, at the product owner's priority. Phase 14 is Sales tools now, and the tasks
     * that compute these are Phase 18.2's: P18.2-T1, P18.2-T5 and P18.2-T8 (were P14-T1, P14-T3,
     * P14-T6).
     */
    const MOVED_2026_10_08: Record<string, { from: string; to: string }> = {
      TRAINING_COMPLETION_PCT: { from: '14', to: '18.2' },
      EVENT_ATTENDANCE_STATUS: { from: '14', to: '18.2' },
      CAMPAIGN_QUALIFICATION_STATUS: { from: '14', to: '18.2' },
    };
    /**
     * P15-T0 (D-metrics), the same day: the Unit Dashboard draws neither unit rollup, so both move to the
     * Owner's reporting, whose screens draw them (`KPM_Owner.html:1248`, `:982-985`).
     */
    const MOVED_BY_P15: Record<string, { from: string; to: string }> = {
      MAA_COUNT_IN_UNIT: { from: '15', to: '18' },
      ACTIVITY_COMPLIANCE_RATE: { from: '15', to: '18' },
    };
    /**
     * P18-T0 (D-registry), 2026-10-09: the two event metrics move to 18.2, whose screens read them — the
     * compliance, events and campaigns tree. A metric of Phase 18 that read event records would be a roadmap
     * defect.
     */
    const MOVED_BY_P18: Record<string, { from: string; to: string }> = {
      EVENT_ATTENDANCE_RATE: { from: '18', to: '18.2' },
      EVENT_NPS: { from: '18', to: '18.2' },
    };
    /** Campaign evaluation under the 2026-09-29 plan; 18.2 since 2026-10-08 (P18.2-T7, P18.2-T8). */
    const SEPT_29_CAMPAIGN_EVALUATION_PHASE = '14';
    /** A metric's phase under the 2026-09-29 plan: today's, with 2026-10-08's and 2026-10-09's moves undone. */
    const sept29Phase = (id: string): string =>
      MOVED_2026_10_08[id]?.from ?? MOVED_BY_P15[id]?.from ?? MOVED_BY_P18[id]?.from ?? metric(id).phase;
    /** The metrics about an office rather than a member: measured, and no requirement's to name. */
    const NOT_REQUIRABLE = SERVED.filter((m) => m.requirable === false).map((m) => m.key);

    const COACHING_SIX = [
      'COACHED_7D', 'COACHED_30D', 'DAYS_SINCE_LAST_COACHING', 'COACHING_COVERAGE', 'GOAL_PACE_STATUS', 'PACING_TO_MAA',
    ];
    /** The unit rollups (15 under that plan, 18 since P15-T0) and the Owner's reporting metrics (18). */
    const ROLLUPS_AND_REPORTING = [
      'MAA_COUNT_IN_UNIT', 'ACTIVITY_COMPLIANCE_RATE', 'LEADER_COACHING_FREQUENCY',
      'EVENT_ATTENDANCE_RATE', 'EVENT_NPS', 'MOC_STATUS', 'PRODUCTION_CLUB_TIER',
    ];

    /**
     * Metrics registered after the re-plan, each with the phase of the task that first computes it. The
     * crosswalk never moved them and the old plan never had them, so the comparisons below leave them out.
     */
    const REGISTERED_SINCE: Record<string, string> = {
      // P11-T4: the coaching session's Activity card.
      SUB_PERIOD_ACTIVITY_TARGET: '11',
      // P13.1-T5 (ADR-0109): the pace sentence's *N*, replacing `PROJECTED_CLOSINGS_THIS_MONTH`.
      CLOSINGS_LAST_30_DAYS: '13.1',
      // P13.2-T4 (ADR-0113): the office's leaders, which its leader limit bounds.
      LEADERS_USED: '13.2',
      // P15-T1 (D-leads, D-metrics): the Unit Dashboard's roster.
      OPEN_SALES_LEADS: '15',
      SALES_LEADS_CLOSING_THIS_MONTH: '15',
      RECRUITMENT_NOMINATED_THIS_MONTH: '15',
      // UI V1 (Phase 18.11 T4, UI-028): the roster's *Closing*.
      SALES_LEADS_CLOSED_IN_PERIOD: '18.11',
      POTENTIAL_MAA_COUNT_IN_UNIT: '15',
      CASCADE_ACTIVITY_TOUCHES: '15',
      // P18-T1, P18-T2 (D-registry): the Owner's reporting — the office's five, and MOC's six inputs. P19.3-T1 retired
      // `ACTIVITY_LOGGED_THIS_MONTH` (ADR-0200 §3) and `NET_APE`, whose definition is `MOC_APE`'s at its phase (ADR-0201 §1).
      OFFICE_HEADCOUNT: '18',
      OFFICE_NEW_MEMBERS_THIS_MONTH: '18',
      RECRUITMENT_CLOSED_LAST_MONTH: '18',
      APE_YEAR_PROJECTION: '18',
      MOC_APE: '18',
      MONTHLY2_AA: '18',
      MONTHLY2_AA_DU: '18',
      MONTHLY2_AA_DG: '18',
      DIRECT_AB_COUNT: '18',
      MOC_PERSISTENCY: '18',
      // P18.1-T1 (D-cohort, OD-144): the Strategic Leader Forum's scorecard, and the cohort it reads.
      ACTIVATION_COHORT: '18.1',
      // `NEW_AGENT_3M_ACTIVE_PCT` (18.1) retired by ADR-0171 §2 (P18.8-T6) for `ACTIVATION_3M_PCT`, below, and
      // `NEW_ACTIVE_AGENTS_MONTHLY_AVG` (18.1) by ADR-0175 §2 (P18.9-T1 AC-6).
      PRODUCING_AGENTS: '18.1',
      MAA_MONTHLY_AVG: '18.1',
      CASE_SUBMISSIONS: '18.1',
      AVERAGE_CASE_SIZE_REALISED: '18.1',
      // P18.2-T8 (OD-152 → option 3): the file's `recruitment` column, the campaigns' *New Hire*.
      NEW_HIRES: '18.2',
      // P18.3-T1 (OD-159, OD-160): the Owner's compliance tree's two chips that needed a definition.
      ACTIVATION_COMPLETION_RATE: '18.3',
      GOAL_SET_RATE: '18.3',
      // P18.8-T4 (ADR-0171 §1): the first sale's day, kept on the membership.
      FIRST_SALE_DATE: '18.8',
      // P18.8-T5 (ADR-0172 §2): who a unit's production and *on pace* read.
      COUNTS_FOR_PRODUCTION: '18.8',
      // P18.8-T6 (ADR-0171 §2): a new hire's 3M result, and the share activated — the one 3M metric.
      ACTIVATION_3M: '18.8',
      ACTIVATION_3M_PCT: '18.8',
      // P18.9-T1 AC-5 (ADR-0175 §2): the reference slide's *Cases/producing agents*.
      CASES_PER_PRODUCING_AGENT: '18.9',
      // P19.1-T6 (ADR-0193): the Unit Dashboard's *Potensi* tab — a lead's switch, the tab's AA, a kandidat's rekrut.
      LEAD_POTENSI_THIS_MONTH: '19.1',
      AA_THIS_MONTH: '19.1',
      REKRUT_THIS_MONTH: '19.1',
      // P19.3-T1 (ADR-0201 to ADR-0203): a leader row's uploaded unit persistency, and the forum's D7 and recruitment rows.
      UNIT_PERSISTENCY: '19.3',
      NEW_AGENT_ACTIVATION_3M_PCT: '19.3',
      RECRUITMENT_MONTHLY_AVG: '19.3',
      // P19.5-T4 (ADR-0216 §4): the surveys' six, each over a run.
      NPS_SCORE: '19.5',
      SURVEY_RESPONSE_RATE: '19.5',
      QUAL_ITEM_ISSUE_PCT: '19.5',
      QUAL_PERSON_ISSUE_COUNT: '19.5',
      QUAL_LEADER_SUPPORT: '19.5',
      QUAL_COACHING_DOWNLINE_PCT: '19.5',
      // P19.5-T2 (ADR-0214 §10, §11): the Data upload's month complete, and a column's calculated year to date.
      UPLOAD_MONTH_COMPLETE: '19.5',
      COLUMN_YEAR_TO_DATE: '19.5',
      // P19.5-T3 (ADR-0215): the *Advanced analytics* page's nineteen — Demographics, the events' NPS, Quant, the peers, Sub-group.
      MANPOWER_BY_DIMENSION: '19.5',
      EVENT_NPS_FOR_PERIOD: '19.5',
      QUANT_RECRUITS_PER_LEADER: '19.5',
      QUANT_ANNUAL_ACTIVE_NET_GROWTH: '19.5',
      QUANT_ACTIVE_PER_LEADER: '19.5',
      QUANT_ACTIVATION_12M_PCT: '19.5',
      QUANT_TENURED_ACTIVE_PCT: '19.5',
      QUANT_AVG_MAA_PER_LEADER: '19.5',
      QUANT_AVG_ACTIVE_MONTHS: '19.5',
      QUANT_PEER_MEDIAN: '19.5',
      QUANT_PEER_STATUS: '19.5',
      SUBGROUP_MAA_BASELINE: '19.5',
      SUBGROUP_HEAD_ACTIVE_DAYS: '19.5',
      SUBGROUP_DOWNLINE_ADOPTION_PCT: '19.5',
      POWER_USER_COUNT: '19.5',
      SUBGROUP_ONE_ON_ONES_PER_WEEK: '19.5',
      SUBGROUP_WEEKLY_ACTIVITY_TARGET: '19.5',
      SUBGROUP_RECRUITMENT_BASELINE: '19.5',
      SUBGROUP_TARGET_ATTAINMENT_PCT: '19.5',
      // P19.7-T2 (ADR-0221 §7): the Unit Dashboard's *Proposal* count.
      PROPOSALS_MADE: '19.7',
      // P19.8-T2 (ADR-0228 §4, OD-283): Home's *Leads* tile.
      OWN_OPEN_LEADS: '19.8',
    };
    const existedBefore = (id: string) => !(id in REGISTERED_SINCE);

    /** The metrics measured by the time a campaign is evaluated, under a given plan. */
    const computableAt = (evaluationPhase: string, phaseOf: (id: string) => string): string[] =>
      METRIC_IDS.filter((id) => comparePhases(phaseOf(id), evaluationPhase) <= 0).sort();

    /** What the 2026-09-29 plan's campaign evaluation could read: 41 metrics, Leaders used aside. */
    const SEPT_29_COMPUTED = [
      'ACTIVATION_COMPLETION_PCT', 'ACTIVATION_DAY_INDEX',
      'ACTIVITY_COMPLIANCE_7D', 'ACTIVITY_COMPLIANCE_MONTH', 'ACTIVITY_TARGET_ATTAINMENT_PCT', 'ACTIVITY_TOTAL_BY_CATEGORY',
      'APE_ACHIEVED', 'APE_ATTAINMENT_PCT', 'APE_GAP_TO_TARGET', 'APE_TARGET', 'APPOINTMENT_TARGET',
      'CAMPAIGN_QUALIFICATION_STATUS', 'CLOSINGS_NEEDED_PER_WEEK',
      'COACHED_30D', 'COACHED_7D', 'COACHING_COVERAGE', 'DAYS_SINCE_LAST_COACHING',
      'EVENT_ATTENDANCE_STATUS', 'GOAL_PACE_STATUS',
      'LEADS_PER_ACTIVITY', 'LEAD_TARGET',
      'MEASURED_CLOSING_RATE', 'MEASURED_LEAD_TO_APPOINTMENT_RATE', 'MEETING_PER_APPROACH',
      'MONTHLY_ACTIVE_AGENT', 'MONTHLY_APE_TARGET', 'MONTHS_LEFT_IN_YEAR', 'NEW_ACTIVE_AGENTS',
      'PACING_TO_MAA', 'POLICIES_NEEDED', 'POLICY_COUNT_TARGET', 'CLOSINGS_LAST_30_DAYS',
      'RECRUITMENT_EXPECTED_TO_CLOSE', 'RECRUITMENT_PIPELINE_NOW', 'RECRUITMENT_SUCCESS_RATE', 'ROLLING_PERSISTENCY',
      'SELLING_RECRUITMENT_BALANCE', 'SELLING_SUCCESS_RATE', 'SUB_PERIOD_ACTIVITY_TARGET', 'SUMMARY_ACTIVITY_TARGET',
      'TRAINING_COMPLETION_PCT',
    ];

    it('moved every deferred metric by the crosswalk, and nothing that had shipped', () => {
      for (const [id, { to }] of Object.entries(MOVED)) {
        expect({ id, phase: sept29Phase(id) }).toEqual({ id, phase: to });
      }
      // Nothing that shipped reopens: what Phases 4–10 computed keeps its number.
      for (const id of METRIC_IDS.filter((id) => !(id in MOVED) && existedBefore(id))) {
        expect({ id, shipped: comparePhases(metric(id).phase, '10') <= 0 }).toEqual({ id, shipped: true });
      }
      // And a metric registered since sits in the phase that computes it.
      for (const [id, phase] of Object.entries(REGISTERED_SINCE)) {
        expect({ id, phase: metric(id).phase }).toEqual({ id, phase });
      }
      // And no phase that plan gave no metric to: an old-plan 12 left behind would have read as
      // Calendar's, 16 was Billing, 17 Recruitment tools, 19 go-live. Today's set is pinned below.
      const phases = [...new Set(METRIC_IDS.map(sept29Phase))].sort(comparePhases);
      // 18.2 since P18.2-T8 registered *New Hire* (`NEW_HIRES`), a metric that plan never had; 18.3 since P18.3-T1;
      // 18.8 since P18.8-T4 (`FIRST_SALE_DATE`); 18.9 since P18.9-T1 (`CASES_PER_PRODUCING_AGENT`); 18.11 since UI V1
      // (`SALES_LEADS_CLOSED_IN_PERIOD`); 19.1 since P19.1-T6 (the *Potensi* tab's three, ADR-0193); 19.3 since P19.3-T1
      // (the data sources' three of 3 November, ADR-0201 to ADR-0203); 19.5 since P19.5-T4 (the surveys' six, ADR-0216).
      // 19.8 since P19.8-T2 (Home's *Leads*, `OWN_OPEN_LEADS`, ADR-0228 §4).
      expect(phases).toEqual(['6', '7', '8', '9', '10', '11', '13', '13.1', '13.2', '14', '15', '18', '18.1', '18.2', '18.3', '18.8', '18.9', '18.11', '19.1', '19.3', '19.5', '19.7', '19.8']);
    });

    it('evaluated campaigns in Phase 14 under that plan, the old plan’s 12: where campaign qualification is computed', () => {
      // Campaigns are evaluated by the task that computes their qualification, under every plan.
      expect(sept29Phase('CAMPAIGN_QUALIFICATION_STATUS')).toBe(SEPT_29_CAMPAIGN_EVALUATION_PHASE);
      expect(MOVED.CAMPAIGN_QUALIFICATION_STATUS.from).toBe(OLD_CAMPAIGN_EVALUATION_PHASE);
    });

    it('pinned, by key, every metric measured by the time a campaign was evaluated under that plan', () => {
      // `GET /metrics` served this comparison as `computed`, and `checkCampaign` refused its
      // complement — so this list was what an Owner could build a campaign on until 2026-10-08.
      // Leaders used is measured by then and is about an office, so it is no requirement (the test
      // after next).
      expect(computableAt(SEPT_29_CAMPAIGN_EVALUATION_PHASE, sept29Phase)
        .filter((id) => id !== 'LEADERS_USED')).toEqual([...SEPT_29_COMPUTED].sort());
    });

    it('P13.2-T4: keeps Leaders used, an office’s count, out of what a requirement may name', () => {
      expect(metric('LEADERS_USED')).toMatchObject({
        unit: 'count', phase: '13.2', period: 'POINT_IN_TIME', threshold: null, label: 'Leaders used',
      });
      expect(SERVED.find((m) => m.key === 'LEADERS_USED')?.requirable).toBe(false);
      expect(REQUIREMENT_METRICS.map((m) => m.key)).not.toContain('LEADERS_USED');
      // Since Phase 18 the office's headcount and its new members beside it (D-registry); every other metric is a
      // requirement's.
      expect(SERVED.filter((m) => !REQUIREMENT_METRICS.includes(m)).map((m) => m.key).sort()).toEqual([
        'LEADERS_USED', 'OFFICE_HEADCOUNT', 'OFFICE_NEW_MEMBERS_THIS_MONTH',
        // Since Phase 18.1 the forum's seven, each computed over an office alone (P18.1-T1 AC-4).
        'ACTIVATION_COHORT', 'AVERAGE_CASE_SIZE_REALISED', 'CASE_SUBMISSIONS', 'MAA_MONTHLY_AVG', 'PRODUCING_AGENTS',
        // Since Phase 18.6 the reference slide's *Cases/producing agents*, over an office alone too (P18.9-T1 AC-5).
        'CASES_PER_PRODUCING_AGENT',
        // Since Phase 18.3 the compliance tree's two shares of a set (P18.3-T1 AC-5, AC-7).
        'ACTIVATION_COMPLETION_RATE', 'GOAL_SET_RATE',
        // Since Phase 18.5 a person's first sale: a day, not something achieved over a window (P18.8-T4 AC-1).
        'FIRST_SALE_DATE',
        // And whom a unit's production covers: a rule about a total, nobody's achievement (P18.8-T5 AC-2).
        'COUNTS_FOR_PRODUCTION',
        // And 3M activation: a result decided once, and a share of a set (P18.8-T6 AC-1, AC-2).
        'ACTIVATION_3M', 'ACTIVATION_3M_PCT',
        // And UI V1's *Closing*, a roster column registered after campaign evaluation (Phase 18.11 T4, UI-028).
        'SALES_LEADS_CLOSED_IN_PERIOD',
        // And the *Potensi* tab's three, registered after campaign evaluation (P19.1-T6, ADR-0193).
        'AA_THIS_MONTH', 'LEAD_POTENSI_THIS_MONTH', 'REKRUT_THIS_MONTH',
        // And the data sources' three: a leader row's figure and two of the forum's rows (P19.3-T1, ADR-0201 to ADR-0203).
        'NEW_AGENT_ACTIVATION_3M_PCT', 'RECRUITMENT_MONTHLY_AVG', 'UNIT_PERSISTENCY',
        // And the surveys' six, each a run's figure or one person's answers (P19.5-T4, ADR-0216 §4).
        'NPS_SCORE', 'QUAL_COACHING_DOWNLINE_PCT', 'QUAL_ITEM_ISSUE_PCT', 'QUAL_LEADER_SUPPORT', 'QUAL_PERSON_ISSUE_COUNT', 'SURVEY_RESPONSE_RATE',
        // And the Data upload's two, a month's state and a sum (P19.5-T2, ADR-0214 §10, §11).
        'COLUMN_YEAR_TO_DATE', 'UPLOAD_MONTH_COMPLETE',
        // And the *Advanced analytics* page's nineteen, each a figure about an office or a group (P19.5-T3, ADR-0215).
        'MANPOWER_BY_DIMENSION', 'EVENT_NPS_FOR_PERIOD', 'QUANT_RECRUITS_PER_LEADER',
        'QUANT_ANNUAL_ACTIVE_NET_GROWTH', 'QUANT_ACTIVE_PER_LEADER', 'QUANT_ACTIVATION_12M_PCT',
        'QUANT_TENURED_ACTIVE_PCT', 'QUANT_AVG_MAA_PER_LEADER', 'QUANT_AVG_ACTIVE_MONTHS', 'QUANT_PEER_MEDIAN',
        'QUANT_PEER_STATUS', 'SUBGROUP_MAA_BASELINE', 'SUBGROUP_HEAD_ACTIVE_DAYS', 'SUBGROUP_DOWNLINE_ADOPTION_PCT',
        'POWER_USER_COUNT', 'SUBGROUP_ONE_ON_ONES_PER_WEEK', 'SUBGROUP_WEEKLY_ACTIVITY_TARGET',
        'SUBGROUP_RECRUITMENT_BASELINE', 'SUBGROUP_TARGET_ATTAINMENT_PCT',
        // And the proposals a member made, a count of their own documents (P19.7-T2, ADR-0221 §7).
        'PROPOSALS_MADE',
        // And Home's *Leads*, the reader's own open leads on one screen (P19.8-T2, ADR-0228 §4).
        'OWN_OPEN_LEADS',
      ].sort());
    });

    it('refused, by key, the seven nothing measured by then under that plan', () => {
      // The unit rollups (15) and the Owner's reporting metrics (18): refused before the move,
      // refused after it. `campaign.tenancy.spec.ts` proved it through the service for EVENT_NPS
      // until the 2026-10-08 re-plan put campaign evaluation after both (below).
      // The Unit Dashboard's five, registered since, were not in that plan at all.
      expect(METRIC_IDS.filter((id) => comparePhases(sept29Phase(id), SEPT_29_CAMPAIGN_EVALUATION_PHASE) > 0).filter(existedBefore).sort())
        .toEqual([...ROLLUPS_AND_REPORTING].sort());
    });

    it('changed that set in exactly one way, accepted: coaching precedes campaigns now, so a campaign may require a coaching metric (AC-7)', () => {
      /*
       * Decided, not inherited. Under the old plan coaching (13) came after campaign evaluation
       * (12), so a campaign could not require a coaching metric; now coaching is 11 and campaigns
       * 14, and the six pass. Nothing else changes sides. A renumbering that moved anything else
       * across the line — or that put the six back — fails here by name.
       */
      const before = computableAt(OLD_CAMPAIGN_EVALUATION_PHASE, (id) => MOVED[id]?.from ?? sept29Phase(id))
        .filter(existedBefore);
      const after = computableAt(SEPT_29_CAMPAIGN_EVALUATION_PHASE, sept29Phase).filter(existedBefore);

      expect(after.filter((id) => !before.includes(id))).toEqual([...COACHING_SIX].sort());
      expect(before.filter((id) => !after.includes(id))).toEqual([]);
      expect(after.length).toBe(before.length + COACHING_SIX.length);
    });

    describe('the 2026-10-08 re-plan — training, events and campaigns go last', () => {
      it('moved the three enablement metrics and campaign evaluation from 14 to 18.5', () => {
        for (const [id, { to }] of Object.entries(MOVED_2026_10_08)) {
          expect({ id, phase: metric(id).phase }).toEqual({ id, phase: to });
        }
        expect(CAMPAIGN_EVALUATION_PHASE).toBe('18.2');
        // Still where campaign qualification is computed.
        expect(metric('CAMPAIGN_QUALIFICATION_STATUS').phase).toBe(CAMPAIGN_EVALUATION_PHASE);
        // And no phase the plan gives no metric to. Phase 14 is Sales tools now and computes none;
        // 12 is Calendar's, 16 is retired, 17 Recruitment tools, 19 hardening.
        const phases = [...new Set(METRIC_IDS.map((id) => metric(id).phase))].sort(comparePhases);
        // 18.3 since P18.3-T1: the compliance tree's two, after campaign evaluation and no requirement's (below); 18.8
        // since P18.8-T4, the first sale's day, no requirement's either; 18.9 since P18.9-T1, *Cases/producing agents*.
        // 18.11 since UI V1: the roster's *Closing*, no requirement's. 19.1 since P19.1-T6: the *Potensi* tab's three. 19.3
        // since P19.3-T1: a leader row's unit persistency and two of the forum's rows, no requirement's.
        // 19.5 since P19.5-T4: the surveys' six, no requirement's. 19.8 since P19.8-T2: Home's *Leads*, no requirement's.
        expect(phases).toEqual(['6', '7', '8', '9', '10', '11', '13', '13.1', '13.2', '15', '18', '18.1', '18.2', '18.3', '18.8', '18.9', '18.11', '19.1', '19.3', '19.5', '19.7', '19.8']);
      });

      it('pins, by key, every metric measured by the time a campaign is evaluated: all of them', () => {
        // `GET /metrics` serves this comparison as `computed`, and `checkCampaign` refuses its
        // complement — so this list is what an Owner may build a campaign on. Leaders used is
        // measured by then and is about an office, so it is no requirement (the last test here).
        expect(computableAt(CAMPAIGN_EVALUATION_PHASE, (id) => metric(id).phase)
          .filter((id) => !NOT_REQUIRABLE.includes(id))).toEqual([
          // P18-T1, P18-T2: nine of the eleven, measured before campaigns are evaluated (the headcount and its
          // new members are no requirement's to name). P19.3-T1: `ACTIVITY_LOGGED_THIS_MONTH` retired, and `NET_APE`
          // is `MOC_APE`, at its phase.
          'APE_YEAR_PROJECTION', 'RECRUITMENT_CLOSED_LAST_MONTH',
          'DIRECT_AB_COUNT', 'MOC_PERSISTENCY', 'MONTHLY2_AA', 'MONTHLY2_AA_DG', 'MONTHLY2_AA_DU', 'MOC_APE',
          // P15-T1: the Unit Dashboard's five, measured before campaigns are evaluated.
          'CASCADE_ACTIVITY_TOUCHES', 'OPEN_SALES_LEADS', 'POTENTIAL_MAA_COUNT_IN_UNIT',
          'RECRUITMENT_NOMINATED_THIS_MONTH', 'SALES_LEADS_CLOSING_THIS_MONTH',
          'ACTIVATION_COMPLETION_PCT', 'ACTIVATION_DAY_INDEX',
          'ACTIVITY_COMPLIANCE_7D', 'ACTIVITY_COMPLIANCE_MONTH', 'ACTIVITY_COMPLIANCE_RATE',
          'ACTIVITY_TARGET_ATTAINMENT_PCT', 'ACTIVITY_TOTAL_BY_CATEGORY',
          'APE_ACHIEVED', 'APE_ATTAINMENT_PCT', 'APE_GAP_TO_TARGET', 'APE_TARGET', 'APPOINTMENT_TARGET',
          'CAMPAIGN_QUALIFICATION_STATUS', 'CLOSINGS_LAST_30_DAYS', 'CLOSINGS_NEEDED_PER_WEEK',
          'COACHED_30D', 'COACHED_7D', 'COACHING_COVERAGE', 'DAYS_SINCE_LAST_COACHING',
          'EVENT_ATTENDANCE_RATE', 'EVENT_ATTENDANCE_STATUS', 'EVENT_NPS', 'GOAL_PACE_STATUS',
          'LEADER_COACHING_FREQUENCY', 'LEADS_PER_ACTIVITY', 'LEAD_TARGET', 'MAA_COUNT_IN_UNIT',
          'MEASURED_CLOSING_RATE', 'MEASURED_LEAD_TO_APPOINTMENT_RATE', 'MEETING_PER_APPROACH', 'MOC_STATUS',
          'MONTHLY_ACTIVE_AGENT', 'MONTHLY_APE_TARGET', 'MONTHS_LEFT_IN_YEAR', 'NEW_ACTIVE_AGENTS',
          'PACING_TO_MAA', 'POLICIES_NEEDED', 'POLICY_COUNT_TARGET', 'PRODUCTION_CLUB_TIER',
          'RECRUITMENT_EXPECTED_TO_CLOSE', 'RECRUITMENT_PIPELINE_NOW', 'RECRUITMENT_SUCCESS_RATE', 'ROLLING_PERSISTENCY',
          'SELLING_RECRUITMENT_BALANCE', 'SELLING_SUCCESS_RATE', 'SUB_PERIOD_ACTIVITY_TARGET', 'SUMMARY_ACTIVITY_TARGET',
          'TRAINING_COMPLETION_PCT',
          // P18.2-T8 (OD-152): the campaigns' *New Hire*, registered at campaign evaluation.
          'NEW_HIRES',
        ].sort());
      });

      it('refuses none as not measured yet: no metric a requirement may name is computed after campaign evaluation', () => {
        // The refusal stays, for a requirable metric registered later; `campaign-input.spec.ts` proves it
        // with an evaluation placed earlier.
        expect(METRIC_IDS.filter((id) => comparePhases(metric(id).phase, CAMPAIGN_EVALUATION_PHASE) > 0 && !NOT_REQUIRABLE.includes(id))).toEqual([]);
        // P18.3-T1: the two registered after it are shares of a set, which no requirement may name whatever its phase;
        // P18.9-T1's *Cases/producing agents* is an office's figure, no requirement's either.
        expect(METRIC_IDS.filter((id) => comparePhases(metric(id).phase, CAMPAIGN_EVALUATION_PHASE) > 0).sort()).toEqual([
          'ACTIVATION_3M', 'ACTIVATION_3M_PCT', 'ACTIVATION_COMPLETION_RATE', 'CASES_PER_PRODUCING_AGENT', 'COUNTS_FOR_PRODUCTION',
          'FIRST_SALE_DATE', 'GOAL_SET_RATE', 'SALES_LEADS_CLOSED_IN_PERIOD',
          // P19.1-T6 (ADR-0193): the *Potensi* tab's three, no requirement's.
          'AA_THIS_MONTH', 'LEAD_POTENSI_THIS_MONTH', 'REKRUT_THIS_MONTH',
          // P19.3-T1 (ADR-0201 to ADR-0203): the data sources' three, no requirement's.
          'NEW_AGENT_ACTIVATION_3M_PCT', 'RECRUITMENT_MONTHLY_AVG', 'UNIT_PERSISTENCY',
          // P19.5-T4 (ADR-0216 §4): the surveys' six, no requirement's.
          'NPS_SCORE', 'QUAL_COACHING_DOWNLINE_PCT', 'QUAL_ITEM_ISSUE_PCT', 'QUAL_LEADER_SUPPORT', 'QUAL_PERSON_ISSUE_COUNT', 'SURVEY_RESPONSE_RATE',
          // P19.5-T2 (ADR-0214 §10, §11): the Data upload's two, no requirement's.
          'COLUMN_YEAR_TO_DATE', 'UPLOAD_MONTH_COMPLETE',
          // P19.5-T3 (ADR-0215): the *Advanced analytics* page's nineteen, no requirement's.
          'MANPOWER_BY_DIMENSION', 'EVENT_NPS_FOR_PERIOD', 'QUANT_RECRUITS_PER_LEADER',
          'QUANT_ANNUAL_ACTIVE_NET_GROWTH', 'QUANT_ACTIVE_PER_LEADER', 'QUANT_ACTIVATION_12M_PCT',
          'QUANT_TENURED_ACTIVE_PCT', 'QUANT_AVG_MAA_PER_LEADER', 'QUANT_AVG_ACTIVE_MONTHS', 'QUANT_PEER_MEDIAN',
          'QUANT_PEER_STATUS', 'SUBGROUP_MAA_BASELINE', 'SUBGROUP_HEAD_ACTIVE_DAYS',
          'SUBGROUP_DOWNLINE_ADOPTION_PCT', 'POWER_USER_COUNT', 'SUBGROUP_ONE_ON_ONES_PER_WEEK',
          'SUBGROUP_WEEKLY_ACTIVITY_TARGET', 'SUBGROUP_RECRUITMENT_BASELINE', 'SUBGROUP_TARGET_ATTAINMENT_PCT',
          // P19.7-T2 (ADR-0221 §7): the proposals made, no requirement's.
          'PROPOSALS_MADE',
          // P19.8-T2 (ADR-0228 §4): Home's *Leads*, no requirement's.
          'OWN_OPEN_LEADS',
        ].sort());
      });

      it('changed that set in exactly one way, decided: the unit rollups (15) and the Owner’s reporting metrics (18) precede campaigns now, so a campaign may require them', () => {
        /*
         * Decided with the re-plan, not inherited (`roadmap-and-phases.md`, *Amended 2026-10-08*).
         * Under the 2026-09-29 plan campaigns were evaluated in 14, before the Unit Dashboard and
         * the Owner's reporting, and those seven were refused; now campaigns are 18.2 and the seven
         * pass. The three enablement metrics moved with campaign evaluation, so they stay on the
         * same side. A renumbering that moved anything else across the line fails here by name.
         */
        // Over the metrics both plans had: the Unit Dashboard's five are registered since (below).
        const before = computableAt(SEPT_29_CAMPAIGN_EVALUATION_PHASE, sept29Phase).filter(existedBefore);
        const after = computableAt(CAMPAIGN_EVALUATION_PHASE, (id) => metric(id).phase).filter(existedBefore);

        expect(after.filter((id) => !before.includes(id))).toEqual([...ROLLUPS_AND_REPORTING].sort());
        expect(before.filter((id) => !after.includes(id))).toEqual([]);
        expect(after.length).toBe(before.length + ROLLUPS_AND_REPORTING.length);
      });

      it('keeps Leaders used out of every requirement although it is measured by then', () => {
        // Its phase was never the reason: it is an office's count, `requirable: false`.
        expect(computableAt(CAMPAIGN_EVALUATION_PHASE, (id) => metric(id).phase)).toContain('LEADERS_USED');
        expect(REQUIREMENT_METRICS.map((m) => m.key).sort())
          .toEqual(METRIC_IDS.filter((id) => !NOT_REQUIRABLE.includes(id)).sort());
      });
    });
  });

  describe('P15-T1 AC-6 — the Unit Dashboard’s metrics, and the two rollups it does not draw (D-metrics)', () => {
    const P15 = [
      'OPEN_SALES_LEADS', 'SALES_LEADS_CLOSING_THIS_MONTH', 'RECRUITMENT_NOMINATED_THIS_MONTH',
      'POTENTIAL_MAA_COUNT_IN_UNIT', 'CASCADE_ACTIVITY_TOUCHES',
    ];

    it('P15-T1 AC-6 registers the five the roster draws, each a count, Phase 15, and no threshold of its own', () => {
      expect(METRIC_IDS.filter((id) => metric(id).phase === '15').sort()).toEqual([...P15].sort());
      for (const id of P15) {
        expect({ id, unit: metric(id).unit, threshold: metric(id).threshold }).toEqual({ id, unit: 'count', threshold: null });
      }
      expect(metric('OPEN_SALES_LEADS').period).toBe('POINT_IN_TIME');
      // This office month's promises, and PACING_TO_MAA's month: the calendar month, whatever the toggle.
      for (const id of ['SALES_LEADS_CLOSING_THIS_MONTH', 'RECRUITMENT_NOMINATED_THIS_MONTH', 'POTENTIAL_MAA_COUNT_IN_UNIT']) {
        expect({ id, period: metric(id).period }).toEqual({ id, period: metric('PACING_TO_MAA').period });
      }
      expect(metric('CASCADE_ACTIVITY_TOUCHES').period).toBe('CALENDAR_MONTH');
    });

    it('P15-T1 AC-6 moves MAA_COUNT_IN_UNIT and ACTIVITY_COMPLIANCE_RATE from 15 to 18, still before campaigns', () => {
      expect(metric('MAA_COUNT_IN_UNIT').phase).toBe('18');
      expect(metric('ACTIVITY_COMPLIANCE_RATE').phase).toBe('18');
      expect(comparePhases(metric('MAA_COUNT_IN_UNIT').phase, CAMPAIGN_EVALUATION_PHASE)).toBeLessThan(0);
      // So a requirement may still name both, and every one of the five.
      for (const id of ['MAA_COUNT_IN_UNIT', 'ACTIVITY_COMPLIANCE_RATE', ...P15]) {
        expect([id, REQUIREMENT_METRICS.some((m) => m.key === id)]).toEqual([id, true]);
      }
    });

    it('P15-T1 AC-6 keeps the potential count apart from the active one: a projection is never MAA', () => {
      expect(metric('POTENTIAL_MAA_COUNT_IN_UNIT').label).toMatch(/^Potential /);
      expect(metric('POTENTIAL_MAA_COUNT_IN_UNIT').label).not.toBe(metric('MAA_COUNT_IN_UNIT').label);
    });
  });

  describe('P18-T1 AC-12, P18-T2 — the Owner’s reporting registers its metrics before it serves them (D-registry)', () => {
    const OFFICE = ['OFFICE_HEADCOUNT', 'OFFICE_NEW_MEMBERS_THIS_MONTH'];
    // P19.3-T1: `ACTIVITY_LOGGED_THIS_MONTH` retired (ADR-0200 §3); `NET_APE` is `MOC_APE`, at its phase (ADR-0201 §1).
    const SCOPE = ['RECRUITMENT_CLOSED_LAST_MONTH', 'APE_YEAR_PROJECTION'];
    const MOC_INPUTS = ['MOC_APE', 'MONTHLY2_AA', 'MONTHLY2_AA_DU', 'MONTHLY2_AA_DG', 'DIRECT_AB_COUNT', 'MOC_PERSISTENCY'];

    it('P18-T1 AC-12 registers the eleven at Phase 18 — ten since P19.3-T1 — each with no threshold of its own', () => {
      for (const id of [...OFFICE, ...SCOPE, ...MOC_INPUTS]) {
        expect({ id, phase: metric(id).phase, threshold: metric(id).threshold }).toEqual({ id, phase: '18', threshold: null });
      }
      // And every metric Phase 18 computes: the eleven, and the five registered there before.
      expect(METRIC_IDS.filter((id) => metric(id).phase === '18').sort()).toEqual([
        ...OFFICE, ...SCOPE, ...MOC_INPUTS, 'MAA_COUNT_IN_UNIT', 'ACTIVITY_COMPLIANCE_RATE', 'LEADER_COACHING_FREQUENCY',
        'MOC_STATUS', 'PRODUCTION_CLUB_TIER',
      ].sort());
    });

    it('P18-T1 AC-12 keeps the office’s headcount and new members out of every requirement, and lets one name the other nine', () => {
      const requirable = REQUIREMENT_METRICS.map((m) => m.key);
      for (const id of OFFICE) expect([id, requirable.includes(id)]).toEqual([id, false]);
      for (const id of [...SCOPE, ...MOC_INPUTS]) expect([id, requirable.includes(id)]).toEqual([id, true]);
    });

    it('P18-T1 AC-12 names each by what it counts (OD-142’s logging card retired by P19.3-T1, ADR-0200 §3)', () => {
      expect(() => metric('ACTIVITY_LOGGED_THIS_MONTH')).toThrow(/No metric called ACTIVITY_LOGGED_THIS_MONTH/);
      expect(metric('OFFICE_HEADCOUNT')).toMatchObject({ unit: 'count', period: 'POINT_IN_TIME' });
      expect(metric('APE_YEAR_PROJECTION')).toMatchObject({ unit: 'idr_minor', period: 'CALENDAR_YEAR' });
      expect(metric('MOC_APE')).toMatchObject({ unit: 'idr_minor', period: 'CALENDAR_YEAR' });
      expect(metric('MOC_PERSISTENCY')).toMatchObject({ unit: 'percentage', period: 'ROLLING_12M' });
    });

    it('P18-T1 AC-12 moves EVENT_ATTENDANCE_RATE and EVENT_NPS to 18.2, still requirable there', () => {
      expect(metric('EVENT_ATTENDANCE_RATE').phase).toBe('18.2');
      expect(metric('EVENT_NPS').phase).toBe('18.2');
      expect(CAMPAIGN_EVALUATION_PHASE).toBe('18.2');
      expect(REQUIREMENT_METRICS.map((m) => m.key)).toEqual(expect.arrayContaining(['EVENT_ATTENDANCE_RATE', 'EVENT_NPS']));
    });

    it('P18-T1 AC-5 reads LEADER_COACHING_FREQUENCY over the last 7 days, as the leaderboard does', () => {
      expect(metric('LEADER_COACHING_FREQUENCY').period).toBe('ROLLING_7D');
    });
  });

  describe('P18.1-T1 AC-4 — the forum registers the cohort and the scorecard’s metrics before it serves them (D-cohort, OD-144)', () => {
    const FORUM: Record<string, { label: string; unit: string; period: string }> = {
      ACTIVATION_COHORT: { label: 'Activation cohort', unit: 'count', period: 'CALENDAR_YEAR' },
      // `NEW_AGENT_3M_ACTIVE_PCT` was the seventh, retired by ADR-0171 §2 (P18.8-T6): the row reads `ACTIVATION_3M_PCT`;
      // `NEW_ACTIVE_AGENTS_MONTHLY_AVG` the sixth, retired by ADR-0175 §2 (P18.9-T1 AC-6).
      // P18.9-T1 AC-4: *Producing agents* reads **Annual Active Agents**, the reference slide's name (UI-004, UI-041).
      PRODUCING_AGENTS: { label: 'Annual Active Agents', unit: 'count', period: 'CALENDAR_YEAR' },
      MAA_MONTHLY_AVG: { label: 'Avg. Monthly AA', unit: 'count', period: 'CALENDAR_MONTH' },
      CASE_SUBMISSIONS: { label: 'Case submission', unit: 'count', period: 'CALENDAR_MONTH' },
      AVERAGE_CASE_SIZE_REALISED: { label: 'Average Case Size', unit: 'idr_minor', period: 'CALENDAR_YEAR' },
    };

    it('P18.1-T1 AC-4 registers the five still served at Phase 18.1, each with its period, its unit, its name and no threshold', () => {
      for (const [id, want] of Object.entries(FORUM)) {
        expect(metric(id)).toEqual({ id, ...want, phase: '18.1', threshold: null });
      }
      // And nothing else is Phase 18.1's.
      expect(METRIC_IDS.filter((id) => metric(id).phase === '18.1').sort()).toEqual(Object.keys(FORUM).sort());
    });

    it('P18.1-T1 AC-4 the rows the prototype draws over FY and YTD alone, and the cohort, are a year’s; the two in every column a month’s', () => {
      // Blocked to the right of *YTD* (`KPM_Owner.html:2465`, `:2468`, `:2472`): a year, or a year to date.
      for (const id of ['PRODUCING_AGENTS', 'AVERAGE_CASE_SIZE_REALISED', 'ACTIVATION_COHORT']) {
        expect([id, metric(id).period]).toEqual([id, 'CALENDAR_YEAR']);
      }
      for (const id of ['MAA_MONTHLY_AVG', 'CASE_SUBMISSIONS']) {
        expect([id, metric(id).period]).toEqual([id, metric('NEW_ACTIVE_AGENTS').period]);
      }
    });

    it('P18.1-T1 AC-4 keeps all five out of every requirement: each is computed over an office alone', () => {
      const requirable = REQUIREMENT_METRICS.map((m) => m.key);
      for (const id of Object.keys(FORUM)) {
        expect([id, SERVED.find((m) => m.key === id)?.requirable, requirable.includes(id)]).toEqual([id, false, false]);
      }
      // Measured before campaigns are evaluated, so nothing is refused as not measured yet.
      expect(Object.keys(FORUM).every((id) => comparePhases(metric(id).phase, CAMPAIGN_EVALUATION_PHASE) < 0)).toBe(true);
    });

    it('P18.1-T1 AC-4 names the realised case size apart from the plan’s, and the averages by what they average', () => {
      expect(metric('AVERAGE_CASE_SIZE_REALISED').unit).toBe(metric('APE_ACHIEVED').unit);
      // `NEW_ACTIVE_AGENTS_MONTHLY_AVG`, the other average, retired by ADR-0175 §2 (P18.9-T1 AC-6).
      expect(metric('MAA_MONTHLY_AVG').label).toMatch(/^Avg\. Monthly AA$/);
    });
  });

  describe('P18.2-T5 AC-8, P18.2-T6 AC-6 — the events’ three metrics, per event (D-status, D-evaluable)', () => {
    it('P18.2-T5 AC-8 registers the status, the rate and the NPS at 18.2, point in time, with no threshold', () => {
      expect(metric('EVENT_ATTENDANCE_STATUS')).toMatchObject({ unit: 'enum', period: 'POINT_IN_TIME', threshold: null, phase: '18.2' });
      expect(metric('EVENT_ATTENDANCE_RATE')).toMatchObject({ unit: 'percentage', period: 'POINT_IN_TIME', threshold: null, phase: '18.2' });
      expect(metric('EVENT_NPS')).toMatchObject({ unit: 'score', period: 'POINT_IN_TIME', threshold: null, phase: '18.2' });
    });

    it('P18.2-T6 AC-6 none of the three is campaign-evaluable: two figures per event, and a status, never a member’s reading', () => {
      for (const key of ['EVENT_ATTENDANCE_STATUS', 'EVENT_ATTENDANCE_RATE', 'EVENT_NPS']) {
        expect([key, isCampaignMetric(key)]).toEqual([key, false]);
        expect(CAMPAIGN_METRICS.map((m) => m.key)).not.toContain(key);
      }
    });
  });

  describe('P18.2-T8 AC-1, AC-7 — what a campaign may name, and over what (D-evaluable, D-period)', () => {
    /** The evaluable set, by key: a member's own production over months, their logged activity, the five ratios, their unit's active agents. */
    const EVALUABLE = [
      'APE_ACHIEVED', 'ROLLING_PERSISTENCY', 'NEW_ACTIVE_AGENTS', 'MAA_COUNT_IN_UNIT', 'NEW_HIRES', 'CASCADE_ACTIVITY_TOUCHES',
      'SELLING_RECRUITMENT_BALANCE', 'SELLING_SUCCESS_RATE', 'RECRUITMENT_SUCCESS_RATE', 'LEADS_PER_ACTIVITY', 'MEETING_PER_APPROACH',
    ];

    it('P18.2-T8 AC-1 flags exactly the evaluable set, a second flag beside `requirable`', () => {
      expect(CAMPAIGN_METRICS.map((m) => m.key).sort()).toEqual([...EVALUABLE].sort());
      // Every one is also requirable: the campaign set is a subset of what a carrier rule may name.
      for (const id of EVALUABLE) expect([id, REQUIREMENT_METRICS.some((m) => m.key === id)]).toEqual([id, true]);
      // `requirable` is untouched: still every metric but the office's counts.
      expect(REQUIREMENT_METRICS.length).toBeGreaterThan(CAMPAIGN_METRICS.length);
    });

    it('P18.2-T8 AC-1 leaves out a self-declared toggle, the per-event rates, every target, enum and boolean', () => {
      for (const id of [
        'TRAINING_COMPLETION_PCT', 'EVENT_ATTENDANCE_RATE', 'EVENT_NPS', 'EVENT_ATTENDANCE_STATUS',
        'SUB_PERIOD_ACTIVITY_TARGET', 'APE_TARGET', 'LEAD_TARGET', 'GOAL_PACE_STATUS', 'PACING_TO_MAA',
        'CAMPAIGN_QUALIFICATION_STATUS', 'MOC_STATUS', 'PRODUCTION_CLUB_TIER', 'MONTHLY_ACTIVE_AGENT', 'LEADERS_USED',
      ]) {
        expect([id, isCampaignMetric(id)]).toEqual([id, false]);
      }
      expect(isCampaignMetric('NOT_A_METRIC')).toBe(false);
    });

    it('P18.2-T8 AC-1 reads the file for production, the log for activity, and the unit only for active agents', () => {
      const reading = (id: string) => SERVED.find((m) => m.key === id)?.campaign;
      for (const id of ['APE_ACHIEVED', 'NEW_ACTIVE_AGENTS', 'NEW_HIRES']) {
        expect([id, reading(id)]).toEqual([id, { source: 'file', aggregate: 'sum', subject: 'self' }]);
      }
      expect(reading('ROLLING_PERSISTENCY')).toEqual({ source: 'file', aggregate: 'latest', subject: 'self' });
      expect(reading('MAA_COUNT_IN_UNIT')).toEqual({ source: 'file', aggregate: 'latest', subject: 'unit' });
      expect(reading('CASCADE_ACTIVITY_TOUCHES')).toEqual({ source: 'activity', aggregate: 'sum', subject: 'self' });
      for (const id of ['SELLING_RECRUITMENT_BALANCE', 'SELLING_SUCCESS_RATE', 'RECRUITMENT_SUCCESS_RATE', 'LEADS_PER_ACTIVITY', 'MEETING_PER_APPROACH']) {
        expect([id, reading(id)]).toEqual([id, { source: 'activity', aggregate: 'ratio', subject: 'self' }]);
      }
    });

    it('P18.2-T8 AC-1 registers New Hire over the file’s recruitment column: a count, 18.2, no threshold', () => {
      expect(metric('NEW_HIRES')).toMatchObject({ label: 'New Hire', unit: 'count', phase: '18.2', period: 'CALENDAR_MONTH', threshold: null });
      // The same shape as the file's other count a campaign reads.
      expect(metric('NEW_HIRES').period).toBe(metric('NEW_ACTIVE_AGENTS').period);
    });

    it('P18.2-T8 AC-7 reads CAMPAIGN_QUALIFICATION_STATUS over the campaign’s own window (carry #3)', () => {
      expect(metric('CAMPAIGN_QUALIFICATION_STATUS').period).toBe('PROGRAMME_WINDOW');
      // `CALENDAR_YEAR` stays the code's token for a year; there is no `CALENDAR_YTD` (D-period).
      expect(metric('APE_ACHIEVED').period).toBe('CALENDAR_YEAR');
      expect(METRIC_IDS.map((id) => metric(id).period)).not.toContain('CALENDAR_YTD');
    });
  });

  describe('P18.3-T1 AC-5, AC-7 — the compliance tree registers its two shares before it serves them (OD-159, OD-160)', () => {
    it('P18.3-T1 AC-7 registers ACTIVATION_COMPLETION_RATE at 18.3: a percentage, point in time, no threshold', () => {
      expect(metric('ACTIVATION_COMPLETION_RATE')).toEqual({
        id: 'ACTIVATION_COMPLETION_RATE', label: 'Activation completion rate', unit: 'percentage', period: 'POINT_IN_TIME',
        threshold: null, phase: '18.3',
      });
    });

    it('P18.3-T1 AC-5 registers GOAL_SET_RATE at 18.3: a percentage of the office’s calendar year, no threshold', () => {
      expect(metric('GOAL_SET_RATE')).toEqual({
        id: 'GOAL_SET_RATE', label: 'Goal set', unit: 'percentage', period: 'CALENDAR_YEAR', threshold: null, phase: '18.3',
      });
    });

    it('P18.3-T1 AC-7 keeps the set’s graduations apart from one hire’s items: two names, two scopes', () => {
      expect(metric('ACTIVATION_COMPLETION_PCT').label).not.toBe(metric('ACTIVATION_COMPLETION_RATE').label);
      expect(metric('ACTIVATION_COMPLETION_PCT').period).toBe('PROGRAMME_WINDOW');
    });

    it('P18.3-T1 AC-5, AC-7 keeps both out of every requirement and every campaign: nobody qualifies by a share of a set', () => {
      for (const id of ['ACTIVATION_COMPLETION_RATE', 'GOAL_SET_RATE']) {
        expect([id, SERVED.find((m) => m.key === id)?.requirable, REQUIREMENT_METRICS.some((m) => m.key === id), isCampaignMetric(id)])
          .toEqual([id, false, false, false]);
      }
      // And nothing else is Phase 18.3's.
      expect(METRIC_IDS.filter((id) => metric(id).phase === '18.3').sort()).toEqual(['ACTIVATION_COMPLETION_RATE', 'GOAL_SET_RATE']);
    });
  });

  describe('P18.8-T4 AC-1 — the first sale registers before anything reads it (ADR-0171 §1)', () => {
    it('P18.8-T4 AC-1 registers FIRST_SALE_DATE at 18.8: a date, point in time, no threshold, no requirement’s', () => {
      expect(metric('FIRST_SALE_DATE')).toEqual({
        id: 'FIRST_SALE_DATE', label: 'First sale', unit: 'date', period: 'POINT_IN_TIME', threshold: null, phase: '18.8',
      });
      expect([SERVED.find((m) => m.key === 'FIRST_SALE_DATE')?.requirable, isCampaignMetric('FIRST_SALE_DATE')]).toEqual([false, false]);
      expect(METRIC_IDS.filter((id) => metric(id).phase === '18.8')).toContain('FIRST_SALE_DATE');
    });

    it('P18.8-T4 AC-1 keeps a first sale apart from a Monthly Active Agent: neither is named by the other (ADR-0171 §4)', () => {
      expect(metric('FIRST_SALE_DATE').label).not.toBe(metric('MONTHLY_ACTIVE_AGENT').label);
      expect(metric('MONTHLY_ACTIVE_AGENT').unit).toBe('tri_state');
    });
  });

  describe('P18.8-T5 AC-4 — who a unit’s production reads registers before the dashboard reads it (ADR-0172 §2)', () => {
    it('P18.8-T5 AC-4 registers COUNTS_FOR_PRODUCTION at 18.8: a boolean, point in time, no threshold, no requirement’s', () => {
      expect(metric('COUNTS_FOR_PRODUCTION')).toEqual({
        id: 'COUNTS_FOR_PRODUCTION', label: 'Counts for production', unit: 'boolean', period: 'POINT_IN_TIME', threshold: null,
        phase: '18.8',
      });
      expect([SERVED.find((m) => m.key === 'COUNTS_FOR_PRODUCTION')?.requirable, isCampaignMetric('COUNTS_FOR_PRODUCTION')])
        .toEqual([false, false]);
    });

    it('P18.8-T5 AC-4 is not a Monthly Active Agent, nor the potential count it narrows (invariant §8)', () => {
      for (const id of ['MONTHLY_ACTIVE_AGENT', 'MAA_COUNT_IN_UNIT', 'POTENTIAL_MAA_COUNT_IN_UNIT', 'PACING_TO_MAA']) {
        expect([id, metric('COUNTS_FOR_PRODUCTION').label]).not.toEqual([id, metric(id).label]);
      }
    });
  });

  describe('P18.8-T6 AC-1, AC-2 — 3M activation is one metric, and the forum’s old one is retired (ADR-0171 §2)', () => {
    it('P18.8-T6 AC-1 registers ACTIVATION_3M at 18.8: an enum over the first 90 days, locked on day 90, no requirement’s', () => {
      expect(metric('ACTIVATION_3M')).toEqual({
        id: 'ACTIVATION_3M', label: '3M activation', unit: 'enum', period: 'PROGRAMME_WINDOW', threshold: ACTIVATION_3M.DAYS,
        phase: '18.8',
      });
      expect(metric('ACTIVATION_3M').threshold).toBe(90);
    });

    it('P18.8-T6 AC-2 registers ACTIVATION_3M_PCT at 18.8: a percentage by join month, no threshold, no requirement’s', () => {
      expect(metric('ACTIVATION_3M_PCT')).toEqual({
        id: 'ACTIVATION_3M_PCT', label: '3M activation %', unit: 'percentage', period: 'CALENDAR_MONTH', threshold: null, phase: '18.8',
      });
      for (const id of ['ACTIVATION_3M', 'ACTIVATION_3M_PCT']) {
        expect([id, SERVED.find((m) => m.key === id)?.requirable, isCampaignMetric(id)]).toEqual([id, false, false]);
      }
    });

    it('P18.8-T6 AC-2 retires NEW_AGENT_3M_ACTIVE_PCT: no longer served or computed, so nothing can read a second 3M', () => {
      expect(() => metric('NEW_AGENT_3M_ACTIVE_PCT')).toThrow(/No metric called NEW_AGENT_3M_ACTIVE_PCT/);
      expect(SERVED.some((m) => m.key === 'NEW_AGENT_3M_ACTIVE_PCT')).toBe(false);
      // One 3M metric per definition (invariant §8): the result and its share — and since P19.3-T1 the forum's D7, a
      // definition of its own under a name of its own (ADR-0202), never a second reading of these two.
      expect(METRIC_IDS.filter((id) => id.includes('3M')).sort()).toEqual(['ACTIVATION_3M', 'ACTIVATION_3M_PCT', 'NEW_AGENT_ACTIVATION_3M_PCT']);
    });
  });

  describe('P18.9-T1 AC-4 to AC-6 — the reference slide’s rows: one metric added, one renamed, one retired (ADR-0175 §2)', () => {
    it('P18.9-T1 AC-5 registers CASES_PER_PRODUCING_AGENT at 18.9, in the change that computes it: a ratio over a year, no threshold', () => {
      expect(metric('CASES_PER_PRODUCING_AGENT')).toEqual({
        id: 'CASES_PER_PRODUCING_AGENT', label: 'Cases/producing agents', unit: 'ratio', period: 'CALENDAR_YEAR',
        threshold: null, phase: '18.9',
      });
      // Over the forum's year columns, *Not tracked* in a month, as drawn. Its denominator is the monthly active count
      // summed over the same months since P19.3-T1 (ADR-0203 §5), no longer *Annual Active Agents* (the test below).
      expect(metric('CASES_PER_PRODUCING_AGENT').period).toBe('CALENDAR_YEAR');
      expect([SERVED.find((m) => m.key === 'CASES_PER_PRODUCING_AGENT')?.requirable, isCampaignMetric('CASES_PER_PRODUCING_AGENT')])
        .toEqual([false, false]);
      expect(METRIC_IDS.filter((id) => metric(id).phase === '18.9')).toEqual(['CASES_PER_PRODUCING_AGENT']);
    });

    it('P18.9-T1 AC-4 names PRODUCING_AGENTS Annual Active Agents, the same metric — its period, unit and phase unchanged', () => {
      expect(metric('PRODUCING_AGENTS')).toEqual({
        id: 'PRODUCING_AGENTS', label: 'Annual Active Agents', unit: 'count', period: 'CALENDAR_YEAR', threshold: null, phase: '18.1',
      });
      expect(METRIC_IDS.filter((id) => metric(id).label === 'Producing agents')).toEqual([]);
    });

    it('P18.9-T1 AC-6 retires NEW_ACTIVE_AGENTS_MONTHLY_AVG: no longer served or computed; the file’s NEW_ACTIVE_AGENTS stays', () => {
      expect(() => metric('NEW_ACTIVE_AGENTS_MONTHLY_AVG')).toThrow(/No metric called NEW_ACTIVE_AGENTS_MONTHLY_AVG/);
      expect(SERVED.some((m) => m.key === 'NEW_ACTIVE_AGENTS_MONTHLY_AVG')).toBe(false);
      // Its input is the carrier's count, which a campaign still reads.
      expect(metric('NEW_ACTIVE_AGENTS')).toMatchObject({ unit: 'count', phase: '9' });
      expect(isCampaignMetric('NEW_ACTIVE_AGENTS')).toBe(true);
    });
  });

  describe('P19.3-T1 — the owner’s data sources of 3 November (ADR-0200 to ADR-0203)', () => {
    const doc = () => readFileSync(DOC, 'utf8');

    it('P19.3-T1 AC-5 retires NET_APE from metrics.ts, the registry and the index together; MOC_APE carries its definition', () => {
      expect(() => metric('NET_APE')).toThrow(/No metric called NET_APE/);
      expect(SERVED.some((m) => m.key === 'NET_APE')).toBe(false);
      expect(indexRows().flatMap((row) => row.ids)).not.toContain('NET_APE');
      expect(documentedIds()).not.toContain('NET_APE');
      // `NET_APE`'s definition and phase, under the owner's word: requirable, a carrier rule's, no campaign's (D5).
      expect(metric('MOC_APE')).toEqual({
        id: 'MOC_APE', label: 'APE, MOC scope', unit: 'idr_minor', period: 'CALENDAR_YEAR', threshold: null, phase: '18',
      });
      expect([REQUIREMENT_METRICS.some((m) => m.key === 'MOC_APE'), isCampaignMetric('MOC_APE')]).toEqual([true, false]);
    });

    it('P19.3-T1 AC-5 no metric is named Net APE, and the seeded rules name MOC_APE (T0 AC-2)', () => {
      expect(METRIC_IDS.filter((id) => /net ape/i.test(metric(id).label))).toEqual([]);
      expect(indexRows().filter((row) => /net ape/i.test(row.name))).toEqual([]);
      const keys = SEED_MOC_RULES.flatMap((rule) => rule.criteriaGroups.flatMap((g) => g.criteria.map((c) => c.metricKey)));
      expect(keys).toContain('MOC_APE');
      expect(keys).not.toContain('NET_APE');
      // Every key a seeded rule names is registered.
      for (const key of keys) expect([key, METRIC_IDS.includes(key)]).toEqual([key, true]);
    });

    it('P19.3-T1 AC-5 a stored rule still naming NET_APE reads MOC_APE; every other key reads itself', () => {
      expect(RENAMED_METRIC_KEYS).toEqual({ NET_APE: 'MOC_APE' });
      expect(currentMetricKey('NET_APE')).toBe('MOC_APE');
      expect(currentMetricKey('MOC_APE')).toBe('MOC_APE');
      expect(currentMetricKey('MONTHLY2_AA')).toBe('MONTHLY2_AA');
      // A successor is always a registered metric, and never itself renamed.
      for (const to of Object.values(RENAMED_METRIC_KEYS)) {
        expect([to, METRIC_IDS.includes(to), to in RENAMED_METRIC_KEYS]).toEqual([to, true, false]);
      }
    });

    it('P19.3-T1 AC-1 retires ACTIVITY_LOGGED_THIS_MONTH: the Overview’s first tile counts production (ADR-0200 §2, §3)', () => {
      expect(() => metric('ACTIVITY_LOGGED_THIS_MONTH')).toThrow(/No metric called ACTIVITY_LOGGED_THIS_MONTH/);
      expect(SERVED.some((m) => m.key === 'ACTIVITY_LOGGED_THIS_MONTH')).toBe(false);
      expect(documentedIds()).not.toContain('ACTIVITY_LOGGED_THIS_MONTH');
      // *Aktif bulan ini* is the one count of D1 over a scope, tri-state through its month.
      expect(metric('MAA_COUNT_IN_UNIT')).toMatchObject({ unit: 'count', period: 'CALENDAR_MONTH' });
      expect(metric('MONTHLY_ACTIVE_AGENT').unit).toBe('tri_state');
    });

    it('P19.3-T1 AC-2 no logging metric’s label says active or aktif (the compliance family is Pengguna aktif on a screen)', () => {
      const logging = METRIC_IDS.filter((id) => id.startsWith('ACTIVITY_LOGGED_') || id.startsWith('ACTIVITY_COMPLIANCE_'));
      expect(logging.sort()).toEqual(['ACTIVITY_COMPLIANCE_7D', 'ACTIVITY_COMPLIANCE_MONTH', 'ACTIVITY_COMPLIANCE_RATE']);
      // Exactly *Pengguna aktif* may hold the word; nothing else may (ADR-0200 §3).
      const outsideTheName = (label: string) => label.replace(/Pengguna aktif/g, '');
      for (const id of logging) expect([id, /\b(active|aktif)\b/i.test(outsideTheName(metric(id).label))]).toEqual([id, false]);
      expect(/\b(active|aktif)\b/i.test(outsideTheName('Pengguna aktif'))).toBe(false);
      expect(/\b(active|aktif)\b/i.test(outsideTheName('Aktif bulan ini'))).toBe(true);
    });

    it('P19.3-T1 AC-1 every metric labelled active resolves to D1, the upload’s own count, or a projection named Potential', () => {
      const labelledActive = METRIC_IDS.filter((id) => /\bactive\b/i.test(metric(id).label)).sort();
      expect(labelledActive).toEqual([
        // D1 itself, a count of it, and the distinct agents over a year (ADR-0054, ADR-0200 §1).
        'MAA_COUNT_IN_UNIT', 'MONTHLY_ACTIVE_AGENT', 'PRODUCING_AGENTS',
        // The upload's own column, the carrier's count (§A.8).
        'NEW_ACTIVE_AGENTS',
        // A projection, labelled so (*Potential …*), never MAA.
        'POTENTIAL_MAA_COUNT_IN_UNIT',
        // Quant's five that count D1's active agents over a run (P19.5-T3, ADR-0215 §6; §A.15): A2, A3, B3, C1, C3.
        'QUANT_ACTIVE_PER_LEADER', 'QUANT_ANNUAL_ACTIVE_NET_GROWTH', 'QUANT_AVG_ACTIVE_MONTHS', 'QUANT_AVG_MAA_PER_LEADER',
        'QUANT_TENURED_ACTIVE_PCT',
      ].sort());
      expect(metric('POTENTIAL_MAA_COUNT_IN_UNIT').label).toMatch(/^Potential /);
    });

    it('P19.3-T1 AC-3 RECRUITMENT_CLOSED_LAST_MONTH is named Recruitment last month, its code and period unchanged (D2)', () => {
      expect(metric('RECRUITMENT_CLOSED_LAST_MONTH')).toEqual({
        id: 'RECRUITMENT_CLOSED_LAST_MONTH', label: 'Recruitment last month', unit: 'count', period: 'CALENDAR_MONTH',
        threshold: null, phase: '18',
      });
      // The pipeline beside it counts candidates, and neither of its names says recruitment closed.
      for (const id of ['RECRUITMENT_PIPELINE_NOW', 'RECRUITMENT_EXPECTED_TO_CLOSE']) {
        expect([id, /closed/i.test(metric(id).label)]).toEqual([id, false]);
      }
    });

    it('P19.3-T1 AC-6 registers UNIT_PERSISTENCY: a leader row’s uploaded percentage, apart from a member’s own (D6)', () => {
      expect(metric('UNIT_PERSISTENCY')).toEqual({
        id: 'UNIT_PERSISTENCY', label: 'Unit persistency', unit: 'percentage', period: 'ROLLING_12M', threshold: null, phase: '19.3',
      });
      expect(metric('UNIT_PERSISTENCY').label).not.toBe(metric('ROLLING_PERSISTENCY').label);
      // MOC's criterion reads it over the carrier's same window.
      expect(metric('UNIT_PERSISTENCY').period).toBe(metric('MOC_PERSISTENCY').period);
    });

    it('P19.3-T1 AC-7 registers NEW_AGENT_ACTIVATION_3M_PCT apart from ACTIVATION_3M_PCT: two definitions, two names (D7)', () => {
      expect(metric('NEW_AGENT_ACTIVATION_3M_PCT')).toEqual({
        id: 'NEW_AGENT_ACTIVATION_3M_PCT', label: '3M new agent %', unit: 'percentage', period: 'CALENDAR_YEAR',
        threshold: null, phase: '19.3',
      });
      expect(metric('NEW_AGENT_ACTIVATION_3M_PCT').label).not.toBe(metric('ACTIVATION_3M_PCT').label);
      // New Hires' *Teraktivasi* is unchanged (ADR-0171): 90 days, its own threshold.
      expect(metric('ACTIVATION_3M_PCT')).toMatchObject({ label: '3M activation %', period: 'CALENDAR_MONTH' });
    });

    it('P19.3-T1 AC-15 registers RECRUITMENT_MONTHLY_AVG over a column’s months held — not the recruits who produced (D2)', () => {
      expect(metric('RECRUITMENT_MONTHLY_AVG')).toEqual({
        id: 'RECRUITMENT_MONTHLY_AVG', label: 'Recruitment, avg. monthly', unit: 'count', period: 'CALENDAR_MONTH',
        threshold: null, phase: '19.3',
      });
      // The same cell `NEW_HIRES` reads per member, over the same months.
      expect(metric('RECRUITMENT_MONTHLY_AVG').period).toBe(metric('NEW_HIRES').period);
    });

    it('P19.3-T1 AC-14 reads the three Monthly2 AA counts over the calendar year’s months held (Q6)', () => {
      for (const id of ['MONTHLY2_AA', 'MONTHLY2_AA_DU', 'MONTHLY2_AA_DG']) {
        expect([id, metric(id).period]).toEqual([id, metric('MOC_APE').period]);
      }
    });

    it('P19.3-T1 keeps every one of the four out of every campaign, and three out of every rule', () => {
      for (const id of ['UNIT_PERSISTENCY', 'NEW_AGENT_ACTIVATION_3M_PCT', 'RECRUITMENT_MONTHLY_AVG']) {
        expect([id, SERVED.find((m) => m.key === id)?.requirable, isCampaignMetric(id)]).toEqual([id, false, false]);
      }
      expect(METRIC_IDS.filter((id) => metric(id).phase === '19.3').sort())
        .toEqual(['NEW_AGENT_ACTIVATION_3M_PCT', 'RECRUITMENT_MONTHLY_AVG', 'UNIT_PERSISTENCY']);
      // §A.14 holds no metric under a heading the spec does not read: each is a `###` heading now.
      expect(doc()).not.toMatch(/^#### `(MOC_APE|UNIT_PERSISTENCY|NEW_AGENT_ACTIVATION_3M_PCT|RECRUITMENT_MONTHLY_AVG)`/m);
    });
  });

  describe('P10-T8 AC-2 — one list, served and computed, agreeing with the document', () => {
    it('serves exactly what it computes, under the same name, unit and phase', () => {
      expect([...METRIC_IDS].sort()).toEqual(SERVED.map((m) => m.key).sort());
      for (const served of SERVED) {
        const computed = metric(served.key);
        expect({ label: computed.label, unit: computed.unit, phase: computed.phase })
          .toEqual({ label: served.name, unit: served.unit, phase: served.phase });
      }
    });

    it('refuses, at load, a served metric with no period — and a period for a metric nobody serves', () => {
      const served = [{ key: 'A', name: 'A', unit: 'count' as const, phase: '6' }];
      expect(() => joinLists(served, {})).toThrow(/A is served with no period/);
      expect(() => joinLists(served, { A: { period: 'ROLLING_7D', threshold: null }, B: { period: 'ROLLING_7D', threshold: null } }))
        .toThrow(/B has a period here and no entry/);
      expect(joinLists(served, { A: { period: 'ROLLING_7D', threshold: null } })).toEqual([
        { id: 'A', label: 'A', unit: 'count', phase: '6', period: 'ROLLING_7D', threshold: null },
      ]);
    });

    it('has a row in the document’s index for every metric, and a metric for every row', () => {
      const indexed = indexRows().flatMap((row) => row.ids);
      expect([...indexed].sort()).toEqual([...METRIC_IDS].sort());
    });

    it('agrees with the index on every phase, and on every name the index gives one metric', () => {
      for (const row of indexRows()) {
        for (const id of row.ids) expect({ id, phase: metric(id).phase }).toEqual({ id, phase: row.phase });
        // `COACHED_7D` / `COACHED_30D` share a row and a name; each keeps its own.
        if (row.ids.length === 1) {
          expect({ id: row.ids[0], name: metric(row.ids[0]).label.replace(/’/g, "'") }).toEqual({ id: row.ids[0], name: row.name });
        }
      }
    });
  });

  describe('§8: one definition per metric', () => {
    it('refuses a registry that defines the same id twice', () => {
      /*
       * The rule the whole file exists for, and it was asserted nowhere: the throw fires
       * at module load, so the shipped registry passing proves only that *it* has no
       * duplicate — not that a duplicate would be caught. The prototypes carry three
       * conflicting definitions of "active agent"; this is what stops a fourth.
       */
      const entry = { id: 'X', label: 'X', period: 'POINT_IN_TIME', unit: 'count', threshold: null, phase: '1' } as never;
      expect(() => define([entry, entry])).toThrow(/defined twice/);
    });

    it('keeps every distinct id', () => {
      const one = { id: 'A', label: 'A', period: 'POINT_IN_TIME', unit: 'count', threshold: null, phase: '1' } as never;
      const two = { id: 'B', label: 'B', period: 'POINT_IN_TIME', unit: 'count', threshold: null, phase: '1' } as never;
      expect([...define([one, two]).keys()]).toEqual(['A', 'B']);
    });
  });
});
