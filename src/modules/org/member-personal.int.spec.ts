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
 * ***Lengkapi data* — the Owner and the Admins fill a member's blank personal data, over HTTP** (P19.12-T5 AC-3;
 * ADR-0248 §3; the client's TI-2).
 *
 * Office A, built through `HierarchyService.create`:
 *
 * ```
 * ROOT (AB, the Owner) ── AB Agus ─┬── AAB Arief ── AGENT Wahyu (imported: nothing recorded)
 *                                  ├── DONE Indah (everything recorded)
 *                                  └── GONE Wahyu Lama (removed)
 * ```
 */
describe('P19.12-T5 PATCH /members/:membershipId/personal over HTTP', () => {
  let app: INestApplication;
  let hierarchy: HierarchyService;
  let users: mongoose.Model<User>;
  let audits: mongoose.Model<AuditLog>;
  let companyId: string;
  let seq = 0;
  let m: Record<'ROOT' | 'AB' | 'AAB' | 'AGENT' | 'DONE' | 'GONE', string>;

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
    const root = await join('ab', null, 'Wilson Tanoto');
    const ab = await join('ab', root, 'Agus Prasetyo');
    const aab = await join('aab', ab, 'Arief Hidayat');
    m = {
      ROOT: root,
      AB: ab,
      AAB: aab,
      AGENT: await join('agent', aab, 'Wahyu Saputra'),
      DONE: await join('agent', ab, 'Indah Permatasari', {
        dateOfBirth: '1990-03-15', gender: 'female', companyJoinMonth: '2020-09', phone: '+6281211002200',
      }),
      GONE: await join('agent', ab, 'Wahyu Lama'),
    };
    await mongoose.model(Membership.name).updateOne({ _id: m.DONE }, { $set: { workStatus: 'part_time' } });
    await mongoose.model(Membership.name).updateOne({ _id: m.GONE }, { $set: { status: 'removed' } });
  });

  /** A person placed in office A the way every join places them; `recorded` what their account already holds. */
  async function join(
    role: 'ab' | 'aab' | 'agent', leaderId: string | null, fullName: string, recorded: Record<string, unknown> = {},
  ) {
    seq += 1;
    const user = await users.create({
      email: `p${seq}@kpm.test`, passwordHash: 'x', fullName, status: 'active', platformRole: 'none', companyId,
      agentCode: `${77_000 + seq}`, ...recorded,
    });
    const placed = await hierarchy.create(as('mem-placer', 'AB', { isKpmOwner: true }), {
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

  it('P19.12-T5 AC-3 declares member:complete_personal on its one route', () => {
    expect(declaredPermissions(MemberPersonalController)).toEqual({ complete: 'member:complete_personal' });
  });

  describe('who may', () => {
    it('P19.12-T5 AC-3 the Owner fills every blank of an imported member, each where it lives', async () => {
      session.current = OWNER();

      const res = await patch(m.AGENT, FULL).expect(200);

      expect(res.body).toEqual({
        membershipId: m.AGENT,
        filled: ['dateOfBirth', 'gender', 'companyJoinMonth', 'workStatus', 'phone'],
        personal: {
          dateOfBirth: '1992-07-01', gender: 'male', companyJoinMonth: '2021-02', workStatus: 'full_time',
          phone: '+6281322223333', companyName: 'Prudential',
        },
      });
      expect(await accountOf(m.AGENT)).toMatchObject({
        dateOfBirth: '1992-07-01', gender: 'male', companyJoinMonth: '2021-02', phone: '+6281322223333',
      });
      expect(await workStatusOf(m.AGENT)).toBe('full_time');
    });

    it('P19.12-T5 AC-3 an Admin on no field rung fills one blank, and the others stay blank', async () => {
      session.current = ADMIN();

      const res = await patch(m.AGENT, { gender: 'female' }).expect(200);

      expect(res.body.filled).toEqual(['gender']);
      expect(res.body.personal).toMatchObject({ gender: 'female', dateOfBirth: null, workStatus: null, phone: null });
      expect(await workStatusOf(m.AGENT)).toBeNull();
    });

    it('P19.12-T5 AC-3 the Owner may fill blanks of a leader, and of the Owner’s own record', async () => {
      session.current = OWNER();

      await patch(m.AB, { workStatus: 'full_time' }).expect(200);
      await patch(m.ROOT, { dateOfBirth: '1980-01-31' }).expect(200);

      expect(await workStatusOf(m.AB)).toBe('full_time');
      expect((await accountOf(m.ROOT))?.dateOfBirth).toBe('1980-01-31');
    });

    it.each([
      ['an AB, the member’s upline', () => as(m.AB, 'AB')],
      ['an AAB, the member’s direct leader', () => as(m.AAB, 'AAB')],
      ['an Agent', () => as(m.AGENT, 'AGENT', { directCount: 0 })],
      ['a Super Admin outside a support session', () => SUPER_ADMIN],
    ])('P19.12-T5 AC-3 %s is refused, 403 PERM_DENIED, and nothing is written', async (_, who) => {
      session.current = who();

      const res = await patch(m.AGENT, { gender: 'male' }).expect(403);

      expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'member:complete_personal' } });
      expect((await accountOf(m.AGENT))?.gender ?? null).toBeNull();
    });

    it('P19.12-T5 AC-3 is refused in a support session, 403 PERM_DENIED, even as the Owner', async () => {
      session.current = as(m.ROOT, 'AB', { isKpmOwner: true }, 'u-support');

      expect((await patch(m.AGENT, { gender: 'male' }).expect(403)).body.error.code).toBe('PERM_DENIED');
      expect((await accountOf(m.AGENT))?.gender ?? null).toBeNull();
    });

    it('P19.12-T5 AC-3 somebody who has left, or an id that is none, is 404 NOT_FOUND', async () => {
      session.current = OWNER();

      expect((await patch(m.GONE, { gender: 'male' }).expect(404)).body.error.code).toBe('NOT_FOUND');
      await patch('not-an-id', { gender: 'male' }).expect(404);
      await patch(new mongoose.Types.ObjectId().toString(), { gender: 'male' }).expect(404);
      expect((await accountOf(m.GONE))?.gender ?? null).toBeNull();
    });
  });

  describe('blanks only', () => {
    it('P19.12-T5 AC-3 a value on file is refused 409 MEMBER_DETAIL_ON_FILE, the fields named, and nothing is written', async () => {
      session.current = OWNER();

      const res = await patch(m.DONE, { dateOfBirth: '1991-01-01', phone: '0857-0000-1111' }).expect(409);

      expect(res.body.error).toMatchObject({
        code: 'MEMBER_DETAIL_ON_FILE',
        message: 'Some of this is already recorded. Only they can change what is recorded, on My profile.',
        details: { membershipId: m.DONE, fields: ['dateOfBirth', 'phone'] },
      });
      expect(await accountOf(m.DONE)).toMatchObject({ dateOfBirth: '1990-03-15', phone: '+6281211002200' });
      expect(await audits.countDocuments({ action: 'member.personal_completed' })).toBe(0);
    });

    it('P19.12-T5 AC-3 one recorded field among blank ones refuses the whole request: the blank one stays blank', async () => {
      session.current = OWNER();
      await patch(m.AGENT, { gender: 'male' }).expect(200);

      const res = await patch(m.AGENT, { gender: 'female', dateOfBirth: '1992-07-01' }).expect(409);

      expect(res.body.error.details.fields).toEqual(['gender']);
      expect(await accountOf(m.AGENT)).toMatchObject({ gender: 'male' });
      expect((await accountOf(m.AGENT))?.dateOfBirth ?? null).toBeNull();
    });

    it('P19.12-T5 AC-3 a recorded work status is the membership’s, and is refused the same way', async () => {
      session.current = OWNER();

      const res = await patch(m.DONE, { workStatus: 'full_time' }).expect(409);

      expect(res.body.error.details.fields).toEqual(['workStatus']);
      expect(await workStatusOf(m.DONE)).toBe('part_time');
    });

    it('P19.12-T5 AC-3 an empty string on file counts as blank, and is filled', async () => {
      const row = await mongoose.model(Membership.name).findById(m.AGENT).lean<{ userId: string }>().exec();
      await users.updateOne({ _id: row!.userId }, { $set: { phone: '' } });
      session.current = OWNER();

      await patch(m.AGENT, { phone: '0812 1100 2299' }).expect(200);

      expect((await accountOf(m.AGENT))?.phone).toBe('+6281211002299');
    });

    it('P19.12-T5 AC-3 the race: two saves of one blank at once, one is written and the other refused, never overwritten', async () => {
      session.current = OWNER();
      const http = request(app.getHttpServer());

      const answers = await Promise.all(['1991-01-01', '1992-02-02', '1993-03-03'].map((dateOfBirth) =>
        http.patch(`/members/${m.AGENT}/personal`).send({ dateOfBirth })));

      const won = answers.filter((r) => r.status === 200);
      expect(won).toHaveLength(1);
      expect(answers.filter((r) => r.status === 409)).toHaveLength(2);
      expect((await accountOf(m.AGENT))?.dateOfBirth).toBe(won[0]!.body.personal.dateOfBirth);
      expect(await audits.countDocuments({ action: 'member.personal_completed' })).toBe(1);
    });

    it('P19.12-T5 AC-3 the refusal is in Indonesian for an Indonesian reader', async () => {
      session.current = OWNER();

      const res = await patch(m.DONE, { gender: 'male' }).set('Accept-Language', 'id').expect(409);

      expect(res.body.error.message)
        .toBe('Sebagian data ini sudah tercatat. Hanya dia yang dapat mengubah data yang sudah tercatat, di Profil saya.');
    });
  });

  describe('what is refused 400', () => {
    it.each([
      ['a birth date less than 18 years before the office’s today', { dateOfBirth: '2008-11-12' }, 'dateOfBirth'],
      ['a birth date today', { dateOfBirth: '2026-11-11' }, 'dateOfBirth'],
      ['a join month still to come', { companyJoinMonth: '2026-12' }, 'companyJoinMonth'],
    ])('P19.12-T5 AC-3 refuses %s, naming the field, and writes nothing', async (_, body, field) => {
      session.current = OWNER();

      const res = await patch(m.AGENT, body).expect(400);

      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field } });
      expect((await accountOf(m.AGENT))?.[field as 'dateOfBirth'] ?? null).toBeNull();
    });

    it('P19.12-T5 AC-3 a birth date exactly 18 years before the office’s today is taken', async () => {
      session.current = OWNER();

      await patch(m.AGENT, { dateOfBirth: '2008-11-11', companyJoinMonth: '2026-11' }).expect(200);
    });

    it.each([
      ['a gender the API does not know', { gender: 'L' }, 'gender must be male or female'],
      ['a work status the API does not know', { workStatus: 'fulltime' }, 'workStatus must be full_time or part_time'],
      ['a date of the wrong shape', { dateOfBirth: '15-05-1985' }, 'dateOfBirth must be a date, YYYY-MM-DD'],
      ['a month of the wrong shape', { companyJoinMonth: '03/2020' }, 'companyJoinMonth must be a month, YYYY-MM'],
      ['a number of eight digits', { phone: '12345678' }, 'phone must be an Indonesian number: 9 to 13 digits after +62'],
      ['an empty number: nothing is cleared here', { phone: '' }, 'phone must be an Indonesian number: 9 to 13 digits after +62'],
      ['null: nothing is cleared here', { gender: null }, 'gender must be male or female'],
    ])('P19.12-T5 AC-3 refuses %s in the profile’s words', async (_, body, violation) => {
      session.current = OWNER();

      const res = await patch(m.AGENT, body).expect(400);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.violations).toEqual([violation]);
    });

    it('P19.12-T5 AC-3 a body naming none of the five is refused, and so is a field it does not know', async () => {
      session.current = OWNER();

      expect((await patch(m.AGENT, {}).expect(400)).body.error.message).toBe('Fill in at least one of the details.');
      expect((await patch(m.AGENT, { fullName: 'Someone Else' }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('what is recorded', () => {
    it('P19.12-T5 AC-3 one member.personal_completed entry naming the person and the fields, never their values', async () => {
      session.current = OWNER();

      await patch(m.AGENT, FULL).expect(200);

      const entries = await audits.find({ action: 'member.personal_completed' }).lean().exec();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        targetCollection: 'memberships', targetId: m.AGENT, targetMembershipId: m.AGENT,
        after: { fields: ['dateOfBirth', 'gender', 'companyJoinMonth', 'workStatus', 'phone'] },
      });
      const written = JSON.stringify(entries[0]);
      for (const value of ['1992-07-01', '2021-02', '81322223333', '"male"', 'full_time"']) {
        expect([value, written.includes(value)]).toEqual([value, false]);
      }
    });
  });
});
