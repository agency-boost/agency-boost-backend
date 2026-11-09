import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { PRODUCTION_UPLOAD } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { SalesEvents, signalSales } from '@/modules/activation/sales-events.port';
import { ProductionWrites, signalAfterWrite, signalBeforeWrite } from './production-writes.port';
import { MemberNames } from '@/modules/org/member-names.service';
import { type BatchStatus, DataUploadBatchDocument } from './data-upload-batch.schema';
import { DataUploadBatchRepository } from './data-upload-batch.repository';
import type { PreviousValue } from './data-upload-row.schema';
import { DataUploadRowRepository } from './data-upload-row.repository';
import { MonthlyAgentDataRepository } from './monthly-agent-data.repository';
import { cellAsHydrated, type MetricValue } from './monthly-agent-data.schema';
import { heldCodeOf, type PreviewCell, type PreviewRow } from './production-preview';
import { type MonthState, ProductionMonths } from './production-months.service';
import type { FileUpload } from './production-upload.interceptor';
import { ProductionService, requireMonth, requireOffice } from './production.service';
import { PRODUCTION_REFUSALS } from './production.messages';
import { cellKey, cellPath, parseCellKey } from './upload-columns';
import { UnregisteredAgentDataRepository } from './unregistered-agent-data.repository';
import { Kpm } from '@/modules/tenants/kpm.schema';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';

const SAY = PRODUCTION_REFUSALS;

/** An import as the history panel shows it. */
export interface BatchView {
  id: string;
  month: string;
  filename: string;
  status: BatchStatus;
  /**
   * The template's version the file was read against (R6; P19.5-T2 AC-12) — the history's *"v<n>"*. A batch from
   * before P19.5-T2 reads 1, as the migration stamped it.
   */
  templateVersion: number;
  /** D8: the office day a running month's upload stood at; `null` for a final one. */
  asOf: string | null;
  /** *Belum terdaftar* rows it held apart (ADR-0214 §8). */
  heldRowCount: number;
  rowCount: number;
  writtenRowCount: number;
  cellCount: number;
  issueCount: number;
  committedAt: string | null;
  committedBy: string | null;
  revertedAt: string | null;
  revertedBy: string | null;
  restoredCellCount: number;
  keptCellCount: number;
  /** Corrections by hand the file would have changed, left as they were (ADR-0053). */
  keptCorrectionCount: number;
  /** Corrections by hand the importer chose to replace with the file's figure. */
  replacedCorrectionCount: number;
  /** Standing, and the month's latest standing import — the only one revert will take. */
  canRevert: boolean;
}

export interface ImportResult {
  batch: BatchView;
  state: MonthState;
}

export interface History {
  month: string;
  batches: BatchView[];
}

/** A cell's key in a batch row and a commit's `replace` — `APE`, `KOMISI_YTD` (`cellKey`, P19.5-T2). */
const keyOf = (c: Pick<PreviewCell, 'kode' | 'ytd'>) => cellKey(c.kode, c.ytd);

const writes = (c: PreviewCell) => c.status === 'new' || c.status === 'changed';

/** How a ticked correction is named in the commit: the member — or the held code — and the cell's key. */
const ownerOf = (r: PreviewRow) => (r.status === 'held' ? `held:${heldCodeOf(r.agentCode)}` : r.membershipId);
const correctionKey = (r: PreviewRow, c: PreviewCell) => `${ownerOf(r)}:${keyOf(c)}`;

const EMPTY_CELL: NonNullable<PreviousValue> = {
  value: null, provenance: null, sourceBatchId: null, correctedBy: null, correctedAt: null, reason: null,
  replacedValue: null,
};

/** Statuses that mean the preview behind them went through — what "committed twice" is checked against. */
const WENT_THROUGH: BatchStatus[] = ['committed', 'reverting', 'reverted'];

/**
 * Confirm import, revert, and the history they leave (P9-T4).
 *
 * **Atomic without a transaction.** This product's MongoDB is not always a replica set — local
 * development and the test server are standalone — so a multi-document transaction is not available
 * everywhere it runs. The batch is the undo log instead: its rows, with every figure's previous value,
 * are written **before** a single figure changes. A commit that fails part-way puts back what it
 * wrote before it answers; one whose process dies is finished off by the next write to its month
 * (`recover`). Either way the month ends as it was (AC-7).
 *
 * **Serialised by the month's revision.** Every writer claims it first (`ProductionMonths.claim`), so
 * two writers never interleave on one month, and a commit whose preview saw an older revision is
 * refused before it writes.
 */
@Injectable()
export class ProductionImportService {
  constructor(
    private readonly production: ProductionService,
    private readonly months: ProductionMonths,
    private readonly data: MonthlyAgentDataRepository,
    private readonly batches: DataUploadBatchRepository,
    private readonly rows: DataUploadRowRepository,
    private readonly names: MemberNames,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    // P18.8-T4 AC-1: a policy in the file may be a member's first sale. A port activation answers; failing open.
    @Optional() @Inject(SalesEvents) private readonly sales: SalesEvents | null = null,
    // P19.5-T2 (ADR-0214 §8): *Belum terdaftar* rows; without it a held row is never written (a spec built by hand).
    @Optional() private readonly unregistered: UnregisteredAgentDataRepository | null = null,
    // D8: the office's zone, for the current month and its *as of* day.
    @Optional() @InjectModel(Kpm.name) private readonly kpms: Model<Kpm> | null = null,
    // P19.5-T3 AC-9 (ADR-0215 §6): the Quant runs freeze before a write past their 15th, and recalculate after one.
    @Optional() @Inject(ProductionWrites) private readonly writes: ProductionWrites | null = null,
  ) {}

  /**
   * **Confirm import.** The file is read again, against what is stored now, rather than trusting the
   * browser's copy of the preview — and refused if the month has moved since the preview was taken.
   *
   * Writes only `new` and `changed` figures, each as `imported` with this batch as its source (AC-6).
   * A blank is not provided and is not written (ADR-0051); a figure already as stored is left as it is.
   *
   * **A figure corrected by hand is written only if it is named in `replace`** (ADR-0053) — the
   * preview listed it with who corrected it and why, and whoever imports ticked it. Unticked, it
   * stays; a revert of this import brings back one it replaced.
   */
  async commit(
    ctx: RequestContext,
    month: string,
    revision: string | undefined,
    upload: FileUpload | undefined,
    replace?: string,
    asOfGiven?: string,
  ): Promise<ImportResult> {
    requireOffice(ctx);
    requireMonth(month);
    const asOf = await this.asOfFor(ctx, month, asOfGiven);
    const basedOn = Number(revision);
    if (revision === undefined || !/^\d+$/.test(revision) || !Number.isSafeInteger(basedOn)) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        SAY.VALIDATION_FAILED.revisionRequired,
        HttpStatus.BAD_REQUEST,
        { field: 'revision' },
      );
    }

    await this.recover(ctx, month);
    const a = await this.production.analyse(ctx, month, upload);
    const sha = createHash('sha256').update(upload!.buffer).digest('hex');

    if (await this.batches.exists(ctx, { month, fileSha256: sha, basedOnRevision: basedOn, status: { $in: WENT_THROUGH } })) {
      throw new DomainException(
        ErrorCode.UPLOAD_BATCH_ALREADY_COMMITTED,
        SAY.UPLOAD_BATCH_ALREADY_COMMITTED.importedAlready,
        HttpStatus.CONFLICT,
        { month },
      );
    }

    this.months.refuseIfLocked(await this.months.state(ctx, month));

    // The corrections to replace, by name. One the file would not change at this revision is refused
    // rather than ignored: it means the screen and the server are not looking at the same preview.
    const conflicts = new Set(a.rows.flatMap((r) => r.cells.filter((c) => writes(c) && c.correction)
      .map((c) => correctionKey(r, c))));
    const ticked = new Set((replace ?? '').split(',').map((k) => k.trim()).filter(Boolean));
    for (const key of ticked) {
      if (!conflicts.has(key)) {
        throw new DomainException(
          ErrorCode.VALIDATION_FAILED,
          SAY.VALIDATION_FAILED.correctionNotInFile,
          HttpStatus.BAD_REQUEST,
          { field: 'replace', key },
        );
      }
    }
    const writesHere = (r: PreviewRow) => (c: PreviewCell) =>
      writes(c) && (!c.correction || ticked.has(correctionKey(r, c)));
    // P19.5-T3 AC-9: a Quant run past its freeze is frozen as it stands, before this file changes a figure.
    await signalBeforeWrite(this.writes, ctx, month);

    const takes = (r: PreviewRow) => (r.status === 'ready' || (r.status === 'held' && this.unregistered !== null)) && r.cells.some(writesHere(r));
    const writable = a.rows.filter(takes);
    const members = writable.filter((r) => r.status === 'ready');
    const heldRows = writable.filter((r) => r.status === 'held');
    if (writable.length === 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        SAY.VALIDATION_FAILED.changesNothing,
        HttpStatus.BAD_REQUEST,
        { month },
      );
    }

    const monthRevision = await this.months.claim(ctx, month, basedOn);
    const stamp = { templateId: a.config.templateId, templateVersion: a.config.version, asOf };

    const batch = await this.batches.create(ctx, {
      month,
      status: 'pending',
      filename: upload!.originalname,
      fileSha256: sha,
      analyticsConfig: { templateId: a.config.templateId, version: a.config.version },
      asOf,
      heldRowCount: heldRows.length,
      format: a.read.format,
      encoding: a.read.encoding,
      delimiter: a.read.delimiter,
      basedOnRevision: basedOn,
      monthRevision,
      rowCount: a.summary.rows,
      writtenRowCount: writable.length,
      cellCount: writable.reduce((n, r) => n + r.cells.filter(writesHere(r)).length, 0),
      issueCount: a.rows.reduce((n, r) => n + r.issues.length, 0),
      keptCorrectionCount: conflicts.size - ticked.size,
      replacedCorrectionCount: ticked.size,
      startedAt: this.clock.now(),
    });
    const batchId = String(batch._id);

    // The undo log, before anything it undoes.
    await Promise.all(a.rows.map((r) => {
      const heldCode = r.status === 'held' ? heldCodeOf(r.agentCode) : null;
      const doc = heldCode ? a.held.get(heldCode) : a.stored.get(r.membershipId ?? '');
      return this.rows.create(ctx, {
        batchId,
        month,
        line: r.line,
        agentCode: r.agentCode,
        membershipId: r.membershipId,
        status: r.status,
        heldAgentCode: heldCode,
        heldRowExisted: heldCode ? a.held.has(heldCode) : false,
        values: takes(r) ? Object.fromEntries(r.cells.filter(writesHere(r)).map((c) => [keyOf(c), c.after as number])) : {},
        previousValues: takes(r) ? previousOf(r, doc as CellHolder | undefined, writesHere(r)) : {},
        issues: r.issues,
      });
    }));

    const cellsOf = (r: PreviewRow) => Object.fromEntries(r.cells.filter(writesHere(r)).map((c) => [
      cellPath(c.kode, c.ytd), { ...EMPTY_CELL, value: c.after, provenance: 'imported', sourceBatchId: batchId },
    ]));
    try {
      for (const r of members) {
        await this.data.upsertOne(ctx, { membershipId: r.membershipId, month }, {
          $set: { ...cellsOf(r), ...stamp },
          $setOnInsert: { agentCode: r.resolvedAgentCode },
        });
      }
      // *Belum terdaftar* (ADR-0214 §8): kept apart, by the code, until a member of the KPM takes it.
      for (const r of heldRows) {
        await this.unregistered!.upsertOne(ctx, { agentCode: heldCodeOf(r.agentCode), month }, {
          $set: { ...cellsOf(r), ...stamp, fileName: r.fileName, sourceBatchId: batchId, status: 'held' },
        });
      }
      await this.months.markWritten(ctx, month, asOf);
      await this.batches.updateById(ctx, batchId, {
        $set: { status: 'committed', committedAt: this.clock.now(), committedBy: ctx.membershipId },
      });
    } catch (err) {
      await this.undo(ctx, batchId, month);
      await this.batches.updateById(ctx, batchId, { $set: { status: 'failed' } });
      throw err;
    }

    await this.audit.record(ctx, {
      action: 'upload.commit',
      targetCollection: 'dataUploadBatches',
      targetId: batchId,
      after: {
        month, filename: upload!.originalname, writtenRowCount: writable.length, heldRowCount: heldRows.length,
        keptCorrectionCount: conflicts.size - ticked.size, replacedCorrectionCount: ticked.size,
        analyticsConfig: { templateId: a.config.templateId, version: a.config.version }, asOf,
      },
    });
    // P18.8-T4 AC-1: everybody this file gave a policy may have had their first sale (ADR-0171 §1).
    await signalSales(this.sales, ctx, members
      .filter((r) => r.membershipId && r.cells.some((c) => writesHere(r)(c) && keyOf(c) === 'POLICY_COUNT' && (c.after as number) > 0))
      .map((r) => r.membershipId as string));
    await signalAfterWrite(this.writes, ctx, month);
    return this.result(ctx, batchId, month);
  }

  /**
   * **Revert.** Every figure the import wrote goes back to exactly what it was — including a figure
   * that was empty, which becomes empty again (AC-2).
   *
   * **Only the month's latest standing import**, so each revert is exact: undoing an earlier one
   * underneath a later one would put back values the later one had already replaced. And a figure
   * something else has written since — a later import, a correction — is left as it is and counted,
   * because the revert is of this import and not of what came after it.
   */
  async revert(ctx: RequestContext, batchId: string): Promise<ImportResult> {
    requireOffice(ctx);
    const found = await this.batches.findById(ctx, batchId);
    if (!found) throw new NotFoundException('Import');
    const month = found.month;

    await this.recover(ctx, month);
    const batch = (await this.batches.findById(ctx, batchId))!;
    if (batch.status !== 'committed') {
      throw new DomainException(
        ErrorCode.UPLOAD_NOTHING_TO_REVERT,
        batch.status === 'reverted'
          ? SAY.UPLOAD_NOTHING_TO_REVERT.reverted
          : SAY.UPLOAD_NOTHING_TO_REVERT.neverCompleted,
        HttpStatus.CONFLICT,
        { batchId, status: batch.status },
      );
    }

    const [latest] = await this.batches.find(ctx, { month, status: 'committed' }, { sort: { monthRevision: -1 }, limit: 1 });
    if (String(latest._id) !== batchId) {
      throw new DomainException(
        ErrorCode.UPLOAD_BATCH_NOT_LATEST,
        SAY.UPLOAD_BATCH_NOT_LATEST.revertThatFirst({ filename: latest.filename }),
        HttpStatus.CONFLICT,
        { batchId, latestBatchId: String(latest._id) },
      );
    }

    const state = await this.months.state(ctx, month);
    this.months.refuseIfLocked(state);
    await signalBeforeWrite(this.writes, ctx, month);
    await this.months.claim(ctx, month, state.revision);

    await this.batches.updateById(ctx, batchId, { $set: { status: 'reverting', startedAt: this.clock.now() } });
    const { restored, kept, policiesRestored } = await this.undo(ctx, batchId, month);
    await this.batches.updateById(ctx, batchId, {
      $set: {
        status: 'reverted', revertedAt: this.clock.now(), revertedBy: ctx.membershipId,
        restoredCellCount: restored, keptCellCount: kept,
      },
    });

    await this.audit.record(ctx, {
      action: 'upload.revert',
      targetCollection: 'dataUploadBatches',
      targetId: batchId,
      before: { status: 'committed' },
      after: { status: 'reverted', restoredCellCount: restored, keptCellCount: kept },
    });
    /*
     * The P18.8 exit review, M4 (ADR-0171 §1 as noted): the policies this file gave are gone, so a first sale read from
     * this month is recomputed from what remains — while the member's 3M result is not kept; a kept one stays.
     */
    await signalSales(this.sales, ctx, policiesRestored);
    await signalAfterWrite(this.writes, ctx, month);
    return this.result(ctx, batchId, month);
  }

  /** Every import of the month that went through, newest first — the history panel (AC-1). */
  async history(ctx: RequestContext, month: string): Promise<History> {
    requireOffice(ctx);
    requireMonth(month);
    const list = await this.batches.find(ctx, { month, status: { $in: WENT_THROUGH } }, { sort: { monthRevision: -1 } });
    return { month, batches: await this.views(ctx, list) };
  }

  /**
   * Finish what a dead process left (AC-7): a `pending` commit is undone and marked `failed`; a
   * `reverting` revert is completed. Only batches older than `STRANDED_AFTER_MINUTES`, so a write
   * still in flight in another request is never undone underneath it.
   *
   * It advances the month's revision like any write, so a preview taken of the half-written month is
   * refused `VERSION_CONFLICT` — correctly: the figures it compared against are not there any more.
   */
  private async recover(ctx: RequestContext, month: string): Promise<void> {
    const cutoff = new Date(this.clock.now().getTime() - PRODUCTION_UPLOAD.STRANDED_AFTER_MINUTES * 60_000);
    const stranded = await this.batches.find(ctx, {
      month, status: { $in: ['pending', 'reverting'] }, startedAt: { $lt: cutoff },
    });
    if (stranded.length === 0) return;

    await this.months.claim(ctx, month, (await this.months.state(ctx, month)).revision);
    for (const batch of stranded) {
      const id = String(batch._id);
      const { restored, kept, policiesRestored } = await this.undo(ctx, id, month);
      await this.batches.updateById(ctx, id, {
        $set: batch.status === 'pending'
          ? { status: 'failed' }
          : { status: 'reverted', revertedAt: this.clock.now(), restoredCellCount: restored, keptCellCount: kept },
      });
      // A revert finished here never signalled its own (M4); a failed commit never signalled at all.
      if (batch.status === 'reverting') await signalSales(this.sales, ctx, policiesRestored);
    }
  }

  /**
   * Put back what a batch wrote, cell by cell, where the cell still holds what it wrote.
   *
   * A cell whose `sourceBatchId` is no longer this batch has been written since, and is kept. `policiesRestored` names
   * the members whose month's policies went back (M4): their first sale may have been read from them.
   */
  private async undo(
    ctx: RequestContext, batchId: string, month: string,
  ): Promise<{ restored: number; kept: number; policiesRestored: string[] }> {
    let restored = 0;
    let kept = 0;
    const policiesRestored: string[] = [];
    const rows = await this.rows.find(ctx, { batchId, $or: [{ membershipId: { $ne: null } }, { heldAgentCode: { $ne: null } }] });
    for (const row of rows) {
      const keys = Object.keys(row.values ?? {});
      if (keys.length === 0) continue;
      const held = row.heldAgentCode ?? null;
      const current = held
        ? (this.unregistered ? await this.unregistered.findOne(ctx, { agentCode: held, month }) : null)
        : await this.data.findOne(ctx, { membershipId: row.membershipId, month });
      if (held && !current) continue;
      const set: Record<string, NonNullable<PreviousValue>> = {};
      for (const key of keys) {
        const { kode, ytd } = parseCellKey(key);
        const cell = cellAsHydrated(((ytd ? current?.ytdValues : current?.values)?.[kode] ?? undefined) as Partial<MetricValue> | undefined);
        if (cell?.sourceBatchId === batchId && !(held && current && (current as { status?: string }).status !== 'held')) {
          set[cellPath(kode, ytd)] = row.previousValues?.[key] ?? EMPTY_CELL;
          restored += 1;
        } else {
          kept += 1;
        }
      }
      if (held) {
        // A held month this import made goes with it (ADR-0214 §8); one it only changed gets its cells back.
        if (!row.heldRowExisted && Object.keys(set).length === keys.length) {
          await this.unregistered!.softDeleteById(ctx, String(current!._id), this.clock.now());
        } else if (Object.keys(set).length > 0) {
          await this.unregistered!.updateMany(ctx, { agentCode: held, month }, { $set: set });
        }
        continue;
      }
      if (Object.keys(set).length > 0) {
        await this.data.updateMany(ctx, { membershipId: row.membershipId, month }, { $set: set });
      }
      if (set[cellPath('POLICY_COUNT', false)]) policiesRestored.push(row.membershipId as string);
    }
    return { restored, kept, policiesRestored };
  }

  /**
   * **The *as of* day of an upload into the current month** (D8; P19.5-T2 AC-9; ADR-0214 §11): a day of the month, no
   * later than today in the KPM's calendar, today when none is given. An upload into a month that has ended is its final
   * upload, and carries none. `400 VALIDATION_FAILED` for a day outside the month or after today.
   */
  private async asOfFor(ctx: RequestContext, month: string, given: string | undefined): Promise<string | null> {
    const office = this.kpms ? await this.kpms.findById(ctx.kpmId).select('timezone').lean().exec() as { timezone?: string } | null : null;
    const today = this.clock.localDateFor(office?.timezone ?? DEFAULT_TENANT_TIMEZONE);
    if (month !== today.slice(0, 7)) return null;
    const day = given === undefined || given === '' ? today : given;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day.slice(0, 7) !== month || day > today) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED, SAY.VALIDATION_FAILED.asOfOutsideMonth, HttpStatus.BAD_REQUEST, { field: 'asOf', asOf: given },
      );
    }
    return day;
  }

  private async result(ctx: RequestContext, batchId: string, month: string): Promise<ImportResult> {
    const [history, state] = await Promise.all([this.history(ctx, month), this.months.state(ctx, month)]);
    return { batch: history.batches.find((b) => b.id === batchId)!, state };
  }

  private async views(ctx: RequestContext, list: DataUploadBatchDocument[]): Promise<BatchView[]> {
    const people = [...new Set(list.flatMap((b) => [b.committedBy, b.revertedBy]).filter((x): x is string => !!x))];
    const names = await this.names.byMembershipId(ctx, people);
    const latest = list.find((b) => b.status === 'committed');
    return list.map((b) => ({
      id: String(b._id),
      month: b.month,
      filename: b.filename,
      status: b.status,
      templateVersion: b.analyticsConfig?.version ?? 1,
      asOf: b.asOf ?? null,
      heldRowCount: b.heldRowCount ?? 0,
      rowCount: b.rowCount,
      writtenRowCount: b.writtenRowCount,
      cellCount: b.cellCount,
      issueCount: b.issueCount,
      committedAt: b.committedAt ? b.committedAt.toISOString() : null,
      committedBy: b.committedBy ? names.get(b.committedBy) || null : null,
      revertedAt: b.revertedAt ? b.revertedAt.toISOString() : null,
      revertedBy: b.revertedBy ? names.get(b.revertedBy) || null : null,
      restoredCellCount: b.restoredCellCount ?? 0,
      keptCellCount: b.keptCellCount ?? 0,
      keptCorrectionCount: b.keptCorrectionCount ?? 0,
      replacedCorrectionCount: b.replacedCorrectionCount ?? 0,
      canRevert: b.status === 'committed' && b === latest,
    }));
  }
}

/** A row that holds cells by kode: a member's month, or a held code's. */
type CellHolder = { values?: Record<string, unknown>; ytdValues?: Record<string, unknown> };

/** What each figure a row writes held a moment before — the whole cell, provenance and source included. */
function previousOf(
  row: PreviewRow,
  stored: CellHolder | undefined,
  written: (c: PreviewCell) => boolean,
): Record<string, PreviousValue> {
  return Object.fromEntries(row.cells.filter(written).map((c) => {
    const cell = cellAsHydrated(((c.ytd ? stored?.ytdValues : stored?.values)?.[c.kode] ?? undefined) as Partial<MetricValue> | undefined);
    return [keyOf(c), stored ? {
      value: cell?.value ?? null,
      provenance: cell?.provenance ?? null,
      sourceBatchId: cell?.sourceBatchId ?? null,
      correctedBy: cell?.correctedBy ?? null,
      correctedAt: cell?.correctedAt ?? null,
      reason: cell?.reason ?? null,
      replacedValue: cell?.replacedValue ?? null,
    } : null];
  }));
}
