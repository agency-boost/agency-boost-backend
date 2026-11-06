import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock, SystemClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, NotFoundException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ANALYTICS_MAA_INPUTS, DEFAULT_TENANT_TIMEZONE, LEADER_CLASSES } from '@/domain/constants';
import { monthlyActiveAgent } from '@/domain/metrics/monthly-active-agent';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Kpm } from '@/modules/tenants/kpm.schema';
import { AnalyticsConfigReader, type PublishedAnalyticsConfig } from '@/modules/config/analytics-config.reader';
import { agentCodePattern, platformAnalyticsConfig, type UploadField } from '@/modules/config/analytics-config';
import { MonthlyAgentDataRepository } from './monthly-agent-data.repository';
import { cellAsHydrated, type MetricValue, type MonthlyAgentDataDocument, type Provenance } from './monthly-agent-data.schema';
import {
  buildPreview, layoutOf, previewColumnOf, readFileUpload, type PreviewCell, type PreviewColumn, type PreviewNote,
  type PreviewRow, type PreviewSummary, type ReadUpload, type StoredFigures, type UploadFormat, heldCodeOf,
} from './production-preview';
import type { UploadDelimiter, UploadEncoding } from './production-csv';
import { templateBody, templateFilename, templateHeader } from './production-template';
import { templateWorkbook } from './production-workbook';
import type { FileUpload } from './production-upload.interceptor';
import { type MonthState, ProductionMonths } from './production-months.service';
import { requireMonth, requireOffice } from './production-guards';
import { orgTreeOrder } from './production-roster-order';
import { readCell, sumCell } from './production-readings';
import { PRODUCTION_REFUSALS } from './production.messages';
import { inForce, outsideLimits } from './upload-columns';
import {
  missingMonthsOf, monthsBetween, shiftMonth, UploadCompleteness, type MonthFill, type MonthFillStatus,
} from './upload-completeness';
import { UnregisteredAgentDataRepository } from './unregistered-agent-data.repository';
import type { UnregisteredAgentDataDocument } from './unregistered-agent-data.schema';

export { requireMonth, requireOffice };

/** One figure on the wire: what it is, and which writer put it there. */
export interface MetricCell {
  value: number | null;
  provenance: Provenance | null;
  /**
   * A correction by hand, said without a second request (P9-T6 AC-1): who, by name, when and why.
   * `null` for every other cell. A figure somebody **emptied** by hand keeps this and `corrected`,
   * with a `null` value — nothing is held, and the table can say who decided that.
   */
  correction: { by: string | null; at: string | null; reason: string | null } | null;
  /**
   * **A stored value outside its column's current limits** (P19.5-T2 AC-11; AA UI-025; ADR-0214 §12): the version since
   * which it has been — *"Di luar batas sejak v<n>"*. Flagged, never changed; `null` within them.
   */
  outOfBounds: { sinceVersion: number } | null;
}

/**
 * **A column's year to date** (P19.5-T2 AC-7; R4; ADR-0214 §10): for a `ytd: 'sum'` column, `COLUMN_YEAR_TO_DATE` — the
 * month's and every earlier month's of the year added, computed now and never stored; for a `ytd: 'upload'` column, the
 * figure the file gave. *Belum lengkap* is the column's `ytdMissingMonths`.
 */
export interface YtdCell extends Omit<MetricCell, 'outOfBounds'> {
  /** `true` for a summed year to date, which nobody types; `false` for an uploaded one, which may be corrected. */
  calculated: boolean;
}

/** One agent's row: each column's figure for the month, and each year to date, by kode. */
export interface MonthRow {
  membershipId: string;
  agentCode: string;
  name: string;
  /** This month's figure per current column (`config.columns`), by kode. A column not in force reads empty. */
  values: Record<string, MetricCell>;
  /** The year to date per column whose `ytd` is not `none`, by kode. */
  ytd: Record<string, YtdCell>;
  /** A member of a leader class (`ab`, `aab`; ADR-0156): the rows a `rows: 'leaders'` column is filled on (P19.3-T1). */
  leader: boolean;
  /**
   * `MONTHLY_ACTIVE_AGENT` for the month (ADR-0054; ADR-0214 §6): `APE` or `POLICY_COUNT` above zero. **`null` is not
   * `false`** — it is *not reported*, and the table draws a dash for it.
   */
  monthlyActiveAgent: boolean | null;
}

/** A *Belum terdaftar* row (ADR-0214 §8): a code no member holds yet, read-only, counted in nothing. */
export interface UnregisteredRow {
  agentCode: string;
  /** The name the file gave. */
  fileName: string;
  values: Record<string, MetricCell>;
  ytd: Record<string, YtdCell>;
}

/** A column of the KPM's template, as the month read names it (ADR-0214 §14). */
export interface MonthColumn {
  kode: string;
  system: boolean;
  label: { id: string; en: string };
  unit: UploadField['unit'];
  ytd: UploadField['ytd'];
  min: number | null;
  max: number | null;
  required: boolean;
  rows: UploadField['rows'];
  effectiveFrom: string;
  tip: { id: string; en: string };
  /** `effectiveFrom` is on or before the month (R2): before it the column shows *—* and asks nothing. */
  inForce: boolean;
  /**
   * The months its year to date lacks (R4): each month from the later of January, its `effectiveFrom` and the history's
   * start, to this one, that is not complete. Empty is complete; `[]` too for a column with no YTD.
   */
  ytdMissingMonths: string[];
}

/** The KPM's *Advanced analytics* configuration, as the month read names it (ADR-0214 §14). */
export interface MonthConfig {
  templateId: string | null;
  templateName: string | null;
  version: number;
  /** The template's current columns, in the file's order. */
  columns: MonthColumn[];
  /** The required history's first month (R5): twelve months before the KPM's first. The month grid starts here. */
  historyFrom: string;
  /** The KPM's first month on AgencyBoost: the month of its creation, in its zone (UI-150). */
  firstMonth: string;
  /** % of members filled for a month to be complete (`UPLOAD_MONTH_COMPLETE`). */
  completePct: number;
}

/** A month as complete or not (`UPLOAD_MONTH_COMPLETE`), for the month grid (AA UI-010, UI-016). */
export interface MonthStatus {
  month: string;
  status: MonthFillStatus;
  /** Members on the month's last day, and those of them filled in every column in force. */
  members: number;
  filled: number;
}

export interface MonthView {
  month: string;
  rows: MonthRow[];
  /** *Belum terdaftar* rows held for the month (ADR-0214 §8), after the members. */
  unregistered: UnregisteredRow[];
  /** How many of the rows hold at least one figure. Zero is *nothing uploaded yet*. */
  withData: number;
  /** Open or locked, and why; and the revision a preview of this month will carry (P9-T4). */
  state: MonthState;
  /** **The template the columns follow** (P19.5-T1 AC-17, P19.5-T2; ADR-0214 §14), read live. */
  config: MonthConfig;
  /** This month, as complete or not. */
  completeness: MonthStatus;
  /** The months any year-to-date column lacks — the banner's *"YTD belum lengkap: <Bul> <tahun> belum diunggah."* */
  ytdMissingMonths: string[];
  /** Every month from `config.historyFrom` to the KPM's current month, each as complete or not (the month grid). */
  months: MonthStatus[];
}

/** The file to download, and enough about it to name and to validate it. */
export interface TemplateFile {
  month: string;
  /** The template's published version the header follows (R6). */
  version: number;
  filename: string;
  header: string[];
  /** The whole file: the header, then one row per active agent with an empty field per value column. */
  file: string;
  /** How many agents it lists — what the operator will be filling in. */
  rowCount: number;
}

/** What a filled file would change, before anything does (P9-T3). Nothing is stored. */
export interface UploadPreview {
  month: string;
  /** The name the file had on the reader's machine — for them to recognise, never trusted. */
  filename: string;
  /** The template's published version the file was read against (R6). */
  templateVersion: number;
  /** The same, with its template (ADR-0214 §9): what a commit of this preview stamps. */
  analyticsConfig: { templateId: string | null; version: number };
  /** A CSV, or an Excel workbook (ADR-0184). */
  format: UploadFormat;
  encoding: UploadEncoding;
  delimiter: UploadDelimiter;
  /** The month's revision the preview was taken against. Confirm import sends it back (P9-T4). */
  revision: number;
  /** The columns read, in the template's order: each row's `cells` follow them. */
  columns: PreviewColumn[];
  /** What the file's header says about its columns: missing, retired, unknown, not yet in force (AA UI-013). */
  notes: PreviewNote[];
  summary: PreviewSummary;
  rows: PreviewRow[];
}

/** A file read against the roster and what is stored — what a preview shows and a commit writes. */
export interface Analysis {
  read: ReadUpload;
  config: PublishedAnalyticsConfig;
  stored: Map<string, MonthlyAgentDataDocument>;
  /** The month's held rows, by their normalised code. */
  held: Map<string, UnregisteredAgentDataDocument>;
  columns: PreviewColumn[];
  notes: PreviewNote[];
  rows: PreviewRow[];
  summary: PreviewSummary;
}

const EMPTY: MetricCell = { value: null, provenance: null, correction: null, outOfBounds: null };

/** A member as the table and the template both list them. */
interface RosterEntry {
  membershipId: string;
  agentCode: string;
  name: string;
  /** Of a leader class, `ab` or `aab` (ADR-0156): who a leaders' column is filled for (P19.3-T1). */
  leader: boolean;
}

/**
 * The office's production, month by month (P9-T1) — **in the columns of the KPM's template** since P19.5-T2 (ADR-0214
 * §5, §10 to §12).
 *
 * **Every active member is a row, whether or not anything has been uploaded for them.** The table
 * answers *what does the office know about each person this month*, and *nothing* is an answer:
 * a row of `null` cells says the carrier has not reported this person, where a missing row would
 * say the person is not here. The prototype's template does the same — one row per agent.
 *
 * **The columns are the template's, read live** (`AnalyticsConfigReader.publishedFor`, ADR-0214 §3): the month read,
 * the file, the preview and the commit all read the same version.
 */
@Injectable()
export class ProductionService {
  constructor(
    private readonly data: MonthlyAgentDataRepository,
    private readonly memberships: MembershipRepository,
    private readonly names: MemberNames,
    /**
     * Read by `_id` from the context, the way `ActivityService` reads it. The office's own row is the
     * one document a tenant-scoped service may reach without the tenant repository, because the
     * scope *is* the id.
     */
    @InjectModel(Kpm.name) private readonly kpms: Model<Kpm>,
    private readonly months: ProductionMonths,
    /**
     * The template the KPM's columns follow, read live (P19.5-T1; ADR-0214 §3). `@Optional` for the specs that build
     * this by hand; without it the KPM reads the platform's own configuration.
     */
    @Optional() private readonly analytics?: AnalyticsConfigReader,
    @Optional() private readonly completeness?: UploadCompleteness,
    @Optional() private readonly unregistered?: UnregisteredAgentDataRepository,
    @Optional() private readonly clock?: Clock,
  ) {}

  /** The configuration the KPM reads now: its template's published version, or the platform's. */
  async configFor(ctx: RequestContext): Promise<PublishedAnalyticsConfig> {
    return this.analytics
      ? this.analytics.publishedFor(ctx)
      : { templateId: null, templateName: null, version: 1, config: platformAnalyticsConfig() };
  }

  async readMonth(ctx: RequestContext, month: string): Promise<MonthView> {
    requireOffice(ctx);
    requireMonth(month);

    const config = await this.configFor(ctx);
    const fields = config.config.uploadFields;
    const roster = await this.roster(ctx);
    const ids = roster.map((r) => r.membershipId);

    // The year's rows, for the year to date: each member's months from January to this one.
    const january = `${month.slice(0, 4)}-01`;
    const yearRows = await this.data.find(ctx, { month: { $gte: january, $lte: month }, membershipId: { $in: ids } });
    const byMember = new Map<string, MonthlyAgentDataDocument[]>();
    for (const row of yearRows) byMember.set(row.membershipId, [...(byMember.get(row.membershipId) ?? []), row]);

    // The month grid, this month's status, and each column's missing months: one read of the office's months.
    const today = await this.officeMonth(ctx);
    const office = this.completeness ? await this.completeness.office(ctx) : null;
    const firstMonth = office ? (office.firstMonth < today ? office.firstMonth : today) : today;
    const fill = this.completeness
      ? await this.completeness.forRange(
        ctx, rangeOf(month, today, shiftMonth(firstMonth, -config.config.uploadRules.historyMonthsBeforeJoin)), config,
      )
      : null;
    const historyFrom = fill?.historyFrom ?? shiftMonth(today, -12);
    const fills = fill?.fills ?? new Map<string, MonthFill>();

    // Who corrected what, by name — resolved once for the month, so every cell can say it.
    const correctors = [...new Set(yearRows.flatMap((row) => [
      ...Object.values(row.values ?? {}).map((c) => (c as MetricValue | undefined)?.correctedBy),
      ...Object.values(row.ytdValues ?? {}).map((c) => (c as MetricValue | undefined)?.correctedBy),
    ]).filter((x): x is string => !!x))];
    const names = correctors.length ? await this.names.byMembershipId(ctx, correctors) : new Map<string, string>();
    const history = this.analytics ? await this.analytics.uploadFieldsHistoryFor(ctx) : [{ version: config.version, uploadFields: fields }];

    const cellsOf = (rows: readonly { month: string; values?: Record<string, unknown>; ytdValues?: Record<string, unknown> }[]) => {
      const own = rows.find((r) => r.month === month);
      const values: Record<string, MetricCell> = {};
      const ytd: Record<string, YtdCell> = {};
      for (const field of fields) {
        const stored = cellAsHydrated((own?.values?.[field.kode] ?? undefined) as Partial<MetricValue> | undefined);
        values[field.kode] = inForce(field, month) ? withBounds(cellOf(stored, names), stored, field.kode, history) : EMPTY;
        if (field.ytd === 'sum') {
          // `COLUMN_YEAR_TO_DATE`: every month held, January to this one — the same sum every reader of it reads.
          const months = rows.filter((r) => r.month <= month).map((r) => ({
            month: r.month, cell: cellAsHydrated((r.values?.[field.kode] ?? undefined) as Partial<MetricValue> | undefined),
          }));
          ytd[field.kode] = { ...cellOf(asMetric(sumCell(months)), names), calculated: true };
        } else if (field.ytd === 'upload') {
          const up = cellAsHydrated((own?.ytdValues?.[field.kode] ?? undefined) as Partial<MetricValue> | undefined);
          ytd[field.kode] = { ...cellOf(inForce(field, month) ? up : null, names), calculated: false };
        }
      }
      return { values, ytd };
    };

    const view = roster.map((r): MonthRow => {
      const { values, ytd } = cellsOf(byMember.get(r.membershipId) ?? []);
      const [apeKode, policyKode] = ANALYTICS_MAA_INPUTS;
      return {
        ...r,
        values,
        ytd,
        monthlyActiveAgent: monthlyActiveAgent(values[apeKode]?.value ?? null, values[policyKode]?.value ?? null),
      };
    });

    const heldRows = this.unregistered
      ? await this.unregistered.find(ctx, { month: { $gte: january, $lte: month }, status: 'held' })
      : [];
    const heldByCode = new Map<string, UnregisteredAgentDataDocument[]>();
    for (const row of heldRows) heldByCode.set(row.agentCode, [...(heldByCode.get(row.agentCode) ?? []), row]);
    const unregistered = [...heldByCode.entries()]
      .filter(([, rows]) => rows.some((r) => r.month === month))
      .map(([agentCode, rows]): UnregisteredRow => ({
        agentCode,
        fileName: rows.find((r) => r.month === month)?.fileName ?? '',
        ...cellsOf(rows),
      }))
      .sort((a, b) => a.agentCode.localeCompare(b.agentCode));

    const columns = fields.map((field): MonthColumn => ({
      kode: field.kode,
      system: field.system,
      label: { ...field.label },
      unit: field.unit,
      ytd: field.ytd,
      min: field.min,
      max: field.max,
      required: field.required,
      rows: field.rows,
      effectiveFrom: field.effectiveFrom,
      tip: { ...field.tip },
      inForce: inForce(field, month),
      ytdMissingMonths: field.ytd === 'sum' && fill ? missingMonthsOf(field, month, historyFrom, fills) : [],
    }));
    const statusOf = (m: string): MonthStatus => {
      const f = fills.get(m);
      return { month: m, status: f?.status ?? 'missing', members: f?.members ?? 0, filled: f?.filled ?? 0 };
    };
    const lastGridMonth = month > today ? month : today;

    return {
      month,
      rows: view,
      unregistered,
      withData: view.filter((r) => hasAnyFigure(r)).length,
      state: await this.months.state(ctx, month),
      config: {
        templateId: config.templateId,
        templateName: config.templateName,
        version: config.version,
        columns,
        historyFrom,
        firstMonth: fill?.firstMonth ?? today,
        completePct: config.config.uploadRules.completePct,
      },
      completeness: statusOf(month),
      ytdMissingMonths: [...new Set(columns.flatMap((c) => c.ytdMissingMonths))].sort(),
      months: fill ? monthsBetween(historyFrom < month ? historyFrom : month, lastGridMonth).map(statusOf) : [],
    };
  }

  /** The KPM's current month, in its zone. */
  private async officeMonth(ctx: RequestContext): Promise<string> {
    const office = await this.kpms.findById(ctx.kpmId).select('timezone').lean().exec() as { timezone?: string } | null;
    // The injected clock; the system's where this was built by hand without one.
    return (this.clock ?? new SystemClock()).localDateFor(office?.timezone ?? DEFAULT_TENANT_TIMEZONE).slice(0, 7);
  }

  /**
   * The file for a month: the header of the KPM's template (P19.5-T2 AC-1; ADR-0214 §5), and one row per active agent.
   *
   * **Listed from the roster, not from the month's rows.** The template is for the file that will
   * *create* the month's rows, so it has to name everybody the carrier could report on — which is
   * the same list the table shows, for the same reason (I-125), and in the same order (P13.1-T7).
   */
  async template(ctx: RequestContext, month: string): Promise<TemplateFile> {
    const { code, roster } = await this.templateRows(ctx, month);
    const config = await this.configFor(ctx);
    const header = templateHeader(config.config, ctx.reader.language);
    return {
      month,
      version: config.version,
      filename: templateFilename(code, month),
      header,
      file: templateBody(header, roster),
      rowCount: roster.length,
    };
  }

  /**
   * **The same file as an Excel workbook** (ADR-0184): the same header and the same rows on its *Data* sheet, and the
   * guide on its own sheet, in the reader's language — a row per column of the template. Named as the CSV is, `.xlsx`.
   */
  async workbook(ctx: RequestContext, month: string): Promise<{ filename: string; bytes: Buffer }> {
    const { code, roster } = await this.templateRows(ctx, month);
    const config = await this.configFor(ctx);
    return {
      filename: templateFilename(code, month, 'xlsx'),
      bytes: await templateWorkbook(config.config, roster, month, ctx.reader),
    };
  }

  /** The office's code, which names the file, and the people it lists. */
  private async templateRows(ctx: RequestContext, month: string): Promise<{ code: string; roster: RosterEntry[] }> {
    requireOffice(ctx);
    requireMonth(month);

    const [office, roster] = await Promise.all([
      this.kpms.findById(ctx.kpmId).select('code').lean().exec(),
      this.roster(ctx),
    ]);
    if (!office) throw new NotFoundException('Kpm');
    return { code: (office as { code: string }).code, roster };
  }

  /**
   * A filled file, read and checked against the KPM's template, the roster and what is stored (P9-T3; P19.5-T2).
   *
   * **Writes nothing.** The preview exists in this response and nowhere else, which is what makes it
   * transient and the uploader's alone (AC-8).
   *
   * File-level refusals throw — an unreadable file, a file with no agent code or no column read. Everything about one
   * row or one cell is reported inside the preview, and the rest of the file still previews.
   */
  async preview(ctx: RequestContext, month: string, upload: FileUpload | undefined): Promise<UploadPreview> {
    requireOffice(ctx);
    requireMonth(month);
    // The revision first, the figures second: a write between the two leaves the preview carrying
    // the older revision, and its commit is refused — never a diff against figures it did not see.
    const { revision } = await this.months.state(ctx, month);
    const a = await this.analyse(ctx, month, upload);
    return {
      month,
      filename: upload!.originalname,
      templateVersion: a.config.version,
      analyticsConfig: { templateId: a.config.templateId, version: a.config.version },
      format: a.read.format,
      encoding: a.read.encoding,
      delimiter: a.read.delimiter,
      revision,
      columns: a.columns,
      notes: a.notes,
      summary: a.summary,
      rows: a.rows,
    };
  }

  /**
   * The file against the template, the roster and what is stored: the preview's substance, and what a commit writes
   * (P9-T4 reads it again rather than trusting the browser's copy of the preview).
   */
  async analyse(ctx: RequestContext, month: string, upload: FileUpload | undefined): Promise<Analysis> {
    requireOffice(ctx);
    requireMonth(month);
    if (!upload) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        PRODUCTION_REFUSALS.VALIDATION_FAILED.attachFile,
        HttpStatus.BAD_REQUEST,
        { field: 'file' },
      );
    }

    const read = await readFileUpload(upload.buffer);
    const config = await this.configFor(ctx);
    const layout = layoutOf(read.header, config.config, month, ctx.reader);
    const roster = await this.roster(ctx);
    const previous = shiftMonth(month, -1);
    const rows = await this.data.find(ctx, { month: { $in: [month, previous] }, membershipId: { $in: roster.map((r) => r.membershipId) } });
    const stored = new Map(rows.filter((r) => r.month === month).map((r) => [r.membershipId, r]));
    const before = new Map(rows.filter((r) => r.month === previous).map((r) => [r.membershipId, r]));
    const heldRows = this.unregistered
      ? await this.unregistered.find(ctx, { month: { $in: [month, previous] }, status: 'held' })
      : [];
    const held = new Map(heldRows.filter((r) => r.month === month).map((r) => [r.agentCode, r]));
    const heldBefore = new Map(heldRows.filter((r) => r.month === previous).map((r) => [r.agentCode, r]));

    const kodes = config.config.uploadFields.map((f) => f.kode);
    const numbers = (cells: Record<string, unknown> | undefined) => Object.fromEntries(kodes.map((k) => [
      k, readCell(cellAsHydrated((cells?.[k] ?? undefined) as Partial<MetricValue> | undefined)).value,
    ]));
    const figuresOf = (
      row: { values?: Record<string, unknown>; ytdValues?: Record<string, unknown> } | undefined,
      last: { ytdValues?: Record<string, unknown> } | undefined,
    ): StoredFigures => ({ values: numbers(row?.values), ytdValues: numbers(row?.ytdValues), previousYtd: numbers(last?.ytdValues) });

    const compiled = agentCodePattern(config.config.uploadRules.agentCodePattern);
    // Each issue in the reader's words: a preview answers them, and a commit keeps its issues in them (P18.10-T5).
    const preview = buildPreview({
      records: read.records,
      delimiter: read.delimiter,
      header: read.header,
      layout,
      month,
      roster,
      stored: (membershipId) => figuresOf(stored.get(membershipId), before.get(membershipId)),
      heldStored: (code) => figuresOf(held.get(code), heldBefore.get(code)),
      rules: {
        pattern: 'pattern' in compiled ? compiled.pattern : null,
        example: config.config.uploadRules.agentCodeExample,
        unknownAgent: config.config.uploadRules.unknownAgent,
        ytdTolerancePct: config.config.uploadRules.ytdTolerancePct,
      },
    }, ctx.reader);

    // Which of the figures the file would change were corrected by hand (ADR-0053). `buildPreview`
    // sees numbers only; the stored cells say who corrected what, and why.
    const flagged: { cell: PreviewCell; by: string | null }[] = [];
    for (const row of preview.rows) {
      const doc = row.status === 'held' ? held.get(heldCodeOf(row.agentCode)) : stored.get(row.membershipId ?? '');
      for (const cell of row.cells) {
        if (cell.status !== 'new' && cell.status !== 'changed') continue;
        const heldCell = cellAsHydrated(((cell.ytd ? doc?.ytdValues : doc?.values)?.[cell.kode] ?? undefined) as Partial<MetricValue> | undefined);
        if (heldCell?.provenance !== 'corrected') continue;
        cell.correction = {
          by: null,
          at: heldCell.correctedAt ? new Date(heldCell.correctedAt).toISOString() : null,
          reason: heldCell.reason ?? null,
          replacedValue: heldCell.replacedValue ?? null,
        };
        flagged.push({ cell, by: heldCell.correctedBy ?? null });
      }
    }
    if (flagged.length) {
      const names = await this.names.byMembershipId(ctx, [...new Set(flagged.map((f) => f.by).filter((x): x is string => !!x))]);
      for (const f of flagged) f.cell.correction!.by = f.by ? names.get(f.by) || null : null;
    }
    preview.summary.correctionCells = flagged.length;
    return {
      read,
      config,
      stored,
      held,
      columns: layout.columns.map((c) => previewColumnOf(c, ctx.reader.language)),
      notes: layout.notes,
      ...preview,
    };
  }

  /**
   * Everybody here now, with the code and the name, **in the order the org tree reads** (P13.1-T7).
   *
   * Pending members have registered and nothing more; a removed one is not here. Both are the
   * directory's own rule, and both the table and the template follow it — **in one order**, because
   * both are built from this list: the file an operator fills in lists the people in the order the
   * screen shows them.
   *
   * **The order is the prototype's walk** (`orgTreeOrder`): each AB, their AABs each followed by
   * their agents, then the AB's own agents. It reads each member's **current edge** — the membership's
   * `leaderId`, which the org module writes with the open history row (`validTo: null`) and which the
   * org tree reads too.
   */
  private async roster(ctx: RequestContext): Promise<RosterEntry[]> {
    const members = await this.memberships.find(
      ctx, { status: 'active' }, { sort: { agentSeq: 1 } },
    );
    const ids = members.map((m) => String(m._id));
    const names = await this.names.byMembershipId(ctx, ids);
    const placed = orgTreeOrder(members.map((m) => {
      const id = String(m._id);
      return {
        membershipId: id,
        agentCode: (m as { agentCode?: string }).agentCode ?? '',
        name: names.get(id) ?? '',
        role: m.role ?? null,
        leaderId: m.leaderId ?? null,
        agentSeq: m.agentSeq,
      };
    }));
    // A leader row is a member of a leader class on the upload, by their rung's tier (ADR-0156): who a leaders' column
    // is filled for (P19.3-T1, ADR-0201 §2).
    return placed.map(({ membershipId, agentCode, name, role }) => ({
      membershipId, agentCode, name, leader: (LEADER_CLASSES as readonly string[]).includes(role ?? ''),
    }));
  }
}

/** The months the month read reads: the history's start or January, whichever is first, to this month or today. */
function rangeOf(month: string, today: string, historyFrom: string): { from: string; to: string } {
  const january = `${month.slice(0, 4)}-01`;
  return { from: historyFrom < january ? historyFrom : january, to: month > today ? month : today };
}

/** A summed cell as a stored one, for `cellOf`. */
function asMetric(cell: ReturnType<typeof sumCell>): MetricValue | null {
  if (cell.value === null && cell.provenance === null) return null;
  return {
    value: cell.value, provenance: cell.provenance, sourceBatchId: null, correctedBy: cell.correctedBy,
    correctedAt: cell.correctedAt, reason: cell.reason, replacedValue: null,
  };
}

/**
 * **"Di luar batas sejak v<n>"** (AA UI-025; ADR-0214 §12): a stored value outside its column's current limits is
 * flagged with the version from which every version since has excluded it. Never changed.
 */
function withBounds(
  cell: MetricCell, stored: MetricValue | null, kode: string, history: readonly { version: number; uploadFields: UploadField[] }[],
): MetricCell {
  if (cell.value === null || !stored || stored.value === null) return cell;
  let since: number | null = null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const field = history[i].uploadFields.find((f) => f.kode === kode);
    if (!field || !outsideLimits(field, stored.value)) break;
    since = history[i].version;
  }
  return since === null ? cell : { ...cell, outOfBounds: { sinceVersion: since } };
}

/** A stored cell on the wire. `names` resolves who corrected it. */
function cellOf(stored: MetricValue | null | undefined, names: ReadonlyMap<string, string>): MetricCell {
  // Nothing held, and nobody decided it: empty. A figure emptied **by hand** is not this case (`readCell`).
  const cell = readCell(stored);
  if (cell.value === null && cell.provenance !== 'corrected') return EMPTY;
  return {
    value: cell.value,
    provenance: cell.provenance,
    correction: cell.provenance === 'corrected'
      ? {
        by: cell.correctedBy ? names.get(cell.correctedBy) || null : null,
        at: cell.correctedAt ? new Date(cell.correctedAt).toISOString() : null,
        reason: cell.reason,
      }
      : null,
    outOfBounds: null,
  };
}

function hasAnyFigure(row: MonthRow): boolean {
  return Object.values(row.values).some((c) => c.value !== null);
}
