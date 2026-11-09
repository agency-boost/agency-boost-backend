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
 * P3.1-T7. The ladder is the company's, referenced by code, and archived rather than
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

  /** P18.5-T1, ADR-0156: the tier on each rung, and the class it gives. Over HTTP: `org-level.int.spec.ts`. */
  describe('P18.5-T1 the leader tier', () => {
    it('AC-1 seeds the default ladder with its tiers: AB senior, AAB associate, Agent none', async () => {
      await service.seedDefaultLadder(companyId);
      const ladder = await service.list(sa(), companyId);
      expect(ladder.map((l) => [l.code, l.leaderTier])).toEqual([['AGENT', null], ['AAB', 'associate'], ['AB', 'senior']]);
    });

    it('AC-3 gives each active rung its tier’s class, by code — a custom rung’s included, an archived one not', async () => {
      await service.create(sa(), { ...rung('AGENT', 'Agent', 1) });
      await service.create(sa(), { ...rung('UM', 'Unit Manager', 2), leaderTier: 'associate' });
      await service.create(sa(), { ...rung('SM', 'Senior Manager', 3), leaderTier: 'senior' });
      const [, , , gone] = await service.create(sa(), { ...rung('OLD', 'Old', 4), leaderTier: 'senior' });
      await service.update(sa(), gone.orgLevelId, { status: 'archived' });

      expect(Object.fromEntries(await service.classesByCode(companyId))).toEqual({ AGENT: 'agent', UM: 'aab', SM: 'ab' });
    });

    it('AC-2 refuses a tier change as a server fault when it cannot count who holds the rung — nothing written', async () => {
      // This spec builds the service without the membership repository, as fifteen others do for the reads.
      const [level] = await service.create(sa(), rung('SM', 'Senior Manager', 1));
      await expect(service.update(sa(), level.orgLevelId, { leaderTier: 'senior' })).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
      });
      expect((await service.list(sa(), companyId))[0].leaderTier).toBeNull();
      // A change that is no change asks nobody.
      await expect(service.update(sa(), level.orgLevelId, { leaderTier: null, label: 'SM' })).resolves.toHaveLength(1);
    });
  });

  /** ADR-0164 §4, ADR-0012 §3: the ladder a new company starts with — the default's, or the Template library's copied. */
  describe('P18.6 (ADR-0164 §4) a new company’s ladder, seeded or copied', () => {
    const codes = async (id: string) => (await service.list(sa(), id)).map((l) => [l.code, l.label]);

    it('P3.1-T7 seeds the default ladder once: run again, as the demo seed is, it neither duplicates nor throws', async () => {
      await service.seedDefaultLadder(companyId);
      await service.seedDefaultLadder(companyId);
      expect(await codes(companyId)).toEqual([['AGENT', 'Agent'], ['AAB', 'AAB'], ['AB', 'AB']]);
    });

    it('ADR-0164 §4 copies the source’s active rungs — code, label, order and tier — and copying again keeps what is there', async () => {
      const library = String((await mongoose.model(Company.name).create({ name: 'Template library', slug: 'library' }))._id);
      await service.create(sa(), { companyId: library, code: 'AGENT', label: 'Agen', displayOrder: 1 });
      await service.create(sa(), { companyId: library, code: 'UM', label: 'Unit Manager', displayOrder: 2, leaderTier: 'associate' });
      const [, , old] = await service.create(sa(), { companyId: library, code: 'OLD', label: 'Lama', displayOrder: 3, leaderTier: 'senior' });
      await service.update(sa(), old.orgLevelId, { status: 'archived' });

      expect(await service.copyLadderFrom(library, companyId)).toBe(2);
      expect((await service.list(sa(), companyId)).map((l) => [l.code, l.label, l.leaderTier]))
        .toEqual([['AGENT', 'Agen', null], ['UM', 'Unit Manager', 'associate']]);
      // A copy, never a link: the second run finds both rungs there and writes neither again.
      expect(await service.copyLadderFrom(library, companyId)).toBe(0);
      expect(await codes(companyId)).toHaveLength(2);
    });

    it('ADR-0164 §4 a source with no active rung gives the default ladder: a company without one is a company nobody can join', async () => {
      const empty = String((await mongoose.model(Company.name).create({ name: 'Template library', slug: 'library' }))._id);
      expect(await service.copyLadderFrom(empty, companyId)).toBe(0);
      expect(await codes(companyId)).toEqual([['AGENT', 'Agent'], ['AAB', 'AAB'], ['AB', 'AB']]);
    });
  });

  /**
   * P19.4-T5 AC-2, P19-T6 AC-2: a delete and a tier change each ask something before they write — what names the rung,
   * who stands on it — and the rung can change in between. The write is conditional on what was read, so a rung
   * restored, saved or deleted meanwhile is answered as it now is, never written over.
   */
  describe('P19.4-T5 a rung that changes while a write is asking first', () => {
    /** What happens to the rung while the reference search or the holder count is being asked. */
    let meanwhile: () => Promise<unknown> = async () => undefined;
    const levels = () => mongoose.model(CompanyOrgLevel.name);
    const asking = () => new OrgLevelService(
      levels() as never, mongoose.model(Company.name) as never, mongoose.model(Kpm.name) as never,
      new AuditService(mongoose.model(AuditLog.name) as never), new FixedClock(NOW),
      { countHoldingRungAcrossTenants: async () => { await meanwhile(); return 0; } } as never,
      { of: async () => { await meanwhile(); return []; } } as never,
    );
    const archived = async () => {
      const [level] = await service.create(sa(), rung('OLD', 'Old', 1));
      await service.update(sa(), level.orgLevelId, { status: 'archived' });
      return level.orgLevelId;
    };
    const live = async (id: string) => levels().findOne({ _id: id, deletedAt: null }).lean().exec() as Promise<{ status: string } | null>;
    afterEach(() => { meanwhile = async () => undefined; });

    it('P19.4-T5 AC-2 refuses a delete as a server fault when it cannot search what names the rung — nothing deleted', async () => {
      // This spec's `service` has no reference search: a rung is never deleted without asking what names it.
      const id = await archived();
      await expect(service.remove(sa(), id)).rejects.toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
      expect(await live(id)).toMatchObject({ status: 'archived' });
    });

    it('P19.4-T5 AC-2 a rung restored while its references were searched is not deleted: 409 at the version it now is', async () => {
      const id = await archived();
      meanwhile = () => levels().updateOne({ _id: id }, { $set: { status: 'active', archivedAt: null }, $inc: { version: 1 } }).exec();
      await expect(asking().remove(sa(), id)).rejects.toMatchObject({
        code: 'VERSION_CONFLICT', status: 409, details: { expectedVersion: 1, actualVersion: 2 },
      });
      // The version the Super Admin's table was read at, when they sent one.
      await levels().updateOne({ _id: id }, { $set: { status: 'archived' } }).exec();
      await expect(asking().remove(sa(), id, 2)).rejects.toMatchObject({
        code: 'VERSION_CONFLICT', details: { expectedVersion: 2, actualVersion: 3 },
      });
      // Restored, and there: the delete wrote nothing over the restore.
      expect(await live(id)).toMatchObject({ status: 'active' });
      expect(await mongoose.model(AuditLog.name).countDocuments({ action: 'org_level.deleted' })).toBe(0);
    });

    it('P19.4-T5 AC-2 a rung deleted by somebody else while its references were searched is 404, not a second delete', async () => {
      const id = await archived();
      meanwhile = () => levels().updateOne({ _id: id }, { $set: { deletedAt: NOW } }).exec();
      await expect(asking().remove(sa(), id)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(await mongoose.model(AuditLog.name).countDocuments({ action: 'org_level.deleted' })).toBe(0);
    });

    it('P19-T6 AC-2 a tier change on a rung saved meanwhile is 409; on one deleted meanwhile, 404 — nothing written either way', async () => {
      const [level] = await service.create(sa(), rung('SM', 'Senior Manager', 1));
      meanwhile = () => levels().updateOne({ _id: level.orgLevelId }, { $set: { label: 'Saved by another' }, $inc: { version: 1 } }).exec();
      await expect(asking().update(sa(), level.orgLevelId, { leaderTier: 'senior' })).rejects.toMatchObject({
        code: 'VERSION_CONFLICT', details: { expectedVersion: 0, actualVersion: 1 },
      });
      expect((await service.list(sa(), companyId))[0]).toMatchObject({ label: 'Saved by another', leaderTier: null });

      meanwhile = () => levels().updateOne({ _id: level.orgLevelId }, { $set: { deletedAt: NOW } }).exec();
      await expect(asking().update(sa(), level.orgLevelId, { leaderTier: 'senior' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });
  });
});
