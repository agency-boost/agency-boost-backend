import { CORE_LEADERS, UNIT_DASHBOARD } from '@/domain/constants';

/** P19.13-T3's constant, pinned (invariant §7). */
describe('the Core leaders & groups constants', () => {
  it('P19.13-T3 AC-5 pins one bulk change at the 500-member ceiling an office is measured at', () => {
    expect(CORE_LEADERS.MAX_PER_BULK).toBe(500);
    // The same ceiling as the Unit Dashboard's *+ Tambah ke grup*, so the two writers bound alike.
    expect(CORE_LEADERS.MAX_PER_BULK).toBe(UNIT_DASHBOARD.MAX_TAGGED_PER_ADD);
  });
});
