import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { render, type Sentence } from '@/common/i18n/sentence';
import { AuditService, type AuditEntry } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { SalesEvents, signalSales } from '@/modules/activation/sales-events.port';
import { ProductionWrites, signalAfterWrite, signalBeforeWrite } from './production-writes.port';
import { AnalyticsConfigReader } from '@/modules/config/analytics-config.reader';
import { platformAnalyticsConfig, type AdvancedAnalyticsConfig, type UploadField } from '@/modules/config/analytics-config';
import { MonthlyAgentDataRepository } from './monthly-agent-data.repository';
import { cellAsHydrated, type MetricValue, type Provenance } from './monthly-agent-data.schema';
import { type MonthState, ProductionMonths } from './production-months.service';
import { requireMonth, requireOffice } from './production.service';
import { PRODUCTION_REFUSALS } from './production.messages';
import { labelIn } from './production-template';
import { cellKey, cellPath, inForce, refusalForField } from './upload-columns';

const SAY = PRODUCTION_REFUSALS;

export interface CorrectionInput {
  month: string;
  membershipId: string;
  /** The column's kode in the KPM's template (P19.5-T2; ADR-0214 §9). */
  kode: string;
  /** `true` for a `ytd: 'upload'` column's year to date; a summed one is calculated and never typed (R4). */
  ytd: boolean;
  /** In the unit it is stored in — money in sen. `null` clears the figure (AC-4). */
  value: number | null;
  /** The month's revision the reader saw. */
  revision: number;
  reason: string;
}

export interface CorrectionResult {
  membershipId: string;
  kode: string;
  ytd: boolean;
  /** `false` when the figure already held that value: nothing was written, audited or advanced. */
  changed: boolean;
  before: { value: number | null; provenance: Provenance | null };
  after: { value: number | null; provenance: Provenance | null };
  state: MonthState;
}

/**
 * **A leader's *Update production*, one save** (Phase 15, OD-137 option 2, ADR-0121): this month's APE for each row, in
 * sen. *Since P19.5-T2* (R4, ADR-0214 §10) APE's year to date is the sum of its months, and a row naming one is refused:
 * the leader corrects the month. The caller has resolved every member's reach; this writes each changed cell as
 * `correct` writes one.
 */
export interface ApeCorrectionBatch {
  month: string;
  /** The month's revision the reader saw: one claim for the whole save. */
  revision: number;
  rows: readonly { membershipId: string; apeMonthlyMinor?: number; apeYtdMinor?: number }[];
  /**
   * The fixed reason every cell carries (`UNIT_DASHBOARD_MESSAGES.correctionReason`). **The API's own words are a
   * sentence, stored in the language of the leader saving** (P18.10-T5 AC-6), as text, and shown as stored. A string
   * is stored exactly as given: words somebody typed, or `UNIT_DASHBOARD_CORRECTION_REASON`'s English from a caller
   * that does not pass the sentence yet.
   */
  reason: string | Sentence<null>;
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
  kode: string;
  ytd: boolean;
  value: number | null;
  /** The stored cell as it stands, or nothing when the row has none. */
  held: MetricValue | null;
}

const APE = 'APE';

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
 * The same rules as the import (`refusalForField`, `upload-columns.ts`), the same lock (ADR-0050), and the same
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
    // P18.8-T4 AC-1: a month's policies corrected above zero may be the member's first sale. Failing open.
    @Optional() @Inject(SalesEvents) private readonly sales: SalesEvents | null = null,
    // P19.5-T2 (ADR-0214 §3): the KPM's template, read live — the column a kode names, and its limits.
    @Optional() private readonly analytics: AnalyticsConfigReader | null = null,
    // P19.5-T3 AC-9 (ADR-0215 §6): the Quant runs freeze before a write past their 15th, and recalculate after one.
    @Optional() @Inject(ProductionWrites) private readonly writes: ProductionWrites | null = null,
  ) {}

  /** The configuration the KPM reads now; the platform's where this was built without the reader. */
  private async config(ctx: RequestContext): Promise<{ config: AdvancedAnalyticsConfig; templateId: string | null; version: number }> {
    if (!this.analytics) return { config: platformAnalyticsConfig(), templateId: null, version: 1 };
    const published = await this.analytics.publishedFor(ctx);
    return { config: published.config, templateId: published.templateId, version: published.version };
  }

  /**
   * **The column a correction names** (P19.5-T2; ADR-0214 §9, §10): one of the template's current columns in force in
   * the month — `400 VALIDATION_FAILED` for any other kode — and for its year to date, one the file uploads; a summed
   * year to date is the months' and is corrected by correcting a month.
   */
  private columnFor(config: AdvancedAnalyticsConfig, kode: string, ytd: boolean, month: string, language: 'en' | 'id'): UploadField {
    const field = config.uploadFields.find((f) => f.kode === kode);
    if (!field || !inForce(field, month)) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED, SAY.VALIDATION_FAILED.notAColumn({ kode }), HttpStatus.BAD_REQUEST, { field: 'kode', kode },
      );
    }
    if (ytd && field.ytd !== 'upload') {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED, SAY.VALIDATION_FAILED.ytdIsCalculated({ label: labelIn(field, language) }),
        HttpStatus.BAD_REQUEST, { field: 'ytd', kode },
      );
    }
    return field;
  }

  async correct(ctx: RequestContext, input: CorrectionInput): Promise<CorrectionResult> {
    requireOffice(ctx);
    requireMonth(input.month);
    const { month, membershipId, kode, ytd, value } = input;
    // Typed by the person correcting: stored as typed, trimmed (P18.10-T5 AC-6).
    const reason = input.reason.trim();
    if (!reason || reason.length > REASON_MAX) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        reason ? SAY.VALIDATION_FAILED.reasonTooLong({ max: REASON_MAX }) : SAY.VALIDATION_FAILED.reasonRequired,
        HttpStatus.BAD_REQUEST,
        { field: 'reason' },
      );
    }

    const member = await this.memberships.findOne(ctx, { _id: membershipId, status: 'active' });
    if (!member) throw new NotFoundException('Member');
    const { config, templateId, version } = await this.config(ctx);
    const column = this.columnFor(config, kode, ytd, month, ctx.reader.language);

    const state = await this.months.state(ctx, month);
    this.months.refuseIfLocked(state);

    const row = await this.data.findOne(ctx, { membershipId, month });
    const held = cellAsHydrated(((ytd ? row?.ytdValues : row?.values)?.[kode] ?? undefined) as Partial<MetricValue> | undefined);
    const before = { value: held?.value ?? null, provenance: held?.provenance ?? null };
    const name = labelIn(column, ctx.reader.language);

    if (value !== null) {
      const why = refusalForField(column, value);
      if (why) {
        throw outOfRange(SAY.UPLOAD_VALUE_OUT_OF_RANGE.correction({ name, cadence: ytd ? 'ytd' : 'monthly', reason: why }), { kode, ytd, value });
      }
    }

    if (value === before.value) {
      return { membershipId, kode, ytd, changed: false, before, after: before, state };
    }

    await signalBeforeWrite(this.writes, ctx, month);
    await this.months.claim(ctx, month, input.revision);
    await this.writeCell(ctx, month, reason, this.clock.now(), {
      membershipId, agentCode: (member as { agentCode?: string }).agentCode ?? '', kode, ytd, value, held,
    }, { templateId, templateVersion: version });
    await this.months.markWritten(ctx, month);

    /*
     * P18.8-T4 AC-1 (ADR-0171 §1): a month's policies above zero may be the member's first sale — and, since the P18.8
     * exit review (M4), a month's policies corrected to none, or cleared, may take away the one the file gave them.
     */
    if (kode === 'POLICY_COUNT' && !ytd) {
      await signalSales(this.sales, ctx, [membershipId]);
    }
    await signalAfterWrite(this.writes, ctx, month);
    return {
      membershipId, kode, ytd, changed: true, before,
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
   *   (`refusalForField`). One refusal and nothing is written.
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
    const { month } = input;
    // AC-6: the API's own words in the saving leader's language, stored as text; a string as it was given.
    const reason = typeof input.reason === 'string' ? input.reason : render(input.reason, ctx.reader);
    const ids = input.rows.map((row) => row.membershipId);

    const members = ids.every((id) => isValidObjectId(id))
      ? await this.memberships.find(ctx, { _id: { $in: ids }, status: 'active' })
      : [];
    const codeOf = new Map(members.map((m) => [String(m._id), (m as { agentCode?: string }).agentCode ?? '']));
    if (ids.some((id) => !codeOf.has(id))) throw new NotFoundException('Member');

    // R4 (P19.5-T2): APE's year to date is the sum of its months — a leader corrects the month, never the sum.
    const asksYtd = input.rows.find((row) => row.apeYtdMinor !== undefined);
    if (asksYtd) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED, SAY.VALIDATION_FAILED.ytdIsCalculated({ label: APE }), HttpStatus.BAD_REQUEST,
        { field: 'apeYtdMinor', membershipId: asksYtd.membershipId },
      );
    }
    const { config, templateId, version } = await this.config(ctx);
    const column = this.columnFor(config, APE, false, month, ctx.reader.language);

    const state = await this.months.state(ctx, month);
    this.months.refuseIfLocked(state);

    const stored = new Map((await this.data.find(ctx, { month, membershipId: { $in: ids } }))
      .map((row) => [row.membershipId, cellAsHydrated((row.values?.[APE] ?? undefined) as Partial<MetricValue> | undefined)]));

    const writes: CellWrite[] = [];
    const changedRows = new Set<string>();
    for (const row of input.rows) {
      const value = row.apeMonthlyMinor;
      if (value === undefined) continue;
      const why = refusalForField(column, value);
      if (why) {
        throw outOfRange(
          SAY.UPLOAD_VALUE_OUT_OF_RANGE.correction({ name: labelIn(column, ctx.reader.language), cadence: 'monthly', reason: why }),
          { membershipId: row.membershipId, kode: APE, ytd: false, value },
        );
      }
      const held = stored.get(row.membershipId) ?? null;
      if (value === (held?.value ?? null)) continue;
      writes.push({ membershipId: row.membershipId, agentCode: codeOf.get(row.membershipId)!, kode: APE, ytd: false, value, held });
      changedRows.add(row.membershipId);
    }

    if (writes.length === 0) return { updated: 0, state };

    // One claim of the revision, then every row in one `bulkWrite`, then every cell's entry in one insert.
    await signalBeforeWrite(this.writes, ctx, month);
    await this.months.claim(ctx, month, input.revision);
    const now = this.clock.now();
    const byRow = new Map<string, CellWrite[]>();
    for (const write of writes) byRow.set(write.membershipId, [...(byRow.get(write.membershipId) ?? []), write]);
    const rowIds = await this.data.upsertMonthRows(ctx, month, [...byRow].map(([membershipId, cells]) => ({
      membershipId,
      set: Object.assign({ templateId, templateVersion: version }, ...cells.map((cell) => this.cellSet(ctx, reason, now, cell))),
      setOnInsert: { agentCode: cells[0].agentCode },
    })));
    await this.months.markWritten(ctx, month);
    await this.audit.recordMany(ctx, writes.map((cell) =>
      this.cellAudit(month, reason, cell, rowIds.get(cell.membershipId) as string, { surface: input.surface })));
    await signalAfterWrite(this.writes, ctx, month);

    return { updated: changedRows.size, state: await this.months.state(ctx, month) };
  }

  /**
   * **One cell, corrected — written as every correction writes one** (P9-T5; Phase 15): the figure as
   * `corrected`, with who, when and why, the figure the chain replaced kept from its first link (ADR-0053),
   * and one `upload.cell_corrected` entry with the figure before and after. `correct` writes one row with it;
   * `correctApe` writes many in one `bulkWrite`, from the same `cellSet` and `cellAudit`.
   */
  private async writeCell(
    ctx: RequestContext, month: string, reason: string, now: Date, cell: CellWrite,
    stamp: { templateId: string | null; templateVersion: number },
  ): Promise<void> {
    const written = await this.data.upsertOne(ctx, { membershipId: cell.membershipId, month }, {
      $set: { ...this.cellSet(ctx, reason, now, cell), ...stamp },
      $setOnInsert: { agentCode: cell.agentCode },
    });
    await this.audit.record(ctx, this.cellAudit(month, reason, cell, String(written._id)));
  }

  /** The `$set` a corrected cell is written with. */
  private cellSet(ctx: RequestContext, reason: string, now: Date, cell: CellWrite): Record<string, unknown> {
    const before = cell.held?.provenance ?? null;
    return {
      [cellPath(cell.kode, cell.ytd)]: {
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
    // The cell's key, as a batch row names it: `APE`, `KOMISI_YTD` (`cellKey`, P19.5-T2).
    const field = cellKey(cell.kode, cell.ytd);
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
  message: Sentence<'UPLOAD_VALUE_OUT_OF_RANGE'>,
  input: { membershipId?: string; kode: string; ytd: boolean; value: number | null },
): DomainException {
  return new DomainException(
    ErrorCode.UPLOAD_VALUE_OUT_OF_RANGE,
    message,
    HttpStatus.UNPROCESSABLE_ENTITY,
    {
      // A leader's save names the row, among many; a single correction names only the cell, as it always has.
      ...(input.membershipId !== undefined ? { membershipId: input.membershipId } : {}),
      kode: input.kode, ytd: input.ytd, value: input.value,
    },
  );
}
