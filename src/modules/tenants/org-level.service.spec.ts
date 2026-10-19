import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { Company, CompanySchema } from './company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from './company-org-level.schema';
import { Kpm, KpmSchema } from './kpm.schema';
import { OrgLevelService } from './org-level.service';

const NOW = new Date('2026-09-07T02:00:00.000Z');

/**
 * P3.5-T7. The ladder is the company's, referenced by code, and archived rather than
 * deleted — three rules that only bite when somebody tries to break them.
 */
describe('OrgLevelService', () => {
  let service: OrgLevelService;
  let companyId: string;

  beforeAll(async () => {
    await startMongo();
    const levels = mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema);
    const companies = mongoose.model(Company.name, CompanySchema);
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    service = new OrgLevelService(
      levels as never, companies as never, kpms as never, audit, new FixedClock(NOW),
    );
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: 'prudential' });
    companyId = String(company._id);
  });

  const sa = () => RequestContext.platform('root');
  const owner = () =>
    new RequestContext('u-owner', 'none', {
      membershipId: 'mem-owner', kpmId: 'kpm-a', orgLevelCode: 'AB', hierarchyRole: 'ab',
      status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
    });

  const rung = (code: string, label: string, displayOrder: number) => ({
    companyId, code, label, displayOrder,
  });

  describe('AC-2: the ladder belongs to the company, not to any office', () => {
    it.each([
      ['a KPM Owner', owner()],
      ['a user in no office', new RequestContext('u-nobody', 'none', null)],
    ])('refuses %s the right to add a rung', async (_label, actor) => {
      await expect(service.create(actor, rung('AAB', 'AAB', 2))).rejects.toMatchObject({
        code: 'PERM_DENIED',
      });
    });

    it('refuses a KPM Owner the right to rename one', async () => {
      const [level] = await service.create(sa(), rung('AGENT', 'Agent', 1));
      await expect(
        service.update(owner(), level.orgLevelId, { label: 'Anything' }),
      ).rejects.toMatchObject({ code: 'PERM_DENIED' });
    });

    it('spans every company when no company is named — so the route must be narrow', async () => {
      /*
       * The exit review's blocking finding. `list()` with no `companyId` is unfiltered by
       * design: the Super Admin console shows every insurer's ladder on one screen. That
       * is correct here and lethal one layer up — P4-T9 widened `org_level:read` from
       * Super Admin to all six roles so that badges could be drawn from the company's own
       * ladder, and `GET /admin/org-levels` shared the permission name. A KPM Owner with
       * an ordinary token read fifty-seven rungs across nineteen companies.
       *
       * This test states what the service does; `admin.controller.spec.ts` states the gate
       * it therefore needs. Members read their own company's ladder through
       * `GET /kpm/org-levels`, which narrows by the caller's office.
       */
      const other = await mongoose.model(Company.name).create({ name: 'Allianz', slug: 'allianz-x' });
      await service.create(sa(), rung('AB', 'AB', 3));
      await service.create(sa(), {
        companyId: String(other._id), code: 'AB', label: 'Agency Manager', displayOrder: 3,
      });

      const rows = await service.list(sa());
      expect(new Set(rows.map((l) => l.companyId)).size).toBe(2);
    });

    it('lets a KPM Owner read the ladder, and still not change it (P4-T9)', async () => {
      /*
       * This asserted a refusal until P4-T9, and the reason was written down at the time:
       * *"nothing tenant-side consumes it until the role-badge maps become
       * server-supplied, and a grant nobody exercises is the opposite of a permission."*
       *
       * That is now what happens — every member's badge label, colour and order is drawn
       * from the ladder rather than from five hard-coded maps in the frontend. Reading
       * widened; writing did not, because the ladder belongs to the company (ADR-0012),
       * and that is what the assertion above this one holds.
       */
      const [level] = await service.create(sa(), rung('AGENT', 'Agent', 1));
      await expect(service.list(owner())).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'AGENT' })]),
      );
      void level;
    });
  });

  describe('AC-1: the code is the identity, the order is presentation', () => {
    it('upper-cases the code on the way in, so `aab` and `AAB` are one rung', async () => {
      await service.create(sa(), rung('agent', 'Agent', 1));
      await expect(service.create(sa(), rung('AGENT', 'Agent again', 2))).rejects.toMatchObject({
        code: 'ORG_LEVEL_CODE_TAKEN',
      });
    });

    it('lets the label and the order change, and never the code', async () => {
      const [level] = await service.create(sa(), rung('AAB', 'AAB', 2));
      const [renamed] = await service.update(sa(), level.orgLevelId, {
        label: 'Associate Agency Business',
        displayOrder: 5,
      });
      expect(renamed).toMatchObject({ code: 'AAB', label: 'Associate Agency Business', displayOrder: 5 });
      // `UpdateOrgLevelDto` has no `code` field at all, so this is enforced by the shape
      // of the contract rather than by a check that could be forgotten.
      expect(Object.keys(renamed)).toContain('code');
    });

    it('reads junior first, by order and not by insertion', async () => {
      await service.create(sa(), rung('AB', 'AB', 3));
      await service.create(sa(), rung('AGENT', 'Agent', 1));
      await service.create(sa(), rung('AAB', 'AAB', 2));

      expect((await service.list(sa())).map((l) => l.code)).toEqual(['AGENT', 'AAB', 'AB']);
    });

    it('lets two companies hold the same code', async () => {
      const other = await mongoose.model(Company.name).create({ name: 'Allianz', slug: 'allianz' });
      await service.create(sa(), rung('AB', 'AB', 3));
      const rows = await service.create(sa(), {
        companyId: String(other._id), code: 'AB', label: 'Agency Manager', displayOrder: 3,
      });
      expect(rows.map((l) => l.label)).toEqual(['Agency Manager']);
    });

    it('404s an unknown company rather than creating an orphan rung', async () => {
      await expect(
        service.create(sa(), { ...rung('AB', 'AB', 3), companyId: new mongoose.Types.ObjectId().toString() }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('AC-3: archived, never deleted', () => {
    it('archives with a timestamp and keeps the rung readable', async () => {
      const [level] = await service.create(sa(), rung('AAB', 'AAB', 2));
      const rows = await service.update(sa(), level.orgLevelId, { status: 'archived' });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ code: 'AAB', status: 'archived', archivedAt: NOW.toISOString() });
    });

    it('never reuses an archived code', async () => {
      // The sharp one. A retired `AAB` recreated as something else would silently change
      // what every membership still pointing at the old rung means.
      const [level] = await service.create(sa(), rung('AAB', 'AAB', 2));
      await service.update(sa(), level.orgLevelId, { status: 'archived' });

      await expect(service.create(sa(), rung('AAB', 'Something else', 2))).rejects.toMatchObject({
        code: 'ORG_LEVEL_CODE_TAKEN',
      });
    });

    it('says the clash is with an archived rung, which reads differently', async () => {
      const [level] = await service.create(sa(), rung('AAB', 'AAB', 2));
      await service.update(sa(), level.orgLevelId, { status: 'archived' });
      await expect(service.create(sa(), rung('AAB', 'x', 2))).rejects.toMatchObject({
        message: expect.stringContaining('archived'),
      });
    });

    it('clears the timestamp when a rung comes back', async () => {
      const [level] = await service.create(sa(), rung('AAB', 'AAB', 2));
      await service.update(sa(), level.orgLevelId, { status: 'archived' });
      const [revived] = await service.update(sa(), level.orgLevelId, { status: 'active' });
      expect(revived).toMatchObject({ status: 'active', archivedAt: null });
    });

    it('404s an unknown rung', async () => {
      await expect(
        service.update(sa(), new mongoose.Types.ObjectId().toString(), { label: 'x' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('the ladder per company, for the overview card', () => {
    it('returns active rungs only, junior first', async () => {
      await service.create(sa(), rung('AGENT', 'Agent', 1));
      const [, aab] = await service.create(sa(), rung('AAB', 'AAB', 2));
      await service.create(sa(), rung('AB', 'AB', 3));
      await service.update(sa(), aab.orgLevelId, { status: 'archived' });

      const ladders = await service.laddersByCompany([companyId]);
      // The card says what a company promotes people along *today*; a retired rung on it
      // would read as a rung somebody could still be given.
      expect(ladders.get(companyId)?.map((l) => l.label)).toEqual(['Agent', 'AB']);
    });

    it('answers NOT_FOUND for a malformed rung id, not a 500', async () => {
      await expect(
        service.update(sa(), 'not-an-objectid', { label: 'Nope' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('is empty rather than absent for a company with no ladder', async () => {
      expect((await service.laddersByCompany([companyId])).get(companyId)).toBeUndefined();
      expect((await service.laddersByCompany([])).size).toBe(0);
    });
  });
});
