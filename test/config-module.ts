import mongoose from 'mongoose';
import { Clock, FixedClock } from '@/common/clock/clock.port';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
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
  PlatformTemplate, PlatformTemplateSchema,
} from '@/modules/config/platform-template.schema';
import {
  ActivityCategoryRepository, ActivityTypeRepository, ConfigSnapshotRepository,
  LeadStatusRepository, RatioDefinitionRepository,
} from '@/modules/config/activity.repository';
import { ActivityConfigService } from '@/modules/config/activity.service';
import { LeadStatusService } from '@/modules/config/lead-status.service';
import { RatioService } from '@/modules/config/ratio.service';
import { TenantConfigService } from '@/modules/config/tenant-config.service';
import { ProvisioningService } from '@/modules/config/provisioning.service';

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
export function configModule(now: Date) {
  const model = <T>(name: string, schema: unknown) =>
    mongoose.model(name, schema as never) as unknown as T;

  const categories = model('ActivityCategoryModel', ActivityCategorySchema);
  const types = model('ActivityTypeModel', ActivityTypeSchema);
  const leadStatuses = model('LeadStatusModel', LeadStatusSchema);
  const ratioDefinitions = model('RatioDefinitionModel', RatioDefinitionSchema);
  const snapshots = model('ConfigSnapshotModel', ConfigSnapshotSchema);
  const templates = model('PlatformTemplateModel', PlatformTemplateSchema);

  const clock: Clock = new FixedClock(now);
  const audit = new AuditService(model('AuditLogModel', AuditLogSchema) as never);

  const activity = new ActivityConfigService(
    new ActivityCategoryRepository(categories as never),
    new ActivityTypeRepository(types as never),
    audit,
    clock,
  );
  const ratios = new RatioService(
    new RatioDefinitionRepository(ratioDefinitions as never), activity, audit, clock,
  );
  const leads = new LeadStatusService(
    new LeadStatusRepository(leadStatuses as never), audit, clock,
  );
  const config = new TenantConfigService(
    activity, ratios, leads,
    new ConfigSnapshotRepository(snapshots as never),
    audit, clock,
  );
  const provisioning = new ProvisioningService(
    categories as never,
    types as never,
    leadStatuses as never,
    ratioDefinitions as never,
    snapshots as never,
    templates as never,
    clock,
    config,
  );

  return { activity, ratios, leads, config, provisioning, templates, audit, clock };
}

/** Copy a whole configuration into an office, the way creating one does. */
export async function provisionOffice(
  module: ReturnType<typeof configModule>,
  kpmId: string,
  companyId: string,
) {
  const seeded = await module.provisioning.seedActivityTaxonomy(kpmId, companyId);
  await module.provisioning.seedLeadPipelines(kpmId, companyId);
  await module.provisioning.seedRatioDefinitions(kpmId, companyId, seeded.typeCodes);
  return seeded;
}

export {
  ActivityCategory, ActivityCategorySchema, ActivityType, ActivityTypeSchema,
  ConfigSnapshot, ConfigSnapshotSchema, LeadStatus, LeadStatusSchema,
  PlatformTemplate, PlatformTemplateSchema, RatioDefinition, RatioDefinitionSchema,
  AuditLog, AuditLogSchema,
};
