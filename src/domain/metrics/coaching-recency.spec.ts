import { FixedClock } from '@/common/clock/clock.port';
import { PERFORMANCE } from '@/domain/constants';
import {
  coached30d, coached7d, coachedWithin, daysSinceLastCoaching, oneOnOneOverdue,
} from './coaching-recency';

const TZ = 'Asia/Jakarta';
const clock = new FixedClock(new Date('2026-10-02T03:00:00Z'));
/** The office's calendar arithmetic, as the readings pass it. */
const days = (from: string, to: string) => clock.daysBetween(TZ, from, to);

/**
 * `DAYS_SINCE_LAST_COACHING`, `COACHED_7D` / `COACHED_30D` and the roster's *overdue*
 * (`metrics-and-definitions.md` §A.3; P11-T5 AC-8, P11-T6 AC-3). The reads that feed them, the office's
 * day boundary at 23:59 and 00:01 Jakarta among them, are `coaching-readings.tenancy.spec.ts`.
 */
describe('coaching recency (§A.3)', () => {
  describe('DAYS_SINCE_LAST_COACHING', () => {
    it('P11-T5 AC-8 is null — No 1:1 yet — for a member with no session finalized', () => {
      expect(daysSinceLastCoaching(null, '2026-10-02', days)).toBeNull();
    });

    it('P11-T5 AC-8 is 0 on the day of the 1:1, and whole calendar days after it', () => {
      expect(daysSinceLastCoaching('2026-10-02', '2026-10-02', days)).toBe(0);
      expect(daysSinceLastCoaching('2026-09-25', '2026-10-02', days)).toBe(7);
      // Across a month end, in calendar days rather than 24-hour blocks.
      expect(daysSinceLastCoaching('2026-09-30', '2026-10-01', days)).toBe(1);
    });
  });

  describe('COACHED_7D and COACHED_30D — the formula is the definition', () => {
    it('P11-T5 AC-8 counts a 1:1 seven days ago as coached in the last 7 days, and eight days ago as not', () => {
      // `<= 7` spans eight calendar dates: today and the seven before it.
      expect(coached7d(7)).toBe(true);
      expect(coached7d(8)).toBe(false);
      expect(coached7d(0)).toBe(true);
    });

    it('P11-T5 AC-8 counts 30 days as coached in the last 30, and 31 as not', () => {
      expect(coached30d(30)).toBe(true);
      expect(coached30d(31)).toBe(false);
    });

    it('P11-T5 AC-8 a member never coached is coached in neither window', () => {
      expect(coached7d(null)).toBe(false);
      expect(coached30d(null)).toBe(false);
      expect(coachedWithin(null, 365)).toBe(false);
    });
  });

  describe('the roster’s overdue', () => {
    it('P11-T6 AC-3 is overdue above the threshold, and not at it (`> 7`, Overall.html:10622)', () => {
      expect(oneOnOneOverdue(7, PERFORMANCE.COACHING_OVERDUE_DAYS)).toBe(false);
      expect(oneOnOneOverdue(8, PERFORMANCE.COACHING_OVERDUE_DAYS)).toBe(true);
      expect(oneOnOneOverdue(0, PERFORMANCE.COACHING_OVERDUE_DAYS)).toBe(false);
    });

    it('P11-T6 AC-3 reads the office’s own threshold, not the default', () => {
      expect(oneOnOneOverdue(4, 3)).toBe(true);
      expect(oneOnOneOverdue(10, 14)).toBe(false);
    });

    it('P11-T6 AC-3 at the default threshold, coached in the last 7 days is exactly not overdue', () => {
      for (let d = 0; d <= 40; d += 1) {
        expect({ d, both: coached7d(d) === !oneOnOneOverdue(d, PERFORMANCE.COACHING_OVERDUE_DAYS) })
          .toEqual({ d, both: true });
      }
    });
  });
});
