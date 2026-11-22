import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { InvalidRequestException, NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { PRODUCT_DRAFT_REFUSALS } from './product-draft.messages';
import { Product, ProductDocument, type ProductDraft } from './product.schema';
import { ProductService, type ProductView } from './product.service';

const SAY = PRODUCT_DRAFT_REFUSALS.VALIDATION_FAILED;

/** Where a product stands for *Terbitkan ke KPM* (ADR-0278 §4). */
export type ProductReleaseState =
  /** A new product, made in *Produk & proposal*, published to no KPM yet. */
  | 'unpublished'
  /** Published, with edits waiting in its draft. */
  | 'draft'
  /** Published, nothing waiting. */
  | 'published';

/** **One product as *Produk & proposal* and *Terbitkan ke KPM* read it** (ADR-0278 §4): its draft and its release. */
export interface ProductDraftView {
  id: string;
  code: string;
  name: string;
  state: ProductReleaseState;
  /** The unpublished edits, by field, or `null`. A new product's edits are the product itself, so it never has one. */
  draft: ProductDraft | null;
  /** `null`: every KPM of the company. A list: the KPMs it was published to. */
  releasedTo: string[] | null;
  firstPublishedAt: string | null;
  /** *Juga sesuai*, as published. */
  alsoFits: string[];
  /** *Brosur / file*: the company's brochure for it, by its label, or `null` where none is stored. */
  brochure: { label: string } | null;
}

/** The fields of a draft that are not the product's own write: set on the row by this service when published. */
const OWN_FIELDS = ['alsoFits'] as const;

/**
 * **A product's draft and its release to KPMs** (P19.23-T4 AC-3, AC-5; ADR-0278 §4).
 *
 * - **A published product's edits wait in `draft`**, read by no KPM, until *Terbitkan ke KPM* publishes them through the
 *   product's own write (`ProductService.update`) — every check that write makes, and its version and audit row.
 *   Published, they reach **every KPM that has the product**, as ADR-0033 reads it live (OD-423 by its default).
 * - **A new product starts released to nobody** (`releasedTo: []`, never published): its edits go straight to the row,
 *   which no KPM reads, so the editor's every check answers at once. Published, it is **added** to the KPMs chosen, and
 *   nothing in their settings changes.
 *
 * Company-partitioned like the catalogue: every read names the company, through {@link of}; another company's product is
 * `404`. The Super Admin's alone (`product_catalog:crud`), asked here as well as on the route. Every write audited.
 */
@Injectable()
export class ProductDraftService {
  constructor(
    @InjectModel(Product.name) private readonly products: Model<ProductDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    private readonly catalogue: ProductService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Every product of the company with its draft and release, in shelf order. `404` for a company that is not one. */
  async list(ctx: RequestContext, companyId: string): Promise<ProductDraftView[]> {
    this.require(ctx);
    await this.requireCompany(companyId);
    const rows = await this.of(companyId).sort({ sortOrder: 1 }).exec();
    return rows.map((row) => draftViewOf(row));
  }

  /**
   * ***+ Produk baru*** (AC-3): the product made as the catalogue makes one — the code checked, the shelf's end — and
   * **released to nobody**, so no KPM sees it until it is published to the ones chosen.
   */
  async create(ctx: RequestContext, companyId: string, input: Record<string, unknown>): Promise<ProductView> {
    this.require(ctx);
    const made = await this.catalogue.create(ctx, companyId, input);
    await this.products.updateOne(
      { _id: this.idOf(made.id), companyId }, { $set: { releasedTo: [], firstPublishedAt: null, draft: null } },
    ).exec();
    await this.audit.record(ctx, {
      action: 'product.draft_created',
      targetCollection: 'products',
      targetId: made.id,
      after: { companyId, code: made.code, releasedTo: [] },
    });
    return made;
  }

  /**
   * ***Simpan draf*** (AC-3): the fields sent, merged over the draft already saved. A product published to no KPM yet is
   * written at once instead — nobody reads it — so its checks answer now. `alsoFits` must name the company's other
   * products. `400` for nothing sent.
   */
  async save(
    ctx: RequestContext, companyId: string, productId: string, input: Record<string, unknown>,
  ): Promise<ProductDraftView> {
    this.require(ctx);
    const product = await this.requireProduct(companyId, productId);
    const fields = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    if (Object.keys(fields).length === 0) throw new InvalidRequestException(SAY.emptyDraft);
    if (fields.alsoFits !== undefined) {
      fields.alsoFits = await this.checkAlsoFits(companyId, product, fields.alsoFits as string[]);
    }

    if (stateOf(product) === 'unpublished') {
      await this.writeThrough(ctx, companyId, product, fields);
      return draftViewOf(await this.requireProduct(companyId, productId));
    }

    const before = product.draft ?? null;
    const after = { ...(before ?? {}), ...fields };
    await this.products.updateOne(
      { _id: product._id, companyId, deletedAt: null }, { $set: { draft: after, updatedBy: ctx.userId } },
    ).exec();
    await this.audit.record(ctx, {
      action: 'product.draft_saved',
      targetCollection: 'products',
      targetId: String(product._id),
      before: { draft: before },
      after: { companyId, code: product.code, draft: after },
    });
    return draftViewOf(await this.requireProduct(companyId, productId));
  }

  /** ***Hapus draf***: the published product stands as it is. `400` where no draft waits. */
  async discard(ctx: RequestContext, companyId: string, productId: string): Promise<ProductDraftView> {
    this.require(ctx);
    const product = await this.requireProduct(companyId, productId);
    if (!product.draft) throw new InvalidRequestException(SAY.noDraft({ name: product.name }));
    await this.products.updateOne(
      { _id: product._id, companyId, deletedAt: null }, { $set: { draft: null, updatedBy: ctx.userId } },
    ).exec();
    await this.audit.record(ctx, {
      action: 'product.draft_discarded',
      targetCollection: 'products',
      targetId: String(product._id),
      before: { draft: product.draft },
      after: { companyId, code: product.code, draft: null },
    });
    return draftViewOf(await this.requireProduct(companyId, productId));
  }

  // ---------------------------------------------------------- what *Terbitkan ke KPM* calls

  /**
   * **Publish a product's draft** (AC-5): its fields through the product's own write — every check, a new version, the
   * `product.updated` row — and `alsoFits` set beside them; the draft cleared. Nothing where no draft waits.
   */
  async publishDraft(ctx: RequestContext, companyId: string, productId: string): Promise<boolean> {
    const product = await this.requireProduct(companyId, productId);
    if (!product.draft) return false;
    await this.writeThrough(ctx, companyId, product, product.draft);
    await this.products.updateOne({ _id: product._id, companyId }, { $set: { draft: null } }).exec();
    return true;
  }

  /**
   * **Add the product to these KPMs** (AC-5: *"a new product only adds"*): each named once in `releasedTo`, the first
   * publication's date kept. A product every KPM already has (`releasedTo: null`) is left as it is. Audited
   * `product.released`, naming the KPMs added.
   */
  async release(ctx: RequestContext, companyId: string, productId: string, kpmIds: readonly string[]): Promise<void> {
    const product = await this.requireProduct(companyId, productId);
    if (product.releasedTo === null || product.releasedTo === undefined) return;
    const added = kpmIds.filter((id) => !product.releasedTo!.includes(id));
    const now = this.clock.now();
    await this.products.updateOne(
      { _id: product._id, companyId, deletedAt: null },
      {
        $addToSet: { releasedTo: { $each: [...kpmIds] } },
        $set: { firstPublishedAt: product.firstPublishedAt ?? now, updatedBy: ctx.userId },
      },
    ).exec();
    await this.audit.record(ctx, {
      action: 'product.released',
      targetCollection: 'products',
      targetId: String(product._id),
      before: { releasedTo: product.releasedTo },
      after: { companyId, code: product.code, added },
    });
  }

  /** The company's products as rows, for *Terbitkan ke KPM*'s list of changes. */
  async rowsOf(companyId: string): Promise<ProductDocument[]> {
    return this.of(companyId).sort({ sortOrder: 1 }).exec();
  }

  // -------------------------------------------------------------------------- internals

  /** The draft's fields through the catalogue's write, and the fields that are this service's beside it. */
  private async writeThrough(
    ctx: RequestContext, companyId: string, product: ProductDocument, fields: Record<string, unknown>,
  ): Promise<void> {
    const own = Object.fromEntries(OWN_FIELDS.filter((k) => fields[k] !== undefined).map((k) => [k, fields[k]]));
    const write = Object.fromEntries(Object.entries(fields).filter(([k]) => !(OWN_FIELDS as readonly string[]).includes(k)));
    if (Object.keys(write).length) await this.catalogue.update(ctx, companyId, String(product._id), write);
    if (Object.keys(own).length) {
      await this.products.updateOne({ _id: product._id, companyId, deletedAt: null }, { $set: own }).exec();
      await this.audit.record(ctx, {
        action: 'product.updated',
        targetCollection: 'products',
        targetId: String(product._id),
        before: Object.fromEntries(Object.keys(own).map((k) => [k, (product as unknown as Record<string, unknown>)[k] ?? null])),
        after: { companyId, code: product.code, ...own },
      });
    }
  }

  /** Each code one of the company's other products, upper-cased, in the order sent; `400` naming any that is not. */
  private async checkAlsoFits(companyId: string, product: ProductDocument, codes: readonly string[]): Promise<string[]> {
    const wanted = codes.map((c) => String(c).trim().toUpperCase()).filter(Boolean);
    const known = new Set(
      (await this.of(companyId).select('code').lean().exec()).map((p) => String((p as { code: string }).code)),
    );
    const unknown = wanted.filter((c) => c === product.code || !known.has(c));
    if (unknown.length) throw new InvalidRequestException(SAY.alsoFitsUnknown({ codes: unknown }), { field: 'alsoFits' });
    return wanted;
  }

  private require(ctx: RequestContext): void {
    if (!can(ctx, 'product_catalog:crud')) throw new PermissionDeniedException('product_catalog:crud');
  }

  private async requireCompany(companyId: string): Promise<void> {
    const found = Types.ObjectId.isValid(companyId)
      ? await this.companies.exists({ _id: companyId, deletedAt: null }).exec()
      : null;
    if (!found) throw new NotFoundException('Company');
  }

  private async requireProduct(companyId: string, productId: string): Promise<ProductDocument> {
    const product = await this.of(companyId).findOne({ _id: this.idOf(productId) }).exec();
    if (!product) throw new NotFoundException('Product');
    return product;
  }

  /** **The company filter for every product this service reads**, applied here and nowhere else in it. */
  private of(companyId: string) {
    return this.products.find({ companyId, deletedAt: null });
  }

  private idOf(productId: string): Types.ObjectId | string {
    return Types.ObjectId.isValid(productId) ? new Types.ObjectId(productId) : '0'.repeat(24);
  }
}

/** Where one product stands (ADR-0278 §4): never published, a draft waiting, or published. */
export function stateOf(product: Pick<Product, 'releasedTo' | 'firstPublishedAt' | 'draft'>): ProductReleaseState {
  const released = product.releasedTo;
  if (Array.isArray(released) && released.length === 0 && !product.firstPublishedAt) return 'unpublished';
  return product.draft ? 'draft' : 'published';
}

function draftViewOf(row: ProductDocument): ProductDraftView {
  const documents = row.defaultDocuments as Map<string, { label?: string }> | Record<string, { label?: string }> | undefined;
  const brochure = documents instanceof Map ? documents.get('brochure') : documents?.brochure;
  return {
    id: String(row._id),
    code: row.code,
    name: row.name,
    state: stateOf(row),
    draft: row.draft ?? null,
    releasedTo: row.releasedTo ?? null,
    firstPublishedAt: row.firstPublishedAt ? row.firstPublishedAt.toISOString() : null,
    alsoFits: [...(row.alsoFits ?? [])],
    brochure: brochure?.label ? { label: brochure.label } : null,
  };
}
