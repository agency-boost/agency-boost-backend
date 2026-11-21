import { AB_GROUP_TARGETS, INFORMAL_GROUPS, UNIT_DASHBOARD } from '@/domain/constants';

/** P19.17-T4's constants, pinned (invariant §7; ADR-0270). */
describe('the informal-group and AB-group-target constants', () => {
  it('P19.17-T4 AC-2 pins a group name at 80 characters and one add at the 500-member ceiling', () => {
    expect(INFORMAL_GROUPS.NAME_MAX).toBe(80);
    expect(INFORMAL_GROUPS.MAX_PER_ADD).toBe(500);
    // The same ceiling as the Unit Dashboard's *+ Tambah ke grup*, so the two writers bound alike.
    expect(INFORMAL_GROUPS.MAX_PER_ADD).toBe(UNIT_DASHBOARD.MAX_TAGGED_PER_ADD);
  });

  it('P19.17-T4 AC-3 pins a target at 0 to 999, from January 2024 to a year ahead, and APE ÷ 12', () => {
    expect(AB_GROUP_TARGETS.MAX).toBe(999);
    expect(AB_GROUP_TARGETS.EARLIEST_MONTH).toBe('2024-01');
    expect(AB_GROUP_TARGETS.MONTHS_AHEAD).toBe(12);
    expect(AB_GROUP_TARGETS.MONTHS_PER_YEAR).toBe(12);
  });
});
