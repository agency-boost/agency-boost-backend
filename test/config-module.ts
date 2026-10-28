import mongoose from 'mongoose';
import { Clock, FixedClock } from '@/common/clock/clock.port';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import {
  ActivityCategory, ActivityCategorySchema,
} from '@/modules/config/activity-category.schema';
import { ActivityType, ActivityTypeSchema } from '@/modules/config/activity-type.schema';
import { LeadStatus, LeadStatusSchema } from '@/modules/config/lead-status.schema';
import {
  RatioDefinition, RatioDefinitionSchema,
} from '@/modules/config/ratio-definition.schema';
import {
  ConfigSnapshot, ConfigSnapshotSchema,
} from '@/modules/config/config-snapshot.schema';
import {
  CompanyTemplate, CompanyTemplateSchema,
} from '@/modules/config/company-template.schema';
import {
  ActivityBindingRepository, ActivityCategoryRepository, ActivityTypeRepository, ConfigSnapshotRepository,
  LeadStatusRepository, RatioDefinitionRepository,
} from '@/modules/config/activity.repository';
import { ActivityBinding, ActivityBindingSchema } from '@/modules/config/activity-binding.schema';
import { ActivityBindingService } from '@/modules/config/activity-binding.service';
import { ActivityConfigService } from '@/modules/config/activity.service';
import { LeadStatusService } from '@/modules/config/lead-status.service';
import { RatioService } from '@/modules/config/ratio.service';
import { TenantConfigService } from '@/modules/config/tenant-config.service';
import { ConfigChangeService } from '@/modules/config/changes.service';
import { ProvisioningService } from '@/modules/config/provisioning.service';
import { TemplateService } from '@/modules/config/template.service';
import { KpmOfficeCounter } from '@/modules/config/office-counter';
import { NamedTemplateSchema } from '@/modules/config/named-template.schema';
import { NamedTemplateService } from '@/modules/config/named-template.service';
import { OfficeSettingsSource } from '@/modules/config/office-settings.source';
import { TemplateCopyService } from '@/modules/config/template-copy.service';
import {
  TrainingCategory, TrainingCategorySchema,
} from '@/modules/training/training-category.schema';
import { TrainingSkill, TrainingSkillSchema } from '@/modules/training/training-skill.schema';
import { TrainingModule, TrainingModuleSchema } from '@/modules/training/training-module.schema';
import {
  TrainingCategoryRepository, TrainingModuleRepository, TrainingSkillRepository,
} from '@/modules/training/training.repository';
import { TrainingService } from '@/modules/training/training.service';
import { TrainingProgress, TrainingProgressSchema } from '@/modules/training/training-progress.schema';
import { TrainingProgressRepository } from '@/modules/training/training-progress.repository';
import { OfferedTraining } from '@/modules/training/offered-training';
import { TrainingProgressReadings } from '@/modules/training/training-progress-readings';
import { TrainingProgressService } from '@/modules/training/training-progress.service';
import {
  ActivationTemplate, ActivationTemplateSchema,
} from '@/modules/activation/activation-template.schema';
import { ActivationTemplateRepository } from '@/modules/activation/activation.repository';
import { ActivationService } from '@/modules/activation/activation.service';
import { ActivationItemRecords } from '@/modules/activation/activation-records.service';
import { FirstSaleService } from '@/modules/activation/first-sale.service';
import { Activation3MService } from '@/modules/activation/activation-3m.service';
import { RoleChangeService } from '@/modules/org/role-change.service';
import { RemovalService } from '@/modules/org/removal.service';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { ProductSchema } from '@/modules/products/product.schema';
import { KpmProductConfigSchema } from '@/modules/products/kpm-product-config.schema';
import { KpmProductConfigRepository } from '@/modules/products/kpm-product.repository';
import { KpmProductService } from '@/modules/products/kpm-product.service';
import { Event, EventSchema, EventType, EventTypeSchema } from '@/modules/events/event.schema';
import {
  EventFeedbackRepository, EventRepository, EventRsvpRepository, EventTypeRepository,
} from '@/modules/events/event.repository';
import { EventService } from '@/modules/events/event.service';
import { EventRsvp, EventRsvpSchema } from '@/modules/events/event-rsvp.schema';
import { EventFeedback, EventFeedbackSchema } from '@/modules/events/event-feedback.schema';
import { EventAudienceReader } from '@/modules/events/event-audience';
import { EventReadings } from '@/modules/events/event-readings';
import { EventGuestService } from '@/modules/events/event-guest.service';
import { EventRollCallService } from '@/modules/events/event-roll-call.service';
import { ActivityLog, ActivityLogSchema } from '@/modules/activity/activity-log.schema';
import { ActivityLogRepository } from '@/modules/activity/activity-log.repository';
import { Lead, LeadSchema } from '@/modules/leads/lead.schema';
import { LeadRepository } from '@/modules/leads/lead.repository';
import { LeadService } from '@/modules/leads/lead.service';
import { LeadReadings } from '@/modules/leads/lead-readings';
import { ActivityService } from '@/modules/activity/activity.service';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { SummaryService } from '@/modules/summary/summary.service';
import {
  Campaign, CampaignSchema, QualificationRule, QualificationRuleSchema,
} from '@/modules/campaigns/campaign.schema';
import { CampaignRepository } from '@/modules/campaigns/campaign.repository';
import { CampaignService } from '@/modules/campaigns/campaign.service';
import { CampaignChase, CampaignChaseSchema } from '@/modules/campaigns/campaign-chase.schema';
import { CampaignStanding, CampaignStandingSchema } from '@/modules/campaigns/campaign-standing.schema';
import { CampaignChaseRepository } from '@/modules/campaigns/campaign-chase.repository';
import { CampaignStandingRepository } from '@/modules/campaigns/campaign-standing.repository';
import { CampaignChaseReadings } from '@/modules/campaigns/campaign-chase-readings';
import { CampaignEvaluation } from '@/modules/campaigns/campaign-evaluation';
import { CampaignAgentService } from '@/modules/campaigns/campaign-agent.service';
import { CampaignStandingsReader } from '@/modules/campaigns/campaign-standings-reader';
import { CampaignChaseDeparture } from '@/modules/campaigns/campaign-departure';
import { CampaignStandingOverrides } from '@/modules/campaigns/campaign-standing-overrides';
import {
  CapabilityCatalog, CapabilityCatalogSchema,
} from '@/modules/capability/capability.schema';
import { CapabilityCatalogRepository } from '@/modules/capability/capability.repository';
import { CapabilityService } from '@/modules/capability/capability.service';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { AssetSchema } from '@/modules/assets/asset.schema';
import { AssetRepository } from '@/modules/assets/asset.repository';
import { AssetService } from '@/modules/assets/asset.service';
import { StubStorage } from './stub-storage';
import { ProductService } from '@/modules/products/product.service';
import { KpmSchema } from '@/modules/tenants/kpm.schema';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { Goal, GoalSchema } from '@/modules/goals/goal.schema';
import { MonthlyAgentData, MonthlyAgentDataSchema } from '@/modules/production/monthly-agent-data.schema';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';
import { ProductionService } from '@/modules/production/production.service';
import { ProductionMonth, ProductionMonthSchema } from '@/modules/production/production-month.schema';
import { ProductionMonthRepository } from '@/modules/production/production-month.repository';
import { DataUploadBatch, DataUploadBatchSchema } from '@/modules/production/data-upload-batch.schema';
import { DataUploadBatchRepository } from '@/modules/production/data-upload-batch.repository';
import { DataUploadRow, DataUploadRowSchema } from '@/modules/production/data-upload-row.schema';
import { DataUploadRowRepository } from '@/modules/production/data-upload-row.repository';
import { ProductionMonths } from '@/modules/production/production-months.service';
import { ProductionImportService } from '@/modules/production/production-import.service';
import { ProductionCorrections } from '@/modules/production/production-correction.service';
import { ProductionReadings } from '@/modules/production/production-readings';
import { GoalRepository } from '@/modules/goals/goal.repository';
import { GoalService } from '@/modules/goals/goal.service';
import { MemberNames } from '@/modules/org/member-names.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { UserSchema } from '@/modules/users/user.schema';
import { CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { CoachingSession, CoachingSessionSchema } from '@/modules/coaching/coaching-session.schema';
import { CoachingSessionRepository } from '@/modules/coaching/coaching-session.repository';
import { CoachingReadings } from '@/modules/coaching/coaching-readings';
import { PaceStatusReadings } from '@/modules/coaching/pace-status';
import { CoachingRosterService } from '@/modules/coaching/coaching-roster.service';
import { CoacheeService } from '@/modules/coaching/coachee.service';
import { CoachingSessionGate } from '@/modules/coaching/coaching-session.gate';
import { CoachingSessionService } from '@/modules/coaching/coaching-session.service';
import { CoachingSnapshotBuilder } from '@/modules/coaching/coaching-snapshot';
import { CoachingRecordService } from '@/modules/coaching/coaching-record.service';
import { CoachingProfile, CoachingProfileSchema } from '@/modules/coaching/coaching-profile.schema';
import { CoachingProfileRepository } from '@/modules/coaching/coaching-profile.repository';
import { CoachingProfileService } from '@/modules/coaching/coaching-profile.service';
import { LeaderNote, LeaderNoteSchema } from '@/modules/coaching/leader-note.schema';
import { LeaderNoteRepository } from '@/modules/coaching/leader-note.repository';
import { LeaderNoteService } from '@/modules/coaching/leader-note.service';
import { CalendarEvent, CalendarEventSchema } from '@/modules/calendar/calendar-event.schema';
import { CalendarEventRepository } from '@/modules/calendar/calendar-event.repository';
import { CalendarNotices } from '@/modules/calendar/calendar-notices';
import { CalendarService } from '@/modules/calendar/calendar.service';
import { CalendarPeopleService } from '@/modules/calendar/calendar-people.service';
import { CalendarLeave } from '@/modules/calendar/calendar-leave';
import {
  ActivationProgress, ActivationProgressSchema,
} from '@/modules/activation/activation-progress.schema';
import { ActivationProgressRepository } from '@/modules/activation/activation-progress.repository';
import { ActivationLinkEngine } from '@/modules/activation/activation-links';
import { ActivationProgressService } from '@/modules/activation/activation-progress.service';
import { NewHiresService } from '@/modules/activation/new-hires.service';
import { UnitDashboardService } from '@/modules/unit-dashboard/unit-dashboard.service';
import { RecruitmentPlaybook, RecruitmentPlaybookSchema } from '@/modules/recruitment/recruitment-playbook.schema';
import { RecruitmentPitchSlot, RecruitmentPitchSlotSchema } from '@/modules/recruitment/recruitment-pitch.schema';
import { RecruitmentPitchRepository } from '@/modules/recruitment/recruitment-pitch.repository';
import { RecruitmentPlaybookService } from '@/modules/recruitment/recruitment-playbook.service';
import { RecruitmentPlanService } from '@/modules/recruitment/recruitment-plan.service';
import { RecruitmentPitchService } from '@/modules/recruitment/recruitment-pitch.service';
import { CarrierRules } from '@/modules/campaigns/carrier-rules';
import { KpmRecruitTarget, KpmRecruitTargetSchema } from '@/modules/reporting/kpm-recruit-target.schema';
import { KpmRecruitTargetRepository } from '@/modules/reporting/kpm-recruit-target.repository';
import { OfficePeople } from '@/modules/reporting/office-people';
import { KpmOverviewService } from '@/modules/reporting/kpm-overview.service';
import { KpmAnalyticsService } from '@/modules/reporting/kpm-analytics.service';
import { PlatformAnalyticsService } from '@/modules/reporting/platform-analytics.service';
import { DirectoryColumns } from '@/modules/reporting/directory-columns';

/**
 * The configuration module, wired the way the app wires it.
 *
 * **Why this exists.** Five specs were constructing `ProvisioningService` by hand, and
 * every collection Phase 4 added meant threading one more argument through all five — four
 * times, across P4-T1, T2, T3 and T6. None of those edits was a test getting better; each
 * was a test being dragged along. The wiring is one thing, so it is written once.
 *
 * It deliberately builds the **real** services over the real schemas, on whatever database
 * the caller has already started. A double here would be a second implementation of the
 * thing under test.
 */
export function configModule(
  now: Date,
  /**
   * P11-T8: the real `NotificationService`, for a spec asking what reached a person's inbox and email
   * rather than whether a write announced itself — one notice per coaching session is the first.
   */
  overrides: { notifications?: NotificationService } = {},
) {
  const model = <T>(name: string, schema: unknown) =>
    mongoose.model(name, schema as never) as unknown as T;

  const categories = model('ActivityCategoryModel', ActivityCategorySchema);
  const types = model('ActivityTypeModel', ActivityTypeSchema);
  const leadStatuses = model('LeadStatusModel', LeadStatusSchema);
  const ratioDefinitions = model('RatioDefinitionModel', RatioDefinitionSchema);
  const snapshots = model('ConfigSnapshotModel', ConfigSnapshotSchema);
  const templates = model('CompanyTemplateModel', CompanyTemplateSchema);
  const trainingCategories = model('TrainingCategoryModel', TrainingCategorySchema);
  const trainingSkills = model('TrainingSkillModel', TrainingSkillSchema);
  const trainingModules = model('TrainingModuleModel', TrainingModuleSchema);
  const activationTemplates = model('ActivationTemplateModel', ActivationTemplateSchema);
  const productRows = model('ProductModel', ProductSchema);
  // ADR-0115: a company's named templates, which `companyTemplates` rows hang under.
  const namedTemplateRows = model('NamedTemplateModel', NamedTemplateSchema);

  const clock: Clock = new FixedClock(now);
  const storage = new StubStorage();
  const audit = new AuditService(model('AuditLogModel', AuditLogSchema) as never);
  // P11-T3: the §3.5 read audit, one seam for every subject read.
  const subjectReads = new SubjectReadAudit(audit);

  const leads = new LeadStatusService(
    new LeadStatusRepository(leadStatuses as never), audit, clock,
  );
  const kpms = model('KpmModelForConfig', KpmSchema);
  /*
   * P18.9-T2 (ADR-0163): an office's activity binding, and `resolveCascadeBinding`, the one reader every cascade
   * count goes through — the summary, coaching, the Unit Dashboard, pace status, the goals and the campaigns below.
   */
  const activityBindingRows = model(ActivityBinding.name, ActivityBindingSchema);
  const activityBindingRepository = new ActivityBindingRepository(activityBindingRows as never);
  const activityBindings = new ActivityBindingService(
    activityBindingRepository, new ActivityTypeRepository(types as never), kpms as never, audit,
  );
  // Shared, because the lead service resolves a leader's downline from the same rows the org
  // module reads — two handles on one collection is two caches and one of them stale.
  const memberships = new MembershipRepository(model(Membership.name, MembershipSchema) as never);
  // P11-T3: `COACH(actor, subject)`, which goals, leads and activity resolve a subject through.
  const coach = new CoachResolver(memberships);
  const users = model('UserModelForConfig', UserSchema);
  const companyOrgLevels = model('CompanyOrgLevelModelForConfig', CompanyOrgLevelSchema);
  const orgLevels = new OrgLevelService(
    companyOrgLevels as never,
    model('CompanyModelForConfig', CompanySchema) as never,
    kpms as never,
    audit,
    clock,
  );
  /*
   * After `orgLevels`: since P4-T15 the ratio service validates applicability against the
   * company's ladder, and since P4-T18 so does the activity service — both read the
   * ladder rather than owning a copy of it.
   */
  const activity = new ActivityConfigService(
    new ActivityCategoryRepository(categories as never),
    new ActivityTypeRepository(types as never),
    new RatioDefinitionRepository(ratioDefinitions as never),
    orgLevels,
    audit,
    clock,
    // P18.9-T2: a bound type is not archived (ADR-0163 §5).
    activityBindings,
  );
  const ratios = new RatioService(
    new RatioDefinitionRepository(ratioDefinitions as never), activity, orgLevels, audit, clock,
  );
  // P5-T1. Before `config`, which renders what agents are offered from it.
  // P5-T2: a module's content is files, and files are the asset registry's (ADR-0032).
  const assetRows = model('AssetModelForConfig', AssetSchema);
  const assets = new AssetService(
    new AssetRepository(assetRows as never), storage, clock,
  );
  const training = new TrainingService(
    new TrainingCategoryRepository(trainingCategories as never),
    new TrainingSkillRepository(trainingSkills as never),
    new TrainingModuleRepository(trainingModules as never),
    audit,
    clock,
    assets,
    kpms as never,
  );
  /*
   * P18.5-T1, T2: each member's progress, what the published snapshot offers, and the one read every reader of
   * progress goes through. Before the activation engine, which completes a training-linked item from them.
   */
  const trainingProgressRows = new TrainingProgressRepository(
    model(TrainingProgress.name, TrainingProgressSchema) as never,
  );
  const offeredTraining = new OfferedTraining(new ConfigSnapshotRepository(snapshots as never), training);
  const trainingReadings = new TrainingProgressReadings(
    trainingProgressRows, offeredTraining,
    new TrainingModuleRepository(trainingModules as never),
    new TrainingSkillRepository(trainingSkills as never),
    new TrainingCategoryRepository(trainingCategories as never),
  );
  // P5-T3. After `training`, whose modules its links are checked against.
  const activation = new ActivationService(
    new ActivationTemplateRepository(activationTemplates as never),
    training,
    kpms as never,
    audit,
    clock,
    // The Phase 18.5 exit review (B2): a hire's link titles come from what the office offers.
    offeredTraining,
  );
  // P5-T4. Company-partitioned: it takes a companyId, and never a kpmId.
  const products = new ProductService(
    productRows as never,
    model('CompanyModelForConfig', CompanySchema) as never,
    audit,
    clock,
  );
  // P5-T5: what an office decides about its company's products.
  const kpmProducts = new KpmProductService(
    new KpmProductConfigRepository(
      model('KpmProductConfigModel', KpmProductConfigSchema) as never,
    ),
    productRows as never,
    kpms as never,
    assets,
    audit,
    clock,
  );
  // P5-T6: the events an office runs. Nothing per-person lives on one.
  // P18.5-T5, T6: the members' rows beside them (RSVPs, claims, confirmations, answers), the audience as at the
  // start, the readings, the agent's side and the office's roll call and summary.
  const eventTypeRows = new EventTypeRepository(model(EventType.name, EventTypeSchema) as never);
  const eventRows = new EventRepository(model(Event.name, EventSchema) as never);
  const eventRsvps = new EventRsvpRepository(model(EventRsvp.name, EventRsvpSchema) as never);
  const eventFeedback = new EventFeedbackRepository(model(EventFeedback.name, EventFeedbackSchema) as never);
  const events = new EventService(
    eventTypeRows, eventRows, memberships, audit, clock, new TenantDay(kpms as never, clock), eventRsvps, eventFeedback,
  );
  const eventAudiences = new EventAudienceReader(
    memberships, new MembershipHistoryRepository(model(MembershipHistory.name, MembershipHistorySchema) as never),
  );
  const eventReadings = new EventReadings(
    eventRows, eventRsvps, eventFeedback, eventAudiences, new TenantDay(kpms as never, clock), clock,
  );
  const eventGuests = new EventGuestService(
    eventRows, eventTypeRows, eventRsvps, eventFeedback, eventAudiences, eventReadings,
    new TenantDay(kpms as never, clock), model('CompanyModelForConfig', CompanySchema) as never, audit, clock,
  );
  const eventRollCalls = new EventRollCallService(
    eventReadings, eventRsvps, memberships, new MemberNames(memberships, users as never), orgLevels,
    new TenantDay(kpms as never, clock), audit, clock,
  );
  /*
   * **A recorder, not a second implementation.** `NotificationService` needs a preferences model,
   * a renderer and its channel adapters, and none of that is what a goal test is asking about —
   * what it asks is *did a leader's write announce itself* (P8-T4 AC-7). The real service has its
   * own specs; this captures the request so a caller's test can read it.
   */
  const sentNotifications: Record<string, unknown>[] = [];
  /*
   * P11-T8: a save through a coaching session coalesces into one notice (`sendCoalesced`, recorded with
   * its `coalesceKey` in the same list), and finalize releases the round's held email (recorded here).
   */
  const releasedNotifications: Record<string, unknown>[] = [];
  const notifier = overrides.notifications ?? {
    send: async (request: Record<string, unknown>) => { sentNotifications.push(request); },
    sendCoalesced: async (request: Record<string, unknown>) => { sentNotifications.push(request); },
    releaseHeld: async (kpmId: string, coalesceKey: string, templateId: string) => {
      releasedNotifications.push({ kpmId, coalesceKey, templateId });
    },
  } as unknown as NotificationService;

  // P9-T1: the office's production, month by month — the authoritative APE source. Built before
  // the goals, which read it (P9-T6).
  const monthRows = new MonthlyAgentDataRepository(model(MonthlyAgentData.name, MonthlyAgentDataSchema) as never);
  const productionReadings = new ProductionReadings(monthRows);

  // P8-T1: one agent's agreed plan for one period.
  // P10-T9, P10-T5: a member's counts, and the sections their rung is shown — the activity module's seam.
  const activityReadings = new ActivityReadings(
    new ActivityLogRepository(model(ActivityLog.name, ActivityLogSchema) as never),
    new ActivityCategoryRepository(categories as never),
    new ActivityTypeRepository(types as never),
  );
  /*
   * Phase 13: each hire's activation and the engine that completes its linked items. Before the goals,
   * leads and activity, whose writes reach it through `ActivationEvents` — the real one, so a spec that
   * saves a goal for a hire watches the item complete, as the app does.
   */
  const activationRows = new ActivationProgressRepository(
    model(ActivationProgress.name, ActivationProgressSchema) as never,
  );
  const activationEngine = new ActivationLinkEngine(
    activationRows,
    new GoalRepository(model(Goal.name, GoalSchema) as never),
    new LeadReadings(
      new LeadRepository(model(Lead.name, LeadSchema) as never),
      new LeadStatusRepository(leadStatuses as never),
      clock,
    ),
    activityReadings,
    clock,
    // P18.5-T3: a training-linked item completes from the hire's progress.
    trainingReadings,
    // P18.96-T4: the data-backed items read the production file and the coaching sessions.
    productionReadings,
    new CoachingReadings(new CoachingSessionRepository(model(CoachingSession.name, CoachingSessionSchema) as never), clock),
  );
  const activationProgress = new ActivationProgressService(
    activationRows, activation, activationEngine, memberships,
    new MembershipHistoryRepository(model(MembershipHistory.name, MembershipHistorySchema) as never), coach,
    new MemberNames(memberships, users as never), new TenantDay(kpms as never, clock), audit, clock,
    // P18.5-T3, D-orphan: which modules are offered now.
    offeredTraining,
  );
  // P18.5-T1, T4: the learner's training and the coach's read; a module marked done signals the activation above.
  const trainingProgress = new TrainingProgressService(
    trainingProgressRows, trainingReadings, offeredTraining, training, coach, subjectReads,
    new TenantDay(kpms as never, clock), audit, clock, activationProgress,
  );
  /*
   * P18.96-T4: each person's first sale, answered to the leads' and the production file's writes — the real one, so a
   * spec that moves a lead to *Paid and issued* watches the membership and the checklist move, as the app does.
   */
  // P18.96-T6: each new hire's 3M activation, kept once decided — before a first sale, a join date or leaving moves it.
  // *Mark left* removes the new hire through the removal's own path (no departure hook here: no calendar in these specs).
  const leaverHistory = new MembershipHistoryRepository(model(MembershipHistory.name, MembershipHistorySchema) as never);
  const leaverHierarchy = new HierarchyService(memberships, kpms as never, users as never, leaverHistory, clock, orgLevels);
  const leaverRemoval = new RemovalService(
    memberships, leaverHierarchy,
    new RoleChangeService(memberships, leaverHierarchy, leaverHistory, users as never, audit, notifier, clock),
    leaverHistory, audit, notifier, clock,
  );
  const activation3M = new Activation3MService(
    memberships, new TenantDay(kpms as never, clock), clock, coach, audit, leaverRemoval,
  );
  const firstSale = new FirstSaleService(
    memberships,
    new LeadReadings(new LeadRepository(model(Lead.name, LeadSchema) as never), new LeadStatusRepository(leadStatuses as never), clock),
    productionReadings,
    new TenantDay(kpms as never, clock),
    clock,
    activationProgress,
    activation3M,
  );

  const goals = new GoalService(
    new GoalRepository(model(Goal.name, GoalSchema) as never),
    audit,
    clock,
    new TenantDay(kpms as never, clock),
    memberships,
    new MemberNames(memberships, users as never),
    notifier,
    productionReadings,
    activityReadings,
    coach,
    // P11-T8: `PUT /goals/:period?for=&session=` asks whether the session is the caller's open one.
    new CoachingSessionGate(
      new CoachingSessionRepository(model(CoachingSession.name, CoachingSessionSchema) as never), coach,
    ),
    // P13-T3: a goal saved on a hire's membership completes their `feature:goals` item.
    activationProgress,
    // P18.8-T10: a new plan's two percentages open on the office's benchmarks (ADR-0160 §3).
    new RatioDefinitionRepository(ratioDefinitions as never),
    // P18.9-T2: the measured rates and `cascadeBinding` read the office's binding.
    activityBindings,
  );
  // P6: what an agent did, day by day. The first module holding what people *did*. After `goals` since
  // P11-T4, whose plan the 7-day targets read.
  const activityLogs = new ActivityService(
    new ActivityLogRepository(model(ActivityLog.name, ActivityLogSchema) as never),
    new ActivityTypeRepository(types as never),
    new ActivityCategoryRepository(categories as never),
    coach,
    kpms as never,
    clock,
    audit,
    new RatioDefinitionRepository(ratioDefinitions as never),
    subjectReads,
    // P11-T4: the month's plan its 7-day targets are pro-rated from, and the sections a rung is shown.
    goals,
    productionReadings,
    activityReadings,
    // P13-T3: a day saved or corrected may make a hire's fourth week of activity.
    activationProgress,
    // The published copy is handed over below, once `config` exists.
    undefined,
    // P18.9-T2: the 7-day targets count the office's binding.
    activityBindings,
  );
  // P10-T4: the Personal Summary, read from the goal, the office's production and the member's log.
  const summary = new SummaryService(
    goals,
    productionReadings,
    activityReadings,
    new TenantDay(kpms as never, clock),
    new LeadReadings(
      new LeadRepository(model(Lead.name, LeadSchema) as never),
      new LeadStatusRepository(leadStatuses as never),
      clock,
    ),
    activityLogs,
    // P11-T4: `GET /summary?for=` resolves its subject through `COACH`, and records a read of somebody else's.
    coach,
    subjectReads,
    // Phase 15: who corrected a figure, by name.
    new MemberNames(memberships, users as never),
    // P18.9-T2: the targets, the pace and the tiles count the office's binding.
    activityBindings,
  );
  // P11-T5: the coaching sessions, and the coaching metrics read over them.
  const coachingSessions = new CoachingSessionRepository(
    model(CoachingSession.name, CoachingSessionSchema) as never,
  );
  const coachingReadings = new CoachingReadings(coachingSessions, clock);
  // P11-T6: `GOAL_PACE_STATUS` over `PACING_TO_MAA`, and the roster that serves them.
  const paceStatus = new PaceStatusReadings(
    new GoalRepository(model(Goal.name, GoalSchema) as never), productionReadings, activityReadings, activityBindings,
  );
  const coachingRoster = new CoachingRosterService(
    coach,
    coachingReadings,
    paceStatus,
    new MemberNames(memberships, users as never),
    orgLevels,
    new TenantDay(kpms as never, clock),
  );
  // P11-T7: the person a coaching page opens on.
  const coachee = new CoacheeService(
    coach, new MemberNames(memberships, users as never), orgLevels, new TenantDay(kpms as never, clock),
  );
  // P11-T5: the session lifecycle, and the snapshot finalize takes through the live cards' own internals.
  const coachingSnapshots = new CoachingSnapshotBuilder(
    summary, activityLogs, new GoalRepository(model(Goal.name, GoalSchema) as never), clock,
  );
  const coachingSession = new CoachingSessionService(
    coachingSessions,
    coach,
    new MemberNames(memberships, users as never),
    new TenantDay(kpms as never, clock),
    new LeadRepository(model(Lead.name, LeadSchema) as never),
    coachingSnapshots,
    audit,
    subjectReads,
    notifier,
    clock,
    // P18.96-T4: a 1:1 finalized or logged with a new hire counts toward their *Weekly 1-on-1 check-in*.
    activationProgress,
  );
  // P11-T10: a finalized session's print, and the reader's own coaching.
  const coachingRecord = new CoachingRecordService(
    coachingSessions, coach, new MemberNames(memberships, users as never), audit, subjectReads,
  );
  const productionNames = new MemberNames(memberships, users as never);
  // P9-T4: a month's lock and revision, and the imports that write it.
  const productionMonths = new ProductionMonths(
    new ProductionMonthRepository(model(ProductionMonth.name, ProductionMonthSchema) as never),
    kpms as never,
    clock,
    productionNames,
    audit,
  );
  const production = new ProductionService(monthRows, memberships, productionNames, kpms as never, productionMonths);
  const productionImport = new ProductionImportService(
    production,
    productionMonths,
    monthRows,
    new DataUploadBatchRepository(model(DataUploadBatch.name, DataUploadBatchSchema) as never),
    new DataUploadRowRepository(model(DataUploadRow.name, DataUploadRowSchema) as never),
    productionNames,
    audit,
    clock,
    // P18.96-T4: a policy in the file may be a member's first sale.
    firstSale,
  );
  // P9-T5: one figure by hand.
  const productionCorrections = new ProductionCorrections(productionMonths, monthRows, memberships, audit, clock, firstSale);
  // P5-T7: the office's campaigns, and the carrier rules it is measured against.
  const campaigns = new CampaignService(
    new CampaignRepository(model(Campaign.name, CampaignSchema) as never),
    model(QualificationRule.name, QualificationRuleSchema) as never,
    kpms as never,
    audit,
    clock,
    // P18.5-T7: a campaign's rungs are checked against the company's ladder.
    orgLevels,
  );
  // P5-T8: the office's capability catalog.
  const capability = new CapabilityService(
    new CapabilityCatalogRepository(
      model(CapabilityCatalog.name, CapabilityCatalogSchema) as never,
    ),
    audit,
  );
  /*
   * After the three Phase 5 services it reads (P5-T9 AC-1).
   *
   * `/kpm/config` carries the office's own configuration, and the checklist, the event types and
   * the capability catalog are part of it — so this is constructed once they exist rather than
   * before them.
   */
  const config = new TenantConfigService(
    activity, ratios, leads,
    new ConfigSnapshotRepository(snapshots as never),
    audit, clock,
    orgLevels,
    training,
    activation,
    events,
    capability,
    // P18.9-T2: the binding rendered into each snapshot, as its record.
    activityBindings,
  );
  /*
   * P13.1-T2: the activity log reads and saves in the office's published vocabulary, as Nest wires it
   * (`@Inject(TenantConfigService)`). `activityLogs` is built before `config` — the checklist and the
   * capability catalog that `config` carries need the services above it — so the copy is handed over here
   * rather than through the constructor. Without it the harness would test the draft path production
   * never takes.
   */
  Object.assign(activityLogs, { published: config });
  /*
   * P7-T1: one person an agent is working. The first record about somebody who is not a user.
   * After `config` since P10.1-T4: the *Status* sort ranks stages by the published ladders.
   */
  const leadRecords = new LeadService(
    new LeadRepository(model(Lead.name, LeadSchema) as never),
    new LeadStatusRepository(leadStatuses as never),
    audit,
    clock,
    new TenantDay(kpms as never, clock),
    coach,
    new MemberNames(memberships, users as never),
    config,
    subjectReads,
    // P13-T3: a lead in a hire's pipeline completes their `feature:leads` item.
    activationProgress,
    // P18.96-T4: a sales lead at *Paid and issued* may be its owner's first sale.
    firstSale,
  );
  // P18.96-T4: a data-backed item's hand tick, with its record — through the leads and the coaching sessions.
  const activationRecords = new ActivationItemRecords(
    activationProgress, leadRecords, coachingSession, new TenantDay(kpms as never, clock),
  );
  const newHires = new NewHiresService(
    activationProgress, activationRows, coach, new MemberNames(memberships, users as never),
    new TenantDay(kpms as never, clock), subjectReads, audit, clock, memberships, activationRecords, activation3M,
  );
  const provisioning = new ProvisioningService(
    categories as never,
    types as never,
    leadStatuses as never,
    ratioDefinitions as never,
    snapshots as never,
    templates as never,
    trainingCategories as never,
    trainingSkills as never,
    trainingModules as never,
    activationTemplates as never,
    model(EventType.name, EventTypeSchema) as never,
    model(CapabilityCatalog.name, CapabilityCatalogSchema) as never,
    model(QualificationRule.name, QualificationRuleSchema) as never,
    clock,
    config,
    namedTemplateRows as never,
    // P18.9-T2: the office's binding, copied from the source's taxonomy.
    activityBindingRows as never,
    // P18.9-T3: the Template library an office may start from, and the ladder its rungs are checked against.
    model('CompanyModelForConfig', CompanySchema) as never,
    orgLevels,
  );

  // `orgLevels` and `kpms` are exposed since P4-T15: a ratio's applicability validates
  // against the company's ladder, so a spec exercising it has to be able to publish one.
  const changes = new ConfigChangeService(activity, ratios, config, orgLevels, training);

  /*
   * The Company template service, with the real applier (P5-T9).
   *
   * Publishing `campaign_kinds` writes the company's carrier rules, so a spec that publishes one
   * and then reads the rules is exercising the whole path rather than a fake in the middle.
   */
  const namedTemplates = new NamedTemplateService(
    namedTemplateRows as never,
    templates as never,
    model('CompanyModelForConfig', CompanySchema) as never,
    new KpmOfficeCounter(kpms as never),
    audit,
    clock,
  );
  const templateService = new TemplateService(
    templates as never,
    model('CompanyModelForConfig', CompanySchema) as never,
    audit,
    clock,
    new KpmOfficeCounter(kpms as never),
    provisioning,
    namedTemplates,
  );
  /*
   * P13.2-T7: the copies across an owner boundary — an office's published settings read by name across
   * tenants, files duplicated through the stub storage, rungs checked against the destination's ladder.
   */
  // The snapshot is the source of everything but the checklist and module content (P13.2's exit review).
  const officeSettings = new OfficeSettingsSource(
    new ConfigSnapshotRepository(snapshots as never),
    new ActivationTemplateRepository(activationTemplates as never),
    new TrainingModuleRepository(trainingModules as never),
    new AssetRepository(assetRows as never),
    // P18.9-T2: the office's live binding, which *Save as template* carries.
    activityBindingRepository,
  );
  const templateCopies = new TemplateCopyService(
    namedTemplates, officeSettings, assets, orgLevels, provisioning, kpms as never, audit,
  );
  // P11-T9: the Leader Notes tab — one coachee's capability ticks, and the leaders' notes about them.
  const coachingProfiles = new CoachingProfileRepository(model(CoachingProfile.name, CoachingProfileSchema) as never);
  const coachingProfile = new CoachingProfileService(
    coachingProfiles, coach, capability, new MemberNames(memberships, users as never), clock,
  );
  const leaderNoteRows = new LeaderNoteRepository(model(LeaderNote.name, LeaderNoteSchema) as never);
  const leaderNotes = new LeaderNoteService(
    leaderNoteRows, coach, memberships, new MemberNames(memberships, users as never), audit, clock,
  );

  /*
   * P12: the calendar — its entries, the people picker and the compare list, its notices through the same
   * recorder (or the real service, when a spec passes one), and D-leave's hook for a removal spec to hand
   * `RemovalService`.
   */
  const calendarEntries = new CalendarEventRepository(model(CalendarEvent.name, CalendarEventSchema) as never);
  const calendarNotices = new CalendarNotices(notifier, memberships);
  const calendar = new CalendarService(
    calendarEntries, memberships, coach, new MemberNames(memberships, users as never), orgLevels,
    new TenantDay(kpms as never, clock), calendarNotices, subjectReads, audit, clock,
  );
  const calendarPeople = new CalendarPeopleService(
    memberships, coach, new MemberNames(memberships, users as never), orgLevels, new TenantDay(kpms as never, clock),
  );
  const calendarLeave = new CalendarLeave(calendarEntries, calendarNotices, new TenantDay(kpms as never, clock), clock);

  /*
   * Phase 15: the Unit Dashboard — the roster read through the readings the person's own screens use, and a
   * leader's corrections through the month table's own function.
   */
  /*
   * Phase 18.5: campaigns, the member's side — the chases and the frozen standings through their tenant repositories,
   * the one named reader of chases, the evaluation through production's and activity's own readings, the agent's
   * service, the 18.6 port, and what leaving does to a member's chases.
   */
  const campaignRows = new CampaignRepository(model(Campaign.name, CampaignSchema) as never);
  const campaignChases = new CampaignChaseRepository(model(CampaignChase.name, CampaignChaseSchema) as never);
  const campaignStandings = new CampaignStandingRepository(model(CampaignStanding.name, CampaignStandingSchema) as never);
  const campaignChaseReadings = new CampaignChaseReadings(campaignRows, campaignChases, clock);
  const campaignEvaluation = new CampaignEvaluation(
    productionReadings, productionMonths, activityReadings, new RatioDefinitionRepository(ratioDefinitions as never),
    memberships, campaignChases, campaignStandings, campaignRows, new TenantDay(kpms as never, clock), clock, audit,
    // P18.9-T2: the cascade touches count the office's binding.
    activityBindings,
  );
  const campaignAgent = new CampaignAgentService(
    campaignRows, campaignChases, campaignChaseReadings, campaignEvaluation, coach, memberships, audit,
    new TenantDay(kpms as never, clock), clock,
  );
  const campaignStandingsReader = new CampaignStandingsReader(
    campaignRows, memberships, campaignEvaluation, new TenantDay(kpms as never, clock), clock,
  );
  const campaignDeparture = new CampaignChaseDeparture(campaignChases, clock, audit);
  // P18.6-T2: the override of a final standing.
  const campaignStandingOverrides = new CampaignStandingOverrides(
    campaignRows, memberships, campaignStandings, campaignEvaluation, new MemberNames(memberships, users as never), audit, clock,
  );

  const unitDashboard = new UnitDashboardService(
    coach, new MemberNames(memberships, users as never), orgLevels, new TenantDay(kpms as never, clock),
    coachingReadings, paceStatus, goals, productionReadings, productionMonths, productionCorrections, activityReadings,
    new LeadReadings(
      new LeadRepository(model(Lead.name, LeadSchema) as never),
      new LeadStatusRepository(leadStatuses as never),
      clock,
    ),
    subjectReads,
    campaignChaseReadings,
    // P18.96-T5: the head's own membership, for whether they count for production yet.
    memberships,
    // P18.9-T2: the activity cells count the office's binding.
    activityBindings,
  );

  /*
   * Phase 17: recruitment tools — the company's playbook (read through its named company-filtered method),
   * the plan built from it, and an office's four pitch documents through the tenant-scoped repository.
   */
  const recruitmentPlaybookRows = model(RecruitmentPlaybook.name, RecruitmentPlaybookSchema);
  const recruitmentPlaybooks = new RecruitmentPlaybookService(
    recruitmentPlaybookRows as never,
    model('CompanyModelForConfig', CompanySchema) as never,
    users as never,
    audit,
  );
  const recruitmentPlans = new RecruitmentPlanService(recruitmentPlaybooks, new TenantDay(kpms as never, clock));
  const recruitmentPitch = new RecruitmentPitchService(
    new RecruitmentPitchRepository(model(RecruitmentPitchSlot.name, RecruitmentPitchSlotSchema) as never),
    assets, audit, new TenantDay(kpms as never, clock), clock,
  );

  /*
   * Phase 18: the Owner's reporting — the Overview, the analytics and the platform's adoption, every figure through
   * the readings above; the recruitment target's tenant repository; the campaigns module's one named reader of the
   * carrier rules; and the directory's two columns.
   */
  const leadReadings = new LeadReadings(
    new LeadRepository(model(Lead.name, LeadSchema) as never),
    new LeadStatusRepository(leadStatuses as never),
    clock,
  );
  const recruitTargets = new KpmRecruitTargetRepository(model(KpmRecruitTarget.name, KpmRecruitTargetSchema) as never);
  const officePeople = new OfficePeople(
    memberships, new MemberNames(memberships, users as never), kpms as never,
    model('CompanyModelForConfig', CompanySchema) as never, orgLevels, clock,
  );
  const carrierRules = new CarrierRules(model(QualificationRule.name, QualificationRuleSchema) as never, kpms as never);
  const kpmOverview = new KpmOverviewService(
    officePeople, new TenantDay(kpms as never, clock), clock, activityReadings, coachingReadings,
    leadReadings, recruitTargets, productionReadings, goals, subjectReads, audit,
  );
  const kpmAnalytics = new KpmAnalyticsService(
    officePeople, new TenantDay(kpms as never, clock), clock, coachingReadings, leadReadings,
    productionReadings, goals, carrierRules,
  );
  const platformAnalytics = new PlatformAnalyticsService(
    kpms as never, model('CompanyModelForConfig', CompanySchema) as never, memberships, orgLevels, clock,
  );
  const directoryColumns = new DirectoryColumns(
    activityReadings, coachingReadings, new TenantDay(kpms as never, clock), clock, subjectReads,
  );

  return {
    activity, ratios, leads, config, provisioning, templates, templateService, audit, clock, changes,
    namedTemplates, namedTemplateRows, officeSettings, templateCopies, assetRows,
    orgLevels, kpms, companies: model('CompanyModelForConfig', CompanySchema), training, activation,
    products, assets, storage, kpmProducts, events, campaigns, capability, activityLogs,
    leadRecords,
    goals, production, productionMonths, productionImport, productionCorrections, productionReadings, summary,
    sentNotifications, coach, subjectReads,
    coachingSessions, coachingReadings, paceStatus, coachingRoster, activityReadings, coachee,
    coachingSnapshots, coachingSession, releasedNotifications,
    coachingProfiles, coachingProfile, leaderNoteRows, leaderNotes,
    coachingRecord,
    calendarEntries, calendarNotices, calendar, calendarPeople, calendarLeave,
    activationRows, activationEngine, activationProgress, newHires, firstSale, activationRecords, activation3M,
    trainingProgressRows, offeredTraining, trainingReadings, trainingProgress,
    unitDashboard,
    campaignRows, campaignChases, campaignStandings, campaignChaseReadings, campaignEvaluation, campaignAgent,
    campaignStandingsReader, campaignDeparture, campaignStandingOverrides,
    recruitmentPlaybookRows, recruitmentPlaybooks, recruitmentPlans, recruitmentPitch,
    leadReadings, recruitTargets, officePeople, carrierRules, kpmOverview, kpmAnalytics, platformAnalytics,
    directoryColumns, memberships, users,
    eventRsvps, eventFeedback, eventAudiences, eventReadings, eventGuests, eventRollCalls,
    activityBindings, activityBindingRows,
  };
}

/**
 * Copy a whole configuration into an office, the way creating one from **the AgencyBoost defaults**
 * does (ADR-0115 §4). `_companyId` is kept for the callers that pass one: since 13.2 a source is
 * chosen, never looked up with a fallback, and the defaults are what these specs were always given.
 */
export async function provisionOffice(
  module: ReturnType<typeof configModule>,
  kpmId: string,
  _companyId?: string,
) {
  // Each seed's source defaults to the AgencyBoost defaults.
  const seeded = await module.provisioning.seedActivityTaxonomy(kpmId);
  await module.provisioning.seedLeadPipelines(kpmId);
  await module.provisioning.seedRatioDefinitions(kpmId, seeded.typeCodes);
  const training = await module.provisioning.seedTrainingTaxonomy(kpmId);
  await module.provisioning.seedActivationChecklist(kpmId, training.publishedModuleCodes);
  await module.provisioning.seedEventTypes(kpmId);
  await module.provisioning.seedCapabilityCatalog(kpmId);
  return seeded;
}

/**
 * Build an office's configuration **from a chosen source**, the way `createKpm` does (ADR-0115 §4):
 * the plan resolved and checked whole, then written. Absent, the company's default template.
 */
export async function provisionFrom(
  module: ReturnType<typeof configModule>,
  kpmId: string,
  companyId: string,
  startFrom?: { kind: 'template' | 'defaults' | 'empty'; templateId?: string },
) {
  return module.provisioning.provision(kpmId, await module.provisioning.planFor(companyId, startFrom));
}

/**
 * **A company's default template, as migration `0023` or `createCompany` leaves one** (ADR-0115 §3),
 * for a spec that reads or writes a template kind without naming a template. `origin: 'migration'`
 * makes it answer for offices with no `startedFrom`, as the migration's does.
 */
export async function givenDefaultTemplate(
  module: ReturnType<typeof configModule>,
  companyId: string,
  over: { name?: string; origin?: 'migration' | 'empty' | 'defaults' } = {},
): Promise<string> {
  const row = await (module.namedTemplateRows as unknown as {
    create: (d: unknown) => Promise<{ _id: unknown }>;
  }).create({
    companyId, name: over.name ?? 'Company template', isDefault: true, status: 'active',
    archivedAt: null, origin: { kind: over.origin ?? 'migration' }, deletedAt: null,
  });
  return String(row._id);
}

export {
  ActivityCategory, ActivityCategorySchema, ActivityType, ActivityTypeSchema,
  ConfigSnapshot, ConfigSnapshotSchema, LeadStatus, LeadStatusSchema,
  CompanyTemplate, CompanyTemplateSchema, RatioDefinition, RatioDefinitionSchema,
  AuditLog, AuditLogSchema,
  TrainingCategory, TrainingCategorySchema, TrainingSkill, TrainingSkillSchema,
  TrainingModule, TrainingModuleSchema,
  ActivationTemplate, ActivationTemplateSchema,
};
