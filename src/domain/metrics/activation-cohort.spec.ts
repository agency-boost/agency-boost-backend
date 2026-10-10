import { FixedClock } from '@/common/clock/clock.port';
import { NEW_AGENT_ACTIVE_MONTHS } from '@/domain/constants/metrics';
import {
  activationCohort, cohortOutcome, newAgent3mActive, type CohortActivation, type CohortMonth,
} from './activation-cohort';

const JAKARTA = 'Asia/Jakarta';
/** A month a hire was here for, as the office's file holds it. */
const month = (active: boolean | null, over: Partial<CohortMonth> = {}): CohortMonth => ({ held: true, belonged: true, active, ...over });
const ON = month(true);
const OFF = month(false);
const SILENT = month(null);
const NOT_HELD = month(null, { held: false });
const GONE = month(null, { belonged: false });

describe('ACTIVATION_COHORT and NEW_AGENT_3M_ACTIVE_PCT (P18.1-T1; D-cohort, ADR-0102, ADR-0103)', () => {
  it('P18.1-T1 AC-2 reads a hire’s start month and the three after it: four months', () => {
    expect(NEW_AGENT_ACTIVE_MONTHS).toBe(4);
  });

  describe('the cohort (AC-1)', () => {
    const started: CohortActivation[] = [
      { membershipId: 'a', startDate: '2025-12-31' },
      { membershipId: 'b', startDate: '2026-01-01' },
      { membershipId: 'c', startDate: '2026-06-30' },
      { membershipId: 'd', startDate: '2026-07-01' },
    ];

    it('P18.1-T1 AC-1 counts the activations that started in the period, both bounds included', () => {
      expect(activationCohort(started, { from: '2026-01-01', to: '2026-06-30' })).toEqual(['b', 'c']);
      expect(activationCohort(started, { from: '2025-01-01', to: '2025-12-31' })).toEqual(['a']);
      expect(activationCohort([], { from: '2026-01-01', to: '2026-12-31' })).toEqual([]);
    });

    it('P18.1-T1 AC-1 counts a membership once, and a rejoiner’s second membership as its own', () => {
      const twice = [...started, { membershipId: 'b', startDate: '2026-02-01' }, { membershipId: 'b2', startDate: '2026-03-01' }];
      expect(activationCohort(twice, { from: '2026-01-01', to: '2026-06-30' })).toEqual(['b', 'c', 'b2']);
    });

    it('P18.1-T1 AC-2 pins a start on a month’s last day at 23:59 and at 00:01 Jakarta time: the office’s calendar decides', () => {
      // How a start is written (`ActivationProgressService.create`): the join instant, in the office's zone.
      const clock = new FixedClock(new Date('2026-10-10T03:00:00Z'));
      const lastMinute = clock.localDateFor(JAKARTA, new Date('2026-01-31T16:59:00Z')); // 31 Jan, 23:59 in Jakarta
      const firstMinute = clock.localDateFor(JAKARTA, new Date('2026-01-31T17:01:00Z')); // 1 Feb, 00:01 in Jakarta
      expect([lastMinute, firstMinute]).toEqual(['2026-01-31', '2026-02-01']);
      // Both are still 31 January in UTC: a day key read from the instant would put both in January.
      expect(new Date('2026-01-31T17:01:00Z').toISOString().slice(0, 10)).toBe('2026-01-31');
      const hires = [{ membershipId: 'late', startDate: lastMinute }, { membershipId: 'early', startDate: firstMinute }];
      expect(activationCohort(hires, { from: '2026-01-01', to: '2026-01-31' })).toEqual(['late']);
      expect(activationCohort(hires, { from: '2026-02-01', to: '2026-02-28' })).toEqual(['early']);
    });
  });

  describe('one hire’s four months (AC-2)', () => {
    it('P18.1-T1 AC-2 a hire active in any of the four is producing — the start month, or the fourth', () => {
      expect(cohortOutcome([ON, OFF, OFF, OFF])).toBe('producing');
      expect(cohortOutcome([OFF, OFF, OFF, ON])).toBe('producing');
    });

    it('P18.1-T1 AC-2 a hire active only in their fifth month is not producing: the four are what count', () => {
      expect(cohortOutcome([OFF, OFF, OFF, OFF, ON])).toBe('not_producing');
    });

    it('P18.1-T1 AC-2 a held month whose file says nothing of them is not one they were active in', () => {
      expect(cohortOutcome([SILENT, SILENT, OFF, SILENT])).toBe('not_producing');
    });

    it('P18.1-T1 AC-2 a hire whose four months are not all held is left out — even one already active — never not producing', () => {
      expect(cohortOutcome([OFF, OFF, NOT_HELD, OFF])).toBe('left_out');
      expect(cohortOutcome([ON, NOT_HELD, NOT_HELD, NOT_HELD])).toBe('left_out');
      expect(cohortOutcome([OFF, OFF])).toBe('left_out');
    });

    it('P18.1-T1 AC-2 Noted 4: a hire who left within their four months is producing on a held month they belonged in', () => {
      expect(cohortOutcome([OFF, ON, GONE, GONE])).toBe('producing');
      // Active in a month whose file is not held does not count; neither does a month after they left.
      expect(cohortOutcome([OFF, month(true, { held: false }), GONE, GONE])).toBe('left_out');
      expect(cohortOutcome([OFF, OFF, month(true, { belonged: false }), GONE])).toBe('left_out');
    });

    it('P18.1-T1 AC-2 Noted 4: a leaver active in none of their months is left out, not counted as not producing', () => {
      expect(cohortOutcome([OFF, OFF, GONE, GONE])).toBe('left_out');
      expect(cohortOutcome([GONE, GONE, GONE, GONE])).toBe('left_out');
    });
  });

  describe('the share (AC-2)', () => {
    it('P18.1-T1 AC-2 is producing over counted, a whole percentage, the left out in neither', () => {
      expect(newAgent3mActive([[ON, OFF, OFF, OFF], [OFF, OFF, OFF, OFF], [OFF, SILENT, OFF, OFF], [ON, NOT_HELD, OFF, OFF]]))
        .toEqual({ count: 1, of: 3, pct: 33, leftOut: 1 });
      expect(newAgent3mActive([[ON, ON, ON, ON], [OFF, ON, GONE, GONE]])).toEqual({ count: 2, of: 2, pct: 100, leftOut: 0 });
    });

    it('P18.1-T1 AC-2 is pending — pct null, never 0% — while nobody is counted, an empty cohort included', () => {
      expect(newAgent3mActive([[OFF, NOT_HELD, NOT_HELD, NOT_HELD]])).toEqual({ count: 0, of: 0, pct: null, leftOut: 1 });
      expect(newAgent3mActive([])).toEqual({ count: 0, of: 0, pct: null, leftOut: 0 });
    });
  });
});
