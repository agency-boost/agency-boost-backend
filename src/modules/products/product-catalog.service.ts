import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException } from '@/common/errors/domain.exception';
import { render } from '@/common/i18n/sentence';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import {
  ASSET_LIMITS, PRODUCT_AGE_BAND_LABELS, PRODUCT_BUDGET_BAND_LABELS, PRODUCT_CATEGORY_LABELS,
  PRODUCT_RUN_OFF_NOTE, type ProductCategory, type ProductLifecycle,
} from '@/domain/constants';
import { scopeFor } from '@/modules/rbac/permissions';
import { planFor, type Brief, type ScoredProduct } from './attack-plan.scorer';
import { budgetBandWords } from './products.messages';
import {
  effectiveWordsOf, KpmProductService, type OfficeShelf, type OfficeShelfEntry,
} from './kpm-product.service';

/** One card of the office's shelf (`Overall.html:10172-10181`). */
export interface CatalogCardView {
  code: string;
  name: string;
  tagline: string;
  category: { code: string; label: string };
  channel: string;
  lifecycle: ProductLifecycle;
  needs: string[];
}

export interface CatalogScriptView {
  goodFit: string;
  opening: string;
  benefits: string[];
  fullScript: string;
  objectionTheySay: string;
  objectionYouSay: string;
  nextAction: string;
}

/** One product as the drawer reads it (`Overall.html:10200-10386`), and as the plan shows it. */
export interface CatalogProductView extends CatalogCardView {
  benefits: string[];
  differentiator: string;
  bestFit: string;
  ageBands: string[];
  budgetBands: string[];
  runOffNote: string | null;
  successorCode: string | null;
  /** Absent without `commission_rates:read`: left out, never sent and hidden (F-15, ADR-0038). */
  commissionSchedule?: { year: number; rate: number }[];
  script: CatalogScriptView;
  documents: { slot: string; label: string; available: boolean }[];
}

export interface AttackPlanView {
  brief: Brief;
  product: CatalogProductView | null;
  verdict: 'good_fit' | 'check_fit' | null;
  outside: ('age' | 'budget')[];
  alternatives: { code: string; name: string }[];
  moreCount: number;
  /**
   * True when the office keeps nothing on — a company with no catalog, or every product turned off —
   * so the screen draws the empty shelf rather than *no product matches this need* (P14-T8 AC-10).
   */
  shelfEmpty: boolean;
}

/** One product the office keeps on: the company's row, the office's decision, and its approved words. */
interface ShelfItem extends OfficeShelfEntry {
  /** The code of the company's product that replaced it, kept on here or not: a fact about the company. */
  readonly successorCode: string | null;
}

/** The office's shelf as the field reads see it: what it keeps on, and the one read it came from. */
interface FieldShelf {
  readonly read: OfficeShelf;
  readonly items: readonly ShelfItem[];
}

const SCRIPT_KEYS = [
  'goodFit', 'opening', 'benefits', 'fullScript', 'objectionTheySay', 'objectionYouSay', 'nextAction',
] as const satisfies readonly (keyof CatalogScriptView)[];

/**
 * **The field reads of the office's products** — the Product Catalog, its drawer, a document's link and
 * the Sales Attack Plan (`functional/sales-tools.md`; D-shelf, D-api, D-scoring).
 *
 * **One read, laid over three times.** Each product is the company's row (`products`, read live,
 * ADR-0033), with the office's decision on it — kept on or not, its display name, its documents — from
 * the same overlay the office's own settings screen reads, and its **approved** words through the one
 * effective rule (`effectiveWordsOf`, ADR-0037, ADR-0120). All three come from one call,
 * `KpmProductService.shelfOf` — three queries, the company filter applied there — and this service
 * injects no model. Never `overrides`: those are the office's drafts, and no entry carries them.
 *
 * **What is on the shelf** (D-shelf): every product the office keeps on — the company's
 * `activeByDefault` until the office decided — that the company has not withdrawn, in the company's
 * `sortOrder`. A product in run-off the office keeps on is on it, tagged; the plan never recommends one.
 *
 * **Outside it is 404**, never 403: a product of another company, one the office turned off or never
 * turned on, and one the company withdrew all answer the same way, so a code cannot be probed.
 *
 * **Nothing is written, audited or sent** by these reads (OD-133): they read no other member's data,
 * and a plan is computed and shown, never kept.
 */
@Injectable()
export class ProductCatalogService {
  constructor(
    private readonly offices: KpmProductService,
    private readonly clock: Clock,
  ) {}

  /** `GET /product-catalog`: the office's shelf, as cards. */
  async catalog(ctx: RequestContext): Promise<{ products: CatalogCardView[] }> {
    const { items } = await this.shelf(ctx);
    return { products: items.map((item) => this.card(item)) };
  }

  /** `GET /product-catalog/:productCode`: one product the office keeps on, as the drawer reads it. */
  async product(ctx: RequestContext, code: string): Promise<CatalogProductView> {
    const { items } = await this.shelf(ctx);
    return this.detail(ctx, this.keptOn(items, code));
  }

  /**
   * `GET /product-catalog/:productCode/documents/:slot/url`: a link valid 300 seconds, to the office's
   * file in the slot or else the company's — signed only for a product the office keeps on. Which half
   * signs follows which half holds the file (`KpmProductService.documentUrlOf`, ADR-0032).
   */
  async documentUrl(
    ctx: RequestContext, code: string, slot: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const { read, items } = await this.shelf(ctx);
    // The product as the shelf read it: nothing is read again but the asset that signs.
    const url = await this.offices.documentUrlOf(ctx, read, this.keptOn(items, code), slot);
    // An empty slot, said in the one way every field read says *not here* (`NOT_FOUND`).
    if (url === null) throw new NotFoundException('Document');
    const expiresAt = new Date(this.clock.now().getTime() + ASSET_LIMITS.SIGNED_URL_TTL_SECONDS * 1000);
    return { url, expiresAt: expiresAt.toISOString() };
  }

  /**
   * `GET /attack-plan`: the plan for a brief (D-scoring, D-alternatives) — the recommended product, or
   * the one the reader switched to, with its fit and words, and the brief's other matches in order.
   */
  async attackPlan(ctx: RequestContext, brief: Brief, chosen?: string): Promise<AttackPlanView> {
    const { items } = await this.shelf(ctx);
    const scored = items.map((item) => ({ ...this.scored(item), item }));
    const plan = planFor(scored, brief, chosen?.toUpperCase());
    // A switch to something that is not one of this brief's matches has nothing to show.
    if (!plan) throw new NotFoundException('Product');

    return {
      brief: { need: brief.need, age: brief.age, budget: brief.budget },
      product: plan.shown ? this.detail(ctx, plan.shown.item) : null,
      verdict: plan.fit?.verdict ?? null,
      outside: [...(plan.fit?.outside ?? [])],
      alternatives: plan.alternatives.map(({ item }) => ({ code: item.product.code, name: item.view.displayName.value })),
      moreCount: plan.moreCount,
      shelfEmpty: items.length === 0,
    };
  }

  // -------------------------------------------------------------------- internals

  /**
   * The office's shelf, read live on every request in one call: the company's rows, the overlay its
   * settings read, and its approved words (`KpmProductService.shelfOf`).
   */
  private async shelf(ctx: RequestContext): Promise<FieldShelf> {
    // A Super Admin outside a support session belongs to no office, so there is no shelf to read:
    // refused as every scoped read refuses it, before anything is looked up.
    if (!ctx.kpmId) throw new MissingTenantContextError('kpmProductConfigs', 'shelf');

    const read = await this.offices.shelfOf(ctx);
    const byId = new Map(read.entries.map((entry) => [String(entry.product._id), entry.product]));
    const items = read.entries
      // Kept on: the office's decision, else the company's default — and never once the company
      // has withdrawn it, whatever the office decided (D-shelf).
      .filter(({ view }) => view.active.value && view.sellable)
      .map((entry) => {
        const { replacedByProductId } = entry.product;
        const successor = replacedByProductId ? byId.get(replacedByProductId) : undefined;
        return { ...entry, successorCode: successor?.code ?? null };
      });
    return { read, items };
  }

  /** The product with this code on the office's shelf, or 404 — whichever of the reasons it is not. */
  private keptOn(shelf: readonly ShelfItem[], code: string): ShelfItem {
    const wanted = code.trim().toUpperCase();
    const item = shelf.find((i) => i.product.code === wanted);
    if (!item) throw new NotFoundException('Product');
    return item;
  }

  private card({ product, view, approved }: ShelfItem): CatalogCardView {
    return {
      code: product.code,
      name: view.displayName.value,
      tagline: effectiveWordsOf(product, approved).description,
      category: {
        code: product.category,
        label: PRODUCT_CATEGORY_LABELS[product.category as ProductCategory] ?? product.category,
      },
      channel: product.channel,
      lifecycle: product.lifecycle,
      needs: [...product.primaryNeeds],
    };
  }

  private detail(ctx: RequestContext, item: ShelfItem): CatalogProductView {
    const { product, view, approved } = item;
    const words = effectiveWordsOf(product, approved);
    const script = Object.fromEntries(SCRIPT_KEYS.map((key) => {
      const value = words.script[key];
      return [key, key === 'benefits' ? [...((value as string[] | undefined) ?? [])] : String(value ?? '')];
    })) as unknown as CatalogScriptView;

    return {
      ...this.card(item),
      benefits: [...product.benefits],
      differentiator: product.differentiator,
      bestFit: product.bestFor,
      ageBands: product.eligibleAgeBands.map((band) => PRODUCT_AGE_BAND_LABELS[band] ?? String(band)),
      // *Lump-sum* is a word, written for the reader (P18.98-T7); a range of sums reads the same in both.
      budgetBands: product.eligibleBudgetBands.map((band) => {
        const words = budgetBandWords(band);
        return words ? render(words, ctx.reader) : (PRODUCT_BUDGET_BAND_LABELS[band] ?? String(band));
      }),
      // Written for the reader (P18.98-T5 AC-4): the drawer's note in their language.
      runOffNote: product.lifecycle === 'closed_to_new_business' ? render(PRODUCT_RUN_OFF_NOTE, ctx.reader) : null,
      successorCode: item.successorCode,
      // One schedule per product, every agent's (OD-135), so any scope of the grant reads it.
      ...(scopeFor(ctx, 'commission_rates:read') !== null
        ? {
          commissionSchedule: [...(product.commissionSchedule ?? [])]
            .map(({ year, rate }) => ({ year, rate }))
            .sort((a, b) => a.year - b.year),
        }
        : {}),
      script,
      documents: view.documents.map((d) => ({ slot: d.slot, label: d.label, available: d.source !== 'none' })),
    };
  }

  /** What the scorer reads of one shelf item. */
  private scored({ product }: ShelfItem): ScoredProduct {
    return {
      code: product.code,
      sortOrder: product.sortOrder,
      lifecycle: product.lifecycle,
      needs: product.primaryNeeds,
      ageBands: product.eligibleAgeBands,
      budgetBands: product.eligibleBudgetBands,
    };
  }
}
