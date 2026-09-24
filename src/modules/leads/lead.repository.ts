import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
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
}
