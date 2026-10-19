import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { CapabilityCatalog, CapabilityCatalogDocument } from './capability.schema';

/** One office's catalog, through the chokepoint like every other tenant-scoped collection. */
@Injectable()
export class CapabilityCatalogRepository
  extends TenantScopedRepository<CapabilityCatalogDocument> {
  constructor(@InjectModel(CapabilityCatalog.name) model: Model<CapabilityCatalogDocument>) {
    super(model, 'capabilityCatalogs');
  }
}
