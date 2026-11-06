import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DEFAULT_ORG_LADDER, SEED_PRODUCTS } from '@/domain/constants';
import { AuthToken, AuthTokenSchema } from '@/modules/auth/auth-token.schema';
import { AuthService } from '@/modules/auth/auth.service';
import { PasswordService } from '@/modules/auth/password.service';
import { Hs256TokenSigner } from '@/modules/auth/token-signer';
import { OFFICE_TEMPLATE_KINDS, platformDefaultPayload } from '@/modules/config/template-defaults';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { Membership } from '@/modules/org/membership.schema';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { up as templateCompany } from '@/migrations/0037-template-company';
import { configModule } from '../../../test/config-module';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { KpmRequest, KpmRequestSchema } from './kpm-request.schema';
import { KpmRequestService } from './kpm-request.service';
import { OrgLevelService } from './org-level.service';
import { TEMPLATE_LIBRARY } from './template-library';
import { TenantService } from './tenant.service';

const NOW = new Date('2026-10-26T03:00:00Z');
const LIBRARY = TEMPLATE_LIBRARY.companyId;
const LIBRARY_DEFAULT = TEMPLATE_LIBRARY.defaultTemplateId;

const SA = RequestContext.platform('sa-1');

/** A member of an office, holding each tenant role in turn: every one is refused what the Super Admin may do. */
function member(role: 'owner' | 'admin' | 'ab' | 'aab' | 'agent', kpmId = 'kpm-x'): RequestContext {
  const code = role === 'owner' || role === 'admin' || role === 'ab' ? 'AB' : role.toUpperCase();
  return new RequestContext(`u-${role}`, 'none', {
    membershipId: `m-${role}`, kpmId, orgLevelCode: code,
    hierarchyRole: code.toLowerCase() as 'ab' | 'aab' | 'agent', status: 'active',
    isKpmOwner: role === 'owner', isKpmAdmin: role === 'admin', directCount: 0,
  });
}

/**
 * **P18.6-T3 — the *Template* company, hidden as an insurer and copied by setup** (ADR-0164 §3–§6).
 *
 * The services as the application wires them, over a real database that holds what migration `0037` makes:
 * registration, the platform overview and platform analytics never see the Template library; registration and
 * KPM creation refuse it; a new company copies it, *Empty* aside; a new office may start from its Default
 * template, the rung check made; and a change to the Template afterwards reaches nothing already made from it.
 */
describe('P18.6-T3 the Template library (ADR-0164)', () => {
  let wired: ReturnType<typeof configModule>;
  let tenants: TenantService;
  let auth: AuthService;
  let kpmRequests: KpmRequestService;
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const col = (name: string) => db().collection(name);

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const clock = new FixedClock(NOW);
    const users = wired.users as never;
    tenants = new TenantService(
      wired.kpms as never,
      wired.companies as never,
      users,
      mongoose.model(KpmRequest.name, KpmRequestSchema) as never,
      wired.audit,
      clock,
      new HierarchyService(
        wired.memberships, wired.kpms as never, users,
        new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never),
        clock, wired.orgLevels,
      ),
      wired.memberships,
      wired.orgLevels,
      wired.provisioning,
      wired.products,
      wired.campaigns,
      wired.namedTemplates,
    );
    kpmRequests = new KpmRequestService(
      mongoose.model(KpmRequest.name, KpmRequestSchema) as never, wired.companies as never, users, tenants,
      wired.audit, clock,
    );
    auth = new AuthService(
      users,
      mongoose.model(AuthToken.name, AuthTokenSchema) as never,
      wired.companies as never,
      new PasswordService(),
      new Hs256TokenSigner('a'.repeat(40), clock),
      clock,
      { send: async () => undefined } as never,
    );
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    for (const name of ['companies', 'companyOrgLevels', 'products', 'qualificationRules', 'recruitmentPlaybooks',
      'companyTemplates', 'templates', 'kpms', 'users', 'auditLog', 'kpmRequests']) {
      await col(name).deleteMany({});
    }
    // What every environment holds before any tenant (ADR-0164 §2).
    await templateCompany(db(), NOW);
  });

  const prudential = () => tenants.createCompany(SA, { name: 'Prudential', slug: 'prudential' });
  const office = (companyId: string, startFrom?: Parameters<TenantService['createKpm']>[1]['startFrom']) =>
    tenants.createKpm(SA, { companyId, code: '0417', branchName: 'BSD City Branch', ...(startFrom ? { startFrom } : {}) });
  /** A library kind published again, as version 2: what the Super Admin's edit of the Template leaves. */
  async function publishInLibrary(kind: string, payload: Record<string, unknown>) {
    await col('companyTemplates').insertOne({
      companyId: LIBRARY, templateId: LIBRARY_DEFAULT, kind, version: 2, status: 'published', payload,
      publishedAt: NOW, deletedAt: null, createdBy: 'sa-1', updatedBy: 'sa-1', createdAt: NOW, updatedAt: NOW,
    });
  }
  /** The library's activity taxonomy with item 3 renamed. */
  const renamedTaxonomy = (label: string) => {
    const payload = platformDefaultPayload('activity_taxonomy') as { types: { code: string; label: string }[] };
    payload.types.find((t) => t.code === 'LEADS_CONTACTED')!.label = label;
    return payload as unknown as Record<string, unknown>;
  };

  describe('AC-3: not an insurer', () => {
    it('AC-3 is not listed for registration; an active insurer is', async () => {
      await prudential();
      expect((await tenants.listCompaniesForRegistration()).map((c) => c.name)).toEqual(['Prudential']);
    });

    it('AC-3 POST /auth/register refuses it, 404 as for no company, and makes no account', async () => {
      const person = {
        email: 'rina@kpm.test', password: 'correct horse battery', fullName: 'Rina Wijaya', agentCode: '88213',
        dateOfBirth: '1990-03-15', companyJoinMonth: '2021-07', workStatus: 'part_time' as const, gender: 'female' as const,
      };
      await expect(auth.register({ ...person, companyId: LIBRARY })).rejects.toMatchObject({
        status: 404, response: { code: 'NOT_FOUND' },
      });
      expect(await col('users').countDocuments({})).toBe(0);

      const insurer = await prudential();
      await expect(auth.register({ ...person, companyId: String(insurer._id) })).resolves.toBeDefined();
    });

    it('AC-3 nobody may ask for an office in it: a KPM request naming it is 404, as for no company', async () => {
      const person = await col('users').insertOne({
        email: 'asker@kpm.test', fullName: 'Asker', platformRole: 'none', status: 'active', deletedAt: null,
      });
      const asker = new RequestContext(String(person.insertedId), 'none', null);
      await expect(kpmRequests.create(asker, { companyId: LIBRARY, branchName: 'Template Branch' }))
        .rejects.toMatchObject({ status: 404, response: { code: 'NOT_FOUND' } });
      expect(await col('kpmRequests').countDocuments({})).toBe(0);

      const insurer = await prudential();
      await expect(kpmRequests.create(asker, { companyId: String(insurer._id), branchName: 'BSD City' }))
        .resolves.toMatchObject({ branchName: 'BSD City' });
    });

    it('AC-3 KPM creation refuses it, 409 COMPANY_IS_TEMPLATE_LIBRARY, and writes nothing', async () => {
      await expect(office(LIBRARY)).rejects.toMatchObject({
        status: 409, response: { code: 'COMPANY_IS_TEMPLATE_LIBRARY', details: { companyId: LIBRARY } },
      });
      expect(await col('kpms').countDocuments({})).toBe(0);
      expect(await col('activityTypes').countDocuments({})).toBe(0);
    });

    it('AC-3 is not in the platform overview: the tiles and the cards are the insurers', async () => {
      await prudential();
      const overview = await tenants.platformOverview(SA);
      expect(overview.tiles.companies).toBe(1);
      expect(overview.companies.map((c) => c.name)).toEqual(['Prudential']);
    });

    it('AC-3 is not in platform analytics', async () => {
      await prudential();
      const analytics = await wired.platformAnalytics.read(SA);
      expect(analytics.companies.map((c) => c.name)).toEqual(['Prudential']);
      expect(analytics.platform.companies).toBe(1);
    });

    it('AC-3 is on /admin/companies, as kind template, beside the insurers', async () => {
      await prudential();
      const rows = await tenants.listCompanies(SA);
      expect(rows.map((c) => [c.name, c.kind])).toEqual([['Prudential', 'insurer'], ['Template', 'template']]);
    });
  });

  /**
   * **P19.4-T3 AC-12 (SA UI-017): *"Dimulai kosong"* goes once the default template has one published section.** Worked
   * out by the list, so the companies page holds no rule: a blank company's tag while its template has nothing, and none
   * once a section is published — the platform's own *Advanced analytics* version 1 not counting.
   */
  describe('P19.4-T3 AC-12 the started-blank tag', () => {
    it('P19.4-T3 AC-12 reads started blank until the default template has a published section, then not', async () => {
      const blank = await tenants.createCompany(SA, { name: 'Manulife', slug: 'manulife', usesPlatformDefaults: false });
      const full = await prudential();
      const blankId = String(blank._id);
      const tagOf = async (id: string) => (await tenants.listCompanies(SA)).find((c) => String(c._id) === id)?.startedBlank;

      // No template at all (ADR-0213 §3), then an empty one: the platform's *Advanced analytics* v1 says nothing.
      expect(await tagOf(blankId)).toBe(true);
      const made = await wired.namedTemplates.create(SA, blankId, { name: 'Manulife template', from: 'empty' });
      expect(await tagOf(blankId)).toBe(true);
      // A company that took the presets never carries it.
      expect(await tagOf(String(full._id))).toBe(false);

      await col('companyTemplates').insertOne({
        companyId: blankId, templateId: made.id, kind: 'activity_taxonomy', version: 1, status: 'published',
        payload: {}, publishedAt: NOW, deletedAt: null, createdBy: 'sa-1', updatedBy: 'sa-1', createdAt: NOW, updatedAt: NOW,
      });
      expect(await tagOf(blankId)).toBe(false);
    });

    it('P19.4-T3 AC-12 reads a published section of a template that is not the default as no reason to drop the tag', async () => {
      const blank = await tenants.createCompany(SA, { name: 'Manulife', slug: 'manulife', usesPlatformDefaults: false });
      const blankId = String(blank._id);
      await wired.namedTemplates.create(SA, blankId, { name: 'Manulife template', from: 'empty' });
      const second = await wired.namedTemplates.create(SA, blankId, { name: 'Draft copy', from: 'empty' });
      await col('companyTemplates').insertOne({
        companyId: blankId, templateId: second.id, kind: 'lead_pipeline', version: 1, status: 'published',
        payload: {}, publishedAt: NOW, deletedAt: null, createdBy: 'sa-1', updatedBy: 'sa-1', createdAt: NOW, updatedAt: NOW,
      });
      expect((await tenants.listCompanies(SA)).find((c) => String(c._id) === blankId)?.startedBlank).toBe(true);
    });
  });

  describe('AC-4: a new company copies the Template (amended by ADR-0213 §3: no template)', () => {
    it('P19.4-T5 AC-5 makes no first template: the company holds none until the Super Admin makes one', async () => {
      const company = await prudential();
      const companyId = String(company._id);
      expect(await wired.namedTemplates.list(companyId)).toEqual([]);
      expect(company).toMatchObject({ kind: 'insurer', usesPlatformDefaults: true, playbookInTemplates: true });
      // Salin dari… the built-in Default template is how it gets one, and the first it makes is its default.
      const made = await wired.templateCopies.importFrom(SA, companyId, {
        fromCompanyId: LIBRARY, templateId: LIBRARY_DEFAULT, name: 'Prudential — utama',
      });
      expect(made).toMatchObject({ isDefault: true, origin: { kind: 'import', templateId: LIBRARY_DEFAULT } });
      expect(Object.values(made.publishedVersions).filter((v) => v === 1).length).toBeGreaterThanOrEqual(OFFICE_TEMPLATE_KINDS.length);
    });

    it('AC-4 copies what the Template holds now, not the code: its ladder with tiers, products and carrier rules — no playbook', async () => {
      // The Super Admin's edits of the Template: a rung renamed and one added, a product renamed, and the carrier
      // rules' tab published.
      await col('companyOrgLevels').updateOne({ companyId: LIBRARY, code: 'AB' }, { $set: { label: 'Agency Builder' } });
      await col('companyOrgLevels').insertOne({
        companyId: LIBRARY, code: 'SM', label: 'Senior Manager', displayOrder: 4, leaderTier: 'senior',
        status: 'active', archivedAt: null, deletedAt: null, createdAt: NOW, updatedAt: NOW, version: 0,
      });
      await col('products').updateOne({ companyId: LIBRARY, code: SEED_PRODUCTS[0].code }, { $set: { name: 'Renamed in the Template' } });
      await col('companyTemplates').insertOne({
        companyId: LIBRARY, templateId: null, kind: 'campaign_kinds', version: 1, status: 'published',
        payload: platformDefaultPayload('campaign_kinds'), publishedAt: NOW, deletedAt: null, createdAt: NOW, updatedAt: NOW,
      });

      const companyId = String((await prudential())._id);

      const ladder = await col('companyOrgLevels').find({ companyId, deletedAt: null }).sort({ displayOrder: 1 }).toArray();
      expect(ladder.map((r) => [r.code, r.label, r.leaderTier])).toEqual([
        ['AGENT', 'Agent', null], ['AAB', 'AAB', 'associate'], ['AB', 'Agency Builder', 'senior'], ['SM', 'Senior Manager', 'senior'],
      ]);

      const products = await col('products').find({ companyId, deletedAt: null }).toArray();
      expect(products).toHaveLength(SEED_PRODUCTS.length);
      expect(products.find((p) => p.code === SEED_PRODUCTS[0].code)).toMatchObject({
        name: 'Renamed in the Template', version: 1, commissionSchedule: [], defaultDocuments: {},
      });

      const rules = await col('qualificationRules').find({ companyId, deletedAt: null }).toArray();
      const libraryRules = await col('qualificationRules').find({ companyId: LIBRARY, deletedAt: null }).toArray();
      expect(rules.map((r) => `${r.kind}:${r.code}:${r.rank}`).sort())
        .toEqual(libraryRules.map((r) => `${r.kind}:${r.code}:${r.rank}`).sort());
      expect(await col('companyTemplates').findOne({ companyId, kind: 'campaign_kinds' }))
        .toMatchObject({ templateId: null, version: 1, status: 'published' });

      // ADR-0210 §6: no company-level playbook, and (ADR-0213 §3) no template to hold one.
      expect(await col('recruitmentPlaybooks').countDocuments({ companyId })).toBe(0);
      expect(await col('templates').countDocuments({ companyId })).toBe(0);
    });

    it('AC-4 records what it copied: company.created names the library, and no template.created', async () => {
      const companyId = String((await prudential())._id);
      const created = await col('auditLog').findOne({ action: 'company.created', targetId: companyId });
      expect(created?.after).toMatchObject({
        usesPlatformDefaults: true, startedFrom: 'template_library', source: { companyId: LIBRARY },
      });
      expect(await col('auditLog').countDocuments({ action: 'template.created', 'after.companyId': companyId })).toBe(0);
    });

    it('AC-4 Empty stays the alternative: the default ladder, and nothing else — no template either', async () => {
      const company = await tenants.createCompany(SA, { name: 'Sejahtera Baru Life', slug: 'sejahtera', usesPlatformDefaults: false });
      const companyId = String(company._id);
      expect(company).toMatchObject({ kind: 'insurer', usesPlatformDefaults: false });
      const ladder = await col('companyOrgLevels').find({ companyId }).sort({ displayOrder: 1 }).toArray();
      expect(ladder.map((r) => [r.code, r.leaderTier])).toEqual(DEFAULT_ORG_LADDER.map((r) => [r.code, r.leaderTier]));
      for (const name of ['products', 'qualificationRules', 'recruitmentPlaybooks', 'templates']) {
        expect([name, await col(name).countDocuments({ companyId })]).toEqual([name, 0]);
      }
    });

    it('AC-4 where no Template library exists, gives the AgencyBoost defaults from the code, as before — and no template', async () => {
      await col('companies').deleteMany({ kind: 'template' });
      const companyId = String((await prudential())._id);
      expect(await wired.namedTemplates.list(companyId)).toEqual([]);
      expect(await col('products').countDocuments({ companyId })).toBe(SEED_PRODUCTS.length);
      expect((await col('auditLog').findOne({ action: 'company.created', targetId: companyId }))?.after)
        .toMatchObject({ startedFrom: 'defaults' });
    });
  });

  describe('AC-5: a new office may start from Template · Default template', () => {
    it('AC-5 copies the library’s kinds, and its record names the library; the company’s default stays the default', async () => {
      const companyId = String((await prudential())._id);
      const own = await wired.namedTemplates.create(SA, companyId, { name: 'Prudential template', from: 'defaults' });
      await publishInLibrary('activity_taxonomy', renamedTaxonomy('Janji temu'));

      const kpm = await office(companyId, { kind: 'template', templateLibrary: true });
      const row = await col('kpms').findOne({ _id: new mongoose.Types.ObjectId(kpm._id) });
      expect(row!.startedFrom).toEqual({
        source: 'template', templateId: LIBRARY_DEFAULT, templateName: 'Default template', companyId: LIBRARY,
      });
      expect(row!.seededFrom.activity_taxonomy).toEqual({ templateId: LIBRARY_DEFAULT, version: 2 });
      expect(await col('activityTypes').findOne({ kpmId: kpm._id, code: 'LEADS_CONTACTED' }))
        .toMatchObject({ label: 'Janji temu' });

      // Absent, the company's own default — what approving a KPM request starts from.
      expect(own.isDefault).toBe(true);
      const second = await tenants.createKpm(SA, { companyId, code: '0555', branchName: 'Kelapa Gading' });
      expect((await col('kpms').findOne({ _id: new mongoose.Types.ObjectId(second._id) }))!.startedFrom)
        .toEqual({ source: 'template', templateId: own.id, templateName: 'Prudential template' });
    });

    it('P19.4-T5 AC-5 a company with no template: absent, the office starts from the built-in default (ADR-0213 §3)', async () => {
      const companyId = String((await prudential())._id);
      const kpm = await tenants.createKpm(SA, { companyId, code: '0418', branchName: 'Serpong' });
      expect((await col('kpms').findOne({ _id: new mongoose.Types.ObjectId(kpm._id) }))!.startedFrom).toEqual({
        source: 'template', templateId: LIBRARY_DEFAULT, templateName: 'Default template', companyId: LIBRARY,
      });
    });

    it('AC-5 may name another of the library’s templates; a template of the company’s own is not the library’s, 404', async () => {
      const companyId = String((await prudential())._id);
      const own = await wired.namedTemplates.create(SA, companyId, { name: 'Prudential template', from: 'empty' });
      const lean = await wired.namedTemplates.create(SA, LIBRARY, { name: 'Lean start', from: 'empty' });
      const kpm = await office(companyId, { kind: 'template', templateLibrary: true, templateId: lean.id });
      expect((await col('kpms').findOne({ _id: new mongoose.Types.ObjectId(kpm._id) }))!.startedFrom)
        .toMatchObject({ templateId: lean.id, templateName: 'Lean start', companyId: LIBRARY });

      await expect(tenants.createKpm(SA, {
        companyId, code: '0556', branchName: 'Serpong', startFrom: { kind: 'template', templateLibrary: true, templateId: own.id },
      })).rejects.toMatchObject({ status: 404 });
      expect(await col('kpms').countDocuments({ code: '0556' })).toBe(0);
    });

    it('AC-5 makes the rung check: a role the company’s ladder lacks is refused 409 TEMPLATE_RUNG_UNKNOWN, before any write', async () => {
      const ratios = platformDefaultPayload('ratio_set') as { ratios: { appliesToOrgLevelCodes?: string[] }[] };
      ratios.ratios[0].appliesToOrgLevelCodes = ['SM'];
      await publishInLibrary('ratio_set', ratios as unknown as Record<string, unknown>);

      const companyId = String((await tenants.createCompany(SA, { name: 'Prudential', slug: 'prudential', usesPlatformDefaults: false }))._id);
      await expect(office(companyId, { kind: 'template', templateLibrary: true })).rejects.toMatchObject({
        status: 409, response: { code: 'TEMPLATE_RUNG_UNKNOWN', details: { codes: ['SM'] } },
      });
      expect(await col('kpms').countDocuments({})).toBe(0);

      // With the rung on its ladder, the same source is accepted.
      await col('companyOrgLevels').insertOne({
        companyId, code: 'SM', label: 'Senior Manager', displayOrder: 4, leaderTier: 'senior',
        status: 'active', archivedAt: null, deletedAt: null, createdAt: NOW, updatedAt: NOW, version: 0,
      });
      await expect(office(companyId, { kind: 'template', templateLibrary: true })).resolves.toMatchObject({ code: '0417' });
    });

    it('AC-5 is 404 where there is no Template library, and nothing is written', async () => {
      const companyId = String((await prudential())._id);
      await col('companies').deleteMany({ kind: 'template' });
      await expect(office(companyId, { kind: 'template', templateLibrary: true }))
        .rejects.toMatchObject({ status: 404, response: { message: 'Template library not found.' } });
      expect(await col('kpms').countDocuments({})).toBe(0);
    });
  });

  describe('AC-6: copies, never links', () => {
    it('AC-6 changing the Template afterwards changes no company and no office made from it', async () => {
      const companyId = String((await prudential())._id);
      const kpm = await office(companyId, { kind: 'template', templateLibrary: true });
      const snapshot = async () => ({
        ladder: await col('companyOrgLevels').find({ companyId }).sort({ _id: 1 }).toArray(),
        products: await col('products').find({ companyId }).sort({ _id: 1 }).toArray(),
        rules: await col('qualificationRules').find({ companyId }).sort({ _id: 1 }).toArray(),
        playbook: await col('recruitmentPlaybooks').find({ companyId }).toArray(),
        templates: await col('companyTemplates').find({ companyId }).sort({ _id: 1 }).toArray(),
        types: await col('activityTypes').find({ kpmId: kpm._id }).sort({ _id: 1 }).toArray(),
      });
      const before = await snapshot();

      await col('companyOrgLevels').updateMany({ companyId: LIBRARY }, { $set: { label: 'Changed' } });
      await col('products').updateMany({ companyId: LIBRARY }, { $set: { name: 'Changed' } });
      await col('qualificationRules').updateMany({ companyId: LIBRARY }, { $set: { name: 'Changed' } });
      await col('recruitmentPlaybooks').updateMany({ companyId: LIBRARY }, { $set: { 'body.nextAction': 'Changed' } });
      await publishInLibrary('activity_taxonomy', renamedTaxonomy('Changed'));

      expect(await snapshot()).toEqual(before);
    });
  });

  /*
   * **ADR-0168 §3 (OD-210) — the Template's ladder is edited on `/admin/org-levels`**, as every company's is. The
   * reads carry it, every write takes it, a tier change is never refused for members — it has no offices — and a
   * company made afterwards copies the ladder as it then stands, while one made before keeps its own copy (§6).
   */
  describe('ADR-0168 §3: its ladder, edited where every ladder is', () => {
    /** The ladder service as the application wires it: with who stands on a rung, which a tier change asks. */
    const ladders = () => new OrgLevelService(
      mongoose.model('CompanyOrgLevelModelForConfig') as never, wired.companies as never, wired.kpms as never,
      wired.audit, new FixedClock(NOW), wired.memberships,
    );
    /** A company's rungs as stored, junior first: code, label, order, tier and status. */
    const ladderOf = async (companyId: string) =>
      (await col('companyOrgLevels').find({ companyId, deletedAt: null }).sort({ displayOrder: 1 }).toArray())
        .map((r) => [r.code, r.label, r.displayOrder, r.leaderTier ?? null, r.status]);

    it('is read with the insurers’ ladders, whole or by company, beside its kind on /admin/companies', async () => {
      const insurer = String((await prudential())._id);
      const all = await ladders().list(SA);
      expect(all.filter((r) => r.companyId === LIBRARY).map((r) => [r.code, r.leaderTier]))
        .toEqual(DEFAULT_ORG_LADDER.map((r) => [r.code, r.leaderTier]));
      expect(all.some((r) => r.companyId === insurer)).toBe(true);
      expect((await ladders().list(SA, LIBRARY)).map((r) => r.companyId)).toEqual(Array(DEFAULT_ORG_LADDER.length).fill(LIBRARY));
      expect((await tenants.listCompanies(SA)).find((c) => String(c._id) === LIBRARY)).toMatchObject({ kind: 'template' });
    });

    it('takes every write: a rung added, renamed, reordered, given a tier, archived and restored, each audited', async () => {
      const service = ladders();
      let ladder = await service.create(SA, { companyId: LIBRARY, code: 'sm', label: 'SM', displayOrder: 9 });
      const sm = ladder.find((r) => r.code === 'SM')!;
      expect(sm).toMatchObject({ companyId: LIBRARY, label: 'SM', displayOrder: 9, leaderTier: null, status: 'active' });

      ladder = await service.update(SA, sm.orgLevelId, { label: 'Senior Manager', displayOrder: 4, leaderTier: 'senior' });
      expect(ladder.find((r) => r.code === 'SM')).toMatchObject({ label: 'Senior Manager', displayOrder: 4, leaderTier: 'senior' });
      ladder = await service.update(SA, sm.orgLevelId, { status: 'archived' });
      expect(ladder.find((r) => r.code === 'SM')).toMatchObject({ status: 'archived', archivedAt: NOW.toISOString() });
      ladder = await service.update(SA, sm.orgLevelId, { status: 'active' });
      expect(ladder.find((r) => r.code === 'SM')).toMatchObject({ status: 'active', archivedAt: null });

      const actions = await col('auditLog').find({ targetCollection: 'companyOrgLevels', targetId: sm.orgLevelId })
        .sort({ _id: 1 }).toArray();
      expect(actions.map((a) => a.action)).toEqual(['org_level.created', 'org_level.updated', 'org_level.archived', 'org_level.updated']);
    });

    it('changes a tier with no refusal: nobody stands on its rungs, even where an insurer’s copy of the rung is held', async () => {
      const insurer = String((await prudential())._id);
      // Somebody on Prudential's AAB, the copy: a rung of its own, with its own id.
      const copy = await col('companyOrgLevels').findOne({ companyId: insurer, code: 'AAB' });
      await mongoose.model(Membership.name).create({
        kpmId: '66f0000000000000000000a1', userId: 'u-1', agentCode: '1001', agentSeq: 1, leaderCode: 'LC1',
        orgLevelId: String(copy!._id), orgLevelCode: 'AAB', role: 'aab', status: 'active',
      });
      const service = ladders();
      const aab = (await service.list(SA, LIBRARY)).find((r) => r.code === 'AAB')!;

      const ladder = await service.update(SA, aab.orgLevelId, { leaderTier: null });
      expect(ladder.find((r) => r.code === 'AAB')).toMatchObject({ leaderTier: null });
      // The insurer's copy is untouched, and its member with it.
      expect(await col('companyOrgLevels').findOne({ _id: copy!._id })).toMatchObject({ leaderTier: 'associate' });
      // That copy's tier, by contrast, is refused while its member stands on it.
      await expect(service.update(SA, String(copy!._id), { leaderTier: null })).rejects.toMatchObject({
        status: 409, response: { code: 'ORG_LEVEL_TIER_IN_USE', details: { members: 1 } },
      });
    });

    it('a company made afterwards copies the ladder as it then stands; one made before keeps its own copy (ADR-0164 §6)', async () => {
      const before = String((await prudential())._id);
      const beforeLadder = await ladderOf(before);

      const service = ladders();
      const library = await service.list(SA, LIBRARY);
      await service.update(SA, library.find((r) => r.code === 'AB')!.orgLevelId, { label: 'Agency Builder' });
      await service.update(SA, library.find((r) => r.code === 'AAB')!.orgLevelId, { leaderTier: null });
      await service.create(SA, { companyId: LIBRARY, code: 'SM', label: 'Senior Manager', displayOrder: 4, leaderTier: 'senior' });
      // An archived rung is the Template's history, not a rung to copy.
      const [um] = (await service.create(SA, { companyId: LIBRARY, code: 'UM', label: 'Unit Manager', displayOrder: 5 }))
        .filter((r) => r.code === 'UM');
      await service.update(SA, um.orgLevelId, { status: 'archived' });

      const after = String((await tenants.createCompany(SA, { name: 'Allianz Life', slug: 'allianz-life' }))._id);
      expect(await ladderOf(after)).toEqual([
        ['AGENT', DEFAULT_ORG_LADDER[0].label, 1, null, 'active'],
        ['AAB', DEFAULT_ORG_LADDER[1].label, 2, null, 'active'],
        ['AB', 'Agency Builder', 3, 'senior', 'active'],
        ['SM', 'Senior Manager', 4, 'senior', 'active'],
      ]);
      expect(await ladderOf(before)).toEqual(beforeLadder);
    });
  });

  describe('only the Super Admin', () => {
    it.each(['owner', 'admin', 'ab', 'aab', 'agent'] as const)(
      'refuses the %s a company, and an office from the library, 403 before anything is read',
      async (role) => {
        const ctx = member(role);
        await expect(tenants.createCompany(ctx, { name: 'Allianz Life', slug: 'allianz-life' }))
          .rejects.toMatchObject({ status: 403, response: { code: 'PERM_DENIED' } });
        await expect(tenants.createKpm(ctx, {
          companyId: LIBRARY, code: '0417', branchName: 'BSD', startFrom: { kind: 'template', templateLibrary: true },
        })).rejects.toMatchObject({ status: 403, response: { code: 'PERM_DENIED' } });
        expect(await col('companies').countDocuments({})).toBe(1);
        expect(await col('kpms').countDocuments({})).toBe(0);
      },
    );
  });
});
