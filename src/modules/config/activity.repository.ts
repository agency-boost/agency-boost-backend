import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { ActivityCategory, ActivityCategoryDocument } from './activity-category.schema';
import { ActivityType, ActivityTypeDocument } from './activity-type.schema';
import { LeadStatus, LeadStatusDocument } from './lead-status.schema';
import { RatioDefinition, RatioDefinitionDocument } from './ratio-definition.schema';

/**
 * The office's activity categories. No escape hatch to the raw model, by design — the
 * repository is the chokepoint that makes forgetting `kpmId` impossible (invariant §1).
 */
@Injectable()
export class ActivityCategoryRepository
  extends TenantScopedRepository<ActivityCategoryDocument> {
  constructor(@InjectModel(ActivityCategory.name) model: Model<ActivityCategoryDocument>) {
    super(model, 'activityCategories');
  }
}

/** The office's activity types. */
@Injectable()
export class ActivityTypeRepository extends TenantScopedRepository<ActivityTypeDocument> {
  constructor(@InjectModel(ActivityType.name) model: Model<ActivityTypeDocument>) {
    super(model, 'activityTypes');
  }
}

/** The office's lead pipelines. */
@Injectable()
export class LeadStatusRepository extends TenantScopedRepository<LeadStatusDocument> {
  constructor(@InjectModel(LeadStatus.name) model: Model<LeadStatusDocument>) {
    super(model, 'leadStatuses');
  }
}

/** The office's ratio definitions. */
@Injectable()
export class RatioDefinitionRepository extends TenantScopedRepository<RatioDefinitionDocument> {
  constructor(@InjectModel(RatioDefinition.name) model: Model<RatioDefinitionDocument>) {
    super(model, 'ratioDefinitions');
  }
}
