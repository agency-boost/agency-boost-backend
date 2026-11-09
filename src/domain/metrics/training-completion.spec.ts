import { TRAINING_STATUSES, type TrainingStatus } from '@/domain/constants';
import { metric } from './registry';
import { completionByScope, trainingCompletion } from './training-completion';

const statuses = (entries: Record<string, TrainingStatus>) => new Map(Object.entries(entries));

/**
 * `TRAINING_COMPLETION_PCT`, pinned at each edge (P18.2-T2 AC-2): offered-only denominator, done-only numerator,
 * `null` for an empty scope, drafts and archived modules in neither, a module archived after being done among them.
 */
describe('TRAINING_COMPLETION_PCT (P18.2-T2)', () => {
  it('P18.2-T2 AC-1 the statuses are the prototype’s three, in its order — the member’s own word (OD-149)', () => {
    expect(TRAINING_STATUSES).toEqual(['not_started', 'in_progress', 'done']);
  });

  it('P18.2-T2 AC-2 is point in time, with no threshold (the registry agrees with the definition)', () => {
    expect(metric('TRAINING_COMPLETION_PCT')).toMatchObject({ period: 'POINT_IN_TIME', threshold: null, unit: 'percentage' });
  });

  it('P18.2-T2 AC-2 counts done over offered, as a whole percent', () => {
    const s = statuses({ A: 'done', B: 'done', C: 'in_progress' });
    expect(trainingCompletion(['A', 'B', 'C', 'D'], s)).toEqual({ done: 2, total: 4, pct: 50 });
  });

  it('P18.2-T2 AC-2 does not count in progress as done', () => {
    expect(trainingCompletion(['A'], statuses({ A: 'in_progress' }))).toEqual({ done: 0, total: 1, pct: 0 });
  });

  it('P18.2-T2 AC-2 an empty scope is null, never 0% — drawn (0/0)', () => {
    expect(trainingCompletion([], statuses({ A: 'done' }))).toEqual({ done: 0, total: 0, pct: null });
  });

  it('P18.2-T2 AC-2 a module the member did that is no longer offered is in neither number (D-history)', () => {
    // CLIENT_RETENTION done, then archived: the offered scope no longer names it.
    const s = statuses({ CLIENT_RETENTION: 'done', PROSPECT_LIST: 'done' });
    expect(trainingCompletion(['PROSPECT_LIST', 'REFERRAL_GENERATION'], s)).toEqual({ done: 1, total: 2, pct: 50 });
  });

  it('P18.2-T2 AC-2 a draft is never in the scope, so a status on it counts for nothing', () => {
    // The caller passes what the snapshot offers; a draft's code is not among them.
    expect(trainingCompletion(['A'], statuses({ A: 'not_started', DRAFT_MODULE: 'done' })).done).toBe(0);
  });

  it('P18.2-T2 AC-2 counts a module named twice once', () => {
    expect(trainingCompletion(['A', 'A', 'B'], statuses({ A: 'done' }))).toEqual({ done: 1, total: 2, pct: 50 });
  });

  it('P18.2-T2 AC-2 rounds half up, as every share the product draws', () => {
    expect(trainingCompletion(['A', 'B', 'C'], statuses({ A: 'done', B: 'done' })).pct).toBe(67);
    expect(trainingCompletion(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], statuses({ A: 'done' })).pct).toBe(13);
  });

  describe('every scope at once', () => {
    const tree = [
      {
        code: 'SALES',
        skills: [
          { code: 'PROSPECTING', modules: [{ code: 'P1' }, { code: 'P2' }] },
          { code: 'CLOSING', modules: [{ code: 'C1' }] },
        ],
      },
      { code: 'PRODUCT', skills: [] },
    ];

    it('P18.2-T2 AC-2 answers the catalog, each category and each skill', () => {
      const out = completionByScope(tree, statuses({ P1: 'done', C1: 'done', P2: 'in_progress' }));
      expect(out.catalog).toEqual({ done: 2, total: 3, pct: 67 });
      expect(out.categories.get('SALES')).toEqual({ done: 2, total: 3, pct: 67 });
      expect(out.categories.get('PRODUCT')).toEqual({ done: 0, total: 0, pct: null });
      expect(out.skills.get('PROSPECTING')).toEqual({ done: 1, total: 2, pct: 50 });
      expect(out.skills.get('CLOSING')).toEqual({ done: 1, total: 1, pct: 100 });
      expect(out.allOfferedDone).toBe(false);
    });

    it('P18.2-T2 AC-3 every offered module done is all offered done', () => {
      expect(completionByScope(tree, statuses({ P1: 'done', P2: 'done', C1: 'done' })).allOfferedDone).toBe(true);
    });

    it('P18.2-T2 AC-3 nothing offered is not all done', () => {
      expect(completionByScope([], new Map()).allOfferedDone).toBe(false);
      expect(completionByScope([{ code: 'PRODUCT', skills: [] }], new Map()).catalog).toEqual({ done: 0, total: 0, pct: null });
    });
  });
});
