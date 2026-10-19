import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { ActivityLog, ActivityLogDocument } from './activity-log.schema';

/**
 * Every activity log, through the chokepoint (invariant §1).
 *
 * There is no unscoped method here and there should not be one: a Super Admin reads an office's
 * activity by impersonating it, not by reaching across the boundary — and this collection is the
 * evidentiary base for compliance, MAA status and campaign qualification, so a cross-tenant read
 * is not a convenience anybody should have without a route that says so by name.
 */
@Injectable()
export class ActivityLogRepository extends TenantScopedRepository<ActivityLogDocument> {
  constructor(@InjectModel(ActivityLog.name) model: Model<ActivityLogDocument>) {
    super(model, 'activityLogs');
  }
}
