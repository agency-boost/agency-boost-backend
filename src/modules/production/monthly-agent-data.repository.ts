import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { MonthlyAgentData, MonthlyAgentDataDocument } from './monthly-agent-data.schema';

/**
 * Every month row, through the chokepoint (invariant §1).
 *
 * No unscoped method. The one cross-tenant reader this data will ever have is the company's own
 * benchmark analytics (OD-20, deferred), and that is a named method on the day it is needed — not
 * an absent filter today.
 */
@Injectable()
export class MonthlyAgentDataRepository extends TenantScopedRepository<MonthlyAgentDataDocument> {
  constructor(@InjectModel(MonthlyAgentData.name) model: Model<MonthlyAgentDataDocument>) {
    super(model, 'monthlyAgentData');
  }
}
