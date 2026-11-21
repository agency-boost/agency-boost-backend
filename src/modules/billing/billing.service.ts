import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { DateTime } from 'luxon';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { InvalidRequestException, NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import {
  BILLING, BILLING_LAPSE_SUSPENSION_REASON, DEFAULT_TENANT_TIMEZONE, SUBSCRIPTION_PLAN_MONTHS, type SubscriptionPlan,
} from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { countLeadersUsedPerOffice } from '@/modules/org/leader-limit';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { PlatformSettingsService } from '@/modules/platform-settings/platform-settings.service';
import { renderPdf } from '@/modules/proposals/proposal-pdf.builder';
import { dispositionOf } from '@/modules/proposals/proposal-pdf.layout';
import { can, type Permission } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument, type KpmSubscription } from '@/modules/tenants/kpm.schema';
import { addOfficeDays, graceEndsOn, isPastGraceOn, subscriptionStateOn } from '@/modules/tenants/subscription';
import { User, UserDocument } from '@/modules/users/user.schema';
import type { BillingKpmFilter, OfferInputDto, OfferPdfDto } from './billing.dto';
import { BILLING_REFUSALS } from './billing.messages';
import { offerDocument, offerFileName } from './offer-pdf';
import { OfferInputError, priceOffer, tierFor, type BulkDiscount, type OfferPricing } from './price-offer';

/**
 * Why a KPM is on *Perlu tindakan*, or what its one pill says (P19.23-T5 AC-4; ADR-0279 §6) — one per row, in this
 * order: *Ditangguhkan*, *Berakhir*, *Melewati batas*, *Trial*, *Berakhir ≤ 30 hari*.
 */
export type BillingAttention = 'suspended' | 'ended' | 'over' | 'trial' | 'ending_soon';

/** The four that need an action from the Super Admin (*Perlu tindakan*); a suspended KPM is shown, not counted. */
const NEEDS_ACTION: ReadonlySet<BillingAttention> = new Set(['ended', 'over', 'trial', 'ending_soon']);

/** One KPM on *Langganan per KPM*: counts, prices and dates, and its Owner's WhatsApp for *Kirim penawaran*. */
export interface BillingKpmRow {
  kpmId: string;
  code: string;
  branch: string;
  company: { id: string; name: string };
  /** The KPM's own status: `active` or `suspended` (an archived KPM is not listed). */
  kpmStatus: 'active' | 'suspended';
  /** The Owner, or the Owner named and waiting (ADR-0212 §3): the name, and the number *Kirim penawaran* opens. */
  owner: { fullName: string; phone: string | null } | null;
  /** *Leader dipakai*: ADR-0113's count, test accounts never counted. */
  leadersUsed: number;
  /** The limit — the leaders the package was confirmed for — or `null` for none. */
  maxLeaders: number | null;
  /** *paket 1–10 leader*: the tier of the package's leaders, else of the leaders used. */
  tier: { code: string; minLeaders: number; maxLeaders: number | null };
  /** *Harga / leader*, before the annual discount; `null` without a price (a trial, none). */
  rateMinor: number | null;
  /** *harga khusus*: a price other than the tier's offer price. */
  customPrice: boolean;
  plan: SubscriptionPlan | null;
  trial: boolean;
  startDate: string | null;
  endDate: string | null;
  /** *Per bulan*: the period's total ÷ its months. */
  perMonthMinor: number | null;
  /** *Tagihan per periode*: the confirmed total, or for a package set before 19.23 the price × leaders × months. */
  periodTotalMinor: number | null;
  /** The last day of the grace, for a KPM whose period has ended and is not kept active; else `null`. */
  graceEndsOn: string | null;
  attention: BillingAttention | null;
  needsAction: boolean;
  /** The confirmed inputs, so *Atur* opens the calculator as it was confirmed. */
  agents: number | null;
  bulkDiscount: BulkDiscount | null;
  note: string | null;
}

/** The navy summary (P19.23-T5 AC-4): always every KPM, whatever the filter. */
export interface BillingSummary {
  /** *Pendapatan per bulan*: Σ per bulan over the paying KPMs, *dari n KPM berbayar*. */
  monthlyRevenueMinor: number;
  payingKpms: number;
  /** *Leader ditagih*: Σ the leaders the paying KPMs' packages price. */
  leadersBilled: number;
  /** *Berakhir ≤ 30 hari*: a trial, or a period ending within 30 days. */
  endingSoon: number;
  /** *Perlu tindakan*. */
  needsAction: number;
  /** *Semua n*. */
  kpms: number;
}

/** The *Total* row over the rows shown. */
export interface BillingTotal {
  kpms: number;
  leadersUsed: number;
  /** *rata-rata tertimbang*: Σ price × leaders ÷ Σ leaders over the paying rows; `null` with none. */
  weightedRateMinor: number | null;
  perMonthMinor: number;
  /** *semua periode berjalan*. */
  periodTotalMinor: number;
  needsAction: number;
}

export interface BillingKpmList {
  summary: BillingSummary;
  total: BillingTotal;
  rows: BillingKpmRow[];
}

/** What the PDF route answers: the bytes, and how the browser names the file. */
export interface OfferPdfFile {
  bytes: Buffer;
  disposition: string;
}

/** A real calendar date in `YYYY-MM-DD`: `2026-02-30` has the shape and is no day. */
const isOfficeDate = (value: string) => DateTime.fromFormat(value, 'yyyy-MM-dd', { zone: 'utc' }).isValid;

const halfUp = (a: number, b: number) => Math.floor((2 * a + b) / (2 * b));

/**
 * **Langganan & akses** (P19.23-T5; ADR-0279): the list of KPMs with their subscriptions, *Konfirmasi paket*, and the
 * offer's PDF. The price list itself is `BillingController`'s.
 *
 * Platform-level, as `TenantService` is: KPM rows, companies and users are the platform's own collections, read here
 * with no tenant to scope to, and *Leader dipakai* is counted through the membership repository's named unscoped method
 * (invariant §1). The permission check opens every method, so nothing is read before it.
 */
@Injectable()
export class BillingService {
  constructor(
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly memberships: MembershipRepository,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly platform: PlatformSettingsService,
  ) {}

  private require(ctx: RequestContext, permission: Permission): void {
    if (!can(ctx, permission)) throw new PermissionDeniedException(permission);
  }

  /** **`GET /admin/billing/kpms`** (AC-4): every live, unarchived KPM, the summary, and the *Total* row. */
  async list(ctx: RequestContext, filter: BillingKpmFilter = 'all'): Promise<BillingKpmList> {
    this.require(ctx, 'billing:read_prices');
    const kpms = await this.kpms.find({ deletedAt: null, status: { $in: ['active', 'suspended'] } }).exec();
    const rows = await this.rowsOf(ctx, kpms);
    const shown = filter === 'needs_action' ? rows.filter((r) => r.needsAction) : rows;
    return { summary: summaryOf(rows), total: totalOf(shown), rows: shown };
  }

  /**
   * **`PUT /admin/billing/kpms/:kpmId/subscription`** — *Konfirmasi paket* (AC-2, AC-4; ADR-0279 §3): price the
   * calculator's inputs here, and write them as the KPM's subscription — its dates, its price, its leader limit (the
   * leaders priced), its plan and the period's total — the trial ended. Audited with the subscription before and after.
   *
   * **A KPM the daily run suspended is reactivated** when the new period is not itself past its grace (ADR-0279 §5); one
   * the Super Admin suspended themselves stays suspended. Answers the KPM's row as the list reads it.
   */
  async confirmPackage(ctx: RequestContext, kpmId: string, input: OfferInputDto): Promise<BillingKpmRow> {
    this.require(ctx, 'kpm:update_subscription');
    this.checkDates(input);
    const pricing = this.price(input);
    const kpm = await this.liveKpm(kpmId);

    const before = kpm.subscription ?? null;
    const note = input.note?.trim() || null;
    const next: KpmSubscription = {
      startDate: input.startDate,
      endDate: input.endDate,
      pricePerLeaderMinor: pricing.rateMinor,
      currency: 'IDR',
      maxLeaders: pricing.leaders,
      keepActiveAfterEnd: before?.keepActiveAfterEnd ?? false,
      plan: pricing.plan,
      trial: false,
      periodTotalMinor: pricing.totalMinor,
      bulkDiscount: bulkOf(input),
      agents: pricing.agents,
      note,
    };
    kpm.subscription = next;
    kpm.markModified('subscription');

    const today = this.clock.localDateFor(kpm.timezone ?? DEFAULT_TENANT_TIMEZONE);
    const reactivate = kpm.status === 'suspended' && kpm.suspendedReason === BILLING_LAPSE_SUSPENSION_REASON
      && !isPastGraceOn(next, today);
    if (reactivate) {
      kpm.status = 'active';
      kpm.suspendedAt = null;
      kpm.suspendedReason = null;
    }
    await kpm.save();

    await this.audit.record(ctx, {
      action: 'kpm.subscription_updated',
      targetCollection: 'kpms',
      targetId: kpmId,
      before: { subscription: before },
      after: { subscription: next },
    });
    if (reactivate) {
      await this.audit.record(ctx, {
        action: 'kpm.active',
        targetCollection: 'kpms',
        targetId: kpmId,
        before: { status: 'suspended', reason: BILLING_LAPSE_SUSPENSION_REASON },
        after: { status: 'active', reason: null },
      });
    }

    const [row] = await this.rowsOf(ctx, [kpm]);
    return row;
  }

  /**
   * **`POST /admin/billing/offer`** — *Buat PDF* (AC-2; ADR-0279 §7): the offer as a one-page PDF, priced here. For an
   * existing KPM its name and company are read here; for a new one the name typed. Nothing is stored or audited: it is
   * a document made from a calculation, as a print is.
   */
  async offerPdf(ctx: RequestContext, input: OfferPdfDto): Promise<OfferPdfFile> {
    this.require(ctx, 'billing:send_quote');
    this.checkDates(input);
    const pricing = this.price(input);

    let kpmName = input.kpmName?.trim() ?? '';
    let companyName: string | null = null;
    let timezone = DEFAULT_TENANT_TIMEZONE;
    if (input.kpmId) {
      const kpm = await this.liveKpm(input.kpmId);
      kpmName = kpm.branchName;
      timezone = kpm.timezone ?? DEFAULT_TENANT_TIMEZONE;
      const company = await this.companies.findOne({ _id: kpm.companyId }, { name: 1 }).exec();
      companyName = company?.name ?? null;
    }
    if (!kpmName) throw new InvalidRequestException(BILLING_REFUSALS.VALIDATION_FAILED.kpmName, { field: 'kpmName' });

    const today = this.clock.localDateFor(timezone);
    const definition = offerDocument({
      pricing,
      kpmName,
      companyName,
      startDate: input.startDate,
      endDate: input.endDate,
      note: input.note?.trim() || null,
      today,
      whatsappNumber: await this.platform.whatsappNumber(),
    });
    const { bytes } = await renderPdf(definition);
    return { bytes, disposition: dispositionOf(offerFileName(kpmName, today)) };
  }

  /** The rows, as the list reads them, for the KPMs given. */
  private async rowsOf(ctx: RequestContext, kpms: KpmDocument[]): Promise<BillingKpmRow[]> {
    if (kpms.length === 0) return [];
    const ids = kpms.map((k) => String(k._id));
    const ownerIds = kpms.map((k) => k.ownerUserId).filter((id): id is string => !!id && isValidObjectId(id));
    const [companies, leaders, owners] = await Promise.all([
      this.companies.find({ _id: { $in: [...new Set(kpms.map((k) => k.companyId))] } }, { name: 1 }).exec(),
      countLeadersUsedPerOffice(this.memberships, ctx, ids),
      ownerIds.length
        ? this.users.find({ _id: { $in: ownerIds }, deletedAt: null }, { fullName: 1, phone: 1 }).exec()
        : Promise.resolve([]),
    ]);
    const companyName = new Map(companies.map((c) => [String(c._id), c.name]));
    const ownerOf = new Map(owners.map((u) => [String(u._id), { fullName: u.fullName, phone: u.phone ?? null }]));

    const rows = kpms.map((kpm) => rowOf(
      kpm,
      companyName.get(kpm.companyId) ?? '',
      leaders.get(String(kpm._id)) ?? 0,
      (kpm.ownerUserId && ownerOf.get(kpm.ownerUserId))
        || (kpm.pendingOwner ? { fullName: kpm.pendingOwner.fullName, phone: kpm.pendingOwner.phone ?? null } : null),
      this.clock.localDateFor(kpm.timezone ?? DEFAULT_TENANT_TIMEZONE),
    ));
    return rows.sort((a, b) => a.company.name.localeCompare(b.company.name) || a.branch.localeCompare(b.branch)
      || a.code.localeCompare(b.code));
  }

  /** A live KPM that is not archived, or 404 — a malformed id included. */
  private async liveKpm(kpmId: string): Promise<KpmDocument> {
    const kpm = isValidObjectId(kpmId)
      ? await this.kpms.findOne({ _id: kpmId, deletedAt: null, status: { $in: ['active', 'suspended'] } }).exec()
      : null;
    if (!kpm) throw new NotFoundException('KPM');
    return kpm;
  }

  private checkDates(input: { startDate: string; endDate: string }): void {
    const SAY = BILLING_REFUSALS.VALIDATION_FAILED;
    if (!isOfficeDate(input.startDate)) throw new InvalidRequestException(SAY.date, { field: 'startDate' });
    if (!isOfficeDate(input.endDate)) throw new InvalidRequestException(SAY.date, { field: 'endDate' });
    if (input.endDate < input.startDate) throw new InvalidRequestException(SAY.endBeforeStart, { field: 'endDate' });
  }

  /** The inputs, priced; a bound the browser would refuse is a `400` naming its field. */
  private price(input: OfferInputDto): OfferPricing {
    try {
      return priceOffer({
        leaders: input.leaders,
        agents: input.agents ?? null,
        plan: input.plan,
        price: input.price.mode === 'per_leader'
          ? { mode: 'per_leader', rateMinor: input.price.rateMinor ?? Number.NaN }
          : { mode: 'total', totalMinor: input.price.totalMinor ?? Number.NaN },
        bulk: bulkOf(input),
      });
    } catch (err) {
      if (!(err instanceof OfferInputError)) throw err;
      const SAY = BILLING_REFUSALS.VALIDATION_FAILED;
      const sentence = {
        leaders: SAY.leaders,
        agents: SAY.agents,
        'price.rateMinor': SAY.rate,
        'price.totalMinor': SAY.total,
        'bulk.percent': SAY.percent,
        'bulk.amountMinor': SAY.amount,
      }[err.field];
      throw new InvalidRequestException(sentence, { field: err.field });
    }
  }
}

/** *Diskon bulk order* as the pricing function takes it; a zero is none. */
function bulkOf(input: OfferInputDto): BulkDiscount | null {
  const bulk = input.bulk;
  if (!bulk) return null;
  if (bulk.type === 'percent') return bulk.percent ? { type: 'percent', percent: bulk.percent } : null;
  return bulk.amountMinor ? { type: 'amount', amountMinor: bulk.amountMinor } : null;
}

/**
 * **A subscription's period total** (ADR-0279 §3): the confirmed one; for a package set before 19.23, or through *Edit
 * subscription*, the price × leaders × months less the annual discount — the calculator's own arithmetic — and `null`
 * without a price and a plan.
 */
export function periodTotalOf(sub: KpmSubscription | null, leadersUsed: number): number | null {
  if (!sub || sub.trial) return null;
  if (typeof sub.periodTotalMinor === 'number') return sub.periodTotalMinor;
  if (sub.pricePerLeaderMinor === null || !sub.plan) return null;
  try {
    return priceOffer({
      leaders: sub.maxLeaders ?? Math.max(leadersUsed, 1),
      agents: null,
      plan: sub.plan,
      price: { mode: 'per_leader', rateMinor: sub.pricePerLeaderMinor },
      bulk: null,
    }).totalMinor;
  } catch {
    return null;
  }
}

/** **One row** (AC-4), from the KPM, its company, its leaders used, its Owner and its own today. Pure. */
export function rowOf(
  kpm: Pick<KpmDocument, '_id' | 'code' | 'branchName' | 'companyId' | 'status' | 'subscription'>,
  companyName: string,
  leadersUsed: number,
  owner: { fullName: string; phone: string | null } | null,
  today: string,
): BillingKpmRow {
  const sub = kpm.subscription ?? null;
  const trial = sub?.trial === true;
  const maxLeaders = sub?.maxLeaders ?? null;
  const tier = tierFor(Math.max(maxLeaders ?? leadersUsed, 1));
  const rateMinor = trial ? null : sub?.pricePerLeaderMinor ?? null;
  const plan = trial ? null : sub?.plan ?? null;
  const periodTotalMinor = periodTotalOf(sub, leadersUsed);
  const months = plan ? SUBSCRIPTION_PLAN_MONTHS[plan] : null;
  const state = subscriptionStateOn(sub, today);
  const endDate = sub?.endDate ?? null;

  let attention: BillingAttention | null = null;
  if (kpm.status === 'suspended') attention = 'suspended';
  else if (state === 'ended' || state === 'ended_kept_active') attention = 'ended';
  else if (maxLeaders !== null && leadersUsed > maxLeaders) attention = 'over';
  else if (trial && state === 'active') attention = 'trial';
  else if (endDate && state === 'active' && endDate <= addOfficeDays(today, BILLING.ENDING_SOON_DAYS)) attention = 'ending_soon';

  return {
    kpmId: String(kpm._id),
    code: kpm.code,
    branch: kpm.branchName,
    company: { id: kpm.companyId, name: companyName },
    kpmStatus: kpm.status === 'suspended' ? 'suspended' : 'active',
    owner,
    leadersUsed,
    maxLeaders,
    tier: { code: tier.code, minLeaders: tier.minLeaders, maxLeaders: tier.maxLeaders },
    rateMinor,
    customPrice: rateMinor !== null && rateMinor !== tier.offerMinor,
    plan,
    trial,
    startDate: sub?.startDate ?? null,
    endDate,
    perMonthMinor: periodTotalMinor !== null && months ? halfUp(periodTotalMinor / 100, months) * 100 : null,
    periodTotalMinor,
    graceEndsOn: state === 'ended' && endDate ? graceEndsOn(endDate) : null,
    attention,
    needsAction: attention !== null && NEEDS_ACTION.has(attention),
    agents: sub?.agents ?? null,
    bulkDiscount: sub?.bulkDiscount ?? null,
    note: sub?.note ?? null,
  };
}

/** A paying row: a priced, running period in a KPM that is not suspended — what *Pendapatan per bulan* sums. */
const paying = (r: BillingKpmRow) => r.kpmStatus === 'active' && !r.trial && r.periodTotalMinor !== null
  && r.perMonthMinor !== null && r.attention !== 'ended';

/** The leaders a paying row is billed for: its package's, else the leaders used. */
const billed = (r: BillingKpmRow) => r.maxLeaders ?? r.leadersUsed;

/** **The navy summary**, over every row. Pure. */
export function summaryOf(rows: readonly BillingKpmRow[]): BillingSummary {
  const live = rows.filter(paying);
  return {
    monthlyRevenueMinor: live.reduce((sum, r) => sum + (r.perMonthMinor ?? 0), 0),
    payingKpms: live.length,
    leadersBilled: live.reduce((sum, r) => sum + billed(r), 0),
    endingSoon: rows.filter((r) => r.attention === 'trial' || r.attention === 'ending_soon').length,
    needsAction: rows.filter((r) => r.needsAction).length,
    kpms: rows.length,
  };
}

/** **The *Total* row**, over the rows shown. Pure. */
export function totalOf(rows: readonly BillingKpmRow[]): BillingTotal {
  const live = rows.filter(paying);
  const leaders = live.reduce((sum, r) => sum + billed(r), 0);
  const weighted = live.reduce((sum, r) => sum + (r.rateMinor ?? 0) / 100 * billed(r), 0);
  return {
    kpms: rows.length,
    leadersUsed: rows.reduce((sum, r) => sum + r.leadersUsed, 0),
    weightedRateMinor: leaders ? halfUp(weighted, leaders) * 100 : null,
    perMonthMinor: live.reduce((sum, r) => sum + (r.perMonthMinor ?? 0), 0),
    periodTotalMinor: live.reduce((sum, r) => sum + (r.periodTotalMinor ?? 0), 0),
    needsAction: rows.filter((r) => r.needsAction).length,
  };
}
