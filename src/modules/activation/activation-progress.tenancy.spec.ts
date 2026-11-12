import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { AuditService } from '@/modules/audit/audit.service';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { ApprovalsService } from '@/modules/org/approvals.service';
import type { ActivationStarter } from '@/modules/org/activation-starter.port';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { JoinRequest, JoinRequestSchema } from '@/modules/org/join-request.schema';
import { LeaderCodeService } from '@/modules/org/leader-code.service';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { JoinRequestRepository, MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { RemovalService } from '@/modules/org/removal.service';
import { RoleChangeService } from '@/modules/org/role-change.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { addDays } from '@/common/time/local-day';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import type { ActivationProgressDocument } from './activation-progress.schema';

/** 23:30 UTC on the 14th: already 06:30 on the 15th in Jakarta, the office's today. */
const NOW = new Date('2026-09-14T23:30:00Z');
const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();

/**
 * **One activation per hire, created where a person joins under a leader** (P13-T1), and the collection's
 * isolation (AC-8). The org services are the real ones, given the real activation service as their
 * `ActivationStarter`, so what is proven is what approving, tagging and redeeming a code actually start.
 */
describe('the activation instance (P13-T1)', () => {
  let wired: ReturnType<typeof configModule>;
  let hierarchy: HierarchyService;
  let approvals: ApprovalsService;
  let codes: LeaderCodeService;
  let removals: RemovalService;
  let members: MembershipRepository;
  let companyId: string;
  let seq = 0;
  const starter = () => wired.activationProgress as unknown as ActivationStarter;
  const notifications = { send: async () => undefined } as never;
  const office = (kpmId: string) => RequestContext.forJob(kpmId, 'activation-spec');
  const activations = (filter: Record<string, unknown> = {}) =>
    mongoose.connection.db!.collection('activationProgress').find(filter).toArray();

  function buildOrg(withStarter: ActivationStarter | null) {
    const users = mongoose.model(User.name, UserSchema);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    const history = new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never);
    const requests = new JoinRequestRepository(mongoose.model(JoinRequest.name, JoinRequestSchema) as never);
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    const clock = wired.clock;
    hierarchy = new HierarchyService(members, kpms as never, users as never, history, clock, wired.orgLevels);
    approvals = new ApprovalsService(members, hierarchy, requests, history, users as never, audit, notifications, clock, withStarter);
    codes = new LeaderCodeService(
      members, hierarchy, requests, approvals, kpms as never, mongoose.model(Company.name, CompanySchema) as never,
      users as never, audit, notifications, clock, withStarter,
    );
    const roles = new RoleChangeService(members, hierarchy, history, users as never, audit, notifications, clock);
    removals = new RemovalService(members, hierarchy, roles, history, audit, notifications, clock);
  }

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    (wired.clock as FixedClock).set(NOW);
    buildOrg(starter());
    const company = await mongoose.model(Company.name, CompanySchema).create({ name: 'Prudential', slug: `pru-${Math.random()}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    for (const [kpmId, code] of [[KPM_A, '0417'], [KPM_B, '0555']]) {
      await mongoose.model(Kpm.name, KpmSchema).create({
        _id: kpmId, companyId, code, branchName: `Branch ${code}`, counters: { nextMemberSeq: 1 }, status: 'active',
        timezone: 'Asia/Jakarta',
      });
    }
    await provisionOffice(wired, KPM_A, companyId);
    await provisionOffice(wired, KPM_B, companyId);
  });

  async function person() {
    seq += 1;
    const user = await mongoose.model(User.name, UserSchema).create({
      email: `hire${seq}@activation.test`, passwordHash: 'x', fullName: `Hire ${seq}`, status: 'active',
      platformRole: 'none', companyId, agentCode: `PRU-9${String(seq).padStart(4, '0')}`,
    });
    return String(user._id);
  }

  /** A member, signed in as themselves: `membershipId`, rung, and the context to act as them. */
  async function member(kpmId: string, role: 'ab' | 'aab' | 'agent', leaderId: string | null, status: 'active' | 'pending' = 'active') {
    const userId = await person();
    const m = await hierarchy.create(office(kpmId), { userId, role, leaderId, status });
    return {
      id: String(m._id), userId, leaderCode: m.leaderCode,
      ctx: new RequestContext(userId, 'none', {
        membershipId: String(m._id), kpmId, orgLevelCode: role.toUpperCase(), hierarchyRole: role, status,
        isKpmOwner: role === 'ab' && leaderId === null, isKpmAdmin: false, directCount: 1,
      }),
    };
  }

  async function requestFrom(membershipId: string, leaderMembershipId: string) {
    const row = await mongoose.model(JoinRequest.name, JoinRequestSchema).create({
      kpmId: KPM_A, membershipId, leaderMembershipId, status: 'pending',
    });
    return String(row._id);
  }

  describe('creation (OD-119, AC-1)', () => {
    it('P13-T1 AC-1 an approved request starts exactly one, pinned to the published version, on the join date in the office’s zone', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const joiner = await member(KPM_A, 'agent', null, 'pending');
      await approvals.approve(leader.ctx, await requestFrom(joiner.id, leader.id));

      const rows = await activations();
      const published = (await wired.activation.publishedNow(office(KPM_A)))!;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kpmId: KPM_A, membershipId: joiner.id, templateId: published.id, templateVersion: 1,
        // 23:30 UTC on the 14th is the 15th in Jakarta.
        startDate: '2026-09-15', origin: 'joined', graduatedAt: null, note: null, version: 1, deletedAt: null,
        createdBy: leader.id,
      });
      expect(rows[0].items).toHaveLength(16);
      expect(rows[0].items.every((i: { done: boolean }) => i.done === false)).toBe(true);
    });

    it('P13-T1 AC-1 a leader’s tag of a registrant starts one', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const joiner = await member(KPM_A, 'agent', null, 'pending');
      await approvals.tag(leader.ctx, joiner.id);
      expect((await activations()).map((r) => r.membershipId)).toEqual([joiner.id]);
    });

    it('P13-T1 AC-1 a leader’s code starts one, created in the joiner’s own name', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const userId = await person();
      await codes.redeem(new RequestContext(userId, 'none', null), leader.leaderCode);
      const rows = await activations();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kpmId: KPM_A, startDate: '2026-09-15', createdBy: null, templateVersion: 1 });
    });

    it('P13-T1 AC-1 a placement at another rung starts none: an AAB approved under an AB', async () => {
      const leader = await member(KPM_A, 'ab', null);
      const joiner = await member(KPM_A, 'aab', null, 'pending');
      await approvals.approve(leader.ctx, await requestFrom(joiner.id, leader.id));
      expect(await activations()).toEqual([]);
    });

    it('P13-T1 AC-1 a roster import and an office’s creation start none: the membership the import writes is not a join', async () => {
      const leader = await member(KPM_A, 'aab', null);
      // What `RosterImportService` and `TenantService` do: create the member active, with or without a leader.
      await hierarchy.create(office(KPM_A), { userId: await person(), role: 'agent', leaderId: leader.id, status: 'active' });
      await hierarchy.create(office(KPM_A), { userId: await person(), role: 'ab', leaderId: null, status: 'active' });
      expect(await activations()).toEqual([]);
      // And neither of them can: only the three placements reach the port.
      const src = join(__dirname, '..');
      for (const file of ['tenants/roster-import.service.ts', 'tenants/tenant.service.ts', 'org/hierarchy.service.ts', 'org/onboarding.service.ts']) {
        expect([file, readFileSync(join(src, file), 'utf8').includes('ActivationStarter')]).toEqual([file, false]);
      }
      for (const file of ['org/approvals.service.ts', 'org/leader-code.service.ts']) {
        expect([file, readFileSync(join(src, file), 'utf8').includes('startActivation(this.activations')]).toEqual([file, true]);
      }
    });

    it('P13-T1 AC-1 an imported member placed under a leader later is moved, not joined: still none', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const imported = await member(KPM_A, 'agent', null);
      await approvals.tag(leader.ctx, imported.id);
      expect(await activations()).toEqual([]);
    });

    it('P13-T1 AC-1 a second placement of the same membership creates nothing', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const joiner = await member(KPM_A, 'agent', null, 'pending');
      await approvals.tag(leader.ctx, joiner.id);
      await starter().joined(leader.ctx, joiner.id);
      await wired.activationProgress.joined(leader.ctx, joiner.id);
      expect(await activations()).toHaveLength(1);
    });

    it('P13-T1 AC-1 a re-join starts afresh on the new membership and leaves the old one as it was (ADR-0022)', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const first = await member(KPM_A, 'agent', null, 'pending');
      await approvals.tag(leader.ctx, first.id);
      await removals.remove(leader.ctx, first.id, { confirmation: 'REMOVE' });
      const old = (await activations())[0];

      const again = await hierarchy.create(office(KPM_A), { userId: first.userId, role: 'agent', leaderId: null, status: 'pending' });
      (wired.clock as FixedClock).set(new Date('2026-10-01T03:00:00Z'));
      await approvals.tag(leader.ctx, String(again._id));

      const rows = await activations();
      expect(rows.map((r) => [r.membershipId, r.startDate])).toEqual([[first.id, '2026-09-15'], [String(again._id), '2026-10-01']]);
      expect(rows[0]).toEqual(old);
    });

    it('P13-T1 AC-2 creation fails open: a starter that throws leaves the placement standing', async () => {
      buildOrg({ joined: async () => { throw new Error('the activation store is down'); } });
      const leader = await member(KPM_A, 'aab', null);
      const joiner = await member(KPM_A, 'agent', null, 'pending');
      await approvals.tag(leader.ctx, joiner.id);
      expect((await members.findById(office(KPM_A), joiner.id))!.status).toBe('active');
      expect(await activations()).toEqual([]);
    });

    it('P13-T1 AC-2 a write that fails for any reason but a duplicate is the starter’s to log, never the placement’s', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const joiner = await member(KPM_A, 'agent', null, 'pending');
      jest.spyOn(wired.activationRows, 'create').mockRejectedValueOnce(new Error('disk full'));
      await approvals.tag(leader.ctx, joiner.id);
      expect((await members.findById(office(KPM_A), joiner.id))!.status).toBe('active');
      expect(await activations()).toEqual([]);
    });

    it('P13-T1 AC-2 two writers racing: the database’s unique index lets one through, and the other finds it', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const joiner = await member(KPM_A, 'agent', null, 'pending');
      await approvals.tag(leader.ctx, joiner.id);
      jest.spyOn(wired.activationRows, 'exists').mockResolvedValueOnce(false);
      await wired.activationProgress.joined(leader.ctx, joiner.id);
      expect(await activations()).toHaveLength(1);
    });

    it('P13-T1 AC-2 an office with no published checklist pins nothing, and the placement stands', async () => {
      await mongoose.connection.db!.collection('activationTemplates').updateMany({ kpmId: KPM_A }, { $set: { deletedAt: NOW } });
      const leader = await member(KPM_A, 'aab', null);
      const joiner = await member(KPM_A, 'agent', null, 'pending');
      await approvals.tag(leader.ctx, joiner.id);
      expect((await members.findById(office(KPM_A), joiner.id))!.status).toBe('active');
      expect(await activations()).toEqual([]);
    });

    it('P13-T1 AC-2 a version that has gone from under a running activation is a 404, not a crash', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const joiner = await member(KPM_A, 'agent', null, 'pending');
      await approvals.tag(leader.ctx, joiner.id);
      await mongoose.connection.db!.collection('activationTemplates').updateMany({ kpmId: KPM_A }, { $set: { deletedAt: NOW } });
      await expect(wired.activationProgress.mine(new RequestContext(joiner.userId, 'none', {
        ...joiner.ctx.membership!, status: 'active',
      }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('moves (D-moves, AC-7)', () => {
    it('P13-T1 AC-7 a removal leaves the activation as it was, with the membership', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const joiner = await member(KPM_A, 'agent', null, 'pending');
      await approvals.tag(leader.ctx, joiner.id);
      const before = await activations();
      await removals.remove(leader.ctx, joiner.id, { confirmation: 'REMOVE' });
      expect(await activations()).toEqual(before);
    });
  });

  describe('isolation (AC-8)', () => {
    let a: ActivationProgressDocument;

    beforeEach(async () => {
      const leaderA = await member(KPM_A, 'aab', null);
      const joinerA = await member(KPM_A, 'agent', null, 'pending');
      await approvals.tag(leaderA.ctx, joinerA.id);
      const leaderB = await member(KPM_B, 'aab', null);
      const joinerB = await member(KPM_B, 'agent', null, 'pending');
      await approvals.tag(leaderB.ctx, joinerB.id);
      expect(await activations({ kpmId: KPM_B })).toHaveLength(1);
      a = (await wired.activationRows.find(office(KPM_A), {}))[0];
    });

    it('P13-T1 AC-8 office B reads none of office A’s, by id or by membership', async () => {
      expect(await wired.activationRows.findById(office(KPM_B), String(a._id))).toBeNull();
      expect(await wired.activationRows.find(office(KPM_B), { membershipId: a.membershipId })).toEqual([]);
      expect(await wired.activationProgress.latestOf(office(KPM_B), a.membershipId)).toBeNull();
      expect(await wired.activationRows.find(office(KPM_A), {})).toHaveLength(1);
    });

    it('P13-T1 AC-8 office B writes none of office A’s: a tick, a start date, a note find nothing', async () => {
      const written = await wired.activationRows.updateItems(
        office(KPM_B), { _id: a._id }, { $set: { 'items.$[it].done': true } }, [{ 'it.code': 'CRM_SETUP' }],
      );
      expect(written).toBeNull();
      const after = (await wired.activationRows.findById(office(KPM_A), String(a._id)))!;
      expect(after.version).toBe(1);
      expect(after.items.find((i) => i.code === 'CRM_SETUP')!.done).toBe(false);
    });

    it('P13-T1 AC-8 a query with no office fails closed rather than reading across offices', async () => {
      await expect(wired.activationRows.find(RequestContext.platform('root'), {})).rejects.toBeInstanceOf(MissingTenantContextError);
      await expect(wired.activationRows.updateItems(RequestContext.platform('root'), {}, { $set: {} })).rejects.toBeInstanceOf(MissingTenantContextError);
    });
  });

  /*
   * P18.8-T2 (ADR-0169): every path that makes a membership active writes its join date and classification, once,
   * in the office's calendar — and only a new hire is given an activation, by a placement or by a heal.
   */
  describe('the join date and who it makes them (P18.8-T2, ADR-0169)', () => {
    /** The office's today at NOW: 23:30 UTC on the 14th is the 15th in Jakarta. */
    const TODAY = '2026-09-15';
    const read = async (kpmId: string, id: string) => (await members.findById(office(kpmId), id))!;
    const VALIDATION = { code: 'VALIDATION_FAILED', status: 400 };

    it('P18.8-T2 AC-1 an approval with no date joins them today, in the office’s calendar, a new hire with an activation from it', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const joiner = await member(KPM_A, 'agent', null, 'pending');
      expect(await read(KPM_A, joiner.id)).toMatchObject({ joinDate: null, joinedAs: null });
      await approvals.approve(leader.ctx, await requestFrom(joiner.id, leader.id));
      // Not the 14th, which it still is in UTC.
      expect(await read(KPM_A, joiner.id)).toMatchObject({ joinDate: TODAY, joinedAs: 'new_hire' });
      expect((await activations()).map((r) => [r.membershipId, r.startDate])).toEqual([[joiner.id, TODAY]]);
    });

    it('P18.8-T2 AC-1 the boundary: 90 days back is a new hire, started on that day; 91 is an existing agent, with none', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const ninety = await member(KPM_A, 'agent', null, 'pending');
      const ninetyOne = await member(KPM_A, 'agent', null, 'pending');
      await approvals.approve(leader.ctx, await requestFrom(ninety.id, leader.id), undefined, addDays(TODAY, -90));
      await approvals.tag(leader.ctx, ninetyOne.id, addDays(TODAY, -91));

      expect(await read(KPM_A, ninety.id)).toMatchObject({ joinDate: '2026-06-17', joinedAs: 'new_hire' });
      expect(await read(KPM_A, ninetyOne.id)).toMatchObject({ joinDate: '2026-06-16', joinedAs: 'existing_agent', status: 'active' });
      // The new hire's activation starts on the join date a leader gave, not on the day they were let in.
      expect((await activations()).map((r) => [r.membershipId, r.startDate])).toEqual([[ninety.id, '2026-06-17']]);
    });

    it('P18.8-T2 AC-1 the boundary is the office’s day: at 23:30 UTC on the 14th, 16 June is 91 days back, not the UTC day’s 90', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const joiner = await member(KPM_A, 'agent', null, 'pending');
      // Counted from the UTC date, the 14th, it would be 90 days back and a new hire: the office's 15th decides.
      await approvals.tag(leader.ctx, joiner.id, '2026-06-16');
      expect((await read(KPM_A, joiner.id)).joinedAs).toBe('existing_agent');
      // An hour and a half earlier it is still the 14th in Jakarta too, and the same date is 90 days back.
      (wired.clock as FixedClock).set(new Date('2026-09-14T15:00:00Z'));
      const earlier = await member(KPM_A, 'agent', null, 'pending');
      await approvals.tag(leader.ctx, earlier.id, '2026-06-16');
      expect((await read(KPM_A, earlier.id)).joinedAs).toBe('new_hire');
    });

    it('P18.8-T2 AC-1 an existing agent may have joined years ago: accepted, classified once, given no activation', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const veteran = await member(KPM_A, 'agent', null, 'pending');
      await approvals.tag(leader.ctx, veteran.id, '2009-03-01');
      expect(await read(KPM_A, veteran.id)).toMatchObject({ joinDate: '2009-03-01', joinedAs: 'existing_agent', status: 'active' });
      expect(await activations()).toEqual([]);
      // And no later call heals one into being: the starter itself turns an existing agent away.
      await wired.activationProgress.joined(leader.ctx, veteran.id);
      expect(await activations()).toEqual([]);
    });

    it('P18.8-T2 AC-1 a date after the office’s today, before 1980 or not a day is refused 400 naming joinDate, and nothing is written', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const joiner = await member(KPM_A, 'agent', null, 'pending');
      const requestId = await requestFrom(joiner.id, leader.id);
      for (const [bad, words] of [
        ['2026-09-16', 'joinDate cannot be after today.'],
        ['1979-12-31', 'joinDate cannot be before 1980.'],
        ['2026-02-30', 'joinDate must be a real date, written YYYY-MM-DD.'],
      ]) {
        await expect(approvals.approve(leader.ctx, requestId, undefined, bad)).rejects.toMatchObject({ ...VALIDATION, message: words });
        await expect(approvals.tag(leader.ctx, joiner.id, bad)).rejects.toMatchObject({ ...VALIDATION, message: words });
      }
      // Today is not after today, in the office's calendar: the 15th is accepted though UTC says the 14th.
      expect(await read(KPM_A, joiner.id)).toMatchObject({ status: 'pending', joinDate: null, joinedAs: null, leaderId: null });
      expect(await mongoose.model(JoinRequest.name, JoinRequestSchema).findById(requestId).lean()).toMatchObject({ status: 'pending' });
      expect(await activations()).toEqual([]);
      await approvals.approve(leader.ctx, requestId, undefined, TODAY);
      expect(await read(KPM_A, joiner.id)).toMatchObject({ joinDate: TODAY, joinedAs: 'new_hire' });
    });

    it('P18.8-T2 AC-1 is set once: somebody who already has a join date keeps it and their classification through a later placement', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const other = await member(KPM_A, 'aab', null);
      const joiner = await member(KPM_A, 'agent', null, 'pending');
      await approvals.tag(leader.ctx, joiner.id, '2026-09-01');
      // Left without a leader — as a removal that orphans a unit leaves them — then picked up by another leader, with
      // a date given: a move is not a join, and the date and the classification stand.
      await members.updateById(office(KPM_A), joiner.id, { $set: { leaderId: null, ancestorIds: [], depth: 0 } });
      await approvals.tag(other.ctx, joiner.id, '2010-01-01');
      expect(await read(KPM_A, joiner.id)).toMatchObject({ joinDate: '2026-09-01', joinedAs: 'new_hire' });
    });

    it('P18.8-T2 AC-1 a leader’s code joins them today, a new hire; the roster import and the Owner are existing agents', async () => {
      const leader = await member(KPM_A, 'aab', null);
      const userId = await person();
      await codes.redeem(new RequestContext(userId, 'none', null), leader.leaderCode);
      const coded = (await members.find(office(KPM_A), { userId }))[0];
      expect(coded).toMatchObject({ joinDate: TODAY, joinedAs: 'new_hire' });
      expect((await activations()).map((r) => [r.membershipId, r.startDate])).toEqual([[String(coded._id), TODAY]]);

      // What `RosterImportService` and `TenantService` pass (ADR-0169 §6).
      const imported = await hierarchy.create(office(KPM_A), {
        userId: await person(), role: 'agent', leaderId: leader.id, status: 'active', joining: { joinedAs: 'existing_agent' },
      });
      const owner = await hierarchy.create(office(KPM_A), {
        userId: await person(), role: 'ab', leaderId: null, status: 'active', joining: { joinedAs: 'existing_agent' },
      });
      for (const m of [imported, owner]) expect(m).toMatchObject({ joinDate: TODAY, joinedAs: 'existing_agent' });
      // A pending registration has neither: nobody has let them in.
      expect(await hierarchy.create(office(KPM_A), { userId: await person(), role: 'agent', status: 'pending' }))
        .toMatchObject({ joinDate: null, joinedAs: null });
      await wired.activationProgress.joined(leader.ctx, String(imported._id));
      expect(await activations()).toHaveLength(1);
    });

    it('P18.8-T2 AC-1 cross-tenant: office A approving or tagging office B’s member with a join date reaches nothing, and writes nothing there', async () => {
      const leaderA = await member(KPM_A, 'aab', null);
      const leaderB = await member(KPM_B, 'aab', null);
      const joinerB = await member(KPM_B, 'agent', null, 'pending');
      const requestB = String((await mongoose.model(JoinRequest.name, JoinRequestSchema).create({
        kpmId: KPM_B, membershipId: joinerB.id, leaderMembershipId: leaderB.id, status: 'pending',
      }))._id);
      await expect(approvals.approve(leaderA.ctx, requestB, undefined, '2026-09-01')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(approvals.tag(leaderA.ctx, joinerB.id, '2026-09-01')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // A refused date is not even read: the reach is refused first, and answers as an absent row does.
      await expect(approvals.tag(leaderA.ctx, joinerB.id, '2099-01-01')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await read(KPM_B, joinerB.id)).toMatchObject({ status: 'pending', joinDate: null, joinedAs: null });
      expect(await activations({ kpmId: KPM_B })).toEqual([]);
    });
  });
});
