import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { Goal, GoalDocument } from './goal.schema';

/**
 * One agent's agreed plan for one period (P8-T1).
 *
 * Adds nothing to the base class. Every read and write goes through it with `kpmId` injected from
 * the request context, and there is no escape hatch to the raw model — a goal is per-person data
 * inside one office, and no reader of it is cross-tenant.
 */
@Injectable()
export class GoalRepository extends TenantScopedRepository<GoalDocument> {
  constructor(@InjectModel(Goal.name) model: Model<GoalDocument>) {
    super(model, 'goals');
  }
}
