import { HttpStatus, Injectable } from '@nestjs/common';
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
  PROPOSAL, type ProductCurrency, type ProposalChannel, type ProposalPayFrequency, type ProposalRefusalReason,
  type ProposalStatus,
} from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { ageToday } from '@/modules/leads/lead-age';
import { LeadRepository } from '@/modules/leads/lead.repository';
import type { LeadDocument } from '@/modules/leads/lead.schema';
import { KpmProductService, type OfficeShelfEntry } from '@/modules/products/kpm-product.service';
import { Product, type ProductDocument } from '@/modules/products/product.schema';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { catalogOf, refusalOf, type CatalogProductView } from './proposal-offer';
import { proposalFileName } from './proposal-pdf.layout';
import {
  applyItemPatch, itemName, missingOf, newItem, planOf, totalPaidOf, totalsOf, withPremiumsEmptied,
  type ItemPatch, type ItemSnapshot, type StoredItem,
} from './proposal-items';
import { ProposalRepository } from './proposal.repository';
import type { ProposalClientCopy, ProposalDocument } from './proposal.schema';
import { PROPOSAL_REFUSALS } from './proposals.messages';

/** One item, as every route answers it: what is stored, with what is derived from it. */
export interface ProposalItemView {
  itemId: string;
  productId: string;
  productCode: string;
  productVersion: number;
  /** The name this proposal shows (ADR-0221 §9). */
  name: string;
  plan: string | null;
  currency: ProductCurrency;
  snapshot: ItemSnapshot;
  insured: StoredItem['insured'];
  fieldValues: Record<string, string | number>;
  premium: StoredItem['premium'];
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
  client: ProposalClientCopy;
  channel: ProposalChannel;
  payFrequency: ProposalPayFrequency;
  showTotal: boolean;
  status: ProposalStatus;
  doneAt: string | null;
  firstDoneAt: string | null;
  /** `YYYY-MM-DD`, the KPM's calendar: the day of `doneAt`, else today. The PDF's date and its file name's (ADR-0222 §6). */
  date: string;
  /** **The PDF's file name**, `Proposal-{Nama klien}-{date}.pdf` (ADR-0222 §6; P19.7-T3): the one the screen saves it as. */
  fileName: string;
  items: ProposalItemView[];
  totals: { currency: ProductCurrency; amountMinor: number }[];
  duplicatedFrom: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One line of *Riwayat* (ADR-0221 §5). */
export interface ProposalRowView {
  id: string;
  version: number;
  client: { name: string };
  date: string;
  /** The PDF's file name on `date` (ADR-0222 §6): *Riwayat*'s *Unduh lagi* saves the file under it. */
  fileName: string;
  products: { name: string; plan: string | null }[];
  status: ProposalStatus;
  totals: { currency: ProductCurrency; amountMinor: number }[];
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
  channel?: ProposalChannel;
  payFrequency?: ProposalPayFrequency;
  showTotal?: boolean;
  leadId?: string;
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
          products: (row.items ?? []).map((item) => ({ name: itemName(item.snapshot, row.channel), plan: planOf(item) })),
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
    return this.answer(ctx, await this.owned(ctx, id));
  }

  /**
   * `GET /proposals/catalog`: **what step 2 may add** for this channel and this client's age (ADR-0225 §7; Acc. 17, 21).
   * A KPM with nothing to offer gets an empty list, which the screen says in its own words — never an error.
   */
  async catalog(ctx: RequestContext, channel: ProposalChannel, age: number): Promise<{ products: CatalogProductView[] }> {
    this.me(ctx);
    const { entries } = await this.shelf.shelfOf(ctx);
    return { products: catalogOf(entries, channel, age) };
  }

  // ------------------------------------------------------------------------------------------------ writes

  /**
   * `POST /proposals`: **the draft, created at step 1's *Lanjut*** (ADR-0221 §3) for one of the caller's own live Sales
   * leads, with the client's copy taken from it. Another member's lead, or another KPM's, is `404 NOT_FOUND` (*Lead*); a
   * Recruit lead or one with no type, and one without an age or a gender — which step 1 saves to the lead first — `400`.
   *
   * **Never a second empty draft for the same lead** (P19.11-T3 AC-8; UX-11): where the caller already has a live draft
   * on this lead **with no product chosen**, that draft is the answer — its client's copy taken from the lead again, as
   * a new one's would be — instead of another row. *Lanjut* tapped twice, or *Buat proposal* opened again and left at
   * step 2, used to leave one empty *Draf* each time under the client's name. A draft with a product is the agent's work
   * and is never reused; a finished one never either.
   */
  async create(ctx: RequestContext, leadId: string): Promise<ProposalView> {
    const me = this.me(ctx);
    const client = await this.clientOf(ctx, me, leadId);
    const [empty] = await this.proposals.find(
      ctx,
      { ownerMembershipId: me, leadId, status: 'draft', 'items.0': { $exists: false } },
      { sort: { updatedAt: -1, _id: -1 }, limit: 1 },
    );
    if (empty) {
      const same = empty.client.name === client.name && empty.client.age === client.age && empty.client.gender === client.gender;
      if (same) return this.answer(ctx, empty, false);
      const refreshed = await this.write(ctx, empty, { client });
      await this.record(ctx, 'proposal.updated', String(empty._id), { fields: ['client'], reused: true });
      return this.answer(ctx, refreshed, false);
    }
    const created = await this.proposals.create(ctx, {
      ownerMembershipId: me,
      leadId,
      client,
      channel: 'conventional',
      payFrequency: 'monthly',
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
   * `PATCH /proposals/:proposalId`: the settings, and step 1's lead (ADR-0221 §3).
   *
   * - **A `leadId` takes the client's copy again**, the same lead or another of the caller's own.
   * - **A change of channel or of the client's age removes the items no longer offered**, in the same write, and answers
   *   their ids (`removedItemIds`): the screen asked first.
   * - **A change of *Cara bayar* empties every premium**: a monthly figure relabelled *per tahun* would mislead.
   */
  async update(ctx: RequestContext, id: string, body: ProposalSettingsPatch): Promise<ProposalView & { removedItemIds: string[] }> {
    const me = this.me(ctx);
    const doc = await this.pinned(ctx, id, body.expectedVersion);
    const set: Record<string, unknown> = {};
    const changed: string[] = [];
    let items: StoredItem[] = [...(doc.items ?? [])];
    let channel = doc.channel;
    let client = doc.client;

    if (body.channel !== undefined && body.channel !== doc.channel) {
      channel = body.channel;
      set.channel = channel;
      changed.push('channel');
    }
    if (body.payFrequency !== undefined && body.payFrequency !== doc.payFrequency) {
      set.payFrequency = body.payFrequency;
      items = withPremiumsEmptied(items);
      changed.push('payFrequency');
    }
    if (body.showTotal !== undefined && body.showTotal !== doc.showTotal) {
      set.showTotal = body.showTotal;
      changed.push('showTotal');
    }
    if (body.leadId !== undefined) {
      client = await this.clientOf(ctx, me, body.leadId);
      set.leadId = body.leadId;
      set.client = client;
      changed.push('leadId');
    }

    let removedItemIds: string[] = [];
    if ((changed.includes('channel') || changed.includes('leadId')) && items.length > 0) {
      const { entries } = await this.shelf.shelfOf(ctx);
      const fits = (item: StoredItem) => {
        const entry = entries.find((e) => String(e.product._id) === item.productId);
        return entry !== undefined && refusalOf(entry, channel, client.age) === null;
      };
      removedItemIds = items.filter((item) => !fits(item)).map((item) => item.itemId);
      items = items.filter(fits);
    }

    const written = await this.write(ctx, doc, { ...set, items, status: 'draft' });
    await this.record(ctx, 'proposal.updated', id, { fields: changed, removedItems: removedItemIds.length });
    return { ...(await this.answer(ctx, written)), removedItemIds };
  }

  /**
   * `POST /proposals/:proposalId/items`: **adds a product** (ADR-0221 §3; ADR-0225 §6, §7; T1 AC-5, AC-6), with its
   * snapshot, every `chips` field preselected and the product's own *Tertanggung*. A product already in, or a sixth, is
   * `400`; one not offered is `422 PROPOSAL_PRODUCT_WITHDRAWN` with the reason.
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
    const reason = entry ? refusalOf(entry, doc.channel, doc.client.age) : await this.offShelf(companyId, productId);
    if (reason !== null) {
      throw new DomainException(
        ErrorCode.PROPOSAL_PRODUCT_WITHDRAWN,
        PROPOSAL_REFUSALS.PROPOSAL_PRODUCT_WITHDRAWN.notOffered({ reason }),
        HttpStatus.UNPROCESSABLE_ENTITY,
        { reason },
      );
    }
    const { product, view } = entry as OfficeShelfEntry;
    const item = newItem(new Types.ObjectId().toHexString(), product, view.displayName.value);
    const written = await this.write(ctx, doc, { items: [...items, item], status: 'draft' });
    await this.record(ctx, 'proposal.updated', id, { fields: ['items'], added: item.productId, items: items.length + 1 });
    return this.answer(ctx, written);
  }

  /** `PATCH /proposals/:proposalId/items/:itemId`: *Tertanggung*, the fields and the premium, checked against the snapshot. */
  async updateItem(ctx: RequestContext, id: string, itemId: string, expectedVersion: number, patch: ItemPatch): Promise<ProposalView> {
    const doc = await this.pinned(ctx, id, expectedVersion);
    const items = [...(doc.items ?? [])];
    const at = this.itemAt(items, itemId);
    items[at] = applyItemPatch(items[at], patch);
    const written = await this.write(ctx, doc, { items, status: 'draft' });
    const fields = (['insured', 'fieldValues', 'premium'] as const).filter((key) => patch[key] !== undefined);
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
   *   *Klien*; a value for every `chips` field — else `422 PROPOSAL_INCOMPLETE`, `details.items` naming each gap.
   * - **Every product still offered**, else `422 PROPOSAL_PRODUCT_WITHDRAWN`, `details.itemIds`.
   * - **It writes `status: 'done'` and `doneAt`**, and the first time only `firstDoneAt` and `firstDoneProducts` — the
   *   lead's *"Proposal dibuat · …"* note and `PROPOSALS_MADE` read those, and nothing is written to the lead.
   */
  async done(ctx: RequestContext, id: string, expectedVersion: number): Promise<ProposalView> {
    const doc = await this.pinned(ctx, id, expectedVersion);
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
      return !entry || refusalOf(entry, doc.channel, doc.client.age) !== null;
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
      set.firstDoneProducts = items.map((item) => itemName(item.snapshot, doc.channel));
    }
    const written = await this.write(ctx, doc, set);
    await this.record(ctx, 'proposal.done', id, { items: items.length, first: !doc.firstDoneAt });
    return this.answer(ctx, written);
  }

  /**
   * `POST /proposals/:proposalId/duplicate`: **a new *Draf* for the same lead** (ADR-0221 §5): the client's copy taken
   * from the lead again, the items copied with their snapshots and values, and any product no longer offered left out
   * (`droppedProductIds`). A deleted lead's proposal is `404 NOT_FOUND` (*Lead*).
   */
  async duplicate(ctx: RequestContext, id: string): Promise<ProposalView & { droppedProductIds: string[] }> {
    const me = this.me(ctx);
    const source = await this.owned(ctx, id);
    const lead = await this.ownLead(ctx, me, source.leadId);
    const day = await this.days.for(ctx);
    const age = ageToday(lead.age, lead.ageRecordedOn, day.today);
    const client: ProposalClientCopy = {
      name: lead.name,
      age: age ?? source.client.age,
      gender: lead.gender ?? source.client.gender,
    };
    const { entries } = await this.shelf.shelfOf(ctx);
    const kept: StoredItem[] = [];
    const droppedProductIds: string[] = [];
    for (const item of source.items ?? []) {
      const entry = entries.find((e) => String(e.product._id) === item.productId);
      if (entry && refusalOf(entry, source.channel, client.age) === null) {
        kept.push({ ...item, itemId: new Types.ObjectId().toHexString() });
      } else {
        droppedProductIds.push(item.productId);
      }
    }
    const created = await this.proposals.create(ctx, {
      ownerMembershipId: me,
      leadId: source.leadId,
      client,
      channel: source.channel,
      payFrequency: source.payFrequency,
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

  /** **The client's copy from a lead** (ADR-0221 §1): a Sales lead's name, today's age and its gender. */
  private async clientOf(ctx: RequestContext, me: string, leadId: string): Promise<ProposalClientCopy> {
    const lead = await this.ownLead(ctx, me, leadId);
    if (lead.type !== 'sales') {
      throw new InvalidRequestException(PROPOSAL_REFUSALS.VALIDATION_FAILED.notSalesLead, { field: 'leadId' });
    }
    const day = await this.days.for(ctx);
    const age = ageToday(lead.age, lead.ageRecordedOn, day.today);
    if (age === null || !lead.gender) {
      throw new InvalidRequestException(PROPOSAL_REFUSALS.VALIDATION_FAILED.leadNeedsAgeAndGender, { field: 'leadId' });
    }
    return { name: lead.name, age, gender: lead.gender };
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
    return {
      id: String(doc._id),
      version: doc.version,
      leadId: doc.leadId,
      leadDeleted,
      client: { name: doc.client.name, age: doc.client.age, gender: doc.client.gender },
      channel: doc.channel,
      payFrequency: doc.payFrequency,
      showTotal: doc.showTotal,
      status: doc.status,
      doneAt: doc.doneAt ? doc.doneAt.toISOString() : null,
      firstDoneAt: doc.firstDoneAt ? doc.firstDoneAt.toISOString() : null,
      date,
      fileName: proposalFileName(doc.client.name, date).name,
      items: (doc.items ?? []).map((item) => ({
        itemId: item.itemId,
        productId: item.productId,
        productCode: item.productCode,
        productVersion: item.productVersion,
        name: itemName(item.snapshot, doc.channel),
        plan: planOf(item),
        currency: item.premium.currency,
        snapshot: item.snapshot,
        insured: item.insured,
        fieldValues: item.fieldValues,
        premium: item.premium,
        totalPaid: totalPaidOf(item, doc.payFrequency),
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
