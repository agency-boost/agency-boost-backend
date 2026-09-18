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
import {
  ActivationTemplate, ActivationTemplateSchema,
} from '@/modules/activation/activation-template.schema';
import { ActivationTemplateRepository } from '@/modules/activation/activation.repository';
import { ActivationService } from '@/modules/activation/activation.service';
import { ProductSchema } from '@/modules/products/product.schema';
import { KpmProductConfigSchema } from '@/modules/products/kpm-product-config.schema';
import { KpmProductConfigRepository } from '@/modules/products/kpm-product.repository';
import { KpmProductService } from '@/modules/products/kpm-product.service';
import { Event, EventSchema, EventType, EventTypeSchema } from '@/modules/events/event.schema';
import { EventRepository, EventTypeRepository } from '@/modules/events/event.repository';
import { EventService } from '@/modules/events/event.service';
import {
  Campaign, CampaignSchema, QualificationRule, QualificationRuleSchema,
} from '@/modules/campaigns/campaign.schema';
import { CampaignRepository } from '@/modules/campaigns/campaign.repository';
import { CampaignService } from '@/modules/campaigns/campaign.service';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { AssetSchema } from '@/modules/assets/asset.schema';
import { AssetRepository } from '@/modules/assets/asset.repository';
import { AssetService } from '@/modules/assets/asset.service';
import { StubStorage } from './stub-storage';
import { ProductService } from '@/modules/products/product.service';
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
  const activationTemplates = model('ActivationTemplateModel', ActivationTemplateSchema);
  const productRows = model('ProductModel', ProductSchema);

  const clock: Clock = new FixedClock(now);
  const storage = new StubStorage();
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
  const config = new TenantConfigService(
    activity, ratios, leads,
    new ConfigSnapshotRepository(snapshots as never),
    audit, clock,
    orgLevels,
    training,
  );
  // P5-T3. After `training`, whose modules its links are checked against.
  const activation = new ActivationService(
    new ActivationTemplateRepository(activationTemplates as never),
    training,
    kpms as never,
    audit,
    clock,
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
  );
  // P5-T6: the events an office runs. Nothing per-person lives here.
  const events = new EventService(
    new EventTypeRepository(model(EventType.name, EventTypeSchema) as never),
    new EventRepository(model(Event.name, EventSchema) as never),
    new MembershipRepository(model(Membership.name, MembershipSchema) as never),
    audit,
    clock,
  );
  // P5-T7: the office's campaigns, and the carrier rules it is measured against.
  const campaigns = new CampaignService(
    new CampaignRepository(model(Campaign.name, CampaignSchema) as never),
    model(QualificationRule.name, QualificationRuleSchema) as never,
    kpms as never,
    audit,
    clock,
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
    clock,
    config,
  );

  // `orgLevels` and `kpms` are exposed since P4-T15: a ratio's applicability validates
  // against the company's ladder, so a spec exercising it has to be able to publish one.
  const changes = new ConfigChangeService(activity, ratios, config, orgLevels, training);

  return {
    activity, ratios, leads, config, provisioning, templates, audit, clock, changes,
    orgLevels, kpms, companies: model('CompanyModelForConfig', CompanySchema), training, activation,
    products, assets, storage, kpmProducts, events, campaigns,
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
  const training = await module.provisioning.seedTrainingTaxonomy(kpmId, companyId);
  await module.provisioning.seedActivationChecklist(kpmId, companyId, training.publishedModuleCodes);
  await module.provisioning.seedEventTypes(kpmId);
  return seeded;
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
