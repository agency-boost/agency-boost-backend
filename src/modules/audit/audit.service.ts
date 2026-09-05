import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogDocument } from './audit-log.schema';

export interface AuditEntry {
  action: string;
  targetCollection: string;
  targetId?: string | null;
  targetMembershipId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * The audit log is append-only by construction: this service exposes `record` and
 * `query`, and no update or delete. See docs/02-specs/nfr/security-and-privacy.md for
 * the list of actions that must be audited without exception.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@InjectModel(AuditLog.name) private readonly model: Model<AuditLogDocument>) {}

  async record(ctx: RequestContext, entry: AuditEntry): Promise<void> {
    const { actorUserId, effectiveUserId } = ctx.auditActors;
    try {
      await this.model.create({
        kpmId: ctx.kpmId,
        actorUserId,
        effectiveUserId: ctx.isImpersonating ? effectiveUserId : null,
        actorMembershipId: ctx.membershipId,
        onBehalfOf: entry.targetMembershipId != null && entry.targetMembershipId !== ctx.membershipId,
        ...entry,
      });
    } catch (err) {
      // An audit write must never take down the operation it describes — but a failure
      // here is a compliance gap, so it is logged at error level and alerts.
      this.logger.error({ err, action: entry.action }, 'failed to write audit entry');
    }
  }

  /**
   * Reads are tenant-scoped by the caller passing the kpmId it is entitled to.
   *
   * `null` is a real scope, not "unscoped": platform-level events — provisioning a KPM,
   * creating a company — are recorded by a Super Admin whose context has no membership,
   * so they carry `kpmId: null`. Coercing that to `''` would silently return nothing.
   */
  async findForTenant(kpmId: string | null, limit = 100): Promise<AuditLogDocument[]> {
    return this.model.find({ kpmId }).sort({ createdAt: -1 }).limit(limit).exec();
  }
}
