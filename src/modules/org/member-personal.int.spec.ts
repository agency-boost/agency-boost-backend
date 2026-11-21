import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { Clock, FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { declaredPermissions, NO_CLASS, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, seedLadder, startMongo, stopMongo } from '../../../test/mongo';
import { DirectoryService } from './directory.service';
import { HierarchyService } from './hierarchy.service';
import { MemberPersonalController } from './member-personal.controller';
import { MemberPersonalService } from './member-personal.service';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import { MembershipHistoryRepository } from './org.repositories';

/** 11 November 2026, 09:00 in Jakarta: the office's today is `2026-11-11`. */
const NOW = new Date('2026-11-11T02:00:00Z');
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

/** The office's Admin, on no field rung — the column the matrix means. */
const ADMIN = () => as(new mongoose.Types.ObjectId().toString(), 'AGENT', {
  orgLevelCode: 'NO_RUNG', hierarchyRole: NO_CLASS, isKpmAdmin: true,
});

/**
 * **The member sheet — the Owner, the Admins, the Super Admin inside the KPM and a core leader (their downline) change any
 * field of a member, over HTTP** (P19.20-T2 AC-2; ADR-0273 §3, amending ADR-0248 §3 — which this route answered as
 * *Lengkapi data*, blanks only, under P19.12-T5).
 *
 * Office A, built through `HierarchyService.create`:
 *
 * ```
 * ROOT (AB, the Owner) ─┬─ AB Agus (★ core leader) ─┬── AAB Arief ── AGENT Wahyu (imported: nothing recorded)
 *                       │                          ├── DONE Indah (everything recorded, signed in)
 *                       │                          └── GONE Wahyu Lama (removed)
 *                       └─ AB Yosef ── OUT Rina (outside Agus's downline)
 * ```
 * and office B with one member, `OTHER`.
 */
describe('P19.20-T2 PATCH /members/:membershipId/personal over HTTP', () => {
  let app: INestApplication;
  let hierarchy: HierarchyService;
  let users: mongoose.Model<User>;
  let audits: mongoose.Model<AuditLog>;
  let companyId: string;
  let seq = 0;
  let m: Record<'ROOT' | 'AB' | 'AAB' | 'AGENT' | 'DONE' | 'GONE' | 'YOSEF' | 'OUT' | 'OTHER', string>;

  beforeAll(async () => {
    await startMongo();
    const clock = new FixedClock(NOW);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    users = mongoose.model(User.name, UserSchema) as never;
    audits = mongoose.model(AuditLog.name, AuditLogSchema) as never;
    const members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
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
      controllers: [MemberPersonalController],
      providers: [
        MemberPersonalService,
        {
          provide: DirectoryService,
          useValue: new DirectoryService(members, users as never, kpms as never, mongoose.model(Company.name) as never),
        },
        { provide: getModelToken(User.name), useValue: users },
        { provide: MembershipRepository, useValue: members },
        { provide: AuditService, useValue: audit },
        { provide: TenantDay, useValue: new TenantDay(kpms as never, clock as Clock) },
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
    await mongoose.model(Kpm.name).create({
      _id: KPM_A, companyId, code: '0417', branchName: 'BSD City', timezone: 'Asia/Jakarta',
      counters: { nextMemberSeq: 1 }, status: 'active',
    });
    await mongoose.model(Kpm.name).create({
      _id: KPM_B, companyId, code: '0999', branchName: 'Elsewhere', timezone: 'Asia/Jakarta',
      counters: { nextMemberSeq: 1 }, status: 'active',
    });
    const root = await join('ab', null, 'Wilson Tanoto');
    const ab = await join('ab', root, 'Agus Prasetyo');
    const aab = await join('aab', ab, 'Arief Hidayat');
    const yosef = await join('ab', root, 'Yosef Tambunan');
    m = {
      ROOT: root,
      AB: ab,
      AAB: aab,
      AGENT: await join('agent', aab, 'Wahyu Saputra'),
      DONE: await join('agent', ab, 'Indah Permatasari', {
        dateOfBirth: '1990-03-15', gender: 'female', companyJoinMonth: '2020-09', phone: '+6281211002200',
        lastLoginAt: new Date('2026-11-01T02:00:00Z'),
      }),
      GONE: await join('agent', ab, 'Wahyu Lama'),
      YOSEF: yosef,
      OUT: await join('agent', yosef, 'Rina Kurnia'),
      OTHER: await join('agent', null, 'Bukan Kami', {}, KPM_B),
    };
    await mongoose.model(Membership.name).updateOne({ _id: m.DONE }, { $set: { workStatus: 'part_time' } });
    await mongoose.model(Membership.name).updateOne({ _id: m.GONE }, { $set: { status: 'removed' } });
  });

  /** A person placed in office A the way every join places them; `recorded` what their account already holds. */
  async function join(
    role: 'ab' | 'aab' | 'agent', leaderId: string | null, fullName: string, recorded: Record<string, unknown> = {},
    kpmId = KPM_A,
  ) {
    seq += 1;
    const user = await users.create({
      email: `p${seq}@kpm.test`, passwordHash: 'x', fullName, status: 'active', platformRole: 'none', companyId,
      agentCode: `${77_000 + seq}`, ...recorded,
    });
    const placed = await hierarchy.create(as('mem-placer', 'AB', { isKpmOwner: true, kpmId }), {
      userId: String(user._id), role, leaderId, status: 'active',
    });
    return String(placed._id);
  }

  const OWNER = () => as(m.ROOT, 'AB', { isKpmOwner: true });
  const patch = (membershipId: string, body: unknown) =>
    request(app.getHttpServer()).patch(`/members/${membershipId}/personal`).send(body as object);
  const accountOf = async (membershipId: string) => {
    const row = await mongoose.model(Membership.name).findById(membershipId).lean<{ userId: string }>().exec();
    return users.findById(row!.userId).lean().exec();
  };
  const workStatusOf = async (membershipId: string) =>
    (await mongoose.model(Membership.name).findById(membershipId).lean<{ workStatus?: string | null }>().exec())?.workStatus ?? null;
  const FULL = {
    dateOfBirth: '1992-07-01', gender: 'male', companyJoinMonth: '2021-02', workStatus: 'full_time', phone: '0813-2222-3333',
  };

  const CORE = () => as(m.AB, 'AB', { isCoreLeader: true });
  const SA_IN_A = () => RequestContext.superAdminInKpm(RequestContext.platform('u-sa'), KPM_A);
  const membershipOf = (id: string) =>
    mongoose.model(Membership.name).findById(id).lean<{ agentCode: string; joinDate?: string | null; workStatus?: string | null }>().exec();

  it('P19.20-T2 AC-2 declares member:complete_personal on its one route', () => {
    expect(declaredPermissions(MemberPersonalController)).toEqual({ complete: 'member:complete_personal' });
  });

  describe('who may', () => {
    it('P19.20-T2 AC-2 the Owner fills every blank of an imported member, each where it lives, and is answered the member', async () => {
      session.current = OWNER();

      const res = await patch(m.AGENT, FULL).expect(200);

      expect(res.body).toMatchObject({
        membershipId: m.AGENT,
        filled: ['companyJoinMonth', 'workStatus', 'dateOfBirth', 'gender', 'phone'],
        personal: {
          dateOfBirth: '1992-07-01', gender: 'male', companyJoinMonth: '2021-02', workStatus: 'full_time',
          phone: '+6281322223333', companyName: 'Prudential',
        },
        member: { membershipId: m.AGENT, fullName: 'Wahyu Saputra' },
      });
      expect(await accountOf(m.AGENT)).toMatchObject({
        dateOfBirth: '1992-07-01', gender: 'male', companyJoinMonth: '2021-02', phone: '+6281322223333',
      });
      expect(await workStatusOf(m.AGENT)).toBe('full_time');
    });

    it('P19.20-T2 AC-2 any value is changed, not only a blank: a recorded birth date, number and work status', async () => {
      session.current = OWNER();

      const res = await patch(m.DONE, { dateOfBirth: '1991-01-01', phone: '0857-0000-1111', workStatus: 'full_time' }).expect(200);

      expect(res.body.filled).toEqual(['workStatus', 'dateOfBirth', 'phone']);
      expect(await accountOf(m.DONE)).toMatchObject({ dateOfBirth: '1991-01-01', phone: '+6285700001111' });
      expect(await workStatusOf(m.DONE)).toBe('full_time');
    });

    it('P19.20-T2 AC-2 an Admin on no field rung changes one field, and the others stay as they were', async () => {
      session.current = ADMIN();

      const res = await patch(m.AGENT, { gender: 'female' }).expect(200);

      expect(res.body.filled).toEqual(['gender']);
      expect(res.body.personal).toMatchObject({ gender: 'female', dateOfBirth: null, workStatus: null, phone: null });
    });

    it('P19.20-T2 AC-2 the Super Admin inside the KPM changes a field, as its Owner', async () => {
      session.current = SA_IN_A();

      await patch(m.AGENT, { workStatus: 'part_time' }).expect(200);

      expect(await workStatusOf(m.AGENT)).toBe('part_time');
    });

    it('P19.20-T2 AC-2 the read offers the sheet’s pencils to whoever may change: an Owner, a core leader below them', async () => {
      session.current = OWNER();
      expect((await patch(m.AGENT, { gender: 'male' }).expect(200)).body.member.canEditDetails).toBe(true);
      session.current = CORE();
      expect((await patch(m.AGENT, { gender: 'female' }).expect(200)).body.member.canEditDetails).toBe(true);
    });

    it('P19.20-T2 AC-2 a core leader changes somebody in their downline, at any depth', async () => {
      session.current = CORE();

      await patch(m.AGENT, { gender: 'male' }).expect(200);
      await patch(m.AAB, { workStatus: 'full_time' }).expect(200);

      expect((await accountOf(m.AGENT))?.gender).toBe('male');
      expect(await workStatusOf(m.AAB)).toBe('full_time');
    });

    it.each([
      ['outside their downline', () => 'OUT' as const],
      ['their own row: strictly below them', () => 'AB' as const],
      ['the Owner above them', () => 'ROOT' as const],
    ])('P19.20-T2 AC-2 a core leader is answered 404 for somebody %s, and nothing is written', async (_, whom) => {
      session.current = CORE();

      expect((await patch(m[whom()], { gender: 'male' }).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await accountOf(m[whom()]))?.gender ?? null).toBeNull();
    });

    it.each([
      ['an AB who is no core leader, the member’s upline', () => as(m.AB, 'AB')],
      ['an AAB, the member’s direct leader', () => as(m.AAB, 'AAB')],
      ['an Agent', () => as(m.AGENT, 'AGENT', { directCount: 0 })],
      ['a Super Admin in no KPM', () => SUPER_ADMIN],
    ])('P19.20-T2 AC-2 %s is refused, 403 PERM_DENIED, and nothing is written', async (_, who) => {
      session.current = who();

      const res = await patch(m.AGENT, { gender: 'male' }).expect(403);

      expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'member:complete_personal' } });
      expect((await accountOf(m.AGENT))?.gender ?? null).toBeNull();
    });

    it('P19.20-T2 AC-2 is refused in a support session, 403 PERM_DENIED, even as the Owner', async () => {
      session.current = as(m.ROOT, 'AB', { isKpmOwner: true }, 'u-support');

      expect((await patch(m.AGENT, { gender: 'male' }).expect(403)).body.error.code).toBe('PERM_DENIED');
    });

    it('P19.20-T2 AC-2 somebody who has left, or an id that is none, is 404 NOT_FOUND', async () => {
      session.current = OWNER();

      expect((await patch(m.GONE, { gender: 'male' }).expect(404)).body.error.code).toBe('NOT_FOUND');
      await patch('not-an-id', { gender: 'male' }).expect(404);
      await patch(new mongoose.Types.ObjectId().toString(), { gender: 'male' }).expect(404);
    });

    it('P19.20-T2 AC-2 another office’s member is 404 to the Owner of this one, and is not written (cross-tenant)', async () => {
      session.current = OWNER();

      expect((await patch(m.OTHER, { gender: 'male', agentCode: '55501' }).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await accountOf(m.OTHER))?.gender ?? null).toBeNull();
    });
  });

  describe('the fields of Profil', () => {
    it('P19.20-T2 AC-1 Bergabung di KPM: the join date is the membership’s', async () => {
      session.current = OWNER();

      await patch(m.AGENT, { joinDate: '2025-09-20' }).expect(200);

      expect((await membershipOf(m.AGENT))?.joinDate).toBe('2025-09-20');
    });

    it('P19.20-T2 AC-1 Kode agen moves on the account and on this office’s membership', async () => {
      session.current = OWNER();

      await patch(m.AGENT, { agentCode: ' 80009 ' }).expect(200);

      expect((await accountOf(m.AGENT))?.agentCode).toBe('80009');
      expect((await membershipOf(m.AGENT))?.agentCode).toBe('80009');
    });

    it('P19.20-T2 AC-2 a code somebody else holds at the insurer is 409 AGENT_CODE_TAKEN, nothing written', async () => {
      session.current = OWNER();
      const held = (await accountOf(m.DONE))?.agentCode as string;

      const res = await patch(m.AGENT, { agentCode: held, gender: 'male' }).expect(409);

      expect(res.body.error).toMatchObject({ code: 'AGENT_CODE_TAKEN', details: { field: 'agentCode' } });
      expect((await accountOf(m.AGENT))?.gender ?? null).toBeNull();
    });
  });

  describe('Email (OD-400)', () => {
    it('P19.20-T2 AC-2 the address of somebody who never signed in is corrected, lower-cased', async () => {
      session.current = OWNER();

      await patch(m.AGENT, { email: ' Wahyu.Baru@KPM.test ' }).expect(200);

      expect((await accountOf(m.AGENT))?.email).toBe('wahyu.baru@kpm.test');
    });

    it('P19.20-T2 AC-2 the address somebody signs in with is theirs: 409 MEMBER_EMAIL_SIGNED_IN, in both languages', async () => {
      session.current = OWNER();
      const before = (await accountOf(m.DONE))?.email;

      const res = await patch(m.DONE, { email: 'indah.baru@kpm.test' }).expect(409);
      const id = await patch(m.DONE, { email: 'indah.baru@kpm.test' }).set('Accept-Language', 'id').expect(409);

      expect(res.body.error).toMatchObject({
        code: 'MEMBER_EMAIL_SIGNED_IN',
        message: 'They sign in with this email, so only they can change it, on My profile.',
      });
      expect(id.body.error.message).toBe('Dia masuk dengan email ini, jadi hanya dia yang dapat mengubahnya, di Profil saya.');
      expect((await accountOf(m.DONE))?.email).toBe(before);
    });

    it('P19.20-T2 AC-2 an address another account holds is 409 AUTH_EMAIL_TAKEN', async () => {
      session.current = OWNER();
      const taken = (await accountOf(m.DONE))?.email;

      expect((await patch(m.AGENT, { email: taken }).expect(409)).body.error.code).toBe('AUTH_EMAIL_TAKEN');
    });
  });

  describe('what is refused 400', () => {
    it.each([
      ['a birth date less than 18 years before the office’s today', { dateOfBirth: '2008-11-12' }, 'dateOfBirth'],
      ['a birth date today', { dateOfBirth: '2026-11-11' }, 'dateOfBirth'],
      ['a join month still to come', { companyJoinMonth: '2026-12' }, 'companyJoinMonth'],
      ['a join date after the office’s today', { joinDate: '2026-11-12' }, 'joinDate'],
    ])('P19.20-T2 AC-2 refuses %s, naming the field, and writes nothing', async (_, body, field) => {
      session.current = OWNER();

      const res = await patch(m.AGENT, body).expect(400);

      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field } });
    });

    it.each([
      ['a gender the API does not know', { gender: 'L' }, 'gender must be male or female'],
      ['a work status the API does not know', { workStatus: 'fulltime' }, 'workStatus must be full_time or part_time'],
      ['a date of the wrong shape', { dateOfBirth: '15-05-1985' }, 'dateOfBirth must be a date, YYYY-MM-DD'],
      ['a month of the wrong shape', { companyJoinMonth: '03/2020' }, 'companyJoinMonth must be a month, YYYY-MM'],
      ['an agent code with letters', { agentCode: 'PRU-80009' }, 'agentCode must be digits only, 3 to 32 of them'],
      ['a number of eight digits', { phone: '12345678' }, 'phone must be an Indonesian number: 9 to 13 digits after +62'],
      ['null: nothing is cleared here', { gender: null }, 'gender must be male or female'],
    ])('P19.20-T2 AC-2 refuses %s in the profile’s words', async (_, body, violation) => {
      session.current = OWNER();

      const res = await patch(m.AGENT, body).expect(400);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.violations).toEqual([violation]);
    });

    it('P19.20-T2 AC-2 a body naming none of the fields is refused, and so is a field it does not know', async () => {
      session.current = OWNER();

      expect((await patch(m.AGENT, {}).expect(400)).body.error.message).toBe('Fill in at least one of the details.');
      expect((await patch(m.AGENT, { fullName: 'Someone Else' }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await patch(m.AGENT, { email: 'not-an-address' }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('what is recorded', () => {
    it('P19.20-T2 AC-2 one member.details_edited entry: who, the fields, before and after', async () => {
      session.current = OWNER();

      await patch(m.DONE, { gender: 'male', workStatus: 'full_time' }).expect(200);

      const entries = await audits.find({ action: 'member.details_edited' }).lean().exec();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        targetCollection: 'memberships', targetId: m.DONE, targetMembershipId: m.DONE,
        before: { workStatus: 'part_time', gender: 'female' },
        after: { workStatus: 'full_time', gender: 'male' },
      });
    });

    it('P19.20-T2 AC-2 a value sent as it is stored changes nothing and records nothing', async () => {
      session.current = OWNER();

      const res = await patch(m.DONE, { gender: 'female' }).expect(200);

      expect(res.body.filled).toEqual([]);
      expect(await audits.countDocuments({ action: 'member.details_edited' })).toBe(0);
    });
  });
});
