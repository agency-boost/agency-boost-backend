import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVATION, PERFORMANCE, RATIO_BENCHMARKS } from '@/domain/constants';
import { CAMPAIGN_EVALUATION_PHASE, METRIC_REGISTRY as SERVED } from '@/domain/constants/metrics';
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
    });

    it('declares no threshold where there is nothing to compare against', () => {
      // A count has no benchmark. A zero would read as one, and a screen would draw a bar.
      expect(metric('MAA_COUNT_IN_UNIT').threshold).toBeNull();
      expect(metric('EVENT_NPS').threshold).toBeNull();
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

  describe('P10.1-T2 AC-6, AC-7 — the phases are the current plan’s, and what the move changed', () => {
    /*
     * The 2026-09-29 re-plan moved the old Phases 11–15 to 13, 14, 15, 18 and 19 and brought
     * coaching forward to 11 (`roadmap-and-phases.md`, *The 2026-09-29 re-plan*). `metrics.ts`
     * carried the old numbers until 2026-10-01. This is the crosswalk as applied, by key, so a
     * number from the old plan put back fails here by name rather than as a diff in a 47-row index.
     * Old 13 split by the task that first computes each metric.
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
      // Enablement, 12 → 14 (P14-T1, P14-T3, P14-T6).
      TRAINING_COMPLETION_PCT: { from: 12, to: 14 },
      EVENT_ATTENDANCE_STATUS: { from: 12, to: 14 },
      CAMPAIGN_QUALIFICATION_STATUS: { from: 12, to: 14 },
      // Owner reporting, 14 → 18 (P18-T1 to P18-T3).
      LEADER_COACHING_FREQUENCY: { from: 14, to: 18 },
      EVENT_ATTENDANCE_RATE: { from: 14, to: 18 },
      EVENT_NPS: { from: 14, to: 18 },
      MOC_STATUS: { from: 14, to: 18 },
      PRODUCTION_CLUB_TIER: { from: 14, to: 18 },
    };
    /** Campaigns were the old plan's Phase 12; they are 14 (P14-T5, P14-T6). */
    const OLD_CAMPAIGN_EVALUATION_PHASE = 12;

    const COACHING_SIX = [
      'COACHED_7D', 'COACHED_30D', 'DAYS_SINCE_LAST_COACHING', 'COACHING_COVERAGE', 'GOAL_PACE_STATUS', 'PACING_TO_MAA',
    ];

    /** The metrics measured by the time a campaign is evaluated, under a given plan. */
    const computableAt = (evaluationPhase: number, phaseOf: (id: string) => number): string[] =>
      METRIC_IDS.filter((id) => phaseOf(id) <= evaluationPhase).sort();

    it('moved every deferred metric by the crosswalk, and nothing that had shipped', () => {
      for (const [id, { to }] of Object.entries(MOVED)) {
        expect({ id, phase: metric(id).phase }).toEqual({ id, phase: to });
      }
      // Nothing that shipped reopens: what Phases 4–10 computed keeps its number.
      for (const id of METRIC_IDS.filter((id) => !(id in MOVED))) {
        expect({ id, shipped: metric(id).phase <= 10 }).toEqual({ id, shipped: true });
      }
      // And no phase the plan gives no metric to: an old-plan 12 left behind would now read as
      // Calendar's, 16 is Billing, 17 Recruitment tools, 19 go-live.
      const phases = [...new Set(METRIC_IDS.map((id) => metric(id).phase))].sort((a, b) => a - b);
      expect(phases).toEqual([6, 7, 8, 9, 10, 11, 13, 14, 15, 18]);
    });

    it('evaluates campaigns in Phase 14, the old plan’s 12', () => {
      expect(CAMPAIGN_EVALUATION_PHASE).toBe(14);
    });

    it('pins, by key, every metric measured by the time a campaign is evaluated', () => {
      // `GET /metrics` serves this comparison as `computed`, and `checkCampaign` refuses its
      // complement — so this list is what an Owner may build a campaign on.
      expect(computableAt(CAMPAIGN_EVALUATION_PHASE, (id) => metric(id).phase)).toEqual([
        'ACTIVATION_COMPLETION_PCT', 'ACTIVATION_DAY_INDEX',
        'ACTIVITY_COMPLIANCE_7D', 'ACTIVITY_COMPLIANCE_MONTH', 'ACTIVITY_TARGET_ATTAINMENT_PCT', 'ACTIVITY_TOTAL_BY_CATEGORY',
        'APE_ACHIEVED', 'APE_ATTAINMENT_PCT', 'APE_GAP_TO_TARGET', 'APE_TARGET', 'APPOINTMENT_TARGET',
        'CAMPAIGN_QUALIFICATION_STATUS', 'CLOSINGS_NEEDED_PER_WEEK',
        'COACHED_30D', 'COACHED_7D', 'COACHING_COVERAGE', 'DAYS_SINCE_LAST_COACHING',
        'EVENT_ATTENDANCE_STATUS', 'GOAL_PACE_STATUS',
        'LEADS_PER_ACTIVITY', 'LEAD_TARGET',
        'MEASURED_CLOSING_RATE', 'MEASURED_LEAD_TO_APPOINTMENT_RATE', 'MEETING_PER_APPROACH',
        'MONTHLY_ACTIVE_AGENT', 'MONTHLY_APE_TARGET', 'MONTHS_LEFT_IN_YEAR', 'NEW_ACTIVE_AGENTS',
        'PACING_TO_MAA', 'POLICIES_NEEDED', 'POLICY_COUNT_TARGET', 'PROJECTED_CLOSINGS_THIS_MONTH',
        'RECRUITMENT_EXPECTED_TO_CLOSE', 'RECRUITMENT_PIPELINE_NOW', 'RECRUITMENT_SUCCESS_RATE', 'ROLLING_PERSISTENCY',
        'SELLING_RECRUITMENT_BALANCE', 'SELLING_SUCCESS_RATE', 'SUMMARY_ACTIVITY_TARGET', 'TRAINING_COMPLETION_PCT',
      ].sort());
    });

    it('still refuses, by key, the seven nothing measures by then', () => {
      // The unit rollups (15) and the Owner's reporting metrics (18): refused before the move,
      // refused after it. `campaign.tenancy.spec.ts` proves it through the service for EVENT_NPS.
      expect(METRIC_IDS.filter((id) => metric(id).phase > CAMPAIGN_EVALUATION_PHASE).sort()).toEqual([
        'ACTIVITY_COMPLIANCE_RATE', 'EVENT_ATTENDANCE_RATE', 'EVENT_NPS', 'LEADER_COACHING_FREQUENCY',
        'MAA_COUNT_IN_UNIT', 'MOC_STATUS', 'PRODUCTION_CLUB_TIER',
      ].sort());
    });

    it('changed that set in exactly one way, accepted: coaching precedes campaigns now, so a campaign may require a coaching metric (AC-7)', () => {
      /*
       * Decided, not inherited. Under the old plan coaching (13) came after campaign evaluation
       * (12), so a campaign could not require a coaching metric; now coaching is 11 and campaigns
       * 14, and the six pass. Nothing else changes sides. A renumbering that moved anything else
       * across the line — or that put the six back — fails here by name.
       */
      const before = computableAt(OLD_CAMPAIGN_EVALUATION_PHASE, (id) => MOVED[id]?.from ?? metric(id).phase);
      const after = computableAt(CAMPAIGN_EVALUATION_PHASE, (id) => metric(id).phase);

      expect(after.filter((id) => !before.includes(id))).toEqual([...COACHING_SIX].sort());
      expect(before.filter((id) => !after.includes(id))).toEqual([]);
      expect(after.length).toBe(before.length + COACHING_SIX.length);
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
