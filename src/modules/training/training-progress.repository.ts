import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, UpdateQuery } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { TrainingProgress, TrainingProgressDocument } from './training-progress.schema';

/**
 * Every member's training progress (P18.5-T1). No escape hatch to the raw model — the repository is the
 * chokepoint that makes forgetting `kpmId` impossible (invariant §1), and soft delete its default filter (§6).
 */
@Injectable()
export class TrainingProgressRepository extends TenantScopedRepository<TrainingProgressDocument> {
  constructor(@InjectModel(TrainingProgress.name) model: Model<TrainingProgressDocument>) {
    super(model, 'trainingProgress');
  }

  /**
   * **One conditional write, in one round trip**: the row the filter matches, updated, with the domain's
   * `version` moved — or `null` when the filter matched nothing (a concurrent write changed what it tested).
   * Scoped like every other, so a filter can never reach another office's row.
   */
  async updateWhere(
    ctx: RequestContext,
    filter: FilterQuery<TrainingProgressDocument>,
    update: UpdateQuery<TrainingProgressDocument>,
  ): Promise<TrainingProgressDocument | null> {
    return this.model
      .findOneAndUpdate(
        this.scope(ctx, 'updateWhere', filter),
        { ...update, $set: { ...(update.$set ?? {}), updatedBy: ctx.membershipId }, $inc: { version: 1 } },
        { new: true },
      )
      .exec();
  }
}
