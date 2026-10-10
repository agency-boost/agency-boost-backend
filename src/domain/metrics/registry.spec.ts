import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVATION, PERFORMANCE, RATIO_BENCHMARKS } from '@/domain/constants';
import {
  CAMPAIGN_EVALUATION_PHASE, CAMPAIGN_METRICS, METRIC_REGISTRY as SERVED, REQUIREMENT_METRICS, isCampaignMetric,
} from '@/domain/constants/metrics';
import { METRIC_IDS, METRIC_REGISTRY, metric, define, join as joinLists } from './registry';

const DOC = join(__dirname, '../../../../docs/00-product/metrics-and-definitions.md');

/**
 * The document's index table — `| \`ID\` | Name | Unit | Phase |` — one row per metric, or one row for
 * two ids written `A` / `B`.
 */
function indexRows(): { ids: string[]; name: string; phase: number }[] {
  const text = readFileSync(DOC, 'utf8');
  const table = text.slice(text.indexOf('| Code | Name | Unit | Phase |'));
  const rows: { ids: string[]; name: string; phase: number }[] = [];
  for (const line of table.split('\n').slice(2)) {
    if (!line.startsWith('| `')) break;
    const [, codes, name, , phase] = line.split('|').map((cell) => cell.trim());
    rows.push({ ids: [...codes.matchAll(/`([A-Z_0-9]+)`/g)].map((m) => m[1]), name, phase: Number(phase) });
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
      // P18.1-T1: *New AA (avg. monthly)* averages the file's `NEW_ACTIVE_AGENTS`, the carrier's count, over months —
      // it defines no *active* of its own, and its name says whose figure it averages.
      expect(activeish.sort()).toEqual(['MONTHLY_ACTIVE_AGENT', 'NEW_ACTIVE_AGENTS', 'NEW_ACTIVE_AGENTS_MONTHLY_AVG']);
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
        period: 'ROLLING_30D', unit: 'count', phase: 13.1, threshold: null, label: 'Closings over the last 30 days',
      });
      // The needed pace is still this month's: the weeks left are the office's calendar month.
      expect(metric('CLOSINGS_NEEDED_PER_WEEK').period).toBe('CALENDAR_MONTH');
      expect(() => metric('PROJECTED_CLOSINGS_THIS_MONTH')).toThrow(/No metric called PROJECTED_CLOSINGS_THIS_MONTH/);
    });

    it('P11-T4 AC-6 registers SUB_PERIOD_ACTIVITY_TARGET before it is served: the last 7 days, a count, Phase 11', () => {
      expect(metric('SUB_PERIOD_ACTIVITY_TARGET')).toMatchObject({
        period: 'ROLLING_7D', unit: 'count', phase: 11, label: 'Activity target for the last 7 days, pro-rated',
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
      expect(metric('MONTHLY_ACTIVE_AGENT').phase).toBe(9);
      expect(metric('SELLING_SUCCESS_RATE').phase).toBe(6);
      // Computed since P7-T6 — the index said 14, and a campaign asking was told it could not be.
      expect(metric('RECRUITMENT_PIPELINE_NOW').phase).toBe(7);
      // Coaching is Phase 11 since the 2026-09-29 re-plan; the old plan's 13 is the Unit Dashboard's 15.
      expect(metric('COACHED_7D').phase).toBe(11);
      for (const id of METRIC_IDS) {
        expect(metric(id).phase).toBeGreaterThanOrEqual(4);
      }
    });
  });

  describe('P10.1-T2 AC-6, AC-7 — the phases are the current plan’s, and what each move changed', () => {
    /*
     * The 2026-09-29 re-plan moved the old Phases 11–15 to 13, 14, 15, 18 and 19 and brought
     * coaching forward to 11 (`roadmap-and-phases.md`, *The 2026-09-29 re-plan*). `metrics.ts`
     * carried the old numbers until 2026-10-01. This is the crosswalk as applied, by key, so a
     * number from the old plan put back fails here by name rather than as a diff in a 47-row index.
     * Old 13 split by the task that first computes each metric.
     *
     * *Amended 2026-10-08:* that day's re-plan put training, events and campaigns last, in a new
     * Phase 18.5, and moved four numbers a second time: the three enablement metrics and campaign
     * evaluation, 14 → 18.5. The tests of the first move read the 2026-09-29 plan's phases — today's,
     * with `MOVED_2026_10_08` undone — so they still say what that move did. The block at the end
     * pins the second move, and the line campaigns are evaluated at today.
     */
    const MOVED: Record<string, { from: number; to: number }> = {
      // Coaching's six → 11: the session metrics (P11-T5, P11-T8), coverage (P11-T10), and the
      // roster's Status, `GOAL_PACE_STATUS` over `PACING_TO_MAA` (P11-T6).
      COACHED_7D: { from: 13, to: 11 },
      COACHED_30D: { from: 13, to: 11 },
      DAYS_SINCE_LAST_COACHING: { from: 13, to: 11 },
      COACHING_COVERAGE: { from: 13, to: 11 },
      GOAL_PACE_STATUS: { from: 13, to: 11 },
      PACING_TO_MAA: { from: 13, to: 11 },
      // The unit rollups → 15 (P15-T1).
      MAA_COUNT_IN_UNIT: { from: 13, to: 15 },
      ACTIVITY_COMPLIANCE_RATE: { from: 13, to: 15 },
      // Activation, 11 → 13 (P13-T1, P13-T2).
      ACTIVATION_COMPLETION_PCT: { from: 11, to: 13 },
      ACTIVATION_DAY_INDEX: { from: 11, to: 13 },
      // Enablement, 12 → 14 (then P14-T1, P14-T3, P14-T6; 18.5 since 2026-10-08, below).
      TRAINING_COMPLETION_PCT: { from: 12, to: 14 },
      EVENT_ATTENDANCE_STATUS: { from: 12, to: 14 },
      CAMPAIGN_QUALIFICATION_STATUS: { from: 12, to: 14 },
      // Owner reporting, 14 → 18 (P18-T1 to P18-T3; P18-T3 is P18.5-T10 since 2026-10-08).
      LEADER_COACHING_FREQUENCY: { from: 14, to: 18 },
      EVENT_ATTENDANCE_RATE: { from: 14, to: 18 },
      EVENT_NPS: { from: 14, to: 18 },
      MOC_STATUS: { from: 14, to: 18 },
      PRODUCTION_CLUB_TIER: { from: 14, to: 18 },
    };
    /** Campaigns were the old plan's Phase 12; the 2026-09-29 plan made them 14 (then P14-T5, P14-T6). */
    const OLD_CAMPAIGN_EVALUATION_PHASE = 12;

    /**
     * The 2026-10-08 re-plan (`roadmap-and-phases.md`, *Amended 2026-10-08*): training, events and
     * campaigns go last, at the product owner's priority. Phase 14 is Sales tools now, and the tasks
     * that compute these are Phase 18.5's: P18.5-T1, P18.5-T5 and P18.5-T8 (were P14-T1, P14-T3,
     * P14-T6).
     */
    const MOVED_2026_10_08: Record<string, { from: number; to: number }> = {
      TRAINING_COMPLETION_PCT: { from: 14, to: 18.5 },
      EVENT_ATTENDANCE_STATUS: { from: 14, to: 18.5 },
      CAMPAIGN_QUALIFICATION_STATUS: { from: 14, to: 18.5 },
    };
    /**
     * P15-T0 (D-metrics), the same day: the Unit Dashboard draws neither unit rollup, so both move to the
     * Owner's reporting, whose screens draw them (`KPM_Owner.html:1248`, `:982-985`).
     */
    const MOVED_BY_P15: Record<string, { from: number; to: number }> = {
      MAA_COUNT_IN_UNIT: { from: 15, to: 18 },
      ACTIVITY_COMPLIANCE_RATE: { from: 15, to: 18 },
    };
    /**
     * P18-T0 (D-registry), 2026-10-09: the two event metrics move to 18.5, whose screens read them — the
     * compliance, events and campaigns tree. A metric of Phase 18 that read event records would be a roadmap
     * defect.
     */
    const MOVED_BY_P18: Record<string, { from: number; to: number }> = {
      EVENT_ATTENDANCE_RATE: { from: 18, to: 18.5 },
      EVENT_NPS: { from: 18, to: 18.5 },
    };
    /** Campaign evaluation under the 2026-09-29 plan; 18.5 since 2026-10-08 (P18.5-T7, P18.5-T8). */
    const SEPT_29_CAMPAIGN_EVALUATION_PHASE = 14;
    /** A metric's phase under the 2026-09-29 plan: today's, with 2026-10-08's and 2026-10-09's moves undone. */
    const sept29Phase = (id: string): number =>
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
    const REGISTERED_SINCE: Record<string, number> = {
      // P11-T4: the coaching session's Activity card.
      SUB_PERIOD_ACTIVITY_TARGET: 11,
      // P13.1-T5 (ADR-0109): the pace sentence's *N*, replacing `PROJECTED_CLOSINGS_THIS_MONTH`.
      CLOSINGS_LAST_30_DAYS: 13.1,
      // P13.2-T4 (ADR-0113): the office's leaders, which its leader limit bounds.
      LEADERS_USED: 13.2,
      // P15-T1 (D-leads, D-metrics): the Unit Dashboard's roster.
      OPEN_SALES_LEADS: 15,
      SALES_LEADS_CLOSING_THIS_MONTH: 15,
      RECRUITMENT_NOMINATED_THIS_MONTH: 15,
      POTENTIAL_MAA_COUNT_IN_UNIT: 15,
      CASCADE_ACTIVITY_TOUCHES: 15,
      // P18-T1, P18-T2 (D-registry): the Owner's reporting — the office's five, and MOC's six inputs.
      OFFICE_HEADCOUNT: 18,
      OFFICE_NEW_MEMBERS_THIS_MONTH: 18,
      ACTIVITY_LOGGED_THIS_MONTH: 18,
      RECRUITMENT_CLOSED_LAST_MONTH: 18,
      APE_YEAR_PROJECTION: 18,
      NET_APE: 18,
      MONTHLY2_AA: 18,
      MONTHLY2_AA_DU: 18,
      MONTHLY2_AA_DG: 18,
      DIRECT_AB_COUNT: 18,
      MOC_PERSISTENCY: 18,
      // P18.1-T1 (D-cohort, OD-144): the Strategic Leader Forum's scorecard, and the cohort it reads.
      ACTIVATION_COHORT: 18.1,
      NEW_AGENT_3M_ACTIVE_PCT: 18.1,
      NEW_ACTIVE_AGENTS_MONTHLY_AVG: 18.1,
      PRODUCING_AGENTS: 18.1,
      MAA_MONTHLY_AVG: 18.1,
      CASE_SUBMISSIONS: 18.1,
      AVERAGE_CASE_SIZE_REALISED: 18.1,
      // P18.5-T8 (OD-152 → option 3): the file's `recruitment` column, the campaigns' *New Hire*.
      NEW_HIRES: 18.5,
      // P18.6-T1 (OD-159, OD-160): the Owner's compliance tree's two chips that needed a definition.
      ACTIVATION_COMPLETION_RATE: 18.6,
      GOAL_SET_RATE: 18.6,
    };
    const existedBefore = (id: string) => !(id in REGISTERED_SINCE);

    /** The metrics measured by the time a campaign is evaluated, under a given plan. */
    const computableAt = (evaluationPhase: number, phaseOf: (id: string) => number): string[] =>
      METRIC_IDS.filter((id) => phaseOf(id) <= evaluationPhase).sort();

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
        expect({ id, shipped: metric(id).phase <= 10 }).toEqual({ id, shipped: true });
      }
      // And a metric registered since sits in the phase that computes it.
      for (const [id, phase] of Object.entries(REGISTERED_SINCE)) {
        expect({ id, phase: metric(id).phase }).toEqual({ id, phase });
      }
      // And no phase that plan gave no metric to: an old-plan 12 left behind would have read as
      // Calendar's, 16 was Billing, 17 Recruitment tools, 19 go-live. Today's set is pinned below.
      const phases = [...new Set(METRIC_IDS.map(sept29Phase))].sort((a, b) => a - b);
      // 18.5 since P18.5-T8 registered *New Hire* (`NEW_HIRES`), a metric that plan never had; 18.6 since P18.6-T1.
      expect(phases).toEqual([6, 7, 8, 9, 10, 11, 13, 13.1, 13.2, 14, 15, 18, 18.1, 18.5, 18.6]);
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
        unit: 'count', phase: 13.2, period: 'POINT_IN_TIME', threshold: null, label: 'Leaders used',
      });
      expect(SERVED.find((m) => m.key === 'LEADERS_USED')?.requirable).toBe(false);
      expect(REQUIREMENT_METRICS.map((m) => m.key)).not.toContain('LEADERS_USED');
      // Since Phase 18 the office's headcount and its new members beside it (D-registry); every other metric is a
      // requirement's.
      expect(SERVED.filter((m) => !REQUIREMENT_METRICS.includes(m)).map((m) => m.key).sort()).toEqual([
        'LEADERS_USED', 'OFFICE_HEADCOUNT', 'OFFICE_NEW_MEMBERS_THIS_MONTH',
        // Since Phase 18.1 the forum's seven, each computed over an office alone (P18.1-T1 AC-4).
        'ACTIVATION_COHORT', 'AVERAGE_CASE_SIZE_REALISED', 'CASE_SUBMISSIONS', 'MAA_MONTHLY_AVG',
        'NEW_ACTIVE_AGENTS_MONTHLY_AVG', 'NEW_AGENT_3M_ACTIVE_PCT', 'PRODUCING_AGENTS',
        // Since Phase 18.6 the compliance tree's two shares of a set (P18.6-T1 AC-5, AC-7).
        'ACTIVATION_COMPLETION_RATE', 'GOAL_SET_RATE',
      ].sort());
    });

    it('refused, by key, the seven nothing measured by then under that plan', () => {
      // The unit rollups (15) and the Owner's reporting metrics (18): refused before the move,
      // refused after it. `campaign.tenancy.spec.ts` proved it through the service for EVENT_NPS
      // until the 2026-10-08 re-plan put campaign evaluation after both (below).
      // The Unit Dashboard's five, registered since, were not in that plan at all.
      expect(METRIC_IDS.filter((id) => sept29Phase(id) > SEPT_29_CAMPAIGN_EVALUATION_PHASE).filter(existedBefore).sort())
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
        expect(CAMPAIGN_EVALUATION_PHASE).toBe(18.5);
        // Still where campaign qualification is computed.
        expect(metric('CAMPAIGN_QUALIFICATION_STATUS').phase).toBe(CAMPAIGN_EVALUATION_PHASE);
        // And no phase the plan gives no metric to. Phase 14 is Sales tools now and computes none;
        // 12 is Calendar's, 16 is retired, 17 Recruitment tools, 19 hardening.
        const phases = [...new Set(METRIC_IDS.map((id) => metric(id).phase))].sort((a, b) => a - b);
        // 18.6 since P18.6-T1: the compliance tree's two, after campaign evaluation and no requirement's (below).
        expect(phases).toEqual([6, 7, 8, 9, 10, 11, 13, 13.1, 13.2, 15, 18, 18.1, 18.5, 18.6]);
      });

      it('pins, by key, every metric measured by the time a campaign is evaluated: all of them', () => {
        // `GET /metrics` serves this comparison as `computed`, and `checkCampaign` refuses its
        // complement — so this list is what an Owner may build a campaign on. Leaders used is
        // measured by then and is about an office, so it is no requirement (the last test here).
        expect(computableAt(CAMPAIGN_EVALUATION_PHASE, (id) => metric(id).phase)
          .filter((id) => !NOT_REQUIRABLE.includes(id))).toEqual([
          // P18-T1, P18-T2: nine of the eleven, measured before campaigns are evaluated (the headcount and its
          // new members are no requirement's to name).
          'ACTIVITY_LOGGED_THIS_MONTH', 'APE_YEAR_PROJECTION', 'RECRUITMENT_CLOSED_LAST_MONTH',
          'DIRECT_AB_COUNT', 'MOC_PERSISTENCY', 'MONTHLY2_AA', 'MONTHLY2_AA_DG', 'MONTHLY2_AA_DU', 'NET_APE',
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
          // P18.5-T8 (OD-152): the campaigns' *New Hire*, registered at campaign evaluation.
          'NEW_HIRES',
        ].sort());
      });

      it('refuses none as not measured yet: no metric a requirement may name is computed after campaign evaluation', () => {
        // The refusal stays, for a requirable metric registered later; `campaign-input.spec.ts` proves it
        // with an evaluation placed earlier.
        expect(METRIC_IDS.filter((id) => metric(id).phase > CAMPAIGN_EVALUATION_PHASE && !NOT_REQUIRABLE.includes(id))).toEqual([]);
        // P18.6-T1: the two registered after it are shares of a set, which no requirement may name whatever its phase.
        expect(METRIC_IDS.filter((id) => metric(id).phase > CAMPAIGN_EVALUATION_PHASE).sort())
          .toEqual(['ACTIVATION_COMPLETION_RATE', 'GOAL_SET_RATE']);
      });

      it('changed that set in exactly one way, decided: the unit rollups (15) and the Owner’s reporting metrics (18) precede campaigns now, so a campaign may require them', () => {
        /*
         * Decided with the re-plan, not inherited (`roadmap-and-phases.md`, *Amended 2026-10-08*).
         * Under the 2026-09-29 plan campaigns were evaluated in 14, before the Unit Dashboard and
         * the Owner's reporting, and those seven were refused; now campaigns are 18.5 and the seven
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
      expect(METRIC_IDS.filter((id) => metric(id).phase === 15).sort()).toEqual([...P15].sort());
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
      expect(metric('MAA_COUNT_IN_UNIT').phase).toBe(18);
      expect(metric('ACTIVITY_COMPLIANCE_RATE').phase).toBe(18);
      expect(metric('MAA_COUNT_IN_UNIT').phase).toBeLessThan(CAMPAIGN_EVALUATION_PHASE);
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
    const SCOPE = ['ACTIVITY_LOGGED_THIS_MONTH', 'RECRUITMENT_CLOSED_LAST_MONTH', 'APE_YEAR_PROJECTION'];
    const MOC_INPUTS = ['NET_APE', 'MONTHLY2_AA', 'MONTHLY2_AA_DU', 'MONTHLY2_AA_DG', 'DIRECT_AB_COUNT', 'MOC_PERSISTENCY'];

    it('P18-T1 AC-12 registers the eleven at Phase 18, each with no threshold of its own', () => {
      for (const id of [...OFFICE, ...SCOPE, ...MOC_INPUTS]) {
        expect({ id, phase: metric(id).phase, threshold: metric(id).threshold }).toEqual({ id, phase: 18, threshold: null });
      }
      // And every metric Phase 18 computes: the eleven, and the five registered there before.
      expect(METRIC_IDS.filter((id) => metric(id).phase === 18).sort()).toEqual([
        ...OFFICE, ...SCOPE, ...MOC_INPUTS, 'MAA_COUNT_IN_UNIT', 'ACTIVITY_COMPLIANCE_RATE', 'LEADER_COACHING_FREQUENCY',
        'MOC_STATUS', 'PRODUCTION_CLUB_TIER',
      ].sort());
    });

    it('P18-T1 AC-12 keeps the office’s headcount and new members out of every requirement, and lets one name the other nine', () => {
      const requirable = REQUIREMENT_METRICS.map((m) => m.key);
      for (const id of OFFICE) expect([id, requirable.includes(id)]).toEqual([id, false]);
      for (const id of [...SCOPE, ...MOC_INPUTS]) expect([id, requirable.includes(id)]).toEqual([id, true]);
    });

    it('P18-T1 AC-12 names each by what it counts: OD-142’s card is logging, never active agents', () => {
      expect(metric('ACTIVITY_LOGGED_THIS_MONTH').label).toBe('Agents who logged activity this month');
      expect(metric('ACTIVITY_LOGGED_THIS_MONTH').period).toBe('CALENDAR_MONTH');
      expect(metric('OFFICE_HEADCOUNT')).toMatchObject({ unit: 'count', period: 'POINT_IN_TIME' });
      expect(metric('APE_YEAR_PROJECTION')).toMatchObject({ unit: 'idr_minor', period: 'CALENDAR_YEAR' });
      expect(metric('NET_APE')).toMatchObject({ unit: 'idr_minor', period: 'CALENDAR_YEAR' });
      expect(metric('MOC_PERSISTENCY')).toMatchObject({ unit: 'percentage', period: 'ROLLING_12M' });
    });

    it('P18-T1 AC-12 moves EVENT_ATTENDANCE_RATE and EVENT_NPS to 18.5, still requirable there', () => {
      expect(metric('EVENT_ATTENDANCE_RATE').phase).toBe(18.5);
      expect(metric('EVENT_NPS').phase).toBe(18.5);
      expect(CAMPAIGN_EVALUATION_PHASE).toBe(18.5);
      expect(REQUIREMENT_METRICS.map((m) => m.key)).toEqual(expect.arrayContaining(['EVENT_ATTENDANCE_RATE', 'EVENT_NPS']));
    });

    it('P18-T1 AC-5 reads LEADER_COACHING_FREQUENCY over the last 7 days, as the leaderboard does', () => {
      expect(metric('LEADER_COACHING_FREQUENCY').period).toBe('ROLLING_7D');
    });
  });

  describe('P18.1-T1 AC-4 — the forum registers the cohort and the scorecard’s metrics before it serves them (D-cohort, OD-144)', () => {
    const FORUM: Record<string, { label: string; unit: string; period: string }> = {
      ACTIVATION_COHORT: { label: 'Activation cohort', unit: 'count', period: 'CALENDAR_YEAR' },
      NEW_AGENT_3M_ACTIVE_PCT: { label: '3M new agent %', unit: 'percentage', period: 'CALENDAR_YEAR' },
      NEW_ACTIVE_AGENTS_MONTHLY_AVG: { label: 'New AA (avg. monthly)', unit: 'count', period: 'CALENDAR_MONTH' },
      PRODUCING_AGENTS: { label: 'Producing agents', unit: 'count', period: 'CALENDAR_YEAR' },
      MAA_MONTHLY_AVG: { label: 'Avg. Monthly AA', unit: 'count', period: 'CALENDAR_MONTH' },
      CASE_SUBMISSIONS: { label: 'Case submission', unit: 'count', period: 'CALENDAR_MONTH' },
      AVERAGE_CASE_SIZE_REALISED: { label: 'Average Case Size', unit: 'idr_minor', period: 'CALENDAR_YEAR' },
    };

    it('P18.1-T1 AC-4 registers the seven at Phase 18.1, each with its period, its unit, the prototype’s name and no threshold', () => {
      for (const [id, want] of Object.entries(FORUM)) {
        expect(metric(id)).toEqual({ id, ...want, phase: 18.1, threshold: null });
      }
      // And nothing else is Phase 18.1's.
      expect(METRIC_IDS.filter((id) => metric(id).phase === 18.1).sort()).toEqual(Object.keys(FORUM).sort());
    });

    it('P18.1-T1 AC-4 the three the prototype draws over FY and YTD alone, and the cohort, are a year’s; the three in every column a month’s', () => {
      // Blocked to the right of *YTD* (`KPM_Owner.html:2465`, `:2468`, `:2472`): a year, or a year to date.
      for (const id of ['PRODUCING_AGENTS', 'NEW_AGENT_3M_ACTIVE_PCT', 'AVERAGE_CASE_SIZE_REALISED', 'ACTIVATION_COHORT']) {
        expect([id, metric(id).period]).toEqual([id, 'CALENDAR_YEAR']);
      }
      for (const id of ['NEW_ACTIVE_AGENTS_MONTHLY_AVG', 'MAA_MONTHLY_AVG', 'CASE_SUBMISSIONS']) {
        expect([id, metric(id).period]).toEqual([id, metric('NEW_ACTIVE_AGENTS').period]);
      }
    });

    it('P18.1-T1 AC-4 keeps all seven out of every requirement: each is computed over an office alone', () => {
      const requirable = REQUIREMENT_METRICS.map((m) => m.key);
      for (const id of Object.keys(FORUM)) {
        expect([id, SERVED.find((m) => m.key === id)?.requirable, requirable.includes(id)]).toEqual([id, false, false]);
      }
      // Measured before campaigns are evaluated, so nothing is refused as not measured yet.
      expect(Math.max(...Object.keys(FORUM).map((id) => metric(id).phase))).toBeLessThan(CAMPAIGN_EVALUATION_PHASE);
    });

    it('P18.1-T1 AC-4 names the realised case size apart from the plan’s, and the averages by what they average', () => {
      expect(metric('AVERAGE_CASE_SIZE_REALISED').unit).toBe(metric('APE_ACHIEVED').unit);
      expect(metric('NEW_ACTIVE_AGENTS_MONTHLY_AVG').label).toMatch(/avg\. monthly/);
      expect(metric('MAA_MONTHLY_AVG').label).toMatch(/^Avg\. Monthly AA$/);
    });
  });

  describe('P18.5-T5 AC-8, P18.5-T6 AC-6 — the events’ three metrics, per event (D-status, D-evaluable)', () => {
    it('P18.5-T5 AC-8 registers the status, the rate and the NPS at 18.5, point in time, with no threshold', () => {
      expect(metric('EVENT_ATTENDANCE_STATUS')).toMatchObject({ unit: 'enum', period: 'POINT_IN_TIME', threshold: null, phase: 18.5 });
      expect(metric('EVENT_ATTENDANCE_RATE')).toMatchObject({ unit: 'percentage', period: 'POINT_IN_TIME', threshold: null, phase: 18.5 });
      expect(metric('EVENT_NPS')).toMatchObject({ unit: 'score', period: 'POINT_IN_TIME', threshold: null, phase: 18.5 });
    });

    it('P18.5-T6 AC-6 none of the three is campaign-evaluable: two figures per event, and a status, never a member’s reading', () => {
      for (const key of ['EVENT_ATTENDANCE_STATUS', 'EVENT_ATTENDANCE_RATE', 'EVENT_NPS']) {
        expect([key, isCampaignMetric(key)]).toEqual([key, false]);
        expect(CAMPAIGN_METRICS.map((m) => m.key)).not.toContain(key);
      }
    });
  });

  describe('P18.5-T8 AC-1, AC-7 — what a campaign may name, and over what (D-evaluable, D-period)', () => {
    /** The evaluable set, by key: a member's own production over months, their logged activity, the five ratios, their unit's active agents. */
    const EVALUABLE = [
      'APE_ACHIEVED', 'ROLLING_PERSISTENCY', 'NEW_ACTIVE_AGENTS', 'MAA_COUNT_IN_UNIT', 'NEW_HIRES', 'CASCADE_ACTIVITY_TOUCHES',
      'SELLING_RECRUITMENT_BALANCE', 'SELLING_SUCCESS_RATE', 'RECRUITMENT_SUCCESS_RATE', 'LEADS_PER_ACTIVITY', 'MEETING_PER_APPROACH',
    ];

    it('P18.5-T8 AC-1 flags exactly the evaluable set, a second flag beside `requirable`', () => {
      expect(CAMPAIGN_METRICS.map((m) => m.key).sort()).toEqual([...EVALUABLE].sort());
      // Every one is also requirable: the campaign set is a subset of what a carrier rule may name.
      for (const id of EVALUABLE) expect([id, REQUIREMENT_METRICS.some((m) => m.key === id)]).toEqual([id, true]);
      // `requirable` is untouched: still every metric but the office's counts.
      expect(REQUIREMENT_METRICS.length).toBeGreaterThan(CAMPAIGN_METRICS.length);
    });

    it('P18.5-T8 AC-1 leaves out a self-declared toggle, the per-event rates, every target, enum and boolean', () => {
      for (const id of [
        'TRAINING_COMPLETION_PCT', 'EVENT_ATTENDANCE_RATE', 'EVENT_NPS', 'EVENT_ATTENDANCE_STATUS',
        'SUB_PERIOD_ACTIVITY_TARGET', 'APE_TARGET', 'LEAD_TARGET', 'GOAL_PACE_STATUS', 'PACING_TO_MAA',
        'CAMPAIGN_QUALIFICATION_STATUS', 'MOC_STATUS', 'PRODUCTION_CLUB_TIER', 'MONTHLY_ACTIVE_AGENT', 'LEADERS_USED',
      ]) {
        expect([id, isCampaignMetric(id)]).toEqual([id, false]);
      }
      expect(isCampaignMetric('NOT_A_METRIC')).toBe(false);
    });

    it('P18.5-T8 AC-1 reads the file for production, the log for activity, and the unit only for active agents', () => {
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

    it('P18.5-T8 AC-1 registers New Hire over the file’s recruitment column: a count, 18.5, no threshold', () => {
      expect(metric('NEW_HIRES')).toMatchObject({ label: 'New Hire', unit: 'count', phase: 18.5, period: 'CALENDAR_MONTH', threshold: null });
      // The same shape as the file's other count a campaign reads.
      expect(metric('NEW_HIRES').period).toBe(metric('NEW_ACTIVE_AGENTS').period);
    });

    it('P18.5-T8 AC-7 reads CAMPAIGN_QUALIFICATION_STATUS over the campaign’s own window (carry #3)', () => {
      expect(metric('CAMPAIGN_QUALIFICATION_STATUS').period).toBe('PROGRAMME_WINDOW');
      // `CALENDAR_YEAR` stays the code's token for a year; there is no `CALENDAR_YTD` (D-period).
      expect(metric('APE_ACHIEVED').period).toBe('CALENDAR_YEAR');
      expect(METRIC_IDS.map((id) => metric(id).period)).not.toContain('CALENDAR_YTD');
    });
  });

  describe('P18.6-T1 AC-5, AC-7 — the compliance tree registers its two shares before it serves them (OD-159, OD-160)', () => {
    it('P18.6-T1 AC-7 registers ACTIVATION_COMPLETION_RATE at 18.6: a percentage, point in time, no threshold', () => {
      expect(metric('ACTIVATION_COMPLETION_RATE')).toEqual({
        id: 'ACTIVATION_COMPLETION_RATE', label: 'Activation completion rate', unit: 'percentage', period: 'POINT_IN_TIME',
        threshold: null, phase: 18.6,
      });
    });

    it('P18.6-T1 AC-5 registers GOAL_SET_RATE at 18.6: a percentage of the office’s calendar year, no threshold', () => {
      expect(metric('GOAL_SET_RATE')).toEqual({
        id: 'GOAL_SET_RATE', label: 'Goal set', unit: 'percentage', period: 'CALENDAR_YEAR', threshold: null, phase: 18.6,
      });
    });

    it('P18.6-T1 AC-7 keeps the set’s graduations apart from one hire’s items: two names, two scopes', () => {
      expect(metric('ACTIVATION_COMPLETION_PCT').label).not.toBe(metric('ACTIVATION_COMPLETION_RATE').label);
      expect(metric('ACTIVATION_COMPLETION_PCT').period).toBe('PROGRAMME_WINDOW');
    });

    it('P18.6-T1 AC-5, AC-7 keeps both out of every requirement and every campaign: nobody qualifies by a share of a set', () => {
      for (const id of ['ACTIVATION_COMPLETION_RATE', 'GOAL_SET_RATE']) {
        expect([id, SERVED.find((m) => m.key === id)?.requirable, REQUIREMENT_METRICS.some((m) => m.key === id), isCampaignMetric(id)])
          .toEqual([id, false, false, false]);
      }
      // And nothing else is Phase 18.6's.
      expect(METRIC_IDS.filter((id) => metric(id).phase === 18.6).sort()).toEqual(['ACTIVATION_COMPLETION_RATE', 'GOAL_SET_RATE']);
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
      const served = [{ key: 'A', name: 'A', unit: 'count' as const, phase: 6 }];
      expect(() => joinLists(served, {})).toThrow(/A is served with no period/);
      expect(() => joinLists(served, { A: { period: 'ROLLING_7D', threshold: null }, B: { period: 'ROLLING_7D', threshold: null } }))
        .toThrow(/B has a period here and no entry/);
      expect(joinLists(served, { A: { period: 'ROLLING_7D', threshold: null } })).toEqual([
        { id: 'A', label: 'A', unit: 'count', phase: 6, period: 'ROLLING_7D', threshold: null },
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
      const entry = { id: 'X', label: 'X', period: 'POINT_IN_TIME', unit: 'count', threshold: null, phase: 1 } as never;
      expect(() => define([entry, entry])).toThrow(/defined twice/);
    });

    it('keeps every distinct id', () => {
      const one = { id: 'A', label: 'A', period: 'POINT_IN_TIME', unit: 'count', threshold: null, phase: 1 } as never;
      const two = { id: 'B', label: 'B', period: 'POINT_IN_TIME', unit: 'count', threshold: null, phase: 1 } as never;
      expect([...define([one, two]).keys()]).toEqual(['A', 'B']);
    });
  });
});
