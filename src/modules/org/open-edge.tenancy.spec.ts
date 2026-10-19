import mongoose from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, seedLadder, startMongo, stopMongo } from '../../../test/mongo';
import { AdminDelegationService } from './admin-delegation.service';
import { ApprovalsService } from './approvals.service';
import { CoachResolver } from './coach-resolver';
import { HierarchyService } from './hierarchy.service';
import { JoinRequest, JoinRequestSchema } from './join-request.schema';
import { EDGE_EVENTS, MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import { OrgTreeService } from './org-tree.service';
import { JoinRequestRepository, MembershipHistoryRepository } from './org.repositories';
import { REMOVAL_CONFIRMATION, RemovalService } from './removal.service';
import { RoleChangeService } from './role-change.service';

/** A clock that moves, so every change lands on its own instant and a gap or an overlap shows. */
class MovableClock extends Clock {
  constructor(private current: Date) {
    super();
  }
  now(): Date {
    return this.current;
  }
  advance(ms: number): Date {
    this.current = new Date(this.current.getTime() + ms);
    return this.current;
  }
}

const HOUR = 3_600_000;
const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();
const CONFIRMED = { confirmation: REMOVAL_CONFIRMATION };

type Rung = 'AB' | 'AAB' | 'AGENT';

/** Each fixture membership's account, so a signed-in actor is a real user (an admin grant names them). */
const userOf = new Map<string, string>();

/** Somebody signed in as this membership: an active member of office A unless `over` says otherwise. */
const as = (membershipId: string, rung: Rung, over: Record<string, unknown> = {}) =>
  new RequestContext(userOf.get(membershipId) ?? `u-${membershipId}`, 'none', {
    membershipId, kpmId: KPM_A, orgLevelCode: rung, hierarchyRole: rung.toLowerCase(),
    status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
  } as never);

/**
 * **One open edge per membership** (P11-T3; roles §6.1, `domain-invariants.md` §5).
 *
 * The defect: `HierarchyService.closeEdge` closed only rows of the event it was about to write, and
 * the role change and the approval each did the same with theirs. So a member's first re-parent
 * left the `joined` row open beside the new one, a promotion left both open, and an orphan picked
 * up from the pool kept the re-parent that orphaned them. Every edge now opens through
 * `MembershipHistoryRepository.openEdge`, which closes every open edge first.
 *
 * Built through the services that write edges, on a clock that moves. Office A:
 *
 * ```
 * ROOT (AB, the Owner)
 * ├── AB ─┬── AAB ── AGENT
 * │       └── DIRECT (agent)
 * └── AB2
 * ```
 *
 * Office B: `B_AB` ── `B_AGENT`.
 */
describe('one open edge per membership — P11-T3', () => {
  let clock: MovableClock;
  let members: MembershipRepository;
  let history: MembershipHistoryRepository;
  let hierarchy: HierarchyService;
  let roles: RoleChangeService;
  let removals: RemovalService;
  let approvals: ApprovalsService;
  let delegation: AdminDelegationService;
  let trees: OrgTreeService;
  let coach: CoachResolver;
  let companyId: string;
  let seq = 0;

  let m: Record<'ROOT' | 'AB' | 'AB2' | 'AAB' | 'AGENT' | 'DIRECT' | 'B_AB' | 'B_AGENT', string>;

  beforeAll(async () => {
    await startMongo();
    clock = new MovableClock(new Date('2026-10-02T02:00:00Z'));
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    const users = mongoose.model(User.name, UserSchema);
    const notifications = { send: async () => undefined };
    history = new MembershipHistoryRepository(
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
    roles = new RoleChangeService(members, hierarchy, history, users as never, audit, notifications as never, clock);
    removals = new RemovalService(members, hierarchy, roles, history, audit, notifications as never, clock);
    approvals = new ApprovalsService(
      members,
      hierarchy,
      new JoinRequestRepository(mongoose.model(JoinRequest.name, JoinRequestSchema) as never),
      history,
      users as never,
      audit,
      notifications as never,
      clock,
    );
    delegation = new AdminDelegationService(members, history, users as never, audit, notifications as never, clock);
    trees = new OrgTreeService(members, users as never);
    coach = new CoachResolver(members);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    seq += 1;
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `pru-edge-${seq}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    for (const [id, code] of [[KPM_A, '0417'], [KPM_B, '0555']]) {
      await mongoose.model(Kpm.name).create({
        _id: id, companyId, code, branchName: `Branch ${code}`,
        counters: { nextMemberSeq: 1 }, status: 'active',
      });
    }

    const root = await join(KPM_A, 'ab', null);
    const ab = await join(KPM_A, 'ab', root);
    const aab = await join(KPM_A, 'aab', ab);
    const bAb = await join(KPM_B, 'ab', null);
    m = {
      ROOT: root,
      AB: ab,
      AB2: await join(KPM_A, 'ab', root),
      AAB: aab,
      AGENT: await join(KPM_A, 'agent', aab),
      DIRECT: await join(KPM_A, 'agent', ab),
      B_AB: bAb,
      B_AGENT: await join(KPM_B, 'agent', bAb),
    };
  });

  /** A person the insurer issued a code to, placed the way every join places them. */
  async function join(kpmId: string, role: 'ab' | 'aab' | 'agent', leaderId: string | null) {
    seq += 1;
    const user = await mongoose.model(User.name).create({
      email: `edge${seq}@kpm.test`, passwordHash: 'x', fullName: `Person ${seq}`, status: 'active',
      platformRole: 'none', companyId, agentCode: `PRU-${8000 + seq}`,
    });
    const placed = await hierarchy.create(as('mem-placer', 'AB', { kpmId, isKpmOwner: true }), {
      userId: String(user._id), role, leaderId, status: 'active',
    });
    userOf.set(String(placed._id), String(user._id));
    return String(placed._id);
  }

  const ownerOfA = () => as(m.ROOT, 'AB', { isKpmOwner: true });
  const rows = () => mongoose.connection.db!.collection('membershipHistory');

  /** A membership's history in the order it was written. */
  const historyOf = (membershipId: string) =>
    rows().find({ membershipId }).sort({ validFrom: 1, _id: 1 }).toArray();
  /** Every row still open, of either chain. */
  const openRows = (membershipId: string) => rows().find({ membershipId, validTo: null }).toArray();
  /** The open hierarchy edges, the admin chain left out. */
  const openEdges = (membershipId: string) =>
    rows().find({ membershipId, validTo: null, eventType: { $in: [...EDGE_EVENTS] } }).toArray();

  /** Fixture names for ids, so a failure reads as the office rather than as ObjectIds. */
  const nameOf = (id: unknown): string | null =>
    id == null ? null : (Object.entries(m).find(([, v]) => v === id)?.[0] ?? String(id));

  /** Everybody above a member on the open edges, nearest first. */
  function above(name: string, leaderOf: Record<string, string | null>): string[] {
    const chain: string[] = [];
    let at = leaderOf[name];
    while (at && chain.length <= Object.keys(leaderOf).length) {
      chain.push(at);
      at = leaderOf[at];
    }
    return chain;
  }

  /**
   * **One answer from three places**, for the whole of office A: the open edge of every member the
   * org tree draws, the leader the tree draws them under, and `COACH` for every one of them as the
   * actor. The tree and the resolver read the membership cache, the edges are history, and the
   * services under test keep the two in step. Returns who each member reports to, by name.
   */
  async function oneAnswer(): Promise<Record<string, string | null>> {
    const owner = ownerOfA();
    const { nodes } = await trees.read(owner);
    const drawn: Record<string, string | null> = {};
    const open: Record<string, string | null> = {};
    for (const node of nodes) {
      const name = nameOf(node.membershipId)!;
      const edges = await openEdges(node.membershipId);
      expect([name, edges.length]).toEqual([name, 1]);
      drawn[name] = nameOf(node.leaderId);
      open[name] = nameOf(edges[0].toLeaderId);
    }
    expect(open).toEqual(drawn);

    for (const node of nodes) {
      const actor = nameOf(node.membershipId)!;
      const viaEdges = Object.keys(open).filter((name) => above(name, open).includes(actor)).sort();
      const viaResolver = (await coach.coacheesOf(owner, node.membershipId))
        .map((c) => nameOf(c.membershipId)!)
        .sort();
      expect([actor, viaResolver]).toEqual([actor, viaEdges]);
    }
    return open;
  }

  describe('a re-parent', () => {
    it('P11-T3 AC-9: closes the edge the member joined on, and the one open edge names the new leader', async () => {
      const before = await oneAnswer();
      expect(before.AGENT).toBe('AAB');

      const at = clock.advance(HOUR);
      await hierarchy.reparent(ownerOfA(), m.AGENT, m.AB2, 'Moved to another unit');

      const written = await historyOf(m.AGENT);
      expect(written.map((r) => [r.eventType, nameOf(r.toLeaderId), r.validTo])).toEqual([
        ['joined', 'AAB', at],
        ['re_parented', 'AB2', null],
      ]);
      // One instant closes the old edge and opens the new one (roles §6.1): no gap, no overlap.
      expect(written[1].validFrom).toEqual(at);
      // The open edge states all of where they stand, the rung they keep included.
      expect(written[1]).toMatchObject({
        fromLeaderId: m.AAB, toRole: 'agent', toOrgLevelId: written[0].toOrgLevelId,
        reason: 'Moved to another unit',
      });
      expect(await openRows(m.AGENT)).toHaveLength(1);

      const after = await oneAnswer();
      expect(after.AGENT).toBe('AB2');
      expect({ ...after, AGENT: 'AAB' }).toEqual(before);
    });

    it('P11-T3 AC-9: a second re-parent closes the first, so the edges chain end to end with one open', async () => {
      const first = clock.advance(HOUR);
      await hierarchy.reparent(ownerOfA(), m.AGENT, m.AB2);
      const second = clock.advance(HOUR);
      await hierarchy.reparent(ownerOfA(), m.AGENT, m.AB);

      expect(
        (await historyOf(m.AGENT)).map((r) => [r.eventType, nameOf(r.toLeaderId), r.validFrom, r.validTo]),
      ).toEqual([
        ['joined', 'AAB', expect.any(Date), first],
        ['re_parented', 'AB2', first, second],
        ['re_parented', 'AB', second, null],
      ]);
      await oneAnswer();
    });

    it('P11-T3 AC-9: moving a unit writes an edge for the leader who moved, and none for the unit below', async () => {
      await hierarchy.reparent(ownerOfA(), m.AAB, m.AB2);

      expect((await openRows(m.AAB)).map((r) => [r.eventType, nameOf(r.toLeaderId)])).toEqual([
        ['re_parented', 'AB2'],
      ]);
      // The agent still reports to the same AAB: their one edge is the one they joined on.
      expect((await historyOf(m.AGENT)).map((r) => [r.eventType, nameOf(r.toLeaderId), r.validTo])).toEqual([
        ['joined', 'AAB', null],
      ]);
      // And COACH follows the cache: AB2 reaches the agent through AAB, AB no longer does.
      await oneAnswer();
      expect(await coach.coaches(as(m.AB2, 'AB'), m.AB2, m.AGENT)).toBe(true);
      expect(await coach.coaches(as(m.AB, 'AB'), m.AB, m.AGENT)).toBe(false);
    });
  });

  describe('a promotion', () => {
    it('P11-T3 AC-2: as the code models it, a role_changed row, it leaves exactly one open edge, carrying the leader they keep', async () => {
      const promoted = clock.advance(HOUR);
      await roles.change(ownerOfA(), m.DIRECT, 'aab', 'Ready to lead');

      const open = await openRows(m.DIRECT);
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({
        eventType: 'role_changed', fromRole: 'agent', toRole: 'aab', toLeaderId: m.AB,
        validFrom: promoted, reason: 'Ready to lead',
      });

      const demoted = clock.advance(HOUR);
      await roles.change(ownerOfA(), m.DIRECT, 'agent');

      expect((await historyOf(m.DIRECT)).map((r) => [r.eventType, r.toRole, nameOf(r.toLeaderId), r.validTo]))
        .toEqual([
          ['joined', 'agent', 'AB', promoted],
          ['role_changed', 'aab', 'AB', demoted],
          ['role_changed', 'agent', 'AB', null],
        ]);
      // A role change moves nobody, so the tree, COACH and the leader on any date read as before.
      expect((await oneAnswer()).DIRECT).toBe('AB');
      expect(await hierarchy.leaderAsOf(ownerOfA(), m.DIRECT, clock.now())).toBe(m.AB);
    });
  });

  describe('a removal', () => {
    it('P11-T3 AC-9: leaves no edge open but the removal, and none naming the leader who left', async () => {
      await oneAnswer();
      const at = clock.advance(HOUR);
      await removals.remove(ownerOfA(), m.AAB, {
        ...CONFIRMED, reason: 'Left', subtree: { action: 'reassign', toMembershipId: m.AB },
      });

      // The member who left: every edge closed at the removal, and only the removal open.
      expect((await historyOf(m.AAB)).map((r) => [r.eventType, r.validTo])).toEqual([
        ['joined', at],
        ['removed', null],
      ]);
      // Their report moved in the same instant, and the edge naming the leader who left closed.
      expect((await historyOf(m.AGENT)).map((r) => [r.eventType, nameOf(r.toLeaderId), r.validTo])).toEqual([
        ['joined', 'AAB', at],
        ['re_parented', 'AB', null],
      ]);
      expect(await rows().countDocuments({ kpmId: KPM_A, validTo: null, toLeaderId: m.AAB })).toBe(0);

      expect((await oneAnswer()).AGENT).toBe('AB');
      expect(await coach.coaches(as(m.AAB, 'AAB'), m.AAB, m.AGENT)).toBe(false);
    });

    it('P11-T3 AC-9: an orphan picked up from the pool closes the re-parent that orphaned them', async () => {
      const orphaned = clock.advance(HOUR);
      await removals.remove(ownerOfA(), m.AAB, { ...CONFIRMED, subtree: { action: 'orphan' } });
      expect((await openRows(m.AGENT)).map((r) => [r.eventType, r.toLeaderId])).toEqual([['re_parented', null]]);

      const tagged = clock.advance(HOUR);
      await approvals.tag(as(m.AB2, 'AB'), m.AGENT);

      expect((await historyOf(m.AGENT)).map((r) => [r.eventType, nameOf(r.toLeaderId), r.validTo])).toEqual([
        ['joined', 'AAB', orphaned],
        ['re_parented', null, tagged],
        ['re_parented', 'AB2', null],
      ]);
      expect((await openRows(m.AGENT))[0]).toMatchObject({
        fromLeaderId: null, toRole: 'agent', toOrgLevelId: expect.any(String), validFrom: tagged,
      });
      expect((await oneAnswer()).AGENT).toBe('AB2');
    });
  });

  describe('the org tree and COACH', () => {
    it('P11-T3 AC-2: read one answer with the open edges, before and after a re-parent, a promotion and a removal', async () => {
      const start = await oneAnswer();
      expect(start).toEqual({ ROOT: null, AB: 'ROOT', AB2: 'ROOT', AAB: 'AB', AGENT: 'AAB', DIRECT: 'AB' });
      expect(await coach.coaches(as(m.AAB, 'AAB'), m.AAB, m.AGENT)).toBe(true);

      clock.advance(HOUR);
      await hierarchy.reparent(ownerOfA(), m.AGENT, m.AB2);
      expect(await oneAnswer()).toEqual({ ...start, AGENT: 'AB2' });
      expect(await coach.coaches(as(m.AAB, 'AAB'), m.AAB, m.AGENT)).toBe(false);
      expect(await coach.coaches(as(m.AB2, 'AB'), m.AB2, m.AGENT)).toBe(true);

      clock.advance(HOUR);
      await roles.change(ownerOfA(), m.DIRECT, 'aab');
      expect(await oneAnswer()).toEqual({ ...start, AGENT: 'AB2' });

      clock.advance(HOUR);
      await removals.remove(ownerOfA(), m.DIRECT, CONFIRMED);
      const remaining: Record<string, string | null> = { ...start, AGENT: 'AB2' };
      delete remaining.DIRECT;
      expect(await oneAnswer()).toEqual(remaining);
      expect(await coach.coaches(as(m.AB, 'AB'), m.AB, m.DIRECT)).toBe(false);
    });
  });

  describe('the admin chain', () => {
    it('P11-T3 AC-2: an admin grant is not an edge: moving an admin leaves the grant open, and a removal closes both', async () => {
      await delegation.grant(ownerOfA(), m.AB2);
      clock.advance(HOUR);
      await hierarchy.reparent(ownerOfA(), m.AB2, m.AB);

      expect((await openRows(m.AB2)).map((r) => r.eventType).sort()).toEqual(['admin_granted', 're_parented']);
      expect(await openEdges(m.AB2)).toHaveLength(1);
      await oneAnswer();

      const at = clock.advance(HOUR);
      await removals.remove(ownerOfA(), m.AB2, CONFIRMED);
      expect((await openRows(m.AB2)).map((r) => [r.eventType, r.validFrom])).toEqual([['removed', at]]);
    });
  });

  describe('the leader on a date (P3-T2 AC-5)', () => {
    it('P11-T3 AC-9: reads the same through a promotion, a re-parent and a removal', async () => {
      const joined = clock.now();
      const promoted = clock.advance(HOUR);
      await roles.change(ownerOfA(), m.DIRECT, 'aab');
      const moved = clock.advance(HOUR);
      await hierarchy.reparent(ownerOfA(), m.DIRECT, m.AB2);
      const removed = clock.advance(HOUR);
      await removals.remove(ownerOfA(), m.DIRECT, CONFIRMED);

      const leaderOn = async (at: Date) => nameOf(await hierarchy.leaderAsOf(ownerOfA(), m.DIRECT, at));
      expect(await leaderOn(new Date(joined.getTime() - 1))).toBeNull();
      expect(await leaderOn(joined)).toBe('AB');
      // The promotion closed the edge they joined on and moved nobody.
      expect(await leaderOn(promoted)).toBe('AB');
      expect(await leaderOn(new Date(moved.getTime() - 1))).toBe('AB');
      expect(await leaderOn(moved)).toBe('AB2');
      expect(await leaderOn(removed)).toBeNull();
    });

    it('P11-T3 AC-9: reads rows written before the fix, and the next edge closes what they left open', async () => {
      // The shape a database written before P11-T3 holds: a promotion that closed nothing, its
      // row naming no leader, beside the edge the member joined on.
      const promoted = clock.advance(HOUR);
      await mongoose.model(MembershipHistory.name).create({
        kpmId: KPM_A, membershipId: m.DIRECT, eventType: 'role_changed', fromRole: 'agent', toRole: 'aab',
        validFrom: promoted, validTo: null,
      });
      expect(await openEdges(m.DIRECT)).toHaveLength(2);
      expect(await hierarchy.leaderAsOf(ownerOfA(), m.DIRECT, promoted)).toBe(m.AB);

      const moved = clock.advance(HOUR);
      await hierarchy.reparent(ownerOfA(), m.DIRECT, m.AB2);
      expect((await historyOf(m.DIRECT)).map((r) => [r.eventType, r.validTo])).toEqual([
        ['joined', moved],
        ['role_changed', moved],
        ['re_parented', null],
      ]);
    });
  });

  describe('another office (AC-6)', () => {
    it('P11-T3 AC-6: never closes another office’s edge, through the service or the repository', async () => {
      await expect(hierarchy.reparent(ownerOfA(), m.B_AGENT, m.AB)).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // Named outright, from office A: the close is scoped to the caller's office.
      await history.openEdge(ownerOfA(), clock.advance(HOUR), {
        membershipId: m.B_AGENT, eventType: 're_parented', toLeaderId: m.AB,
      });
      const theirs = await rows().find({ kpmId: KPM_B, membershipId: m.B_AGENT }).toArray();
      expect(theirs.map((r) => [r.eventType, nameOf(r.toLeaderId), r.validTo])).toEqual([['joined', 'B_AB', null]]);
    });
  });
});
