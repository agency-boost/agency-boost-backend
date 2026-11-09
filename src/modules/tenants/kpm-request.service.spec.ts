import mongoose from 'mongoose';
import {
  TrainingCategory, TrainingCategorySchema,
} from '@/modules/training/training-category.schema';
import { TrainingSkill, TrainingSkillSchema } from '@/modules/training/training-skill.schema';
import { TrainingModule, TrainingModuleSchema } from '@/modules/training/training-module.schema';
import {
  ActivationTemplate, ActivationTemplateSchema,
} from '@/modules/activation/activation-template.schema';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { readerIn, SOURCE_READER } from '@/common/i18n/reader';
import { AuditService } from '@/modules/audit/audit.service';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import {
  MembershipHistory, MembershipHistorySchema,
} from '@/modules/org/membership-history.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { Company, CompanySchema } from './company.schema';
import { Kpm, KpmSchema } from './kpm.schema';
import { KpmRequest, KpmRequestSchema } from './kpm-request.schema';
import { KpmRequestService } from './kpm-request.service';
import { OrgLevelService } from './org-level.service';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from './company-org-level.schema';
import { TenantService } from './tenant.service';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { NamedTemplate, NamedTemplateSchema } from '@/modules/config/named-template.schema';
import { NamedTemplateService } from '@/modules/config/named-template.service';
import { KpmOfficeCounter } from '@/modules/config/office-counter';
import { ProvisioningService } from '@/modules/config/provisioning.service';
import { ActivityCategory, ActivityCategorySchema } from '@/modules/config/activity-category.schema';
import { ActivityType, ActivityTypeSchema } from '@/modules/config/activity-type.schema';
import { LeadStatus, LeadStatusSchema } from '@/modules/config/lead-status.schema';
import { RatioDefinition, RatioDefinitionSchema } from '@/modules/config/ratio-definition.schema';
import { ConfigSnapshot, ConfigSnapshotSchema } from '@/modules/config/config-snapshot.schema';
import { configModule } from '../../../test/config-module';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { Product, ProductSchema } from '@/modules/products/product.schema';
import { EventType, EventTypeSchema } from '@/modules/events/event.schema';
import {
  CapabilityCatalog, CapabilityCatalogSchema,
} from '@/modules/capability/capability.schema';
import {
  Campaign, CampaignSchema, QualificationRule, QualificationRuleSchema,
} from '@/modules/campaigns/campaign.schema';
import { CampaignRepository } from '@/modules/campaigns/campaign.repository';
import { CampaignService } from '@/modules/campaigns/campaign.service';
import { ProductService } from '@/modules/products/product.service';
import {
  CompanyTemplate, CompanyTemplateSchema,
} from '@/modules/config/company-template.schema';

const NOW = new Date('2026-09-06T02:00:00Z');

/** Somebody signed in with no office — the only person who may ask for one. */
function asker(userId: string) {
  return new RequestContext(userId, 'none', null);
}
function platform() {
  return RequestContext.platform('u-root');
}

describe('KpmRequestService (P3.1-T2)', () => {
  let service: KpmRequestService;
  let tenants: TenantService;
  let namedTemplates: NamedTemplateService;
  let companyId: string;
  let requesterId: string;

  beforeAll(async () => {
    await startMongo();
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    const companies = mongoose.model(Company.name, CompanySchema);
    const requests = mongoose.model(KpmRequest.name, KpmRequestSchema);
    const users = mongoose.model(User.name, UserSchema);
    const auditModel = mongoose.model(AuditLog.name, AuditLogSchema);
    const memberModel = mongoose.model(Membership.name, MembershipSchema);
    const historyModel = mongoose.model(MembershipHistory.name, MembershipHistorySchema);
    const historyRepo = new MembershipHistoryRepository(historyModel as never);
    const levels = mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema);
    const repo = new MembershipRepository(memberModel as never);
    const clock = new FixedClock(NOW);
    const audit = new AuditService(auditModel as never);

    const orgLevels = new OrgLevelService(levels as never, companies as never, kpms as never, audit, clock);
    const provisioning = new ProvisioningService(
      mongoose.model(ActivityCategory.name, ActivityCategorySchema) as never,
      mongoose.model(ActivityType.name, ActivityTypeSchema) as never,
      mongoose.model(LeadStatus.name, LeadStatusSchema) as never,
      mongoose.model(RatioDefinition.name, RatioDefinitionSchema) as never,
      mongoose.model(ConfigSnapshot.name, ConfigSnapshotSchema) as never,
      mongoose.model(CompanyTemplate.name, CompanyTemplateSchema) as never,
      mongoose.model(TrainingCategory.name, TrainingCategorySchema) as never,
      mongoose.model(TrainingSkill.name, TrainingSkillSchema) as never,
      mongoose.model(TrainingModule.name, TrainingModuleSchema) as never,
      mongoose.model(ActivationTemplate.name, ActivationTemplateSchema) as never,
      mongoose.model(EventType.name, EventTypeSchema) as never,
      mongoose.model(CapabilityCatalog.name, CapabilityCatalogSchema) as never,
      mongoose.model(QualificationRule.name, QualificationRuleSchema) as never,
      new FixedClock(NOW),
      configModule(NOW).config,
      mongoose.model(NamedTemplate.name, NamedTemplateSchema) as never,
    );
    // ADR-0115: approval starts the office from the company's default template.
    namedTemplates = new NamedTemplateService(
      mongoose.model(NamedTemplate.name, NamedTemplateSchema) as never,
      mongoose.model(CompanyTemplate.name, CompanyTemplateSchema) as never,
      companies as never,
      new KpmOfficeCounter(kpms as never),
      audit,
      clock,
    );
    tenants = new TenantService(
      kpms as never, companies as never, users as never, requests as never, audit, clock,
      new HierarchyService(
        repo, kpms as never, users as never, historyRepo, clock, orgLevels,
      ), repo,
      orgLevels,
      provisioning,
      new ProductService(
        mongoose.model(Product.name, ProductSchema) as never,
        companies as never,
        audit,
        clock,
        // P19.4-T4: the offices' rows a delete counts (ADR-0209 §10); not exercised here.
        {} as never,
      ),
      new CampaignService(
        new CampaignRepository(mongoose.model(Campaign.name, CampaignSchema) as never),
        mongoose.model(QualificationRule.name, QualificationRuleSchema) as never,
        kpms as never,
        audit,
        clock,
      ),
      namedTemplates,
    );
    service = new KpmRequestService(
      requests as never, companies as never, users as never, tenants, audit, clock,
    );
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    const company = await mongoose.model(Company.name).create({
      name: 'Prudential', slug: 'prudential', defaultTimezone: 'Asia/Jakarta',
    });
    await seedLadder(String(company._id));
    companyId = String(company._id);
    await namedTemplates.createFirst(RequestContext.platform('root'), company as never);
    const user = await mongoose.model(User.name).create({
      email: 'rangga@example.test', fullName: 'Rangga Wibisono', passwordHash: 'x',
      // Approving a request creates the office and puts the asker in it, so they need
      // the insurer that issued their code (ADR-0017).
      companyId, agentCode: 'PRU-60001',
      // ADR-0190 §4: only a verified address may be made an office's Owner.
      emailVerifiedAt: NOW, phone: '+62 812 3456 7890',
    });
    requesterId = String(user._id);
  });

  const ask = () => ({ companyId, branchName: 'Surabaya Branch', note: 'Twelve agents already here.' });

  describe('asking', () => {
    it('AC-1: records who asked, which company, and what they would call the branch', async () => {
      const row = await service.create(asker(requesterId), ask());

      expect(row).toMatchObject({
        branchName: 'Surabaya Branch',
        companyName: 'Prudential',
        // The prototype writes requester and proposed Owner as one person with one
        // intent — "Rangga Wibisono (proposed KPM Owner)" (`Superadmin.html:329`).
        requestedByName: 'Rangga Wibisono',
        status: 'pending',
      });
      expect(row.createdKpmId).toBeNull();
    });

    it('AC-1: refuses somebody who already has an office', async () => {
      const member = new RequestContext(requesterId, 'none', {
        membershipId: 'mem-1', kpmId: 'kpm-1', orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
        isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      });
      await expect(service.create(member, ask())).rejects.toMatchObject({
        code: 'ORG_AGENT_ALREADY_TAGGED',
      });
    });

    it('allows one open ask at a time, so two approvals cannot make two offices', async () => {
      await service.create(asker(requesterId), ask());
      await expect(service.create(asker(requesterId), ask())).rejects.toMatchObject({
        code: 'TENANT_REQUEST_ALREADY_OPEN',
      });
    });

    it('refuses a company that does not exist, without saying which kind of absent', async () => {
      // An account with no company names one (P19-T2 AC-2); a malformed or unknown one is "not here".
      await mongoose.model(User.name).updateOne({ _id: requesterId }, { $set: { companyId: null } });
      await expect(
        service.create(asker(requesterId), { ...ask(), companyId: 'not-an-id' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('lets the asker read back where their own request stands, and the company a request is for', async () => {
      expect(await service.mine(asker(requesterId))).toEqual({
        request: null, company: { companyId, name: 'Prudential' },
      });
      await service.create(asker(requesterId), ask());
      expect((await service.mine(asker(requesterId))).request).toMatchObject({ status: 'pending' });
    });
  });

    it('keeps an empty note as nothing, not as an empty string', async () => {
      // `note` is optional and free text; a blank one is the absence of a note, and a
      // screen rendering "" would show an empty paragraph where there is no answer.
      const row = await service.create(asker(requesterId), {
        companyId, branchName: 'Medan Branch', note: '   ',
      });
      expect(row.note).toBeNull();
    });

    it('names an unknown company and an unknown asker rather than failing', async () => {
      // Both are soft-deletable and neither is this service's to resurrect. A row that
      // cannot name its company is still a row somebody has to decide.
      const row = await service.create(asker(requesterId), ask());
      await mongoose.model(Company.name).deleteOne({ _id: companyId });
      await mongoose.model(User.name).deleteOne({ _id: requesterId });

      const [seen] = await service.queue(platform().withReader(SOURCE_READER));
      expect(seen).toMatchObject({
        requestId: row.requestId,
        companyName: 'Unknown',
        requestedByName: 'Unknown',
        requestedByEmail: '',
      });
      // P18.10-T7: in the reader's language — the Super Admin reading Bahasa Indonesia reads *Tidak diketahui*.
      const [inIndonesian] = await service.queue(platform().withReader(readerIn('id')));
      expect(inIndonesian).toMatchObject({ companyName: 'Tidak diketahui', requestedByName: 'Tidak diketahui' });
    });

  describe('deciding', () => {
    it('AC-2: approving creates the office and hands it to whoever asked', async () => {
      const row = await service.create(asker(requesterId), ask());
      const [after] = await service.approve(platform(), row.requestId, { code: '0629' });

      expect(after.status).toBe('approved');
      expect(after.createdKpmId).toBeTruthy();

      const kpm = await tenants.readProfile(platform(), after.createdKpmId!);
      expect(kpm.branchName).toBe('Surabaya Branch');
      expect(kpm.code).toBe('0629');
      // The office is theirs, which is what "proposed KPM Owner" means.
      expect(String(kpm.ownerUserId)).toBe(requesterId);
    });

    it('P13.2-T6 AC-7: approving starts the office from the company’s default template', async () => {
      // Moved to a template of its own, so the default is not merely the only one there is.
      const other = await namedTemplates.create(platform(), companyId, { name: 'Surabaya settings', from: 'empty' });
      await namedTemplates.update(platform(), companyId, other.id, { isDefault: true });

      const row = await service.create(asker(requesterId), ask());
      const [after] = await service.approve(platform(), row.requestId, { code: '0629' });

      const stored = await mongoose.model(Kpm.name).findById(after.createdKpmId).lean().exec() as
        { startedFrom: unknown } | null;
      expect(stored?.startedFrom).toEqual({ source: 'template', templateId: other.id, templateName: 'Surabaya settings' });
    });

    it('P19.4-T5 AC-5 approving for a company with no template takes the Mulai dari the card offered', async () => {
      // A company made since ADR-0213 §3 has no template until the Super Admin makes one.
      await mongoose.model(NamedTemplate.name).deleteMany({ companyId }).exec();
      const row = await service.create(asker(requesterId), ask());
      const [after] = await service.approve(platform(), row.requestId, { code: '0629', startFrom: { kind: 'empty' } });

      const stored = await mongoose.model(Kpm.name).findById(after.createdKpmId).lean().exec() as
        { startedFrom: unknown } | null;
      expect(stored?.startedFrom).toEqual({ source: 'empty', templateId: null, templateName: null });
    });

    it('AC-2: declining creates nothing, and keeps the reason', async () => {
      const row = await service.create(asker(requesterId), ask());
      const [after] = await service.decline(platform(), row.requestId, {
        reason: 'This branch already trades under KPM 0417.',
      });

      expect(after).toMatchObject({
        status: 'declined',
        reason: 'This branch already trades under KPM 0417.',
        createdKpmId: null,
      });
      await expect(tenants.listAll(platform())).resolves.toEqual([]);
    });

    it('AC-3: a second decision says which way the first went', async () => {
      const row = await service.create(asker(requesterId), ask());
      await service.approve(platform(), row.requestId, { code: '0629' });

      await expect(
        service.decline(platform(), row.requestId, { reason: 'too late' }),
      ).rejects.toMatchObject({ code: 'TENANT_REQUEST_DECIDED', status: 409 });
    });

    it('AC-3: 404s a request that is not there, malformed id included', async () => {
      await expect(service.approve(platform(), 'not-an-id', { code: '0629' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('frees the asker to try again after a decline', async () => {
      const row = await service.create(asker(requesterId), ask());
      await service.decline(platform(), row.requestId, {});
      // The unique index is scoped to `pending` for exactly this: a refusal should not
      // be a life sentence.
      await expect(service.create(asker(requesterId), ask())).resolves.toMatchObject({
        status: 'pending',
      });
    });
  });

  describe('who may see and decide', () => {
    it('is the platform only — an office cannot read the queue or decide it', async () => {
      const owner = new RequestContext(requesterId, 'none', {
        membershipId: 'mem-1', kpmId: 'kpm-1', orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
        isKpmOwner: true, isKpmAdmin: false, directCount: 0,
      });
      await expect(service.queue(owner)).rejects.toMatchObject({ code: 'PERM_DENIED' });
      await expect(service.approve(owner, 'x', { code: '0629' })).rejects.toMatchObject({
        code: 'PERM_DENIED',
      });
    });

    it('shows the platform the queue, pending first', async () => {
      const other = await mongoose.model(User.name).create({
        email: 'sari@example.test', fullName: 'Sari Handayani', passwordHash: 'x',
        companyId, agentCode: 'PRU-60002',
      });
      const first = await service.create(asker(requesterId), ask());
      await service.create(asker(String(other._id)), { ...ask(), branchName: 'Medan Branch' });
      await service.decline(platform(), first.requestId, {});

      const queue = await service.queue(platform());
      expect(queue.map((r) => r.status)).toEqual(['pending', 'declined']);
    });
  });

  // ------------------------------------------------------------------ Phase 19 (ADR-0191)

  /** A second insurer, with its ladder and its default template: Victor Gunawan's. */
  async function manulife(): Promise<string> {
    const company = await mongoose.model(Company.name).create({
      name: 'Manulife', slug: 'manulife', defaultTimezone: 'Asia/Jakarta',
    });
    await seedLadder(String(company._id));
    await namedTemplates.createFirst(RequestContext.platform('root'), company as never);
    return String(company._id);
  }

  /** Somebody who signed up with a company — verified unless told otherwise. */
  async function applicant(email: string, fullName: string, over: Record<string, unknown> = {}): Promise<string> {
    const user = await mongoose.model(User.name).create({
      email, fullName, passwordHash: 'x', companyId, agentCode: `${Math.floor(Math.random() * 1e8)}`,
      emailVerifiedAt: NOW, ...over,
    });
    return String(user._id);
  }

  const offices = () => mongoose.model(Kpm.name).find({}).lean().exec() as Promise<Array<Record<string, unknown>>>;
  const audits = (action: string) => mongoose.model(AuditLog.name).find({ action }).lean().exec();

  describe('P19-T2 the request carries the applicant’s company (ADR-0191 §1)', () => {
    it('P19-T2 AC-3 saves the request with the company the applicant signed up with, naming none', async () => {
      const row = await service.create(asker(requesterId), { branchName: 'stellar' });
      expect(row).toMatchObject({ companyId, companyName: 'Prudential', branchName: 'stellar' });
    });

    it('P19-T2 AC-3 refuses a request for another company, writing nothing', async () => {
      const other = await manulife();
      await expect(service.create(asker(requesterId), { companyId: other, branchName: 'stellar' }))
        .rejects.toMatchObject({ code: 'TENANT_COMPANY_MISMATCH', status: 409 });
      expect(await mongoose.model(KpmRequest.name).countDocuments()).toBe(0);
    });

    it('P19-T2 AC-2 asks an account with no company to name one, and saves it for the one named', async () => {
      const nobody = await applicant('nobody@example.test', 'No Company', { companyId: null, agentCode: null });
      await expect(service.create(asker(nobody), { branchName: 'stellar' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'companyId' } });
      expect(await service.mine(asker(nobody))).toEqual({ request: null, company: null });
      await expect(service.create(asker(nobody), { companyId, branchName: 'stellar' }))
        .resolves.toMatchObject({ companyId, companyName: 'Prudential' });
    });
  });

  describe('P19-T3 the Super Admin’s requests (ADR-0191 §2–§5)', () => {
    it('P19-T3 AC-1 each row names the applicant: name, email, phone, the company they signed up with, note and date', async () => {
      await service.create(asker(requesterId), ask());
      const [row] = await service.queue(platform());
      expect(row).toMatchObject({
        requestedByName: 'Rangga Wibisono',
        requestedByEmail: 'rangga@example.test',
        requestedByPhone: '+62 812 3456 7890',
        requesterCompanyId: companyId,
        requesterCompanyName: 'Prudential',
        requesterEmailVerified: true,
        companyName: 'Prudential',
        branchName: 'Surabaya Branch',
        note: 'Twelve agents already here.',
        createdKpm: null,
      });
      // The date the card shows: when it was asked, as the database stamped it.
      expect(Number.isNaN(Date.parse(row.requestedAt))).toBe(false);
    });

    it('P19-T3 AC-2 approving with the company corrected on the card makes the office there, and records both', async () => {
      // Production's shape (UI-165): a Manulife applicant whose request arrived as Prudential.
      const other = await manulife();
      const victor = await applicant('victor@example.test', 'Victor Gunawan', { companyId: other });
      const { requestId } = await service.create(asker(victor), { branchName: 'stellar' });
      await mongoose.model(KpmRequest.name).updateOne({ _id: requestId }, { $set: { companyId } });

      const [after] = await service.approve(platform(), requestId, { code: '1001', companyId: other });
      expect(after).toMatchObject({ status: 'approved', companyId: other, companyName: 'Manulife' });
      const kpm = await tenants.readProfile(platform(), after.createdKpmId!);
      expect(kpm).toMatchObject({ companyId: other, code: '1001', ownerUserId: victor });
      const [audit] = await audits('kpm_request.approved');
      expect(audit).toMatchObject({ before: { companyId }, after: { companyId: other, ownerUserId: victor } });
    });

    it('P19-T3 AC-3 one press makes the office and its Owner; pressing again answers the same office, not a second', async () => {
      const { requestId } = await service.create(asker(requesterId), ask());
      const [first] = await service.approve(platform(), requestId, { code: '0629' });
      const [again] = await service.approve(platform(), requestId, { code: '0629' });

      expect(again).toMatchObject({ status: 'approved', createdKpmId: first.createdKpmId });
      expect(again.createdKpm).toEqual({
        kpmId: first.createdKpmId, code: '0629', branchName: 'Surabaya Branch', deleted: false,
      });
      expect(await offices()).toHaveLength(1);
      expect((await offices())[0]).toMatchObject({ ownerUserId: requesterId });
    });

    it('P19-T3 AC-3 an applicant of another company is refused before anything is written', async () => {
      const other = await manulife();
      const victor = await applicant('victor@example.test', 'Victor Gunawan', { companyId: other });
      const { requestId } = await service.create(asker(victor), { branchName: 'stellar' });

      // Approving it as Prudential — the half-made office of UI-165 — is refused, and leaves nothing.
      const refusal = service.approve(platform(), requestId, { code: '1001', companyId });
      await expect(refusal).rejects.toMatchObject({
        code: 'TENANT_COMPANY_MISMATCH', status: 409, details: { userCompanyId: other, kpmCompanyId: companyId },
      });
      await expect(refusal).rejects.toThrow(/Victor Gunawan signed up with Manulife, and this office is Prudential's/);
      expect(await offices()).toEqual([]);
      expect(await mongoose.model(KpmRequest.name).findById(requestId).lean().exec())
        .toMatchObject({ status: 'pending', approvingSince: null, createdKpmId: null });
    });

    it('P19-T3 AC-3 an applicant whose address is not verified is refused before anything is written (ADR-0190 §4)', async () => {
      await mongoose.model(User.name).updateOne({ _id: requesterId }, { $set: { emailVerifiedAt: null } });
      const { requestId } = await service.create(asker(requesterId), ask());
      await expect(service.approve(platform(), requestId, { code: '0629' }))
        .rejects.toMatchObject({ code: 'AUTH_EMAIL_NOT_VERIFIED', status: 409 });
      expect(await offices()).toEqual([]);
    });

    it('P19-T3 AC-3 if the Owner cannot be set, the office is undone, the code is free, and a second press succeeds', async () => {
      const { requestId } = await service.create(asker(requesterId), ask());
      const spy = jest.spyOn(tenants, 'assignOwner').mockRejectedValueOnce(new Error('the Owner could not be set'));

      await expect(service.approve(platform(), requestId, { code: '0629' })).rejects.toThrow('the Owner could not be set');
      const [undone] = await offices();
      expect(undone).toMatchObject({ code: '0629' });
      expect(undone.deletedAt).toEqual(NOW);
      expect(await tenants.listAll(platform())).toEqual([]);
      expect(await mongoose.model(KpmRequest.name).findById(requestId).lean().exec())
        .toMatchObject({ status: 'pending', approvingSince: null, createdKpmId: null });
      expect(await audits('kpm.discarded')).toHaveLength(1);
      // Its configuration went with it.
      expect(await mongoose.model(ActivityType.name).countDocuments({ kpmId: String(undone._id), deletedAt: null })).toBe(0);

      spy.mockRestore();
      const [after] = await service.approve(platform(), requestId, { code: '0629' });
      expect(after).toMatchObject({ status: 'approved' });
      expect((await tenants.listAll(platform())).map((k) => k.code)).toEqual(['0629']);
    });

    it('P19-T3 AC-3 a second press while the first holds the request is refused; a lease past two minutes is taken over', async () => {
      const { requestId } = await service.create(asker(requesterId), ask());
      await mongoose.model(KpmRequest.name).updateOne({ _id: requestId }, { $set: { approvingSince: NOW } });
      await expect(service.approve(platform(), requestId, { code: '0629' }))
        .rejects.toMatchObject({ code: 'TENANT_REQUEST_IN_PROGRESS', status: 409 });
      await expect(service.decline(platform(), requestId, {}))
        .rejects.toMatchObject({ code: 'TENANT_REQUEST_IN_PROGRESS' });
      expect(await offices()).toEqual([]);

      await mongoose.model(KpmRequest.name).updateOne(
        { _id: requestId }, { $set: { approvingSince: new Date(NOW.getTime() - 3 * 60 * 1000) } },
      );
      await expect(service.approve(platform(), requestId, { code: '0629' }))
        .resolves.toMatchObject([{ status: 'approved' }]);
    });

    it('P19-T3 AC-3 an approval that stopped after making the office is finished on that office', async () => {
      const { requestId } = await service.create(asker(requesterId), ask());
      const made = await tenants.createKpm(platform(), { companyId, code: '0629', branchName: 'Surabaya Branch' });
      await mongoose.model(KpmRequest.name).updateOne({ _id: requestId }, { $set: { createdKpmId: made._id } });

      const [after] = await service.approve(platform(), requestId, { code: '0629' });
      expect(after).toMatchObject({ status: 'approved', createdKpmId: made._id });
      expect(await offices()).toHaveLength(1);
      expect((await tenants.readProfile(platform(), made._id)).ownerUserId).toBe(requesterId);
    });

    it('P19-T3 AC-3 a declined request stays declined: approving it is 409 saying so, and makes nothing', async () => {
      const { requestId } = await service.create(asker(requesterId), ask());
      await service.decline(platform(), requestId, { reason: 'duplikat' });
      await expect(service.approve(platform(), requestId, { code: '0629' })).rejects.toMatchObject({
        code: 'TENANT_REQUEST_DECIDED', status: 409, details: { requestId, status: 'declined', decidedAt: NOW.toISOString() },
      });
      expect(await offices()).toEqual([]);
    });

    it('P19-T3 AC-2 a company corrected on the card must be a live insurer: the Template library, a deleted one, a bad id are 404', async () => {
      const library = await mongoose.model(Company.name).create({ name: 'Template library', slug: 'template-library', kind: 'template' });
      const gone = await mongoose.model(Company.name).create({ name: 'Gone Life', slug: 'gone-life', deletedAt: NOW });
      const { requestId } = await service.create(asker(requesterId), ask());
      for (const companyId of [String(library._id), String(gone._id), 'not-an-id']) {
        await expect(service.approve(platform(), requestId, { code: '0629', companyId }))
          .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      }
      expect(await offices()).toEqual([]);
      expect(await mongoose.model(KpmRequest.name).findById(requestId).lean().exec())
        .toMatchObject({ status: 'pending', approvingSince: null, createdKpmId: null });
    });

    it('P19-T3 AC-3 an applicant whose account has gone since asking is 404: there is nobody to make the Owner', async () => {
      const { requestId } = await service.create(asker(requesterId), ask());
      await mongoose.model(User.name).updateOne({ _id: requesterId }, { $set: { deletedAt: NOW } });
      await expect(service.approve(platform(), requestId, { code: '0629' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(await offices()).toEqual([]);
      expect(await mongoose.model(KpmRequest.name).findById(requestId).lean().exec()).toMatchObject({ status: 'pending' });
    });

    it('P19-T3 AC-3 a resumed approval that fails again keeps the office it was finishing; the next press finishes it', async () => {
      const { requestId } = await service.create(asker(requesterId), ask());
      const made = await tenants.createKpm(platform(), { companyId, code: '0629', branchName: 'Surabaya Branch' });
      await mongoose.model(KpmRequest.name).updateOne({ _id: requestId }, { $set: { createdKpmId: made._id } });
      const spy = jest.spyOn(tenants, 'assignOwner').mockRejectedValueOnce(new Error('the Owner could not be set'));

      await expect(service.approve(platform(), requestId, { code: '0629' })).rejects.toThrow('the Owner could not be set');
      spy.mockRestore();
      // This press made no office, so it discards none: the one an earlier press made is still there to finish.
      expect((await offices()).map((k) => [String(k._id), k.deletedAt])).toEqual([[made._id, null]]);
      expect(await audits('kpm.discarded')).toEqual([]);
      expect(await mongoose.model(KpmRequest.name).findById(requestId).lean().exec())
        .toMatchObject({ status: 'pending', approvingSince: null, createdKpmId: made._id });

      const [after] = await service.approve(platform(), requestId, { code: '0629' });
      expect(after).toMatchObject({ status: 'approved', createdKpmId: made._id });
      expect(await offices()).toHaveLength(1);
    });

    it('P19-T2 AC-3 an applicant whose company has since gone reads no company on their own screen', async () => {
      await mongoose.model(Company.name).updateOne({ _id: companyId }, { $set: { deletedAt: NOW } });
      expect(await service.mine(asker(requesterId))).toEqual({ request: null, company: null });
    });

    it('P19-T3 AC-4 a code in use is refused naming the office that holds it, before anything is written', async () => {
      await tenants.createKpm(platform(), { companyId, code: '1001', branchName: 'stellar' });
      const { requestId } = await service.create(asker(requesterId), ask());
      const refusal = service.approve(platform(), requestId, { code: '1001' });
      await expect(refusal).rejects.toMatchObject({
        code: 'TENANT_CODE_TAKEN', status: 409, details: { code: '1001', branchName: 'stellar', companyName: 'Prudential' },
      });
      await expect(refusal).rejects.toThrow('Code 1001 is already used by another KPM at Prudential: KPM 1001 · stellar.');
      expect(await offices()).toHaveLength(1);
    });

    it('P19-T3 AC-3 the decided list says what an approval made, and that it was deleted once it is', async () => {
      const { requestId } = await service.create(asker(requesterId), ask());
      const [after] = await service.approve(platform(), requestId, { code: '0629' });
      await mongoose.model(Kpm.name).updateOne({ _id: after.createdKpmId }, { $set: { deletedAt: NOW } });
      const [row] = await service.queue(platform());
      expect(row.createdKpm).toMatchObject({ code: '0629', deleted: true });
    });

    it('P19-T3 AC-3 declining sends the reason back to the applicant’s own screen', async () => {
      const { requestId } = await service.create(asker(requesterId), ask());
      await service.decline(platform(), requestId, { reason: 'KPM ini sudah ada: 0417.' });
      expect((await service.mine(asker(requesterId))).request).toMatchObject({
        status: 'declined', reason: 'KPM ini sudah ada: 0417.',
      });
    });

    it('P19-T3 AC-7 Hapus removes a wrong or duplicate request, pending or decided, and audits it', async () => {
      const { requestId } = await service.create(asker(requesterId), ask());
      expect(await service.remove(platform(), requestId)).toEqual([]);
      const [audit] = await audits('kpm_request.deleted');
      expect(audit).toMatchObject({ targetId: requestId, before: { status: 'pending', branchName: 'Surabaya Branch' } });
      expect(await mongoose.model(KpmRequest.name).findById(requestId).lean().exec())
        .toMatchObject({ deletedAt: NOW });
      // Gone from the applicant's own screen too, so they may ask again.
      expect((await service.mine(asker(requesterId))).request).toBeNull();
      await expect(service.remove(platform(), requestId)).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const decided = await service.create(asker(requesterId), ask());
      await service.decline(platform(), decided.requestId, { reason: 'duplikat' });
      await expect(service.remove(platform(), decided.requestId)).resolves.toEqual([]);
    });

    it('P19-T3 permissions: an office’s Owner may neither approve with a company, nor remove a request', async () => {
      const owner = new RequestContext(requesterId, 'none', {
        membershipId: 'mem-1', kpmId: 'kpm-1', orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
        isKpmOwner: true, isKpmAdmin: false, directCount: 0,
      });
      await expect(service.remove(owner, 'x')).rejects.toMatchObject({ code: 'PERM_DENIED' });
      await expect(service.approve(owner, 'x', { code: '0629', companyId })).rejects.toMatchObject({ code: 'PERM_DENIED' });
    });
  });
});
