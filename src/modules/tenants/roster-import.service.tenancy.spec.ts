import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { Workbook } from 'exceljs';
import { zipSync } from 'fflate';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { ViewOnlySessionGuard } from '@/common/auth/view-only-session.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { SOURCE_READER } from '@/common/i18n/reader';
import { ROSTER_INVITATION, ROSTER_UPLOAD, XLSX_MIME_TYPE } from '@/domain/constants';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthToken, AuthTokenSchema } from '@/modules/auth/auth-token.schema';
import { PasswordService } from '@/modules/auth/password.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { InvitesService } from '@/modules/org/invites.service';
import { MemberInvite, MemberInviteSchema } from '@/modules/org/member-invite.schema';
import { MemberNames } from '@/modules/org/member-names.service';
import { MemberInviteRepository, MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { User, UserSchema } from '@/modules/users/user.schema';
import { AB, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { IN_INDONESIAN } from '../../../test/i18n';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { AdminController } from './admin.controller';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from './company-org-level.schema';
import { Company, CompanySchema } from './company.schema';
import { Kpm, KpmSchema } from './kpm.schema';
import { OrgLevelService } from './org-level.service';
import { ROSTER_TEMPLATE_HEADER } from './roster-csv';
import { RosterImportService, type RosterPreview } from './roster-import.service';

const H = ROSTER_TEMPLATE_HEADER;
const NOW = new Date('2026-09-09T02:00:00.000Z');

/** One row in the template's order: A3's nine, then *Jenis kelamin* and *Bulan bergabung di perusahaan*. */
const line = (
  code: string, name: string, role: string, up = '', wa = '', email = '', join = '', waktu = '', dob = '', gender = '', month = '',
) => [code, name, role, up, wa, email, join, waktu, dob, gender, month].map((c) => (/[,"]/.test(c) ? `"${c}"` : c)).join(',');
const a3 = (...rows: string[]) => [H, ...rows].join('\n');
/** A new person who would import: a code, a name, a rung, an upline and an address. */
const person = (code: string, name: string, role: string, up = '', email = `${code}@k.test`, wa = '0812 1100 2200') =>
  line(code, name, role, up, wa, email);

/** What each row came to, by code: `[outcome, first message]`. */
const results = (preview: Pick<RosterPreview, 'rows'>) =>
  Object.fromEntries(preview.rows.map((r) => [r.agentCode, [r.outcome, r.messages[0] ?? null]]));

describe('RosterImportService (P3.2-T4; A3 since P19.3-T4, ADR-0205)', () => {
  let service: RosterImportService;
  let hierarchy: HierarchyService;
  let members: MembershipRepository;
  let historyRepo: MembershipHistoryRepository;
  let orgLevels: OrgLevelService;
  let kpmId: string;
  let companyId: string;
  const clock = new FixedClock(NOW);
  const sent: { userId: string; templateId: string; payload: Record<string, unknown> }[] = [];
  const notifications = { send: async (r: (typeof sent)[number]) => { sent.push(r); } };

  /**
   * **The office's Owner, who imports** (P19.4-T2; ADR-0206 §2), reading the API's English as asserted below. The
   * Super Admin ran these until their grant went; they are refused now (*P19.4-T2 AC-4*, below).
   */
  const theOwner = () => memberOf(kpmId, { isKpmOwner: true });
  /** The Super Admin, as themselves: refused the import since P19.4-T2. */
  const superAdmin = () => RequestContext.platform('root').withReader(SOURCE_READER);
  const scoped = () => RequestContext.tenantRead(kpmId, 'test');
  const liveUsers = (filter: Record<string, unknown> = {}) => mongoose.model(User.name).countDocuments({ ...filter, deletedAt: null });
  const build = (h: HierarchyService = hierarchy) => new RosterImportService(
    members, h, mongoose.model(Kpm.name) as never, mongoose.model(User.name) as never, new PasswordService(),
    new AuditService(mongoose.model(AuditLog.name) as never), clock, orgLevels, historyRepo, notifications as never,
    mongoose.model(AuthToken.name) as never,
  );

  beforeAll(async () => {
    await startMongo();
    const users = mongoose.model(User.name, UserSchema);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    mongoose.model(Membership.name, MembershipSchema);
    mongoose.model(MembershipHistory.name, MembershipHistorySchema);
    mongoose.model(Company.name, CompanySchema);
    mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema);
    mongoose.model(AuditLog.name, AuditLogSchema);
    if (!mongoose.models[AuthToken.name]) mongoose.model(AuthToken.name, AuthTokenSchema);
    if (!mongoose.models[MemberInvite.name]) mongoose.model(MemberInvite.name, MemberInviteSchema);

    members = new MembershipRepository(mongoose.model(Membership.name) as never);
    historyRepo = new MembershipHistoryRepository(mongoose.model(MembershipHistory.name) as never);
    orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name) as never, mongoose.model(Company.name) as never, mongoose.model(Kpm.name) as never,
      new AuditService(mongoose.model(AuditLog.name) as never), clock,
    );
    hierarchy = new HierarchyService(members, kpms as never, users as never, historyRepo, clock, orgLevels);
    service = build();
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    sent.length = 0;
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `prudential-${Math.random()}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    const kpm = await mongoose.model(Kpm.name).create({
      companyId, code: '0581', branchName: 'Bandung Dago', status: 'active', counters: { nextMemberSeq: 1 },
    });
    kpmId = String(kpm._id);
    clock.set(NOW);
  });

  const memberOf = (id: string, over: Record<string, unknown> = {}) =>
    new RequestContext('u-member', 'none', {
      membershipId: 'mem-1', kpmId: id, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
      isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
    }).withReader(SOURCE_READER);
  const otherOffice = async (code = '0417') => String((await mongoose.model(Kpm.name).create({
    companyId, code, branchName: 'BSD City Branch', status: 'active', counters: { nextMemberSeq: 1 },
  }))._id);
  const byCode = async (code: string) => (await members.find(scoped(), { agentCode: code }))[0] ?? null;

  describe('P19.3-T4 AC-13 who may run it', () => {
    it('P19.3-T4 AC-13 lets an Owner and an Admin fill their own office', async () => {
      const owner = memberOf(kpmId, { isKpmOwner: true });
      expect((await service.preview(owner, kpmId, a3(person('101', 'Rina', 'AB')))).counts).toEqual({ imported: 1, updated: 0, invited: 0, skipped: 0 });
      const admin = memberOf(kpmId, { isKpmAdmin: true });
      await expect(service.commit(admin, kpmId, a3(person('102', 'Budi', 'AB')))).resolves.toMatchObject({ counts: { imported: 1 } });
    });

    it('P19.3-T4 AC-13 refuses AB, AAB and Agent, who administer nothing', async () => {
      for (const rung of [{}, { orgLevelCode: 'AAB', hierarchyRole: 'aab' }, { orgLevelCode: 'AGENT', hierarchyRole: 'agent' }]) {
        await expect(service.preview(memberOf(kpmId, rung), kpmId, a3(person('101', 'Rina', 'AB')))).rejects.toMatchObject({ code: 'PERM_DENIED' });
        await expect(service.commit(memberOf(kpmId, rung), kpmId, a3(person('101', 'Rina', 'AB')))).rejects.toMatchObject({ code: 'PERM_DENIED' });
      }
      expect(await liveUsers()).toBe(0);
    });

    it('P19.3-T4 AC-13 answers an Owner naming another office not found, and writes nothing there', async () => {
      const other = await otherOffice('0555');
      const owner = memberOf(kpmId, { isKpmOwner: true });
      await expect(service.preview(owner, other, a3(person('101', 'Rina', 'AB')))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(service.commit(owner, other, a3(person('101', 'Rina', 'AB')))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await liveUsers()).toBe(0);
    });

    it('writes as the Owner, not as a platform operator', async () => {
      await service.commit(memberOf(kpmId, { isKpmOwner: true }), kpmId, a3(person('101', 'Rina', 'AB')));
      const row = await mongoose.model(AuditLog.name).findOne({ action: 'roster.imported' });
      expect(row?.get('actorUserId')).toBe('u-member');
      expect(row?.get('actorMembershipId')).toBe('mem-1');
    });

    it('404s an office that is not there, and a malformed id alike', async () => {
      await expect(service.preview(theOwner(), 'not-an-objectid', a3())).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(service.preview(theOwner(), String(new mongoose.Types.ObjectId()), a3())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('P19.4-T2 AC-4 refuses the Super Admin, 403 PERM_DENIED, in any office, and writes nothing', async () => {
      const other = await otherOffice('0555');
      for (const office of [kpmId, other]) {
        await expect(service.preview(superAdmin(), office, a3(person('101', 'Rina', 'AB')))).rejects.toMatchObject({ code: 'PERM_DENIED' });
        await expect(service.commit(superAdmin(), office, a3(person('101', 'Rina', 'AB')))).rejects.toMatchObject({ code: 'PERM_DENIED' });
        await expect(service.workbook(superAdmin(), office)).rejects.toMatchObject({ code: 'PERM_DENIED' });
      }
      await expect(service.workbook(superAdmin(), null)).rejects.toMatchObject({ code: 'PERM_DENIED' });
      expect(await liveUsers()).toBe(0);
      expect(await mongoose.model(AuditLog.name).countDocuments({})).toBe(0);
    });
  });

  describe('P19.3-T4 AC-8 each check, its result and A3’s message', () => {
    it('P19.3-T4 AC-8 a code twice in the file: the later row is skipped', async () => {
      const preview = await service.preview(theOwner(), kpmId, a3(person('101', 'Rina', 'AB'), person('101', 'Rina Lagi', 'AB', '', 'lagi@k.test')));
      expect(preview.rows.map((r) => [r.line, r.outcome, r.messages])).toEqual([
        [2, 'imported', []],
        [3, 'skipped', ['Kode agen: This code appears twice in the file.']],
      ]);
    });

    it('P19.3-T4 AC-8 a role not on the ladder lists the ladder’s own rungs; Agen is read as Agent', async () => {
      const preview = await service.preview(theOwner(), kpmId, a3(
        person('101', 'Rahmat', 'AB'), person('102', 'Desi', 'Agen Senior', '101'), person('103', 'Bayu', 'Agen', '101'),
      ));
      expect(results(preview)).toMatchObject({
        102: ['skipped', 'Role "Agen Senior" does not exist. Use: Agent, AAB, AB.'],
        103: ['imported', null],
      });
      const id = await service.preview(theOwner().withReader({ language: 'id', figures: 'id' } as never), kpmId,
        a3(person('101', 'Rahmat', 'AB'), person('102', 'Desi', 'Agen Senior', '101')));
      expect(results(id)['102']).toEqual(['skipped', 'Peran "Agen Senior" tidak ada. Pakai: Agent, AAB, AB.']);
    });

    it('P19.3-T4 AC-8 an upline in neither the file nor the office', async () => {
      const preview = await service.preview(theOwner(), kpmId, a3(person('101', 'Fikri', 'Agent', '70049999')));
      expect(results(preview)['101']).toEqual(['skipped', 'Upline code 70049999 is in neither the file nor this KPM.']);
    });

    it('P19.3-T4 AC-8 an upline who is not a leader, and one who ranks lower', async () => {
      const preview = await service.preview(theOwner(), kpmId, a3(
        person('101', 'Rahmat', 'AB'), person('102', 'Sari', 'AAB', '101'), person('103', 'Bayu', 'Agent', '102'),
        person('104', 'Yusuf', 'AB', '103'), person('105', 'Citra', 'AB', '102'), person('106', 'Dewi', 'AB', '101'),
      ));
      expect(results(preview)).toEqual({
        101: ['imported', null], 102: ['imported', null], 103: ['imported', null],
        104: ['skipped', 'The upline must be a leader (AAB or AB), not Agent.'],
        105: ['skipped', 'The upline (AAB) ranks below AB.'],
        // An AB can be the upline of an AB (A-R5).
        106: ['imported', null],
      });
    });

    it('P19.3-T4 AC-8 an Agent and an AAB need an upline; the top rung may have none', async () => {
      const preview = await service.preview(theOwner(), kpmId, a3(
        person('101', 'Rahmat', 'AB'), person('102', 'Sari', 'AAB'), person('103', 'Bayu', 'Agent'),
      ));
      expect(results(preview)).toEqual({
        101: ['imported', null],
        102: ['skipped', 'Agent and AAB need an upline code.'],
        103: ['skipped', 'Agent and AAB need an upline code.'],
      });
    });

    it('P19.3-T4 AC-8 uplines are checked across the whole file: row order does not matter, and the office counts', async () => {
      await service.commit(theOwner(), kpmId, a3(person('100', 'Wilson', 'AB')));
      const preview = await service.preview(theOwner(), kpmId, a3(
        person('103', 'Bayu', 'Agent', '102'), person('102', 'Sari', 'AAB', '101'), person('101', 'Rahmat', 'AB', '100'),
      ));
      expect(preview.counts).toEqual({ imported: 3, updated: 0, invited: 0, skipped: 0 });
    });

    it('P19.3-T4 AC-8 a loop (A → B → A) is skipped, and so is a row whose upline’s row is skipped, naming it', async () => {
      const preview = await service.preview(theOwner(), kpmId, a3(
        person('101', 'Ana', 'AB', '102'), person('102', 'Budi', 'AB', '101'), person('103', 'Citra', 'Agent', '101'),
        person('104', 'Dodi', 'AB', '104'),
      ));
      expect(results(preview)).toEqual({
        101: ['skipped', 'The uplines go round in a loop: 101 → 102 → 101.'],
        102: ['skipped', 'The uplines go round in a loop: 102 → 101 → 102.'],
        103: ['skipped', 'The upline\'s row (101) is skipped, so this one is too.'],
        104: ['skipped', 'The uplines go round in a loop: 104 → 104.'],
      });
    });

    it('P19.3-T4 AC-8 a row without a WhatsApp number is imported, saying so', async () => {
      const preview = await service.preview(theOwner(), kpmId, a3(person('101', 'Rahmat', 'AB'), person('109', 'Nadia', 'Agent', '101', 'nadia@k.test', '')));
      expect(results(preview)['109']).toEqual(['imported', null]);
      // P19.12-T7 AC-3: among what the row leaves out (ADR-0250 §3).
      expect(preview.rows[1].warnings[0]).toBe('No WhatsApp number: imported, but cannot be reminded on WhatsApp yet.');
      const committed = await service.commit(theOwner(), kpmId, a3(person('101', 'Rahmat', 'AB'), person('109', 'Nadia', 'Agent', '101', 'nadia@k.test', '')));
      expect(committed.counts.imported).toBe(2);
      expect(await mongoose.model(User.name).findOne({ email: 'nadia@k.test' }).lean()).toMatchObject({ phone: null });
    });

    // Built with no invitation service, as before ADR-0250 §4: a row with no email is skipped whatever its rung.
    it('P19.3-T4 AC-8 a new person’s row needs an email (ADR-0205 §7); an address with an account is skipped too', async () => {
      await mongoose.model(User.name).create({ email: 'taken@k.test', passwordHash: 'x', fullName: 'Taken', companyId, agentCode: '999' });
      const preview = await service.preview(theOwner(), kpmId, a3(
        person('101', 'Rahmat', 'AB'), line('102', 'Sari', 'AAB', '101', '0812 1100 2200', ''), person('103', 'Bayu', 'Agent', '101', 'taken@k.test'),
      ));
      expect(results(preview)).toMatchObject({
        102: ['skipped', 'No email: they cannot be invited, so the row is skipped.'],
        103: ['skipped', 'Already has an account. Import creates people; this one exists already.'],
      });
    });

    it('P19.3-T4 AC-8 the code-format check is ADR-0158 §4’s until a template holds an agentCodePattern', async () => {
      const preview = await service.preview(theOwner(), kpmId, a3(person('PRU-1', 'Rahmat', 'AB'), person('7004510', 'Tono', 'AB')));
      expect(results(preview)).toEqual({
        'PRU-1': ['skipped', 'Kode agen: "PRU-1" is not an agent code. Use digits only, 3 to 32 of them.'],
        7004510: ['imported', null],
      });
    });

    it('P19.5-T1 AC-11 checks codes with the format the KPM’s template publishes, read for this KPM; none published, ADR-0158 §4’s', async () => {
      const asked: string[] = [];
      const reading = (agentCodePattern: string) => new RosterImportService(
        members, hierarchy, mongoose.model(Kpm.name) as never, mongoose.model(User.name) as never, new PasswordService(),
        new AuditService(mongoose.model(AuditLog.name) as never), clock, orgLevels, historyRepo, notifications as never,
        mongoose.model(AuthToken.name) as never,
        {
          forOffice: async (id: string) => {
            asked.push(id);
            return { config: { uploadRules: { agentCodePattern, agentCodeExample: '70012345' } } };
          },
        } as never,
      );
      const file = a3(person('7004510', 'Tono', 'AB'), person('70045001', 'Rahmat', 'AB'), person('PRU-1', 'Budi', 'AB'));

      const eight = await reading('^[0-9]{8}$').preview(theOwner(), kpmId, file);
      expect(results(eight)).toEqual({
        7004510: ['skipped', 'Kode agen: "7004510" does not match this company\'s agent code format, for example 70012345.'],
        70045001: ['imported', null],
        'PRU-1': ['skipped', 'Kode agen: "PRU-1" does not match this company\'s agent code format, for example 70012345.'],
      });
      expect(asked).toEqual([kpmId]);

      // A template that publishes no format (the platform's empty pattern compiles to nothing): the global rule stands.
      const none = await reading('').preview(theOwner(), kpmId, file);
      expect(results(none)).toMatchObject({
        7004510: ['imported', null],
        'PRU-1': ['skipped', 'Kode agen: "PRU-1" is not an agent code. Use digits only, 3 to 32 of them.'],
      });
    });

    it('P19.12-T7 AC-2 a bad value in one of the optional fields is left empty, naming the cell; the row imports', async () => {
      const preview = await service.preview(theOwner(), kpmId, a3(
        line('101', 'Rahmat', 'AB', '', '', 'r@k.test', '', '', '10/10/2015'),
        line('102', 'Sari', 'AB', '', '', 's@k.test'),
      ));
      expect(results(preview)).toEqual({ 101: ['imported', null], 102: ['imported', null] });
      expect(preview.rows[0].warnings[0])
        .toBe('Tanggal lahir: A date of birth must be at least 18 years ago. Left empty; the rest of the row is imported.');
      expect(preview.rows[1].warnings[0]).toBe('No WhatsApp number: imported, but cannot be reminded on WhatsApp yet.');
    });
  });

  describe('P19.3-T4 AC-8 a code already in this office is updated', () => {
    /** The office as it stands: Wilson at the top, Agus an AB under him, Indah an Agent under Agus. */
    const office = () => a3(
      line('100', 'Wilson', 'AB', '', '0812 0000 0100', 'wilson@k.test', '01/01/2020', 'Full-time', '01/01/1980', 'male', '2010-01'),
      line('200', 'Agus', 'AB', '100', '', 'agus@k.test', '01/02/2021'),
      line('300', 'Indah', 'Agent', '200', '0812 0000 0300', 'indah@k.test', '', 'Part-time'),
    );

    it('P19.3-T4 AC-8 says “Sudah ada; data diperbarui.”, and blank cells keep what is stored', async () => {
      await service.commit(theOwner(), kpmId, office());
      const preview = await service.preview(theOwner(), kpmId, a3(line('300', 'Indah', 'Agent')));
      expect(results(preview)['300']).toEqual(['updated', 'Already here; details updated.']);
      await service.commit(theOwner(), kpmId, a3(line('300', 'Indah', 'Agent')));
      const indah = await byCode('300');
      expect(indah).toMatchObject({ leaderId: String((await byCode('200'))!._id), workStatus: 'part_time', orgLevelCode: 'AGENT' });
      expect(await mongoose.model(User.name).findOne({ agentCode: '300' }).lean()).toMatchObject({ phone: '+6281200000300', email: 'indah@k.test' });
    });

    it('P19.3-T4 AC-8 an update never changes an email: a different one is not applied, and the row says so', async () => {
      await service.commit(theOwner(), kpmId, office());
      const preview = await service.preview(theOwner(), kpmId, a3(line('300', 'Indah', 'Agent', '', '', 'new-indah@k.test')));
      expect(preview.rows[0].messages).toEqual([
        'Already here; details updated.',
        'The email is not changed by an import: the person changes it themselves, through a link sent to the new address.',
      ]);
      await service.commit(theOwner(), kpmId, a3(line('300', 'Indah', 'Agent', '', '', 'new-indah@k.test')));
      expect(await liveUsers({ email: 'new-indah@k.test' })).toBe(0);
      expect(await liveUsers({ email: 'indah@k.test' })).toBe(1);
      const audit = await mongoose.model(AuditLog.name).findOne({ action: 'roster.member_updated' }).lean<{ after: Record<string, unknown> }>();
      expect(audit?.after).toMatchObject({ emailNotApplied: true });
    });

    it('P19.3-T4 AC-8 changes the role through a role change, logged, and the upline by closing one edge and opening another', async () => {
      await service.commit(theOwner(), kpmId, office());
      sent.length = 0;
      await service.commit(theOwner(), kpmId, a3(line('300', 'Indah', 'AAB', '100')));
      const indah = (await byCode('300'))!;
      expect(indah).toMatchObject({ orgLevelCode: 'AAB', role: 'aab', leaderId: String((await byCode('100'))!._id) });
      const edges = await historyRepo.find(scoped(), { membershipId: String(indah._id) }, { sort: { createdAt: 1 } });
      expect(edges.map((e) => [e.eventType, e.validTo === null])).toEqual([['joined', false], ['role_changed', false], ['re_parented', true]]);
      expect(edges[1]).toMatchObject({ fromRole: 'agent', toRole: 'aab', reason: 'Member import' });
      // The member is told, as a role change tells them — once everything has landed.
      expect(sent.map((s) => s.templateId)).toEqual([NotificationTemplate.ROLE_CHANGED]);
    });

    it('P19.3-T4 AC-8 writes the join date as ADR-0169 §2’s correction, reclassifying nobody, and fills a missing number only', async () => {
      await service.commit(theOwner(), kpmId, office());
      await service.commit(theOwner(), kpmId, a3(
        line('200', 'Agus', 'AB', '', '0812 0000 0200', '', '15/03/2021', 'Full-time', '05/05/1985', 'male', '2015-05'),
        line('300', 'Indah', 'Agent', '', '0812 9999 9999'),
      ));
      expect(await byCode('200')).toMatchObject({ joinDate: '2021-03-15', joinedAs: 'existing_agent', workStatus: 'full_time' });
      expect(await mongoose.model(User.name).findOne({ agentCode: '200' }).lean()).toMatchObject({
        phone: '+6281200000200', dateOfBirth: '1985-05-05', gender: 'male', companyJoinMonth: '2015-05',
      });
      // A number on file stays (D-22): the person changes it on their profile.
      expect(await mongoose.model(User.name).findOne({ agentCode: '300' }).lean()).toMatchObject({ phone: '+6281200000300' });
    });

    it('P19.3-T4 AC-8 a leader moved onto a rung that leads nobody, while people report to them, is skipped', async () => {
      await service.commit(theOwner(), kpmId, office());
      const preview = await service.preview(theOwner(), kpmId, a3(line('200', 'Agus', 'Agent')));
      expect(results(preview)['200']).toEqual(['skipped', '1 person reports to them. Move them to another leader first.']);
    });

    it('P19.3-T4 AC-8 the Owner’s rung is not changed by an import', async () => {
      await service.commit(theOwner(), kpmId, office());
      const wilson = (await mongoose.model(User.name).findOne({ agentCode: '100' }))!;
      await mongoose.model(Kpm.name).updateOne({ _id: kpmId }, { $set: { ownerUserId: String(wilson._id) } });
      const preview = await service.preview(theOwner(), kpmId, a3(line('100', 'Wilson', 'AAB')));
      expect(results(preview)['100']).toEqual(['skipped', 'They own this KPM, so an import does not change their role.']);
    });
  });

  describe('P19.3-T4 AC-9 a code held in another KPM of the company (A-R3, OD-257)', () => {
    const holderIn = async (officeId: string, status = 'active', code = '70013011') => {
      const user = await mongoose.model(User.name).create({
        email: 'rina@kpm0417.test', passwordHash: 'x', fullName: 'Rina Wijaya', companyId, agentCode: code,
      });
      await mongoose.connection.db!.collection('memberships').insertOne({
        kpmId: officeId, userId: String(user._id), agentCode: code, orgLevelCode: 'AGENT', role: 'agent',
        leaderId: null, ancestorIds: [], status, deletedAt: null,
      } as never);
    };
    const file = () => a3(person('101', 'Rahmat', 'AB'), person('70013011', 'Rina Wijaya', 'Agent', '101'));

    it('P19.3-T4 AC-9 is skipped with today’s sentence, which names no KPM and nobody, to an Owner', async () => {
      await holderIn(await otherOffice());
      const preview = await service.preview(memberOf(kpmId, { isKpmOwner: true }), kpmId, file());
      expect(results(preview)['70013011']).toEqual(['skipped', 'This agent code is already registered at this insurer.']);
      const said = JSON.stringify(preview);
      for (const leak of ['rina@kpm0417.test', '0417', 'BSD City Branch']) expect(said).not.toContain(leak);
      expect(preview.counts).toEqual({ imported: 1, updated: 0, invited: 0, skipped: 1 });
    });

    it('P19.3-T4 AC-9 in Indonesian, the sentence that stands until OD-257 is answered', async () => {
      await holderIn(await otherOffice());
      const preview = await service.preview(memberOf(kpmId, { isKpmOwner: true }).withReader({ language: 'id', figures: 'id' } as never), kpmId, file());
      expect(results(preview)['70013011'][1]).toBe('Kode agen ini sudah terdaftar di perusahaan asuransi ini.');
    });

    it('B1 a holder who left this office is somebody elsewhere too: not named to the Owner or an Admin', async () => {
      await holderIn(kpmId, 'removed');
      expect(results(await service.preview(memberOf(kpmId, { isKpmOwner: true }), kpmId, file()))['70013011'][1])
        .toBe('This agent code is already registered at this insurer.');
      expect(results(await service.preview(memberOf(kpmId, { isKpmAdmin: true }), kpmId, file()))['70013011'][1])
        .toBe('This agent code is already registered at this insurer.');
    });

    it('B1 a holder still pending in this same office is named to its Owner, whom they asked to join', async () => {
      await holderIn(kpmId, 'pending');
      expect(results(await service.preview(memberOf(kpmId, { isKpmOwner: true }), kpmId, file()))['70013011'][1])
        .toBe('Already registered at this insurer by rina@kpm0417.test.');
    });
  });

  describe('P19.3-T4 AC-10 the preview', () => {
    it('P19.3-T4 AC-10 counts new, updated and skipped, gives a result per row, and writes nothing', async () => {
      await service.commit(theOwner(), kpmId, a3(person('100', 'Wilson', 'AB')));
      const preview = await service.preview(theOwner(), kpmId, a3(
        person('101', 'Rahmat', 'AB', '100'), line('100', 'Wilson', 'AB'), person('102', 'Desi', 'Agen Senior', '101'),
      ));
      expect(preview.counts).toEqual({ imported: 1, updated: 1, invited: 0, skipped: 1 });
      expect(preview.rows.map((r) => [r.line, r.agentCode, r.outcome])).toEqual([[2, '101', 'imported'], [3, '100', 'updated'], [4, '102', 'skipped']]);
      expect(await liveUsers()).toBe(1);
    });

    it('P19.3-T4 AC-10 the skipped rows download as the same columns with an Alasan column, in the file’s order', async () => {
      const preview = await service.preview(theOwner(), kpmId, a3(
        person('101', 'Rahmat', 'AB'), person('105', 'Fikri', 'Agent', '70049999'), person('106', 'Desi', 'Agen Senior', '101'),
      ));
      expect(preview.skippedCsv).toBe([
        `${H},Alasan`,
        `${person('105', 'Fikri', 'Agent', '70049999')},Upline code 70049999 is in neither the file nor this KPM.`,
        `${person('106', 'Desi', 'Agen Senior', '101')},"Role ""Agen Senior"" does not exist. Use: Agent, AAB, AB."`,
        '',
      ].join('\n'));
      expect((await service.preview(theOwner(), kpmId, a3(person('101', 'Rahmat', 'AB')))).skippedCsv).toBeNull();
    });

    it('a file that cannot be read is said whole, with no rows', async () => {
      const preview = await service.preview(theOwner(), kpmId, 'Nama,Email\nBudi,b@k.test');
      expect(preview.issues).toEqual([{ line: 1, column: 'file', message: 'The file has no Kode agen, Peran column. Download the template and use its header.' }]);
      expect(preview.rows).toEqual([]);
    });
  });

  describe('P19.3-T4 AC-11 the import', () => {
    it('P19.3-T4 AC-11 writes the valid rows leader first, whatever the file order, and none of the skipped', async () => {
      const result = await service.commit(theOwner(), kpmId, a3(
        person('103', 'Bayu', 'Agent', '102'), person('102', 'Sari', 'AAB', '101'), person('101', 'Rahmat', 'AB'),
        person('105', 'Fikri', 'Agent', '70049999'),
      ));
      expect(result.counts).toEqual({ imported: 3, updated: 0, invited: 0, skipped: 1 });
      const [rahmat, sari, bayu] = await Promise.all(['101', '102', '103'].map(byCode));
      expect(sari!.leaderId).toBe(String(rahmat!._id));
      expect(bayu!.ancestorIds).toEqual([String(rahmat!._id), String(sari!._id)]);
      expect(await byCode('105')).toBeNull();
      // New people are existing agents, joined on the import's day when the file gives none (ADR-0169 §6).
      expect(bayu).toMatchObject({ joinedAs: 'existing_agent', joinDate: '2026-09-09', status: 'active' });
    });

    it('P19.3-T4 AC-11 no password is returned, stored for anybody to read, or owed: the person chooses their own', async () => {
      const result = await service.commit(theOwner(), kpmId, a3(person('101', 'Rahmat', 'AB')));
      expect(JSON.stringify(result)).not.toMatch(/password/i);
      const rahmat = await mongoose.model(User.name).findOne({ agentCode: '101' }).select('+passwordHash').lean<User>();
      expect(rahmat).toMatchObject({ mustChangePassword: false, emailVerifiedAt: null, status: 'active' });
      expect(rahmat!.passwordHash).toMatch(/^\$argon2/);
    });

    it('P19.3-T4 AC-11 invites each new person by email, a one-time link to choose their password; updates are not mailed', async () => {
      await service.commit(theOwner(), kpmId, a3(person('100', 'Wilson', 'AB')));
      sent.length = 0;
      await mongoose.model(AuthToken.name).deleteMany({});
      const result = await service.commit(theOwner(), kpmId, a3(person('101', 'Rahmat', 'AB', '100'), line('100', 'Wilson', 'AB')));
      expect(result.invited).toBe(1);
      const rahmat = (await mongoose.model(User.name).findOne({ agentCode: '101' }))!;
      expect(sent).toEqual([{
        userId: String(rahmat._id), kpmId, templateId: NotificationTemplate.MEMBER_INVITATION,
        payload: { token: expect.any(String), fullName: 'Rahmat', office: 'Bandung Dago', days: ROSTER_INVITATION.TTL_DAYS },
      }]);
      const token = await mongoose.model(AuthToken.name).findOne({ userId: String(rahmat._id) }).lean<{ kind: string; expiresAt: Date; tokenHash: string }>();
      expect(token).toMatchObject({ kind: 'password_reset' });
      expect(token!.expiresAt.getTime() - NOW.getTime()).toBe(7 * 24 * 60 * 60_000);
      // The raw token is mailed and stored nowhere: only its hash.
      expect(token!.tokenHash).not.toBe(sent[0].payload.token);
      expect(new PasswordService().hashToken(sent[0].payload.token as string)).toBe(token!.tokenHash);
      // P19.4-T3 AC-9 (ADR-0212 §2): *Diundang* — the invited person's membership records when it went.
      expect((await mongoose.model(Membership.name).findOne({ kpmId, userId: String(rahmat._id) })
        .lean<{ invitedAt: Date | null }>())!.invitedAt).toEqual(NOW);
    });

    it('P19.3-T4 AC-11 with the box unticked, nobody is mailed', async () => {
      const result = await service.commit(theOwner(), kpmId, a3(person('101', 'Rahmat', 'AB')), false);
      expect(result.invited).toBe(0);
      expect(sent).toEqual([]);
      // Never invited: *Belum diundang* (ADR-0212 §2).
      const rahmat = (await mongoose.model(User.name).findOne({ agentCode: '101' }))!;
      expect((await mongoose.model(Membership.name).findOne({ kpmId, userId: String(rahmat._id) })
        .lean<{ invitedAt: Date | null }>())!.invitedAt).toBeNull();
      expect(await mongoose.model(AuthToken.name).countDocuments({})).toBe(0);
    });

    it('P19.3-T4 AC-11 refuses a file with no row to import, and a file it cannot read', async () => {
      await expect(service.commit(theOwner(), kpmId, a3(person('105', 'Fikri', 'Agent', '70049999')))).rejects.toMatchObject({
        code: 'VALIDATION_FAILED', message: 'No row of this file can be imported. Download the skipped rows, fix them and upload them again.',
      });
      await expect(service.commit(theOwner(), kpmId, 'Nama\nBudi')).rejects.toMatchObject({
        code: 'VALIDATION_FAILED', details: { issues: [expect.objectContaining({ column: 'file' })] },
      });
      await expect(service.commit(theOwner(), kpmId, a3())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('P19.3-T4 AC-11 a write failing mid-way undoes every write of the commit: nobody is left behind', async () => {
      // The office before: Wilson at the top, Indah an Agent under him. The file updates Indah and adds three people.
      await service.commit(theOwner(), kpmId, a3(person('100', 'Wilson', 'AB'), line('300', 'Indah', 'Agent', '100', '', 'indah@k.test')));
      const indahBefore = (await byCode('300'))!;
      const usersBefore = await liveUsers();
      sent.length = 0;
      let calls = 0;
      const failing = Object.create(hierarchy) as HierarchyService;
      failing.createWithAccount = async (...args: Parameters<HierarchyService['createWithAccount']>) => {
        calls += 1;
        if (calls === 3) {
          // The account is made, then the write fails: the worst moment.
          await args[2]();
          throw new Error('the database went away');
        }
        return hierarchy.createWithAccount(...args);
      };
      const file = a3(
        person('101', 'Rahmat', 'AB', '100'), person('102', 'Sari', 'AAB', '101'), person('103', 'Bayu', 'Agent', '102'),
        line('300', 'Indah', 'AAB', '101', '0812 3000 3000', '', '01/01/2022', 'Full-time'),
      );
      await expect(build(failing).commit(theOwner(), kpmId, file)).rejects.toThrow('the database went away');

      expect(await liveUsers()).toBe(usersBefore);
      for (const code of ['101', '102', '103']) expect(await byCode(code)).toBeNull();
      const indah = (await byCode('300'))!;
      expect(indah).toMatchObject({
        orgLevelCode: 'AGENT', role: 'agent', leaderId: indahBefore.leaderId, joinDate: indahBefore.joinDate, workStatus: null,
      });
      expect(await mongoose.model(User.name).findOne({ agentCode: '300' }).lean()).toMatchObject({ phone: null });
      // Indah keeps the one open edge she had; the edges the commit opened are gone.
      const open = await historyRepo.find(scoped(), { membershipId: String(indah._id), validTo: null });
      expect(open.map((e) => e.eventType)).toEqual(['joined']);
      expect(await historyRepo.count(scoped(), { eventType: { $in: ['role_changed', 're_parented'] } })).toBe(0);
      // Nobody was told anything, and the undo is on the record.
      expect(sent).toEqual([]);
      expect(await mongoose.model(AuditLog.name).countDocuments({ action: 'roster.import_undone' })).toBe(1);
      expect(await mongoose.model(AuditLog.name).countDocuments({ action: 'roster.imported' })).toBe(1);

      // The same file, imported again afterwards: the undone accounts' addresses and codes are free.
      const again = await service.commit(theOwner(), kpmId, file);
      expect(again.counts).toEqual({ imported: 3, updated: 1, invited: 0, skipped: 0 });
      expect(await byCode('300')).toMatchObject({ orgLevelCode: 'AAB', leaderId: String((await byCode('101'))!._id) });
    });

    it('P19.3-T4 AC-11 audits the counts and the codes, and never a personal datum', async () => {
      await service.commit(theOwner(), kpmId, a3(person('101', 'Rahmat', 'AB'), person('105', 'Fikri', 'Agent', '70049999')));
      const row = await mongoose.model(AuditLog.name).findOne({ action: 'roster.imported' }).lean<{ after: unknown }>();
      expect(row?.after).toEqual({ count: 1, agentCodes: ['101'], updated: [], invitedOnWhatsApp: [], skipped: 1 });
      expect(JSON.stringify(row)).not.toContain('0812');
    });
  });

  describe('P19.3-T4 AC-11 the leader limit, as today (P13.2-T4)', () => {
    it('P19.3-T4 AC-11 skips each row past the limit with its words, and imports the rest', async () => {
      await mongoose.model(Kpm.name).updateOne({ _id: kpmId }, {
        $set: { subscription: { startDate: null, endDate: null, pricePerLeaderMinor: null, currency: 'IDR', maxLeaders: 1, keepActiveAfterEnd: false } },
      });
      const owner = memberOf(kpmId, { isKpmOwner: true });
      const preview = await service.preview(owner, kpmId, a3(person('101', 'Rahmat', 'AB'), person('102', 'Sari', 'AAB', '101'), person('103', 'Bayu', 'Agent', '101')));
      expect(results(preview)['102'][0]).toBe('skipped');
      expect(results(preview)['102'][1]).toMatch(/Import them as an Agent, then promote them on their page/);
      expect(preview.counts).toEqual({ imported: 2, updated: 0, invited: 0, skipped: 1 });
      await service.commit(owner, kpmId, a3(person('101', 'Rahmat', 'AB'), person('102', 'Sari', 'AAB', '101'), person('103', 'Bayu', 'Agent', '101')));
      expect(await byCode('102')).toBeNull();
      expect(await byCode('103')).not.toBeNull();
    });
  });

  /*
   * **The client's import test of 11 November** (P19.12-T7; ADR-0250; `revisions/2026-11-11/TES-IMPORT-PEOPLE-…`): a bad
   * optional cell is left empty, `L` and `P` are read, a row says what it leaves out, and an Agent with no email is
   * invited on WhatsApp through *+ Tambah agent*'s own invitation.
   */
  describe('P19.12-T7 the import forgives, says what is missing, and invites by WhatsApp', () => {
    const ORIGIN = 'https://app.agencyboost.test';
    const inviteRows = () => new MemberInviteRepository(mongoose.model(MemberInvite.name) as never);
    /** The import as the application wires it: with the invitation *+ Tambah agent* makes. */
    const withInvites = () => {
      const users = mongoose.model(User.name);
      const invites = new InvitesService(
        inviteRows(), members, hierarchy, null as never, null as never, null as never, new MemberNames(members, users as never),
        mongoose.model(Kpm.name) as never, mongoose.model(Company.name) as never, users as never,
        new AuditService(mongoose.model(AuditLog.name) as never), notifications as never, clock,
      );
      return new RosterImportService(
        members, hierarchy, mongoose.model(Kpm.name) as never, users as never, new PasswordService(),
        new AuditService(mongoose.model(AuditLog.name) as never), clock, orgLevels, historyRepo, notifications as never,
        mongoose.model(AuthToken.name) as never, undefined, invites, inviteRows(),
        { get: (key: string) => (key === 'APP_ORIGIN' ? ORIGIN : undefined) } as never,
      );
    };
    const inIndonesian = () => theOwner().withReader({ language: 'id', figures: 'id' } as never);
    const pending = () => mongoose.model(MemberInvite.name).find({ kpmId, status: 'pending' }).lean<Record<string, unknown>[]>();
    /** Rahmat, an AB already in the office: the upline the file's Agents name. */
    const rahmat = () => service.commit(theOwner(), kpmId, a3(person('101', 'Rahmat', 'AB')));

    it('P19.12-T7 AC-1 reads L and P as male and female, and stores them so', async () => {
      const preview = await service.preview(theOwner(), kpmId, a3(
        line('101', 'Lima', 'AB', '', '', 'l@k.test', '', '', '', 'L'), line('102', 'Dua', 'AB', '', '', 'p@k.test', '', '', '', 'p'),
      ));
      expect(preview.rows.map((r) => [r.outcome, r.warnings.some((w) => w.startsWith('Jenis kelamin'))]))
        .toEqual([['imported', false], ['imported', false]]);
      await service.commit(theOwner(), kpmId, a3(
        line('101', 'Lima', 'AB', '', '', 'l@k.test', '', '', '', 'L'), line('102', 'Dua', 'AB', '', '', 'p@k.test', '', '', '', 'p'),
      ));
      expect(await mongoose.model(User.name).findOne({ agentCode: '101' }).lean()).toMatchObject({ gender: 'male' });
      expect(await mongoose.model(User.name).findOne({ agentCode: '102' }).lean()).toMatchObject({ gender: 'female' });
    });

    it('P19.12-T7 AC-2 a bad WhatsApp number and birth date are left empty with a warning, and the person is imported', async () => {
      // TES-IMPORT Tes 1's 99311205 and Tes 3's `nomor saya`: once skipped, now in with the bad cells empty.
      const file = a3(
        person('101', 'Rahmat', 'AB'),
        line('102', 'Fmt', 'Agent', '101', 'nomor saya', 'fmt@k.test', '01/01/2030', '', '15/05/2015', 'L'),
      );
      const preview = await service.preview(inIndonesian(), kpmId, file);
      expect(preview.counts).toEqual({ imported: 2, updated: 0, invited: 0, skipped: 0 });
      expect(preview.rows[1]).toMatchObject({ outcome: 'imported', messages: [] });
      expect(preview.rows[1].warnings).toEqual([
        'No. WhatsApp: "nomor saya" bukan nomor WhatsApp. Dikosongkan; sisa barisnya tetap masuk.',
        'Tanggal bergabung: Tanggal bergabung tidak boleh setelah hari ini. Dikosongkan; sisa barisnya tetap masuk.',
        'Tanggal lahir: Tanggal lahir harus paling tidak 18 tahun yang lalu. Dikosongkan; sisa barisnya tetap masuk.',
        'Tanpa nomor WhatsApp: masuk, tapi belum bisa diingatkan lewat WhatsApp.',
        'Data belum lengkap: Tanggal bergabung, Waktu, Tanggal lahir, Bulan bergabung di perusahaan kosong. Impor ulang '
          + 'barisnya untuk melengkapi.',
      ]);
      expect(preview.skippedCsv).toBeNull();

      await service.commit(theOwner(), kpmId, file);
      expect(await mongoose.model(User.name).findOne({ agentCode: '102' }).lean())
        .toMatchObject({ phone: null, dateOfBirth: null, gender: 'male' });
      // The join date left empty is the import's day, as a blank one is.
      expect(await byCode('102')).toMatchObject({ joinDate: '2026-09-09' });
    });

    it('P19.12-T7 AC-2 a bad required cell still skips the row, its bad optional cells said among the reasons', async () => {
      const preview = await service.preview(theOwner(), kpmId, a3(
        person('101', 'Rahmat', 'AB'), line('102', 'Fmt', 'Senior Agent', '101', 'nomor saya', 'fmt@k.test'),
      ));
      expect(preview.rows[1]).toMatchObject({
        outcome: 'skipped',
        messages: ['Role "Senior Agent" does not exist. Use: Agent, AAB, AB.', 'No. WhatsApp: "nomor saya" is not a WhatsApp number.'],
        warnings: [],
      });
      expect(preview.skippedCsv).toContain('"nomor saya"" is not a WhatsApp number.');
    });

    it('P19.12-T7 AC-2 a bad Email skips a new person, and only warns on an update, which never applies an email', async () => {
      await rahmat();
      const preview = await service.preview(theOwner(), kpmId, a3(
        line('101', 'Rahmat', 'AB', '', 'nomor saya', 'fmt08@@agencyboost'),
        line('102', 'Baru', 'Agent', '101', '0812 1100 2200', 'fmt08@@agencyboost'),
      ));
      expect(preview.rows[0]).toMatchObject({ outcome: 'updated', messages: ['Already here; details updated.'] });
      // In the file's column order: No. WhatsApp, then Email.
      expect(preview.rows[0].warnings.slice(0, 2)).toEqual([
        'No. WhatsApp: "nomor saya" is not a WhatsApp number. Left empty; the rest of the row is imported.',
        'Email: "fmt08@@agencyboost" is not an email address. Left empty; the rest of the row is imported.',
      ]);
      expect(preview.rows[1]).toMatchObject({ outcome: 'skipped', messages: ['Email: "fmt08@@agencyboost" is not an email address.'] });
    });

    it('P19.12-T7 AC-3 a new row names every detail it leaves empty; an update only those nothing stored fills', async () => {
      await service.commit(theOwner(), kpmId, a3(
        person('100', 'Wilson', 'AB'), line('300', 'Indah', 'Agent', '100', '', 'indah@k.test', '', 'Part-time'),
      ));
      const preview = await service.preview(theOwner(), kpmId, a3(person('101', 'Rahmat', 'AB', '100'), line('300', 'Indah', 'Agent')));
      expect(preview.rows[0].warnings).toEqual([
        'Incomplete: no Tanggal bergabung, Waktu, Tanggal lahir, Jenis kelamin, Bulan bergabung di perusahaan. Import the row '
          + 'again with them to fill them in.',
      ]);
      // Indah's join date and work status are stored; her birth date, gender and join month are not.
      expect(preview.rows[1].warnings).toEqual([
        'Incomplete: no Tanggal lahir, Jenis kelamin, Bulan bergabung di perusahaan. Import the row again with them to fill them in.',
      ]);

      // Imported again with them, they fill in, and the row has nothing more to say.
      const filled = a3(line('300', 'Indah', 'Agent', '', '', '', '', '', '21/07/1998', 'P', '03/2020'));
      await service.commit(theOwner(), kpmId, filled);
      expect(await mongoose.model(User.name).findOne({ agentCode: '300' }).lean())
        .toMatchObject({ dateOfBirth: '1998-07-21', gender: 'female', companyJoinMonth: '2020-03' });
      expect((await service.preview(theOwner(), kpmId, a3(line('300', 'Indah', 'Agent')))).rows[0].warnings).toEqual([]);
    });

    it('P19.12-T7 AC-4 an Agent with no email, a number and a leader upline is invited on WhatsApp, in the preview', async () => {
      await rahmat();
      const preview = await withInvites().preview(inIndonesian(), kpmId, a3(line('103', 'Tiga', 'Agent', '101', '0812 1100 3300')));
      expect(preview.counts).toEqual({ imported: 0, updated: 0, invited: 1, skipped: 0 });
      expect(preview.rows[0]).toMatchObject({
        outcome: 'invited',
        messages: ['Tanpa email: diundang lewat WhatsApp. Dia mendaftar lewat tautannya dengan email dan kata sandinya sendiri.'],
        warnings: [],
      });
      expect(preview.rows[0]).not.toHaveProperty('invite');
      expect(await pending()).toEqual([]);
    });

    it('P19.12-T7 AC-4 the commit makes + Tambah agent’s invitation under the upline, its link answered once to share', async () => {
      await rahmat();
      sent.length = 0;
      const result = await withInvites().commit(theOwner(), kpmId, a3(
        line('103', 'Tiga', 'Agent', '101', '0812 1100 3300', '', '', '', '21/07/1998'),
      ));
      expect(result.counts).toEqual({ imported: 0, updated: 0, invited: 1, skipped: 0 });
      expect(result.invited).toBe(0);
      expect(result.rows[0].messages).toEqual([
        'No email: invited on WhatsApp instead. They register through the link with their own email and password.',
        'Tanggal lahir not kept: they give their own when they register.',
      ]);
      expect(result.rows[0].invite).toEqual({ link: expect.stringMatching(`^${ORIGIN}/register\\?invite=`), phone: '+6281211003300' });

      // Nobody is made, and nothing is mailed: the person registers through the link (ADR-0170).
      expect(await liveUsers({ agentCode: '103' })).toBe(0);
      expect(await byCode('103')).toBeNull();
      expect(sent).toEqual([]);
      const [invite] = await pending();
      expect(invite).toMatchObject({
        agentCode: '103', fullName: 'Tiga', phone: '+6281211003300', joinDate: '2026-09-09',
        leaderMembershipId: String((await byCode('101'))!._id), existingAccount: false,
      });
      // The link carries the token the row keeps only as a hash.
      const token = decodeURIComponent(new URL(result.rows[0].invite!.link).searchParams.get('invite')!);
      expect(invite.tokenHash).not.toBe(token);
      expect(await mongoose.model(AuditLog.name).countDocuments({ action: 'member_invite.created' })).toBe(1);
      expect(await mongoose.model(AuditLog.name).findOne({ action: 'roster.imported' }).sort({ _id: -1 }).lean())
        .toMatchObject({ after: { count: 0, invitedOnWhatsApp: ['103'] } });
    });

    it('P19.12-T7 AC-4 an upline new in the same file is made first, and the invitation goes under them', async () => {
      const result = await withInvites().commit(theOwner(), kpmId, a3(
        line('103', 'Tiga', 'Agent', '102', '0812 1100 3300', '', '15/01/2026'), person('102', 'Empat', 'AAB', '101'),
        person('101', 'Rahmat', 'AB'),
      ));
      expect(result.counts).toEqual({ imported: 2, updated: 0, invited: 1, skipped: 0 });
      expect(await pending()).toEqual([
        expect.objectContaining({ agentCode: '103', leaderMembershipId: String((await byCode('102'))!._id), joinDate: '2026-01-15' }),
      ]);
    });

    it('P19.12-T7 AC-4 an AAB with no email, an Agent with no number and one with no usable upline are still skipped', async () => {
      await rahmat();
      const preview = await withInvites().preview(theOwner(), kpmId, a3(
        line('102', 'Empat', 'AAB', '101', '0812 1100 2200'),
        line('103', 'Tiga', 'Agent', '101'),
        line('104', 'Lima', 'Agent', '11111111', '0812 1100 4400'),
        line('105', 'Enam', 'Agent', '', '0812 1100 5500'),
        line('106', 'Tujuh', 'Agent', '101', 'nomor saya'),
      ));
      expect(results(preview)).toEqual({
        102: ['skipped', 'No email: only an Agent can be invited on WhatsApp, so the row is skipped. Fill in their email.'],
        103: ['skipped', 'No email and no WhatsApp number: they cannot be invited, so the row is skipped. Fill in their email, '
          + 'or their WhatsApp number to invite them on WhatsApp.'],
        104: ['skipped', 'Upline code 11111111 is in neither the file nor this KPM.'],
        105: ['skipped', 'Agent and AAB need an upline code.'],
        106: ['skipped', 'No email and no WhatsApp number: they cannot be invited, so the row is skipped. Fill in their email, '
          + 'or their WhatsApp number to invite them on WhatsApp.'],
      });
      // The number left empty for its shape is said too: nothing of a skipped row goes in.
      expect(preview.rows[4].messages[1]).toBe('No. WhatsApp: "nomor saya" is not a WhatsApp number.');
      await expect(withInvites().commit(theOwner(), kpmId, a3(line('102', 'Empat', 'AAB', '101', '0812 1100 2200'))))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await pending()).toEqual([]);
    });

    it('P19.12-T7 AC-4 a code with an invitation already waiting is skipped in the preview, as + Tambah agent refuses it', async () => {
      await rahmat();
      const file = a3(line('103', 'Tiga', 'Agent', '101', '0812 1100 3300'));
      await withInvites().commit(theOwner(), kpmId, file);
      const again = await withInvites().preview(theOwner(), kpmId, file);
      expect(results(again)['103']).toEqual([
        'skipped', 'Agent code 103 already has an invite waiting to be accepted. Resend that one, or cancel it first.',
      ]);
      await expect(withInvites().commit(theOwner(), kpmId, file)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await pending()).toHaveLength(1);
    });

    it('P19.12-T7 AC-4 an invitation the commit cannot make skips its row with the refusal’s words; the rest stands', async () => {
      await rahmat();
      const service7 = withInvites();
      // An invitation for the code comes to wait between the check and the write: + Tambah agent's own refusal.
      const raced = Object.create(inviteRows()) as MemberInviteRepository;
      let asked = 0;
      raced.pendingCodeAcrossTenants = async () => { asked += 1; return false; };
      (service7 as unknown as { inviteRows: MemberInviteRepository }).inviteRows = raced;
      await mongoose.model(MemberInvite.name).create({
        kpmId, companyId, leaderMembershipId: String((await byCode('101'))!._id), invitedByMembershipId: 'mem-1',
        agentCode: '103', fullName: 'Tiga', phone: '+6281211003300', joinDate: '2026-09-09', tokenHash: 'h',
        status: 'pending', expiresAt: new Date(NOW.getTime() + 86_400_000), existingAccount: false,
      });
      const result = await service7.commit(theOwner(), kpmId, a3(
        line('103', 'Tiga', 'Agent', '101', '0812 1100 3300'), person('104', 'Empat', 'Agent', '101'),
      ));
      expect(asked).toBe(1);
      expect(result.counts).toEqual({ imported: 1, updated: 0, invited: 0, skipped: 1 });
      expect(results(result)['103']).toEqual([
        'skipped', 'Agent code 103 already has an invite waiting to be accepted. Resend that one, or cancel it first.',
      ]);
      expect(result.skippedCsv).toContain('103,Tiga,Agent,101');
      expect(await byCode('104')).not.toBeNull();
    });

    it('P19.12-T7 AC-4 an invitation that fails for no reason it can name skips its row, pointing at + Tambah agent', async () => {
      await rahmat();
      const service7 = withInvites();
      (service7 as unknown as { invitations: Pick<InvitesService, 'addAgent'> }).invitations = {
        addAgent: async () => { throw new Error('the database went away'); },
      };
      const result = await service7.commit(theOwner(), kpmId, a3(
        line('103', 'Tiga', 'Agent', '101', '0812 1100 3300'), person('104', 'Empat', 'Agent', '101'),
      ));
      expect(results(result)['103']).toEqual([
        'skipped', 'The WhatsApp invitation could not be made. Invite them with + Add agent on New Hires.',
      ]);
      expect(result.counts).toEqual({ imported: 1, updated: 0, invited: 0, skipped: 1 });
      expect(await byCode('104')).not.toBeNull();
    });
  });

  /*
   * **A5-3, the setup spec's sample file, imported into a seeded KPM.** Two adaptations, each from a decision: ADR-0205 §7
   * needs an email on a new person's row, so rows 2, 3, 4 and 9 — which A3's sample leaves without one — are given one;
   * and the code-format check (*"Kode agen harus 8 angka."*) waits for a template's `agentCodePattern` (Phase 19.5,
   * OD-266), so row 10's seven-digit `7004510` imports under ADR-0158 §4's rule until then. Rina's code is held in KPM
   * 0417 of the same company, as A3's sample assumes.
   */
  describe('P19.3-T4 AC-12 A5-3: the spec’s sample file', () => {
    const SAMPLE = [
      'Kode agen,Nama,Peran,Kode upline,No. WhatsApp,Email,Tanggal bergabung,Waktu,Tanggal lahir',
      '70045001,Rahmat Hidayat,AB,,0812 4500 1001,rahmat@contoh.id,02/03/2015,Full-time,12/05/1978',
      '70045002,Sari Wulandari,AAB,70045001,0812 4500 1002,sari@contoh.id,01/07/2019,Full-time,03/09/1986',
      '70045003,Bayu Saputra,Agent,70045002,0812 4500 1003,bayu@contoh.id,15/01/2026,Part-time,21/11/1999',
      '70045004,Melati Putri,Agent,70045002,0812 4500 1004,melati@contoh.id,10/08/2024,Full-time,02/02/1995',
      '70045005,Fikri Ramadhan,Agent,70049999,0812 4500 1005,,05/05/2025,Full-time,17/06/1993',
      '70045006,Desi Anggraeni,Agen Senior,70045002,0812 4500 1006,,01/02/2023,Full-time,30/01/1990',
      '70013011,Rina Wijaya,Agent,70045002,0812 1301 1000,,15/03/2021,Full-time,08/08/1992',
      '70045008,Yusuf Maulana,AB,70045003,0812 4500 1008,,01/01/2020,Full-time,11/11/1980',
      '70045009,Nadia Kusuma,Agent,70045001,,nadia@contoh.id,20/08/2026,Part-time,05/04/2001',
      '7004510,Tono Wijaya,Agent,70045001,0812 4500 1010,tono@contoh.id,01/09/2026,Full-time,09/09/1998',
    ].join('\n');

    it('P19.3-T4 AC-12 imports six, one without a number, and skips four, each with A3’s reason', async () => {
      const kpm0417 = await otherOffice('0417');
      const rina = await mongoose.model(User.name).create({
        email: 'rina@kpm0417.test', passwordHash: 'x', fullName: 'Rina Wijaya', companyId, agentCode: '70013011',
      });
      await mongoose.connection.db!.collection('memberships').insertOne({
        kpmId: kpm0417, userId: String(rina._id), agentCode: '70013011', orgLevelCode: 'AGENT', role: 'agent',
        leaderId: null, ancestorIds: [], status: 'active', deletedAt: null,
      } as never);
      const owner = memberOf(kpmId, { isKpmOwner: true }).withReader({ language: 'id', figures: 'id' } as never);

      const preview = await service.preview(owner, kpmId, SAMPLE);
      expect(preview.counts).toEqual({ imported: 6, updated: 0, invited: 0, skipped: 4 });
      expect(results(preview)).toEqual({
        70045001: ['imported', null],
        70045002: ['imported', null],
        70045003: ['imported', null],
        70045004: ['imported', null],
        70045005: ['skipped', 'Kode upline 70049999 tidak ada di file atau di KPM ini.'],
        70045006: ['skipped', 'Peran "Agen Senior" tidak ada. Pakai: Agent, AAB, AB.'],
        70013011: ['skipped', 'Kode agen ini sudah terdaftar di perusahaan asuransi ini.'],
        70045008: ['skipped', 'Upline harus leader (AAB atau AB), bukan Agent.'],
        70045009: ['imported', null],
        7004510: ['imported', null],
      });
      // P19.12-T7 AC-3: the sample has no *Jenis kelamin* or *Bulan bergabung* column, and every row says so.
      expect(preview.rows.find((r) => r.agentCode === '70045009')!.warnings).toEqual([
        'Tanpa nomor WhatsApp: masuk, tapi belum bisa diingatkan lewat WhatsApp.',
        'Data belum lengkap: Jenis kelamin, Bulan bergabung di perusahaan kosong. Impor ulang barisnya untuk melengkapi.',
      ]);

      const result = await service.commit(owner, kpmId, SAMPLE);
      expect(result.counts).toEqual({ imported: 6, updated: 0, invited: 0, skipped: 4 });
      expect(result.invited).toBe(6);
      expect(await members.count(scoped(), { status: 'active' })).toBe(6);
      expect(await byCode('70045009')).toMatchObject({ joinDate: '2026-08-20', workStatus: 'part_time' });
    });
  });

  /*
   * **Over HTTP, through the real `PermissionsGuard`** (P19.3-T4 AC-13): the five roster routes, each role, the reader's
   * language, and the file forms of ADR-0184.
   */
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
      // The app's guards in the app's order: a support session's writes meet `ViewOnlySessionGuard` first (P19.4-T2).
      app.useGlobalGuards(
        new StubAuth(), new ViewOnlySessionGuard(app.get(Reflector)), new PermissionsGuard(app.get(Reflector)),
      );
      await app.init();
      await listenOnLoopback(app);
    });
    afterAll(() => app.close());
    // The office's Owner, who imports (P19.4-T2). It was the Super Admin until their grant went.
    beforeEach(() => { session.current = theOwner(); });

    /** A binary answer, kept as bytes. */
    const binary = (res: request.Response, done: (err: Error | null, body: Buffer) => void) => {
      const stream = res as unknown as NodeJS.ReadableStream;
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => done(null, Buffer.concat(chunks)));
    };
    const send = (path: string, bytes: Buffer, name = 'roster.xlsx') =>
      request(app.getHttpServer()).post(`/admin/tenants/${kpmId}/roster/${path}`).attach('file', bytes, name);
    /** The Excel template, filled in with `rows` under its header, as somebody would save it. */
    const filledWorkbook = async (...rows: string[][]): Promise<Buffer> => {
      const workbook = new Workbook();
      await workbook.xlsx.load((await service.workbook(theOwner(), kpmId)) as unknown as Parameters<Workbook['xlsx']['load']>[0]);
      rows.forEach((cells, i) => { workbook.getWorksheet('Data')!.getRow(i + 2).values = cells; });
      return Buffer.from(await workbook.xlsx.writeBuffer());
    };
    const cells = (code: string, name: string, role: string, up = '', email = `${code}@k.test`) =>
      [code, name, role, up, '0812 1100 2200', email];

    it('P18.10-T5 AC-7 previews each row in the reader’s language', async () => {
      const rows = a3(person('101', 'Rahmat', 'AB'), person('102', 'Desi', 'Agen Senior', '101'));
      const id = await request(app.getHttpServer()).post(`/admin/tenants/${kpmId}/roster/preview`)
        .set(...IN_INDONESIAN).send({ rows }).expect(200);
      expect(id.body.rows[1]).toMatchObject({ outcome: 'skipped', messages: ['Peran "Agen Senior" tidak ada. Pakai: Agent, AAB, AB.'] });
      expect(id.body.skippedCsv).toContain('Alasan');
      const en = await request(app.getHttpServer()).post(`/admin/tenants/${kpmId}/roster/preview`).send({ rows }).expect(200);
      expect(en.body.rows[1].messages).toEqual(['Role "Agen Senior" does not exist. Use: Agent, AAB, AB.']);
    });

    it('P19.3-T4 AC-11 imports with invite on by default, and off when the body says false', async () => {
      const on = await request(app.getHttpServer()).post(`/admin/tenants/${kpmId}/roster`)
        .send({ rows: a3(person('101', 'Rahmat', 'AB')) }).expect(201);
      expect(on.body).toMatchObject({ counts: { imported: 1 }, invited: 1 });
      expect(JSON.stringify(on.body)).not.toMatch(/password/i);
      const off = await request(app.getHttpServer()).post(`/admin/tenants/${kpmId}/roster`)
        .send({ rows: a3(person('102', 'Sari', 'AB')), invite: false }).expect(201);
      expect(off.body.invited).toBe(0);
      await request(app.getHttpServer()).post(`/admin/tenants/${kpmId}/roster`)
        .send({ rows: a3(person('103', 'Bayu', 'AB')), invite: 'nope' }).expect(400);
    });

    it('refuses the commit of an unreadable file with its issues, in Indonesian', async () => {
      const res = await request(app.getHttpServer()).post(`/admin/tenants/${kpmId}/roster`)
        .set(...IN_INDONESIAN).send({ rows: 'Nama\nBudi' }).expect(400);
      expect(res.body.error.message).toBe('File tidak dapat dibaca, jadi tidak ada yang diimpor. Perbaiki, lalu unggah lagi.');
      expect(res.body.error.details.issues).toEqual([
        { line: 1, column: 'file', message: 'Kolom Kode agen, Peran tidak ditemukan. Unduh template dan pakai header-nya.' },
      ]);
    });

    it('answers the template as a workbook, named and typed as one, its guide in the reader’s language', async () => {
      const res = await request(app.getHttpServer()).get(`/admin/tenants/roster-template?format=xlsx&kpmId=${kpmId}`)
        .set(...IN_INDONESIAN).buffer(true).parse(binary).expect(200);
      expect(res.headers['content-type']).toBe(XLSX_MIME_TYPE);
      expect(res.headers['content-disposition']).toBe('attachment; filename="roster-template.xlsx"');
      const workbook = new Workbook();
      await workbook.xlsx.load(res.body as unknown as Parameters<Workbook['xlsx']['load']>[0]);
      expect(workbook.worksheets.map((w) => w.name)).toEqual(['Petunjuk', 'Data']);
      expect(workbook.getWorksheet('Data')!.getCell('C2').dataValidation).toMatchObject({ formulae: ['"Agent,AAB,AB"'] });
    });

    it('P19.3-T4 AC-7 answers the CSV template as A3’s header alone, and the JSON with it', async () => {
      const csv = await request(app.getHttpServer()).get('/admin/tenants/roster-template?format=csv').buffer(true).parse(binary).expect(200);
      expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(csv.body.toString('utf8')).toBe(`${H}\n`);
      const json = await request(app.getHttpServer()).get('/admin/tenants/roster-template').expect(200);
      expect(json.body).toMatchObject({ header: H, template: `${H}\n` });
      expect(json.body.examples).toHaveLength(3);
    });

    it('refuses a format the template does not come in, in the reader’s language', async () => {
      const res = await request(app.getHttpServer()).get('/admin/tenants/roster-template?format=pdf').expect(400);
      expect(res.body.error.details.violations).toEqual(['That is not a format the roster template comes in. Ask for format=xlsx or format=csv.']);
      const id = await request(app.getHttpServer()).get('/admin/tenants/roster-template?format=pdf').set(...IN_INDONESIAN).expect(400);
      expect(id.body.error.details.violations).toEqual(['Itu bukan format template roster. Minta format=xlsx atau format=csv.']);
    });

    it('S4 refuses a kpmId that is not an id, an operator object included', async () => {
      for (const query of ['format=xlsx&kpmId[$ne]=000000000000000000000000', 'format=xlsx&kpmId=not-an-id', 'format[$ne]=pdf', 'format=xlsx&office=x']) {
        const res = await request(app.getHttpServer()).get(`/admin/tenants/roster-template?${query}`);
        expect([query, res.status, res.body.error?.code]).toEqual([query, 400, 'VALIDATION_FAILED']);
      }
    });

    it('ADR-0184 previews and imports an uploaded workbook, the invite a form field', async () => {
      const filled = await filledWorkbook(cells('101', 'Rahmat', 'AB'), cells('102', 'Sari', 'AAB', '101'));
      const preview = await send('file/preview', filled).expect(200);
      expect(preview.body).toMatchObject({ issues: [], counts: { imported: 2, updated: 0, skipped: 0 } });
      const committed = await request(app.getHttpServer()).post(`/admin/tenants/${kpmId}/roster/file`)
        .field('invite', 'false').attach('file', filled, 'roster.xlsx').expect(201);
      expect(committed.body).toMatchObject({ counts: { imported: 2 }, invited: 0 });
      expect(sent).toEqual([]);
    });

    it('ADR-0184 answers a row’s cell problem in the reader’s language, on the row the sheet shows', async () => {
      const filled = await filledWorkbook(cells('101', 'Rina', 'AB', '', 'not-an-email'));
      const res = await send('file/preview', filled).set(...IN_INDONESIAN).expect(200);
      expect(res.body.rows).toEqual([expect.objectContaining({ line: 2, outcome: 'skipped', messages: ['Email: "not-an-email" bukan alamat email.'] })]);
    });

    it('ADR-0184 refuses a file over the ceiling, a zip bomb, a workbook that will not open, and no file', async () => {
      const big = await send('file/preview', Buffer.alloc(ROSTER_UPLOAD.MAX_BYTES + 1, 0x41), 'roster.csv').expect(413);
      expect(big.body.error).toMatchObject({ code: 'ASSET_TOO_LARGE', details: { maxBytes: 1_048_576 } });
      const bomb = Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': new Uint8Array(30 * 1024 * 1024) }, { level: 9 }));
      await send('file/preview', bomb).expect(413);
      const broken = await send('file/preview', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01])).expect(422);
      expect(broken.body.error.code).toBe('UPLOAD_MALFORMED_CSV');
      const none = await request(app.getHttpServer()).post(`/admin/tenants/${kpmId}/roster/file/preview`).expect(400);
      expect(none.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'file' } });
    });

    /*
     * **Every role on the import's routes** (P19.3-T4 AC-13; S5 of the T17–T20 review; P19.4-T2 AC-4): `kpm:import_roster`
     * is the Owner's and the Admin's at `own-kpm`, and nobody else's — no rung, no Super Admin (ADR-0206 §2), and no
     * support session: one only looks, as the Owner or anybody (ADR-0206 §4; a setup session could, ADR-0162).
     */
    describe('P19.3-T4 AC-13 who may use the routes', () => {
      const inOffice = (id: string, over: Record<string, unknown> = {}) => ({
        membershipId: 'mem-staff', kpmId: id, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
        isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
      }) as never;
      const ownerOf = (id: string) => new RequestContext('u-owner-here', 'none', inOffice(id, { isKpmOwner: true }));
      const adminOf = (id: string) => new RequestContext('u-admin-here', 'none', inOffice(id, { isKpmAdmin: true }));
      const supportAsOwner = () => new RequestContext(
        'u-owner-here', 'none', inOffice(kpmId, { isKpmOwner: true }), 'sa-1', null, false, true,
      );
      const csv = (code: string) => Buffer.from(a3(person(code, 'Rina', 'AB')));
      /** The five routes, against office `id`. */
      const five = (id: string, code: string) => [
        ['preview', () => request(app.getHttpServer()).post(`/admin/tenants/${id}/roster/preview`).send({ rows: a3(person(code, 'Rina', 'AB')) })],
        ['import', () => request(app.getHttpServer()).post(`/admin/tenants/${id}/roster`).send({ rows: a3(person(code, 'Rina', 'AB')) })],
        ['file preview', () => request(app.getHttpServer()).post(`/admin/tenants/${id}/roster/file/preview`).attach('file', csv(code), 'roster.csv')],
        ['file import', () => request(app.getHttpServer()).post(`/admin/tenants/${id}/roster/file`).attach('file', csv(`${code}9`), 'roster.csv')],
        ['template', () => request(app.getHttpServer()).get(`/admin/tenants/roster-template?format=xlsx&kpmId=${id}`).buffer(true).parse(binary)],
      ] as const;
      const statuses = async (calls: ReturnType<typeof five>) => {
        const out: [string, number][] = [];
        for (const [route, call] of calls) out.push([route, (await call()).status]);
        return out;
      };
      const OK = [['preview', 200], ['import', 201], ['file preview', 200], ['file import', 201], ['template', 200]];

      it.each([['the Owner', ownerOf], ['a KPM Admin', adminOf]])('P19.3-T4 AC-13 lets %s use all five for their own office', async (_who, as) => {
        session.current = as(kpmId);
        expect(await statuses(five(kpmId, '301'))).toEqual(OK);
        expect(await liveUsers()).toBe(2);
      });

      it.each([['the Owner', ownerOf], ['a KPM Admin', adminOf]])('P19.3-T4 AC-13 answers %s naming another office not found, and creates nobody', async (_who, as) => {
        const other = await otherOffice('0556');
        session.current = as(kpmId);
        expect((await statuses(five(other, '302'))).map(([, s]) => s)).toEqual([404, 404, 404, 404, 404]);
        expect(await liveUsers()).toBe(0);
      });

      it.each([
        ['an AB', {}],
        ['an AAB', { orgLevelCode: 'AAB', hierarchyRole: 'aab' }],
        ['an Agent', { orgLevelCode: 'AGENT', hierarchyRole: 'agent' }],
      ])('P19.3-T4 AC-13 refuses %s of the office all five, 403', async (_who, rung) => {
        session.current = new RequestContext('u-rung', 'none', inOffice(kpmId, rung));
        expect((await statuses(five(kpmId, '303'))).map(([, s]) => s)).toEqual([403, 403, 403, 403, 403]);
        expect(await liveUsers()).toBe(0);
      });

      it('P19.4-T2 AC-2 refuses a session as the Owner all five — the four writes IMPERSONATION_READ_ONLY — and writes nothing', async () => {
        session.current = supportAsOwner();
        const codes: [string, number, string][] = [];
        for (const [route, call] of five(kpmId, '304')) {
          const res = await call();
          const body = Buffer.isBuffer(res.body) ? JSON.parse(res.body.toString('utf8')) : res.body;
          codes.push([route, res.status, body.error.code]);
        }
        // The template is a GET, refused by its permission's verb (`can()`); the rest by their method, before it.
        expect(codes).toEqual([
          ['preview', 403, 'IMPERSONATION_READ_ONLY'], ['import', 403, 'IMPERSONATION_READ_ONLY'],
          ['file preview', 403, 'IMPERSONATION_READ_ONLY'], ['file import', 403, 'IMPERSONATION_READ_ONLY'],
          ['template', 403, 'PERM_DENIED'],
        ]);
        expect(await liveUsers()).toBe(0);
      });

      it('P19.4-T2 AC-4 refuses the Super Admin all five, 403 PERM_DENIED, and creates nobody', async () => {
        session.current = SUPER_ADMIN;
        const codes: [string, number, string][] = [];
        for (const [route, call] of five(kpmId, '306')) {
          const res = await call();
          const body = Buffer.isBuffer(res.body) ? JSON.parse(res.body.toString('utf8')) : res.body;
          codes.push([route, res.status, body.error.code]);
        }
        expect(codes.map(([, status, code]) => [status, code])).toEqual(Array(5).fill([403, 'PERM_DENIED']));
        expect(await liveUsers()).toBe(0);
      });

      it('answers an Owner of another office not found, and a leader no', async () => {
        session.current = OWNER; // of FIXTURE_KPM, not of this office
        await send('file/preview', csv('307'), 'roster.csv').expect(404);
        session.current = AB;
        await send('file/preview', csv('307'), 'roster.csv').expect(403);
        expect(await liveUsers()).toBe(0);
      });
    });
  });
});
