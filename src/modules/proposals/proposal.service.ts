import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, InvalidRequestException, NoMembershipException, NotFoundException, VersionConflictException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { localDayOf } from '@/common/time/local-day';
import {
  PROPOSAL, type ProductCurrency, type ProposalRefusalReason, type ProposalStatus,
} from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { goalKeyOf, type ItemCalc } from '@/modules/product-data/item-calculation';
import { PremiumCalculator } from '@/modules/product-data/premium-calculator.service';
import type { FixedAmount } from '@/modules/product-data/premium-engine';
import { LeadRepository } from '@/modules/leads/lead.repository';
import type { LeadDocument } from '@/modules/leads/lead.schema';
import { KpmProductService, type OfficeShelfEntry } from '@/modules/products/kpm-product.service';
import { Product, type ProductDocument } from '@/modules/products/product.schema';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { clientAfter, clientPrefillOf, detailsOf, type ClientInput, type ProposalClient } from './proposal-client';
import { catalogOf, refusalOf, type CatalogProductView } from './proposal-offer';
import { proposalFileName } from './proposal-pdf.layout';
import {
  applyItemPatch, currencyOf, itemName, missingOf, newItem, planOf, settlePayTerm, totalPaidOf, totalsOf,
  type ItemPatch, type ItemSnapshot, type ProposalTotal, type StoredItem,
} from './proposal-items';
import { ProposalRepository } from './proposal.repository';
import type { ProposalDocument } from './proposal.schema';
import { PROPOSAL_REFUSALS } from './proposals.messages';

/** One item, as every route answers it: what is stored, with what is derived from it. */
export interface ProposalItemView {
  itemId: string;
  productId: string;
  productCode: string;
  productVersion: number;
  /** The product's name (ADR-0255 §1). */
  name: string;
  plan: string | null;
  currency: ProductCurrency;
  snapshot: ItemSnapshot;
  insured: StoredItem['insured'];
  smoker: boolean | null;
  fieldValues: Record<string, string | number>;
  payTerm: string | null;
  payFrequency: StoredItem['payFrequency'];
  up: StoredItem['up'];
  premium: StoredItem['premium'];
  fixedField: StoredItem['fixedField'];
  rateTableVersionId: string | null;
  rateTableEffectiveFrom: string | null;
  calcNote: string | null;
  /** **What the card shows of its calculation** (P19.15-T1; ADR-0258 §5), or `null` on a typed (`manual`) item. */
  calc: ItemCalc | null;
  /** *Total dibayar* (§B.34), computed here and never on the screen. */
  totalPaid: { amountMinor: number; years: number } | null;
  choice: null;
}

/** The proposal, as every route answers it (`functional/proposal.md`, *The proposal, as every route answers it*). */
export interface ProposalView {
  id: string;
  version: number;
  leadId: string;
  leadDeleted: boolean;
  client: ProposalClient;
  showTotal: boolean;
  status: ProposalStatus;
  doneAt: string | null;
  firstDoneAt: string | null;
  /** `YYYY-MM-DD`, the KPM's calendar: the day of `doneAt`, else today. The PDF's date and its file name's (ADR-0222 §6). */
  date: string;
  /** **The PDF's file name**, `Proposal-{Nama klien}-{date}.pdf` (ADR-0222 §6): the one the screen saves it as. */
  fileName: string;
  items: ProposalItemView[];
  /** Per currency and per *Cara bayar* (ADR-0255 §7). */
  totals: ProposalTotal[];
  duplicatedFrom: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One line of *Riwayat*, and of the lead sheet's *Proposal* section (ADR-0221 §5; ADR-0257 §3). */
export interface ProposalRowView {
  id: string;
  version: number;
  client: { name: string };
  date: string;
  /** The PDF's file name on `date` (ADR-0222 §6): *Riwayat*'s *Unduh lagi* saves the file under it. */
  fileName: string;
  products: { name: string; plan: string | null }[];
  status: ProposalStatus;
  totals: ProposalTotal[];
  leadId: string;
  leadDeleted: boolean;
  updatedAt: string;
}

export interface ProposalQuery {
  search?: string;
  status?: ProposalStatus;
  leadId?: string;
  page?: number;
  pageSize?: number;
}

export interface ProposalSettingsPatch {
  expectedVersion: number;
  showTotal?: boolean;
  leadId?: string;
  client?: ClientInput;
}

/**
 * **The simple proposal: the agent's own record, saved on every change** (P19.7-T2; ADR-0221; ADR-0225 §6–§8;
 * `functional/proposal.md`).
 *
 * - **Owned by one membership and answered to nobody else.** Every route finds the proposal by its id **and its owner**,
 *   in the caller's office, so another member's — a leader's downline's included — another KPM's, a deleted one and an
 *   id that is nobody's are all `404 PROPOSAL_NOT_FOUND`, the same answer (ADR-0221 §2).
 * - **Every write is pinned** (`expectedVersion`) and made in one operation with the check (`ProposalRepository.writeAt`):
 *   a stale one is `409 VERSION_CONFLICT` and nothing is written (§3).
 * - **What is offered is one rule** (`proposal-offer.ts`), read off the office's shelf as the catalogue reads it
 *   (`KpmProductService.shelfOf`). Each item keeps a snapshot of its product, never refreshed (ADR-0225 §6).
 * - **No audit entry copies a name, an age or a premium** (§12): ids and counts only.
 * - **Nothing is sent and nothing is public** (§10): no notification, no token.
 */
@Injectable()
export class ProposalService {
  constructor(
    private readonly proposals: ProposalRepository,
    private readonly leads: LeadRepository,
    private readonly shelf: KpmProductService,
    private readonly days: TenantDay,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    /**
     * Read once, for one question: is a product that is not on the office's shelf **its own company's, deleted** — a
     * withdrawn product taken off the catalogue (ADR-0209 §10) — so the refusal says `withdrawn` rather than
     * `not_on_shelf` (ADR-0225 §7). Company-filtered, as `KpmProductService.productsOf` is; never written.
     */
    @InjectModel(Product.name) private readonly products: Model<ProductDocument>,
    /**
     * **The premium tables' calculation** (P19.15-T1; ADR-0258 §5): each item's amounts worked out with the version in
     * force on the KPM's day, on every write that touches it and on a draft re-opened after another version took effect.
     * Optional so a spec about something else builds the service without it: every product is then typed.
     */
    @Optional() private readonly calculator?: PremiumCalculator,
  ) {}

  // ------------------------------------------------------------------------------------------------ reads

  /**
   * `GET /proposals`: *Riwayat* — the caller's own live proposals, newest change first (ADR-0221 §5). **`status=done`
   * orders by the last *Simpan PDF*** (`doneAt`, P19.11-T3 AC-7; UXQ3), so the lead sheet's one finished proposal is the
   * first row of `?leadId=…&status=done&pageSize=1`. A finished proposal's last change is that save, so *Riwayat*'s
   * *Selesai* filter reads in the same order as before.
   */
  async list(ctx: RequestContext, query: ProposalQuery = {}): Promise<{ rows: ProposalRowView[]; total: number; page: number; pageSize: number }> {
    const me = this.me(ctx);
    const filter: Record<string, unknown> = { ownerMembershipId: me };
    if (query.status) filter.status = query.status;
    if (query.leadId) filter.leadId = query.leadId;
    if (query.search?.trim()) {
      // Escaped: a client's name is typed text, and `(` in a pattern is not a bracket.
      const needle = new RegExp(query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ 'client.name': needle }, { 'items.snapshot.name': needle }, { 'items.snapshot.syariahName': needle }];
    }
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(Math.max(1, query.pageSize ?? PROPOSAL.LIST_PAGE_SIZE), PROPOSAL.LIST_PAGE_SIZE_MAX);
    const [total, rows, day] = await Promise.all([
      this.proposals.count(ctx, filter),
      this.proposals.find(ctx, filter, {
        sort: query.status === 'done' ? { doneAt: -1, _id: -1 } : { updatedAt: -1, _id: -1 },
        skip: (page - 1) * pageSize,
        limit: pageSize,
      }),
      this.days.for(ctx),
    ]);
    const live = await this.liveLeads(ctx, rows.map((row) => row.leadId));
    return {
      rows: rows.map((row) => {
        const date = localDayOf(row.status === 'done' && row.doneAt ? row.doneAt : row.updatedAt, day.timezone);
        return {
          id: String(row._id),
          version: row.version,
          client: { name: row.client.name },
          date,
          fileName: proposalFileName(row.client.name, row.status === 'done' && row.doneAt ? date : day.today).name,
          products: (row.items ?? []).map((item) => ({ name: itemName(item.snapshot), plan: planOf(item) })),
          status: row.status,
          totals: totalsOf(row.items ?? []),
          leadId: row.leadId,
          leadDeleted: !live.has(row.leadId),
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
      total,
      page,
      pageSize,
    };
  }

  /** `GET /proposals/:proposalId`. */
  async read(ctx: RequestContext, id: string): Promise<ProposalView> {
    return this.answer(ctx, await this.refreshed(ctx, await this.owned(ctx, id)));
  }

  /**
   * `GET /proposals/catalog`: **what step 2 may add** (ADR-0225 §7; ADR-0255 §8; P19.14-T2 AC-2): every product on the
   * office's shelf on sale, a base, **each with `outOfAge` for this client's age** — listed and greyed, never hidden. A
   * KPM with nothing to offer gets an empty list, which the screen says in its own words — never an error.
   */
  async catalog(ctx: RequestContext, age: number | null): Promise<{ products: CatalogProductView[] }> {
    this.me(ctx);
    const { entries } = await this.shelf.shelfOf(ctx);
    return { products: catalogOf(entries, age) };
  }

  // ------------------------------------------------------------------------------------------------ writes

  /**
   * `POST /proposals`: **the draft, created at step 1's *Lanjut*** (ADR-0221 §3; ADR-0254 §1, §2) for one of the
   * caller's own live Sales leads: the client's name copied from the lead, **the age, the gender and the details from
   * step 1 — never from the lead, and never written to it**. Another member's lead, or another KPM's, is `404 NOT_FOUND`
   * (*Lead*); a Recruit lead or one with no type `400`; a client without an age or a gender `400`, an age outside 1–100
   * `422 LEAD_AGE_OUT_OF_RANGE`.
   *
   * **Never a second empty draft for the same lead** (P19.11-T3 AC-8; UX-11): where the caller already has a live draft
   * on this lead **with no product chosen**, that draft is the answer, its client taken again from this write, instead
   * of another row. A draft with a product is the agent's work and is never reused; a finished one never either.
   */
  async create(ctx: RequestContext, leadId: string, input: ClientInput): Promise<ProposalView> {
    const me = this.me(ctx);
    const lead = await this.salesLead(ctx, me, leadId);
    const day = await this.days.for(ctx);
    const [empty] = await this.proposals.find(
      ctx,
      { ownerMembershipId: me, leadId, status: 'draft', 'items.0': { $exists: false } },
      { sort: { updatedAt: -1, _id: -1 }, limit: 1 },
    );
    if (empty) {
      const client = clientAfter(empty.client, input, lead.name, day.today);
      if (sameClient(empty.client, client)) return this.answer(ctx, empty, false);
      const refreshed = await this.write(ctx, empty, { client });
      await this.record(ctx, 'proposal.updated', String(empty._id), { fields: ['client'], reused: true });
      return this.answer(ctx, refreshed, false);
    }
    const client = clientAfter(null, input, lead.name, day.today);
    const created = await this.proposals.create(ctx, {
      ownerMembershipId: me,
      leadId,
      client,
      showTotal: false,
      status: 'draft',
      doneAt: null,
      firstDoneAt: null,
      firstDoneProducts: [],
      items: [],
      duplicatedFrom: null,
      version: 1,
      createdBy: me,
      updatedBy: me,
    } as Partial<ProposalDocument>);
    await this.record(ctx, 'proposal.created', String(created._id), { leadId, items: 0 });
    return this.answer(ctx, created, false);
  }

  /**
   * `PATCH /proposals/:proposalId`: *Tampilkan total*, and step 1 — the lead and the client (ADR-0221 §3; ADR-0254 §2).
   *
   * - **A `leadId` takes that lead's name**, the same lead or another of the caller's own Sales leads.
   * - **`client` lays the age, the gender and the details over what is stored** — never onto the lead.
   * - **A change of the client's age removes the items whose entry ages it leaves**, in the same write, and answers
   *   their ids (`removedItemIds`): the screen asked first. **Each client-insured item's pay term is held to the new age**,
   *   moving to the longest it allows (ADR-0255 §2).
   */
  async update(ctx: RequestContext, id: string, body: ProposalSettingsPatch): Promise<ProposalView & { removedItemIds: string[] }> {
    const me = this.me(ctx);
    const doc = await this.pinned(ctx, id, body.expectedVersion);
    const set: Record<string, unknown> = {};
    const changed: string[] = [];
    let items: StoredItem[] = [...(doc.items ?? [])];

    if (body.showTotal !== undefined && body.showTotal !== doc.showTotal) {
      set.showTotal = body.showTotal;
      changed.push('showTotal');
    }
    let name = doc.client.name;
    if (body.leadId !== undefined) {
      name = (await this.salesLead(ctx, me, body.leadId)).name;
      set.leadId = body.leadId;
      changed.push('leadId');
    }
    let removedItemIds: string[] = [];
    if (body.leadId !== undefined || body.client !== undefined) {
      const day = await this.days.for(ctx);
      const client = clientAfter(doc.client, body.client ?? {}, name, day.today);
      if (!sameClient(doc.client, client)) {
        set.client = client;
        changed.push('client');
      }
      if (client.age !== doc.client.age && items.length > 0) {
        const { entries } = await this.shelf.shelfOf(ctx);
        const fits = (item: StoredItem) => {
          const entry = entries.find((e) => String(e.product._id) === item.productId);
          return entry !== undefined && refusalOf(entry, client.age) === null;
        };
        removedItemIds = items.filter((item) => !fits(item)).map((item) => item.itemId);
        items = items.filter(fits).map((item) => settlePayTerm(item, client.age));
        set.items = items;
      }
      // P19.15-T1 (ADR-0258 §5): a *Klien* item is priced by the client's age and gender — calculated again.
      if ((client.age !== doc.client.age || client.gender !== doc.client.gender) && items.length > 0 && this.calculator) {
        const day = (await this.days.for(ctx)).today;
        items = await Promise.all(items.map((item) => (item.insured.relation === 'client'
          ? this.calculator!.calculate(item, { clientAge: client.age, clientGender: client.gender }, day)
          : item)));
        set.items = items;
      }
    }

    const written = await this.write(ctx, doc, { ...set, status: 'draft' });
    await this.record(ctx, 'proposal.updated', id, { fields: changed, removedItems: removedItemIds.length });
    return { ...(await this.answer(ctx, written)), removedItemIds };
  }

  /**
   * `POST /proposals/:proposalId/items`: **adds a product** (ADR-0221 §3; ADR-0225 §6, §7; ADR-0255 §2), with its
   * snapshot, every `chips` field preselected, the `derived` one worked out, the product's own *Tertanggung*, its default
   * pay term the client's age allows and *Cara bayar* *Bulanan* where offered. A product already in, or a sixth, is
   * `400`; one not offered — the client outside its entry ages among them — `422 PROPOSAL_PRODUCT_WITHDRAWN` with the
   * reason.
   */
  async addItem(ctx: RequestContext, id: string, expectedVersion: number, productId: string): Promise<ProposalView> {
    const doc = await this.pinned(ctx, id, expectedVersion);
    const items = doc.items ?? [];
    if (items.some((item) => item.productId === productId)) {
      throw new InvalidRequestException(PROPOSAL_REFUSALS.VALIDATION_FAILED.alreadyAdded, { field: 'productId' });
    }
    if (items.length >= PROPOSAL.ITEMS_MAX) {
      throw new InvalidRequestException(PROPOSAL_REFUSALS.VALIDATION_FAILED.tooManyItems({ max: PROPOSAL.ITEMS_MAX }), { field: 'productId' });
    }
    const { companyId, entries } = await this.shelf.shelfOf(ctx);
    const entry = entries.find((e) => String(e.product._id) === productId);
    const reason = entry ? refusalOf(entry, doc.client.age) : await this.offShelf(companyId, productId);
    if (reason !== null) {
      throw new DomainException(
        ErrorCode.PROPOSAL_PRODUCT_WITHDRAWN,
        PROPOSAL_REFUSALS.PROPOSAL_PRODUCT_WITHDRAWN.notOffered({ reason }),
        HttpStatus.UNPROCESSABLE_ENTITY,
        { reason },
      );
    }
    const { product, view } = entry as OfficeShelfEntry;
    const made = newItem(new Types.ObjectId().toHexString(), product, view.displayName.value, doc.client.age);
    // P19.15-T1: a product with a table in force says so from the start — the card calculates once an amount is typed.
    const item = await this.calculated(ctx, doc, made, {});
    const written = await this.write(ctx, doc, { items: [...items, item], status: 'draft' });
    await this.record(ctx, 'proposal.updated', id, { fields: ['items'], added: item.productId, items: items.length + 1 });
    return this.answer(ctx, written);
  }

  /**
   * `PATCH /proposals/:proposalId/items/:itemId`: *Tertanggung*, the fields, *Merokok?*, the pay term, *Cara bayar*, the
   * sum assured and the premium, each checked against the item's own snapshot (ADR-0255 §2).
   */
  async updateItem(ctx: RequestContext, id: string, itemId: string, expectedVersion: number, patch: ItemPatch): Promise<ProposalView> {
    const doc = await this.pinned(ctx, id, expectedVersion);
    const items = [...(doc.items ?? [])];
    const at = this.itemAt(items, itemId);
    const before = items[at];
    const applied = applyItemPatch(before, patch, doc.client.age);
    /*
     * P19.15-T1 AC-5 (ADR-0258 §5): **the server calculates on every save**, so the rates never leave it. The amount just
     * typed becomes the fixed one — the UP, the premium, or the goal's field — and a change of *Cara bayar* keeps the UP.
     */
    const goalKey = goalKeyOf(before.snapshot);
    const typed: FixedAmount | undefined = patch.up !== undefined ? 'up' : patch.premium !== undefined ? 'premium'
      : goalKey !== null && patch.fieldValues !== undefined && goalKey in patch.fieldValues ? 'goal' : undefined;
    items[at] = await this.calculated(ctx, doc, applied, {
      typed, frequencyChanged: applied.payFrequency !== before.payFrequency, touched: true,
    });
    const written = await this.write(ctx, doc, { items, status: 'draft' });
    const fields = (['insured', 'fieldValues', 'smoker', 'payTerm', 'payFrequency', 'up', 'premium'] as const)
      .filter((key) => patch[key] !== undefined);
    await this.record(ctx, 'proposal.updated', id, { fields: fields.map((f) => `items.${f}`), itemId });
    return this.answer(ctx, written);
  }

  /** `DELETE /proposals/:proposalId/items/:itemId`. */
  async removeItem(ctx: RequestContext, id: string, itemId: string, expectedVersion: number): Promise<ProposalView> {
    const doc = await this.pinned(ctx, id, expectedVersion);
    const items = [...(doc.items ?? [])];
    items.splice(this.itemAt(items, itemId), 1);
    const written = await this.write(ctx, doc, { items, status: 'draft' });
    await this.record(ctx, 'proposal.updated', id, { fields: ['items'], removed: itemId, items: items.length });
    return this.answer(ctx, written);
  }

  /**
   * `POST /proposals/:proposalId/done`: ***Simpan PDF*'s first half** (ADR-0221 §4; T2 AC-11; T3 calls it from step 3).
   *
   * - **It needs a complete proposal** — a product at least; each premium above zero; a name and an age for anyone but
   *   *Klien*; a value for every `chips` and `derived` field; a pay term where the product has any — else `422
   *   PROPOSAL_INCOMPLETE`, `details.items` naming each gap.
   * - **Every product still offered**, else `422 PROPOSAL_PRODUCT_WITHDRAWN`, `details.itemIds`.
   * - **It writes `status: 'done'` and `doneAt`**, and the first time only `firstDoneAt` and `firstDoneProducts` — the
   *   lead's *"Proposal dibuat · …"* note and `PROPOSALS_MADE` read those, and nothing is written to the lead.
   */
  async done(ctx: RequestContext, id: string, expectedVersion: number): Promise<ProposalView> {
    const pinned = await this.pinned(ctx, id, expectedVersion);
    /*
     * P19.15-T1 AC-6: **stale numbers never print.** Where another version took effect since the draft was read, it is
     * calculated again and written, and the save is a `409` — the screen reads the draft again and shows *"Premi
     * diperbarui ke tarif {date}"* before anyone saves it.
     */
    const doc = await this.refreshed(ctx, pinned);
    if (doc.version !== pinned.version) throw new VersionConflictException(expectedVersion, doc.version);
    const items = doc.items ?? [];
    if (items.length === 0) {
      throw new DomainException(
        ErrorCode.PROPOSAL_INCOMPLETE, PROPOSAL_REFUSALS.PROPOSAL_INCOMPLETE.noProduct, HttpStatus.UNPROCESSABLE_ENTITY, { items: [] },
      );
    }
    const gaps = items.map((item) => ({ itemId: item.itemId, missing: missingOf(item) })).filter((gap) => gap.missing.length > 0);
    if (gaps.length > 0) {
      throw new DomainException(
        ErrorCode.PROPOSAL_INCOMPLETE, PROPOSAL_REFUSALS.PROPOSAL_INCOMPLETE.fillGaps, HttpStatus.UNPROCESSABLE_ENTITY, { items: gaps },
      );
    }
    const { entries } = await this.shelf.shelfOf(ctx);
    const unoffered = items.filter((item) => {
      const entry = entries.find((e) => String(e.product._id) === item.productId);
      return !entry || refusalOf(entry, doc.client.age) !== null;
    }).map((item) => item.itemId);
    if (unoffered.length > 0) {
      throw new DomainException(
        ErrorCode.PROPOSAL_PRODUCT_WITHDRAWN,
        PROPOSAL_REFUSALS.PROPOSAL_PRODUCT_WITHDRAWN.noLongerOffered({ count: unoffered.length }),
        HttpStatus.UNPROCESSABLE_ENTITY,
        { itemIds: unoffered },
      );
    }
    const now = this.clock.now();
    const set: Record<string, unknown> = { status: 'done', doneAt: now };
    if (!doc.firstDoneAt) {
      set.firstDoneAt = now;
      set.firstDoneProducts = items.map((item) => itemName(item.snapshot));
    }
    const written = await this.write(ctx, doc, set);
    await this.record(ctx, 'proposal.done', id, { items: items.length, first: !doc.firstDoneAt });
    return this.answer(ctx, written);
  }

  /**
   * `POST /proposals/:proposalId/duplicate`: **a new *Draf* for the same lead** (ADR-0221 §5; ADR-0254 §4): the lead's
   * name again, the source's client with the age moved up by the years since it was entered, the items copied with their
   * snapshots and values — each pay term held to the age — and any product no longer offered left out
   * (`droppedProductIds`). A deleted lead's proposal is `404 NOT_FOUND` (*Lead*).
   */
  async duplicate(ctx: RequestContext, id: string): Promise<ProposalView & { droppedProductIds: string[] }> {
    const me = this.me(ctx);
    const source = await this.owned(ctx, id);
    const lead = await this.ownLead(ctx, me, source.leadId);
    const day = await this.days.for(ctx);
    const prefill = clientPrefillOf(source.client, day.today);
    const client = clientAfter(null, prefill, lead.name, day.today);
    const { entries } = await this.shelf.shelfOf(ctx);
    const kept: StoredItem[] = [];
    const droppedProductIds: string[] = [];
    for (const item of source.items ?? []) {
      const entry = entries.find((e) => String(e.product._id) === item.productId);
      if (entry && refusalOf(entry, client.age) === null) {
        const copy = settlePayTerm({ ...item, itemId: new Types.ObjectId().toHexString() }, client.age);
        // P19.15-T1: a new draft calculates with today's version, never the source's (ADR-0258 §5).
        kept.push(await this.calculated(ctx, { client } as ProposalDocument, copy, {}));
      } else {
        droppedProductIds.push(item.productId);
      }
    }
    const created = await this.proposals.create(ctx, {
      ownerMembershipId: me,
      leadId: source.leadId,
      client,
      showTotal: source.showTotal,
      status: 'draft',
      doneAt: null,
      firstDoneAt: null,
      firstDoneProducts: [],
      items: kept,
      duplicatedFrom: String(source._id),
      version: 1,
      createdBy: me,
      updatedBy: me,
    } as Partial<ProposalDocument>);
    await this.record(ctx, 'proposal.created', String(created._id), {
      leadId: source.leadId, duplicatedFrom: String(source._id), items: kept.length, dropped: droppedProductIds.length,
    });
    return { ...(await this.answer(ctx, created, false)), droppedProductIds };
  }

  /**
   * `DELETE /proposals/:proposalId`: **soft** (`deletedAt`, `deletedBy`; invariant §6). It leaves *Riwayat*, the lead's
   * pill and its *Proposal* section; the lead's *"Proposal dibuat"* note stays, unlinked.
   */
  async remove(ctx: RequestContext, id: string, expectedVersion: number): Promise<void> {
    const doc = await this.pinned(ctx, id, expectedVersion);
    await this.write(ctx, doc, { deletedAt: this.clock.now(), deletedBy: ctx.membershipId });
    await this.record(ctx, 'proposal.deleted', id, { items: (doc.items ?? []).length });
  }

  // ------------------------------------------------------------------------------------------------ internals

  /** **An item calculated** with the version in force on the KPM's day (P19.15-T1); as it is without the calculator. */
  private async calculated(
    ctx: RequestContext, doc: Pick<ProposalDocument, 'client'>, item: StoredItem,
    opts: Parameters<PremiumCalculator['calculate']>[3],
  ): Promise<StoredItem> {
    if (!this.calculator) return item;
    const day = (await this.days.for(ctx)).today;
    return this.calculator.calculate(item, { clientAge: doc.client.age ?? null, clientGender: doc.client.gender ?? null }, day, opts);
  }

  /**
   * **A draft re-opened after another version took effect, calculated again** (P19.15-T1 AC-6; P1b *Versions*): each item
   * calculated with a version that is no longer the one in force on the KPM's day is calculated with the one that is —
   * *"Premi diperbarui ke tarif {date}"* — or, with none in force, its calculated amount emptied (*table_off*); the draft
   * is written once, audited by field. **A saved proposal is never touched**: it keeps the version it was calculated
   * with. Nor is a view-only session's read, which writes nothing; nor a write that lost a race, which is answered as read.
   */
  private async refreshed(ctx: RequestContext, doc: ProposalDocument): Promise<ProposalDocument> {
    if (!this.calculator || doc.status !== 'draft' || ctx.impersonationReadOnly || !(doc.items ?? []).length) return doc;
    const day = (await this.days.for(ctx)).today;
    let changed = 0;
    const items: StoredItem[] = [];
    for (const item of doc.items) {
      const was = item.calc?.mode === 'table' ? item.calc.tableId : item.rateTableVersionId;
      if (was === null || was === undefined) {
        items.push(item);
        continue;
      }
      const now = await this.calculator.inForceId(item.productId, day);
      if (now === was) {
        items.push(item);
        continue;
      }
      changed += 1;
      items.push(await this.calculated(ctx, doc, item, { refreshed: item.rateTableVersionId !== null }));
    }
    if (changed === 0) return doc;
    try {
      const written = await this.write(ctx, doc, { items });
      await this.record(ctx, 'proposal.updated', String(doc._id), { fields: ['items.premium'], recalculated: changed, reason: 'rate_table' });
      return written;
    } catch (err) {
      if (err instanceof VersionConflictException) return doc;
      throw err;
    }
  }

  /** The caller's own membership; the guard has already refused anybody without a grant. */
  private me(ctx: RequestContext): string {
    if (!ctx.membershipId) throw new NoMembershipException();
    return ctx.membershipId;
  }

  private notFound(): DomainException {
    return new DomainException(
      ErrorCode.PROPOSAL_NOT_FOUND, PROPOSAL_REFUSALS.PROPOSAL_NOT_FOUND.notYours, HttpStatus.NOT_FOUND,
    );
  }

  /** **One of the caller's own live proposals, or `404 PROPOSAL_NOT_FOUND`** — whoever's else it is (ADR-0221 §2). */
  private async owned(ctx: RequestContext, id: string): Promise<ProposalDocument> {
    const doc = await this.proposals.findOne(ctx, { _id: id, ownerMembershipId: this.me(ctx) });
    if (!doc) throw this.notFound();
    return doc;
  }

  /** The caller's own proposal at the version they read — the 404 first, so a stale pin confirms nothing. */
  private async pinned(ctx: RequestContext, id: string, expectedVersion: number): Promise<ProposalDocument> {
    const doc = await this.owned(ctx, id);
    if (doc.version !== expectedVersion) throw new VersionConflictException(expectedVersion, doc.version);
    return doc;
  }

  /** The write, pinned in the same operation: a writer who landed in between makes it a `409`, and a delete a `404`. */
  private async write(ctx: RequestContext, doc: ProposalDocument, set: Record<string, unknown>): Promise<ProposalDocument> {
    const id = String(doc._id);
    const written = await this.proposals.writeAt(ctx, id, doc.ownerMembershipId, doc.version, set);
    if (written) return written;
    const now = await this.proposals.findOne(ctx, { _id: id, ownerMembershipId: doc.ownerMembershipId });
    if (!now) throw this.notFound();
    throw new VersionConflictException(doc.version, now.version);
  }

  private itemAt(items: readonly StoredItem[], itemId: string): number {
    const at = items.findIndex((item) => item.itemId === itemId);
    if (at < 0) throw new InvalidRequestException(PROPOSAL_REFUSALS.VALIDATION_FAILED.noSuchItem, { field: 'itemId' });
    return at;
  }

  /** One of the caller's own live leads, or `404 NOT_FOUND` (*Lead*) — another member's and another KPM's alike. */
  private async ownLead(ctx: RequestContext, me: string, leadId: string): Promise<LeadDocument> {
    const lead = await this.leads.findOne(ctx, { _id: leadId, ownerMembershipId: me });
    if (!lead) throw new NotFoundException('Lead');
    return lead;
  }

  /** **One of the caller's own live Sales leads** (ADR-0221 §1): another member's or KPM's `404`, a Recruit lead `400`. */
  private async salesLead(ctx: RequestContext, me: string, leadId: string): Promise<LeadDocument> {
    const lead = await this.ownLead(ctx, me, leadId);
    if (lead.type !== 'sales') {
      throw new InvalidRequestException(PROPOSAL_REFUSALS.VALIDATION_FAILED.notSalesLead, { field: 'leadId' });
    }
    return lead;
  }

  /** **Why a product off the shelf is refused**: its own company's, deleted, is `withdrawn`; anything else `not_on_shelf`. */
  private async offShelf(companyId: string, productId: string): Promise<ProposalRefusalReason> {
    if (!isValidObjectId(productId)) return 'not_on_shelf';
    const deleted = await this.products.exists({ _id: productId, companyId, deletedAt: { $ne: null } }).exec();
    return deleted ? 'withdrawn' : 'not_on_shelf';
  }

  /** The leads among these that are still live. One query. */
  private async liveLeads(ctx: RequestContext, leadIds: readonly string[]): Promise<Set<string>> {
    const ids = [...new Set(leadIds)].filter((id) => isValidObjectId(id));
    if (ids.length === 0) return new Set();
    const live = await this.leads.find(ctx, { _id: { $in: ids } }, { projection: { _id: 1 } });
    return new Set(live.map((lead) => String(lead._id)));
  }

  /** The answer every route gives: the stored proposal with what is derived from it. */
  private async answer(ctx: RequestContext, doc: ProposalDocument, readLead = true): Promise<ProposalView> {
    const day = await this.days.for(ctx);
    const leadDeleted = readLead ? !(await this.liveLeads(ctx, [doc.leadId])).has(doc.leadId) : false;
    const date = doc.status === 'done' && doc.doneAt ? localDayOf(doc.doneAt, day.timezone) : day.today;
    const client = doc.client;
    return {
      id: String(doc._id),
      version: doc.version,
      leadId: doc.leadId,
      leadDeleted,
      client: {
        name: client.name,
        age: client.age ?? null,
        ageSetOn: client.ageSetOn ?? null,
        gender: client.gender ?? null,
        details: detailsOf(client.details),
      },
      showTotal: doc.showTotal,
      status: doc.status,
      doneAt: doc.doneAt ? doc.doneAt.toISOString() : null,
      firstDoneAt: doc.firstDoneAt ? doc.firstDoneAt.toISOString() : null,
      date,
      fileName: proposalFileName(client.name, date).name,
      items: (doc.items ?? []).map((item) => ({
        itemId: item.itemId,
        productId: item.productId,
        productCode: item.productCode,
        productVersion: item.productVersion,
        name: itemName(item.snapshot),
        plan: planOf(item),
        currency: item.premium?.currency ?? item.up?.currency ?? currencyFromSnapshot(item),
        snapshot: item.snapshot,
        insured: item.insured,
        smoker: item.smoker ?? null,
        fieldValues: item.fieldValues,
        payTerm: item.payTerm ?? null,
        payFrequency: item.payFrequency,
        up: item.up ?? null,
        premium: item.premium ?? null,
        fixedField: item.fixedField ?? 'none',
        rateTableVersionId: item.rateTableVersionId ?? null,
        rateTableEffectiveFrom: item.rateTableEffectiveFrom ?? null,
        calcNote: item.calcNote ?? null,
        calc: item.calc ?? null,
        totalPaid: totalPaidOf(item),
        choice: null,
      })),
      totals: totalsOf(doc.items ?? []),
      duplicatedFrom: doc.duplicatedFrom ?? null,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  }

  /** **Ids and counts, never a name, an age or a premium** (ADR-0221 §12). */
  private async record(ctx: RequestContext, action: string, targetId: string, after: Record<string, unknown>): Promise<void> {
    await this.audit.record(ctx, { action, targetCollection: 'proposals', targetId, after });
  }
}

/** Two clients the same, as a write compares them: nothing to write when they are. */
function sameClient(a: ProposalClient, b: ProposalClient): boolean {
  return JSON.stringify([a.name, a.age, a.ageSetOn ?? null, a.gender, a.details ?? null])
    === JSON.stringify([b.name, b.age, b.ageSetOn, b.gender, b.details]);
}

/** An item's currency where it holds no amount yet: the snapshot's rule (ADR-0225 §8). */
function currencyFromSnapshot(item: StoredItem): ProductCurrency {
  return currencyOf(item.snapshot, item.fieldValues);
}
