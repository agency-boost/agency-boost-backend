import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { Clock } from '@/common/clock/clock.port';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { DirectoryService } from './directory.service';
import { HierarchyService } from './hierarchy.service';
import { MembershipRepository } from './membership.repository';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { Membership, MembershipSchema } from './membership.schema';
import { JoinRequest, JoinRequestSchema } from './join-request.schema';
import { OnboardingService } from './onboarding.service';
import { InviteService } from './invite.service';
import { ApprovalsService } from './approvals.service';
import { AdminDelegationService } from './admin-delegation.service';
import { Group, GroupSchema } from './group.schema';
import { GroupService } from './group.service';
import { OrgTreeService, ORG_TREE_MAX_NODES } from './org-tree.service';
import { RemovalService } from './removal.service';
import { RoleChangeService } from './role-change.service';
import { InviteCode, InviteCodeSchema } from './invite-code.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';

/** A clock that can be moved, so as-of-date history is testable without sleeping. */
class MovableClock extends Clock {
  constructor(private current: Date) {
    super();
  }
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

// Real ObjectIds: `kpms._id` is one, and the agent-code counter is incremented by a
// query against it. A readable placeholder would fail the cast and never reach the code
// under test.
const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();

function ctx(kpmId: string, over: Partial<{ membershipId: string; isKpmOwner: boolean }> = {}) {
  return new RequestContext('u-actor', 'none', {
    membershipId: over.membershipId ?? 'mem-actor',
    kpmId,
    hierarchyRole: 'ab',
    status: 'active',
    isKpmOwner: over.isKpmOwner ?? true,
    isKpmAdmin: false,
    directCount: 0,
  });
}

describe('organisation', () => {
  let hierarchy: HierarchyService;
  let directory: DirectoryService;
  let members: MembershipRepository;
  let onboarding: OnboardingService;
  let invites: InviteService;
  let approvals: ApprovalsService;
  let roles: RoleChangeService;
  let removals: RemovalService;
  let tree: OrgTreeService;
  let groups: GroupService;
  let delegation: AdminDelegationService;
  let sent: { userId?: string; templateId: string; payload?: Record<string, unknown> }[];
  let clock: MovableClock;
  let users: ReturnType<typeof userModel>;

  function userModel() {
    return mongoose.model(User.name, UserSchema);
  }

  beforeAll(async () => {
    await startMongo();
    const memberModel = mongoose.model(Membership.name, MembershipSchema);
    const historyModel = mongoose.model(MembershipHistory.name, MembershipHistorySchema);
    const kpmModel = mongoose.model(Kpm.name, KpmSchema);
    users = userModel();
    clock = new MovableClock(new Date('2026-03-01T02:00:00Z'));
    members = new MembershipRepository(memberModel as never);
    hierarchy = new HierarchyService(members, kpmModel as never, historyModel as never, clock);
    directory = new DirectoryService(members, users as never);

    sent = [];
    const notifications = {
      send: async (r: { userId?: string; templateId: string; payload?: Record<string, unknown> }) => {
        sent.push(r);
      },
    };
    onboarding = new OnboardingService(
      members,
      hierarchy,
      kpmModel as never,
      mongoose.model(Company.name, CompanySchema) as never,
      users as never,
      mongoose.model(JoinRequest.name, JoinRequestSchema) as never,
      new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never),
      notifications as never,
      clock,
    );

    invites = new InviteService(
      members,
      hierarchy,
      mongoose.model(InviteCode.name, InviteCodeSchema) as never,
      mongoose.model(JoinRequest.name) as never,
      kpmModel as never,
      mongoose.model(Company.name) as never,
      users as never,
      new AuditService(mongoose.model(AuditLog.name) as never),
      notifications as never,
      clock,
    );

    approvals = new ApprovalsService(
      members,
      hierarchy,
      mongoose.model(JoinRequest.name) as never,
      historyModel as never,
      users as never,
      new AuditService(mongoose.model(AuditLog.name) as never),
      notifications as never,
      clock,
    );

    roles = new RoleChangeService(
      members,
      hierarchy,
      historyModel as never,
      users as never,
      new AuditService(mongoose.model(AuditLog.name) as never),
      notifications as never,
      clock,
    );

    removals = new RemovalService(
      members,
      hierarchy,
      roles,
      historyModel as never,
      new AuditService(mongoose.model(AuditLog.name) as never),
      notifications as never,
      clock,
    );

    tree = new OrgTreeService(members, users as never);

    groups = new GroupService(
      mongoose.model(Group.name, GroupSchema) as never,
      members,
      users as never,
      new AuditService(mongoose.model(AuditLog.name) as never),
      clock,
    );

    delegation = new AdminDelegationService(
      members,
      historyModel as never,
      users as never,
      new AuditService(mongoose.model(AuditLog.name) as never),
      notifications as never,
      clock,
    );

    // The partial unique index is the guarantee under test, not a background detail.
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    sent = [];
    const company = await mongoose.model(Company.name).create({
      name: 'Prudential', slug: `prudential-${Math.random()}`,
    });
    for (const [id, code] of [[KPM_A, '0417'], [KPM_B, '0555']]) {
      await mongoose.model(Kpm.name).create({
        _id: id, companyId: String(company._id), code, branchName: `Branch ${code}`,
        counters: { nextAgentCodeSeq: 1 }, status: 'active',
      });
    }
  });

  let seq = 0;
  async function person(fullName = 'Rina Wijaya') {
    seq += 1;
    const u = await users.create({
      email: `p${seq}@kpm.test`, passwordHash: 'x', fullName, status: 'active', platformRole: 'none',
    });
    return String(u._id);
  }

  async function join(kpmId: string, role: 'ab' | 'aab' | 'agent', leaderId: string | null = null) {
    const m = await hierarchy.create(ctx(kpmId), {
      userId: await person(),
      role,
      leaderId,
      status: 'active',
    });
    return String(m._id);
  }

  describe('agent codes (P3-T1 AC-1)', () => {
    it('issues from the office counter, prefixed and padded', async () => {
      const first = await hierarchy.create(ctx(KPM_A), { userId: await person(), role: 'ab', status: 'active' });
      const second = await hierarchy.create(ctx(KPM_A), { userId: await person(), role: 'agent', status: 'active' });
      expect(first.agentCode).toBe('KPM0417-001');
      expect(second.agentCode).toBe('KPM0417-002');
    });

    it('numbers each office independently — two offices may both have a -001', async () => {
      const a = await hierarchy.create(ctx(KPM_A), { userId: await person(), role: 'ab', status: 'active' });
      const b = await hierarchy.create(ctx(KPM_B), { userId: await person(), role: 'ab', status: 'active' });
      expect(a.agentCode).toBe('KPM0417-001');
      expect(b.agentCode).toBe('KPM0555-001');
    });

    it('never hands two concurrent joins the same number', async () => {
      // The counter is incremented inside findOneAndUpdate, so the read and the bump are
      // one operation. A read-then-write would collide here and the unique index would
      // turn the race into a user-visible failure on a code nobody chose.
      const people = await Promise.all([person(), person(), person(), person(), person()]);
      const created = await Promise.all(
        people.map((userId) => hierarchy.create(ctx(KPM_A), { userId, role: 'agent', status: 'active' })),
      );
      const codes = created.map((c) => c.agentCode);
      expect(new Set(codes).size).toBe(5);
    });

    it('is not accepted from a caller — the input has no field for one', async () => {
      const m = await hierarchy.create(ctx(KPM_A), {
        userId: await person(),
        role: 'agent',
        status: 'active',
        // @ts-expect-error the input type has no agentCode, deliberately
        agentCode: 'KPM9999-999',
      });
      expect(m.agentCode).toBe('KPM0417-001');
    });
  });

  describe('one live membership per office (P3-T1 AC-2)', () => {
    it('refuses a second active membership for the same person', async () => {
      const userId = await person();
      await hierarchy.create(ctx(KPM_A), { userId, role: 'agent', status: 'active' });
      await expect(
        hierarchy.create(ctx(KPM_A), { userId, role: 'agent', status: 'active' }),
      ).rejects.toThrow();
    });

    it('allows the same person in a different office', async () => {
      const userId = await person();
      await hierarchy.create(ctx(KPM_A), { userId, role: 'agent', status: 'active' });
      await expect(
        hierarchy.create(ctx(KPM_B), { userId, role: 'agent', status: 'active' }),
      ).resolves.toBeDefined();
    });
  });

  describe('the directory (P3-T1 AC-3)', () => {
    it('never returns another office\'s members', async () => {
      await join(KPM_A, 'ab');
      await join(KPM_B, 'ab');
      const page = await directory.list(ctx(KPM_A));
      expect(page.members).toHaveLength(1);
      expect(page.members[0].agentCode).toBe('KPM0417-001');
    });

    it('pages by cursor, so a mid-scroll join does not skip a row', async () => {
      for (let i = 0; i < 5; i += 1) await join(KPM_A, 'agent');
      const first = await directory.list(ctx(KPM_A), { limit: 2 });
      expect(first.members).toHaveLength(2);
      // The cursor is the numeric sequence, not the code: the code sorts wrong past 999
      // and a cursor on a wrongly-sorted key skips rows without saying so.
      expect(first.nextCursor).toBe('2');

      const second = await directory.list(ctx(KPM_A), { limit: 2, cursor: first.nextCursor! });
      expect(second.members.map((m) => m.agentCode)).toEqual(['KPM0417-003', 'KPM0417-004']);
    });

    it('stops offering a cursor on the last page', async () => {
      await join(KPM_A, 'ab');
      const page = await directory.list(ctx(KPM_A), { limit: 10 });
      expect(page.nextCursor).toBeNull();
    });

    it('excludes removed members unless asked for by name', async () => {
      const id = await join(KPM_A, 'agent');
      await members.updateById(ctx(KPM_A), id, { $set: { status: 'removed' } });

      expect((await directory.list(ctx(KPM_A))).members).toHaveLength(0);
      expect((await directory.list(ctx(KPM_A), { status: 'removed' })).members).toHaveLength(1);
    });

    it('searches by name, email and agent code', async () => {
      const u = await users.create({
        email: 'budi@kpm0417.test', passwordHash: 'x', fullName: 'Budi Santoso',
        status: 'active', platformRole: 'none',
      });
      await hierarchy.create(ctx(KPM_A), { userId: String(u._id), role: 'agent', status: 'active' });
      await join(KPM_A, 'agent');

      expect((await directory.list(ctx(KPM_A), { q: 'budi' })).members).toHaveLength(1);
      expect((await directory.list(ctx(KPM_A), { q: 'BUDI@' })).members).toHaveLength(1);
      expect((await directory.list(ctx(KPM_A), { q: '0417-001' })).members).toHaveLength(1);
    });

    it('treats a search term as text, not as a pattern', async () => {
      await join(KPM_A, 'agent');
      // An unescaped `.*` would match everything and read as a working search.
      expect((await directory.list(ctx(KPM_A), { q: '.*' })).members).toHaveLength(0);
    });

    it('shows a leader their downline and nothing sideways', async () => {
      const ab = await join(KPM_A, 'ab');
      const mine = await join(KPM_A, 'agent', ab);
      const peer = await join(KPM_A, 'aab');
      await join(KPM_A, 'agent', peer);

      const asAb = new RequestContext('u-ab', 'none', {
        membershipId: ab, kpmId: KPM_A, hierarchyRole: 'ab', status: 'active',
        isKpmOwner: false, isKpmAdmin: false, directCount: 1,
      });
      const seen = (await directory.list(asAb)).members.map((m) => m.membershipId);
      expect(seen).toContain(ab);
      expect(seen).toContain(mine);
      expect(seen).not.toContain(peer);
    });

    it('404s a peer rather than 403 — a 403 would confirm they exist', async () => {
      const ab = await join(KPM_A, 'ab');
      const peer = await join(KPM_A, 'aab');
      const asAb = new RequestContext('u-ab', 'none', {
        membershipId: ab, kpmId: KPM_A, hierarchyRole: 'ab', status: 'active',
        isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      });
      await expect(directory.read(asAb, peer)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('lists direct reports through the same visibility as the roster', async () => {
      const ab = await join(KPM_A, 'ab');
      const aab = await join(KPM_A, 'aab', ab);
      await join(KPM_A, 'agent', aab);
      await join(KPM_A, 'agent', aab);

      const reports = await directory.reportsOf(ctx(KPM_A), aab);
      expect(reports).toHaveLength(2);
      expect(reports.every((r) => r.leaderName !== null)).toBe(true);
    });

    it('refuses reports for a peer rather than answering about their unit', async () => {
      const ab = await join(KPM_A, 'ab');
      const peer = await join(KPM_A, 'aab');
      await join(KPM_A, 'agent', peer);

      const asAb = new RequestContext('u-ab', 'none', {
        membershipId: ab, kpmId: KPM_A, hierarchyRole: 'ab', status: 'active',
        isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      });
      await expect(directory.reportsOf(asAb, peer)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('filters by status when one is named, not only by role', async () => {
      const id = await join(KPM_A, 'agent');
      await members.updateById(ctx(KPM_A), id, { $set: { status: 'pending' } });
      expect((await directory.list(ctx(KPM_A), { status: 'pending' })).members).toHaveLength(1);
      expect((await directory.list(ctx(KPM_A), { status: 'active' })).members).toHaveLength(0);
    });

    it('reads a member whose identity row is gone without crashing the roster', async () => {
      // Identity is global and membership is tenant-scoped, so the two can be deleted
      // independently. A page of the roster must still render — one unreadable name is
      // better than a directory nobody can open.
      const id = await join(KPM_A, 'agent');
      const row = await members.findById(ctx(KPM_A), id);
      await users.deleteOne({ _id: row!.userId });

      const one = await directory.read(ctx(KPM_A), id);
      expect(one.fullName).toBe('Unknown');
      // The avatar derives from the name shown, so the two agree rather than the row
      // reading "Unknown" beside a "??" nobody can account for.
      expect(one.initials).toBe('UU');
      expect(one.email).toBe('');
    });

    it('shows nobody to a requester with no membership at all', async () => {
      // A registered person who has not joined an office. Returning the roster to them
      // would be a leak; returning an error would be wrong, because asking is valid.
      const nobody = new RequestContext('u-new', 'none', null, null, KPM_A);
      await join(KPM_A, 'ab');
      expect((await directory.list(nobody)).members).toHaveLength(0);
    });

    it('404s another office\'s member for a tenant admin too', async () => {
      const theirs = await join(KPM_B, 'ab');
      await expect(directory.read(ctx(KPM_A), theirs)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('the hierarchy (P3-T2)', () => {
    it('AC-2: ancestorIds are root-first and exclude self', async () => {
      const ab = await join(KPM_A, 'ab');
      const aab = await join(KPM_A, 'aab', ab);
      const agent = await join(KPM_A, 'agent', aab);

      const row = await members.findById(ctx(KPM_A), agent);
      expect(row?.ancestorIds).toEqual([ab, aab]);
      expect(row?.ancestorIds).not.toContain(agent);
      expect(row?.depth).toBe(2);
    });

    it('AC-1: refuses a re-parent that would make someone their own leader', async () => {
      const ab = await join(KPM_A, 'ab');
      const aab = await join(KPM_A, 'aab', ab);
      await expect(hierarchy.reparent(ctx(KPM_A), ab, aab)).rejects.toMatchObject({
        code: 'ORG_CYCLE_DETECTED',
      });
    });

    it('AC-1: refuses making someone their own direct leader', async () => {
      const ab = await join(KPM_A, 'ab');
      await expect(hierarchy.reparent(ctx(KPM_A), ab, ab)).rejects.toMatchObject({
        code: 'ORG_CYCLE_DETECTED',
      });
    });

    it('refuses a leader from another office', async () => {
      const mine = await join(KPM_A, 'agent');
      const theirs = await join(KPM_B, 'ab');
      await expect(hierarchy.reparent(ctx(KPM_A), mine, theirs)).rejects.toMatchObject({
        code: 'ORG_LEADER_NOT_IN_KPM',
      });
    });

    it('AC-3: a leader change closes the old edge and opens a new one', async () => {
      const first = await join(KPM_A, 'ab');
      const second = await join(KPM_A, 'ab');
      const agent = await join(KPM_A, 'agent', first);

      clock.advance(60_000);
      await hierarchy.reparent(ctx(KPM_A), agent, second, 'unit rebalance');

      const rows = await mongoose
        .model(MembershipHistory.name)
        .find({ membershipId: agent })
        .sort({ validFrom: 1 });

      // Nothing is overwritten: the joined edge is closed, not changed.
      expect(rows.map((r) => r.get('eventType'))).toEqual(['joined', 're_parented']);
      expect(rows[0].get('toLeaderId')).toBe(first);
      expect(rows[1].get('fromLeaderId')).toBe(first);
      expect(rows[1].get('toLeaderId')).toBe(second);
      expect(rows[1].get('validTo')).toBeNull();
      expect(rows[1].get('reason')).toBe('unit rebalance');
    });

    it('moves the whole subtree, re-splicing every descendant', async () => {
      const oldRoot = await join(KPM_A, 'ab');
      const newRoot = await join(KPM_A, 'ab');
      const aab = await join(KPM_A, 'aab', oldRoot);
      const agent = await join(KPM_A, 'agent', aab);

      await hierarchy.reparent(ctx(KPM_A), aab, newRoot);

      expect((await members.findById(ctx(KPM_A), aab))?.ancestorIds).toEqual([newRoot]);
      const deep = await members.findById(ctx(KPM_A), agent);
      expect(deep?.ancestorIds).toEqual([newRoot, aab]);
      expect(deep?.depth).toBe(2);
    });

    it('shifts depth by the difference, not to a fixed value', async () => {
      const root = await join(KPM_A, 'ab');
      const mid = await join(KPM_A, 'aab', root);
      const leaf = await join(KPM_A, 'agent', mid);

      // Promoting mid to the top pulls its leaf up with it.
      await hierarchy.reparent(ctx(KPM_A), mid, null);
      expect((await members.findById(ctx(KPM_A), mid))?.depth).toBe(0);
      expect((await members.findById(ctx(KPM_A), leaf))?.depth).toBe(1);
      expect((await members.findById(ctx(KPM_A), leaf))?.ancestorIds).toEqual([mid]);
    });

    it('AC-4: resolves the whole downline in one indexed query', async () => {
      const root = await join(KPM_A, 'ab');
      const mid = await join(KPM_A, 'aab', root);
      for (let i = 0; i < 3; i += 1) await join(KPM_A, 'agent', mid);

      const all = await hierarchy.descendantsOf(ctx(KPM_A), root);
      expect(all).toHaveLength(4);
    });

    it('AC-5: answers what the hierarchy was on a date, not what it is now', async () => {
      const first = await join(KPM_A, 'ab');
      const second = await join(KPM_A, 'ab');
      const agent = await join(KPM_A, 'agent', first);

      const before = new Date(clock.now());
      clock.advance(86_400_000);
      await hierarchy.reparent(ctx(KPM_A), agent, second);

      expect(await hierarchy.leaderAsOf(ctx(KPM_A), agent, before)).toBe(first);
      expect(await hierarchy.leaderAsOf(ctx(KPM_A), agent, clock.now())).toBe(second);
    });

    it('refuses to create a membership with no office named', async () => {
      const nowhere = new RequestContext('u-new', 'none', null);
      await expect(
        hierarchy.create(nowhere, { userId: await person(), role: 'agent' }),
      ).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
    });

    it('creates a pending membership without counting it as a report', async () => {
      const ab = await join(KPM_A, 'ab');
      await hierarchy.create(ctx(KPM_A), {
        userId: await person(), role: 'agent', leaderId: ab, status: 'pending',
      });
      // Waiting on approval is not being in the unit. Counting it would make someone a
      // leader before anyone had agreed to it.
      expect((await members.findById(ctx(KPM_A), ab))?.directCounts.total).toBe(0);
    });

    it('is a no-op when the leader is already the one asked for', async () => {
      const ab = await join(KPM_A, 'ab');
      const agent = await join(KPM_A, 'agent', ab);
      await hierarchy.reparent(ctx(KPM_A), agent, ab);

      const rows = await mongoose.model(MembershipHistory.name).find({ membershipId: agent });
      expect(rows.map((r) => r.get('eventType'))).toEqual(['joined']);
    });

    it('404s a re-parent of somebody who is not here', async () => {
      const stranger = new mongoose.Types.ObjectId().toString();
      await expect(hierarchy.reparent(ctx(KPM_A), stranger, null)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('answers "no leader" for a date before they existed', async () => {
      const agent = await join(KPM_A, 'agent');
      const before = new Date('2020-01-01T00:00:00Z');
      expect(await hierarchy.leaderAsOf(ctx(KPM_A), agent, before)).toBeNull();
    });

    it('lists direct reports one level down, in roster order', async () => {
      const ab = await join(KPM_A, 'ab');
      const first = await join(KPM_A, 'agent', ab);
      const second = await join(KPM_A, 'agent', ab);
      const grandchild = await join(KPM_A, 'agent', first);

      const reports = await hierarchy.directReportsOf(ctx(KPM_A), ab);
      expect(reports.map((r) => String(r._id))).toEqual([first, second]);
      expect(reports.map((r) => String(r._id))).not.toContain(grandchild);
    });

    it('keeps direct counts derived from live rows, so leadership cannot drift', async () => {
      const ab = await join(KPM_A, 'ab');
      const agent = await join(KPM_A, 'agent', ab);

      expect((await members.findById(ctx(KPM_A), ab))?.directCounts.total).toBe(1);

      // Losing the last report ends leadership. That is correct, not a regression.
      await members.updateById(ctx(KPM_A), agent, { $set: { status: 'removed' } });
      await hierarchy.refreshCounts(ctx(KPM_A), ab);
      expect((await members.findById(ctx(KPM_A), ab))?.directCounts.total).toBe(0);
    });

    it('orders the roster past 999, where the code alone sorts wrong', async () => {
      // KPM0417-1000 sorts before KPM0417-999 as a string. Ordering on the sequence
      // keeps the roster right, and keeps the cursor from skipping the whole 1000s.
      await mongoose.model(Kpm.name).updateOne(
        { _id: KPM_A },
        { $set: { 'counters.nextAgentCodeSeq': 998 } },
      );
      for (let i = 0; i < 3; i += 1) await join(KPM_A, 'agent');

      const page = await directory.list(ctx(KPM_A), { limit: 10 });
      expect(page.members.map((m) => m.agentCode)).toEqual([
        'KPM0417-998',
        'KPM0417-999',
        'KPM0417-1000',
      ]);
    });

    it('counts the subtree, not just direct reports', async () => {
      const root = await join(KPM_A, 'ab');
      const mid = await join(KPM_A, 'aab', root);
      await join(KPM_A, 'agent', mid);
      await hierarchy.refreshCounts(ctx(KPM_A), root);

      const row = await members.findById(ctx(KPM_A), root);
      expect(row?.directCounts).toMatchObject({ aab: 1, total: 1 });
      expect(row?.subtreeCount).toBe(2);
    });
  });

  describe('joining an office (P3-T3)', () => {
    /** Somebody registered and in no office — the state the whole chain starts from. */
    function newcomer(userId: string) {
      return new RequestContext(userId, 'none', null);
    }

    it('AC-2: refuses a leader search before an office is registered', async () => {
      // The prototype hides the card; this refuses the call, because a hidden card is
      // not a gate — anything can ask the API directly.
      await expect(onboarding.leaders(newcomer(await person()))).rejects.toMatchObject({
        code: 'TENANT_NO_MEMBERSHIP',
      });
    });

    it('AC-2: refuses a leader request before an office is registered', async () => {
      await expect(
        onboarding.requestLeader(newcomer(await person()), 'anyone'),
      ).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
    });

    it('names the leader once one is set, and copes when the row is gone', async () => {
      const ab = await join(KPM_A, 'ab');
      const agent = await join(KPM_A, 'agent', ab);
      const row = await members.findById(ctx(KPM_A), agent);
      const asAgent = new RequestContext(row!.userId, 'none', {
        membershipId: agent, kpmId: KPM_A, hierarchyRole: 'agent', status: 'active',
        isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      });

      expect((await onboarding.myState(asAgent)).leaderName).toBeTruthy();

      // Identity is global and can be erased independently. The screen must still load;
      // an unnamed leader is better than a page that will not open.
      const leaderRow = await members.findById(ctx(KPM_A), ab);
      await users.deleteOne({ _id: leaderRow!.userId });
      expect((await onboarding.myState(asAgent)).leaderName).toBeNull();
    });

    it('answers "no office" for a context whose membership row has since gone', async () => {
      // A token outlives the row it was issued against — somebody removed mid-session.
      const stale = new RequestContext('u-gone', 'none', {
        membershipId: new mongoose.Types.ObjectId().toString(),
        kpmId: KPM_A, hierarchyRole: 'agent', status: 'active',
        isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      });
      expect((await onboarding.myState(stale)).kpmId).toBeNull();
    });

    it('answers "no office" for a newcomer rather than failing', async () => {
      // Being in no office is a valid state, not an error — it is where everybody
      // starts.
      const state = await onboarding.myState(newcomer(await person()));
      expect(state).toMatchObject({ kpmId: null, status: 'none', pendingRequestTo: null });
    });

    it('searches the office directory by code or branch name', async () => {
      expect((await onboarding.searchKpms('0417')).map((k) => k.code)).toEqual(['0417']);
      expect((await onboarding.searchKpms('Branch 0555')).map((k) => k.code)).toEqual(['0555']);
      expect((await onboarding.searchKpms()).map((k) => k.code)).toEqual(['0417', '0555']);
      expect(await onboarding.searchKpms('nothing like this')).toEqual([]);
    });

    it('tells an outsider nothing but code, branch, company and city', async () => {
      // The one cross-tenant read a non-Super-Admin has. Member counts, production and
      // the owner's name are all absent by construction, not by a filter someone could
      // forget.
      const [entry] = await onboarding.searchKpms('0417');
      expect(Object.keys(entry).sort()).toEqual([
        'branchName', 'city', 'code', 'companyId'.replace('companyId', 'companyName'), 'kpmId',
      ].sort());
    });

    it('hides an office that is not active, without saying which it was', async () => {
      await mongoose.model(Kpm.name).updateOne({ _id: KPM_B }, { $set: { status: 'suspended' } });
      expect((await onboarding.searchKpms()).map((k) => k.code)).toEqual(['0417']);
      await expect(
        onboarding.registerKpm(newcomer(await person()), KPM_B),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('AC-1: registering creates a pending membership with no leader', async () => {
      const userId = await person();
      const state = await onboarding.registerKpm(newcomer(userId), KPM_A);

      expect(state.status).toBe('pending');
      expect(state.leaderMembershipId).toBeNull();
      expect(state.kpmLabel).toBe('Prudential — KPM 0417 · Branch 0417');

      const row = await mongoose.model(Membership.name).findOne({ kpmId: KPM_A, userId });
      expect(row?.get('status')).toBe('pending');
      // A code is issued even though nobody has approved them, so every membership row
      // has one. A declined request leaves a gap in the numbering, which is fine.
      expect(row?.get('agentCode')).toBe('KPM0417-001');
    });

    it('refuses a second registration rather than moving somebody silently', async () => {
      const userId = await person();
      await onboarding.registerKpm(newcomer(userId), KPM_A);
      const joined = await mongoose.model(Membership.name).findOne({ userId });
      const ctxAfter = new RequestContext(userId, 'none', {
        membershipId: String(joined!._id), kpmId: KPM_A, hierarchyRole: 'agent',
        status: 'pending', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      });
      await expect(onboarding.registerKpm(ctxAfter, KPM_B)).rejects.toMatchObject({
        code: 'ORG_AGENT_ALREADY_TAGGED',
      });
    });

    describe('once registered', () => {
      let joinerCtx: RequestContext;
      let ab: string;
      let childlessAab: string;

      beforeEach(async () => {
        ab = await join(KPM_A, 'ab');
        childlessAab = await join(KPM_A, 'aab', ab);
        await join(KPM_A, 'agent', ab);

        const userId = await person('Joining Person');
        await onboarding.registerKpm(newcomer(userId), KPM_A);
        const row = await mongoose.model(Membership.name).findOne({ kpmId: KPM_A, userId });
        joinerCtx = new RequestContext(userId, 'none', {
          membershipId: String(row!._id), kpmId: KPM_A, hierarchyRole: 'agent',
          status: 'pending', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
        });
      });

      it('offers every AB and AAB, including one who leads nobody yet', async () => {
        // By role, not by the graph. A new AAB has to be askable or they could never
        // get a first report — OD-23 governs who *is* a leader, not who may become one.
        const choices = await onboarding.leaders(joinerCtx);
        expect(choices.map((c) => c.membershipId).sort()).toEqual([ab, childlessAab].sort());
        expect(choices.find((c) => c.membershipId === childlessAab)?.unitSize).toBe(0);
      });

      it('searches leaders by name only, as the prototype does', async () => {
        expect(await onboarding.leaders(joinerCtx, 'nobody named this')).toEqual([]);
        expect((await onboarding.leaders(joinerCtx, 'rina')).length).toBeGreaterThanOrEqual(0);
      });

      it('never offers the asker themselves', async () => {
        const choices = await onboarding.leaders(joinerCtx);
        expect(choices.map((c) => c.membershipId)).not.toContain(joinerCtx.membershipId);
      });

      it('AC-3: sending a request notifies the leader', async () => {
        await onboarding.requestLeader(joinerCtx, ab);
        const leaderRow = await mongoose.model(Membership.name).findById(ab);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
          userId: leaderRow!.get('userId'),
          templateId: 'join_request.received',
        });
      });

      it('marks the row it was sent to, so the screen can say so', async () => {
        await onboarding.requestLeader(joinerCtx, ab);
        const choices = await onboarding.leaders(joinerCtx);
        expect(choices.find((c) => c.membershipId === ab)?.requestSent).toBe(true);
        expect(choices.find((c) => c.membershipId === childlessAab)?.requestSent).toBe(false);
      });

      it('replaces an outstanding ask rather than stacking a second', async () => {
        // Two open rows would let two approvers both say yes, and the membership would
        // end up in a state neither decision describes.
        await onboarding.requestLeader(joinerCtx, ab);
        await onboarding.requestLeader(joinerCtx, childlessAab);

        const open = await mongoose
          .model(JoinRequest.name)
          .find({ membershipId: joinerCtx.membershipId, status: 'pending' });
        expect(open).toHaveLength(1);
        expect(open[0].get('leaderMembershipId')).toBe(childlessAab);
      });

      it('refuses a leader from another office', async () => {
        const theirs = await join(KPM_B, 'ab');
        await expect(onboarding.requestLeader(joinerCtx, theirs)).rejects.toMatchObject({
          code: 'ORG_LEADER_NOT_IN_KPM',
        });
      });

      it('refuses an agent as a leader — they cannot take anyone on', async () => {
        const plainAgent = await join(KPM_A, 'agent', ab);
        await expect(onboarding.requestLeader(joinerCtx, plainAgent)).rejects.toMatchObject({
          code: 'ORG_LEADER_NOT_IN_KPM',
        });
      });

      it('refuses asking to report to yourself', async () => {
        await expect(
          onboarding.requestLeader(joinerCtx, joinerCtx.membershipId!),
        ).rejects.toMatchObject({ code: 'ORG_CYCLE_DETECTED' });
      });

      it('withdraws an outstanding ask', async () => {
        await onboarding.requestLeader(joinerCtx, ab);
        const after = await onboarding.cancelRequest(joinerCtx);
        expect(after.pendingRequestTo).toBeNull();
      });

      it('refuses a withdrawal from somebody in no office', async () => {
        await expect(onboarding.cancelRequest(newcomer(await person()))).rejects.toMatchObject({
          code: 'TENANT_NO_MEMBERSHIP',
        });
      });

      it('404s a withdrawal when there is nothing to withdraw', async () => {
        await expect(onboarding.cancelRequest(joinerCtx)).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
      });
    });
  });

  describe('invites (P3-T4)', () => {
    function newcomer(userId: string) {
      return new RequestContext(userId, 'none', null);
    }

    let leader: string;
    let leaderCtx: RequestContext;

    beforeEach(async () => {
      leader = await join(KPM_A, 'ab');
      const row = await members.findById(ctx(KPM_A), leader);
      leaderCtx = new RequestContext(row!.userId, 'none', {
        membershipId: leader, kpmId: KPM_A, hierarchyRole: 'ab', status: 'active',
        isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      });
    });

    it('AC-1: issues one artefact, presented as a code and a link', async () => {
      // The prototype shows three tiles as if they were three things; its own copy says
      // any of the three does the same job. One record, three renderings.
      const issued = await invites.issue(leaderCtx, {}, 'https://agencyboost.app');
      expect(issued.code).toMatch(/^[A-Z2-9]{6}$/);
      expect(issued.url).toBe(`https://agencyboost.app/join?code=${issued.code}`);
      expect(issued.state).toBe('active');
      expect(issued.autoApprove).toBe(true);
    });

    it('leaves out the characters people misread aloud', async () => {
      // A code gets read down a phone line. 0/O and 1/I are where that goes wrong.
      for (let i = 0; i < 15; i += 1) {
        const { code } = await invites.issue(leaderCtx, {}, '');
        expect(code).not.toMatch(/[01OI]/);
      }
    });

    it('AC-1: redeeming tags the joiner to the issuer, active, with no approval', async () => {
      const { code } = await invites.issue(leaderCtx, {}, '');
      const joinerId = await person('Invited Person');

      const result = await invites.redeem(newcomer(joinerId), code);
      expect(result.kpmId).toBe(KPM_A);

      const row = await mongoose.model(Membership.name).findOne({ kpmId: KPM_A, userId: joinerId });
      expect(row?.get('status')).toBe('active');
      expect(row?.get('leaderId')).toBe(leader);
      expect(row?.get('role')).toBe('agent');
      expect(row?.get('recruitedByMembershipId')).toBe(leader);
    });

    it('AC-3: writes a joined history row and creates no join request', async () => {
      // A request would sit in the leader's inbox asking them to approve something that
      // already happened.
      const { code } = await invites.issue(leaderCtx, {}, '');
      const joinerId = await person();
      await invites.redeem(newcomer(joinerId), code);

      const row = await mongoose.model(Membership.name).findOne({ kpmId: KPM_A, userId: joinerId });
      const events = await mongoose
        .model(MembershipHistory.name)
        .find({ membershipId: String(row!._id) });
      expect(events.map((e) => e.get('eventType'))).toEqual(['joined']);
      expect(events[0].get('toLeaderId')).toBe(leader);

      expect(await mongoose.model(JoinRequest.name).countDocuments({})).toBe(0);
    });

    it('forces the agent role, whatever the invite is used for', async () => {
      // An invite is a way into somebody's unit, not a way to pick your own rank on the
      // way in.
      const { code } = await invites.issue(leaderCtx, {}, '');
      const joinerId = await person();
      await invites.redeem(newcomer(joinerId), code);
      const row = await mongoose.model(Membership.name).findOne({ userId: joinerId });
      expect(row?.get('role')).toBe('agent');
    });

    it('cancels an outstanding request, because they got in by another door', async () => {
      const joinerId = await person();
      await onboarding.registerKpm(newcomer(joinerId), KPM_A);
      const registered = await mongoose.model(Membership.name).findOne({ userId: joinerId });
      const asJoiner = new RequestContext(joinerId, 'none', {
        membershipId: String(registered!._id), kpmId: KPM_A, hierarchyRole: 'agent',
        status: 'pending', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      });
      await onboarding.requestLeader(asJoiner, leader);

      // They are pending, so redeeming refuses — they already have an office.
      const { code } = await invites.issue(leaderCtx, {}, '');
      await expect(invites.redeem(asJoiner, code)).rejects.toMatchObject({
        code: 'ORG_AGENT_ALREADY_TAGGED',
      });
    });

    it('notifies the leader that somebody walked in', async () => {
      const { code } = await invites.issue(leaderCtx, {}, '');
      sent.length = 0;
      await invites.redeem(newcomer(await person()), code);

      const leaderRow = await mongoose.model(Membership.name).findById(leader);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        userId: leaderRow!.get('userId'),
        templateId: 'member.tagged_by_leader',
      });
    });

    describe('codes are unique across the platform, not just the office', () => {
      // A code is the credential somebody presents *before* they belong anywhere:
      // `resolve()` looks it up by code alone, because a joiner has no office to scope
      // the lookup to. The unique index was `{kpmId, code}` until 2026-09-06, so two
      // live `JOR417`s could exist and `findOne` would return whichever the plan reached
      // first — landing the joiner in a stranger's office under a stranger's leader.
      it('refuses a second live invite carrying a code another office already holds', async () => {
        const { code } = await invites.issue(leaderCtx, {}, '');

        const otherLeader = await join(KPM_B, 'ab');
        await expect(
          mongoose.model(InviteCode.name).create({
            kpmId: KPM_B,
            code,
            issuedByMembershipId: otherLeader,
            autoApprove: true,
            maxUses: null,
            createdBy: otherLeader,
          }),
        ).rejects.toMatchObject({ code: 11000 });
      });

      it('releases a code once its invite is soft-deleted', async () => {
        const { code } = await invites.issue(leaderCtx, {}, '');
        const model = mongoose.model(InviteCode.name);
        await model.updateOne({ code }, { $set: { deletedAt: new Date() } });

        const otherLeader = await join(KPM_B, 'ab');
        await expect(
          model.create({
            kpmId: KPM_B,
            code,
            issuedByMembershipId: otherLeader,
            autoApprove: true,
            maxUses: null,
            createdBy: otherLeader,
          }),
        ).resolves.toBeDefined();
      });
    });

    describe('AC-2: refusing an invite that should not work', () => {
      it('refuses a code nobody issued', async () => {
        await expect(invites.redeem(newcomer(await person()), 'NOPE99')).rejects.toMatchObject({
          code: 'ORG_INVITE_EXPIRED',
        });
      });

      it('refuses a revoked one, and says nothing different from an unknown one', async () => {
        // Six characters, and the reward for guessing is joining somebody's unit. Telling
        // a prober which of the two they hit hands them a working oracle.
        const issued = await invites.issue(leaderCtx, {}, '');
        await invites.revoke(leaderCtx, issued.inviteId);

        const revoked = await invites
          .redeem(newcomer(await person()), issued.code)
          .catch((e) => e);
        const unknown = await invites.redeem(newcomer(await person()), 'ZZZZZZ').catch((e) => e);
        expect(revoked.code).toBe(unknown.code);
        expect(revoked.message).toBe(unknown.message);
      });

      it('refuses an expired one', async () => {
        const { code } = await invites.issue(leaderCtx, { expiresInDays: 1 }, '');
        clock.advance(2 * 86_400_000);
        await expect(invites.redeem(newcomer(await person()), code)).rejects.toMatchObject({
          code: 'ORG_INVITE_EXPIRED',
        });
      });

      it('refuses an exhausted one, and says so — a ceiling is not a mistake', async () => {
        // The one refusal that names itself: hitting a use limit is not a guess, and the
        // person redeeming it was given a real code by a real leader.
        const { code } = await invites.issue(leaderCtx, { maxUses: 1 }, '');
        await invites.redeem(newcomer(await person()), code);

        await expect(invites.redeem(newcomer(await person()), code)).rejects.toMatchObject({
          code: 'ORG_INVITE_EXHAUSTED',
        });
      });

      it('does not spend a use on a redemption that failed', async () => {
        const { code, inviteId } = await invites.issue(leaderCtx, { maxUses: 2 }, '');
        const joinerId = await person();
        await invites.redeem(newcomer(joinerId), code);
        // The same person again: already tagged, so it refuses before counting.
        const row = await mongoose.model(Membership.name).findOne({ userId: joinerId });
        const asMember = new RequestContext(joinerId, 'none', {
          membershipId: String(row!._id), kpmId: KPM_A, hierarchyRole: 'agent',
          status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
        });
        await expect(invites.redeem(asMember, code)).rejects.toMatchObject({
          code: 'ORG_AGENT_ALREADY_TAGGED',
        });

        const after = await mongoose.model(InviteCode.name).findById(inviteId);
        expect(after?.get('useCount')).toBe(1);
      });

      it('refuses an invite into a suspended office', async () => {
        const { code } = await invites.issue(leaderCtx, {}, '');
        await mongoose.model(Kpm.name).updateOne({ _id: KPM_A }, { $set: { status: 'suspended' } });
        await expect(invites.redeem(newcomer(await person()), code)).rejects.toMatchObject({
          code: 'ORG_INVITE_EXPIRED',
        });
      });

      it('refuses an invite whose issuer has left, rather than dropping somebody in leaderless', async () => {
        const { code } = await invites.issue(leaderCtx, {}, '');
        await members.updateById(ctx(KPM_A), leader, { $set: { status: 'removed' } });
        await expect(invites.redeem(newcomer(await person()), code)).rejects.toMatchObject({
          code: 'ORG_INVITE_EXPIRED',
        });
      });
    });

    describe('managing them', () => {
      it('lists a leader own invites, revoked ones included', async () => {
        const first = await invites.issue(leaderCtx, { label: 'September' }, '');
        await invites.issue(leaderCtx, {}, '');
        await invites.revoke(leaderCtx, first.inviteId);

        const mine = await invites.mine(leaderCtx, '');
        expect(mine).toHaveLength(2);
        expect(mine.find((i) => i.inviteId === first.inviteId)?.state).toBe('revoked');
        expect(mine.find((i) => i.inviteId === first.inviteId)?.label).toBe('September');
      });

      it('never lists or revokes somebody else invite', async () => {
        const theirs = await invites.issue(leaderCtx, {}, '');
        const otherId = await join(KPM_A, 'aab', leader);
        const otherRow = await members.findById(ctx(KPM_A), otherId);
        const otherCtx = new RequestContext(otherRow!.userId, 'none', {
          membershipId: otherId, kpmId: KPM_A, hierarchyRole: 'aab', status: 'active',
          isKpmOwner: false, isKpmAdmin: false, directCount: 0,
        });

        expect(await invites.mine(otherCtx, '')).toHaveLength(0);
        await expect(invites.revoke(otherCtx, theirs.inviteId)).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
      });

      it('never reaches another office invite', async () => {
        const theirLeader = await join(KPM_B, 'ab');
        const theirRow = await members.findById(ctx(KPM_B), theirLeader);
        const theirCtx = new RequestContext(theirRow!.userId, 'none', {
          membershipId: theirLeader, kpmId: KPM_B, hierarchyRole: 'ab', status: 'active',
          isKpmOwner: false, isKpmAdmin: false, directCount: 0,
        });
        const mine = await invites.issue(leaderCtx, {}, '');

        await expect(invites.revoke(theirCtx, mine.inviteId)).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
      });

      it('is idempotent about revoking twice', async () => {
        const issued = await invites.issue(leaderCtx, {}, '');
        const once = await invites.revoke(leaderCtx, issued.inviteId);
        const twice = await invites.revoke(leaderCtx, issued.inviteId);
        expect(twice.revokedAt).toBe(once.revokedAt);
      });

      it('previews whose unit and which office, before anybody commits', async () => {
        const { code } = await invites.issue(leaderCtx, {}, '');
        const preview = await invites.preview(code);
        expect(preview.kpmLabel).toContain('KPM 0417');
        expect(preview.leaderName).toBeTruthy();
      });

      it('accepts a code in any case, because people type it as they read it', async () => {
        const { code } = await invites.issue(leaderCtx, {}, '');
        await expect(invites.preview(`  ${code.toLowerCase()}  `)).resolves.toBeDefined();
      });
    });
  });

  describe('approving and tagging (P3-T5)', () => {
    function newcomer(userId: string) {
      return new RequestContext(userId, 'none', null);
    }

    async function asMember(membershipId: string, over: Partial<{ role: 'ab' | 'aab' | 'agent' }> = {}) {
      const row = await members.findById(ctx(KPM_A), membershipId);
      return new RequestContext(row!.userId, 'none', {
        membershipId,
        kpmId: KPM_A,
        hierarchyRole: over.role ?? (row!.role as 'ab' | 'aab' | 'agent'),
        status: 'active',
        isKpmOwner: false,
        isKpmAdmin: false,
        directCount: row!.directCounts?.total ?? 0,
      });
    }

    /** Somebody registered to the office who has asked `leaderId` to take them on. */
    async function askedFor(leaderId: string, name = 'Asking Person') {
      const userId = await person(name);
      await onboarding.registerKpm(newcomer(userId), KPM_A);
      const row = await mongoose.model(Membership.name).findOne({ kpmId: KPM_A, userId });
      const joinerCtx = new RequestContext(userId, 'none', {
        membershipId: String(row!._id), kpmId: KPM_A, hierarchyRole: 'agent',
        status: 'pending', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      });
      await onboarding.requestLeader(joinerCtx, leaderId);
      return { membershipId: String(row!._id), userId, ctx: joinerCtx };
    }

    let ab: string;
    let aab: string;
    let abCtx: RequestContext;
    let aabCtx: RequestContext;

    beforeEach(async () => {
      ab = await join(KPM_A, 'ab');
      aab = await join(KPM_A, 'aab', ab);
      await hierarchy.refreshCounts(ctx(KPM_A), ab);
      abCtx = await asMember(ab);
      aabCtx = await asMember(aab);
    });

    it('shows a leader what is waiting on them and nothing else', async () => {
      const mine = await askedFor(ab, 'For The AB');
      await askedFor(aab, 'For The AAB');

      const inbox = await approvals.inbox(abCtx);
      expect(inbox.map((r) => r.membershipId)).toEqual([mine.membershipId]);
      expect(inbox[0].fullName).toBe('For The AB');
      expect(inbox[0].agentCode).toBeTruthy();
      expect(inbox[0].routedFromName).toBeNull();
    });

    it('AC-2: offers an AB their own AABs to route into, and only those', async () => {
      const otherAb = await join(KPM_A, 'ab');
      await join(KPM_A, 'aab', otherAb);

      const choices = await approvals.routingChoices(abCtx);
      expect(choices.map((c) => c.membershipId)).toEqual([aab]);
    });

    it('AC-2: offers an AAB nothing, because there is no sub-unit below them', async () => {
      expect(await approvals.routingChoices(aabCtx)).toEqual([]);
    });

    it('AC-2: approving into an AAB unit puts them under the AAB, not the AB', async () => {
      const asker = await askedFor(ab);
      await approvals.approve(abCtx, (await approvals.inbox(abCtx))[0].requestId, aab);

      const row = await members.findById(ctx(KPM_A), asker.membershipId);
      expect(row?.leaderId).toBe(aab);
      expect(row?.status).toBe('active');
      expect(row?.ancestorIds).toEqual([ab, aab]);
      expect(row?.depth).toBe(2);
    });

    it('approving with no destination puts them under the approver', async () => {
      const asker = await askedFor(ab);
      await approvals.approve(abCtx, (await approvals.inbox(abCtx))[0].requestId);

      const row = await members.findById(ctx(KPM_A), asker.membershipId);
      expect(row?.leaderId).toBe(ab);
      expect(row?.ancestorIds).toEqual([ab]);
    });

    it('closes the joined edge and opens the one naming their leader', async () => {
      // Nothing is overwritten. The row that said "registered, no leader" is closed, and
      // a new one records who they now report to.
      const asker = await askedFor(ab);
      clock.advance(60_000);
      await approvals.approve(abCtx, (await approvals.inbox(abCtx))[0].requestId);

      const rows = await mongoose
        .model(MembershipHistory.name)
        .find({ membershipId: asker.membershipId })
        .sort({ validFrom: 1 });
      expect(rows).toHaveLength(2);
      expect(rows[0].get('validTo')).not.toBeNull();
      expect(rows[1].get('toLeaderId')).toBe(ab);
      expect(rows[1].get('validTo')).toBeNull();
    });

    it('counts the new report, so the approver becomes a leader by it', async () => {
      await askedFor(aab);
      await approvals.approve(aabCtx, (await approvals.inbox(aabCtx))[0].requestId);

      const row = await members.findById(ctx(KPM_A), aab);
      expect(row?.directCounts.total).toBe(1);
    });

    it('tells the asker they are in', async () => {
      const asker = await askedFor(ab);
      sent.length = 0;
      await approvals.approve(abCtx, (await approvals.inbox(abCtx))[0].requestId);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ userId: asker.userId, templateId: 'join_request.approved' });
    });

    it('AC-4: refuses to decide one that was already decided, and says which way', async () => {
      const { requestId } = (await askedFor(ab), (await approvals.inbox(abCtx))[0]);
      await approvals.approve(abCtx, requestId);

      await expect(approvals.approve(abCtx, requestId)).rejects.toMatchObject({
        code: 'ORG_REQUEST_ALREADY_DECIDED',
      });
      const err = await approvals.decline(abCtx, requestId).catch((e) => e);
      expect(err.details.status).toBe('approved');
    });

    it('404s another leader request rather than saying it is not theirs', async () => {
      await askedFor(aab);
      const requestId = (await approvals.inbox(aabCtx))[0].requestId;
      await expect(approvals.approve(abCtx, requestId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('refuses routing into a unit that is not the approver own', async () => {
      const otherAb = await join(KPM_A, 'ab');
      const strangersAab = await join(KPM_A, 'aab', otherAb);
      await askedFor(ab);
      const requestId = (await approvals.inbox(abCtx))[0].requestId;

      await expect(approvals.approve(abCtx, requestId, strangersAab)).rejects.toMatchObject({
        code: 'ORG_LEADER_NOT_IN_KPM',
      });
    });

    it('refuses routing by somebody without the grant', async () => {
      // An AAB has the inbox but not the routing. Checked on approve as well as on the
      // list, because a caller can name any id and the list is only a convenience.
      const target = await join(KPM_A, 'aab', aab);
      await askedFor(aab);
      const requestId = (await approvals.inbox(aabCtx))[0].requestId;

      await expect(approvals.approve(aabCtx, requestId, target)).rejects.toMatchObject({
        code: 'PERM_DENIED',
      });
    });

    describe('the office-wide queue (P3.5)', () => {
      async function asOwner(membershipId: string) {
        const row = await members.findById(ctx(KPM_A), membershipId);
        return new RequestContext(row!.userId, 'none', {
          membershipId, kpmId: KPM_A, hierarchyRole: row!.role as 'ab' | 'aab' | 'agent',
          status: 'active', isKpmOwner: true, isKpmAdmin: false,
          directCount: row!.directCounts?.total ?? 0,
        });
      }

      it('shows an Owner every open request, not only their own', async () => {
        // `leader_request:approve` grants the Owner `own-kpm`; the inbox used to answer
        // `own-unit` regardless, so a request nobody else answered was invisible.
        await askedFor(aab, 'Asked The AAB');
        await askedFor(ab, 'Asked The AB');

        const owner = await asOwner(ab);
        expect(await approvals.inbox(owner)).toHaveLength(2);
      });

      it('still shows a leader only what was addressed to them', async () => {
        await askedFor(aab, 'Asked The AAB');
        await askedFor(ab, 'Asked The AB');

        const theirs = await approvals.inbox(aabCtx);
        expect(theirs).toHaveLength(1);
        expect(theirs[0].fullName).toBe('Asked The AAB');
      });

      it('a peer still cannot reach a request addressed to somebody else', async () => {
        const peer = await join(KPM_A, 'aab', ab);
        await hierarchy.refreshCounts(ctx(KPM_A), ab);
        const asked = await askedFor(aab, 'Asked The AAB');

        const inbox = await approvals.inbox(aabCtx);
        await expect(
          approvals.approve(await asMember(peer), inbox[0].requestId),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect((await members.findById(ctx(KPM_A), asked.membershipId))!.status).toBe('pending');
      });

      it('AC: approving on a leader behalf attaches the joiner to THAT leader', async () => {
        // The trap: `leaderId` defaulted to the actor. An Owner clearing the queue would
        // have quietly moved every joiner into their own unit.
        const asked = await askedFor(aab, 'Asked The AAB');
        const owner = await asOwner(ab);

        const inbox = await approvals.inbox(owner);
        await approvals.approve(owner, inbox[0].requestId);

        const joined = await members.findById(ctx(KPM_A), asked.membershipId);
        expect(joined!.leaderId).toBe(aab);
        expect(joined!.status).toBe('active');
      });

      it('records who decided it, which is not who they asked', async () => {
        await askedFor(aab, 'Asked The AAB');
        const owner = await asOwner(ab);
        const inbox = await approvals.inbox(owner);
        await approvals.approve(owner, inbox[0].requestId);

        const row = await mongoose
          .model(JoinRequest.name)
          .findOne({ _id: inbox[0].requestId });
        expect(row!.get('decidedByMembershipId')).toBe(ab);
        expect(row!.get('leaderMembershipId')).toBe(aab);
        // Not routed — it went where it was asked to go.
        expect(row!.get('routedToMembershipId')).toBeNull();
      });

      it('never reaches another office queue', async () => {
        const theirRoot = await join(KPM_B, 'ab');
        const theirOwner = new RequestContext(
          (await members.findById(ctx(KPM_B), theirRoot))!.userId, 'none',
          {
            membershipId: theirRoot, kpmId: KPM_B, hierarchyRole: 'ab', status: 'active',
            isKpmOwner: true, isKpmAdmin: false, directCount: 0,
          },
        );
        await askedFor(aab, 'Asked In A');
        expect(await approvals.inbox(theirOwner)).toEqual([]);
      });
    });

    describe('declining', () => {
      it('leaves them registered, so they can ask somebody else', async () => {
        // The prototype drops the row, which leaves them nowhere.
        const asker = await askedFor(ab);
        await approvals.decline(abCtx, (await approvals.inbox(abCtx))[0].requestId, 'Not my patch');

        const row = await members.findById(ctx(KPM_A), asker.membershipId);
        expect(row?.status).toBe('pending');
        expect(row?.leaderId).toBeNull();

        // And they can, straight away.
        await expect(onboarding.requestLeader(asker.ctx, aab)).resolves.toBeDefined();
      });

      it('sends the reason to them', async () => {
        const asker = await askedFor(ab);
        sent.length = 0;
        await approvals.decline(abCtx, (await approvals.inbox(abCtx))[0].requestId, '  Try Sari  ');

        expect(sent[0]).toMatchObject({
          userId: asker.userId,
          templateId: 'join_request.declined',
        });
        const rows = await mongoose.model(JoinRequest.name).find({ status: 'declined' });
        expect(rows[0].get('reason')).toBe('Try Sari');
      });

      it('empties the inbox it returns', async () => {
        await askedFor(ab);
        const after = await approvals.decline(abCtx, (await approvals.inbox(abCtx))[0].requestId);
        expect(after).toEqual([]);
      });
    });

    describe('AC-3: pulling in somebody untagged', () => {
      it('lists people with no leader, not the whole office', async () => {
        const untaggedId = await person('Untagged Person');
        await onboarding.registerKpm(newcomer(untaggedId), KPM_A);

        const pool = await approvals.untagged(abCtx);
        expect(pool.map((p) => p.fullName)).toContain('Untagged Person');
        // The AAB reports to the AB, so they are not untagged.
        expect(pool.map((p) => p.membershipId)).not.toContain(aab);
      });

      it('never lists the searcher themselves', async () => {
        const pool = await approvals.untagged(abCtx);
        expect(pool.map((p) => p.membershipId)).not.toContain(ab);
      });

      it('searches by name', async () => {
        const untaggedId = await person('Findable Person');
        await onboarding.registerKpm(newcomer(untaggedId), KPM_A);
        expect(await approvals.untagged(abCtx, 'findable')).toHaveLength(1);
        expect(await approvals.untagged(abCtx, 'nobody')).toHaveLength(0);
      });

      it('tags them immediately, active, with no approval', async () => {
        const untaggedId = await person('Pulled In');
        await onboarding.registerKpm(newcomer(untaggedId), KPM_A);
        const row = await mongoose.model(Membership.name).findOne({ userId: untaggedId });

        await approvals.tag(abCtx, String(row!._id));

        const after = await members.findById(ctx(KPM_A), String(row!._id));
        expect(after?.status).toBe('active');
        expect(after?.leaderId).toBe(ab);
      });

      it('notifies them, because nobody asked', async () => {
        const untaggedId = await person();
        await onboarding.registerKpm(newcomer(untaggedId), KPM_A);
        const row = await mongoose.model(Membership.name).findOne({ userId: untaggedId });
        sent.length = 0;

        await approvals.tag(abCtx, String(row!._id));
        expect(sent[0]).toMatchObject({
          userId: untaggedId,
          templateId: 'member.tagged_by_leader',
        });
      });

      it('cancels a request they had open, since they are in a unit now', async () => {
        const asker = await askedFor(aab);
        await approvals.tag(abCtx, asker.membershipId);

        const open = await mongoose
          .model(JoinRequest.name)
          .find({ membershipId: asker.membershipId, status: 'pending' });
        expect(open).toHaveLength(0);
      });

      it('refuses somebody who already reports to a leader', async () => {
        // Taking them out of another unit is a re-parent, not a tag, and not something
        // you do from a search result.
        await expect(approvals.tag(abCtx, aab)).rejects.toMatchObject({
          code: 'ORG_AGENT_ALREADY_TAGGED',
        });
      });

      it('refuses adding yourself to your own unit', async () => {
        await expect(approvals.tag(abCtx, ab)).rejects.toMatchObject({
          code: 'ORG_CYCLE_DETECTED',
        });
      });

      it('never reaches another office', async () => {
        const theirs = await join(KPM_B, 'agent');
        await expect(approvals.tag(abCtx, theirs)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect((await approvals.untagged(abCtx)).map((p) => p.membershipId)).not.toContain(theirs);
      });
    });
  });

  describe('KPM Admin delegation (P3-T10)', () => {
    async function asMember(
      membershipId: string,
      over: Partial<{ isKpmOwner: boolean; isKpmAdmin: boolean }> = {},
    ) {
      const row = await members.findById(ctx(KPM_A), membershipId);
      return new RequestContext(row!.userId, 'none', {
        membershipId,
        kpmId: KPM_A,
        hierarchyRole: row!.role as 'ab' | 'aab' | 'agent',
        status: 'active',
        isKpmOwner: over.isKpmOwner ?? false,
        isKpmAdmin: over.isKpmAdmin ?? false,
        directCount: row!.directCounts?.total ?? 0,
      });
    }

    let root: string;
    let ab: string;
    let agent: string;
    let owner: RequestContext;

    beforeEach(async () => {
      root = await join(KPM_A, 'ab');
      ab = await join(KPM_A, 'ab', root);
      agent = await join(KPM_A, 'agent', ab);
      await hierarchy.refreshCounts(ctx(KPM_A), root);
      await hierarchy.refreshCounts(ctx(KPM_A), ab);
      owner = await asMember(root, { isKpmOwner: true });
    });

    describe('AC-2: admin rights are independent of hierarchy role', () => {
      it('gives them to an AB with a unit, and touches neither', async () => {
        const before = await members.findById(ctx(KPM_A), ab);
        const [granted] = await delegation.grant(owner, ab);

        expect(granted).toMatchObject({ membershipId: ab, role: 'ab' });
        const after = await members.findById(ctx(KPM_A), ab);
        expect(after!.role).toBe('ab');
        expect(after!.leaderId).toBe(before!.leaderId);
        expect(after!.directCounts.total).toBe(before!.directCounts.total);
      });

      it('gives them to an agent, who is still an agent', async () => {
        await delegation.grant(owner, agent);
        expect((await members.findById(ctx(KPM_A), agent))!.role).toBe('agent');
      });

      it('changing a role afterwards leaves the admin rights alone', async () => {
        await delegation.grant(owner, agent);
        await roles.change(owner, agent, 'aab', 'Ready to lead');

        const after = await members.findById(ctx(KPM_A), agent);
        expect(after!.role).toBe('aab');
        expect(after!.adminAccess.isKpmAdmin).toBe(true);
      });

      it('and revoking them leaves the role alone', async () => {
        await delegation.grant(owner, ab);
        await delegation.revoke(owner, ab);
        expect((await members.findById(ctx(KPM_A), ab))!.role).toBe('ab');
      });
    });

    describe('AC-3: both parties are recorded', () => {
      it('writes who granted it and when, and reads the name back', async () => {
        const [granted] = await delegation.grant(owner, ab);
        expect(granted.grantedAt).toBeTruthy();
        expect(granted.grantedByName).toBeTruthy();

        const row = await members.findById(ctx(KPM_A), ab);
        expect(row!.adminAccess.grantedByUserId).toBe(owner.userId);
      });

      it('appends a history event naming actor and target, and closes the last one', async () => {
        await delegation.grant(owner, ab);
        await delegation.revoke(owner, ab);

        const events = await mongoose
          .model(MembershipHistory.name)
          .find({ membershipId: ab, eventType: { $in: ['admin_granted', 'admin_revoked'] } })
          .sort({ validFrom: 1 });

        expect(events.map((e) => e.get('eventType'))).toEqual(['admin_granted', 'admin_revoked']);
        expect(events.every((e) => e.get('actorMembershipId') === root)).toBe(true);
        // Append-only: only the newest edge is open.
        expect(events.filter((e) => e.get('validTo') === null)).toHaveLength(1);
      });

      it('tells the person, both ways', async () => {
        const userId = (await members.findById(ctx(KPM_A), ab))!.userId;
        sent = [];
        await delegation.grant(owner, ab);
        await delegation.revoke(owner, ab);

        const notes = sent.filter((n) => n.templateId === 'member.admin_access_changed');
        expect(notes).toHaveLength(2);
        expect(notes.every((n) => n.userId === userId)).toBe(true);
        expect(notes.map((n) => n.payload?.granted)).toEqual([true, false]);
      });
    });

    describe('the list', () => {
      it('is empty before anybody is granted anything', async () => {
        expect(await delegation.list(owner)).toEqual([]);
      });

      it('shows an Admin the list, read-only', async () => {
        await delegation.grant(owner, ab);
        const asAdmin = await asMember(ab, { isKpmAdmin: true });

        const seen = await delegation.list(asAdmin);
        expect(seen.map((a) => a.membershipId)).toEqual([ab]);
        // Knowing who administers the office is not a power. Taking it away is.
        expect(seen[0].canRevoke).toBe(false);
      });

      it('never offers the Owner their own row to revoke', async () => {
        await delegation.grant(owner, root);
        const listed = await delegation.list(owner);
        expect(listed.find((a) => a.membershipId === root)!.canRevoke).toBe(false);
        expect(listed.find((a) => a.membershipId !== root)).toBeUndefined();
      });

      it('drops somebody once they are removed from the office', async () => {
        await delegation.grant(owner, ab);
        await removals.remove(owner, ab, {
          confirmation: 'REMOVE',
          subtree: { action: 'orphan' },
        });
        expect(await delegation.list(owner)).toEqual([]);
      });

      it('never shows another office admins', async () => {
        const theirRoot = await join(KPM_B, 'ab');
        const theirOwner = new RequestContext(
          (await members.findById(ctx(KPM_B), theirRoot))!.userId,
          'none',
          {
            membershipId: theirRoot, kpmId: KPM_B, hierarchyRole: 'ab', status: 'active',
            isKpmOwner: true, isKpmAdmin: false, directCount: 0,
          },
        );
        await delegation.grant(theirOwner, theirRoot);
        expect(await delegation.list(owner)).toEqual([]);
      });
    });

    describe('what granting refuses', () => {
      it('refuses somebody who already has it', async () => {
        await delegation.grant(owner, ab);
        await expect(delegation.grant(owner, ab)).rejects.toMatchObject({
          code: 'ORG_ALREADY_ADMIN',
        });
      });

      it('refuses somebody who has not joined yet', async () => {
        const waiting = await join(KPM_A, 'agent');
        await members.updateById(ctx(KPM_A), waiting, { $set: { status: 'pending' } });
        await expect(delegation.grant(owner, waiting)).rejects.toMatchObject({
          code: 'ORG_ADMIN_TARGET_NOT_ACTIVE',
        });
      });

      it('refuses somebody who has been removed', async () => {
        await removals.remove(owner, agent, { confirmation: 'REMOVE' });
        await expect(delegation.grant(owner, agent)).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
      });

      it('never reaches another office member', async () => {
        const theirs = await join(KPM_B, 'agent');
        await expect(delegation.grant(owner, theirs)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(delegation.revoke(owner, theirs)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      });
    });

    describe('what revoking refuses', () => {
      it('refuses somebody who does not have it', async () => {
        await expect(delegation.revoke(owner, agent)).rejects.toMatchObject({
          code: 'ORG_NOT_AN_ADMIN',
        });
      });

      it('refuses the Owner their own access — transferring the office is the operation', async () => {
        await delegation.grant(owner, root);
        await expect(delegation.revoke(owner, root)).rejects.toMatchObject({
          code: 'PERM_OWNER_ONLY',
        });
        expect((await members.findById(ctx(KPM_A), root))!.adminAccess.isKpmAdmin).toBe(true);
      });
    });

    it('refuses every surface to somebody in no office', async () => {
      const nowhere = new RequestContext('u-new', 'none', null);
      await expect(delegation.list(nowhere)).rejects.toMatchObject({
        code: 'TENANT_NO_MEMBERSHIP',
      });
      await expect(delegation.grant(nowhere, ab)).rejects.toMatchObject({
        code: 'TENANT_NO_MEMBERSHIP',
      });
    });
  });

  describe('groups and Core Leader (P3-T9)', () => {
    async function asOwner(membershipId: string) {
      const row = await members.findById(ctx(KPM_A), membershipId);
      return new RequestContext(row!.userId, 'none', {
        membershipId,
        kpmId: KPM_A,
        hierarchyRole: row!.role as 'ab' | 'aab' | 'agent',
        status: 'active',
        isKpmOwner: true,
        isKpmAdmin: false,
        directCount: row!.directCounts?.total ?? 0,
      });
    }

    let root: string;
    let ab: string;
    let agent: string;
    let owner: RequestContext;

    beforeEach(async () => {
      root = await join(KPM_A, 'ab');
      ab = await join(KPM_A, 'ab', root);
      agent = await join(KPM_A, 'agent', ab);
      await hierarchy.refreshCounts(ctx(KPM_A), root);
      await hierarchy.refreshCounts(ctx(KPM_A), ab);
      owner = await asOwner(root);
    });

    describe('AC-1: a group is a tag, and never touches what anybody can see', () => {
      it('does not change one person visibility of another', async () => {
        // The whole point of the acceptance criterion. Two people in one group, with no
        // hierarchy between them, still cannot see each other.
        const [created] = await groups.create(owner, {
          name: 'Top Producers 2026',
          ownerMembershipId: root,
        });
        const peer = await join(KPM_A, 'agent', root);
        await hierarchy.refreshCounts(ctx(KPM_A), root);

        const asAb = new RequestContext((await members.findById(ctx(KPM_A), ab))!.userId, 'none', {
          membershipId: ab, kpmId: KPM_A, hierarchyRole: 'ab', status: 'active',
          isKpmOwner: false, isKpmAdmin: false, directCount: 1,
        });

        const before = (await directory.list(asAb, {})).members.map((m) => m.membershipId);
        expect(before).not.toContain(peer);

        await groups.tag(owner, ab, { groupIds: [created.groupId], isCoreLeader: false });
        await groups.tag(owner, peer, { groupIds: [created.groupId], isCoreLeader: false });

        const after = (await directory.list(asAb, {})).members.map((m) => m.membershipId);
        expect(after).toEqual(before);
      });

      it('does not put a group member into anybody tree', async () => {
        const [created] = await groups.create(owner, { name: 'Task Force', ownerMembershipId: root });
        const peer = await join(KPM_A, 'agent', root);
        await hierarchy.refreshCounts(ctx(KPM_A), root);
        await groups.tag(owner, ab, { groupIds: [created.groupId], isCoreLeader: false });
        await groups.tag(owner, peer, { groupIds: [created.groupId], isCoreLeader: false });

        const asAb = new RequestContext((await members.findById(ctx(KPM_A), ab))!.userId, 'none', {
          membershipId: ab, kpmId: KPM_A, hierarchyRole: 'ab', status: 'active',
          isKpmOwner: false, isKpmAdmin: false, directCount: 1,
        });
        expect((await tree.read(asAb)).nodes.map((n) => n.membershipId)).not.toContain(peer);
      });

      it('AC-2: Core Leader changes nothing about scope either', async () => {
        const asAgent = new RequestContext(
          (await members.findById(ctx(KPM_A), agent))!.userId,
          'none',
          {
            membershipId: agent, kpmId: KPM_A, hierarchyRole: 'agent', status: 'active',
            isKpmOwner: false, isKpmAdmin: false, directCount: 0,
          },
        );
        const before = (await directory.list(asAgent, {})).members.length;

        await groups.tag(owner, agent, { groupIds: [], isCoreLeader: true });
        expect((await members.findById(ctx(KPM_A), agent))!.isCoreLeader).toBe(true);

        expect((await directory.list(asAgent, {})).members).toHaveLength(before);
      });
    });

    describe('creating and naming', () => {
      it('names the owner by membership, and reads their name back', async () => {
        const list = await groups.create(owner, {
          name: 'New Agent Mentoring Circle',
          ownerMembershipId: ab,
        });
        expect(list[0]).toMatchObject({
          name: 'New Agent Mentoring Circle',
          ownerMembershipId: ab,
          ownerHasLeft: false,
          memberCount: 0,
        });
        expect(list[0].ownerName).toBeTruthy();
      });

      it('refuses a second live group with the same name', async () => {
        await groups.create(owner, { name: 'Task Force', ownerMembershipId: root });
        await expect(
          groups.create(owner, { name: 'Task Force', ownerMembershipId: root }),
        ).rejects.toMatchObject({ code: 'ORG_GROUP_NAME_TAKEN' });
      });

      it('refuses an owner who is not in this office', async () => {
        const theirs = await join(KPM_B, 'ab');
        await expect(
          groups.create(owner, { name: 'Cross-office', ownerMembershipId: theirs }),
        ).rejects.toMatchObject({ code: 'ORG_GROUP_OWNER_NOT_IN_KPM' });
      });

      it('renames, and hands it to a different owner', async () => {
        const [made] = await groups.create(owner, { name: 'Old name', ownerMembershipId: root });
        const [renamed] = await groups.rename(owner, made.groupId, {
          name: 'New name',
          ownerMembershipId: ab,
        });
        expect(renamed).toMatchObject({ name: 'New name', ownerMembershipId: ab });
      });

      it('lets a group keep its own name when only the owner changes', async () => {
        const [made] = await groups.create(owner, { name: 'Steady', ownerMembershipId: root });
        await expect(
          groups.rename(owner, made.groupId, { name: 'Steady', ownerMembershipId: ab }),
        ).resolves.toBeDefined();
      });

      it('counts the people tagged into it', async () => {
        const [made] = await groups.create(owner, { name: 'Circle', ownerMembershipId: root });
        await groups.tag(owner, ab, { groupIds: [made.groupId], isCoreLeader: false });
        await groups.tag(owner, agent, { groupIds: [made.groupId], isCoreLeader: false });

        expect((await groups.list(owner))[0].memberCount).toBe(2);
      });

      it('says so when the owner has left, rather than showing a blank', async () => {
        const leaver = await join(KPM_A, 'aab', root);
        await hierarchy.refreshCounts(ctx(KPM_A), root);
        await groups.create(owner, { name: 'Theirs to run', ownerMembershipId: leaver });

        await removals.remove(owner, leaver, { confirmation: 'REMOVE' });

        const [listed] = await groups.list(owner);
        // Still named — they really are the recorded owner, and a blank would read as a
        // fault — but flagged, because the group now has nobody running it.
        expect(listed.ownerName).toBeTruthy();
        expect(listed.ownerHasLeft).toBe(true);
        // The group itself survives its owner leaving — somebody has to be able to
        // hand it on, and a group that vanished would take its tags with it.
        expect(listed.name).toBe('Theirs to run');
      });

      it('never counts, or shows, another office groups', async () => {
        const theirRoot = await join(KPM_B, 'ab');
        const theirOwner = new RequestContext(
          (await members.findById(ctx(KPM_B), theirRoot))!.userId,
          'none',
          {
            membershipId: theirRoot, kpmId: KPM_B, hierarchyRole: 'ab', status: 'active',
            isKpmOwner: true, isKpmAdmin: false, directCount: 0,
          },
        );
        await groups.create(theirOwner, { name: 'Theirs', ownerMembershipId: theirRoot });

        expect(await groups.list(owner)).toEqual([]);
        // And the same name is free over here, because uniqueness is per office.
        await expect(
          groups.create(owner, { name: 'Theirs', ownerMembershipId: root }),
        ).resolves.toBeDefined();
      });
    });

    describe('retiring one', () => {
      it('archives rather than deleting, and keeps the tags on the people', async () => {
        // The prototype splices the row and strips everybody tags in the same breath,
        // so the record that a cohort existed is gone.
        const [made] = await groups.create(owner, { name: 'Class of 2025', ownerMembershipId: root });
        await groups.tag(owner, agent, { groupIds: [made.groupId], isCoreLeader: false });

        expect(await groups.archive(owner, made.groupId)).toEqual([]);
        expect((await members.findById(ctx(KPM_A), agent))!.groupIds).toEqual([made.groupId]);
      });

      it('frees the name for reuse once it is retired', async () => {
        const [made] = await groups.create(owner, { name: 'Task Force', ownerMembershipId: root });
        await groups.archive(owner, made.groupId);
        await expect(
          groups.create(owner, { name: 'Task Force', ownerMembershipId: root }),
        ).resolves.toBeDefined();
      });

      it('404s a group that is not here, and one already retired', async () => {
        const [made] = await groups.create(owner, { name: 'Gone', ownerMembershipId: root });
        await groups.archive(owner, made.groupId);
        await expect(groups.archive(owner, made.groupId)).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
        await expect(groups.archive(owner, 'not-an-id')).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
      });
    });

    describe('tagging one person', () => {
      it('sets and clears groups, and the Core Leader flag, together', async () => {
        const [a] = await groups.create(owner, { name: 'A', ownerMembershipId: root });
        const list = await groups.create(owner, { name: 'B', ownerMembershipId: root });
        const b = list.find((g) => g.name === 'B')!;

        let tags = await groups.tag(owner, agent, {
          groupIds: [a.groupId, b.groupId],
          isCoreLeader: true,
        });
        expect(tags.groupIds.sort()).toEqual([a.groupId, b.groupId].sort());
        expect(tags.isCoreLeader).toBe(true);

        tags = await groups.tag(owner, agent, { groupIds: [a.groupId], isCoreLeader: false });
        expect(tags.groupIds).toEqual([a.groupId]);
        expect(tags.isCoreLeader).toBe(false);
      });

      it('keeps a tag on a retired group, because it is the record of a past cohort', async () => {
        const [old] = await groups.create(owner, { name: 'Class of 2025', ownerMembershipId: root });
        await groups.tag(owner, agent, { groupIds: [old.groupId], isCoreLeader: false });
        await groups.archive(owner, old.groupId);

        const [now] = await groups.create(owner, { name: 'Class of 2026', ownerMembershipId: root });
        const tags = await groups.tag(owner, agent, {
          groupIds: [now.groupId],
          isCoreLeader: false,
        });

        // Saving the panel does not silently drop what the panel could not offer.
        expect(tags.groupIds.sort()).toEqual([old.groupId, now.groupId].sort());
      });

      it('refuses a group id from another office', async () => {
        const theirRoot = await join(KPM_B, 'ab');
        const theirOwner = new RequestContext(
          (await members.findById(ctx(KPM_B), theirRoot))!.userId,
          'none',
          {
            membershipId: theirRoot, kpmId: KPM_B, hierarchyRole: 'ab', status: 'active',
            isKpmOwner: true, isKpmAdmin: false, directCount: 0,
          },
        );
        const [theirs] = await groups.create(theirOwner, {
          name: 'Theirs',
          ownerMembershipId: theirRoot,
        });

        await expect(
          groups.tag(owner, agent, { groupIds: [theirs.groupId], isCoreLeader: false }),
        ).rejects.toMatchObject({ code: 'ORG_GROUP_NOT_FOUND' });
      });

      it('refuses a retired group rather than quietly re-adding it', async () => {
        const [made] = await groups.create(owner, { name: 'Retired', ownerMembershipId: root });
        await groups.archive(owner, made.groupId);
        await expect(
          groups.tag(owner, agent, { groupIds: [made.groupId], isCoreLeader: false }),
        ).rejects.toMatchObject({ code: 'ORG_GROUP_NOT_FOUND' });
      });

      it('never reaches another office member', async () => {
        const theirs = await join(KPM_B, 'agent');
        await expect(
          groups.tag(owner, theirs, { groupIds: [], isCoreLeader: false }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(groups.tagsFor(owner, theirs)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      });

      it('does not duplicate a group somebody is already in', async () => {
        const [made] = await groups.create(owner, { name: 'Once', ownerMembershipId: root });
        await groups.tag(owner, agent, {
          groupIds: [made.groupId, made.groupId],
          isCoreLeader: false,
        });
        expect((await groups.tagsFor(owner, agent)).groupIds).toEqual([made.groupId]);
      });
    });

    it('refuses every surface to somebody in no office', async () => {
      const nowhere = new RequestContext('u-new', 'none', null);
      await expect(groups.list(nowhere)).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
      await expect(
        groups.create(nowhere, { name: 'X', ownerMembershipId: root }),
      ).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
      await expect(groups.tagsFor(nowhere, agent)).rejects.toMatchObject({
        code: 'TENANT_NO_MEMBERSHIP',
      });
    });
  });

  const directory_list = (c: RequestContext, q = {}) => directory.list(c, q);

  describe('Phase 3 exit criterion: the hierarchy at 500 members', () => {
    /**
     * Seed an office of `n` members directly.
     *
     * Through `hierarchy.create` this would be 500 counter increments and 500 history
     * writes — minutes, not seconds, and none of it is what is under test. The shape is
     * what matters: one root, ten ABs, five AABs each, nine agents each.
     */
    async function office(kpmId: string, root: string) {
      const model = mongoose.model(Membership.name);
      const docs: Record<string, unknown>[] = [];
      const abIds: string[] = [];
      let seq = 1000;
      const add = (leaderId: string | null, ancestors: string[], role: string) => {
        const id = String(new mongoose.Types.ObjectId());
        docs.push({
          _id: id, kpmId, userId: `u-${id}`, role, leaderId,
          ancestorIds: ancestors, depth: ancestors.length, status: 'active',
          agentSeq: ++seq, agentCode: `PERF-${seq}`,
          directCounts: { ab: 0, aab: 0, agent: 0, total: 0 }, subtreeCount: 0,
          isCoreLeader: false, groupIds: [], deletedAt: null,
          adminAccess: { isKpmAdmin: false, grantedByUserId: null, grantedAt: null, revokedAt: null },
        });
        return id;
      };
      for (let a = 0; a < 10; a += 1) {
        const ab = add(root, [root], 'ab');
        abIds.push(ab);
        for (let b = 0; b < 5; b += 1) {
          const aab = add(ab, [root, ab], 'aab');
          for (let g = 0; g < 9; g += 1) add(aab, [root, ab, aab], 'agent');
        }
      }
      await model.insertMany(docs);
      return { count: docs.length, abIds };
    }

    it('answers descendants and the whole office from one index, examining nothing spare', async () => {
      // Two offices, so a query that forgot `kpmId` would be visibly wrong rather than
      // accidentally right.
      const rootA = await join(KPM_A, 'ab');
      const rootB = await join(KPM_B, 'ab');
      const seeded = await office(KPM_A, rootA);
      await office(KPM_B, rootB);
      expect(seeded.count).toBe(510);

      type Explained = {
        queryPlanner: unknown;
        executionStats: { nReturned: number; totalDocsExamined: number };
      };
      const model = mongoose.model(Membership.name);
      const explain = async (filter: Record<string, unknown>) =>
        (await model.find(filter).explain('executionStats')) as unknown as Explained;

      const office_ = await explain({ kpmId: KPM_A, status: 'active', deletedAt: null });
      const downline = await explain({
        kpmId: KPM_A, ancestorIds: seeded.abIds[3], status: 'active', deletedAt: null,
      });

      for (const plan of [office_, downline]) {
        const winning = JSON.stringify(plan.queryPlanner);
        expect(winning).not.toContain('COLLSCAN');
        expect(winning).toContain('IXSCAN');
        // The whole point of `ancestorIds`: the fan-out is an indexed lookup, so the
        // engine touches what it returns and not the office around it.
        expect(plan.executionStats.totalDocsExamined)
          .toBeLessThanOrEqual(plan.executionStats.nReturned);
      }

      expect(office_.executionStats.nReturned).toBe(511);
      expect(downline.executionStats.nReturned).toBe(50);
    });

    it('reads one office and never the other, at scale', async () => {
      const rootA = await join(KPM_A, 'ab');
      const rootB = await join(KPM_B, 'ab');
      await office(KPM_A, rootA);
      await office(KPM_B, rootB);

      const descendants = await hierarchy.descendantsOf(ctx(KPM_A), rootA);
      expect(descendants).toHaveLength(510);
      expect(descendants.every((d) => d.kpmId === KPM_A)).toBe(true);
    });
  });

  describe('the roster is three disjoint populations (P3.5)', () => {
    it('the Directory is active only, and each count counts its own tab', async () => {
      // The bug: the Directory answered `$ne: 'removed'`, so a pending member appeared
      // there *and* under Pending — the same person on two tabs, and a Directory count
      // that disagreed with its own rows by exactly the number of them.
      const root = await join(KPM_A, 'ab');
      const active = await join(KPM_A, 'agent', root);
      const waiting = await join(KPM_A, 'agent');
      await members.updateById(ctx(KPM_A), waiting, { $set: { status: 'pending' } });
      const gone = await join(KPM_A, 'agent', root);
      await members.updateById(ctx(KPM_A), gone, { $set: { status: 'removed' } });
      await hierarchy.refreshCounts(ctx(KPM_A), root);

      const owner = new RequestContext(
        (await members.findById(ctx(KPM_A), root))!.userId, 'none',
        {
          membershipId: root, kpmId: KPM_A, hierarchyRole: 'ab', status: 'active',
          isKpmOwner: true, isKpmAdmin: false, directCount: 2,
        },
      );

      const directory = await directory_list(owner);
      expect(directory.members.map((m) => m.membershipId).sort()).toEqual([root, active].sort());
      expect(directory.counts).toEqual({ directory: 2, pending: 1, removed: 1 });

      // Each tab's rows equal its own count, and no member is on two tabs.
      const pending = await directory_list(owner, { status: 'pending' as const });
      const removed = await directory_list(owner, { status: 'removed' as const });
      expect(pending.members).toHaveLength(pending.counts.pending);
      expect(removed.members).toHaveLength(removed.counts.removed);

      const ids = [...directory.members, ...pending.members, ...removed.members]
        .map((m) => m.membershipId);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('the tree (P3-T8)', () => {
    async function asMember(
      membershipId: string,
      over: Partial<{ isKpmOwner: boolean; isKpmAdmin: boolean }> = {},
    ) {
      const row = await members.findById(ctx(KPM_A), membershipId);
      return new RequestContext(row!.userId, 'none', {
        membershipId,
        kpmId: KPM_A,
        hierarchyRole: row!.role as 'ab' | 'aab' | 'agent',
        status: 'active',
        isKpmOwner: over.isKpmOwner ?? false,
        isKpmAdmin: over.isKpmAdmin ?? false,
        directCount: row!.directCounts?.total ?? 0,
      });
    }

    let root: string;
    let ab: string;
    let aab: string;
    let agent: string;

    beforeEach(async () => {
      root = await join(KPM_A, 'ab');
      ab = await join(KPM_A, 'ab', root);
      aab = await join(KPM_A, 'aab', ab);
      agent = await join(KPM_A, 'agent', aab);
      for (const id of [root, ab, aab]) await hierarchy.refreshCounts(ctx(KPM_A), id);
    });

    describe('AC-1: layers come from depth, and your leader is not one', () => {
      it('sends the depth the membership carries, not a position', async () => {
        const owner = await asMember(root, { isKpmOwner: true });
        const byId = new Map((await tree.read(owner)).nodes.map((n) => [n.membershipId, n.depth]));

        expect(byId.get(root)).toBe(0);
        expect(byId.get(ab)).toBe(1);
        expect(byId.get(aab)).toBe(2);
        expect(byId.get(agent)).toBe(3);
      });

      it('a depth survives an unrelated branch being collapsed, because it is not an index', async () => {
        // The prototype labels by column index, so collapsing a branch renumbers
        // everybody. Depth is a property of the person.
        const second = await join(KPM_A, 'agent', root);
        await hierarchy.refreshCounts(ctx(KPM_A), root);
        const owner = await asMember(root, { isKpmOwner: true });

        const before = (await tree.read(owner)).nodes.find((n) => n.membershipId === agent)!.depth;
        await removals.remove(owner, second, { confirmation: 'REMOVE' });
        const after = (await tree.read(owner)).nodes.find((n) => n.membershipId === agent)!.depth;

        expect(after).toBe(before);
      });

      it('puts the root of your own tree on layer 1, whatever the office says', async () => {
        // The trap two independent reviews found: sending office depth and letting the
        // screen label it. An AB two layers down the office is layer 1 of their tree.
        const asAb = await tree.read(await asMember(ab));
        const byId = new Map(asAb.nodes.map((n) => [n.membershipId, n]));

        expect(byId.get(ab)).toMatchObject({ depth: 1, layer: 1 });
        expect(byId.get(aab)).toMatchObject({ depth: 2, layer: 2 });
        expect(byId.get(agent)).toMatchObject({ depth: 3, layer: 3 });

        // The same people, seen office-wide, are one layer deeper.
        const owner = await tree.read(await asMember(root, { isKpmOwner: true }));
        expect(new Map(owner.nodes.map((n) => [n.membershipId, n.layer])).get(agent)).toBe(4);
      });

      it('puts an orphan root on layer 1 beside the office root', async () => {
        await removals.remove(await asMember(root, { isKpmOwner: true }), ab, {
          confirmation: 'REMOVE',
          subtree: { action: 'orphan' },
        });
        const result = await tree.read(await asMember(root, { isKpmOwner: true }));
        const byId = new Map(result.nodes.map((n) => [n.membershipId, n.layer]));

        expect(byId.get(root)).toBe(1);
        expect(byId.get(aab)).toBe(1);
        expect(byId.get(agent)).toBe(2);
      });

      it('sends your own leader separately, and never as a node', async () => {
        const asAab = await asMember(aab);
        const result = await tree.read(asAab);

        expect(result.leader?.membershipId).toBe(ab);
        expect(result.nodes.map((n) => n.membershipId)).not.toContain(ab);
        // Structurally incapable of being a layer: it carries no depth and no leaderId.
        expect(result.leader).not.toHaveProperty('depth');
      });

      it('sends no leader card to somebody whose leader is already a node', async () => {
        // A tenant admin sees their own leader in the tree. Drawing them above as well
        // would be the same person twice on one screen.
        const owner = await asMember(aab, { isKpmOwner: true });
        expect((await tree.read(owner)).leader).toBeNull();
      });

      it('sends no leader card to the office root, who has none', async () => {
        expect((await tree.read(await asMember(root))).leader).toBeNull();
      });

      it('marks which node is you, so the tree can say YOU without guessing', async () => {
        const asAab = await asMember(aab);
        const result = await tree.read(asAab);
        expect(result.selfId).toBe(aab);
        expect(result.nodes.filter((n) => n.isSelf).map((n) => n.membershipId)).toEqual([aab]);
      });
    });

    describe('AC-2: who sees what', () => {
      it('gives a tenant admin the whole office', async () => {
        const owner = await asMember(root, { isKpmOwner: true });
        expect((await tree.read(owner)).nodes.map((n) => n.membershipId).sort())
          .toEqual([root, ab, aab, agent].sort());
      });

      it('gives a leader themselves and their downline, and nothing above', async () => {
        const result = await tree.read(await asMember(ab));
        expect(result.nodes.map((n) => n.membershipId).sort()).toEqual([ab, aab, agent].sort());
        expect(result.rootIds).toEqual([ab]);
      });

      it('gives an agent a tree of one, rather than refusing them', async () => {
        const result = await tree.read(await asMember(agent));
        expect(result.nodes.map((n) => n.membershipId)).toEqual([agent]);
        expect(result.leader?.membershipId).toBe(aab);
      });

      it('stops the leader card at one person, and at four fields', async () => {
        // `visibleTo` is self plus descendants, so a leader is an *ancestor* and outside
        // it. The card is the single registered exception to "you see your downline
        // only" (`multi-tenancy-and-scoping.md`). It is bounded deliberately, and this
        // fails if either bound moves.
        const result = await tree.read(await asMember(agent));

        // One person: their own leader, never the chain above them.
        expect(result.leader?.membershipId).toBe(aab);
        expect(result.leader?.membershipId).not.toBe(ab);
        expect(result.nodes.map((n) => n.membershipId)).toEqual([agent]);

        // Four fields. Not unit size, not a count, not an email or an agent code — an
        // agent cannot read their leader's row, only be told who they are.
        expect(Object.keys(result.leader!).sort()).toEqual(
          ['fullName', 'initials', 'membershipId', 'role'].sort(),
        );
      });

      it('gives a nested AAB their whole downline, not just their direct reports', async () => {
        // The matrix cell for an AAB reads `own-unit`, and the rules beneath it say what
        // that means: rule 1 resolves `own-unit` to `own-downline` for reading, naming
        // role change and removal as the only exceptions, and rule 2 says `own-downline`
        // stays correct even where a KPM nests AAB under AAB
        // (`roles-and-permissions.md:187-196`).
        //
        // A first pass on 2026-09-06 read the cell and not the rules, and asserted the
        // opposite of this — that the top AAB should NOT see the grandchild. That would
        // have cut a nested AAB off from their own downline on a screen whose manual
        // says it draws "your unit and everyone below it".
        const topAab = await join(KPM_A, 'aab', ab);
        const midAab = await join(KPM_A, 'aab', topAab);
        const grandchild = await join(KPM_A, 'agent', midAab);

        const seen = (await tree.read(await asMember(topAab))).nodes.map((n) => n.membershipId);
        expect(seen.sort()).toEqual([topAab, midAab, grandchild].sort());

        // The AB above them sees all four, and a peer's unit is still unreachable.
        const abSees = (await tree.read(await asMember(ab))).nodes.map((n) => n.membershipId);
        for (const id of [topAab, midAab, grandchild]) expect(abSees).toContain(id);
      });

      it('gives an agent themselves, and nobody else', async () => {
        // `own` is the one token that stays literal: an agent who leads nobody has a
        // downline of one, and an agent who leads somebody is still granted only `own`.
        const seen = (await tree.read(await asMember(agent))).nodes.map((n) => n.membershipId);
        expect(seen).toEqual([agent]);
      });

      it('never reaches another office, even for an admin', async () => {
        await join(KPM_B, 'ab');
        const owner = await asMember(root, { isKpmOwner: true });
        const ids = (await tree.read(owner)).nodes.map((n) => n.membershipId);
        const theirs = await members.find(ctx(KPM_B), {});
        for (const row of theirs) expect(ids).not.toContain(String(row._id));
      });

      it('shows a Super Admin acting in an office the whole of it, and no leader card', async () => {
        // The one cross-tenant reader, and they are named as acting inside the office
        // rather than given a fabricated membership.
        const sa = new RequestContext('u-root', 'super_admin', null, null, KPM_A);
        const result = await tree.read(sa);

        expect(result.nodes.map((n) => n.membershipId).sort()).toEqual([root, ab, aab, agent].sort());
        expect(result.selfId).toBeNull();
        expect(result.leader).toBeNull();
        expect(result.nodes.some((n) => n.isSelf)).toBe(false);
      });

      it('shows nothing to somebody in the office who is not a member of it', async () => {
        // An absent filter would return the tenant, so the rule fails closed with an
        // impossible one instead.
        const nobody = new RequestContext('u-new', 'none', null, null, KPM_A);
        expect((await tree.read(nobody)).nodes).toEqual([]);
        expect((await tree.read(nobody)).rootIds).toEqual([]);
      });
    });

    describe('an office is a forest, which P3-T7 made true', () => {
      it('roots everybody whose leader is not visible, not just the office root', async () => {
        // Orphaning is a removal disposition. Rooting the query at the Owner would have
        // hidden this person and everybody under them.
        await removals.remove(await asMember(root, { isKpmOwner: true }), ab, {
          confirmation: 'REMOVE',
          subtree: { action: 'orphan' },
        });

        const owner = await asMember(root, { isKpmOwner: true });
        const result = await tree.read(owner);

        expect(result.nodes.map((n) => n.membershipId)).toContain(aab);
        expect(result.rootIds.sort()).toEqual([root, aab].sort());
      });

      it('keeps the orphan subtree attached to the orphan', async () => {
        await removals.remove(await asMember(root, { isKpmOwner: true }), ab, {
          confirmation: 'REMOVE',
          subtree: { action: 'orphan' },
        });
        const result = await tree.read(await asMember(root, { isKpmOwner: true }));
        expect(result.nodes.find((n) => n.membershipId === agent)!.leaderId).toBe(aab);
      });

      it('leaves a removed member out of the tree entirely', async () => {
        await removals.remove(await asMember(aab), agent, { confirmation: 'REMOVE' });
        const result = await tree.read(await asMember(root, { isKpmOwner: true }));
        expect(result.nodes.map((n) => n.membershipId)).not.toContain(agent);
      });

      it('leaves a pending member out — they are in no unit yet', async () => {
        const waiting = await join(KPM_A, 'agent');
        await members.updateById(ctx(KPM_A), waiting, { $set: { status: 'pending' } });
        const result = await tree.read(await asMember(root, { isKpmOwner: true }));
        expect(result.nodes.map((n) => n.membershipId)).not.toContain(waiting);
      });
    });

    describe('the breakdown', () => {
      it('counts everybody but you, as the prototype does', async () => {
        const result = await tree.read(await asMember(ab));
        // ab is self; aab and agent are below.
        expect(result.counts).toEqual({ ab: 0, aab: 1, agent: 1, total: 2 });
      });

      it('counts an AB under an AB, which the Owner prototype silently drops', async () => {
        const owner = await asMember(root, { isKpmOwner: true });
        expect((await tree.read(owner)).counts.ab).toBe(1);
      });

      it('says who leads from the graph, never from the role (OD-23)', async () => {
        const childless = await join(KPM_A, 'aab', ab);
        await hierarchy.refreshCounts(ctx(KPM_A), ab);
        const owner = await asMember(root, { isKpmOwner: true });
        const byId = new Map((await tree.read(owner)).nodes.map((n) => [n.membershipId, n]));

        expect(byId.get(childless)!.role).toBe('aab');
        expect(byId.get(childless)!.isLeader).toBe(false);
        expect(byId.get(aab)!.isLeader).toBe(true);
      });
    });

    describe('AC-3: it stays one indexed query at office scale', () => {
      it('refuses rather than truncating above the cap, naming the number', async () => {
        // A page of a tree is not a tree, so the failure is a refusal rather than a
        // wrong org chart drawn from a slice. The repository is doubled because
        // inserting 2001 memberships to prove one branch is not worth the minute.
        const oversized = new OrgTreeService(
          {
            find: async () =>
              Array.from({ length: ORG_TREE_MAX_NODES + 1 }, (_, i) => ({
                _id: `m${i}`, userId: `u${i}`, role: 'agent', depth: 0, leaderId: null,
                agentCode: `KPM-${i}`, directCounts: { total: 0 }, subtreeCount: 0,
              })),
          } as never,
          users as never,
        );

        await expect(oversized.read(ctx(KPM_A))).rejects.toMatchObject({
          code: 'ORG_TREE_TOO_LARGE',
          details: { count: ORG_TREE_MAX_NODES + 1, max: ORG_TREE_MAX_NODES },
        });
      });

      it('names somebody whose user row has gone rather than dropping their card', async () => {
        // The membership is the record of participation; the user row is global and
        // could be erased under PDP. A hole in the tree would hide a whole subtree.
        const row = await members.findById(ctx(KPM_A), agent);
        await users.deleteOne({ _id: row!.userId });

        const result = await tree.read(await asMember(root, { isKpmOwner: true }));
        const orphanNode = result.nodes.find((n) => n.membershipId === agent);
        expect(orphanNode).toBeDefined();
        expect(orphanNode!.fullName).toBe('Unknown');
      });

      it('reads the whole office with one indexed query and no collection scan', async () => {
        // performance-and-scale.md requires an explain() assertion on every list
        // endpoint. This is the first one, and the tree is the widest read in the
        // product — 500 members in a single response.
        const model = mongoose.model(Membership.name);
        const plan = await model
          .find({ kpmId: KPM_A, status: 'active', deletedAt: null })
          .sort({ agentSeq: 1 })
          .explain('executionStats');

        const winning = JSON.stringify((plan as unknown as { queryPlanner: unknown }).queryPlanner);
        expect(winning).not.toContain('COLLSCAN');
        expect(winning).toContain('IXSCAN');
      });

      it('reads a downline with one indexed query too', async () => {
        const model = mongoose.model(Membership.name);
        const plan = await model
          .find({ kpmId: KPM_A, ancestorIds: ab, status: 'active', deletedAt: null })
          .explain('executionStats');

        const winning = JSON.stringify((plan as unknown as { queryPlanner: unknown }).queryPlanner);
        expect(winning).not.toContain('COLLSCAN');
      });

      it('does not fan out: one query for members, one for names, whatever the size', async () => {
        for (let i = 0; i < 40; i += 1) await join(KPM_A, 'agent', aab);
        await hierarchy.refreshCounts(ctx(KPM_A), aab);

        const owner = await asMember(root, { isKpmOwner: true });
        const before = mongoose.connection.db;
        expect(before).toBeDefined();

        const result = await tree.read(owner);
        expect(result.nodes).toHaveLength(44);
        // Every name resolved, so the second query covered all of them.
        expect(result.nodes.every((n) => n.fullName !== 'Unknown')).toBe(true);
      });
    });
  });

  describe('removal, orphaning and re-entry (P3-T7)', () => {
    async function asMember(
      membershipId: string,
      over: Partial<{ isKpmOwner: boolean; isKpmAdmin: boolean }> = {},
    ) {
      const row = await members.findById(ctx(KPM_A), membershipId);
      return new RequestContext(row!.userId, 'none', {
        membershipId,
        kpmId: KPM_A,
        hierarchyRole: row!.role as 'ab' | 'aab' | 'agent',
        status: 'active',
        isKpmOwner: over.isKpmOwner ?? false,
        isKpmAdmin: over.isKpmAdmin ?? false,
        directCount: row!.directCounts?.total ?? 0,
      });
    }

    const CONFIRM = { confirmation: 'REMOVE' };

    let ab: string;
    let aab: string;
    let agent: string;
    let abCtx: RequestContext;

    beforeEach(async () => {
      ab = await join(KPM_A, 'ab');
      aab = await join(KPM_A, 'aab', ab);
      agent = await join(KPM_A, 'agent', ab);
      await hierarchy.refreshCounts(ctx(KPM_A), ab);
      abCtx = await asMember(ab);
    });

    describe('AC-1: the typed confirmation', () => {
      it('refuses without the word, before it even looks the person up', async () => {
        await expect(
          removals.remove(abCtx, agent, { confirmation: '' }),
        ).rejects.toMatchObject({ code: 'ORG_REMOVAL_NOT_CONFIRMED' });

        const row = await members.findById(ctx(KPM_A), agent);
        expect(row!.status).toBe('active');
      });

      it('refuses a near miss', async () => {
        for (const word of ['REMOV', 'REMOVED', 'delete', 'REMOVE ME']) {
          await expect(
            removals.remove(abCtx, agent, { confirmation: word }),
          ).rejects.toMatchObject({ code: 'ORG_REMOVAL_NOT_CONFIRMED' });
        }
      });

      it('accepts it trimmed and in any case, exactly as the prototype does', async () => {
        await removals.remove(abCtx, agent, { confirmation: '  remove  ' });
        const row = await members.findById(ctx(KPM_A), agent);
        expect(row!.status).toBe('removed');
      });

      it('checks the word even for somebody who could otherwise remove them', async () => {
        // The gate is not a permission. A tenant admin types it too.
        const owner = await asMember(ab, { isKpmOwner: true });
        await expect(
          removals.remove(owner, agent, { confirmation: 'yes' }),
        ).rejects.toMatchObject({ code: 'ORG_REMOVAL_NOT_CONFIRMED' });
      });
    });

    describe('AC-2: nothing is deleted', () => {
      it('keeps the row, the agent code and the leader they had', async () => {
        const before = await members.findById(ctx(KPM_A), agent);
        await removals.remove(abCtx, agent, { ...CONFIRM, reason: 'Left the industry' });

        const after = await members.findById(ctx(KPM_A), agent);
        expect(after).not.toBeNull();
        expect(after!.agentCode).toBe(before!.agentCode);
        expect(after!.role).toBe(before!.role);
        // Kept, not blanked: it is who they reported to when they left.
        expect(after!.leaderId).toBe(ab);
        expect(after!.removedAt).toBeInstanceOf(Date);
      });

      it('writes a removal event carrying the reason and who did it', async () => {
        await removals.remove(abCtx, agent, { ...CONFIRM, reason: 'Left the industry' });

        const events = await mongoose
          .model(MembershipHistory.name)
          .find({ membershipId: agent })
          .sort({ validFrom: 1 });
        const removal = events.find((e) => e.get('eventType') === 'removed');
        expect(removal).toBeDefined();
        expect(removal!.get('reason')).toBe('Left the industry');
        expect(removal!.get('actorMembershipId')).toBe(ab);
        expect(removal!.get('fromLeaderId')).toBe(ab);

        // Append-only: every earlier edge is closed, and only the removal is open.
        expect(events.filter((e) => e.get('validTo') === null)).toHaveLength(1);
      });

      it('keeps their role changes readable in the log after they are gone', async () => {
        await roles.change(abCtx, agent, 'aab', 'Ready to lead');
        await removals.remove(abCtx, agent, CONFIRM);

        const log = await roles.log(abCtx);
        expect(log.map((e) => e.membershipId)).toContain(agent);
        expect(log[0].fullName).not.toBe('Unknown');
      });

      it('leaves them out of the roster, and findable when asked for', async () => {
        await removals.remove(abCtx, agent, CONFIRM);

        const roster = await directory.list(abCtx, {});
        expect(roster.members.map((m) => m.membershipId)).not.toContain(agent);

        const removed = await directory.list(abCtx, { status: 'removed' });
        expect(removed.members.map((m) => m.membershipId)).toEqual([agent]);
        expect(removed.members[0].removedAt).not.toBeNull();
      });

      it('still reads one by one, so a link from the log does not dead-end', async () => {
        await removals.remove(abCtx, agent, CONFIRM);
        const one = await directory.read(abCtx, agent);
        expect(one.status).toBe('removed');
      });
    });

    describe('AC-3: their reports have to go somewhere', () => {
      let under: string;

      beforeEach(async () => {
        under = await join(KPM_A, 'agent', aab);
        await hierarchy.refreshCounts(ctx(KPM_A), aab);
      });

      it('refuses removal with no disposition, naming the count', async () => {
        await expect(removals.remove(abCtx, aab, CONFIRM)).rejects.toMatchObject({
          code: 'ORG_SUBTREE_DISPOSITION_REQUIRED',
          details: { directCount: 1 },
        });
        expect((await members.findById(ctx(KPM_A), aab))!.status).toBe('active');
      });

      it('reassigns them, and the moved person keeps a legible history', async () => {
        await removals.remove(abCtx, aab, {
          ...CONFIRM,
          subtree: { action: 'reassign', toMembershipId: ab },
        });

        const moved = await members.findById(ctx(KPM_A), under);
        expect(moved!.leaderId).toBe(ab);
        expect(moved!.ancestorIds).toEqual([ab]);
        expect(moved!.depth).toBe(1);

        // The move is its own event, not something to infer from a removal.
        const events = await mongoose.model(MembershipHistory.name).find({ membershipId: under });
        expect(events.some((e) => e.get('eventType') === 're_parented')).toBe(true);
      });

      it('orphans them, which puts them back in the untagged pool', async () => {
        await removals.remove(abCtx, aab, { ...CONFIRM, subtree: { action: 'orphan' } });

        const orphan = await members.findById(ctx(KPM_A), under);
        expect(orphan!.leaderId).toBeNull();
        expect(orphan!.ancestorIds).toEqual([]);
        expect(orphan!.status).toBe('active');

        const pool = await approvals.untagged(abCtx);
        expect(pool.map((p) => p.membershipId)).toContain(under);
      });

      it('refuses moving them to the person being removed', async () => {
        await expect(
          removals.remove(abCtx, aab, {
            ...CONFIRM,
            subtree: { action: 'reassign', toMembershipId: aab },
          }),
        ).rejects.toMatchObject({ code: 'ORG_SUBTREE_DISPOSITION_REQUIRED' });
      });

      it('moves a whole unit, not just the first of it', async () => {
        const second = await join(KPM_A, 'agent', aab);
        await hierarchy.refreshCounts(ctx(KPM_A), aab);

        await removals.remove(abCtx, aab, {
          ...CONFIRM,
          subtree: { action: 'reassign', toMembershipId: ab },
        });

        for (const id of [under, second]) {
          expect((await members.findById(ctx(KPM_A), id))!.leaderId).toBe(ab);
        }
      });

      it('re-splices a deeper subtree rather than only its top', async () => {
        const deep = await join(KPM_A, 'agent', under);
        await hierarchy.refreshCounts(ctx(KPM_A), under);

        await removals.remove(abCtx, aab, {
          ...CONFIRM,
          subtree: { action: 'reassign', toMembershipId: ab },
        });

        const grandchild = await members.findById(ctx(KPM_A), deep);
        expect(grandchild!.ancestorIds).toEqual([ab, under]);
        expect(grandchild!.depth).toBe(2);
      });

      it('counts them in the plural, and carries the reason into the moves', async () => {
        await join(KPM_A, 'agent', aab);
        await hierarchy.refreshCounts(ctx(KPM_A), aab);

        await expect(removals.remove(abCtx, aab, CONFIRM)).rejects.toMatchObject({
          code: 'ORG_SUBTREE_DISPOSITION_REQUIRED',
          message: expect.stringContaining('2 people report'),
        });

        await removals.remove(abCtx, aab, {
          ...CONFIRM,
          reason: 'Left the industry',
          subtree: { action: 'reassign', toMembershipId: ab },
        });

        // Why somebody moved is the question asked when reading it back, and the answer
        // is on the move rather than only on the removal that caused it.
        const moved = await mongoose
          .model(MembershipHistory.name)
          .find({ membershipId: under, eventType: 're_parented' });
        expect(moved[0].get('reason')).toContain('Left the industry');
      });

      it('a disposition on somebody who leads nobody changes nothing', async () => {
        await removals.remove(abCtx, agent, {
          ...CONFIRM,
          subtree: { action: 'orphan' },
        });
        expect((await members.findById(ctx(KPM_A), agent))!.status).toBe('removed');
      });

      it('leaves the office untouched when the disposition is refused', async () => {
        await expect(removals.remove(abCtx, aab, CONFIRM)).rejects.toThrow();
        expect((await members.findById(ctx(KPM_A), under))!.leaderId).toBe(aab);
      });
    });

    describe('who may remove whom', () => {
      it('refuses somebody who is not their direct leader', async () => {
        const aabCtx = await asMember(aab);
        await expect(removals.remove(aabCtx, agent, CONFIRM)).rejects.toMatchObject({
          code: 'ORG_REMOVAL_NOT_PERMITTED',
        });
      });

      it('lets a tenant admin remove anybody in the office', async () => {
        const owner = await asMember(ab, { isKpmOwner: true });
        const deep = await join(KPM_A, 'agent', aab);
        await hierarchy.refreshCounts(ctx(KPM_A), aab);

        await removals.remove(owner, deep, CONFIRM);
        expect((await members.findById(ctx(KPM_A), deep))!.status).toBe('removed');
      });

      it('refuses removing yourself', async () => {
        const aabCtx = await asMember(aab);
        await expect(removals.remove(aabCtx, aab, CONFIRM)).rejects.toMatchObject({
          code: 'ORG_REMOVAL_NOT_PERMITTED',
        });
      });

      it('refuses removing the root, which nobody could put back', async () => {
        const owner = await asMember(ab, { isKpmOwner: true });
        const root = await join(KPM_A, 'ab');
        await expect(removals.remove(owner, root, CONFIRM)).rejects.toMatchObject({
          code: 'ORG_REMOVAL_NOT_PERMITTED',
        });
      });

      it('refuses removing them twice, saying when the first one was', async () => {
        await removals.remove(abCtx, agent, CONFIRM);
        await expect(removals.remove(abCtx, agent, CONFIRM)).rejects.toMatchObject({
          code: 'ORG_ALREADY_REMOVED',
        });
      });

      it('never reaches another office member', async () => {
        const theirs = await join(KPM_B, 'agent');
        await expect(removals.remove(abCtx, theirs, CONFIRM)).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
      });

      it('refuses somebody in no office', async () => {
        const nowhere = new RequestContext('u-root', 'super_admin', null);
        await expect(removals.remove(nowhere, agent, CONFIRM)).rejects.toMatchObject({
          code: 'TENANT_NO_MEMBERSHIP',
        });
      });
    });

    describe('the leader they left', () => {
      it('loses them from the counts, by role and in total', async () => {
        await removals.remove(abCtx, agent, CONFIRM);
        const leader = await members.findById(ctx(KPM_A), ab);
        expect(leader!.directCounts.total).toBe(1);
        expect(leader!.directCounts.agent).toBe(0);
        expect(leader!.directCounts.aab).toBe(1);
      });

      it('no longer lists them as a report', async () => {
        await removals.remove(abCtx, agent, CONFIRM);
        expect((await roles.team(abCtx)).map((t) => t.membershipId)).not.toContain(agent);
      });

      it('tells the person, with what to do next', async () => {
        const userId = (await members.findById(ctx(KPM_A), agent))!.userId;
        sent = [];
        await removals.remove(abCtx, agent, { ...CONFIRM, reason: 'Left the industry' });

        const note = sent.find((n) => n.templateId === 'member.removed');
        expect(note).toBeDefined();
        expect(note!.userId).toBe(userId);
        // The reason and the way back, because being told only that you are out is the
        // prototype's dead end.
        expect(note!.payload).toMatchObject({
          reason: 'Left the industry',
          nextStep: expect.stringContaining('request to join again'),
        });
      });
    });

    describe('AC-4: coming back', () => {
      it('gives a new membership and a new agent code, keeping the old row', async () => {
        const oldRow = await members.findById(ctx(KPM_A), agent);
        const userId = oldRow!.userId;
        await removals.remove(abCtx, agent, CONFIRM);

        const rejoined = await hierarchy.create(ctx(KPM_A), { userId, role: 'agent', status: 'pending' });

        expect(String(rejoined._id)).not.toBe(agent);
        expect(rejoined.agentCode).not.toBe(oldRow!.agentCode);
        // Both rows are theirs, and both stay.
        const all = await members.find(ctx(KPM_A), { userId });
        expect(all).toHaveLength(2);
        expect(all.filter((m) => m.status === 'removed')).toHaveLength(1);
      });

      it('does not reopen the old membership, so the two spells stay separate', async () => {
        const userId = (await members.findById(ctx(KPM_A), agent))!.userId;
        await roles.change(abCtx, agent, 'aab', 'Led a unit last time');
        await removals.remove(abCtx, agent, CONFIRM);
        await hierarchy.create(ctx(KPM_A), { userId, role: 'agent', status: 'pending' });

        const old = await members.findById(ctx(KPM_A), agent);
        expect(old!.status).toBe('removed');
        expect(old!.role).toBe('aab'); // what they were when they left, not what they are now
      });

      it('refuses a second live membership while the first is live', async () => {
        // The partial unique index is what makes re-entry safe: it exempts `removed`
        // rows and nothing else.
        const userId = (await members.findById(ctx(KPM_A), agent))!.userId;
        await expect(
          hierarchy.create(ctx(KPM_A), { userId, role: 'agent', status: 'pending' }),
        ).rejects.toThrow();
      });
    });
  });

  describe('role changes (P3-T6)', () => {
    async function asMember(
      membershipId: string,
      over: Partial<{ isKpmOwner: boolean; isKpmAdmin: boolean }> = {},
    ) {
      const row = await members.findById(ctx(KPM_A), membershipId);
      return new RequestContext(row!.userId, 'none', {
        membershipId,
        kpmId: KPM_A,
        hierarchyRole: row!.role as 'ab' | 'aab' | 'agent',
        status: 'active',
        isKpmOwner: over.isKpmOwner ?? false,
        isKpmAdmin: over.isKpmAdmin ?? false,
        directCount: row!.directCounts?.total ?? 0,
      });
    }

    let ab: string;
    let aab: string;
    let agent: string;
    let abCtx: RequestContext;

    beforeEach(async () => {
      ab = await join(KPM_A, 'ab');
      aab = await join(KPM_A, 'aab', ab);
      agent = await join(KPM_A, 'agent', ab);
      await hierarchy.refreshCounts(ctx(KPM_A), ab);
      abCtx = await asMember(ab);
    });

    it('lists a leader team, with what they may do to each', async () => {
      const team = await roles.team(abCtx);
      expect(team.map((t) => t.membershipId).sort()).toEqual([aab, agent].sort());
      expect(team.every((t) => t.canChangeRole)).toBe(true);
    });

    it('AC-1: never offers the control for an AB report, even to their leader', async () => {
      const otherAb = await join(KPM_A, 'ab', ab);
      await hierarchy.refreshCounts(ctx(KPM_A), ab);

      const team = await roles.team(await asMember(ab));
      expect(team.find((t) => t.membershipId === otherAb)?.canChangeRole).toBe(false);
    });

    it('AC-1: promotes an agent to AAB, and back', async () => {
      await roles.change(abCtx, agent, 'aab');
      expect((await members.findById(ctx(KPM_A), agent))?.role).toBe('aab');

      await roles.change(abCtx, agent, 'agent');
      expect((await members.findById(ctx(KPM_A), agent))?.role).toBe('agent');
    });

    it('never moves anybody — a role change is a statement, not a reorganisation', async () => {
      // The prototype's own copy says so: "they'll keep reporting to you".
      const before = await members.findById(ctx(KPM_A), agent);
      await roles.change(abCtx, agent, 'aab');
      const after = await members.findById(ctx(KPM_A), agent);

      expect(after?.leaderId).toBe(before?.leaderId);
      expect(after?.ancestorIds).toEqual(before?.ancestorIds);
      expect(after?.depth).toBe(before?.depth);
    });

    it('AC-2: writes a role_changed row with both roles, the actor and the reason', async () => {
      await roles.change(abCtx, agent, 'aab', '  Ready to lead  ');

      const rows = await mongoose
        .model(MembershipHistory.name)
        .find({ membershipId: agent, eventType: 'role_changed' });
      expect(rows).toHaveLength(1);
      expect(rows[0].get('fromRole')).toBe('agent');
      expect(rows[0].get('toRole')).toBe('aab');
      expect(rows[0].get('actorMembershipId')).toBe(ab);
      expect(rows[0].get('reason')).toBe('Ready to lead');
      expect(rows[0].get('validTo')).toBeNull();
    });

    it('closes the previous role edge rather than overwriting it', async () => {
      await roles.change(abCtx, agent, 'aab');
      clock.advance(60_000);
      await roles.change(abCtx, agent, 'agent');

      const rows = await mongoose
        .model(MembershipHistory.name)
        .find({ membershipId: agent, eventType: 'role_changed' })
        .sort({ validFrom: 1 });
      expect(rows).toHaveLength(2);
      expect(rows[0].get('validTo')).not.toBeNull();
      expect(rows[1].get('validTo')).toBeNull();
    });

    it('updates the leader counts, which break down by role', async () => {
      await roles.change(abCtx, agent, 'aab');
      const leader = await members.findById(ctx(KPM_A), ab);
      expect(leader?.directCounts).toMatchObject({ aab: 2, agent: 0, total: 2 });
    });

    it('tells them', async () => {
      const row = await members.findById(ctx(KPM_A), agent);
      sent.length = 0;
      await roles.change(abCtx, agent, 'aab');
      expect(sent[0]).toMatchObject({ userId: row!.userId, templateId: 'member.role_changed' });
    });

    it('does nothing when the role is already what was asked for', async () => {
      await roles.change(abCtx, agent, 'agent');
      const rows = await mongoose
        .model(MembershipHistory.name)
        .countDocuments({ membershipId: agent, eventType: 'role_changed' });
      expect(rows).toBe(0);
    });

    describe('AC-3: demoting somebody who leads people', () => {
      it('refuses, and says how many, rather than orphaning them silently', async () => {
        await join(KPM_A, 'agent', aab);
        await join(KPM_A, 'agent', aab);
        await hierarchy.refreshCounts(ctx(KPM_A), aab);

        const err = await roles.change(abCtx, aab, 'agent').catch((e) => e);
        expect(err.code).toBe('ORG_HAS_DIRECT_REPORTS');
        expect(err.details.directCount).toBe(2);
        // And nothing changed.
        expect((await members.findById(ctx(KPM_A), aab))?.role).toBe('aab');
      });

      it('allows it once nobody reports to them', async () => {
        await expect(roles.change(abCtx, aab, 'agent')).resolves.toBeDefined();
        expect((await members.findById(ctx(KPM_A), aab))?.role).toBe('agent');
      });

      it('does not block a promotion, which orphans nobody', async () => {
        await join(KPM_A, 'agent', aab);
        await hierarchy.refreshCounts(ctx(KPM_A), aab);
        await expect(roles.change(abCtx, aab, 'ab')).rejects.toMatchObject({
          // Refused for a different reason: AB is not a leader's call.
          code: 'ORG_ROLE_CHANGE_NOT_PERMITTED',
        });
      });
    });

    describe('who may change what', () => {
      it('refuses a leader who is not the direct one', async () => {
        const stranger = await join(KPM_A, 'ab');
        await expect(roles.change(await asMember(stranger), agent, 'aab')).rejects.toMatchObject({
          code: 'ORG_ROLE_CHANGE_NOT_PERMITTED',
        });
      });

      it('refuses a direct leader making somebody an AB', async () => {
        await expect(roles.change(abCtx, agent, 'ab')).rejects.toMatchObject({
          code: 'ORG_ROLE_CHANGE_NOT_PERMITTED',
        });
      });

      it('refuses a direct leader unmaking an AB', async () => {
        const abReport = await join(KPM_A, 'ab', ab);
        await expect(roles.change(abCtx, abReport, 'agent')).rejects.toMatchObject({
          code: 'ORG_ROLE_CHANGE_NOT_PERMITTED',
        });
      });

      it('allows the Owner anything, including AB, and anywhere in the office', async () => {
        const ownerCtx = await asMember(ab, { isKpmOwner: true });
        await expect(roles.change(ownerCtx, agent, 'ab')).resolves.toBeDefined();
        expect((await members.findById(ctx(KPM_A), agent))?.role).toBe('ab');
      });

      it('allows an Admin the same, and somebody they do not lead', async () => {
        const other = await join(KPM_A, 'aab');
        const adminCtx = await asMember(ab, { isKpmAdmin: true });
        await expect(roles.change(adminCtx, other, 'agent')).resolves.toBeDefined();
      });

      it('never reaches another office', async () => {
        const theirs = await join(KPM_B, 'agent');
        await expect(roles.change(abCtx, theirs, 'aab')).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
      });
    });

    describe('the log', () => {
      it('reads back what changed, who did it and why, newest first', async () => {
        await roles.change(abCtx, agent, 'aab', 'Ready to lead');
        clock.advance(60_000);
        await roles.change(abCtx, agent, 'agent', 'Stepping back');

        const log = await roles.log(abCtx);
        expect(log).toHaveLength(2);
        expect(log[0]).toMatchObject({ fromRole: 'aab', toRole: 'agent', reason: 'Stepping back' });
        expect(log[0].actorName).toBeTruthy();
        expect(log[0].agentCode).toBeTruthy();
        expect(log[1]).toMatchObject({ fromRole: 'agent', toRole: 'aab' });
      });

      it('is empty before anything has changed', async () => {
        expect(await roles.log(abCtx)).toEqual([]);
      });

      it('refuses every surface to somebody in no office', async () => {
        // A Super Admin has the permission but no membership, so "your team" and "your
        // office's log" have no meaning for them. Answering [] would read as an empty
        // office rather than the wrong question.
        const nowhere = new RequestContext('u-root', 'super_admin', null);
        await expect(roles.team(nowhere)).rejects.toMatchObject({
          code: 'TENANT_NO_MEMBERSHIP',
        });
        await expect(roles.log(nowhere)).rejects.toMatchObject({
          code: 'TENANT_NO_MEMBERSHIP',
        });
        await expect(roles.change(nowhere, agent, 'aab')).rejects.toMatchObject({
          code: 'TENANT_NO_MEMBERSHIP',
        });
      });

      it('never shows another office changes', async () => {
        const theirAb = await join(KPM_B, 'ab');
        const theirAgent = await join(KPM_B, 'agent', theirAb);
        await hierarchy.refreshCounts(ctx(KPM_B), theirAb);
        await roles.change(await (async () => {
          const row = await members.findById(ctx(KPM_B), theirAb);
          return new RequestContext(row!.userId, 'none', {
            membershipId: theirAb, kpmId: KPM_B, hierarchyRole: 'ab', status: 'active',
            isKpmOwner: false, isKpmAdmin: false, directCount: 1,
          });
        })(), theirAgent, 'aab');

        expect(await roles.log(abCtx)).toEqual([]);
      });
    });
  });
});
