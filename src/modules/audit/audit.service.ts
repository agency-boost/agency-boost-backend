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
    try {
      await this.model.create(this.rowOf(ctx, entry));
    } catch (err) {
      // An audit write must never take down the operation it describes — but a failure
      // here is a compliance gap, so it is logged at error level and alerts.
      this.logger.error({ err, action: entry.action }, 'failed to write audit entry');
    }
  }

  /**
   * **Many entries, one insert** (Phase 15, D-audit): a read that discloses fifty members' data writes
   * fifty entries, and fifty round trips would make the record the slowest part of the read. Each row is
   * exactly the one `record` would write; a failure is logged and swallowed for the same reason.
   */
  async recordMany(ctx: RequestContext, entries: readonly AuditEntry[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      await this.model.insertMany(entries.map((entry) => this.rowOf(ctx, entry)));
    } catch (err) {
      this.logger.error({ err, action: entries[0].action, count: entries.length }, 'failed to write audit entries');
    }
  }

  /** The row an entry is written as: both actors under impersonation, and whether it was on somebody's behalf. */
  private rowOf(ctx: RequestContext, entry: AuditEntry): Record<string, unknown> {
    const { actorUserId, effectiveUserId } = ctx.auditActors;
    // The context's fields last: an entry says what happened, never who did it or in which office.
    return {
      ...entry,
      kpmId: ctx.kpmId,
      actorUserId,
      effectiveUserId: ctx.isImpersonating ? effectiveUserId : null,
      actorMembershipId: ctx.membershipId,
      onBehalfOf: entry.targetMembershipId != null && entry.targetMembershipId !== ctx.membershipId,
    };
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
