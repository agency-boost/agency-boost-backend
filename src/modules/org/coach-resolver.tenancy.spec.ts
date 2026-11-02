import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, seedLadder, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { NO_CLASS } from '../../../test/http-permissions';
import { CoachResolver } from './coach-resolver';
import { HierarchyService } from './hierarchy.service';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import { MembershipHistoryRepository } from './org.repositories';
import { REMOVAL_CONFIRMATION, RemovalService } from './removal.service';
import { RoleChangeService } from './role-change.service';

const NOW = new Date('2026-10-02T02:00:00Z');
const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();

type Rung = 'AB' | 'AAB' | 'AGENT';

/** Somebody signed in as this membership: an active member of office A unless `over` says otherwise. */
const as = (
  membershipId: string,
  rung: Rung,
  over: Record<string, unknown> = {},
  impersonator: string | null = null,
) => new RequestContext(`u-${membershipId}`, 'none', {
  membershipId, kpmId: KPM_A, orgLevelCode: rung, hierarchyRole: rung.toLowerCase(),
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 1, ...over,
} as never, impersonator);

/**
 * **`COACH(actor, subject)`, on real hierarchy writes** (P11-T3, ADR-0074).
 *
 * The office is built through `HierarchyService.create`, so every `leaderId`, `ancestorIds` and
 * history row is the one the product writes; edges are closed through `reparent` and `remove`, the
 * two services that close them. Office A:
 *
 * ```
 * ROOT (AB, the Owner as well, as Wilson is in the demo)
 * ├── AB ─┬── DIRECT (agent)
 * │       ├── AAB ─┬── AGENT
 * │       │        └── NESTED (an AAB leading an AAB) ── DEEP (agent)
 * │       └── PEER (a peer AAB) ── PEER_AGENT
 * └── AB2 (a peer AB)
 * ```
 *
 * Office B: `B_AB` ── `B_AGENT`.
 */
describe('COACH(actor, subject) — P11-T3', () => {
  let members: MembershipRepository;
  let hierarchy: HierarchyService;
  let removals: RemovalService;
  let coach: CoachResolver;
  let wired: ReturnType<typeof configModule>;
  let companyId: string;
  let seq = 0;

  /** Every membership the fixture builds, by name. */
  let m: Record<
    'ROOT' | 'AB' | 'AB2' | 'DIRECT' | 'AAB' | 'AGENT' | 'NESTED' | 'DEEP' | 'PEER' | 'PEER_AGENT'
    | 'B_AB' | 'B_AGENT',
    string
  >;

  beforeAll(async () => {
    await startMongo();
    const clock = new FixedClock(NOW);
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    const users = mongoose.model(User.name, UserSchema);
    const history = new MembershipHistoryRepository(
      mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never,
    );
    members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never,
      mongoose.model(Company.name, CompanySchema) as never,
      kpms as never,
      audit,
      clock,
    );
    hierarchy = new HierarchyService(members, kpms as never, users as never, history, clock, orgLevels);
    const notifications = { send: async () => undefined };
    const roles = new RoleChangeService(
      members, hierarchy, history, users as never, audit, notifications as never, clock,
    );
    removals = new RemovalService(members, hierarchy, roles, history, audit, notifications as never, clock);
    coach = new CoachResolver(members);
    // The activity reads, wired as the app wires them, for the subject read AC-9 names.
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `pru-${seq}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    for (const [id, code] of [[KPM_A, '0417'], [KPM_B, '0555']]) {
      await mongoose.model(Kpm.name).create({
        _id: id, companyId, code, branchName: `Branch ${code}`, timezone: 'Asia/Jakarta',
        counters: { nextMemberSeq: 1 }, status: 'active',
      });
    }

    const root = await join(KPM_A, 'ab', null);
    const ab = await join(KPM_A, 'ab', root);
    const aab = await join(KPM_A, 'aab', ab);
    const nested = await join(KPM_A, 'aab', aab);
    const peer = await join(KPM_A, 'aab', ab);
    const bAb = await join(KPM_B, 'ab', null);
    m = {
      ROOT: root,
      AB: ab,
      AB2: await join(KPM_A, 'ab', root),
      DIRECT: await join(KPM_A, 'agent', ab),
      AAB: aab,
      AGENT: await join(KPM_A, 'agent', aab),
      NESTED: nested,
      DEEP: await join(KPM_A, 'agent', nested),
      PEER: peer,
      PEER_AGENT: await join(KPM_A, 'agent', peer),
      B_AB: bAb,
      B_AGENT: await join(KPM_B, 'agent', bAb),
    };
  });

  /** A person the insurer issued a code to, placed in an office the way every join places them. */
  async function join(kpmId: string, role: 'ab' | 'aab' | 'agent', leaderId: string | null) {
    seq += 1;
    const user = await mongoose.model(User.name).create({
      email: `c${seq}@kpm.test`, passwordHash: 'x', fullName: `Person ${seq}`, status: 'active',
      platformRole: 'none', companyId, agentCode: `PRU-${5000 + seq}`,
    });
    const placed = await hierarchy.create(as('mem-placer', 'AB', { kpmId, isKpmOwner: true }), {
      userId: String(user._id), role, leaderId, status: 'active',
    });
    return String(placed._id);
  }

  const ownerOfA = () => as(m.ROOT, 'AB', { isKpmOwner: true });
  /** Who the actor coaches, as a sorted list of fixture names. */
  const named = (ids: string[]) =>
    ids.map((id) => Object.entries(m).find(([, v]) => v === id)?.[0] ?? id).sort();

  describe('AC-2 — one predicate: active, in the office, below the actor on current edges, never self', () => {
    it('P11-T3 AC-2: an AB coaches their whole downline, at any depth', async () => {
      for (const name of ['DIRECT', 'AAB', 'AGENT', 'NESTED', 'DEEP', 'PEER', 'PEER_AGENT'] as const) {
        expect([name, await coach.coaches(as(m.AB, 'AB'), m.AB, m[name])]).toEqual([name, true]);
      }
    });

    it('P11-T3 AC-2: an AAB coaches their subtree, a nested AAB’s agent included (ADR-0074)', async () => {
      for (const name of ['AGENT', 'NESTED', 'DEEP'] as const) {
        expect([name, await coach.coaches(as(m.AAB, 'AAB'), m.AAB, m[name])]).toEqual([name, true]);
      }
    });

    it('P11-T3 AC-2 leader_cannot_coach_self: a leader never coaches themselves', async () => {
      expect(await coach.coachee(as(m.AB, 'AB'), m.AB, m.AB)).toBeNull();
      expect(await coach.coaches(ownerOfA(), m.ROOT, m.ROOT)).toBe(false);
    });

    it('P11-T3 AC-2: never upward, and never sideways', async () => {
      expect(await coach.coaches(as(m.AAB, 'AAB'), m.AAB, m.AB)).toBe(false);
      expect(await coach.coaches(as(m.AGENT, 'AGENT'), m.AGENT, m.AAB)).toBe(false);
      expect(await coach.coaches(as(m.AB2, 'AB'), m.AB2, m.DIRECT)).toBe(false);
    });

    it('P11-T3 AC-2: a member who has left is not coached, although the cache still names their leaders', async () => {
      // Map finding 3: removal sets the status and blanks nothing, so `ancestorIds` still name them.
      await removals.remove(ownerOfA(), m.AGENT, { confirmation: REMOVAL_CONFIRMATION });
      const row = await members.findById(ownerOfA(), m.AGENT);
      expect(row).toMatchObject({ status: 'removed', ancestorIds: [m.ROOT, m.AB, m.AAB] });

      expect(await coach.coaches(as(m.AAB, 'AAB'), m.AAB, m.AGENT)).toBe(false);
      expect(await coach.coaches(as(m.AB, 'AB'), m.AB, m.AGENT)).toBe(false);
    });

    it('P11-T3 AC-2: a pending member is not coached', async () => {
      seq += 1;
      const user = await mongoose.model(User.name).create({
        email: `p${seq}@kpm.test`, passwordHash: 'x', fullName: 'Pending', status: 'active',
        platformRole: 'none', companyId, agentCode: `PRU-${7000 + seq}`,
      });
      const pending = await hierarchy.create(ownerOfA(), { userId: String(user._id), role: 'agent', leaderId: m.AAB });

      expect(pending.status).toBe('pending');
      expect(await coach.coaches(as(m.AAB, 'AAB'), m.AAB, String(pending._id))).toBe(false);
    });

    it('P11-T3 AC-2: every link between them must be active, not only the two ends', async () => {
      // A cache no hierarchy write produces — removal re-parents a leader's reports first — so this
      // is the second lock: a removed leader between the actor and the subject breaks the chain.
      await mongoose.model(Membership.name).updateOne(
        { _id: m.NESTED, kpmId: KPM_A }, { $set: { status: 'removed' } },
      );

      expect(await coach.coaches(as(m.AB, 'AB'), m.AB, m.DEEP)).toBe(false);
      expect(await coach.coaches(as(m.AAB, 'AAB'), m.AAB, m.DEEP)).toBe(false);
      // Still a direct report of nobody they cannot reach: the rest of the unit is unaffected.
      expect(await coach.coaches(as(m.AAB, 'AAB'), m.AAB, m.AGENT)).toBe(true);
      expect(named((await coach.coacheesOf(as(m.AAB, 'AAB'), m.AAB)).map((c) => c.membershipId)))
        .toEqual(['AGENT']);
    });

    it('P11-T3 AC-2: the actor need not be the caller — an Owner asks whether a coach still coaches', async () => {
      const owner = as(m.DIRECT, 'AGENT', { isKpmOwner: true });

      expect(await coach.coaches(owner, m.AAB, m.AGENT)).toBe(true);
      expect(await coach.coaches(owner, m.AAB, m.PEER_AGENT)).toBe(false);
      // An actor who is not an active member of this office coaches nobody.
      expect(await coach.coaches(owner, m.B_AB, m.B_AGENT)).toBe(false);
      expect(await coach.coaches(owner, 'not-a-membership', m.AGENT)).toBe(false);
      await mongoose.model(Membership.name).updateOne({ _id: m.AAB, kpmId: KPM_A }, { $set: { status: 'removed' } });
      expect(await coach.coaches(owner, m.AAB, m.AGENT)).toBe(false);
    });

    it('P11-T3 AC-2: a caller whose own membership is not active coaches nobody', async () => {
      const removed = as(m.AB, 'AB', { status: 'removed' });

      expect(await coach.coaches(removed, m.AB, m.DIRECT)).toBe(false);
      expect(await coach.coacheesOf(removed, m.AB)).toEqual([]);
    });

    it('P11-T3 AC-2: an id that is malformed, or names nobody, is not coached and does not throw', async () => {
      expect(await coach.coaches(as(m.AB, 'AB'), m.AB, 'not-an-id')).toBe(false);
      expect(await coach.coaches(as(m.AB, 'AB'), m.AB, new mongoose.Types.ObjectId().toString())).toBe(false);
    });
  });

  describe('AC-5 — a peer AAB is unreachable', () => {
    it('P11-T3 AC-5 aab_cannot_coach_peer_unit: neither the peer nor the peer’s agent', async () => {
      expect(await coach.coaches(as(m.AAB, 'AAB'), m.AAB, m.PEER)).toBe(false);
      expect(await coach.coaches(as(m.AAB, 'AAB'), m.AAB, m.PEER_AGENT)).toBe(false);
      expect(await coach.coaches(as(m.PEER, 'AAB'), m.PEER, m.AGENT)).toBe(false);
      expect(await coach.coaches(as(m.PEER, 'AAB'), m.PEER, m.DEEP)).toBe(false);
    });

    it('P11-T3 AC-5: a subject read naming the peer’s agent is 404, and the peer is in no list', async () => {
      await expect(coach.subject(as(m.AAB, 'AAB'), m.PEER_AGENT, 'activity_log:read_raw'))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      const reach = await coach.reach(as(m.AAB, 'AAB'), 'lead:read');
      expect(named(reach!)).toEqual(['AAB', 'AGENT', 'DEEP', 'NESTED']);
    });
  });

  describe('AC-6 — cross-tenant: a leader in office A resolving a member of office B is 404', () => {
    it('P11-T3 AC-6: on COACH, on a subject read, and at own-kpm', async () => {
      expect(await coach.coaches(as(m.AB, 'AB'), m.AB, m.B_AGENT)).toBe(false);
      for (const reader of [as(m.AB, 'AB'), ownerOfA(), as(m.AGENT, 'AGENT')]) {
        await expect(coach.subject(reader, m.B_AGENT, 'goal:read'))
          .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      }
      // And from the other side.
      await expect(coach.subject(as(m.B_AB, 'AB', { kpmId: KPM_B }), m.AGENT, 'goal:read'))
        .rejects.toMatchObject({ status: 404 });
    });

    it('P11-T3 AC-6: the office is the tenant’s, not the graph’s — another office’s row naming an A leader stays out', async () => {
      // A row no write produces: office B's member whose cached ancestors name A's AB. The tenant
      // repository scopes by `kpmId`, so the graph cannot carry a read across the boundary.
      const forged = await mongoose.model(Membership.name).create({
        kpmId: KPM_B, userId: new mongoose.Types.ObjectId().toString(), role: 'agent',
        orgLevelCode: 'AGENT', orgLevelId: new mongoose.Types.ObjectId().toString(), status: 'active',
        agentCode: 'X-1', agentSeq: 999, leaderCode: 'FORGED01', leaderId: m.AB, ancestorIds: [m.AB],
      });

      expect(await coach.coaches(as(m.AB, 'AB'), m.AB, String(forged._id))).toBe(false);
      expect(named((await coach.coacheesOf(as(m.AB, 'AB'), m.AB)).map((c) => c.membershipId)))
        .not.toContain(String(forged._id));
    });
  });

  describe('coacheesOf — the roster’s list', () => {
    it('P11-T3 AC-2: lists the whole reach, nearest first, with the depth from the coach', async () => {
      const list = await coach.coacheesOf(as(m.AB, 'AB'), m.AB);

      expect(named(list.map((c) => c.membershipId)))
        .toEqual(['AAB', 'AGENT', 'DEEP', 'DIRECT', 'NESTED', 'PEER', 'PEER_AGENT']);
      const depth = Object.fromEntries(list.map((c) => [named([c.membershipId])[0], c.depth]));
      expect(depth).toEqual({ DIRECT: 1, AAB: 1, PEER: 1, AGENT: 2, NESTED: 2, PEER_AGENT: 2, DEEP: 3 });
      expect(list.map((c) => c.depth)).toEqual([...list.map((c) => c.depth)].sort());
      expect(list.every((c) => String(c.membership._id) === c.membershipId)).toBe(true);
    });

    it('P11-T3 AC-2: agrees with COACH member by member, for every actor', async () => {
      await removals.remove(ownerOfA(), m.PEER_AGENT, { confirmation: REMOVAL_CONFIRMATION });
      const everybody = Object.values(m);
      const actors: [string, Rung, string][] = [
        ['ROOT', 'AB', KPM_A], ['AB', 'AB', KPM_A], ['AAB', 'AAB', KPM_A], ['NESTED', 'AAB', KPM_A],
        ['PEER', 'AAB', KPM_A], ['AGENT', 'AGENT', KPM_A], ['B_AB', 'AB', KPM_B],
      ];
      for (const [name, rung, kpmId] of actors) {
        const ctx = as(m[name as keyof typeof m], rung, { kpmId });
        const listed = new Set((await coach.coacheesOf(ctx, ctx.membershipId!)).map((c) => c.membershipId));
        for (const subject of everybody) {
          const one = await coach.coaches(ctx, ctx.membershipId!, subject);
          expect([name, named([subject])[0], one]).toEqual([name, named([subject])[0], listed.has(subject)]);
        }
      }
    });
  });

  describe('subject — the existing subject reads, by the widest scope on the route’s permission', () => {
    it('P11-T3: absent, or the caller, is the caller’s own read, on their own rung', async () => {
      await expect(coach.subject(as(m.AAB, 'AAB'), undefined, 'goal:read'))
        .resolves.toEqual({ membershipId: m.AAB, orgLevelCode: 'AAB', self: true });
      await expect(coach.subject(as(m.AAB, 'AAB'), m.AAB, 'goal:read'))
        .resolves.toEqual({ membershipId: m.AAB, orgLevelCode: 'AAB', self: true });
    });

    it('P11-T3: a hierarchy token reaches COACH, and answers the subject’s rung', async () => {
      await expect(coach.subject(as(m.AAB, 'AAB'), m.DEEP, 'goal:update'))
        .resolves.toEqual({ membershipId: m.DEEP, orgLevelCode: 'AGENT', self: false });
      await expect(coach.subject(as(m.AB, 'AB'), m.NESTED, 'activity_ratios:read'))
        .resolves.toMatchObject({ membershipId: m.NESTED, orgLevelCode: 'AAB' });
    });

    it('P11-T3 AC-3: `own` reaches only the caller — an Agent naming somebody else is 404, not 403', async () => {
      await expect(coach.subject(as(m.AGENT, 'AGENT'), m.DIRECT, 'activity_log:read_raw'))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'Membership not found.' });
    });

    it('P11-T3 AC-3: no grant at all reaches nobody, rather than falling back to the caller', async () => {
      const unknownRung = as(m.AB, 'AB', { orgLevelCode: 'UNKNOWN_RUNG', hierarchyRole: NO_CLASS });
      await expect(coach.subject(unknownRung, m.DIRECT, 'goal:read', 'Goal'))
        .rejects.toMatchObject({ status: 404, message: 'Goal not found.' });
    });

    it('P11-T3: `own-kpm` reaches the office, a member who has left included (§6.7)', async () => {
      await removals.remove(ownerOfA(), m.PEER_AGENT, { confirmation: REMOVAL_CONFIRMATION });
      const admin = as(m.AGENT, 'AGENT', { isKpmAdmin: true });

      await expect(coach.subject(admin, m.PEER_AGENT, 'goal:read'))
        .resolves.toMatchObject({ membershipId: m.PEER_AGENT, self: false });
      await expect(coach.subject(ownerOfA(), m.AB2, 'activity_log:read_raw'))
        .resolves.toMatchObject({ membershipId: m.AB2, orgLevelCode: 'AB' });
      // …and nobody it cannot resolve: an invented id, like another office's, is 404.
      await expect(coach.subject(admin, new mongoose.Types.ObjectId().toString(), 'goal:read'))
        .rejects.toMatchObject({ status: 404 });
    });

    it('N4: on a write, `own-kpm` reaches only who is still in the office — a member who has left is 404', async () => {
      await removals.remove(ownerOfA(), m.PEER_AGENT, { confirmation: REMOVAL_CONFIRMATION });
      const admin = as(m.AGENT, 'AGENT', { isKpmAdmin: true });

      // `goal:update` is a write: the Owner and the Admin are refused a member who has left, by name of the resource.
      await expect(coach.subject(admin, m.PEER_AGENT, 'goal:update', 'Goal'))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'Goal not found.' });
      await expect(coach.subject(ownerOfA(), m.PEER_AGENT, 'goal:update'))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      // An active member is reached for the write as before, on their own rung.
      await expect(coach.subject(admin, m.AB2, 'goal:update'))
        .resolves.toEqual({ membershipId: m.AB2, orgLevelCode: 'AB', self: false });
      // Nobody it cannot resolve: an invented id, a malformed one and another office's member.
      for (const asked of [new mongoose.Types.ObjectId().toString(), 'not-an-id', m.B_AGENT]) {
        await expect(coach.subject(admin, asked, 'goal:update')).rejects.toMatchObject({ status: 404 });
      }
    });

    it('N4: a read keeps today’s reach — the member who has left is still the office’s history (§6.7)', async () => {
      await removals.remove(ownerOfA(), m.PEER_AGENT, { confirmation: REMOVAL_CONFIRMATION });
      const admin = as(m.AGENT, 'AGENT', { isKpmAdmin: true });

      for (const permission of ['goal:read', 'activity_log:read_raw', 'personal_summary:read'] as const) {
        await expect(coach.subject(admin, m.PEER_AGENT, permission))
          .resolves.toMatchObject({ membershipId: m.PEER_AGENT, self: false });
      }
      // A hierarchy token never reached them, read or write: `COACH` already asks for an active member.
      await expect(coach.subject(as(m.PEER, 'AAB'), m.PEER_AGENT, 'goal:read')).rejects.toMatchObject({ status: 404 });
      await expect(coach.subject(as(m.PEER, 'AAB'), m.PEER_AGENT, 'goal:update')).rejects.toMatchObject({ status: 404 });
    });

    it('P11-T3: a Super Admin who belongs to an office reads it as the office, never beyond it', async () => {
      const superAdminMember = new RequestContext('u-sa', 'super_admin', {
        membershipId: m.AGENT, kpmId: KPM_A, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
        status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      });

      await expect(coach.subject(superAdminMember, m.AB2, 'goal:read')).resolves.toMatchObject({ membershipId: m.AB2 });
      await expect(coach.subject(superAdminMember, m.B_AGENT, 'goal:read')).rejects.toMatchObject({ status: 404 });
      await expect(coach.reach(superAdminMember, 'goal:read')).resolves.toBeNull();
    });

    it('P11-T3: somebody in no office is told so, whatever they name', async () => {
      await expect(coach.subject(RequestContext.platform('root'), m.AGENT, 'goal:read'))
        .rejects.toMatchObject({ status: 403, code: 'TENANT_NO_MEMBERSHIP' });
      await expect(coach.reach(RequestContext.platform('root'), 'lead:read'))
        .rejects.toMatchObject({ status: 403, code: 'TENANT_NO_MEMBERSHIP' });
    });
  });

  describe('unitOf — a leader’s unit, by the scope the grant holds (Phase 15)', () => {
    const ids = (unit: { below: { membershipId: string }[] }) => named(unit.below.map((c) => c.membershipId));

    it('Phase 15: a hierarchy token is COACH, and the caller is in it while they lead somebody', async () => {
      const unit = await coach.unitOf(as(m.AAB, 'AAB'), 'unit_dashboard:update_production');
      expect([unit.office, unit.self, ids(unit)]).toEqual([false, true, ['AGENT', 'DEEP', 'NESTED']]);
      // A leader of nobody heads no unit, and may not name themselves in it.
      const alone = await coach.unitOf(as(m.DIRECT, 'AGENT'), 'unit_dashboard:read');
      expect([alone.office, alone.self, ids(alone)]).toEqual([false, false, []]);
    });

    it('Phase 15: the office’s own grant is the office for a write, and the caller’s downline for their unit', async () => {
      const unit = await coach.unitOf(ownerOfA(), 'unit_dashboard:read');
      expect([unit.office, unit.self]).toEqual([true, true]);
      expect(ids(unit)).toEqual(named((await coach.coacheesOf(ownerOfA(), m.ROOT)).map((c) => c.membershipId)));
    });

    it('Phase 15: `own` alone is the caller and nobody below — never a fallback to COACH; no grant is nobody', async () => {
      // `lead:read` holds `own` alone for an Agent; this one leads nobody, and COACH would answer nobody anyway,
      // so the AB below, holding `own` alone by the same grant shape, is the case that matters.
      expect(await coach.unitOf(as(m.AGENT, 'AGENT'), 'lead:read')).toEqual({ office: false, below: [], self: true });
      const find = jest.spyOn(members, 'find');
      try {
        expect(await coach.unitOf(as(m.AB, 'AGENT'), 'lead:read')).toEqual({ office: false, below: [], self: true });
        expect(find).not.toHaveBeenCalled();
      } finally {
        find.mockRestore();
      }
      expect(await coach.unitOf(as(m.AB, 'AB', { orgLevelCode: 'UNKNOWN_RUNG', hierarchyRole: NO_CLASS }), 'lead:read'))
        .toEqual({ office: false, below: [], self: false });
    });
  });

  describe('reach — whose data a grant reaches, for a list', () => {
    it('P11-T3: the caller and everybody they coach, for a hierarchy token', async () => {
      expect(named((await coach.reach(as(m.AB, 'AB'), 'lead:read'))!))
        .toEqual(['AAB', 'AB', 'AGENT', 'DEEP', 'DIRECT', 'NESTED', 'PEER', 'PEER_AGENT']);
    });

    it('P11-T3: the whole office as null for own-kpm, the caller alone for own, nobody for no grant', async () => {
      expect(await coach.reach(ownerOfA(), 'lead:read_aggregate_counts')).toBeNull();
      expect(await coach.reach(as(m.AGENT, 'AGENT'), 'lead:read')).toEqual([m.AGENT]);
      expect(await coach.reach(as(m.AB, 'AB', { orgLevelCode: 'UNKNOWN_RUNG', hierarchyRole: NO_CLASS }), 'lead:read')).toEqual([]);
    });

    it('P11-T3: reach is coacheesOf with the caller added, for every actor — a member who left and a broken chain included', async () => {
      await removals.remove(ownerOfA(), m.PEER_AGENT, { confirmation: REMOVAL_CONFIRMATION });
      // A removed leader between the actor and the subject, as the every-link test above writes it.
      await mongoose.model(Membership.name).updateOne({ _id: m.NESTED, kpmId: KPM_A }, { $set: { status: 'removed' } });
      const actors: [keyof typeof m, Rung, string][] = [
        ['ROOT', 'AB', KPM_A], ['AB', 'AB', KPM_A], ['AAB', 'AAB', KPM_A], ['PEER', 'AAB', KPM_A], ['B_AB', 'AB', KPM_B],
      ];
      for (const [name, rung, kpmId] of actors) {
        const ctx = as(m[name], rung, { kpmId });
        const listed = (await coach.coacheesOf(ctx, m[name])).map((c) => c.membershipId);
        expect([name, named((await coach.reach(ctx, 'lead:read'))!)]).toEqual([name, named([m[name], ...listed])]);
      }
    });

    it('P11-T3: reach reads each member’s id and ancestry alone, not the whole membership', async () => {
      const find = jest.spyOn(members, 'find');
      try {
        await coach.reach(as(m.AB, 'AB'), 'lead:read');
        expect(find).toHaveBeenCalledTimes(1);
        expect(find).toHaveBeenCalledWith(
          expect.anything(),
          { ancestorIds: m.AB, status: 'active' },
          expect.objectContaining({ projection: { _id: 1, ancestorIds: 1 } }),
        );
        // The roster's list reads the whole membership, which is what it hands back.
        find.mockClear();
        await coach.coacheesOf(as(m.AB, 'AB'), m.AB);
        expect(find.mock.calls[0][2]).not.toHaveProperty('projection');
      } finally {
        find.mockRestore();
      }
    });
  });

  describe('AC-7 — who reads a leader note (ADR-0073)', () => {
    /** AB wrote about AGENT; AAB wrote about AGENT; AB wrote about AAB, a subject who leads. */
    const note = (author: string, subject: string) => ({ authorMembershipId: author, subjectMembershipId: subject });

    it('P11-T3 AC-7: its author, and the author’s ancestors in the office on current edges', async () => {
      expect(await coach.readsLeaderNote(as(m.AB, 'AB'), note(m.AB, m.AGENT))).toBe(true);
      expect(await coach.readsLeaderNote(as(m.ROOT, 'AB'), note(m.AB, m.AGENT))).toBe(true);
      expect(await coach.readsLeaderNote(as(m.AB, 'AB'), note(m.AAB, m.AGENT))).toBe(true);
      expect(await coach.readsLeaderNote(as(m.AAB, 'AAB'), note(m.NESTED, m.DEEP))).toBe(true);
    });

    it('P11-T3 AC-7 coachee_cannot_read_leader_notes: never the subject, one who leads people included', async () => {
      expect(await coach.readsLeaderNote(as(m.AGENT, 'AGENT'), note(m.AB, m.AGENT))).toBe(false);
      expect(await coach.readsLeaderNote(as(m.AGENT, 'AGENT'), note(m.AAB, m.AGENT))).toBe(false);
      // AAB leads AGENT and NESTED, and is still the subject of what AB wrote about them.
      expect(await coach.readsLeaderNote(as(m.AAB, 'AAB'), note(m.AB, m.AAB))).toBe(false);
      // The subject before every other rule: AAB stands above NESTED, the author, so COACH alone
      // would let them read it.
      expect(await coach.coaches(as(m.AAB, 'AAB'), m.AAB, m.NESTED)).toBe(true);
      expect(await coach.readsLeaderNote(as(m.AAB, 'AAB'), note(m.NESTED, m.AAB))).toBe(false);
    });

    it('P11-T3 AC-7 lower_or_peer_leader_cannot_read_leader_notes: nobody beside or below the author', async () => {
      // The subject's own AAB, below the AB who wrote it.
      expect(await coach.readsLeaderNote(as(m.AAB, 'AAB'), note(m.AB, m.AGENT))).toBe(false);
      expect(await coach.readsLeaderNote(as(m.PEER, 'AAB'), note(m.AAB, m.AGENT))).toBe(false);
      expect(await coach.readsLeaderNote(as(m.AB2, 'AB'), note(m.AB, m.AGENT))).toBe(false);
    });

    it('P11-T3 AC-7 office_roles_cannot_read_leader_notes: never the Owner, the Admin or the Super Admin as such', async () => {
      expect(await coach.readsLeaderNote(as(m.DIRECT, 'AGENT', { isKpmOwner: true }), note(m.AB, m.AGENT))).toBe(false);
      expect(await coach.readsLeaderNote(as(m.AB2, 'AB', { isKpmAdmin: true }), note(m.AB, m.AGENT))).toBe(false);
      expect(await coach.readsLeaderNote(RequestContext.platform('root'), note(m.AB, m.AGENT))).toBe(false);
      // The Owner who is the root AB reads as that ancestor: the hierarchy, not the office (§1.1).
      expect(await coach.readsLeaderNote(ownerOfA(), note(m.AB, m.AGENT))).toBe(true);
    });

    it('P11-T3 AC-7 support_session_cannot_read_leader_notes: not even the author’s own, in a session', async () => {
      expect(await coach.readsLeaderNote(as(m.AB, 'AB', {}, 'u-root'), note(m.AB, m.AGENT))).toBe(false);
      expect(await coach.readsLeaderNote(as(m.ROOT, 'AB', {}, 'u-root'), note(m.AB, m.AGENT))).toBe(false);
    });

    it('P11-T3 AC-7: not another office, and not a reader whose membership is no longer active', async () => {
      expect(await coach.readsLeaderNote(as(m.B_AB, 'AB', { kpmId: KPM_B }), note(m.AB, m.AGENT))).toBe(false);
      expect(await coach.readsLeaderNote(as(m.AB, 'AB', { status: 'removed' }), note(m.AB, m.AGENT))).toBe(false);
    });

    it('P11-T3 AC-7: follows the author — a leader who stops being above the author stops reading', async () => {
      await hierarchy.reparent(ownerOfA(), m.AAB, m.AB2);

      expect(await coach.readsLeaderNote(as(m.AB, 'AB'), note(m.AAB, m.AGENT))).toBe(false);
      expect(await coach.readsLeaderNote(as(m.AB2, 'AB'), note(m.AAB, m.AGENT))).toBe(true);
      // The author keeps reading what they wrote.
      expect(await coach.readsLeaderNote(as(m.AAB, 'AAB'), note(m.AAB, m.AGENT))).toBe(true);
    });
  });

  describe('AC-9 — closing a leader edge ends that leader’s COACH from that moment', () => {
    it('P11-T3 AC-9: a re-parent, through the org service — COACH is false and the subject read is 404', async () => {
      const aab = as(m.AAB, 'AAB');
      await expect(wired.activityLogs.readDay(aab, { membershipId: m.AGENT }))
        .resolves.toMatchObject({ membershipId: m.AGENT });

      await hierarchy.reparent(ownerOfA(), m.AGENT, m.AB2, 'Moved to another unit');

      expect(await coach.coaches(aab, m.AAB, m.AGENT)).toBe(false);
      expect(await coach.coaches(as(m.AB, 'AB'), m.AB, m.AGENT)).toBe(false);
      await expect(wired.activityLogs.readDay(aab, { membershipId: m.AGENT }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      await expect(coach.subject(aab, m.AGENT, 'goal:read')).rejects.toMatchObject({ status: 404 });
      // The new leader gains them from the edge, and the root above both keeps them.
      expect(await coach.coaches(as(m.AB2, 'AB'), m.AB2, m.AGENT)).toBe(true);
      expect(await coach.coaches(ownerOfA(), m.ROOT, m.AGENT)).toBe(true);
      // Append-only: the edge they joined on is kept, and the open re-parent names the new leader.
      const edges = await mongoose.connection.db!.collection('membershipHistory')
        .find({ membershipId: m.AGENT }).sort({ validFrom: 1, _id: 1 }).toArray();
      expect(edges.map((e) => [e.eventType, e.toLeaderId])).toEqual([['joined', m.AAB], ['re_parented', m.AB2]]);
    });

    it('P11-T3 AC-9: a removal, through the org service — the open `removed` row grants nothing', async () => {
      const aab = as(m.AAB, 'AAB');

      await removals.remove(ownerOfA(), m.AGENT, { confirmation: REMOVAL_CONFIRMATION, reason: 'Left' });

      expect(await coach.coaches(aab, m.AAB, m.AGENT)).toBe(false);
      await expect(wired.activityLogs.readDay(aab, { membershipId: m.AGENT }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      // Removal leaves a `removed` row whose `validTo` is null too; status, not that row, decides.
      const open = await mongoose.connection.db!.collection('membershipHistory')
        .find({ membershipId: m.AGENT, validTo: null }).toArray();
      expect(open.map((e) => e.eventType)).toEqual(['removed']);
      // The office keeps the history: the Owner still reads them (§6.7).
      await expect(wired.activityLogs.readDay(ownerOfA(), { membershipId: m.AGENT }))
        .resolves.toMatchObject({ membershipId: m.AGENT });
    });
  });
});
