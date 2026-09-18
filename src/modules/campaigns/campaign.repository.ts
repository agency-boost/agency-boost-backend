import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { Campaign, CampaignDocument } from './campaign.schema';

/** An office's own campaigns. Through the chokepoint, like every tenant-scoped collection. */
@Injectable()
export class CampaignRepository extends TenantScopedRepository<CampaignDocument> {
  constructor(@InjectModel(Campaign.name) model: Model<CampaignDocument>) {
    super(model, 'campaigns');
  }
}
