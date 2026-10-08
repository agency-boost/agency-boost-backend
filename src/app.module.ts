import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { validateEnv } from '@/config/env.validation';
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
import { InAppChannelAdapter, LogEmailAdapter } from '@/modules/notifications/local-adapters';
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
import { EventRepository, EventTypeRepository } from '@/modules/events/event.repository';
import { EventService } from '@/modules/events/event.service';
import { EventController } from '@/modules/events/event.controller';
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
import { StoragePort } from '@/modules/assets/storage.port';
import { CloudinaryAdapter } from '@/modules/assets/cloudinary.adapter';
import { User, UserSchema } from '@/modules/users/user.schema';
import { AuthToken, AuthTokenSchema } from '@/modules/auth/auth-token.schema';
import {
  ImpersonationSession, ImpersonationSessionSchema,
} from '@/modules/auth/impersonation-session.schema';
import { AuthService } from '@/modules/auth/auth.service';
import { AuthController } from '@/modules/auth/auth.controller';
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
import {
  GroupRepository, JoinRequestRepository, MembershipHistoryRepository,
} from '@/modules/org/org.repositories';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { DirectoryService } from '@/modules/org/directory.service';
import { OrgController } from '@/modules/org/org.controller';
import { JoinRequest, JoinRequestSchema } from '@/modules/org/join-request.schema';
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
import { MemberDeparture } from '@/modules/org/member-departure.port';
import { CalendarEvent, CalendarEventSchema } from '@/modules/calendar/calendar-event.schema';
import { CalendarEventRepository } from '@/modules/calendar/calendar-event.repository';
import { CalendarNotices } from '@/modules/calendar/calendar-notices';
import { CalendarService } from '@/modules/calendar/calendar.service';
import { CalendarPeopleService } from '@/modules/calendar/calendar-people.service';
import { CalendarLeave } from '@/modules/calendar/calendar-leave';
import { CalendarController } from '@/modules/calendar/calendar.controller';
import { RoleChangeService } from '@/modules/org/role-change.service';
import { UnitDashboardController } from '@/modules/unit-dashboard/unit-dashboard.controller';
import { UnitDashboardService } from '@/modules/unit-dashboard/unit-dashboard.service';

@Module({
  imports: [
    LoggingModule,
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
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
      { name: Group.name, schema: GroupSchema },
      { name: ActivityCategory.name, schema: ActivityCategorySchema },
      { name: ActivityType.name, schema: ActivityTypeSchema },
      { name: LeadStatus.name, schema: LeadStatusSchema },
      { name: RatioDefinition.name, schema: RatioDefinitionSchema },
      { name: ConfigSnapshot.name, schema: ConfigSnapshotSchema },
      { name: CompanyTemplate.name, schema: CompanyTemplateSchema },
      // ADR-0115: a company's named templates, each a name over seven kinds of companyTemplates.
      { name: NamedTemplate.name, schema: NamedTemplateSchema },
      { name: TrainingCategory.name, schema: TrainingCategorySchema },
      { name: TrainingSkill.name, schema: TrainingSkillSchema },
      { name: TrainingModule.name, schema: TrainingModuleSchema },
      { name: ActivationTemplate.name, schema: ActivationTemplateSchema },
      { name: Product.name, schema: ProductSchema },
      { name: KpmProductConfig.name, schema: KpmProductConfigSchema },
      { name: EventType.name, schema: EventTypeSchema },
      { name: Event.name, schema: EventSchema },
      { name: ActivityLog.name, schema: ActivityLogSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: QualificationRule.name, schema: QualificationRuleSchema },
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
    ]),
  ],
  controllers: [
    SummaryController,
    LeadController,
    GoalController,
    ProductionController,
    HealthController,
    AuthController,
    AdminController,
    // P13.2-T6: a company's named templates (ADR-0115).
    NamedTemplateController,
    // P13.2-T7: *Save as template*, an office's published settings into a company's template.
    OfficeTemplateController,
    CompanyController,
    OrgController,
    OnboardingController,
    NotificationController,
    TenantConfigController,
    TenantConfigReadController,
    TrainingController,
    ActivationController,
    ProductController,
    KpmProductController,
    // Phase 14: the field reads of the office's shelf — the Product Catalog and the Sales Attack Plan.
    ProductCatalogController,
    AttackPlanController,
    EventController,
    ActivityController,
    CampaignController,
    MetricRegistryController,
    CapabilityController,
    CoachingController,
    CoachingProfileController,
    // P11-T10: the print of a finalized session, and the reader's own coaching.
    CoachingRecordController,
    // Phase 12: the calendar.
    CalendarController,
    // Phase 13: the hire's own activation, and a leader's new hires.
    ActivationProgressController,
    NewHiresController,
    // P13.2-T2: the quote tool's price read; it stores nothing (ADR-0111).
    BillingController,
    // Phase 15: a leader's unit, and *Update production*.
    UnitDashboardController,
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
     * Email over SMTP, or into the log for a developer with no mail catcher.
     * `MAIL_TRANSPORT=log` is refused in production by `env.validation.ts`, so this
     * factory cannot quietly choose the wrong one there: the process will not have
     * started.
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
        config.get<string>('MAIL_TRANSPORT') === 'log' ? log : smtp,
      ],
    },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    // Order matters: authenticate and resolve the context, then check the permission.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    ActivityCategoryRepository,
    ActivityTypeRepository,
    ActivityConfigService,
    LeadStatusRepository,
    LeadStatusService,
    RatioDefinitionRepository,
    RatioService,
    ConfigChangeService,
    TrainingCategoryRepository,
    TrainingSkillRepository,
    TrainingModuleRepository,
    TrainingService,
    ActivationTemplateRepository,
    ActivationService,
    ProductService,
    KpmProductConfigRepository,
    KpmProductService,
    ProductCatalogService,
    EventTypeRepository,
    EventRepository,
    EventService,
    ActivityLogRepository,
    ActivityService,
    ActivityReadings,
    SummaryService,
    CampaignRepository,
    CampaignService,
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
    { provide: StoragePort, useClass: CloudinaryAdapter },
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
    MembershipHistoryRepository,
    HierarchyService,
    DirectoryService,
    OnboardingService,
    LeaderCodeService,
    MemberNames,
    ApprovalsService,
    RoleChangeService,
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
    CalendarPeopleService,
    CalendarLeave,
    { provide: MemberDeparture, useExisting: CalendarLeave },
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
    GroupService,
    AdminDelegationService,
    /*
     * Phase 15: the Unit Dashboard — one roster read through the readings the person's own screens use, and
     * a leader's corrections through the month table's own function. No collection of its own.
     */
    UnitDashboardService,
  ],
  exports: [Clock, AuditService],
})
export class AppModule {}
