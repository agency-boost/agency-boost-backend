import { partitionAgencies } from '@/modules/reporting/agency-partition';
import {
  abGroupOf, byGroupName, placeInformalGroups, subgroupOf, type GroupedMember, type LiveGroup,
} from './leader-groups';

const group = (groupId: string, name: string, leaderMembershipIds: string[] = []): LiveGroup => (
  { groupId, name, leaderMembershipIds }
);

/**
 * Build the office from `who → leader` pairs, root first, each with a class and the tags their row carries.
 *
 * ```
 * owner (AB, g1) ─┬─ admin (AB, none)
 *                 ├─ agus (AB, g2) ─┬─ indah (agent, tagged g1 — never read)
 *                 │                 ├─ sari (AAB, tagged g1 — never read) ── rina (agent)
 *                 │                 └─ budi (AB, g1) ── yoga (agent)          an AB under an AB: their own AB group
 *                 ├─ left (AB, removed, g2) ── tono (agent)                   placed by the AB above the leaver
 *                 └─ putu (agent)
 * orphan (agent, no leader)
 * ```
 */
function office(rows: [id: string, role: string, leader: string | null, groupIds?: string[], active?: boolean][]): GroupedMember[] {
  const byId = new Map<string, GroupedMember>();
  for (const [membershipId, role, leader, groupIds = [], active = true] of rows) {
    const ancestorIds = leader === null ? [] : [...byId.get(leader)!.ancestorIds, leader];
    byId.set(membershipId, { membershipId, role, ancestorIds, groupIds, active });
  }
  return [...byId.values()];
}

const ROWS = office([
  ['owner', 'ab', null, ['g1']], ['admin', 'ab', 'owner'], ['agus', 'ab', 'owner', ['g2']],
  ['indah', 'agent', 'agus', ['g1']], ['sari', 'aab', 'agus', ['g1']], ['rina', 'agent', 'sari'],
  ['budi', 'ab', 'agus', ['g1']], ['yoga', 'agent', 'budi'], ['left', 'ab', 'owner', ['g2'], false],
  ['tono', 'agent', 'left'], ['putu', 'agent', 'owner'], ['orphan', 'agent', null],
]);

/** ADR-0270 §1, §2 — an AB's group, the AB group that follows it, and the Group Leaders. */
describe('informal groups (P19.17-T4)', () => {
  describe('placeInformalGroups', () => {
    const groups = [group('g1', 'TOP PRODUCERS', ['owner', 'budi', 'sari', 'gone']), group('g2', 'MENTORING', ['agus']), group('g3', 'EMPTY')];
    const placed = placeInformalGroups(ROWS, groups);

    it('P19.17-T4 AC-1 places each person in the AB group of the nearest active AB, themselves first', () => {
      expect(Object.fromEntries(placed.abOf)).toEqual({
        owner: 'owner', admin: 'admin', agus: 'agus', indah: 'agus', sari: 'agus', rina: 'agus', budi: 'budi', yoga: 'budi',
        // A leaver heads nothing: they and their people are in the AB group above them.
        left: 'owner', tono: 'owner', putu: 'owner', orphan: null,
      });
    });

    it('DATA-DEFINITIONS: an AB group is exactly the agency partitionAgencies computes', () => {
      const { agencies, unplacedIds } = partitionAgencies(ROWS.map((m) => ({
        membershipId: m.membershipId, orgLevelCode: m.role.toUpperCase(), role: m.role as 'ab' | 'aab' | 'agent',
        leaderId: m.ancestorIds.at(-1) ?? null, ancestorIds: m.ancestorIds, active: m.active !== false,
      })));
      for (const agency of agencies) {
        for (const id of agency.memberIds) expect(placed.abOf.get(id)).toBe(agency.headId);
      }
      for (const id of unplacedIds) expect(placed.abOf.get(id)).toBeNull();
    });

    it('P19.17-T4 AC-1 reads a group on an active AB only; AABs and agents follow their AB, whatever their row carries', () => {
      expect(Object.fromEntries(placed.groupOfAb)).toEqual({ owner: 'g1', admin: null, agus: 'g2', budi: 'g1' });
      expect(Object.fromEntries(placed.groupOf)).toEqual({
        owner: 'g1', admin: null, agus: 'g2', indah: 'g2', sari: 'g2', rina: 'g2', budi: 'g1', yoga: 'g1',
        left: 'g1', tono: 'g1', putu: 'g1', orphan: null,
      });
    });

    it('P19.17-T4 AC-1 gives a group its Group Leaders while they hold: active ABs who read in it, any number', () => {
      // `sari` is an AAB, `gone` is nobody given, `agus` reads in g2 — whose leader he is.
      expect(Object.fromEntries(placed.leadersOf)).toEqual({ g1: ['owner', 'budi'], g2: ['agus'], g3: [] });
    });

    it('ADR-0270 §1 reads an AB tagged into several live groups as the first by name, then id; a dead id places nobody', () => {
      const several = office([['x', 'ab', null, ['g9', 'g1', 'g3']], ['y', 'ab', null, ['g3', 'g2']], ['z', 'ab', null, ['archived']]]);
      const { groupOfAb } = placeInformalGroups(several, [group('g9', 'ZETA'), group('g1', 'ALFA'), group('g3', 'MID'), group('g2', 'MID')]);
      expect(Object.fromEntries(groupOfAb)).toEqual({ x: 'g1', y: 'g2', z: null });
    });

    it('a duplicated leader id is listed once; an empty office places nobody', () => {
      const one = placeInformalGroups(office([['a', 'ab', null, ['g1']]]), [group('g1', 'A', ['a', 'a'])]);
      expect(one.leadersOf.get('g1')).toEqual(['a']);
      expect(placeInformalGroups([], [])).toEqual({ abOf: new Map(), groupOfAb: new Map(), groupOf: new Map(), leadersOf: new Map() });
    });

    it('orders groups by name, then by id', () => {
      expect([group('b', 'X'), group('a', 'X'), group('c', 'A')].sort(byGroupName).map((g) => g.groupId)).toEqual(['c', 'a', 'b']);
    });
  });

  describe('abGroupOf', () => {
    it('answers the member themselves, the nearest AB above, or null', () => {
      const abs = new Set(['ab1', 'ab2']);
      expect(abGroupOf({ membershipId: 'ab2', ancestorIds: ['ab1'] }, abs)).toBe('ab2');
      expect(abGroupOf({ membershipId: 'x', ancestorIds: ['ab1', 'ab2', 'aab'] }, abs)).toBe('ab2');
      expect(abGroupOf({ membershipId: 'x', ancestorIds: ['gone'] }, abs)).toBeNull();
    });
  });

  describe('subgroupOf', () => {
    // As `placeInformalGroups` answers for leaders: ab1 in g1, its AAB aab1 following it, ab2 under ab1 in none.
    const groupOf = new Map<string, string | null>([['ab1', 'g1'], ['aab1', 'g1'], ['ab2', null], ['aab2', null]]);

    it('P19.17-T4 AC-1 places everybody by the nearest leader above them, whose group is their AB’s', () => {
      expect(subgroupOf({ membershipId: 'ab1', ancestorIds: [] }, groupOf)).toBe('g1');
      expect(subgroupOf({ membershipId: 'agent', ancestorIds: ['ab1', 'aab1'] }, groupOf)).toBe('g1');
      expect(subgroupOf({ membershipId: 'agent', ancestorIds: ['ab1', 'ab2'] }, groupOf)).toBeNull();
      expect(subgroupOf({ membershipId: 'agent', ancestorIds: ['ab1', 'ab2', 'aab2', 'senior-agent'] }, groupOf)).toBeNull();
    });

    it('puts somebody under no active leader in Tanpa group', () => {
      expect(subgroupOf({ membershipId: 'orphan', ancestorIds: [] }, groupOf)).toBeNull();
      expect(subgroupOf({ membershipId: 'orphan', ancestorIds: ['gone'] }, groupOf)).toBeNull();
    });
  });
});
