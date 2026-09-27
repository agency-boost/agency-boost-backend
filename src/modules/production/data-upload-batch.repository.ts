import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { DataUploadBatch, DataUploadBatchDocument } from './data-upload-batch.schema';

/** Through the chokepoint (invariant §1). No unscoped method. */
@Injectable()
export class DataUploadBatchRepository extends TenantScopedRepository<DataUploadBatchDocument> {
  constructor(@InjectModel(DataUploadBatch.name) model: Model<DataUploadBatchDocument>) {
    super(model, 'dataUploadBatches');
  }
}
