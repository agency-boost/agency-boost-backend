import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { NOT_A_TEST_ACCOUNT, withoutTestAccounts } from './counted-members';

const NOW = new Date('2026-11-20T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const id = (n: number) => `66f0000000000000000001${String(n).padStart(2, '0')}`;
const OWNER = id(0);
const AGUS = id(1);
const RINA = id(2);
const FMT = id(3);
const UNDER_FMT = id(4);
const IMPORTED = id(5);
const LEFT_FMT = id(6);
const B_OWNER = id(7);
const B_FMT = id(8);

const asMember = (membershipId: string, kpmId = KPM_A, owner = false) => new RequestContext(`u-${membershipId}`, 'none', {
  membershipId, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active', isKpmOwner: owner, isKpmAdmin: false,
  directCount: 1,
} as never);

/**
 * **A test account is never listed or counted by the shared readings of a KPM's members** (P19.17-T1 AC-1; ADR-0267 §1):
 * `OfficePeople` — the Owner's reports' people — and `CoachResolver`'s lists — the roster, a leader's unit, a list's
 * reach — leave out every membership carrying the flag. Reaching one by id is unchanged, and a real person below a test
 * account is still reached. Office A:
 *
 * ```
 * OWNER ── AGUS ─┬── RINA
 *                ├── FMT (test) ── UNDER_FMT (a real person)
 *                ├── IMPORTED (test)
 *                └── LEFT_FMT (test, removed)
 * ```
 *
 * Office B: `B_OWNER` ── `B_FMT` (test).
 */
describe('test accounts are never listed or counted (P19.17-T1 AC-1)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  const member = (kpmId: string, _id: string, ancestors: string[], extra: Record<string, unknown> = {}) => ({
    _id: new mongoose.Types.ObjectId(_id), kpmId, userId: String(new mongoose.Types.ObjectId()), agentCode: _id.slice(-5), agentSeq: Number(_id.slice(-2)),
    leaderCode: `LC${_id.slice(-4)}`, orgLevelId: 'lvl', orgLevelCode: 'AGENT', role: 'agent',
    leaderId: ancestors[ancestors.length - 1] ?? null, ancestorIds: ancestors, depth: ancestors.length,
    status: 'active', joinedAt: NOW, joinDate: '2026-01-05', removedAt: null, deletedAt: null, ...extra,
  });

  beforeEach(async () => {
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: 'c1', code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: 'c1', code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await mongoose.connection.db!.collection('memberships').insertMany([
      member(KPM_A, OWNER, [], { role: 'ab', orgLevelCode: 'AB' }),
      member(KPM_A, AGUS, [OWNER], { role: 'ab', orgLevelCode: 'AB' }),
      member(KPM_A, RINA, [OWNER, AGUS]),
      member(KPM_A, FMT, [OWNER, AGUS], { testAccount: true, role: 'aab', orgLevelCode: 'AAB' }),
      member(KPM_A, UNDER_FMT, [OWNER, AGUS, FMT]),
      member(KPM_A, IMPORTED, [OWNER, AGUS], { testAccount: true }),
      member(KPM_A, LEFT_FMT, [OWNER, AGUS], { testAccount: true, status: 'removed', removedAt: new Date('2026-11-10T03:00:00Z') }),
      member(KPM_B, B_OWNER, [], { role: 'ab', orgLevelCode: 'AB' }),
      member(KPM_B, B_FMT, [B_OWNER], { testAccount: true }),
    ]);
  });

  it('is one clause on a membership filter, the filter’s own kept', () => {
    expect(NOT_A_TEST_ACCOUNT).toEqual({ testAccount: { $ne: true } });
    expect(withoutTestAccounts({ status: 'active' })).toEqual({ status: 'active', testAccount: { $ne: true } });
  });

  it('OfficePeople: the office’s people, and its leavers, never a test account', async () => {
    const roster = await wired.officePeople.read(asMember(OWNER, KPM_A, true), new Date('2026-11-01T00:00:00Z'), 'Asia/Jakarta');
    expect(roster.everyone.map((p) => p.membershipId).sort()).toEqual([OWNER, AGUS, RINA, UNDER_FMT].sort());
    expect(roster.active).toHaveLength(4);
    expect(await wired.officePeople.everyone(asMember(OWNER, KPM_A, true), null, 'Asia/Jakarta')).toHaveLength(4);
  });

  it('CoachResolver: the roster and a list’s reach leave test accounts out, and still reach a real person below one', async () => {
    const coached = (await wired.coach.coacheesOf(asMember(AGUS), AGUS)).map((c) => c.membershipId);
    expect(coached).toEqual([RINA, UNDER_FMT]);
    // An AB's `goal:read` is `own-downline`: themselves and everybody they coach.
    const reach = await wired.coach.reach(asMember(AGUS, KPM_A), 'goal:read');
    expect([...(reach ?? [])].sort()).toEqual([AGUS, RINA, UNDER_FMT].sort());
  });

  it('CoachResolver: one member by id is unchanged — the flag is about lists, not access', async () => {
    expect(await wired.coach.coaches(asMember(AGUS), AGUS, FMT)).toBe(true);
  });

  it('never reads another office’s people (cross-tenant)', async () => {
    const roster = await wired.officePeople.read(asMember(B_OWNER, KPM_B, true), null, 'Asia/Jakarta');
    expect(roster.everyone.map((p) => p.membershipId)).toEqual([B_OWNER]);
    expect(await wired.coach.coacheesOf(asMember(B_OWNER, KPM_B), B_OWNER)).toEqual([]);
    expect(await wired.coach.coacheesOf(asMember(AGUS, KPM_B), AGUS)).toEqual([]);
  });
});
