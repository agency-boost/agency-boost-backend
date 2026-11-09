import { FixedClock } from '@/common/clock/clock.port';
import { activationCohort, type CohortActivation } from './activation-cohort';

const JAKARTA = 'Asia/Jakarta';

describe('ACTIVATION_COHORT (P18.1-T1; D-cohort, ADR-0102, ADR-0103)', () => {

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
  // P18.8-T6: the four months and the share were `NEW_AGENT_3M_ACTIVE_PCT`'s, retired by ADR-0171 §2 for `ACTIVATION_3M_PCT`
  // (`activation-3m.spec.ts`). The cohort stays, for `ACTIVATION_COMPLETION_RATE`.
});
