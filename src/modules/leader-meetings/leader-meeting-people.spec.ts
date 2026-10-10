import { RequestContext } from '@/common/context/request-context';
import { LeaderMeetingPeople } from './leader-meeting-people';
import type { FrozenEditor } from './leader-meeting.schema';

const KPM = '66f0000000000000000000a1';
const ctx = (over: { owner?: boolean; admin?: boolean } = {}, membershipId = 'm-reader') => new RequestContext('u', 'none', {
  membershipId, kpmId: KPM, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
  isKpmOwner: over.owner ?? false, isKpmAdmin: over.admin ?? false, directCount: 0,
});

/** The people service over fakes: the memberships, the names, the ladder and the office's row are each a stub. */
function people(fakes: {
  rows?: Record<string, unknown>[];
  reader?: Record<string, unknown> | null;
  names?: Record<string, string>;
  ladder?: { code: string; label: string }[];
  kpm?: Record<string, unknown> | null;
}) {
  const memberships = {
    findById: async () => fakes.reader ?? null,
    find: async () => fakes.rows ?? [],
  };
  const names = { byMembershipId: async () => new Map(Object.entries(fakes.names ?? {})) };
  const orgLevels = { list: async () => fakes.ladder ?? [] };
  const kpms = { findById: () => ({ select: () => ({ lean: () => ({ exec: async () => fakes.kpm ?? null }) }) }) };
  return new LeaderMeetingPeople(memberships as never, names as never, orgLevels as never, kpms as never);
}

describe('who reads the forum, and who edits it (P18.1-T2 AC-1, D-coeditors)', () => {
  it('P18.1-T2 AC-1 nobody outside an office reads it: TENANT_NO_MEMBERSHIP', async () => {
    await expect(people({}).reader(RequestContext.platform('root'))).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
  });

  it('P18.1-T2 AC-1 the Owner and an Admin edit whatever their tag; a field member only tagged; untagged is 404', async () => {
    expect(await people({ reader: null }).editor(ctx({ owner: true }))).toMatchObject({ office: true, tagged: false });
    expect(await people({ reader: { isCoreLeader: false } }).editor(ctx({ admin: true }))).toMatchObject({ office: true });
    expect(await people({ reader: { isCoreLeader: true } }).editor(ctx())).toMatchObject({ office: false, tagged: true });
    await expect(people({ reader: { isCoreLeader: false } }).editor(ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // A reader by a link is read whatever their tag.
    expect(await people({ reader: null }).reader(ctx())).toMatchObject({ office: false, tagged: false });
  });

  it('P18.1-T2 AC-3 an office whose row says nothing reads Jakarta, no branch, no Owner, no company', async () => {
    expect(await people({ kpm: null }).office(ctx())).toEqual({ timezone: 'Asia/Jakarta', branch: '', ownerUserId: null, companyId: null });
  });

  it('P18.1-T2 AC-2 an office with no Owner lists no Owner; the Admins and the tagged follow, each once', async () => {
    const editors = await people({
      rows: [
        { _id: 'm-admin', userId: 'u-a', orgLevelCode: 'AB', isCoreLeader: true, adminAccess: { isKpmAdmin: true } },
        { _id: 'm-tagged', userId: 'u-t', orgLevelCode: 'AGENT', isCoreLeader: true, adminAccess: null },
      ],
    }).liveEditors(ctx(), { timezone: 'Asia/Jakarta', branch: '', ownerUserId: null, companyId: null });
    expect(editors).toEqual([
      { membershipId: 'm-admin', as: 'admin', rungCode: 'AB', tagged: true },
      { membershipId: 'm-tagged', as: 'core_leader', rungCode: 'AGENT', tagged: true },
    ]);
  });

  it('P18.1-T2 AC-2 an office whose owning account holds no active membership in it lists no Owner', async () => {
    const editors = await people({
      rows: [{ _id: 'm-tagged', userId: 'u-t', orgLevelCode: 'AGENT', isCoreLeader: true, adminAccess: null }],
    }).liveEditors(ctx(), { timezone: 'Asia/Jakarta', branch: '', ownerUserId: 'u-left', companyId: null });
    expect(editors).toEqual([{ membershipId: 'm-tagged', as: 'core_leader', rungCode: 'AGENT', tagged: true }]);
  });

  it('P18.1-T2 AC-2 an office with no company reads no ladder: each rung by its code; two of one name ordered by membership', async () => {
    const list: FrozenEditor[] = [
      { membershipId: 'm-b', as: 'admin', rungCode: 'AB', tagged: false },
      { membershipId: 'm-a', as: 'admin', rungCode: 'AB', tagged: false },
    ];
    const listed = jest.fn(async () => [{ code: 'AB', label: 'Agency Builder' }]);
    const service = people({ names: { 'm-a': 'Dewi Lestari', 'm-b': 'Dewi Lestari' } });
    (service as unknown as { orgLevels: { list: typeof listed } }).orgLevels.list = listed;
    const describe = await service.describer(ctx(), { timezone: 'Asia/Jakarta', branch: '', ownerUserId: null, companyId: null }, [list]);
    const { admins } = describe.editors(list, false);
    expect(listed).not.toHaveBeenCalled();
    expect(admins.map((p) => [p.membershipId, p.rung])).toEqual([
      ['m-a', { code: 'AB', label: 'AB' }], ['m-b', { code: 'AB', label: 'AB' }],
    ]);
  });

  it('P18.1-T2 AC-2 an editor whose membership is gone is left out; a rung the ladder does not name reads its code', async () => {
    const list: FrozenEditor[] = [
      { membershipId: 'm-owner', as: 'owner', rungCode: 'AB', tagged: true },
      { membershipId: 'm-gone', as: 'core_leader', rungCode: 'AGENT', tagged: true },
      { membershipId: 'm-reader', as: 'core_leader', rungCode: 'SENIOR', tagged: true },
    ];
    const describe = await people({ names: { 'm-owner': 'Wilson', 'm-reader': 'Rina' }, ladder: [{ code: 'AB', label: 'Agency Builder' }] })
      .describer(ctx(), { timezone: 'Asia/Jakarta', branch: '', ownerUserId: null, companyId: 'c' }, [list]);
    const editors = describe.editors(list, true);
    expect(editors.owner).toEqual({ membershipId: 'm-owner', name: 'Wilson', rung: { code: 'AB', label: 'Agency Builder' }, isReader: false, tagged: true });
    expect(editors.coreLeaders).toEqual([{ membershipId: 'm-reader', name: 'Rina', rung: { code: 'SENIOR', label: 'SENIOR' }, isReader: true, tagged: true }]);
    // The Owner is never counted among the core leaders tagged, tagged or not.
    expect([editors.coreLeaderCount, editors.frozen]).toEqual([1, true]);
    expect(describe.nameOf('m-gone')).toBeNull();
    expect(describe.editors([], false).owner).toBeNull();
  });
});
