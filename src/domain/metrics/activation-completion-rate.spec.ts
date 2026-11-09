import {
  activationCompletionRate, activationOutcome, cohortCompletionRate, lastFinishedYear, type ActivationStateForRate,
} from './activation-completion-rate';

const a = (membershipId: string, startDate: string, state: ActivationStateForRate) => ({ membershipId, startDate, state });

describe('ACTIVATION_COMPLETION_RATE (P18.3-T1 AC-7; OD-159 → option 1)', () => {
  describe('the tree’s reading of one activation', () => {
    it.each([
      ['graduated', false, 'completed'],
      // A graduation is never overdue: `isOverdue` is open-only, and a graduated hire reads *Completed* whatever day it is.
      ['graduated', true, 'completed'],
      ['open', false, 'in_progress'],
      ['open', true, 'overdue'],
      // An expired activation is *Overdue*, its end said beside it — never *Completed*, never *In progress*.
      ['expired', false, 'overdue'],
      ['expired', true, 'overdue'],
    ] as const)('P18.3-T1 AC-7 %s, overdue %s, reads %s', (state, overdue, outcome) => {
      expect(activationOutcome({ state, overdue })).toBe(outcome);
    });
  });

  describe('the rate, at its edges', () => {
    it('P18.3-T1 AC-7 graduated over every activation of the set — open and expired ones in the denominator', () => {
      expect(activationCompletionRate([
        { state: 'graduated' }, { state: 'graduated' }, { state: 'open' }, { state: 'expired' },
      ])).toEqual({ count: 2, of: 4, pct: 50 });
    });

    it('P18.3-T1 AC-7 over nobody is no rate: null, never 0%', () => {
      expect(activationCompletionRate([])).toEqual({ count: 0, of: 0, pct: null });
    });

    it('P18.3-T1 AC-7 none graduated is 0%; all graduated 100%', () => {
      expect(activationCompletionRate([{ state: 'open' }, { state: 'expired' }])).toEqual({ count: 0, of: 2, pct: 0 });
      expect(activationCompletionRate([{ state: 'graduated' }])).toEqual({ count: 1, of: 1, pct: 100 });
    });

    it('P18.3-T1 AC-7 rounds half up, as every share the Owner reads does: 12 of 19 is 63%, 1 of 8 is 13%', () => {
      const of = (graduated: number, total: number) => activationCompletionRate(Array.from({ length: total }, (_, i) => ({
        state: i < graduated ? 'graduated' as const : 'open' as const,
      })));
      // The seed's chip, under OD-159's 1 (the phase file's *Seed*): Siti and eleven of the cohort over nineteen.
      expect(of(12, 19)).toEqual({ count: 12, of: 19, pct: 63 });
      expect(of(1, 8)).toEqual({ count: 1, of: 8, pct: 13 });
    });
  });

  describe('the PRD’s figure: the same function over the last finished year’s cohort (exit test 3)', () => {
    it('P18.3-T1 AC-7 the last finished calendar year is the one before the office’s today’s', () => {
      expect(lastFinishedYear('2026-10-10')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
      expect(lastFinishedYear('2026-01-01')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
      expect(lastFinishedYear('2025-12-31')).toEqual({ from: '2024-01-01', to: '2024-12-31' });
    });

    it('P18.3-T1 AC-7 counts the cohort by its start day, both year ends included, and nobody else', () => {
      expect(cohortCompletionRate([
        a('dec31', '2025-12-31', 'graduated'),
        a('jan1', '2025-01-01', 'expired'),
        a('next', '2026-01-01', 'graduated'),
        a('before', '2024-12-31', 'open'),
      ], lastFinishedYear('2026-10-10'))).toEqual({ count: 1, of: 2, pct: 50 });
    });

    it('P18.3-T1 AC-7 exit review 6: each activation is in or out by its own start day, not by its membership', () => {
      // One membership, two activations: last year's graduated, this year's open. FY 2025 reads the first alone.
      const twice = [a('m', '2025-06-01', 'graduated'), a('m', '2026-02-01', 'open')];
      expect(cohortCompletionRate(twice, lastFinishedYear('2026-10-10'))).toEqual({ count: 1, of: 1, pct: 100 });
      expect(cohortCompletionRate(twice, { from: '2026-01-01', to: '2026-12-31' })).toEqual({ count: 0, of: 1, pct: 0 });
    });

    it('P18.3-T1 AC-7 an empty cohort is no rate', () => {
      expect(cohortCompletionRate([a('x', '2026-03-01', 'graduated')], lastFinishedYear('2026-10-10')))
        .toEqual({ count: 0, of: 0, pct: null });
    });

    /*
     * **Pinned on the seed's shape** (`seed/cohort-fixture.ts`, `seed/activation-fixture.ts`, run on 10 October 2026):
     * the twelve cohort hires of Phase 18's cast, every one graduated on day 71 — nine started in 2025 (Arini, Bonar,
     * Gilang — who left since, judged by the activation he had — Cahya, Damar, Elsa, Oscar, Ikhsan, Jihan), three in
     * 2026 (Pandu, Kemal, Raka); and Phase 13's hires, every one started in 2026: Siti graduated, Rina, Budi, Yanti,
     * Novi and Wahyu open, Dimas and Indah overdue. The PRD's figure reads FY 2025: nine of nine.
     */
    it('P18.3-T1 AC-7 exit test 3 on the seed’s shape: FY 2025’s cohort is 9 of 9, 100%; the open 2026 hires do not depress it', () => {
      const seed = [
        ...['arini', 'bonar', 'gilang', 'cahya', 'damar', 'elsa', 'oscar', 'ikhsan', 'jihan']
          .map((key, i) => a(key, `2025-${String(3 + i).padStart(2, '0')}-15`, 'graduated')),
        ...['pandu', 'kemal', 'raka'].map((key) => a(key, '2026-02-10', 'graduated')),
        a('siti', '2026-07-01', 'graduated'),
        ...['rina', 'budi', 'yanti', 'novi', 'wahyu'].map((key) => a(key, '2026-08-01', 'open')),
        ...['dimas', 'indah'].map((key) => a(key, '2026-07-01', 'open')),
      ];
      expect(cohortCompletionRate(seed, lastFinishedYear('2026-10-10'))).toEqual({ count: 9, of: 9, pct: 100 });
      // The same function over this year's cohort, open hires and all, is lower: why the PRD's figure reads a finished year.
      expect(cohortCompletionRate(seed, { from: '2026-01-01', to: '2026-12-31' })).toEqual({ count: 4, of: 11, pct: 36 });
    });
  });
});
