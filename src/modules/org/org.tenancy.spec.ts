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
    // The partial unique index is the guarantee under test, not a background detail.
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    for (const [id, code] of [[KPM_A, '0417'], [KPM_B, '0555']]) {
      await mongoose.model(Kpm.name).create({
        _id: id, companyId: 'co-1', code, branchName: `Branch ${code}`,
        counters: { nextAgentCodeSeq: 1 },
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
});
