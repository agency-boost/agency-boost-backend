import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { DateTime } from 'luxon';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, InvalidRequestException, NotFoundException, PermissionDeniedException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { DEFAULT_TENANT_TIMEZONE, type SubscriptionPlan } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { countLeadersUsedPerOffice } from '@/modules/org/leader-limit';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { can } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { subscriptionStateOf, type SubscriptionState } from '@/modules/tenants/subscription';
import { User, UserDocument } from '@/modules/users/user.schema';
import type { BillingKpmSort, SendQuoteDto } from './billing.dto';
import { BILLING_REFUSALS } from './billing.messages';
import { priceQuote, QuoteInputError, tierFor, type ManualDiscount, type QuotePricing } from './price-quote';

/** One KPM on `/admin/billing` (ADR-0211 §3): counts and codes, no member named. */
export interface BillingKpmRow {
  kpmId: string;
  code: string;
  branch: string;
  company: { id: string; name: string };
  /** *Leader*: ADR-0113's one count, the active members on a leader rung. */
  leadersUsed: number;
  /** *Tingkat*: the price tier those leaders fall in (ADR-0111's table; under one leader, the first). */
  tier: { code: string; minLeaders: number; maxLeaders: number | null };
  /** *Paket*: `six_months`, `annual`, or `null` for none. */
  plan: SubscriptionPlan | null;
  /** *Perpanjangan*: the subscription's end date, the last day the office is served (ADR-0211 §2); `null` for none. */
  renewalDate: string | null;
  /**
   * *Status*: `active` (*Aktif*), `ended` (*Berakhir*), `ended_kept_active` (*Berakhir — tetap aktif*) or `none` (*Belum
   * ada langganan*) — the office's today against its end date, the rule `ContextResolver` refuses by.
   */
  status: SubscriptionState;
}

/** What a sent quote answers: who received it, and the server's figures. */
export interface QuoteSentView {
  kpmId: string;
  recipient: { fullName: string };
  pricing: Omit<QuotePricing, 'tier'> & { tierCode: string };
}

const STATUS_ORDER: Readonly<Record<SubscriptionState, number>> = { active: 0, ended_kept_active: 1, ended: 2, none: 3 };
const PLAN_ORDER = (plan: SubscriptionPlan | null) => (plan === 'six_months' ? 0 : plan === 'annual' ? 1 : 2);

/** A real calendar date in `YYYY-MM-DD`: `2026-02-30` has the shape and is no day. */
const isOfficeDate = (value: string) => DateTime.fromFormat(value, 'yyyy-MM-dd', { zone: 'utc' }).isValid;

/**
 * **Billing per KPM** (ADR-0211; P19.4-T3 AC-10): the list of KPMs with their leaders, tier, plan and renewal, and a
 * quote sent to one KPM's Owner.
 *
 * Platform-level, as `TenantService` is: the KPM rows and the companies are the platform's own collections, read here
 * with no tenant to scope to, and *Leaders used* is counted through the membership repository's named unscoped method
 * (invariant §1). The permission check opens every method, so nothing is read before it.
 *
 * **A quote is still not stored** (ADR-0211 §5, ADR-0111 §2): no collection is written but the Owner's notification
 * row and the audit entries.
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
    private readonly notifications: NotificationService,
  ) {}

  private require(ctx: RequestContext, permission: 'billing:read_prices' | 'billing:send_quote'): void {
    if (!can(ctx, permission)) throw new PermissionDeniedException(permission);
  }

  /** **`GET /admin/billing/kpms`** (ADR-0211 §3): every live KPM, filterable by company, sorted by a column. */
  async list(
    ctx: RequestContext,
    query: { companyId?: string; sort?: BillingKpmSort; dir?: 'asc' | 'desc' } = {},
  ): Promise<BillingKpmRow[]> {
    this.require(ctx, 'billing:read_prices');
    const kpms = await this.kpms
      .find({ deletedAt: null, ...(query.companyId ? { companyId: query.companyId } : {}) })
      .exec();
    if (kpms.length === 0) return [];
    const ids = kpms.map((k) => String(k._id));
    const [companies, leaders] = await Promise.all([
      this.companies.find({ _id: { $in: [...new Set(kpms.map((k) => k.companyId))] } }, { name: 1 }).exec(),
      countLeadersUsedPerOffice(this.memberships, ctx, ids),
    ]);
    const companyName = new Map(companies.map((c) => [String(c._id), c.name]));

    const rows = kpms.map((kpm): BillingKpmRow => {
      const leadersUsed = leaders.get(String(kpm._id)) ?? 0;
      const tier = tierFor(Math.max(leadersUsed, 1));
      return {
        kpmId: String(kpm._id),
        code: kpm.code,
        branch: kpm.branchName,
        company: { id: kpm.companyId, name: companyName.get(kpm.companyId) ?? '' },
        leadersUsed,
        tier: { code: tier.code, minLeaders: tier.minLeaders, maxLeaders: tier.maxLeaders },
        plan: kpm.subscription?.plan ?? null,
        renewalDate: kpm.subscription?.endDate ?? null,
        status: subscriptionStateOf(kpm, this.clock),
      };
    });
    return sortRows(rows, query.sort ?? 'kpm', query.dir ?? 'asc');
  }

  /**
   * **`POST /admin/tenants/:kpmId/quote`** (ADR-0211 §5): price the quote on the server, send it to the KPM's Owner by
   * email and in the app, and audit it in the platform's log and the KPM's.
   *
   * - **Every figure is computed here** from the tier table and the inputs; the body carries none.
   * - **The Owner, and nobody else.** No Owner, an account gone or deactivated, or an address not verified (ADR-0190 §4)
   *   is `409 BILLING_QUOTE_NO_OWNER`, before anything is sent or recorded.
   * - **Not stored**: no quote record, no number, no list (ADR-0111 §2 stands).
   */
  async sendQuote(ctx: RequestContext, kpmId: string, input: SendQuoteDto): Promise<QuoteSentView> {
    this.require(ctx, 'billing:send_quote');
    if (!isOfficeDate(input.startDate)) {
      throw new InvalidRequestException(BILLING_REFUSALS.VALIDATION_FAILED.date, { field: 'startDate' });
    }
    if (!isOfficeDate(input.endDate)) {
      throw new InvalidRequestException(BILLING_REFUSALS.VALIDATION_FAILED.date, { field: 'endDate' });
    }
    if (input.endDate < input.startDate) {
      throw new InvalidRequestException(BILLING_REFUSALS.VALIDATION_FAILED.endBeforeStart, { field: 'endDate' });
    }
    const pic = input.pic.trim();
    const salesBy = input.salesBy.trim();
    if (!pic || !salesBy) {
      throw new InvalidRequestException(BILLING_REFUSALS.VALIDATION_FAILED.name, { field: pic ? 'salesBy' : 'pic' });
    }
    const pricing = this.price(input);

    const kpm = isValidObjectId(kpmId) ? await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec() : null;
    if (!kpm) throw new NotFoundException('KPM');

    const owner = kpm.ownerUserId && isValidObjectId(kpm.ownerUserId)
      ? await this.users.findOne({ _id: kpm.ownerUserId, deletedAt: null }).exec()
      : null;
    if (!owner || owner.status === 'deactivated') throw this.noOwner(kpmId, 'no_owner');
    if (!owner.emailVerifiedAt) throw this.noOwner(kpmId, 'unverified');

    const office = `KPM ${kpm.code} · ${kpm.branchName}`;
    const tierRange = pricing.tier.maxLeaders === null
      ? `${pricing.tier.minLeaders}+` : `${pricing.tier.minLeaders}–${pricing.tier.maxLeaders}`;
    const kctx = RequestContext.superAdminInTenant(ctx.auditActors.actorUserId, kpmId);
    const ownerMembership = await this.memberships.findOne(kctx, { userId: String(owner._id), status: 'active' });

    // Told first, then recorded: a send that throws records nothing it did not do.
    await this.notifications.send({
      userId: String(owner._id),
      kpmId,
      ...(ownerMembership ? { membershipId: String(ownerMembership._id) } : {}),
      templateId: NotificationTemplate.BILLING_QUOTE_RECEIVED,
      payload: {
        fullName: owner.fullName,
        office,
        kpmCode: kpm.code,
        pic,
        salesBy,
        startDate: input.startDate,
        endDate: input.endDate,
        generatedOn: this.clock.localDateFor(kpm.timezone ?? DEFAULT_TENANT_TIMEZONE),
        plan: pricing.plan,
        tierRange,
        customPricing: pricing.tier.customPricing,
        leaders: pricing.leaders,
        standardMinor: pricing.standardMinor,
        offerMinor: pricing.offerMinor,
        annualDiscountMinor: pricing.annualDiscountMinor,
        manualDiscountMinor: pricing.manualDiscountMinor,
        finalMinor: pricing.finalMinor,
        monthlyTotalMinor: pricing.monthlyTotalMinor,
        periodTotalMinor: pricing.periodTotalMinor,
      },
    });

    const entry = {
      action: 'billing.quote_sent',
      targetCollection: 'kpms',
      targetId: kpmId,
      after: {
        recipientUserId: String(owner._id),
        leaders: pricing.leaders,
        plan: pricing.plan,
        tierCode: pricing.tier.code,
        rateMinor: pricing.finalMinor,
        totalMinor: pricing.periodTotalMinor,
        discount: input.discount
          ? { ...this.discountOf(input), perLeaderMinor: pricing.manualDiscountMinor }
          : null,
        startDate: input.startDate,
        endDate: input.endDate,
      },
    };
    // The platform's log (the Super Admin's own scope), and the KPM's, so its Owner reads it in theirs (ADR-0211 §5).
    await this.audit.record(ctx, entry);
    await this.audit.record(kctx, entry);

    const { tier, ...figures } = pricing;
    return { kpmId, recipient: { fullName: owner.fullName }, pricing: { ...figures, tierCode: tier.code } };
  }

  /** The inputs, priced; a bound the browser would refuse is a `400` naming its field. */
  private price(input: SendQuoteDto): QuotePricing {
    try {
      return priceQuote({ leaders: input.leaders, plan: input.plan, discount: input.discount ? this.discountOf(input) : null });
    } catch (err) {
      if (!(err instanceof QuoteInputError)) throw err;
      const sentence = err.field === 'leaders' ? BILLING_REFUSALS.VALIDATION_FAILED.leaders
        : err.field === 'discount.percent' ? BILLING_REFUSALS.VALIDATION_FAILED.percent
          : BILLING_REFUSALS.VALIDATION_FAILED.amount;
      throw new InvalidRequestException(sentence, { field: err.field });
    }
  }

  private discountOf(input: SendQuoteDto): ManualDiscount {
    const d = input.discount!;
    return d.type === 'percent'
      ? { type: 'percent', percent: d.percent ?? '' }
      : { type: 'flat', amountMinor: d.amountMinor ?? Number.NaN };
  }

  private noOwner(kpmId: string, reason: 'no_owner' | 'unverified'): DomainException {
    return new DomainException(
      ErrorCode.BILLING_QUOTE_NO_OWNER,
      reason === 'no_owner' ? BILLING_REFUSALS.BILLING_QUOTE_NO_OWNER.noOwner : BILLING_REFUSALS.BILLING_QUOTE_NO_OWNER.unverified,
      HttpStatus.CONFLICT,
      { kpmId, reason },
    );
  }
}

/** The list in a column's order, the code breaking ties, an empty cell last whichever way. */
function sortRows(rows: BillingKpmRow[], sort: BillingKpmSort, dir: 'asc' | 'desc'): BillingKpmRow[] {
  const sign = dir === 'desc' ? -1 : 1;
  const byCode = (a: BillingKpmRow, b: BillingKpmRow) => a.code.localeCompare(b.code) || a.branch.localeCompare(b.branch);
  const compare = (a: BillingKpmRow, b: BillingKpmRow): number => {
    switch (sort) {
      case 'company': return sign * a.company.name.localeCompare(b.company.name);
      case 'leaders':
      case 'tier': return sign * (a.leadersUsed - b.leadersUsed);
      case 'plan': return sign * (PLAN_ORDER(a.plan) - PLAN_ORDER(b.plan));
      case 'renewal':
        if (a.renewalDate === b.renewalDate) return 0;
        if (a.renewalDate === null) return 1;
        if (b.renewalDate === null) return -1;
        return sign * a.renewalDate.localeCompare(b.renewalDate);
      case 'status': return sign * (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
      default: return sign * byCode(a, b);
    }
  };
  return [...rows].sort((a, b) => compare(a, b) || byCode(a, b));
}
