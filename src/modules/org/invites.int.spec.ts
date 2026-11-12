import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { REGISTRATION } from '@/domain/constants';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthController } from '@/modules/auth/auth.controller';
import { AuthToken, AuthTokenSchema } from '@/modules/auth/auth-token.schema';
import { AuthService } from '@/modules/auth/auth.service';
import { PasswordService } from '@/modules/auth/password.service';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import { Hs256TokenSigner } from '@/modules/auth/token-signer';
import { KpmRequestService } from '@/modules/tenants/kpm-request.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { Lead, LeadSchema } from '@/modules/leads/lead.schema';
import { LeadRepository } from '@/modules/leads/lead.repository';
import { RecruitLeadLinks } from '@/modules/leads/recruit-lead-links';
import { CoachResolver } from './coach-resolver';
import { declaredPermissions, NO_CLASS, productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { IN_INDONESIAN } from '../../../test/i18n';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { ApprovalsService } from './approvals.service';
import { HierarchyService } from './hierarchy.service';
import { InviteLinkController, NewHireAgentsController, TransferRequestsController } from './invites.controller';
import { InvitesService } from './invites.service';
import { JoinRequest, JoinRequestSchema } from './join-request.schema';
import { LeaderCodeService } from './leader-code.service';
import { MemberInvite, MemberInviteSchema } from './member-invite.schema';
import { MemberNames } from './member-names.service';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import {
  JoinRequestRepository, MemberInviteRepository, MembershipHistoryRepository, TransferRequestRepository,
} from './org.repositories';
import { TransferRequest, TransferRequestSchema } from './transfer-request.schema';
import { TransfersService } from './transfers.service';

/** 10:00 on Tuesday 27 October 2026 in Jakarta. */
const NOW = new Date('2026-10-27T03:00:00Z');
const TODAY = '2026-10-27';
const DAY_MS = 86_400_000;
const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();

type Who =
  | 'OWNER' | 'ADMIN' | 'AGUS' | 'SARI' | 'RINA' | 'PEER' | 'PEER_AGENT' | 'PUTRI' | 'FAJAR' | 'ORPHAN' | 'ORPHAN_AAB'
  | 'B_OWNER' | 'B_AGENT';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const tokenOf = (link: string) => decodeURIComponent(new URL(link).searchParams.get('invite')!);

/**
 * **+ Add agent, invites, transfers and Find Your Leader, over HTTP** (P18.8-T3; ADR-0170). The real services behind
 * the real `PermissionsGuard` and the production pipe, on an office built through `HierarchyService`:
 *
 * ```
 * Office A (0417):  OWNER (AB, the Owner) ─┬── ADMIN (AB, an Admin, leads nobody)
 *                                          ├── AGUS (AB) ── SARI (AAB) ── RINA (Agent)
 *                                          └── PEER (AB) ── PEER_AGENT (Agent)
 *                   ORPHAN (AB, active, no leader) ── ORPHAN_AAB (AAB)
 *                   PUTRI (pending, asked Sari) · FAJAR (pending, asked nobody)
 *                   LOOSE — an account with code 20001 and no membership anywhere
 * Office B (0555), the same company:  B_OWNER (AB, its Owner) ── B_AGENT
 * ```
 */
describe('P18.8-T3 + Add agent, invites, transfers and Find Your Leader over HTTP', () => {
  let app: INestApplication;
  let clock: FixedClock;
  let limiterClock: FixedClock;
  let hierarchy: HierarchyService;
  let members: MembershipRepository;
  let requests: JoinRequestRepository;
  let companyId: string;
  let id: Record<Who, string>;
  let user: Record<Who | 'LOOSE', string>;
  let sent: { userId?: string; templateId: string; payload?: Record<string, unknown> }[];
  let started: string[];
  const col = (name: string) => mongoose.connection.db!.collection(name);
  const http = () => request(app.getHttpServer());
  const job = (kpmId: string) => RequestContext.forJob(kpmId, 'invites-spec');

  beforeAll(async () => {
    await startMongo();
    clock = new FixedClock(NOW);
    limiterClock = new FixedClock(NOW);
    const users = mongoose.model(User.name, UserSchema);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    const companies = mongoose.model(Company.name, CompanySchema);
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    const history = new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never);
    requests = new JoinRequestRepository(mongoose.model(JoinRequest.name, JoinRequestSchema) as never);
    const invitesRows = new MemberInviteRepository(mongoose.model(MemberInvite.name, MemberInviteSchema) as never);
    const transferRows = new TransferRequestRepository(mongoose.model(TransferRequest.name, TransferRequestSchema) as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never, companies as never, kpms as never, audit, clock,
    );
    hierarchy = new HierarchyService(members, kpms as never, users as never, history, clock, orgLevels);
    sent = [];
    started = [];
    const notifications = {
      send: async (r: { userId?: string; templateId: string; payload?: Record<string, unknown> }) => { sent.push(r); },
    } as never;
    const activations = { joined: async (_ctx: RequestContext, membershipId: string) => { started.push(membershipId); } };
    const approvals = new ApprovalsService(members, hierarchy, requests, history, users as never, audit, notifications, clock, activations);
    const names = new MemberNames(members, users as never);
    const transfers = new TransfersService(transferRows, members, hierarchy, names, kpms as never, audit, notifications, clock);
    // P19.1-T6 AC-7: a recruitment lead linked to the membership the form makes.
    const recruitLinks = new RecruitLeadLinks(
      new LeadRepository(mongoose.model(Lead.name, LeadSchema) as never), new CoachResolver(members), audit,
    );
    const invites = new InvitesService(
      invitesRows, members, hierarchy, approvals, transfers, requests, names,
      kpms as never, companies as never, users as never, audit, notifications, clock, activations, recruitLinks,
    );
    const onboarding = new OnboardingService(
      members, hierarchy, kpms as never, companies as never, users as never, requests, audit, notifications, clock,
    );
    const auth = new AuthService(
      users as never, mongoose.model(AuthToken.name, AuthTokenSchema) as never, companies as never,
      new PasswordService(), new Hs256TokenSigner('x'.repeat(40), clock), clock, notifications,
    );
    const config = { get: (key: string) => (key === 'APP_ORIGIN' ? 'https://app.agencyboost.test' : undefined) };
    const leaderCodes = new LeaderCodeService(
      members, hierarchy, requests, approvals, kpms as never, companies as never, users as never, audit, notifications, clock,
      activations,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [NewHireAgentsController, InviteLinkController, TransferRequestsController, OnboardingController, AuthController],
      providers: [
        { provide: InvitesService, useValue: invites },
        { provide: TransfersService, useValue: transfers },
        { provide: OnboardingService, useValue: onboarding },
        { provide: ApprovalsService, useValue: approvals },
        { provide: AuthService, useValue: auth },
        { provide: RateLimiter, useValue: new RateLimiter(limiterClock) },
        { provide: ConfigService, useValue: config },
        { provide: getModelToken(User.name), useValue: users },
        { provide: MembershipRepository, useValue: members },
        // P19.10-T1: registering on a leader's link, and a code redeemed by somebody waiting.
        { provide: LeaderCodeService, useValue: leaderCodes },
        // Routes this spec never calls.
        { provide: KpmRequestService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
    await syncIndexes();
  });

  afterAll(async () => {
    await app?.close();
    await stopMongo();
  });

  let seq = 0;
  async function account(fullName: string, agentCode: string, company = companyId): Promise<string> {
    seq += 1;
    const u = await mongoose.model(User.name).create({
      email: `p${seq}@kpm.test`, passwordHash: 'x', fullName, status: 'active', platformRole: 'none',
      companyId: company, agentCode,
    });
    return String(u._id);
  }

  async function place(kpmId: string, userId: string, role: 'ab' | 'aab' | 'agent', leaderId: string | null, status: 'active' | 'pending' = 'active') {
    const m = await hierarchy.create(job(kpmId), {
      userId, role, leaderId, status, ...(status === 'active' ? { joining: { joinDate: '2025-01-02' } } : {}),
    });
    return String(m._id);
  }

  /** The session a member's own token would carry: their row, read back. */
  async function as(who: Who | string, flags: { owner?: boolean; admin?: boolean } = {}): Promise<RequestContext> {
    const membershipId = (id as Record<string, string>)[who] ?? who;
    const row = (await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(membershipId) }))!;
    return new RequestContext(String(row.userId), 'none', {
      membershipId, kpmId: row.kpmId, orgLevelCode: String(row.role).toUpperCase(), hierarchyRole: row.role,
      status: row.status, isKpmOwner: flags.owner ?? who === 'OWNER', isKpmAdmin: flags.admin ?? who === 'ADMIN',
      directCount: row.directCounts?.total ?? 0,
    });
  }
  const signIn = async (who: Who, flags: { owner?: boolean; admin?: boolean } = {}) => { session.current = await as(who, flags); };

  const add = (body: Record<string, unknown>) => http().post('/new-hires/agents').send({
    fullName: 'Hendra Wijaya', phone: '0812-3456-7890', ...body,
  });

  beforeEach(async () => {
    clock.set(NOW);
    limiterClock.advance(2 * 60 * 60 * 1000);
    await clearCollections();
    sent.length = 0;
    started.length = 0;
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `pru-${Math.random()}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    const u = {} as Record<Who | 'LOOSE', string>;
    const people: [Who | 'LOOSE', string, string][] = [
      ['OWNER', 'Wilson Tan', '10001'], ['ADMIN', 'Maya Sari', '10002'], ['AGUS', 'Agus Prasetyo', '10003'],
      ['SARI', 'Sari Puspita', '10004'], ['RINA', 'Rina Wijaya', '10005'], ['PEER', 'Hendra Gunawan', '10006'],
      ['PEER_AGENT', 'Lina Marlina', '10007'], ['PUTRI', 'Putri Anggraini', '10008'], ['FAJAR', 'Fajar Nugroho', '10009'],
      ['ORPHAN', 'Bayu Saputra', '10010'], ['ORPHAN_AAB', 'Citra Dewi', '10011'], ['LOOSE', 'Yoga Pratama', '20001'],
      ['B_OWNER', 'Hendra Wijaya', '30001'], ['B_AGENT', 'Dian Lestari', '30002'],
    ];
    for (const [who, name, code] of people) u[who] = await account(name, code);
    user = u;
    await mongoose.model(Kpm.name).create({
      _id: KPM_A, companyId, code: '0417', branchName: 'BSD City', counters: { nextMemberSeq: 1 }, status: 'active',
      timezone: 'Asia/Jakarta', ownerUserId: u.OWNER,
    });
    await mongoose.model(Kpm.name).create({
      _id: KPM_B, companyId, code: '0555', branchName: 'Kelapa Gading', counters: { nextMemberSeq: 1 }, status: 'active',
      timezone: 'Asia/Jakarta', ownerUserId: u.B_OWNER,
    });
    const i = {} as Record<Who, string>;
    i.OWNER = await place(KPM_A, u.OWNER, 'ab', null);
    i.ADMIN = await place(KPM_A, u.ADMIN, 'ab', i.OWNER);
    i.AGUS = await place(KPM_A, u.AGUS, 'ab', i.OWNER);
    i.SARI = await place(KPM_A, u.SARI, 'aab', i.AGUS);
    i.RINA = await place(KPM_A, u.RINA, 'agent', i.SARI);
    i.PEER = await place(KPM_A, u.PEER, 'ab', i.OWNER);
    i.PEER_AGENT = await place(KPM_A, u.PEER_AGENT, 'agent', i.PEER);
    i.PUTRI = await place(KPM_A, u.PUTRI, 'agent', null, 'pending');
    i.FAJAR = await place(KPM_A, u.FAJAR, 'agent', null, 'pending');
    i.ORPHAN = await place(KPM_A, u.ORPHAN, 'ab', null);
    i.ORPHAN_AAB = await place(KPM_A, u.ORPHAN_AAB, 'aab', i.ORPHAN);
    i.B_OWNER = await place(KPM_B, u.B_OWNER, 'ab', null);
    i.B_AGENT = await place(KPM_B, u.B_AGENT, 'agent', i.B_OWNER);
    id = i;
    await col('memberships').updateOne({ _id: new mongoose.Types.ObjectId(i.ADMIN) }, { $set: { 'adminAccess.isKpmAdmin': true } });
    await requests.create(job(KPM_A), { membershipId: i.PUTRI, leaderMembershipId: i.SARI, status: 'pending' });
    await signIn('AGUS');
  });

  const audits = (action: string) => col('auditLog').find({ action }).toArray();
  const notices = (templateId: string) => sent.filter((n) => n.templateId === templateId);
  const membershipOf = (userId: string, kpmId = KPM_A) => col('memberships').findOne({ userId, kpmId, status: { $in: ['active', 'pending'] } });

  // ------------------------------------------------------------------ the entry point

  describe('POST /new-hires/agents — one entry point, decided by the agent code', () => {
    it('P18.8-T3 AC-2 a code nobody holds is invited: a link to registration, 14 days, audited, and nothing counts it', async () => {
      const res = await add({ agentCode: '80777', joinDate: TODAY }).expect(200);
      expect(res.body).toMatchObject({
        outcome: 'invited',
        invite: {
          fullName: 'Hendra Wijaya', agentCode: '80777', phone: '0812-3456-7890', joinDate: TODAY, status: 'pending',
          leader: { membershipId: id.AGUS, name: 'Agus Prasetyo' }, existingAccount: false,
          expiresAt: new Date(NOW.getTime() + 14 * DAY_MS).toISOString(),
        },
      });
      expect(res.body.link).toMatch(/^https:\/\/app\.agencyboost\.test\/register\?invite=/);
      const token = tokenOf(res.body.link);
      expect(token.startsWith(`${KPM_A}.`)).toBe(true);
      const row = (await col('memberInvites').findOne({}))!;
      // The token itself is never stored, only its hash.
      expect(row.tokenHash).toBe(hash(token));
      expect(JSON.stringify(row)).not.toContain(token.split('.')[1]);
      expect(row).toMatchObject({ kpmId: KPM_A, companyId, leaderMembershipId: id.AGUS, invitedByMembershipId: id.AGUS });
      // An invite counts in nothing: no membership, no account.
      expect(await col('memberships').countDocuments({ agentCode: '80777' })).toBe(0);
      expect(await col('users').countDocuments({ agentCode: '80777' })).toBe(0);
      expect(await audits('member_invite.created')).toHaveLength(1);
    });

    it('P18.8-T3 AC-2 the code is unique across the company’s accounts and invites: a second invite is 409 ORG_INVITE_PENDING, from this office or another', async () => {
      await add({ agentCode: '80777' }).expect(200);
      expect((await add({ agentCode: '80777' }).expect(409)).body.error.code).toBe('ORG_INVITE_PENDING');
      await signIn('PEER');
      expect((await add({ agentCode: '80777' }).expect(409)).body.error.code).toBe('ORG_INVITE_PENDING');
      await signIn('B_OWNER', { owner: true });
      const other = await add({ agentCode: '80777' }).expect(409);
      expect(other.body.error).toMatchObject({ code: 'ORG_INVITE_PENDING', message: expect.stringContaining('80777') });
    });

    it('P18.8-T3 AC-3 a pending member is linked at once under the leader, with the join date given, classified, and their request cancelled', async () => {
      const res = await add({ agentCode: '10008', joinDate: '2026-10-20' }).expect(200);
      expect(res.body).toEqual({ outcome: 'linked', member: { membershipId: id.PUTRI, fullName: 'Putri Anggraini' } });
      const putri = (await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id.PUTRI) }))!;
      expect(putri).toMatchObject({ status: 'active', leaderId: id.AGUS, joinDate: '2026-10-20', joinedAs: 'new_hire' });
      expect(await col('joinRequests').findOne({ membershipId: id.PUTRI })).toMatchObject({ status: 'cancelled' });
      expect(started).toEqual([id.PUTRI]);
      const tagged = await audits('member.tagged_by_leader');
      expect(tagged).toHaveLength(1);
      expect(tagged[0].after).toMatchObject({ leaderId: id.AGUS, via: 'add_agent', joinDate: '2026-10-20' });
      expect(notices('member.tagged_by_leader').map((n) => n.userId)).toEqual([user.PUTRI]);
    });

    it('P18.8-T3 AC-3 an account reporting to another leader becomes a transfer request for the Owner and the Admin; a second is 409 ORG_TRANSFER_PENDING', async () => {
      const res = await add({ agentCode: '10007', fullName: 'Lina Marlina' }).expect(200);
      // P18.8-T8 M3: answered with what Agus typed, and nothing of Hendra's unit.
      expect(res.body).toEqual({
        outcome: 'transfer_requested',
        transfer: {
          transferId: expect.any(String), requestedName: 'Lina Marlina', agentCode: '10007',
          to: { membershipId: id.AGUS, name: 'Agus Prasetyo' }, status: 'pending', requestedAt: expect.any(String),
        },
      });
      // Nothing moved: the member stays with their leader until the office decides.
      expect((await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id.PEER_AGENT) }))!.leaderId).toBe(id.PEER);
      expect(notices('transfer_request.received').map((n) => n.userId).sort()).toEqual([user.ADMIN, user.OWNER].sort());
      expect(notices('transfer_request.received')[0].payload).toMatchObject({ requesterName: 'Agus Prasetyo', memberName: 'Lina Marlina' });
      expect(await audits('transfer_request.created')).toHaveLength(1);
      expect((await add({ agentCode: '10007' }).expect(409)).body.error.code).toBe('ORG_TRANSFER_PENDING');
      expect((await http().get('/new-hires/transfers').expect(200)).body.map((t: { requestedName: string }) => t.requestedName)).toEqual(['Lina Marlina']);
    });

    it('P18.8-T8 M3 a peer unit’s code is answered with what was typed — no real name, no from, no member id — to the POST and GET /new-hires/transfers', async () => {
      const res = await add({ agentCode: '10007', fullName: 'Hendra W.' }).expect(200);
      const mine = (await http().get('/new-hires/transfers').expect(200)).body;
      expect(mine).toEqual([res.body.transfer]);
      expect(res.body.transfer).toMatchObject({ requestedName: 'Hendra W.', agentCode: '10007' });
      for (const answer of [res.body, mine]) {
        const text = JSON.stringify(answer);
        // Lina Marlina, her membership, and Hendra Gunawan's unit she is in: none of it.
        for (const secret of ['Lina Marlina', id.PEER_AGENT, 'Hendra Gunawan', id.PEER]) expect(text).not.toContain(secret);
        expect(text).not.toMatch(/"from"|"member"/);
      }
      // The typed name is kept on the request, and the office's deciders see both, to spot the mismatch.
      expect(await col('transferRequests').findOne({})).toMatchObject({ requestedName: 'Hendra W.' });
      await signIn('OWNER');
      expect((await http().get('/transfer-requests').expect(200)).body).toEqual([expect.objectContaining({
        member: { membershipId: id.PEER_AGENT, name: 'Lina Marlina', agentCode: '10007' },
        from: { membershipId: id.PEER, name: 'Hendra Gunawan' },
        to: { membershipId: id.AGUS, name: 'Agus Prasetyo' },
        requestedBy: { membershipId: id.AGUS, name: 'Agus Prasetyo' },
        requestedName: 'Hendra W.',
      })]);
    });

    it('P18.8-T8 M3 whoever asked is told the decision in the name they typed, declined or approved', async () => {
      const first = (await add({ agentCode: '10007', fullName: 'Hendra W.' }).expect(200)).body.transfer.transferId;
      await signIn('OWNER');
      await http().post(`/transfer-requests/${first}/decline`).send({}).expect(200);
      await signIn('AGUS');
      const second = (await add({ agentCode: '10007', fullName: 'Lina M.' }).expect(200)).body.transfer.transferId;
      await signIn('OWNER');
      await http().post(`/transfer-requests/${second}/approve`).expect(200);
      expect(notices('transfer_request.decided').filter((n) => n.payload!.audience === 'requester').map((n) => [n.payload!.decision, n.payload!.memberName]))
        .toEqual([['declined', 'Hendra W.'], ['approved', 'Lina M.']]);
      // The leader she left is told her name: she was in his unit.
      expect(notices('transfer_request.decided').find((n) => n.payload!.audience === 'from_leader')!.payload!.memberName).toBe('Lina Marlina');
    });

    it('P18.8-T8 M3 the office’s owner who has a leader is refused 403 ORG_NOT_PERMITTED_TO_TAG, when asked and when approved — nothing moves', async () => {
      const kpm = { _id: new mongoose.Types.ObjectId(KPM_A) };
      // Ownership moved to Sari, who keeps her leader, Agus.
      await col('kpms').updateOne(kpm, { $set: { ownerUserId: user.SARI } });
      await signIn('PEER');
      const asked = await add({ agentCode: '10004' }).expect(403);
      expect(asked.body.error).toMatchObject({ code: 'ORG_NOT_PERMITTED_TO_TAG', message: 'They own this office. Nobody adds them to a unit.' });
      expect(await col('transferRequests').countDocuments({})).toBe(0);
      // Asked for while Rina was nobody's owner, and approved once she is.
      await col('kpms').updateOne(kpm, { $set: { ownerUserId: user.OWNER } });
      const transferId = (await add({ agentCode: '10005' }).expect(200)).body.transfer.transferId;
      await col('kpms').updateOne(kpm, { $set: { ownerUserId: user.RINA } });
      await signIn('OWNER');
      expect((await http().post(`/transfer-requests/${transferId}/approve`).expect(403)).body.error.code).toBe('ORG_NOT_PERMITTED_TO_TAG');
      expect(await col('transferRequests').findOne({})).toMatchObject({ status: 'pending' });
      expect((await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id.RINA) }))!.leaderId).toBe(id.SARI);
    });

    it('P18.8-T3 AC-4 an account with no membership in the office is invited to sign in and accept: the link opens /join', async () => {
      const res = await add({ agentCode: '20001' }).expect(200);
      expect(res.body).toMatchObject({ outcome: 'invited', invite: { existingAccount: true } });
      expect(res.body.link).toMatch(/^https:\/\/app\.agencyboost\.test\/join\?invite=/);
    });

    it('P18.8-T3 AC-1 refuses its own code, somebody already in the unit, a loop, the office’s root, a bad date and a bad code', async () => {
      expect((await add({ agentCode: '10003' }).expect(409)).body.error.code).toBe('ORG_CYCLE_DETECTED');
      await signIn('SARI');
      expect((await add({ agentCode: '10005' }).expect(409)).body.error.code).toBe('ORG_AGENT_ALREADY_TAGGED');
      // Sari asking for Agus, her own leader: moving him under her would be a loop, refused when asked.
      expect((await add({ agentCode: '10003' }).expect(409)).body.error.code).toBe('ORG_CYCLE_DETECTED');
      expect(await col('transferRequests').countDocuments({})).toBe(0);
      await signIn('AGUS');
      // The office's root has no leader, and nobody tags them into a unit.
      expect((await add({ agentCode: '10001' }).expect(403)).body.error.code).toBe('ORG_NOT_PERMITTED_TO_TAG');
      expect((await add({ agentCode: '80777', joinDate: '2026-10-28' }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await add({ agentCode: 'PRU-1' }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await add({ agentCode: '80777', phone: 'call me' }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect(await col('memberInvites').countDocuments({})).toBe(0);
    });

    it('P18.8-T3 AC-7 the Owner adds to any unit by naming its leader; an AB naming another unit is 404, an Agent and the Super Admin 403', async () => {
      await signIn('OWNER');
      const res = await add({ agentCode: '80777', leaderMembershipId: id.SARI }).expect(200);
      expect(res.body.invite.leader).toEqual({ membershipId: id.SARI, name: 'Sari Puspita' });
      expect((await col('memberInvites').findOne({}))!.invitedByMembershipId).toBe(id.OWNER);
      await signIn('ADMIN');
      await add({ agentCode: '80778', leaderMembershipId: id.PEER }).expect(200);
      // Another office's member is not found, as is anybody's outside the reach.
      expect((await add({ agentCode: '80779', leaderMembershipId: id.B_AGENT }).expect(404)).body.error.code).toBe('NOT_FOUND');
      await signIn('AGUS');
      expect((await add({ agentCode: '80779', leaderMembershipId: id.SARI }).expect(404)).body.error.code).toBe('NOT_FOUND');
      await signIn('RINA');
      expect((await add({ agentCode: '80779' }).expect(403)).body.error.code).toBe('PERM_DENIED');
      session.current = RequestContext.platform('root');
      expect((await add({ agentCode: '80779' }).expect(403)).body.error.code).toBe('PERM_DENIED');
    });
  });

  // ------------------------------------------------------------------ the leader's invites

  describe('the invites: list, resend, cancel, expiry', () => {
    it('P18.8-T3 AC-2 Agus lists the invites into his unit and not the Peer’s; the Owner lists the office’s, with its today', async () => {
      await add({ agentCode: '80777' }).expect(200);
      await signIn('PEER');
      await add({ agentCode: '80778', fullName: 'Rudi Hartono' }).expect(200);
      await signIn('AGUS');
      const mine = (await http().get('/new-hires/invites').expect(200)).body;
      expect(mine.today).toBe(TODAY);
      expect(mine.invites.map((i: { fullName: string }) => i.fullName)).toEqual(['Hendra Wijaya']);
      expect(mine.invites[0]).not.toHaveProperty('link');
      await signIn('OWNER');
      expect((await http().get('/new-hires/invites').expect(200)).body.invites).toHaveLength(2);
      await signIn('B_OWNER', { owner: true });
      expect((await http().get('/new-hires/invites').expect(200)).body.invites).toEqual([]);
    });

    it('P18.8-T3 AC-2 Resend makes a new token — the old link opens nothing — and 14 days from now; audited', async () => {
      const first = tokenOf((await add({ agentCode: '80777' }).expect(200)).body.link);
      clock.advance(5 * DAY_MS);
      const inviteId = String((await col('memberInvites').findOne({}))!._id);
      const res = await http().post(`/new-hires/invites/${inviteId}/resend`).expect(200);
      const second = tokenOf(res.body.link);
      expect(second).not.toBe(first);
      expect(res.body.invite.expiresAt).toBe(new Date(NOW.getTime() + 19 * DAY_MS).toISOString());
      await http().get(`/invites/${encodeURIComponent(first)}`).expect(404);
      await http().get(`/invites/${encodeURIComponent(second)}`).expect(200);
      expect(await audits('member_invite.resent')).toHaveLength(1);
    });

    it('P18.8-T3 AC-2 Cancel invite leaves nothing: the link opens nothing, it is listed no more, and twice is 409', async () => {
      const token = tokenOf((await add({ agentCode: '80777' }).expect(200)).body.link);
      const inviteId = String((await col('memberInvites').findOne({}))!._id);
      const res = await http().delete(`/new-hires/invites/${inviteId}`).expect(200);
      expect(res.body.invites).toEqual([]);
      expect(await col('memberInvites').findOne({})).toMatchObject({ status: 'cancelled', cancelledByMembershipId: id.AGUS });
      expect((await http().get(`/invites/${encodeURIComponent(token)}`).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await http().delete(`/new-hires/invites/${inviteId}`).expect(409)).body.error.code).toBe('ORG_REQUEST_ALREADY_DECIDED');
      expect(await audits('member_invite.cancelled')).toHaveLength(1);
      // The code is free again.
      await add({ agentCode: '80777' }).expect(200);
    });

    it('P18.8-T3 AC-2 past 14 days the link has expired, the row says so, the code is free, and Resend revives it', async () => {
      const token = tokenOf((await add({ agentCode: '80777' }).expect(200)).body.link);
      clock.advance(14 * DAY_MS);
      const expired = await http().get(`/invites/${encodeURIComponent(token)}`).expect(404);
      expect(expired.body.error.message).toMatch(/expired/);
      const list = (await http().get('/new-hires/invites').expect(200)).body;
      expect(list.invites[0].status).toBe('expired');
      const inviteId = list.invites[0].inviteId;
      const revived = await http().post(`/new-hires/invites/${inviteId}/resend`).expect(200);
      expect(revived.body.invite.status).toBe('pending');
    });

    it('P18.8-T3 AC-7 an AB reaches only the invites into their own unit; another office’s are 404', async () => {
      await add({ agentCode: '80777' }).expect(200);
      const inviteId = String((await col('memberInvites').findOne({}))!._id);
      await signIn('PEER');
      await http().post(`/new-hires/invites/${inviteId}/resend`).expect(404);
      await http().delete(`/new-hires/invites/${inviteId}`).expect(404);
      await signIn('B_OWNER', { owner: true });
      await http().post(`/new-hires/invites/${inviteId}/resend`).expect(404);
      await http().delete(`/new-hires/invites/${inviteId}`).expect(404);
      await http().delete('/new-hires/invites/not-an-id').expect(404);
      expect((await col('memberInvites').findOne({}))!.status).toBe('pending');
    });
  });

  // ------------------------------------------------------------------ the link

  describe('an invite link: the banner, registration and a signed-in account', () => {
    const register = (token: string, over: Record<string, unknown> = {}) => http().post('/auth/register').send({
      email: 'hendra@new.test', password: 'a long enough password', fullName: 'Hendra W.',
      companyId: new mongoose.Types.ObjectId().toString(), agentCode: '99999',
      dateOfBirth: '1995-03-15', companyJoinMonth: '2026-10', workStatus: 'full_time', gender: 'male',
      inviteToken: token, ...over,
    });

    it('P18.8-T3 AC-4 the banner names the leader, the office, the code, the join date and the name; 404 for a link that opens nothing', async () => {
      const token = tokenOf((await add({ agentCode: '80777', joinDate: '2026-10-25' }).expect(200)).body.link);
      session.current = RequestContext.platform('nobody');
      const res = await http().get(`/invites/${encodeURIComponent(token)}`).expect(200);
      expect(res.body).toEqual({
        leaderName: 'Agus Prasetyo', kpm: { code: '0417', branchName: 'BSD City' }, companyId, companyName: 'Prudential',
        agentCode: '80777', joinDate: '2026-10-25', fullName: 'Hendra Wijaya', existingAccount: false,
        expiresAt: new Date(NOW.getTime() + 14 * DAY_MS).toISOString(),
        // P19.6-T1 AC-13 (ADR-0218 §9): no branding reader in this harness, so AgencyBoost's.
        branding: null,
      });
      for (const bad of ['nonsense', `${KPM_A}.wrong`, `${KPM_B}.${token.split('.')[1]}`, `not-an-id.${token.split('.')[1]}`]) {
        expect([bad, (await http().get(`/invites/${encodeURIComponent(bad)}`)).status]).toEqual([bad, 404]);
      }
    });

    it('P18.8-T3 AC-4 the banner is rate limited per address: the sixty-first opening in an hour is 429', async () => {
      for (let n = 0; n < 60; n += 1) await http().get('/invites/nonsense').expect(404);
      expect((await http().get('/invites/nonsense').expect(429)).body.error.code).toBe('AUTH_RATE_LIMITED');
    });

    it('P18.8-T3 AC-4 registering on the link joins the office under the leader at once, with the invite’s code and join date', async () => {
      const token = tokenOf((await add({ agentCode: '80777', joinDate: '2026-10-20' }).expect(200)).body.link);
      // P19.12-T2 AC-3 (ADR-0245 §3): the account made is signed in, the cookie set as at sign-in.
      const made = await register(token).expect(201);
      expect(made.body).toEqual({ status: 'signed_in', accessToken: expect.any(String), expiresIn: expect.any(Number) });
      expect(String(made.headers['set-cookie'])).toMatch(/^agencyboost_refresh=/);
      const account = (await col('users').findOne({ email: 'hendra@new.test' }))!;
      // The invite's code and the office's insurer, whatever the form sent.
      expect(account).toMatchObject({ agentCode: '80777', companyId, phone: '0812-3456-7890', fullName: 'Hendra W.' });
      const membership = (await membershipOf(String(account._id)))!;
      expect(membership).toMatchObject({ status: 'active', leaderId: id.AGUS, joinDate: '2026-10-20', joinedAs: 'new_hire', role: 'agent' });
      expect(await col('memberInvites').findOne({})).toMatchObject({ status: 'accepted', acceptedMembershipId: String(membership._id) });
      expect(started).toEqual([String(membership._id)]);
      expect(notices('member_invite.accepted')).toEqual([expect.objectContaining({
        userId: user.AGUS, payload: { joinerName: 'Hendra W.', membershipId: String(membership._id) },
      })]);
      expect(await audits('member_invite.accepted')).toHaveLength(1);
      // Used once: the link now says so, and registering on it again is refused before anything is written.
      expect((await http().get(`/invites/${encodeURIComponent(token)}`).expect(404)).body.error.message).toMatch(/already used/);
      await register(token, { email: 'again@new.test' }).expect(404);
      expect(await col('users').countDocuments({ email: 'again@new.test' })).toBe(0);
    });

    it('P18.8-T8 L2 sign-ups are rate limited per address: the twenty-first in an hour is 429, before anything is read or made', async () => {
      const token = tokenOf((await add({ agentCode: '80777' }).expect(200)).body.link);
      session.current = RequestContext.platform('nobody');
      // Twenty attempts, refused or not, spend the address's hour.
      for (let i = 0; i < REGISTRATION.MAX_PER_ADDRESS; i += 1) await register('nonsense', { email: `probe${i}@new.test` }).expect(404);
      const res = await register(token).expect(429);
      expect(res.body.error).toMatchObject({ code: 'AUTH_RATE_LIMITED', details: { retryAfterSeconds: expect.any(Number) } });
      expect(await col('users').countDocuments({ email: 'hendra@new.test' })).toBe(0);
      expect(await col('memberInvites').findOne({})).toMatchObject({ status: 'pending' });
      // An hour on, the address may sign up again.
      limiterClock.advance(REGISTRATION.WINDOW_SECONDS * 1000);
      await register(token).expect(201);
    });

    it('P18.8-T3 AC-4 an existing agent joins as an existing agent: a join date over 90 days back classifies them so', async () => {
      const token = tokenOf((await add({ agentCode: '80777', joinDate: '2026-01-05' }).expect(200)).body.link);
      await register(token).expect(201);
      const account = (await col('users').findOne({ email: 'hendra@new.test' }))!;
      expect(await membershipOf(String(account._id))).toMatchObject({ joinDate: '2026-01-05', joinedAs: 'existing_agent' });
    });

    it('P18.8-T3 AC-4 registering on a link with an address that already exists joins nobody to anything', async () => {
      const token = tokenOf((await add({ agentCode: '80777' }).expect(200)).body.link);
      const existing = (await col('users').findOne({ _id: new mongoose.Types.ObjectId(user.RINA) }))!;
      const res = await register(token, { email: existing.email }).expect(201, { status: 'verification_sent' });
      // P19.12-T2 AC-3 (ADR-0245 §3): and signs nobody in.
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await col('memberInvites').findOne({})).toMatchObject({ status: 'pending' });
      expect(await col('memberships').countDocuments({ kpmId: KPM_A })).toBe(11);
    });

    it('P18.8-T3 AC-2 the code is checked again at acceptance: an account that took it since refuses the registration, 409 AGENT_CODE_TAKEN', async () => {
      const token = tokenOf((await add({ agentCode: '80777' }).expect(200)).body.link);
      await account('Somebody Else', '80777');
      expect((await register(token).expect(409)).body.error.code).toBe('AGENT_CODE_TAKEN');
      expect(await col('users').countDocuments({ email: 'hendra@new.test' })).toBe(0);
    });

    it('P18.8-T3 AC-4 a signed-in account the code belongs to accepts with one button; another account is 404, somebody in an office 409', async () => {
      const token = tokenOf((await add({ agentCode: '20001' }).expect(200)).body.link);
      await signIn('B_AGENT');
      expect((await http().post(`/invites/${encodeURIComponent(token)}/accept`).expect(404)).body.error.code).toBe('NOT_FOUND');
      session.current = new RequestContext(user.LOOSE, 'none', null);
      const res = await http().post(`/invites/${encodeURIComponent(token)}/accept`).expect(200);
      expect(res.body).toEqual({ kpmId: KPM_A, leaderName: 'Agus Prasetyo' });
      expect(await membershipOf(user.LOOSE)).toMatchObject({ status: 'active', leaderId: id.AGUS, joinDate: TODAY });
      expect(notices('member_invite.accepted')).toHaveLength(1);

      // An account already in an office is refused, as a leader's code refuses them.
      await signIn('AGUS');
      const second = tokenOf((await add({ agentCode: '30002' }).expect(200)).body.link);
      await signIn('B_AGENT');
      expect((await http().post(`/invites/${encodeURIComponent(second)}/accept`).expect(409)).body.error.code).toBe('ORG_AGENT_ALREADY_TAGGED');
    });
  });

  // ------------------------------------------------------------------ a leader's code

  describe('P19.10-T1 a leader’s code or link needs no approval, from every door (ADR-0236)', () => {
    const codeOf = async (who: Who) => String((await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id[who]) }))!.leaderCode);
    const registerWith = (leaderCode: string, over: Record<string, unknown> = {}) => http().post('/auth/register').send({
      email: 'yudi@new.test', password: 'a long enough password', fullName: 'Yudi Hartono',
      agentCode: '88123', dateOfBirth: '1995-03-15', companyJoinMonth: '2026-10', workStatus: 'full_time', gender: 'male',
      leaderCode, ...over,
    });
    const redeem = (code: string) => http().post('/join/redeem').send({ code });

    it('P19.10-T1 AC-1 registering on a leader’s link joins their unit at once: active, the code’s insurer, today, a new hire, no request', async () => {
      session.current = RequestContext.platform('nobody');
      const code = await codeOf('AGUS');
      // The insurer the form sent is not the office's: the code's office decides, as an invite's does. Lower case and
      // spaces, as somebody types a code they were read.
      const elsewhere = new mongoose.Types.ObjectId().toString();
      // P19.12-T2 AC-3 (ADR-0245 §3): and signs the account in, already in the unit.
      const made = await registerWith(`  ${code.toLowerCase()} `, { companyId: elsewhere }).expect(201);
      expect(made.body).toMatchObject({ status: 'signed_in', accessToken: expect.any(String) });
      expect(String(made.headers['set-cookie'])).toMatch(/^agencyboost_refresh=/);

      const account = (await col('users').findOne({ email: 'yudi@new.test' }))!;
      expect(account).toMatchObject({ companyId, agentCode: '88123' });
      const membership = (await membershipOf(String(account._id)))!;
      expect(membership).toMatchObject({
        status: 'active', leaderId: id.AGUS, recruitedByMembershipId: id.AGUS, role: 'agent', joinDate: TODAY, joinedAs: 'new_hire',
      });
      expect(await col('joinRequests').countDocuments({ membershipId: String(membership._id) })).toBe(0);
      expect(started).toEqual([String(membership._id)]);
      expect(notices('member.tagged_by_leader')).toEqual([expect.objectContaining({
        userId: user.AGUS, payload: { joinerName: 'Yudi Hartono', via: 'leader-code', code },
      })]);
      expect(await audits('leader_code.redeemed')).toEqual([expect.objectContaining({
        targetId: String(membership._id), after: { code, leaderMembershipId: id.AGUS },
      })]);
    });

    it('P19.10-T1 AC-1 the insurer may be left out on a leader’s link; without one, or without a code, it is still required', async () => {
      session.current = RequestContext.platform('nobody');
      await registerWith(await codeOf('SARI')).expect(201);
      expect(await membershipOf(String((await col('users').findOne({ email: 'yudi@new.test' }))!._id))).toMatchObject({ leaderId: id.SARI });
      const plain = await http().post('/auth/register').send({
        email: 'plain@new.test', password: 'a long enough password', fullName: 'Plain Person', agentCode: '88124',
        dateOfBirth: '1995-03-15', companyJoinMonth: '2026-10', workStatus: 'full_time', gender: 'male',
      }).expect(400);
      expect(plain.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P19.10-T1 AC-2 a code that opens nothing is refused 410 before any account is made, answered alike for an unknown code and a leader who left', async () => {
      session.current = RequestContext.platform('nobody');
      const unknown = await registerWith('ZZZZZZ').expect(410);
      expect(unknown.body.error.code).toBe('ORG_INVITE_EXPIRED');
      const leftCode = await codeOf('PEER_AGENT');
      await col('memberships').updateOne({ _id: new mongoose.Types.ObjectId(id.PEER_AGENT) }, { $set: { status: 'removed' } });
      const left = await registerWith(leftCode).expect(410);
      expect(left.body.error).toEqual(unknown.body.error);
      // A stopped office admits nobody either.
      const bCode = await codeOf('B_OWNER');
      await col('kpms').updateOne({ _id: new mongoose.Types.ObjectId(KPM_B) }, { $set: { status: 'suspended' } });
      expect((await registerWith(bCode).expect(410)).body.error.code).toBe('ORG_INVITE_EXPIRED');
      expect(await col('users').countDocuments({ email: 'yudi@new.test' })).toBe(0);
    });

    it('P19.10-T1 AC-1 an address that already exists makes nothing, signs nobody in and joins nobody to anything', async () => {
      session.current = RequestContext.platform('nobody');
      const loose = (await col('users').findOne({ _id: new mongoose.Types.ObjectId(user.LOOSE) }))!;
      const res = await registerWith(await codeOf('AGUS'), { email: loose.email }).expect(201, { status: 'verification_sent' });
      // P19.12-T2 AC-3 (ADR-0245 §3): no session for an address that already had an account.
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await col('memberships').countDocuments({ userId: user.LOOSE })).toBe(0);
      expect(notices('member.tagged_by_leader')).toEqual([]);
    });

    it('P19.10-T1 a leader’s link is ignored beside an invite, which names its own leader', async () => {
      const token = tokenOf((await add({ agentCode: '80777', joinDate: '2026-10-20' }).expect(200)).body.link);
      session.current = RequestContext.platform('nobody');
      await http().post('/auth/register').send({
        email: 'both@new.test', password: 'a long enough password', fullName: 'Both Ways', agentCode: '11111',
        dateOfBirth: '1995-03-15', companyJoinMonth: '2026-10', workStatus: 'full_time', gender: 'male',
        companyId, inviteToken: token, leaderCode: await codeOf('PEER'),
      }).expect(201);
      const account = (await col('users').findOne({ email: 'both@new.test' }))!;
      expect(await membershipOf(String(account._id))).toMatchObject({ leaderId: id.AGUS, joinDate: '2026-10-20' });
    });

    it('P19.10-T1 AC-3 somebody waiting in the office who asked a leader is placed by another’s code at once; their request is cancelled', async () => {
      const code = await codeOf('AGUS');
      await signIn('PUTRI');
      const res = await redeem(code).expect(200);
      expect(res.body).toEqual({ kpmId: KPM_A, leaderName: 'Agus Prasetyo' });
      expect(await membershipOf(user.PUTRI)).toMatchObject({
        _id: new mongoose.Types.ObjectId(id.PUTRI), status: 'active', leaderId: id.AGUS, role: 'agent', joinDate: TODAY, joinedAs: 'new_hire',
      });
      // Their request to Sari is moot: nobody's inbox asks about somebody already in.
      expect(await col('joinRequests').findOne({ membershipId: id.PUTRI })).toMatchObject({ status: 'cancelled' });
      expect(started).toEqual([id.PUTRI]);
      expect(notices('member.tagged_by_leader')).toEqual([expect.objectContaining({
        userId: user.AGUS, payload: { joinerName: 'Putri Anggraini', via: 'leader-code', code },
      })]);
      expect(await audits('leader_code.redeemed')).toEqual([expect.objectContaining({
        targetId: id.PUTRI, after: expect.objectContaining({ leaderId: id.AGUS, via: 'leader_code', code, joinDate: TODAY }),
      })]);
      // The edge from registration is closed, and one naming the leader is open.
      const edges = await col('membershipHistory').find({ membershipId: id.PUTRI }).sort({ validFrom: 1 }).toArray();
      expect(edges.filter((e) => e.validTo === null)).toEqual([expect.objectContaining({ eventType: 'joined', toLeaderId: id.AGUS })]);
    });

    it('P19.10-T1 AC-3 somebody waiting who asked nobody is placed by a code too, under whichever leader holds it', async () => {
      await signIn('FAJAR');
      await redeem(await codeOf('RINA')).expect(200);
      expect(await membershipOf(user.FAJAR)).toMatchObject({ status: 'active', leaderId: id.RINA });
    });

    it('P19.10-T1 AC-4 somebody waiting in another office is refused, in words that say so, and nothing moves', async () => {
      await signIn('PUTRI');
      const code = await codeOf('B_OWNER');
      const res = await http().post('/join/redeem').set(...IN_INDONESIAN).send({ code }).expect(409);
      expect(res.body.error).toMatchObject({
        code: 'ORG_AGENT_ALREADY_TAGGED',
        message: 'Anda sedang menunggu bergabung di KPM lain. Kode ini untuk KPM yang berbeda, jadi tidak dapat menempatkan Anda.',
      });
      expect((await redeem(code).expect(409)).body.error.message).toMatch(/waiting to join another office/);
      expect(await membershipOf(user.PUTRI)).toMatchObject({ status: 'pending', leaderId: null });
      expect(await col('memberships').countDocuments({ userId: user.PUTRI })).toBe(1);
    });

    it('P19.10-T1 AC-4 somebody active is refused before the code is read, as before', async () => {
      await signIn('RINA');
      const valid = await redeem(await codeOf('PEER')).expect(409);
      const unknown = await redeem('ZZZZZZ').expect(409);
      expect(valid.body.error).toEqual(unknown.body.error);
      expect(await membershipOf(user.RINA)).toMatchObject({ leaderId: id.SARI });
    });
  });

  // ------------------------------------------------------------------ transfers

  describe('transfer requests, decided by the office', () => {
    const transfer = async () => {
      const res = await add({ agentCode: '10007' }).expect(200);
      return res.body.transfer.transferId as string;
    };

    it('P18.8-T3 AC-3 the Owner approves: the member moves with history — the old edge closed, a re_parented one open — and three people are told', async () => {
      const transferId = await transfer();
      sent.length = 0;
      await signIn('OWNER');
      expect((await http().get('/transfer-requests').expect(200)).body.map((t: { transferId: string }) => t.transferId)).toEqual([transferId]);
      clock.advance(60_000);
      expect((await http().post(`/transfer-requests/${transferId}/approve`).expect(200)).body).toEqual([]);
      const lina = (await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id.PEER_AGENT) }))!;
      expect(lina).toMatchObject({ leaderId: id.AGUS, ancestorIds: [id.OWNER, id.AGUS], depth: 2 });
      const edges = await col('membershipHistory').find({ membershipId: id.PEER_AGENT }).sort({ validFrom: 1 }).toArray();
      expect(edges.map((e) => [e.eventType, e.toLeaderId, e.validTo === null])).toEqual([['joined', id.PEER, false], ['re_parented', id.AGUS, true]]);
      expect(edges[1]).toMatchObject({ fromLeaderId: id.PEER });
      // Both leaders' counts follow the move.
      expect((await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id.PEER) }))!.directCounts.total).toBe(0);
      expect((await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id.AGUS) }))!.directCounts.total).toBe(2);
      expect(await col('transferRequests').findOne({})).toMatchObject({ status: 'approved', decidedByMembershipId: id.OWNER });
      // Whoever asked is told before the leader they left (P19.12-T4); Agus asked and is the new leader, told once.
      expect(notices('transfer_request.decided').map((n) => [n.userId, n.payload!.audience])).toEqual([
        [user.PEER_AGENT, 'member'], [user.AGUS, 'requester'], [user.PEER, 'from_leader'],
      ]);
      expect(await audits('transfer_request.approved')).toHaveLength(1);
      await signIn('AGUS');
      expect((await http().get('/new-hires/transfers').expect(200)).body).toEqual([]);
    });

    it('P18.8-T3 AC-3 declining moves nothing and tells whoever asked, with the reason; deciding twice is 409', async () => {
      const transferId = await transfer();
      sent.length = 0;
      await signIn('ADMIN');
      await http().post(`/transfer-requests/${transferId}/decline`).send({ reason: 'Not this month.' }).expect(200, []);
      expect((await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id.PEER_AGENT) }))!.leaderId).toBe(id.PEER);
      expect(notices('transfer_request.decided')).toEqual([expect.objectContaining({
        userId: user.AGUS, payload: expect.objectContaining({ decision: 'declined', audience: 'requester', reason: 'Not this month.' }),
      })]);
      expect(await audits('transfer_request.declined')).toHaveLength(1);
      expect((await http().post(`/transfer-requests/${transferId}/approve`).expect(409)).body.error.code).toBe('ORG_REQUEST_ALREADY_DECIDED');
    });

    it('P18.8-T3 AC-3 a loop is refused at the decision too: the destination moved under the member since', async () => {
      const transferId = await transfer();
      // Agus is moved under Lina by the office, so moving Lina under Agus would make her her own ancestor.
      await hierarchy.reparent(job(KPM_A), id.AGUS, id.PEER_AGENT);
      await signIn('OWNER');
      expect((await http().post(`/transfer-requests/${transferId}/approve`).expect(409)).body.error.code).toBe('ORG_CYCLE_DETECTED');
      expect(await col('transferRequests').findOne({})).toMatchObject({ status: 'pending' });
    });

    it('P18.8-T3 AC-7 only the Owner and the Admins decide: an AB, an AAB and an Agent are 403; another office’s request is 404', async () => {
      const transferId = await transfer();
      for (const who of ['AGUS', 'SARI', 'RINA'] as const) {
        await signIn(who);
        await http().get('/transfer-requests').expect(403);
        await http().post(`/transfer-requests/${transferId}/approve`).expect(403);
        await http().post(`/transfer-requests/${transferId}/decline`).expect(403);
      }
      await signIn('B_OWNER', { owner: true });
      expect((await http().get('/transfer-requests').expect(200)).body).toEqual([]);
      await http().post(`/transfer-requests/${transferId}/approve`).expect(404);
      await http().post(`/transfer-requests/${transferId}/decline`).expect(404);
      expect(await col('transferRequests').findOne({})).toMatchObject({ status: 'pending' });
    });
  });

  // ------------------------------------------------------------------ the edges

  describe('the edges: races, people who left, a code invited again', () => {
    const setStatus = (who: Who, status: string) =>
      col('memberships').updateOne({ _id: new mongoose.Types.ObjectId(id[who]) }, { $set: { status } });

    it('P18.8-T3 AC-2 two forms at once for one code make one invite; the other is 409 ORG_INVITE_PENDING', async () => {
      const [a, b] = await Promise.all([add({ agentCode: '80777' }), add({ agentCode: '80777' })]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect([a.body, b.body].find((x) => x.error)?.error.code).toBe('ORG_INVITE_PENDING');
      expect(await col('memberInvites').countDocuments({ status: 'pending' })).toBe(1);
    });

    it('P18.8-T3 AC-3 two forms at once for one member make one transfer; the other is 409 ORG_TRANSFER_PENDING', async () => {
      const [a, b] = await Promise.all([add({ agentCode: '10007' }), add({ agentCode: '10007' })]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect([a.body, b.body].find((x) => x.error)?.error.code).toBe('ORG_TRANSFER_PENDING');
      expect(await col('transferRequests').countDocuments({ status: 'pending' })).toBe(1);
    });

    it('P18.8-T3 AC-2 an expired invite’s code invited again since cannot be resent: 409 ORG_INVITE_PENDING', async () => {
      await add({ agentCode: '80777' }).expect(200);
      const first = String((await col('memberInvites').findOne({}))!._id);
      clock.advance(15 * DAY_MS);
      await signIn('PEER');
      await add({ agentCode: '80777' }).expect(200);
      await signIn('AGUS');
      expect((await http().post(`/new-hires/invites/${first}/resend`).expect(409)).body.error.code).toBe('ORG_INVITE_PENDING');
      // Accepted and cancelled invites are not resent either.
      await col('memberInvites').updateOne({ _id: new mongoose.Types.ObjectId(first) }, { $set: { status: 'accepted' } });
      expect((await http().post(`/new-hires/invites/${first}/resend`).expect(409)).body.error.code).toBe('ORG_REQUEST_ALREADY_DECIDED');
    });

    it('P18.8-T3 AC-3 approving a transfer for somebody who has left closes it, 409 ORG_ALREADY_REMOVED; to a leader who left, 422', async () => {
      const first = (await add({ agentCode: '10007' }).expect(200)).body.transfer.transferId;
      await setStatus('PEER_AGENT', 'removed');
      await signIn('OWNER');
      expect((await http().post(`/transfer-requests/${first}/approve`).expect(409)).body.error.code).toBe('ORG_ALREADY_REMOVED');
      expect(await col('transferRequests').findOne({ _id: new mongoose.Types.ObjectId(first) })).toMatchObject({ status: 'cancelled' });
      await setStatus('PEER_AGENT', 'active');
      await signIn('AGUS');
      const second = (await add({ agentCode: '10007' }).expect(200)).body.transfer.transferId;
      await setStatus('AGUS', 'removed');
      await signIn('OWNER');
      expect((await http().post(`/transfer-requests/${second}/approve`).expect(422)).body.error.code).toBe('ORG_LEADER_NOT_IN_KPM');
      await http().post('/transfer-requests/not-an-id/approve').expect(404);
    });

    it('P18.8-T8 L4 approving a transfer whose member moved since is 409 ORG_TRANSFER_STALE: the request is closed, nobody moves', async () => {
      const transferId = (await add({ agentCode: '10007' }).expect(200)).body.transfer.transferId;
      // The office moved Lina under the Admin meanwhile.
      await hierarchy.reparent(job(KPM_A), id.PEER_AGENT, id.ADMIN);
      await signIn('OWNER');
      const res = await http().post(`/transfer-requests/${transferId}/approve`).expect(409);
      expect(res.body.error).toMatchObject({ code: 'ORG_TRANSFER_STALE', details: { transferId } });
      expect(await col('transferRequests').findOne({})).toMatchObject({ status: 'cancelled', decidedByMembershipId: id.OWNER });
      expect((await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id.PEER_AGENT) }))!.leaderId).toBe(id.ADMIN);
      expect(await audits('transfer_request.approved')).toHaveLength(0);
    });

    it('P18.8-T8 L4 a move that fails leaves the request waiting, never approved with nobody moved; approving again moves them', async () => {
      const transferId = (await add({ agentCode: '10007' }).expect(200)).body.transfer.transferId;
      await signIn('OWNER');
      const reparent = jest.spyOn(hierarchy, 'reparent').mockRejectedValueOnce(new Error('the database went away'));
      try {
        await http().post(`/transfer-requests/${transferId}/approve`).expect(500);
        expect(await col('transferRequests').findOne({})).toMatchObject({ status: 'pending', decidedAt: null, decidedByMembershipId: null });
        expect((await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id.PEER_AGENT) }))!.leaderId).toBe(id.PEER);
      } finally {
        reparent.mockRestore();
      }
      await http().post(`/transfer-requests/${transferId}/approve`).expect(200);
      expect((await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id.PEER_AGENT) }))!.leaderId).toBe(id.AGUS);
    });

    it('P18.8-T8 L3 two accepts at once place the person once: the other is a 4xx, never a duplicate key’s 500', async () => {
      const token = tokenOf((await add({ agentCode: '20001' }).expect(200)).body.link);
      session.current = new RequestContext(user.LOOSE, 'none', null);
      const [a, b] = await Promise.all([
        http().post(`/invites/${encodeURIComponent(token)}/accept`), http().post(`/invites/${encodeURIComponent(token)}/accept`),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(200);
      expect([404, 409]).toContain(statuses[1]);
      expect(await col('memberships').countDocuments({ userId: user.LOOSE })).toBe(1);
      expect(await col('memberInvites').findOne({})).toMatchObject({ status: 'accepted', acceptedMembershipId: expect.any(String) });
    });

    it('P18.8-T8 L3 the accept is a compare-and-set: an invite accepted between the read and the write is 409 ORG_REQUEST_ALREADY_DECIDED', async () => {
      const token = tokenOf((await add({ agentCode: '20001' }).expect(200)).body.link);
      session.current = new RequestContext(user.LOOSE, 'none', null);
      const findById = members.findById.bind(members);
      // Another accept lands after this one read the invite, and before it claims it.
      const raced = jest.spyOn(members, 'findById').mockImplementationOnce(async (ctx, membershipId) => {
        await col('memberInvites').updateOne({}, { $set: { status: 'accepted' } });
        return findById(ctx, membershipId);
      });
      try {
        const res = await http().post(`/invites/${encodeURIComponent(token)}/accept`).expect(409);
        expect(res.body.error).toMatchObject({ code: 'ORG_REQUEST_ALREADY_DECIDED', details: { status: 'accepted' } });
      } finally {
        raced.mockRestore();
      }
      expect(await membershipOf(user.LOOSE)).toBeNull();
    });

    it('P18.8-T8 L3 a placement refused after the claim puts the invite back, waiting — a duplicate key is 409 ORG_AGENT_ALREADY_TAGGED', async () => {
      const token = tokenOf((await add({ agentCode: '20001' }).expect(200)).body.link);
      session.current = new RequestContext(user.LOOSE, 'none', null);
      const create = jest.spyOn(hierarchy, 'create').mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
      try {
        expect((await http().post(`/invites/${encodeURIComponent(token)}/accept`).expect(409)).body.error.code).toBe('ORG_AGENT_ALREADY_TAGGED');
      } finally {
        create.mockRestore();
      }
      expect(await col('memberInvites').findOne({})).toMatchObject({ status: 'pending', acceptedAt: null });
      await http().post(`/invites/${encodeURIComponent(token)}/accept`).expect(200);
      expect(await col('memberInvites').findOne({})).toMatchObject({ status: 'accepted' });
    });

    it('P18.8-T3 AC-4 accepting after the leader has left is 422 ORG_LEADER_NOT_IN_KPM, and nobody is placed', async () => {
      const token = tokenOf((await add({ agentCode: '20001' }).expect(200)).body.link);
      await setStatus('AGUS', 'removed');
      session.current = new RequestContext(user.LOOSE, 'none', null);
      expect((await http().post(`/invites/${encodeURIComponent(token)}/accept`).expect(422)).body.error.code).toBe('ORG_LEADER_NOT_IN_KPM');
      expect(await membershipOf(user.LOOSE)).toBeNull();
    });

    it('P18.8-T3 AC-7 the Owner naming a leader who has left is 422 ORG_LEADER_NOT_IN_KPM; a suspended office’s link opens nothing', async () => {
      await setStatus('PEER', 'removed');
      await signIn('OWNER');
      expect((await add({ agentCode: '80777', leaderMembershipId: id.PEER }).expect(422)).body.error.code).toBe('ORG_LEADER_NOT_IN_KPM');
      await signIn('AGUS');
      const token = tokenOf((await add({ agentCode: '80777' }).expect(200)).body.link);
      await col('kpms').updateOne({ _id: new mongoose.Types.ObjectId(KPM_A) }, { $set: { status: 'suspended' } });
      await http().get(`/invites/${encodeURIComponent(token)}`).expect(404);
    });
  });

  // ------------------------------------------------------------------ Find Your Leader

  describe('Find Your Leader (AC-6)', () => {
    it('P18.8-T3 AC-6 never lists the reader or anybody below them', async () => {
      await signIn('ORPHAN');
      const names = (await http().get('/join/leaders').expect(200)).body.map((l: { fullName: string }) => l.fullName);
      expect(names).not.toContain('Bayu Saputra');
      expect(names).not.toContain('Citra Dewi');
      expect(names).toEqual(expect.arrayContaining(['Wilson Tan', 'Agus Prasetyo', 'Sari Puspita']));
      await signIn('AGUS');
      const agus = (await http().get('/join/leaders').expect(200)).body.map((l: { fullName: string }) => l.fullName);
      expect(agus).not.toContain('Agus Prasetyo');
      expect(agus).not.toContain('Sari Puspita');
    });

    it('P18.8-T3 AC-6 a request to somebody in the reader’s own unit is refused when sent, 409 ORG_CYCLE_DETECTED; nobody is notified', async () => {
      await signIn('ORPHAN');
      const res = await http().post('/join/leader-request').send({ leaderMembershipId: id.ORPHAN_AAB }).expect(409);
      expect(res.body.error.code).toBe('ORG_CYCLE_DETECTED');
      expect(await col('joinRequests').countDocuments({ membershipId: id.ORPHAN })).toBe(0);
      expect(notices('join_request.received')).toEqual([]);
      // Somebody outside it is asked as before.
      await http().post('/join/leader-request').send({ leaderMembershipId: id.PEER }).expect(200);
    });

    it('P18.8-T3 AC-6 a reader who already has a leader is refused as before, 409 ORG_AGENT_ALREADY_TAGGED', async () => {
      await signIn('RINA');
      expect((await http().post('/join/leader-request').send({ leaderMembershipId: id.PEER }).expect(409)).body.error.code)
        .toBe('ORG_AGENT_ALREADY_TAGGED');
    });
  });

  // ------------------------------------------------------------------ the reader's language

  /*
   * **P18.10-T5 — joining an office, in the reader's language** (ADR-0179 §7; AC-3, AC-4, AC-6, AC-7). One refusal of
   * each family asked as an Indonesian screen asks (`Accept-Language: id`): the same `code` and `details`, the sentence
   * in Indonesian, a field's sentence in `details.violations` with it. Every other test here reads English.
   */
  describe('P18.10-T5 in Indonesian', () => {
    it('P18.10-T5 AC-7 + Add agent refuses the form’s own fields, a join date after today and a code already invited, in Indonesian', async () => {
      // The form's own fields first; the code's format is the office's template's (P19.5-T2, ADR-0214 §7), asked
      // after them — so a form wrong in both is told about the phone, then about the code.
      const fields = await add({ agentCode: 'PRU-1', phone: 'call me' }).set(...IN_INDONESIAN).expect(400);
      expect(fields.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: {
          violations: [
            'phone harus berupa nomor telepon: angka, spasi, atau tanda hubung, dengan paling banyak satu + di depan',
          ],
        },
      });
      const code = await add({ agentCode: 'PRU-1' }).set(...IN_INDONESIAN).expect(400);
      expect(code.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { violations: ['agentCode hanya boleh berisi angka, 3 sampai 32 digit'] },
      });
      const english = await add({ agentCode: 'PRU-1' }).expect(400);
      expect(english.body.error.message).toBe('agentCode must be digits only, 3 to 32 of them');

      const future = await add({ agentCode: '80777', joinDate: '2026-10-28' }).set(...IN_INDONESIAN).expect(400);
      expect(future.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'joinDate tidak boleh setelah hari ini.',
        details: { violations: ['joinDate tidak boleh setelah hari ini.'] },
      });

      await add({ agentCode: '80777' }).expect(200);
      const waiting = await add({ agentCode: '80777' }).set(...IN_INDONESIAN).expect(409);
      expect(waiting.body.error).toMatchObject({
        code: 'ORG_INVITE_PENDING',
        message: 'Kode agen 80777 sudah memiliki undangan yang menunggu diterima. Kirim ulang undangan itu, atau batalkan dulu.',
        details: { agentCode: '80777' },
      });
    });

    it('P18.10-T5 AC-7 an invite: a link that opens nothing, and one cancelled twice, in Indonesian', async () => {
      const nothing = await http().get('/invites/nonsense').set(...IN_INDONESIAN).expect(404);
      expect(nothing.body.error).toMatchObject({
        code: 'NOT_FOUND',
        message: 'Tautan undangan ini tidak valid. Pastikan Anda membuka seluruh tautannya, atau minta tautan baru kepada '
          + 'pengirimnya.',
      });
      await add({ agentCode: '80777' }).expect(200);
      const inviteId = String((await col('memberInvites').findOne({}))!._id);
      await http().delete(`/new-hires/invites/${inviteId}`).expect(200);
      const twice = await http().delete(`/new-hires/invites/${inviteId}`).set(...IN_INDONESIAN).expect(409);
      expect(twice.body.error).toMatchObject({
        code: 'ORG_REQUEST_ALREADY_DECIDED', message: 'Undangan itu sudah dibatalkan.', details: { status: 'cancelled' },
      });
      expect((await http().delete(`/new-hires/invites/${inviteId}`).expect(409)).body.error.message)
        .toBe('That invite was already cancelled.');
    });

    it('P18.10-T5 AC-4 the banner names a leader whose account is gone in the reader’s language', async () => {
      const token = tokenOf((await add({ agentCode: '80777' }).expect(200)).body.link);
      await col('users').deleteOne({ _id: new mongoose.Types.ObjectId(user.AGUS) });
      session.current = RequestContext.platform('nobody');
      const path = `/invites/${encodeURIComponent(token)}`;
      expect((await http().get(path).set(...IN_INDONESIAN).expect(200)).body.leaderName).toBe('leader Anda');
      expect((await http().get(path).expect(200)).body.leaderName).toBe('your leader');
    });

    it('P18.10-T5 AC-6, AC-7 a transfer: asked twice, decided twice, in Indonesian — and its edge’s reason stored in the decider’s', async () => {
      const first = (await add({ agentCode: '10007' }).expect(200)).body.transfer.transferId;
      const again = await add({ agentCode: '10007' }).set(...IN_INDONESIAN).expect(409);
      expect(again.body.error).toMatchObject({
        code: 'ORG_TRANSFER_PENDING', message: 'Permintaan pemindahan untuknya sudah menunggu keputusan KPM.',
      });
      await signIn('OWNER');
      await http().post(`/transfer-requests/${first}/approve`).set(...IN_INDONESIAN).expect(200);
      const edge = await col('membershipHistory').findOne({ membershipId: id.PEER_AGENT, eventType: 're_parented', validTo: null });
      expect(edge?.reason).toBe('Permintaan pemindahan disetujui');
      const decided = await http().post(`/transfer-requests/${first}/decline`).set(...IN_INDONESIAN).send({}).expect(409);
      expect(decided.body.error).toMatchObject({
        code: 'ORG_REQUEST_ALREADY_DECIDED', message: 'Permintaan pemindahan itu sudah disetujui.', details: { status: 'approved' },
      });
    });

    it('P18.10-T5 AC-7 a join request decided twice, and a tag for somebody already in a unit, in Indonesian', async () => {
      const requestId = String((await col('joinRequests').findOne({ membershipId: id.PUTRI }))!._id);
      await signIn('SARI');
      const badDate = await http().post(`/join/requests/${requestId}/approve`).set(...IN_INDONESIAN)
        .send({ joinDate: '27/10/2026' }).expect(400);
      expect(badDate.body.error.details.violations)
        .toEqual(['joinDate harus berupa tanggal yang benar, dengan format YYYY-MM-DD.']);
      await http().post(`/join/requests/${requestId}/approve`).send({}).expect(200);
      const twice = await http().post(`/join/requests/${requestId}/approve`).set(...IN_INDONESIAN).send({}).expect(409);
      expect(twice.body.error).toMatchObject({
        code: 'ORG_REQUEST_ALREADY_DECIDED', message: 'Permintaan itu sudah disetujui.', details: { status: 'approved' },
      });

      await signIn('AGUS');
      const tagged = await http().post(`/join/untagged/${id.RINA}`).set(...IN_INDONESIAN).send({}).expect(409);
      expect(tagged.body.error).toMatchObject({
        code: 'ORG_AGENT_ALREADY_TAGGED',
        message: 'Dia sudah melapor ke seseorang. Memindahkannya adalah proses yang berbeda.',
      });
    });

    it('P18.10-T5 AC-7 Find Your Leader refuses a loop and somebody who has a leader, in Indonesian', async () => {
      await signIn('ORPHAN');
      const loop = await http().post('/join/leader-request').set(...IN_INDONESIAN)
        .send({ leaderMembershipId: id.ORPHAN_AAB }).expect(409);
      expect(loop.body.error).toMatchObject({
        code: 'ORG_CYCLE_DETECTED',
        message: 'Dia melapor ke Anda, jadi dia tidak dapat menjadi leader Anda. Minta seseorang di luar unit Anda.',
      });
      await signIn('RINA');
      const led = await http().post('/join/leader-request').set(...IN_INDONESIAN)
        .send({ leaderMembershipId: id.PEER }).expect(409);
      expect(led.body.error).toMatchObject({
        code: 'ORG_AGENT_ALREADY_TAGGED',
        message: 'Anda sudah melapor ke seseorang. Pindah ke leader lain tidak dapat Anda minta di sini.',
      });
    });
  });

  // ------------------------------------------------------------------ who may

  describe('permissions, per role (AC-7)', () => {
    it('P18.8-T3 AC-7 declares one permission per route, and the link’s banner none', () => {
      expect(declaredPermissions(NewHireAgentsController)).toEqual({
        add: 'member:invite', list: 'member:invite', resend: 'member:invite', cancel: 'member:invite', myTransfers: 'member:invite',
      });
      expect(declaredPermissions(TransferRequestsController)).toEqual({
        queue: 'member:transfer_approve', approve: 'member:transfer_approve', decline: 'member:transfer_approve',
      });
      expect(declaredPermissions(InviteLinkController)).toEqual({ banner: undefined, accept: 'join_via_code_link_qr' });
    });

    it('P18.8-T3 AC-7 the invites’ routes answer the Owner, the Admin — on a rung or none — an AB and an AAB, and refuse an Agent and the Super Admin', async () => {
      const base = await as('ADMIN');
      // An Admin standing on no rung the matrix names: the office's grant alone.
      const officeOnly = new RequestContext(base.userId, 'none', { ...base.membership!, orgLevelCode: 'NO_RUNG', hierarchyRole: NO_CLASS });
      for (const ctx of [await as('OWNER'), base, officeOnly, await as('AGUS'), await as('SARI')]) {
        session.current = ctx;
        await http().get('/new-hires/invites').expect(200);
        await http().get('/new-hires/transfers').expect(200);
      }
      for (const ctx of [await as('RINA'), RequestContext.platform('root')]) {
        session.current = ctx;
        await http().get('/new-hires/invites').expect(403);
        await http().get('/new-hires/transfers').expect(403);
        await http().post('/new-hires/invites/66f0000000000000000000a1/resend').expect(403);
        await http().delete('/new-hires/invites/66f0000000000000000000a1').expect(403);
      }
    });

    it('P18.8-T3 AC-7 a read-only support session reads nothing it would need the write to use, and writes nothing', async () => {
      const base = await as('AGUS');
      session.current = new RequestContext(base.userId, 'none', base.membership, 'u-support', null, false, true);
      await add({ agentCode: '80777' }).expect(403);
      await http().get('/new-hires/invites').expect(403);
      expect(await col('memberInvites').countDocuments({})).toBe(0);
    });
  });

  // ------------------------------------------------------------------ P19.1-T6: Tambahkan ke unit ›

  describe('P19.1-T6 AC-7 Tambahkan ke unit › — the recruitment lead the form came from names who they became', () => {
    /** A recruitment lead of `owner`'s, marked *Berhasil* at the final Recruit stage this month. */
    const rekrut = async (owner: string, kpmId = KPM_A, over: Record<string, unknown> = {}) => {
      const { insertedId } = await col('leads').insertOne({
        kpmId, ownerMembershipId: owner, type: 'recruitment', name: 'Sdri. Maya Lestari', statusCode: 'NEW_ACTIVE_AGENT',
        statusId: null, outcome: 'won', outcomeAt: new Date('2026-10-20T03:00:00Z'), contact: { phone: null, email: null },
        commitments: [{ month: '2026-10', at: new Date('2026-10-02T03:00:00Z'), byMembershipId: owner }],
        transitions: [], version: 3, joinedMembershipId: null, deletedAt: null, dateRegistered: new Date('2026-09-01T03:00:00Z'),
        ...over,
      });
      return String(insertedId);
    };
    const linkOf = async (leadId: string) =>
      (await col('leads').findOne({ _id: new mongoose.Types.ObjectId(leadId) }))!.joinedMembershipId;

    it('P19.1-T6 AC-7 a code linking somebody in the office now writes the link at once, audited without a name', async () => {
      const lead = await rekrut(id.RINA);
      const res = await add({ agentCode: '10009', recruitLeadId: lead }).expect(200);
      expect(res.body).toMatchObject({ outcome: 'linked', member: { membershipId: id.FAJAR } });
      expect(await linkOf(lead)).toBe(id.FAJAR);
      const [entry] = await audits('lead.recruit_linked');
      expect(entry).toMatchObject({ targetId: lead, targetMembershipId: id.FAJAR, after: { joinedMembershipId: id.FAJAR } });
      expect(JSON.stringify(entry)).not.toContain('Maya');
    });

    it('P19.1-T6 AC-7 an invite carries the lead, and accepting it writes the link to the membership it made', async () => {
      const lead = await rekrut(id.RINA);
      const token = tokenOf((await add({ agentCode: '20001', recruitLeadId: lead }).expect(200)).body.link);
      expect(await col('memberInvites').findOne({ agentCode: '20001' })).toMatchObject({ recruitLeadId: lead });
      expect(await linkOf(lead)).toBeNull();
      session.current = new RequestContext(user.LOOSE, 'none', null);
      await http().post(`/invites/${encodeURIComponent(token)}/accept`).expect(200);
      const joined = await membershipOf(user.LOOSE);
      expect(await linkOf(lead)).toBe(String(joined!._id));
    });

    it('P19.1-T6 AC-12 another office’s lead is refused 404 and nothing is written — no invite, no link', async () => {
      const theirs = await rekrut(id.B_AGENT, KPM_B);
      const res = await add({ agentCode: '80777', recruitLeadId: theirs }).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(await col('memberInvites').countDocuments({})).toBe(0);
      expect(await linkOf(theirs)).toBeNull();
    });

    it('P19.1-T6 AC-12 a lead outside the adder’s reach, an open one, a sales one, or one linked already is 404 alike', async () => {
      const peers = await rekrut(id.PEER_AGENT);
      const open = await rekrut(id.RINA, KPM_A, { outcome: null, outcomeAt: null, statusCode: 'AGENT_CODE_CREATED' });
      const sales = await rekrut(id.RINA, KPM_A, { type: 'sales', statusCode: 'PAID_AND_ISSUED' });
      const linked = await rekrut(id.RINA, KPM_A, { joinedMembershipId: id.SARI });
      for (const lead of [peers, open, sales, linked]) {
        expect((await add({ agentCode: '80777', recruitLeadId: lead }).expect(404)).body.error.code).toBe('NOT_FOUND');
      }
      expect(await col('memberInvites').countDocuments({})).toBe(0);
      expect(await linkOf(linked)).toBe(id.SARI);
    });

    it('P19.1-T6 AC-7 recruitLeadId is a lead id, or the form is refused 400 by name', async () => {
      const res = await add({ agentCode: '80777', recruitLeadId: 'not-an-id' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.error.details)).toContain('recruitLeadId');
    });
  });
});
