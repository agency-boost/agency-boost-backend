import { PERFORMANCE } from '@/domain/constants';
import { COACHING_STATUS, COACHING_STATUSES } from '@/domain/constants/coaching-status';
import { coachingStatus } from './coaching-status';
import { oneOnOneOverdue } from './coaching-recency';

/**
 * **`COACHING_STATUS`: red never, green up to 14 days, yellow after** (P19.17-T1 AC-5; ADR-0267 §5;
 * `metrics-and-definitions.md` §A.3). A new named metric beside the roster's *overdue*, which keeps its 7.
 */
describe('the coaching status tile (P19.17-T1 AC-5, ADR-0267 §5)', () => {
  it('pins 14 days and the three states', () => {
    expect(COACHING_STATUS.RECENT_MAX_DAYS).toBe(14);
    expect(COACHING_STATUSES).toEqual(['never', 'recent', 'lapsed']);
  });

  it('is red with no 1-on-1 ever', () => {
    expect(coachingStatus(null)).toBe('never');
  });

  it('is green from today to the 14th day, yellow from the 15th', () => {
    expect(coachingStatus(0)).toBe('recent');
    expect(coachingStatus(7)).toBe('recent');
    expect(coachingStatus(14)).toBe('recent');
    expect(coachingStatus(15)).toBe('lapsed');
    expect(coachingStatus(90)).toBe('lapsed');
  });

  it('does not change the roster’s overdue, which stays at 7: ten days is overdue there and green here', () => {
    expect(PERFORMANCE.COACHING_OVERDUE_DAYS).toBe(7);
    expect(oneOnOneOverdue(10, PERFORMANCE.COACHING_OVERDUE_DAYS)).toBe(true);
    expect(coachingStatus(10)).toBe('recent');
  });
});
