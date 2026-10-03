import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, UpdateQuery } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { ActivationProgress, ActivationProgressDocument } from './activation-progress.schema';

/**
 * Every hire's activation (Phase 13). No escape hatch to the raw model — the repository is the chokepoint
 * that makes forgetting `kpmId` impossible (invariant §1), and soft delete its default filter (§6).
 */
@Injectable()
export class ActivationProgressRepository extends TenantScopedRepository<ActivationProgressDocument> {
  constructor(@InjectModel(ActivationProgress.name) model: Model<ActivationProgressDocument>) {
    super(model, 'activationProgress');
  }

  /**
   * **One write to named items, by code, in one round trip** — the shape a tick and the evaluator take.
   *
   * Each item is addressed with an array filter on its `code` (invariant §4), so two people ticking two
   * items of one hire at once each write their own and neither overwrites the other: there is no
   * read-modify-write of the list. The filter is scoped like every other, and the domain's `version` moves.
   * Answers the activation as it now is, or `null` when the filter matched nothing.
   */
  async updateItems(
    ctx: RequestContext,
    filter: FilterQuery<ActivationProgressDocument>,
    update: UpdateQuery<ActivationProgressDocument>,
    arrayFilters: Record<string, unknown>[] = [],
  ): Promise<ActivationProgressDocument | null> {
    return this.model
      .findOneAndUpdate(
        this.scope(ctx, 'updateItems', filter),
        { ...update, $set: { ...(update.$set ?? {}), updatedBy: ctx.membershipId }, $inc: { version: 1 } },
        { new: true, ...(arrayFilters.length > 0 ? { arrayFilters } : {}) },
      )
      .exec();
  }
}
