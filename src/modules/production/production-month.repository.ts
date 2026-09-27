import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { ProductionMonth, ProductionMonthDocument } from './production-month.schema';

/** Through the chokepoint (invariant §1). No unscoped method. */
@Injectable()
export class ProductionMonthRepository extends TenantScopedRepository<ProductionMonthDocument> {
  constructor(@InjectModel(ProductionMonth.name) model: Model<ProductionMonthDocument>) {
    super(model, 'productionMonths');
  }
}
