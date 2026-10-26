import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
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

const H = ROSTER_TEMPLATE_HEADER;
const NOW = new Date('2026-09-09T02:00:00.000Z');

describe('RosterImportService (P3.6-T4)', () => {
  let service: RosterImportService;
  let members: MembershipRepository;
  let kpmId: string;
  let companyId: string;
  const clock = new FixedClock(NOW);

  const sa = () => RequestContext.platform('root');

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
});
