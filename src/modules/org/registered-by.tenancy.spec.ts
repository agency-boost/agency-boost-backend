import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { ApprovalsService } from './approvals.service';
import { HierarchyService } from './hierarchy.service';
import { InvitesService } from './invites.service';
import { JoinRequest, JoinRequestSchema } from './join-request.schema';
import { LeaderCodeService } from './leader-code.service';
import { MemberInvite, MemberInviteSchema } from './member-invite.schema';
import { MemberNames } from './member-names.service';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import {
  JoinRequestRepository, MemberInviteRepository, MembershipHistoryRepository, TransferRequestRepository,
} from './org.repositories';
import { recruitCountsByRecruiter, recruitsJoined } from './recruits';
import { TransferRequest, TransferRequestSchema } from './transfer-request.schema';
import { TransfersService } from './transfers.service';

/** 10:00 on Friday 20 November 2026 in Jakarta. */
const NOW = new Date('2026-11-20T03:00:00Z');
const TODAY = '2026-11-20';
const NOVEMBER = { from: '2026-11-01', to: '2026-11-30' };
const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();

type Who = 'OWNER' | 'AGUS' | 'SARI' | 'PEER' | 'PUTRI' | 'FAJAR' | 'B_OWNER';

/**
 * **Who registered each person, on every path that places one, and the recruits it credits** (P19.17-T1 AC-3;
 * ADR-0267 §3; `RECRUITS_JOINED`). The real services on an office built through `HierarchyService`:
 *
 * ```
 * Office A:  OWNER (AB, the Owner) ─┬── AGUS (AB) ── SARI (AAB)
 *                                   └── PEER (AB)
 *            PUTRI (pending, asked Sari) · FAJAR (pending, asked nobody)
 * Office B:  B_OWNER (AB, its Owner)
 * ```
 */
describe('P19.17-T1 AC-3 who registered each person, and Recruitment', () => {
  let clock: FixedClock;
  let hierarchy: HierarchyService;
  let approvals: ApprovalsService;
  let invites: InvitesService;
  let leaderCodes: LeaderCodeService;
  let members: MembershipRepository;
  let requests: JoinRequestRepository;
  let companyId: string;
  let id: Record<Who, string>;
  const col = (name: string) => mongoose.connection.db!.collection(name);
  const job = (kpmId: string) => RequestContext.forJob(kpmId, 'registered-by-spec');

  beforeAll(async () => {
    await startMongo();
    clock = new FixedClock(NOW);
    const users = mongoose.model(User.name, UserSchema);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    const companies = mongoose.model(Company.name, CompanySchema);
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    const history = new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never);
    requests = new JoinRequestRepository(mongoose.model(JoinRequest.name, JoinRequestSchema) as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never, companies as never, kpms as never, audit, clock,
    );
    hierarchy = new HierarchyService(members, kpms as never, users as never, history, clock, orgLevels);
    const notifications = { send: async () => undefined } as never;
    const activations = { joined: async () => undefined };
    approvals = new ApprovalsService(members, hierarchy, requests, history, users as never, audit, notifications, clock, activations);
    const names = new MemberNames(members, users as never);
    const transfers = new TransfersService(
      new TransferRequestRepository(mongoose.model(TransferRequest.name, TransferRequestSchema) as never),
      members, hierarchy, names, kpms as never, audit, notifications, clock,
    );
    invites = new InvitesService(
      new MemberInviteRepository(mongoose.model(MemberInvite.name, MemberInviteSchema) as never), members, hierarchy, approvals,
      transfers, requests, names, kpms as never, companies as never, users as never, audit, notifications, clock, activations,
    );
    leaderCodes = new LeaderCodeService(
      members, hierarchy, requests, approvals, kpms as never, companies as never, users as never, audit, notifications, clock,
      activations,
    );
    await syncIndexes();
  });
  afterAll(stopMongo);

  let seq = 0;
  async function account(fullName: string, agentCode: string, extra: Record<string, unknown> = {}): Promise<string> {
    seq += 1;
    const u = await mongoose.model(User.name).create({
      email: `r${seq}@kpm.test`, passwordHash: 'x', fullName, status: 'active', platformRole: 'none', companyId, agentCode, ...extra,
    });
    return String(u._id);
  }

  async function place(kpmId: string, userId: string, role: 'ab' | 'aab' | 'agent', leaderId: string | null, status: 'active' | 'pending' = 'active') {
    const m = await hierarchy.create(job(kpmId), {
      userId, role, leaderId, status, ...(status === 'active' ? { joining: { joinDate: '2025-01-02' } } : {}),
    });
    return String(m._id);
  }

  async function as(who: Who | string, flags: { owner?: boolean } = {}): Promise<RequestContext> {
    const membershipId = (id as Record<string, string>)[who] ?? who;
    const row = (await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(membershipId) }))!;
    return new RequestContext(String(row.userId), 'none', {
      membershipId, kpmId: row.kpmId, orgLevelCode: String(row.role).toUpperCase(), hierarchyRole: row.role,
      status: row.status, isKpmOwner: flags.owner ?? (who === 'OWNER' || who === 'B_OWNER'), isKpmAdmin: false,
      directCount: row.directCounts?.total ?? 0,
    });
  }

  const row = (membershipId: string) => col('memberships').findOne({ _id: new mongoose.Types.ObjectId(membershipId) });
  const membershipOf = (userId: string) => col('memberships').findOne({ userId, status: { $in: ['active', 'pending'] } });

  beforeEach(async () => {
    clock.set(NOW);
    await clearCollections();
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `pru-${Math.random()}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    const u = {} as Record<Who, string>;
    const people: [Who, string, string][] = [
      ['OWNER', 'Wilson Tan', '10001'], ['AGUS', 'Agus Prasetyo', '10003'], ['SARI', 'Sari Puspita', '10004'],
      ['PEER', 'Hendra Gunawan', '10006'], ['PUTRI', 'Putri Anggraini', '10008'], ['FAJAR', 'Fajar Nugroho', '10009'],
      ['B_OWNER', 'Hendra Wijaya', '30001'],
    ];
    for (const [who, name, code] of people) u[who] = await account(name, code);
    for (const [kpmId, code, ownerUserId] of [[KPM_A, '0417', u.OWNER], [KPM_B, '0555', u.B_OWNER]]) {
      await mongoose.model(Kpm.name).create({
        _id: kpmId, companyId, code, branchName: code, counters: { nextMemberSeq: 1 }, status: 'active',
        timezone: 'Asia/Jakarta', ownerUserId,
      });
    }
    const i = {} as Record<Who, string>;
    i.OWNER = await place(KPM_A, u.OWNER, 'ab', null);
    i.AGUS = await place(KPM_A, u.AGUS, 'ab', i.OWNER);
    i.SARI = await place(KPM_A, u.SARI, 'aab', i.AGUS);
    i.PEER = await place(KPM_A, u.PEER, 'ab', i.OWNER);
    i.PUTRI = await place(KPM_A, u.PUTRI, 'agent', null, 'pending');
    i.FAJAR = await place(KPM_A, u.FAJAR, 'agent', null, 'pending');
    i.B_OWNER = await place(KPM_B, u.B_OWNER, 'ab', null);
    id = i;
    await requests.create(job(KPM_A), { membershipId: i.PUTRI, leaderMembershipId: i.SARI, status: 'pending' });
  });

  describe('every path that places a person writes who registered them', () => {
    it('an invitation the Owner sent for Agus’s unit: the Owner registered them, Agus leads them', async () => {
      const sent = await invites.addAgent(await as('OWNER'), {
        agentCode: '40001', fullName: 'Hendra Baru', phone: '0812-3456-7890', leaderMembershipId: id.AGUS,
      }, 'https://app.agencyboost.test');
      if (sent.outcome !== 'invited') throw new Error(`expected an invitation, got ${sent.outcome}`);
      const token = decodeURIComponent(new URL(sent.link).searchParams.get('invite')!);
      const joiner = await account('Hendra Baru', '40001');
      await invites.acceptForNewAccount(token, joiner);

      expect(await membershipOf(joiner)).toMatchObject({
        registeredByMembershipId: id.OWNER, recruitedByMembershipId: id.AGUS, leaderId: id.AGUS,
        joinedAs: 'new_hire', joinDate: TODAY,
      });
    });

    it('a newcomer on Agus’s link: Agus registered them', async () => {
      const joiner = await account('Dian Lestari', '40002');
      await leaderCodes.joinNewAccount(String((await row(id.AGUS))!.leaderCode), joiner);
      expect(await membershipOf(joiner)).toMatchObject({ registeredByMembershipId: id.AGUS, leaderId: id.AGUS });
    });

    it('somebody waiting who redeems Sari’s code: Sari registered them', async () => {
      await leaderCodes.redeem(await as('FAJAR'), String((await row(id.SARI))!.leaderCode));
      expect(await row(id.FAJAR)).toMatchObject({ registeredByMembershipId: id.SARI, leaderId: id.SARI, status: 'active' });
    });

    it('a request to join Sari the Owner approves: Sari, the leader they asked for — never the approver', async () => {
      const [request] = await requests.find(job(KPM_A), { membershipId: id.PUTRI, status: 'pending' });
      await approvals.approve(await as('OWNER'), String(request._id));
      expect(await row(id.PUTRI)).toMatchObject({ registeredByMembershipId: id.SARI, leaderId: id.SARI, status: 'active' });
    });

    it('a leader who tags somebody waiting: that leader', async () => {
      await approvals.tag(await as('AGUS'), id.FAJAR);
      expect(await row(id.FAJAR)).toMatchObject({ registeredByMembershipId: id.AGUS, leaderId: id.AGUS });
    });

    it('+ Tambah agent for somebody already waiting, the Owner placing them under Peer: the Owner', async () => {
      const added = await invites.addAgent(await as('OWNER'), {
        agentCode: '10009', fullName: 'Fajar Nugroho', phone: '0812-3456-7890', leaderMembershipId: id.PEER,
      }, 'https://app.agencyboost.test');
      expect(added.outcome).toBe('linked');
      expect(await row(id.FAJAR)).toMatchObject({ registeredByMembershipId: id.OWNER, leaderId: id.PEER });
    });

    it('a membership made directly names whoever the caller gives, and nobody when none is given (an Owner)', async () => {
      const imported = await hierarchy.createWithAccount(job(KPM_A), {
        role: 'agent', leaderId: id.AGUS, status: 'active', registeredByMembershipId: id.OWNER,
        joining: { joinedAs: 'existing_agent' },
      }, () => account('Rudi Hartono', '40003'));
      expect(await row(String(imported._id))).toMatchObject({ registeredByMembershipId: id.OWNER, joinedAs: 'existing_agent' });
      expect(await row(id.OWNER)).toMatchObject({ registeredByMembershipId: null });
      expect(await row(id.PUTRI)).toMatchObject({ registeredByMembershipId: null });
    });

    it('is written once: somebody placed again keeps who registered them', async () => {
      await approvals.tag(await as('AGUS'), id.FAJAR);
      await hierarchy.moveUnder(job(KPM_A), id.FAJAR, null);
      await approvals.tag(await as('PEER'), id.FAJAR);
      expect(await row(id.FAJAR)).toMatchObject({ registeredByMembershipId: id.AGUS, leaderId: id.PEER });
    });

    it('carries the account’s test-account flag onto every membership made for it (ADR-0267 §1)', async () => {
      const tester = await account('FMT Uji', '40004', { testAccount: true });
      const real = await account('Nadia Safitri', '40005');
      const testerRow = await hierarchy.create(job(KPM_A), { userId: tester, role: 'agent', leaderId: id.AGUS, status: 'active' });
      const realRow = await hierarchy.create(job(KPM_A), { userId: real, role: 'agent', leaderId: id.AGUS, status: 'active' });
      expect((await row(String(testerRow._id)))?.testAccount).toBe(true);
      expect((await row(String(realRow._id)))?.testAccount).toBe(false);
    });
  });

  describe('RECRUITS_JOINED: the new hires who joined in the period, credited to whoever registered them', () => {
    /** A recruit placed by `registeredBy`, joined on `joinDate`, written as the paths above write one. */
    async function recruit(fullName: string, code: string, joinDate: string, registeredBy: string, extra: Record<string, unknown> = {}) {
      const userId = await account(fullName, code, extra.testAccount ? { testAccount: true } : {});
      const m = await hierarchy.create(job(KPM_A), {
        userId, role: 'agent', leaderId: id.AGUS, status: 'active', registeredByMembershipId: registeredBy,
        joining: { joinDate, joinedAs: 'new_hire' },
      });
      if (extra.status) await col('memberships').updateOne({ _id: m._id }, { $set: { status: extra.status } });
      return String(m._id);
    }

    it('lists the period’s new hires oldest first, a leaver included, with their recruiter', async () => {
      const first = await recruit('Dewi Anggraini', '50001', '2026-11-01', id.AGUS);
      const left = await recruit('Yoga Pratama', '50002', '2026-11-10', id.SARI, { status: 'removed' });
      const last = await recruit('Citra Lestari', '50003', TODAY, id.AGUS);
      // Outside the period, a test account, and an existing agent never count.
      await recruit('Lina Marlina', '50004', '2026-10-31', id.AGUS);
      await recruit('FMT Uji', '50005', '2026-11-15', id.AGUS, { testAccount: true });
      await hierarchy.create(job(KPM_A), {
        userId: await account('Bayu Saputra', '50006'), role: 'agent', leaderId: id.AGUS, status: 'active',
        registeredByMembershipId: id.AGUS, joining: { joinDate: '2026-11-12', joinedAs: 'existing_agent' },
      });

      const rows = await recruitsJoined(members, job(KPM_A), NOVEMBER);
      expect(rows.map((r) => [r.membershipId, r.joinDate, r.registeredByMembershipId, r.status])).toEqual([
        [first, '2026-11-01', id.AGUS, 'active'],
        [left, '2026-11-10', id.SARI, 'removed'],
        [last, TODAY, id.AGUS, 'active'],
      ]);
      expect(recruitCountsByRecruiter(rows)).toEqual(new Map([[id.AGUS, 2], [id.SARI, 1]]));
      // Candidates and people waiting never count: Putri and Fajar have no join date.
      expect(rows.map((r) => r.membershipId)).not.toContain(id.PUTRI);
    });

    it('narrows to the recruits credited to the members named — a unit’s, a group’s — and none for none', async () => {
      await recruit('Dewi Anggraini', '50001', '2026-11-03', id.AGUS);
      const sari = await recruit('Yoga Pratama', '50002', '2026-11-04', id.SARI);
      expect((await recruitsJoined(members, job(KPM_A), NOVEMBER, { creditedTo: [id.SARI] })).map((r) => r.membershipId))
        .toEqual([sari]);
      expect(await recruitsJoined(members, job(KPM_A), NOVEMBER, { creditedTo: [] })).toEqual([]);
    });

    it('never reads another office’s recruits, even credited to a member named from there (cross-tenant)', async () => {
      await recruit('Dewi Anggraini', '50001', '2026-11-03', id.AGUS);
      expect(await recruitsJoined(members, job(KPM_B), NOVEMBER)).toEqual([]);
      expect(await recruitsJoined(members, job(KPM_B), NOVEMBER, { creditedTo: [id.AGUS] })).toEqual([]);
    });
  });
});
