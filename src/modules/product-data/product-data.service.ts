import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { InvalidRequestException, NotFoundException } from '@/common/errors/domain.exception';
import {
  PRODUCT_DATA_STATUSES, type ProductDataCheckReason, type ProductDataStatus, type ProposalPayFrequency,
} from '@/domain/constants';
import { Product, type ProductDocument } from '@/modules/products/product.schema';
import { calcSettingsOf, isSyariahProduct, type ProposalCalcSettings } from '@/modules/products/proposal-fields';
import { itemOf, type PdfItem, type PdfItemSource } from '@/modules/proposals/proposal-pdf.model';
import {
  applyItemPatch, newItem, planOf, totalPaidOf, type ItemPatch, type StoredItem,
} from '@/modules/proposals/proposal-items';
import { Company, type CompanyDocument } from '@/modules/tenants/company.schema';
import { User, type UserDocument } from '@/modules/users/user.schema';
import { calculateItem, goalKeyOf } from './item-calculation';
import { IllustrationSummaries } from './illustration-summaries.port';
import { PremiumCalculator } from './premium-calculator.service';
import type { FixedAmount } from './premium-engine';
import { fingerprintOf } from './rate-file';
import { endingSoon, inForceOn, nextScheduled, type VersionFacts } from './rate-table-status';
import type { RateTableDocument } from './rate-table.schema';
import { catalogueRulesOf, RateTableService, tableFactsOf, type RateTableView } from './rate-table.service';
import { RULE_KEYS } from './product-rules.service';
import { ProductDataAccess } from './product-data-access.service';
import { PRODUCT_DATA_REFUSALS } from './product-data.messages';

/** **One row of the Proposal tab's list** (P1b §2; P19.15-T4 AC-1). */
export interface ProductDataRow {
  productId: string;
  code: string;
  name: string;
  category: string;
  isSyariah: boolean;
  calcType: ProposalCalcSettings['calcType'];
  lifecycle: string;
  status: ProductDataStatus;
  checkReasons: ProductDataCheckReason[];
  /** *Tabel premi*: `active` (*Berlaku {from}*), `none` (*Belum ada*), `ending` (*Berakhir {to}*), `gaps` (*Ada celah*). */
  table: {
    state: 'active' | 'none' | 'ending' | 'gaps';
    id: string | null;
    version: number | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    gapCount: number;
    /** *"Tarif baru mulai {date}"*. */
    scheduledFrom: string | null;
  };
  /** *Ilustrasi*: *"Ada · 3 bagian"* or *"Belum ada"* (T2's, through `IllustrationSummaries`). */
  illustration: { state: 'published' | 'none'; blocks: number };
}

export interface ProductDataOverview {
  company: { id: string; name: string };
  canManage: boolean;
  counters: Record<ProductDataStatus, number>;
  /** *"Terakhir diperbarui: {date} oleh {name}"*: the latest change to a table or a product of the company. */
  lastUpdated: { at: string; by: { id: string; name: string | null } | null } | null;
  products: ProductDataRow[];
}

/** What *Uji coba* sends: the card's state, as the last answer left it, and the change. */
export interface TryInput {
  age: number;
  gender: 'male' | 'female';
  /** Try a named version (a draft or a scheduled one); else the one in force on `onDate`, else today. */
  rateTableId?: string | null;
  onDate?: string | null;
  state?: {
    fieldValues?: Record<string, unknown>;
    smoker?: boolean | null;
    payTerm?: string | null;
    payFrequency?: ProposalPayFrequency;
    up?: number | { amountMinor: number } | null;
    premium?: number | { amountMinor: number } | null;
    fixedField?: FixedAmount;
  } | null;
  patch?: ItemPatch | null;
}

/**
 * **The Proposal tab** (P19.15-T1, T4 AC-1; ADR-0258 §8; the P1b spec's §1 to §3): the overview and the list, one
 * product's *Isian* and versions, and *Uji coba*. Every route asks `ProductDataAccess` first (the controller); what is
 * answered here is the company's, read by its id.
 */
@Injectable()
export class ProductDataService {
  constructor(
    @InjectModel(Product.name) private readonly products: Model<ProductDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly tables: RateTableService,
    private readonly calculator: PremiumCalculator,
    private readonly access: ProductDataAccess,
    private readonly illustrations: IllustrationSummaries,
  ) {}

  /**
   * **The four counters and one row per product** (P1b §1, §2): *Siap hitung* — a table in force covers it; *Ketik
   * manual* — none does (or its calculation is `manual`); *Perlu dicek* — its table ends within 30 days with nothing
   * scheduled after it, has gaps, or was made before the product changed in the catalogue; *Ditarik* — withdrawn. Base
   * products only: a rider is never on a proposal alone. Sorted *Perlu dicek*, *Ketik manual*, *Siap hitung*, *Ditarik*,
   * each in the catalogue's order.
   */
  async overview(ctx: RequestContext, companyId: string): Promise<ProductDataOverview> {
    const company = await this.companies.findOne({ _id: companyId, deletedAt: null }).lean().exec();
    if (!company) throw new NotFoundException('Company');
    const [products, versions, illustrations, canManage] = await Promise.all([
      this.products.find({ companyId, deletedAt: null, kind: { $ne: 'rider' } }).sort({ sortOrder: 1 }).lean().exec(),
      this.tables.versionsOfCompany(companyId),
      this.illustrations.ofCompany(companyId),
      this.access.canManage(ctx, companyId),
    ]);
    const today = this.tables.today();
    const rows = products.map((product) => {
      const id = String(product._id);
      const own = versions.filter((v) => v.productId === id).map(factsOf);
      const inForce = inForceOn(own, today)?.doc ?? null;
      const scheduled = nextScheduled(own, today)?.doc ?? null;
      const calc = calcSettingsOf(product as unknown as Record<string, unknown>);
      const reasons: ProductDataCheckReason[] = [];
      if (inForce) {
        if (endingSoon(factsOf(inForce), scheduled ? factsOf(scheduled) : null, today)) reasons.push('ending');
        if (inForce.gapCount > 0) reasons.push('gaps');
        if (inForce.productFingerprint !== null && inForce.productFingerprint !== fingerprintOf(tableFactsOf(product))) reasons.push('changed');
      }
      const status: ProductDataStatus = product.lifecycle === 'withdrawn' ? 'withdrawn'
        : !inForce || calc.calcType === 'manual' ? 'manual'
          : reasons.length > 0 ? 'check' : 'ready';
      const shown = illustrations.get(id);
      const row: ProductDataRow = {
        productId: id,
        code: product.code,
        name: product.name,
        category: product.category,
        isSyariah: isSyariahProduct(product),
        calcType: calc.calcType,
        lifecycle: product.lifecycle,
        status,
        checkReasons: status === 'check' ? reasons : [],
        table: {
          state: !inForce ? 'none' : reasons.includes('ending') ? 'ending' : inForce.gapCount > 0 ? 'gaps' : 'active',
          id: inForce ? String(inForce._id) : null,
          version: inForce?.version ?? null,
          effectiveFrom: inForce?.effectiveFrom ?? null,
          effectiveTo: inForce?.effectiveTo ?? null,
          gapCount: inForce?.gapCount ?? 0,
          scheduledFrom: scheduled?.effectiveFrom ?? null,
        },
        illustration: shown ? { state: 'published', blocks: shown.blocks } : { state: 'none', blocks: 0 },
      };
      return row;
    });
    const order = (s: ProductDataStatus) => PRODUCT_DATA_STATUSES.indexOf(s);
    rows.sort((a, b) => order(a.status) - order(b.status));
    const counters = Object.fromEntries(PRODUCT_DATA_STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length])) as Record<ProductDataStatus, number>;
    return {
      company: { id: String(company._id), name: company.name },
      canManage,
      counters,
      lastUpdated: await this.lastUpdated(products, versions),
      products: rows,
    };
  }

  /**
   * **One product: *Isian*'s values and every version** (P1b §3): the rules the form edits — the catalogue's —, the
   * version in force and the next scheduled, and the version list (*Berlaku*, *Terjadwal*, *Lama*, *Mati*, *Draf*), each
   * with who uploaded it and its three test results.
   */
  async detail(ctx: RequestContext, companyId: string, productId: string) {
    const product = await this.tables.productOf(companyId, productId);
    const plain = product.toObject();
    const versions = await this.tables.versionsOf(companyId, productId);
    const views: RateTableView[] = versions.length ? await this.tables.views(versions, versions) : [];
    const today = this.tables.today();
    const facts = versions.map(factsOf);
    const inForce = inForceOn(facts, today)?.doc ?? null;
    const scheduled = nextScheduled(facts, today)?.doc ?? null;
    const rules = Object.fromEntries(RULE_KEYS.map((key) => [key, (plain as unknown as Record<string, unknown>)[key] ?? null]));
    return {
      product: {
        id: String(product._id), code: product.code, name: product.name, category: product.category, channel: product.channel,
        isSyariah: isSyariahProduct(product), lifecycle: product.lifecycle, version: product.version,
        currencies: [...(product.currencies ?? ['IDR'])], kind: product.kind,
        rules: { ...rules, ...calcSettingsOf(plain as unknown as Record<string, unknown>), proposalFields: plain.proposalFields ?? [], planOptions: plain.planOptions ?? [] },
      },
      canManage: await this.access.canManage(ctx, companyId),
      catalogueRules: catalogueRulesOf(plain as unknown as Record<string, unknown>),
      inForce: inForce ? views.find((v) => v.id === String(inForce._id)) ?? null : null,
      scheduled: scheduled ? views.find((v) => v.id === String(scheduled._id)) ?? null : null,
      versions: views,
    };
  }

  /**
   * ***Uji coba*: the agent's card, with nothing stored** (P19.15-T1 AC-7; P1b §3): a product's item made as a proposal
   * makes one — for a client of this age and gender —, the card's last state laid on it and the change applied with the
   * very function the item's `PATCH` uses, then calculated with the very function the card's save uses, with the version
   * in force (or the one named, a draft too). Answers the item as the card reads it and the product's PDF box as the PDF
   * draws it. No version is marked used.
   */
  async tryIt(companyId: string, productId: string, input: TryInput): Promise<{ item: Record<string, unknown>; box: PdfItem }> {
    const product = await this.tables.productOf(companyId, productId);
    const age = input.age;
    let item: StoredItem = newItem(new Types.ObjectId().toHexString(), product.toObject() as never, product.name, age);
    const state = input.state ?? {};
    item = applyItemPatch(item, {
      ...(state.fieldValues ? { fieldValues: state.fieldValues } : {}),
      ...(typeof state.smoker === 'boolean' ? { smoker: state.smoker } : {}),
      ...(state.payTerm ? { payTerm: state.payTerm } : {}),
      ...(state.payFrequency ? { payFrequency: state.payFrequency } : {}),
    }, age);
    // The card's amounts as the last answer gave them — `{ amountMinor }` — or as a number.
    const amountOf = (v: unknown): number | null | undefined =>
      (v !== null && typeof v === 'object' ? (v as { amountMinor: number | null }).amountMinor : v as number | null | undefined);
    const up = amountOf(state.up);
    const premium = amountOf(state.premium);
    item = applyItemPatch(item, {
      ...(up !== undefined && item.snapshot.calcType === 'up_premium' ? { up: { amountMinor: up } } : {}),
      ...(premium !== undefined ? { premium: { amountMinor: premium } } : {}),
    }, age);
    item = { ...item, fixedField: state.fixedField ?? 'none' };
    const patch = input.patch ?? {};
    const patched = applyItemPatch(item, patch, age);
    const goalKey = goalKeyOf(item.snapshot);
    const typed: FixedAmount | undefined = patch.up !== undefined ? 'up' : patch.premium !== undefined ? 'premium'
      : goalKey !== null && patch.fieldValues && goalKey in patch.fieldValues ? 'goal' : undefined;
    const day = input.onDate ?? this.tables.today();
    let table = null;
    if (input.rateTableId) {
      const version = (await this.tables.versionsOf(companyId, productId)).find((v) => String(v._id) === input.rateTableId);
      if (!version) throw new InvalidRequestException(PRODUCT_DATA_REFUSALS.VALIDATION_FAILED.noTableToTry, { field: 'rateTableId' });
      table = await this.calculator.load(String(version._id), version.effectiveFrom, version.rules, version.frequencies, age);
    } else if (item.snapshot.calcType !== 'manual') {
      table = await this.calculator.tableFor(productId, day, age);
    }
    const calculated = calculateItem(patched, { clientAge: age, clientGender: input.gender }, table, {
      typed, frequencyChanged: patched.payFrequency !== item.payFrequency,
    });
    const view = {
      ...calculated,
      name: calculated.snapshot.name,
      plan: planOf(calculated),
      currency: calculated.premium?.currency ?? calculated.up?.currency ?? 'IDR',
      totalPaid: totalPaidOf(calculated),
      calc: calculated.calc ?? null,
    };
    return { item: view, box: itemOf(calculated as unknown as PdfItemSource, 'Klien', true) };
  }

  /** The latest change to a table or a product of the company, and who made it. */
  private async lastUpdated(
    products: readonly { updatedAt?: Date; updatedBy?: string | null }[], versions: readonly RateTableDocument[],
  ): Promise<ProductDataOverview['lastUpdated']> {
    const changes = [
      ...products.map((p) => ({ at: p.updatedAt ?? null, by: p.updatedBy ?? null })),
      ...versions.map((v) => ({ at: v.updatedAt ?? null, by: v.updatedBy ?? null })),
    ].filter((c): c is { at: Date; by: string | null } => c.at instanceof Date).sort((a, b) => b.at.getTime() - a.at.getTime());
    const latest = changes[0];
    if (!latest) return null;
    let name: string | null = null;
    if (latest.by && isValidObjectId(latest.by)) {
      const user = await this.users.findById(latest.by).select('fullName').lean().exec();
      name = (user as { fullName?: string } | null)?.fullName ?? null;
    }
    return { at: latest.at.toISOString(), by: latest.by ? { id: latest.by, name } : null };
  }
}

function factsOf(t: RateTableDocument): VersionFacts & { doc: RateTableDocument } {
  return {
    id: String(t._id), version: t.version, effectiveFrom: t.effectiveFrom, effectiveTo: t.effectiveTo,
    activatedAt: t.activatedAt, turnedOffAt: t.turnedOffAt, deletedAt: t.deletedAt, doc: t,
  };
}
