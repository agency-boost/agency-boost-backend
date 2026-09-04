import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_FILTER } from '@nestjs/core';

import { validateEnv } from '@/config/env.validation';
import { LoggingModule } from '@/common/logging/logging.module';
import { Clock, SystemClock } from '@/common/clock/clock.port';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { HealthController } from '@/modules/health/health.controller';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import {
  Notification, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from '@/modules/notifications/notification.schema';
import { Asset, AssetSchema } from '@/modules/assets/asset.schema';

@Module({
  imports: [
    LoggingModule,
    ConfigModule.forRoot({
      isGlobal: true,
      // Boot fails loudly on a missing or malformed key rather than starting and
      // connecting somewhere unexpected.
      validate: validateEnv,
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGODB_URI'),
        dbName: config.getOrThrow<string>('MONGODB_DB_NAME'),
      }),
    }),
    MongooseModule.forFeature([
      { name: AuditLog.name, schema: AuditLogSchema },
      { name: Notification.name, schema: NotificationSchema },
      { name: NotificationPreferences.name, schema: NotificationPreferencesSchema },
      { name: Asset.name, schema: AssetSchema },
    ]),
  ],
  controllers: [HealthController],
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    AuditService,
  ],
  exports: [Clock, AuditService],
})
export class AppModule {}
