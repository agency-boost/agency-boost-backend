import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { InvalidRequestException, NotFoundException } from '@/common/errors/domain.exception';
import { SEED_PRODUCTS, type ProductLifecycle } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { plainText } from '@/common/validation/plain-text';
import { Product, ProductDocument } from './product.schema';
import { PRODUCTS_REFUSALS } from './products.messages';

/** The company's catalogue, refused in both languages (P18.98-T5 AC-3). */
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
  objectionTheySay: string;
  objectionYouSay: string;
  nextAction: string;
}

export interface ProductView {
  id: string;
  companyId: string;
  code: string;
  name: string;
  tagline: string;
  channel: string;
  category: string;
  primaryNeeds: string[];
  eligibleAgeBands: number[];
  eligibleBudgetBands: number[];
  benefits: string[];
  differentiator: string;
  bestFor: string;
  defaultAttackPlan: AttackPlanView;
  /** Absent for a reader without `commission_rates:read` — left out, never sent and hidden. */
  commissionSchedule?: CommissionYearView[];
  lifecycle: ProductLifecycle;
  replacedByProductId: string | null;
  activeByDefault: boolean;
  sortOrder: number;
  version: number;
}

/** Both halves strip it: a rule enforced on one side only is a rule with a way around it. */
const plain = plainText;

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

    const last = await this.of(companyId).sort({ sortOrder: -1 }).limit(1).exec();
    const created = await this.products.create({
      ...this.writable(input),
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

  /** Everything except the identity and the lifecycle, which move through their own routes. */
  async update(
    ctx: RequestContext, companyId: string, productId: string, input: Record<string, unknown>,
  ): Promise<ProductView> {
    const set = this.writable(input);
    if (Object.keys(set).length === 0) throw new InvalidRequestException(SAY.nothingToChange);

    /*
     * **The row as it was, taken by the write itself** (the Phase 14 exit review, N3): the audit row
     * records the fields written before and after, so a commission schedule changed or cleared says
     * what it replaced. Read separately first, a write in between would have been recorded as this
     * one's starting point.
     */
    const previous = await this.products.findOneAndUpdate(
      { _id: productId, companyId, deletedAt: null },
      { $set: { ...set, updatedBy: ctx.userId }, $inc: { version: 1 } },
      { new: false },
    ).exec();
    if (!previous) throw new NotFoundException('Product');
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
    return this.view(updated, true);
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
      defaultAttackPlan: { ...product.defaultAttackPlan, benefits: [...product.defaultAttackPlan.benefits] },
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
    // meaning of every policy and every attack plan still pointing at it.
    if (await this.products.exists({ companyId, code, deletedAt: null })) {
      throw new InvalidRequestException(SAY.codeTaken({ code }));
    }
  }

  /** The fields a write may set — never `code`, never `lifecycle`, never `companyId`. */
  private writable(input: Record<string, unknown>): Record<string, unknown> {
    const set: Record<string, unknown> = {};
    const text = ['name', 'tagline', 'differentiator', 'bestFor'] as const;
    for (const field of text) {
      if (input[field] !== undefined) set[field] = plain(input[field]);
    }
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
    if (input.commissionSchedule !== undefined) {
      set.commissionSchedule = this.schedule(input.commissionSchedule as CommissionYearView[]);
    }
    if (input.defaultAttackPlan !== undefined) {
      const plan = input.defaultAttackPlan as Record<string, unknown>;
      set.defaultAttackPlan = {
        goodFit: plain(plan.goodFit),
        opening: plain(plan.opening),
        benefits: ((plan.benefits as unknown[]) ?? []).map(plain).filter((line) => line !== ''),
        fullScript: plain(plan.fullScript),
        objectionTheySay: plain(plan.objectionTheySay),
        objectionYouSay: plain(plan.objectionYouSay),
        nextAction: plain(plan.nextAction),
      };
    }
    return set;
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
        objectionTheySay: plan.objectionTheySay,
        objectionYouSay: plan.objectionYouSay,
        nextAction: plan.nextAction,
      },
      // Left out rather than emptied: a reader without the permission never receives the field,
      // so no screen has to remember to hide it.
      ...(withCommission
        ? { commissionSchedule: doc.commissionSchedule.map((c) => ({ year: c.year, rate: c.rate })) }
        : {}),
      lifecycle: doc.lifecycle,
      replacedByProductId: doc.replacedByProductId,
      activeByDefault: doc.activeByDefault,
      sortOrder: doc.sortOrder,
      version: doc.version,
    };
  }
}
