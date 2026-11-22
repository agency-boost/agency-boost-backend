import { RequestContext } from '@/common/context/request-context';
import { LeaderMeetingPeople } from './leader-meeting-people';
import type { ForumEditor } from './leader-meeting.schema';

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
  photos?: Record<string, string>;
  ladder?: { code: string; label: string }[];
  kpm?: Record<string, unknown> | null;
  /** What each `find` was asked, for the test-account clause. */
  asked?: unknown[];
}) {
  const memberships = {
    findById: async () => fakes.reader ?? null,
    find: async (_: unknown, filter: unknown) => { fakes.asked?.push(filter); return fakes.rows ?? []; },
  };
  const names = {
    pictured: async () => new Map(Object.entries(fakes.names ?? {}).map(([id, name]) => [
      id, { name, pronoun: 'they', photoUrl: fakes.photos?.[id] ?? null },
    ])),
  };
  const orgLevels = { list: async () => fakes.ladder ?? [] };
  const kpms = { findById: () => ({ select: () => ({ lean: () => ({ exec: async () => fakes.kpm ?? null }) }) }) };
  return new LeaderMeetingPeople(memberships as never, names as never, orgLevels as never, kpms as never);
}

describe('who reads the forum, and who edits it (P19.22-T8 AC-1, AC-2; ADR-0268, ADR-0276)', () => {
  it('P19.22-T8 AC-1 nobody outside an office reads it: TENANT_NO_MEMBERSHIP', async () => {
    await expect(people({}).reader(RequestContext.platform('root'))).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
  });

  it('P19.22-T8 AC-1 the Super Admin inside the KPM is an editor as its Owner, with no membership', async () => {
    const inside = RequestContext.superAdminInKpm(RequestContext.platform('root'), KPM);
    expect(await people({}).editor(inside)).toEqual({ membershipId: null, office: true, tagged: false });
  });

  it('P19.22-T8 AC-1 the Owner and an Admin edit whatever their tag; a field member only tagged on a leader rung, active', async () => {
    expect(await people({ reader: { isCoreLeader: false, role: 'ab', status: 'active' } }).editor(ctx({ owner: true })))
      .toMatchObject({ office: true });
    expect(await people({ reader: null }).editor(ctx({ admin: true }))).toMatchObject({ office: true });
    expect(await people({ reader: { isCoreLeader: true, role: 'aab', status: 'active' } }).editor(ctx()))
      .toMatchObject({ office: false, tagged: true });
    await expect(people({ reader: { isCoreLeader: false, role: 'ab', status: 'active' } }).editor(ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(people({ reader: { isCoreLeader: true, role: 'agent', status: 'active' } }).editor(ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(people({ reader: { isCoreLeader: true, role: 'ab', status: 'removed' } }).editor(ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('P19.22-T8 AC-1 an office whose row says nothing reads Jakarta, no branch, no Owner, no company', async () => {
    expect(await people({ kpm: null }).office(ctx())).toEqual({ timezone: 'Asia/Jakarta', branch: '', ownerUserId: null, companyId: null });
  });

  it('P19.22-T8 AC-2 the editors: the Owner, the Admins, then the core leaders, each once — never a test account', async () => {
    const asked: unknown[] = [];
    const rows = [
      { _id: 'm-admin', userId: 'u-admin', orgLevelCode: 'AB', role: 'ab', isCoreLeader: false, adminAccess: { isKpmAdmin: true } },
      { _id: 'm-owner', userId: 'u-owner', orgLevelCode: 'AB', role: 'ab', isCoreLeader: true },
      { _id: 'm-agus', userId: 'u-agus', orgLevelCode: 'AB', role: 'ab', isCoreLeader: true },
    ];
    const editors = await people({ rows, asked }).liveEditors(ctx(), { timezone: 'Asia/Jakarta', branch: '', ownerUserId: 'u-owner', companyId: null });
    expect(editors.map((e) => [e.membershipId, e.as, e.tagged])).toEqual([
      ['m-owner', 'owner', true], ['m-admin', 'admin', false], ['m-agus', 'core_leader', true],
    ]);
    expect(asked[0]).toMatchObject({ testAccount: { $ne: true }, status: 'active' });
  });

  it('P19.22-T8 AC-2, OD-418 people: the editors pickable with first names and photos, a PIC no longer an editor drawn but not pickable; core leaders by name', async () => {
    const editors: ForumEditor[] = [
      { membershipId: 'm-owner', as: 'owner', rungCode: 'AB', tagged: false },
      { membershipId: 'm-sari', as: 'core_leader', rungCode: 'AAB', tagged: true },
      { membershipId: 'm-agus', as: 'core_leader', rungCode: 'AB', tagged: true },
    ];
    const service = people({
      rows: [{ _id: 'm-old', orgLevelCode: 'AB', role: 'ab', isCoreLeader: false }],
      names: { 'm-owner': 'Wilson Tanoto', 'm-sari': 'Sari Puspita', 'm-agus': 'Agus Salim', 'm-old': 'Hendra Gunawan' },
      photos: { 'm-agus': 'https://photos/agus' },
      ladder: [{ code: 'AB', label: 'Agency Builder' }],
    });
    const { people: drawn, coreLeaders } = await service.people(ctx({}, 'm-sari'), {
      timezone: 'Asia/Jakarta', branch: '', ownerUserId: null, companyId: 'c-1',
    }, editors, ['m-old', 'm-agus']);
    expect(drawn.map((p) => [p.firstName, p.pickable, p.isReader])).toEqual([
      ['Wilson', true, false], ['Sari', true, true], ['Agus', true, false], ['Hendra', false, false],
    ]);
    expect(drawn[2]).toMatchObject({ photoUrl: 'https://photos/agus', rung: { code: 'AB', label: 'Agency Builder' } });
    expect(drawn[1].rung).toEqual({ code: 'AAB', label: 'AAB' });
    expect(coreLeaders.map((p) => p.firstName)).toEqual(['Agus', 'Sari']);
  });

  it('P19.22-T8 AC-1 inside an office with no membership of their own and no Owner’s standing — a platform read, a job’s read — TENANT_NO_MEMBERSHIP', async () => {
    // A platform read is read-only, so it is not the Super Admin inside the KPM (ADR-0207 §4; ADR-0268 §3).
    const platformRead = RequestContext.platformRead(RequestContext.platform('root'), KPM);
    for (const outsider of [platformRead, RequestContext.tenantRead(KPM, 'forum-link')]) {
      await expect(people({}).reader(outsider)).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
      await expect(people({}).editor(outsider)).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
    }
  });

  it('P19.22-T8 AC-2 an Owner with no active membership of the office (a test account, say) is no editor; the Admins and core leaders still are', async () => {
    // The office names its owning account, but no live, counted membership of it came back.
    const rows = [
      { _id: 'm-admin', userId: 'u-admin', orgLevelCode: 'AB', role: 'ab', isCoreLeader: false, adminAccess: { isKpmAdmin: true } },
      { _id: 'm-agus', userId: 'u-agus', orgLevelCode: 'AB', role: 'ab', isCoreLeader: true },
    ];
    const editors = await people({ rows }).liveEditors(ctx(), { timezone: 'Asia/Jakarta', branch: '', ownerUserId: 'u-owner', companyId: null });
    expect(editors.map((e) => [e.membershipId, e.as])).toEqual([['m-admin', 'admin'], ['m-agus', 'core_leader']]);
    // An office with no owning account at all asks for no Owner's membership.
    const asked: { $or: unknown[] }[] = [];
    const ownerless = await people({ rows, asked: asked as unknown[] })
      .liveEditors(ctx(), { timezone: 'Asia/Jakarta', branch: '', ownerUserId: null, companyId: null });
    expect(ownerless.map((e) => e.as)).toEqual(['admin', 'core_leader']);
    expect(JSON.stringify(asked[0].$or)).not.toContain('userId');
  });

  it('P19.22-T8 AC-2 namesakes keep one order: the PICs no longer editors, and the core leaders, by name and then by membership', async () => {
    const editors: ForumEditor[] = [
      { membershipId: 'm-2', as: 'core_leader', rungCode: 'AB', tagged: true },
      { membershipId: 'm-1', as: 'core_leader', rungCode: 'AB', tagged: true },
    ];
    const service = people({
      rows: [
        { _id: 'm-old-b', orgLevelCode: 'AB', role: 'ab', isCoreLeader: false },
        { _id: 'm-old-a', orgLevelCode: 'AB', role: 'ab', isCoreLeader: false },
        { _id: 'm-zul', orgLevelCode: 'AB', role: 'ab', isCoreLeader: false },
      ],
      names: { 'm-1': 'Budi Santoso', 'm-2': 'Budi Santoso', 'm-old-a': 'Hendra Gunawan', 'm-old-b': 'Hendra Gunawan', 'm-zul': 'Ani Wijaya' },
    });
    const { people: drawn, coreLeaders } = await service.people(ctx(), {
      timezone: 'Asia/Jakarta', branch: '', ownerUserId: null, companyId: null,
    }, editors, ['m-old-b', 'm-zul', 'm-old-a']);
    // The editors in their own order, then the others by name, a tie by membership id.
    expect(drawn.map((p) => p.membershipId)).toEqual(['m-2', 'm-1', 'm-zul', 'm-old-a', 'm-old-b']);
    expect(coreLeaders.map((p) => p.membershipId)).toEqual(['m-1', 'm-2']);
  });

  it('P19.22-T8 AC-2 a person whose membership is gone is left out', async () => {
    const { people: drawn } = await people({ names: {} }).people(ctx(), {
      timezone: 'Asia/Jakarta', branch: '', ownerUserId: null, companyId: null,
    }, [{ membershipId: 'm-gone', as: 'admin', rungCode: 'AB', tagged: false }]);
    expect(drawn).toEqual([]);
  });
});
