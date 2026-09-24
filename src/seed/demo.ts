/**
 * Seeds a demo tenant so the API and the screens can actually be exercised.
 *
 * The cast is chosen to make **states** reachable, not to look populous. Every account
 * below exists because some behaviour is only visible through it: a childless AAB for
 * leadership-by-graph (OD-23), a pending member for the join gate, a removed one for
 * what survives leaving, a second office for isolation, and a suspended office for the
 * error that is deliberately distinct from a permission failure.
 *
 * Activity, leads and production arrive as Phases 6–9 create their collections. This
 * grows with them rather than pretending to be the full fixture now.
 *
 *   pnpm seed:demo            create, leaving anything that already exists
 *   pnpm seed:demo --reset    empty the collections it owns first
 */
import 'reflect-metadata';
import mongoose from 'mongoose';
import { config as loadEnv } from 'dotenv';
import { SystemClock } from '@/common/clock/clock.port';
import { PasswordService } from '@/modules/auth/password.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Product, ProductSchema } from '@/modules/products/product.schema';
import {
  KpmProductConfig, KpmProductConfigSchema,
} from '@/modules/products/kpm-product-config.schema';
import { Event, EventSchema, EventType, EventTypeSchema } from '@/modules/events/event.schema';
import {
  Campaign, CampaignSchema, QualificationRule, QualificationRuleSchema,
} from '@/modules/campaigns/campaign.schema';
import {
  CapabilityCatalog, CapabilityCatalogSchema,
} from '@/modules/capability/capability.schema';
import {
  capabilitySeedDocument, defaultCapabilityLadder,
} from '@/modules/capability/capability-payload';
import { DEFAULT_ORG_LADDER } from '@/domain/constants';
import {
  CompanyOrgLevel, CompanyOrgLevelSchema,
} from '@/modules/tenants/company-org-level.schema';
import { DEFAULT_KPM_SETTINGS, Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { generateLeaderCode } from '@/modules/org/leader-code';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import {
  MembershipHistory, MembershipHistorySchema,
} from '@/modules/org/membership-history.schema';
import { Group, GroupSchema } from '@/modules/org/group.schema';
import { JoinRequest, JoinRequestSchema } from '@/modules/org/join-request.schema';
import { KpmRequest, KpmRequestSchema } from '@/modules/tenants/kpm-request.schema';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { Notification, NotificationSchema } from '@/modules/notifications/notification.schema';
import {
  SEED_ACTIVITY_CATEGORIES, SEED_ACTIVITY_TYPES, SEED_EVENT_TYPES, SEED_LEAD_STATUSES,
  SEED_MOC_RULES, SEED_PRODUCTION_CLUB_TIERS, SEED_PRODUCTS, SEED_RATIO_DEFINITIONS,
  metricByKey,
} from '@/domain/constants';
import {
  ActivityCategory, ActivityCategorySchema,
} from '@/modules/config/activity-category.schema';
import { ActivityType, ActivityTypeSchema } from '@/modules/config/activity-type.schema';
import { LeadStatus, LeadStatusSchema } from '@/modules/config/lead-status.schema';
import {
  RatioDefinition, RatioDefinitionSchema,
} from '@/modules/config/ratio-definition.schema';
import { ConfigSnapshot, ConfigSnapshotSchema } from '@/modules/config/config-snapshot.schema';
import {
  TrainingCategory, TrainingCategorySchema,
} from '@/modules/training/training-category.schema';
import { TrainingSkill, TrainingSkillSchema } from '@/modules/training/training-skill.schema';
import { TrainingModule, TrainingModuleSchema } from '@/modules/training/training-module.schema';
import {
  defaultTrainingTaxonomy, trainingSeedDocuments,
} from '@/modules/training/training-payload';
import {
  ActivationTemplate, ActivationTemplateSchema,
} from '@/modules/activation/activation-template.schema';
import {
  activationSeedAspects, defaultActivationChecklist,
} from '@/modules/activation/activation-payload';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import {
  CompanyTemplate, CompanyTemplateSchema,
} from '@/modules/config/company-template.schema';

loadEnv();

/**
 * One password for every field account, so the sign-in panel stays readable. The three
 * that predate this keep their own, because the documentation quotes them.
 */
const FIELD_PASSWORD = 'demo password field';

type Role = 'ab' | 'aab' | 'agent';

interface Placed {
  id: string;
  ancestorIds: string[];
  depth: number;
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME ?? 'agencyboost';
  if (!uri) {
    console.error('MONGODB_URI is not set. Copy .env.example to .env and fill in your Atlas string.');
    process.exit(1);
  }

  await mongoose.connect(uri, { dbName });
  const passwords = new PasswordService();
  const clock = new SystemClock();

  const Users = mongoose.model(User.name, UserSchema);
  const Companies = mongoose.model(Company.name, CompanySchema);
  const OrgLevels = mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema);
  const Kpms = mongoose.model(Kpm.name, KpmSchema);
  const ActivityCategories = mongoose.model(ActivityCategory.name, ActivityCategorySchema);
  const ActivityTypes = mongoose.model(ActivityType.name, ActivityTypeSchema);
  const LeadStatuses = mongoose.model(LeadStatus.name, LeadStatusSchema);
  const RatioDefinitions = mongoose.model(RatioDefinition.name, RatioDefinitionSchema);
  const ConfigSnapshots = mongoose.model(ConfigSnapshot.name, ConfigSnapshotSchema);
  const TrainingCategories = mongoose.model(TrainingCategory.name, TrainingCategorySchema);
  const TrainingSkills = mongoose.model(TrainingSkill.name, TrainingSkillSchema);
  const TrainingModules = mongoose.model(TrainingModule.name, TrainingModuleSchema);
  const ActivationTemplates = mongoose.model(ActivationTemplate.name, ActivationTemplateSchema);
  const Products = mongoose.model(Product.name, ProductSchema);
  const KpmProductConfigs = mongoose.model(KpmProductConfig.name, KpmProductConfigSchema);
  const EventTypes = mongoose.model(EventType.name, EventTypeSchema);
  const Events = mongoose.model(Event.name, EventSchema);
  const Campaigns = mongoose.model(Campaign.name, CampaignSchema);
  const QualificationRules = mongoose.model(QualificationRule.name, QualificationRuleSchema);
  const CompanyTemplates = mongoose.model(CompanyTemplate.name, CompanyTemplateSchema);
  const CapabilityCatalogs = mongoose.model(CapabilityCatalog.name, CapabilityCatalogSchema);
  const Memberships = mongoose.model(Membership.name, MembershipSchema);
  const History = mongoose.model(MembershipHistory.name, MembershipHistorySchema);
  const Groups = mongoose.model(Group.name, GroupSchema);
  const JoinRequests = mongoose.model(JoinRequest.name, JoinRequestSchema);
  const KpmRequests = mongoose.model(KpmRequest.name, KpmRequestSchema);
  const Audit = mongoose.model(AuditLog.name, AuditLogSchema);
  const Notifications = mongoose.model(Notification.name, NotificationSchema);

  if (process.argv.includes('--reset')) {
    // Empty the collections rather than drop the database. An Atlas user with ordinary
    // read/write permissions cannot `dropDatabase` — the seed failed outright against
    // one — and emptying named collections will not take out a database someone pointed
    // at by mistake.
    const owned = [
      'memberships', 'membershipHistory', 'joinRequests', 'groups', 'kpms', 'companies', 'users',
      'authTokens', 'auditLog', 'notifications', 'notificationPreferences', 'assets',
      'kpmRequests',
      // Phase 4 configuration. Without these a `--reset` leaves the previous run's
      // taxonomy behind, orphaned against office ids that no longer exist — so every
      // settings screen renders another run's rows and the publish bar compares versions
      // across two different offices.
      'activityCategories', 'activityTypes', 'leadStatuses', 'ratioDefinitions',
      'configSnapshots',
      // Phase 5. `products` is the company's rather than the office's, and it is cleared for
      // the same reason: a previous run's shelf orphaned against a company id that no longer
      // exists renders as an empty Products tab on a company that should have 31.
      'trainingCategories', 'trainingSkills', 'trainingModules', 'activationTemplates',
      'companyTemplates', 'products', 'kpmProductConfigs', 'eventTypes', 'events',
      'campaigns', 'qualificationRules', 'capabilityCatalogs', 'activityLogs',
    ];
    for (const name of owned) {
      const { deletedCount } = await mongoose.connection.collection(name).deleteMany({});
      if (deletedCount) console.log(`cleared ${deletedCount} from ${name}`);
      /*
       * **And the indexes.** Emptying a collection leaves its indexes exactly as they
       * were, so a database seeded before a schema change keeps enforcing the old shape —
       * `memberships { kpmId, agentCode }` was unique until ADR-0017, and a reseed hit
       * `E11000` on the member who leaves and rejoins. Mongoose rebuilds what the schema
       * says on the next write. A deployed database gets the same thing from migration
       * `0002`; this is `--reset` meaning reset.
       */
      await mongoose.connection.collection(name).dropIndexes().catch(() => undefined);
    }
    console.log(`reset ${dbName}`);
  }

  /** Idempotent: running the seed twice must not mint a second of anything. */
  /**
   * A person, and the insurer that issued them a code.
   *
   * `companyId` and `agentCode` are on the account, not the membership (ADR-0017): the
   * code is the insurer's and it exists before any office admits them. A Super Admin
   * sells for nobody and carries neither, which is the pair the unique index excludes.
   *
   * The codes below deliberately do **not** look like `KPM0417-001`. That format was ours
   * and it is gone; a real Prudential producer id is what a demo should show.
   */
  let issued = 0;
  async function user(
    email: string,
    fullName: string,
    opts: {
      password?: string;
      platformRole?: 'super_admin' | 'none';
      status?: string;
      companyId?: string;
      agentCode?: string;
    } = {},
  ) {
    const existing = await Users.findOne({ email }).exec();
    if (existing) return existing;
    const platformRole = opts.platformRole ?? 'none';
    const sellsForSomebody = platformRole !== 'super_admin';
    issued += 1;
    return Users.create({
      email,
      passwordHash: await passwords.hash(opts.password ?? FIELD_PASSWORD),
      fullName,
      platformRole,
      companyId: sellsForSomebody ? (opts.companyId ?? String(prudential._id)) : null,
      agentCode: sellsForSomebody
        ? (opts.agentCode ?? `PRU-${String(80000 + issued)}`)
        : null,
      status: opts.status ?? 'active',
      // Pre-verified: the point of a demo tenant is to sign in, not to chase an inbox.
      emailVerifiedAt: clock.now(),
    });
  }

  async function company(name: string, slug: string) {
    const row = (
      (await Companies.findOne({ slug }).exec()) ??
      (await Companies.create({
        name, slug,
        defaultCurrency: 'IDR', defaultLocale: 'id-ID', defaultTimezone: 'Asia/Jakarta',
      }))
    );
    await seedProducts(String(row._id));
    await seedCarrierRules(String(row._id));
    return row;
  }

  /**
   * A published Company template of one kind (P5-T9).
   *
   * Published rather than drafted, so the tab reads *"New offices start from version 1"* rather
   * than *"Nothing is published yet"* — and so the two companies below differ in a way somebody
   * can see on screen without creating an office first.
   */
  async function publishTemplate(
    companyId: string, kind: string, payload: Record<string, unknown>,
  ) {
    if (await CompanyTemplates.exists({ companyId, kind })) return;
    await CompanyTemplates.create({
      companyId, kind, version: 1, status: 'published', payload,
      publishedAt: new Date(clock.now().getTime() - 7 * 24 * 60 * 60 * 1000),
      deletedAt: null, createdBy: null, updatedBy: null,
    });
  }

  /**
   * The company's product catalog (P5-T4), as `TenantService.createCompany` gives a real one.
   *
   * Mirrored here rather than called, for the reason the office presets below are: this file
   * writes documents and owns no Nest container. The **values** come from `@/domain/constants`,
   * so there is one catalog and this is a second copy of the call, not of the shelf.
   *
   * Without it the Company template's Products tab renders an empty catalog on the one company
   * the demo has — which is what the P5-T4 browser walk found.
   */
  /**
   * MOC and the production club tiers (P5-T7, ADR-0026), as `TenantService.createCompany` gives a
   * real company. Mirrored rather than called for the same reason the office presets are: this file
   * writes documents and owns no Nest container, and the **values** come from `@/domain/constants`.
   */
  async function seedCarrierRules(companyId: string) {
    if (await QualificationRules.exists({ companyId })) return;

    await QualificationRules.insertMany([
      ...SEED_PRODUCTION_CLUB_TIERS.map((tier) => ({
        companyId, scope: 'company', kind: 'production_club',
        code: tier.code, name: tier.name, appliesToOrgLevelCodes: [],
        criteriaGroups: [{
          mode: 'all',
          criteria: [{
            metricKey: 'APE_ACHIEVED', comparator: 'gte',
            value: tier.minAnnualApe, unit: 'idr_minor',
          }],
        }],
        groupMode: 'all', reward: tier.reward, rank: tier.rank,
        waitingOnMetrics: [], effectiveFrom: null, effectiveTo: null, deletedAt: null,
      })),
      ...SEED_MOC_RULES.map((rule, index) => {
        const criteriaGroups = rule.criteriaGroups.map((group) => ({
          mode: group.mode,
          criteria: group.criteria.map((c) => ({
            metricKey: c.metricKey, comparator: c.comparator, value: c.value,
            unit: metricByKey(c.metricKey)?.unit ?? (c.value > 1_000_000 ? 'idr_minor' : 'count'),
          })),
        }));
        return {
          companyId, scope: 'company', kind: 'moc',
          code: rule.code, name: rule.name,
          appliesToOrgLevelCodes: [...rule.appliesToOrgLevelCodes],
          criteriaGroups, groupMode: rule.groupMode, reward: '', rank: index + 1,
          // The inputs the registry does not define yet, so the screen can say what it is waiting
          // on rather than showing a rule nobody can ever pass.
          waitingOnMetrics: [...new Set(
            criteriaGroups.flatMap((g) => g.criteria).map((c) => c.metricKey)
              .filter((key) => metricByKey(key) === undefined),
          )],
          effectiveFrom: null, effectiveTo: null, deletedAt: null,
        };
      }),
    ]);
  }

  async function seedProducts(companyId: string) {
    if (await Products.exists({ companyId })) return;
    await Products.insertMany(SEED_PRODUCTS.map((product) => ({
      ...product,
      companyId,
      // Never seeded: a company states its own rates (parity F-15).
      commissionSchedule: [],
      replacedByProductId: null,
      lifecycleChangedAt: null,
      lifecycleChangedBy: null,
      version: 1,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
    })));
  }

  async function office(
    companyId: string,
    code: string,
    branchName: string,
    opts: { ownerUserId?: string; status?: string; address?: string } = {},
  ) {
    const existing = await Kpms.findOne({ companyId, code }).exec();
    if (existing) return existing;
    return Kpms.create({
      companyId,
      code,
      branchName,
      address: opts.address ?? null,
      ownerUserId: opts.ownerUserId ?? null,
      timezone: 'Asia/Jakarta',
      settings: { ...DEFAULT_KPM_SETTINGS },
      counters: { nextAgentCodeSeq: 1 },
      status: opts.status ?? 'active',
    });
  }

  /**
   * Copy the whole Phase 4 configuration into an office, the way creating one does.
   *
   * The seed builds offices through the model rather than through `TenantService`, so
   * nothing had ever run `ProvisioningService` over them: every seeded office had no
   * activity types, no ratios and no lead statuses, and all three settings screens were
   * empty in a database whose whole purpose is to make screens exercisable.
   *
   * This mirrors what provisioning writes rather than calling it, because the service
   * wants a Nest container and the seed is a script. The shapes are asserted against each
   * other by `provisioning.tenancy.spec.ts`; what is duplicated here is the *call*, not
   * the values, which come from `@/domain/constants` exactly as provisioning's do.
   */
  /** Which insurer an office belongs to — the decisions below are about that company's shelf. */
  async function companyOf(kpmId: string): Promise<string> {
    const kpm = await Kpms.findById(kpmId).select('companyId').lean().exec();
    return String((kpm as { companyId?: string } | null)?.companyId ?? '');
  }

  /**
   * Everything one office starts with.
   *
   * **Guarded per collection, not once for the whole function.** It used to return early when the
   * office already had activity types, so every collection a later phase added — event types,
   * events, campaigns, product decisions — was skipped on any database that had been seeded
   * before. The seed reported success and wrote nothing, and the screens for those features were
   * empty with no way to tell that from broken.
   *
   * "Has activity types" was never the same question as "has event types". Each block now asks
   * its own.
   */
  async function configure(kpmId: string) {
    const missing = async (model: { exists: (f: object) => Promise<unknown> }) =>
      !(await model.exists({ kpmId }));

    if (await missing(ActivityTypes as never)) {
    await ActivityCategories.insertMany(SEED_ACTIVITY_CATEGORIES.map((c) => ({
      kpmId, code: c.code, label: c.label, displayOrder: c.displayOrder,
      version: 1, status: 'active', archivedAt: null, deletedAt: null,
    })));
    await ActivityTypes.insertMany(SEED_ACTIVITY_TYPES.map((t) => ({
      kpmId, code: t.code, categoryCode: t.categoryCode, label: t.label,
      description: t.description ?? null, displayOrder: t.displayOrder,
      version: 1, status: 'active', archivedAt: null, deletedAt: null,
    })));
    await LeadStatuses.insertMany(SEED_LEAD_STATUSES.map((l) => ({
      kpmId, pipeline: l.pipeline, code: l.code, label: l.label, rank: l.rank,
      isTerminal: l.isTerminal, isLateStage: l.isLateStage,
      version: 1, status: 'active', archivedAt: null, deletedAt: null,
    })));
    await RatioDefinitions.insertMany(SEED_RATIO_DEFINITIONS.map((r) => ({
      kpmId, code: r.code, label: r.label,
      numerator: [...r.numerator], denominator: [...r.denominator],
      benchmark: r.benchmark, comparison: r.comparison, displayUnit: r.displayUnit,
      displayOrder: r.displayOrder,
      origin: 'platform',
      standardNumerator: [...r.numerator], standardDenominator: [...r.denominator],
      appliesToOrgLevelCodes: [...(r.appliesToOrgLevelCodes ?? [])],
      version: 1, status: 'active', archivedAt: null, deletedAt: null,
    })));
    }

    // The training taxonomy (P5-T1), through the helper provisioning and migration 0011 use.
    if (await missing(TrainingModules as never)) {
      const training = trainingSeedDocuments(kpmId, defaultTrainingTaxonomy());
      await TrainingCategories.insertMany(training.categories);
      await TrainingSkills.insertMany(training.skills);
      await TrainingModules.insertMany(training.modules);
    }

    // The event types a new office is provisioned with (P5-T6). Without them the Events
    // screen opens empty and says an office has nothing to file an event under.
    if (await missing(EventTypes as never)) {
      await EventTypes.insertMany(SEED_EVENT_TYPES.map((type, index) => ({
      kpmId, code: type.code, label: type.label, description: null,
      emoji: type.emoji, color: type.color, displayOrder: index + 1,
      version: 1, status: 'active', archivedAt: null, deletedAt: null,
        createdBy: null, updatedBy: null,
      })));
    }

    /*
     * Three events, one in each phase (P5-T6).
     *
     * Dated **relative to the seeded clock**, so the demo always has something upcoming, something
     * running and something past. A fixed date would drift into all-past within a month and the
     * phase badge — the thing this task exists to get right — would stop being demonstrable.
     */
    const day = 86_400_000;
    const at = (offsetDays: number, hours: number) =>
      new Date(clock.now().getTime() + offsetDays * day + hours * 3_600_000);
    if (await missing(Events as never)) {
    await Events.insertMany([
      {
        kpmId, code: 'KICKOFF', typeCode: 'TRAINING', title: 'Kickoff 2026',
        blurb: 'What the year looks like, and what we are measured on.',
        description: '', startsAt: at(14, 2), endsAt: at(14, 6), location: 'Kantor KPM',
        locationUrl: null,
        audience: { issuer: 'kpm', scope: 'all_agents', inviteeMembershipIds: [] },
      },
      {
        kpmId, code: 'LEADERS_HUDDLE', typeCode: 'RECOGNITION',
        title: 'Leaders’ huddle', blurb: 'Unit numbers, and who needs help this month.',
        description: '', startsAt: at(0, -1), endsAt: at(0, 2), location: 'Ruang rapat',
        locationUrl: null,
        // Leaders by the graph, never by job title — which is what makes this row worth seeding.
        audience: { issuer: 'kpm', scope: 'leaders', inviteeMembershipIds: [] },
      },
      {
        kpmId, code: 'PRULINK_BRIEFING', typeCode: 'PRODUCT_LAUNCH',
        title: 'PRULink briefing', blurb: 'The new rider, and how to position it.',
        description: '', startsAt: at(-21, 2), endsAt: at(-21, 5), location: 'Online',
        locationUrl: 'https://meet.example.test/prulink',
        audience: { issuer: 'company', scope: 'all_agents', inviteeMembershipIds: [] },
      },
    ].map((event) => ({
      ...event, version: 1, status: 'active', archivedAt: null, deletedAt: null,
      createdBy: null, updatedBy: null,
    })));
    }

    /*
     * Five product decisions (P5-T5, P5-T10), so both tabs show every state they have.
     *
     * An office with no rows at all reads as *"everything inherited"*, which is true but shows
     * none of what the screens are for. So: one product it turned off, one it renamed, and the
     * three review states the approval queue exists to tell apart — **pending**, **approved**
     * (its words frozen, which is what agents actually read) and **sent back** with a reason.
     */
    const shelf = await Products.find({ companyId: await companyOf(kpmId) })
      .sort({ sortOrder: 1 }).limit(5).lean().exec();
    if (shelf.length === 5) {
      /*
       * Per row, not per collection.
       *
       * The collection-wide guard this file uses everywhere else is right where a block's rows
       * arrive together. These do not: P5-T5 seeded three and P5-T10 added two, and an office
       * seeded before today would keep answering *"it already has some"* for ever — the exact
       * shape of the bug that left the Events screen empty after a reseed. `$setOnInsert` fills
       * in what is missing and leaves anything already there alone, including a row somebody
       * changed while walking the screen.
       */
      const already = new Set((await KpmProductConfigs.find({ kpmId }).lean().exec())
        .map((row) => String(row.productId)));
      const decisions = [
        {
          kpmId, productId: String(shelf[0]._id),
          active: null,
          overrides: { displayName: `${String(shelf[0].name)} (nama kami)` },
          reviewState: 'none',
        },
        {
          kpmId, productId: String(shelf[1]._id),
          // Turned off here, and still on the company's shelf — the distinction the screen exists
          // to make visible.
          active: false,
          overrides: {},
          reviewState: 'none',
        },
        {
          kpmId, productId: String(shelf[2]._id),
          active: true,
          overrides: {
            opening: 'Halo Pak/Bu, boleh saya cerita sebentar soal proteksi keluarga?',
            nextAction: 'Boleh saya siapkan ilustrasinya untuk Bapak/Ibu?',
          },
          // Written, not yet approved: agents keep reading the company's words until it is.
          reviewState: 'pending',
        },
        {
          kpmId, productId: String(shelf[3]._id),
          active: true,
          // Approved, and then edited again — so `overrides` and `approvedOverrides` differ, which
          // is the whole point of freezing them: agents read the approved words while the new
          // draft waits. The screen says so on the queued card.
          overrides: {
            opening: 'Halo Pak/Bu, ada waktu lima menit? Saya ingin cerita soal dana pendidikan.',
          },
          reviewState: 'pending',
          approvedOverrideVersion: 1,
          approvedOverrides: {
            opening: 'Halo Pak/Bu, boleh saya cerita sebentar soal dana pendidikan?',
          },
        },
        {
          kpmId, productId: String(shelf[4]._id),
          active: true,
          overrides: { fullScript: 'Produk ini pasti untung besar, dijamin.' },
          // Sent back, with something its author can act on — which is why the reason is required.
          reviewState: 'rejected',
          rejectionReason:
            'Klaim "pasti untung" melebihi ilustrasi resmi. Tolong pakai angka dari ilustrasi.',
        },
      ].filter((row) => !already.has(row.productId)).map((row) => ({
        reviewedByMembershipId: null, reviewedAt: null, rejectionReason: null,
        approvedOverrideVersion: 0, approvedOverrides: {}, documents: {},
        version: 1, deletedAt: null, createdBy: null, updatedBy: null,
        ...row,
      }));
      if (decisions.length > 0) await KpmProductConfigs.insertMany(decisions);
    }

    /*
     * Two campaigns, one running and one ended (P5-T7).
     *
     * Named after the prototype's own *Year-End Star Club Drive*, which is the office's and fully
     * editable — the row that has to look different from *Star Club*, the insurer's tier, on the
     * same screen. Dated relative to the seeded clock so one is always running.
     */
    if (await missing(Campaigns as never)) {
    await Campaigns.insertMany([
      {
        kpmId, code: 'YEAR_END_DRIVE', title: 'Year-End Star Club Drive',
        description: 'Push to Star Club before the year closes.',
        startsAt: at(-30, 0), endsAt: at(60, 0),
        requirements: [{
          metricKey: 'APE_ACHIEVED', comparator: 'gte',
          value: 500_000_000 * 100, unit: 'idr_minor',
        }],
        reward: 'Extra unit budget and a dinner',
      },
      {
        kpmId, code: 'RECRUIT_SPRINT', title: 'Recruitment sprint',
        description: 'Four weeks of recruiting, counted on activity.',
        startsAt: at(-120, 0), endsAt: at(-90, 0),
        requirements: [{
          metricKey: 'RECRUITMENT_SUCCESS_RATE', comparator: 'gte', value: 0.3, unit: 'ratio',
        }],
        reward: 'Recognition at the monthly huddle',
      },
    ].map((campaign) => ({
      ...campaign, version: 1, status: 'active', archivedAt: null, deletedAt: null,
      createdBy: null, updatedBy: null,
    })));
    }

    // The capability catalog (P5-T8), the instrument leaders assess against. One per office, and
    // every item carrying a code — the two grids the prototype keys by label included.
    if (await missing(CapabilityCatalogs as never)) {
      await CapabilityCatalogs.create(
        capabilitySeedDocument(kpmId, defaultCapabilityLadder()),
      );
    }

    // The activation checklist (P5-T3), as the office's version 1, published — the state
    // provisioning leaves a new office in, so the settings screen opens on something real.
    if (await missing(ActivationTemplates as never)) {
    await ActivationTemplates.create({
      kpmId,
      version: 1,
      status: 'published',
      publishedAt: clock.now(),
      aspects: activationSeedAspects(defaultActivationChecklist()),
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
    });
    }
  }

  /**
   * Publish an office's configuration, so agents are on a copy rather than on nothing.
   *
   * `readPublished` falls back to the live rows when no snapshot exists, so an unpublished
   * office looks fine — and then the publish bar has only one state to show and nobody
   * ever sees the gate P4-T6 exists for. One office below is left deliberately unpublished
   * for that reason.
   */
  async function publish(kpmId: string, at: Date) {
    /*
     * Skipped only when the newest snapshot already carries what this seed would write.
     *
     * *"Has a snapshot"* was never the same question as *"has a snapshot with the Phase 5
     * catalogs in it"* — the same shape as the bug that left the Events screen empty after a
     * reseed. An office seeded before P5-T9 gets the **next version** rather than a rewrite,
     * because a published snapshot is immutable and that is exactly what an Owner pressing
     * Publish again would produce.
     */
    const newest = await ConfigSnapshots.findOne({ kpmId }).sort({ version: -1 }).lean().exec();
    const current = (newest as { payload?: { eventTypes?: unknown[] } } | null)?.payload;
    if (newest && Array.isArray(current?.eventTypes)) return;
    const [
      cats, types, ratios, statuses, trainingCats, trainingSkills, trainingModules,
      eventTypeRows, capabilityRow, checklistRow,
    ] = await Promise.all([
      ActivityCategories.find({ kpmId, status: 'active' }).sort({ displayOrder: 1 }).lean().exec(),
      ActivityTypes.find({ kpmId, status: 'active' }).sort({ displayOrder: 1 }).lean().exec(),
      RatioDefinitions.find({ kpmId, status: 'active' }).sort({ displayOrder: 1 }).lean().exec(),
      LeadStatuses.find({ kpmId, status: 'active' }).sort({ rank: 1 }).lean().exec(),
      TrainingCategories.find({ kpmId, status: 'active' }).sort({ displayOrder: 1 }).lean().exec(),
      TrainingSkills.find({ kpmId, status: 'active' }).sort({ displayOrder: 1 }).lean().exec(),
      // What agents are offered: published modules only, as `TrainingService.offered` renders it.
      TrainingModules.find({ kpmId, status: 'active', publishState: 'published' })
        .sort({ displayOrder: 1 }).lean().exec(),
      /*
       * The three Phase 5 catalogs the snapshot carries (P5-T9 AC-1).
       *
       * Without them `/kpm/config` answers a demo office with an empty `eventTypes` and a null
       * `capability` — the backward-compatible read for an office provisioned before these
       * fields existed, which is exactly what a freshly seeded office would have looked like.
       * A feature nobody can see in the demo is one nobody can check.
       */
      EventTypes.find({ kpmId, status: 'active' }).sort({ displayOrder: 1 }).lean().exec(),
      CapabilityCatalogs.findOne({ kpmId }).lean().exec(),
      ActivationTemplates.findOne({ kpmId, status: 'published' })
        .sort({ version: -1 }).lean().exec(),
    ]);
    const view = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
      rows.map((r) => ({ ...r, id: String(r._id) }));
    const payload = {
      activity: view(cats as never).map((c) => ({
        ...c,
        types: view(types as never).filter((t) => t.categoryCode === c.code),
      })) as unknown[],
      ratios: view(ratios as never),
      leadPipelines: ['sales', 'recruitment'].map((pipeline) => ({
        pipeline,
        statuses: view(statuses as never).filter((l) => l.pipeline === pipeline),
      })),
      training: view(trainingCats as never).map((c) => ({
        ...c,
        skills: view(trainingSkills as never).filter((sk) => sk.categoryCode === c.code).map((sk) => ({
          ...sk,
          modules: view(trainingModules as never).filter((m) => m.skillCode === sk.code),
        })),
      })),
      activationChecklist: checklistRow
        ? {
          id: String((checklistRow as { _id: unknown })._id),
          version: (checklistRow as { version: number }).version,
          status: 'published',
          publishedAt: null,
          aspects: (checklistRow as { aspects?: unknown[] }).aspects ?? [],
        }
        : null,
      eventTypes: view(eventTypeRows as never).map((t) => ({
        id: t.id,
        code: t.code,
        label: t.label,
        description: t.description ?? null,
        emoji: t.emoji ?? null,
        color: t.color ?? null,
        displayOrder: t.displayOrder,
        version: t.version,
      })),
      capability: capabilityRow
        ? {
          stages: (capabilityRow as { stages?: unknown[] }).stages ?? [],
          milestones: (capabilityRow as { milestones?: unknown[] }).milestones ?? [],
          grids: (capabilityRow as { grids?: unknown[] }).grids ?? [],
          version: (capabilityRow as { version: number }).version,
        }
        : null,
      version: 1,
    };
    const version = ((newest as { version?: number } | null)?.version ?? 0) + 1;
    await ConfigSnapshots.create({
      kpmId, version, sourceVersion: 1, payload,
      publishedAt: at, publishedBy: null, deletedAt: null,
    });

    /*
     * What was copied, recorded the way provisioning records it (P5-T12): the platform
     * defaults for all three kinds, so a null version each. Without it every demo office read
     * as *unrecorded* on every tab of the Company template — true of offices configured before
     * this line existed, which is why the early return above leaves those alone.
     */
    if (version > 1) return;

    const defaults = { templateId: null, version: null };
    await Kpms.updateOne({ _id: kpmId }, {
      $set: {
        seededFrom: {
          activity_taxonomy: defaults, lead_pipeline: defaults, ratio_set: defaults,
          training_taxonomy: defaults, activation_checklist: defaults,
        },
      },
    }).exec();
  }

  /**
   * Place somebody in an office.
   *
   * The agent code comes from the office counter, the same way the service issues one —
   * a seed that made codes up would not exercise the numbering that everything else
   * joins on.
   */
  async function place(
    kpm: { _id: unknown; code: string; companyId: string },
    userId: string,
    role: Role,
    leader: Placed | null,
    opts: {
      status?: 'active' | 'pending' | 'removed';
      isKpmAdmin?: boolean;
      grantedByUserId?: string;
      /** Backdates a grant, so "Admin since" reads as a date rather than as today. */
      adminSinceDaysAgo?: number;
      /** Backdates a removal, so the Removed tab does not read as though it happened today. */
      removedDaysAgo?: number;
    } = {},
  ): Promise<Placed> {
    const kpmId = String(kpm._id);
    // A removed row is not "already placed". Re-running the seed must not adopt somebody's
    // old membership as their current one — that is the mistake P3-T7 AC-4 forbids, and the
    // partial unique index draws the same line.
    const existing = await Memberships.findOne({
      kpmId,
      userId,
      status: { $ne: 'removed' },
    }).exec();
    if (existing) {
      return {
        id: String(existing._id),
        ancestorIds: existing.get('ancestorIds') as string[],
        depth: existing.get('depth') as number,
      };
    }

    const counted = await Kpms.findOneAndUpdate(
      { _id: kpm._id },
      { $inc: { 'counters.nextMemberSeq': 1 } },
      { new: false },
    ).exec();
    const seq = (counted?.get('counters')?.nextMemberSeq as number) ?? 1;

    // Copied off the account, never minted here. The membership carries it so the roster,
    // the search and the production import have one field to read; it cannot drift,
    // because the code is immutable and an office sits inside one company.
    const account = await Users.findOne({ _id: userId }).exec();
    const agentCode = account?.get('agentCode') as string | null;
    if (!agentCode) throw new Error(`No agent code on the account for ${userId}`);
    const status = opts.status ?? 'active';
    const leaderId = leader ? leader.id : null;

    // The rung the role names, on this office's company ladder. The seed writes straight
    // to the model rather than through HierarchyService, so it resolves this itself —
    // and a missing rung throws here rather than producing a membership with no level.
    const level = await OrgLevels.findOne({
      companyId: kpm.companyId, code: role.toUpperCase(), status: 'active', deletedAt: null,
    }).exec();
    if (!level) throw new Error(`No ${role.toUpperCase()} rung on the ladder for KPM ${kpm.code}`);

    const created = await Memberships.create({
      kpmId,
      userId,
      agentCode,
      // The same generator production uses, so a seeded code is shaped like a real one.
      leaderCode: generateLeaderCode(),
      agentSeq: seq,
      orgLevelId: String(level._id),
      // What a permission grant reads (P4-T9), denormalised from the rung just resolved.
      orgLevelCode: level.code,
      role,
      leaderId,
      ancestorIds: leader ? [...leader.ancestorIds, leader.id] : [],
      depth: leader ? leader.depth + 1 : 0,
      status,
      joinedAt: status === 'pending' ? null : clock.now(),
      removedAt: status === 'removed' ? daysAgo(opts.removedDaysAgo ?? 0) : null,
      recruitedByMembershipId: leaderId,
      // A grant nobody made and nobody dated reads as a bug on Manage KPM admins, so
      // the seed records both — the Owner, months ago.
      adminAccess: opts.isKpmAdmin
        ? {
            isKpmAdmin: true,
            grantedByUserId: opts.grantedByUserId ?? null,
            grantedAt: daysAgo(opts.adminSinceDaysAgo ?? 0),
            revokedAt: null,
          }
        : { isKpmAdmin: false, grantedByUserId: null, grantedAt: null, revokedAt: null },
    });

    // History is written from the first day, not from the day a screen reads it.
    await History.create({
      kpmId, membershipId: String(created._id), eventType: 'joined',
      toRole: role, toLeaderId: leaderId, validFrom: clock.now(), validTo: null,
    });
    if (status === 'removed') {
      await History.create({
        kpmId, membershipId: String(created._id), eventType: 'removed',
        fromRole: role, validFrom: daysAgo(opts.removedDaysAgo ?? 0), validTo: null,
        reason: 'Left the industry — seeded so the Removed tab has something to show',
      });
    }

    return {
      id: String(created._id),
      ancestorIds: created.get('ancestorIds') as string[],
      depth: created.get('depth') as number,
    };
  }

  /**
   * A role change that happened before today.
   *
   * The Role change log reads `membershipHistory`, so an office seeded only with
   * `joined` rows shows an empty log — which is indistinguishable from a broken screen.
   * The `toRole` here always matches the role the person actually holds; a seeded
   * transition that contradicts the membership would be a lie in the audit trail.
   */
  const daysAgo = (days: number) =>
    new Date(clock.now().getTime() - days * 24 * 60 * 60 * 1000);

  async function promotedEarlier(
    kpmId: string,
    membership: Placed,
    from: Role,
    to: Role,
    actor: Placed,
    reason: string,
    days: number,
  ) {
    if (await History.findOne({ membershipId: membership.id, eventType: 'role_changed' }).exec()) {
      return;
    }
    await History.create({
      kpmId,
      membershipId: membership.id,
      eventType: 'role_changed',
      fromRole: from,
      toRole: to,
      validFrom: daysAgo(days),
      validTo: null,
      actorMembershipId: actor.id,
      reason,
    });
  }

  /** Counts are derived, never incremented, so they cannot drift out of step. */
  async function recount(kpmId: string, membershipId: string) {
    const directs = await Memberships.find({ kpmId, leaderId: membershipId, status: 'active' }).exec();
    const counts = { ab: 0, aab: 0, agent: 0, total: directs.length };
    for (const d of directs) counts[d.get('role') as Role] += 1;
    const subtreeCount = await Memberships.countDocuments({
      kpmId, ancestorIds: membershipId, status: 'active',
    });
    await Memberships.updateOne({ _id: membershipId }, { $set: { directCounts: counts, subtreeCount } });
  }

  // ---------------------------------------------------------------- platform

  // **The insurer first.** `user()` defaults everybody who is not a Super Admin to a
  // Prudential account, and reading a `const` before its declaration throws. The two
  // operators below happen to skip that branch, so ordering it the other way round
  // survived only by short-circuit evaluation — which is not a thing to rely on.
  const prudential = await company('Prudential', 'prudential');

  /*
   * Two companies, publishing different presets (P5-T9 AC-5).
   *
   * Allianz Life has **no offices**, which is a real state — a company exists before its first
   * branch — and it is the cheapest way to make the isolation visible: open each company's
   * template and the Events tab lists a different set. Without a second company the Company
   * template screen can only ever show one answer, so "neither company sees the other's" is a
   * claim nobody can check in a browser.
   */
  const allianz = await company('Allianz Life', 'allianz-life');

  await publishTemplate(String(prudential._id), 'event_types', {
    types: [
      { code: 'TRAINING', label: 'Pelatihan', description: null, emoji: '📚', color: '#2D9CDB', displayOrder: 1 },
      { code: 'PRODUCT_LAUNCH', label: 'Peluncuran produk', description: null, emoji: '🚀', color: '#F2994A', displayOrder: 2 },
      { code: 'RECOGNITION', label: 'Penghargaan', description: null, emoji: '🏆', color: '#27AE60', displayOrder: 3 },
      { code: 'RECRUITMENT', label: 'Rekrutmen', description: null, emoji: '🤝', color: '#9B51E0', displayOrder: 4 },
      { code: 'COMMUNITY', label: 'Komunitas', description: null, emoji: '🎉', color: '#EB5757', displayOrder: 5 },
    ],
  });
  await publishTemplate(String(allianz._id), 'event_types', {
    types: [
      { code: 'ROADSHOW', label: 'Roadshow', description: null, emoji: '🚐', color: '#EB5757', displayOrder: 1 },
      { code: 'PRODUCT_CLINIC', label: 'Klinik produk', description: null, emoji: '🩺', color: '#27AE60', displayOrder: 2 },
    ],
  });

  const superAdmin = await user('superadmin@agencyboost.test', 'Platform Operator', {
    password: 'demo super admin', platformRole: 'super_admin',
  });
  // A second one, because "a Super Admin cannot be impersonated" needs two to show.
  await user('root@agencyboost.test', 'Second Operator', { platformRole: 'super_admin' });

  /**
   * Prudential's ladder (P3.5-T7 AC-5), junior first, exactly as the prototype writes it:
   * *"Role ladder: Agent → AAB → AB"* (`Superadmin.html:311`).
   *
   * The codes are what `memberships.orgLevelId` will resolve to in T8, and they match the
   * `HierarchyRole` enum lower-cased — which is the whole reason v1's one-to-one mapping
   * lets the enum keep working while the reference becomes the stored truth.
   */
  for (const { code, label, displayOrder } of DEFAULT_ORG_LADDER) {
    const existing = await OrgLevels.findOne({ companyId: String(prudential._id), code }).exec();
    if (!existing) {
      await OrgLevels.create({
        companyId: String(prudential._id), code, label, displayOrder,
        status: 'active', archivedAt: null, deletedAt: null,
      });
    }
  }

  // ---------------------------------------------------------- KPM 0417, the main office

  const ownerUser = await user('owner@kpm0417.test', 'Wilson Tanoto', { password: 'demo password 0417' });
  const kpm0417 = await office(String(prudential._id), '0417', 'BSD City Branch', {
    ownerUserId: String(ownerUser._id),
    address: 'Jl. Raya Serpong, Tangerang Selatan',
  });
  const office0417 = {
    _id: kpm0417._id,
    code: kpm0417.get('code') as string,
    companyId: kpm0417.get('companyId') as string,
  };
  const id0417 = String(kpm0417._id);

  await configure(id0417);
  // Published a while back, then edited — so 0417's publish bar shows the state that
  // matters: agents on one copy while the Owner works on another. 0555 is the clean
  // counterpart.
  await publish(id0417, daysAgo(45));

  /*
   * The states a settings screen can only show if something is in them.
   *
   * Every one of these was unreachable in a seeded database: nothing was ever archived, so
   * *Show archived* was an empty checkbox; every ratio was the platform's, so the two row
   * kinds P4-T15 added looked identical; and nothing had been touched since publishing, so
   * the publish bar only ever had one thing to say.
   */
  if (!(await ActivityTypes.findOne({ kpmId: id0417, status: 'archived' }).exec())) {
    // Retired, not deleted (invariant §3): its history still renders wherever it is named.
    await ActivityTypes.updateOne(
      { kpmId: id0417, code: 'DEV_COACHING_RECEIVED' },
      { $set: { status: 'archived', archivedAt: daysAgo(12), version: 2 } },
    );
    await LeadStatuses.updateOne(
      { kpmId: id0417, code: 'APPROVED_NOT_PAID' },
      { $set: { status: 'archived', archivedAt: daysAgo(9), version: 2 } },
    );
  }

  /*
   * An edit since publishing, on a row that is still **active**.
   *
   * `hasUnpublishedChanges` compares the highest *live* version against the version the
   * snapshot was rendered from, so bumping a row and archiving it in the same breath
   * leaves the bar reading clean — which is what the first version of this seed did, and
   * the state it was written to produce never appeared.
   */
  await RatioDefinitions.updateOne(
    { kpmId: id0417, code: 'SELLING_SUCCESS_RATE', version: 1 },
    { $set: { benchmark: 0.18, version: 2 } },
  );

  if (!(await RatioDefinitions.findOne({ kpmId: id0417, origin: 'office' }).exec())) {
    // An office's own (ADR-0021): formula included, and comparable with nobody.
    await RatioDefinitions.create({
      kpmId: id0417,
      code: 'REFERRAL_RATE',
      label: 'Referral rate',
      numerator: ['LEADS_NEW_PROSPECT'],
      denominator: ['LEADS_CONTACTED'],
      benchmark: 0.35,
      comparison: 'gte',
      // A conversion rate, so the Owner reads 35.0% — the unit they chose for their own.
      displayUnit: 'percent',
      displayOrder: 6,
      origin: 'office',
      // Their referral push is the senior rungs' programme this quarter (ADR-0020).
      appliesToOrgLevelCodes: ['AB', 'AAB'],
      version: 1,
      status: 'active',
      archivedAt: null,
      deletedAt: null,
    });
  }

  const owner = await place(office0417, String(ownerUser._id), 'ab', null);

  // Admin rights are orthogonal to hierarchy role: this one is an AB as well.
  const adminUser = await user('admin@kpm0417.test', 'Maya Halim');
  const admin = await place(office0417, String(adminUser._id), 'ab', owner, {
    isKpmAdmin: true,
    grantedByUserId: String(ownerUser._id),
    adminSinceDaysAgo: 234,
  });
  if (!(await History.findOne({ membershipId: admin.id, eventType: 'admin_granted' }).exec())) {
    await History.create({
      kpmId: id0417, membershipId: admin.id, eventType: 'admin_granted',
      validFrom: daysAgo(234), validTo: null, actorMembershipId: owner.id,
      actorUserId: String(ownerUser._id),
    });
  }

  // An AB who is neither Owner nor Admin, with a unit of their own.
  const abUser = await user('agus@kpm0417.test', 'Agus Prasetyo');
  const ab = await place(office0417, String(abUser._id), 'ab', owner);

  const sariUser = await user('sari@kpm0417.test', 'Sari Puspita');
  const sari = await place(office0417, String(sariUser._id), 'aab', ab);

  // The case OD-23 settles: holds the role, leads nobody.
  const dewiUser = await user('dewi@kpm0417.test', 'Dewi Lestari');
  const dewi = await place(office0417, String(dewiUser._id), 'aab', ab);

  // Both AABs were agents first. Without these the Role change log is empty, and an
  // empty log reads as a screen that does not work.
  await promotedEarlier(id0417, sari, 'agent', 'aab', ab, 'Ready to lead a unit of her own', 62);
  await promotedEarlier(id0417, dewi, 'agent', 'aab', ab, 'Took the AAB track after Q2', 21);

  const rinaUser = await user('rina@kpm0417.test', 'Rina Wijaya', { password: 'demo password rina' });
  const rina = await place(office0417, String(rinaUser._id), 'agent', sari);
  const budiUser = await user('budi@kpm0417.test', 'Budi Santoso');
  const budi = await place(office0417, String(budiUser._id), 'agent', sari);

  // Registered and waiting on a leader, with the request already sent.
  const pendingUser = await user('pending@kpm0417.test', 'Putri Anggraini');
  const pending = await place(office0417, String(pendingUser._id), 'agent', null, { status: 'pending' });
  if (!(await JoinRequests.findOne({ membershipId: pending.id }).exec())) {
    await JoinRequests.create({
      kpmId: id0417,
      membershipId: pending.id,
      leaderMembershipId: sari.id,
      status: 'pending',
    });
  }

  // Registered and has asked nobody yet — the untagged pool.
  const untaggedUser = await user('untagged@kpm0417.test', 'Fajar Nugroho');
  await place(office0417, String(untaggedUser._id), 'agent', null, { status: 'pending' });

  // Left the office. The row stays, and so does everything attached to it.
  const removedUser = await user('removed@kpm0417.test', 'Yanti Kusuma');
  await place(office0417, String(removedUser._id), 'agent', sari, {
    status: 'removed',
    removedDaysAgo: 48,
  });

  // Came back. A second, live membership for the same person, with its own agent code —
  // the case P3-T7 AC-4 exists for, and the one a reader will not believe until they
  // see the same name twice on the roster.
  await place(office0417, String(removedUser._id), 'agent', sari);

  for (const id of [owner.id, ab.id, sari.id]) await recount(id0417, id);

  /**
   * Informal groups, and the Core Leader tag.
   *
   * Seeded so the Groups tab has something to show and the person page has a tag to
   * render. Deliberately cutting across the hierarchy — Rina reports to Sari, Maya to
   * the Owner — because that is the whole point of a group: it is not the tree.
   */
  const groupSeeds = [
    { name: 'New Agent Mentoring Circle', owner: sari.id, members: [rina.id, budi.id] },
    { name: 'Top Producers 2026', owner: owner.id, members: [ab.id, sari.id] },
  ];
  for (const seed of groupSeeds) {
    const existing = await Groups.findOne({ kpmId: id0417, name: seed.name }).exec();
    const group =
      existing ??
      (await Groups.create({
        kpmId: id0417,
        name: seed.name,
        ownerMembershipId: seed.owner,
        status: 'active',
        createdByMembershipId: owner.id,
      }));
    await Memberships.updateMany(
      { _id: { $in: seed.members } },
      { $addToSet: { groupIds: String(group._id) } },
    ).exec();
  }
  // Core Leader gates Leader Forum co-editing (Phase 14) and nothing else.
  await Memberships.updateMany(
    { _id: { $in: [ab.id, sari.id] } },
    { $set: { isCoreLeader: true } },
  ).exec();

  /*
   * Readable leader codes, so the sign-in panel and the docs can quote them.
   *
   * `HierarchyService` generates a random six-character code with every membership; the
   * seed overwrites two of them with something a person can read off a page. That is the
   * one thing it does differently from the API, and it is why they are quotable.
   *
   * There is nothing else to seed here. Invites used to have four states — working, spent,
   * withdrawn, expired — and each needed a fixture. A leader code has one (P3.6-T1).
   */
  for (const [membershipId, code] of [[sari.id, 'SARI01'], [ab.id, 'AGUS01']] as const) {
    await Memberships.updateOne({ _id: membershipId }, { $set: { leaderCode: code } });
  }

  // ------------------------------------------------- KPM 0555, for cross-tenant checks

  const owner0555User = await user('owner@kpm0555.test', 'Hendra Wijaya');
  const kpm0555 = await office(String(prudential._id), '0555', 'Kelapa Gading Branch', {
    ownerUserId: String(owner0555User._id),
    address: 'Jl. Boulevard Raya, Jakarta Utara',
  });
  const office0555 = {
    _id: kpm0555._id,
    code: kpm0555.get('code') as string,
    companyId: kpm0555.get('companyId') as string,
  };
  await configure(String(kpm0555._id));
  // Published and untouched since, so its publish bar reads clean — the state 0417 is
  // deliberately *not* in.
  await publish(String(kpm0555._id), daysAgo(30));

  const owner0555 = await place(office0555, String(owner0555User._id), 'ab', null);
  const agent0555User = await user('agent@kpm0555.test', 'Lina Marlina');
  await place(office0555, String(agent0555User._id), 'agent', owner0555);
  await recount(String(kpm0555._id), owner0555.id);

  // ------------------------------------------- a suspended office, and somebody in it

  const suspendedOwnerUser = await user('owner@kpm0999.test', 'Bagus Setiawan');
  const kpm0999 = await office(String(prudential._id), '0999', 'Suspended Branch', {
    ownerUserId: String(suspendedOwnerUser._id),
    status: 'suspended',
  });
  await configure(String(kpm0999._id));
  await publish(String(kpm0999._id), daysAgo(120));
  await place(
    {
      _id: kpm0999._id,
      code: kpm0999.get('code') as string,
      companyId: kpm0999.get('companyId') as string,
    },
    String(suspendedOwnerUser._id),
    'ab',
    null,
  );

  // ------------------------------------------------- offices asking to exist

  /**
   * `/admin/kpm-requests` had no rows, because nothing seeded the collection it reads.
   *
   * The approved one is `owner@kpm0555.test` asking for the office they now run, so the
   * second tenant has a provenance rather than appearing from nowhere. The two pending
   * ones are the screen's actual work; the declined one carries a reason, because the
   * decline dialog requires one and a reader should see what that looks like afterwards.
   */
  async function kpmRequest(
    email: string,
    fullName: string,
    branchName: string,
    fields: Record<string, unknown>,
  ) {
    const who = await user(email, fullName);
    const existing = await KpmRequests.findOne({ branchName }).exec();
    if (existing) return existing;
    return KpmRequests.create({
      companyId: String(prudential._id),
      branchName,
      requestedByUserId: String(who._id),
      note: null,
      status: 'pending',
      ...fields,
    });
  }

  await kpmRequest('ade@agencyboost.test', 'Ade Kurniawan', 'Bandung Kota Branch', {
    note: 'Six agents ready to move across from a branch that is closing.',
    createdAt: daysAgo(3),
  });
  await kpmRequest('maya@agencyboost.test', 'Maya Sari', 'Surabaya Timur Branch', {
    note: null,
    createdAt: daysAgo(1),
  });
  await kpmRequest('tomi@agencyboost.test', 'Tomi Halim', 'Medan Selatan Branch', {
    status: 'declined',
    decidedAt: daysAgo(9),
    decidedByUserId: String(superAdmin._id),
    reason: 'Too close to an existing office. Reapply once the territory split is settled.',
    createdAt: daysAgo(12),
  });
  await kpmRequest('owner@kpm0555.test', 'Hendra Wijaya', 'Kelapa Gading Branch', {
    status: 'approved',
    decidedAt: daysAgo(40),
    decidedByUserId: String(superAdmin._id),
    createdKpmId: String(kpm0555._id),
    createdAt: daysAgo(45),
  });

  // ------------------------------------------------------------- the inbox

  /**
   * Every screen in the product has a bell, and it was empty for everybody.
   *
   * Only the seven templates whose subject matter Phase 3 actually built are seeded. The
   * other three in-app templates — goals, coaching, event reminders — say things like
   * *"Open Goals to accept it"*, and pointing a reader at a screen that does not exist is
   * worse than an empty row. They arrive with their phases.
   *
   * Each one describes something that genuinely happened in this fixture: Putri really
   * did ask Sari, Sari and Dewi really were promoted, Yanti really was removed and came
   * back. A notification about an event the rest of the seed does not contain would send
   * somebody looking for a record that is not there.
   */
  async function notify(
    to: { userId: string; membershipId: string | null },
    templateId: string,
    payload: Record<string, unknown>,
    opts: { readDaysAgo?: number; sentDaysAgo: number },
  ) {
    const existing = await Notifications.findOne({
      userId: to.userId, templateId, createdAt: daysAgo(opts.sentDaysAgo),
    }).exec();
    if (existing) return;
    const at = daysAgo(opts.sentDaysAgo);
    await Notifications.create({
      kpmId: id0417,
      membershipId: to.membershipId,
      userId: to.userId,
      templateId,
      payload,
      delivery: {
        in_app: { status: 'sent', at },
        email: { status: 'sent', at },
      },
      readAt: opts.readDaysAgo === undefined ? null : daysAgo(opts.readDaysAgo),
      createdAt: at,
    });
  }

  // Sari: an open request to act on, and the promotion she already read about.
  await notify(
    { userId: String(sariUser._id), membershipId: sari.id },
    NotificationTemplate.JOIN_REQUEST_RECEIVED,
    { fullName: 'Putri Anggraini' },
    { sentDaysAgo: 2 },
  );
  await notify(
    { userId: String(sariUser._id), membershipId: sari.id },
    NotificationTemplate.ROLE_CHANGED,
    { reason: 'Ready to lead a unit of her own' },
    { sentDaysAgo: 62, readDaysAgo: 61 },
  );
  await notify(
    { userId: String(dewiUser._id), membershipId: dewi.id },
    NotificationTemplate.ROLE_CHANGED,
    { reason: 'Took the AAB track after Q2' },
    { sentDaysAgo: 21, readDaysAgo: 20 },
  );

  // Rina and Budi: how each of them arrived. Two different doors, two templates.
  await notify(
    { userId: String(rinaUser._id), membershipId: rina.id },
    NotificationTemplate.JOIN_REQUEST_APPROVED,
    {},
    { sentDaysAgo: 30, readDaysAgo: 29 },
  );
  await notify(
    { userId: String(budiUser._id), membershipId: budi.id },
    NotificationTemplate.MEMBER_TAGGED_BY_LEADER,
    {},
    { sentDaysAgo: 5 },
  );

  // Maya: the grant the Owner made, which is a row on /people/admins as well.
  await notify(
    { userId: String(adminUser._id), membershipId: null },
    NotificationTemplate.ADMIN_ACCESS_CHANGED,
    { granted: true },
    { sentDaysAgo: 200, readDaysAgo: 199 },
  );

  // Yanti: removed, then back. Both rows, in that order.
  await notify(
    { userId: String(removedUser._id), membershipId: null },
    NotificationTemplate.MEMBER_REMOVED,
    { reason: 'Left for a competitor, then came back three weeks later.' },
    { sentDaysAgo: 50, readDaysAgo: 49 },
  );
  await notify(
    { userId: String(removedUser._id), membershipId: null },
    NotificationTemplate.JOIN_REQUEST_APPROVED,
    {},
    { sentDaysAgo: 28 },
  );

  // Fajar has asked nobody *now* — because the first time he asked, he was declined.
  await notify(
    { userId: String(untaggedUser._id), membershipId: null },
    NotificationTemplate.JOIN_REQUEST_DECLINED,
    { reason: 'My unit is full this quarter — ask Agus, he has room.' },
    { sentDaysAgo: 8 },
  );

  // ------------------------------------------------------------ the audit log

  /**
   * `/admin/audit` read an empty collection, because the seed writes through models
   * rather than through the services that stamp audit rows.
   *
   * These are the actions the rest of the fixture implies, with the real action names the
   * services emit — a row here that invented a name would teach the wrong vocabulary to
   * anyone reading the screen to learn what the log contains.
   */
  async function audited(
    action: string,
    targetCollection: string,
    fields: Record<string, unknown>,
  ) {
    const existing = await Audit.findOne({ action, ...fields }).exec();
    if (existing) return;
    await Audit.create({
      kpmId: null,
      actorUserId: String(superAdmin._id),
      action,
      targetCollection,
      ...fields,
    });
  }

  await audited('company.created', 'companies', {
    targetId: String(prudential._id),
    after: { name: 'Prudential', slug: 'prudential' },
    createdAt: daysAgo(120),
  });
  /*
   * `kpmId: null` on all of these, which is not an oversight.
   *
   * `AuditService.record` stamps `kpmId: ctx.kpmId`, and a Super Admin provisioning an
   * office has no tenant context — so provisioning is a **platform-level** row, which is
   * exactly the side `/admin/audit` shows by default. Seeding them under the office they
   * created would put them behind the scope toggle and misrepresent the shape the
   * service actually writes.
   */
  for (const [kpm, days] of [[kpm0417, 110], [kpm0555, 40], [kpm0999, 30]] as const) {
    await audited('kpm.created', 'kpms', {
      targetId: String(kpm._id),
      after: { code: kpm.get('code'), branchName: kpm.get('branchName') },
      createdAt: daysAgo(days),
    });
  }
  await audited('kpm.owner_assigned', 'kpms', {
    targetId: id0417,
    after: { ownerUserId: String(ownerUser._id) },
    createdAt: daysAgo(109),
  });
  await audited('kpm.suspended', 'kpms', {
    targetId: String(kpm0999._id),
    before: { status: 'active' },
    after: { status: 'suspended', reason: 'Unpaid platform fees' },
    createdAt: daysAgo(14),
  });
  await audited('kpm_request.declined', 'kpmRequests', {
    after: { branchName: 'Medan Selatan Branch' },
    createdAt: daysAgo(9),
  });
  // Tenant-level rows, so the screen's "Show platform level" toggle has both sides.
  await audited('kpm_admin.granted', 'memberships', {
    kpmId: id0417,
    actorUserId: String(ownerUser._id),
    targetMembershipId: admin.id,
    after: { granted: true },
    createdAt: daysAgo(200),
  });
  await audited('member.role_changed', 'memberships', {
    kpmId: id0417,
    actorUserId: String(ownerUser._id),
    targetMembershipId: sari.id,
    before: { role: 'agent' },
    after: { role: 'aab' },
    createdAt: daysAgo(62),
  });
  await audited('member.removed', 'memberships', {
    kpmId: id0417,
    actorUserId: String(sariUser._id),
    targetMembershipId: rina.id,
    onBehalfOf: true,
    after: { reason: 'Left for a competitor' },
    createdAt: daysAgo(50),
  });

  /*
   * The pair is deliberately asymmetric, because the service writes it that way.
   *
   * Starting a session is done *as the Super Admin* — no tenant context, no
   * `effectiveUserId`, so it is a platform row. Ending one is done *while impersonating*,
   * so the context carries the target's office and `record` fills `effectiveUserId` in.
   * One support session therefore appears on both sides of the scope toggle, which is
   * worth seeing before somebody assumes a missing row means a missing event.
   */
  await audited('impersonation.started', 'users', {
    targetId: String(rinaUser._id),
    after: { reason: 'Support ticket 118 — cannot see her unit', minutes: 60 },
    createdAt: daysAgo(6),
  });
  await audited('impersonation.ended', 'users', {
    kpmId: id0417,
    effectiveUserId: String(rinaUser._id),
    targetId: String(rinaUser._id),
    createdAt: daysAgo(6),
  });

  // ------------------------------------------------------------ activity logs (P6)

  /*
   * **Without these the Log Activity screen has nothing to show and the compliance tree is
   * empty**, which reads as a broken screen rather than as an office nobody has logged in yet.
   * Four states are seeded because each is a different answer the product gives:
   *
   * - **Rina** logs most days — the compliant case, and the one the ratios have data for.
   * - **Budi** last logged nine days ago — outside the seven-day window, so the Owner's
   *   compliance list has somebody on it and *"Last logged 9 days ago"* has a source.
   * - **Dewi** saved a day of zeroes — the OD-30 case. She counts as reporting, and the whole
   *   argument for that is only visible when the row exists.
   * - **Sari** has a **corrected** day from last month, which is the only way to see ADR-0042's
   *   correction list on a screen at all.
   */
  const jakartaDay = (days: number) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(daysAgo(days));

  const logDay = async (
    membershipId: string,
    daysBack: number,
    counts: Record<string, number>,
    extra: Record<string, unknown> = {},
  ) => {
    const types = await ActivityTypes.find({ kpmId: id0417, status: 'active' }).lean().exec();
    const entries = types.map((type) => ({
      activityTypeId: String((type as { _id: unknown })._id),
      activityTypeCode: (type as { code: string }).code,
      count: counts[(type as { code: string }).code] ?? 0,
    }));
    await mongoose.connection.collection('activityLogs').insertOne({
      kpmId: id0417,
      membershipId,
      localDate: jakartaDay(daysBack),
      entries,
      totalCount: entries.reduce((sum, e) => sum + e.count, 0),
      source: 'self',
      enteredByMembershipId: membershipId,
      version: 1,
      frozenAt: null,
      corrections: [],
      deletedAt: null,
      createdAt: daysAgo(daysBack),
      updatedAt: daysAgo(daysBack),
      createdBy: null,
      updatedBy: null,
      ...extra,
    });
  };

  // Rina: a working week, with the shape a real one has — busier midweek, quiet on the edges.
  for (const [back, counts] of [
    [0, { LEADS_GEN_ACTIVITY: 2, LEADS_CONTACTED: 5, SELL_PRESENTATION: 2, SELL_SUBMISSION: 1 }],
    [1, { LEADS_CONTACTED: 4, SELL_PRESENTATION: 3, SELL_FOLLOWUP: 2 }],
    [2, { LEADS_GEN_ACTIVITY: 1, LEADS_CONTACTED: 6, SELL_PRESENTATION: 1 }],
    [4, { LEADS_CONTACTED: 3, SELL_FOLLOWUP: 1, DEV_TRAINING_ATTEND: 1 }],
    [5, { LEADS_GEN_ACTIVITY: 3, LEADS_NEW_PROSPECT: 2 }],
  ] as [number, Record<string, number>][]) {
    await logDay(rina.id, back, counts);
  }

  // Budi: nine days ago, so he is outside the window and the Owner has somebody to chase.
  await logDay(budi.id, 9, { LEADS_CONTACTED: 2, SELL_PRESENTATION: 1 });

  // Dewi: a day of zeroes. She reported, and she did nothing — two different facts (OD-30).
  await logDay(dewi.id, 1, {});

  /*
   * Sari: a day from last month, corrected after its window closed.
   *
   * The prior state is kept **whole** rather than as a diff, because the point of the list is
   * that a leader who coached against the old numbers can still read them (ADR-0042).
   */
  const sariTypes = await ActivityTypes.find({ kpmId: id0417, status: 'active' }).lean().exec();
  const priorEntries = sariTypes.map((type) => ({
    activityTypeId: String((type as { _id: unknown })._id),
    activityTypeCode: (type as { code: string }).code,
    count: (type as { code: string }).code === 'SELL_SUBMISSION' ? 1 : 0,
  }));
  await logDay(sari.id, 40, { SELL_SUBMISSION: 3, SELL_PRESENTATION: 2 }, {
    version: 2,
    frozenAt: daysAgo(6),
    corrections: [{
      version: 1,
      entries: priorEntries,
      totalCount: 1,
      at: daysAgo(5),
      byMembershipId: sari.id,
      reason: 'Two submissions were logged against the wrong day.',
    }],
  });

  // ---------------------------------------------------------- in no office at all

  await user('newcomer@agencyboost.test', 'Nadia Safitri');

  void superAdmin;

  console.log(`
Seeded. Every field account uses the password "${FIELD_PASSWORD}" unless noted.

  PLATFORM
    superadmin@agencyboost.test   demo super admin     Super Admin
    root@agencyboost.test                              Super Admin — a second, so SA-on-SA can be refused

  KPM 0417 · BSD City Branch  (${id0417})
    owner@kpm0417.test           demo password 0417    KPM Owner, AB at the root
    admin@kpm0417.test                                 KPM Admin since Jan 2026, granted by the Owner,
                                                       and an AB — the two are independent
    agus@kpm0417.test                                  AB with a unit, neither Owner nor Admin
    sari@kpm0417.test                                  AAB leading two agents
    dewi@kpm0417.test                                  AAB leading nobody — the OD-23 case
                                                       Sari and Dewi were promoted from Agent,
                                                       so /people/members Role change log has rows
    rina@kpm0417.test            demo password rina    Agent under Sari
    budi@kpm0417.test                                  Agent under Sari
    pending@kpm0417.test                               Registered, request sent to Sari, waiting
    untagged@kpm0417.test                              Registered, has asked nobody
    removed@kpm0417.test                               Removed once, rejoined — two memberships,
                                                       two agent codes, one person (P3-T7 AC-4)

  KPM 0555 · Kelapa Gading Branch  (${String(kpm0555._id)})
    owner@kpm0555.test                                 KPM Owner — for cross-tenant checks
    agent@kpm0555.test                                 Agent

  KPM 0999 · Suspended Branch
    owner@kpm0999.test                                 Signing in returns TENANT_SUSPENDED

  NO OFFICE
    newcomer@agencyboost.test                          Brand new — starts at Register KPM

  GROUPS in KPM 0417, at /people/members → Groups
    New Agent Mentoring Circle   owned by Sari · Rina and Budi tagged
    Top Producers 2026           owned by the Owner · Agus and Sari tagged
    Agus and Sari also carry the Core Leader tag

  KPM REQUESTS at /admin/kpm-requests  (Super Admin)
    Bandung Kota Branch          pending, with a note — ade@agencyboost.test
    Surabaya Timur Branch        pending, no note — maya@agencyboost.test
    Medan Selatan Branch         declined, with the reason on the row
    Kelapa Gading Branch         approved — this is where KPM 0555 came from

  NOTIFICATIONS at /notifications  (the bell on every screen)
    sari@kpm0417.test            1 unread: Putri's request. Plus her own promotion, read
    budi@kpm0417.test            1 unread: tagged by a leader
    untagged@kpm0417.test        1 unread: declined, with the leader's reason
    removed@kpm0417.test         1 unread: back in. Plus the removal, read
    rina / dewi / admin          read-only inboxes — the "nothing new" state
    owner@kpm0417.test           empty, deliberately: nothing in this fixture is
                                 addressed to the Owner, and an empty inbox is a
                                 state worth seeing too

  AUDIT LOG at /admin/audit  (Super Admin)
    Platform-level and tenant-level rows, so the scope toggle has both sides.
    Includes an impersonation.started / .ended pair on Rina.
    The log also accumulates from real API use, so expect more than the seed writes —
    run with --reset for only these.

  LEADER CODES for KPM 0417, at /join?code=<code>
    SARI01   Sari's. Redeeming it lands you in her unit, active, with no approval
    AGUS01   Agus's, the same
    Everybody else has one too — a random six characters, on their own membership.
    There is nothing to withdraw and nothing that expires: a code is issued once,
    with the membership, and lasts as long as it does. Sign in first — the preview
    and the redemption both need an account.

Sign in at POST /api/v1/auth/login, then send the access token as
  Authorization: Bearer <accessToken>
`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
