import { UNIT_DASHBOARD, UNIT_DASHBOARD_CORRECTION_REASON } from '@/domain/constants';

/** Phase 15's constants, pinned (invariant §7). */
describe('the Unit Dashboard constants', () => {
  it('P15-T3 AC-3 pins the reason a leader’s correction carries, word for word (OD-137, ADR-0121)', () => {
    expect(UNIT_DASHBOARD_CORRECTION_REASON).toBe('Updated on the Unit Dashboard from the company report.');
    // Within the correction route's own bound on a reason, so the two writers store the same kind of row.
    expect(UNIT_DASHBOARD_CORRECTION_REASON.length).toBeLessThanOrEqual(500);
  });

  it('P15-T1 AC-10 pins the three periods in the order drawn, This month first selected (Overall.html:3895-3897)', () => {
    expect(UNIT_DASHBOARD.PERIODS).toEqual(['7d', 'month', 'year']);
    expect(UNIT_DASHBOARD.DEFAULT_PERIOD).toBe('month');
  });

  it('P15-T3 AC-3 pins one save at the 500-member ceiling an office is measured at', () => {
    expect(UNIT_DASHBOARD.MAX_ROWS_PER_SAVE).toBe(500);
  });

  it('P19.12-T6 AC-2 pins the three views in the order the picker draws them, and one add at the same ceiling', () => {
    expect(UNIT_DASHBOARD.VIEWS).toEqual(['direct', 'informal', 'downline']);
    expect(UNIT_DASHBOARD.MAX_TAGGED_PER_ADD).toBe(500);
  });
});
