import { RequestContext } from '@/common/context/request-context';
import { OfficeGroups } from './office-groups';

const ctx = RequestContext.tenantRead('66f0000000000000000000a1', 'office-groups-spec');

/** The two repositories over fakes: the office's live groups, and its active members as stored. */
function officeGroups(fakes: {
  groups?: Record<string, unknown>[];
  members?: Record<string, unknown>[];
  person?: Record<string, unknown> | null;
}) {
  const asked: unknown[] = [];
  const groups = { find: async (_ctx: unknown, filter: unknown) => { asked.push(filter); return fakes.groups ?? []; } };
  const members = {
    find: async () => fakes.members ?? [],
    findById: async () => fakes.person ?? null,
  };
  return { service: new OfficeGroups(groups as never, members as never), asked };
}

/**
 * **The KPM partitioned, over rows as the office stored them** (P19.17-T4; ADR-0270 §1): a membership written before
 * the informal groups — no `groupIds`, no `ancestorIds`, no code, no flag — and a group saved before its Group Leaders
 * are each placed, never dropped, so every total is still the sum of its parts.
 */
describe('OfficeGroups over rows written before the informal groups (P19.17-T4; ADR-0270 §1)', () => {
  it('P19.17-T4 a member with none of the newer fields is placed with their defaults; a group with no leaders stored has none', async () => {
    const { service } = officeGroups({
      groups: [{ _id: 'g-1', name: 'Top Producers' }],
      members: [
        // An AB as an early row holds them: no code, no line above, no tags, no flag, no account.
        { _id: 'm-ab', role: 'ab' },
        { _id: 'm-agent', role: 'agent', userId: 'u-agent', agentCode: '7001', leaderId: 'm-ab', ancestorIds: ['m-ab'], isCoreLeader: true },
      ],
    });
    const partition = await service.partition(ctx);

    expect(partition.members.get('m-ab')).toEqual({
      membershipId: 'm-ab', userId: null, agentCode: null, role: 'ab', leaderId: null, ancestorIds: [], isCoreLeader: false,
    });
    expect(partition.members.get('m-agent')).toMatchObject({ userId: 'u-agent', agentCode: '7001', ancestorIds: ['m-ab'], isCoreLeader: true });
    // The AB carries no tag: *Tanpa group*, with their agent in their AB group.
    expect(partition.ungroupedAbIds).toEqual(['m-ab']);
    expect(partition.abGroups.get('m-ab')).toEqual({ abMembershipId: 'm-ab', memberIds: ['m-ab', 'm-agent'] });
    expect(partition.groups).toEqual([{ groupId: 'g-1', name: 'Top Producers', leaderIds: [], abIds: [] }]);
    expect(partition.unplacedIds).toEqual([]);
  });

  it('P19.17-T4 informalGroupOf: an AB stored with no line above and no tags heads their own AB group, in no group — no group read', async () => {
    const { service, asked } = officeGroups({ person: { _id: 'm-ab', role: 'ab' }, members: [{ _id: 'm-ab' }] });
    expect(await service.informalGroupOf(ctx, 'm-ab')).toEqual({ abMembershipId: 'm-ab', group: null });
    expect(asked).toEqual([]);
  });

  it('P19.17-T4 informalGroupOf: somebody under no active AB is in no AB group and no group', async () => {
    const { service } = officeGroups({ person: { _id: 'm-agent', role: 'agent' }, members: [] });
    expect(await service.informalGroupOf(ctx, 'm-agent')).toEqual({ abMembershipId: null, group: null });
  });

  it('P19.17-T4 peopleOf: an id that heads no AB group adds nobody', async () => {
    const { service } = officeGroups({ members: [{ _id: 'm-ab', role: 'ab', ancestorIds: [], groupIds: [] }] });
    const partition = await service.partition(ctx);
    expect(service.peopleOf(partition, ['m-ab', 'm-nobody'])).toEqual(['m-ab']);
  });
});
