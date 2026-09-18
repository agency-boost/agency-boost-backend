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
import { AuditService } from '@/modules/audit/audit.service';
import {
  Notification, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from '@/modules/notifications/notification.schema';
import {
  NOTIFICATION_ADAPTERS, NotificationService, TemplateRenderer,
} from '@/modules/notifications/notification.service';
import { NotificationController } from '@/modules/notifications/notification.controller';
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
import { Product, ProductSchema } from '@/modules/products/product.schema';
import { ProductService } from '@/modules/products/product.service';
import { ProductController } from '@/modules/products/product.controller';
import {
  KpmProductConfig, KpmProductConfigSchema,
} from '@/modules/products/kpm-product-config.schema';
import { KpmProductConfigRepository } from '@/modules/products/kpm-product.repository';
import { KpmProductService } from '@/modules/products/kpm-product.service';
import { KpmProductController } from '@/modules/products/kpm-product.controller';
import { Event, EventSchema, EventType, EventTypeSchema } from '@/modules/events/event.schema';
import { EventRepository, EventTypeRepository } from '@/modules/events/event.repository';
import { EventService } from '@/modules/events/event.service';
import { EventController } from '@/modules/events/event.controller';
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
import { ApprovalsService } from '@/modules/org/approvals.service';
import { Group, GroupSchema } from '@/modules/org/group.schema';
import { AdminDelegationService } from '@/modules/org/admin-delegation.service';
import { GroupService } from '@/modules/org/group.service';
import { OrgTreeService } from '@/modules/org/org-tree.service';
import { RemovalService } from '@/modules/org/removal.service';
import { RoleChangeService } from '@/modules/org/role-change.service';

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
      { name: MembershipHistory.name, schema: MembershipHistorySchema },
      { name: JoinRequest.name, schema: JoinRequestSchema },
      { name: Group.name, schema: GroupSchema },
      { name: ActivityCategory.name, schema: ActivityCategorySchema },
      { name: ActivityType.name, schema: ActivityTypeSchema },
      { name: LeadStatus.name, schema: LeadStatusSchema },
      { name: RatioDefinition.name, schema: RatioDefinitionSchema },
      { name: ConfigSnapshot.name, schema: ConfigSnapshotSchema },
      { name: CompanyTemplate.name, schema: CompanyTemplateSchema },
      { name: TrainingCategory.name, schema: TrainingCategorySchema },
      { name: TrainingSkill.name, schema: TrainingSkillSchema },
      { name: TrainingModule.name, schema: TrainingModuleSchema },
      { name: ActivationTemplate.name, schema: ActivationTemplateSchema },
      { name: Product.name, schema: ProductSchema },
      { name: KpmProductConfig.name, schema: KpmProductConfigSchema },
      { name: EventType.name, schema: EventTypeSchema },
      { name: Event.name, schema: EventSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: QualificationRule.name, schema: QualificationRuleSchema },
      { name: CapabilityCatalog.name, schema: CapabilityCatalogSchema },
    ]),
  ],
  controllers: [
    HealthController,
    AuthController,
    AdminController,
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
    EventController,
    CampaignController,
    MetricRegistryController,
    CapabilityController,
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
    EventTypeRepository,
    EventRepository,
    EventService,
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
    { provide: OfficeCounter, useClass: KpmOfficeCounter },
    ProvisioningService,
    { provide: CampaignKindsApplier, useExisting: ProvisioningService },
    AuditService,
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
    ApprovalsService,
    RoleChangeService,
    RemovalService,
    OrgTreeService,
    GroupService,
    AdminDelegationService,
  ],
  exports: [Clock, AuditService],
})
export class AppModule {}
