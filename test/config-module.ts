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
  CompanyTemplate, CompanyTemplateSchema,
} from '@/modules/config/company-template.schema';
import {
  ActivityCategoryRepository, ActivityTypeRepository, ConfigSnapshotRepository,
  LeadStatusRepository, RatioDefinitionRepository,
} from '@/modules/config/activity.repository';
import { ActivityConfigService } from '@/modules/config/activity.service';
import { LeadStatusService } from '@/modules/config/lead-status.service';
import { RatioService } from '@/modules/config/ratio.service';
import { TenantConfigService } from '@/modules/config/tenant-config.service';
import { ConfigChangeService } from '@/modules/config/changes.service';
import { ProvisioningService } from '@/modules/config/provisioning.service';
import {
  TrainingCategory, TrainingCategorySchema,
} from '@/modules/training/training-category.schema';
import { TrainingSkill, TrainingSkillSchema } from '@/modules/training/training-skill.schema';
import { TrainingModule, TrainingModuleSchema } from '@/modules/training/training-module.schema';
import {
  TrainingCategoryRepository, TrainingModuleRepository, TrainingSkillRepository,
} from '@/modules/training/training.repository';
import { TrainingService } from '@/modules/training/training.service';
import { KpmSchema } from '@/modules/tenants/kpm.schema';
import { CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';

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
  const templates = model('CompanyTemplateModel', CompanyTemplateSchema);
  const trainingCategories = model('TrainingCategoryModel', TrainingCategorySchema);
  const trainingSkills = model('TrainingSkillModel', TrainingSkillSchema);
  const trainingModules = model('TrainingModuleModel', TrainingModuleSchema);

  const clock: Clock = new FixedClock(now);
  const audit = new AuditService(model('AuditLogModel', AuditLogSchema) as never);

  const leads = new LeadStatusService(
    new LeadStatusRepository(leadStatuses as never), audit, clock,
  );
  const kpms = model('KpmModelForConfig', KpmSchema);
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
  );
  const ratios = new RatioService(
    new RatioDefinitionRepository(ratioDefinitions as never), activity, orgLevels, audit, clock,
  );
  // P5-T1. Before `config`, which renders what agents are offered from it.
  const training = new TrainingService(
    new TrainingCategoryRepository(trainingCategories as never),
    new TrainingSkillRepository(trainingSkills as never),
    new TrainingModuleRepository(trainingModules as never),
    audit,
    clock,
  );
  const config = new TenantConfigService(
    activity, ratios, leads,
    new ConfigSnapshotRepository(snapshots as never),
    audit, clock,
    orgLevels,
    training,
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
    clock,
    config,
  );

  // `orgLevels` and `kpms` are exposed since P4-T15: a ratio's applicability validates
  // against the company's ladder, so a spec exercising it has to be able to publish one.
  const changes = new ConfigChangeService(activity, ratios, config, orgLevels, training);

  return {
    activity, ratios, leads, config, provisioning, templates, audit, clock, changes,
    orgLevels, kpms, companies: model('CompanyModelForConfig', CompanySchema), training,
  };
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
  await module.provisioning.seedTrainingTaxonomy(kpmId, companyId);
  return seeded;
}

export {
  ActivityCategory, ActivityCategorySchema, ActivityType, ActivityTypeSchema,
  ConfigSnapshot, ConfigSnapshotSchema, LeadStatus, LeadStatusSchema,
  CompanyTemplate, CompanyTemplateSchema, RatioDefinition, RatioDefinitionSchema,
  AuditLog, AuditLogSchema,
  TrainingCategory, TrainingCategorySchema, TrainingSkill, TrainingSkillSchema,
  TrainingModule, TrainingModuleSchema,
};
