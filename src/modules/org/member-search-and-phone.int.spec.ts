import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { DirectoryColumns } from '@/modules/reporting/directory-columns';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { declaredPermissions, NO_CLASS, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, seedLadder, startMongo, stopMongo } from '../../../test/mongo';
import { AdminDelegationService } from './admin-delegation.service';
import { CoachResolver } from './coach-resolver';
import { DirectoryService } from './directory.service';
import { GroupService } from './group.service';
import { HierarchyService } from './hierarchy.service';
import { LeaderLimitRequestService } from './leader-limit-request.service';
import { MemberPhoneController } from './member-phone.controller';
import { MemberPhoneService } from './member-phone.service';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import { OrgController } from './org.controller';
import { MembershipHistoryRepository } from './org.repositories';
import { OrgTreeService } from './org-tree.service';
import { RemovalService } from './removal.service';
import { RoleChangeService } from './role-change.service';

const NOW = new Date('2026-10-30T02:00:00Z');
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
 * ***Search agent* and a leader saving an agent's WhatsApp number, over HTTP** (UI V1, 2026-10-30; UI-012, UI-059,
 * UI-081, UI-101; the owner's D-14 and D-22).
 *
 * Office A, built through `HierarchyService.create`, so every `ancestorIds` is the one the product writes:
 *
 * ```
 * ROOT (AB, the Owner as well) ── AB ─┬── DIRECT (agent)      Indah Permatasari
 *                                     ├── AAB  Arief Hidayat ── AGENT  Wahyu Saputra
 *                                     ├── PEER Sari Puspita  ── PEER_AGENT  Novi Andriani
 *                                     ├── GONE (agent, removed)  Wahyu Lama
 *                                     └── WAITING (agent, pending)  Wahyu Baru
 * ```
 *
 * Office B: `B_AB` ── `B_AGENT` Wahyu Kusuma — the same first name, never found from A.
 */
describe('UI V1 GET /members/search and PUT /members/:membershipId/phone over HTTP', () => {
  let app: INestApplication;
  let members: MembershipRepository;
  let hierarchy: HierarchyService;
  let users: mongoose.Model<User>;
  let audits: mongoose.Model<AuditLog>;
  let companyId: string;
  let seq = 0;

  let m: Record<
    'ROOT' | 'AB' | 'DIRECT' | 'AAB' | 'AGENT' | 'PEER' | 'PEER_AGENT' | 'GONE' | 'WAITING' | 'B_AB' | 'B_AGENT',
    string
  >;

  beforeAll(async () => {
    await startMongo();
    const clock = new FixedClock(NOW);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    users = mongoose.model(User.name, UserSchema) as never;
    audits = mongoose.model(AuditLog.name, AuditLogSchema) as never;
    members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    const audit = new AuditService(audits as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never,
      mongoose.model(Company.name, CompanySchema) as never,
      kpms as never,
      audit,
      clock,
    );
    hierarchy = new HierarchyService(
      members,
      kpms as never,
      users as never,
      new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never),
      clock,
      orgLevels,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [OrgController, MemberPhoneController],
      providers: [
        { provide: DirectoryService, useValue: new DirectoryService(members, users as never, kpms as never) },
        { provide: getModelToken(User.name), useValue: users },
        { provide: MembershipRepository, useValue: members },
        { provide: CoachResolver, useValue: new CoachResolver(members) },
        { provide: AuditService, useValue: audit },
        MemberPhoneService,
        // The routes this spec never calls; a bare object keeps Nest from building their graphs.
        ...[
          OrgTreeService, RoleChangeService, RemovalService, GroupService, AdminDelegationService, DirectoryColumns,
          LeaderLimitRequestService,
        ].map((provide) => ({ provide, useValue: {} })),
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await clearCollections();
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `pru-${Math.random()}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    for (const [id, code] of [[KPM_A, '0417'], [KPM_B, '0555']]) {
      await mongoose.model(Kpm.name).create({
        _id: id, companyId, code, branchName: `Branch ${code}`, timezone: 'Asia/Jakarta',
        counters: { nextMemberSeq: 1 }, status: 'active',
      });
    }
    const root = await join(KPM_A, 'ab', null, 'Wilson Tanoto');
    const ab = await join(KPM_A, 'ab', root, 'Agus Prasetyo');
    const aab = await join(KPM_A, 'aab', ab, 'Arief Hidayat');
    const peer = await join(KPM_A, 'aab', ab, 'Sari Puspita');
    const bAb = await join(KPM_B, 'ab', null, 'Budi Hartono');
    m = {
      ROOT: root,
      AB: ab,
      DIRECT: await join(KPM_A, 'agent', ab, 'Indah Permatasari'),
      AAB: aab,
      AGENT: await join(KPM_A, 'agent', aab, 'Wahyu Saputra', 'Wahyu'),
      PEER: peer,
      PEER_AGENT: await join(KPM_A, 'agent', peer, 'Novi Andriani'),
      GONE: await join(KPM_A, 'agent', ab, 'Wahyu Lama'),
      WAITING: await join(KPM_A, 'agent', ab, 'Wahyu Baru', null, 'pending'),
      B_AB: bAb,
      B_AGENT: await join(KPM_B, 'agent', bAb, 'Wahyu Kusuma'),
    };
    // Somebody who has left: the cache still names their leaders, and only the status says they are gone.
    await mongoose.model(Membership.name).updateOne({ _id: m.GONE }, { $set: { status: 'removed' } });
  });

  /** A person the insurer issued a code to, placed in an office the way every join places them. */
  async function join(
    kpmId: string,
    role: 'ab' | 'aab' | 'agent',
    leaderId: string | null,
    fullName: string,
    preferredName: string | null = null,
    status: 'active' | 'pending' = 'active',
  ) {
    seq += 1;
    const user = await users.create({
      email: `s${seq}@kpm.test`, passwordHash: 'x', fullName, preferredName, status: 'active',
      platformRole: 'none', companyId, agentCode: `${88_000 + seq}`,
    });
    const placed = await hierarchy.create(as('mem-placer', 'AB', { kpmId, isKpmOwner: true }), {
      userId: String(user._id), role, leaderId, ...(status === 'active' ? { status } : {}),
    });
    return String(placed._id);
  }

  const http = () => request(app.getHttpServer());
  const search = (q?: string, limit?: number) => http().get('/members/search').query({
    ...(q === undefined ? {} : { q }), ...(limit === undefined ? {} : { limit }),
  });
  const names = (body: { members: { fullName: string }[] }) => body.members.map((p) => p.fullName);
  const codeOf = async (membershipId: string) => (await members.findById(as(m.ROOT, 'AB'), membershipId))!.agentCode;
  const phoneOf = async (membershipId: string) => {
    const row = await mongoose.model(Membership.name).findById(membershipId).lean<{ userId: string }>().exec();
    return (await users.findById(row!.userId).lean().exec())?.phone ?? null;
  };

  it('T1 declares each route’s permission: Search agent on member:read_profile, the number on member:update_phone', () => {
    expect(declaredPermissions(OrgController).search).toBe('member:read_profile');
    expect(declaredPermissions(MemberPhoneController)).toEqual({ set: 'member:update_phone' });
  });

  describe('UI-012 / D-14 GET /members/search', () => {
    it('UI-012 an AB finds a person in their downline by part of a name, at any depth, with what the picker shows', async () => {
      session.current = as(m.AB, 'AB');

      const res = await search('wahyu').expect(200);

      expect(res.body.members).toEqual([{
        membershipId: m.AGENT, fullName: 'Wahyu Saputra', preferredName: 'Wahyu', agentCode: await codeOf(m.AGENT),
        role: 'agent', orgLevelCode: 'AGENT',
      }]);
    });

    it('UI-012 an AB finds a person by part of their agent code', async () => {
      session.current = as(m.AB, 'AB');
      const code = await codeOf(m.PEER_AGENT);

      const res = await search(code.slice(1)).expect(200);

      expect(names(res.body)).toEqual(['Novi Andriani']);
    });

    it('UI-012 an AAB finds only their own unit, never a peer AAB’s agent, nor their leader', async () => {
      session.current = as(m.AAB, 'AAB');

      expect(names((await search().expect(200)).body)).toEqual(['Wahyu Saputra']);
      expect((await search('novi').expect(200)).body.members).toEqual([]);
      expect((await search('agus').expect(200)).body.members).toEqual([]);
    });

    it('UI-012 an Agent, who may see nobody but themselves, finds nobody', async () => {
      session.current = as(m.DIRECT, 'AGENT');

      expect((await search().expect(200)).body.members).toEqual([]);
      expect((await search('indah').expect(200)).body.members).toEqual([]);
      expect((await search('wahyu').expect(200)).body.members).toEqual([]);
    });

    it('UI-012 never answers with the reader themselves', async () => {
      session.current = as(m.AB, 'AB');

      expect((await search('agus').expect(200)).body.members).toEqual([]);
      expect(names((await search().expect(200)).body)).not.toContain('Agus Prasetyo');
    });

    it('UI-012 leaves out somebody who has left and somebody not yet in', async () => {
      session.current = as(m.AB, 'AB');

      const found = names((await search('wahyu').expect(200)).body);

      expect(found).not.toContain('Wahyu Lama');
      expect(found).not.toContain('Wahyu Baru');
    });

    it('UI-012 lists everybody in reach A to Z when nothing is typed, and the Owner reads the office', async () => {
      session.current = as(m.AB, 'AB');
      expect(names((await search().expect(200)).body)).toEqual([
        'Arief Hidayat', 'Indah Permatasari', 'Novi Andriani', 'Sari Puspita', 'Wahyu Saputra',
      ]);

      session.current = as(m.ROOT, 'AB', { isKpmOwner: true });
      expect(names((await search().expect(200)).body)).toEqual([
        'Agus Prasetyo', 'Arief Hidayat', 'Indah Permatasari', 'Novi Andriani', 'Sari Puspita', 'Wahyu Saputra',
      ]);
    });

    it('T1 an Admin with no field rung reads the office, as the Owner does', async () => {
      session.current = as(new mongoose.Types.ObjectId().toString(), 'AGENT', {
        orgLevelCode: 'NO_RUNG', hierarchyRole: NO_CLASS, isKpmAdmin: true,
      });
      expect(names((await search().expect(200)).body)).toEqual([
        'Agus Prasetyo', 'Arief Hidayat', 'Indah Permatasari', 'Novi Andriani', 'Sari Puspita', 'Wahyu Saputra',
        'Wilson Tanoto',
      ]);
    });

    it('T1 a Super Admin outside a support session, and a member on no rung the matrix names, are refused 403', async () => {
      for (const ctx of [
        SUPER_ADMIN,
        as(new mongoose.Types.ObjectId().toString(), 'AGENT', { orgLevelCode: 'NO_RUNG', hierarchyRole: NO_CLASS }),
      ]) {
        session.current = ctx;
        expect((await search('wahyu').expect(403)).body.error).toMatchObject({
          code: 'PERM_DENIED', details: { permission: 'member:read_profile' },
        });
      }
    });

    it('UI-012 cross-tenant: office B’s Wahyu is never found from office A, nor office A’s from B', async () => {
      session.current = as(m.ROOT, 'AB', { isKpmOwner: true });
      expect(names((await search('wahyu').expect(200)).body)).toEqual(['Wahyu Saputra']);
      // Every code in both offices begins `88`: the office's own come back, and none of the other's.
      const byCode = (await search('88').expect(200)).body.members.map((p: { membershipId: string }) => p.membershipId);
      expect(byCode).toContain(m.AGENT);
      expect(byCode).not.toContain(m.B_AGENT);
      expect(byCode).not.toContain(m.B_AB);

      session.current = as(m.B_AB, 'AB', { kpmId: KPM_B });
      expect(names((await search('wahyu').expect(200)).body)).toEqual(['Wahyu Kusuma']);
    });

    it('UI-012 keeps to the limit asked for, ten unless asked, and refuses one past twenty', async () => {
      session.current = as(m.AB, 'AB');

      expect(names((await search(undefined, 2).expect(200)).body)).toEqual(['Arief Hidayat', 'Indah Permatasari']);
      expect((await search(undefined, 21).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await search(undefined, 0).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('UI-012 reads what is typed as text: a pattern’s signs find nothing and throw nothing', async () => {
      session.current = as(m.AB, 'AB');

      for (const q of ['(.*', '[', '.*', '\\', '$where']) {
        expect([q, (await search(q).expect(200)).body.members]).toEqual([q, []]);
      }
    });

    it('UI-012 records no read: names and codes only, as the tree', async () => {
      session.current = as(m.AB, 'AB');

      await search('wahyu').expect(200);

      expect(await audits.countDocuments({})).toBe(0);
    });
  });

  describe('UI-081 / D-22 PUT /members/:membershipId/phone', () => {
    const put = (membershipId: string, body: unknown) => http().put(`/members/${membershipId}/phone`).send(body as object);

    it('UI-081 an AB saves the number of a direct agent, as +62 and its digits, on the person’s account', async () => {
      session.current = as(m.AB, 'AB');

      const res = await put(m.DIRECT, { phone: '0812-1100-2200' }).expect(200);

      expect(res.body).toEqual({ membershipId: m.DIRECT, phone: '+6281211002200' });
      expect(await phoneOf(m.DIRECT)).toBe('+6281211002200');
    });

    it('UI-081 an AB saves the number of somebody further down, an AAB’s agent', async () => {
      session.current = as(m.AB, 'AB');

      await put(m.AGENT, { phone: '+62 813 2222 3333' }).expect(200);

      expect(await phoneOf(m.AGENT)).toBe('+6281322223333');
    });

    it('UI-081 an AAB saves the number of their own agent', async () => {
      session.current = as(m.AAB, 'AAB');

      await put(m.AGENT, { phone: '813 2222 3333' }).expect(200);

      expect(await phoneOf(m.AGENT)).toBe('+6281322223333');
    });

    it('UI-081 records one member.phone_updated entry naming the person, and never the number', async () => {
      session.current = as(m.AB, 'AB');

      await put(m.DIRECT, { phone: '0812-1100-2200' }).expect(200);

      const entries = await audits.find({ action: 'member.phone_updated' }).lean().exec();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ targetMembershipId: m.DIRECT, targetCollection: 'users' });
      expect(JSON.stringify(entries[0])).not.toContain('81211002200');
    });

    it('UI-081 an AAB is answered 404 for a peer AAB’s agent, and nothing is written', async () => {
      session.current = as(m.AAB, 'AAB');

      const res = await put(m.PEER_AGENT, { phone: '0812-1100-2200' }).expect(404);

      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(await phoneOf(m.PEER_AGENT)).toBeNull();
    });

    it('UI-081 an Agent is refused, 403: no grant', async () => {
      session.current = as(m.DIRECT, 'AGENT');

      expect((await put(m.AGENT, { phone: '0812-1100-2200' }).expect(403)).body.error.code).toBe('PERM_DENIED');
      expect(await phoneOf(m.AGENT)).toBeNull();
    });

    it.each([['the Owner', { isKpmOwner: true }], ['an Admin', { isKpmAdmin: true }]])(
      'UI-081 %s on the Agent rung is refused, 403: the office’s administrators hold no grant',
      async (_, over) => {
        session.current = as(new mongoose.Types.ObjectId().toString(), 'AGENT', over);

        expect((await put(m.DIRECT, { phone: '0812-1100-2200' }).expect(403)).body.error.code).toBe('PERM_DENIED');
        expect(await phoneOf(m.DIRECT)).toBeNull();
      },
    );

    it('UI-081 cross-tenant: office A’s AB is answered 404 for office B’s agent, and nothing is written', async () => {
      session.current = as(m.ROOT, 'AB', { isKpmOwner: true });

      expect((await put(m.B_AGENT, { phone: '0812-1100-2200' }).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect(await phoneOf(m.B_AGENT)).toBeNull();
    });

    it('UI-081 somebody who has left, or an id that is none, is 404', async () => {
      session.current = as(m.AB, 'AB');

      await put(m.GONE, { phone: '0812-1100-2200' }).expect(404);
      await put('not-an-id', { phone: '0812-1100-2200' }).expect(404);
      expect(await phoneOf(m.GONE)).toBeNull();
    });

    it.each([
      ['eight digits', { phone: '12345678' }],
      ['letters', { phone: '0812-ABCD-2200' }],
      ['an empty field: not cleared here', { phone: '' }],
      ['nothing at all', {}],
      ['null', { phone: null }],
    ])('UI-081 refuses %s, 400 VALIDATION_FAILED naming phone, and writes nothing', async (_, body) => {
      session.current = as(m.AB, 'AB');

      const res = await put(m.DIRECT, body).expect(400);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.violations).toEqual(['phone must be an Indonesian number: 9 to 13 digits after +62']);
      expect(await phoneOf(m.DIRECT)).toBeNull();
    });

    it('M1 a number already on file is never overwritten: 409 MEMBER_PHONE_ON_FILE, the stored number unchanged', async () => {
      session.current = as(m.AB, 'AB');
      await put(m.DIRECT, { phone: '0812-1100-2200' }).expect(200);

      const res = await put(m.DIRECT, { phone: '0813-9999-8888' }).expect(409);

      expect(res.body.error.code).toBe('MEMBER_PHONE_ON_FILE');
      expect(res.body.error.details).toEqual({ membershipId: m.DIRECT });
      expect(res.body.error.message).toBe('They already have a WhatsApp number. Only they can change it, on My profile.');
      expect(await phoneOf(m.DIRECT)).toBe('+6281211002200');
      expect(await audits.countDocuments({ action: 'member.phone_updated' })).toBe(1);
    });

    it('M1 the refusal is in Indonesian for an Indonesian reader', async () => {
      session.current = as(m.AB, 'AB');
      await put(m.DIRECT, { phone: '0812-1100-2200' }).expect(200);

      const res = await put(m.DIRECT, { phone: '0813-9999-8888' }).set('Accept-Language', 'id').expect(409);

      expect(res.body.error.message).toBe('Dia sudah memiliki nomor WhatsApp. Hanya dia yang dapat mengubahnya, di Profil saya.');
    });

    it('M1 a number the person saved themselves is refused the same way, whoever leads them', async () => {
      const row = await mongoose.model(Membership.name).findById(m.AGENT).lean<{ userId: string }>().exec();
      await users.updateOne({ _id: row!.userId }, { $set: { phone: '+6285700001111' } });

      for (const reader of [as(m.AB, 'AB'), as(m.AAB, 'AAB')]) {
        session.current = reader;
        expect((await put(m.AGENT, { phone: '0812-1100-2200' }).expect(409)).body.error.code).toBe('MEMBER_PHONE_ON_FILE');
      }
      expect(await phoneOf(m.AGENT)).toBe('+6285700001111');
      expect(await audits.countDocuments({ action: 'member.phone_updated' })).toBe(0);
    });

    it('M1 an empty string on file counts as no number, and is filled', async () => {
      const row = await mongoose.model(Membership.name).findById(m.DIRECT).lean<{ userId: string }>().exec();
      await users.updateOne({ _id: row!.userId }, { $set: { phone: '' } });
      session.current = as(m.AB, 'AB');

      await put(m.DIRECT, { phone: '0812-1100-2200' }).expect(200);

      expect(await phoneOf(m.DIRECT)).toBe('+6281211002200');
    });

    it('M1 the race: two leaders saving at once, one is written and the other refused, never overwritten', async () => {
      const ab = request(app.getHttpServer());
      session.current = as(m.AB, 'AB');

      const answers = await Promise.all([
        ab.put(`/members/${m.AGENT}/phone`).send({ phone: '0812-1100-2200' }),
        ab.put(`/members/${m.AGENT}/phone`).send({ phone: '0813-9999-8888' }),
        ab.put(`/members/${m.AGENT}/phone`).send({ phone: '0857-4444-5555' }),
      ]);

      const won = answers.filter((r) => r.status === 200);
      const refused = answers.filter((r) => r.status === 409);
      expect(won).toHaveLength(1);
      expect(refused).toHaveLength(2);
      refused.forEach((r) => expect(r.body.error.code).toBe('MEMBER_PHONE_ON_FILE'));
      expect(await phoneOf(m.AGENT)).toBe(won[0]!.body.phone);
      expect(await audits.countDocuments({ action: 'member.phone_updated' })).toBe(1);
    });

    it('UI-081 is refused in a support session, 403 PERM_DENIED, however it was started', async () => {
      session.current = as(m.AB, 'AB', {}, 'u-support');

      expect((await put(m.DIRECT, { phone: '0812-1100-2200' }).expect(403)).body.error.code).toBe('PERM_DENIED');
      expect(await phoneOf(m.DIRECT)).toBeNull();
    });
  });
});
