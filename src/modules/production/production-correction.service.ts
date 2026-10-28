import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService, type AuditEntry } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { SalesEvents, signalSales } from '@/modules/activation/sales-events.port';
import { MonthlyAgentDataRepository } from './monthly-agent-data.repository';
import type { MetricValue, ProductionMetric, Provenance } from './monthly-agent-data.schema';
import type { Cadence } from './production-preview';
import { type MonthState, ProductionMonths } from './production-months.service';
import { breaksYtd, refusalFor } from './production-rules';
import { requireMonth, requireOffice } from './production.service';

export interface CorrectionInput {
  month: string;
  membershipId: string;
  metric: ProductionMetric;
  cadence: Cadence;
  /** In the unit it is stored in — money in sen. `null` clears the figure (AC-4). */
  value: number | null;
  /** The month's revision the reader saw. */
  revision: number;
  reason: string;
}

export interface CorrectionResult {
  membershipId: string;
  metric: ProductionMetric;
  cadence: Cadence;
  /** `false` when the figure already held that value: nothing was written, audited or advanced. */
  changed: boolean;
  before: { value: number | null; provenance: Provenance | null };
  after: { value: number | null; provenance: Provenance | null };
  state: MonthState;
}

/**
 * **A leader's *Update production*, one save** (Phase 15, OD-137 option 2, ADR-0121): this month's APE and
 * year to date for each row, either or both, in sen. The caller has resolved every member's reach; this
 * writes each changed cell as `correct` writes one.
 */
export interface ApeCorrectionBatch {
  month: string;
  /** The month's revision the reader saw: one claim for the whole save. */
  revision: number;
  rows: readonly { membershipId: string; apeMonthlyMinor?: number; apeYtdMinor?: number }[];
  /** The fixed reason every cell carries (`UNIT_DASHBOARD_CORRECTION_REASON`). */
  reason: string;
  /** Where the save came from, on every audit entry's `after` — `unit_dashboard`. */
  surface: string;
}

export interface ApeCorrectionResult {
  /** Rows with at least one cell changed: the toast's *"Production updated for {n} agent(s)."*. */
  updated: number;
  state: MonthState;
}

/** One cell about to be written: the figure, and what it replaces. */
interface CellWrite {
  membershipId: string;
  agentCode: string;
  metric: ProductionMetric;
  cadence: Cadence;
  value: number | null;
  /** The stored cell as it stands, or nothing when the row has none. */
  held: MetricValue | undefined;
}

/** The six figures as a sentence names them — never in the file's *Rp M*: a correction is typed in rupiah. */
const NAME: Record<ProductionMetric, string> = {
  ape: 'APE', persistency: 'Rolling persistency', recruitment: 'Recruitment',
  newActiveAgents: 'New active agents', fyp: 'FYP', policyCount: '# of policy',
};
const labelOf = (metric: ProductionMetric, cadence: Cadence) =>
  `${NAME[metric]} ${cadence === 'monthly' ? 'this month' : 'year to date'}`;
const fieldOf = (metric: ProductionMetric, cadence: Cadence) =>
  `${metric}${cadence === 'monthly' ? 'Monthly' : 'Ytd'}`;

const REASON_MAX = 500;

/**
 * One figure, corrected by hand (P9-T5).
 *
 * *"Click any number to correct it manually — no need to re-upload for a single fix"* — the
 * prototype's own hint, made safe: **an invalid value is refused with the reason** (the prototype
 * silently turns it into `null`, a figure nobody entered); **every accepted correction is audited**
 * with the figure before and after, who and when; and **it carries a reason**, because a production
 * figure freezes at upload and a change after that is a new version with a why (ADR-0042).
 *
 * **Clearing is possible here and only here** (AC-4, ADR-0051): `value: null` empties the figure, as
 * `corrected`, audited like any other change. No file can.
 *
 * The same rules as the import (`production-rules.ts`), the same lock (ADR-0050), and the same
 * mutex: a correction claims the month's revision like every other write, so it is refused rather
 * than written over a month that moved while the reader looked at it.
 */
@Injectable()
export class ProductionCorrections {
  constructor(
    private readonly months: ProductionMonths,
    private readonly data: MonthlyAgentDataRepository,
    private readonly memberships: MembershipRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    // P18.96-T4 AC-1: a month's policies corrected above zero may be the member's first sale. Failing open.
    @Optional() @Inject(SalesEvents) private readonly sales: SalesEvents | null = null,
  ) {}

  async correct(ctx: RequestContext, input: CorrectionInput): Promise<CorrectionResult> {
    requireOffice(ctx);
    requireMonth(input.month);
    const { month, membershipId, metric, cadence, value } = input;
    const reason = input.reason.trim();
    if (!reason || reason.length > REASON_MAX) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        reason ? `Keep the reason under ${REASON_MAX} characters.` : 'Say why the figure is being corrected.',
        HttpStatus.BAD_REQUEST,
        { field: 'reason' },
      );
    }

    const member = await this.memberships.findOne(ctx, { _id: membershipId, status: 'active' });
    if (!member) throw new NotFoundException('Member');

    const state = await this.months.state(ctx, month);
    this.months.refuseIfLocked(state);

    const row = await this.data.findOne(ctx, { membershipId, month });
    const cells = (row ?? {}) as unknown as Record<string, MetricValue | undefined>;
    const field = fieldOf(metric, cadence);
    const before = { value: cells[field]?.value ?? null, provenance: cells[field]?.provenance ?? null };
    const label = labelOf(metric, cadence);

    if (value !== null) {
      const why = refusalFor(metric, value);
      const cell = { metric, cadence, value };
      if (why) throw outOfRange(`${label} ${why}`, cell);
      const other = cells[fieldOf(metric, cadence === 'monthly' ? 'ytd' : 'monthly')]?.value ?? null;
      const [m, y] = cadence === 'monthly' ? [value, other] : [other, value];
      if (breaksYtd(metric, m, y)) {
        throw outOfRange(cadence === 'monthly'
          ? `${label} would be more than the year to date already held. Correct the year to date first.`
          : `${label} would be less than this month's figure. Correct this month first.`, cell);
      }
    }

    if (value === before.value) {
      return { membershipId, metric, cadence, changed: false, before, after: before, state };
    }

    await this.months.claim(ctx, month, input.revision);
    await this.writeCell(ctx, month, reason, this.clock.now(), {
      membershipId, agentCode: (member as { agentCode?: string }).agentCode ?? '', metric, cadence, value,
      held: cells[field],
    });

    /*
     * P18.96-T4 AC-1 (ADR-0171 §1): a month's policies above zero may be the member's first sale — and, since the P18.96
     * exit review (M4), a month's policies corrected to none, or cleared, may take away the one the file gave them.
     */
    if (metric === 'policyCount' && cadence === 'monthly') {
      await signalSales(this.sales, ctx, [membershipId]);
    }
    return {
      membershipId, metric, cadence, changed: true, before,
      after: { value, provenance: 'corrected' },
      state: await this.months.state(ctx, month),
    };
  }

  /**
   * **A leader's *Update production*: many members' APE, one save** (Phase 15, P15-T3; OD-137 option 2,
   * ADR-0121) — each changed cell a correction of the office's figure, **written by the function `correct`
   * writes one with**, so the month table, the next import's preview (ADR-0053), the Summary and coaching
   * read a leader's figure exactly as they read an Owner's.
   *
   * - **Everything is checked before anything is written.** Every member is an active member of the office
   *   (the caller resolved their reach; a member who left is 404 here too), the month is open, and every
   *   row's **resulting** pair — what it sends, over what is held — passes the import's own rules
   *   (`refusalFor`, `breaksYtd`). One refusal and nothing is written.
   * - **One claim of the month's revision for the whole save**, and only when a cell changes — as `correct`
   *   claims only for a change. A stale revision is `VERSION_CONFLICT`, and nothing is written.
   * - **A cell already holding the figure is unchanged**: not written, not audited, not counted. `updated`
   *   counts the rows with a cell changed (the prototype counted every row, `Overall.html:7554`).
   * - **A leader cannot clear a figure**: the rows carry numbers only, and clearing stays the month table's
   *   (ADR-0051).
   */
  async correctApe(ctx: RequestContext, input: ApeCorrectionBatch): Promise<ApeCorrectionResult> {
    requireOffice(ctx);
    requireMonth(input.month);
    const { month, reason } = input;
    const ids = input.rows.map((row) => row.membershipId);

    const members = ids.every((id) => isValidObjectId(id))
      ? await this.memberships.find(ctx, { _id: { $in: ids }, status: 'active' })
      : [];
    const codeOf = new Map(members.map((m) => [String(m._id), (m as { agentCode?: string }).agentCode ?? '']));
    if (ids.some((id) => !codeOf.has(id))) throw new NotFoundException('Member');

    const state = await this.months.state(ctx, month);
    this.months.refuseIfLocked(state);

    const stored = new Map((await this.data.find(ctx, { month, membershipId: { $in: ids } }))
      .map((row) => [row.membershipId, row as unknown as Record<string, MetricValue | undefined>]));

    const writes: CellWrite[] = [];
    const changedRows = new Set<string>();
    for (const row of input.rows) {
      const cells = stored.get(row.membershipId) ?? {};
      const asked: [Cadence, number | undefined][] = [['monthly', row.apeMonthlyMinor], ['ytd', row.apeYtdMinor]];
      for (const [cadence, value] of asked) {
        if (value === undefined) continue;
        const why = refusalFor('ape', value);
        if (why) throw outOfRange(`${labelOf('ape', cadence)} ${why}`, { membershipId: row.membershipId, metric: 'ape', cadence, value });
      }
      const held = (cadence: Cadence) => cells[fieldOf('ape', cadence)];
      const monthly = row.apeMonthlyMinor ?? held('monthly')?.value ?? null;
      const ytd = row.apeYtdMinor ?? held('ytd')?.value ?? null;
      if (breaksYtd('ape', monthly, ytd)) {
        const cadence: Cadence = row.apeYtdMinor !== undefined ? 'ytd' : 'monthly';
        throw outOfRange(cadence === 'monthly'
          ? `${labelOf('ape', 'monthly')} would be more than the year to date already held. Correct the year to date too.`
          : `${labelOf('ape', 'ytd')} would be less than this month's figure.`,
        { membershipId: row.membershipId, metric: 'ape', cadence, value: cadence === 'monthly' ? monthly : ytd });
      }
      for (const [cadence, value] of asked) {
        if (value === undefined || value === (held(cadence)?.value ?? null)) continue;
        writes.push({
          membershipId: row.membershipId, agentCode: codeOf.get(row.membershipId)!, metric: 'ape', cadence, value,
          held: held(cadence),
        });
        changedRows.add(row.membershipId);
      }
    }

    if (writes.length === 0) return { updated: 0, state };

    // One claim of the revision, then every row in one `bulkWrite`, then every cell's entry in one insert.
    await this.months.claim(ctx, month, input.revision);
    const now = this.clock.now();
    const byRow = new Map<string, CellWrite[]>();
    for (const write of writes) byRow.set(write.membershipId, [...(byRow.get(write.membershipId) ?? []), write]);
    const rowIds = await this.data.upsertMonthRows(ctx, month, [...byRow].map(([membershipId, cells]) => ({
      membershipId,
      set: Object.assign({}, ...cells.map((cell) => this.cellSet(ctx, reason, now, cell))),
      setOnInsert: { agentCode: cells[0].agentCode },
    })));
    await this.audit.recordMany(ctx, writes.map((cell) =>
      this.cellAudit(month, reason, cell, rowIds.get(cell.membershipId) as string, { surface: input.surface })));

    return { updated: changedRows.size, state: await this.months.state(ctx, month) };
  }

  /**
   * **One cell, corrected — written as every correction writes one** (P9-T5; Phase 15): the figure as
   * `corrected`, with who, when and why, the figure the chain replaced kept from its first link (ADR-0053),
   * and one `upload.cell_corrected` entry with the figure before and after. `correct` writes one row with it;
   * `correctApe` writes many in one `bulkWrite`, from the same `cellSet` and `cellAudit`.
   */
  private async writeCell(ctx: RequestContext, month: string, reason: string, now: Date, cell: CellWrite): Promise<void> {
    const written = await this.data.upsertOne(ctx, { membershipId: cell.membershipId, month }, {
      $set: this.cellSet(ctx, reason, now, cell),
      $setOnInsert: { agentCode: cell.agentCode },
    });
    await this.audit.record(ctx, this.cellAudit(month, reason, cell, String(written._id)));
  }

  /** The `$set` a corrected cell is written with. */
  private cellSet(ctx: RequestContext, reason: string, now: Date, cell: CellWrite): Record<string, unknown> {
    const before = cell.held?.provenance ?? null;
    return {
      [fieldOf(cell.metric, cell.cadence)]: {
        value: cell.value, provenance: 'corrected', sourceBatchId: null,
        correctedBy: ctx.membershipId, correctedAt: now, reason,
        // The figure the chain of corrections replaced: kept from the first, never the last hand's.
        replacedValue: before === 'corrected' ? (cell.held?.replacedValue ?? null) : (cell.held?.value ?? null),
      },
    };
  }

  /** The entry a corrected cell leaves; `extra` lands on its `after` — where a leader's save came from. */
  private cellAudit(
    month: string, reason: string, cell: CellWrite, targetId: string, extra: Record<string, unknown> = {},
  ): AuditEntry {
    const field = fieldOf(cell.metric, cell.cadence);
    return {
      action: 'upload.cell_corrected',
      targetCollection: 'monthlyAgentData',
      targetId,
      targetMembershipId: cell.membershipId,
      before: {
        month, field, value: cell.held?.value ?? null, provenance: cell.held?.provenance ?? null,
        sourceBatchId: cell.held?.sourceBatchId ?? null,
      },
      after: { month, field, value: cell.value, provenance: 'corrected', reason, ...extra },
    };
  }
}

function outOfRange(
  message: string,
  input: { membershipId?: string; metric: ProductionMetric; cadence: Cadence; value: number | null },
): DomainException {
  return new DomainException(
    ErrorCode.UPLOAD_VALUE_OUT_OF_RANGE,
    message,
    HttpStatus.UNPROCESSABLE_ENTITY,
    {
      // A leader's save names the row, among many; a single correction names only the cell, as it always has.
      ...(input.membershipId !== undefined ? { membershipId: input.membershipId } : {}),
      metric: input.metric, cadence: input.cadence, value: input.value,
    },
  );
}
