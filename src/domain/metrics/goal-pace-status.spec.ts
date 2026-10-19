import { PERFORMANCE } from '@/domain/constants';
import { GOAL_PACE_STATUSES, goalPaceStatus } from './goal-pace-status';

const M = 1_000_000 * 100;
const RATIO = PERFORMANCE.ON_TRACK_PACE_THRESHOLD;
const month = (
  apeMinor: number | null, pacing = true, targetMinor = 100 * M,
  closings: { last30Days: number; target: number } | null = null,
) => ({ targetMinor, apeMinor, pacing, closings });

/**
 * `GOAL_PACE_STATUS` (`metrics-and-definitions.md` §A.4, ADR-0080): the roster's *Status* (P11-T6 AC-4).
 * Each of the four states, and the order the branches are tested in.
 */
describe('GOAL_PACE_STATUS (§A.4)', () => {
  it('P11-T6 AC-4 has four values, ADR-0080’s fourth among them', () => {
    expect(GOAL_PACE_STATUSES).toEqual(['on_track', 'watch_closely', 'needs_attention', 'no_goal_set']);
  });

  it('P11-T6 AC-4 ADR-0080: a member with no target reads No goal set, never Watch closely', () => {
    expect(goalPaceStatus({ month: null, onTrackRatio: RATIO })).toBe('no_goal_set');
  });

  it('P11-T6 AC-4 not pacing to MAA is Needs attention, full stop — whatever the APE says', () => {
    // A month already at 150% of its target that projects no policy is still the conversation to have.
    expect(goalPaceStatus({ month: month(150 * M, false), onTrackRatio: RATIO })).toBe('needs_attention');
    expect(goalPaceStatus({ month: month(null, false), onTrackRatio: RATIO })).toBe('needs_attention');
  });

  it('P11-T6 AC-4 pacing, at or above the on-track ratio of this month’s target, is On track', () => {
    expect(goalPaceStatus({ month: month(90 * M), onTrackRatio: RATIO })).toBe('on_track');
    expect(goalPaceStatus({ month: month(125 * M), onTrackRatio: RATIO })).toBe('on_track');
  });

  it('P11-T6 AC-4 pacing, below the on-track ratio, is Watch closely', () => {
    expect(goalPaceStatus({ month: month(89.99 * M), onTrackRatio: RATIO })).toBe('watch_closely');
    expect(goalPaceStatus({ month: month(0), onTrackRatio: RATIO })).toBe('watch_closely');
  });

  it('P11-T6 AC-4 nothing uploaded for the month yet is a pace of 0: Watch closely when pacing', () => {
    expect(goalPaceStatus({ month: month(null), onTrackRatio: RATIO })).toBe('watch_closely');
  });

  it('P11-T6 AC-4 reads the office’s own on-track ratio (PACE_ON_TRACK_RATIO)', () => {
    expect(goalPaceStatus({ month: month(80 * M), onTrackRatio: 0.75 })).toBe('on_track');
    expect(goalPaceStatus({ month: month(80 * M), onTrackRatio: RATIO })).toBe('watch_closely');
  });

  /*
   * **Rewritten 2026-10-02 (OD-109, option 2).** This was *a zero target never divides: the prototype's
   * pace of 0*, which read Watch closely. A zero target is a month that needs nothing more, so it is met.
   */
  it('OD-109 a zero target — the year already met — reads met once the gate passes: On track', () => {
    expect(goalPaceStatus({ month: month(10 * M, true, 0), onTrackRatio: RATIO })).toBe('on_track');
    expect(goalPaceStatus({ month: month(null, true, 0), onTrackRatio: RATIO })).toBe('on_track');
    expect(goalPaceStatus({ month: month(0, true, 0, { last30Days: 0, target: 0 }), onTrackRatio: RATIO })).toBe('on_track');
  });

  it('OD-109 a year met is still gated first: not pacing to MAA is Needs attention, full stop', () => {
    expect(goalPaceStatus({ month: month(10 * M, false, 0), onTrackRatio: RATIO })).toBe('needs_attention');
  });

  /*
   * **Amended 2026-10-07 (ADR-0109).** The activity's pace is the Summary sentence's: the closings of the
   * last 30 days over this month's closing target, where it was ADR-0057's run-rate, `null` before the 7th.
   */
  describe('OD-110: until this month’s file lands, the pace is the activity’s', () => {
    it('OD-110 with no APE, the last 30 days’ closings at the on-track share of the closing target is On track', () => {
      // 9 of 10 is exactly the default 0.90, which is inclusive.
      expect(goalPaceStatus({ month: month(null, true, 100 * M, { last30Days: 9, target: 10 }), onTrackRatio: RATIO }))
        .toBe('on_track');
      expect(goalPaceStatus({ month: month(null, true, 100 * M, { last30Days: 12, target: 10 }), onTrackRatio: RATIO }))
        .toBe('on_track');
    });

    it('OD-110 with no APE, the last 30 days’ closings below that share is Watch closely', () => {
      expect(goalPaceStatus({ month: month(null, true, 100 * M, { last30Days: 8, target: 10 }), onTrackRatio: RATIO }))
        .toBe('watch_closely');
      expect(goalPaceStatus({ month: month(null, true, 100 * M, { last30Days: 0, target: 10 }), onTrackRatio: RATIO }))
        .toBe('watch_closely');
    });

    it('P13.1-T5 AC-4 there is no first week without an answer: the 30 days answer on the 1st as on the 30th', () => {
      // The closings argument carries no day: what the window counts is the answer, every day of the month.
      expect(goalPaceStatus({ month: month(null, true, 100 * M, { last30Days: 10, target: 10 }), onTrackRatio: RATIO }))
        .toBe('on_track');
    });

    it('OD-110 once the file lands APE decides, whatever the activity says', () => {
      expect(goalPaceStatus({ month: month(20 * M, true, 100 * M, { last30Days: 30, target: 10 }), onTrackRatio: RATIO }))
        .toBe('watch_closely');
      expect(goalPaceStatus({ month: month(95 * M, true, 100 * M, { last30Days: 0, target: 10 }), onTrackRatio: RATIO }))
        .toBe('on_track');
    });

    it('OD-110 reads the office’s own on-track ratio on the activity pace too', () => {
      expect(goalPaceStatus({ month: month(null, true, 100 * M, { last30Days: 7, target: 10 }), onTrackRatio: 0.7 }))
        .toBe('on_track');
      expect(goalPaceStatus({ month: month(null, true, 100 * M, { last30Days: 7, target: 10 }), onTrackRatio: RATIO }))
        .toBe('watch_closely');
    });

    it('OD-110 the gate still comes first: not pacing is Needs attention whatever the closings say', () => {
      expect(goalPaceStatus({ month: month(null, false, 100 * M, { last30Days: 20, target: 10 }), onTrackRatio: RATIO }))
        .toBe('needs_attention');
    });

    it('OD-110 a closing target of zero never divides', () => {
      expect(goalPaceStatus({ month: month(null, true, 100 * M, { last30Days: 3, target: 0 }), onTrackRatio: RATIO }))
        .toBe('watch_closely');
    });
  });
});
