import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { PasswordService } from '@/modules/auth/password.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { ROSTER_TEMPLATE_HEADER } from '@/modules/tenants/roster-csv';
import { RosterImportService } from '@/modules/tenants/roster-import.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { ApprovalsService } from './approvals.service';
import { HierarchyService } from './hierarchy.service';
import { JoinRequest, JoinRequestSchema } from './join-request.schema';
import { countLeadersUsed } from './leader-limit';
import { LeaderLimitRequest, LeaderLimitRequestSchema } from './leader-limit-request.schema';
import { LeaderLimitRequestService, staleReason } from './leader-limit-request.service';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import {
  JoinRequestRepository, LeaderLimitRequestRepository, MembershipHistoryRepository,
} from './org.repositories';
import { RoleChangeService } from './role-change.service';

const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();
const NOW = new Date('2026-10-26T03:00:00Z');
const SA = RequestContext.platform('sa-1');

/** The office's own context, for a fixture written on its behalf. */
const office = (kpmId: string) => RequestContext.superAdminInTenant('sa-1', kpmId);

/**
 * **A leader past the limit waits for AgencyBoost's approval** (P18.8-T2, ADR-0157), over a real database: the
 * refusal says it may be asked about (AC-2); the office asks, lists and cancels (AC-3); the Super Admin's queue,
 * approval past the limit and decline (AC-4); the audit rows and the asker's notice (AC-5); and nothing crosses
 * from one office to the other (AC-8).
 *
 * KPM A has a limit of 2 and stands at it: the Owner (the root AB) and one AAB. KPM B is another office of the
 * same company, with members of its own.
 */
describe('P18.8-T2 — a leader past the limit waits for AgencyBoost', () => {
  let members: MembershipRepository;
  let hierarchy: HierarchyService;
  let roles: RoleChangeService;
  let approvals: ApprovalsService;
  let roster: RosterImportService;
  let joinRequests: JoinRequestRepository;
  let service: LeaderLimitRequestService;
  let users: mongoose.Model<User>;
  let kpms: mongoose.Model<Kpm>;
  let history: mongoose.Model<MembershipHistory>;
  let audits: mongoose.Model<AuditLog>;
  let rows: mongoose.Model<LeaderLimitRequest>;
  const sent: { userId: string; templateId: string; payload: Record<string, unknown> }[] = [];
  let companyId: string;
  let seq = 0;

  // KPM A's people.
  let owner: string;
  let aab: string;
  let agent: string;
  let other: string;

  beforeAll(async () => {
    await startMongo();
    const clock = new FixedClock(NOW);
    history = mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never;
    const historyRepo = new MembershipHistoryRepository(history as never);
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    users = mongoose.model(User.name, UserSchema) as never;
    audits = mongoose.model(AuditLog.name, AuditLogSchema) as never;
    rows = mongoose.model(LeaderLimitRequest.name, LeaderLimitRequestSchema) as never;
    const audit = new AuditService(audits as never);
    const notifications = {
      send: async (r: { userId: string; templateId: string; payload: Record<string, unknown> }) => { sent.push(r); },
    };
    members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    joinRequests = new JoinRequestRepository(mongoose.model(JoinRequest.name, JoinRequestSchema) as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never,
      mongoose.model(Company.name, CompanySchema) as never, kpms as never, audit, clock, members,
    );
    hierarchy = new HierarchyService(members, kpms as never, users as never, historyRepo, clock, orgLevels);
    roles = new RoleChangeService(members, hierarchy, historyRepo, users as never, audit, notifications as never, clock);
    approvals = new ApprovalsService(
      members, hierarchy, joinRequests, historyRepo, users as never, audit, notifications as never, clock,
    );
    roster = new RosterImportService(members, hierarchy, kpms as never, users as never, new PasswordService(), audit, clock);
    service = new LeaderLimitRequestService(
      new LeaderLimitRequestRepository(rows as never), members, hierarchy, roles, approvals, users as never,
      kpms as never, audit, notifications as never, clock,
    );
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    sent.length = 0;
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `pru-${Math.random()}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    for (const [id, code] of [[KPM_A, '0602'], [KPM_B, '0555']]) {
      await kpms.create({
        _id: id, companyId, code, branchName: `Branch ${code}`, timezone: 'Asia/Jakarta',
        counters: { nextMemberSeq: 1 }, status: 'active',
        subscription: {
          startDate: null, endDate: null, pricePerLeaderMinor: null, currency: 'IDR', maxLeaders: 2,
          keepActiveAfterEnd: false,
        },
      });
    }
    owner = await join(KPM_A, 'ab', null, 'Wilson Ownerman');
    await kpms.updateOne({ _id: KPM_A }, { $set: { ownerUserId: (await members.findById(office(KPM_A), owner))!.userId } });
    aab = await join(KPM_A, 'aab', owner, 'Sari Leader');
    agent = await join(KPM_A, 'agent', aab, 'Rina Agent');
    other = await join(KPM_A, 'agent', owner, 'Budi Agent');
  });

  async function person(fullName?: string) {
    seq += 1;
    const u = await users.create({
      email: `p${seq}@kpm.test`, passwordHash: 'x', fullName: fullName ?? `Person ${seq}`, status: 'active',
      platformRole: 'none', companyId, agentCode: `${8000 + seq}`,
    });
    return String(u._id);
  }

  async function join(
    kpmId: string, role: 'ab' | 'aab' | 'agent', leaderId: string | null, fullName?: string,
    status: 'active' | 'pending' = 'active',
  ) {
    const m = await hierarchy.create(office(kpmId), { userId: await person(fullName), role, leaderId, status });
    return String(m._id);
  }

  /** The context somebody's own sign-in would carry, read off their row. */
  async function as(
    kpmId: string, membershipId: string,
    over: { owner?: boolean; admin?: boolean; readOnly?: boolean } = {},
  ) {
    const row = await members.findById(office(kpmId), membershipId);
    const membership = {
      membershipId, kpmId: row!.kpmId, orgLevelCode: row!.orgLevelCode, hierarchyRole: row!.role,
      status: row!.status as 'active', isKpmOwner: over.owner ?? false, isKpmAdmin: over.admin ?? false,
      directCount: row!.directCounts?.total ?? 0,
    };
    return over.readOnly
      ? new RequestContext(row!.userId, 'none', membership, 'sa-1', null, false, true)
      : new RequestContext(row!.userId, 'none', membership);
  }
  const asOwner = () => as(KPM_A, owner, { owner: true });
  const used = (kpmId: string) => countLeadersUsed(members, office(kpmId));
  const promote = { action: 'promote' as const, orgLevelCode: 'AAB', reason: 'Ready to lead' };

  /** A pending member at AAB, asking to join `leaderId` — registered, then promoted while pending. */
  async function pendingAab(leaderId: string) {
    const id = await join(KPM_A, 'aab', null, 'Dewi Pending', 'pending');
    const request = await joinRequests.create(office(KPM_A), { membershipId: id, leaderMembershipId: leaderId, status: 'pending' });
    return { id, joinRequestId: String(request._id) };
  }

  describe('AC-2: the refusal says it may be asked about', () => {
    it('a role change past the limit is 409 with canRequest, for the Owner and for an AAB over their own', async () => {
      await expect(roles.change(await asOwner(), other, 'aab')).rejects.toMatchObject({
        code: 'LEADER_LIMIT_REACHED', details: { maxLeaders: 2, leadersUsed: 2, canRequest: true },
      });
      await expect(roles.change(await as(KPM_A, aab), agent, 'aab')).rejects.toMatchObject({
        code: 'LEADER_LIMIT_REACHED', details: { canRequest: true },
      });
    });

    it('approving a pending leader past the limit is 409 with canRequest, and nothing is written', async () => {
      const { id, joinRequestId } = await pendingAab(owner);
      await expect(approvals.approve(await asOwner(), joinRequestId)).rejects.toMatchObject({
        code: 'LEADER_LIMIT_REACHED', details: { canRequest: true },
      });
      expect((await members.findById(office(KPM_A), id))!.status).toBe('pending');
    });

    it('a read-only support session, which may not ask, is told canRequest false', async () => {
      // A read-only session may not change a role either; the limit is met first only in an elevated one. Ask the
      // seat directly, as the session's write would.
      const ro = await as(KPM_A, owner, { owner: true, readOnly: true });
      await expect(hierarchy.setLevel(ro, other, 'aab')).rejects.toMatchObject({
        code: 'LEADER_LIMIT_REACHED', details: { canRequest: false },
      });
    });

    it('the roster import and an Owner’s assignment cannot wait: canRequest false', async () => {
      const file = [ROSTER_TEMPLATE_HEADER, 'Ana,ana@kpm.test,9901,aab,,1990-01-01,2020-01,full-time,female'].join('\n');
      await expect(roster.commit(SA, KPM_A, file)).rejects.toMatchObject({
        code: 'LEADER_LIMIT_REACHED', details: { canRequest: false },
      });
      // An Owner assigned who is not yet a member is made the root AB through `create`, as here.
      await expect(hierarchy.create(office(KPM_A), { userId: await person(), role: 'ab', status: 'active' }))
        .rejects.toMatchObject({ code: 'LEADER_LIMIT_REACHED', details: { canRequest: false } });
    });
  });

  describe('AC-3: the office asks, lists and cancels', () => {
    it('a promotion is asked with the rung and the reason, and nothing about the member changes', async () => {
      const row = await service.create(await asOwner(), other, promote);
      expect(row).toMatchObject({
        action: 'promote', status: 'pending', subjectMembershipId: other, subjectName: 'Budi Agent',
        fromOrgLevelCode: 'AGENT', toOrgLevelCode: 'AAB', reason: 'Ready to lead',
        requestedByMembershipId: owner, requestedByName: 'Wilson Ownerman', kpmCode: '0602',
        maxLeaders: 2, leadersUsed: 2,
      });
      expect((await members.findById(office(KPM_A), other))!.role).toBe('agent');
      expect(await used(KPM_A)).toBe(2);
    });

    it('an activation names the join request and the leader it joins', async () => {
      const { id, joinRequestId } = await pendingAab(owner);
      await service.create(await asOwner(), id, { action: 'activate' });
      const stored = await rows.findOne({ subjectMembershipId: id }).lean().exec();
      expect(stored).toMatchObject({ action: 'activate', joinRequestId, leaderMembershipId: owner, fromOrgLevelCode: 'AAB' });
    });

    it('an activation of an untagged pending leader is a tag into the asker’s unit', async () => {
      const id = await join(KPM_A, 'aab', null, 'Tono Untagged', 'pending');
      await service.create(await asOwner(), id, { action: 'activate' });
      expect(await rows.findOne({ subjectMembershipId: id }).lean().exec())
        .toMatchObject({ joinRequestId: null, leaderMembershipId: owner });
    });

    it('a second open request for the same member is 409 LEADER_LIMIT_REQUEST_OPEN; after a cancel, one may ask again', async () => {
      const first = await service.create(await asOwner(), other, promote);
      await expect(service.create(await asOwner(), other, promote)).rejects.toMatchObject({
        code: 'LEADER_LIMIT_REQUEST_OPEN', details: { requestId: first.requestId },
      });
      await service.cancel(await asOwner(), first.requestId);
      await expect(service.create(await asOwner(), other, promote)).resolves.toMatchObject({ status: 'pending' });
    });

    it('a change that makes no new leader needs nobody’s approval: 400', async () => {
      // AAB to AB adds nobody; an active member is not let in.
      await expect(service.create(await asOwner(), aab, { action: 'promote', orgLevelCode: 'AB' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(service.create(await asOwner(), other, { action: 'activate' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(service.create(await asOwner(), other, { action: 'promote' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'orgLevelCode' } });
    });

    it('is refused wherever the write would be: an AAB asking to make somebody an AB, or for a peer’s member', async () => {
      await expect(service.create(await as(KPM_A, aab), agent, { action: 'promote', orgLevelCode: 'AB' }))
        .rejects.toMatchObject({ code: 'ORG_ROLE_CHANGE_NOT_PERMITTED' });
      // Budi reports to the Owner, not to Sari.
      await expect(service.create(await as(KPM_A, aab), other, promote))
        .rejects.toMatchObject({ code: 'ORG_ROLE_CHANGE_NOT_PERMITTED' });
    });

    it('the Owner lists every request of the office; an AAB the ones they asked', async () => {
      await service.create(await asOwner(), other, promote);
      await service.create(await as(KPM_A, aab), agent, promote);
      expect((await service.list(await asOwner())).map((r) => r.subjectName).sort()).toEqual(['Budi Agent', 'Rina Agent']);
      expect((await service.list(await as(KPM_A, aab))).map((r) => r.subjectName)).toEqual(['Rina Agent']);
    });

    it('whoever asked or the Owner cancels; anybody else is answered 404, and a cancelled one is 409 DECIDED', async () => {
      const mine = await service.create(await as(KPM_A, aab), agent, promote);
      const owners = await service.create(await asOwner(), other, promote);
      await expect(service.cancel(await as(KPM_A, aab), owners.requestId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const left = await service.cancel(await asOwner(), mine.requestId);
      expect(left.find((r) => r.requestId === mine.requestId)?.status).toBe('cancelled');
      await expect(service.cancel(await asOwner(), mine.requestId)).rejects.toMatchObject({
        code: 'LEADER_LIMIT_REQUEST_DECIDED', details: { status: 'cancelled' },
      });
      expect((await audits.find({ action: 'leader_limit_request.cancelled' }).lean().exec())).toHaveLength(1);
    });
  });

  describe('AC-4: the Super Admin decides', () => {
    it('the queue is every office’s, pending first, and the Super Admin’s alone', async () => {
      const decided = await service.create(await asOwner(), agent, promote);
      await service.decline(SA, decided.requestId, { reason: 'Not this quarter.' });
      await service.create(await asOwner(), other, promote);
      const bOwner = await join(KPM_B, 'ab', null, 'Bea Owner');
      const bAgent = await join(KPM_B, 'agent', bOwner, 'Bayu Agent');
      await service.create(await as(KPM_B, bOwner, { owner: true }), bAgent, promote);

      const queue = await service.queue(SA);
      expect(queue.map((r) => [r.kpmCode, r.subjectName, r.status])).toEqual([
        ['0555', 'Bayu Agent', 'pending'],
        ['0602', 'Budi Agent', 'pending'],
        ['0602', 'Rina Agent', 'declined'],
      ]);
      expect(queue.find((r) => r.kpmCode === '0555')).toMatchObject({ requestedByName: 'Bea Owner', leadersUsed: 1 });
      await expect(service.queue(await asOwner())).rejects.toMatchObject({ code: 'PERM_DENIED' });
    });

    it('approving a promotion makes it past the limit: the rung, the log row with the asker and their reason, 3 / 2', async () => {
      const request = await service.create(await asOwner(), other, promote);
      const queue = await service.approve(SA, request.requestId);

      const budi = await members.findById(office(KPM_A), other);
      expect([budi!.orgLevelCode, budi!.role]).toEqual(['AAB', 'aab']);
      expect(await used(KPM_A)).toBe(3);
      // The quota does not move: the office reads above it.
      expect((await kpms.findById(KPM_A).lean().exec())!.subscription!.maxLeaders).toBe(2);
      expect(queue.find((r) => r.requestId === request.requestId)).toMatchObject({ status: 'approved', leadersUsed: 3 });

      const edge = await history.findOne({ membershipId: other, eventType: 'role_changed', validTo: null }).lean().exec();
      expect(edge).toMatchObject({ toRole: 'aab', actorMembershipId: owner, reason: 'Ready to lead' });
      // The lease is given back.
      expect((await kpms.findById(KPM_A).lean().exec())!.leaderLimitLock ?? null).toBeNull();
    });

    it('approving an activation approves the join request: the member active under the leader they asked for', async () => {
      const { id, joinRequestId } = await pendingAab(owner);
      const request = await service.create(await asOwner(), id, { action: 'activate' });
      await service.approve(SA, request.requestId);

      const dewi = await members.findById(office(KPM_A), id);
      expect([dewi!.status, dewi!.leaderId]).toEqual(['active', owner]);
      expect(await joinRequests.findById(office(KPM_A), joinRequestId)).toMatchObject({
        status: 'approved', decidedByMembershipId: owner,
      });
      expect(await used(KPM_A)).toBe(3);
      expect(sent.map((s) => s.templateId)).toContain(NotificationTemplate.JOIN_REQUEST_APPROVED);
    });

    it('approving a tag puts an untagged pending leader in the asker’s unit', async () => {
      const id = await join(KPM_A, 'aab', null, 'Tono Untagged', 'pending');
      const request = await service.create(await asOwner(), id, { action: 'activate' });
      await service.approve(SA, request.requestId);
      const tono = await members.findById(office(KPM_A), id);
      expect([tono!.status, tono!.leaderId]).toEqual(['active', owner]);
    });

    it('a request that no longer applies is 409 STALE, closed as declined with what changed, and nothing is written', async () => {
      const request = await service.create(await asOwner(), other, promote);
      // Budi stands on another rung by the time it is decided (written directly: at the limit, no path could).
      await mongoose.model(Membership.name).updateOne({ _id: other }, { $set: { orgLevelCode: 'AB', role: 'ab' } });

      await expect(service.approve(SA, request.requestId)).rejects.toMatchObject({ code: 'LEADER_LIMIT_REQUEST_STALE' });
      const stored = await rows.findById(request.requestId).lean().exec();
      expect(stored).toMatchObject({ status: 'declined', declineReason: expect.stringMatching(/^No longer applies: They have moved rung/) });
      expect(sent.find((s) => s.templateId === NotificationTemplate.LEADER_LIMIT_REQUEST_DECLINED)?.payload)
        .toMatchObject({ subjectName: 'Budi Agent', reason: expect.stringMatching(/No longer applies/) });
      await expect(service.approve(SA, request.requestId)).rejects.toMatchObject({ code: 'LEADER_LIMIT_REQUEST_DECIDED' });
    });

    it('an activation let in some other way since is stale; so is a member who has left', async () => {
      const { id } = await pendingAab(owner);
      const request = await service.create(await asOwner(), id, { action: 'activate' });
      await kpms.updateOne({ _id: KPM_A }, { $set: { 'subscription.maxLeaders': 5 } });
      const open = await joinRequests.findOne(office(KPM_A), { membershipId: id, status: 'pending' });
      await approvals.approve(await asOwner(), String(open!._id));
      await expect(service.approve(SA, request.requestId)).rejects.toMatchObject({ code: 'LEADER_LIMIT_REQUEST_STALE' });

      expect(staleReason({ action: 'promote', fromOrgLevelCode: 'AGENT' }, null)).toMatch(/no longer a member/);
      expect(staleReason({ action: 'promote', fromOrgLevelCode: 'AGENT' }, { status: 'removed', orgLevelCode: 'AGENT' }))
        .toMatch(/no longer a member/);
      expect(staleReason({ action: 'promote', fromOrgLevelCode: 'AGENT' }, { status: 'pending', orgLevelCode: 'AGENT' }))
        .toBeNull();
    });

    it('a promotion onto a rung archived since is stale', async () => {
      const request = await service.create(await asOwner(), other, promote);
      await mongoose.model(CompanyOrgLevel.name).updateOne({ companyId, code: 'AAB' }, { $set: { status: 'archived' } });
      await expect(service.approve(SA, request.requestId)).rejects.toMatchObject({
        code: 'LEADER_LIMIT_REQUEST_STALE', details: { why: 'The rung AAB is no longer on the ladder.' },
      });
    });

    it('declining needs a reason, changes nothing about the member, and tells whoever asked', async () => {
      const request = await service.create(await as(KPM_A, aab), agent, promote);
      await expect(service.decline(SA, request.requestId, { reason: '  ' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await service.decline(SA, request.requestId, { reason: 'Raise the limit at renewal instead.' });
      expect((await members.findById(office(KPM_A), agent))!.role).toBe('agent');
      const notice = sent.find((s) => s.templateId === NotificationTemplate.LEADER_LIMIT_REQUEST_DECLINED);
      expect(notice).toMatchObject({
        userId: (await members.findById(office(KPM_A), aab))!.userId,
        payload: { subjectName: 'Rina Agent', reason: 'Raise the limit at renewal instead.' },
      });
      await expect(service.decline(SA, request.requestId, { reason: 'Again.' })).rejects.toMatchObject({
        code: 'LEADER_LIMIT_REQUEST_DECIDED', details: { status: 'declined' },
      });
    });

    it('the permission review: whoever asked must still be able to — a leader who left, or a member moved to another unit, is stale', async () => {
      const left = await service.create(await as(KPM_A, aab), agent, promote);
      await mongoose.model(Membership.name).updateOne({ _id: aab }, { $set: { status: 'removed' } });
      await expect(service.approve(SA, left.requestId)).rejects.toMatchObject({
        code: 'LEADER_LIMIT_REQUEST_STALE', details: { why: 'Whoever asked is no longer an active member of the office.' },
      });
      expect((await members.findById(office(KPM_A), agent))!.role).toBe('agent');

      await mongoose.model(Membership.name).updateOne({ _id: aab }, { $set: { status: 'active' } });
      const moved = await service.create(await as(KPM_A, aab), agent, promote);
      await mongoose.model(Membership.name).updateOne({ _id: agent }, { $set: { leaderId: owner } });
      await expect(service.approve(SA, moved.requestId)).rejects.toMatchObject({
        code: 'LEADER_LIMIT_REQUEST_STALE', details: { why: 'They no longer report to whoever asked.' },
      });
      expect(await used(KPM_A)).toBe(2);
    });

    it('the permission review: two decisions at once — one wins, the other is told it was decided, nothing is written twice', async () => {
      const request = await service.create(await asOwner(), other, promote);
      const [a, b] = await Promise.allSettled([
        service.approve(SA, request.requestId),
        service.decline(SA, request.requestId, { reason: 'Not now.' }),
      ]);
      const outcomes = [a.status, b.status].sort();
      expect(outcomes).toEqual(['fulfilled', 'rejected']);
      const loser = [a, b].find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({ code: expect.stringMatching(/^LEADER_LIMIT_REQUEST_(DECIDED|STALE)$/) });
      const decisions = await audits.countDocuments({
        targetId: request.requestId, action: { $in: ['leader_limit_request.approved', 'leader_limit_request.declined'] },
      });
      expect(decisions).toBe(1);
    });

    it('the permission review: an act that fails for another reason gives the request back, to be decided again', async () => {
      const request = await service.create(await asOwner(), other, promote);
      const spy = jest.spyOn(roles, 'carryOutApproved').mockRejectedValueOnce(new Error('the database went away'));
      await expect(service.approve(SA, request.requestId)).rejects.toThrow('the database went away');
      spy.mockRestore();
      expect(await rows.findById(request.requestId).lean().exec()).toMatchObject({
        status: 'pending', decidedAt: null, decidedByUserId: null,
      });
      await service.approve(SA, request.requestId);
      expect((await members.findById(office(KPM_A), other))!.role).toBe('aab');
    });

    it('an office’s Owner may not decide, and an unknown id is not found', async () => {
      const request = await service.create(await asOwner(), other, promote);
      await expect(service.approve(await asOwner(), request.requestId)).rejects.toMatchObject({ code: 'PERM_DENIED' });
      await expect(service.decline(await asOwner(), request.requestId, { reason: 'x' })).rejects.toMatchObject({ code: 'PERM_DENIED' });
      await expect(service.approve(SA, new mongoose.Types.ObjectId().toString())).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(service.approve(SA, 'not-an-id')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('AC-5: audited, and the asker notified', () => {
    it('created, approved and declined each write their row; the approval notifies the asker', async () => {
      const one = await service.create(await asOwner(), other, promote);
      const two = await service.create(await as(KPM_A, aab), agent, promote);
      await service.approve(SA, one.requestId);
      await service.decline(SA, two.requestId, { reason: 'No.' });

      const actions = (await audits.find({ targetCollection: 'leaderLimitRequests' }).lean().exec()).map((a) => a.action).sort();
      expect(actions).toEqual([
        'leader_limit_request.approved', 'leader_limit_request.created', 'leader_limit_request.created',
        'leader_limit_request.declined',
      ]);
      const approved = await audits.findOne({ action: 'leader_limit_request.approved' }).lean().exec();
      expect(approved).toMatchObject({ kpmId: KPM_A, actorUserId: 'sa-1', targetMembershipId: other });
      const roleChange = await audits.findOne({ action: 'member.role_changed', targetMembershipId: other }).lean().exec();
      expect(roleChange?.after).toMatchObject({ role: 'aab', leaderLimitRequestId: one.requestId });

      const notice = sent.find((s) => s.templateId === NotificationTemplate.LEADER_LIMIT_REQUEST_APPROVED);
      expect(notice).toMatchObject({
        userId: (await members.findById(office(KPM_A), owner))!.userId,
        payload: { subjectName: 'Budi Agent', requestId: one.requestId },
      });
    });
  });

  describe('AC-8: one office never reaches another’s requests', () => {
    let bOwner: string;
    beforeEach(async () => {
      bOwner = await join(KPM_B, 'ab', null, 'Bea Owner');
    });

    it('cannot read, cancel, or ask about another office’s member', async () => {
      const request = await service.create(await asOwner(), other, promote);
      const asB = await as(KPM_B, bOwner, { owner: true });
      expect(await service.list(asB)).toEqual([]);
      await expect(service.cancel(asB, request.requestId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(service.create(asB, other, promote)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await rows.findById(request.requestId).lean().exec())!.status).toBe('pending');
    });

    it('approving acts in the request’s office alone', async () => {
      const bAgent = await join(KPM_B, 'agent', bOwner, 'Bayu Agent');
      const request = await service.create(await asOwner(), other, promote);
      await service.approve(SA, request.requestId);
      expect(await used(KPM_A)).toBe(3);
      expect(await used(KPM_B)).toBe(1);
      expect((await members.findById(office(KPM_B), bAgent))!.role).toBe('agent');
      expect(await members.findById(office(KPM_B), other)).toBeNull();
    });
  });
});
