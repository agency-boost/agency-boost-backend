import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Sentence } from '@/common/i18n/sentence';
import { DEFAULT_TENANT_TIMEZONE, INTAKE, type IntakeItemStatus } from '@/domain/constants';
import { StoragePort } from '@/modules/assets/storage.port';
import { AuditService } from '@/modules/audit/audit.service';
import { ProductService } from '@/modules/products/product.service';
import type { ProposalField } from '@/modules/products/proposal-fields';
import { Company, type CompanyDocument } from '@/modules/tenants/company.schema';
import { User, type UserDocument } from '@/modules/users/user.schema';
import { PRODUCT_DATA_READER, ProductDataReader } from './ai/reader.port';
import { IllustrationService, safeName } from './illustration.service';
import {
  answerTo, effectiveFromOf, rateRowsOf, scaledRows, settledChanges, storedFactor, typedNumber,
} from './intake-apply-plan';
import { IntakeCatalogue } from './intake-catalogue';
import { prepareUpload, type UploadedFile } from './intake-files';
import { IntakeReading } from './intake-reading';
import { intakeStatusOf, isStale, itemStatusOf } from './intake-status';
import { IntakeTargets } from './intake-targets';
import { isRealDay, openQuestions } from './intake-understanding';
import { INTAKE_REFUSALS } from './intake.messages';
import { ProductDataAccess } from './product-data-access.service';
import { PRODUCT_DATA_REFUSALS } from './product-data.messages';
import {
  IntakeItem, UploadIntake, type IntakeDiffRow, type IntakeItemDocument, type IntakeQuestion, type IntakeSource,
  type UploadIntakeDocument,
} from './upload-intake.schema';

const SAY = INTAKE_REFUSALS;

/** One upload as a list shows it. */
export interface IntakeView {
  id: string;
  companyId: string | null;
  companyName: string | null;
  status: UploadIntake['status'];
  failure: string | null;
  files: { index: number; name: string; kind: string; bytes: number; status: string; failure: string | null; items: number; kept: boolean }[];
  uploadedBy: string;
  uploadedByName: string | null;
  createdAt: string;
  readAt: string | null;
  items: number;
  open: number;
}

/** One card, as *Yang kami pahami* shows it. */
export interface IntakeItemView {
  id: string;
  companyId: string | null;
  productId: string | null;
  productName: string | null;
  productAsWritten: string | null;
  kind: IntakeItem['kind'];
  summary: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  source: IntakeSource;
  diff: Omit<IntakeDiffRow, 'value'>[];
  table: { rows: number; columns: { column: string; header: string; meaning: string }[]; gaps: string[]; basis: string | null; currency: string | null } | null;
  percent: { asWritten: string; direction: string; rule: string } | null;
  newProductName: string | null;
  questions: (Omit<IntakeQuestion, 'answeredAt'> & { open: boolean; asked: boolean; answeredAt: string | null })[];
  confidence: 'high' | 'low';
  status: IntakeItemStatus;
  appliedRef: IntakeItem['appliedRef'];
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface IntakeDetailView extends IntakeView {
  canManage: boolean;
  cards: IntakeItemView[];
}

/**
 * ***Unggah file*** (P19.15-T3; ADR-0259; the P1b spec §0 *Unggah apa saja*): anything uploaded is read, shown as *Yang
 * kami pahami* — one card per product with old → new and each value's source — and question cards; **nothing is
 * applied until a person answers and confirms**, and what is applied goes through T1's and T2's own flows.
 *
 * - **Who** (ADR-0259 §1): an upload for one company, by whoever may manage it (`ProductDataAccess`: Super Admin, or a
 *   holder of *Kelola data produk* for that company); *Perusahaan*'s upload for every company, the Super Admin alone. A
 *   KPM Owner or Admin reads their company's uploads and changes nothing.
 * - **The originals are kept with the intake** (ADR-0259 §9) — in the company's folder, or the uploader's while the
 *   company is not known — as the evidence each applied change links to; an upload whose every card was rejected has
 *   its files removed.
 * - **Every write is audited** — `intake.uploaded`, `intake.answered`, `intake.applied`, `intake.rejected` — the applied
 *   one naming the file, the intake and the card, beside the audit row the change itself writes.
 */
@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);

  constructor(
    @InjectModel(UploadIntake.name) private readonly intakes: Model<UploadIntakeDocument>,
    @InjectModel(IntakeItem.name) private readonly items: Model<IntakeItemDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @Inject(PRODUCT_DATA_READER) private readonly reader: ProductDataReader,
    private readonly reading: IntakeReading,
    private readonly access: ProductDataAccess,
    private readonly catalogue: IntakeCatalogue,
    private readonly targets: IntakeTargets,
    private readonly products: ProductService,
    private readonly illustrations: IllustrationService,
    private readonly storage: StoragePort,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  get aiReading(): boolean {
    return this.reader.enabled;
  }

  private today(): string {
    return this.clock.localDateFor(DEFAULT_TENANT_TIMEZONE);
  }

  // ------------------------------------------------------------------------------------------------ upload

  /** **Files uploaded** — checked, kept, and read in the background; the intake answers at once, `reading`. */
  async upload(ctx: RequestContext, companyId: string | null, files: readonly UploadedFile[]): Promise<IntakeView> {
    if (companyId === null) this.assertPlatform(ctx, true);
    else await this.access.assertManage(ctx, companyId);
    if (!this.reader.enabled) throw readingOff();
    const prepared = prepareUpload(files);

    const intake = await this.intakes.create({
      companyId, files: [], uploadedBy: ctx.userId, status: 'reading', readingStartedAt: this.clock.now(),
      readAt: null, failure: null, usage: { inputTokens: 0, outputTokens: 0 }, deletedAt: null,
    });
    const id = String(intake._id);
    const owner = companyId ? { kind: 'company' as const, companyId } : { kind: 'user' as const, userId: ctx.userId };
    const kept = [];
    for (const [index, file] of prepared.entries()) {
      let storageKey: string | null = null;
      try {
        const stored = await this.storage.putObject({ owner, folder: `intake/${id}`, name: `${index}-${safeName(file.name)}`, mimeType: file.mimeType, body: file.bytes });
        storageKey = stored.storageKey;
      } catch (err) {
        // Development without a bucket keeps nothing; the reading still runs from the bytes in hand.
        this.logger.warn({ intakeId: id, err: err instanceof Error ? err.name : 'unknown' }, 'intake file not kept');
      }
      kept.push({
        index, name: file.name, kind: file.kind, mimeType: file.mimeType, bytes: file.bytes.length, storageKey,
        fromZip: file.fromZip, status: 'reading' as const, failure: null, items: 0,
      });
    }
    await this.intakes.updateOne({ _id: id }, { $set: { files: kept } }).exec();
    await this.audit.recordForCompany(ctx, {
      action: 'intake.uploaded', targetCollection: 'uploadIntakes', targetId: id,
      after: { companyId, files: kept.map((f) => ({ name: f.name, kind: f.kind, bytes: f.bytes, storageKey: f.storageKey })) },
    });
    this.reading.start(id, companyId, prepared);
    return this.viewOf(await this.intakes.findById(id).orFail().exec());
  }

  // ------------------------------------------------------------------------------------------------ reads

  /** A company's uploads, newest first — or, `null`, every upload the Super Admin made from *Perusahaan* and since. */
  async list(ctx: RequestContext, companyId: string | null): Promise<{ aiReading: boolean; intakes: IntakeView[] }> {
    if (companyId === null) this.assertPlatform(ctx, false);
    else await this.access.assertRead(ctx, companyId);
    const rows = await this.intakes.find({ ...(companyId ? { companyId } : {}), deletedAt: null }).sort({ createdAt: -1 }).limit(INTAKE.LIST_MAX).exec();
    const fresh = await Promise.all(rows.map((r) => this.fresh(r)));
    return { aiReading: this.reader.enabled, intakes: await Promise.all(fresh.map((r) => this.viewOf(r))) };
  }

  /** One upload with its cards. */
  async read(ctx: RequestContext, intakeId: string): Promise<IntakeDetailView> {
    const intake = await this.fresh(await this.load(ctx, intakeId, false));
    const canManage = intake.companyId === null
      ? ctx.isSuperAdmin && !ctx.isImpersonating && !ctx.impersonationReadOnly
      : await this.access.canManage(ctx, intake.companyId);
    const cards = await this.items.find({ intakeId, deletedAt: null }).sort({ createdAt: 1 }).exec();
    const names = await this.productNames(cards.map((c) => c.productId).filter((x): x is string => !!x));
    return { ...(await this.viewOf(intake)), canManage, cards: cards.map((c) => itemView(c, names)) };
  }

  /** A short-lived link to an original file: what each card's source links to. */
  async fileLink(ctx: RequestContext, intakeId: string, index: number): Promise<{ url: string }> {
    const intake = await this.load(ctx, intakeId, false);
    const file = intake.files.find((f) => f.index === index);
    if (!file?.storageKey) throw new NotFoundException('Intake file');
    return { url: await this.storage.createSignedUrl(file.storageKey, 600, file.mimeType) };
  }

  // ------------------------------------------------------------------------------------------------ the cards

  /** **A question answered** — checked against its kind; an answer that settles the card moves it to `ready`. */
  async answer(ctx: RequestContext, intakeId: string, itemId: string, input: { questionId: string; answer: string }): Promise<IntakeItemView> {
    const intake = await this.load(ctx, intakeId, true);
    const item = await this.undecided(intake, itemId);
    const question = item.questions.find((q) => q.id === input.questionId);
    if (!question) throw invalid(SAY.VALIDATION_FAILED.unknownQuestion, 'questionId');
    const answer = this.checkedAnswer(question, String(input.answer ?? '').trim(), item);

    const questions = item.questions.map((q) => (q.id === question.id ? { ...q, answer, answeredBy: ctx.userId, answeredAt: this.clock.now() } : q));
    const set: Record<string, unknown> = { questions };
    let decided: IntakeItemStatus | null = null;
    switch (question.about) {
      case 'company':
        set.companyId = answer;
        break;
      case 'product':
        if (answer === 'ignore') decided = 'rejected';
        else if (answer.startsWith('rename:')) set.productId = answer.slice('rename:'.length);
        else if (answer !== 'new') {
          set.productId = answer;
          if (!item.companyId) {
            const entry = (await this.catalogue.catalogue(null)).find((p) => p.id === answer);
            if (entry) set.companyId = entry.companyId;
          }
        }
        break;
      case 'effectiveFrom':
        set.effectiveFrom = answer;
        break;
      case 'percent':
        if (answer === 'reject') decided = 'rejected';
        break;
    }
    if (typeof set.productId === 'string') set.diff = await this.refreshedDiff(item, String(set.companyId ?? item.companyId ?? ''), set.productId);
    set.status = itemStatusOf(questions, decided);
    if (decided) Object.assign(set, { decidedBy: ctx.userId, decidedAt: this.clock.now() });
    await this.items.updateOne({ _id: item._id }, { $set: set }).exec();
    await this.audit.recordForCompany(ctx, {
      action: 'intake.answered', targetCollection: 'intakeItems', targetId: String(item._id),
      before: { question: question.text, answer: question.answer }, after: { intakeId, question: question.text, answer, status: set.status },
    });
    await this.settle(intakeId);
    return this.cardView(itemId);
  }

  /**
   * **A card confirmed, and applied through its flow** (P19.15-T3 AC-3, AC-4): refused while a question is open; a
   * premium table becomes a draft version of T1 (then its gaps, its three test profiles and its activation), rules go
   * through T1's change of rules, a catalogue change through the catalogue, an illustration through T2.
   */
  async confirm(ctx: RequestContext, intakeId: string, itemId: string): Promise<IntakeItemView> {
    const intake = await this.load(ctx, intakeId, true);
    const item = await this.undecided(intake, itemId);
    const open = openQuestions(item.questions);
    if (open.length) {
      throw new DomainException(ErrorCode.INTAKE_QUESTIONS_OPEN, SAY.INTAKE_QUESTIONS_OPEN.answerFirst({ count: open.length }), HttpStatus.CONFLICT, {
        open: open.map((q) => q.id),
      });
    }
    const companyId = item.companyId ?? intake.companyId;
    if (companyId && intake.companyId === null) this.assertPlatform(ctx, true);
    const ref = await this.apply(ctx, intake, item, companyId);
    const now = this.clock.now();
    await this.items.updateOne({ _id: item._id }, { $set: { status: 'applied', appliedRef: ref, decidedBy: ctx.userId, decidedAt: now } }).exec();
    const file = intake.files.find((f) => f.index === item.source.file);
    await this.audit.recordForCompany(ctx, {
      action: 'intake.applied', targetCollection: 'intakeItems', targetId: String(item._id),
      after: {
        intakeId, kind: item.kind, companyId, productId: item.productId, appliedRef: ref,
        file: file ? { name: file.name, storageKey: file.storageKey } : null,
        source: item.source, diff: item.diff.map((d) => ({ key: d.key, old: d.old, new: d.new })),
      },
    });
    await this.settle(intakeId);
    return this.cardView(itemId);
  }

  /** **A card rejected**: nothing applied. When every card of the upload is rejected, its files are removed. */
  async reject(ctx: RequestContext, intakeId: string, itemId: string): Promise<IntakeItemView> {
    const intake = await this.load(ctx, intakeId, true);
    const item = await this.undecided(intake, itemId);
    await this.items.updateOne({ _id: item._id }, { $set: { status: 'rejected', decidedBy: ctx.userId, decidedAt: this.clock.now() } }).exec();
    await this.audit.recordForCompany(ctx, {
      action: 'intake.rejected', targetCollection: 'intakeItems', targetId: String(item._id),
      after: { intakeId, kind: item.kind, productId: item.productId, summary: item.summary },
    });
    await this.settle(intakeId);
    return this.cardView(itemId);
  }

  // ------------------------------------------------------------------------------------------------ applying

  private async apply(
    ctx: RequestContext, intake: UploadIntakeDocument, item: IntakeItemDocument, companyId: string | null,
  ): Promise<NonNullable<IntakeItem['appliedRef']>> {
    const refuse = (reason: keyof typeof SAY.INTAKE_APPLY_REFUSED) => new DomainException(
      ErrorCode.INTAKE_APPLY_REFUSED, SAY.INTAKE_APPLY_REFUSED[reason] as never, HttpStatus.CONFLICT, { reason },
    );
    const intakeItemId = String(item._id);
    const file = intake.files.find((f) => f.index === item.source.file);
    const effectiveFrom = effectiveFromOf(item);

    if (item.kind === 'new_product') {
      if (!companyId) throw refuse('noProduct');
      const choice = answerTo(item.questions, 'product');
      const name = (item.newProductName ?? item.productAsWritten ?? '').slice(0, 200);
      if (choice?.startsWith('rename:')) {
        const id = choice.slice('rename:'.length);
        await this.products.update(ctx, companyId, id, { name });
        return { kind: 'product', id };
      }
      const created = await this.products.create(ctx, companyId, {
        code: String(answerTo(item.questions, 'new:code') ?? '').toUpperCase(),
        name,
        category: answerTo(item.questions, 'new:category') ?? 'life',
        channel: answerTo(item.questions, 'new:channel') ?? 'conventional',
      });
      return { kind: 'product', id: created.id };
    }

    if (!companyId || !item.productId) throw refuse('noProduct');
    const productId = item.productId;
    switch (item.kind) {
      case 'premium_table': {
        const now = await this.targets.productNow(companyId, productId, this.today());
        const { rows } = rateRowsOf(item, now?.payTerms ?? []);
        if (rows.length === 0) throw refuse('noRows');
        const { rules } = settledChanges(item);
        const made = await this.targets.createRateTableDraft(ctx, {
          companyId, productId, rows, rules, effectiveFrom: effectiveFrom!, effectiveTo: item.effectiveTo,
          source: { fileName: file?.name ?? item.source.fileName, assetKey: file?.storageKey ?? null, intakeItemId },
        });
        return { kind: 'rate_table', id: made.rateTableId };
      }
      case 'percent_change': {
        if (answerTo(item.questions, 'percent') !== 'approve' || !item.percent) throw refuse('notApproved');
        const factor = storedFactor(item.percent.factor);
        const inForce = await this.targets.inForceRows(companyId, productId, this.today());
        if (!factor || !inForce || inForce.rows.length === 0) throw refuse('noTableInForce');
        const made = await this.targets.createRateTableDraft(ctx, {
          companyId, productId, rows: scaledRows(inForce.rows, factor), rules: {}, effectiveFrom: effectiveFrom!, effectiveTo: item.effectiveTo,
          source: { fileName: file?.name ?? item.source.fileName, assetKey: file?.storageKey ?? null, intakeItemId },
        });
        return { kind: 'rate_table', id: made.rateTableId };
      }
      case 'product_rules':
      case 'field_change': {
        const { rules, fields } = settledChanges(item);
        const hasRules = Object.keys(rules).length > 0;
        const patch = await this.fieldPatch(companyId, productId, fields);
        if (!hasRules && !patch) throw refuse('nothingToApply');
        let ref: NonNullable<IntakeItem['appliedRef']> = { kind: 'product', id: productId };
        if (patch) await this.products.update(ctx, companyId, productId, patch);
        if (hasRules) ref = await this.targets.applyRules(ctx, { companyId, productId, rules, effectiveFrom, intakeItemId });
        return ref;
      }
      case 'withdrawn_product':
        await this.products.setLifecycle(ctx, companyId, productId, 'withdrawn');
        return { kind: 'product', id: productId };
      case 'illustration': {
        const id = await this.illustrations.fromIntake(ctx, {
          companyId, productId, fileName: file?.name ?? item.source.fileName, fileKey: file?.storageKey ?? null,
          illustrationDate: effectiveFrom!, plan: null, intakeItemId,
        });
        return { kind: 'illustration', id };
      }
      default:
        throw refuse('nothingToApply');
    }
  }

  /** The catalogue write a card's field changes make, or `null` for none. */
  private async fieldPatch(companyId: string, productId: string, fields: ReturnType<typeof settledChanges>['fields']): Promise<Record<string, unknown> | null> {
    const patch: Record<string, unknown> = {};
    if (fields.name) patch.name = fields.name;
    if (fields.smokerRated !== undefined) patch.smokerRated = fields.smokerRated;
    if (fields.frequencies?.length) patch.frequencies = fields.frequencies;
    if (fields.optionsAdded?.length || fields.optionsRemoved?.length) {
      const product = await this.catalogue.product(companyId, productId);
      const current = ((product as unknown as { proposalFields?: ProposalField[] } | null)?.proposalFields ?? []).map((f) => ({ ...f, options: [...f.options] }));
      for (const { fieldKey, label } of fields.optionsAdded ?? []) {
        const field = current.find((f) => f.key === fieldKey);
        if (field && !field.options.some((o) => o.label === label)) field.options.push({ label, years: null, currency: null });
      }
      for (const { fieldKey, label } of fields.optionsRemoved ?? []) {
        const field = current.find((f) => f.key === fieldKey);
        if (field) field.options = field.options.filter((o) => o.label !== label);
      }
      patch.proposalFields = current;
    }
    return Object.keys(patch).length ? patch : null;
  }

  // ------------------------------------------------------------------------------------------------ helpers

  /** *Perusahaan*'s upload is the Super Admin's, as themselves; a view-as session writes nothing. */
  private assertPlatform(ctx: RequestContext, write: boolean): void {
    if (!ctx.isSuperAdmin) throw new NotFoundException('Intake');
    if (write && (ctx.isImpersonating || ctx.impersonationReadOnly)) {
      throw new DomainException(ErrorCode.PERM_DENIED, PRODUCT_DATA_REFUSALS.PERM_DENIED.readOnly, HttpStatus.FORBIDDEN);
    }
  }

  private async load(ctx: RequestContext, intakeId: string, write: boolean): Promise<UploadIntakeDocument> {
    const intake = isValidObjectId(intakeId) ? await this.intakes.findOne({ _id: intakeId, deletedAt: null }).exec() : null;
    if (!intake) throw new NotFoundException('Intake');
    try {
      if (intake.companyId === null) this.assertPlatform(ctx, write);
      else if (write) await this.access.assertManage(ctx, intake.companyId);
      else await this.access.assertRead(ctx, intake.companyId);
    } catch (err) {
      // Another company's upload answers exactly as one that does not exist: *Company not found* would say it does.
      if (err instanceof NotFoundException) throw new NotFoundException('Intake');
      throw err;
    }
    return intake;
  }

  private async undecided(intake: UploadIntakeDocument, itemId: string): Promise<IntakeItemDocument> {
    if (intake.status === 'reading') {
      throw new DomainException(ErrorCode.INTAKE_ITEM_DECIDED, SAY.INTAKE_ITEM_DECIDED.already({ status: 'reading' }), HttpStatus.CONFLICT, { status: 'reading' });
    }
    const item = isValidObjectId(itemId) ? await this.items.findOne({ _id: itemId, intakeId: String(intake._id), deletedAt: null }).exec() : null;
    if (!item) throw new NotFoundException('Intake item');
    if (item.status === 'applied' || item.status === 'rejected') {
      throw new DomainException(ErrorCode.INTAKE_ITEM_DECIDED, SAY.INTAKE_ITEM_DECIDED.already({ status: item.status }), HttpStatus.CONFLICT, { status: item.status });
    }
    return item;
  }

  /** An answer, as its kind allows: one of the choices, a real day, a number as typed, a short text. */
  private checkedAnswer(q: IntakeQuestion, answer: string, item: IntakeItemDocument): string {
    switch (q.kind) {
      case 'date':
        if (!isRealDay(answer)) throw invalid(SAY.VALIDATION_FAILED.notADay, 'answer');
        return answer;
      case 'type_number':
        if (!typedNumber(answer) || answer.length > 40) throw invalid(SAY.VALIDATION_FAILED.notANumber, 'answer');
        return answer;
      case 'text': {
        if (!answer || answer.length > INTAKE.ANSWER_MAX_LENGTH) throw invalid(SAY.VALIDATION_FAILED.emptyAnswer, 'answer');
        if (q.about === 'new:code' && !/^[A-Za-z][A-Za-z0-9_]{1,59}$/.test(answer)) throw invalid(SAY.VALIDATION_FAILED.emptyAnswer, 'answer');
        return q.about === 'new:code' ? answer.toUpperCase() : answer;
      }
      default:
        void item;
        if (!q.choices.some((c) => c.value === answer)) throw invalid(SAY.VALIDATION_FAILED.notAChoice, 'answer');
        return answer;
    }
  }

  /** Old values again, once the product a card is for is known. */
  private async refreshedDiff(item: IntakeItemDocument, companyId: string, productId: string): Promise<IntakeDiffRow[]> {
    const now = companyId ? await this.targets.productNow(companyId, productId, this.today()) : null;
    if (!now) return item.diff;
    const rupiah = (v: number | null) => (v === null ? null : `Rp${(v / 100).toLocaleString('id-ID')}`);
    return item.diff.map((d) => {
      const [key, sub] = d.key.split(':');
      const r = now.rules;
      switch (key) {
        case 'upStep': case 'upMin': case 'upMax': case 'premiumMin': case 'premiumMax':
          return { ...d, old: rupiah(r[key]) };
        case 'entryAgeMin': case 'entryAgeMax':
          return { ...d, old: r[key] === null ? null : `${r[key]} tahun` };
        case 'payTermMaxAge':
          return { ...d, old: r.payTermMaxAge[sub] === undefined ? null : `${r.payTermMaxAge[sub]} tahun` };
        case 'name':
          return { ...d, old: now.name };
        default:
          return d;
      }
    });
  }

  /** The upload's state again, from its cards; files removed once every card is rejected. */
  private async settle(intakeId: string): Promise<void> {
    const intake = await this.intakes.findById(intakeId).exec();
    if (!intake || intake.status === 'reading') return;
    const items = await this.items.find({ intakeId, deletedAt: null }).select('status').lean().exec();
    const status = intakeStatusOf(false, intake.files, items);
    const set: Record<string, unknown> = { status };
    if (status === 'rejected' && intake.files.some((f) => f.storageKey)) {
      for (const f of intake.files) {
        if (f.storageKey) await this.storage.remove(f.storageKey).catch(() => undefined);
      }
      set.files = intake.files.map((f) => ({ ...f, storageKey: null }));
    }
    await this.intakes.updateOne({ _id: intakeId }, { $set: set }).exec();
  }

  /** A reading the process lost: `failed`, `stale`. */
  private async fresh(intake: UploadIntakeDocument): Promise<UploadIntakeDocument> {
    if (intake.status === 'reading' && isStale(intake.readingStartedAt, this.clock.now())) {
      const files = intake.files.map((f) => (f.status === 'reading' ? { ...f, status: 'failed' as const, failure: 'service_error' as const } : f));
      await this.intakes.updateOne({ _id: intake._id, status: 'reading' }, { $set: { status: 'failed', failure: 'stale', files } }).exec();
      intake.status = 'failed';
      intake.failure = 'stale';
      intake.files = files;
    }
    return intake;
  }

  private async cardView(itemId: string): Promise<IntakeItemView> {
    const item = await this.items.findById(itemId).orFail().exec();
    const names = await this.productNames(item.productId ? [item.productId] : []);
    return itemView(item, names);
  }

  private async productNames(ids: string[]): Promise<Map<string, string>> {
    const entries = await this.catalogue.catalogue(null);
    return new Map(entries.filter((e) => ids.includes(e.id)).map((e) => [e.id, e.name]));
  }

  private async viewOf(intake: UploadIntakeDocument): Promise<IntakeView> {
    const id = String(intake._id);
    const [company, user, items] = await Promise.all([
      intake.companyId && isValidObjectId(intake.companyId) ? this.companies.findById(intake.companyId).select('name').lean().exec() : null,
      isValidObjectId(intake.uploadedBy) ? this.users.findById(intake.uploadedBy).select('fullName').lean().exec() : null,
      this.items.find({ intakeId: id, deletedAt: null }).select('questions status').lean().exec(),
    ]);
    return {
      id,
      companyId: intake.companyId,
      companyName: (company as { name?: string } | null)?.name ?? null,
      status: intake.status,
      failure: intake.failure,
      files: intake.files.map((f) => ({
        index: f.index, name: f.name, kind: f.kind, bytes: f.bytes, status: f.status, failure: f.failure, items: f.items, kept: Boolean(f.storageKey),
      })),
      uploadedBy: intake.uploadedBy,
      uploadedByName: (user as { fullName?: string } | null)?.fullName ?? null,
      createdAt: intake.createdAt.toISOString(),
      readAt: intake.readAt ? intake.readAt.toISOString() : null,
      items: items.length,
      open: items.filter((i) => i.status === 'needs_answers').reduce((n, i) => n + openQuestions(i.questions as IntakeQuestion[]).length, 0),
    };
  }
}

const readingOff = () => new DomainException(ErrorCode.AI_READING_OFF, SAY.AI_READING_OFF.notSwitchedOn, HttpStatus.SERVICE_UNAVAILABLE);
const invalid = (message: Sentence<'VALIDATION_FAILED'>, field: string) =>
  new DomainException(ErrorCode.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, { field });

function itemView(item: IntakeItemDocument, names: ReadonlyMap<string, string>): IntakeItemView {
  const answers = new Map(item.questions.map((q) => [q.id, q.answer]));
  const open = new Set(openQuestions(item.questions).map((q) => q.id));
  return {
    id: String(item._id),
    companyId: item.companyId,
    productId: item.productId,
    productName: item.productId ? names.get(item.productId) ?? null : null,
    productAsWritten: item.productAsWritten,
    kind: item.kind,
    summary: item.summary,
    effectiveFrom: effectiveFromOf(item),
    effectiveTo: item.effectiveTo,
    source: item.source,
    diff: item.diff.map(({ value: _value, ...row }) => row),
    table: item.table ? {
      rows: item.table.rows.length,
      columns: item.table.columns.map((c) => ({ column: c.column, header: c.header, meaning: c.meaning })),
      gaps: item.table.gaps, basis: item.table.basis, currency: item.table.currency,
    } : null,
    percent: item.percent ? { asWritten: item.percent.asWritten, direction: item.percent.direction, rule: item.percent.rule } : null,
    newProductName: item.newProductName,
    questions: item.questions.map((q) => ({
      ...q,
      answeredAt: q.answeredAt ? new Date(q.answeredAt).toISOString() : null,
      open: open.has(q.id),
      asked: q.when === null || answers.get(q.when.question) === q.when.answer,
    })),
    confidence: item.confidence,
    status: item.status,
    appliedRef: item.appliedRef,
    decidedBy: item.decidedBy,
    decidedAt: item.decidedAt ? item.decidedAt.toISOString() : null,
  };
}
