import { byGroupName, placeLeaders, subgroupOf, type LiveGroup } from './leader-groups';

const group = (groupId: string, name: string, ownerMembershipId: string | null = null): LiveGroup => (
  { groupId, name, ownerMembershipId }
);

/** ADR-0253 §1, §2, §5 — a leader's one group, its ★, and the office partitioned by them. */
describe('leader groups (P19.13-T3)', () => {
  describe('placeLeaders', () => {
    it('P19.13-T3 AC-2 gives each leader their one group, or none, and each group its ★ while it holds', () => {
      const groups = [group('g1', 'BIMA', 'bima'), group('g2', 'ARDIAN', 'ardian'), group('g3', 'CAHYO')];
      const { groupOf, headOf } = placeLeaders([
        { membershipId: 'ardian', groupIds: ['g2'] },
        { membershipId: 'aditya', groupIds: ['g2'] },
        { membershipId: 'bima', groupIds: ['g1'] },
        { membershipId: 'lisa', groupIds: [] },
      ], groups);
      expect(Object.fromEntries(groupOf)).toEqual({ ardian: 'g2', aditya: 'g2', bima: 'g1', lisa: null });
      expect(Object.fromEntries(headOf)).toEqual({ g1: 'bima', g2: 'ardian', g3: null });
    });

    it('ADR-0253 §1 reads a leader tagged into several groups as the one they lead, else the first by name then id', () => {
      const groups = [group('g9', 'ZETA', 'both'), group('g1', 'ALFA'), group('g3', 'MIDDLE'), group('g2', 'MIDDLE')];
      const { groupOf } = placeLeaders([
        { membershipId: 'both', groupIds: ['g1', 'g9'] },
        { membershipId: 'plain', groupIds: ['g3', 'g9', 'g1'] },
        { membershipId: 'tie', groupIds: ['g3', 'g2'] },
        // An archived group's id, or another office's, is not a live group here: it places nobody.
        { membershipId: 'stale', groupIds: ['archived'] },
      ], groups);
      expect(Object.fromEntries(groupOf)).toEqual({ both: 'g9', plain: 'g1', tie: 'g2', stale: null });
    });

    it('ADR-0253 §2 gives no ★ to an owner who is no listed leader, who reads in another group, or who is in none', () => {
      const groups = [group('g1', 'A', 'left'), group('g2', 'B', 'mover'), group('g3', 'C', 'mover'), group('g4', 'D', 'loose')];
      const { headOf } = placeLeaders([
        { membershipId: 'mover', groupIds: ['g2', 'g3'] },
        { membershipId: 'loose', groupIds: [] },
      ], groups);
      // `left` is no leader given (left the office, or an Agent now); `mover` reads in B, the first by name; `loose` in none.
      expect(Object.fromEntries(headOf)).toEqual({ g1: null, g2: 'mover', g3: null, g4: null });
    });

    it('places nobody with no groups, and answers empty for an empty office', () => {
      expect(placeLeaders([{ membershipId: 'x', groupIds: ['g1'] }], [])).toEqual({
        groupOf: new Map([['x', null]]), headOf: new Map(),
      });
      expect(placeLeaders([], [])).toEqual({ groupOf: new Map(), headOf: new Map() });
    });

    it('orders groups by name, then by id', () => {
      expect([group('b', 'X'), group('a', 'X'), group('c', 'A')].sort(byGroupName).map((g) => g.groupId))
        .toEqual(['c', 'a', 'b']);
    });
  });

  describe('subgroupOf', () => {
    // AB1 (g1) leads AAB1 (no group) and AAB2 (g2); AB2 (no group) is another root.
    const groupOf = new Map<string, string | null>([['ab1', 'g1'], ['aab1', null], ['aab2', 'g2'], ['ab2', null]]);

    it('P19.13-T3 AC-6 places a leader in their own row: their group, or Tidak ada group with none', () => {
      expect(subgroupOf({ membershipId: 'aab2', ancestorIds: ['ab1'] }, groupOf)).toBe('g2');
      expect(subgroupOf({ membershipId: 'ab1', ancestorIds: [] }, groupOf)).toBe('g1');
      // A leader with no group is in Tidak ada group, though the AB above them has one (the report: leaders without a
      // group form that row).
      expect(subgroupOf({ membershipId: 'aab1', ancestorIds: ['ab1'] }, groupOf)).toBeNull();
      expect(subgroupOf({ membershipId: 'ab2', ancestorIds: [] }, groupOf)).toBeNull();
    });

    it('P19.13-T3 AC-6 places everybody else by the nearest leader above them, whose row it is', () => {
      expect(subgroupOf({ membershipId: 'agent', ancestorIds: ['ab1'] }, groupOf)).toBe('g1');
      expect(subgroupOf({ membershipId: 'agent', ancestorIds: ['ab1', 'aab2'] }, groupOf)).toBe('g2');
      expect(subgroupOf({ membershipId: 'agent', ancestorIds: ['ab1', 'aab1'] }, groupOf)).toBeNull();
      // Under an agent who leads (no leader rung): still the nearest leader's row.
      expect(subgroupOf({ membershipId: 'agent', ancestorIds: ['ab1', 'aab2', 'senior-agent'] }, groupOf)).toBe('g2');
    });

    it('P19.13-T3 AC-6 puts somebody under no active leader in Tidak ada group', () => {
      expect(subgroupOf({ membershipId: 'orphan', ancestorIds: [] }, groupOf)).toBeNull();
      expect(subgroupOf({ membershipId: 'orphan', ancestorIds: ['gone'] }, groupOf)).toBeNull();
    });
  });
});
