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
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { up as templateCompany } from '@/migrations/0037-template-company';
import { configModule } from '../../../test/config-module';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { KpmRequest, KpmRequestSchema } from './kpm-request.schema';
import { KpmRequestService } from './kpm-request.service';
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
 * **P18.9-T3 — the *Template* company, hidden as an insurer and copied by setup** (ADR-0164 §3–§6).
 *
 * The services as the application wires them, over a real database that holds what migration `0037` makes:
 * registration, the platform overview and platform analytics never see the Template library; registration and
 * KPM creation refuse it; a new company copies it, *Empty* aside; a new office may start from its Default
 * template, the rung check made; and a change to the Template afterwards reaches nothing already made from it.
 */
describe('P18.9-T3 the Template library (ADR-0164)', () => {
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
      wired.recruitmentPlaybooks,
      wired.templateCopies,
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

  describe('AC-4: a new company copies the Template', () => {
    it('AC-4 its first template, its default, is the Default template copied, the origin naming the source', async () => {
      const company = await prudential();
      const companyId = String(company._id);
      const templates = await wired.namedTemplates.list(companyId);
      expect(templates).toHaveLength(1);
      expect(templates[0]).toMatchObject({
        name: 'Prudential template', isDefault: true, status: 'active',
        origin: { kind: 'copy', templateId: LIBRARY_DEFAULT, companyId: LIBRARY },
      });
      expect(Object.values(templates[0].publishedVersions)).toEqual(Array(OFFICE_TEMPLATE_KINDS.length).fill(1));

      const copied = await wired.namedTemplates.publishedKindsOf(companyId, templates[0].id);
      const source = await wired.namedTemplates.publishedKindsOf(LIBRARY, LIBRARY_DEFAULT);
      expect(copied.kinds).toEqual(source.kinds);
      expect(company).toMatchObject({ kind: 'insurer', usesPlatformDefaults: true });
    });

    it('AC-4 copies what the Template holds now, not the code: its ladder with tiers, products, carrier rules and playbook', async () => {
      // The Super Admin's edits of the Template: a rung renamed and one added, a product renamed, the playbook
      // reworded, item 3 renamed and published as version 2, and the carrier rules' tab published.
      await col('companyOrgLevels').updateOne({ companyId: LIBRARY, code: 'AB' }, { $set: { label: 'Agency Builder' } });
      await col('companyOrgLevels').insertOne({
        companyId: LIBRARY, code: 'SM', label: 'Senior Manager', displayOrder: 4, leaderTier: 'senior',
        status: 'active', archivedAt: null, deletedAt: null, createdAt: NOW, updatedAt: NOW, version: 0,
      });
      await col('products').updateOne({ companyId: LIBRARY, code: SEED_PRODUCTS[0].code }, { $set: { name: 'Renamed in the Template' } });
      await col('recruitmentPlaybooks').updateOne({ companyId: LIBRARY }, { $set: { 'body.nextAction': 'The Template’s words.', version: 2 } });
      await publishInLibrary('activity_taxonomy', renamedTaxonomy('Janji temu'));
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

      expect(await col('recruitmentPlaybooks').findOne({ companyId }))
        .toMatchObject({ version: 1, body: { nextAction: 'The Template’s words.' } });

      const [template] = await wired.namedTemplates.list(companyId);
      // The library's newest published version, as the copy's version 1.
      expect(template.publishedVersions.activity_taxonomy).toBe(1);
      const { kinds } = await wired.namedTemplates.publishedKindsOf(companyId, template.id);
      expect((kinds.activity_taxonomy!.types as { code: string; label: string }[])
        .find((t) => t.code === 'LEADS_CONTACTED')!.label).toBe('Janji temu');
    });

    it('AC-4 records what it copied: company.created names the library’s template, and one template.created', async () => {
      const companyId = String((await prudential())._id);
      const created = await col('auditLog').findOne({ action: 'company.created', targetId: companyId });
      expect(created?.after).toMatchObject({
        usesPlatformDefaults: true, startedFrom: 'template_library',
        source: { companyId: LIBRARY, templateId: LIBRARY_DEFAULT, name: 'Default template' },
      });
      const template = await col('auditLog').findOne({ action: 'template.created', 'after.companyId': companyId });
      expect(template?.after).toMatchObject({
        from: 'copy', isDefault: true, filesDuplicated: 0,
        source: { companyId: LIBRARY, templateId: LIBRARY_DEFAULT, name: 'Default template' },
      });
    });

    it('AC-4 Empty stays the alternative: the default ladder, and nothing else', async () => {
      const company = await tenants.createCompany(SA, { name: 'Sejahtera Baru Life', slug: 'sejahtera', usesPlatformDefaults: false });
      const companyId = String(company._id);
      expect(company).toMatchObject({ kind: 'insurer', usesPlatformDefaults: false });
      const ladder = await col('companyOrgLevels').find({ companyId }).sort({ displayOrder: 1 }).toArray();
      expect(ladder.map((r) => [r.code, r.leaderTier])).toEqual(DEFAULT_ORG_LADDER.map((r) => [r.code, r.leaderTier]));
      for (const name of ['products', 'qualificationRules', 'recruitmentPlaybooks']) {
        expect([name, await col(name).countDocuments({ companyId })]).toEqual([name, 0]);
      }
      const [template] = await wired.namedTemplates.list(companyId);
      expect(template).toMatchObject({ name: 'Sejahtera Baru Life template', isDefault: true, origin: { kind: 'empty' } });
      expect(Object.values(template.publishedVersions).every((v) => v === null)).toBe(true);
    });

    it('AC-4 where no Template library exists, gives the AgencyBoost defaults from the code, as before', async () => {
      await col('companies').deleteMany({ kind: 'template' });
      const companyId = String((await prudential())._id);
      const [template] = await wired.namedTemplates.list(companyId);
      expect(template).toMatchObject({ isDefault: true, origin: { kind: 'defaults' } });
      expect(await col('products').countDocuments({ companyId })).toBe(SEED_PRODUCTS.length);
      expect((await col('auditLog').findOne({ action: 'company.created', targetId: companyId }))?.after)
        .toMatchObject({ startedFrom: 'defaults' });
    });
  });

  describe('AC-5: a new office may start from Template · Default template', () => {
    it('AC-5 copies the library’s kinds, and its record names the library; the company’s default stays the default', async () => {
      const companyId = String((await prudential())._id);
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
      const [own] = await wired.namedTemplates.list(companyId);
      const second = await tenants.createKpm(SA, { companyId, code: '0555', branchName: 'Kelapa Gading' });
      expect((await col('kpms').findOne({ _id: new mongoose.Types.ObjectId(second._id) }))!.startedFrom)
        .toEqual({ source: 'template', templateId: own.id, templateName: 'Prudential template' });
    });

    it('AC-5 may name another of the library’s templates; a template of the company’s own is not the library’s, 404', async () => {
      const companyId = String((await prudential())._id);
      const lean = await wired.namedTemplates.create(SA, LIBRARY, { name: 'Lean start', from: 'empty' });
      const kpm = await office(companyId, { kind: 'template', templateLibrary: true, templateId: lean.id });
      expect((await col('kpms').findOne({ _id: new mongoose.Types.ObjectId(kpm._id) }))!.startedFrom)
        .toMatchObject({ templateId: lean.id, templateName: 'Lean start', companyId: LIBRARY });

      const [own] = await wired.namedTemplates.list(companyId);
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
