import { CAMPAIGN_METRICS, metricByKey } from '@/domain/constants';
import { qualify, readingAgreesWithPeriod, requirementProgress, type RequirementReading } from './campaign-qualification';
import { combine, compare, criterionMet } from './criteria';
import { metric } from './registry';

const APE = { metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 100 };
const read = (current: number | null, over: Partial<RequirementReading> = {}): RequirementReading =>
  ({ current, missing: false, open: false, ...over });

/**
 * `CAMPAIGN_QUALIFICATION_STATUS` (P18.2-T8 AC-3, AC-4, AC-6, AC-7; OD-153, OD-154, OD-157): a row per requirement as
 * the dialog prints it, and the status — three-valued, through the one rule MOC is decided by.
 */
describe('campaign qualification (P18.2-T8)', () => {
  describe('a requirement’s row (OD-157)', () => {
    it('P18.2-T8 AC-6 is met — "{current} of {target}" with ✓ — once the figure clears the target, open or not', () => {
      expect(requirementProgress(APE, read(150), true)).toMatchObject({ current: 150, target: 100, met: true, state: 'met' });
      expect(requirementProgress(APE, read(100, { open: true }), true)).toMatchObject({ met: true, state: 'met' });
    });

    it('P18.2-T8 AC-3 reads a month not held as Not uploaded yet, never ✕ — short only because the file has not landed', () => {
      expect(requirementProgress(APE, read(null), true)).toMatchObject({ current: null, met: null, state: 'not_uploaded' });
      expect(requirementProgress(APE, read(60, { missing: true }), true)).toMatchObject({ current: 60, met: null, state: 'not_uploaded' });
      // Missing, and met already: the months held clear it.
      expect(requirementProgress(APE, read(160, { missing: true }), true)).toMatchObject({ met: true, state: 'met' });
    });

    it('P18.2-T8 AC-6 is in progress while the window is open, and not met only once it is final', () => {
      expect(requirementProgress(APE, read(60, { open: true }), true)).toMatchObject({ met: null, state: 'in_progress' });
      expect(requirementProgress(APE, read(60), true)).toMatchObject({ current: 60, met: false, state: 'not_met' });
    });

    it('P18.2-T8 AC-1 reads a stored requirement outside the evaluable set as Not measured yet, deciding nothing', () => {
      const nps = { metricKey: 'EVENT_NPS', comparator: 'gte', value: 50 };
      expect(requirementProgress(nps, undefined, false)).toMatchObject({ current: null, met: null, state: 'not_measured' });
      expect(requirementProgress(nps, read(80), false)).toMatchObject({ state: 'not_measured' });
    });

    it('P18.2-T8 AC-4 compares by each of the five comparators', () => {
      expect([compare(5, 'gte', 5), compare(5, 'gt', 5), compare(5, 'lte', 5), compare(5, 'lt', 5), compare(5, 'eq', 5)])
        .toEqual([true, false, true, false, true]);
      expect([compare(4, 'gt', 3), compare(2, 'lt', 3), compare(4, 'eq', 5)]).toEqual([true, true, false]);
      expect(requirementProgress({ ...APE, comparator: 'lte' }, read(90), true).state).toBe('met');
    });
  });

  describe('the status (AC-4; OD-153, OD-154)', () => {
    const met = requirementProgress(APE, read(150), true);
    const missed = requirementProgress(APE, read(60), true);
    const unknown = requirementProgress(APE, read(null), true);
    const open = requirementProgress(APE, read(60, { open: true }), true);
    const chaser = (final: boolean) => ({ chasing: true, eligible: true, final });

    it('P18.2-T8 AC-4 qualifies a chaser who meets every requirement — while it runs and once final', () => {
      expect(qualify([met, met], chaser(false)).status).toBe('qualified');
      expect(qualify([met], chaser(true)).status).toBe('qualified');
    });

    it('P18.2-T8 AC-4 is in progress while not final, and not met or unknown once it is', () => {
      expect(qualify([met, open], chaser(false)).status).toBe('in_progress');
      expect(qualify([met, missed], chaser(true)).status).toBe('not_met');
      expect(qualify([met, unknown], chaser(true)).status).toBe('unknown');
      // One ✕ fails it whatever else is unknown (Kleene's AND).
      expect(qualify([missed, unknown], chaser(true)).status).toBe('not_met');
    });

    it('P18.2-T8 AC-4 a member who did not chase is not_joined, running or final, whatever they produced (OD-153, ADR-0143)', () => {
      expect(qualify([met], { chasing: false, eligible: true, final: false })).toMatchObject({ status: 'not_joined', requirementsMet: true });
      expect(qualify([met], { chasing: false, eligible: true, final: true })).toMatchObject({ status: 'not_joined', requirementsMet: true });
      expect(qualify([missed], { chasing: false, eligible: false, final: true }).status).toBe('not_joined');
    });

    it('P18.2-T8 AC-4 qualifies no chaser outside its rungs, nor by a campaign that asks for nothing', () => {
      expect(qualify([met], { chasing: true, eligible: false, final: true }).status).toBe('not_met');
      expect(qualify([met], { chasing: true, eligible: false, final: false }).status).toBe('in_progress');
      expect(qualify([], chaser(true))).toMatchObject({ status: 'unknown', requirementsMet: null });
    });

    it('P18.2-T8 AC-4 shares MOC’s three-valued rule: one function, `moc-status.ts` re-exporting it', () => {
      expect(combine([true, null], 'all')).toBeNull();
      expect(combine([false, null], 'all')).toBe(false);
      expect(combine([true, null], 'any')).toBe(true);
      expect(combine([false, null], 'any')).toBeNull();
      expect(combine([false, false], 'any')).toBe(false);
      expect(criterionMet(undefined, 'gte', 1)).toBeNull();
      expect(criterionMet({ current: null }, 'gte', 1)).toBeNull();
      expect(criterionMet({ current: 2 }, 'gte', 1)).toBe(true);
    });
  });

  describe('a reading agrees with its metric’s period (AC-7, D-period)', () => {
    it.each(CAMPAIGN_METRICS.map((m) => m.key))('P18.2-T8 AC-7 %s is read as its period allows', (key) => {
      expect(readingAgreesWithPeriod(metricByKey(key)!.campaign!, metric(key).period)).toBe(true);
    });

    it('P18.2-T8 AC-7 refuses a sum over a rolling or point-in-time figure, the latest of a log, a ratio of the file', () => {
      expect(readingAgreesWithPeriod({ source: 'file', aggregate: 'sum', subject: 'self' }, 'ROLLING_12M')).toBe(false);
      expect(readingAgreesWithPeriod({ source: 'file', aggregate: 'sum', subject: 'self' }, 'POINT_IN_TIME')).toBe(false);
      expect(readingAgreesWithPeriod({ source: 'activity', aggregate: 'sum', subject: 'self' }, 'CALENDAR_YEAR')).toBe(false);
      expect(readingAgreesWithPeriod({ source: 'activity', aggregate: 'latest', subject: 'self' }, 'CALENDAR_MONTH')).toBe(false);
      expect(readingAgreesWithPeriod({ source: 'file', aggregate: 'latest', subject: 'self' }, 'CALENDAR_YEAR')).toBe(false);
      expect(readingAgreesWithPeriod({ source: 'file', aggregate: 'ratio', subject: 'self' }, 'ROLLING_30D')).toBe(false);
      expect(readingAgreesWithPeriod({ source: 'activity', aggregate: 'ratio', subject: 'self' }, 'CALENDAR_MONTH')).toBe(false);
      expect(readingAgreesWithPeriod({ source: 'activity', aggregate: 'ratio', subject: 'self' }, 'ROLLING_7D')).toBe(true);
    });
  });
});
