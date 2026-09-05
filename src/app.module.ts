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
import { ConsoleTemplateRenderer } from '@/modules/notifications/console-renderer';
import { Asset, AssetSchema } from '@/modules/assets/asset.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { AuthToken, AuthTokenSchema } from '@/modules/auth/auth-token.schema';
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
import { AdminController } from '@/modules/tenants/admin.controller';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import {
  MembershipHistory, MembershipHistorySchema,
} from '@/modules/org/membership-history.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { DirectoryService } from '@/modules/org/directory.service';
import { OrgController } from '@/modules/org/org.controller';
import { JoinRequest, JoinRequestSchema } from '@/modules/org/join-request.schema';
import { OnboardingService } from '@/modules/org/onboarding.service';
import { OnboardingController } from '@/modules/org/onboarding.controller';
import { InviteCode, InviteCodeSchema } from '@/modules/org/invite-code.schema';
import { InviteService } from '@/modules/org/invite.service';

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
      { name: Company.name, schema: CompanySchema },
      { name: Kpm.name, schema: KpmSchema },
      { name: Membership.name, schema: MembershipSchema },
      { name: MembershipHistory.name, schema: MembershipHistorySchema },
      { name: JoinRequest.name, schema: JoinRequestSchema },
      { name: InviteCode.name, schema: InviteCodeSchema },
    ]),
  ],
  controllers: [HealthController, AuthController, AdminController, OrgController, OnboardingController],
  providers: [
    { provide: Clock, useClass: SystemClock },
    {
      provide: TokenSigner,
      inject: [ConfigService, Clock],
      useFactory: (config: ConfigService, clock: Clock) =>
        new Hs256TokenSigner(config.getOrThrow<string>('JWT_ACCESS_SECRET'), clock),
    },
    { provide: TemplateRenderer, useClass: ConsoleTemplateRenderer },
    // No channel adapters wired yet: notifications are rendered to the log in
    // development (ConsoleTemplateRenderer) and the email adapter lands with SMTP.
    { provide: NOTIFICATION_ADAPTERS, useValue: [] },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    // Order matters: authenticate and resolve the context, then check the permission.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    AuditService,
    NotificationService,
    PasswordService,
    RateLimiter,
    AuthService,
    ContextResolver,
    ImpersonationService,
    TenantService,
    MembershipRepository,
    HierarchyService,
    DirectoryService,
    OnboardingService,
    InviteService,
  ],
  exports: [Clock, AuditService],
})
export class AppModule {}
