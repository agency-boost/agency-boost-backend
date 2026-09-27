import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, NotFoundException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Kpm } from '@/modules/tenants/kpm.schema';
import { MonthlyAgentDataRepository } from './monthly-agent-data.repository';
import {
  MetricValue, MonthlyAgentDataDocument, PRODUCTION_METRICS, type ProductionMetric, type Provenance,
} from './monthly-agent-data.schema';
import {
  buildPreview, type PreviewCell, type PreviewRow, type PreviewSummary, readUpload, type StoredFigures,
} from './production-preview';
import type { UploadDelimiter, UploadEncoding } from './production-csv';
import {
  TEMPLATE_HEADER_V1, TEMPLATE_VERSION, templateBody, templateFilename,
} from './production-template';
import type { UploadedCsv } from './production-upload.interceptor';
import { type MonthState, ProductionMonths } from './production-months.service';
import type { ReadUpload } from './production-preview';
import { requireMonth, requireOffice } from './production-guards';

export { requireMonth, requireOffice };

/** One figure on the wire: what it is, and which writer put it there. */
export interface MetricCell {
  value: number | null;
  provenance: Provenance | null;
}

/** One agent's row: the two cadences of each of the six metrics. */
export interface MonthRow {
  membershipId: string;
  agentCode: string;
  name: string;
  metrics: Record<ProductionMetric, { monthly: MetricCell; ytd: MetricCell }>;
}

export interface MonthView {
  month: string;
  rows: MonthRow[];
  /** How many of the rows hold at least one figure. Zero is *nothing uploaded yet*. */
  withData: number;
  /** Open or locked, and why; and the revision a preview of this month will carry (P9-T4). */
  state: MonthState;
}

/** The file to download, and enough about it to name and to validate it. */
export interface TemplateFile {
  month: string;
  version: number;
  filename: string;
  header: string[];
  /** The whole file: the header, then one row per active agent with twelve empty fields. */
  file: string;
  /** How many agents it lists — what the operator will be filling in. */
  rowCount: number;
}

/** What a filled file would change, before anything does (P9-T3). Nothing is stored. */
export interface UploadPreview {
  month: string;
  /** The name the file had on the reader's machine — for them to recognise, never trusted. */
  filename: string;
  templateVersion: number;
  encoding: UploadEncoding;
  delimiter: UploadDelimiter;
  /** The month's revision the preview was taken against. Confirm import sends it back (P9-T4). */
  revision: number;
  summary: PreviewSummary;
  rows: PreviewRow[];
}

/** A file read against the roster and what is stored — what a preview shows and a commit writes. */
export interface Analysis {
  read: ReadUpload;
  stored: Map<string, MonthlyAgentDataDocument>;
  rows: PreviewRow[];
  summary: PreviewSummary;
}

const EMPTY: MetricCell = { value: null, provenance: null };

/** A member as the table and the template both list them. */
interface RosterEntry {
  membershipId: string;
  agentCode: string;
  name: string;
}

/**
 * The office's production, month by month (P9-T1).
 *
 * **This task reads; the tasks after it write.** The month table is the surface every later task
 * builds on — the template lists its rows, the preview diffs against it, a commit fills it, a
 * correction changes one cell of it — so it exists first, empty, which is the honest state before an
 * upload and is itself worth seeing.
 *
 * **Every active member is a row, whether or not anything has been uploaded for them.** The table
 * answers *what does the office know about each person this month*, and *nothing* is an answer:
 * a row of `null` cells says the carrier has not reported this person, where a missing row would
 * say the person is not here. The prototype's template does the same — one row per agent, twelve
 * empty fields.
 *
 * **Nothing here is derived.** The prototype paints an *Active (MAA)* column from these cells, and
 * it is the third competing definition of *active agent* in the product (OD-21). This service hands
 * back the cells and their provenance and computes nothing from them, so a definition is not shipped
 * before it is decided (invariant §8).
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
  ) {}

  async readMonth(ctx: RequestContext, month: string): Promise<MonthView> {
    requireOffice(ctx);
    requireMonth(month);

    const roster = await this.roster(ctx);
    const ids = roster.map((r) => r.membershipId);
    const rows = await this.data.find(ctx, { month, membershipId: { $in: ids } });
    const byMember = new Map(rows.map((r) => [r.membershipId, r]));

    const view = roster.map((r): MonthRow => ({ ...r, metrics: metricsOf(byMember.get(r.membershipId)) }));

    return {
      month,
      rows: view,
      withData: view.filter((r) => hasAnyFigure(r)).length,
      state: await this.months.state(ctx, month),
    };
  }

  /**
   * The file for a month: the header that is the contract, and one row per active agent (P9-T2).
   *
   * **Listed from the roster, not from the month's rows.** The template is for the file that will
   * *create* the month's rows, so it has to name everybody the carrier could report on — which is
   * the same list the table shows, for the same reason (I-125).
   */
  async template(ctx: RequestContext, month: string): Promise<TemplateFile> {
    requireOffice(ctx);
    requireMonth(month);

    const [office, roster] = await Promise.all([
      this.kpms.findById(ctx.kpmId).select('code').lean().exec(),
      this.roster(ctx),
    ]);
    if (!office) throw new NotFoundException('Kpm');

    return {
      month,
      version: TEMPLATE_VERSION,
      filename: templateFilename((office as { code: string }).code, month),
      header: [...TEMPLATE_HEADER_V1],
      file: templateBody(roster),
      rowCount: roster.length,
    };
  }

  /**
   * A filled file, read and checked against the roster and what is stored (P9-T3).
   *
   * **Writes nothing.** The preview exists in this response and nowhere else, which is what makes it
   * transient and the uploader's alone (AC-8). How a preview is held until somebody confirms it is
   * P9-T4's, with the route that confirms it.
   *
   * File-level refusals throw — an unreadable file, a header nobody issued. Everything about one row
   * or one cell is reported inside the preview, and the rest of the file still previews.
   */
  async preview(ctx: RequestContext, month: string, upload: UploadedCsv | undefined): Promise<UploadPreview> {
    requireOffice(ctx);
    requireMonth(month);
    // The revision first, the figures second: a write between the two leaves the preview carrying
    // the older revision, and its commit is refused — never a diff against figures it did not see.
    const { revision } = await this.months.state(ctx, month);
    const a = await this.analyse(ctx, month, upload);
    return {
      month,
      filename: upload!.originalname,
      templateVersion: a.read.templateVersion,
      encoding: a.read.encoding,
      delimiter: a.read.delimiter,
      revision,
      summary: a.summary,
      rows: a.rows,
    };
  }

  /**
   * The file against the roster and what is stored: the preview's substance, and what a commit
   * writes (P9-T4 reads it again rather than trusting the browser's copy of the preview).
   */
  async analyse(ctx: RequestContext, month: string, upload: UploadedCsv | undefined): Promise<Analysis> {
    requireOffice(ctx);
    requireMonth(month);
    if (!upload) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Attach the filled template as the `file` field.',
        HttpStatus.BAD_REQUEST,
        { field: 'file' },
      );
    }

    const read = readUpload(upload.buffer);
    const roster = await this.roster(ctx);
    const rows = await this.data.find(ctx, { month, membershipId: { $in: roster.map((r) => r.membershipId) } });
    const stored = new Map(rows.map((r) => [r.membershipId, r]));
    const nothing = metricsOf(undefined);
    const figures = (membershipId: string): StoredFigures => {
      const row = stored.get(membershipId);
      const m = row ? metricsOf(row) : nothing;
      return Object.fromEntries(PRODUCTION_METRICS.map((k) => [
        k, { monthly: m[k].monthly.value, ytd: m[k].ytd.value },
      ])) as StoredFigures;
    };

    const preview = buildPreview({ records: read.records, delimiter: read.delimiter, roster, stored: figures });

    // Which of the figures the file would change were corrected by hand (ADR-0053). `buildPreview`
    // sees numbers only; the stored cells say who corrected what, and why.
    const flagged: { cell: PreviewCell; by: string | null }[] = [];
    for (const row of preview.rows) {
      const cells = (stored.get(row.membershipId ?? '') ?? {}) as unknown as Record<string, MetricValue | undefined>;
      for (const cell of row.cells) {
        if (cell.status !== 'new' && cell.status !== 'changed') continue;
        const held = cells[`${cell.metric}${cell.cadence === 'monthly' ? 'Monthly' : 'Ytd'}`];
        if (held?.provenance !== 'corrected') continue;
        cell.correction = {
          by: null,
          at: held.correctedAt ? held.correctedAt.toISOString() : null,
          reason: held.reason ?? null,
          replacedValue: held.replacedValue ?? null,
        };
        flagged.push({ cell, by: held.correctedBy ?? null });
      }
    }
    if (flagged.length) {
      const names = await this.names.byMembershipId(ctx, [...new Set(flagged.map((f) => f.by).filter((x): x is string => !!x))]);
      for (const f of flagged) f.cell.correction!.by = f.by ? names.get(f.by) || null : null;
    }
    preview.summary.correctionCells = flagged.length;
    return { read, stored, ...preview };
  }

  /**
   * Everybody here now, in the order the roster shows them, with the code and the name.
   *
   * Pending members have registered and nothing more; a removed one is not here. Both are the
   * directory's own rule, and both the table and the template follow it.
   */
  private async roster(ctx: RequestContext): Promise<RosterEntry[]> {
    const members = await this.memberships.find(
      ctx, { status: 'active' }, { sort: { agentSeq: 1 } },
    );
    const ids = members.map((m) => String(m._id));
    const names = await this.names.byMembershipId(ctx, ids);
    return members.map((m) => {
      const id = String(m._id);
      return {
        membershipId: id,
        agentCode: (m as { agentCode?: string }).agentCode ?? '',
        name: names.get(id) ?? '',
      };
    });
  }
}

/** Twelve cells from a row, or twelve empty ones from no row. */
function metricsOf(row: MonthlyAgentDataDocument | undefined): MonthRow['metrics'] {
  const out = {} as MonthRow['metrics'];
  for (const metric of PRODUCTION_METRICS) {
    out[metric] = {
      monthly: cellOf(row?.[`${metric}Monthly`]),
      ytd: cellOf(row?.[`${metric}Ytd`]),
    };
  }
  return out;
}

/**
 * `undefined` is not a case: Mongoose applies a subdocument's defaults on hydration, so a stored cell
 * always carries `value: null` at the least. An arm for it would be one nothing could ever take.
 */
function cellOf(stored: MetricValue | undefined): MetricCell {
  if (!stored || stored.value === null) return EMPTY;
  return { value: stored.value, provenance: stored.provenance };
}

function hasAnyFigure(row: MonthRow): boolean {
  return PRODUCTION_METRICS.some(
    (m) => row.metrics[m].monthly.value !== null || row.metrics[m].ytd.value !== null,
  );
}
