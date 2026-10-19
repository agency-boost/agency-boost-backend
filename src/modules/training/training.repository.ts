import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { TrainingCategory, TrainingCategoryDocument } from './training-category.schema';
import { TrainingSkill, TrainingSkillDocument } from './training-skill.schema';
import { TrainingModule, TrainingModuleDocument } from './training-module.schema';

/**
 * The office's training taxonomy (P5-T1). No escape hatch to the raw models — the
 * repositories are the chokepoint that makes forgetting `kpmId` impossible (invariant §1).
 */
@Injectable()
export class TrainingCategoryRepository extends TenantScopedRepository<TrainingCategoryDocument> {
  constructor(@InjectModel(TrainingCategory.name) model: Model<TrainingCategoryDocument>) {
    super(model, 'trainingCategories');
  }
}

@Injectable()
export class TrainingSkillRepository extends TenantScopedRepository<TrainingSkillDocument> {
  constructor(@InjectModel(TrainingSkill.name) model: Model<TrainingSkillDocument>) {
    super(model, 'trainingSkills');
  }
}

@Injectable()
export class TrainingModuleRepository extends TenantScopedRepository<TrainingModuleDocument> {
  constructor(@InjectModel(TrainingModule.name) model: Model<TrainingModuleDocument>) {
    super(model, 'trainingModules');
  }
}
