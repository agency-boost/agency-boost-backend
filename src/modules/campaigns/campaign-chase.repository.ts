import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { CampaignChase, CampaignChaseDocument } from './campaign-chase.schema';

/** A member's chases (P18.5-T7). Through the chokepoint, like every tenant-scoped collection. */
@Injectable()
export class CampaignChaseRepository extends TenantScopedRepository<CampaignChaseDocument> {
  constructor(@InjectModel(CampaignChase.name) model: Model<CampaignChaseDocument>) {
    super(model, 'campaignChases');
  }
}
