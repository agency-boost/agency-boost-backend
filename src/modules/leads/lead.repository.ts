import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, UpdateQuery } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { Lead, LeadDocument } from './lead.schema';

/**
 * Every lead, through the chokepoint (invariant §1).
 *
 * **There is no unscoped method here, and there should be less of one than anywhere else.** Leads
 * carry a third party's name and contact details, typed by an agent about somebody who never
 * interacted with the platform — so even the Super Admin's ordinary escape hatch is wrong here:
 * §3.7 gives the platform and the office's admins **counts, not rows**, and a method that could
 * return rows across tenants would be the first thing somebody reached for when asked a question
 * counts could have answered.
 */
@Injectable()
export class LeadRepository extends TenantScopedRepository<LeadDocument> {
  constructor(@InjectModel(Lead.name) model: Model<LeadDocument>) {
    super(model, 'leads');
  }

  /**
   * **Update a lead only if it is still at `version`** — the check and the write in one operation
   * (P11-T4 AC-3).
   *
   * The service compares the pinned version with the row it read, and then writes. Between the two, a
   * second writer — the agent on a phone and the leader on a laptop in one 1-on-1 — could land, and a
   * write filtered on `_id` alone would overwrite what they did. With the version in the filter the
   * write finds nothing instead, and `null` lets the service answer `VERSION_CONFLICT`. Scoped like
   * every other write here: the tenant is injected into the filter, and `updatedBy` is the caller.
   */
  async updateAtVersion(
    ctx: RequestContext, id: string, version: number, update: UpdateQuery<LeadDocument>,
  ): Promise<LeadDocument | null> {
    return this.model
      .findOneAndUpdate(
        this.scope(ctx, 'updateAtVersion', { _id: id, version } as FilterQuery<LeadDocument>),
        { ...update, $set: { ...(update.$set ?? {}), updatedBy: ctx.membershipId } },
        { new: true },
      )
      .exec();
  }
}
