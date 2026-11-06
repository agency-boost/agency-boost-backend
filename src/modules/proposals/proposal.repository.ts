import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, QueryOptions } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { Proposal, ProposalDocument } from './proposal.schema';

/**
 * **Every proposal, through the chokepoint** (invariant §1; ADR-0221 §1). The tenant is injected into every filter and
 * every write, and soft-deleted rows are left out unless a method says otherwise.
 *
 * **No unscoped method, and none should be added.** A proposal names a third party and what was offered them at what
 * premium; it is read by its owner alone, and nobody's count needs a row from another office.
 */
@Injectable()
export class ProposalRepository extends TenantScopedRepository<ProposalDocument> {
  constructor(@InjectModel(Proposal.name) model: Model<ProposalDocument>) {
    super(model, 'proposals');
  }

  /**
   * **Write one of an owner's live proposals only if it is still at `version`** — the check and the write in one
   * operation, with the version moved on and the writer named. `null` when it moved, went, or was never theirs; the
   * service tells the three apart (ADR-0221 §3).
   */
  async writeAt(
    ctx: RequestContext, id: string, ownerMembershipId: string, version: number, set: Record<string, unknown>,
  ): Promise<ProposalDocument | null> {
    return this.model
      .findOneAndUpdate(
        this.scope(ctx, 'writeAt', { _id: id, ownerMembershipId, version } as FilterQuery<ProposalDocument>),
        { $set: { ...set, updatedBy: ctx.membershipId }, $inc: { version: 1 } },
        { new: true },
      )
      .exec();
  }

  /**
   * **One owner's proposals of one lead that were ever finished, deleted ones included** — the lead's *Riwayat* keeps the
   * note *"Proposal dibuat · …"* when its proposal is deleted, without the link (ADR-0221 §6). The one read here that
   * sees a deleted row, and only its date, its names and whether it is gone.
   */
  async finishedOfLead(ctx: RequestContext, ownerMembershipId: string, leadId: string): Promise<ProposalDocument[]> {
    return this.model
      .find(
        this.scope(ctx, 'finishedOfLead', { ownerMembershipId, leadId, firstDoneAt: { $ne: null } } as FilterQuery<ProposalDocument>, true),
        { firstDoneAt: 1, firstDoneProducts: 1, deletedAt: 1 },
        { sort: { firstDoneAt: 1, _id: 1 } } as QueryOptions<ProposalDocument>,
      )
      .exec();
  }
}
