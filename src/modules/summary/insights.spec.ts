import { INSIGHTS } from '@/domain/constants';
import type { OpenLead } from '@/modules/leads/lead-readings';
import { insightsFor, type InsightInputs, type RatioReading } from './insights';

const logged = { compliant: true, windowDays: 7, lastLoggedOn: '2026-09-13' as const };
const lead = (over: Partial<OpenLead>): OpenLead => ({
  id: 'l-1', name: 'Pak Hendro', type: 'sales', statusCode: 'FOLLOW_UP', statusLabel: 'Follow-up', thisMonth: false,
  flags: [], overdueDays: null, nextActionDate: '2026-09-20', nextActionNote: null, ...over,
});
const ratio = (over: Partial<RatioReading>): RatioReading => ({
  code: 'SELLING_SUCCESS_RATE', label: 'Selling success rate', comparison: 'gte', displayUnit: 'percent',
  benchmark: 0.15, value: 0.15, denominatorCount: 10, status: 'success', ...over,
});
const pace = (over: Record<string, unknown> = {}) => ({
  closingTarget: 6, closingsLast30Days: 4, dayOfMonth: 14, daysInMonth: 30, weeksLeft: 3, policiesNeeded: 5, neededPerWeek: 2,
  targetMet: false, ...over,
});
const quiet: InsightInputs = { compliance: logged, pace: null, leads: [], ratios: [] };
const rules = (input: Partial<InsightInputs>) => insightsFor({ ...quiet, ...input }).map((c) => c.rule);

/** The insight rules (P10-T7, ADR-0060): named, over registered metrics, computed on read. */
describe('the insight rules (P10-T7)', () => {
  it('AC-3: says nothing when nothing fired — no card is made up to fill the four', () => {
    expect(insightsFor(quiet)).toEqual([]);
  });

  describe('NOTHING_LOGGED — silence in the office’s compliance window', () => {
    it('fires on no entry in the window, with the window and the last day logged', () => {
      expect(insightsFor({ ...quiet, compliance: { compliant: false, windowDays: 7, lastLoggedOn: '2026-09-01' } })).toEqual([
        { rule: 'NOTHING_LOGGED', kind: 'action', facts: { windowDays: 7, lastLoggedOn: '2026-09-01' } },
      ]);
    });

    it('stays quiet for a member who logged — a day of zeroes included, which the window already counts', () => {
      expect(rules({ compliance: logged })).toEqual([]);
    });
  });

  describe('BEHIND_PACE — the pace line’s own *behind*', () => {
    it('P13.1-T5 AC-2 fires on the last 30 days’ closings short of the month’s closing target (ADR-0109)', () => {
      expect(insightsFor({ ...quiet, pace: pace() })).toEqual([
        { rule: 'BEHIND_PACE', kind: 'action', facts: { closingsLast30Days: 4, closingTarget: 6, neededPerWeek: 2, weeksLeft: 3 } },
      ]);
    });

    it('P13.1-T5 AC-1 fires on the 1st as on any day: there is no first week without a pace', () => {
      expect(rules({ pace: pace({ dayOfMonth: 1, weeksLeft: 5, closingsLast30Days: 0 }) })).toEqual(['BEHIND_PACE']);
    });

    it('stays quiet at the target, once the APE target is reached, and without a goal', () => {
      expect(rules({ pace: pace({ closingsLast30Days: 6 }) })).toEqual([]);
      expect(rules({ pace: pace({ closingsLast30Days: 21 }) })).toEqual([]);
      expect(rules({ pace: pace({ targetMet: true }) })).toEqual([]);
      expect(rules({ pace: null })).toEqual([]);
    });
  });

  describe('LEAD_OVERDUE and LEAD_NEGLECTED — the Leads screen’s own flags', () => {
    it('names the latest of the late, and counts the others', () => {
      const [card] = insightsFor({
        ...quiet,
        leads: [
          lead({ id: 'a', name: 'Ibu Wulan', flags: ['overdue'], overdueDays: 2 }),
          lead({ id: 'b', name: 'Pak Heri', flags: ['overdue', 'no-remarks'], overdueDays: 8 }),
          lead({ id: 'c', name: 'Pak Joko', flags: [] }),
          lead({ id: 'd', name: 'Ibu Ratna', flags: ['overdue'], overdueDays: 5 }),
        ],
      });
      expect(card).toEqual({ rule: 'LEAD_OVERDUE', kind: 'action', facts: { leadId: 'b', name: 'Pak Heri', overdueDays: 8, others: 2 } });
    });

    it('a lead with neither a next action nor a remark is neglected — one of the two is not', () => {
      const cards = insightsFor({
        ...quiet,
        leads: [
          lead({ id: 'a', name: 'Pak Bambang', flags: ['no-next-action'] }),
          lead({ id: 'b', name: 'Pak Alvin', flags: ['no-next-action', 'no-remarks'] }),
          lead({ id: 'c', name: 'Pak Surya', flags: ['no-next-action', 'no-remarks'] }),
        ],
      });
      expect(cards).toEqual([{ rule: 'LEAD_NEGLECTED', kind: 'action', facts: { leadId: 'b', name: 'Pak Alvin', others: 1 } }]);
    });
  });

  describe('RATIO_BELOW and RATIO_STRENGTH — rates with enough behind them', () => {
    it('names the rate furthest below its benchmark, as a share of it', () => {
      const [card] = insightsFor({
        ...quiet,
        ratios: [
          ratio({ code: 'A', label: 'A', value: 0.12, status: 'alert' }), // 80% of 0.15
          ratio({ code: 'B', label: 'B', displayUnit: 'decimal', benchmark: 1.5, value: 0.3, status: 'alert' }), // 20% of 1.5
          ratio({ code: 'C', label: 'C', value: 0.09, status: 'alert' }), // 60% — after the worst, and not it
        ],
      });
      expect(card).toEqual({
        rule: 'RATIO_BELOW', kind: 'improve', facts: { code: 'B', label: 'B', value: 0.3, benchmark: 1.5, displayUnit: 'decimal' },
      });
    });

    it(`says nothing over fewer than ${INSIGHTS.RATIO_MIN_DENOMINATOR} of the denominator, or without a value`, () => {
      expect(rules({ ratios: [ratio({ value: 0, status: 'alert', denominatorCount: INSIGHTS.RATIO_MIN_DENOMINATOR - 1 })] })).toEqual([]);
      expect(rules({ ratios: [ratio({ value: 0, status: 'alert', denominatorCount: INSIGHTS.RATIO_MIN_DENOMINATOR })] })).toEqual(['RATIO_BELOW']);
      expect(rules({ ratios: [ratio({ value: null, status: 'neutral', denominatorCount: 0 })] })).toEqual([]);
    });

    it(`calls a rate a strength only at ${INSIGHTS.STRENGTH_FACTOR}× its benchmark or more, and names the furthest`, () => {
      expect(rules({ ratios: [ratio({ value: 0.2 })] })).toEqual([]); // above, not well above
      const [card] = insightsFor({
        ...quiet,
        ratios: [
          ratio({ code: 'A', label: 'A', value: 0.225 }), // exactly 1.5×
          ratio({ code: 'B', label: 'B', displayUnit: 'decimal', benchmark: 0.3, value: 0.54 }), // 1.8×
          ratio({ code: 'C', label: 'C', value: 0.24 }), // 1.6× — after the best, and not it
        ],
      });
      expect(card).toMatchObject({ rule: 'RATIO_STRENGTH', facts: { code: 'B', value: 0.54 } });
    });

    it('leaves the balance out — it is a lean either way, not a rate against a floor — and a zero benchmark', () => {
      expect(rules({
        ratios: [
          ratio({ comparison: 'band', displayUnit: 'points', benchmark: 30, value: 80, status: 'alert' }),
          ratio({ benchmark: 0, value: 0.4 }),
        ],
      })).toEqual([]);
    });
  });

  it('AC-3: takes the rules in their fixed priority, and at most four of them', () => {
    const everything: InsightInputs = {
      compliance: { compliant: false, windowDays: 7, lastLoggedOn: null },
      pace: pace(),
      leads: [lead({ flags: ['overdue'], overdueDays: 3 }), lead({ id: 'l-2', flags: ['no-next-action', 'no-remarks'] })],
      ratios: [ratio({ code: 'LOW', value: 0.05, status: 'alert' }), ratio({ code: 'HIGH', value: 0.4 })],
    };
    expect(insightsFor(everything).map((c) => c.rule)).toEqual(['NOTHING_LOGGED', 'BEHIND_PACE', 'LEAD_OVERDUE', 'LEAD_NEGLECTED']);
    expect(insightsFor(everything)).toHaveLength(INSIGHTS.MAX_CARDS);

    // With the first two quiet, both ratio cards make the four.
    expect(insightsFor({ ...everything, compliance: logged, pace: null }).map((c) => c.rule))
      .toEqual(['LEAD_OVERDUE', 'LEAD_NEGLECTED', 'RATIO_BELOW', 'RATIO_STRENGTH']);
  });
});
