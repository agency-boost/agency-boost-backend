import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
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

  /**
   * **Entries in named scopes, in one insert, or the read fails** (ADR-0207 §5; P19.4-T3 AC-16): a Super Admin's
   * platform read writes one entry in the platform's log (`kpmId: null`) and one in each KPM's whose data it returned,
   * so that KPM's Owner reads the visit in their own log. Unlike `record` and `recordMany`, **a failure is thrown**,
   * after it is logged: an unrecorded cross-KPM read is the one thing that decision forbids, so the caller answers
   * `500` rather than the figures. Each row is otherwise exactly what `record` writes — the actor from the context — with
   * the scope named per entry instead of read from it.
   */
  async recordInScopesOrFail(
    ctx: RequestContext,
    entries: readonly { kpmId: string | null; entry: AuditEntry }[],
  ): Promise<void> {
    if (entries.length === 0) return;
    try {
      await this.model.insertMany(entries.map(({ kpmId, entry }) => ({ ...this.rowOf(ctx, entry), kpmId })));
    } catch (err) {
      this.logger.error({ err, action: entries[0].entry.action, count: entries.length }, 'failed to write audit entries');
      throw err;
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

  /**
   * **One batch of a scope's rows, newest first, after a row** (P19.2-T2 AC-6; §B.32): what the audit page folds into
   * groups. The scope is a parameter of its own and leads the filter, as `findForTenant`'s does — `null` is the
   * platform-level log, never *every office* — and `filter` only narrows within it.
   *
   * Ordered by time and then id, both descending, so two rows written in one millisecond still have one order, and
   * `after` — the last row of the batch before — resumes exactly past it: rows written meanwhile are newer, and never
   * move a batch nobody has read yet.
   */
  async findNewestFirst(
    kpmId: string | null,
    filter: FilterQuery<AuditLogDocument>,
    after: { at: Date; id: string } | null,
    limit: number,
  ): Promise<AuditLogDocument[]> {
    const past = after
      ? [{ $or: [{ createdAt: { $lt: after.at } }, { createdAt: after.at, _id: { $lt: new Types.ObjectId(after.id) } }] }]
      : [];
    return this.model
      .find({ kpmId, $and: [filter, ...past] })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .exec();
  }

  /**
   * **The different values of one field within a scope** (P19.2-T2 AC-6): what the audit page's *Tindakan* and *Pelaku*
   * chips offer. The scope leads, as above; `filter` narrows within it.
   */
  async distinctWithin(
    kpmId: string | null,
    key: 'action' | 'actorUserId',
    filter: FilterQuery<AuditLogDocument> = {},
  ): Promise<string[]> {
    const values = await this.model.distinct(key, { kpmId, ...filter }).exec();
    return (values as unknown[]).filter((v): v is string => typeof v === 'string');
  }
}
