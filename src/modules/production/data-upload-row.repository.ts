import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { DataUploadRow, DataUploadRowDocument } from './data-upload-row.schema';

/** Through the chokepoint (invariant §1). No unscoped method. */
@Injectable()
export class DataUploadRowRepository extends TenantScopedRepository<DataUploadRowDocument> {
  constructor(@InjectModel(DataUploadRow.name) model: Model<DataUploadRowDocument>) {
    super(model, 'dataUploadRows');
  }
}
