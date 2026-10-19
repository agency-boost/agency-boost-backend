import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { Policy, PolicyDocument } from './policy.schema';

/** Every policy, through the chokepoint (invariant §1). */
@Injectable()
export class PolicyRepository extends TenantScopedRepository<PolicyDocument> {
  constructor(@InjectModel(Policy.name) model: Model<PolicyDocument>) {
    super(model, 'policies');
  }
}
