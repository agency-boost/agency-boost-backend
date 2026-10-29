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
 * **Coaching (P11-T2)** adds the people the demo AB coaches (`coaching-cast.ts`) and defines the
 * sessions, ticks and notes their collections hold (`coaching-fixture.ts`, whose header says which
 * account shows which roster state). The sessions are inserted (P11-T5 AC-10), and the ticks and the
 * notes (P11-T9 AC-8).
 *
 *   pnpm seed:demo            create, leaving anything that already exists
 *   pnpm seed:demo --reset    empty the collections it owns first
 *
 * The last lines it prints count the rows this run wrote, so a second run can show it wrote none.
 */
import 'reflect-metadata';
import mongoose from 'mongoose';
import { config as loadEnv } from 'dotenv';
import { Clock, SystemClock } from '@/common/clock/clock.port';
import { addDays as addLocalDays } from '@/common/time/local-day';
import { PasswordService } from '@/modules/auth/password.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Product, ProductSchema } from '@/modules/products/product.schema';
import { Lead, LeadSchema } from '@/modules/leads/lead.schema';
import { up as leadPosition } from '@/migrations/0031-lead-position';
import { up as membershipJoinDate } from '@/migrations/0040-membership-join-date';
import { Goal, GoalSchema } from '@/modules/goals/goal.schema';
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
import {
  CASCADE_ACTIVITY_CODES, DEFAULT_ORG_LADDER, DEFAULT_TENANT_TIMEZONE, FIRST_SALE_STAGE_CODE,
} from '@/domain/constants';
import { annualTargetOf, computeCascade, defaultMonthsLeft } from '@/modules/goals/goal-cascade';
import { monthlyApeTarget } from '@/modules/summary/summary-figures';
import {
  CASCADE_CODES, COACHING_ACTIVITY, COACHING_CAST, COACHING_GOALS, COACHING_LEADS, COACHING_PRODUCTION,
  pacingFloor, type ActivityPlan, type CastKey, type CoacheeKey, type DayCounts,
} from './coaching-cast';
import {
  buildCoachingFixture, ROSTER_PLAN, seedObjectId, type CoachingFixture, type FixtureLead,
} from './coaching-fixture';
import { CoachingSession, CoachingSessionSchema } from '@/modules/coaching/coaching-session.schema';
import { CoachingProfile, CoachingProfileSchema } from '@/modules/coaching/coaching-profile.schema';
import { LeaderNote, LeaderNoteSchema } from '@/modules/coaching/leader-note.schema';
import { backfillCoachingSnapshots } from './coaching-snapshots';
import { buildCalendarFixture, CALENDAR_WORDS as CAL, type CalendarFixture } from './calendar-fixture';
import { buildActivationFixture, type ActivationFixture } from './activation-fixture';
import { seedSubscriptionFixture } from './subscription-fixture';
import { seedPersonalFor } from './personal-fixture';
import { seedTemplateFixture } from './template-fixture';
import { seedTemplateCopyFixture } from './template-copy-fixture';
import { seedSalesToolsFixture } from './sales-tools-fixture';
import { seedUnitDashboardFixture } from './unit-dashboard-fixture';
import { seedRecruitmentFixture, storageFromEnvironment, type RecruitmentFixture } from './recruitment-fixture';
import { monthField, seedMonthFigures } from './production-figures';
import {
  placeReportingCast, reportingMonthFigures, seedReportingFixture, type ReportingKey,
} from './reporting-fixture';
import { seedActivationCohort } from './cohort-fixture';
import { seedActivation3MFixture, type Activation3MSeed } from './activation-3m-fixture';
import { markNewHires } from './join-dates';
import { buildFirstSaleFixture, type FirstSaleFixture } from './first-sale-fixture';
import { up as backfillFirstSales } from '../migrations/0042-membership-first-sale';
import { seedLeaderForumFixture, type LeaderForumFixture } from './leader-forum-fixture';
import { seedTrainingFixture, type TrainingFixture } from './training-fixture';
import { CONFIGURED_EVENTS, seedEventsFixture, type EventsFixture } from './events-fixture';
import { seedCampaignsFixture, type CampaignsFixture } from './campaigns-fixture';
import { seedComplianceFixture, type ComplianceFixture } from './compliance-fixture';
import { seedJoiningFixture, type JoiningFixture } from './joining-fixture';
import { planSeed } from './seed-guard';
import type { StoragePort } from '@/modules/assets/storage.port';
import { LONG_PIPELINE } from './long-pipeline';
import {
  ActivationProgress, ActivationProgressSchema,
} from '@/modules/activation/activation-progress.schema';
import { activityWeeksCompletedOn, officeMondayOf } from '@/modules/activation/activation-rules';
import { CalendarEvent, CalendarEventSchema } from '@/modules/calendar/calendar-event.schema';
import {
  CompanyOrgLevel, CompanyOrgLevelSchema,
} from '@/modules/tenants/company-org-level.schema';
import { DEFAULT_KPM_SETTINGS, Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { generateLeaderCode } from '@/modules/org/leader-code';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import {
  EDGE_EVENTS, MembershipHistory, MembershipHistorySchema,
} from '@/modules/org/membership-history.schema';
import { Group, GroupSchema } from '@/modules/org/group.schema';
import { JoinRequest, JoinRequestSchema } from '@/modules/org/join-request.schema';
import { LeaderLimitRequest, LeaderLimitRequestSchema } from '@/modules/org/leader-limit-request.schema';
import { KpmRequest, KpmRequestSchema } from '@/modules/tenants/kpm-request.schema';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { Notification, NotificationSchema } from '@/modules/notifications/notification.schema';
import { IN_APP_TEMPLATES } from '@/modules/notifications/inbox-copy';
import {
  SEED_ACTIVITY_CATEGORIES, SEED_ACTIVITY_TYPES, SEED_EVENT_TYPES, SEED_LEAD_STATUSES,
  SEED_MOC_RULES, SEED_PRODUCTION_CLUB_TIERS, SEED_PRODUCTS, SEED_RATIO_DEFINITIONS,
  metricByKey,
} from '@/domain/constants';
import {
  ActivityCategory, ActivityCategorySchema,
} from '@/modules/config/activity-category.schema';
import { ActivityType, ActivityTypeSchema } from '@/modules/config/activity-type.schema';
import { ActivityBinding, ActivityBindingSchema } from '@/modules/config/activity-binding.schema';
import { defaultBinding } from '@/modules/config/activity-binding';
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
import {
  NotificationTemplate, TEMPLATE_CHANNELS, type NotificationTemplateId,
} from '@/modules/notifications/notification.types';
import { createHash } from 'node:crypto';
import { DataUploadBatch, DataUploadBatchSchema } from '@/modules/production/data-upload-batch.schema';
import { DataUploadRow, DataUploadRowSchema } from '@/modules/production/data-upload-row.schema';
import { MonthlyAgentData, MonthlyAgentDataSchema, PRODUCTION_METRICS } from '@/modules/production/monthly-agent-data.schema';
import { ProductionMonth, ProductionMonthSchema } from '@/modules/production/production-month.schema';
import { templateFilename } from '@/modules/production/production-template';
import {
  CompanyTemplate, CompanyTemplateSchema,
} from '@/modules/config/company-template.schema';

/**
 * One password for every field account, so the sign-in panel stays readable. The three
 * that predate this keep their own, because the documentation quotes them.
 */
const FIELD_PASSWORD = 'demo password field';

/** A pronoun the seed states for a person: `users.pronoun` less the default, which needs no stating. */
export type SeedPronoun = Exclude<User['pronoun'], 'they'>;

/**
 * **The addresses the seed owns**: every account it makes is at a `.test` domain, which RFC 2606 reserves,
 * so no real person registers one. An account at such an address is the seed's to amend on a re-run.
 */
const SEED_OWNED_EMAIL = /@[a-z0-9.-]+\.test$/i;

/** The three a person records on the account (ADR-0158); work status is the membership's (`place`). */
function seedPersonalAccount(email: string, pronoun?: 'she' | 'he' | 'they') {
  const { dateOfBirth, gender, companyJoinMonth } = seedPersonalFor(email, pronoun);
  return { dateOfBirth, gender, companyJoinMonth };
}

/**
 * Every model is compiled with this, so a second run in one process — the seed's spec runs it two and
 * three times — recompiles rather than throwing `OverwriteModelError`. The command runs it once.
 */
const RECOMPILE = { overwriteModels: true } as const;

/**
 * Days before the run, each written in two places that must agree: when KPM 0417's Owner joined and the
 * audit log's `kpm.owner_assigned`, and when Rina and Budi joined and the notices of how they arrived.
 */
const OWNER_ASSIGNED_DAYS_AGO = 109;
const RINA_JOINED_DAYS_AGO = 58;
const BUDI_JOINED_DAYS_AGO = 61;
/** When 0555's Owner and Lina joined: before 0555's two months of files, its logging and its 1:1 — and Lina's activation start. */
const OFFICE_0555_JOINED_DAYS_AGO = 60;

/*
 * **What the office types, in Bahasa Indonesia** (P18.98-T7, OD-238): the demo reads as an Indonesian office. Content an
 * office typed is shown as typed in both languages (ADR-0179 §5), so this is the seed's own text, never a translation.
 * Each row below is written once and then left as it is, so a database seeded before keeps the English it was given:
 * where a writer keys on what a row says (a notice's payload, an audit row's fields, a group's name), the English it
 * wrote before is named beside it as `formerly`, and a re-run that finds either writes nothing.
 */

/** The reasons people typed: promotions, a removal, a decline, a suspension, a support session. */
export const DEMO_REASONS = {
  sariPromoted: 'Siap memimpin unit sendiri',
  dewiPromoted: 'Mengambil jalur AAB setelah Q2',
  yantiRemoved: 'Pindah ke kompetitor, lalu kembali tiga minggu kemudian.',
  fajarDeclined: 'Unit saya penuh kuartal ini — coba ke Agus, unitnya masih ada tempat.',
  suspended: 'Biaya platform belum dibayar',
  removedForCompetitor: 'Pindah ke kompetitor',
  impersonation: 'Tiket dukungan 118 — tidak bisa melihat unitnya',
} as const;

/** The English the seed typed before P18.98-T7, by the same keys: what a re-run over an older database finds. */
const FORMER_REASONS: Readonly<Record<keyof typeof DEMO_REASONS, string>> = {
  sariPromoted: 'Ready to lead a unit of her own',
  dewiPromoted: 'Took the AAB track after Q2',
  yantiRemoved: 'Left for a competitor, then came back three weeks later.',
  fajarDeclined: 'My unit is full this quarter — ask Agus, he has room.',
  suspended: 'Unpaid platform fees',
  removedForCompetitor: 'Left for a competitor',
  impersonation: 'Support ticket 118 — cannot see her unit',
};

/**
 * **The office's three events, as `configure()` writes them**, by code (`events-fixture.ts` holds their words). Reminders
 * name each by the title the office holds — read back by code — so a database seeded before keeps its English titles
 * and its reminders agree with them.
 */
const DEMO_EVENTS = CONFIGURED_EVENTS;
type DemoEventCode = keyof typeof DEMO_EVENTS;

/** The two informal groups in 0417, and the name the first had before P18.98-T7. */
export const DEMO_GROUPS = {
  mentoring: { name: 'Mentoring Agen Baru', formerly: 'New Agent Mentoring Circle' },
  topProducers: { name: 'Top Producers 2026' },
} as const;

type Role = 'ab' | 'aab' | 'agent';

interface Placed {
  id: string;
  ancestorIds: string[];
  depth: number;
}

/**
 * The collections this seed owns: `--reset` empties them, and every run counts them before and after so
 * it can say what it wrote. **A new collection is added here with the writer that fills it** — the rule
 * `docs/03-engineering/local-development.md` states, so a reset does not orphan its rows and the count
 * does not miss them.
 */
const OWNED_COLLECTIONS = [
  'memberships', 'membershipHistory', 'joinRequests', 'groups', 'kpms', 'companies', 'users',
  'authTokens', 'auditLog', 'notifications', 'notificationPreferences', 'assets',
  'kpmRequests',
  // Phase 4 configuration. Without these a `--reset` leaves the previous run's
  // taxonomy behind, orphaned against office ids that no longer exist — so every
  // settings screen renders another run's rows and the publish bar compares versions
  // across two different offices.
  'activityCategories', 'activityTypes', 'leadStatuses', 'ratioDefinitions',
  'configSnapshots',
  // P18.9-T2 (ADR-0163): which activity types each cascade role counts, one row per office.
  'activityBindings',
  // Phase 5. `products` is the company's rather than the office's, and it is cleared for
  // the same reason: a previous run's shelf orphaned against a company id that no longer
  // exists renders as an empty Products tab on a company that should have 31.
  'trainingCategories', 'trainingSkills', 'trainingModules', 'activationTemplates',
  'companyTemplates', 'products', 'kpmProductConfigs', 'eventTypes', 'events',
  'campaigns', 'qualificationRules', 'capabilityCatalogs', 'activityLogs',
  // Phase 8. Added with the collection rather than a phase later, which is the
  // lesson `leads` taught on the line below.
  'goals',
  // Phase 7, and missed when the collection was added in P7-T1. Without it a `--reset`
  // leaves the previous run's leads owned by membership ids that no longer exist: the
  // Leads screen then reads none of them — it lists the caller's own — while the rows sit
  // in the database forever, which is the same orphaning the two comments above describe.
  'leads',
  // Phase 9. The month rows and the imports that wrote them, and the months' own state — a
  // `--reset` that kept a batch would offer to revert figures that are no longer there.
  'monthlyAgentData', 'policies', 'productionMonths', 'dataUploadBatches', 'dataUploadRows',
  // Phase 11, with the writer that fills it (P11-T5 AC-10): the coaching fixture's sessions.
  'coachingSessions',
  // P11-T9 AC-8, with the writer that fills them: the fixture's capability ticks and leader notes.
  'coachingProfiles', 'leaderNotes',
  // Phase 12, with the writer that fills it: the calendar fixture's entries (`calendar-fixture.ts`).
  'calendarEvents',
  // Phase 13, with the writer that fills it: every hire's activation (`activation-fixture.ts`).
  'activationProgress',
  // Phase 17, with the writer that fills them (`recruitment-fixture.ts`): the companies' playbooks and the
  // offices' pitch documents. Their files are `assets` rows, above.
  'recruitmentPlaybooks', 'kpmRecruitmentPitchDocuments',
  // Phase 18, with the writer that fills it (`reporting-fixture.ts`): an office's recruitment target per month.
  'kpmRecruitTargets',
  // Phase 18.1, with the writer that fills them (`leader-forum-fixture.ts`): the offices' leader meetings and their links.
  'leaderMeetings', 'leaderMeetingShareLinks',
  // Phase 18.5, with the writer that fills it (`training-fixture.ts`): each member's progress on each module.
  'trainingProgress',
  // Phase 18.5, with the writer that fills them (`events-fixture.ts`): members' RSVPs, claims, confirmations and answers.
  'eventRsvps', 'eventFeedback',
  // Phase 18.5, with the writer that fills them (`campaigns-fixture.ts`): members' chases, and the standings frozen once final.
  'campaignChases', 'campaignStandings',
  // Phase 18.8, with the writer that fills it (`subscription-fixture.ts`): 0603's leaders past its limit (ADR-0157).
  'leaderLimitRequests',
  // P18.96-T3, with the writer that fills them (`joining-fixture.ts`): Agus's invites and his transfer request (ADR-0170).
  'memberInvites', 'transferRequests',
] as const;

/**
 * What the run's count reads: everything above that the seed writes — sessions and the asset store are
 * the product's, and API use moves them while a seed runs — and the company ladder, which it writes and
 * `--reset` has never emptied.
 */
const COUNTED_COLLECTIONS: readonly string[] = [
  ...OWNED_COLLECTIONS.filter((name) => !['authTokens', 'assets', 'notificationPreferences'].includes(name)),
  'companyOrgLevels',
];

export interface SeedOptions {
  /** The run's clock. Every seeded date counts from its today in `Asia/Jakarta` (P11-T2 AC-5). */
  clock?: Clock;
  /** `--reset`: empty the owned collections first. */
  reset?: boolean;
  /** Where the printed guide goes; the seed's spec passes a sink. */
  log?: (text: string) => void;
  /**
   * Phase 17 (D-seed): the storage the demonstration PDFs are written through. The command passes the
   * configured one, or `null` where none is; a spec passes a fake. Absent or `null`, the pitch documents and
   * the brochure are skipped, and the run says so.
   */
  storage?: StoragePort | null;
}

export interface SeedResult {
  /** Rows this run added, by collection — empty when the run found everything already there. */
  written: Record<string, number>;
  /** Accounts an earlier run made that this run gave their pronoun: 0 on a fresh seed and on a re-run. */
  pronounsSet: number;
  /** The coaching rows P11-T5 and P11-T9 insert with their collections (`coaching-fixture.ts`). */
  coaching: CoachingFixture;
  /** The calendar's week and month, inserted with their collection (`calendar-fixture.ts`). */
  calendar: CalendarFixture;
  /** Every hire's activation, and the audit rows its stored writes left (`activation-fixture.ts`). */
  activation: ActivationFixture;
  /** The playbooks, the pitch documents and the brochure, and whether their files were stored. */
  recruitment: RecruitmentFixture;
  /** The Strategic Leader Forum's meetings and links (`leader-forum-fixture.ts`). */
  forum: LeaderForumFixture;
  /** Phase 18.5: training progress, the company's material, 0555's bound item 9 (`training-fixture.ts`). */
  training: TrainingFixture;
  /** Phase 18.5: the events' RSVPs, claims, confirmations and answers (`events-fixture.ts`). */
  events: EventsFixture;
  /** Phase 18.5: the campaigns' new rows and the chases across the cast (`campaigns-fixture.ts`). */
  campaigns: CampaignsFixture;
  /** Phase 18.6: training for Phase 18's cast and D-seed's override (`compliance-fixture.ts`). */
  compliance: ComplianceFixture;
  /** P18.96-T3: Agus's pending and cancelled invites, and his transfer request for Raka (`joining-fixture.ts`). */
  joining: JoiningFixture;
  /** P18.96-T4: the first sales on day 20 and day 120, Rina's fourth 1:1 (`first-sale-fixture.ts`). */
  firstSales: FirstSaleFixture;
  /** P18.96-T6: Lukman, not activated by a sale on day 96, and Tari, marked left (`activation-3m-fixture.ts`). */
  activation3M: Activation3MSeed;
}

async function countRows(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const name of COUNTED_COLLECTIONS) {
    counts[name] = await mongoose.connection.collection(name).countDocuments({});
  }
  return counts;
}

/** `{ a: { b: 1 } }` as `{ 'a.b': 1 }`: a filter that matches a stored subdocument field by field. */
function asFieldFilter(fields: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const path = `${prefix}${key}`;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      Object.assign(filter, asFieldFilter(value as Record<string, unknown>, `${path}.`));
    } else {
      filter[path] = value;
    }
  }
  return filter;
}

/**
 * Seeds the demo tenant on the connection `mongoose` already holds. The command connects and calls
 * this; the seed's spec calls it on the in-memory database, twice, to prove the second run writes
 * nothing (P11-T2 AC-6).
 */
export async function seedDemo(options: SeedOptions = {}): Promise<SeedResult> {
  const clock = options.clock ?? new SystemClock();
  const log = options.log ?? ((text: string) => console.log(text));
  const dbName = mongoose.connection.db?.databaseName ?? 'the database';
  const passwords = new PasswordService();

  const Users = mongoose.model(User.name, UserSchema, undefined, RECOMPILE);
  const Companies = mongoose.model(Company.name, CompanySchema, undefined, RECOMPILE);
  const OrgLevels = mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema, undefined, RECOMPILE);
  const Kpms = mongoose.model(Kpm.name, KpmSchema, undefined, RECOMPILE);
  const ActivityCategories = mongoose.model(ActivityCategory.name, ActivityCategorySchema, undefined, RECOMPILE);
  const ActivityTypes = mongoose.model(ActivityType.name, ActivityTypeSchema, undefined, RECOMPILE);
  const ActivityBindings = mongoose.model(ActivityBinding.name, ActivityBindingSchema, undefined, RECOMPILE);
  const LeadStatuses = mongoose.model(LeadStatus.name, LeadStatusSchema, undefined, RECOMPILE);
  const RatioDefinitions = mongoose.model(RatioDefinition.name, RatioDefinitionSchema, undefined, RECOMPILE);
  const ConfigSnapshots = mongoose.model(ConfigSnapshot.name, ConfigSnapshotSchema, undefined, RECOMPILE);
  const TrainingCategories = mongoose.model(TrainingCategory.name, TrainingCategorySchema, undefined, RECOMPILE);
  const TrainingSkills = mongoose.model(TrainingSkill.name, TrainingSkillSchema, undefined, RECOMPILE);
  const TrainingModules = mongoose.model(TrainingModule.name, TrainingModuleSchema, undefined, RECOMPILE);
  const ActivationTemplates = mongoose.model(ActivationTemplate.name, ActivationTemplateSchema, undefined, RECOMPILE);
  const Products = mongoose.model(Product.name, ProductSchema, undefined, RECOMPILE);
  const Leads = mongoose.model(Lead.name, LeadSchema, undefined, RECOMPILE);
  const Goals = mongoose.model(Goal.name, GoalSchema, undefined, RECOMPILE);
  const KpmProductConfigs = mongoose.model(KpmProductConfig.name, KpmProductConfigSchema, undefined, RECOMPILE);
  const EventTypes = mongoose.model(EventType.name, EventTypeSchema, undefined, RECOMPILE);
  const Events = mongoose.model(Event.name, EventSchema, undefined, RECOMPILE);
  const Campaigns = mongoose.model(Campaign.name, CampaignSchema, undefined, RECOMPILE);
  const QualificationRules = mongoose.model(QualificationRule.name, QualificationRuleSchema, undefined, RECOMPILE);
  const CompanyTemplates = mongoose.model(CompanyTemplate.name, CompanyTemplateSchema, undefined, RECOMPILE);
  const CapabilityCatalogs = mongoose.model(CapabilityCatalog.name, CapabilityCatalogSchema, undefined, RECOMPILE);
  const Memberships = mongoose.model(Membership.name, MembershipSchema, undefined, RECOMPILE);
  const History = mongoose.model(MembershipHistory.name, MembershipHistorySchema, undefined, RECOMPILE);
  const Groups = mongoose.model(Group.name, GroupSchema, undefined, RECOMPILE);
  const JoinRequests = mongoose.model(JoinRequest.name, JoinRequestSchema, undefined, RECOMPILE);
  const LeaderLimitRequests = mongoose.model(LeaderLimitRequest.name, LeaderLimitRequestSchema, undefined, RECOMPILE);
  const KpmRequests = mongoose.model(KpmRequest.name, KpmRequestSchema, undefined, RECOMPILE);
  const Audit = mongoose.model(AuditLog.name, AuditLogSchema, undefined, RECOMPILE);
  const Notifications = mongoose.model(Notification.name, NotificationSchema, undefined, RECOMPILE);

  if (options.reset) {
    // Empty the collections rather than drop the database. An Atlas user with ordinary
    // read/write permissions cannot `dropDatabase` — the seed failed outright against
    // one — and emptying named collections will not take out a database someone pointed
    // at by mistake. The list is `OWNED_COLLECTIONS`, above.
    for (const name of OWNED_COLLECTIONS) {
      const { deletedCount } = await mongoose.connection.collection(name).deleteMany({});
      if (deletedCount) log(`cleared ${deletedCount} from ${name}`);
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
    log(`reset ${dbName}`);
  }

  // Counted after any reset, so the last lines printed are what this run wrote.
  const before = await countRows();

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
  /** Accounts made by an earlier run that this run gave their pronoun (printed with the count). */
  let pronounsSet = 0;
  async function user(
    email: string,
    fullName: string,
    opts: {
      password?: string;
      platformRole?: 'super_admin' | 'none';
      status?: string;
      companyId?: string;
      agentCode?: string;
      /**
       * **The person's own pronoun**, which every coaching sentence about them is written in (*Leads that
       * need her*). Stated per person, beside the name, never derived from it (`users.pronoun`). Left out
       * for the two operator accounts, which are not people anybody coaches: they keep `they`.
       */
      pronoun?: SeedPronoun;
    } = {},
  ) {
    const existing = await Users.findOne({ email }).exec();
    if (existing) {
      /*
       * **An account an earlier run made before the seed gave pronouns** gets this one, once: only on an
       * address the seed owns (`.test`, reserved, so nobody real signs up there) and only while it still
       * holds the default — a pronoun somebody chose since in a walk is theirs and is kept. A re-run
       * finds it set and writes nothing.
       */
      if (opts.pronoun && SEED_OWNED_EMAIL.test(email) && (existing.pronoun ?? 'they') === 'they') {
        const { modifiedCount } = await Users.updateOne(
          { _id: existing._id, pronoun: { $in: ['they', null] } }, { $set: { pronoun: opts.pronoun } },
        ).exec();
        pronounsSet += modifiedCount;
        if (modifiedCount) existing.set('pronoun', opts.pronoun);
      }
      /*
       * **What a person records** (ADR-0158), given once to an account an earlier run made before the
       * seed recorded it — on an address the seed owns, and only while it has none, so a birth date
       * somebody typed on `/profile` in a walk is kept. Its agent code is left as it is: a code is
       * never rewritten, and the production rows already imported join on it.
       */
      if (SEED_OWNED_EMAIL.test(email) && existing.get('platformRole') !== 'super_admin' && !existing.get('dateOfBirth')) {
        const { dateOfBirth, gender, companyJoinMonth } = seedPersonalFor(email, existing.get('pronoun'));
        await Users.updateOne(
          { _id: existing._id, dateOfBirth: null },
          { $set: { dateOfBirth, gender, companyJoinMonth } },
        ).exec();
      }
      return existing;
    }
    const platformRole = opts.platformRole ?? 'none';
    const sellsForSomebody = platformRole !== 'super_admin';
    // Only a counted code advances the count: an account that brings its own (the coaching cast)
    // leaves everybody after it on the number a fresh seed has always given them.
    if (!opts.agentCode) issued += 1;
    return Users.create({
      email,
      passwordHash: await passwords.hash(opts.password ?? FIELD_PASSWORD),
      fullName,
      platformRole,
      companyId: sellsForSomebody ? (opts.companyId ?? String(prudential._id)) : null,
      // Digits only, as every new code is since ADR-0158 §4. It was `PRU-80001` and so on until then.
      agentCode: sellsForSomebody
        ? (opts.agentCode ?? String(80000 + issued))
        : null,
      // What a person records (ADR-0158). A Super Admin sells for nobody, and records none of it.
      ...(sellsForSomebody ? seedPersonalAccount(email, opts.pronoun) : {}),
      status: opts.status ?? 'active',
      pronoun: opts.pronoun ?? 'they',
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
      // The prototype's four tiles (ADR-0064); a database seeded before them gets them from 0021.
      summaryGroupCode: c.summaryGroupCode, summaryGroupLabel: c.summaryGroupLabel,
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

    /*
     * The office's activity binding (ADR-0163 §1): today's three codes, one per cascade role — what provisioning
     * gives an office from the AgencyBoost defaults, and what the Super Admin's *Activity binding* card opens on.
     */
    if (await missing(ActivityBindings as never)) {
      await ActivityBindings.create({
        kpmId, ...defaultBinding(), version: 1, status: 'active', archivedAt: null, deletedAt: null,
        createdBy: null, updatedBy: null,
      });
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
    /*
     * *Phase 18.5 (the exit review):* at plausible hours of the office's day — Kickoff 09:00–13:00, PRULink 10:00–13:00
     * in Jakarta — where they were the run's own minute plus whole hours. Only the running huddle stays relative to the
     * run: from an hour before it to six hours after, so a walk finds it still running (it ended two hours in).
     */
    const hour = 3_600_000;
    const today = clock.localDateFor(DEFAULT_TENANT_TIMEZONE);
    const at = (offsetDays: number, localHour: number) => new Date(
      clock.startOfLocalDay(DEFAULT_TENANT_TIMEZONE, addLocalDays(today, offsetDays)).getTime() + localHour * hour,
    );
    const fromNow = (hours: number) => new Date(clock.now().getTime() + hours * hour);
    if (await missing(Events as never)) {
    await Events.insertMany([
      {
        kpmId, code: 'KICKOFF', typeCode: 'TRAINING', ...DEMO_EVENTS.KICKOFF,
        description: '', startsAt: at(14, 9), endsAt: at(14, 13), location: 'Kantor KPM',
        locationUrl: null,
        audience: { issuer: 'kpm', scope: 'all_agents', inviteeMembershipIds: [] },
      },
      {
        kpmId, code: 'LEADERS_HUDDLE', typeCode: 'RECOGNITION', ...DEMO_EVENTS.LEADERS_HUDDLE,
        description: '', startsAt: fromNow(-1), endsAt: fromNow(6), location: 'Ruang rapat',
        locationUrl: null,
        // Leaders by the graph, never by job title — which is what makes this row worth seeding.
        audience: { issuer: 'kpm', scope: 'leaders', inviteeMembershipIds: [] },
      },
      {
        kpmId, code: 'PRULINK_BRIEFING', typeCode: 'PRODUCT_LAUNCH', ...DEMO_EVENTS.PRULINK_BRIEFING,
        description: '', startsAt: at(-21, 10), endsAt: at(-21, 13), location: 'Online',
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
     * none of what the screens are for. So: one product it turned off, and the three review states
     * the approval queue exists to tell apart — **pending**, **approved** (its words frozen, which is
     * what agents actually read) and **sent back** with a reason. The first product's row is the one
     * `sales-tools-fixture.ts` lays 0417's approved description onto.
     *
     * *Changed 2026-10-26 (P18.95-T6, UI-023):* that first row no longer renames the product. It read
     * *"PRUMapan (nama kami)"* — "our name" — which the client took, rightly, for a placeholder on the
     * catalog; migration `0039-product-name-placeholder` gives a database seeded before this the
     * company's name back. An office's rename is walked by renaming one on `/kpm/settings/products`.
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
          overrides: {},
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
        kpmId, code: 'YEAR_END_DRIVE', title: 'Kejar Star Club Akhir Tahun',
        description: 'Dorong sampai Star Club sebelum tahun berakhir.',
        startsAt: at(-30, 0), endsAt: at(60, 0),
        requirements: [{
          metricKey: 'APE_ACHIEVED', comparator: 'gte',
          value: 500_000_000 * 100, unit: 'idr_minor',
        }],
        reward: 'Tambahan anggaran unit dan makan malam bersama',
      },
      {
        kpmId, code: 'RECRUIT_SPRINT', title: 'Sprint recruitment',
        description: 'Empat minggu recruitment, dihitung dari aktivitas.',
        startsAt: at(-120, 0), endsAt: at(-90, 0),
        requirements: [{
          metricKey: 'RECRUITMENT_SUCCESS_RATE', comparator: 'gte', value: 0.3, unit: 'ratio',
        }],
        reward: 'Apresiasi di rapat bulanan',
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
      eventTypeRows, capabilityRow, checklistRow, bindingRow,
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
      // The binding in force, which a publish records (ADR-0163 §1).
      ActivityBindings.findOne({ kpmId, status: 'active', deletedAt: null }).lean().exec(),
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
      activityBinding: bindingRow
        ? {
          leads: (bindingRow as { leads: string[] }).leads,
          appointments: (bindingRow as { appointments: string[] }).appointments,
          closings: (bindingRow as { closings: string[] }).closings,
          version: (bindingRow as { version: number }).version,
          updatedAt: null,
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
      /**
       * Backdates the join — `joinedAt` and the `joined` edge's `validFrom` together — so it comes
       * before the member's first activity, goal, promotion and session. Without it everybody joins at
       * the moment of the run, after weeks of their own history.
       */
      joinedDaysAgo?: number;
      /** The role on the `joined` edge, for somebody promoted since: the role change log has the move. */
      joinedAs?: Role;
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
      // ADR-0158: a membership an earlier run made before work status existed is given one, once.
      if (!existing.get('workStatus')) {
        const account = await Users.findOne({ _id: userId }).exec();
        const email = account?.get('email') as string | undefined;
        if (email && SEED_OWNED_EMAIL.test(email)) {
          await Memberships.updateOne(
            { _id: existing._id, workStatus: null },
            { $set: { workStatus: seedPersonalFor(email).workStatus } },
          ).exec();
        }
      }
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
    const joined = daysAgo(opts.joinedDaysAgo ?? 0);

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
      joinedAt: status === 'pending' ? null : joined,
      /*
       * ADR-0169: the join date is the day the join is backdated to, in the office's calendar, and everybody is an
       * existing agent here — the fixtures that give somebody an activation make them a new hire, from its start
       * (`markNewHires`), as migration 0040 classifies a database written before the fields. Not `opts.joinedAs`,
       * which is the rung on the `joined` edge. A pending row has neither: nobody has let them in.
       */
      joinDate: status === 'pending' ? null : clock.localDateFor(DEFAULT_TENANT_TIMEZONE, joined),
      joinedAs: status === 'pending' ? null : 'existing_agent',
      removedAt: status === 'removed' ? daysAgo(opts.removedDaysAgo ?? 0) : null,
      recruitedByMembershipId: leaderId,
      // Full-time or part-time in this office (ADR-0158 §1), from the same derivation as the person's
      // birth date, so a reseed gives the same answer.
      workStatus: seedPersonalFor(String(account?.get('email') ?? userId)).workStatus,
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
      toRole: opts.joinedAs ?? role, toLeaderId: leaderId, validFrom: joined, validTo: null,
    });
    if (status === 'removed') {
      // As `RemovalService` writes it: one instant closes every row still open, whichever chain
      // opened it, and opens the `removed` row (roles §6.1, invariant §5). Written open beside the
      // `joined` row, it gave the membership two current edges.
      const removedAt = daysAgo(opts.removedDaysAgo ?? 0);
      await History.updateMany(
        { kpmId, membershipId: String(created._id), validTo: null },
        { $set: { validTo: removedAt } },
      );
      await History.create({
        kpmId, membershipId: String(created._id), eventType: 'removed',
        fromRole: role, validFrom: removedAt, validTo: null,
        reason: 'Keluar dari industri asuransi.',
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
    /*
     * As `MembershipHistoryRepository.openEdge` writes it (P11-T3): the promotion's instant closes
     * every edge row still open, and opens the `role_changed` row, which carries the leader the
     * member keeps, so the one open edge states where they stand. Written open beside the `joined`
     * row, it gave the membership two current edges. The admin chain is not an edge, and stays.
     */
    const at = daysAgo(days);
    await History.updateMany(
      { kpmId, membershipId: membership.id, eventType: { $in: [...EDGE_EVENTS] }, validTo: null },
      { $set: { validTo: at } },
    );
    await History.create({
      kpmId,
      membershipId: membership.id,
      eventType: 'role_changed',
      fromRole: from,
      toRole: to,
      toLeaderId: membership.ancestorIds.at(-1) ?? null,
      validFrom: at,
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
  for (const { code, label, displayOrder, leaderTier } of DEFAULT_ORG_LADDER) {
    const existing = await OrgLevels.findOne({ companyId: String(prudential._id), code }).exec();
    if (!existing) {
      await OrgLevels.create({
        companyId: String(prudential._id), code, label, displayOrder, leaderTier,
        status: 'active', archivedAt: null, deletedAt: null,
      });
    }
  }

  /*
   * **Allianz Life's own ladder, with rungs it named itself** (P18.8-T1, ADR-0156): *Unit Manager* marked
   * *Associate Leader* and *Senior Manager* marked *Senior Leader*, so `/admin/org-levels` shows a ladder whose
   * leaders are not called AB or AAB. Allianz has no office yet, so nobody stands on them and the tiers can still
   * be changed there; the members who hold a custom rung's rights are the seed task's (P18.8-T14).
   */
  for (const rung of [
    { code: 'AGENT', label: 'Agent', displayOrder: 1, leaderTier: null },
    { code: 'UM', label: 'Unit Manager', displayOrder: 2, leaderTier: 'associate' },
    { code: 'SM', label: 'Senior Manager', displayOrder: 3, leaderTier: 'senior' },
  ]) {
    if (!(await OrgLevels.exists({ companyId: String(allianz._id), code: rung.code }))) {
      await OrgLevels.create({
        companyId: String(allianz._id), ...rung, status: 'active', archivedAt: null, deletedAt: null,
      });
    }
  }

  // ---------------------------------------------------------- KPM 0417, the main office

  const ownerUser = await user('owner@kpm0417.test', 'Wilson Tanoto', { password: 'demo password 0417', pronoun: 'he' });
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
  /*
   * **Open since January last year** (P18.8-T11, ADR-0161 §4): the Personal Summary's month and year selects run
   * from the office's first month, the month its record was created, and the production files begin then
   * (`reporting-fixture.ts`). Written to the collection, as `createdAt` is immutable to the model; only ever moved
   * earlier, so a later run leaves an office opened earlier still is.
   */
  {
    const today = clock.localDateFor(DEFAULT_TENANT_TIMEZONE);
    const opened = clock.startOfLocalDay(DEFAULT_TENANT_TIMEZONE, `${Number(today.slice(0, 4)) - 1}-01-01`);
    await Kpms.collection.updateOne({ _id: kpm0417._id, createdAt: { $gt: opened } }, { $set: { createdAt: opened } });
  }

  await configure(id0417);
  /*
   * **Published, and untouched since: the prototype's settings** (P13.1-T3, K5). The office the client
   * walks is the one their prototype draws: the platform's defaults as `configure` copies them — the
   * twelve activity types, the two ladders, the five ratios at the platform's benchmarks — with nothing
   * archived, no ratio of the office's own and no edit since publishing, so its publish bar reads clean.
   * The defaults differ from the prototype only where a register says so (ADR-0043's seventh recruitment
   * stage, item 7's label; ADR-0160's words for items 3, 7 and 8, its benchmarks and *Set appointment to
   * meeting*).
   *
   * It used to carry the settings screens' demonstration states as well: an archived type and status,
   * *Referral rate*, *Selling success rate* raised to 18%. The client read them as the seed disagreeing
   * with the prototype, and the archived type was behind their Log Activity report besides (a row the
   * screen showed and the save refused). They are office 0555's now, below. A database seeded before
   * keeps them here until `--reset`: the seed leaves rows that exist.
   */
  await publish(id0417, daysAgo(45));

  /*
   * **When the people the coaching demo rests on joined** (P11-T2, from the verification of its history).
   * Each date comes before the member's first activity, goal, promotion and coaching session, and after
   * their leader joined or, under an AAB, after that AAB's promotion, because an Agent leads nobody. The
   * Owner joined when the audit log below says they were assigned the office; the coaching cast's dates
   * are in `coaching-cast.ts`. Everybody else still joins at the moment of the run.
   */
  const owner = await place(office0417, String(ownerUser._id), 'ab', null, { joinedDaysAgo: OWNER_ASSIGNED_DAYS_AGO });

  // Admin rights are orthogonal to hierarchy role: this one is an AB as well.
  const adminUser = await user('admin@kpm0417.test', 'Maya Halim', { pronoun: 'she' });
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
  const abUser = await user('agus@kpm0417.test', 'Agus Prasetyo', { pronoun: 'he' });
  const ab = await place(office0417, String(abUser._id), 'ab', owner, { joinedDaysAgo: 106 });

  // Joined as Agents, and promoted below: before Sari's first session with Agus, 21 days ago.
  const sariUser = await user('sari@kpm0417.test', 'Sari Puspita', { pronoun: 'she' });
  const sari = await place(office0417, String(sariUser._id), 'aab', ab, { joinedDaysAgo: 103, joinedAs: 'agent' });

  // The case OD-23 settles: holds the role, leads nobody.
  const dewiUser = await user('dewi@kpm0417.test', 'Dewi Lestari', { pronoun: 'she' });
  const dewi = await place(office0417, String(dewiUser._id), 'aab', ab, { joinedDaysAgo: 100, joinedAs: 'agent' });

  // Both AABs were agents first. Without these the Role change log is empty, and an
  // empty log reads as a screen that does not work.
  await promotedEarlier(id0417, sari, 'agent', 'aab', ab, DEMO_REASONS.sariPromoted, 62);
  await promotedEarlier(id0417, dewi, 'agent', 'aab', ab, DEMO_REASONS.dewiPromoted, 21);

  /*
   * Sari's two agents joined after her promotion, 62 days ago: Budi the day after, before his first logged
   * day (59 back); Rina before hers (44 back) and before this year's first plan (54 back). Their arrival
   * notices below carry the same days. Rina's plan for last year is older than the office, and stays:
   * it is what the goal history screen reads (P8-T6).
   */
  const rinaUser = await user('rina@kpm0417.test', 'Rina Wijaya', { password: 'demo password rina', pronoun: 'she' });
  const rina = await place(office0417, String(rinaUser._id), 'agent', sari, { joinedDaysAgo: RINA_JOINED_DAYS_AGO });
  const budiUser = await user('budi@kpm0417.test', 'Budi Santoso', { pronoun: 'he' });
  const budi = await place(office0417, String(budiUser._id), 'agent', sari, { joinedDaysAgo: BUDI_JOINED_DAYS_AGO });

  // Registered and waiting on a leader, with the request already sent.
  const pendingUser = await user('pending@kpm0417.test', 'Putri Anggraini', { pronoun: 'she' });
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
  const untaggedUser = await user('untagged@kpm0417.test', 'Fajar Nugroho', { pronoun: 'he' });
  await place(office0417, String(untaggedUser._id), 'agent', null, { status: 'pending' });

  // Left the office. The row stays, and so does everything attached to it.
  const removedUser = await user('removed@kpm0417.test', 'Yanti Kusuma', { pronoun: 'she' });
  await place(office0417, String(removedUser._id), 'agent', sari, {
    status: 'removed',
    removedDaysAgo: 48,
    joinedDaysAgo: 60,
  });

  // Came back. A second, live membership for the same person, with its own agent code —
  // the case P3-T7 AC-4 exists for, and the one a reader will not believe until they
  // see the same name twice on the roster. Joined the day her inbox says she was approved.
  const yanti = await place(office0417, String(removedUser._id), 'agent', sari, { joinedDaysAgo: 28 });

  /*
   * **The coaching cast (P11-T2 AC-1).** Agus had two AABs and no agent of his own, so the roster's
   * first group — *Your direct agents* — was empty on the account a demo opens with. He gets three, and a
   * second AAB unit with two agents. Placed after everybody above, so every earlier member keeps the
   * agent sequence a fresh seed has always given them, and with codes of their own (`coaching-cast.ts`).
   * `place()` writes the leader edge as the org module does: `leaderId`, the cached `ancestorIds` and
   * `depth`, and a `joined` row open from the day the cast says they joined (`validTo: null`). Arief
   * joined as an Agent and is promoted here, before Novi and Wahyu join his unit: the promotion closes
   * his `joined` row at its own instant and is the one edge left open (`promotedEarlier`).
   */
  const cast = {} as Record<CastKey, Placed>;
  for (const person of COACHING_CAST) {
    const account = await user(person.email, person.fullName, { agentCode: person.agentCode, pronoun: person.pronoun });
    cast[person.key] = await place(
      office0417, String(account._id), person.role, person.leader === 'agus' ? ab : cast.arief,
      { joinedDaysAgo: person.joinedDaysAgo, joinedAs: person.promoted ? 'agent' : person.role },
    );
    if (person.promoted) {
      await promotedEarlier(
        id0417, cast[person.key], 'agent', person.role, ab, person.promoted.reason, person.promoted.daysAgo,
      );
    }
  }

  /** Everybody the demo AB coaches, by the key `coaching-cast.ts` and `coaching-fixture.ts` use. */
  const coachees: Record<CoacheeKey, Placed> = { ...cast, sari, dewi, rina, budi, yanti };

  for (const id of [owner.id, ab.id, sari.id, cast.arief.id]) await recount(id0417, id);

  /*
   * **The Owner's reporting's two new agencies (Phase 18, *Seed*; `reporting-fixture.ts`)**: Yosef's and Satria's,
   * under the Owner, outside every documented leader's downline, each member joined over six months ago. Placed
   * after the coaching cast — so every earlier member keeps the agent sequence a fresh seed has always given them,
   * with codes of their own — and before the month files, which list them as they list everybody.
   */
  const reportingCast = await placeReportingCast({
    clock, kpmId: id0417, office0417, owner, recount,
    user: (email, fullName, opts) => user(email, fullName, opts),
    place: (kpm, userId, role, leader, opts) => place(kpm, userId, role, leader, opts),
  });

  /**
   * Informal groups, and the Core Leader tag.
   *
   * Seeded so the Groups tab has something to show and the person page has a tag to
   * render. Deliberately cutting across the hierarchy — Rina reports to Sari, Maya to
   * the Owner — because that is the whole point of a group: it is not the tree.
   */
  const groupSeeds = [
    { ...DEMO_GROUPS.mentoring, owner: sari.id, members: [rina.id, budi.id] },
    { ...DEMO_GROUPS.topProducers, owner: owner.id, members: [ab.id, sari.id] },
  ];
  for (const seed of groupSeeds) {
    // Found under the name an earlier run gave it too, so a database seeded before P18.98-T7 gets no second group.
    const names = 'formerly' in seed ? [seed.name, seed.formerly] : [seed.name];
    const existing = await Groups.findOne({ kpmId: id0417, name: { $in: names } }).exec();
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
  // Core Leader decides who, besides the Owner and the Admins, may open and write in the Strategic Leader Forum's
  // meetings (built in Phase 18.1, `leader-forum-fixture.ts`), and nothing else.
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

  /*
   * ------------------------------------------------------ Leads (P7-T1, P7-T2, P7-T3)
   *
   * **Without these the Leads screen is an empty table**, and an empty table cannot be reviewed:
   * every state it has to render — a stage, an attention flag, a closed lead, a commitment for
   * the month — is a row or it is nothing.
   *
   * Three things are deliberately spread across them:
   *
   * - **The contact details**: one with a name and nothing else, phones in the formats agents type —
   *   each opens WhatsApp from its row's *Actions* (ADR-0161 §2) — and one reachable only by email. *No lawful basis since
   *   2026-10-07 (ADR-0108): the client removed the field, and the API neither takes nor returns one.*
   * - **The ladder**, because a status is reached by *moving* (ADR-0045) — so each seeded lead
   *   that holds one also holds the transitions that put it there, walked or jumped.
   * - **What is asking to be picked up**, so the attention filter has something to find: one
   *   overdue, one with no next action, one with neither a date nor a remark.
   *
   * One lead sits **open on the stage that closes its pipeline**, which is the only way to see
   * the ✓ enabled; one is **won** there, and one is **lost from the middle of the ladder** —
   * which is §3.7's asymmetry made visible rather than asserted.
   */
  interface LeadSeed {
    owner: string;
    name: string;
    /**
     * The name the seed wrote this lead under before. A database seeded then keeps its row under that
     * name and is not given a second one; `--reset` brings the new name.
     */
    formerly?: string;
    type: 'sales' | 'recruitment' | null;
    /** The stages this lead has been through, oldest first. The last one is where it sits. */
    path?: string[];
    outcome?: 'won' | 'lost';
    phone?: string;
    email?: string;
    remarks?: string;
    /** Days from today. Negative is in the past, which is what *overdue* means. */
    nextActionIn?: number;
    nextActionNote?: string;
    thisMonth?: boolean;
    source?: string;
    /**
     * Somebody other than the owner made the last change (ADR-0044).
     *
     * Seeded because P7-T7's acceptance criterion is a claim about what an **agent sees on their
     * own screen** — so the fixture has to contain a lead a leader touched, or the criterion
     * cannot be checked the way it is written.
     */
    lastEditedBy?: string;
    /**
     * Days before the run it was registered, and of its last move (P13.1-T3): a pipeline built over
     * weeks, so the table's newest-registered order has something to order. The moves are spread
     * evenly between the two. Left out, a lead is registered 20 days back and moves every four days
     * from 18 back, as every lead before these was.
     */
    registeredDaysAgo?: number;
    movedDaysAgo?: number;
  }

  /** `YYYY-MM-DD` in the office's timezone — the same day boundary the server resolves. */
  const leadDay = (inDays: number) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(daysAgo(-inDays));

  const seedLeads = async (kpmId: string, seeds: readonly LeadSeed[]) => {
    for (const seed of seeds) {
      const names = seed.formerly ? [seed.name, seed.formerly] : [seed.name];
      if (await Leads.findOne({ kpmId, name: { $in: names } }).exec()) continue;
      const path = seed.path ?? [];
      const here = path.at(-1) ?? null;
      const status = here
        ? await LeadStatuses.findOne({ kpmId, code: here }).lean().exec()
        : null;

      // Oldest first, and spaced so the history reads as a fortnight of work rather than as one
      // instant — which is what makes it useful to a leader reading it in a coaching session.
      const registered = seed.registeredDaysAgo ?? 20;
      const moved = seed.movedDaysAgo ?? registered;
      const movedAt = (i: number) => (seed.registeredDaysAgo === undefined
        ? daysAgo(18 - i * 4)
        : daysAgo(registered - (path.length > 1 ? Math.round((i * (registered - moved)) / (path.length - 1)) : 0)));
      const transitions = path.map((code, i) => ({
        fromStatusCode: i === 0 ? null : path[i - 1],
        toStatusCode: code,
        at: movedAt(i),
        byMembershipId: seed.owner,
      }));

      await Leads.create({
        kpmId,
        ownerMembershipId: seed.owner,
        name: seed.name,
        type: seed.type,
        contact: { phone: seed.phone ?? null, email: seed.email ?? null },
        statusCode: here,
        statusId: status ? String((status as { _id: unknown })._id) : null,
        /*
         * A promise carries the month it was made for (P7-T5), so nothing has to clear it. Seeded
         * as **this** month in the office's zone — a demo lead promised for a month that has
         * already ended would read as not promised, which is the mechanism working and a fixture
         * that shows nothing.
         */
        commitments: seed.thisMonth
          ? [{ month: leadDay(0).slice(0, 7), at: daysAgo(3), byMembershipId: seed.owner }]
          : [],
        remarks: seed.remarks ?? null,
        nextActionDate: seed.nextActionIn === undefined ? null : leadDay(seed.nextActionIn),
        nextActionNote: seed.nextActionNote ?? null,
        outcome: seed.outcome ?? null,
        outcomeAt: seed.outcome ? daysAgo(2) : null,
        dateRegistered: daysAgo(registered),
        source: seed.source ?? null,
        // One for the record, one for each move, one for the outcome — what the product would
        // have written had somebody done this by hand.
        version: 1 + transitions.length + (seed.outcome ? 1 : 0),
        transitions,
        deletedAt: null,
        createdBy: seed.owner,
        updatedBy: seed.lastEditedBy ?? seed.owner,
      });
    }
  };

  await seedLeads(id0417, [
    // A name from a Thursday BOP and nothing more — legal to hold, and the reason the gate sits
    // on the contact fields rather than on the record. No type, so no stage is possible yet.
    { owner: rina.id, name: 'Pak Bambang', type: null, remarks: 'Ketemu di BOP hari Kamis.' },
    {
      // Seeded as *Ibu Dewi Lestari* until P11-T2's verification: the AAB's own name, on the roster the
      // coaching demo walks, where *Leads · Ibu Dewi Lestari* in Rina's sessions read as the AAB.
      owner: rina.id, name: 'Ibu Rosa Damayanti', formerly: 'Ibu Dewi Lestari', type: 'sales',
      path: ['NOT_YET_APPROACHED', 'FOLLOW_UP'],
      phone: '0812-1100-2200',
      remarks: 'Kebutuhan utama: anak sulung masuk kuliah dua tahun lagi.',
      nextActionIn: 7, nextActionNote: 'Ngopi di Grand Indonesia, jam 10.00.',
      thisMonth: true, source: 'Referral — Ibu Sari',
    },
    {
      // Overdue, and committed for the month — the pair the prototype hides behind its green
      // chip and this product does not (P7-T4 AC-2).
      // Sari coached Rina on this one and left a note, so the agent's screen shows *Edited by
      // Ibu Sari* — which is the phase's exit criterion, seeded rather than asserted.
      lastEditedBy: sari.id,
      owner: rina.id, name: 'Pak Hendro Gunawan', type: 'sales',
      path: ['NOT_YET_APPROACHED', 'FOLLOW_UP', 'POLICY_SUBMITTED'],
      email: 'hendro.g@example.com',
      remarks: 'SPAJ sudah masuk di asuransi lain; masih membandingkan.',
      nextActionIn: -6, nextActionNote: 'Follow up soal ilustrasinya.',
      thisMonth: true, source: 'Canvassing — Senayan',
    },
    {
      // Nothing typed against it at all: no date and no remark, so it carries two flags.
      owner: rina.id, name: 'Pak Surya Dharma', type: 'sales',
      path: ['NOT_YET_APPROACHED'],
      source: 'Datang langsung — kantor BSD',
    },
    {
      // Open, on the stage that closes the pipeline. The only state in which ✓ is available.
      owner: rina.id, name: 'Ibu Wulan Sari', type: 'sales',
      path: ['NOT_YET_APPROACHED', 'FOLLOW_UP', 'POLICY_SUBMITTED', 'APPROVED_NOT_PAID', 'PAID_AND_ISSUED'],
      phone: '0811-9090-3030',
      remarks: 'Premi sudah dibayar tanggal 12; menunggu dokumen polis.',
      nextActionIn: 2, nextActionNote: 'Serahkan polisnya.',
      thisMonth: true, source: 'Referral — Pak Hendro',
    },
    {
      // Won, and therefore carrying no attention flags whatever its dates say.
      owner: rina.id, name: 'Ibu Ratna Kusuma', type: 'sales',
      path: ['NOT_YET_APPROACHED', 'POLICY_SUBMITTED', 'PAID_AND_ISSUED'], outcome: 'won',
      phone: '0812-3344-5566',
      remarks: 'Ambil produk dana pendidikan. Tanya soal polis kedua untuk putranya.',
      source: 'Referral — Ibu Sari',
    },
    {
      owner: budi.id, name: 'Sdri. Maya Puspita', type: 'recruitment',
      path: ['NOT_APPROACHED'],
      phone: '0813-4455-6677',
      remarks: 'Direferensikan sepupunya yang sudah jadi agen. Belum didekati.',
      source: 'Referral — jaringan agen',
    },
    {
      owner: budi.id, name: 'Pak Andi Kurniawan', type: 'recruitment',
      path: ['NOT_APPROACHED', 'MEETING_SCHEDULED', 'RECRUITMENT_PRESENTATION', 'AGENT_CODE_CREATED', 'AAJI_LICENSED'],
      phone: '0857-7788-9900',
      remarks: 'Sudah ikut NBO. Tanya soal jadwal lisensi.',
      nextActionIn: 11, nextActionNote: 'Kirim jadwal ujian AAJI.',
      thisMonth: true, source: 'BOP — 12 September',
    },
    {
      // Lost from the middle of the ladder, which is allowed and won is not (§3.7).
      owner: budi.id, name: 'Pak Joko Prasetyo', type: 'recruitment',
      path: ['NOT_APPROACHED', 'MEETING_SCHEDULED'], outcome: 'lost',
      phone: '0856-2233-4455',
      remarks: 'Memilih kerja kantoran bergaji tetap. Boleh ditawari lagi tahun depan.',
      source: 'BOP — 12 September',
    },
    /*
     * **A year behind Rina, so the two closed cards can be read.**
     *
     * The screen lists five per card and shows the office's real total in the header, with *See all*
     * handing the rest to the table — none of which can be seen with one closed lead each, and the
     * two there were belonged to different agents, so nobody saw both cards populated.
     *
     * Six won and two lost: enough for one card to exceed what it lists, which is the case the count
     * exists for.
     */
    {
      owner: rina.id, name: 'Pak Bambang Sutrisno', type: 'sales',
      path: ['NOT_YET_APPROACHED', 'FOLLOW_UP', 'POLICY_SUBMITTED', 'APPROVED_NOT_PAID', 'PAID_AND_ISSUED'],
      outcome: 'won', phone: '0811-2233-4455',
      remarks: 'Asuransi jiwa seumur hidup, premi tahunan. Berikutnya minta istrinya dibuatkan juga.',
      source: 'Referral — Pak Hendro',
    },
    {
      owner: rina.id, name: 'Ibu Dewi Anggraini', type: 'sales',
      path: ['NOT_YET_APPROACHED', 'POLICY_SUBMITTED', 'PAID_AND_ISSUED'],
      outcome: 'won', email: 'dewi.a@example.com',
      remarks: 'Dana pendidikan untuk dua anak. Tanya soal top up tahun depan.',
      source: 'Canvassing — Senayan',
    },
    {
      owner: rina.id, name: 'Pak Slamet Riyadi', type: 'sales',
      path: ['NOT_YET_APPROACHED', 'FOLLOW_UP', 'POLICY_SUBMITTED', 'PAID_AND_ISSUED'],
      outcome: 'won', phone: '0812-9988-7766',
      remarks: 'Rider penyakit kritis ditambahkan saat underwriting.',
      source: 'BOP — 12 September',
    },
    {
      owner: rina.id, name: 'Ibu Lestari Wibowo', type: 'sales',
      path: ['NOT_YET_APPROACHED', 'POLICY_SUBMITTED', 'PAID_AND_ISSUED'],
      outcome: 'won',
      remarks: 'Pindahan dari polis yang dia pegang di tempat lain.',
      source: 'Referral — Ibu Ratna',
    },
    {
      owner: rina.id, name: 'Pak Yusuf Maulana', type: 'sales',
      path: ['NOT_YET_APPROACHED', 'FOLLOW_UP', 'POLICY_SUBMITTED', 'PAID_AND_ISSUED'],
      outcome: 'won', phone: '0857-1122-3344',
      remarks: 'Bayar lewat transfer hari itu juga. Memberi referral saudaranya.',
      source: 'Referral — jaringan agen',
    },
    {
      // Lost late, which the ladder allows at any rung (§3.7) — and the more useful case to see,
      // because a lead that reached submission and still fell away is the one worth a conversation.
      owner: rina.id, name: 'Pak Hendra Gunawan', type: 'sales',
      path: ['NOT_YET_APPROACHED', 'FOLLOW_UP', 'POLICY_SUBMITTED'], outcome: 'lost',
      phone: '0813-7766-5544',
      remarks: 'Underwriting minta pemeriksaan medis, dia tidak bersedia.',
      source: 'Canvassing — Senayan',
    },
    {
      owner: rina.id, name: 'Sdri. Fitri Handayani', type: 'recruitment',
      path: ['NOT_APPROACHED', 'MEETING_SCHEDULED'], outcome: 'lost',
      email: 'fitri.h@example.com',
      remarks: 'Mau menyelesaikan kuliah dulu. Minta dihubungi lagi tahun depan.',
      source: 'BOP — 12 September',
    },
    {
      // Somebody else's, so a leader screen has more than one agent's work to show in P7-T7.
      owner: dewi.id, name: 'Pak Rizal Effendi', type: 'sales',
      path: ['NOT_YET_APPROACHED', 'FOLLOW_UP'],
      phone: '0815-6677-8899',
      remarks: 'Minta dihitungkan rider penyakit kritis.',
      nextActionIn: 4, nextActionNote: 'Kirim dua ilustrasinya.',
      source: 'Referral — Pak Agus',
    },
  ]);

  /*
   * **The coaching cast's leads (P11-T2 AC-2):** open ones for every coachee, some with a next action
   * date, one promised this month with a date — and Siti's one promised with none (`coaching-cast.ts`).
   * `'unless-held'` is decided against the database as it stands, after the leads above: Rina and Budi
   * keep the promises Phase 7 gave them, and a database whose promises are last month's gets one for
   * this month.
   */
  const thisMonthKey = leadDay(0).slice(0, 7);
  const coachingLeadSeeds: LeadSeed[] = [];
  for (const plan of COACHING_LEADS) {
    const owner = coachees[plan.owner].id;
    const promised = plan.thisMonth === 'unless-held'
      ? !(await Leads.exists({
          kpmId: id0417, ownerMembershipId: owner, outcome: null, deletedAt: null,
          'commitments.month': thisMonthKey,
        }).exec())
      : plan.thisMonth;
    coachingLeadSeeds.push({
      owner, name: plan.name, type: plan.type, path: plan.path,
      nextActionIn: plan.nextActionIn, nextActionNote: plan.nextActionNote,
      thisMonth: promised, remarks: plan.remarks, source: plan.source,
    });
  }
  await seedLeads(id0417, coachingLeadSeeds);

  /*
   * **Budi's long pipeline (P13.1-T3 AC-3):** 39 open leads beside the three he had, so `/leads` has more
   * than its first 30 to show and *Show more* can be reviewed. After the coaching cast's, so his
   * `'unless-held'` promise is decided as before: none of these is promised for any month. Why Budi, and
   * what is spread across them, is in `long-pipeline.ts`.
   */
  await seedLeads(id0417, LONG_PIPELINE.map((lead) => ({
    ...lead, owner: budi.id, path: lead.path ? [...lead.path] : undefined,
  })));

  /*
   * ------------------------------------------------------------------ Goals (P8-T1)
   *
   * **A goal is the only place an agent says what they intend to produce**, and four surfaces read
   * it. Without these the Goal Settings screen opens on defaults for everybody, and the two states
   * that are actually interesting — a plan somebody has re-planned, and a plan their leader set —
   * cannot be looked at.
   *
   * The snapshots are left at zero deliberately: **what the inputs produce is P8-T2's**, and a
   * seeded figure here would be a number this codebase cannot yet derive, sitting in the field
   * whose whole point is that it records something that *was* derived.
   */
  /*
   * **The periods are the run's years in the office's zone** (P11-T2 AC-5), not the literals they were:
   * a seed run in January wrote last year's goal as the current one, and the Summary measured nobody.
   */
  const thisYear = clock.localDateFor(DEFAULT_TENANT_TIMEZONE).slice(0, 4);
  const lastYear = String(Number(thisYear) - 1);

  const goalSeeds: ReadonlyArray<{
    owner: string;
    period: string;
    /** When the current plan was saved. Twelve days ago unless a seed says otherwise. */
    savedDaysAgo?: number;
    mode: 'direct' | 'from_savings';
    annual: number;
    savings?: number;
    commissionPct?: number;
    /** `null` uses the office's calendar, which is what most agents leave it at. */
    monthsLeft: number | null;
    achieved: number;
    caseSize: number;
    leadsToAppt: number;
    closing: number;
    /** Somebody other than the owner saved it — a leader, in a 1-on-1 (ADR-0046). */
    savedBy?: string;
    /**
     * The plans this one replaced, **oldest first** — each written as only what differed.
     *
     * Without these, `/goals` has a History panel with nothing in it, and P8-T6 cannot be reviewed
     * in a browser. `version` is derived from the length rather than typed, because a fixture that
     * says version 5 and carries no revisions is a state the service cannot produce.
     */
    priors?: Array<Partial<{
      mode: 'direct' | 'from_savings';
      annual: number;
      savings: number;
      commissionPct: number;
      monthsLeft: number | null;
      achieved: number;
      caseSize: number;
      leadsToAppt: number;
      closing: number;
      savedBy: string;
    }>>;
  }> = [
    {
      // Rina: the ordinary case, a plan she set herself and has since updated as she produced.
      owner: rina.id, period: thisYear, mode: 'direct',
      annual: 500_000_000_00, monthsLeft: null, achieved: 120_000_000_00,
      caseSize: 18_000_000_00, leadsToAppt: 30, closing: 30,
      priors: [
        // Where she started: the office's defaults, before she had produced anything.
        { achieved: 0 },
        // She raised the target once the year was clearly going better than she planned for.
        { annual: 420_000_000_00, achieved: 60_000_000_00 },
      ],
    },
    {
      // Budi: the second entry mode. He thinks in take-home pay, not in APE.
      owner: budi.id, period: thisYear, mode: 'from_savings',
      annual: 300_000_000_00, savings: 30_000_000_00, commissionPct: 10,
      monthsLeft: null, achieved: 45_000_000_00,
      // No priors: the first plan somebody saves, and the History panel says so.
      caseSize: 15_000_000_00, leadsToAppt: 25, closing: 20,
    },
    {
      // Dewi: **set by her leader**, so the agent's screen has an attribution to show (ADR-0046).
      owner: dewi.id, period: thisYear, mode: 'direct',
      // Sari set a shorter runway than the calendar says, and the override survives every read.
      annual: 750_000_000_00, monthsLeft: 2.5, achieved: 210_000_000_00,
      caseSize: 22_000_000_00, leadsToAppt: 35, closing: 30,
      savedBy: ab.id,
      // Her own plan, which her leader then replaced — so the History panel shows a name changing
      // hands, which is the case worth reviewing.
      priors: [{ annual: 500_000_000_00, monthsLeft: null, savedBy: dewi.id }],
    },
    {
      // Rina, last year: what a history screen reads, and the reason `period` is a key (ADR-0049).
      owner: rina.id, period: lastYear, mode: 'direct',
      annual: 400_000_000_00, monthsLeft: 0.1, achieved: 415_000_000_00,
      caseSize: 16_000_000_00, leadsToAppt: 30, closing: 30,
      priors: [
        { achieved: 0, monthsLeft: null },
        { achieved: 180_000_000_00, monthsLeft: null, closing: 25 },
      ],
    },
    /*
     * **The coaching cast's plans (P11-T2 AC-2)**: every coachee but Sari holds one for this year, and
     * Novi's was saved by Arief in a 1-on-1 (ADR-0046). `achieved` is the agent's own figure — the APE
     * they say they have — which the office's imported year to date replaces wherever it is held.
     */
    ...COACHING_GOALS.map((plan) => ({
      owner: coachees[plan.key].id, period: thisYear, savedDaysAgo: plan.savedDaysAgo,
      mode: plan.mode, annual: plan.annual, savings: plan.savings, commissionPct: plan.commissionPct,
      monthsLeft: null,
      achieved: (COACHING_PRODUCTION.find((p) => p.key === plan.key)?.baseMonthly ?? 0)
        * Math.max(0, Number(clock.localDateFor(DEFAULT_TENANT_TIMEZONE).slice(5, 7)) - 1),
      caseSize: plan.caseSize, leadsToAppt: plan.leadsToAppt, closing: plan.closing,
      savedBy: plan.savedBy ? coachees[plan.savedBy].id : undefined,
    })),
  ];

  type GoalSeed = (typeof goalSeeds)[number];

  /**
   * One whole state of a plan: the inputs as the record stores them, and what they meant.
   *
   * **Derived, not typed** (P8-T2). Seeding a hand-written figure here would be the prototype's own
   * defect — its markup says 80 leads and its calculator says 67 — planted in the fixture this
   * product is reviewed from. Used for the current plan and for every revision behind it, so a
   * history entry cannot disagree with the formula either.
   */
  const goalState = (seed: GoalSeed, over: NonNullable<GoalSeed['priors']>[number], savedOn: Date) => {
    const it = { ...seed, ...over };
    const inputs = {
      mode: it.mode,
      annualApeTargetMinor: it.annual,
      savingsTargetMinor: it.savings ?? 0,
      commissionRatePct: it.commissionPct ?? 0,
      apeAchievedMinor: it.achieved,
      caseSizeMinor: it.caseSize,
      leadsToApptPct: it.leadsToAppt,
      closingRatePct: it.closing,
    };
    const agreed = computeCascade({
      ...inputs,
      // The figure in force when the plan was agreed: the agent's own, or the office's calendar on
      // that day. The override is what the record keeps (P8-T5).
      monthsLeft: it.monthsLeft ?? defaultMonthsLeft(seed.period, savedOn, DEFAULT_TENANT_TIMEZONE),
    });
    return {
      ...inputs,
      monthsLeftOverride: it.monthsLeft,
      snapshot: {
        monthlyApeTargetMinor: agreed.monthlyApeTargetMinor,
        policiesPerMonth: agreed.policiesPerMonth,
        appointmentsPerMonth: agreed.appointmentsPerMonth,
        leadsPerMonth: agreed.leadsPerMonth,
      },
    };
  };

  for (const seed of goalSeeds) {
    if (await Goals.findOne({ kpmId: id0417, membershipId: seed.owner, period: seed.period }).exec()) {
      continue;
    }
    const priors = seed.priors ?? [];
    const savedDaysAgo = seed.period === lastYear ? 300 : (seed.savedDaysAgo ?? 12);
    const currentDay = daysAgo(savedDaysAgo);
    // Three weeks apart, oldest first, ending at the current plan — so the History panel reads as a
    // sequence of conversations rather than a pile sharing one timestamp.
    const priorDay = (i: number) => daysAgo(
      savedDaysAgo + (priors.length - i) * 21,
    );

    await Goals.create({
      kpmId: id0417,
      membershipId: seed.owner,
      period: seed.period,
      ...goalState(seed, {}, currentDay),
      cascadeMapping: { ...CASCADE_ACTIVITY_CODES },
      savedAt: currentDay,
      savedByMembershipId: seed.savedBy ?? seed.owner,
      /*
       * **Derived from the revisions, never typed** (P8-T6). The service reaches version N by
       * saving N times and keeping N-1 prior states, so a fixture claiming version 5 with an empty
       * history is a row the product cannot produce — and the screen would show a version number
       * with nothing behind it.
       */
      version: priors.length + 1,
      revisions: priors.map((over, i) => ({
        version: i + 1,
        ...goalState(seed, over, priorDay(i)),
        at: priorDay(i),
        byMembershipId: over.savedBy ?? seed.owner,
      })),
      deletedAt: null,
      createdBy: seed.savedBy ?? seed.owner,
      updatedBy: seed.savedBy ?? seed.owner,
    });
  }

  // --------------------------------------------------- monthly production (P9-T4)

  /*
   * Three months, each a state the Data upload screen has to be reviewable in:
   *
   * - **This month** — an import that was reverted, then a corrected one standing over it. History
   *   shows both, and Revert is offered on the standing one. Two members are left out of it, so the
   *   table shows dashes beside figures and the preview says who a file does not list.
   * - **Last month** — one import. Locked by the schedule once its window closes, seven days after
   *   the month ends, so Reopen is offered.
   * - **The month before** — nothing at all, which is its own state.
   *
   * Written as the service writes it — batch, rows with their previous values, month rows carrying
   * the batch as their source, the month's revision, and the audit entries — so a revert of the seeded
   * import puts back exactly what the seed says was there.
   *
   * **Each month is written when it holds nothing yet** (P11-T2 AC-6), where the guard used to ask
   * whether the office held any import at all: a run in a month the database has not seen fills that
   * month in, and leaves alone every month that has an import or a state of its own.
   *
   * **The coaching cast is on the files with everybody else** (P11-T2 AC-2), with the figures
   * `coaching-cast.ts` plans for them. The members the seed had before keep theirs, worked out from
   * their place among themselves — so the quiet member and the two left out of this month's file are who
   * they have always been.
   */
  const Batches = mongoose.model(DataUploadBatch.name, DataUploadBatchSchema, undefined, RECOMPILE);
  const UploadRows = mongoose.model(DataUploadRow.name, DataUploadRowSchema, undefined, RECOMPILE);
  const MonthRows = mongoose.model(MonthlyAgentData.name, MonthlyAgentDataSchema, undefined, RECOMPILE);
  const Months = mongoose.model(ProductionMonth.name, ProductionMonthSchema, undefined, RECOMPILE);

  const thisMonth = clock.localDateFor(DEFAULT_TENANT_TIMEZONE).slice(0, 7);
  const shift = (month: string, by: number) => {
    const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1 + by, 1));
    return d.toISOString().slice(0, 7);
  };
  const lastMonth = shift(thisMonth, -1);
  /** A month somebody has imported into, or corrected by hand, is the database's and not the seed's. */
  const held = async (month: string) => Boolean(
    (await Batches.exists({ kpmId: id0417, month }).exec())
    ?? (await Months.exists({ kpmId: id0417, month, deletedAt: null }).exec()),
  );
  const writeLastMonth = !(await held(lastMonth));
  const writeThisMonth = !(await held(thisMonth));

  if (writeLastMonth || writeThisMonth) {
    type RosterRow = { _id: unknown; agentCode: string };
    const roster = await Memberships.find({ kpmId: id0417, status: 'active', deletedAt: null })
      .sort({ agentSeq: 1 }).lean().exec() as unknown as RosterRow[];
    const castKeyOf = new Map<string, CastKey>(
      (Object.entries(cast) as [CastKey, Placed][]).map(([key, placed]) => [placed.id, key]),
    );
    // The reporting cast's months are planned (`reporting-fixture.ts`), as the coaching cast's are.
    const reportingKeyOf = new Map<string, ReportingKey>(
      (Object.entries(reportingCast) as [ReportingKey, Placed][]).map(([key, placed]) => [placed.id, key]),
    );
    // Everybody the seed had before the coaching cast, in the order their figures have always followed.
    const earlier = roster.filter((member) => !castKeyOf.has(String(member._id)) && !reportingKeyOf.has(String(member._id)));

    const field = monthField;
    const EMPTY = { value: null, provenance: null, sourceBatchId: null };

    // Everybody else's month: `production-figures.ts`, which the reporting fixture's history months read too.
    const figures = seedMonthFigures;
    /*
     * **Yanti's first weeks back sold nothing** (P18.96-T5; ADR-0172, `functional/unit-dashboard.md`, *Seed*): last
     * month's file lists her live membership with no APE and no policy, and this month's leaves her out (below), so
     * she is a new hire with no first sale — the roster's *New hire*, in Agus's and Sari's team and in neither total's
     * production nor *On pace to be active*. Her year to date is the carrier's, from before she left.
     */
    const quietLastMonth = new Set([yanti.id]);

    /**
     * **A coaching cast member's month** (P11-T2 AC-4): last month the plan's base; this month the planned
     * share of their `MONTHLY_APE_TARGET`, taken from the year to date the office holds before the month
     * — the same reading the Summary makes — through the product's own `monthlyApeTarget`. So *On track*
     * and *Watch closely* hold in whatever month the seed runs.
     */
    const castFigures = async (key: CastKey, membershipId: string, month: string, scale = 1) => {
      const plan = COACHING_PRODUCTION.find((p) => p.key === key)!;
      const year = month.slice(0, 4);
      const m = Number(month.slice(5));
      const goal = await Goals.findOne({ kpmId: id0417, membershipId, period: year, deletedAt: null }).lean().exec();
      const [before] = await MonthRows.find({
        kpmId: id0417, membershipId, deletedAt: null,
        month: { $gte: `${year}-01`, $lt: month }, 'apeYtd.value': { $ne: null },
      }).sort({ month: -1 }).limit(1).lean().exec();
      const ytdBefore = m === 1 ? 0 : ((before?.apeYtd?.value as number | null | undefined) ?? plan.baseMonthly * (m - 1));
      const annual = goal ? annualTargetOf({
        mode: goal.mode, annualApeTargetMinor: goal.annualApeTargetMinor, savingsTargetMinor: goal.savingsTargetMinor,
        commissionRatePct: goal.commissionRatePct, monthsLeft: 1, apeAchievedMinor: goal.apeAchievedMinor,
        caseSizeMinor: goal.caseSizeMinor, leadsToApptPct: goal.leadsToApptPct, closingRatePct: goal.closingRatePct,
      }) : 0;
      const ape = month === thisMonth
        ? Math.round(monthlyApeTarget(annual, ytdBefore, m) * plan.thisMonthShareOfTarget)
        : plan.baseMonthly;
      const caseSize = goal?.caseSizeMinor ?? plan.baseMonthly;
      const leads = key === 'arief' ? 1 : 0;
      const monthly: Record<string, number> = {
        ape: ape * scale, persistency: 88 + (m % 8), recruitment: leads, newActiveAgents: leads * (m % 2),
        fyp: Math.round(ape * 0.6) * scale, policyCount: ape > 0 ? Math.max(1, Math.round(ape / caseSize)) : 0,
      };
      const ytd: Record<string, number> = {
        ape: (ytdBefore + ape) * scale, persistency: monthly.persistency - 2, recruitment: leads * m,
        newActiveAgents: leads * Math.floor(m / 2), fyp: Math.round((ytdBefore + ape) * 0.6) * scale,
        policyCount: Math.max(monthly.policyCount, Math.round((ytdBefore + ape) / caseSize)),
      };
      return Object.fromEntries(PRODUCTION_METRICS.flatMap((metric) => [
        [field(metric, 'monthly'), monthly[metric]],
        [field(metric, 'ytd'), ytd[metric]],
      ]));
    };

    const figuresFor = async (member: RosterRow, month: string, scale = 1): Promise<Record<string, number> | null> => {
      const key = castKeyOf.get(String(member._id));
      const reporting = reportingKeyOf.get(String(member._id));
      if (reporting) {
        const values = reportingMonthFigures(reporting, month, thisMonth);
        return values && Object.fromEntries(Object.entries(values).map(([k, v]) => [k, k.startsWith('persistency') ? v : v * scale]));
      }
      return key
        ? castFigures(key, String(member._id), month, scale)
        : figures(earlier.indexOf(member), month, scale, { quiet: month === lastMonth && quietLastMonth.has(String(member._id)) });
    };
    // A member a month's file leaves out is not on it: no row (`reportingMonthFigures`).
    const rowsFor = async (members: readonly RosterRow[], month: string, scale = 1) => {
      const rows: { member: RosterRow; values: Record<string, number> }[] = [];
      for (const member of members) {
        const values = await figuresFor(member, month, scale);
        if (values) rows.push({ member, values });
      }
      return rows;
    };

    const batchOf = async (spec: {
      month: string; filename: string; revision: number; at: Date;
      rows: { member: RosterRow; values: Record<string, number> }[];
      previous: (field: string) => typeof EMPTY | null;
      reverted?: Date;
    }) => {
      const cells = spec.rows.length * 12;
      const batch = await Batches.create({
        kpmId: id0417, month: spec.month, status: spec.reverted ? 'reverted' : 'committed',
        filename: spec.filename,
        fileSha256: createHash('sha256').update(`${spec.filename}:${spec.month}`).digest('hex'),
        templateVersion: 1, encoding: 'utf-8', delimiter: ',',
        basedOnRevision: spec.revision - 1, monthRevision: spec.revision,
        rowCount: spec.rows.length, writtenRowCount: spec.rows.length, cellCount: cells, issueCount: 0,
        startedAt: spec.at, committedAt: spec.at, committedBy: owner.id,
        revertedAt: spec.reverted ?? null, revertedBy: spec.reverted ? admin.id : null,
        restoredCellCount: spec.reverted ? cells : 0, keptCellCount: 0,
        deletedAt: null, createdBy: owner.id, updatedBy: spec.reverted ? admin.id : owner.id,
      });
      const batchId = String(batch._id);
      await UploadRows.insertMany(spec.rows.map((r, n) => ({
        kpmId: id0417, batchId, month: spec.month, line: n + 2, agentCode: r.member.agentCode,
        membershipId: String(r.member._id), status: 'ready', values: r.values,
        previousValues: Object.fromEntries(Object.keys(r.values).map((k) => [k, spec.previous(k)])),
        issues: [], deletedAt: null, createdBy: owner.id, updatedBy: owner.id,
      })));
      await Audit.create({
        kpmId: id0417, actorUserId: String(ownerUser._id), actorMembershipId: owner.id,
        action: 'upload.commit', targetCollection: 'dataUploadBatches', targetId: batchId,
        after: { month: spec.month, filename: spec.filename, writtenRowCount: spec.rows.length },
      });
      if (spec.reverted) {
        await Audit.create({
          kpmId: id0417, actorUserId: String(adminUser._id), actorMembershipId: admin.id,
          action: 'upload.revert', targetCollection: 'dataUploadBatches', targetId: batchId,
          before: { status: 'committed' }, after: { status: 'reverted', restoredCellCount: cells, keptCellCount: 0 },
        });
      }
      return batchId;
    };

    const monthRow = (member: RosterRow, month: string, cells: Record<string, unknown>) => ({
      kpmId: id0417, membershipId: String(member._id), agentCode: member.agentCode, month,
      ...Object.fromEntries(PRODUCTION_METRICS.flatMap((metric) => (['monthly', 'ytd'] as const)
        .map((c) => [field(metric, c), cells[field(metric, c)] ?? EMPTY]))),
      deletedAt: null, createdBy: owner.id, updatedBy: owner.id,
    });

    if (writeLastMonth) {
      // Last month: one import, standing.
      const lastRows = await rowsFor(roster, lastMonth);
      const lastId = await batchOf({
        month: lastMonth, filename: templateFilename('0417', lastMonth), revision: 1, at: daysAgo(20),
        rows: lastRows, previous: () => null,
      });
      await MonthRows.insertMany(lastRows.map((r) => monthRow(r.member, lastMonth, Object.fromEntries(
        Object.entries(r.values).map(([k, v]) => [k, { value: v, provenance: 'imported', sourceBatchId: lastId }]),
      ))));
      await Months.create({ kpmId: id0417, month: lastMonth, revision: 1, deletedAt: null, createdBy: owner.id, updatedBy: owner.id });
    }

    if (writeThisMonth) {
      // This month: an import typed in thousands instead of millions, reverted by the Admin …
      const wrong = await rowsFor(roster, thisMonth, 1000);
      await batchOf({
        month: thisMonth, filename: templateFilename('0417', thisMonth), revision: 1, at: daysAgo(3),
        rows: wrong, previous: () => null, reverted: daysAgo(2),
      });
      // … then the corrected file, standing — everybody but the last two the seed had before the cast.
      const leftOut = new Set(earlier.slice(-2).map((member) => String(member._id)));
      const right = await rowsFor(roster.filter((member) => !leftOut.has(String(member._id))), thisMonth);
      const rightId = await batchOf({
        month: thisMonth, filename: templateFilename('0417', thisMonth).replace('.csv', '-corrected.csv'), revision: 3, at: daysAgo(1),
        rows: right, previous: () => ({ ...EMPTY }),
      });
      const written = new Map(right.map((r) => [String(r.member._id), r.values]));
      // … and one figure corrected by hand over it (P9-T5): the first member's APE, which the carrier
      // restated after the file was sent. A revert of the standing import keeps it, and says so.
      const correctedAt = daysAgo(0.5);
      const firstId = right[0] ? String(right[0].member._id) : null;
      const firstApe = right[0] ? Math.round(right[0].values.apeMonthly * 1.1) : 0;
      const correction = {
        value: firstApe, provenance: 'corrected', sourceBatchId: null,
        correctedBy: admin.id, correctedAt, reason: 'Perusahaan meralat APE lewat email setelah file dikirim.',
        replacedValue: right[0]?.values.apeMonthly ?? null,
      };
      await MonthRows.insertMany(roster.map((member) => monthRow(member, thisMonth, {
        ...Object.fromEntries(Object.entries(written.get(String(member._id)) ?? {})
          .map(([k, v]) => [k, { value: v, provenance: 'imported', sourceBatchId: rightId }])),
        ...(String(member._id) === firstId ? { apeMonthly: correction } : {}),
      })));
      if (right[0]) {
        await Audit.create({
          kpmId: id0417, actorUserId: String(adminUser._id), actorMembershipId: admin.id,
          action: 'upload.cell_corrected', targetCollection: 'monthlyAgentData',
          targetMembershipId: String(right[0].member._id),
          before: { month: thisMonth, field: 'apeMonthly', value: right[0].values.apeMonthly, provenance: 'imported', sourceBatchId: rightId },
          after: { month: thisMonth, field: 'apeMonthly', value: firstApe, provenance: 'corrected', reason: correction.reason },
        });
      }
      await Months.create({ kpmId: id0417, month: thisMonth, revision: 4, deletedAt: null, createdBy: owner.id, updatedBy: admin.id });
    }
  }

  // ------------------------------------------------- KPM 0555, for cross-tenant checks

  const owner0555User = await user('owner@kpm0555.test', 'Hendra Wijaya', { pronoun: 'he' });
  const kpm0555 = await office(String(prudential._id), '0555', 'Kelapa Gading Branch', {
    ownerUserId: String(owner0555User._id),
    address: 'Jl. Boulevard Raya, Jakarta Utara',
  });
  const office0555 = {
    _id: kpm0555._id,
    code: kpm0555.get('code') as string,
    companyId: kpm0555.get('companyId') as string,
  };
  const id0555 = String(kpm0555._id);
  await configure(id0555);
  // Published a month back, then changed — so 0555's publish bar shows the state that matters: its
  // agent on one copy while the Owner works on another. 0417 is the clean counterpart (K5).
  await publish(id0555, daysAgo(30));

  /*
   * **The states a settings screen can only show if something is in them** (P13.1-T3: moved here from
   * 0417, which now holds the prototype's settings and nothing else).
   *
   * Every one of these was unreachable in a seeded database once: nothing was ever archived, so
   * *Show archived* was an empty checkbox; every ratio was the platform's, so the two row kinds P4-T15
   * added looked identical; and nothing had been touched since publishing, so the publish bar only ever
   * had one thing to say. Sign in as `owner@kpm0555.test` to see them.
   *
   * **Each is written only over the row as `configure` left it** — version 1, active — so a re-run
   * writes nothing, and a row somebody restored or edited in a walk is theirs, not the seed's to undo.
   */
  // Retired, not deleted (invariant §3): the office records its 1-on-1s as coaching sessions, so the
  // self-reported row went. Archived after publishing, so Lina's Log Activity still offers it until the
  // Owner publishes — the case P13.1-T2 makes savable.
  await ActivityTypes.updateOne(
    { kpmId: id0555, code: 'DEV_COACHING_RECEIVED', version: 1, status: 'active' },
    { $set: { status: 'archived', archivedAt: daysAgo(12), version: 2 } },
  );
  // Kelapa Gading takes the first premium with the application, so a policy is never approved and
  // unpaid there. Neither of the office's two leads stands on it.
  await LeadStatuses.updateOne(
    { kpmId: id0555, code: 'APPROVED_NOT_PAID', version: 1, status: 'active' },
    { $set: { status: 'archived', archivedAt: daysAgo(9), version: 2 } },
  );

  /*
   * **An edit since publishing, on a row that is still active**: the Owner raised the selling bar to 40%
   * and has not published, so the settings screen shows 40.0% while Lina is still judged at 30.0%.
   *
   * The first version of this seed archived and edited one row in the same breath, when the bar compared
   * the highest live version only and so read clean; P5-T11 compares which rows are present at which
   * version, and an edit on a live row is the change an Owner most often makes.
   */
  await RatioDefinitions.updateOne(
    { kpmId: id0555, code: 'SELLING_SUCCESS_RATE', version: 1 },
    { $set: { benchmark: 0.4, version: 2 } },
  );

  if (!(await RatioDefinitions.findOne({ kpmId: id0555, code: 'REFERRAL_RATE' }).exec())) {
    // An office's own (ADR-0021): formula included, and comparable with nobody. New prospects per
    // existing prospect contacted, which is where a referral comes from.
    await RatioDefinitions.create({
      kpmId: id0555,
      code: 'REFERRAL_RATE',
      label: 'Rasio referral',
      numerator: ['LEADS_NEW_PROSPECT'],
      denominator: ['LEADS_CONTACTED'],
      benchmark: 0.35,
      comparison: 'gte',
      // A conversion rate, so the Owner reads 35.0% — the unit they chose for their own.
      displayUnit: 'percent',
      displayOrder: 6,
      origin: 'office',
      // Their referral push is the senior rungs' programme this quarter (ADR-0020): Hendra's, not Lina's.
      appliesToOrgLevelCodes: ['AB', 'AAB'],
      version: 1,
      status: 'active',
      archivedAt: null,
      deletedAt: null,
    });
  }

  // Both joined about two months ago (the Phase 18 exit review): before their files, their logging and their 1:1,
  // so 0555's reports read a membership that was there for what it holds. Lina's activation starts on the same day.
  const owner0555 = await place(office0555, String(owner0555User._id), 'ab', null, { joinedDaysAgo: OFFICE_0555_JOINED_DAYS_AGO });
  const agent0555User = await user('agent@kpm0555.test', 'Lina Marlina', { pronoun: 'she' });
  const agent0555 = await place(office0555, String(agent0555User._id), 'agent', owner0555, { joinedDaysAgo: OFFICE_0555_JOINED_DAYS_AGO });
  await recount(String(kpm0555._id), owner0555.id);

  /*
   * Two leads in the second office, on the two ladders.
   *
   * **The point is that they are unreachable from the first.** A cross-tenant negative asserted
   * against an empty collection passes for the wrong reason — there is nothing to leak — so the
   * office that must not be readable has rows worth reading.
   */
  await seedLeads(String(kpm0555._id), [
    {
      owner: agent0555.id, name: 'Ibu Christine Halim', type: 'sales',
      path: ['NOT_YET_APPROACHED', 'FOLLOW_UP'],
      phone: '0819-2200-3311',
      remarks: 'Kelapa Gading. Tertarik unit link, ragu soal biayanya.',
      nextActionIn: 3, nextActionNote: 'Jelaskan tabel biayanya.',
      source: 'Datang langsung — Kelapa Gading',
    },
    {
      owner: owner0555.id, name: 'Pak Teguh Santoso', type: 'recruitment',
      path: ['NOT_APPROACHED', 'MEETING_SCHEDULED'],
      email: 'teguh.s@example.com',
      remarks: 'Kepala cabang di sebuah bank, cari penghasilan tambahan.',
      source: 'Referral — Hendra',
    },
  ]);

  // ------------------------------------------- a suspended office, and somebody in it

  const suspendedOwnerUser = await user('owner@kpm0999.test', 'Bagus Setiawan', { pronoun: 'he' });
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

  // ------------------------- subscriptions and the leader limit (P13.2; `subscription-fixture.ts`)

  const subscriptions = await seedSubscriptionFixture({
    clock, Kpms: Kpms as never, companyId: String(prudential._id), kpm0417: id0417, kpm0555: id0555,
    user, configure, publish, place, recount, daysAgo,
    // ADR-0157: 0603's leaders past its limit, their requests, and the promotions they carried out.
    promote: promotedEarlier, LeaderLimitRequests: LeaderLimitRequests as never, superAdminUserId: String(superAdmin._id),
  });

  // ------------------- named templates, and an office started Empty (P13.2-T6; `template-fixture.ts`)

  const templates = await seedTemplateFixture({
    clock, reset: options.reset, Kpms: Kpms as never,
    companies: [prudential, allianz].map((c) => ({ _id: String(c._id), name: c.get('name') as string })),
    user, publish, place, recount, daysAgo,
  });

  // ------------------- a template saved from 0417's settings (P13.2-T7; `template-copy-fixture.ts`)

  const templateCopies = await seedTemplateCopyFixture({
    clock, companyId: String(prudential._id), kpm0417: id0417,
  });

  // ------------------- the sales tools: 0417's new decisions, commission (Phase 14; `sales-tools-fixture.ts`)

  const salesTools = await seedSalesToolsFixture({
    clock, companyId: String(prudential._id), kpm0417: id0417, ownerMembershipId: owner.id,
    ownerUserId: String(ownerUser._id), superAdminUserId: String(superAdmin._id),
  });

  // ------------------- the Unit Dashboard: Indah's nomination, Sari's correction (Phase 15; `unit-dashboard-fixture.ts`)

  const unitDashboard = await seedUnitDashboardFixture({
    clock, kpm0417: id0417, indah: cast.indah.id, budi: budi.id,
    sari: { membershipId: sari.id, userId: String(sariUser._id) },
  });

  // ------------------- recruitment tools: the playbooks, the pitch, 0417's brochure (Phase 17; `recruitment-fixture.ts`)

  const recruitment = await seedRecruitmentFixture({
    clock,
    storage: options.storage ?? null,
    companies: { prudential: String(prudential._id), allianz: String(allianz._id) },
    offices: {
      '0417': {
        kpmId: id0417,
        owner: { membershipId: owner.id, userId: String(ownerUser._id) },
        admin: { membershipId: admin.id, userId: String(adminUser._id) },
      },
      '0555': {
        kpmId: id0555,
        owner: { membershipId: owner0555.id, userId: String(owner0555User._id) },
        admin: null,
      },
    },
  });
  if (recruitment.files !== 'stored') log(`Recruitment pitch documents and 0417's PRUMapan brochure ${recruitment.files}.`);

  // ------------------- the Owner's reporting: a year of files, two agencies, sign-ins (Phase 18; `reporting-fixture.ts`)

  const reporting = await seedReportingFixture({
    clock, kpmId: id0417,
    owner: { membershipId: owner.id, userId: String(ownerUser._id) },
    admin: { membershipId: admin.id },
    cast: reportingCast,
    coachingCastIds: new Set(Object.values(cast).map((placed) => placed.id)),
    office0555: { kpmId: id0555, owner: owner0555.id, agent: agent0555.id },
  });

  // ------------------- a lead list in a dragged order (P18.8-T7; ADR-0161 §1)

  /*
   * **Every lead above gets its place in its owner's list, and Rina's list is one she has dragged** (P18.8-T7
   * AC-1, P18.8-T14 AC-1). `GET /leads` without a sort reads `position`, so a lead with none would sort first,
   * and a list in registration order cannot show that the order is kept: every lead of Rina's is registered
   * on one day. Here, after the last fixture that writes a lead.
   *
   * Rina's open leads first, in the order an agent would put them — the one waiting on its policy, then the
   * overdue one, then the next meetings, the two with nothing planned last — **only while none of hers holds
   * a place yet**, so a walk that dragged them is not undone by the next run. Then migration 0031 places every
   * other lead, newest registration first, below anything already placed: Rina's closed ones, and everybody
   * else's. A second run places nothing.
   */
  const RINA_DRAGGED = [
    'Ibu Wulan Sari', 'Pak Hendro Gunawan', 'Ibu Rosa Damayanti', 'Ibu Kartika Dewanti', 'Pak Surya Dharma', 'Pak Bambang',
  ];
  const rinaOpen = await Leads.find({ kpmId: id0417, ownerMembershipId: rina.id, outcome: null, deletedAt: null })
    .sort({ dateRegistered: -1, _id: -1 }).exec();
  if (rinaOpen.length > 0 && rinaOpen.every((lead) => lead.position === null)) {
    // A name the list does not hold keeps its registration order, after the ones it does.
    const rank = (name: string) => (RINA_DRAGGED.indexOf(name) + RINA_DRAGGED.length + 1) % (RINA_DRAGGED.length + 1);
    const dragged = [...rinaOpen].sort((a, b) => rank(a.name) - rank(b.name));
    await Leads.bulkWrite(dragged.map((lead, position) => ({
      updateOne: { filter: { _id: lead._id, position: null }, update: { $set: { position } } },
    })), { timestamps: false });
  }
  await leadPosition(mongoose.connection.db!);

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
    pronoun: SeedPronoun,
    branchName: string,
    fields: Record<string, unknown>,
  ) {
    const who = await user(email, fullName, { pronoun });
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

  await kpmRequest('ade@agencyboost.test', 'Ade Kurniawan', 'he', 'Bandung Kota Branch', {
    note: 'Enam agen siap pindah dari cabang yang akan tutup.',
    createdAt: daysAgo(3),
  });
  await kpmRequest('maya@agencyboost.test', 'Maya Sari', 'she', 'Surabaya Timur Branch', {
    note: null,
    createdAt: daysAgo(1),
  });
  await kpmRequest('tomi@agencyboost.test', 'Tomi Halim', 'he', 'Medan Selatan Branch', {
    status: 'declined',
    decidedAt: daysAgo(9),
    decidedByUserId: String(superAdmin._id),
    reason: 'Terlalu dekat dengan kantor yang sudah ada. Silakan ajukan lagi setelah pembagian wilayah selesai.',
    createdAt: daysAgo(12),
  });
  await kpmRequest('owner@kpm0555.test', 'Hendra Wijaya', 'he', 'Kelapa Gading Branch', {
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
   * Only the seven templates whose subject matter Phase 3 actually built are seeded here. The
   * other in-app templates — goals, coaching, event reminders — arrive with their phases:
   * pointing a reader at a screen that does not exist is worse than an empty row. Coaching's
   * arrived: each coachee's latest finalized fixture session is announced below, with the
   * fixture (`COACHING_SESSION_FINALIZED`).
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
    opts: {
      readDaysAgo?: number; readAt?: Date;
      /** The payload an earlier run wrote this notice with, before its words were Indonesian (P18.98-T7). */
      formerly?: Record<string, unknown>;
    } & ({ sentDaysAgo: number } | { sentAt: Date }),
  ) {
    /*
     * **Keyed on what the notice says, never on when** (P11-T2 AC-6). The key was `createdAt`, which is
     * `daysAgo()` of the run's own clock — a different instant on every run — so each re-seed without
     * `--reset` delivered every notice again (nine doubled on a database seeded twice). Who, which
     * template and the payload's fields are the notice; a re-run finds it and writes nothing.
     */
    const existing = await Notifications.findOne({
      userId: to.userId, templateId,
      $or: [payload, ...(opts.formerly ? [opts.formerly] : [])].map((said) => asFieldFilter({ payload: said })),
    }).exec();
    if (existing) return;
    const at = 'sentAt' in opts ? opts.sentAt : daysAgo(opts.sentDaysAgo);
    await Notifications.create({
      kpmId: id0417,
      membershipId: to.membershipId,
      userId: to.userId,
      templateId,
      payload,
      // Sent on the channels the template declares, as `NotificationService.send` delivers it: a
      // finalize notice is in-app only, so it carries no email it was never sent.
      delivery: Object.fromEntries(
        (TEMPLATE_CHANNELS[templateId as NotificationTemplateId] ?? []).map((channel) => [channel, { status: 'sent', at }]),
      ),
      readAt: opts.readAt ?? (opts.readDaysAgo === undefined ? null : daysAgo(opts.readDaysAgo)),
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
    { reason: DEMO_REASONS.sariPromoted },
    { sentDaysAgo: 62, readDaysAgo: 61, formerly: { reason: FORMER_REASONS.sariPromoted } },
  );
  await notify(
    { userId: String(dewiUser._id), membershipId: dewi.id },
    NotificationTemplate.ROLE_CHANGED,
    { reason: DEMO_REASONS.dewiPromoted },
    { sentDaysAgo: 21, readDaysAgo: 20, formerly: { reason: FORMER_REASONS.dewiPromoted } },
  );

  // Rina and Budi: how each of them arrived. Two different doors, two templates, on the days they joined.
  await notify(
    { userId: String(rinaUser._id), membershipId: rina.id },
    NotificationTemplate.JOIN_REQUEST_APPROVED,
    {},
    { sentDaysAgo: RINA_JOINED_DAYS_AGO, readDaysAgo: RINA_JOINED_DAYS_AGO - 1 },
  );
  await notify(
    { userId: String(budiUser._id), membershipId: budi.id },
    NotificationTemplate.MEMBER_TAGGED_BY_LEADER,
    {},
    { sentDaysAgo: BUDI_JOINED_DAYS_AGO },
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
    { reason: DEMO_REASONS.yantiRemoved },
    { sentDaysAgo: 50, readDaysAgo: 49, formerly: { reason: FORMER_REASONS.yantiRemoved } },
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
    { reason: DEMO_REASONS.fajarDeclined },
    { sentDaysAgo: 8, formerly: { reason: FORMER_REASONS.fajarDeclined } },
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
    /** The fields an earlier run wrote this row with, before its words were Indonesian (P18.98-T7). */
    formerly?: Record<string, unknown>,
  ) {
    /*
     * **The same trap, the same fix** (P11-T2 AC-6): `fields` carries `createdAt: daysAgo(n)`, a new
     * instant on every run, so matching on it never found the row it had written. The entry is the
     * action and what it was done to; when is not part of what it is.
     */
    const { createdAt: _when, ...what } = fields;
    const existing = await Audit.findOne({
      action, $or: [what, ...(formerly ? [{ ...what, ...formerly }] : [])].map((said) => asFieldFilter(said)),
    }).exec();
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
    createdAt: daysAgo(OWNER_ASSIGNED_DAYS_AGO),
  });
  await audited('kpm.suspended', 'kpms', {
    targetId: String(kpm0999._id),
    before: { status: 'active' },
    after: { status: 'suspended', reason: DEMO_REASONS.suspended },
    createdAt: daysAgo(14),
  }, { after: { status: 'suspended', reason: FORMER_REASONS.suspended } });
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
    after: { reason: DEMO_REASONS.removedForCompetitor },
    createdAt: daysAgo(50),
  }, { after: { reason: FORMER_REASONS.removedForCompetitor } });

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
    after: { reason: DEMO_REASONS.impersonation, minutes: 60 },
    createdAt: daysAgo(6),
  }, { after: { reason: FORMER_REASONS.impersonation, minutes: 60 } });
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

  /** The office's active types, read once: nothing below archives or adds one. */
  let typesHeld: Awaited<ReturnType<typeof readActiveTypes>> | null = null;
  const readActiveTypes = () => ActivityTypes.find({ kpmId: id0417, status: 'active' }).lean().exec();
  const activeTypes = async () => (typesHeld ??= await readActiveTypes());

  const logDay = async (
    membershipId: string,
    daysBack: number,
    counts: Record<string, number>,
    extra: Record<string, unknown> = {},
  ) => {
    /*
     * **Leaves what exists**, like every other writer in this file.
     *
     * This one had no guard and was the only seeder that could *fail* a re-run rather than
     * no-op it: `activityLogs` carries a unique `(kpmId, membershipId, localDate)` index, and
     * the days below are relative to **today**. Seed on Tuesday and Rina's `daysBack: 0` writes
     * Tuesday; seed again on Wednesday and her `daysBack: 1` writes Tuesday a second time —
     * E11000, on a script the docs call idempotent, part-way through so that everything after
     * it never ran. Which is how it surfaced: a re-seed for Phase 7 stopped before the leads
     * block it was run for.
     *
     * Skipping rather than overwriting is the same contract as `notify` and `audited` above: a
     * day that is already there keeps the counts it has.
     */
    const localDate = jakartaDay(daysBack);
    if (await mongoose.connection.collection('activityLogs')
      .findOne({ kpmId: id0417, membershipId, localDate })) return;

    const types = await activeTypes();
    const entries = types.map((type) => ({
      activityTypeId: String((type as { _id: unknown })._id),
      activityTypeCode: (type as { code: string }).code,
      count: counts[(type as { code: string }).code] ?? 0,
    }));
    await mongoose.connection.collection('activityLogs').insertOne({
      kpmId: id0417,
      membershipId,
      localDate,
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

  /*
   * **A coachee's weeks of activity (P11-T2 AC-2)**, written through `logDay`, so a day that exists keeps
   * the counts it has. A plan can ask for two things, each decided against the database as it stands:
   *
   * - `sellingFreeThisMonth` drops the three cascade codes from every day of the current month, so the
   *   member is not pacing to MAA on any day of it;
   * - `pacing` tops **today's** row up when the month's cascade total — the days held and the days this
   *   run adds — falls short of `pacingFloor` for the member's goal, so they pace from the first of the
   *   month. It never rewrites a day already there.
   */
  const activityToday = jakartaDay(0);
  const activityMonthStart = `${activityToday.slice(0, 7)}-01`;
  const cascadeTotal = (counts: DayCounts) => CASCADE_CODES.reduce((sum, code) => sum + (counts[code] ?? 0), 0);
  const logPlan = async (membershipId: string, plan: Pick<ActivityPlan, 'days' | 'counts' | 'sellingFreeThisMonth' | 'pacing'>) => {
    const planned = new Map<number, Record<string, number>>();
    for (const back of plan.days) {
      const counts: Record<string, number> = { ...plan.counts(back) };
      if (plan.sellingFreeThisMonth && jakartaDay(back) >= activityMonthStart) {
        for (const code of CASCADE_CODES) delete counts[code];
      }
      planned.set(back, counts);
    }
    const todays = planned.get(0);
    if (plan.pacing && todays) {
      const goal = await Goals.findOne({
        kpmId: id0417, membershipId, period: activityToday.slice(0, 4), deletedAt: null,
      }).lean().exec();
      const held = await mongoose.connection.collection('activityLogs').find({
        kpmId: id0417, membershipId, localDate: { $gte: activityMonthStart, $lte: activityToday },
      }).toArray();
      const heldDays = new Set(held.map((day) => day.localDate as string));
      const heldTotal = held.reduce((sum, day) => sum + (day.entries as { activityTypeCode: string; count: number }[])
        .filter((entry) => CASCADE_CODES.includes(entry.activityTypeCode))
        .reduce((total, entry) => total + entry.count, 0), 0);
      const adding = [...planned]
        .filter(([back]) => jakartaDay(back) >= activityMonthStart && !heldDays.has(jakartaDay(back)))
        .reduce((sum, [, counts]) => sum + cascadeTotal(counts), 0);
      const short = (goal ? pacingFloor(goal) : 0) - heldTotal - adding;
      if (short > 0 && !heldDays.has(activityToday)) {
        // A busy day, in the member's own mix of the three codes, so it reads like their other days and
        // moves their ratios as little as a day can.
        const { leadsCode, appointmentsCode, closingsCode } = CASCADE_ACTIVITY_CODES;
        const sumOf = (code: string) => [...planned.values()].reduce((sum, counts) => sum + (counts[code] ?? 0), 0);
        const whole = sumOf(leadsCode) + sumOf(appointmentsCode) + sumOf(closingsCode);
        const appointments = whole ? Math.floor((short * sumOf(appointmentsCode)) / whole) : 0;
        const closings = whole ? Math.floor((short * sumOf(closingsCode)) / whole) : 0;
        todays[leadsCode] = (todays[leadsCode] ?? 0) + short - appointments - closings;
        todays[appointmentsCode] = (todays[appointmentsCode] ?? 0) + appointments;
        todays[closingsCode] = (todays[closingsCode] ?? 0) + closings;
      }
    }
    for (const [back, counts] of planned) await logDay(membershipId, back, counts);
  };

  // Rina: a working week, with the shape a real one has — busier midweek, quiet on the edges.
  /*
   * Her prospecting is her strength: about two new prospects for every lead-generation activity, so *Leads per
   * activity* stands well past its benchmark of 1.00 (ADR-0160 §2) — `INSIGHTS.STRENGTH_FACTOR` times it — and
   * the Summary has a strength card beside the ratio she is below on (P18.8-T14).
   */
  const rinaWeek = new Map<number, DayCounts>([
    [0, { LEADS_GEN_ACTIVITY: 2, LEADS_NEW_PROSPECT: 3, LEADS_CONTACTED: 5, SELL_PRESENTATION: 2, SELL_SUBMISSION: 1 }],
    [1, { LEADS_CONTACTED: 4, SELL_PRESENTATION: 3, SELL_FOLLOWUP: 2 }],
    [2, { LEADS_GEN_ACTIVITY: 1, LEADS_NEW_PROSPECT: 2, LEADS_CONTACTED: 6, SELL_PRESENTATION: 1 }],
    [4, { LEADS_CONTACTED: 3, SELL_FOLLOWUP: 1, DEV_TRAINING_ATTEND: 1 }],
    [5, { LEADS_GEN_ACTIVITY: 3, LEADS_NEW_PROSPECT: 5 }],
  ]);

  /*
   * **Six weeks behind that week (P10-T1).** The Activity Dashboard's *Last 30 days*, and a custom range
   * reaching further back, need history to show anything but zeroes — five days only ever filled one
   * column. Most days, not all, because a gap is a column worth seeing; and a little recruitment,
   * because an agent may log it and the ratios read it.
   */
  const rinaEarlier = (back: number): DayCounts => ({
    LEADS_GEN_ACTIVITY: back % 3,
    LEADS_NEW_PROSPECT: 2 * (back % 3) + (back % 4 === 0 ? 1 : 0),
    LEADS_CONTACTED: 2 + (back % 5),
    SELL_PRESENTATION: back % 2,
    SELL_FOLLOWUP: back % 3 === 1 ? 1 : 0,
    SELL_SUBMISSION: back % 9 === 0 ? 1 : 0,
    RECRUIT_PRESENTATION: back % 13 === 0 ? 1 : 0,
    DEV_TRAINING_ATTEND: back % 14 === 0 ? 1 : 0,
  });
  const rinaDays = [
    ...rinaWeek.keys(),
    // The days she did not log: every week's fourth, and every eleventh.
    ...Array.from({ length: 39 }, (_, i) => 6 + i).filter((back) => !(back % 7 === 3 || back % 11 === 0)),
  ];
  // She is pacing to MAA (P11-T2): `coaching-fixture.ts` says what that makes her status.
  await logPlan(rina.id, { days: rinaDays, counts: (back) => rinaWeek.get(back) ?? rinaEarlier(back), pacing: true });

  /*
   * Sari leads a unit: a month of recruitment and team development, most days — and, every few days, a
   * referral drive that brings in two or three prospects, so her *Leads per activity* stands well past its
   * benchmark of 1.00 and her Summary shows a strength beside the ratio she is below on (P18.8-T14). Neither
   * code is the cascade's, so her goal activities on the Unit Dashboard are unchanged.
   */
  for (let back = 0; back <= 34; back += 1) {
    if (back % 4 === 2) continue;
    await logDay(sari.id, back, {
      LEADS_GEN_ACTIVITY: back % 3 === 1 ? 1 : 0,
      LEADS_NEW_PROSPECT: back % 3 === 1 ? 2 + (back % 2) : 0,
      LEADS_CONTACTED: 1 + (back % 3),
      SELL_PRESENTATION: back % 3 === 0 ? 1 : 0,
      RECRUIT_PRESENTATION: back % 2,
      RECRUIT_FOLLOWUP: back % 5 === 0 ? 1 : 0,
      RECRUIT_AGENT_CODE: back % 12 === 0 ? 1 : 0,
      DEV_TEAM_ACTIVITY: back % 6 === 0 ? 1 : 0,
    });
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
  const sariTypes = await activeTypes();
  const priorEntries = sariTypes.map((type) => ({
    activityTypeId: String((type as { _id: unknown })._id),
    activityTypeCode: (type as { code: string }).code,
    count: (type as { code: string }).code === 'SELL_SUBMISSION' ? 1 : 0,
  }));
  // **Once** (P11-T2 AC-6): the day is relative, so a run on a later day would correct a second one.
  const sariCorrected = await mongoose.connection.collection('activityLogs').findOne({
    kpmId: id0417, membershipId: sari.id, 'corrections.0': { $exists: true },
  });
  if (!sariCorrected) await logDay(sari.id, 40, { SELL_SUBMISSION: 3, SELL_PRESENTATION: 2 }, {
    version: 2,
    frozenAt: daysAgo(6),
    corrections: [{
      version: 1,
      entries: priorEntries,
      totalCount: 1,
      at: daysAgo(5),
      byMembershipId: sari.id,
      reason: 'Dua submission tercatat di hari yang salah.',
    }],
  });

  // The coaching cast's weeks, and Dewi's, Budi's and Yanti's (P11-T2 AC-2): `coaching-cast.ts`.
  for (const plan of COACHING_ACTIVITY) await logPlan(coachees[plan.key].id, plan);

  // ---------------------------------------------------------- in no office at all

  await user('newcomer@agencyboost.test', 'Nadia Safitri', { pronoun: 'she' });

  void superAdmin;

  /*
   * **The coaching fixture (P11-T2 AC-3)** — built from the rows above and returned. The sessions are
   * inserted below (P11-T5 AC-10), and the ticks and the notes after them (P11-T9 AC-8), the same way:
   * by the row's own `_id` (`coaching-fixture.ts`).
   */
  const leadsOf = async (membershipId: string): Promise<FixtureLead[]> => {
    const rows = await Leads.find({ kpmId: id0417, ownerMembershipId: membershipId, deletedAt: null })
      .sort({ name: 1 }).lean().exec();
    return rows.map((lead) => ({
      id: String(lead._id), name: lead.name, nextActionDate: lead.nextActionDate ?? null,
      nextActionNote: lead.nextActionNote ?? null,
    }));
  };
  const catalog = await CapabilityCatalogs.findOne({ kpmId: id0417 }).lean().exec();
  const active = <T extends { status?: string }>(rows: readonly T[] | undefined) =>
    (rows ?? []).filter((row) => row.status !== 'archived');
  const office0417Settings = (await Kpms.findOne({ _id: kpm0417._id }).lean().exec())?.settings;
  /*
   * **Yanti's first membership and its edge under Sari** (ADR-0088's demo case): the session Sari led with
   * her is a former coachee's, which `GET /coaching/me/sessions` lists under `ledFormerly`. Read from the
   * rows rather than recomputed, so every run dates the session inside the same edge. Looked up by its
   * status: on a re-run `place()` answers the removed row's call with the live membership, as it must.
   * An edge left open by an older seed (P11-T3's two open edges) closes, for this purpose, at the removal.
   */
  const formerYanti = await Memberships.findOne({ kpmId: id0417, userId: String(removedUser._id), status: 'removed' })
    .sort({ _id: 1 }).lean().exec();
  const formerEdge = formerYanti && await History.findOne({
    kpmId: id0417, membershipId: String(formerYanti._id), eventType: 'joined', toLeaderId: sari.id,
  }).lean().exec();
  const formerUntil = formerEdge?.validTo ?? formerYanti?.removedAt ?? null;
  if (!formerYanti || !formerEdge || !formerUntil) {
    throw new Error('The coaching fixture needs Yanti’s removed membership and its closed edge under Sari');
  }
  const coaching = buildCoachingFixture({
    kpmId: id0417,
    clock,
    timezone: DEFAULT_TENANT_TIMEZONE,
    coachingOverdueDays: office0417Settings?.coachingOverdueDays ?? DEFAULT_KPM_SETTINGS.coachingOverdueDays,
    members: { agus: ab.id, sari: sari.id, rina: rina.id, indah: cast.indah.id },
    formerCoachee: {
      membershipId: String(formerYanti._id),
      edge: { validFrom: formerEdge.validFrom as Date, validTo: formerUntil as Date },
    },
    leads: { rina: await leadsOf(rina.id), sari: await leadsOf(sari.id), indah: await leadsOf(cast.indah.id) },
    catalog: {
      milestoneCodes: active(catalog?.milestones).map((m) => m.code),
      skillCodes: active(catalog?.grids).flatMap((grid) => active(grid.items).map((item) => item.code)),
    },
  });
  /*
   * **The fixture's sessions, inserted (P11-T5 AC-10)** — each under its own `_id`, and only when that
   * id is absent: a re-seed writes none, and a session somebody went on to edit, finalize or delete in a
   * walk is never written over (P11-T2 AC-6). Each row is cast and validated by the collection's own
   * schema first — strictly, so a field the schema does not have throws rather than vanishing — and a
   * fixture that drifted from `erd.md` fails here rather than on a screen. It is then written as the
   * fixture dates it, `createdAt` and `updatedAt` included, which a model's save would stamp with the
   * run's instant. `snapshot` is inserted `null` and then taken by finalize's own builder, as of each
   * session's first finalize (`coaching-snapshots.ts`), so a seeded snapshot and a real one are one
   * computation. The backfill fills only a snapshot still missing: a re-run writes none.
   */
  const CoachingSessions = mongoose.model(CoachingSession.name, CoachingSessionSchema, undefined, RECOMPILE);
  /*
   * **P18.96-T4: the first sales and the data-backed items' rows** (`first-sale-fixture.ts`): Novi's closing on day 20,
   * Raka's on day 120, and Rina's fourth 1:1 — inserted here, before the sessions' snapshots are taken, so hers carries
   * one as every finalized session does. Each under its derived `_id`, and only when absent.
   */
  const rakaJoinedAt = (await Memberships.findOne({ _id: reportingCast.raka.id }).lean().exec() as { joinedAt?: Date } | null)?.joinedAt;
  const firstSales = buildFirstSaleFixture({
    clock, timezone: DEFAULT_TENANT_TIMEZONE, kpmId: id0417,
    members: { novi: cast.novi.id, raka: reportingCast.raka.id, rina: rina.id, sari: sari.id },
    joined: {
      novi: addLocalDays(clock.localDateFor(DEFAULT_TENANT_TIMEZONE), -COACHING_CAST.find((p) => p.key === 'novi')!.joinedDaysAgo),
      raka: clock.localDateFor(DEFAULT_TENANT_TIMEZONE, rakaJoinedAt ?? daysAgo(220)),
    },
  });
  const paidAndIssued = await LeadStatuses.findOne({ kpmId: id0417, code: FIRST_SALE_STAGE_CODE }).lean().exec() as { _id: unknown } | null;
  for (const seed of firstSales.leads) {
    const _id = new mongoose.Types.ObjectId(seed._id);
    if (await Leads.exists({ _id }) || await Leads.exists({ kpmId: id0417, name: seed.name })) continue;
    const doc = new Leads({ ...seed, _id, statusId: paidAndIssued ? String(paidAndIssued._id) : null }, null, { strict: 'throw' });
    await doc.validate();
    await Leads.collection.insertOne({ ...doc.toObject(), createdAt: seed.createdAt, updatedAt: seed.updatedAt });
  }
  // Their places in their owners' lists, as every seeded lead has one (P18.8-T7): migration 0031, which places none twice.
  await leadPosition(mongoose.connection.db!);
  for (const seed of firstSales.sessions) {
    const _id = new mongoose.Types.ObjectId(seed._id);
    if (await CoachingSessions.exists({ _id })) continue;
    const doc = new CoachingSessions({ ...seed, _id }, null, { strict: 'throw' });
    await doc.validate();
    await CoachingSessions.collection.insertOne({ ...doc.toObject(), createdAt: seed.createdAt, updatedAt: seed.updatedAt });
  }
  for (const seed of coaching.sessions) {
    const _id = new mongoose.Types.ObjectId(seed._id);
    if (await CoachingSessions.exists({ _id })) continue;
    const doc = new CoachingSessions({ ...seed, _id }, null, { strict: 'throw' });
    await doc.validate();
    await CoachingSessions.collection.insertOne({
      ...doc.toObject(), createdAt: seed.createdAt, updatedAt: seed.updatedAt,
    });
  }
  const storedSessions = await CoachingSessions.countDocuments({ kpmId: id0417, deletedAt: null });
  const snapshotsTaken = await backfillCoachingSnapshots(id0417);

  /*
   * **The notice each coachee's latest finalize sent** (P11-T10 AC-8): `COACHING_SESSION_FINALIZED`, in-app,
   * payload `{ sessionId }` and nothing a leader typed, sent when the session was finalized and unread —
   * what `announceFinalized` writes. Without it a fresh seed holds finalized sessions and no inbox link
   * to them, so the coachee's way into `/coaching/me?session=` cannot be walked.
   *
   * **The latest per live coachee membership.** Yanti's removed membership is left out: the session Sari
   * led with it is a former coachee's (ADR-0088), and her live membership's `/coaching/me` does not list
   * it, so a link to it would open nothing. Keyed on the session id, so a re-run writes none — nor does a
   * run that finds the notice a finalize in a walk already sent. Dated by the stored session's first
   * finalize (`frozenAt`): a session an earlier run stored keeps that run's dates, and so does its notice.
   */
  const latestFinalized = new Map<string, (typeof coaching.sessions)[number]>();
  for (const session of coaching.sessions) {
    if (session.status !== 'finalized') continue;
    const held = latestFinalized.get(session.coacheeMembershipId);
    if (!held || session.finalizedAt!.getTime() > held.finalizedAt!.getTime()) {
      latestFinalized.set(session.coacheeMembershipId, session);
    }
  }
  for (const [coacheeMembershipId, session] of latestFinalized) {
    const coachee = await Memberships.findOne({ _id: coacheeMembershipId, kpmId: id0417, status: 'active' }).lean().exec();
    if (!coachee) continue;
    const stored = await CoachingSessions.findOne({ _id: session._id }).select('frozenAt').lean().exec();
    await notify(
      { userId: String(coachee.userId), membershipId: coacheeMembershipId },
      NotificationTemplate.COACHING_SESSION_FINALIZED,
      { sessionId: session._id },
      { sentAt: stored?.frozenAt ?? session.finalizedAt! },
    );
  }

  /*
   * **The fixture's capability ticks and leader notes, inserted (P11-T9 AC-8)** — as the sessions are:
   * each under its own `_id`, only when that id is absent, validated strictly by its collection's own
   * schema and written with the fixture's dates. A re-seed writes none, and a profile somebody ticked or
   * a note somebody saved in a walk is never written over. A note's author leads its coachee, and the
   * coachee never reads it (ADR-0073).
   */
  const insertFixtureRows = async (
    Model: mongoose.Model<object>, rows: readonly { _id: string; createdAt: Date; updatedAt: Date }[],
  ) => {
    for (const seed of rows) {
      const _id = new mongoose.Types.ObjectId(seed._id);
      if (await Model.exists({ _id })) continue;
      const doc = new Model({ ...seed, _id }, null, { strict: 'throw' });
      await doc.validate();
      await Model.collection.insertOne({ ...doc.toObject(), _id, createdAt: seed.createdAt, updatedAt: seed.updatedAt });
    }
  };
  await insertFixtureRows(
    mongoose.model(CoachingProfile.name, CoachingProfileSchema, undefined, RECOMPILE) as unknown as mongoose.Model<object>,
    coaching.profiles,
  );
  await insertFixtureRows(
    mongoose.model(LeaderNote.name, LeaderNoteSchema, undefined, RECOMPILE) as unknown as mongoose.Model<object>,
    coaching.notes,
  );

  /*
   * **The calendar's week and month** (Phase 12, *Seed*; `calendar-fixture.ts`, whose header says which
   * account shows what): the entries Agus, Sari, Rina, Indah and the Owner organise, the invitations in every
   * state, Agus's block on Indah and the 1:1s — inserted as the coaching rows are, each under its derived
   * `_id` and only when that id is absent, validated strictly by `calendarEvents`' own schema. Then the
   * notices those writes sent: Sari's invitation to the goal review, Rina's to the huddle she declined —
   * read when she answered — and Indah's block.
   */
  const calendar = buildCalendarFixture({
    kpmId: id0417,
    clock,
    timezone: DEFAULT_TENANT_TIMEZONE,
    members: {
      owner: owner.id, agus: ab.id, sari: sari.id, rina: rina.id, budi: budi.id,
      indah: cast.indah.id, dimas: cast.dimas.id, siti: cast.siti.id, arief: cast.arief.id,
    },
    sariRinaSessionDays: coaching.sessions
      .filter((x) => x.coachMembershipId === sari.id && x.coacheeMembershipId === rina.id && x.status === 'finalized')
      .map((x) => x.date as string),
  });
  const CalendarEvents = mongoose.model(CalendarEvent.name, CalendarEventSchema, undefined, RECOMPILE);
  await insertFixtureRows(CalendarEvents as unknown as mongoose.Model<object>, calendar.entries);
  /*
   * **Rina hides her own entries from her leaders** (P13.1-T8, ADR-0110): *Hide my personal activities* is on
   * for her, so Sari's compare shows *Pertemuan klien — Pak Gunadi* and her task as *Busy* at their times, while
   * Sari's own 1:1s with her stay in full — Sari organised them. Agus's compare with Sari, the OD-87 walk, is
   * untouched. Set on every run — the schema writes `false` when a membership is created, so there is no
   * "never written" to wait for — and a walker who switched it off gets it back on the next run, as `--reset`
   * gives them every other state.
   */
  await Memberships.updateOne(
    { _id: rina.id, kpmId: id0417, calendarHideDetails: { $ne: true } },
    { $set: { calendarHideDetails: true } },
  );
  /*
   * Each notice names its entry as the office holds it: an entry an earlier run stored keeps that run's
   * date, and so does its notice, which is keyed on its payload — so a re-run writes none.
   */
  const calendarPeople = { owner, agus: ab, sari, rina, budi, indah: cast.indah, dimas: cast.dimas, siti: cast.siti, arief: cast.arief };
  for (const notice of calendar.notices) {
    const member = await Memberships.findOne({ _id: calendarPeople[notice.to].id, kpmId: id0417 }).lean().exec();
    const entry = await CalendarEvents.findOne({ _id: notice.payload.entryId, kpmId: id0417, deletedAt: null }).lean().exec();
    if (!member || !entry) continue;
    const answeredAt = notice.readOnAnswer
      ? entry.attendees.find((a) => a.membershipId === calendarPeople[notice.to].id)?.answeredAt ?? undefined
      : undefined;
    await notify(
      { userId: String(member.userId), membershipId: calendarPeople[notice.to].id },
      notice.templateId,
      { entryId: notice.payload.entryId, date: clock.localDateFor(DEFAULT_TENANT_TIMEZONE, entry.startsAt) },
      { sentAt: entry.createdAt, readAt: answeredAt },
    );
  }
  /*
   * **An inbox longer than two pages, for Agus, Sari and Rina** (P12.1-T4): the bell's list is paged twenty at a
   * time, and a pager with one page cannot be reviewed. Each of the three gets 45 more notices, spread from two
   * days ago back to the day they joined the office, read and unread, with and without a link:
   *
   * - **What really happened first.** Each earlier finalize of a session they were coached in sent its notice,
   *   as the latest one's above (`/coaching/me?session=`, read since). Sari received Rina's request on the day
   *   Rina joined and Yanti's on the day she came back; Agus received Sari's and Dewi's on the days they joined.
   * - **Then the run of an ordinary office**, to make up the 45: entries they were on being cancelled
   *   (`/calendar?date=`, the week it was in — the entry is gone, which is what a cancellation says) and the
   *   office's event reminders (no link). Payloads are ids, names and dates, never anything typed, as every
   *   notice's is.
   * - **No *set your goal* among them** (P18.8-T15 AC-3, the client's UI review, UI-003). The run had their leader
   *   setting their goal every fifth row, so Agus's inbox said *Wilson Tanoto set your goal* seven times beside a
   *   Summary that says he has none. That notice is written below for each goal a leader actually saved, and for
   *   nothing else.
   *
   * Every row is written under an `_id` derived from its account and position, only when that id is absent,
   * so a re-run writes none, and a notice somebody read or unread in a walk keeps that state.
   */
  const HISTORY_SIZE = 45;
  const hour = 60 * 60 * 1000;
  const officeDate = (at: Date) => clock.localDateFor(DEFAULT_TENANT_TIMEZONE, at);
  /**
   * When the office's seeded events start, in days from the run (the `Events` rows above), by code: a reminder precedes
   * its event. By code, not by title, since P18.98-T7 — a database seeded before holds the English titles.
   */
  const EVENT_STARTS_IN_DAYS: Record<DemoEventCode, number> = { PRULINK_BRIEFING: -21, LEADERS_HUDDLE: 0, KICKOFF: 14 };
  const historyCast = [
    {
      key: 'agus', user: abUser, membership: ab, joinedDaysAgo: 106,
      requests: [{ fullName: sariUser.fullName, daysAgo: 103 }, { fullName: dewiUser.fullName, daysAgo: 100 }],
      reminders: ['LEADERS_HUDDLE', 'PRULINK_BRIEFING', 'KICKOFF'],
    },
    {
      key: 'sari', user: sariUser, membership: sari, joinedDaysAgo: 103,
      requests: [{ fullName: rinaUser.fullName, daysAgo: RINA_JOINED_DAYS_AGO }, { fullName: removedUser.fullName, daysAgo: 28 }],
      reminders: ['LEADERS_HUDDLE', 'PRULINK_BRIEFING', 'KICKOFF'],
    },
    {
      key: 'rina', user: rinaUser, membership: rina, joinedDaysAgo: RINA_JOINED_DAYS_AGO,
      requests: [], reminders: ['PRULINK_BRIEFING', 'KICKOFF'],
    },
  ] as const;
  const reminderFor = (codes: readonly DemoEventCode[], at: Date, i: number) => {
    const upcoming = codes.filter((code) => daysAgo(-EVENT_STARTS_IN_DAYS[code]).getTime() > at.getTime());
    return upcoming[i % upcoming.length];
  };
  /*
   * **A reminder names its event's time and place** (P18.95-T7 AC-4; the client's UI review, UI-030): its payload is
   * the event as the office holds it — its id, title, start and the zone that start is read in, and its location —
   * read back from the three events above, so a database whose events an earlier run dated keeps that run's dates.
   */
  const remindedEvents = new Map(
    (await Events.find({ kpmId: id0417, code: { $in: Object.keys(EVENT_STARTS_IN_DAYS) }, deletedAt: null }).lean().exec())
      .map((event) => [event.code, event]),
  );
  const reminderPayload = (code: DemoEventCode): Record<string, unknown> => {
    const event = remindedEvents.get(code);
    return event
      ? {
        eventId: String(event._id), title: event.title, startsAt: event.startsAt.toISOString(),
        timezone: DEFAULT_TENANT_TIMEZONE, location: event.location,
      }
      : { title: DEMO_EVENTS[code].title };
  };
  const historyRows: Record<string, unknown>[] = [];
  for (const person of historyCast) {
    const to = { userId: String(person.user._id), membershipId: person.membership.id };

    // Each earlier finalize's notice, as `announceFinalized` sent it, read a few hours later.
    const latest = latestFinalized.get(person.membership.id);
    const earlier = coaching.sessions.filter((s) =>
      s.status === 'finalized' && s.coacheeMembershipId === person.membership.id && s._id !== latest?._id);
    for (const session of earlier) {
      const stored = await CoachingSessions.findOne({ _id: session._id }).select('frozenAt').lean().exec();
      const sentAt = stored?.frozenAt ?? session.finalizedAt!;
      await notify(to, NotificationTemplate.COACHING_SESSION_FINALIZED, { sessionId: session._id }, {
        sentAt, readAt: new Date(Math.min(sentAt.getTime() + 3 * hour, clock.now().getTime())),
      });
    }
    for (const asked of person.requests) {
      await notify(to, NotificationTemplate.JOIN_REQUEST_RECEIVED, { fullName: asked.fullName }, {
        sentDaysAgo: asked.daysAgo, readDaysAgo: asked.daysAgo,
      });
    }

    // The ordinary run, from two days ago back to the day they joined.
    const made = earlier.length + person.requests.length;
    const span = person.joinedDaysAgo - 3;
    for (let i = 0; i < HISTORY_SIZE - made; i += 1) {
      const at = new Date(daysAgo(2 + (span * i) / (HISTORY_SIZE - made)).getTime() - (i % 5) * hour);
      const kind = (['cancelled', 'reminder'] as const)[i % 2];
      const [templateId, payload] = kind === 'cancelled'
        ? [NotificationTemplate.CALENDAR_ENTRY_CHANGED, {
          entryId: seedObjectId('inbox-history', person.key, 'entry', String(i)),
          date: officeDate(new Date(at.getTime() + 2 * 24 * hour)), change: 'cancelled',
        }]
        : [NotificationTemplate.EVENT_REMINDER, reminderPayload(reminderFor(person.reminders, at, i))];
      // The newest few are unread, and every fourth after them: an inbox somebody keeps up with, mostly.
      const unread = i < 3 || i % 4 === 0;
      historyRows.push({
        _id: new mongoose.Types.ObjectId(seedObjectId('inbox-history', person.key, String(i))),
        kpmId: id0417, membershipId: to.membershipId, userId: to.userId, templateId, payload,
        delivery: Object.fromEntries(
          (TEMPLATE_CHANNELS[templateId] ?? []).map((channel) => [channel, { status: 'sent', at }]),
        ),
        readAt: unread ? null : new Date(at.getTime() + 2 * hour),
        coalesceKey: null, deletedAt: null, createdAt: at, updatedAt: at,
      });
    }
  }
  /*
   * **Three in a row, the inbox's repeats** (P18.95-T7 AC-4; the client's UI review, UI-030 — *Wilson updated your
   * goal · 7×*): the office's *Kickoff 2026* reminder sent three times, a quarter of an hour apart, as the newest of
   * each of the three inboxes and unread. `/notifications` and the bell draw them as one line, *Kickoff 2026 is
   * coming up · 3×*, that opens to the three. Derived ids, so a re-run writes none, and a database seeded before
   * them gets them.
   */
  for (const person of historyCast) {
    for (let n = 0; n < 3; n += 1) {
      const at = new Date(clock.now().getTime() - (n + 1) * 15 * 60 * 1000);
      historyRows.push({
        _id: new mongoose.Types.ObjectId(seedObjectId('inbox-repeats', person.key, String(n))),
        kpmId: id0417, membershipId: person.membership.id, userId: String(person.user._id),
        templateId: NotificationTemplate.EVENT_REMINDER, payload: reminderPayload('KICKOFF'),
        delivery: Object.fromEntries(
          (TEMPLATE_CHANNELS[NotificationTemplate.EVENT_REMINDER] ?? []).map((channel) => [channel, { status: 'sent', at }]),
        ),
        readAt: null, coalesceKey: null, deletedAt: null, createdAt: at, updatedAt: at,
      });
    }
  }
  for (const row of historyRows) {
    if (await Notifications.exists({ _id: row._id })) {
      /*
       * A reminder an earlier run wrote with its title alone takes its event's time and place (P18.95-T7 AC-4): its
       * payload only, so whether somebody read it in a walk stays as they left it.
       */
      if (row.templateId === NotificationTemplate.EVENT_REMINDER && (row.payload as { startsAt?: unknown }).startsAt) {
        await Notifications.collection.updateOne(
          { _id: row._id as mongoose.Types.ObjectId, templateId: NotificationTemplate.EVENT_REMINDER, 'payload.startsAt': { $exists: false } },
          { $set: { payload: row.payload } },
        );
      }
      continue;
    }
    await Notifications.collection.insertOne(row);
  }
  /*
   * **A *set your goal* notice for each goal a leader saved, and only those** (P18.8-T15 AC-3, UI-003): read back
   * from the goals this run holds — this year's whose current plan somebody other than its owner saved (ADR-0046),
   * Dewi's by Agus and Novi's by Arief among them — with the payload `GoalService.announce` sends, on the day it was
   * saved, read a few hours later. Keyed on its payload, as every notice here is, so a re-run writes none.
   */
  const setForThem = await Goals.find({
    kpmId: id0417, period: thisYear, deletedAt: null, $expr: { $ne: ['$savedByMembershipId', '$membershipId'] },
  }).lean().exec();
  for (const goal of setForThem) {
    const [member, leader] = await Promise.all([
      Memberships.findOne({ _id: goal.membershipId, kpmId: id0417 }).lean().exec(),
      Memberships.findOne({ _id: goal.savedByMembershipId, kpmId: id0417 }).lean().exec(),
    ]);
    const leaderUser = leader ? await Users.findById(leader.userId).select('fullName').lean().exec() : null;
    if (!member || !leaderUser || !goal.savedAt) continue;
    const savedAt = goal.savedAt;
    await notify(
      { userId: String(member.userId), membershipId: String(member._id) },
      NotificationTemplate.GOAL_SET_BY_LEADER,
      { byName: leaderUser.fullName, period: goal.period },
      { sentAt: savedAt, readAt: new Date(Math.min(savedAt.getTime() + 3 * hour, clock.now().getTime())) },
    );
  }
  /*
   * **Every hire's 90-day activation** (Phase 13, *Seed*; `activation-fixture.ts`, whose header says which
   * account shows what): the activations the backfill would give the demo's Agents, pinned to each office's
   * published checklist, with the hires' and leaders' ticks, Sari's note to Rina, Wahyu's corrected start
   * date and Siti's graduation — and the audit rows those writes left. Inserted as the coaching rows are:
   * each under its derived `_id`, only when absent, validated strictly by its collection's schema. The
   * linked items of an open activation are left for the first read to complete from the hire's own data.
   */
  const ActivationRows = mongoose.model(ActivationProgress.name, ActivationProgressSchema, undefined, RECOMPILE);
  const pinnedOf = async (kpmId: string) => {
    const row = await ActivationTemplates.findOne({ kpmId, status: 'published', deletedAt: null }).sort({ version: -1 }).lean().exec();
    if (!row) throw new Error(`KPM ${kpmId} has no published activation checklist to pin to`);
    return {
      id: String(row._id),
      version: row.version,
      codes: (row.aspects as { items: { code: string }[] }[]).flatMap((a) => a.items.map((i) => i.code)),
    };
  };
  const userOf = async (membershipId: string) =>
    String((await Memberships.findOne({ _id: membershipId }).lean().exec())!.userId);
  const sitiJoined = clock.localDateFor(DEFAULT_TENANT_TIMEZONE, daysAgo(COACHING_CAST.find((p) => p.key === 'siti')!.joinedDaysAgo));
  const sitiGoal = await Goals.findOne({ kpmId: id0417, membershipId: cast.siti.id, deletedAt: null }).sort({ savedAt: -1 }).lean().exec();
  const sitiLead = await Leads.findOne({ kpmId: id0417, ownerMembershipId: cast.siti.id, deletedAt: null }).sort({ dateRegistered: 1 }).lean().exec();
  const sitiDays = await mongoose.connection.collection('activityLogs')
    .find({ kpmId: id0417, membershipId: cast.siti.id, totalCount: { $gt: 0 }, localDate: { $gte: sitiJoined }, deletedAt: null })
    .sort({ localDate: 1 }).toArray();
  const sitiFourthWeek = activityWeeksCompletedOn(
    sitiDays.map((d) => ({ date: d.localDate as string, id: String(d._id) })),
    officeMondayOf(clock, DEFAULT_TENANT_TIMEZONE),
  );
  const joinedOf = (key: CastKey) => COACHING_CAST.find((p) => p.key === key)!.joinedDaysAgo;
  const activation = buildActivationFixture({
    clock,
    timezone: DEFAULT_TENANT_TIMEZONE,
    kpm0417: id0417,
    kpm0555: String(kpm0555._id),
    versions: { kpm0417: await pinnedOf(id0417), kpm0555: await pinnedOf(String(kpm0555._id)) },
    members: {
      rina: rina.id, budi: budi.id, yanti: yanti.id, novi: cast.novi.id, wahyu: cast.wahyu.id, siti: cast.siti.id,
      dimas: cast.dimas.id, indah: cast.indah.id, lina: agent0555.id, sari: sari.id, arief: cast.arief.id, agus: ab.id,
    },
    users: { sari: String(sariUser._id), arief: await userOf(cast.arief.id), siti: await userOf(cast.siti.id) },
    joinedDaysAgo: {
      rina: RINA_JOINED_DAYS_AGO, budi: BUDI_JOINED_DAYS_AGO, yanti: 28, novi: joinedOf('novi'), wahyu: joinedOf('wahyu'),
      siti: joinedOf('siti'), dimas: joinedOf('dimas'), indah: joinedOf('indah'), lina: OFFICE_0555_JOINED_DAYS_AGO,
    },
    sitiRecords: {
      goal: sitiGoal ? String(sitiGoal._id) : null,
      lead: sitiLead ? String(sitiLead._id) : null,
      day: sitiFourthWeek?.id ?? null,
    },
  });
  await insertFixtureRows(ActivationRows as unknown as mongoose.Model<object>, activation.activations);
  await insertFixtureRows(Audit as unknown as mongoose.Model<object>, activation.audits);
  // ADR-0169: each of them a new hire, joined on their activation's start — Wahyu's corrected one included.
  await markNewHires(activation.activations.map((a) => a.membershipId));

  // ------------------- the activation cohort the forum's *3M new agent %* reads (Phase 18.1; `cohort-fixture.ts`)

  const cohort = await seedActivationCohort({ clock, kpmId: id0417, cast: reportingCast });

  // ------------------- P18.96-T6 — 3M activation (`activation-3m-fixture.ts`): the two results nobody under Agus had —
  // Lukman, not activated by a sale on day 96, and Tari, marked left before one. Placed after every other 0417 member,
  // so nobody's agent sequence moves; before the forum, so #12's and #13's frozen scorecards count them as a read would.
  const activation3M = await seedActivation3MFixture({
    clock, kpmId: id0417, office0417, agus: ab, arief: cast.arief, ariefUserId: await userOf(cast.arief.id),
    user: (email, fullName, opts) => user(email, fullName, opts),
    place: (kpm, userId, role, leader, opts) => place(kpm, userId, role, leader, opts),
    recount,
  });

  /*
   * P18.96-T6: the first sales the seed holds so far — every lead and production month above — computed before the forum
   * freezes #12's and #13's scorecards, whose *3M new agent %* reads them (`ACTIVATION_3M_PCT`). Migration 0042's own
   * backfill, run again over the finished seed below; it writes only what is earlier, so the second finds nothing.
   */
  await backfillFirstSales(mongoose.connection.db!);

  // ------------------- the Strategic Leader Forum: 0417's three meetings, two links, 0555's one (Phase 18.1;
  // `leader-forum-fixture.ts`). After the cohort, so #12's and #13's frozen scorecards carry it.

  const forum = await seedLeaderForumFixture({
    clock,
    '0417': {
      kpmId: id0417,
      owner: { membershipId: owner.id, userId: String(ownerUser._id) },
      admin: { membershipId: admin.id },
      agus: { membershipId: ab.id },
      sari: { membershipId: sari.id },
    },
    '0555': { kpmId: String(kpm0555._id), owner: { membershipId: owner0555.id, userId: String(owner0555User._id) } },
  });
  // ------------------- Phase 18.5 — training, as its learners live it (`training-fixture.ts`): 0417's coaching cast's
  // progress, the company's material by reference, and 0555's item 9 bound for Lina (D-seed-link a). After the
  // activations, whose 0555 version it repins Lina from; before events and campaigns.

  const yantiFirstMembership = await Memberships.findOne({
    kpmId: id0417, userId: String(removedUser._id), status: 'removed',
  }).sort({ joinedAt: 1 }).lean().exec();
  if (!yantiFirstMembership) throw new Error('Yanti’s first membership is missing: the training fixture keeps her three modules with it');
  const training = await seedTrainingFixture({
    clock,
    storage: options.storage ?? null,
    companyId: String(prudential._id),
    office0417: {
      kpmId: id0417,
      cast: {
        rina: rina.id, agus: ab.id, indah: cast.indah.id, dimas: cast.dimas.id, novi: cast.novi.id, wahyu: cast.wahyu.id,
        siti: cast.siti.id, yantiFirst: String(yantiFirstMembership._id), yanti: yanti.id, budi: budi.id, dewi: dewi.id,
        maya: admin.id,
      },
    },
    office0555: { kpmId: String(kpm0555._id), lina: agent0555.id },
  });
  if (training.files !== 'stored') log(`Training: Prudential's demonstration PDFs ${training.files}.`);
  // ------------------- Phase 18.5 — events, as their audience lives them (`events-fixture.ts`): 0417's RSVPs, claims,
  // confirmations and answers over configure()'s three events and four new ones. After the forum; before campaigns.

  const yantiFirst = await Memberships.findOne({
    kpmId: id0417, userId: String(removedUser._id), status: 'removed',
  }).sort({ joinedAt: 1 }).lean().exec();
  if (!yantiFirst) throw new Error('Yanti’s first membership is missing: the events fixture keeps her Bootcamp answer with it');
  const events = await seedEventsFixture({
    clock,
    kpmId: id0417,
    cast: {
      owner: owner.id, admin: admin.id, agus: ab.id, sari: sari.id, dewi: dewi.id, rina: rina.id, budi: budi.id,
      indah: cast.indah.id, dimas: cast.dimas.id, siti: cast.siti.id, novi: cast.novi.id, yantiFirst: String(yantiFirst._id),
    },
  });
  // ------------------- Phase 18.5 — campaigns, as their chasers live them (`campaigns-fixture.ts`): 0417's seasonal and
  // structural campaigns and the chases across the coaching cast, 0555's one. After training and events.

  const campaigns = await seedCampaignsFixture({
    clock,
    office0417: { kpmId: id0417, cast: { rina: rina.id, budi: budi.id, agus: ab.id, dimas: cast.dimas.id, sari: sari.id } },
    office0555: { kpmId: String(kpm0555._id) },
  });
  // ------------------- Phase 18.6 — the Owner's compliance tree (`compliance-fixture.ts`): training for Phase 18's
  // cast, and D-seed's override of Budi's final persistency standing as the Owner. After campaigns, whose push it reads.

  const compliance = await seedComplianceFixture({
    clock,
    kpmId: id0417,
    owner: { membershipId: owner.id, userId: String(ownerUser._id) },
    budi: budi.id,
    cast: Object.fromEntries((Object.entries(reportingCast) as [ReportingKey, Placed][]).map(([key, placed]) => [key, placed.id])),
  });
  // ------------------- P18.96-T3 — adding an agent (`joining-fixture.ts`): Agus's invite waiting to join, one he
  // cancelled, and his transfer request for Raka Aditama, who reports to Satria — the Owner's and the Admin's to decide.
  const joining = await seedJoiningFixture({
    clock,
    kpmId: id0417,
    companyId: office0417.companyId,
    agus: { membershipId: ab.id },
    raka: { membershipId: reportingCast.raka.id },
    satria: { membershipId: reportingCast.satria.id },
    deciders: [
      { userId: String(ownerUser._id), membershipId: owner.id },
      { userId: String(adminUser._id), membershipId: admin.id },
    ],
    notify,
  });
  // P18.96-T2: migration 0040 after the fixtures, as a deploy runs it. On a fresh seed every membership has its join
  // date and classification already, so it leaves only the pending ones, waiting; on a re-seed over an older
  // database it classifies the rows `place()` adopted, as it would have on that database's deploy.
  await membershipJoinDate(mongoose.connection.db!);
  const storedActivations = await ActivationRows.countDocuments({ deletedAt: null }).exec();

  /** What each long inbox holds now, as the bell counts it, for the summary below. */
  const inboxLine = async (user: { _id: unknown }) => {
    const mine = { userId: String(user._id), deletedAt: null, templateId: { $in: IN_APP_TEMPLATES } };
    const [total, unread] = await Promise.all([
      Notifications.countDocuments(mine).exec(), Notifications.countDocuments({ ...mine, readAt: null }).exec(),
    ]);
    return `${total} notices, ${unread} unread`;
  };
  const longInboxes = {
    agus: await inboxLine(abUser), sari: await inboxLine(sariUser), rina: await inboxLine(rinaUser),
  };
  // Counted, not quoted: a lead closed or deleted in a walk changes it, and the line should say so.
  const budiOpenLeads = await Leads.countDocuments({
    kpmId: id0417, ownerMembershipId: budi.id, outcome: null, deletedAt: null,
  }).exec();

  const storedCalendar = await mongoose.connection.collection('calendarEvents').countDocuments({ kpmId: id0417, deletedAt: null });

  const rosterLine = (status: string) => (Object.entries(ROSTER_PLAN) as [CoacheeKey, (typeof ROSTER_PLAN)[CoacheeKey]][])
    .filter(([, row]) => row.status === status)
    .map(([key, row]) => `${key[0].toUpperCase()}${key.slice(1)}${row.monthDependent ? '*' : ''}`)
    .join(', ');

  log(`
Seeded. Every field account uses the password "${FIELD_PASSWORD}" unless noted.

  PLATFORM
    superadmin@agencyboost.test   demo super admin     Super Admin
    root@agencyboost.test                              Super Admin — a second, so SA-on-SA can be refused

  KPM 0417 · BSD City Branch  (${id0417})
    owner@kpm0417.test           demo password 0417    KPM Owner, AB at the root
    admin@kpm0417.test                                 KPM Admin since Jan 2026, granted by the Owner,
                                                       and an AB — the two are independent
    agus@kpm0417.test                                  AB with a unit, neither Owner nor Admin: three
                                                       agents of his own and three AABs under him
    sari@kpm0417.test                                  AAB leading two agents
    dewi@kpm0417.test                                  AAB leading nobody — the OD-23 case
                                                       Sari, Dewi and Arief were promoted from Agent,
                                                       so /people/members Role change log has rows
    rina@kpm0417.test            demo password rina    Agent under Sari; /leads in the order she dragged
                                                       it, Ibu Wulan Sari first, Pak Bambang last
    budi@kpm0417.test                                  Agent under Sari, with ${budiOpenLeads} open leads: /leads
                                                       shows 30, then Show more
    indah@ · dimas@ · siti@kpm0417.test                Agents under Agus — his direct agents
    arief@kpm0417.test                                 AAB under Agus, promoted from Agent, leading two:
    novi@ · wahyu@kpm0417.test                         Agents under Arief
    pending@kpm0417.test                               Registered, request sent to Sari, waiting
    untagged@kpm0417.test                              Registered, has asked nobody — Putri and Fajar stay
                                                       leaderless, so + Add agent with either code links them
    ADDING AN AGENT (Agus, /new-hires)                 Yusuf Hidayat invited (80777), waiting to join;
                                                       Raka Aditama, Transfer requested — the Owner's and
                                                       the Admin's to decide on All Members › Pending
    Yusuf's link                                       ${joining.invitePath}
    removed@kpm0417.test                               Removed once, rejoined — two memberships,
                                                       two agent codes, one person (P3-T7 AC-4)

  KPM 0555 · Kelapa Gading Branch  (${String(kpm0555._id)})
    owner@kpm0555.test                                 KPM Owner — for cross-tenant checks, and the
                                                       settings screens' states: an archived activity
                                                       type and lead status, an office-made ratio, and
                                                       an edit since publishing. 0417's settings are
                                                       the prototype's, published and untouched
    agent@kpm0555.test                                 Agent

  KPM 0999 · Suspended Branch
    owner@kpm0999.test                                 Signing in shows the page: the office is suspended
${subscriptions.guide}${templates.guide}${templateCopies.guide}${salesTools.guide}${unitDashboard.guide}${recruitment.guide}${reporting.guide}${cohort.guide}${forum.guide}${training.guide}${events.guide}${campaigns.guide}${compliance.guide}
  NO OFFICE
    newcomer@agencyboost.test                          Brand new — starts at Register KPM

  GROUPS in KPM 0417, at /people/members → Groups
    ${DEMO_GROUPS.mentoring.name.padEnd(28)} owned by Sari · Rina and Budi tagged
    ${DEMO_GROUPS.topProducers.name.padEnd(28)} owned by the Owner · Agus and Sari tagged
    Agus, Sari and Yosef also carry the Core Leader tag

  KPM REQUESTS at /admin/kpm-requests  (Super Admin)
    Bandung Kota Branch          pending, with a note — ade@agencyboost.test
    Surabaya Timur Branch        pending, no note — maya@agencyboost.test
    Medan Selatan Branch         declined, with the reason on the row
    Kelapa Gading Branch         approved — this is where KPM 0555 came from

  NOTIFICATIONS at /notifications  (the bell on every screen; twenty to a page)
    agus@kpm0417.test            ${longInboxes.agus}: three pages and more
    sari@kpm0417.test            ${longInboxes.sari}: Putri's request on top, her promotion read
    rina@kpm0417.test            ${longInboxes.rina}
                                 Each of the three: what the fixture sent them first, then a
                                 history, read and unread — finalized sessions opening at
                                 /coaching/me, cancellations opening their week, goal and event
                                 notices opening nothing
    budi@kpm0417.test            1 unread: tagged by a leader
    untagged@kpm0417.test        1 unread: declined, with the leader's reason
    removed@kpm0417.test         1 unread: back in. Plus the removal, read
    dewi / admin                 read-only inboxes — the "nothing new" state
    owner@kpm0417.test           empty, deliberately: nothing in this fixture is
                                 addressed to the Owner, and an empty inbox is a
                                 state worth seeing too

  ACTIVITY at /activity/log, /activity/dashboard and /activity/ratio
    rina@kpm0417.test            six weeks of days, a few missed — Last 30 days fills every
                                 column, and a custom range reaches further back. An agent:
                                 three ratios, the recruitment ones not hers to be judged by.
                                 /goals prints her logged rate under each conversion
                                 assumption; Sari, opening Rina's plan, reads "Their" rate
    sari@kpm0417.test            a leader's month: recruitment and team development most days,
                                 and a day corrected after it closed, 40 days back — a custom
                                 range that includes it says "1 corrected day". All five
                                 ratios, the balance leaning toward recruitment
    budi@kpm0417.test            four steady weeks a month and more ago, then one day nine
                                 days ago, then nothing: outside the 7-day window
    dewi@kpm0417.test            weeks of training and team development, and yesterday a day
                                 of zeroes — none of it a ratio's denominator, so her ratios
                                 all read "Not enough data"
    the coaching cast            weeks of days each — see COACHING below

  PERSONAL SUMMARY at /summary
    rina@kpm0417.test            a saved goal, and last month's and this month's production:
                                 Monthly measures this month's upload against a target held
                                 from last month's year to date; Yearly the year so far; her
                                 closings this month make the pace sentence. Her activity
                                 targets: leads, appointments and closings against the
                                 cascade on this month's target (Yearly: on the year's), a
                                 chip per other section, and the pulse — her three ratios.
                                 Leads that need you: Pak Hendro first, overdue and promised
                                 this month; Pak Bambang and Pak Surya last, with no date set.
                                 Four insight cards: behind pace, Pak Hendro overdue, Pak
                                 Surya with no next step, and a ratio below benchmark. Her
                                 Leads per activity is well above its benchmark (green on
                                 /activity/ratio), the fifth card, and four is the most shown
    budi@kpm0417.test            a goal (from savings), and not in this month's file — this
                                 month reads "Not uploaded yet", never zero. His last day was
                                 over a week ago, so "Nothing logged" leads his cards, then
                                 "Behind pace"; his ratios rest on too little to make one
    sari@kpm0417.test            no goal saved — "You haven't set a goal", and Set your goal.
                                 Her activity still counts, with no target to divide it by;
                                 her pulse has four ratios, the balance left to /activity/ratio.
                                 Two leads of her own, both with a date coming, so no lead
                                 asks for her. Two insights: a ratio below benchmark, and
                                 Leads per activity well above it; no action card. (admin@ has neither a goal nor a lead, and her
                                 Summary shows both empty states.)

  MONTHLY UPLOAD at /kpm/data-upload  (owner@kpm0417.test or admin@kpm0417.test)
    This month   one import reverted by the Admin (figures typed in thousands), then
                 the corrected file standing — Revert is offered on it. The last two
                 members are not in it, so their rows are dashes. The first member's
                 APE this month was corrected by hand afterwards; a revert keeps it
    Active (MAA) the last column: ✓ for most; ✕ for the 4th member in roster order (Sari),
                 who sold nothing that month; — for the two not in the file
    Each month   written when it holds no import yet, so a run in a new month fills that
                 month in and leaves the others; the coaching cast is on the files too
    Last month   one import. Locked once its window closed (7 days after month end),
                 so Reopen is offered; before then it is still open
    Month before nothing uploaded
    Download the template, fill a few cells, upload it: the preview, then Confirm import
    Click any figure in an open month to correct it, with a reason

  COACHING at /coaching  (the sessions are in coachingSessions, the ticks in coachingProfiles
             and the notes in leaderNotes, all from src/seed/coaching-fixture.ts)
    agus@kpm0417.test            the demo AB. His roster, grouped as the prototype groups it:
                                 Your direct agents · 3   Dimas, Indah, Siti
                                 AAB units                Arief (Novi, Wahyu) · Dewi (nobody) ·
                                                          Sari (Budi, Rina, Yanti)
    Status                       On track: ${rosterLine('on_track')}
                                 Watch closely: ${rosterLine('watch_closely')}
                                 Needs attention: ${rosterLine('needs_attention')}
                                 No goal set: ${rosterLine('no_goal_set')}
                                 * Rina reads On track instead in May to August
    Last 1:1                     Today: Rina, Sari's third weekly session
                                 recent: Indah, Agus — and his open draft with her, today
                                 overdue: Sari, Agus — her own history as a coachee
                                 No 1:1 yet: everybody else
    siti@kpm0417.test            holds a lead promised this month with no next action date,
                                 so a session with her will not finalize until it has one
    sari@kpm0417.test            leads Rina's weekly 1:1s; reads her own at /coaching/me. A former
                                 coach too: one session with Yanti's first membership, before
                                 Yanti left, which /coaching/me/sessions lists under ledFormerly
    rina@kpm0417.test            reads her three at /coaching/me
    Finalize notices             Rina, Indah and Sari each have "A coaching session was finalized"
                                 in the bell for their latest session; its title opens
                                 /coaching/me on that session
    Ticks and a leader note      Rina (Sari's), Indah (Agus's), on the person's Leader Notes tab.
                                 Agus and the Owner read Sari's note as her leaders above, and
                                 Sari never reads Agus's; Rina never does, nor Indah
    Fixture this run             ${coaching.sessions.filter((x) => x.status === 'finalized').length} finalized sessions, ${coaching.sessions.filter((x) => x.status === 'draft').length} draft, ${coaching.profiles.length} profiles, ${coaching.notes.length} notes — dated from ${coaching.today}
    Sessions stored              ${storedSessions} in KPM 0417. A session is written only where its id is
                                 absent, so one stored by an earlier run keeps that run's dates:
                                 run with --reset to date them from today
    Snapshots taken this run     ${snapshotsTaken}: each finalized session's, as of its own finalize, by
                                 finalize's own builder. A session that has one keeps it

  CALENDAR at /calendar  (the entries are in calendarEvents, from src/seed/calendar-fixture.ts;
             this week is ${calendar.monday} to the Sunday after, the office's today ${calendar.today})
    agus@kpm0417.test            his week: ${CAL.standup} Monday and Thursday 9:00, the
                                 ${CAL.goalReview}, a ${CAL.prospecting}, ${CAL.trip}
                                 (Friday and Saturday, Travel), and ${CAL.clientReview}
                                 with an address in its notes. Monday has four lines: Month draws
                                 "+1 more…", or "+2 more…" when seeded on a Monday, his 1:1 with
                                 Indah today being a fifth. That 1:1 is the day his draft is open
    Compare (Agus)               + Compare with downline → Sari: her ${CAL.clientVisit}
                                 in full, address included; the Owner's ${CAL.leadersReview} she
                                 attends is Busy. Every compared week is recorded in the audit log
    Block time (Agus)            his block on Indah on Wednesday, 15:00 — placed, not asked;
                                 Indah has "Time was blocked on your calendar" in the bell
    sari@kpm0417.test            ${CAL.leadsFollowUp}; the ${CAL.goalReview} invitation pending, with
                                 "You have a new invitation" in the bell; the standups accepted;
                                 her weekly ${CAL.oneToOne('Rina Wijaya')} on her sessions' days; the
                                 ${CAL.huddle}, which Rina declined
    rina@kpm0417.test            ${CAL.clientMeeting} and a task; Sari's 1:1s, whose chip
                                 links nowhere for her; the declined huddle is off her grid, and
                                 its "You have a new invitation" in the bell, read, still opens it
    Hide my personal activities  on for Rina: Sari's compare shows her ${CAL.clientMeeting} and task as
                                 Busy; Sari's own 1:1s with her stay in full
    indah@kpm0417.test           a task, the standups accepted, Agus's block (Close alone)
    The month                    four lighter weeks before this one and the week after
    Entries stored               ${storedCalendar} in KPM 0417 (${calendar.entries.length} in this run's fixture)

  ACTIVATION at /activation, /new-hires  (the activations are in activationProgress, from
             src/seed/activation-fixture.ts; days counted from the office's today ${activation.today},
             against its 90-day window. Linked items complete from each hire's own goal, leads and
             activity the first time a page reads them)
    rina@kpm0417.test            day 59, 8 of 16: her three linked items done from her own data;
                                 three ticks of hers, two with a note and a date; two of Sari's,
                                 attributed; Sari's coaching note at the top of her page
    budi@kpm0417.test            day 62, part-way
    removed@kpm0417.test         Yanti, day 29: the re-join — her current membership starts afresh,
                                 her first, removed, has none
    novi@kpm0417.test            day 85: her goal item attributed to Arief, who saved her goal
    wahyu@kpm0417.test           day 87: a start date Arief corrected to his contract date, audited
    siti@kpm0417.test            graduated three days ago — every item done, the audit row, and no
                                 New agent section any more
    dimas@kpm0417.test           day 95, half done, overdue: his day is red
    indah@kpm0417.test           day 98, 15 of 16, overdue: one item short; first case closed (✓)
    agus@kpm0417.test            Your New Hires: Direct Unit (Indah, Dimas), AAB: Arief Hidayat (Wahyu,
                                 Novi), AAB: Sari Puspita (Budi, Rina, Yanti). Siti has left it;
                                 Dewi leads nobody and has no card. Every hire shown is a recorded read
    sari@kpm0417.test            her own Direct Unit; ticks and the note on a hire's detail
    arief@kpm0417.test           his own Direct Unit; Wahyu's Start date is his correction
    agent@kpm0555.test           Lina, office 0555, day 61 (joined two months ago): the other office's hire
    Sari, Dewi and Arief joined as Agents and were promoted: none of them has an activation.
    Activations stored           ${storedActivations} (${activation.activations.length} in this run's fixture). A row is
                                 written only where its id is absent: run with --reset to date
                                 them from today

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

  /*
   * **What this run wrote** (P11-T2 AC-6): every counted collection before and after. A second run
   * without `--reset` on the same day prints zero; a run on a later day writes that day's activity.
   */
  /*
   * **P18.96-T4: every member's first sale, computed from what the seed holds** — the leads, the production file — by
   * migration 0042's own backfill, which is `firstSaleOf`: a fresh seed and a migrated database say the same thing, and
   * a re-run, or the migration after it, finds nothing earlier to write (`first-sale-fixture.ts`).
   */
  await backfillFirstSales(mongoose.connection.db!);
  log(firstSales.guide);
  log(activation3M.guide);

  const after = await countRows();
  const written = Object.fromEntries(COUNTED_COLLECTIONS
    .map((name) => [name, after[name] - before[name]] as const)
    .filter(([, added]) => added !== 0));
  const total = Object.values(written).reduce((sum, added) => sum + added, 0);
  if (pronounsSet > 0) log(`Set the pronoun on ${pronounsSet} accounts an earlier run made (users.pronoun).`);
  log(total === 0
    ? 'This run wrote 0 rows: everything it seeds was already there.'
    : `This run wrote ${total} rows: ${Object.entries(written).map(([name, added]) => `${name} +${added}`).join(', ')}`);

  return {
    written, pronounsSet, coaching, calendar, activation, recruitment, forum, training, events, campaigns, compliance, joining,
    firstSales, activation3M,
  };
}

async function main(): Promise<void> {
  loadEnv();
  const reset = process.argv.includes('--reset');
  // P18.7-T1: never in production, and the target named before a row is written (`seed-guard.ts`).
  const plan = planSeed(process.env, reset);
  if ('refusal' in plan) {
    console.error(plan.refusal);
    process.exit(1);
  }
  console.log(plan.banner);
  await mongoose.connect(plan.target.uri, { dbName: plan.target.dbName });
  // The storage the demonstration PDFs go through, where one is configured (D-seed); none, and they are skipped.
  await seedDemo({ reset, storage: storageFromEnvironment(process.env, new SystemClock()) });
  await mongoose.disconnect();
}

// Run as the command, never on import: the seed's spec imports `seedDemo` and runs it itself.
if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
  });
}
