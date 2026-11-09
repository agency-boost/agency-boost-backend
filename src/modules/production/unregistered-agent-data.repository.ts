import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { UnregisteredAgentData, UnregisteredAgentDataDocument } from './unregistered-agent-data.schema';

/**
 * Every *Belum terdaftar* row, through the chokepoint (invariant §1; ADR-0214 §8). No unscoped method: the one
 * cross-office read of it — which kodes hold a figure, for the template editor's locks — is
 * `MonthlyAgentDataRepository.kodesHeldInOfficesAcrossTenants`, which reads this collection beside its own.
 */
@Injectable()
export class UnregisteredAgentDataRepository extends TenantScopedRepository<UnregisteredAgentDataDocument> {
  constructor(@InjectModel(UnregisteredAgentData.name) model: Model<UnregisteredAgentDataDocument>) {
    super(model, 'unregisteredAgentData');
  }
}
