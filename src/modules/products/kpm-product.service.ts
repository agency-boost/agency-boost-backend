import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import {
  APPROVED_PRODUCT_FIELDS, DOCUMENT_MIME_TYPES, OVERRIDABLE_PRODUCT_FIELDS, PRODUCT_DOCUMENT_FOLDER,
  PRODUCT_DOCUMENT_LABEL_MAX_LENGTH, PRODUCT_DOCUMENT_SLOTS,
  SCRIPT_OVERRIDE_FIELDS, type ProductDocumentSlot, type ScriptReviewState,
} from '@/domain/constants';
import { plainText } from '@/common/validation/plain-text';
import { AssetService } from '@/modules/assets/asset.service';
import type { SignedUpload } from '@/modules/assets/storage.port';
import { AuditService } from '@/modules/audit/audit.service';
import { Kpm } from '@/modules/tenants/kpm.schema';
import { KpmProductConfigDocument } from './kpm-product-config.schema';
import { KpmProductConfigRepository } from './kpm-product.repository';
import { Product, ProductDocument } from './product.schema';

/** One value an office reads, and whether the office is the one who chose it. */
export interface EffectiveField<T> {
  value: T;
  /** True when this office has replaced the company's value for this field. */
  overridden: boolean;
}

export interface ProductDocumentView {
  slot: ProductDocumentSlot;
  label: string;
  /** Null in both halves means nobody has attached anything to this slot yet. */
  storageKey: string | null;
  filename: string | null;
  /** Where the file came from — the prototype's own *"Uploaded by KPM"* vs *"From the catalog"*. */
  source: 'kpm' | 'company' | 'none';
}

export interface KpmProductView {
  productId: string;
  code: string;
  /** What the company calls it, always — so a screen can say what a rename replaced. */
  companyName: string;
  channel: string;
  category: string;
  lifecycle: string;
  /** False for a product the company has withdrawn, whatever this office once decided. */
  sellable: boolean;
  active: EffectiveField<boolean>;
  displayName: EffectiveField<string>;
  /**
   * *Short description (shown to agents)* (OD-136): this office's draft, else the company's
   * tagline. **The draft, not what agents read** — that is {@link KpmProductService.effectiveScript}.
   */
  description: EffectiveField<string>;
  script: Record<string, EffectiveField<string | string[]>>;
  /** Whether this office's own script override may reach its agents yet (ADR-0037). */
  reviewState: ScriptReviewState;
  rejectionReason: string | null;
  documents: ProductDocumentView[];
}

/** One product of an office's shelf, as {@link KpmProductService.shelfOf} reads it. */
export interface OfficeShelfEntry {
  /** The company's row, read live (ADR-0033). */
  readonly product: ProductDocument;
  /** The office's decisions laid over it — what the settings screen lists for this product. */
  readonly view: KpmProductView;
  /**
   * The office's **approved** words for it (`approvedOverrides`, ADR-0037), or `undefined` where it
   * approved none. Never `overrides`: the drafts stay inside this service, so a field read built on
   * this entry has no way to reach one.
   */
  readonly approved: Record<string, unknown> | undefined;
}

/** The office's whole shelf, read once: its company, and every product of it with the office's decisions. */
export interface OfficeShelf {
  /** The office's own company (`kpms.companyId`), never a value the caller sent. */
  readonly companyId: string;
  /** Every product of the company, in its `sortOrder`, withdrawn rows included. */
  readonly entries: readonly OfficeShelfEntry[];
}

/**
 * What an agent is served for one product: the office's **approved** words field by field, else
 * the company's (ADR-0037, ADR-0120).
 */
export interface EffectiveWords {
  /** `kpm` once the office has approved any of its own words for this product; else `company`. */
  source: 'kpm' | 'company';
  /** The seven script fields, each the effective value. No markup, ever. */
  script: Record<string, string | string[]>;
  /** The office's approved description (OD-136), else the company's tagline. */
  description: string;
}

/**
 * **The rule** every agent read applies: the approved copy, field by field, else the company's.
 *
 * Pure, so a read of a whole shelf can apply it to rows it read in one query. It takes the
 * office's `approvedOverrides` and nothing else — never `overrides`, which holds drafts — so no
 * caller can render an unapproved word by passing the wrong field: there is no parameter for it.
 *
 * | Office state | What an agent reads |
 * |---|---|
 * | approved | The office's own words, frozen at approval |
 * | `pending`, `rejected`, `none` | The company's — which the company published, and is therefore already the company's word |
 */
export function effectiveWordsOf(
  product: { defaultAttackPlan: unknown; tagline: string },
  approvedOverrides: Record<string, unknown> | null | undefined,
): EffectiveWords {
  const plan = product.defaultAttackPlan as Record<string, string | string[]>;
  const approved = (approvedOverrides ?? {}) as Record<string, string | string[]>;
  const has = (field: string) => Object.prototype.hasOwnProperty.call(approved, field);

  return {
    source: APPROVED_PRODUCT_FIELDS.some(has) ? 'kpm' : 'company',
    // Field by field: an office may have approved a rewrite of two fields and left the rest.
    script: Object.fromEntries(
      SCRIPT_OVERRIDE_FIELDS.map((field) => [field, has(field) ? approved[field] : plan[field]]),
    ),
    description: has('description') ? String(approved.description) : product.tagline,
  };
}

const SLOT_KEYS = PRODUCT_DOCUMENT_SLOTS.map((s) => s.key) as readonly string[];

/**
 * What an office sells, and the words it sells it with (P5-T5, ADR-0033, ADR-0037).
 *
 * **The product is the company's and is read live; only the decision is the office's.** So this
 * service never copies a product — it reads the company's row and lays the office's `kpmProductConfigs`
 * row over it, field by field. That is what makes a company edit to a field nobody has overridden
 * reach every office on its next read, with no Owner pressing anything.
 *
 * **Absent means inherit.** `active: null` inherits `activeByDefault`; a key missing from `overrides`
 * inherits the company's value. Resetting is an `$unset` rather than a copy of today's company value,
 * which would silently freeze the current wording into the office for ever.
 */
@Injectable()
export class KpmProductService {
  constructor(
    private readonly configs: KpmProductConfigRepository,
    @InjectModel(Product.name) private readonly products: Model<ProductDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<Kpm>,
    private readonly assets: AssetService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** This office's whole shelf: its company's products, with its own decisions laid over them. */
  async list(ctx: RequestContext): Promise<KpmProductView[]> {
    return (await this.shelfOf(ctx)).entries.map((entry) => entry.view);
  }

  /**
   * **The one read of an office's shelf** (P5-T5; the Phase 14 exit review): the office's company, the
   * company's rows in order, and the office's rows — three queries, whatever the shelf's size — with
   * each product's overlay and its approved words.
   *
   * The settings screen's list is this read's views. The field reads (`ProductCatalogService`) build
   * the agent's shelf from the same entries, so the overlay is one rule rather than two, and the
   * company filter is applied here, through {@link productsOf}, and nowhere in that service.
   */
  async shelfOf(ctx: RequestContext): Promise<OfficeShelf> {
    const companyId = await this.companyOf(ctx);
    const [products, rows] = await Promise.all([
      this.productsOf(companyId).sort({ sortOrder: 1 }).exec(),
      this.configs.find(ctx, {}),
    ]);
    const byProduct = new Map(rows.map((row) => [row.productId, row]));
    return {
      companyId,
      entries: products.map((product) => {
        const row = byProduct.get(String(product._id)) ?? null;
        return {
          product,
          view: this.view(product, row),
          approved: (row?.approvedOverrides ?? undefined) as Record<string, unknown> | undefined,
        };
      }),
    };
  }

  /**
   * Sell this product, or stop (AC-5).
   *
   * `null` gives the decision back to the company's `activeByDefault` — which is not the same as
   * setting the flag's current value, because the company may change it later.
   */
  async setActive(
    ctx: RequestContext, productId: string, active: boolean | null,
  ): Promise<KpmProductView> {
    const product = await this.requireProduct(ctx, productId);

    // A withdrawn product is one the company has taken off the market. An office turning it back
    // on would be selling something its insurer no longer issues.
    if (active === true && product.lifecycle === 'withdrawn') {
      throw new BadRequestException(
        `${product.name} has been withdrawn by your company, so it cannot be activated. `
        + 'Your company decides what is on the shelf; your office decides which of it you sell.',
      );
    }

    const row = await this.configs.upsert(ctx, productId, { $set: { active } });
    await this.record(ctx, 'kpm_product.activation_set', row, { code: product.code, active });
    return this.view(product, row);
  }

  /**
   * Replace some of the company's words with this office's own (AC-2, AC-6).
   *
   * A script edit lands as **pending**: the office approves its own override before agents see it
   * (ADR-0037), and until it does, agents keep reading the approved words — or the company's. The
   * description is held the same way since OD-136 (ADR-0120).
   *
   * **A `null` or blank description gives it back to the company**, exactly as
   * {@link resetOverride} does: it is not new words, so nothing waits on an approval to stop
   * agents reading the office's sentence.
   */
  async saveOverrides(
    ctx: RequestContext, productId: string, body: Record<string, unknown>,
  ): Promise<KpmProductView> {
    const product = await this.requireProduct(ctx, productId);

    /*
     * Only the fields the caller sent.
     *
     * The DTO arrives from the pipe with **every** declared field as an own key, `undefined` where
     * the body had none (ES2022 class fields), so `{ ...dto }` named all eight. This loop wrote
     * each of them as `''`: saving the name over HTTP made every script line the office's, blank,
     * and the row pending. No test sent a partial body through the pipe until OD-136's did.
     */
    const input = Object.fromEntries(
      Object.entries(body).filter(([, value]) => value !== undefined),
    );

    const unknown = Object.keys(input)
      .filter((key) => !(OVERRIDABLE_PRODUCT_FIELDS as readonly string[]).includes(key));
    if (unknown.length > 0) {
      // Named, rather than quietly dropped: somebody whose edit half-saved has no way to find out
      // which half, and the fields an office may not change are a rule worth stating out loud.
      throw new BadRequestException(
        `Your office cannot change ${unknown.join(', ')} on a product — those belong to your `
        + `company. You may change: ${OVERRIDABLE_PRODUCT_FIELDS.join(', ')}.`,
      );
    }
    if (Object.keys(input).length === 0) throw new BadRequestException('Nothing to change.');

    const set: Record<string, unknown> = {};
    const unset: Record<string, ''> = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === 'description' && (value === null || plainText(value) === '')) {
        // Given back, not blanked: an empty sentence on every card is nobody's intention, and the
        // approved copy goes with the draft, as `resetOverride` takes it.
        unset['overrides.description'] = '';
        unset['approvedOverrides.description'] = '';
        continue;
      }
      // **Sanitised on write, the same as the company's half** (AC-6). Anybody who can write a
      // script could otherwise write a tag, and the prototype renders scripts with `innerHTML`.
      set[`overrides.${key}`] = Array.isArray(value)
        ? value.map(plainText).filter((line) => line !== '')
        : plainText(value);
    }

    // Only new words wait for approval: a description given back is in `unset`, not here.
    const touchesApproved = Object.keys(set)
      .some((path) => APPROVED_PRODUCT_FIELDS.includes(path.slice('overrides.'.length) as never));
    if (touchesApproved) {
      // **Editing an approved override returns it to pending** (ADR-0037, AC-2). The approved
      // copy stays readable, so agents keep reading words somebody approved while the next draft
      // is being looked at.
      set.reviewState = 'pending';
      // A new draft clears the last decision rather than inheriting it: an approval belongs to
      // the words it was given, and a rejection nobody has re-read is not a rejection of these.
      set.reviewedByMembershipId = null;
      set.reviewedAt = null;
      set.rejectionReason = null;
    }

    const row = await this.configs.upsert(ctx, productId, {
      $set: set,
      ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
      $inc: { version: 1 },
    });
    await this.record(ctx, 'kpm_product.override_saved', row, {
      code: product.code, fields: Object.keys(input), reviewState: row.reviewState,
      ...(Object.keys(unset).length > 0 ? { givenBack: ['description'] } : {}),
    });
    return this.view(product, row);
  }

  /**
   * Give one field back to the company (AC-3).
   *
   * **An `$unset`, not a copy.** Writing the company's current value here would look identical
   * today and diverge silently the moment the company changed its wording — which is exactly the
   * defect the prototype has, where *Reset* copies the default into the form.
   */
  async resetOverride(
    ctx: RequestContext, productId: string, field: string,
  ): Promise<KpmProductView> {
    const product = await this.requireProduct(ctx, productId);
    if (!(OVERRIDABLE_PRODUCT_FIELDS as readonly string[]).includes(field)) {
      throw new BadRequestException(`${field} is not a field your office can change.`);
    }

    /*
     * The approved copy goes with it.
     *
     * Giving a field back to the company means agents follow the company on it — and since the
     * effective read answers from `approvedOverrides`, leaving the approved copy behind would go
     * on serving words the office has just said it no longer wants.
     */
    const row = await this.configs.upsert(ctx, productId, {
      $unset: { [`overrides.${field}`]: '', [`approvedOverrides.${field}`]: '' },
      $inc: { version: 1 },
    });
    await this.record(ctx, 'kpm_product.override_reset', row, { code: product.code, field });
    return this.view(product, row);
  }

  /**
   * **A signed upload for an office's own product document** (P17-T9, D-productdocs): a PDF of at most
   * 25 MB, into the office's own `products` folder, refused before anything is signed otherwise. The key is
   * then attached to a slot by {@link setDocument}, as it always was.
   */
  async requestDocumentUpload(
    ctx: RequestContext, params: { filename: string; mimeType: string; bytes: number },
  ): Promise<SignedUpload> {
    return this.assets.requestUpload(ctx, { folder: PRODUCT_DOCUMENT_FOLDER, ...params }, DOCUMENT_MIME_TYPES);
  }

  /** Attach this office's own file to one slot, replacing the company's for this office alone. */
  async setDocument(
    ctx: RequestContext,
    productId: string,
    slot: string,
    file: { storageKey: string; label: string },
  ): Promise<KpmProductView> {
    const product = await this.requireProduct(ctx, productId);
    this.requireSlot(slot);

    /*
     * It exists, it is this office's, and its bytes arrived: **confirmed against storage here** (ADR-0040),
     * what storage reports recorded. P17-T9: this asked for an already-confirmed upload first — the check
     * delivery makes — and no product route confirms one, so an upload signed for this slot could never be
     * attached. Confirming is that check and more: another office's key is still 404, bytes that never came
     * are still `409 ASSET_NOT_UPLOADED` — and **a file storage holds as anything but a PDF is refused**
     * (`415 ASSET_TYPE_NOT_ALLOWED`), whatever it was signed as, with nothing attached: a product document
     * is a PDF (`DOCUMENT_MIME_TYPES`).
     */
    const stored = await this.assets.confirmUpload(ctx, file.storageKey, DOCUMENT_MIME_TYPES);

    const existing = (await this.configs.findOne(ctx, { productId }))?.documents?.get(slot);
    const row = await this.configs.upsert(ctx, productId, {
      $set: {
        [`documents.${slot}`]: {
          storageKey: stored.storageKey,
          // Cut, not refused, past the longest a slot carries — the pipe cuts it too; this is for any caller.
          label: file.label.trim().slice(0, PRODUCT_DOCUMENT_LABEL_MAX_LENGTH) || stored.originalFilename || slot,
          mimeType: stored.mimeType,
          bytes: stored.bytes,
        },
      },
      $inc: { version: 1 },
    });
    // Referenced once more only when the slot did not already hold this file (the Phase 17 exit review): an
    // attach of the same key again would otherwise count one reference twice, and the file would never read
    // as unreferenced once released.
    if (existing?.storageKey !== stored.storageKey) {
      await this.assets.retain(ctx, stored.storageKey);
      if (existing) await this.assets.release(ctx, existing.storageKey);
    }

    await this.record(ctx, 'kpm_product.document_set', row, { code: product.code, slot });
    return this.view(product, row);
  }

  /** Fall back to the company's document for one slot, leaving every other slot alone (AC-7). */
  async resetDocument(
    ctx: RequestContext, productId: string, slot: string,
  ): Promise<KpmProductView> {
    const product = await this.requireProduct(ctx, productId);
    this.requireSlot(slot);

    const existing = (await this.configs.findOne(ctx, { productId }))?.documents?.get(slot);
    const row = await this.configs.upsert(ctx, productId, {
      $unset: { [`documents.${slot}`]: '' },
      $inc: { version: 1 },
    });
    // Released, never deleted: somebody may put it back, and deleting a file because it stopped
    // being referenced is a decision nobody made.
    if (existing) await this.assets.release(ctx, existing.storageKey);

    await this.record(ctx, 'kpm_product.document_reset', row, { code: product.code, slot });
    return this.view(product, row);
  }

  /**
   * A short-lived URL for one slot.
   *
   * Which registry answers follows **which half holds the file**, never what the caller says: the
   * office's own upload is read as the office's, and the company's document through the named
   * unscoped method filtered by this office's company (ADR-0032).
   */
  async documentUrl(ctx: RequestContext, productId: string, slot: string): Promise<string> {
    const companyId = await this.companyOf(ctx);
    const product = await this.productOf(companyId, productId);
    this.requireSlot(slot);

    const row = await this.configs.findOne(ctx, { productId });
    const url = await this.signedUrl(ctx, companyId, this.view(product, row), slot);
    if (url === null) throw new NotFoundException('Document');
    return url;
  }

  /**
   * The same link for a product the caller has already read with {@link shelfOf} — its overlay and
   * its company in hand, so nothing is read again but the asset itself. `null` for a slot nobody
   * filled, which the caller says in its own words; a slot a product does not have is `400`.
   */
  async documentUrlOf(
    ctx: RequestContext, shelf: OfficeShelf, entry: OfficeShelfEntry, slot: string,
  ): Promise<string | null> {
    this.requireSlot(slot);
    return this.signedUrl(ctx, shelf.companyId, entry.view, slot);
  }

  // ------------------------------------------------- the script approval gate (P5-T10, ADR-0037)

  /**
   * The overrides this office still has to do something about.
   *
   * A queue rather than a hunt through 31 products: the whole point of a gate is that the person
   * holding it can see what is behind it.
   *
   * **Sent-back rows belong here too.** They are the ones somebody has to act on — a rejection
   * nobody can find is a script that stays unapproved for ever, which is the thing requiring a
   * reason was meant to prevent. `approved` and `none` are settled and are not on anybody's list.
   */
  async pendingReviews(ctx: RequestContext): Promise<KpmProductView[]> {
    const open: ScriptReviewState[] = ['pending', 'rejected'];
    return (await this.list(ctx)).filter((p) => open.includes(p.reviewState));
  }

  /**
   * Approve this office's own script override (AC-3, AC-4).
   *
   * **The approved words are frozen here, not read live.** `approvedOverrides` is a copy taken at
   * the moment of approval, so editing afterwards cannot change what agents are already reading —
   * which is the whole of *"every script an agent read carries a name and a time"*.
   *
   * **This is a gate, not an independent review** (ADR-0037). The office both writes and approves;
   * what it guarantees is that no half-finished script reaches an agent. The manual says so.
   */
  async approveScript(ctx: RequestContext, productId: string): Promise<KpmProductView> {
    const product = await this.requireProduct(ctx, productId);
    const row = await this.requirePending(ctx, productId);

    const approved = await this.configs.upsert(ctx, productId, {
      $set: {
        reviewState: 'approved',
        reviewedByMembershipId: ctx.membershipId,
        reviewedAt: this.clock.now(),
        rejectionReason: null,
        // Frozen: a later edit returns the row to pending and leaves this readable (AC-2).
        approvedOverrides: this.approvedOf(row),
        approvedOverrideVersion: row.version,
      },
    });

    await this.record(ctx, 'sales_script.approved', approved, {
      code: product.code, version: row.version,
    });
    return this.view(product, approved);
  }

  /**
   * Send it back, with a reason (AC-4).
   *
   * **A reason is required.** "No" on its own is not something the person who wrote the script can
   * act on, and a rejection nobody can act on is a script that stays unapproved for ever.
   */
  async rejectScript(
    ctx: RequestContext, productId: string, reason: string,
  ): Promise<KpmProductView> {
    const product = await this.requireProduct(ctx, productId);
    await this.requirePending(ctx, productId);

    const trimmed = reason.trim();
    if (!trimmed) {
      throw new BadRequestException(
        'Say why you are sending it back. Somebody has to act on it, and "no" on its own is not '
        + 'something anybody can act on.',
      );
    }

    const rejected = await this.configs.upsert(ctx, productId, {
      $set: {
        reviewState: 'rejected',
        reviewedByMembershipId: ctx.membershipId,
        reviewedAt: this.clock.now(),
        rejectionReason: trimmed,
      },
    });

    await this.record(ctx, 'sales_script.rejected', rejected, {
      code: product.code, reason: trimmed,
    });
    return this.view(product, rejected);
  }

  /**
   * The words an agent is actually served (AC-5): the script, and since OD-136 the description.
   *
   * **Phase 14's field reads apply the same rule** ({@link effectiveWordsOf}) to the approved words
   * {@link shelfOf} hands them, which is what stops them bypassing the gate: an override that is
   * `pending` or `rejected` is not in the answer at all, so a caller cannot accidentally render one
   * by reading the wrong field.
   *
   * | Office state | What an agent reads |
   * |---|---|
   * | `approved` | The office's own words, frozen at approval |
   * | `pending`, `rejected`, `none` | The company's — which the company published, and is therefore already the company's word |
   *
   * The description follows the same table: the approved one, else the company's tagline.
   */
  async effectiveScript(ctx: RequestContext, productId: string): Promise<EffectiveWords> {
    const product = await this.requireProduct(ctx, productId);
    const row = await this.configs.findOne(ctx, { productId });

    /*
     * What was approved, **not** what the row's state is today.
     *
     * Reading the state instead was wrong and only a browser walk showed it: an office approves a
     * script, starts editing it the next week, and every agent's screen falls back to the
     * company's words mid-week — because the edit had moved the row to `pending`. Nobody
     * unapproved anything. `approvedOverrides` is written at approval and at no other time, so it
     * is the honest answer to *"what did this office approve?"*, whatever is being drafted over it.
     */
    return effectiveWordsOf(product, row?.approvedOverrides as Record<string, unknown> | undefined);
  }

  private async requirePending(
    ctx: RequestContext, productId: string,
  ): Promise<KpmProductConfigDocument> {
    const row = await this.configs.findOne(ctx, { productId });
    if (!row || row.reviewState !== 'pending') {
      throw new BadRequestException(
        'There is nothing waiting on you for this product. A decision is made on a script that has '
        + 'been written and not yet approved.',
      );
    }
    return row;
  }

  /**
   * The fields held for approval: the seven script fields and the description (ADR-0120). A
   * display-name override is a label, not words an agent says, so it is not frozen here.
   */
  private approvedOf(row: KpmProductConfigDocument): Record<string, unknown> {
    const overrides = (row.overrides ?? {}) as Record<string, unknown>;
    return Object.fromEntries(
      APPROVED_PRODUCT_FIELDS
        .filter((field) => Object.prototype.hasOwnProperty.call(overrides, field))
        .map((field) => [field, overrides[field]]),
    );
  }

  // -------------------------------------------------------------------- internals

  /** A product of this office's **own** company. Another company's is a 404, never a 403. */
  private async requireProduct(
    ctx: RequestContext, productId: string,
  ): Promise<ProductDocument> {
    return this.productOf(await this.companyOf(ctx), productId);
  }

  private async productOf(companyId: string, productId: string): Promise<ProductDocument> {
    const product = await this.productsOf(companyId)
      .findOne({ _id: productId })
      .exec()
      .catch(() => null);
    if (!product) throw new NotFoundException('Product');
    return product;
  }

  /**
   * **The company filter for every product this service reads**, applied here and nowhere else in it
   * (as `ProductService.of` applies it for the company's own side): `products` is
   * company-partitioned, so `companyId` — the office's own, from `companyOf` — is what scopes it.
   */
  private productsOf(companyId: string) {
    return this.products.find({ companyId, deletedAt: null });
  }

  /**
   * Which registry signs follows **which half holds the file**, never what the caller says: the
   * office's own upload is read as the office's, and the company's document through the named
   * unscoped method filtered by this office's company (ADR-0032). `null` when neither holds one.
   */
  private async signedUrl(
    ctx: RequestContext, companyId: string, view: KpmProductView, slot: string,
  ): Promise<string | null> {
    const document = view.documents.find((d) => d.slot === slot);
    if (!document?.storageKey) return null;
    return document.source === 'kpm'
      ? this.assets.urlFor(ctx, document.storageKey)
      : this.assets.companyUrlFor(companyId, document.storageKey);
  }

  private requireSlot(slot: string): void {
    if (!SLOT_KEYS.includes(slot)) {
      throw new BadRequestException(
        `${slot} is not a document slot. A product has: ${SLOT_KEYS.join(', ')}.`,
      );
    }
  }

  /** The company this office belongs to — never a value the caller sent. */
  private async companyOf(ctx: RequestContext): Promise<string> {
    const kpm = await this.kpms.findById(ctx.kpmId).select('companyId').lean().exec();
    const companyId = (kpm as { companyId?: string } | null)?.companyId;
    if (!companyId) throw new NotFoundException('Kpm');
    return companyId;
  }

  private record(
    ctx: RequestContext, action: string, row: KpmProductConfigDocument,
    after: Record<string, unknown>,
  ) {
    return this.audit.record(ctx, {
      action,
      targetCollection: 'kpmProductConfigs',
      targetId: String(row._id),
      after,
    });
  }

  /** The company's product with the office's decisions laid over it, field by field. */
  private view(
    product: ProductDocument, row: KpmProductConfigDocument | null,
  ): KpmProductView {
    const overrides = (row?.overrides ?? {}) as Record<string, unknown>;
    const has = (field: string) => Object.prototype.hasOwnProperty.call(overrides, field);
    const plan = product.defaultAttackPlan;

    const field = <T>(name: string, companyValue: T): EffectiveField<T> => (
      has(name)
        ? { value: overrides[name] as T, overridden: true }
        : { value: companyValue, overridden: false }
    );

    const script: KpmProductView['script'] = {};
    for (const name of SCRIPT_OVERRIDE_FIELDS) {
      const companyValue = (plan as unknown as Record<string, string | string[]>)[name];
      script[name] = field(name, companyValue);
    }

    return {
      productId: String(product._id),
      code: product.code,
      companyName: product.name,
      channel: product.channel,
      category: product.category,
      lifecycle: product.lifecycle,
      // A withdrawn product is not sellable whatever this office decided, and no office action
      // was needed to make that true (AC-5).
      sellable: product.lifecycle !== 'withdrawn',
      active: row?.active === null || row?.active === undefined
        ? { value: product.activeByDefault, overridden: false }
        : { value: row.active, overridden: true },
      displayName: field('displayName', product.name),
      description: field('description', product.tagline),
      script,
      reviewState: row?.reviewState ?? 'none',
      rejectionReason: row?.rejectionReason ?? null,
      documents: PRODUCT_DOCUMENT_SLOTS.map(({ key, label }) => {
        const own = row?.documents?.get(key);
        const theirs = product.defaultDocuments?.get(key) as
          { storageKey?: string; label?: string } | undefined;
        if (own) {
          return { slot: key, label, storageKey: own.storageKey, filename: own.label, source: 'kpm' as const };
        }
        if (theirs?.storageKey) {
          return {
            slot: key, label, storageKey: theirs.storageKey,
            filename: theirs.label ?? null, source: 'company' as const,
          };
        }
        return { slot: key, label, storageKey: null, filename: null, source: 'none' as const };
      }),
    };
  }
}
