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
import { RecruitmentPlaybookService } from '@/modules/recruitment/recruitment-playbook.service';
import { RecruitmentPlaybook, RecruitmentPlaybookSchema } from '@/modules/recruitment/recruitment-playbook.schema';
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

describe('KpmRequestService (P3.5-T2)', () => {
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
      ),
      new CampaignService(
        new CampaignRepository(mongoose.model(Campaign.name, CampaignSchema) as never),
        mongoose.model(QualificationRule.name, QualificationRuleSchema) as never,
        kpms as never,
        audit,
        clock,
      ),
      namedTemplates,
      // Phase 17: a company started from the defaults is given the recruitment playbook's words.
      new RecruitmentPlaybookService(
        mongoose.model(RecruitmentPlaybook.name, RecruitmentPlaybookSchema) as never,
        companies as never,
        users as never,
        audit,
      ),
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
      await expect(
        service.create(asker(requesterId), { ...ask(), companyId: 'not-an-id' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('lets the asker read back where their own request stands', async () => {
      expect(await service.mine(asker(requesterId))).toBeNull();
      await service.create(asker(requesterId), ask());
      expect(await service.mine(asker(requesterId))).toMatchObject({ status: 'pending' });
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

      const [seen] = await service.queue(platform());
      expect(seen).toMatchObject({
        requestId: row.requestId,
        companyName: 'Unknown',
        requestedByName: 'Unknown',
        requestedByEmail: '',
      });
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
});
