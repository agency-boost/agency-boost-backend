import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { editableUntil } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE, PRODUCTION } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { MemberNames } from '@/modules/org/member-names.service';
import { Kpm } from '@/modules/tenants/kpm.schema';
import { requireMonth } from './production-guards';
import { ProductionMonthRepository } from './production-month.repository';

/**
 * Why a month is open or locked (ADR-0050).
 *
 * `open` and `schedule` are the office's schedule — open until `editableUntil`, locked after it.
 * `locked_by_hand` and `reopened` are somebody's decision, which holds until the other is taken.
 */
export type LockReason = 'open' | 'schedule' | 'locked_by_hand' | 'reopened';

export interface MonthState {
  month: string;
  /** Advanced by every write to the month. A preview carries it; a commit must match it. */
  revision: number;
  locked: boolean;
  reason: LockReason;
  /** The last day the schedule leaves it open, in the office's calendar: month end plus the window. */
  editableUntil: string;
  /** When somebody last locked or reopened it by hand, and who. */
  changedAt: string | null;
  changedBy: string | null;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const monthLabel = (month: string) => {
  const [y, m] = month.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
};

/**
 * A month of production as a thing with a state: its lock, and its revision (P9-T4, ADR-0050).
 *
 * **The schedule is arithmetic, not a row.** A month is open until the end of the office's calendar
 * month plus `kpms.settings.productionLockGraceDays` — `editableUntil`, the same function the
 * activity window uses, so the two windows are one rule. A row exists only once somebody has written
 * to the month or put a hand on its lock.
 */
@Injectable()
export class ProductionMonths {
  constructor(
    private readonly months: ProductionMonthRepository,
    @InjectModel(Kpm.name) private readonly kpms: Model<Kpm>,
    private readonly clock: Clock,
    private readonly names: MemberNames,
    private readonly audit: AuditService,
  ) {}

  async state(ctx: RequestContext, month: string): Promise<MonthState> {
    // Every caller has checked already; this is so that none can reach the date arithmetic without.
    requireMonth(month);
    const [office, row] = await Promise.all([
      this.kpms.findById(ctx.kpmId).select('timezone settings').lean().exec(),
      this.months.findOne(ctx, { month }),
    ]);
    // The platform defaults when the office row predates the setting — migration 0020 writes it,
    // and a month's state is not worth refusing a whole screen over.
    const o = office as { timezone?: string; settings?: { productionLockGraceDays?: number } } | null;
    const timezone = o?.timezone ?? DEFAULT_TENANT_TIMEZONE;
    const grace = o?.settings?.productionLockGraceDays ?? PRODUCTION.LOCK_GRACE_DAYS;

    const until = editableUntil(`${month}-01`, grace);
    const scheduled = this.clock.localDateFor(timezone) > until;
    const override = row?.lockOverride ?? null;

    let changedBy: string | null = null;
    if (row?.lockChangedBy) {
      changedBy = (await this.names.byMembershipId(ctx, [row.lockChangedBy])).get(row.lockChangedBy) || null;
    }

    return {
      month,
      revision: row?.revision ?? 0,
      locked: override === null ? scheduled : override === 'locked',
      reason: override === 'locked' ? 'locked_by_hand'
        : override === 'open' ? 'reopened'
          : scheduled ? 'schedule' : 'open',
      editableUntil: until,
      changedAt: row?.lockChangedAt ? row.lockChangedAt.toISOString() : null,
      changedBy,
    };
  }

  /** `UPLOAD_MONTH_LOCKED`, saying why and what to do — enforced by the writes, never only by the screen. */
  refuseIfLocked(state: MonthState): void {
    if (!state.locked) return;
    const label = monthLabel(state.month);
    const why = state.reason === 'locked_by_hand'
      ? `${label} was locked${state.changedBy ? ` by ${state.changedBy}` : ''}.`
      : `${label} locked after ${state.editableUntil}, when its window closed.`;
    throw new DomainException(
      ErrorCode.UPLOAD_MONTH_LOCKED,
      `${why} Reopen the month to change its figures.`,
      HttpStatus.CONFLICT,
      { month: state.month, reason: state.reason, editableUntil: state.editableUntil },
    );
  }

  /**
   * Advance the month's revision from `expected`, in one atomic write — or refuse.
   *
   * The month's mutex: whoever advances it may write, and anybody who read an older revision is
   * refused `VERSION_CONFLICT` without writing a thing. The first claim on a month creates its row,
   * and two racing first claims meet the unique index — a duplicate, answered the same way.
   */
  async claim(ctx: RequestContext, month: string, expected: number, set: Record<string, unknown> = {}): Promise<number> {
    const update = { $inc: { revision: 1 }, ...(Object.keys(set).length ? { $set: set } : {}) };
    if (expected === 0) {
      try {
        await this.months.upsertOne(ctx, { month, revision: 0 }, update);
        return 1;
      } catch (err) {
        if ((err as { code?: number }).code === 11000) throw await this.conflict(ctx, month, expected);
        throw err;
      }
    }
    const changed = await this.months.updateMany(ctx, { month, revision: expected }, update);
    if (changed === 0) throw await this.conflict(ctx, month, expected);
    return expected + 1;
  }

  /** Lock it now, ahead of its schedule or after a reopen. A month already locked is left as it is. */
  async lock(ctx: RequestContext, month: string): Promise<MonthState> {
    const before = await this.state(ctx, month);
    if (before.locked) return before;
    await this.claim(ctx, month, before.revision, {
      lockOverride: 'locked', lockChangedAt: this.clock.now(), lockChangedBy: ctx.membershipId,
    });
    const after = await this.state(ctx, month);
    await this.audit.record(ctx, {
      action: 'upload.month_locked',
      targetCollection: 'productionMonths',
      targetId: month,
      before: { locked: false, reason: before.reason },
      after: { locked: true, reason: after.reason },
    });
    return after;
  }

  /**
   * Reopen a locked month — `reopen_month`, audited (ADR-0050). It stays open until somebody locks it
   * again; what is written into it meanwhile is versioned like any other write.
   */
  async reopen(ctx: RequestContext, month: string): Promise<MonthState> {
    const before = await this.state(ctx, month);
    if (!before.locked) return before;
    await this.claim(ctx, month, before.revision, {
      lockOverride: 'open', lockChangedAt: this.clock.now(), lockChangedBy: ctx.membershipId,
    });
    const after = await this.state(ctx, month);
    await this.audit.record(ctx, {
      action: 'upload.month_reopened',
      targetCollection: 'productionMonths',
      targetId: month,
      before: { locked: true, reason: before.reason },
      after: { locked: false, reason: after.reason },
    });
    return after;
  }

  private async conflict(ctx: RequestContext, month: string, expected: number): Promise<DomainException> {
    const actual = (await this.months.findOne(ctx, { month }))?.revision ?? 0;
    return new DomainException(
      ErrorCode.VERSION_CONFLICT,
      `${monthLabel(month)} has changed since you looked at it. Load it again, and upload the file again if you were importing one.`,
      HttpStatus.CONFLICT,
      { month, expectedVersion: expected, actualVersion: actual },
    );
  }
}
