import { RequestContext } from '@/common/context/request-context';
import { FixedClock } from '@/common/clock/clock.port';
import { AdminDelegationService } from './admin-delegation.service';
import { NOT_A_TEST_ACCOUNT } from './counted-members';

const KPM = '66f0000000000000000000a1';
const OWNER = new RequestContext('u-owner', 'none', {
  membershipId: 'm-owner', kpmId: KPM, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: true, isKpmAdmin: false, directCount: 1,
} as never);

const ROWS = [
  { _id: 'm-maya', userId: 'u-maya', agentCode: '80004', role: 'ab', adminAccess: { isKpmAdmin: true, grantedByUserId: 'u-owner', grantedAt: new Date('2026-03-02T02:00:00Z') } },
  { _id: 'm-dewi', userId: 'u-dewi', agentCode: '80007', role: 'aab', adminAccess: { isKpmAdmin: true } },
  { _id: 'm-arif', userId: 'u-arif', agentCode: '80104', role: 'aab', adminAccess: { isKpmAdmin: true } },
];
const USERS = [
  { _id: 'u-owner', fullName: 'Wilson Tanoto', avatarUrl: null },
  { _id: 'u-maya', fullName: 'Maya Halim', avatarUrl: 'avatars/maya.jpg' },
  { _id: 'u-dewi', fullName: 'Dewi Lestari', avatarUrl: null },
  // A key the link service could not sign: drawn with initials, never a key.
  { _id: 'u-arif', fullName: 'Arief Hidayat', avatarUrl: 'avatars/gone.jpg' },
];

function build(avatarLinks: unknown) {
  const filters: unknown[] = [];
  const members = { find: async (_ctx: unknown, filter: unknown) => { filters.push(filter); return ROWS; } };
  const query = (rows: unknown[]) => ({ select: () => query(rows), exec: async () => rows });
  const users = { find: () => query(USERS) };
  const service = new AdminDelegationService(
    members as never, {} as never, users as never, {} as never, {} as never, new FixedClock(new Date()), avatarLinks as never,
  );
  return { service, filters };
}

describe('P19.20-T4 AC-2 KPM admins: each admin’s photo, and no test account', () => {
  it('P19.20-T4 AC-2 signs each photo it can, and leaves the rest to their initials', async () => {
    const links = { linksFor: async (keys: (string | null)[]) => new Map(keys.filter((k) => k === 'avatars/maya.jpg').map((k) => [k as string, 'https://signed/maya'])) };
    const { service } = build(links);

    const admins = await service.list(OWNER);

    expect(admins.map((a) => [a.fullName, a.photoUrl])).toEqual([
      ['Maya Halim', 'https://signed/maya'],
      ['Dewi Lestari', null],
      ['Arief Hidayat', null],
    ]);
  });

  it('P19.20-T4 AC-2 without the link service every admin draws initials', async () => {
    const { service } = build(null);

    expect((await service.list(OWNER)).every((a) => a.photoUrl === null)).toBe(true);
  });

  it('P19.20-T4 AC-2 the list never reads a test account (ADR-0267 §1)', async () => {
    const { service, filters } = build(null);

    await service.list(OWNER);

    expect(filters[0]).toMatchObject(NOT_A_TEST_ACCOUNT);
  });
});
