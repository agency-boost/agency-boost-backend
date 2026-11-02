import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { validateEnv } from '@/config/env.validation';
import { GracefulShutdown } from '@/graceful-shutdown';
import { Clock, SystemClock } from '@/common/clock/clock.port';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { LoggingModule } from '@/common/logging/logging.module';
import { AuthGuard } from '@/common/auth/auth.guard';
import { PermissionsGuard } from '@/common/auth/permissions.guard';

import { HealthController } from '@/modules/health/health.controller';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditReadService } from '@/modules/audit/audit-read.service';
import { LeadController } from '@/modules/leads/lead.controller';
import { LeadRepository } from '@/modules/leads/lead.repository';
import { LeadService } from '@/modules/leads/lead.service';
import { LeadReadings } from '@/modules/leads/lead-readings';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { Lead, LeadSchema } from '@/modules/leads/lead.schema';
import { Goal, GoalSchema } from '@/modules/goals/goal.schema';
import { GoalRepository } from '@/modules/goals/goal.repository';
import { GoalService } from '@/modules/goals/goal.service';
import { GoalController } from '@/modules/goals/goal.controller';
import { Policy, PolicySchema } from '@/modules/production/policy.schema';
import { MonthlyAgentData, MonthlyAgentDataSchema } from '@/modules/production/monthly-agent-data.schema';
import { PolicyRepository } from '@/modules/production/policy.repository';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';
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
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { SummaryController } from '@/modules/summary/summary.controller';
import { SummaryService } from '@/modules/summary/summary.service';
import { ProductionService } from '@/modules/production/production.service';
import { ProductionController } from '@/modules/production/production.controller';
import { AuditService } from '@/modules/audit/audit.service';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import {
  Notification, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from '@/modules/notifications/notification.schema';
import {
  NOTIFICATION_ADAPTERS, NotificationService, TemplateRenderer,
} from '@/modules/notifications/notification.service';
import { NotificationController } from '@/modules/notifications/notification.controller';
import { NotificationRepository } from '@/modules/notifications/notification.repository';
import { EmailTemplateRenderer } from '@/modules/notifications/email-renderer';
import { RecipientAddressBook, SmtpChannelAdapter } from '@/modules/notifications/smtp.adapter';
import { UserAddressBook } from '@/modules/notifications/user-address-book';
import { RecipientLanguages, UserLanguages } from '@/modules/notifications/recipient-languages';
import { InAppChannelAdapter, LogEmailAdapter } from '@/modules/notifications/local-adapters';
import { resolveMailProvider } from '@/modules/notifications/mail-provider';
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
import { ActivityBinding, ActivityBindingSchema } from '@/modules/config/activity-binding.schema';
import { ActivityBindingRepository } from '@/modules/config/activity.repository';
import { ActivityBindingService } from '@/modules/config/activity-binding.service';
import {
  ActivityBindingAdminController, ActivityBindingReadController,
} from '@/modules/config/activity-binding.controller';
import {
  CompanyTemplate, CompanyTemplateSchema,
} from '@/modules/config/company-template.schema';
import {
  ActivityCategoryRepository, ActivityTypeRepository, ConfigSnapshotRepository,
  LeadStatusRepository, RatioDefinitionRepository,
} from '@/modules/config/activity.repository';
import { LeadStatusService } from '@/modules/config/lead-status.service';
import { RatioService } from '@/modules/config/ratio.service';
import { ConfigChangeService } from '@/modules/config/changes.service';
import { ActivityConfigService } from '@/modules/config/activity.service';
import { ProvisioningService } from '@/modules/config/provisioning.service';
import {
  TenantConfigController, TenantConfigReadController,
} from '@/modules/config/config.controller';
import { TenantConfigService } from '@/modules/config/tenant-config.service';
import { TemplateService } from '@/modules/config/template.service';
import { NamedTemplate, NamedTemplateSchema } from '@/modules/config/named-template.schema';
import { NamedTemplateService } from '@/modules/config/named-template.service';
import { NamedTemplateController } from '@/modules/config/named-template.controller';
import { OfficeTemplateController } from '@/modules/config/office-template.controller';
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
import { TrainingController } from '@/modules/training/training.controller';
import { TrainingProgress, TrainingProgressSchema } from '@/modules/training/training-progress.schema';
import { TrainingProgressRepository } from '@/modules/training/training-progress.repository';
import { OfferedTraining } from '@/modules/training/offered-training';
import { TrainingProgressReadings } from '@/modules/training/training-progress-readings';
import { TrainingProgressService } from '@/modules/training/training-progress.service';
import { TrainingProgressController } from '@/modules/training/training-progress.controller';
import {
  ActivationTemplate, ActivationTemplateSchema,
} from '@/modules/activation/activation-template.schema';
import { ActivationTemplateRepository } from '@/modules/activation/activation.repository';
import { ActivationService } from '@/modules/activation/activation.service';
import { ActivationController } from '@/modules/activation/activation.controller';
import {
  ActivationProgress, ActivationProgressSchema,
} from '@/modules/activation/activation-progress.schema';
import { ActivationProgressRepository } from '@/modules/activation/activation-progress.repository';
import { ActivationLinkEngine } from '@/modules/activation/activation-links';
import { ActivationProgressService } from '@/modules/activation/activation-progress.service';
import { NewHiresService } from '@/modules/activation/new-hires.service';
import { ActivationProgressController } from '@/modules/activation/activation-progress.controller';
import { NewHiresController } from '@/modules/activation/new-hires.controller';
import { BillingController } from '@/modules/billing/billing.controller';
import { ActivationEvents } from '@/modules/activation/activation-events.port';
import { ActivationItemRecords } from '@/modules/activation/activation-records.service';
import { FirstSaleService } from '@/modules/activation/first-sale.service';
import { Activation3MService } from '@/modules/activation/activation-3m.service';
import { SalesEvents } from '@/modules/activation/sales-events.port';
import { ActivationNav } from '@/modules/activation/activation-nav.port';
import { ActivationStarter } from '@/modules/org/activation-starter.port';
import { Product, ProductSchema } from '@/modules/products/product.schema';
import { ProductService } from '@/modules/products/product.service';
import { ProductController } from '@/modules/products/product.controller';
import {
  KpmProductConfig, KpmProductConfigSchema,
} from '@/modules/products/kpm-product-config.schema';
import { KpmProductConfigRepository } from '@/modules/products/kpm-product.repository';
import { KpmProductService } from '@/modules/products/kpm-product.service';
import { KpmProductController } from '@/modules/products/kpm-product.controller';
import { ProductCatalogService } from '@/modules/products/product-catalog.service';
import {
  AttackPlanController, ProductCatalogController,
} from '@/modules/products/product-catalog.controller';
import { Event, EventSchema, EventType, EventTypeSchema } from '@/modules/events/event.schema';
import {
  EventFeedbackRepository, EventRepository, EventRsvpRepository, EventTypeRepository,
} from '@/modules/events/event.repository';
import { EventService } from '@/modules/events/event.service';
import { EventController } from '@/modules/events/event.controller';
// P18.5-T5, T6: members' RSVPs, claims, confirmations and answers, and the readings over them.
import { EventRsvp, EventRsvpSchema } from '@/modules/events/event-rsvp.schema';
import { EventFeedback, EventFeedbackSchema } from '@/modules/events/event-feedback.schema';
import { EventAudienceReader } from '@/modules/events/event-audience';
import { EventReadings } from '@/modules/events/event-readings';
import { EventGuestService } from '@/modules/events/event-guest.service';
import { EventRollCallService } from '@/modules/events/event-roll-call.service';
import { EventGuestController } from '@/modules/events/event-guest.controller';
import { ActivityLog, ActivityLogSchema } from '@/modules/activity/activity-log.schema';
import { ActivityLogRepository } from '@/modules/activity/activity-log.repository';
import { ActivityService } from '@/modules/activity/activity.service';
import { ActivityController } from '@/modules/activity/activity.controller';
import {
  Campaign, CampaignSchema, QualificationRule, QualificationRuleSchema,
} from '@/modules/campaigns/campaign.schema';
import { CampaignRepository } from '@/modules/campaigns/campaign.repository';
import { CampaignService } from '@/modules/campaigns/campaign.service';
import { CampaignController } from '@/modules/campaigns/campaign.controller';
import { MetricRegistryController } from '@/modules/campaigns/metric-registry.controller';
import { CampaignChase, CampaignChaseSchema } from '@/modules/campaigns/campaign-chase.schema';
import { CampaignStanding, CampaignStandingSchema } from '@/modules/campaigns/campaign-standing.schema';
import { CampaignChaseRepository } from '@/modules/campaigns/campaign-chase.repository';
import { CampaignStandingRepository } from '@/modules/campaigns/campaign-standing.repository';
import { CampaignChaseReadings } from '@/modules/campaigns/campaign-chase-readings';
import { CampaignEvaluation } from '@/modules/campaigns/campaign-evaluation';
import { CampaignAgentService } from '@/modules/campaigns/campaign-agent.service';
import { CampaignAgentController } from '@/modules/campaigns/campaign-agent.controller';
import { CampaignStandingsReader } from '@/modules/campaigns/campaign-standings-reader';
import { CampaignStandingOverrides } from '@/modules/campaigns/campaign-standing-overrides';
import { CampaignChaseDeparture } from '@/modules/campaigns/campaign-departure';
import {
  CapabilityCatalog, CapabilityCatalogSchema,
} from '@/modules/capability/capability.schema';
import { CapabilityCatalogRepository } from '@/modules/capability/capability.repository';
import { CapabilityService } from '@/modules/capability/capability.service';
import { CapabilityController } from '@/modules/capability/capability.controller';
import { OfficeCounter } from '@/modules/config/office-counter.port';
import { CampaignKindsApplier } from '@/modules/config/campaign-kinds.port';
import { KpmOfficeCounter } from '@/modules/config/office-counter';
import { Asset, AssetSchema } from '@/modules/assets/asset.schema';
import { AssetRepository } from '@/modules/assets/asset.repository';
import { AssetService } from '@/modules/assets/asset.service';
import { STORAGE_PROVIDER } from '@/modules/assets/storage.provider';
import { User, UserSchema } from '@/modules/users/user.schema';
import { AuthToken, AuthTokenSchema } from '@/modules/auth/auth-token.schema';
import {
  ImpersonationSession, ImpersonationSessionSchema,
} from '@/modules/auth/impersonation-session.schema';
import { AuthService } from '@/modules/auth/auth.service';
import { AuthController } from '@/modules/auth/auth.controller';
import { ProfileController } from '@/modules/users/profile.controller';
import { ProfileService } from '@/modules/users/profile.service';
import { AvatarLinks, AvatarService } from '@/modules/users/avatar.service';
import { PasswordService } from '@/modules/auth/password.service';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import { ContextResolver } from '@/modules/auth/context-resolver';
import { ImpersonationService } from '@/modules/auth/impersonation.service';
import { Hs256TokenSigner, TokenSigner } from '@/modules/auth/token-signer';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { TenantService } from '@/modules/tenants/tenant.service';
import { KpmRequest, KpmRequestSchema } from '@/modules/tenants/kpm-request.schema';
import { KpmRequestService } from '@/modules/tenants/kpm-request.service';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import {
  CompanyOrgLevel, CompanyOrgLevelSchema,
} from '@/modules/tenants/company-org-level.schema';
import { AdminController } from '@/modules/tenants/admin.controller';
import { CompanyController } from '@/modules/tenants/company.controller';
import { RosterImportService } from '@/modules/tenants/roster-import.service';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import {
  MembershipHistory, MembershipHistorySchema,
} from '@/modules/org/membership-history.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { ProfileLineReader } from '@/modules/org/profile-line';
import {
  GroupRepository, JoinRequestRepository, LeaderLimitRequestRepository, MemberInviteRepository, MembershipHistoryRepository,
  TransferRequestRepository,
} from '@/modules/org/org.repositories';
import { MemberInvite, MemberInviteSchema } from '@/modules/org/member-invite.schema';
import { TransferRequest, TransferRequestSchema } from '@/modules/org/transfer-request.schema';
import {
  InviteLinkController, NewHireAgentsController, TransferRequestsController,
} from '@/modules/org/invites.controller';
import { InvitesService } from '@/modules/org/invites.service';
import { TransfersService } from '@/modules/org/transfers.service';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { DirectoryService } from '@/modules/org/directory.service';
import { OrgController } from '@/modules/org/org.controller';
import { MemberPhoneController } from '@/modules/org/member-phone.controller';
import { MemberPhoneService } from '@/modules/org/member-phone.service';
import { JoinRequest, JoinRequestSchema } from '@/modules/org/join-request.schema';
import { LeaderLimitRequest, LeaderLimitRequestSchema } from '@/modules/org/leader-limit-request.schema';
import { LeaderLimitRequestAdminController } from '@/modules/org/leader-limit-request.controller';
import { LeaderLimitRequestService } from '@/modules/org/leader-limit-request.service';
import { OnboardingService } from '@/modules/org/onboarding.service';
import { OnboardingController } from '@/modules/org/onboarding.controller';
import { LeaderCodeService } from '@/modules/org/leader-code.service';
import { MemberNames } from '@/modules/org/member-names.service';
import { ApprovalsService } from '@/modules/org/approvals.service';
import { Group, GroupSchema } from '@/modules/org/group.schema';
import { AdminDelegationService } from '@/modules/org/admin-delegation.service';
import { GroupService } from '@/modules/org/group.service';
import { OrgTreeService } from '@/modules/org/org-tree.service';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { CoachingSession, CoachingSessionSchema } from '@/modules/coaching/coaching-session.schema';
import { CoachingSessionRepository } from '@/modules/coaching/coaching-session.repository';
import { CoachingReadings } from '@/modules/coaching/coaching-readings';
import { PaceStatusReadings } from '@/modules/coaching/pace-status';
import { CoachingRosterService } from '@/modules/coaching/coaching-roster.service';
import { CoacheeService } from '@/modules/coaching/coachee.service';
import { CoachingSessionService } from '@/modules/coaching/coaching-session.service';
import { CoachingSessionGate } from '@/modules/coaching/coaching-session.gate';
import { CoachingSnapshotBuilder } from '@/modules/coaching/coaching-snapshot';
import { CoachingController } from '@/modules/coaching/coaching.controller';
import { CoachingProfile, CoachingProfileSchema } from '@/modules/coaching/coaching-profile.schema';
import { LeaderNote, LeaderNoteSchema } from '@/modules/coaching/leader-note.schema';
import { CoachingProfileRepository } from '@/modules/coaching/coaching-profile.repository';
import { LeaderNoteRepository } from '@/modules/coaching/leader-note.repository';
import { CoachingProfileService } from '@/modules/coaching/coaching-profile.service';
import { LeaderNoteService } from '@/modules/coaching/leader-note.service';
import { CoachingProfileController } from '@/modules/coaching/coaching-profile.controller';
import { CoachingRecordService } from '@/modules/coaching/coaching-record.service';
import { CoachingRecordController } from '@/modules/coaching/coaching-record.controller';
import { RemovalService } from '@/modules/org/removal.service';
import { MemberDeparture, MemberDepartures } from '@/modules/org/member-departure.port';
import { CalendarEvent, CalendarEventSchema } from '@/modules/calendar/calendar-event.schema';
import { CalendarEventRepository } from '@/modules/calendar/calendar-event.repository';
import { CalendarNotices } from '@/modules/calendar/calendar-notices';
import { CalendarService } from '@/modules/calendar/calendar.service';
import { CalendarPeopleService } from '@/modules/calendar/calendar-people.service';
import { CalendarLeave } from '@/modules/calendar/calendar-leave';
import { CalendarController } from '@/modules/calendar/calendar.controller';
import { CalendarAutoItems } from '@/modules/calendar/calendar-auto-items';
import { CoachingActionDone } from '@/modules/coaching/coaching-action-done.service';
import { CoachingActionDoneController } from '@/modules/coaching/coaching-action-done.controller';
import { RoleChangeService } from '@/modules/org/role-change.service';
import { ActivityRatioReadings } from '@/modules/activity/activity-ratio-readings';
import { UnitActivitiesController } from '@/modules/unit-dashboard/unit-activities.controller';
import { UnitActivitiesService } from '@/modules/unit-dashboard/unit-activities.service';
import { UnitDashboardController } from '@/modules/unit-dashboard/unit-dashboard.controller';
import { UnitDashboardService } from '@/modules/unit-dashboard/unit-dashboard.service';
import { HomeController } from '@/modules/home/home.controller';
import { HomeService } from '@/modules/home/home.service';
import {
  RecruitmentController, RecruitmentPitchController, RecruitmentPlaybookController,
} from '@/modules/recruitment/recruitment.controller';
import {
  RecruitmentPlaybook, RecruitmentPlaybookSchema,
} from '@/modules/recruitment/recruitment-playbook.schema';
import { RecruitmentPitchSlot, RecruitmentPitchSlotSchema } from '@/modules/recruitment/recruitment-pitch.schema';
import { RecruitmentPitchRepository } from '@/modules/recruitment/recruitment-pitch.repository';
import { RecruitmentPlaybookService } from '@/modules/recruitment/recruitment-playbook.service';
import { RecruitmentPlanService } from '@/modules/recruitment/recruitment-plan.service';
import { RecruitmentPitchService } from '@/modules/recruitment/recruitment-pitch.service';
import {
  KpmAnalyticsController, KpmOverviewController, PlatformAnalyticsController,
} from '@/modules/reporting/reporting.controller';
import { KpmRecruitTarget, KpmRecruitTargetSchema } from '@/modules/reporting/kpm-recruit-target.schema';
import { KpmRecruitTargetRepository } from '@/modules/reporting/kpm-recruit-target.repository';
import { OfficePeople } from '@/modules/reporting/office-people';
import { KpmOverviewService } from '@/modules/reporting/kpm-overview.service';
import { KpmAnalyticsService } from '@/modules/reporting/kpm-analytics.service';
import { PlatformAnalyticsService } from '@/modules/reporting/platform-analytics.service';
import { DirectoryColumns } from '@/modules/reporting/directory-columns';
import { ComplianceController } from '@/modules/reporting/compliance/compliance.controller';
import { ComplianceService } from '@/modules/reporting/compliance/compliance.service';
import { TrainingComplianceCategory } from '@/modules/reporting/compliance/training.category';
import { GoalsComplianceCategory } from '@/modules/reporting/compliance/goals.category';
import { ActivityComplianceCategory } from '@/modules/reporting/compliance/activity.category';
import { ActivationComplianceCategory } from '@/modules/reporting/compliance/activation.category';
import { EventsComplianceCategory } from '@/modules/reporting/compliance/events.category';
import { CampaignsComplianceCategory } from '@/modules/reporting/compliance/campaigns.category';
import { ActivationReadings } from '@/modules/activation/activation-readings';
import { CarrierRules } from '@/modules/campaigns/carrier-rules';
import { LeaderMeeting, LeaderMeetingSchema } from '@/modules/leader-meetings/leader-meeting.schema';
import {
  LeaderMeetingShareLink, LeaderMeetingShareLinkSchema,
} from '@/modules/leader-meetings/leader-meeting-share-link.schema';
import { LeaderMeetingRepository } from '@/modules/leader-meetings/leader-meeting.repository';
import { LeaderMeetingShareLinkRepository } from '@/modules/leader-meetings/leader-meeting-share-link.repository';
import { LeaderMeetingPeople } from '@/modules/leader-meetings/leader-meeting-people';
import { LeaderMeetingsService } from '@/modules/leader-meetings/leader-meetings.service';
import { LeaderMeetingMinutes } from '@/modules/leader-meetings/leader-meeting-minutes.service';
import { LeaderMeetingSharing } from '@/modules/leader-meetings/leader-meeting-sharing.service';
import { LeaderMeetingsController } from '@/modules/leader-meetings/leader-meetings.controller';
import { LEADER_SCORECARD_PROVIDERS } from '@/modules/leader-meetings/scorecard/scorecard.module';

@Module({
  imports: [
    LoggingModule,
    // Under Jest (which sets NODE_ENV=test) no `.env` is read: a suite is configured by what it sets
    // (test/boot-env.ts), so it runs on a laptop as it runs on CI, where there is no `.env` to read.
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, ignoreEnvFile: process.env.NODE_ENV === 'test' }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGODB_URI'),
        dbName: config.getOrThrow<string>('MONGODB_DB_NAME'),
        // Stated rather than left to Mongoose's default, because two guarantees rest on
        // it: `kpmId` leads every scoped index, and the partial unique index on
        // (kpmId, userId) is what stops one person holding two live memberships. An
        // index that was never built enforces nothing, and the failure is silent.
        //
        // It stays on in production at this size — the collections are small and the
        // cost is a boot-time no-op once built. Revisit when a collection is large
        // enough that a build would block, and move to a migration step then.
        autoIndex: true,
      }),
    }),
    MongooseModule.forFeature([
      { name: AuditLog.name, schema: AuditLogSchema },
      { name: Notification.name, schema: NotificationSchema },
      { name: NotificationPreferences.name, schema: NotificationPreferencesSchema },
      { name: Asset.name, schema: AssetSchema },
      { name: User.name, schema: UserSchema },
      { name: AuthToken.name, schema: AuthTokenSchema },
      { name: ImpersonationSession.name, schema: ImpersonationSessionSchema },
      { name: Company.name, schema: CompanySchema },
      { name: Kpm.name, schema: KpmSchema },
      { name: KpmRequest.name, schema: KpmRequestSchema },
      { name: CompanyOrgLevel.name, schema: CompanyOrgLevelSchema },
      { name: Membership.name, schema: MembershipSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: Policy.name, schema: PolicySchema },
      { name: MonthlyAgentData.name, schema: MonthlyAgentDataSchema },
      { name: ProductionMonth.name, schema: ProductionMonthSchema },
      { name: DataUploadBatch.name, schema: DataUploadBatchSchema },
      { name: DataUploadRow.name, schema: DataUploadRowSchema },
      { name: Goal.name, schema: GoalSchema },
      { name: MembershipHistory.name, schema: MembershipHistorySchema },
      { name: JoinRequest.name, schema: JoinRequestSchema },
      // ADR-0157: a leader past the office's limit, waiting for AgencyBoost.
      { name: LeaderLimitRequest.name, schema: LeaderLimitRequestSchema },
      // P18.96-T3 (ADR-0170): a leader's invites, and the requests to move a member to another leader.
      { name: MemberInvite.name, schema: MemberInviteSchema },
      { name: TransferRequest.name, schema: TransferRequestSchema },
      { name: Group.name, schema: GroupSchema },
      { name: ActivityCategory.name, schema: ActivityCategorySchema },
      { name: ActivityType.name, schema: ActivityTypeSchema },
      { name: LeadStatus.name, schema: LeadStatusSchema },
      { name: RatioDefinition.name, schema: RatioDefinitionSchema },
      { name: ConfigSnapshot.name, schema: ConfigSnapshotSchema },
      // ADR-0163: which activity types each cascade role counts, one row per office.
      { name: ActivityBinding.name, schema: ActivityBindingSchema },
      { name: CompanyTemplate.name, schema: CompanyTemplateSchema },
      // ADR-0115: a company's named templates, each a name over seven kinds of companyTemplates.
      { name: NamedTemplate.name, schema: NamedTemplateSchema },
      { name: TrainingCategory.name, schema: TrainingCategorySchema },
      { name: TrainingSkill.name, schema: TrainingSkillSchema },
      { name: TrainingModule.name, schema: TrainingModuleSchema },
      // P18.5-T1: one member's progress on one training module.
      { name: TrainingProgress.name, schema: TrainingProgressSchema },
      { name: ActivationTemplate.name, schema: ActivationTemplateSchema },
      { name: Product.name, schema: ProductSchema },
      { name: KpmProductConfig.name, schema: KpmProductConfigSchema },
      { name: EventType.name, schema: EventTypeSchema },
      { name: Event.name, schema: EventSchema },
      { name: EventRsvp.name, schema: EventRsvpSchema },
      { name: EventFeedback.name, schema: EventFeedbackSchema },
      { name: ActivityLog.name, schema: ActivityLogSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: QualificationRule.name, schema: QualificationRuleSchema },
      // Phase 18.5: a member's chase of a campaign, and a final standing once its window is final.
      { name: CampaignChase.name, schema: CampaignChaseSchema },
      { name: CampaignStanding.name, schema: CampaignStandingSchema },
      { name: CapabilityCatalog.name, schema: CapabilityCatalogSchema },
      // P11-T5: a 1:1 between a coach and a coachee.
      { name: CoachingSession.name, schema: CoachingSessionSchema },
      // P11-T9: one coachee's capability ticks, and a leader's private note about them.
      { name: CoachingProfile.name, schema: CoachingProfileSchema },
      { name: LeaderNote.name, schema: LeaderNoteSchema },
      // Phase 12: one calendar entry, however many people are on it.
      { name: CalendarEvent.name, schema: CalendarEventSchema },
      // Phase 13: one hire's 90-day activation.
      { name: ActivationProgress.name, schema: ActivationProgressSchema },
      // Phase 17: a company's recruitment playbook, and an office's four pitch documents.
      { name: RecruitmentPlaybook.name, schema: RecruitmentPlaybookSchema },
      { name: RecruitmentPitchSlot.name, schema: RecruitmentPitchSlotSchema },
      // Phase 18: an office's recruitment target, month by month.
      { name: KpmRecruitTarget.name, schema: KpmRecruitTargetSchema },
      // Phase 18.1: the office's leader meetings, and the links that share one read-only.
      { name: LeaderMeeting.name, schema: LeaderMeetingSchema },
      { name: LeaderMeetingShareLink.name, schema: LeaderMeetingShareLinkSchema },
    ]),
  ],
  controllers: [
    SummaryController,
    LeadController,
    GoalController,
    ProductionController,
    HealthController,
    AuthController,
    // UI V1 (UI-111): *Profil saya*'s photo and read-only facts, under `/auth/me`.
    ProfileController,
    AdminController,
    // P13.2-T6: a company's named templates (ADR-0115).
    NamedTemplateController,
    // P13.2-T7: *Save as template*, an office's published settings into a company's template.
    OfficeTemplateController,
    CompanyController,
    OrgController,
    // UI V1 (2026-10-30; UI-081, D-22): a leader saves an agent's WhatsApp number.
    MemberPhoneController,
    // ADR-0157: the Super Admin's queue of leaders past an office's limit.
    LeaderLimitRequestAdminController,
    OnboardingController,
    // P18.96-T3: an invite's link, and the office's transfer requests (ADR-0170 §3, §4).
    InviteLinkController,
    TransferRequestsController,
    NotificationController,
    TenantConfigController,
    TenantConfigReadController,
    // ADR-0163: an office's activity binding — the Super Admin's per office, the Owner's and Admin's read.
    ActivityBindingAdminController,
    ActivityBindingReadController,
    TrainingController,
    // P18.5-T1, T4: the learner's training, and the coach's read of it.
    TrainingProgressController,
    ActivationController,
    ProductController,
    KpmProductController,
    // Phase 14: the field reads of the office's shelf — the Product Catalog and the Sales Attack Plan.
    ProductCatalogController,
    AttackPlanController,
    EventController,
    EventGuestController,
    ActivityController,
    CampaignController,
    MetricRegistryController,
    // Phase 18.5: the agent's campaigns — the list, one campaign with its progress, the chase, whose chases.
    CampaignAgentController,
    CapabilityController,
    CoachingController,
    CoachingProfileController,
    // P11-T10: the print of a finalized session, and the reader's own coaching.
    CoachingRecordController,
    // UI V1 (UI-104): a coachee's tick on an action item, from Calendar.
    CoachingActionDoneController,
    // Phase 12: the calendar.
    CalendarController,
    // Phase 13: the hire's own activation, and a leader's new hires.
    ActivationProgressController,
    /*
     * P18.96-T3: *+ Add agent*, its invites and its transfers, under `/new-hires` — **before** `NewHiresController`, whose
     * `GET /new-hires/:membershipId` would otherwise read `invites` and `transfers` as an id (`app.module.int.spec.ts`).
     */
    NewHireAgentsController,
    NewHiresController,
    // P13.2-T2: the quote tool's price read; it stores nothing (ADR-0111).
    BillingController,
    // Phase 15: a leader's unit, and *Update production*.
    UnitDashboardController,
    // UI V1 (Phase 18.99 T4, UI-001): the Unit Dashboard's Activities tab.
    UnitActivitiesController,
    // UI V1, Phase 18.99 T11 (UI-100, UI-101): Home's one read.
    HomeController,
    // Phase 17: the agents' Recruitment, the office's pitch settings, and the company's playbook.
    RecruitmentController,
    RecruitmentPitchController,
    RecruitmentPlaybookController,
    // Phase 18: the Owner's reporting — the KPM Overview, KPM analytics, and the platform's adoption.
    KpmOverviewController,
    KpmAnalyticsController,
    PlatformAnalyticsController,
    // Phase 18.6: the Owner's compliance tree, the analytics' third tab.
    ComplianceController,
    // Phase 18.1: the Strategic Leader Forum — the meetings, their minutes, and their shared links.
    LeaderMeetingsController,
  ],
  providers: [
    { provide: Clock, useClass: SystemClock },
    {
      provide: TokenSigner,
      inject: [ConfigService, Clock],
      useFactory: (config: ConfigService, clock: Clock) =>
        new Hs256TokenSigner(config.getOrThrow<string>('JWT_ACCESS_SECRET'), clock),
    },
    { provide: TemplateRenderer, useClass: EmailTemplateRenderer },
    { provide: RecipientAddressBook, useClass: UserAddressBook },
    // P18.98-T5 AC-5: whose language an email is written in — the recipient's `users.locale`.
    { provide: RecipientLanguages, useClass: UserLanguages },
    InAppChannelAdapter,
    LogEmailAdapter,
    SmtpChannelAdapter,
    /*
     * How mail actually leaves (P4-T14, ADR-0019).
     *
     * In-app always, because its delivery *is* the row the service writes — without an
     * adapter every in-app send recorded `failed: 'no adapter'` beside a row that had
     * been delivered.
     *
     * Email over SMTP, through the provider `MAIL_PROVIDER` names (P18.99-T18, ADR-0182), or into the
     * log for a developer with no mail catcher. `log`, by either key, is refused in production by
     * `env.validation.ts`, so this factory cannot quietly choose the wrong one there: the process
     * will not have started. An env file with `MAIL_TRANSPORT` alone still chooses as it did.
     */
    {
      provide: NOTIFICATION_ADAPTERS,
      inject: [ConfigService, InAppChannelAdapter, LogEmailAdapter, SmtpChannelAdapter],
      useFactory: (
        config: ConfigService,
        inApp: InAppChannelAdapter,
        log: LogEmailAdapter,
        smtp: SmtpChannelAdapter,
      ) => [
        inApp,
        resolveMailProvider(config).provider === 'log' ? log : smtp,
      ],
    },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    // Order matters: authenticate and resolve the context, then check the permission.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    ActivityCategoryRepository,
    ActivityTypeRepository,
    ActivityConfigService,
    // ADR-0163: the activity binding, and `resolveCascadeBinding`, the one reader every cascade count goes through.
    ActivityBindingRepository,
    ActivityBindingService,
    LeadStatusRepository,
    LeadStatusService,
    RatioDefinitionRepository,
    RatioService,
    ConfigChangeService,
    TrainingCategoryRepository,
    TrainingSkillRepository,
    TrainingModuleRepository,
    TrainingService,
    /*
     * P18.5-T1, T2: each member's progress, what the published snapshot offers, the one read every reader of
     * progress goes through (the activation engine's training kind among them), and the learner's routes.
     */
    TrainingProgressRepository,
    OfferedTraining,
    TrainingProgressReadings,
    TrainingProgressService,
    ActivationTemplateRepository,
    ActivationService,
    ProductService,
    KpmProductConfigRepository,
    KpmProductService,
    ProductCatalogService,
    EventTypeRepository,
    EventRepository,
    EventService,
    EventRsvpRepository,
    EventFeedbackRepository,
    EventAudienceReader,
    EventReadings,
    EventGuestService,
    EventRollCallService,
    ActivityLogRepository,
    ActivityService,
    ActivityReadings,
    // UI V1 (Phase 18.99 T4): the ratios over sets of members — the Ratio page's and the Unit Dashboard's.
    ActivityRatioReadings,
    SummaryService,
    CampaignRepository,
    CampaignService,
    /*
     * Phase 18.5: campaigns, the member's side — the chases and the frozen standings, the one named reader of chases
     * (the Summary, the coachee's chips, the Unit Dashboard), the evaluation through production's and activity's own
     * readings, the agent's service, and the bulk standings port Phase 18.6's tree reads.
     */
    CampaignChaseRepository,
    CampaignStandingRepository,
    CampaignChaseReadings,
    CampaignEvaluation,
    CampaignAgentService,
    CampaignStandingsReader,
    // P18.6-T2: the override of a final standing, behind `PUT`/`DELETE …/standings/:membershipId/override`.
    CampaignStandingOverrides,
    CapabilityCatalogRepository,
    CapabilityService,
    /*
     * The upload registry (P4-T11 AC-1, finished 2026-09-18).
     *
     * It was written in Phase 2 and never registered, so nothing could inject it and no
     * route could exist — a module complete enough to pass its own unit tests and absent
     * from the running application. P5-T2 builds the endpoints on top of it.
     */
    AssetRepository,
    AssetService,
    // P18.7-T2 (ADR-0153, D12): the bucket when `GCS_BUCKET` names one; in development and test without one,
    // storage that refuses with `STORAGE_NOT_CONFIGURED` so the API still boots.
    STORAGE_PROVIDER,
    ConfigSnapshotRepository,
    TenantConfigService,
    TemplateService,
    NamedTemplateService,
    // P13.2-T7: the copies — an office's settings read across tenants by name, and the copy itself.
    OfficeSettingsSource,
    TemplateCopyService,
    { provide: OfficeCounter, useClass: KpmOfficeCounter },
    ProvisioningService,
    { provide: CampaignKindsApplier, useExisting: ProvisioningService },
    AuditService,
    AuditReadService,
    // P11-T3: the §3.5 read audit, one seam every module that reads a member's data calls.
    SubjectReadAudit,
    LeadRepository,
    LeadService,
    LeadReadings,
    GoalRepository,
    GoalService,
    PolicyRepository,
    MonthlyAgentDataRepository,
    ProductionMonthRepository,
    DataUploadBatchRepository,
    DataUploadRowRepository,
    ProductionMonths,
    ProductionService,
    ProductionImportService,
    ProductionCorrections,
    ProductionReadings,
    TenantDay,
    NotificationRepository,
    NotificationService,
    // P18.7-T1: on shutdown, stop listening and finish the open requests, then wait for their email.
    GracefulShutdown,
    PasswordService,
    RateLimiter,
    AuthService,
    ContextResolver,
    ImpersonationService,
    TenantService,
    KpmRequestService,
    OrgLevelService,
    RosterImportService,
    MembershipRepository,
    GroupRepository,
    JoinRequestRepository,
    LeaderLimitRequestRepository,
    MembershipHistoryRepository,
    HierarchyService,
    DirectoryService,
    OnboardingService,
    LeaderCodeService,
    MemberNames,
    ApprovalsService,
    // P18.96-T3 (ADR-0170): + Add agent, the invites it makes, and the transfers it asks for.
    MemberInviteRepository,
    TransferRequestRepository,
    InvitesService,
    TransfersService,
    RoleChangeService,
    MemberPhoneService,
    // UI V1 (UI-111): the profile photo, its signed links, and the profile's read-only facts.
    AvatarService,
    AvatarLinks,
    ProfileService,
    LeaderLimitRequestService,
    RemovalService,
    OrgTreeService,
    // P11-T3: `COACH(actor, subject)`, and every read of a member's data that goes through it.
    CoachResolver,
    // P11-T5 and P11-T6: the sessions, the coaching metrics read over them, and the roster.
    CoachingSessionRepository,
    CoachingReadings,
    PaceStatusReadings,
    CoachingRosterService,
    // P11-T7: the person a coaching page opens on.
    CoacheeService,
    // P11-T5: the session lifecycle, the snapshot finalize takes, and the goal save's session check (P11-T8).
    CoachingSessionService,
    CoachingSnapshotBuilder,
    CoachingSessionGate,
    // P11-T9: the Leader Notes tab — the capability profile and the leader notes.
    CoachingProfileRepository,
    LeaderNoteRepository,
    CoachingProfileService,
    LeaderNoteService,
    // P11-T10: the print, `/coaching/me`'s sessions, and a former coach's (ADR-0077, ADR-0078, ADR-0088).
    CoachingRecordService,
    // Phase 12: the calendar — its entries, the picker and the compare list, its notices, and what
    // leaving does to a member's future entries (D-leave), which `RemovalService` calls through the port.
    CalendarEventRepository,
    CalendarNotices,
    CalendarService,
    // UI V1 (UI-104): lead next actions, open coaching action items and joined events, merged at query time.
    CalendarAutoItems,
    CoachingActionDone,
    CalendarPeopleService,
    CalendarLeave,
    /*
     * P18.5-T7 AC-5: leaving answers two modules — the calendar's future entries and the campaigns' chases — behind the
     * one port `RemovalService` holds.
     */
    CampaignChaseDeparture,
    {
      provide: MemberDeparture,
      inject: [CalendarLeave, CampaignChaseDeparture],
      useFactory: (calendar: CalendarLeave, campaigns: CampaignChaseDeparture) => new MemberDepartures([calendar, campaigns]),
    },
    /*
     * Phase 13: each hire's activation, the engine that completes its linked items, and a leader's new
     * hires — and the three ports through which other modules reach it without depending on it: joining
     * (`ActivationStarter`, org), a goal, lead or day written (`ActivationEvents`), and the session's nav
     * facts (`ActivationNav`, auth).
     */
    ActivationProgressRepository,
    ActivationLinkEngine,
    ActivationProgressService,
    NewHiresService,
    { provide: ActivationStarter, useExisting: ActivationProgressService },
    { provide: ActivationEvents, useExisting: ActivationProgressService },
    { provide: ActivationNav, useExisting: ActivationProgressService },
    /*
     * P18.96-T4 (ADR-0171 §1, §3): each person's first sale, kept on the membership and answered to the leads' and the
     * production file's writes through `SalesEvents`; and a data-backed item's hand tick, saved with its record.
     */
    FirstSaleService,
    { provide: SalesEvents, useExisting: FirstSaleService },
    ActivationItemRecords,
    // P18.96-T6 (ADR-0171 §2, ADR-0173 §3): each new hire's 3M activation, kept once decided, and *Mark left*.
    Activation3MService,
    GroupService,
    // P18.8-T6: the groups and the office on the sidebar's profile line, read with `/auth/me` (ADR-0159 §5).
    ProfileLineReader,
    AdminDelegationService,
    /*
     * Phase 15: the Unit Dashboard — one roster read through the readings the person's own screens use, and
     * a leader's corrections through the month table's own function. No collection of its own.
     */
    UnitDashboardService,
    UnitActivitiesService,
    HomeService,
    /*
     * Phase 17: recruitment tools — the company's playbook (read live, written by the Super Admin, given to a
     * company started from the defaults by `TenantService`), the plan built from it, and an office's pitch.
     */
    RecruitmentPlaybookService,
    RecruitmentPlanService,
    RecruitmentPitchRepository,
    RecruitmentPitchService,
    /*
     * Phase 18: the Owner's reporting — every figure through its owner's readings, the office's people read once,
     * the recruitment target's tenant repository, the campaigns module's one named reader of the carrier rules,
     * and the directory's two columns.
     */
    KpmRecruitTargetRepository,
    OfficePeople,
    CarrierRules,
    KpmOverviewService,
    KpmAnalyticsService,
    PlatformAnalyticsService,
    DirectoryColumns,
    /*
     * Phase 18.6: the Owner's compliance tree — the read, its six categories (each through the module that owns its
     * records), and activation's bulk reader the Activation category reads every hire's activation through.
     */
    ActivationReadings,
    TrainingComplianceCategory,
    GoalsComplianceCategory,
    ActivityComplianceCategory,
    ActivationComplianceCategory,
    EventsComplianceCategory,
    CampaignsComplianceCategory,
    ComplianceService,
    /*
     * Phase 18.1: the Strategic Leader Forum — the meetings' and the links' tenant repositories, who reads and edits
     * (the tag is the list), the meetings, their minutes and their links, and the scorecard computed through Phase 18's
     * readings, live until the meeting and frozen after.
     */
    LeaderMeetingRepository,
    LeaderMeetingShareLinkRepository,
    LeaderMeetingPeople,
    LeaderMeetingsService,
    LeaderMeetingMinutes,
    LeaderMeetingSharing,
    ...LEADER_SCORECARD_PROVIDERS,
  ],
  exports: [Clock, AuditService],
})
export class AppModule {}
