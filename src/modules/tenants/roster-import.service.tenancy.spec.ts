import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { RequestContext } from '@/common/context/request-context';
import { SOURCE_READER } from '@/common/i18n/reader';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { PasswordService } from '@/modules/auth/password.service';
import { FixedClock } from '@/common/clock/clock.port';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import {
  MembershipHistory, MembershipHistorySchema,
} from '@/modules/org/membership-history.schema';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { Company, CompanySchema } from './company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from './company-org-level.schema';
import { Kpm, KpmSchema } from './kpm.schema';
import { OrgLevelService } from './org-level.service';
import { RosterImportService } from './roster-import.service';
import { ROSTER_TEMPLATE_HEADER } from './roster-csv';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { AB, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { IN_INDONESIAN } from '../../../test/i18n';
import { listenOnLoopback } from '../../../test/listen';
import { AdminController } from './admin.controller';
import { Workbook } from 'exceljs';
import { zipSync } from 'fflate';
import { ROSTER_UPLOAD, XLSX_MIME_TYPE } from '@/domain/constants';
import { SETUP_SESSION_WRITE_SCOPE } from '@/modules/rbac/permissions';

const H = ROSTER_TEMPLATE_HEADER;
const NOW = new Date('2026-09-09T02:00:00.000Z');

describe('RosterImportService (P3.6-T4)', () => {
  let service: RosterImportService;
  let members: MembershipRepository;
  let kpmId: string;
  let companyId: string;
  const clock = new FixedClock(NOW);

  /** The Super Admin, reading the API's English as asserted below: nobody's choice reads Indonesian (P18.98-T4). */
  const sa = () => RequestContext.platform('root').withReader(SOURCE_READER);

  beforeAll(async () => {
    await startMongo();
    const users = mongoose.model(User.name, UserSchema);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    mongoose.model(Membership.name, MembershipSchema);
    mongoose.model(MembershipHistory.name, MembershipHistorySchema);
    mongoose.model(Company.name, CompanySchema);
    mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema);
    mongoose.model(AuditLog.name, AuditLogSchema);

    members = new MembershipRepository(mongoose.model(Membership.name) as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name) as never,
      mongoose.model(Company.name) as never,
      mongoose.model(Kpm.name) as never,
      new AuditService(mongoose.model(AuditLog.name) as never),
      clock,
    );
    const hierarchy = new HierarchyService(
      members,
      kpms as never,
      users as never,
      new MembershipHistoryRepository(mongoose.model(MembershipHistory.name) as never),
      clock,
      orgLevels,
    );
    service = new RosterImportService(
      members,
      hierarchy,
      kpms as never,
      users as never,
      new PasswordService(),
      new AuditService(mongoose.model(AuditLog.name) as never),
      clock,
    );
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    const company = await mongoose.model(Company.name).create({
      name: 'Prudential', slug: `prudential-${Math.random()}`,
    });
    companyId = String(company._id);
    await seedLadder(companyId);
    const kpm = await mongoose.model(Kpm.name).create({
      companyId, code: '0417', branchName: 'BSD City Branch', status: 'active',
      counters: { nextMemberSeq: 1 },
    });
    kpmId = String(kpm._id);
    clock.set(NOW);
  });

  /**
   * Each row gains the four a person records (ADR-0158), valid ones, so a test about something else is
   * not refused for them. A test about them writes its own (`what a person records`, below).
   */
  const P = ',1990-03-15,2021-07,full-time,female';
  const file = (...rows: string[]) => [H, ...rows.map((row) => `${row}${P}`)].join('\n');

  describe('who may run it', () => {
    const memberOf = (id: string, over: Record<string, unknown> = {}) =>
      new RequestContext('u-member', 'none', {
        membershipId: 'mem-1', kpmId: id, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
        isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
      });

    it('lets an Owner fill their own office', async () => {
      // An office that hires ten people at once is the case this exists for; routing it
      // through a platform operator would be the reason nobody uses it.
      const owner = memberOf(kpmId, { isKpmOwner: true });
      const preview = await service.preview(owner, kpmId, file('Rina,rina@k.test,101,ab,'));
      expect(preview.issues).toEqual([]);
      expect(preview.willCreate).toBe(1);
    });

    it('lets an Admin do the same', async () => {
      const admin = memberOf(kpmId, { isKpmAdmin: true });
      await expect(
        service.commit(admin, kpmId, file('Rina,rina@k.test,101,ab,')),
      ).resolves.toMatchObject({ created: [{ agentCode: '101' }] });
    });

    it('refuses a leader, who administers nothing', async () => {
      await expect(service.preview(memberOf(kpmId), kpmId, file())).rejects.toMatchObject({
        code: 'PERM_DENIED',
      });
    });

    /*
     * **The check the wider grant turns on.**
     *
     * `kpm:import_roster` is `own-kpm` for an Owner, and the office id arrives in the URL
     * — so nothing but this stops one office filling another with accounts it controls
     * the passwords for. It answers 404, never 403: a 403 would confirm the id is real.
     */
    it('refuses an Owner any office but their own, as not found', async () => {
      const other = await mongoose.model(Kpm.name).create({
        companyId, code: '0555', branchName: 'Somebody Else', status: 'active',
        counters: { nextMemberSeq: 1 },
      });
      const owner = memberOf(kpmId, { isKpmOwner: true });

      for (const call of [
        () => service.preview(owner, String(other._id), file('R,r@k.test,101,ab,')),
        () => service.commit(owner, String(other._id), file('R,r@k.test,101,ab,')),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
      expect(await mongoose.model(User.name).countDocuments({})).toBe(0);
    });

    it('writes as the Owner, not as a platform operator', async () => {
      // `superAdminInTenant` names an office for somebody who is in none. Reaching for it
      // unconditionally would attribute every membership an Owner imported to a platform
      // operator, and promote their context for the duration of the write.
      const owner = memberOf(kpmId, { isKpmOwner: true });
      await service.commit(owner, kpmId, file('Rina,rina@k.test,101,ab,'));

      const row = await mongoose.model(AuditLog.name).findOne({ action: 'roster.imported' });
      expect(row?.get('actorUserId')).toBe('u-member');
      expect(row?.get('actorMembershipId')).toBe('mem-1');
    });

    it('404s an office that is not there, and a malformed id alike', async () => {
      await expect(service.preview(sa(), 'not-an-objectid', file())).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        service.preview(sa(), String(new mongoose.Types.ObjectId()), file()),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('the preview', () => {
    it('reports what a clean file would do, and writes nothing', async () => {
      const csv = file('Rina Wijaya,rina@k.test,101,ab,');
      const preview = await service.preview(sa(), kpmId, csv);

      expect(preview.issues).toEqual([]);
      expect(preview.willCreate).toBe(1);
      expect(preview.rows[0]).toMatchObject({ line: 2, agentCode: '101' });
      expect(await mongoose.model(User.name).countDocuments({})).toBe(0);
    });

    it('says zero would be created the moment anything is wrong', async () => {
      // Not "nine of ten": the commit is all-or-nothing, so a count that suggested
      // otherwise would be a promise the commit does not keep.
      const csv = file('Rina,rina@k.test,101,ab,', 'Budi,not-an-email,102,agent,');
      const preview = await service.preview(sa(), kpmId, csv);
      expect(preview.issues).toHaveLength(1);
      expect(preview.willCreate).toBe(0);
    });

    it('reports a code the insurer already issued, naming who has it', async () => {
      await mongoose.model(User.name).create({
        email: 'held@k.test', passwordHash: 'x', fullName: 'Held', companyId, agentCode: '101',
      });
      const preview = await service.preview(sa(), kpmId, file('Rina,rina@k.test,101,ab,'));
      expect(preview.issues[0]).toMatchObject({ line: 2, column: 'agentCode' });
      expect(preview.issues[0].message).toContain('held@k.test');
    });

    /*
     * **B1 (the T17–T20 permission review): who holds a code is said only to whoever may know.** Codes are unique per
     * insurer, so the holder can be a member of another office of the same company; naming them to an Owner of this one
     * would let a file of sequential codes collect that office's addresses.
     */
    describe('B1 a code held elsewhere names nobody', () => {
      const ownerOf = (id: string) => new RequestContext('u-owner-a', 'none', {
        membershipId: 'mem-owner-a', kpmId: id, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
        isKpmOwner: true, isKpmAdmin: false, directCount: 0,
      }).withReader(SOURCE_READER);
      /** A person of the insurer holding code 101, a live member of `officeId`. */
      const holderIn = async (officeId: string, status = 'active') => {
        const user = await mongoose.model(User.name).create({
          email: 'held@office-b.test', passwordHash: 'x', fullName: 'Held Elsewhere', companyId, agentCode: '101',
        });
        await mongoose.connection.db!.collection('memberships').insertOne({
          kpmId: officeId, userId: String(user._id), agentCode: '101', orgLevelCode: 'AGENT', hierarchyRole: 'agent',
          leaderId: null, ancestorIds: [], status, deletedAt: null,
        } as never);
      };
      const officeB = async () => String((await mongoose.model(Kpm.name).create({
        companyId, code: '0555', branchName: 'Kantor B', status: 'active', counters: { nextMemberSeq: 1 },
      }))._id);

      it('B1 an Owner of office A previewing a code of office B’s member is told it is taken, with no email and nothing of B', async () => {
        await holderIn(await officeB());
        const preview = await service.preview(ownerOf(kpmId), kpmId, file('Rina,rina@k.test,101,ab,'));
        expect(preview.issues).toEqual([
          { line: 2, column: 'agentCode', message: 'This agent code is already registered at this insurer.' },
        ]);
        const said = JSON.stringify(preview);
        for (const leak of ['held@office-b.test', 'Held Elsewhere', 'Kantor B', '0555']) expect(said).not.toContain(leak);
      });

      it('B1 the commit’s refusal says the same, and carries no email', async () => {
        await holderIn(await officeB());
        const refused = await service.commit(ownerOf(kpmId), kpmId, file('Rina,rina@k.test,101,ab,'))
          .catch((err: { details: unknown }) => err);
        expect(JSON.stringify((refused as { details: unknown }).details)).not.toContain('held@office-b.test');
        expect((refused as { details: { issues: { column: string }[] } }).details.issues[0].column).toBe('agentCode');
      });

      it('B1 a holder who left this office is somebody elsewhere too: not named', async () => {
        await holderIn(kpmId, 'removed');
        const preview = await service.preview(ownerOf(kpmId), kpmId, file('Rina,rina@k.test,101,ab,'));
        expect(preview.issues[0].message).toBe('This agent code is already registered at this insurer.');
      });

      it('B1 a holder who is a live member of this same office is still named to its Owner', async () => {
        await holderIn(kpmId);
        const preview = await service.preview(ownerOf(kpmId), kpmId, file('Rina,rina@k.test,101,ab,'));
        expect(preview.issues[0]).toMatchObject({ column: 'agentCode', message: 'Already registered at this insurer by held@office-b.test.' });
      });

      it('B1 the Super Admin is still told who holds it, whichever office that is', async () => {
        await holderIn(await officeB());
        const preview = await service.preview(sa(), kpmId, file('Rina,rina@k.test,101,ab,'));
        expect(preview.issues[0].message).toContain('held@office-b.test');
      });
    });

    it('reports an address that already has an account', async () => {
      await mongoose.model(User.name).create({
        email: 'rina@k.test', passwordHash: 'x', fullName: 'Rina', companyId, agentCode: '109',
      });
      const preview = await service.preview(sa(), kpmId, file('Rina,rina@k.test,101,ab,'));
      expect(preview.issues[0].column).toBe('email');
    });

    it('accepts a leader who is already in the office', async () => {
      const csv = file('Root,root@k.test,109,ab,');
      await service.commit(sa(), kpmId, csv);
      const preview = await service.preview(sa(), kpmId, file('Rina,rina@k.test,101,agent,109'));
      expect(preview.issues).toEqual([]);
    });

    it('refuses a leader who is in neither the file nor the office', async () => {
      const preview = await service.preview(sa(), kpmId, file('Rina,rina@k.test,101,agent,NOBODY'));
      expect(preview.issues[0]).toMatchObject({ line: 2, column: 'leaderAgentCode' });
      expect(preview.issues[0].message).toContain('NOBODY');
    });

    it('sorts issues by line, so the list reads like the file', async () => {
      const csv = file(
        'A,a@k.test,201,director,',
        'B,not-an-email,202,agent,',
      );
      const preview = await service.preview(sa(), kpmId, csv);
      expect(preview.issues.map((i) => i.line)).toEqual([2, 3]);
    });
  });

  describe('what a person records (P18.8-T4, ADR-0158)', () => {
    const bare = (...rows: string[]) => [H, ...rows].join('\n');

    it('AC-1, AC-2: writes the birth date, join month and gender on the account, the work status on the membership', async () => {
      await service.commit(sa(), kpmId, bare(
        'Root,root@k.test,109,AB,,1984-05-12,2012-03,full-time,male',
        'Rina,rina@k.test,101,Agent,109,1998-07-21,2024-01,Part-Time,FEMALE',
      ));
      const rina = await mongoose.model(User.name).findOne({ email: 'rina@k.test' }).lean<User & { _id: unknown }>();
      expect(rina).toMatchObject({ dateOfBirth: '1998-07-21', companyJoinMonth: '2024-01', gender: 'female' });
      const scoped = RequestContext.tenantRead(kpmId, 'test');
      const membership = await members.findOne(scoped, { userId: String(rina!._id) });
      expect(membership?.workStatus).toBe('part_time');
      expect(membership?.role).toBe('agent');
      const root = await members.findOne(scoped, { agentCode: '109' });
      expect(root?.workStatus).toBe('full_time');
    });

    it('AC-2: a row missing one of the four is refused whole, the column named, and nothing is written', async () => {
      const refusal = await service.commit(sa(), kpmId, bare(
        'Rina,rina@k.test,101,Agent,,1998-07-21,,part-time,female',
      )).catch((e) => e);
      expect(refusal.details.issues).toEqual([
        { line: 2, column: 'companyJoinMonth', message: 'The month they joined the company is required.' },
      ]);
      expect(await mongoose.model(User.name).countDocuments({})).toBe(0);
    });

    it('AC-4: measures 18 years and the join month against the office\'s today, in its timezone', async () => {
      // 02:00 UTC on 9 September is 09:00 in Jakarta: somebody born on 10 September 2008 is not 18 yet.
      const row = 'Rina,rina@k.test,101,Agent,,2008-09-10,2026-09,full-time,female';
      const early = await service.preview(sa(), kpmId, bare(row));
      expect(early.issues).toEqual([
        { line: 2, column: 'dateOfBirth', message: 'A date of birth must be at least 18 years ago.' },
      ]);
      // 20:00 UTC on 9 September is already the 10th in Jakarta, while the server's UTC still says the 9th.
      clock.set(new Date('2026-09-09T20:00:00.000Z'));
      expect((await service.preview(sa(), kpmId, bare(row))).issues).toEqual([]);
      const nextMonth = await service.preview(sa(), kpmId, bare('Rina,rina@k.test,101,Agent,,1990-01-01,2026-10,full-time,female'));
      expect(nextMonth.issues).toEqual([
        { line: 2, column: 'companyJoinMonth', message: 'The company join month cannot be in the future.' },
      ]);
    });

    it('AC-5: refuses a new agent code with letters in it', async () => {
      const refused = await service.preview(sa(), kpmId, bare('Rina,rina@k.test,PRU-101,Agent,,1990-01-01,2020-01,full-time,female'));
      expect(refused.issues).toEqual([
        { line: 2, column: 'agentCode', message: '"PRU-101" is not an agent code. Use digits only, 3 to 32 of them.' },
      ]);
    });
  });

  describe('the commit', () => {
    it('creates everybody, with a membership and a rung', async () => {
      const csv = file(
        'Root,root@k.test,109,ab,',
        'Rina,rina@k.test,101,agent,109',
      );
      const result = await service.commit(sa(), kpmId, csv);

      expect(result.created).toHaveLength(2);
      const rina = await mongoose.model(User.name).findOne({ email: 'rina@k.test' });
      expect(rina?.get('companyId')).toBe(companyId);
      expect(rina?.get('agentCode')).toBe('101');

      const membership = await members.findOne(
        RequestContext.tenantRead(kpmId, 'test'),
        { userId: String(rina!._id) },
      );
      expect(membership?.role).toBe('agent');
      expect(membership?.status).toBe('active');
      expect(membership?.orgLevelId).toBeTruthy();
    });

    it('creates a leader before the people who report to them, whatever the file order', async () => {
      // A spreadsheet lists people in whatever order it held them.
      const csv = file(
        'Rina,rina@k.test,101,agent,109',
        'Root,root@k.test,109,ab,',
      );
      await service.commit(sa(), kpmId, csv);

      const scoped = RequestContext.tenantRead(kpmId, 'test');
      const root = (await members.find(scoped, { agentCode: '109' }))[0];
      const rina = (await members.find(scoped, { agentCode: '101' }))[0];
      expect(rina.leaderId).toBe(String(root._id));
      expect(rina.ancestorIds).toEqual([String(root._id)]);
    });

    it('hands back a password per person, and stores none of them', async () => {
      const csv = file('Rina,rina@k.test,101,ab,');
      const { created } = await service.commit(sa(), kpmId, csv);

      expect(created[0].temporaryPassword).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
      const stored = await mongoose.model(User.name)
        .findOne({ email: 'rina@k.test' }).select('+passwordHash');
      // Hashed, not kept. The response is the only place the plaintext exists.
      expect(stored?.get('passwordHash')).not.toBe(created[0].temporaryPassword);
      expect(await new PasswordService().verify(
        stored!.get('passwordHash') as string,
        created[0].temporaryPassword,
      )).toBe(true);
    });

    it('marks every account as owing a password of its own', async () => {
      await service.commit(sa(), kpmId, file('Rina,rina@k.test,101,ab,'));
      const rina = await mongoose.model(User.name).findOne({ email: 'rina@k.test' });
      // The credential the operator has read opens nothing but the screen that replaces
      // it — `AuthGuard` refuses the rest.
      expect(rina?.get('mustChangePassword')).toBe(true);
      // And it can sign in at all, which the guard needs it to be able to do.
      expect(rina?.get('status')).toBe('active');
      expect(rina?.get('emailVerifiedAt')).toBeTruthy();
    });

    it('writes nothing at all when one row is wrong', async () => {
      // The promise the whole design turns on. A half-imported roster cannot be told from
      // a whole one, and re-uploading the file would refuse every row that landed.
      const csv = file(
        'Root,root@k.test,109,ab,',
        'Rina,rina@k.test,101,agent,109',
        'Broken,not-an-email,102,agent,109',
      );
      await expect(service.commit(sa(), kpmId, csv)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });

      expect(await mongoose.model(User.name).countDocuments({})).toBe(0);
      expect(await mongoose.model(Membership.name).countDocuments({})).toBe(0);
    });

    it('carries every issue into the refusal, so one upload answers everything', async () => {
      // Blank name, bad address, no code, and a rung that is not one.
      const csv = file(',not-an-email,,director,');
      const refusal = await service.commit(sa(), kpmId, csv).catch((e) => e);
      expect(refusal.details.issues.map((i: { column: string }) => i.column).sort())
        .toEqual(['agentCode', 'email', 'fullName', 'role']);
    });

    it('refuses a file with a header and nobody in it', async () => {
      await expect(service.commit(sa(), kpmId, file())).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    });

    it('audits the count and the codes, and never a password', async () => {
      const { created } = await service.commit(sa(), kpmId, file('Rina,rina@k.test,101,ab,'));
      const row = await mongoose.model(AuditLog.name).findOne({ action: 'roster.imported' });

      expect(row?.get('after')).toMatchObject({ count: 1, agentCodes: ['101'] });
      expect(JSON.stringify(row?.toObject())).not.toContain(created[0].temporaryPassword);
    });

    it('never reaches another office', async () => {
      const other = await mongoose.model(Kpm.name).create({
        companyId, code: '0555', branchName: 'Other', status: 'active',
        counters: { nextMemberSeq: 1 },
      });
      await service.commit(sa(), String(other._id), file('Rina,rina@k.test,101,ab,'));

      const here = await members.find(RequestContext.tenantRead(kpmId, 'test'), {});
      expect(here).toEqual([]);
    });
  });

  /*
   * **The preview's issues, and the commit's refusal, written for their reader** (P18.98-T5 AC-3, AC-7): each issue
   * is a sentence in both languages, which the preview writes for the request's reader and the error filter writes in
   * the commit's `details.issues`. Over HTTP, so the header is what decides.
   */
  describe('P18.98-T5 AC-7 over HTTP, in the reader’s language', () => {
    let app: INestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [AdminController],
        providers: [{ provide: RosterImportService, useValue: service }],
      })
        .useMocker(() => ({}))
        .compile();
      app = moduleRef.createNestApplication();
      app.useGlobalPipes(productionPipe());
      app.useGlobalFilters(new DomainExceptionFilter());
      app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
      await app.init();
      await listenOnLoopback(app);
    });
    afterAll(() => app.close());
    beforeEach(() => { session.current = SUPER_ADMIN; });

    const rows = () => file('Rina,rina@k.test,101,senior manager,', 'Budi,rina@k.test,102,agent,');
    const NOT_A_RUNG_ID = '"senior manager" bukan jenjang. Gunakan kode jenjang dari susunan jenjang perusahaan Anda — '
      + 'AB, AAB, atau Agent, atau jenjang yang ditambahkannya.';

    it('previews every row’s issue in Indonesian for an Indonesian reader, and in English for an English one', async () => {
      const res = await request(app.getHttpServer()).post(`/admin/tenants/${kpmId}/roster/preview`)
        .set(...IN_INDONESIAN).send({ rows: rows() }).expect(200);
      expect(res.body.issues).toEqual([
        { line: 2, column: 'role', message: NOT_A_RUNG_ID },
        { line: 3, column: 'email', message: 'Sudah ada di baris 2.' },
      ]);
      expect(res.body.willCreate).toBe(0);

      const english = await request(app.getHttpServer()).post(`/admin/tenants/${kpmId}/roster/preview`)
        .send({ rows: rows() }).expect(200);
      expect(english.body.issues.map((i: { message: string }) => i.message)).toEqual([
        '"senior manager" is not a rung. Use a rung of your company’s ladder by its code — AB, AAB or Agent, '
          + 'or one it added.',
        'Already on line 2.',
      ]);
    });

    it('refuses the commit with the same issues, the refusal and each issue in Indonesian', async () => {
      const res = await request(app.getHttpServer()).post(`/admin/tenants/${kpmId}/roster`)
        .set(...IN_INDONESIAN).send({ rows: rows() }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message)
        .toBe('2 baris tidak dapat diimpor. Tidak ada yang dibuat — perbaiki file, lalu unggah lagi.');
      expect(res.body.error.details.issues).toEqual([
        { line: 2, column: 'role', message: NOT_A_RUNG_ID },
        { line: 3, column: 'email', message: 'Sudah ada di baris 2.' },
      ]);

      const english = await request(app.getHttpServer()).post(`/admin/tenants/${kpmId}/roster`)
        .send({ rows: rows() }).expect(400);
      expect(english.body.error.message)
        .toBe('2 rows would not import. Nothing was created — fix the file and upload it again.');
      expect(english.body.error.details.issues[1]).toEqual({ line: 3, column: 'email', message: 'Already on line 2.' });
    });
  });

  /*
   * **ADR-0184: the roster as a file — an Excel workbook or a CSV.** The file is read to the text a paste is and meets
   * the same parser; the office is checked before the file is read, and another office's id is 404 as everywhere here.
   */
  describe('ADR-0184 the roster as a file', () => {
    const memberOf = (id: string, over: Record<string, unknown> = {}) =>
      new RequestContext('u-member', 'none', {
        membershipId: 'mem-1', kpmId: id, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
        isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
      });

    /** The Excel template, filled in with `rows` under its header, as somebody would save it. */
    const filledWorkbook = async (...rows: string[][]): Promise<Buffer> => {
      const workbook = new Workbook();
      await workbook.xlsx.load((await service.workbook(sa(), kpmId)) as unknown as Parameters<Workbook['xlsx']['load']>[0]);
      rows.forEach((cells, i) => { workbook.getWorksheet('Data')!.getRow(i + 2).values = cells; });
      return Buffer.from(await workbook.xlsx.writeBuffer());
    };
    const person = (name: string, email: string, code: string, role = 'ab', leader = '') =>
      [name, email, code, role, leader, '1990-03-15', '2021-07', 'full-time', 'female'];
    const upload = (buffer: Buffer, originalname = 'roster.xlsx') => ({ buffer, originalname, size: buffer.length });

    it('previews a filled workbook through the same parser as a paste', async () => {
      const file = upload(await filledWorkbook(person('Rina', 'rina@k.test', '101'), person('Budi', 'budi@k.test', '102', 'agent', '101')));
      const preview = await service.previewFile(sa(), kpmId, file);
      expect(preview.issues).toEqual([]);
      expect(preview.rows.map((r) => [r.line, r.agentCode])).toEqual([[2, '101'], [3, '102']]);
      expect(preview.willCreate).toBe(2);
    });

    it('imports a filled workbook all or nothing, as the paste is', async () => {
      const file = upload(await filledWorkbook(person('Rina', 'rina@k.test', '101')));
      await expect(service.commitFile(sa(), kpmId, file)).resolves.toMatchObject({ created: [{ agentCode: '101' }] });

      const twice = upload(await filledWorkbook(person('Sari', 'sari@k.test', '201'), person('Rina', 'rina@k.test', '202')));
      await expect(service.commitFile(sa(), kpmId, twice)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await mongoose.model(User.name).countDocuments({ email: 'sari@k.test' })).toBe(0);
    });

    it('reads a CSV file as it reads a paste', async () => {
      const preview = await service.previewFile(sa(), kpmId, upload(Buffer.from(file('Rina,rina@k.test,101,ab,')), 'roster.csv'));
      expect(preview).toMatchObject({ issues: [], willCreate: 1 });
    });

    it('asks for the file when there is none', async () => {
      await expect(service.previewFile(sa(), kpmId, undefined)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED', details: { field: 'file' },
      });
    });

    it('lets the Owner fill their own office from a file, and refuses them any other as not found', async () => {
      const owner = memberOf(kpmId, { isKpmOwner: true });
      const filled = upload(await filledWorkbook(person('Rina', 'rina@k.test', '101')));
      await expect(service.previewFile(owner, kpmId, filled)).resolves.toMatchObject({ willCreate: 1 });

      const other = await mongoose.model(Kpm.name).create({
        companyId, code: '0555', branchName: 'Somebody Else', status: 'active', counters: { nextMemberSeq: 1 },
      });
      for (const call of [
        () => service.previewFile(owner, String(other._id), filled),
        () => service.commitFile(owner, String(other._id), filled),
        () => service.workbook(owner, String(other._id)),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
      expect(await mongoose.model(User.name).countDocuments({})).toBe(0);
    });

    it('refuses a leader, who administers nothing, the file and the template alike', async () => {
      const filled = upload(await filledWorkbook(person('Rina', 'rina@k.test', '101')));
      await expect(service.previewFile(memberOf(kpmId), kpmId, filled)).rejects.toMatchObject({ code: 'PERM_DENIED' });
      await expect(service.commitFile(memberOf(kpmId), kpmId, filled)).rejects.toMatchObject({ code: 'PERM_DENIED' });
      await expect(service.workbook(memberOf(kpmId), null)).rejects.toMatchObject({ code: 'PERM_DENIED' });
    });

    it('offers the office’s ladder as the role dropdown — the Owner’s own when they name none — and free text with no office', async () => {
      const open = async (bytes: Buffer) => {
        const workbook = new Workbook();
        await workbook.xlsx.load(bytes as unknown as Parameters<Workbook['xlsx']['load']>[0]);
        return workbook.getWorksheet('Data')!.getCell('D2').dataValidation;
      };
      expect(await open(await service.workbook(memberOf(kpmId, { isKpmOwner: true }), null)))
        .toMatchObject({ type: 'list', formulae: ['"AAB,AB,AGENT"'] });
      expect(await open(await service.workbook(sa(), kpmId))).toMatchObject({ formulae: ['"AAB,AB,AGENT"'] });
      expect(await open(await service.workbook(sa(), null))).toBeUndefined();
    });

    describe('over HTTP', () => {
      let app: INestApplication;

      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
          controllers: [AdminController],
          providers: [{ provide: RosterImportService, useValue: service }],
        })
          .useMocker(() => ({}))
          .compile();
        app = moduleRef.createNestApplication();
        app.useGlobalPipes(productionPipe());
        app.useGlobalFilters(new DomainExceptionFilter());
        app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
        await app.init();
        await listenOnLoopback(app);
      });
      afterAll(() => app.close());
      beforeEach(() => { session.current = SUPER_ADMIN; });

      /** A binary answer, kept as bytes. */
      const binary = (res: request.Response, done: (err: Error | null, body: Buffer) => void) => {
        const stream = res as unknown as NodeJS.ReadableStream;
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => done(null, Buffer.concat(chunks)));
      };
      const send = (path: string, bytes: Buffer, name = 'roster.xlsx') =>
        request(app.getHttpServer()).post(`/admin/tenants/${kpmId}/roster/${path}`).attach('file', bytes, name);

      it('answers the template as a workbook, named and typed as one, its guide in the reader’s language', async () => {
        const res = await request(app.getHttpServer()).get(`/admin/tenants/roster-template?format=xlsx&kpmId=${kpmId}`)
          .set(...IN_INDONESIAN).buffer(true).parse(binary).expect(200);
        expect(res.headers['content-type']).toBe(XLSX_MIME_TYPE);
        expect(res.headers['content-disposition']).toBe('attachment; filename="roster-template.xlsx"');
        const workbook = new Workbook();
        await workbook.xlsx.load(res.body as unknown as Parameters<Workbook['xlsx']['load']>[0]);
        expect(workbook.worksheets.map((w) => w.name)).toEqual(['Petunjuk', 'Data']);
      });

      it('answers the CSV template as the header alone, and the JSON as before, its template header-only', async () => {
        const csv = await request(app.getHttpServer()).get('/admin/tenants/roster-template?format=csv')
          .buffer(true).parse(binary).expect(200);
        expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
        expect(csv.headers['content-disposition']).toBe('attachment; filename="roster-template.csv"');
        expect(csv.body.toString('utf8')).toBe(`${H}\n`);

        const json = await request(app.getHttpServer()).get('/admin/tenants/roster-template').expect(200);
        expect(json.body).toMatchObject({ header: H, template: `${H}\n` });
        expect(json.body.examples).toHaveLength(3);
      });

      it('refuses a format the template does not come in', async () => {
        const res = await request(app.getHttpServer()).get('/admin/tenants/roster-template?format=pdf').expect(400);
        expect(res.body.error).toMatchObject({
          code: 'VALIDATION_FAILED',
          details: { violations: ['That is not a format the roster template comes in. Ask for format=xlsx or format=csv.'] },
        });
        const id = await request(app.getHttpServer()).get('/admin/tenants/roster-template?format=pdf')
          .set(...IN_INDONESIAN).expect(400);
        expect(id.body.error.details.violations).toEqual(['Itu bukan format template roster. Minta format=xlsx atau format=csv.']);
      });

      /*
       * **S4 (the T17–T20 permission review): the query is a DTO.** `kpmId` reaches a lookup by id, so an operator object
       * in its place is refused before anything is read — never handed to the database to match some office — and so
       * is a format that is not a string, and a query field nobody declared.
       */
      it('S4 refuses a kpmId that is not an id, an operator object included, and reads no office for it', async () => {
        for (const query of [
          'format=xlsx&kpmId[$ne]=000000000000000000000000',
          'format=xlsx&kpmId=not-an-id',
          'format[$ne]=pdf',
          'format=xlsx&office=x',
        ]) {
          const res = await request(app.getHttpServer()).get(`/admin/tenants/roster-template?${query}`);
          expect([query, res.status, res.body.error?.code]).toEqual([query, 400, 'VALIDATION_FAILED']);
        }
        // And an Owner's operator object is the same 400, not another office's ladder or a 404 that confirms one.
        session.current = OWNER;
        const owner = await request(app.getHttpServer())
          .get('/admin/tenants/roster-template?format=xlsx&kpmId[$ne]=000000000000000000000000');
        expect(owner.status).toBe(400);
      });

      it('previews and imports an uploaded workbook, as multipart form data', async () => {
        const filled = await filledWorkbook(person('Rina', 'rina@k.test', '101'));
        const preview = await send('file/preview', filled).expect(200);
        expect(preview.body).toMatchObject({ issues: [], willCreate: 1 });
        const committed = await send('file', filled).expect(201);
        expect(committed.body.created).toEqual([expect.objectContaining({ agentCode: '101', email: 'rina@k.test' })]);
      });

      it('answers a row’s problem in the reader’s language, on the row the sheet shows', async () => {
        const filled = await filledWorkbook(person('Rina', 'not-an-email', '101'));
        const res = await send('file/preview', filled).set(...IN_INDONESIAN).expect(200);
        expect(res.body.issues).toEqual([{ line: 2, column: 'email', message: '"not-an-email" bukan alamat email.' }]);
      });

      it('previews an uploaded CSV the same way', async () => {
        const res = await send('file/preview', Buffer.from(file('Rina,rina@k.test,101,ab,')), 'roster.csv').expect(200);
        expect(res.body).toMatchObject({ issues: [], willCreate: 1 });
      });

      it('refuses a file over the ceiling as ASSET_TOO_LARGE, and a zip bomb before opening it', async () => {
        const big = await send('file/preview', Buffer.alloc(ROSTER_UPLOAD.MAX_BYTES + 1, 0x41), 'roster.csv').expect(413);
        expect(big.body.error).toMatchObject({ code: 'ASSET_TOO_LARGE', details: { maxBytes: 1_048_576 } });

        const bomb = Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': new Uint8Array(30 * 1024 * 1024) }, { level: 9 }));
        const refused = await send('file/preview', bomb).set(...IN_INDONESIAN).expect(413);
        expect(refused.body.error).toMatchObject({
          code: 'ASSET_TOO_LARGE', details: { maxUncompressedBytes: 26_214_400 },
          message: 'Workbook ini lebih dari 25 MB setelah dibuka. Template yang sudah diisi jauh di bawah 1 MB — periksa '
            + 'apakah ini file yang benar.',
        });
      });

      it('refuses a workbook that will not open, and no file, with codes a client can branch on', async () => {
        const broken = await send('file/preview', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01])).expect(422);
        expect(broken.body.error.code).toBe('UPLOAD_MALFORMED_CSV');
        const none = await request(app.getHttpServer()).post(`/admin/tenants/${kpmId}/roster/file/preview`).expect(400);
        expect(none.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'file' } });
        const misnamed = await request(app.getHttpServer()).post(`/admin/tenants/${kpmId}/roster/file/preview`)
          .attach('upload', Buffer.from('x'), 'roster.csv').expect(400);
        expect(misnamed.body.error.code).toBe('VALIDATION_FAILED');
      });

      /*
       * **S5 (the T17–T20 permission review): every role on the three T19 routes** — the file's preview, its import and
       * the template workbook — through the real `PermissionsGuard`. `kpm:import_roster` is the Owner's and the Admin's
       * at `own-kpm` and the Super Admin's at `all`; no rung holds it; a support session that only looks may not use it,
       * and a setup session may, for its own office (ADR-0162).
       */
      describe('S5 who may use the file routes', () => {
        const inOffice = (id: string, over: Record<string, unknown> = {}) => ({
          membershipId: 'mem-staff', kpmId: id, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
          isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
        }) as never;
        const adminOf = (id: string) => new RequestContext('u-admin-here', 'none', inOffice(id, { isKpmAdmin: true }));
        /** A support session as this office's Owner: `setup` with the scope, read-only without it (ADR-0162). */
        const supportAsOwner = (writeScope: readonly string[]) => new RequestContext(
          'u-owner-here', 'none', inOffice(kpmId, { isKpmOwner: true }), 'sa-1', null, false, true, writeScope,
        );
        const csv = (email: string, code: string) => Buffer.from(file(`Rina,${email},${code},agent,`));
        const template = (id: string) => request(app.getHttpServer())
          .get(`/admin/tenants/roster-template?format=xlsx&kpmId=${id}`).buffer(true).parse(binary);
        /** The three routes, against office `id`. */
        const three = (id: string, email: string, code: string) => [
          ['preview', () => request(app.getHttpServer()).post(`/admin/tenants/${id}/roster/file/preview`).attach('file', csv(email, code), 'roster.csv')],
          ['import', () => request(app.getHttpServer()).post(`/admin/tenants/${id}/roster/file`).attach('file', csv(email, code), 'roster.csv')],
          ['template', () => template(id)],
        ] as const;
        const anotherOffice = async () => String((await mongoose.model(Kpm.name).create({
          companyId, code: '0556', branchName: 'Kantor Lain', status: 'active', counters: { nextMemberSeq: 1 },
        }))._id);
        const statuses = async (calls: ReturnType<typeof three>) => {
          const out: [string, number][] = [];
          for (const [route, call] of calls) out.push([route, (await call()).status]);
          return out;
        };

        it('S5 lets the office’s KPM Admin preview, import and download the template, for their own office', async () => {
          session.current = adminOf(kpmId);
          expect(await statuses(three(kpmId, 'admin-made@k.test', '301')))
            .toEqual([['preview', 200], ['import', 201], ['template', 200]]);
          expect(await mongoose.model(User.name).countDocuments({ email: 'admin-made@k.test' })).toBe(1);
        });

        it('S5 answers a KPM Admin naming another office not found, on all three, and creates nobody', async () => {
          const other = await anotherOffice();
          session.current = adminOf(kpmId);
          expect(await statuses(three(other, 'elsewhere@k.test', '302')))
            .toEqual([['preview', 404], ['import', 404], ['template', 404]]);
          expect(await mongoose.model(User.name).countDocuments({})).toBe(0);
        });

        it.each([
          ['an AAB', { orgLevelCode: 'AAB', hierarchyRole: 'aab' }],
          ['an Agent', { orgLevelCode: 'AGENT', hierarchyRole: 'agent' }],
        ])('S5 refuses %s of the office all three, 403', async (_who, rung) => {
          session.current = new RequestContext('u-rung', 'none', inOffice(kpmId, rung));
          expect(await statuses(three(kpmId, 'rung@k.test', '303')))
            .toEqual([['preview', 403], ['import', 403], ['template', 403]]);
          expect(await mongoose.model(User.name).countDocuments({})).toBe(0);
        });

        it('S5 refuses a read-only support session all three, and writes nothing', async () => {
          session.current = supportAsOwner([]);
          for (const [route, call] of three(kpmId, 'looked@k.test', '304')) {
            const res = await call();
            // The template is read as bytes, so its refusal is too.
            const body = Buffer.isBuffer(res.body) ? JSON.parse(res.body.toString('utf8')) : res.body;
            expect([route, res.status, body.error.code]).toEqual([route, 403, 'PERM_DENIED']);
          }
          expect(await mongoose.model(User.name).countDocuments({})).toBe(0);
        });

        it('S5 lets a setup session use all three for its own office, and answers another office not found', async () => {
          session.current = supportAsOwner(SETUP_SESSION_WRITE_SCOPE);
          expect(await statuses(three(kpmId, 'set-up@k.test', '305')))
            .toEqual([['preview', 200], ['import', 201], ['template', 200]]);
          expect(await mongoose.model(User.name).countDocuments({ email: 'set-up@k.test' })).toBe(1);

          const other = await anotherOffice();
          expect(await statuses(three(other, 'set-up-elsewhere@k.test', '306')))
            .toEqual([['preview', 404], ['import', 404], ['template', 404]]);
          expect(await mongoose.model(User.name).countDocuments({ email: 'set-up-elsewhere@k.test' })).toBe(0);
        });
      });

      it('answers an Owner naming another office not found, and a leader no', async () => {
        session.current = OWNER; // of FIXTURE_KPM, not of this office
        await send('file/preview', Buffer.from(file('Rina,rina@k.test,101,ab,')), 'roster.csv').expect(404);
        await request(app.getHttpServer()).get(`/admin/tenants/roster-template?format=xlsx&kpmId=${kpmId}`).expect(404);
        session.current = AB;
        await send('file/preview', Buffer.from(file('Rina,rina@k.test,101,ab,')), 'roster.csv').expect(403);
        await request(app.getHttpServer()).get('/admin/tenants/roster-template?format=xlsx').expect(403);
        expect(await mongoose.model(User.name).countDocuments({})).toBe(0);
      });
    });
  });
});
