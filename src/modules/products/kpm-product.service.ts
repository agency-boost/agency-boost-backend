import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import {
  OVERRIDABLE_PRODUCT_FIELDS, PRODUCT_DOCUMENT_SLOTS, SCRIPT_OVERRIDE_FIELDS,
  type ProductDocumentSlot, type ScriptReviewState,
} from '@/domain/constants';
import { plainText } from '@/common/validation/plain-text';
import { AssetService } from '@/modules/assets/asset.service';
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
  script: Record<string, EffectiveField<string | string[]>>;
  /** Whether this office's own script override may reach its agents yet (ADR-0037). */
  reviewState: ScriptReviewState;
  rejectionReason: string | null;
  documents: ProductDocumentView[];
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
    const companyId = await this.companyOf(ctx);
    const [products, rows] = await Promise.all([
      this.products.find({ companyId, deletedAt: null }).sort({ sortOrder: 1 }).exec(),
      this.configs.find(ctx, {}),
    ]);
    const byProduct = new Map(rows.map((row) => [row.productId, row]));
    return products.map((product) => this.view(product, byProduct.get(String(product._id)) ?? null));
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
   * (ADR-0037), and until it does, agents keep reading the approved words — or the company's.
   */
  async saveOverrides(
    ctx: RequestContext, productId: string, input: Record<string, unknown>,
  ): Promise<KpmProductView> {
    const product = await this.requireProduct(ctx, productId);

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
    for (const [key, value] of Object.entries(input)) {
      // **Sanitised on write, the same as the company's half** (AC-6). Anybody who can write a
      // script could otherwise write a tag, and the prototype renders scripts with `innerHTML`.
      set[`overrides.${key}`] = Array.isArray(value)
        ? value.map(plainText).filter((line) => line !== '')
        : plainText(value);
    }

    const touchesScript = Object.keys(input).some((k) => SCRIPT_OVERRIDE_FIELDS.includes(k as never));
    if (touchesScript) {
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

    const row = await this.configs.upsert(ctx, productId, { $set: set, $inc: { version: 1 } });
    await this.record(ctx, 'kpm_product.override_saved', row, {
      code: product.code, fields: Object.keys(input), reviewState: row.reviewState,
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

  /** Attach this office's own file to one slot, replacing the company's for this office alone. */
  async setDocument(
    ctx: RequestContext,
    productId: string,
    slot: string,
    file: { storageKey: string; label: string },
  ): Promise<KpmProductView> {
    const product = await this.requireProduct(ctx, productId);
    this.requireSlot(slot);

    // The same check delivery makes: it exists, it is this office's, and its bytes arrived.
    await this.assets.urlFor(ctx, file.storageKey);
    const stored = await this.assets.confirmUpload(ctx, file.storageKey);

    const existing = (await this.configs.findOne(ctx, { productId }))?.documents?.get(slot);
    const row = await this.configs.upsert(ctx, productId, {
      $set: {
        [`documents.${slot}`]: {
          storageKey: stored.storageKey,
          label: file.label.trim() || stored.originalFilename || slot,
          mimeType: stored.mimeType,
          bytes: stored.bytes,
        },
      },
      $inc: { version: 1 },
    });
    await this.assets.retain(ctx, stored.storageKey);
    if (existing && existing.storageKey !== stored.storageKey) {
      await this.assets.release(ctx, existing.storageKey);
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
    const product = await this.requireProduct(ctx, productId);
    this.requireSlot(slot);

    const own = (await this.configs.findOne(ctx, { productId }))?.documents?.get(slot);
    if (own) return this.assets.urlFor(ctx, own.storageKey);

    const theirs = product.defaultDocuments?.get(slot) as { storageKey?: string } | undefined;
    if (theirs?.storageKey) {
      return this.assets.companyUrlFor(await this.companyOf(ctx), theirs.storageKey);
    }
    throw new NotFoundException('Document');
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
        approvedOverrides: this.scriptOf(row),
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
   * The script an agent is actually served (AC-5).
   *
   * **Phase 12 reads this and nothing else**, which is what stops it bypassing the gate: an
   * override that is `pending` or `rejected` is not in the answer at all, so a caller cannot
   * accidentally render one by reading the wrong field.
   *
   * | Office state | What an agent reads |
   * |---|---|
   * | `approved` | The office's own words, frozen at approval |
   * | `pending`, `rejected`, `none` | The company's — which the company published, and is therefore already the company's word |
   */
  async effectiveScript(
    ctx: RequestContext, productId: string,
  ): Promise<{ source: 'kpm' | 'company'; script: Record<string, string | string[]> }> {
    const product = await this.requireProduct(ctx, productId);
    const row = await this.configs.findOne(ctx, { productId });
    const company = SCRIPT_OVERRIDE_FIELDS.reduce<Record<string, string | string[]>>(
      (acc, field) => ({
        ...acc,
        [field]: (product.defaultAttackPlan as unknown as Record<string, string | string[]>)[field],
      }),
      {},
    );

    /*
     * What was approved, **not** what the row's state is today.
     *
     * Reading the state instead was wrong and only a browser walk showed it: an office approves a
     * script, starts editing it the next week, and every agent's screen falls back to the
     * company's words mid-week — because the edit had moved the row to `pending`. Nobody
     * unapproved anything. `approvedOverrides` is written at approval and at no other time, so it
     * is the honest answer to *"what did this office approve?"*, whatever is being drafted over it.
     */
    const approved = (row?.approvedOverrides ?? {}) as Record<string, string | string[]>;
    if (Object.keys(approved).length === 0) return { source: 'company', script: company };

    // Field by field: an office may have approved a rewrite of two fields and left the rest.
    return {
      source: 'kpm',
      script: SCRIPT_OVERRIDE_FIELDS.reduce<Record<string, string | string[]>>(
        (acc, field) => ({
          ...acc,
          [field]: Object.prototype.hasOwnProperty.call(approved, field)
            ? approved[field]
            : company[field],
        }),
        {},
      ),
    };
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

  /** Only the seven script fields — a display-name override is not a script. */
  private scriptOf(row: KpmProductConfigDocument): Record<string, unknown> {
    const overrides = (row.overrides ?? {}) as Record<string, unknown>;
    return Object.fromEntries(
      SCRIPT_OVERRIDE_FIELDS
        .filter((field) => Object.prototype.hasOwnProperty.call(overrides, field))
        .map((field) => [field, overrides[field]]),
    );
  }

  // -------------------------------------------------------------------- internals

  /** A product of this office's **own** company. Another company's is a 404, never a 403. */
  private async requireProduct(
    ctx: RequestContext, productId: string,
  ): Promise<ProductDocument> {
    const companyId = await this.companyOf(ctx);
    const product = await this.products
      .findOne({ _id: productId, companyId, deletedAt: null })
      .exec()
      .catch(() => null);
    if (!product) throw new NotFoundException('Product');
    return product;
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
