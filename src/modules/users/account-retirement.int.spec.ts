import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { ViewOnlySessionGuard } from '@/common/auth/view-only-session.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthToken, AuthTokenSchema } from '@/modules/auth/auth-token.schema';
import { DirectoryService } from '@/modules/org/directory.service';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { MemberInvite, MemberInviteSchema } from '@/modules/org/member-invite.schema';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MemberInviteRepository, MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { RemovalService } from '@/modules/org/removal.service';
import { RoleChangeService } from '@/modules/org/role-change.service';
import { UserInvitationRepository } from '@/modules/org/user-invitation.repository';
import { UserInvitation, UserInvitationSchema } from '@/modules/org/user-invitation.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { ownersOf } from '../../../test/owners';
import { AccountRetirementController } from './account-retirement.controller';
import { AccountRetirementService } from './account-retirement.service';
import { RETIRED_EMAIL_DOMAIN, retiredEmailOf, User, UserSchema } from './user.schema';

const NOW = new Date('2026-11-23T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';

/**
 * ***Hapus akun*** **over HTTP** (P19.31-T1 AC-1 to AC-5, T3 AC-1;
 * [ADR-0289](../../../../docs/04-adr/0289-the-super-admin-may-retire-an-account-so-its-address-and-code-can-be-used-again-and-its-history-stays.md)).
 *
 * KPM A: Wilson (owner, root AB), Dewi (AAB under Wilson, with Rina under her), Rina (agent), Budi (agent under Wilson,
 * the one retired). KPM B: Hendra (owner). An account in no KPM (Fajar), and a Super Admin's (Root). The sign-in, the
 * re-registration and the re-import against a retired account are `auth.e2e.int.spec.ts`'s.
 */
describe('Hapus akun — retiring an account (P19.31, ADR-0289)', () => {
  let app: INestApplication;
  let users: mongoose.Model<User>;
  let memberships: mongoose.Model<Membership>;
  let kpms: mongoose.Model<Kpm>;
  let tokens: mongoose.Model<AuthToken>;
  let audit: mongoose.Model<AuditLog>;
  let userInvitations: mongoose.Model<UserInvitation>;
  let memberInvites: mongoose.Model<MemberInvite>;
  let hierarchy: HierarchyService;
  let directory: DirectoryService;
  let removals: RemovalService;
  let service: AccountRetirementService;
  let members: MembershipRepository;
  const clock = new FixedClock(NOW);
  const sent: unknown[] = [];

  beforeAll(async () => {
    await startMongo();
    users = mongoose.model(User.name, UserSchema) as never;
    memberships = mongoose.model(Membership.name, MembershipSchema) as never;
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    tokens = mongoose.model(AuthToken.name, AuthTokenSchema) as never;
    audit = mongoose.model(AuditLog.name, AuditLogSchema) as never;
    userInvitations = mongoose.model(UserInvitation.name, UserInvitationSchema) as never;
    memberInvites = mongoose.model(MemberInvite.name, MemberInviteSchema) as never;
    const history = new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never);
    members = new MembershipRepository(memberships as never);
    const auditService = new AuditService(audit as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never, mongoose.model(Company.name, CompanySchema) as never,
      kpms as never, auditService, clock,
    );
    hierarchy = new HierarchyService(members, kpms as never, users as never, history, clock, orgLevels);
    directory = new DirectoryService(members, users as never, kpms as never);
    const notifications = { send: async (n: unknown) => { sent.push(n); } };
    const roles = new RoleChangeService(members, hierarchy, history, users as never, auditService, notifications as never, clock);
    removals = new RemovalService(members, hierarchy, roles, history, auditService, notifications as never, clock);
    service = new AccountRetirementService(
      users as never, tokens as never, kpms as never, members,
      new UserInvitationRepository(userInvitations as never), new MemberInviteRepository(memberInvites as never),
      removals, auditService, clock,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [AccountRetirementController],
      providers: [{ provide: AccountRetirementService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new ViewOnlySessionGuard(app.get(Reflector)), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
    await syncIndexes();
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  let companyId = '';
  let seq = 0;
  const ids: Record<string, string> = {};
  const m: Record<string, string> = {};
  const inA = () => RequestContext.tenantRead(KPM_A, 'spec');

  async function account(key: string, fullName: string, over: Record<string, unknown> = {}) {
    seq += 1;
    const u = await users.create({
      email: `${key}@kpm.test`, passwordHash: 'x', fullName, status: 'active', platformRole: 'none', companyId,
      agentCode: `${70000 + seq}`, ...over,
    });
    ids[key] = String(u._id);
    return ids[key];
  }

  beforeEach(async () => {
    await clearCollections();
    sent.length = 0;
    seq = 0;
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `pru-${Math.random()}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    await account('wilson', 'Wilson Tanoto');
    await account('dewi', 'Dewi Lestari');
    await account('rina', 'Rina Kartika');
    await account('budi', 'Budi  Santoso');
    await account('hendra', 'Hendra Wijaya');
    await account('fajar', 'Fajar Nugroho');
    await account('root', 'Root Admin', { platformRole: 'super_admin', companyId: null, agentCode: null });
    await kpms.create([
      { _id: KPM_A, companyId, code: '0417', branchName: 'BSD City Branch', status: 'active', counters: { nextMemberSeq: 1 }, owners: ownersOf(ids.wilson), deletedAt: null },
      { _id: KPM_B, companyId, code: '0555', branchName: 'Kelapa Gading Branch', status: 'active', counters: { nextMemberSeq: 1 }, owners: ownersOf(ids.hendra), deletedAt: null },
    ] as never);
    const place = async (key: string, kpmId: string, role: 'ab' | 'aab' | 'agent', leader: string | null) => {
      const row = await hierarchy.create(RequestContext.tenantRead(kpmId, 'spec'), { userId: ids[key], role, leaderId: leader, status: 'active' });
      m[key] = String(row._id);
    };
    await place('wilson', KPM_A, 'ab', null);
    await place('dewi', KPM_A, 'aab', m.wilson);
    await place('rina', KPM_A, 'agent', m.dewi);
    await place('budi', KPM_A, 'agent', m.wilson);
    await place('hendra', KPM_B, 'ab', null);
    // Budi's sessions and links, and invitations waiting for him.
    await tokens.create([
      { userId: ids.budi, kind: 'refresh', tokenHash: 'h1', familyId: 'f1', expiresAt: new Date('2026-12-30T00:00:00Z') },
      { userId: ids.budi, kind: 'password_reset', tokenHash: 'h2', expiresAt: new Date('2026-11-24T00:00:00Z') },
    ]);
    await userInvitations.create({
      kpmId: KPM_B, fullName: 'Budi Santoso', phone: '+6281211002200', email: 'budi@kpm.test', userId: ids.budi, orgLevelCode: 'AGENT',
      roleClass: 'agent', tokenHash: 'ui-1', invitedByUserId: 'root', status: 'pending', invitedAt: NOW, expiresAt: new Date('2026-12-07T00:00:00Z'),
    } as never);
    await memberInvites.create({
      kpmId: KPM_B, companyId, leaderMembershipId: m.hendra, invitedByMembershipId: m.hendra, agentCode: '70004',
      fullName: 'Budi Santoso', phone: '+6281211002200', joinDate: '2026-11-23', tokenHash: 'mi-1', status: 'pending',
      expiresAt: new Date('2026-12-07T00:00:00Z'), existingAccount: true,
    } as never);
    session.current = SUPER_ADMIN.withReader(SUPER_ADMIN.reader);
  });

  const api = () => request(app.getHttpServer());
  const retire = (key: string, body: Record<string, unknown> = {}) =>
    api().post(`/admin/accounts/${ids[key]}/retirement`).send({ reason: 'Dibuat ulang dari file District 41.', fullName: '', ...body });

  it('P19.31-T1 AC-1 both routes declare account:retire', () => {
    expect(declaredPermissions(AccountRetirementController)).toEqual({ preview: 'account:retire', retire: 'account:retire' });
  });

  describe('who may (AC-1)', () => {
    it.each([['the Owner', OWNER], ['a KPM Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an agent', AGENT]])(
      'P19.31-T1 AC-1 %s is refused 403, and nothing is written',
      async (_who, ctx) => {
        session.current = ctx;
        await api().get(`/admin/accounts/${ids.budi}/retirement`).expect(403);
        const res = await retire('budi', { fullName: 'Budi Santoso' }).expect(403);
        expect(res.body.error.code).toBe('PERM_DENIED');
        expect((await users.findById(ids.budi).lean())!.deletedAt).toBeNull();
      },
    );

    it('P19.31-T1 AC-1 a support session is refused, even the Super Admin’s', async () => {
      session.current = new RequestContext(ids.wilson, 'none', OWNER.membership, 'root', null, false, true);
      await retire('budi', { fullName: 'Budi Santoso' }).expect(403);
      expect((await users.findById(ids.budi).lean())!.deletedAt).toBeNull();
    });

    it('P19.31-T1 AC-1 an unknown id, a malformed one and an account already retired are 404', async () => {
      await api().get('/admin/accounts/66f0000000000000000000ff/retirement').expect(404);
      await api().get('/admin/accounts/nope/retirement').expect(404);
      await retire('fajar', { fullName: 'Fajar Nugroho' }).expect(200);
      await retire('fajar', { fullName: 'Fajar Nugroho' }).expect(404);
      await api().get(`/admin/accounts/${ids.fajar}/retirement`).expect(404);
    });

    it('P19.31-T1 AC-1 the Super Admin inside a KPM still may: it is theirs as themselves', async () => {
      session.current = RequestContext.superAdminInKpm(SUPER_ADMIN, KPM_B);
      await retire('fajar', { fullName: 'Fajar Nugroho' }).expect(200);
    });
  });

  describe('the refusals (AC-2): 409, each its code and what to do, nothing written', () => {
    const untouched = async (key: string) => {
      const row = await users.findById(ids[key]).lean();
      expect(row).toMatchObject({ deletedAt: null, email: `${key}@kpm.test` });
    };

    it('P19.31-T1 AC-2 a Super Admin’s account: ACCOUNT_RETIRE_PLATFORM_TEAM', async () => {
      const res = await retire('root', { fullName: 'Root Admin' }).expect(409);
      expect(res.body.error).toMatchObject({ code: 'ACCOUNT_RETIRE_PLATFORM_TEAM' });
      expect(res.body.error.message).toMatch(/platform team first/);
      await untouched('root');
    });

    it('P19.31-T1 AC-2 an owner of a KPM: ACCOUNT_RETIRE_OWNER, naming the KPM; once no longer owner, they may go', async () => {
      const preview = await api().get(`/admin/accounts/${ids.hendra}/retirement`).expect(200);
      expect(preview.body.refusal).toMatchObject({ code: 'ACCOUNT_RETIRE_OWNER', details: { kpms: [{ kpmId: KPM_B, code: '0555' }] } });
      expect(preview.body.refusal.message).toBe('They are an owner of Kelapa Gading Branch. Remove them as owner first (Kelola owner), then delete the account.');
      const res = await retire('hendra', { fullName: 'Hendra Wijaya' }).expect(409);
      expect(res.body.error.code).toBe('ACCOUNT_RETIRE_OWNER');
      await untouched('hendra');
      // Owners cleared (another owner, or *Hapus sebagai owner*): Hendra, the root of B with nobody under him, may go.
      await kpms.updateOne({ _id: KPM_B }, { $set: { owners: ownersOf(ids.wilson) } });
      await retire('hendra', { fullName: 'Hendra Wijaya' }).expect(200);
    });

    it('P19.31-T1 AC-2 somebody people report to: ACCOUNT_RETIRE_HAS_REPORTS, with the count and the KPM', async () => {
      const res = await retire('dewi', { fullName: 'Dewi Lestari' }).expect(409);
      expect(res.body.error).toMatchObject({ code: 'ACCOUNT_RETIRE_HAS_REPORTS', details: { reports: 1, kpmId: KPM_A } });
      expect(res.body.error.message).toBe('1 person reports to them in BSD City Branch. Move them to another leader first (Ganti leader), then delete the account.');
      await untouched('dewi');
      expect((await members.findById(inA(), m.dewi))!.status).toBe('active');
    });

    it('P19.31-T1 AC-2 a name typed that is not theirs is 400, and nothing is written', async () => {
      const res = await retire('budi', { fullName: 'Budi' }).expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'fullName' } });
      await untouched('budi');
      await retire('budi', { reason: '' , fullName: 'Budi Santoso' }).expect(400);
    });
  });

  describe('what it does (AC-3, AC-5)', () => {
    it('P19.31-T1 AC-3 the preview says what ends and what stays, and writes nothing', async () => {
      const res = await api().get(`/admin/accounts/${ids.budi}/retirement`).expect(200);
      expect(res.body).toEqual({
        userId: ids.budi, fullName: 'Budi  Santoso', email: 'budi@kpm.test', kpmsWithHistory: 1, refusal: null,
        membership: { membershipId: m.budi, kpmId: KPM_A, kpmName: 'BSD City Branch', kpmCode: '0417', status: 'active' },
      });
      expect(await audit.countDocuments({})).toBe(0);
    });

    it('P19.31-T1 AC-3 the account soft-deleted with who and why, its address a tombstone, its name and code kept on it', async () => {
      const res = await retire('budi', { fullName: '  budi santoso ' }).expect(200);
      expect(res.body).toEqual({
        userId: ids.budi, fullName: 'Budi  Santoso', retiredAt: NOW.toISOString(),
        membershipEnded: { membershipId: m.budi, kpmId: KPM_A }, invitationsCancelled: 2,
      });
      const row = await users.findById(ids.budi).lean();
      expect(row).toMatchObject({
        deletedAt: NOW, deletedByUserId: 'root', deletedReason: 'Dibuat ulang dari file District 41.',
        email: retiredEmailOf(ids.budi), fullName: 'Budi  Santoso', agentCode: '70004',
      });
      expect(retiredEmailOf(ids.budi)).toBe(`retired+${ids.budi}@${RETIRED_EMAIL_DOMAIN}`);
      expect(RETIRED_EMAIL_DOMAIN).toBe('akun-dihapus.invalid');
    });

    it('P19.31-T1 AC-3 the live membership ended through the removal, its history kept, nobody told', async () => {
      await retire('budi', { fullName: 'Budi Santoso' }).expect(200);
      const row = (await members.findById(inA(), m.budi))!;
      expect(row).toMatchObject({ status: 'removed', removedAt: NOW, leaderId: m.wilson, agentCode: '70004' });
      const removed = await mongoose.model(MembershipHistory.name).findOne({ membershipId: m.budi, eventType: 'removed' }).lean<{ actorUserId: string; actorMembershipId: string | null }>();
      expect(removed).toMatchObject({ actorUserId: 'root', actorMembershipId: null });
      expect(await audit.countDocuments({ action: 'member.removed', kpmId: KPM_A, targetId: m.budi })).toBe(1);
      // No notice to a login that has ended.
      expect(sent).toEqual([]);
      // The KPM still reads them, with their name, among those who left (invariant §2: the history is the KPM's).
      const owner = new RequestContext(ids.wilson, 'none', { ...OWNER.membership!, membershipId: m.wilson, kpmId: KPM_A });
      const removedList = await directory.list(owner, { status: 'removed' });
      expect(removedList.members.map((r) => [r.membershipId, r.fullName])).toEqual([[m.budi, 'Budi  Santoso']]);
      expect((await directory.read(owner, m.budi)).fullName).toBe('Budi  Santoso');
      // Wilson leads one fewer.
      expect((await members.findById(inA(), m.wilson))!.directCounts.total).toBe(1);
    });

    it('P19.31-T1 AC-3 every session and unused link revoked; every invitation for them cancelled', async () => {
      await retire('budi', { fullName: 'Budi Santoso' }).expect(200);
      const left = await tokens.find({ userId: ids.budi }).lean<{ revokedAt: Date | null; revokedReason: string | null }[]>();
      expect(left.map((t) => [t.revokedAt, t.revokedReason])).toEqual([[NOW, 'account retired'], [NOW, 'account retired']]);
      expect((await userInvitations.findOne({}).lean<{ status: string; cancelledByUserId: string }>())).toMatchObject({ status: 'cancelled', cancelledByUserId: 'root' });
      expect((await memberInvites.findOne({}).lean<{ status: string }>())).toMatchObject({ status: 'cancelled' });
    });

    it('P19.31-T1 AC-3 an account in no KPM: retired, nothing to end', async () => {
      const res = await retire('fajar', { fullName: 'Fajar Nugroho' }).expect(200);
      expect(res.body.membershipEnded).toBeNull();
      expect((await users.findById(ids.fajar).lean())!.email).toBe(retiredEmailOf(ids.fajar));
    });

    it('P19.31-T1 AC-3 all or nothing: the membership’s end failing undoes the account, the links and the invitations', async () => {
      const depart = jest.spyOn(removals, 'depart').mockRejectedValueOnce(new Error('the database went away'));
      await retire('budi', { fullName: 'Budi Santoso' }).expect(500);
      depart.mockRestore();
      expect(await users.findById(ids.budi).lean()).toMatchObject({ deletedAt: null, email: 'budi@kpm.test', deletedReason: null });
      expect(await tokens.countDocuments({ userId: ids.budi, revokedAt: null })).toBe(2);
      expect((await userInvitations.findOne({}).lean<{ status: string }>())!.status).toBe('pending');
      expect((await memberInvites.findOne({}).lean<{ status: string }>())!.status).toBe('pending');
      expect((await members.findById(inA(), m.budi))!.status).toBe('active');
      expect(await audit.countDocuments({ action: 'account.retire_undone' })).toBe(1);
      expect(await audit.countDocuments({ action: 'account.retired' })).toBe(0);
    });

    it('P19.31-T1 AC-5 audited account.retired in the platform’s log and the KPM’s: the original address in before', async () => {
      await retire('budi', { fullName: 'Budi Santoso' }).expect(200);
      const rows = await audit.find({ action: 'account.retired' }).sort({ kpmId: 1 }).lean<Record<string, unknown>[]>();
      expect(rows.map((r) => r.kpmId)).toEqual([null, KPM_A]);
      expect(rows[0]).toMatchObject({
        actorUserId: 'root', targetCollection: 'users', targetId: ids.budi, targetMembershipId: m.budi,
        before: { email: 'budi@kpm.test', status: 'active', membership: { id: m.budi, status: 'active' } },
        after: { reason: 'Dibuat ulang dari file District 41.', email: retiredEmailOf(ids.budi), membershipEnded: { membershipId: m.budi, kpmId: KPM_A } },
      });
    });
  });

  describe('afterwards, the address and the code are free (AC-4)', () => {
    it('P19.31-T1 AC-4 a new account takes the same address and the same agent code; the old one keeps its history', async () => {
      await retire('budi', { fullName: 'Budi Santoso' }).expect(200);
      const again = await users.create({
        email: 'budi@kpm.test', passwordHash: 'y', fullName: 'Budi Santoso', status: 'active', platformRole: 'none', companyId,
        agentCode: '70004',
      });
      expect(String(again._id)).not.toBe(ids.budi);
      // And placed in another KPM as a new member; the old membership stays in A, removed.
      const placed = await hierarchy.create(RequestContext.tenantRead(KPM_B, 'spec'), { userId: String(again._id), role: 'agent', leaderId: m.hendra, status: 'active' });
      expect(placed.agentCode).toBe('70004');
      expect((await members.findById(inA(), m.budi))!.status).toBe('removed');
      // Exactly one live account holds the code.
      expect(await users.countDocuments({ companyId, agentCode: '70004', deletedAt: null })).toBe(1);
    });
  });
});
