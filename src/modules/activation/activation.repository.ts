import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { ActivationTemplate, ActivationTemplateDocument } from './activation-template.schema';

/**
 * The office's activation checklist (P5-T3). No escape hatch to the raw model — the repository is
 * the chokepoint that makes forgetting `kpmId` impossible (invariant §1).
 */
@Injectable()
export class ActivationTemplateRepository extends TenantScopedRepository<ActivationTemplateDocument> {
  constructor(@InjectModel(ActivationTemplate.name) model: Model<ActivationTemplateDocument>) {
    super(model, 'activationTemplates');
  }
}
