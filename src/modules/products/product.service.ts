import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, InvalidRequestException, NotFoundException, VersionConflictException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import {
  DEFAULT_TENANT_TIMEZONE, PRODUCT_CURRENCIES, SEED_PRODUCTS, seedObjectionsOf,
  type ObjectionCard, type ProductCurrency, type ProductKind, type ProductLifecycle, type ProposalDefaultInsured,
} from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { plainText, plainTextLines } from '@/common/validation/plain-text';
import { KpmProductConfigRepository } from './kpm-product.repository';
import { Product, ProductDocument } from './product.schema';
import { PRODUCTS_REFUSALS, referenceWords } from './products.messages';
import {
  checkProposalSettings, PROPOSAL_SETTING_KEYS,
  type FaqEntry, type PdfDetailBlock, type PlanOption, type ProposalField, type ProposalSettings,
} from './proposal-fields';

/** The company's catalogue, refused in both languages (P18.10-T5 AC-3). */
const SAY = PRODUCTS_REFUSALS.VALIDATION_FAILED;

export interface CommissionYearView {
  year: number;
  rate: number;
}

export interface AttackPlanView {
  goodFit: string;
  opening: string;
  benefits: string[];
  fullScript: string;
  /** *4 · If they push back*, every card in order (ADR-0209 §9). */
  objections: ObjectionCard[];
  nextAction: string;
}

/** What still names a withdrawn product, by kind (`409 PRODUCT_IN_USE`, ADR-0209 §10). */
export interface ProductReferences {
  /** Offices that sell it: a `kpmProductConfigs` row switched on. */
  activations: number;
  /** Offices with a script for it — drafted, approved or sent back (ADR-0037). */
  scriptApprovals: number;
  /** Riders of this company attached to it. */
  riders: number;
}

export interface ProductView {
  id: string;
  companyId: string;
  code: string;
  name: string;
  tagline: string;
  channel: string;
  category: string;
  /** *Produk dasar* or *Rider* (ADR-0209 §1). */
  kind: ProductKind;
  /** A rider's base products, by id; `[]` for a base. */
  attachesTo: string[];
  /** The currencies it is sold in, `IDR` first (ADR-0209 §8). */
  currencies: ProductCurrency[];
  primaryNeeds: string[];
  eligibleAgeBands: number[];
  eligibleBudgetBands: number[];
  benefits: string[];
  differentiator: string;
  bestFor: string;
  defaultAttackPlan: AttackPlanView;
  /** Absent for a reader without `commission_rates:read` — left out, never sent and hidden. */
  commissionSchedule?: CommissionYearView[];
  /** The proposal panel's fields, in order (P19.7-T1; ADR-0225 §1). */
  proposalFields: ProposalField[];
  planOptions: PlanOption[];
  faq: FaqEntry[];
  pdfDetail: PdfDetailBlock[];
  syariahName: string | null;
  /** As stored: `null` reads the category's. */
  defaultInsured: ProposalDefaultInsured | null;
  /** As stored: `null` reads the category's. */
  proposalTypeLabel: string | null;
  lifecycle: ProductLifecycle;
  replacedByProductId: string | null;
  activeByDefault: boolean;
  sortOrder: number;
  version: number;
}

/** A stored value as plain JSON: a Mongoose array is a proxy `structuredClone` cannot copy. */
const plainJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The proposal settings a product holds, as plain values — what `checkProposalSettings` reads and a view answers. */
export function proposalSettingsOf(doc: Partial<ProposalSettings>): ProposalSettings {
  return plainJson({
    proposalFields: doc.proposalFields ?? [],
    planOptions: doc.planOptions ?? [],
    faq: doc.faq ?? [],
    pdfDetail: doc.pdfDetail ?? [],
    syariahName: doc.syariahName ?? null,
    defaultInsured: doc.defaultInsured ?? null,
    proposalTypeLabel: doc.proposalTypeLabel ?? null,
  });
}

/** Whether a write names any of the proposal's settings. */
const touchesProposal = (input: Record<string, unknown>) => PROPOSAL_SETTING_KEYS.some((key) => input[key] !== undefined);

/** Both halves strip it: a rule enforced on one side only is a rule with a way around it. */
const plain = plainText;

/**
 * **A field written in paragraphs keeps its line breaks** (P19-T6 AC-1, B1-2): what sets the product apart and
 * every text field of the attack plan — each a textarea, here and in the Owner's override — with markup out as
 * {@link plain} takes it. A name, a tagline, *best for* and each benefit stay one line: each is typed into one.
 */
const lines = plainTextLines;

/**
 * **The objection cards as a write stores them** (P19.4-T4 AC-1; ADR-0209 §9): each side plain text with its line
 * breaks kept (B1-2), in the order sent; a card with neither side written is dropped. The DTO bounds the count
 * (`PRODUCT_OBJECTIONS_MAX`) and each text.
 */
export function objectionCards(value: unknown): ObjectionCard[] {
  return ((value as { objection?: unknown; answer?: unknown }[] | undefined) ?? [])
    .map((card) => ({ objection: lines(card?.objection), answer: lines(card?.answer) }))
    .filter((card) => card.objection !== '' || card.answer !== '');
}

/**
 * A company's product catalog (P5-T4, ADR-0033).
 *
 * **Company-partitioned, and every read names its company.** There is no tenant-scoped repository
 * here because there is no `kpmId`: the filter that matters is `companyId`, and it is applied in one
 * place — {@link ProductService.of} — so no query can forget it.
 *
 * **Live, not copied.** A withdrawal is one write and every office of that company stops selling the
 * product on its next read. What an office owns is its own decisions (P5-T5).
 */
@Injectable()
export class ProductService {
  constructor(
    @InjectModel(Product.name) private readonly products: Model<ProductDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    /** Offices' rows, counted across offices to refuse deleting a product one still names (ADR-0209 §10). */
    private readonly offices: KpmProductConfigRepository,
  ) {}

  /** Every product of one company, in order, withdrawn rows included. */
  async list(
    companyId: string, opts: { withCommission: boolean },
  ): Promise<ProductView[]> {
    await this.requireCompany(companyId);
    const rows = await this.of(companyId).sort({ sortOrder: 1 }).exec();
    return rows.map((row) => this.view(row, opts.withCommission));
  }

  async create(
    ctx: RequestContext, companyId: string, input: Record<string, unknown>,
  ): Promise<ProductView> {
    await this.requireCompany(companyId);
    const code = String(input.code ?? '').trim().toUpperCase();
    await this.refuseTakenCode(companyId, code);
    // A rider names its bases from the start; a base attaches to nothing (ADR-0209 §2).
    const kind = await this.kindAndBases(companyId, null, input);
    const proposal = touchesProposal(input) ? this.proposalWrite(input, {
      channel: String(input.channel), category: String(input.category),
      currencies: (input.currencies as string[] | undefined) ?? ['IDR'],
    }, {}) : {};

    const last = await this.of(companyId).sort({ sortOrder: -1 }).limit(1).exec();
    const created = await this.products.create({
      ...this.writable(input),
      ...kind,
      ...proposal,
      companyId,
      code,
      // Appended: somebody adding a product has not said where on the shelf it goes.
      sortOrder: (last[0]?.sortOrder ?? 0) + 1,
      lifecycle: 'active',
      replacedByProductId: null,
      version: 1,
      deletedAt: null,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    });

    await this.record(ctx, 'product.created', created, { code, companyId });
    return this.view(created, true);
  }

  /**
   * Everything except the identity and the lifecycle, which move through their own routes.
   *
   * **Pinned to the version the editor read, when it says one** (P19-T6 AC-2; the 11-03 handover's B1-10): an
   * `expectedVersion` the product has moved past — somebody else saved it, closed it or withdrew it since — is
   * refused `409 VERSION_CONFLICT` and nothing is written, where the last save used to win. The pin is part of the
   * write's own filter, so of two saves racing on one version exactly one lands. Absent, the write lands whatever
   * the version, as it always did: an API caller from before the pin still works.
   */
  async update(
    ctx: RequestContext, companyId: string, productId: string, input: Record<string, unknown>,
  ): Promise<ProductView> {
    const set = this.writable(input);
    const expected = typeof input.expectedVersion === 'number' ? input.expectedVersion : undefined;
    const kindChange = input.kind !== undefined || input.attachesTo !== undefined;
    /*
     * **The proposal's settings are checked across the product as it will be** (P19.7-T1 AC-3; ADR-0225 §2): a plan
     * card against the plan field, a formula against the money keys, a currency option against what the product
     * sells, `syariahName` against its channel — so a change to the channel or the currencies is checked too.
     */
    const proposalChange = touchesProposal(input) || input.channel !== undefined || input.currencies !== undefined;
    if (kindChange || proposalChange) {
      /*
       * **The kind and the bases are checked against the row as it is** (ADR-0209 §2): a rider's bases must be this
       * company's active bases, and a kind cannot change under an attachment. Read first, so a refusal names the
       * product; the write below is still pinned to the version the editor read.
       */
      const current = await this.of(companyId).findOne({ _id: this.idOf(productId) }).exec();
      if (!current) throw new NotFoundException('Product');
      if (expected !== undefined && expected !== current.version) {
        throw new VersionConflictException(expected, current.version);
      }
      if (kindChange) Object.assign(set, await this.kindAndBases(companyId, current, input));
      if (proposalChange) {
        Object.assign(set, this.proposalWrite(input, {
          channel: (set.channel as string | undefined) ?? current.channel,
          category: (set.category as string | undefined) ?? current.category,
          currencies: (set.currencies as string[] | undefined) ?? current.currencies ?? ['IDR'],
        }, proposalSettingsOf(current)));
      }
    }
    if (Object.keys(set).length === 0) throw new InvalidRequestException(SAY.nothingToChange);

    /*
     * **The row as it was, taken by the write itself** (the Phase 14 exit review, N3): the audit row
     * records the fields written before and after, so a commission schedule changed or cleared says
     * what it replaced. Read separately first, a write in between would have been recorded as this
     * one's starting point.
     */
    const previous = await this.products.findOneAndUpdate(
      {
        _id: this.idOf(productId), companyId, deletedAt: null,
        ...(expected === undefined ? {} : { version: expected }),
      },
      { $set: { ...set, updatedBy: ctx.userId }, $inc: { version: 1 } },
      { new: false },
    ).exec();
    if (!previous) {
      // The scope first: a product of another company is not here, whatever version was named (ADR-0002).
      const now = expected === undefined ? null : await this.of(companyId).findOne({ _id: this.idOf(productId) }).exec();
      if (now) throw new VersionConflictException(expected!, now.version);
      throw new NotFoundException('Product');
    }
    const updated = await this.of(companyId).findOne({ _id: productId }).orFail().exec();

    const was = previous.toObject() as unknown as Record<string, unknown>;
    const before = Object.fromEntries(Object.keys(set).map((field) => [field, was[field] ?? null]));
    await this.record(ctx, 'product.updated', updated, set, before);
    return this.view(updated, true);
  }

  /**
   * Move a product along its lifecycle.
   *
   * Named routes rather than a field somebody patches: withdrawing a product stops every office of
   * the company selling it, and an act with that reach should read as an act.
   */
  async setLifecycle(
    ctx: RequestContext,
    companyId: string,
    productId: string,
    lifecycle: ProductLifecycle,
    replacedByProductId?: string | null,
  ): Promise<ProductView> {
    const at = this.clock.now();
    if (replacedByProductId) {
      const successor = await this.of(companyId).findOne({ _id: replacedByProductId }).exec();
      if (!successor) {
        throw new InvalidRequestException(SAY.replacementNotOnShelf);
      }
    }

    const updated = await this.products.findOneAndUpdate(
      { _id: productId, companyId, deletedAt: null },
      {
        $set: {
          lifecycle,
          replacedByProductId: replacedByProductId ?? null,
          lifecycleChangedAt: at,
          lifecycleChangedBy: ctx.userId,
          updatedBy: ctx.userId,
        },
        $inc: { version: 1 },
      },
      { new: true },
    ).exec();
    if (!updated) throw new NotFoundException('Product');

    await this.record(ctx, `product.${lifecycle}`, updated, {
      code: updated.code, replacedByProductId: replacedByProductId ?? null,
    });
    if (lifecycle === 'withdrawn' && updated.kind === 'base') await this.detachFromRiders(ctx, companyId, updated);
    return this.view(updated, true);
  }

  /**
   * **A withdrawn base leaves its riders** (P19.4-T4 AC-6; the riders spec's rule 4; ADR-0209 §4): it is taken out of
   * every rider's `attachesTo`, each rider so changed a new version, audited `product.updated` with the reason
   * `base_withdrawn`. A rider left with none is hidden from agents — no base offers it — and its row says so. Putting
   * the base back on sale does not re-attach it: the Super Admin chooses again.
   */
  private async detachFromRiders(ctx: RequestContext, companyId: string, base: ProductDocument): Promise<void> {
    const baseId = String(base._id);
    const riders = await this.products.find({ companyId, kind: 'rider', attachesTo: baseId, deletedAt: null }).exec();
    for (const rider of riders) {
      const changed = await this.products.findOneAndUpdate(
        { _id: rider._id, companyId, deletedAt: null },
        { $pull: { attachesTo: baseId }, $set: { updatedBy: ctx.userId }, $inc: { version: 1 } },
        { new: true },
      ).exec();
      if (!changed) continue;
      await this.record(
        ctx, 'product.updated', changed,
        { attachesTo: [...changed.attachesTo], reason: 'base_withdrawn', baseId, baseCode: base.code },
        { attachesTo: [...rider.attachesTo] },
      );
    }
  }

  /**
   * **Delete a withdrawn product nothing references** (P19.4-T4 AC-13; B1-5, OD-264; ADR-0209 §10): a soft delete —
   * `deletedAt`, audited `product.deleted` — after which no read lists it. Its code is never reused.
   *
   * - A product on sale or in run-off is refused (`400`): it is withdrawn first.
   * - **A product something names is refused `409 PRODUCT_IN_USE`**, `details.references` the kinds and counts: an
   *   office that sells it, an office's script for it, a rider attached to it. Nothing is written.
   * - Neither a lead nor a training module names a product today, so neither is counted: there is nothing to count.
   */
  async remove(ctx: RequestContext, companyId: string, productId: string): Promise<void> {
    const product = await this.of(companyId).findOne({ _id: this.idOf(productId) }).exec();
    if (!product) throw new NotFoundException('Product');
    if (product.lifecycle !== 'withdrawn') {
      throw new InvalidRequestException(SAY.deleteOnSale({ name: product.name }), { lifecycle: product.lifecycle });
    }

    const references = await this.referencesTo(ctx, companyId, String(product._id));
    if (references.activations + references.scriptApprovals + references.riders > 0) {
      throw new DomainException(
        ErrorCode.PRODUCT_IN_USE,
        PRODUCTS_REFUSALS.PRODUCT_IN_USE.referenced({ name: product.name, reasons: referenceWords(references) }),
        HttpStatus.CONFLICT,
        { productId: String(product._id), code: product.code, references },
      );
    }

    const at = this.clock.now();
    const deleted = await this.products.findOneAndUpdate(
      { _id: product._id, companyId, deletedAt: null, lifecycle: 'withdrawn' },
      { $set: { deletedAt: at, deletedBy: ctx.userId, updatedBy: ctx.userId }, $inc: { version: 1 } },
      { new: true },
    ).exec();
    if (!deleted) throw new NotFoundException('Product');
    await this.record(
      ctx, 'product.deleted', deleted,
      { code: deleted.code, deletedAt: at.toISOString() },
      { code: product.code, lifecycle: product.lifecycle },
    );
  }

  /** What names one product: offices' rows across every office of the company, and the company's riders. */
  private async referencesTo(ctx: RequestContext, companyId: string, productId: string): Promise<ProductReferences> {
    const [offices, riders] = await Promise.all([
      this.offices.referencesToProductAcrossTenants(ctx, productId),
      this.products.countDocuments({ companyId, kind: 'rider', attachesTo: productId, deletedAt: null }).exec(),
    ]);
    return { ...offices, riders };
  }

  /** The whole shelf in the order wanted, so two people reordering cannot interleave. */
  async reorder(ctx: RequestContext, companyId: string, ids: string[]): Promise<ProductView[]> {
    const rows = await this.of(companyId).exec();
    const known = new Set(rows.map((row) => String(row._id)));
    const wanted = new Set(ids);
    if (ids.length !== rows.length || wanted.size !== ids.length
      || ids.some((id) => !known.has(id))) {
      throw new InvalidRequestException(SAY.sendEveryProduct({ count: rows.length }));
    }

    await Promise.all(ids.map((id, index) => this.products.updateOne(
      { _id: id, companyId },
      // Position is presentation: it bumps no version, as every other reorder in this product.
      { $set: { sortOrder: index + 1, updatedBy: ctx.userId } },
    ).exec()));

    await this.audit.record(ctx, {
      action: 'product.reordered',
      targetCollection: 'products',
      targetId: companyId,
      after: { companyId, products: ids.length },
    });
    return this.list(companyId, { withCommission: true });
  }

  /**
   * The catalog a new company starts with (P5-T4).
   *
   * Copied at creation and owned from then on, the way an office owns its taxonomy. A company that
   * already has products is left alone, so running it twice changes nothing.
   */
  async seedForCompany(companyId: string): Promise<number> {
    if (await this.products.exists({ companyId, deletedAt: null })) return 0;

    const now = this.clock.now();
    const rows = SEED_PRODUCTS.map((product) => ({
      ...product,
      primaryNeeds: [...product.primaryNeeds],
      eligibleAgeBands: [...product.eligibleAgeBands],
      eligibleBudgetBands: [...product.eligibleBudgetBands],
      benefits: [...product.benefits],
      defaultAttackPlan: {
        goodFit: product.defaultAttackPlan.goodFit,
        opening: product.defaultAttackPlan.opening,
        benefits: [...product.defaultAttackPlan.benefits],
        fullScript: product.defaultAttackPlan.fullScript,
        // The seed's one pair, as the card a product stores (ADR-0209 §9).
        objections: seedObjectionsOf(product.defaultAttackPlan),
        nextAction: product.defaultAttackPlan.nextAction,
      },
      kind: 'base',
      attachesTo: [],
      currencies: ['IDR'],
      companyId,
      commissionSchedule: [],
      replacedByProductId: null,
      lifecycleChangedAt: null,
      lifecycleChangedBy: null,
      version: 1,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
      createdAt: now,
      updatedAt: now,
    }));
    await this.products.insertMany(rows);
    return rows.length;
  }

  /**
   * **A new company's catalog, copied from another company's** (ADR-0164 §4): every live product of the
   * Template library, its lifecycle included, as the new company's own — version 1, nobody's edit. A copy,
   * never a link: a later change to either shelf is that company's alone.
   *
   * Two things are not copied. **Commission**, which each company states for itself — a figure an agent reads
   * as their pay is the source's, not this insurer's (parity F-15). **The product documents**, which are the
   * source company's files: the new company uploads its own. A replacement is pointed at the copy of the
   * product it names. A company that already has products is left alone, as `seedForCompany` leaves it.
   */
  async copyFromCompany(sourceCompanyId: string, companyId: string): Promise<number> {
    if (await this.products.exists({ companyId, deletedAt: null })) return 0;
    const source = await this.products.find({ companyId: sourceCompanyId, deletedAt: null }).lean().exec();
    if (source.length === 0) return 0;

    const now = this.clock.now();
    const ids = new Map(source.map((p) => [String(p._id), new Types.ObjectId()]));
    const rows = source.map((product) => {
      const { _id, createdAt: _c, updatedAt: _u, __v: _v, ...fields } = product as typeof product & {
        createdAt?: Date; updatedAt?: Date; __v?: number;
      };
      const replacement = product.replacedByProductId ? ids.get(product.replacedByProductId) ?? null : null;
      return {
        ...structuredClone(fields),
        _id: ids.get(String(_id)),
        // A rider's bases are the copies of its bases (ADR-0209 §2): never the source company's ids.
        attachesTo: (product.attachesTo ?? []).flatMap((id) => (ids.has(id) ? [String(ids.get(id))] : [])),
        companyId,
        commissionSchedule: [],
        defaultDocuments: {},
        replacedByProductId: replacement ? String(replacement) : null,
        lifecycleChangedAt: null,
        lifecycleChangedBy: null,
        version: 1,
        deletedAt: null,
        createdBy: null,
        updatedBy: null,
        createdAt: now,
        updatedAt: now,
      };
    });
    await this.products.insertMany(rows);
    return rows.length;
  }

  // -------------------------------------------------------------------- internals

  /**
   * The company filter for every **read**.
   *
   * It said "the one place `companyId` is applied, so no query can forget it", and that was not
   * true: `update`, `setLifecycle` and `reorder` each apply it inline. Every mutating query does
   * still filter on it — this is not a leak — but a reader who believed the old sentence would
   * check one function and conclude the boundary was held there.
   */
  private of(companyId: string) {
    return this.products.find({ companyId, deletedAt: null });
  }

  private async requireCompany(companyId: string): Promise<void> {
    const company = await this.companies.findOne({ _id: companyId, deletedAt: null }).exec();
    if (!company) throw new NotFoundException('Company');
  }

  private async refuseTakenCode(companyId: string, code: string): Promise<void> {
    // Counting withdrawn rows: a retired code that came back as something else would change the
    // meaning of every policy and every attack plan still pointing at it. **And deleted ones** (P19.4-T4 AC-13,
    // ADR-0209 §10): the unique index counts live rows only, so a deleted product's code is refused here.
    if (await this.products.exists({ companyId, code })) {
      throw new InvalidRequestException(SAY.codeTaken({ code }));
    }
  }

  /** The fields a write may set — never `code`, never `lifecycle`, never `companyId`. */
  private writable(input: Record<string, unknown>): Record<string, unknown> {
    const set: Record<string, unknown> = {};
    const text = ['name', 'tagline', 'bestFor'] as const;
    for (const field of text) {
      if (input[field] !== undefined) set[field] = plain(input[field]);
    }
    if (input.differentiator !== undefined) set.differentiator = lines(input.differentiator);
    for (const field of ['channel', 'category'] as const) {
      if (input[field] !== undefined) set[field] = input[field];
    }
    for (const field of ['primaryNeeds', 'eligibleAgeBands', 'eligibleBudgetBands'] as const) {
      if (input[field] !== undefined) set[field] = input[field];
    }
    if (input.benefits !== undefined) {
      set.benefits = (input.benefits as unknown[]).map(plain).filter((line) => line !== '');
    }
    if (input.activeByDefault !== undefined) set.activeByDefault = Boolean(input.activeByDefault);
    if (input.currencies !== undefined) {
      // Stored in the registry's order, `IDR` first, so *IDR + USD* reads one way everywhere (ADR-0209 §8).
      const named = new Set(input.currencies as string[]);
      set.currencies = PRODUCT_CURRENCIES.filter((currency) => named.has(currency));
    }
    if (input.commissionSchedule !== undefined) {
      set.commissionSchedule = this.schedule(input.commissionSchedule as CommissionYearView[]);
    }
    if (input.defaultAttackPlan !== undefined) {
      const plan = input.defaultAttackPlan as Record<string, unknown>;
      // Every text field of the plan keeps its lines (P19-T6 AC-1); a benefit is one line of the list.
      set.defaultAttackPlan = {
        goodFit: lines(plan.goodFit),
        opening: lines(plan.opening),
        benefits: ((plan.benefits as unknown[]) ?? []).map(plain).filter((line) => line !== ''),
        fullScript: lines(plan.fullScript),
        objections: objectionCards(plan.objections),
        nextAction: lines(plan.nextAction),
      };
    }
    return set;
  }

  /**
   * **A product's kind and its bases, as a write sets them** (P19.4-T4 AC-4; the riders spec's rule 2; ADR-0209 §2).
   * `{}` when the write names neither and creates nothing.
   *
   * - A rider names at least one base — empty is *"Pilih minimal satu produk dasar"*, `details.field: 'attachesTo'` —
   *   and each is a live product of **this** company, a base, and on sale. Another company's id is refused as one
   *   this catalogue does not have, naming nothing of that company.
   * - A base attaches to nothing.
   * - **A kind does not change under an attachment** (`409 PRODUCT_KIND_IN_USE`): a base some rider attaches to does
   *   not become a rider, and a rider still attached does not become a base unless the same write clears its bases.
   */
  private async kindAndBases(
    companyId: string, current: ProductDocument | null, input: Record<string, unknown>,
  ): Promise<{ kind?: ProductKind; attachesTo?: string[] }> {
    if (current === null && input.kind === undefined && input.attachesTo === undefined) return {};
    const kind = (input.kind as ProductKind | undefined) ?? current?.kind ?? 'base';
    const sent = input.attachesTo as string[] | undefined;

    if (kind === 'base') {
      if (sent !== undefined && sent.length > 0) {
        throw new InvalidRequestException(SAY.baseAttaches, { field: 'attachesTo' });
      }
      if (current?.kind === 'rider' && sent === undefined && current.attachesTo.length > 0) {
        throw new DomainException(
          ErrorCode.PRODUCT_KIND_IN_USE,
          PRODUCTS_REFUSALS.PRODUCT_KIND_IN_USE.riderHasBases({ name: current.name, bases: current.attachesTo.length }),
          HttpStatus.CONFLICT,
          { productId: String(current._id), bases: current.attachesTo.length },
        );
      }
      return { kind, attachesTo: [] };
    }

    if (current?.kind === 'base') {
      const riders = await this.products
        .countDocuments({ companyId, kind: 'rider', attachesTo: String(current._id), deletedAt: null }).exec();
      if (riders > 0) {
        throw new DomainException(
          ErrorCode.PRODUCT_KIND_IN_USE,
          PRODUCTS_REFUSALS.PRODUCT_KIND_IN_USE.baseHasRiders({ name: current.name, riders }),
          HttpStatus.CONFLICT,
          { productId: String(current._id), riders },
        );
      }
    }
    const bases = [...new Set(sent ?? current?.attachesTo ?? [])];
    if (bases.length === 0) throw new InvalidRequestException(SAY.attachAtLeastOne, { field: 'attachesTo' });
    // A rider is never its own base: it is a rider.
    if (current && bases.includes(String(current._id))) {
      throw new InvalidRequestException(SAY.attachToRider({ name: current.name }), { field: 'attachesTo' });
    }
    const valid = bases.filter((id) => Types.ObjectId.isValid(id));
    const found = valid.length === 0 ? [] : await this.of(companyId).find({ _id: { $in: valid } }).exec();
    if (found.length !== bases.length) {
      throw new InvalidRequestException(SAY.attachNotOnShelf, { field: 'attachesTo' });
    }
    const rider = found.find((product) => product.kind === 'rider');
    if (rider) throw new InvalidRequestException(SAY.attachToRider({ name: rider.name }), { field: 'attachesTo' });
    const offSale = found.find((product) => product.lifecycle !== 'active');
    if (offSale) throw new InvalidRequestException(SAY.attachNotActive({ name: offSale.name }), { field: 'attachesTo' });
    return { kind, attachesTo: bases };
  }

  /**
   * **The proposal settings a write sets** (P19.7-T1 AC-3; ADR-0225 §2): the stored ones with the write's over them,
   * checked whole, and the keys the write sent taken from the result. `{}` when it sent none (a change of channel or
   * currencies is checked, and writes nothing here).
   */
  private proposalWrite(
    input: Record<string, unknown>,
    product: { channel: string; category: string; currencies: readonly string[] },
    stored: Partial<ProposalSettings>,
  ): Partial<ProposalSettings> {
    const today = this.clock.localDateFor(DEFAULT_TENANT_TIMEZONE, this.clock.now());
    const sent = Object.fromEntries(PROPOSAL_SETTING_KEYS.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
    const checked = checkProposalSettings(sent, stored, { ...product, today });
    return Object.fromEntries(Object.keys(sent).map((key) => [key, checked[key as keyof ProposalSettings]]));
  }

  /** A product id as the database holds it, or one that matches nothing — a malformed id is not here (`404`). */
  private idOf(productId: string): Types.ObjectId | string {
    return Types.ObjectId.isValid(productId) ? new Types.ObjectId(productId) : '0'.repeat(24);
  }

  /**
   * A commission schedule as the company states it (OD-135, ADR-0119): a rate for each policy
   * year from year 1, **none missing and none twice**, stored in year order.
   *
   * The DTO bounds each row (a year from 1, a proportion from 0 to 1); this is the rule across
   * rows, which no decorator sees. A gap is refused rather than filled: *"Y3"* with no *Y2* on an
   * agent's drawer reads as a year with no commission, which nobody stated either.
   */
  private schedule(rows: CommissionYearView[]): CommissionYearView[] {
    const sorted = rows
      .map((row) => ({ year: row.year, rate: row.rate }))
      .sort((a, b) => a.year - b.year);
    if (sorted.some((row, index) => row.year !== index + 1)) {
      throw new InvalidRequestException(SAY.scheduleGaps({ years: sorted.map((row) => row.year) }));
    }
    return sorted;
  }

  private record(
    ctx: RequestContext, action: string, doc: ProductDocument, after: Record<string, unknown>,
    before: Record<string, unknown> | null = null,
  ) {
    return this.audit.record(ctx, {
      action,
      targetCollection: 'products',
      targetId: String(doc._id),
      before,
      after,
    });
  }

  private view(doc: ProductDocument, withCommission: boolean): ProductView {
    // Read straight off the document: the schema defaults every field of the plan, so a fallback
    // here would be a branch that cannot fire and a test that only proves it cannot.
    const plan = doc.defaultAttackPlan;
    return {
      id: String(doc._id),
      companyId: doc.companyId,
      code: doc.code,
      name: doc.name,
      tagline: doc.tagline,
      channel: doc.channel,
      category: doc.category,
      kind: doc.kind ?? 'base',
      attachesTo: [...(doc.attachesTo ?? [])],
      currencies: [...(doc.currencies ?? ['IDR'])],
      primaryNeeds: [...doc.primaryNeeds],
      eligibleAgeBands: [...doc.eligibleAgeBands],
      eligibleBudgetBands: [...doc.eligibleBudgetBands],
      benefits: [...doc.benefits],
      differentiator: doc.differentiator,
      bestFor: doc.bestFor,
      defaultAttackPlan: {
        goodFit: plan.goodFit,
        opening: plan.opening,
        benefits: [...plan.benefits],
        fullScript: plan.fullScript,
        objections: (plan.objections ?? []).map(({ objection, answer }) => ({ objection, answer })),
        nextAction: plan.nextAction,
      },
      // Left out rather than emptied: a reader without the permission never receives the field,
      // so no screen has to remember to hide it.
      ...(withCommission
        ? { commissionSchedule: doc.commissionSchedule.map((c) => ({ year: c.year, rate: c.rate })) }
        : {}),
      // Plain copies of what is stored: the documents are the checked shapes of `proposal-fields.ts` (ADR-0225 §1).
      ...(proposalSettingsOf({
        proposalFields: doc.proposalFields, planOptions: doc.planOptions, faq: doc.faq, pdfDetail: doc.pdfDetail,
        syariahName: doc.syariahName, defaultInsured: doc.defaultInsured, proposalTypeLabel: doc.proposalTypeLabel,
      })),
      lifecycle: doc.lifecycle,
      replacedByProductId: doc.replacedByProductId,
      activeByDefault: doc.activeByDefault,
      sortOrder: doc.sortOrder,
      version: doc.version,
    };
  }
}
