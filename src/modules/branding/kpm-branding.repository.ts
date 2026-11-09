import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { KpmBranding, KpmBrandingDocument } from './kpm-branding.schema';


/**
 * **A KPM's branding, through the chokepoint** (invariant §1; ADR-0218 §1). The tenant is injected into every filter and
 * every write. The public sign-in read and the files route read through it too, with a context naming the KPM of the
 * link (`RequestContext.tenantRead`) — never an absent filter.
 */
@Injectable()
export class KpmBrandingRepository extends TenantScopedRepository<KpmBrandingDocument> {
  constructor(@InjectModel(KpmBranding.name) model: Model<KpmBrandingDocument>) {
    super(model, 'kpmBranding');
  }

  /** The KPM's live row, or `null`. */
  async live(ctx: RequestContext): Promise<KpmBrandingDocument | null> {
    return this.model.findOne(this.scope(ctx, 'live')).sort({ createdAt: -1 }).exec();
  }

  /** **Write the live row only if it is still at `version`**: the check and the write in one operation. */
  async writeAt(ctx: RequestContext, id: string, version: number, set: Record<string, unknown>): Promise<KpmBrandingDocument | null> {
    return this.model
      .findOneAndUpdate(
        this.scope(ctx, 'writeAt', { _id: id, version } as FilterQuery<KpmBrandingDocument>),
        { $set: { ...set, updatedBy: ctx.membershipId }, $inc: { version: 1 } },
        { new: true },
      )
      .exec();
  }

  /** **The first row**, at version 1. */
  async insert(ctx: RequestContext, fields: Record<string, unknown>): Promise<KpmBrandingDocument> {
    return this.create(ctx, { ...fields, version: 1, updatedBy: ctx.membershipId } as Partial<KpmBrandingDocument>);
  }

  /** ***Kembalikan ke default***: the live row soft-deleted (invariant §6), only if it is still at `version`. */
  async softDeleteAt(ctx: RequestContext, id: string, version: number, at: Date): Promise<KpmBrandingDocument | null> {
    return this.model
      .findOneAndUpdate(
        this.scope(ctx, 'softDeleteAt', { _id: id, version } as FilterQuery<KpmBrandingDocument>),
        { $set: { deletedAt: at, deletedBy: ctx.membershipId }, $inc: { version: 1 } },
        { new: true },
      )
      .exec();
  }
}
