import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { ulid } from 'ulid';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import {
  DEFAULT_TENANT_TIMEZONE, ILLUSTRATION, PDF_DETAIL_BLOCKS, PROPOSAL, PROPOSAL_TEXT_MAX, type PdfDetailBlockKind,
} from '@/domain/constants';
import { StoragePort } from '@/modules/assets/storage.port';
import { AuditService } from '@/modules/audit/audit.service';
import { ProductService } from '@/modules/products/product.service';
import type { ProductForItem } from '@/modules/proposals/proposal-items';
import { ProposalPdfBuilder } from '@/modules/proposals/proposal-pdf.builder';
import { Company, type CompanyDocument } from '@/modules/tenants/company.schema';
import { PRODUCT_DATA_READER, ProductDataReader } from './ai/reader.port';
import { blocksOf, checkRow, mismatches } from './illustration-check';
import { boxPreview, pdfDetailOf, previewItem, previewModel, type BoxPreview } from './illustration-preview';
import {
  Illustration, type IllustrationBlock, type IllustrationDocument, type IllustrationRow,
} from './illustration.schema';
import { entryOf, IntakeCatalogue } from './intake-catalogue';
import { kindOf } from './intake-files';
import { isRealDay } from './intake-understanding';
import { INTAKE_REFUSALS } from './intake.messages';
import { isStale } from './intake-status';
import { ProductDataAccess } from './product-data-access.service';

const SAY = INTAKE_REFUSALS;

/** The name an illustration uploaded with none is kept under. */
const ILLUSTRATION_FILE_NAME = 'ilustrasi.pdf';

/** What the *Ilustrasi* tab reads of one illustration. */
export interface IllustrationView {
  id: string;
  companyId: string;
  productId: string;
  plan: string | null;
  fileName: string;
  hasFile: boolean;
  illustrationDate: string;
  status: Illustration['status'];
  failure: Illustration['failure'];
  blocks: IllustrationBlock[];
  dropped: string[];
  sampleInputs: Record<string, number>;
  /** The names a formula may use for this product: its money fields, and `up` where it has a sum assured. */
  formulaNames: string[];
  mismatches: number;
  unchecked: number;
  intakeItemId: string | null;
  publishedAt: string | null;
  supersededAt: string | null;
  createdAt: string;
}

/** A row as the editor sends it: an existing row by its `id`, keeping its evidence, or a new one (`id` `null`). */
export interface RowInput { id: string | null; label: string; note: string | null; formula: string | null; text: string | null }
export interface BlockInput { block: PdfDetailBlockKind; rows: RowInput[] }

const ROW_LIMITS: Readonly<Record<PdfDetailBlockKind, number>> = {
  manfaat: ILLUSTRATION.BENEFITS_MAX, jadwal: PROPOSAL.PDF_DETAIL_ROWS_MAX, masa: 2,
  pengecualian: ILLUSTRATION.EXCLUSIONS_MAX, nilai_tunai: ILLUSTRATION.CASH_VALUE_YEARS_MAX,
};

/**
 * **The *Ilustrasi* tab** (P19.15-T2; ADR-0259 §8; the P1b spec §3 *Ilustrasi*): an official illustration uploaded with
 * its date, condensed by Claude into the PDF's five kinds of block, every amount a formula checked by our code, the
 * wording edited by a person, the product's box previewed with the proposal's own PDF, and published — the product's
 * `pdfDetail` for new proposals; a saved proposal keeps what it printed (its snapshot).
 *
 * Access is the Proposal tab's (`ProductDataAccess`): read by those who may read the company, written by those who may
 * manage it. Reading runs in the API's process, as *Unggah file*'s does (ADR-0259 §5).
 */
@Injectable()
export class IllustrationService {
  private readonly logger = new Logger(IllustrationService.name);
  private readonly running = new Set<Promise<void>>();

  constructor(
    @InjectModel(Illustration.name) private readonly illustrations: Model<IllustrationDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @Inject(PRODUCT_DATA_READER) private readonly reader: ProductDataReader,
    private readonly access: ProductDataAccess,
    private readonly catalogue: IntakeCatalogue,
    private readonly products: ProductService,
    private readonly storage: StoragePort,
    private readonly audit: AuditService,
    private readonly builder: ProposalPdfBuilder,
    private readonly clock: Clock,
  ) {}

  private today(): string {
    return this.clock.localDateFor(DEFAULT_TENANT_TIMEZONE);
  }

  /** A product's illustrations, newest first, and whether reading is switched on. */
  async list(ctx: RequestContext, companyId: string, productId: string): Promise<{ aiReading: boolean; illustrations: IllustrationView[] }> {
    await this.access.assertRead(ctx, companyId);
    const product = await this.requireProduct(companyId, productId);
    const rows = await this.illustrations.find({ companyId, productId, deletedAt: null }).sort({ createdAt: -1 }).limit(20).exec();
    const names = entryOf(product).formulaNames;
    return { aiReading: this.reader.enabled, illustrations: await Promise.all(rows.map((r) => this.fresh(r).then((x) => viewOf(x, names)))) };
  }

  async read(ctx: RequestContext, companyId: string, id: string): Promise<IllustrationView> {
    await this.access.assertRead(ctx, companyId);
    const row = await this.fresh(await this.find(companyId, id));
    const product = await this.requireProduct(companyId, row.productId);
    return viewOf(row, entryOf(product).formulaNames);
  }

  /** **An illustration uploaded on the *Ilustrasi* tab**: a PDF and its date; read in the background. */
  async upload(
    ctx: RequestContext, companyId: string, productId: string,
    file: { originalname: string; buffer: Buffer; mimetype?: string } | undefined,
    input: { illustrationDate?: string; plan?: string | null },
  ): Promise<IllustrationView> {
    await this.access.assertManage(ctx, companyId);
    if (!this.reader.enabled) throw readingOff();
    const product = await this.requireProduct(companyId, productId);
    if (!file || kindOf(file.originalname, file.mimetype ?? '', file.buffer) !== 'pdf') {
      throw new DomainException(ErrorCode.ASSET_TYPE_NOT_ALLOWED, SAY.ASSET_TYPE_NOT_ALLOWED.illustrationIsPdf, HttpStatus.UNSUPPORTED_MEDIA_TYPE, { allowed: ['application/pdf'] });
    }
    const date = input.illustrationDate ?? '';
    if (!isRealDay(date) || date > this.today()) {
      throw new DomainException(ErrorCode.VALIDATION_FAILED, SAY.VALIDATION_FAILED.illustrationDate, HttpStatus.BAD_REQUEST, { field: 'illustrationDate' });
    }
    const plan = input.plan?.trim().slice(0, ILLUSTRATION.PLAN_MAX_LENGTH) || null;
    const fileName = file.originalname.normalize('NFC').slice(0, 120) || ILLUSTRATION_FILE_NAME;
    return this.begin(ctx, { companyId, product: entryOf(product).id, fileName, bytes: file.buffer, illustrationDate: date, plan, intakeItemId: null, fileKey: undefined });
  }

  /**
   * **An illustration that came through *Unggah file*** (P19.15-T3 AC-4): its card confirmed, the file read again from
   * where the upload kept it, and condensed here like any other.
   */
  async fromIntake(ctx: RequestContext, input: {
    companyId: string; productId: string; fileName: string; fileKey: string | null; illustrationDate: string; plan: string | null; intakeItemId: string;
  }): Promise<string> {
    await this.requireProduct(input.companyId, input.productId);
    const bytes = input.fileKey ? await this.storage.read(input.fileKey, ILLUSTRATION.FILE_MAX_BYTES).catch(() => null) : null;
    if (!bytes) throw new DomainException(ErrorCode.INTAKE_APPLY_REFUSED, SAY.INTAKE_APPLY_REFUSED.noFile, HttpStatus.CONFLICT, { reason: 'no_file' });
    const view = await this.begin(ctx, { ...input, product: input.productId, bytes, fileKey: input.fileKey });
    return view.id;
  }

  private async begin(ctx: RequestContext, input: {
    companyId: string; product: string; fileName: string; bytes: Buffer; illustrationDate: string; plan: string | null;
    intakeItemId: string | null; fileKey: string | null | undefined;
  }): Promise<IllustrationView> {
    const created = await this.illustrations.create({
      companyId: input.companyId, productId: input.product, plan: input.plan, fileName: input.fileName, fileKey: null,
      illustrationDate: input.illustrationDate, status: 'reading', failure: null, readingStartedAt: this.clock.now(),
      blocks: [], dropped: [], sampleInputs: {}, intakeItemId: input.intakeItemId, uploadedBy: ctx.userId,
      updatedBy: ctx.userId, publishedBy: null, publishedAt: null, supersededAt: null, deletedAt: null,
    });
    const id = String(created._id);
    let fileKey = input.fileKey ?? null;
    if (input.fileKey === undefined) {
      try {
        const stored = await this.storage.putObject({
          owner: { kind: 'company', companyId: input.companyId }, folder: `illustrations/${id}`,
          name: safeName(input.fileName), mimeType: 'application/pdf', body: input.bytes,
        });
        fileKey = stored.storageKey;
      } catch (err) {
        // Development without a bucket keeps nothing: the reading still runs from the bytes in hand.
        this.logger.warn({ illustrationId: id, err: err instanceof Error ? err.name : 'unknown' }, 'illustration file not kept');
      }
    }
    if (fileKey) await this.illustrations.updateOne({ _id: id }, { $set: { fileKey } }).exec();
    await this.audit.recordForCompany(ctx, {
      action: 'illustration.uploaded', targetCollection: 'illustrations', targetId: id,
      after: { companyId: input.companyId, productId: input.product, fileName: input.fileName, fileKey, illustrationDate: input.illustrationDate, plan: input.plan, intakeItemId: input.intakeItemId },
    });
    this.start(id, input.companyId, input.product, input.fileName, input.bytes, input.plan);
    const row = await this.find(input.companyId, id);
    const product = await this.requireProduct(input.companyId, input.product);
    return viewOf(row, entryOf(product).formulaNames);
  }

  private start(id: string, companyId: string, productId: string, fileName: string, bytes: Buffer, plan: string | null): void {
    const job: Promise<void> = this.condense(id, companyId, productId, fileName, bytes, plan)
      .catch(async () => {
        await this.illustrations.updateOne({ _id: id }, { $set: { status: 'failed', failure: 'service_error' } }).exec();
      })
      .finally(() => { this.running.delete(job); });
    this.running.add(job);
  }

  /** Every reading under way, finished: what a test waits on. */
  async settled(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  private async condense(id: string, companyId: string, productId: string, fileName: string, bytes: Buffer, plan: string | null): Promise<void> {
    const product = await this.requireProduct(companyId, productId);
    const entry = entryOf(product);
    const result = await this.reader.condenseIllustration({
      file: { kind: 'pdf', name: fileName, base64: bytes.toString('base64') }, product: entry, plan, today: this.today(),
    });
    const usage = result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } : { inputTokens: 0, outputTokens: 0 };
    if (!result.ok) {
      await this.illustrations.updateOne({ _id: id, status: 'reading' }, { $set: { status: 'failed', failure: result.failure, usage } }).exec();
      return;
    }
    const { blocks, samples } = blocksOf(result.value, entry.formulaNames, ulid);
    await this.illustrations.updateOne(
      { _id: id, status: 'reading' },
      {
        $set: {
          status: 'draft', blocks, sampleInputs: samples, usage,
          dropped: result.value.dropped.map((d) => d.slice(0, 160)).slice(0, 12),
          plan: plan ?? (result.value.plan?.slice(0, ILLUSTRATION.PLAN_MAX_LENGTH) || null),
        },
      },
    ).exec();
  }

  /**
   * **The wording edited** (P19.15-T2 AC-3): the blocks as the editor sends them — each kind once, the bounds the PDF's
   * box keeps, a formula or a text on each row — every formula checked again, by our evaluator, against the two numbers
   * its row was read with. A row the Super Admin added has none, and is *belum dicek*.
   */
  async update(ctx: RequestContext, companyId: string, id: string, input: { blocks: BlockInput[] }): Promise<IllustrationView> {
    await this.access.assertManage(ctx, companyId);
    const row = await this.fresh(await this.find(companyId, id));
    if (row.status !== 'draft') throw notDraft(row.status);
    const product = await this.requireProduct(companyId, row.productId);
    const names = entryOf(product).formulaNames;
    const before = row.blocks;
    const evidence = new Map(before.flatMap((b) => b.rows).map((r) => [r.id, r]));
    const blocks = checkedBlocks(input.blocks, evidence, names);
    await this.illustrations.updateOne({ _id: id }, { $set: { blocks, updatedBy: ctx.userId } }).exec();
    await this.audit.recordForCompany(ctx, {
      action: 'illustration.edited', targetCollection: 'illustrations', targetId: id,
      before: { blocks: before.map(plainBlock) }, after: { blocks: blocks.map(plainBlock) },
    });
    return viewOf(await this.find(companyId, id), names);
  }

  /** **The box, previewed**: every row the product would print and what each number of products keeps of them. */
  async preview(ctx: RequestContext, companyId: string, id: string): Promise<BoxPreview> {
    await this.access.assertRead(ctx, companyId);
    const row = await this.find(companyId, id);
    if (row.status !== 'draft' && row.status !== 'published') throw notDraft(row.status);
    const product = await this.requireProduct(companyId, row.productId);
    const detail = pdfDetailOf(row.blocks, row.fileName, row.illustrationDate);
    return boxPreview(previewItem(productForItem(product), detail, row.sampleInputs), detail);
  }

  /** **The file itself**: a sample proposal of the product, built by the proposal's own builder, as an agent would get it. */
  async previewPdf(ctx: RequestContext, companyId: string, id: string): Promise<Buffer> {
    await this.access.assertRead(ctx, companyId);
    const row = await this.find(companyId, id);
    if (row.status !== 'draft' && row.status !== 'published') throw notDraft(row.status);
    const product = await this.requireProduct(companyId, row.productId);
    const company = await this.companies.findOne({ _id: companyId }, { name: 1 }).lean().exec();
    const detail = pdfDetailOf(row.blocks, row.fileName, row.illustrationDate);
    const item = previewItem(productForItem(product), detail, row.sampleInputs);
    const built = await this.builder.build(previewModel(item, (company as { name?: string } | null)?.name ?? '', this.today()), this.clock.now());
    return built.bytes;
  }

  /**
   * **Published** (P19.15-T2 AC-3): the blocks become the product's `pdfDetail` through the catalogue's own write — its
   * checks, its version, its audit — for **new** proposals; a saved one keeps the blocks it printed. Refused while a
   * formula does not match. The one published before is marked superseded.
   */
  async publish(ctx: RequestContext, companyId: string, id: string): Promise<IllustrationView> {
    await this.access.assertManage(ctx, companyId);
    const row = await this.fresh(await this.find(companyId, id));
    if (row.status !== 'draft') throw notDraft(row.status);
    const wrong = mismatches(row.blocks);
    if (wrong.length) {
      throw new DomainException(ErrorCode.ILLUSTRATION_FORMULA_MISMATCH, SAY.ILLUSTRATION_FORMULA_MISMATCH.fixFirst({ count: wrong.length }), HttpStatus.CONFLICT, { rows: wrong });
    }
    const product = await this.requireProduct(companyId, row.productId);
    const previous = (product as unknown as { pdfDetail?: unknown[] }).pdfDetail ?? [];
    const pdfDetail = pdfDetailOf(row.blocks, row.fileName, row.illustrationDate);
    await this.products.update(ctx, companyId, row.productId, { pdfDetail });
    const now = this.clock.now();
    await this.illustrations.updateMany(
      { companyId, productId: row.productId, status: 'published', supersededAt: null, deletedAt: null, _id: { $ne: id } },
      { $set: { supersededAt: now } },
    ).exec();
    await this.illustrations.updateOne({ _id: id }, { $set: { status: 'published', publishedBy: ctx.userId, publishedAt: now, updatedBy: ctx.userId } }).exec();
    await this.audit.recordForCompany(ctx, {
      action: 'illustration.published', targetCollection: 'illustrations', targetId: id,
      before: { productId: row.productId, pdfDetail: previous },
      after: { productId: row.productId, pdfDetail, fileName: row.fileName, fileKey: row.fileKey, intakeItemId: row.intakeItemId },
    });
    return viewOf(await this.find(companyId, id), entryOf(product).formulaNames);
  }

  /** The original PDF, through a short-lived link. */
  async fileLink(ctx: RequestContext, companyId: string, id: string): Promise<{ url: string }> {
    await this.access.assertRead(ctx, companyId);
    const row = await this.find(companyId, id);
    if (!row.fileKey) throw new NotFoundException('Intake file');
    return { url: await this.storage.createSignedUrl(row.fileKey, 600, 'application/pdf') };
  }

  // ------------------------------------------------------------------------------------------------ helpers

  private async find(companyId: string, id: string): Promise<IllustrationDocument> {
    const row = isValidObjectId(id) ? await this.illustrations.findOne({ _id: id, companyId, deletedAt: null }).exec() : null;
    if (!row) throw new NotFoundException('Illustration');
    return row;
  }

  private async requireProduct(companyId: string, productId: string) {
    const product = await this.catalogue.product(companyId, productId);
    if (!product) throw new NotFoundException('Product');
    return product;
  }

  /** A reading the process lost: `failed`, `stale`, once it is older than the bound. */
  private async fresh(row: IllustrationDocument): Promise<IllustrationDocument> {
    if (row.status === 'reading' && isStale(row.readingStartedAt, this.clock.now())) {
      await this.illustrations.updateOne({ _id: row._id, status: 'reading' }, { $set: { status: 'failed', failure: 'stale' } }).exec();
      row.status = 'failed';
      row.failure = 'stale';
    }
    return row;
  }
}

const readingOff = () => new DomainException(ErrorCode.AI_READING_OFF, SAY.AI_READING_OFF.notSwitchedOn, HttpStatus.SERVICE_UNAVAILABLE);
const notDraft = (status: string) => new DomainException(ErrorCode.ILLUSTRATION_NOT_DRAFT, SAY.ILLUSTRATION_NOT_DRAFT.notDraft({ status }), HttpStatus.CONFLICT, { status });
const shape = (field: string) => new DomainException(ErrorCode.VALIDATION_FAILED, SAY.VALIDATION_FAILED.blocksShape({ field }), HttpStatus.BAD_REQUEST, { field });

export const safeName = (name: string) => name.normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').slice(-80) || 'file';

/** The product as a new proposal item reads it. */
function productForItem(product: unknown): ProductForItem & { name: string } {
  const p = (product as { toObject?: () => Record<string, unknown> }).toObject?.() ?? (product as Record<string, unknown>);
  return { ...(p as unknown as ProductForItem), name: String(p.name ?? '') };
}

const plainBlock = (b: IllustrationBlock) => ({ block: b.block, rows: b.rows.map((r) => ({ label: r.label, note: r.note, formula: r.formula, text: r.text })) });

/** **The editor's blocks, checked**: each kind once and known, the box's bounds, a formula or a text, formulas checked. */
export function checkedBlocks(input: unknown, evidence: ReadonlyMap<string, IllustrationRow>, names: readonly string[]): IllustrationBlock[] {
  if (!Array.isArray(input) || input.length > PDF_DETAIL_BLOCKS.length) throw shape('blocks');
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const b = raw as Partial<BlockInput>;
    if (!b || !PDF_DETAIL_BLOCKS.includes(b.block as PdfDetailBlockKind) || seen.has(b.block as string)) throw shape(`blocks[${i}].block`);
    const kind = b.block as PdfDetailBlockKind;
    seen.add(kind);
    if (!Array.isArray(b.rows) || b.rows.length > ROW_LIMITS[kind]) throw shape(`blocks[${i}].rows`);
    const rows = b.rows.map((r, j): IllustrationRow => {
      const at = `blocks[${i}].rows[${j}]`;
      const text = (v: unknown, max: number, field: string): string | null => {
        if (v === null || v === undefined || v === '') return null;
        if (typeof v !== 'string' || v.trim().length > max) throw shape(`${at}.${field}`);
        return v.replace(/\s+/g, ' ').trim() || null;
      };
      const label = text(r.label, PROPOSAL_TEXT_MAX.DETAIL_LABEL, 'label');
      if (!label) throw shape(`${at}.label`);
      const formula = text(r.formula, PROPOSAL.FORMULA_MAX_LENGTH, 'formula');
      const shown = formula ? null : text(r.text, PROPOSAL_TEXT_MAX.DETAIL_LABEL, 'text');
      if (!formula && !shown) throw shape(`${at}.text`);
      const old = typeof r.id === 'string' ? evidence.get(r.id) : undefined;
      const kept = old?.evidence ?? [];
      return {
        id: old?.id ?? ulid(),
        label,
        note: text(r.note, PROPOSAL_TEXT_MAX.DETAIL_NOTE, 'note'),
        formula,
        text: shown,
        page: old?.page ?? null,
        evidence: kept,
        check: checkRow(formula, kept, names),
      };
    });
    const page = rows.find((r) => r.page)?.page ?? null;
    return { block: kind, page, rows };
  }).filter((b) => b.rows.length);
}

function viewOf(row: IllustrationDocument, names: string[]): IllustrationView {
  const checks = row.blocks.flatMap((b) => b.rows.map((r) => r.check?.state ?? null));
  return {
    id: String(row._id),
    companyId: row.companyId,
    productId: row.productId,
    plan: row.plan,
    fileName: row.fileName,
    hasFile: Boolean(row.fileKey),
    illustrationDate: row.illustrationDate,
    status: row.status,
    failure: row.failure,
    blocks: row.blocks,
    dropped: row.dropped,
    sampleInputs: row.sampleInputs ?? {},
    formulaNames: names,
    mismatches: checks.filter((c) => c === 'mismatch').length,
    unchecked: checks.filter((c) => c === 'unchecked').length,
    intakeItemId: row.intakeItemId,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
