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
import {
  Membership, MembershipDocument, MembershipSchema,
} from '@/modules/org/membership.schema';
import {
  MembershipHistory, MembershipHistorySchema,
} from '@/modules/org/membership-history.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { Company, CompanyDocument, CompanySchema } from './company.schema';
import { KpmRequest, KpmRequestSchema } from './kpm-request.schema';
import { OrgLevelService } from './org-level.service';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from './company-org-level.schema';
import { Kpm, KpmSchema } from './kpm.schema';
import { TenantService } from './tenant.service';
import { clearCollections, seedLadder, startMongo, stopMongo } from '../../../test/mongo';
import { ProvisioningService } from '@/modules/config/provisioning.service';
import { ActivityCategory, ActivityCategorySchema } from '@/modules/config/activity-category.schema';
import { ActivityType, ActivityTypeSchema } from '@/modules/config/activity-type.schema';
import { LeadStatus, LeadStatusSchema } from '@/modules/config/lead-status.schema';
import { RatioDefinition, RatioDefinitionSchema } from '@/modules/config/ratio-definition.schema';
import { ConfigSnapshot, ConfigSnapshotSchema } from '@/modules/config/config-snapshot.schema';
import { configModule } from '../../../test/config-module';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import {
  CompanyTemplate, CompanyTemplateSchema,
} from '@/modules/config/company-template.schema';

const NOW = new Date('2026-09-05T02:00:00Z');

function ctx(opts: { superAdmin?: boolean; owner?: boolean; admin?: boolean; kpmId?: string } = {}) {
  return new RequestContext(
    'u1',
    opts.superAdmin ? 'super_admin' : 'none',
    opts.kpmId || opts.owner || opts.admin
      ? {
          membershipId: 'mem-1',
          kpmId: opts.kpmId ?? 'kpm-x',
          orgLevelCode: 'AB', hierarchyRole: 'ab',
          status: 'active',
          isKpmOwner: opts.owner ?? false,
          isKpmAdmin: opts.admin ?? false, directCount: 0,
        }
      : null,
  );
}

/** Inferring the model type keeps mongoose's generics out of the test's way. */
function userModel() {
  return mongoose.model(User.name, UserSchema);
}

describe('TenantService', () => {
  let service: TenantService;
  let users: ReturnType<typeof userModel>;
  let memberModel: mongoose.Model<MembershipDocument>;
  let companyModel: mongoose.Model<CompanyDocument>;
  let companyId: string;

  beforeAll(async () => {
    await startMongo();
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    companyModel = mongoose.model(Company.name, CompanySchema) as never;
    const companies = companyModel;
    const requests = mongoose.model(KpmRequest.name, KpmRequestSchema);
    const levels = mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema);
    const auditModel = mongoose.model(AuditLog.name, AuditLogSchema);
    users = userModel();
    memberModel = mongoose.model(Membership.name, MembershipSchema) as never;
    const historyModel = mongoose.model(MembershipHistory.name, MembershipHistorySchema);
    const historyRepo = new MembershipHistoryRepository(historyModel as never);
    const repo = new MembershipRepository(memberModel as never);
    const clock = new FixedClock(NOW);
    const orgLevels = new OrgLevelService(
      levels as never, companies as never, kpms as never,
      new AuditService(auditModel as never), clock,
    );
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
      new FixedClock(NOW),
      configModule(NOW).config,
    );
    service = new TenantService(
      kpms as never,
      companies as never,
      users as never,
      requests as never,
      new AuditService(auditModel as never),
      clock,
      new HierarchyService(
        repo, kpms as never, users as never, historyRepo, clock, orgLevels,
      ),
      repo,
      orgLevels,
      provisioning,
    );
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    const company = await mongoose
      .model(Company.name)
      .create({ name: 'Prudential', slug: 'prudential', defaultTimezone: 'Asia/Jakarta' });
    companyId = String(company._id);
    await seedLadder(companyId);
  });

  const input = () => ({ companyId, code: '0417', branchName: 'BSD City Branch' });

  /** A fresh producer id per fixture account: they are unique per company (ADR-0017). */
  let codeSeq = 0;
  const nextCode = () => `PRU-${(codeSeq += 1) + 5000}`;

  /**
   * Seeds a membership straight through the model.
   *
   * The repository refuses a write with no tenant context, which is the whole point of
   * it — a Super Admin building fixtures is not a tenant request. Going around it here
   * is a test-setup shortcut, never something production code may copy.
   */
  const seedMember = (kpmId: string, userId: string, role: 'ab' | 'aab' | 'agent') =>
    mongoose.model(Membership.name).create({
      kpmId, userId, role, status: 'active', agentCode: `${kpmId.slice(-4)}-${userId}`,
      agentSeq: 1, leaderCode: nextCode(), leaderId: null, ancestorIds: [], depth: 0,
      // Required now, and a placeholder is honest here: this helper deliberately skips
      // `HierarchyService`, so nothing about it resolves a real rung. What it exercises
      // is the counting, not the ladder.
      orgLevelId: 'lvl-fixture', orgLevelCode: 'FIXTURE',
    });

  describe('creating a company (P3.5-T14 AC-7)', () => {
    it('refuses a duplicate slug by name, rather than falling through to a 500', async () => {
      // `E11000` is neither a DomainException nor an HttpException, so before this it
      // reached the filter's last branch: HTTP 500, INTERNAL_ERROR, logged as unhandled.
      // The console's own test stubbed a `CONFLICT` code the API could not produce, and
      // the manual promised a message the reader never got.
      await expect(
        service.createCompany(ctx({ superAdmin: true }), { name: 'Prudential Two', slug: 'prudential' }),
      ).rejects.toMatchObject({
        code: 'COMPANY_SLUG_TAKEN',
        status: 409,
      });
    });

    it('names the company that holds the slug, because the reader never chose it', async () => {
      // The form derives the slug now. `Prudential Indonesia` and `Prudential-Indonesia`
      // both land on the same value, and a refusal that only says "taken" leaves the
      // reader with no way to tell what they collided with.
      await expect(
        service.createCompany(ctx({ superAdmin: true }), { name: 'Other', slug: 'prudential' }),
      ).rejects.toMatchObject({ message: expect.stringContaining('Prudential') });
    });

    it('frees the slug once a company is soft-deleted', async () => {
      // A bare `unique: true` reserved it for ever, which invariant 6 forbids: deleting
      // is disabling, and a disabled row must not hold a name nobody can see.
      await mongoose.model(Company.name).updateOne({ slug: 'prudential' }, { $set: { deletedAt: NOW } });
      const revived = await service.createCompany(ctx({ superAdmin: true }), {
        name: 'Prudential Again', slug: 'prudential',
      });
      expect(revived.slug).toBe('prudential');
    });

    it('seeds the three defaults an office inherits, and audits them', async () => {
      const company = await service.createCompany(ctx({ superAdmin: true }), {
        name: 'Allianz', slug: 'allianz',
      });
      expect(company.defaultCurrency).toBe('IDR');
      expect(company.defaultLocale).toBe('id-ID');
      expect(company.defaultTimezone).toBe('Asia/Jakarta');

      const entry = await mongoose
        .model(AuditLog.name)
        .findOne({ action: 'company.created', targetId: String(company._id) })
        .exec();
      // The audit exists *because* offices inherit these. A row that recorded only the
      // two typed fields omitted the thing its own justification named.
      expect(entry?.get('after')).toMatchObject({
        name: 'Allianz', slug: 'allianz',
        defaultCurrency: 'IDR', defaultLocale: 'id-ID', defaultTimezone: 'Asia/Jakarta',
      });
    });

    it.each([
      ['a KPM Owner', ctx({ owner: true })],
      ['a user with no membership', ctx()],
    ])('refuses %s with PERM_DENIED', async (_label, actor) => {
      await expect(
        service.createCompany(actor, { name: 'Nope', slug: 'nope' }),
      ).rejects.toMatchObject({ code: 'PERM_DENIED' });
    });
  });

  describe('only a Super Admin creates a KPM', () => {
    it('allows a Super Admin', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      expect(kpm.code).toBe('0417');
      expect(kpm.status).toBe('active');
      expect(kpm.ownerUserId).toBeNull();
    });

    it.each([
      ['a KPM Owner', ctx({ owner: true })],
      ['a KPM Admin', ctx({ admin: true })],
      ['an AB', ctx({ kpmId: 'kpm-x' })],
      ['a user with no membership', ctx()],
    ])('refuses %s with PERM_DENIED', async (_label, actor) => {
      await expect(service.createKpm(actor, input())).rejects.toMatchObject({
        code: 'PERM_DENIED',
      });
    });
  });

  describe('provisioning', () => {
    it('inherits the company defaults when none are given', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      expect(kpm.timezone).toBe('Asia/Jakarta');
      expect(kpm.currency).toBe('IDR');
    });

    it('seeds the settings every prototype screen hardcodes', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      expect(kpm.settings).toMatchObject({
        activationWindowDays: 90,
        ratioWindowDays: 30,
        onTrackPaceThreshold: 0.9,
        activityDailyMaxCount: 999,
      });
      // Read from the document, not the response. `counters.nextMemberSeq` is the
      // internal agent-code sequence and the read shape deliberately stops carrying it —
      // an office's next code is nobody's business but the server's. The seeding is still
      // an invariant, so it is still asserted, one layer down.
      const stored = await mongoose.model(Kpm.name).findById(kpm._id).exec();
      expect(stored?.get('counters').nextMemberSeq).toBe(1);
    });

    it('P5-T12: records which version of each kind the office was built from', async () => {
      /*
       * One record per kind, each taken from the template that kind's seed actually copied.
       * It was a single pair written from the taxonomy's seed alone, so every other tab of the
       * Company template compared this office against the wrong version.
       */
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());

      const stored = await mongoose.model(Kpm.name).findById(kpm._id).lean().exec() as
        { seededFrom: Record<string, unknown>; seededFromVersion?: unknown } | null;
      // Nothing is published for this company, so every kind came from the platform defaults
      // — a known answer, recorded as a null version rather than left out.
      expect(stored?.seededFrom).toEqual({
        activity_taxonomy: { templateId: null, version: null },
        lead_pipeline: { templateId: null, version: null },
        ratio_set: { templateId: null, version: null },
        // P5-T1: the training taxonomy is seeded, and recorded, like the rest.
        training_taxonomy: { templateId: null, version: null },
        activation_checklist: { templateId: null, version: null },
      });
      expect(stored).not.toHaveProperty('seededFromVersion');
    });

    it('rejects a duplicate code within the same company', async () => {
      await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(service.createKpm(ctx({ superAdmin: true }), input())).rejects.toMatchObject({
        code: 'TENANT_CODE_TAKEN',
      });
    });

    it('allows the same code under a different company', async () => {
      await service.createKpm(ctx({ superAdmin: true }), input());
      const other = await mongoose.model(Company.name).create({ name: 'Allianz', slug: 'allianz' });
      await seedLadder(String(other._id));
      const kpm = await service.createKpm(ctx({ superAdmin: true }), {
        ...input(),
        companyId: String(other._id),
      });
      expect(kpm.code).toBe('0417');
    });

    it('P3.5-T14 AC-7: names the owner rather than handing back their id', async () => {
      // The console rendered `ownerUserId` in a column headed **Owner** — a 24-character
      // hex string where a person's name belongs. The join is the API's to make: no
      // screen can turn a user id into a name.
      const created = await service.createKpm(ctx({ superAdmin: true }), input());
      expect(created.ownerName).toBeNull();
      expect(created.ownerEmail).toBeNull();

      await users.create({
        email: 'owner@kpm0417.test', fullName: 'Rina Wijaya', passwordHash: 'x',
        platformRole: 'none', status: 'active', emailVerifiedAt: NOW, deletedAt: null,
        companyId, agentCode: nextCode(),
      });
      const owned = await service.assignOwner(ctx({ superAdmin: true }), created._id, {
        email: 'owner@kpm0417.test',
      });

      expect(owned.ownerName).toBe('Rina Wijaya');
      expect(owned.ownerEmail).toBe('owner@kpm0417.test');
      // And the id stays: the detail screen shows it deliberately, labelled, for support.
      expect(owned.ownerUserId).toEqual(expect.any(String));
    });

    it('P3.5-T14 AC-7: carries the company name, so no screen joins it client-side', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      expect(kpm.companyName).toBe('Prudential');
    });

    it('P3.5-T14: says an owner is Unknown rather than dropping the office', async () => {
      // An owner whose account has gone is a different problem from an office with no
      // owner, and the screen renders them differently — one is a name, the other is a
      // call to act. Hard-deleting a user should not be able to make an office look
      // unowned.
      const ghost = await users.create({
        email: 'ghost@kpm0417.test', fullName: 'Gone Away', passwordHash: 'x',
        platformRole: 'none', status: 'active', emailVerifiedAt: NOW, deletedAt: null,
        companyId, agentCode: nextCode(),
      });
      const created = await service.createKpm(ctx({ superAdmin: true }), input());
      await mongoose.model(Kpm.name).updateOne(
        { _id: created._id },
        { $set: { ownerUserId: String(ghost._id) } },
      );
      await users.deleteOne({ _id: ghost._id });

      const read = await service.readProfile(ctx({ superAdmin: true }), created._id);
      expect(read.ownerName).toBe('Unknown');
      expect(read.ownerUserId).toBe(String(ghost._id));
    });

    it('P3.5-T14: resolves every owner in one query, not one per office', async () => {
      // The roster is unpaginated. A lookup per row turns a list of offices into a list
      // of round trips, and the pattern this copies (kpm-request.service `rows()`)
      // batches for exactly that reason.
      const owner = await users.create({
        email: 'many@kpm0417.test', fullName: 'Many Offices', passwordHash: 'x',
        platformRole: 'none', status: 'active', emailVerifiedAt: NOW, deletedAt: null,
        companyId, agentCode: nextCode(),
      });
      for (const code of ['0417', '0418', '0419']) {
        const k = await service.createKpm(ctx({ superAdmin: true }), { ...input(), code });
        await mongoose.model(Kpm.name).updateOne(
          { _id: k._id },
          { $set: { ownerUserId: String(owner._id) } },
        );
      }
      const spy = jest.spyOn(users, 'find');
      const all = await service.listAll(ctx({ superAdmin: true }));

      expect(all).toHaveLength(3);
      expect(all.every((k) => k.ownerName === 'Many Offices')).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('P3.5-T14: keeps the internal agent-code sequence off the wire', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      expect(kpm).not.toHaveProperty('counters');
      expect(kpm).not.toHaveProperty('deletedAt');
    });

    it('404s an unknown company rather than creating an orphan tenant', async () => {
      await expect(
        service.createKpm(ctx({ superAdmin: true }), {
          ...input(),
          companyId: new mongoose.Types.ObjectId().toString(),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('ownership', () => {
    async function makeUser(email: string, status: 'active' | 'deactivated' = 'active') {
      const user = await users.create({
        email,
        passwordHash: 'x',
        fullName: email,
        status,
        platformRole: 'none',
        // The insurer that issued their code. Without it no office can place them, which
        // is the point of ADR-0017 and not something a fixture gets to skip.
        companyId,
        agentCode: nextCode(),
      });
      return String(user._id);
    }

    it('assigns an owner and audits it', async () => {
      const owner = await makeUser('owner@kpm0417.test');
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      const updated = await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), {
        userId: owner,
      });
      expect(updated.ownerUserId).toBe(owner);

      const audit = await mongoose.model(AuditLog.name).findOne({ action: 'kpm.owner_assigned' });
      expect(audit).not.toBeNull();
    });

    it('accepts the email a Super Admin actually knows', async () => {
      // §6.1 of roles-and-permissions.md describes this by email. Requiring a Mongo id
      // made the console's own screen unusable — there was no way to learn one from it.
      const owner = await makeUser('owner@kpm0417.test');
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      const updated = await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), {
        email: '  Owner@KPM0417.test ',
      });
      expect(updated.ownerUserId).toBe(owner);
    });

    it('refuses an account that does not exist, instead of storing the string', async () => {
      // The bug this pins: the id was written on trust, so an office could be left
      // pointing at nobody — permanently, and with no one able to administer it.
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(
        service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), {
          email: 'nobody@nowhere.test',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const unchanged = await mongoose.model(Kpm.name).findById(kpm._id);
      expect(unchanged?.get('ownerUserId')).toBeNull();
    });

    it('treats a malformed id as unknown rather than letting Mongoose throw a 500', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(
        service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), { userId: 'not-an-id' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('refuses a deactivated account, which could never sign in to administer anything', async () => {
      await makeUser('gone@kpm0417.test', 'deactivated');
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(
        service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), {
          email: 'gone@kpm0417.test',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('asks for one of the two identifiers rather than silently doing nothing', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(
        service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), {}),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('gives the new Owner a membership, or they cannot reach their own office', async () => {
      // §6.1 creates this on first login. Creating it at assignment means the office is
      // administrable the moment it is assigned, and a context resolves for the Owner.
      const owner = await makeUser('owner@kpm0417.test');
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), { userId: owner });

      const membership = await mongoose
        .model(Membership.name)
        .findOne({ kpmId: String(kpm._id), userId: owner });
      expect(membership?.get('role')).toBe('ab');
      expect(membership?.get('status')).toBe('active');
      expect(membership?.get('leaderId')).toBeNull();
      // Copied off their account, never minted here (ADR-0017). This asserted
      // `KPM0417-001` until 2026-09-08, when the office still issued codes.
      const account = await users.findById(owner);
      expect(membership?.get('agentCode')).toBe(account!.get('agentCode'));
    });

    it('writes the joined history row from the first day, before any screen reads it', async () => {
      const owner = await makeUser('owner@kpm0417.test');
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), { userId: owner });

      const events = await mongoose.model(MembershipHistory.name).find({ kpmId: String(kpm._id) });
      expect(events.map((e) => e.get('eventType'))).toEqual(['joined']);
      expect(events[0].get('validTo')).toBeNull();
    });

    it('does not mint a second membership when ownership returns to a previous owner', async () => {
      // The partial unique index would reject it, and the right answer is the row they
      // already have.
      const first = await makeUser('first@kpm0417.test');
      const second = await makeUser('second@kpm0417.test');
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), { userId: first });
      await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), { userId: second });
      await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), { userId: first });

      const rows = await mongoose.model(Membership.name).find({ kpmId: String(kpm._id), userId: first });
      expect(rows).toHaveLength(1);
    });

    it('records a transfer with both parties', async () => {
      const first = await makeUser('first@kpm0417.test');
      const second = await makeUser('second@kpm0417.test');
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), { userId: first });
      await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), { userId: second });

      const audit = await mongoose.model(AuditLog.name).findOne({ action: 'kpm.owner_transferred' });
      expect(audit?.get('before')).toMatchObject({ ownerUserId: first });
      expect(audit?.get('after')).toMatchObject({ ownerUserId: second });
    });

    it('refuses an Owner transferring ownership themselves', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(
        service.assignOwner(ctx({ owner: true }), String(kpm._id), { email: 'other@kpm.test' }),
      ).rejects.toMatchObject({ code: 'PERM_DENIED' });
    });

    it('refuses to leave a KPM ownerless', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(
        service.clearOwner(ctx({ superAdmin: true }), String(kpm._id)),
      ).rejects.toMatchObject({ code: 'PERM_LAST_OWNER' });
    });
  });

  describe('suspension', () => {
    it('suspends with a reason and a timestamp from the injected clock', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      const s = await service.setStatus(ctx({ superAdmin: true }), String(kpm._id), 'suspended', 'unpaid');
      expect(s.status).toBe('suspended');
      expect(s.suspendedReason).toBe('unpaid');
      // An ISO string, not a Date: the read shape is what crosses the wire, and a Date
      // was only ever going to arrive at the client as this anyway. Asserting the Date
      // was asserting the service's private representation.
      expect(s.suspendedAt).toBe(NOW.toISOString());
    });

    it('clears the suspension detail on reactivation', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await service.setStatus(ctx({ superAdmin: true }), String(kpm._id), 'suspended', 'unpaid');
      const back = await service.setStatus(ctx({ superAdmin: true }), String(kpm._id), 'active');
      expect(back.suspendedAt).toBeNull();
      expect(back.suspendedReason).toBeNull();
    });

    it('refuses suspension by a KPM Owner', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(
        service.setStatus(ctx({ owner: true }), String(kpm._id), 'suspended'),
      ).rejects.toMatchObject({ code: 'PERM_DENIED' });
    });
  });

  describe('reading a tenant profile', () => {
    it('lets an Owner read their own office', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      const read = await service.readProfile(ctx({ owner: true, kpmId: String(kpm._id) }), String(kpm._id));
      expect(read.branchName).toBe('BSD City Branch');
    });

    it('404s another office — never 403, which would confirm it exists', async () => {
      const mine = await service.createKpm(ctx({ superAdmin: true }), input());
      const theirs = await service.createKpm(ctx({ superAdmin: true }), { ...input(), code: '0289' });

      await expect(
        service.readProfile(ctx({ owner: true, kpmId: String(mine._id) }), String(theirs._id)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('lets a Super Admin read any office', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(
        service.readProfile(ctx({ superAdmin: true }), String(kpm._id)),
      ).resolves.toBeDefined();
    });
  });

  describe('the platform overview (P3.5-T1)', () => {
    it('AC-2: is Super Admin only, like everything else on this console', async () => {
      await expect(service.platformOverview(ctx({ owner: true }))).rejects.toMatchObject({
        code: 'PERM_DENIED',
      });
      await expect(service.platformOverview(ctx({ admin: true }))).rejects.toMatchObject({
        code: 'PERM_DENIED',
      });
    });

    it('AC-2: counts companies, offices, members and Agency Builders across every tenant', async () => {
      // ADR-0011 retook ADR-0005 on exactly this: the prototype puts `Total members` and
      // `Agency Builders` on the front page, so aggregate composition is in scope.
      const sa = ctx({ superAdmin: true });
      const kpm = await service.createKpm(sa, input());
      const other = await service.createKpm(sa, { ...input(), code: '0555' });

      await seedMember(String(kpm._id), 'u-a', 'ab');
      await seedMember(String(kpm._id), 'u-b', 'agent');
      await seedMember(String(other._id), 'u-c', 'ab');

      const overview = await service.platformOverview(sa);
      expect(overview.tiles).toEqual({
        companies: 1,
        kpms: 2,
        totalMembers: 3,
        agencyBuilders: 2,
      });
    });

    it('AC-4: gives each company its own office and member totals', async () => {
      const sa = ctx({ superAdmin: true });
      const kpm = await service.createKpm(sa, input());
      await seedMember(String(kpm._id), 'u-a', 'agent');

      const [card] = (await service.platformOverview(sa)).companies;
      expect(card).toMatchObject({ kpmCount: 1, memberCount: 1 });
      expect(card.initials).toHaveLength(2);
    });

    it('AC-1: raises an office with no Owner, because only the platform can fix it', async () => {
      const sa = ctx({ superAdmin: true });
      await service.createKpm(sa, input());

      const { attention } = await service.platformOverview(sa);
      expect(attention).toHaveLength(1);
      expect(attention[0]).toMatchObject({
        tag: 'KPM owner',
        severity: 'structural',
        title: '1 office has no Owner',
      });
    });

    it('I-48: raises a pending KPM request, which is the only way to reach that screen', async () => {
      // P3.5-T2 built the entity, the endpoints and the screen and left this row behind,
      // so `/admin/kpm-requests` was reachable from nowhere — the nav item was still
      // flagged `upcoming`, which renders an anchor with no href.
      const sa = ctx({ superAdmin: true });
      const asker = await users.create({
        email: 'asker@kpm.test', fullName: 'Rangga Wibisono', passwordHash: 'x',
        companyId, agentCode: nextCode(),
      });
      await mongoose.model(KpmRequest.name).create({
        requestedByUserId: String(asker._id), companyId, branchName: 'Surabaya Branch',
        status: 'pending', deletedAt: null,
      });

      const { attention } = await service.platformOverview(sa);
      const row = attention.find((a) => a.tag === 'KPM request');
      expect(row).toMatchObject({
        severity: 'approval',
        title: '1 office is waiting for a decision',
        href: '/admin/kpm-requests',
      });
    });

    it('I-48: counts only the undecided ones', async () => {
      // One pending request per person — `one_open_request_per_user` enforces it — so two
      // pending rows means two people, and a decided one does not stop them asking again.
      const sa = ctx({ superAdmin: true });
      const asks = async (email: string, status: string) => {
        const who = await users.create({ email, fullName: 'Someone', passwordHash: 'x' });
        await mongoose.model(KpmRequest.name).create({
          requestedByUserId: String(who._id), companyId, branchName: 'X',
          status, deletedAt: null,
        });
      };
      await asks('a@kpm.test', 'pending');
      await asks('b@kpm.test', 'pending');
      await asks('c@kpm.test', 'approved');
      await asks('d@kpm.test', 'declined');

      const { attention } = await service.platformOverview(sa);
      expect(attention.find((a) => a.tag === 'KPM request')).toMatchObject({
        title: '2 offices are waiting for a decision',
      });
    });

    it('AC-1: says nothing when there is nothing to say', async () => {
      // The prototype's four rows come from sources that mostly do not exist yet — a
      // ladder request, pending registrations, template adoption, a product publish. An
      // empty queue is the honest answer; four invented rows would read as finished.
      const sa = ctx({ superAdmin: true });
      const kpm = await service.createKpm(sa, input());
      const user = await users.create({
        email: 'o@kpm.test', fullName: 'Owner', passwordHash: 'x',
        companyId, agentCode: nextCode(),
      });
      await service.assignOwner(sa, String(kpm._id), { userId: String(user._id) });

      expect((await service.platformOverview(sa)).attention).toEqual([]);
    });
  });

  describe('the platform admin roster (P3.5-T12)', () => {
    const seedMemberFor = (kpmId: string, userId: string, admin = false) =>
      mongoose.model(Membership.name).create({
        kpmId, userId, role: 'ab', status: 'active', agentCode: `${kpmId.slice(-4)}-${userId}`,
        agentSeq: 1, leaderCode: nextCode(), leaderId: null, ancestorIds: [], depth: 0, orgLevelId: 'lvl-fixture', orgLevelCode: 'FIXTURE',
        ...(admin ? { adminAccess: { isKpmAdmin: true, grantedAt: NOW, grantedByUserId: 'u1', revokedAt: null } } : {}),
      });

    it('AC-2: is Super Admin only', async () => {
      await expect(service.platformAdmins(ctx({ owner: true }))).rejects.toMatchObject({
        code: 'PERM_DENIED',
      });
    });

    it('AC-1: lists the Owner of every office, with which office it is', async () => {
      const sa = ctx({ superAdmin: true });
      const kpm = await service.createKpm(sa, input());
      const owner = await users.create({
        email: 'o@kpm.test', fullName: 'Wilson Tanoto', passwordHash: 'x',
        companyId, agentCode: nextCode(),
      });
      await service.assignOwner(sa, String(kpm._id), { userId: String(owner._id) });

      const [row] = await service.platformAdmins(sa);
      expect(row).toMatchObject({
        fullName: 'Wilson Tanoto',
        isOwner: true,
        isAdmin: false,
        kpmLabel: 'KPM 0417 — BSD City Branch',
      });
      // An Owner's rights come with the office, not from a grant, so there is no date.
      expect(row.grantedAt).toBeNull();
    });

    it('AC-1: lists a delegated Admin with when their access was granted', async () => {
      const sa = ctx({ superAdmin: true });
      const kpm = await service.createKpm(sa, input());
      const person = await users.create({
        email: 'a@kpm.test', fullName: 'Agus Prasetyo', passwordHash: 'x',
        companyId, agentCode: nextCode(),
      });
      await seedMemberFor(String(kpm._id), String(person._id), true);

      const [row] = await service.platformAdmins(sa);
      expect(row).toMatchObject({ fullName: 'Agus Prasetyo', isOwner: false, isAdmin: true });
      expect(row.grantedAt).toBe(NOW.toISOString());
    });

    it('AC-1: an Owner who is also a delegated Admin is one row, not two', async () => {
      const sa = ctx({ superAdmin: true });
      const kpm = await service.createKpm(sa, input());
      const owner = await users.create({
        email: 'both@kpm.test', fullName: 'Both Roles', passwordHash: 'x',
        companyId, agentCode: nextCode(),
      });
      await service.assignOwner(sa, String(kpm._id), { userId: String(owner._id) });
      await mongoose.model(Membership.name).updateOne(
        { kpmId: String(kpm._id), userId: String(owner._id) },
        { $set: { adminAccess: { isKpmAdmin: true, grantedAt: NOW, grantedByUserId: 'u1', revokedAt: null } } },
      );

      const rows = await service.platformAdmins(sa);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ isOwner: true, isAdmin: true });
    });

    it('AC-3: reaches every office, and says nothing when none has an administrator', async () => {
      const sa = ctx({ superAdmin: true });
      await service.createKpm(sa, input());
      // Created, no Owner assigned yet — which is the state the overview raises.
      expect(await service.platformAdmins(sa)).toEqual([]);
    });
  });

  /*
   * These arrive from a URL. Before the Phase 3.5 exit review they reached a raw model
   * with no validation, and Mongoose's CastError is neither a DomainException nor an
   * HttpException — so `GET /admin/tenants/nope` was a 500 logged as an unhandled error
   * for somebody who mistyped a character. `TenantScopedRepository` had already answered
   * this correctly for two phases; these lookups bypass it.
   */
  describe('a malformed id is not found, not a server fault', () => {
    const BAD = 'not-an-objectid';

    it('answers NOT_FOUND on read, assign-owner and set-status alike', async () => {
      const sa = ctx({ superAdmin: true });
      await expect(service.readProfile(sa, BAD)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        service.assignOwner(sa, BAD, { email: 'nobody@agencyboost.test' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(service.setStatus(sa, BAD, 'suspended')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('still refuses before it looks, so the shape of an id cannot skip a permission', async () => {
      // Ordering matters for the same reason it does in the tenant repository: failing
      // closed must not depend on whether the id parses.
      await expect(service.setStatus(ctx({ owner: true }), BAD, 'suspended')).rejects.toMatchObject({
        code: 'PERM_DENIED',
      });
    });
  });

  describe('listing', () => {
    it('is Super Admin only', async () => {
      await expect(service.listAll(ctx({ owner: true }))).rejects.toMatchObject({
        code: 'PERM_DENIED',
      });
      await expect(service.listAll(ctx({ superAdmin: true }))).resolves.toEqual([]);
    });
  });
  describe('branch info (P4-T5)', () => {
    async function anOffice() {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), {
        companyId, code: `${Math.floor(Math.random() * 9000) + 1000}`, branchName: 'BSD City',
      });
      return kpm._id;
    }

    it('changes what the Owner may change, and audits both sides', async () => {
      const id = await anOffice();
      const updated = await service.updateIdentity(ctx({ owner: true, kpmId: id }), id, {
        branchName: 'Serpong Branch',
        address: '  Jl. Raya Serpong  ',
        contactPhone: '',
        fiscalYearStartMonth: 4,
      });

      expect(updated.branchName).toBe('Serpong Branch');
      // Trimmed, and an emptied optional becomes null rather than an empty string — a
      // blank address and an absent one are the same fact and should read alike.
      expect(updated.address).toBe('Jl. Raya Serpong');
      expect(updated.contactPhone).toBeNull();
      expect(updated.fiscalYearStartMonth).toBe(4);
    });

    it('changes it for an Admin too, like every page under Settings (ADR-0027)', async () => {
      const id = await anOffice();
      const updated = await service.updateIdentity(ctx({ admin: true, kpmId: id }), id, {
        branchName: 'Serpong Branch',
      });
      expect(updated.branchName).toBe('Serpong Branch');
    });

    it('refuses a Super Admin, who writes no office\u2019s settings (ADR-0027)', async () => {
      // The company's template is theirs; an office's copy is the office's.
      const id = await anOffice();
      await expect(
        service.updateIdentity(ctx({ superAdmin: true }), id, { branchName: 'From the platform' }),
      ).rejects.toMatchObject({ code: 'PERM_DENIED' });
    });

    it('refuses another office as a 404, never a 403', async () => {
      // A 403 would confirm the id is real, which is itself tenant information.
      const mine = await anOffice();
      const theirs = await anOffice();
      await expect(
        service.updateIdentity(ctx({ owner: true, kpmId: mine }), theirs, { branchName: 'Theirs' }),
      ).rejects.toThrow('KPM');
    });

    it('refuses an empty change rather than writing an audit row about nothing', async () => {
      const id = await anOffice();
      await expect(
        service.updateIdentity(ctx({ owner: true, kpmId: id }), id, {}),
      ).rejects.toThrow('Nothing to change');
    });

    it('refuses an office that does not exist', async () => {
      // A membership naming an office that has since gone — the only way to reach the read
      // now that no platform grant passes the permission.
      const ghost = '66f0000000000000000000ff';
      await expect(
        service.updateIdentity(ctx({ owner: true, kpmId: ghost }), ghost, { branchName: 'Ghost' }),
      ).rejects.toThrow('KPM');
    });
  });

  describe('companies', () => {
    it('lists them to a Super Admin and to nobody else', async () => {
      await expect(service.listCompanies(ctx({ owner: true }))).rejects.toMatchObject({
        code: 'PERM_DENIED',
      });
      await expect(service.listCompanies(ctx({ superAdmin: true }))).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ _id: expect.anything() })]),
      );
    });

    it('names the holder when a slug is taken', async () => {
      // The refusal says who has it, because "taken" without a name sends somebody
      // hunting through a list they may not be able to see.
      const sa = ctx({ superAdmin: true });
      await service.createCompany(sa, { name: 'Allianz Indonesia', slug: 'allianz-indonesia' });
      await expect(
        service.createCompany(sa, { name: 'Allianz Indonesia', slug: 'allianz-indonesia' }),
      ).rejects.toMatchObject({ code: 'COMPANY_SLUG_TAKEN' });
    });

    it('lists insurers to somebody with no account, by name only', async () => {
      /*
       * A projection rather than a filter on the way out: a field added to `companies`
       * later cannot leak through this route by default, which is the difference between
       * an allowlist and a habit.
       */
      const rows = await service.listCompaniesForRegistration();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(['_id', 'name']);
      }
    });
  });

  describe('the Owner’s own membership', () => {
    async function anOffice() {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), {
        companyId, code: `${Math.floor(Math.random() * 9000) + 1000}`, branchName: 'Owner Branch',
      });
      return kpm._id;
    }

    async function aPerson(email: string) {
      return users.create({
        email, fullName: 'Owner Person', passwordHash: 'x', platformRole: 'none',
        status: 'active', emailVerifiedAt: NOW, deletedAt: null,
        companyId, agentCode: nextCode(),
      });
    }

    it('activates a pending membership rather than minting a second one', async () => {
      /*
       * The partial unique index would reject a second row, and the right answer is the
       * one they already have. An Owner assigned to an office they had asked to join is
       * the ordinary path into this branch.
       */
      const kpmId = await anOffice();
      const person = await aPerson(`pending-owner-${Math.random()}@kpm.test`);
      const sa = ctx({ superAdmin: true });

      await service.assignOwner(sa, kpmId, { userId: String(person._id) });
      const first = await memberModel.findOne({ userId: String(person._id), kpmId }).exec();
      expect(first?.status).toBe('active');

      // Set it back to pending and assign again: the row is reused, not duplicated.
      await memberModel.updateOne({ _id: first!._id }, { $set: { status: 'pending' } }).exec();
      await service.assignOwner(sa, kpmId, { userId: String(person._id) });

      const rows = await memberModel.find({ userId: String(person._id), kpmId }).exec();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('active');
    });

    it('leaves an already-active membership exactly as it is', async () => {
      // An office may promote its Owner's account through the ranks like anybody else's,
      // and re-assigning ownership must not quietly demote them.
      const kpmId = await anOffice();
      const person = await aPerson(`active-owner-${Math.random()}@kpm.test`);
      const sa = ctx({ superAdmin: true });

      await service.assignOwner(sa, kpmId, { userId: String(person._id) });
      const before = await memberModel.findOne({ userId: String(person._id), kpmId }).exec();
      await memberModel.updateOne({ _id: before!._id }, { $set: { role: 'ab' } }).exec();

      await service.assignOwner(sa, kpmId, { userId: String(person._id) });

      const after = await memberModel.findOne({ userId: String(person._id), kpmId }).exec();
      expect(after?.role).toBe('ab');
      expect(after?.joinedAt).toEqual(before?.joinedAt);
    });
  });

  describe('the races and the edges', () => {
    it('answers the index, not only the pre-check, when two creates collide', async () => {
      /*
       * The pre-check reads and then writes, so two callers can both read "free". The
       * index is what actually decides, and `E11000` is neither a DomainException nor an
       * HttpException — without this branch it renders as INTERNAL_ERROR and is logged as
       * unhandled, for something a user did on purpose.
       *
       * Forced rather than raced: two concurrent creates are a coin toss about which
       * guard fires, and a test that passes four times in five is worse than none.
       */
      const sa = ctx({ superAdmin: true });
      const collide = jest
        .spyOn(companyModel, 'create')
        .mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }));

      await expect(
        service.createCompany(sa, { name: 'Prudential', slug: 'prudential' }),
      ).rejects.toMatchObject({ code: 'COMPANY_SLUG_TAKEN' });

      collide.mockRestore();
    });

    it('rethrows a write failure that is not a duplicate', async () => {
      // Swallowing everything here would turn a connection fault into "that slug is
      // taken", and somebody would spend an afternoon renaming a company.
      const sa = ctx({ superAdmin: true });
      const broken = jest
        .spyOn(companyModel, 'create')
        .mockRejectedValueOnce(new Error('connection reset'));

      await expect(
        service.createCompany(sa, { name: 'Manulife', slug: 'manulife' }),
      ).rejects.toThrow('connection reset');

      broken.mockRestore();
    });

    it('reads a malformed office id as not-here, not as a 500', async () => {
      // These arrive from a URL. An uncaught CastError is INTERNAL_ERROR and a log line
      // about an unhandled error, which is the wrong story about a typo.
      await expect(
        service.updateIdentity(ctx({ owner: true, kpmId: 'not-an-id' }), 'not-an-id', {
          branchName: 'X',
        }),
      ).rejects.toThrow('KPM');
    });

    it('orders the platform admin roster by office, then owner, then name', async () => {
      /*
       * Three keys, and the second is the one worth having: an office's Owner above its
       * Admins answers the question the screen is for — who runs this one, and who else
       * can act in it.
       */
      const sa = ctx({ superAdmin: true });
      const kpm = await service.createKpm(sa, {
        companyId, code: `${Math.floor(Math.random() * 9000) + 1000}`, branchName: 'Sorted',
      });

      const owner = await users.create({
        email: `zzz-owner-${Math.random()}@kpm.test`, fullName: 'Zed Owner', passwordHash: 'x',
        platformRole: 'none', status: 'active', emailVerifiedAt: NOW, deletedAt: null,
        companyId, agentCode: nextCode(),
      });
      await service.assignOwner(sa, kpm._id, { userId: String(owner._id) });

      const admin = await users.create({
        email: `aaa-admin-${Math.random()}@kpm.test`, fullName: 'Ann Admin', passwordHash: 'x',
        platformRole: 'none', status: 'active', emailVerifiedAt: NOW, deletedAt: null,
        companyId, agentCode: nextCode(),
      });
      const adminMembership = await memberModel.create({
        kpmId: kpm._id, userId: String(admin._id), role: 'ab', orgLevelId: 'lvl-ab',
        orgLevelCode: 'AB', agentCode: nextCode(), agentSeq: 99,
        leaderCode: `LC${Math.floor(Math.random() * 100000)}`, status: 'active',
        adminAccess: { isKpmAdmin: true, grantedByUserId: 'u1', grantedAt: NOW, revokedAt: null },
      } as never);
      void adminMembership;

      const rows = (await service.platformAdmins(sa))
        .filter((r: { kpmLabel: string }) => r.kpmLabel.includes('Sorted'));

      // The Owner first despite sorting after the Admin by name.
      expect(rows.map((r: { fullName: string }) => r.fullName))
        .toEqual(['Zed Owner', 'Ann Admin']);
    });
  });

});
