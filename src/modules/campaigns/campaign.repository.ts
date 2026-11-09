import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { Campaign, CampaignDocument } from './campaign.schema';

/** An office's own campaigns. Through the chokepoint, like every tenant-scoped collection. */
@Injectable()
export class CampaignRepository extends TenantScopedRepository<CampaignDocument> {
  constructor(@InjectModel(Campaign.name) model: Model<CampaignDocument>) {
    super(model, 'campaigns');
  }

  /**
   * **Mark a window frozen, once** (P18.2-T8 AC-5): `true` for the one call that records it, `false` when it already
   * was — so of two first reads at once only one writes the standings and the audit. Scoped like every write here;
   * neither `version` nor `updatedBy` moves — a freeze is not an edit of the campaign.
   */
  async markFrozen(ctx: RequestContext, code: string, windowKey: string, at: Date): Promise<boolean> {
    const result = await this.model.updateOne(
      this.scope(ctx, 'markFrozen', { code, 'frozenWindows.key': { $ne: windowKey } }),
      { $push: { frozenWindows: { key: windowKey, at } } },
    ).exec();
    return result.modifiedCount === 1;
  }
}
