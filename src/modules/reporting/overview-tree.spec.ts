import { placeInformalGroups } from '@/domain/metrics/leader-groups';
import type { InformalPartition, PartitionMember } from './office-groups';
import { NO_GROUP, overviewTree, scopeOf } from './overview-tree';

/** A small office: Ana (AB, group G) with Bea (AAB) over Cia, and Dio her own agent; Eka (AB, no group); Fia under no AB. */
function partition(): InformalPartition {
  const people: (Omit<PartitionMember, 'userId' | 'agentCode' | 'isCoreLeader'> & { groupIds: string[] })[] = [
    { membershipId: 'ana', role: 'ab', leaderId: null, ancestorIds: [], groupIds: ['g'] },
    { membershipId: 'bea', role: 'aab', leaderId: 'ana', ancestorIds: ['ana'], groupIds: [] },
    { membershipId: 'cia', role: 'agent', leaderId: 'bea', ancestorIds: ['ana', 'bea'], groupIds: [] },
    { membershipId: 'dio', role: 'agent', leaderId: 'ana', ancestorIds: ['ana'], groupIds: [] },
    { membershipId: 'eka', role: 'ab', leaderId: null, ancestorIds: [], groupIds: [] },
    { membershipId: 'fia', role: 'agent', leaderId: null, ancestorIds: [], groupIds: [] },
  ];
  const placement = placeInformalGroups(people, [{ groupId: 'g', name: 'Grup', leaderMembershipIds: ['ana'] }]);
  return {
    groups: [{ groupId: 'g', name: 'Grup', leaderIds: ['ana'], abIds: ['ana'] }],
    ungroupedAbIds: ['eka'],
    abGroups: new Map([
      ['ana', { abMembershipId: 'ana', memberIds: ['ana', 'bea', 'cia', 'dio'] }],
      ['eka', { abMembershipId: 'eka', memberIds: ['eka'] }],
    ]),
    unplacedIds: ['fia'],
    members: new Map(people.map((p) => [p.membershipId, { ...p, userId: null, agentCode: null, isCoreLeader: false }])),
    placement,
  };
}

const NAMES: Record<string, string> = { ana: 'Ana', bea: 'Bea', cia: 'Cia', dio: 'Dio', eka: 'Eka', fia: 'Fia' };

describe('the KPM Overview’s tree (P19.19-T1 AC-3)', () => {
  const tree = overviewTree(partition(), (id) => NAMES[id]);

  it('P19.19-T1 AC-3 group → AB → AAB with their agents → the AB’s own agents; then Tanpa group, the unplaced last', () => {
    expect(tree.rows.map((r) => [r.membershipId, r.depth, r.groupId])).toEqual([
      ['ana', 0, 'g'], ['bea', 1, 'g'], ['cia', 2, 'g'], ['dio', 1, 'g'],
      ['eka', 0, null], ['fia', 0, null],
    ]);
    expect(tree.groups).toEqual([
      { groupId: 'g', name: 'Grup', memberIds: ['ana', 'bea', 'cia', 'dio'] },
      { groupId: null, name: null, memberIds: ['eka', 'fia'] },
    ]);
  });

  it('P19.19-T1 AC-3 each person names the leaders whose “n di timnya” they count toward, the AB first', () => {
    const of = (id: string) => tree.rows.find((r) => r.membershipId === id)!;
    expect(of('cia').leaderIds).toEqual(['ana', 'bea']);
    expect(of('dio').leaderIds).toEqual(['ana']);
    expect(of('ana').leaderIds).toEqual([]);
    expect(of('fia')).toMatchObject({ abMembershipId: null, leaderIds: [] });
  });

  it('P19.19-T1 AC-2 a scope: the whole KPM, one group, Tanpa group; an unknown group is 404', () => {
    expect(scopeOf(tree, undefined)).toMatchObject({ selected: null, memberIds: ['ana', 'bea', 'cia', 'dio', 'eka', 'fia'] });
    expect(scopeOf(tree, 'g')).toMatchObject({ selected: { groupId: 'g', name: 'Grup' }, memberIds: ['ana', 'bea', 'cia', 'dio'] });
    expect(scopeOf(tree, NO_GROUP)).toMatchObject({ selected: { groupId: null, name: null }, memberIds: ['eka', 'fia'] });
    expect(() => scopeOf(tree, 'nope')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('P19.19-T1 AC-3 every id is drawn once, even one the partition holds no row for: an AB group’s, or an AB’s own', () => {
    // Eka listed with no AB group of her own row; Gus in Ana's AB group with no row read; Dio's line no longer reaching Ana.
    const base = partition();
    const members = new Map(base.members);
    members.set('dio', { ...members.get('dio')!, ancestorIds: ['zed'] });
    const abGroups = new Map(base.abGroups);
    abGroups.set('ana', { abMembershipId: 'ana', memberIds: ['ana', 'bea', 'cia', 'dio', 'gus'] });
    abGroups.delete('eka');
    const drawn = overviewTree({ ...base, members, abGroups }, (id) => NAMES[id] ?? 'Gus');
    expect(drawn.rows.map((r) => [r.membershipId, r.role, r.depth, r.leaderIds])).toEqual([
      ['ana', 'ab', 0, []], ['bea', 'aab', 1, ['ana']], ['cia', 'agent', 2, ['ana', 'bea']],
      // No AAB above either, so each is the AB's own agent; Gus, with no row, is drawn as one.
      ['dio', 'agent', 1, ['ana']], ['gus', 'agent', 1, ['ana']],
      ['eka', 'ab', 0, []], ['fia', 'agent', 0, []],
    ]);
  });

  it('P19.19-T1 AC-2 Tanpa group with nobody in it still filters, and reads empty', () => {
    const empty = overviewTree({ ...partition(), ungroupedAbIds: [], unplacedIds: [] }, (id) => NAMES[id]);
    expect(scopeOf(empty, NO_GROUP)).toEqual({ selected: { groupId: null, name: null }, memberIds: [], rows: [] });
  });
});
