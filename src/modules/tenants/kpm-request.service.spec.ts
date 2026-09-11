import mongoose from 'mongoose';
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
import { ProvisioningService } from '@/modules/config/provisioning.service';
import { ActivityCategory, ActivityCategorySchema } from '@/modules/config/activity-category.schema';
import { ActivityType, ActivityTypeSchema } from '@/modules/config/activity-type.schema';
import { LeadStatus, LeadStatusSchema } from '@/modules/config/lead-status.schema';
import { RatioDefinition, RatioDefinitionSchema } from '@/modules/config/ratio-definition.schema';
import {
  PlatformTemplate, PlatformTemplateSchema,
} from '@/modules/config/platform-template.schema';

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
    const levels = mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema);
    const repo = new MembershipRepository(memberModel as never);
    const clock = new FixedClock(NOW);
    const audit = new AuditService(auditModel as never);

    const orgLevels = new OrgLevelService(levels as never, companies as never, audit, clock);
    const provisioning = new ProvisioningService(
      mongoose.model(ActivityCategory.name, ActivityCategorySchema) as never,
      mongoose.model(ActivityType.name, ActivityTypeSchema) as never,
      mongoose.model(LeadStatus.name, LeadStatusSchema) as never,
      mongoose.model(RatioDefinition.name, RatioDefinitionSchema) as never,
      mongoose.model(PlatformTemplate.name, PlatformTemplateSchema) as never,
    );
    tenants = new TenantService(
      kpms as never, companies as never, users as never, requests as never, audit, clock,
      new HierarchyService(
        repo, kpms as never, users as never, historyModel as never, clock, orgLevels,
      ), repo,
      orgLevels,
      provisioning,
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
        membershipId: 'mem-1', kpmId: 'kpm-1', hierarchyRole: 'agent', status: 'active',
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
        membershipId: 'mem-1', kpmId: 'kpm-1', hierarchyRole: 'ab', status: 'active',
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
