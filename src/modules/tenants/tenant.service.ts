import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, InvalidRequestException, NotFoundException, PermissionDeniedException,
} from '@/common/errors/domain.exception';
import type { Reader } from '@/common/i18n/reader';
import { render, type Sentence } from '@/common/i18n/sentence';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { User, UserDocument } from '@/modules/users/user.schema';
import { refuseUnverifiedAddress } from '@/modules/auth/verified-address';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { initialsOf } from '@/modules/org/directory.service';
import { Company, CompanyDocument } from './company.schema';
import { KpmRequest, KpmRequestDocument } from './kpm-request.schema';
import { OrgLevelService } from './org-level.service';
import { ProvisioningService, type StartFrom } from '@/modules/config/provisioning.service';
import { NamedTemplateService } from '@/modules/config/named-template.service';
import { ProductService } from '@/modules/products/product.service';
import { CampaignService } from '@/modules/campaigns/campaign.service';
import {
  DEFAULT_KPM_SETTINGS, Kpm, KpmDocument, type KpmPendingOwner, type KpmSubscription,
} from './kpm.schema';
import { OwnerInvitations } from './owner-invitations';
import { countLeadersUsedPerOffice } from '@/modules/org/leader-limit';
import { invitationStateOf, type InvitationState } from '@/modules/org/invitation-state';
import { INSURERS_ONLY, isTemplateLibrary } from './template-library';
import {
  subscriptionStateOf, validateSubscription, type SubscriptionInput, type SubscriptionState,
} from './subscription';
import { TENANTS_MESSAGES, TENANTS_REFUSALS } from './tenants.messages';

export interface CreateKpmInput {
  companyId: string;
  code: string;
  branchName: string;
  address?: string;
  contactPhone?: string;
  /**
   * Accepted for the single legal value only (ADR-0016). `locale` and `currency` used to
   * sit beside it and were unreachable: `CreateKpmDto` declares neither and
   * `forbidNonWhitelisted` would refuse them, so both could only ever be the company
   * default. They are gone — a parameter no caller can supply is not an option, it is a
   * suggestion that one exists.
   */
  timezone?: string;
  /**
   * **What the office starts from** (ADR-0115 §4): one of the company's templates, the AgencyBoost
   * defaults, or *Empty*. Absent, the company's default template — what approving a KPM request uses.
   */
  startFrom?: StartFrom;
  /**
   * ***Pemilik KPM*** (ADR-0212 §1; P19.4-T3 AC-6): the Owner, made with the KPM as one unit. Absent (*"Lewati, nanti
   * saja"*), a KPM with no Owner, which *Perlu perhatian Anda* lists.
   */
  owner?: OwnerInput;
  /** *"Kirim undangan … sekarang"*: on unless `false` (ADR-0212 §2). */
  sendInvitation?: boolean;
}

/** *Pemilik KPM* as *KPM baru* and *Ganti pemilik* name them (ADR-0212 §1): a name and a WhatsApp number, required. */
export interface OwnerInput {
  fullName: string;
  /** `+62…`, as `phoneFromBody` normalised it. Stored and shown; never a channel (ADR-0212 §4). */
  phone: string;
  email?: string;
  agentCode?: string;
}

/**
 * **Who the named Owner turns out to be** (ADR-0212 §2, §3), settled before anything is written: an account that exists
 * (checked as ADR-0191 §5 checks one), an account to make for an email nobody holds, or — with no email — a person who
 * waits, named, with no account.
 */
type OwnerPlan =
  | { kind: 'existing'; user: UserDocument; phone: string }
  | { kind: 'new'; fullName: string; phone: string; email: string; agentCode: string }
  | { kind: 'pending'; pending: KpmPendingOwner };

/** What `POST /admin/tenants` answers: the KPM, and whether its Owner was sent an invitation (ADR-0212 §2). */
export interface KpmCreated extends KpmView {
  /** `true` once the invitation's email is on its way; `false` with no Owner, no email, unticked, or signed in already. */
  invitationSent: boolean;
}

/**
 * Tenant provisioning. A KPM comes into existence only here, and only for a Super
 * Admin — the single hard requirement in ADR-0005.
 *
 * These are platform-level operations, so they do not go through the tenant-scoped
 * repository: there is no tenant yet to scope to. The permission check is therefore
 * the only gate, which is why it is explicit at the top of every method.
 */

/**
 * A KPM as the console reads it: the document, plus the two joins no screen can make for
 * itself.
 *
 * The endpoints used to return the hydrated Mongoose document, which is why
 * `/admin/tenants` rendered a 24-character hex string in a column headed **Owner**. The
 * fix has to be a plain object rather than a field attached to the document: Mongoose
 * runs strict by default (`baseSchemaOptions`), so `kpm.ownerName = …` never reaches
 * `_doc` and never reaches the wire — while a service-level test reading the same object
 * back would pass. That is the shape of defect `.claude/rules/backend-then-frontend.md`
 * exists to prevent, so this is pinned at the HTTP layer too.
 */
export interface KpmView {
  _id: string;
  companyId: string;
  /** The company's name. The list used to join this client-side and fall back to the id. */
  companyName: string;
  code: string;
  branchName: string;
  address: string | null;
  contactPhone: string | null;
  ownerUserId: string | null;
  /** Null when nobody owns the office — which the screens already render as a call to act. */
  ownerName: string | null;
  ownerEmail: string | null;
  timezone: string;
  locale: string;
  currency: string;
  /** 1–12. Stored and shown now; read by the period computations in Phase 18 (P4-T5). */
  fiscalYearStartMonth: number;
  settings: Record<string, number>;
  status: 'active' | 'suspended' | 'archived';
  suspendedAt: string | null;
  suspendedReason: string | null;
  createdAt: string;
}

/**
 * An office as **the Super Admin's** offices list and detail read it (ADR-0112 §2, P13.2-T3 AC-3):
 * the office, its subscription, *Leaders used* (ADR-0113's one count) and where it stands against its
 * end date, computed on the server from the office's today.
 *
 * A separate shape rather than three more fields on `KpmView`, because `KpmView` is also what the
 * Owner and the Admin read as *Branch info*, and the subscription is the platform's business with the
 * office, not a setting of it: nothing grants a tenant role a read of it.
 */
export interface KpmAdminView extends KpmView {
  subscription: KpmSubscription | null;
  leadersUsed: number;
  subscriptionState: SubscriptionState;
  /**
   * **Where the Owner stands** (ADR-0212 §2, §3; P19.4-T3 AC-6, AC-8): `none` — no Owner and none named; `not_invited`
   * — *Belum diundang*: an Owner never sent an invitation, or one named with no email (`pendingOwner`); `invited` —
   * *Diundang*: the latest invitation sent (`memberships.invitedAt`) and the account never signed in; `active` —
   * *Aktif*: the Owner's account has signed in (`users.lastLoginAt`).
   */
  ownerState: OwnerState;
  /** The Owner's WhatsApp number — the account's `phone`, or the pending Owner's — a number to call, never a channel. */
  ownerPhone: string | null;
  /** When the Owner's latest invitation went (`memberships.invitedAt`), or `null`. */
  ownerInvitedAt: string | null;
  /** The Owner named with no email, waiting (`kpms.pendingOwner`), or `null`. The Super Admin's alone. */
  pendingOwner: KpmPendingOwner | null;
  /** Live memberships — active and pending — the Owner's own included. */
  memberCount: number;
  /** The same, the Owner's own left out: *"Belum ada anggota"* while it is 0 (SA R5). */
  membersBesidesOwner: number;
}

/** ***Ringkasan*'s people** (P19.4-T3 AC-9): the Admins, read-only, and the live members by rung. The Super Admin's. */
export interface KpmPeople {
  admins: { fullName: string; state: 'active' | 'invited' | 'not_invited' }[];
  membersByRole: { code: string; label: string; count: number }[];
}

/** The Owner's state as the console reads it (ADR-0212 §2). */
export type OwnerState = 'none' | 'not_invited' | 'invited' | 'active';

/**
 * ADR-0212 §2's state as the console spells it: `invitationStateOf`'s (`org/invitation-state.ts`, the one rule, ADR-0248
 * §4), with *signed in* written `active`, as `ownerState` and `KpmPeople.admins[].state` have always carried it.
 */
const consoleState = (state: InvitationState): 'active' | 'invited' | 'not_invited' =>
  state === 'signed_in' ? 'active' : state;

/** The fields `ownerFacts` adds to an office's admin view. */
type OwnerFacts = Pick<
  KpmAdminView, 'ownerState' | 'ownerPhone' | 'ownerInvitedAt' | 'pendingOwner' | 'memberCount' | 'membersBesidesOwner'
>;

/** How many accounts *Ganti Owner*'s search answers (P19-T3 AC-5): a search, never the platform's users. */
const ACCOUNT_SEARCH_LIMIT = 20;

/**
 * **What an office is made with, and what is counted apart**, by collection — not its *records* (P19-T3 AC-7): the configuration
 * provisioning writes with it (`ProvisioningService.provision`), its product shelf and carrier rules, the memberships
 * counted as *members*, and the audit log, which records the office's own creation.
 */
const NOT_OFFICE_DATA = new Set([
  'memberships', 'auditLog',
  'activityCategories', 'activityTypes', 'activityBindings', 'leadStatuses', 'ratioDefinitions', 'configSnapshots',
  'trainingCategories', 'trainingSkills', 'trainingModules', 'activationTemplates', 'eventTypes', 'capabilityCatalogs',
  'kpmProductConfigs', 'qualificationRules',
]);

/** An office an account owns or belongs to, as *Ganti Owner*'s picker shows it (P19-T3 AC-5). */
export interface AccountOffice {
  kpmId: string;
  code: string;
  branchName: string;
  companyName: string;
  isOwner: boolean;
  /** Their membership's state there; `null` for an office they own with no membership in it. */
  membershipStatus: 'active' | 'pending' | null;
}

/** One account *Ganti Owner* may choose (P19-T3 AC-5). */
export interface AccountChoice {
  userId: string;
  fullName: string;
  email: string;
  phone: string | null;
  companyId: string | null;
  companyName: string | null;
  /** An Owner needs one: the office makes them its root AB under their insurer's code. */
  hasAgentCode: boolean;
  /** ADR-0190 §4: only a verified address may own an office. */
  emailVerified: boolean;
  status: 'invited' | 'active' | 'deactivated';
  offices: AccountOffice[];
}

/** One person who administers an office, seen from the platform. */
export interface PlatformAdminRow {
  membershipId: string;
  fullName: string;
  email: string;
  initials: string;
  kpmId: string;
  kpmLabel: string;
  isOwner: boolean;
  isAdmin: boolean;
  /** When admin access was granted. Null for an Owner, whose rights come with the office. */
  grantedAt: string | null;
}

/** One row of the console's `Needs your attention` queue (`Superadmin.html:232-273`). */
export interface AttentionItem {
  /** The chip: `KPM owner`, `KPM request`, `Role ladder`, `Product`. */
  tag: string;
  /** Drives the chip's colour. `structural` is the platform's own to fix. */
  severity: 'structural' | 'approval' | 'template';
  title: string;
  detail: string;
  /** Where the reader goes to act on it. */
  href: string;
  actionLabel: string;
}

export interface CompanyCard {
  companyId: string;
  name: string;
  initials: string;
  kpmCount: number;
  memberCount: number;
  /** The company's active rungs, junior first — labels only. Empty if none is defined. */
  ladder: string[];
}

export interface PlatformOverview {
  tiles: { companies: number; kpms: number; totalMembers: number; agencyBuilders: number };
  attention: AttentionItem[];
  companies: CompanyCard[];
}

@Injectable()
export class TenantService {
  constructor(
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(KpmRequest.name) private readonly kpmRequests: Model<KpmRequestDocument>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly hierarchy: HierarchyService,
    private readonly memberships: MembershipRepository,
    // Read-only here, and one-directional: OrgLevelService knows nothing about tenants,
    // so there is no cycle to break.
    private readonly orgLevels: OrgLevelService,
    // Same shape: it copies a company template into a brand-new office and knows nothing
    // about tenancy beyond the id it is handed.
    private readonly provisioning: ProvisioningService,
    // Same again: the company's starting catalog (P5-T4). It takes a companyId and nothing else.
    private readonly products: ProductService,
    // And its carrier rules (P5-T7).
    private readonly campaigns: CampaignService,
    /*
     * A company's named templates (ADR-0115): the Template library a new company copies its ladder, products and
     * carrier rules from, and the carrier rules' template. Since ADR-0213 §3 a new company is made with **no template**,
     * and since ADR-0210 with no company-level playbook: the playbook is a template section.
     */
    private readonly namedTemplates: NamedTemplateService,
    /*
     * **The Owner's invitation** (ADR-0212 §2; P19.4-T3): the one-time link by email, its limit and its stamp. Optional so
     * the specs that build this service by hand for something else need not wire the mail; the application always gives
     * it, and an Owner named with an email is refused without it rather than left uninvited unseen.
     */
    @Optional() @Inject(OwnerInvitations) private readonly invitations: OwnerInvitations | null = null,
  ) {}

  private readonly logger = new Logger(TenantService.name);

  private require(ctx: RequestContext, permission: Parameters<typeof can>[1]): void {
    // The shared refusal, in both languages: *You do not have permission to perform this action.*
    if (!can(ctx, permission)) throw new PermissionDeniedException(permission);
  }

  /**
   * The document, plus the owner's name and the company's, resolved in **two** queries
   * however many offices there are.
   *
   * Copied from `kpm-request.service.ts`'s `rows()`, deliberately: one `$in` per
   * collection, a `Map` by id, and a fallback for the row whose user has gone. Neither
   * lookup filters `deletedAt` — a soft-deleted owner still has to render, or the office
   * silently loses the only name on the screen. That differs from `resolveOwner`, which
   * does filter, because that is a write path and this is a display one.
   */
  private async toViews(kpms: KpmDocument[], reader: Reader, ownersRead?: Map<string, UserDocument>): Promise<KpmView[]> {
    if (kpms.length === 0) return [];

    const [byUser, companies] = await Promise.all([
      ownersRead ? Promise.resolve(ownersRead) : this.ownerAccounts(kpms),
      this.companies.find({ _id: { $in: [...new Set(kpms.map((k) => k.companyId))] } }).exec(),
    ]);
    const byCompany = new Map(companies.map((c) => [String(c._id), c]));

    return kpms.map((k) => {
      const owner = k.ownerUserId ? byUser.get(k.ownerUserId) : undefined;
      return {
        _id: String(k._id),
        companyId: k.companyId,
        companyName: byCompany.get(k.companyId)?.name ?? render(TENANTS_MESSAGES.unknownCompany, reader),
        code: k.code,
        branchName: k.branchName,
        address: k.address ?? null,
        contactPhone: k.contactPhone ?? null,
        ownerUserId: k.ownerUserId ?? null,
        // An owner whose account has gone still gets a row: 'Unknown' says the office is
        // owned and the account is missing, which is a different problem from unowned. In the reader's language.
        ownerName: k.ownerUserId ? (owner?.fullName ?? render(TENANTS_MESSAGES.unknownPerson, reader)) : null,
        ownerEmail: k.ownerUserId ? (owner?.email ?? null) : null,
        timezone: k.timezone,
        locale: k.locale,
        currency: k.currency,
        fiscalYearStartMonth: k.fiscalYearStartMonth ?? 1,
        settings: { ...k.settings } as unknown as Record<string, number>,
        status: k.status,
        suspendedAt: k.suspendedAt ? k.suspendedAt.toISOString() : null,
        suspendedReason: k.suspendedReason ?? null,
        createdAt: (k as unknown as { createdAt: Date }).createdAt.toISOString(),
      };
    });
  }

  /** The offices' Owners' accounts, by id, in one query — a soft-deleted one too, so a row still names its Owner. */
  private async ownerAccounts(kpms: readonly KpmDocument[]): Promise<Map<string, UserDocument>> {
    const ownerIds = [...new Set(kpms.map((k) => k.ownerUserId).filter((id): id is string => Boolean(id)))];
    const owners = ownerIds.length > 0 ? await this.users.find({ _id: { $in: ownerIds } }).exec() : [];
    return new Map(owners.map((u) => [String(u._id), u]));
  }

  private async toView(kpm: KpmDocument, reader: Reader): Promise<KpmView> {
    return (await this.toViews([kpm], reader))[0];
  }

  /**
   * The Super Admin's rows: the views above, plus each office's subscription, *Leaders used* and its
   * state (P13.2-T3 AC-3).
   *
   * *Leaders used* for every office in **one** grouped count, through the membership repository's
   * named unscoped method (invariant §1) — the console reads it for offices it is not in. The state is
   * the office's today against its end date, through the clock port: the same rule
   * `ContextResolver` refuses by, so the list and the refusal cannot disagree.
   */
  private async toAdminViews(ctx: RequestContext, kpms: KpmDocument[]): Promise<KpmAdminView[]> {
    // The Owners' accounts once, for their names and for their state (P3.1-T14: one query, not one per office).
    const owners = await this.ownerAccounts(kpms);
    const [views, leaders, facts] = await Promise.all([
      this.toViews(kpms, ctx.reader, owners),
      countLeadersUsedPerOffice(this.memberships, ctx, kpms.map((k) => String(k._id))),
      this.ownerFacts(ctx, kpms, owners),
    ]);
    return views.map((view, i) => ({
      ...view,
      subscription: kpms[i].subscription ?? null,
      leadersUsed: leaders.get(view._id) ?? 0,
      subscriptionState: subscriptionStateOf(kpms[i], this.clock),
      ...(facts.get(view._id) as OwnerFacts),
    }));
  }

  /**
   * **Each office's Owner state and member counts** (ADR-0212 §2, §3; SA R5; P19.4-T3 AC-6, AC-8), in three reads
   * whatever the number of offices: the Owners' accounts (`lastLoginAt`, `phone`), their memberships in those offices
   * (`invitedAt`), and the live memberships per office — through the membership repository's named unscoped methods
   * (invariant §1), read by the Super Admin who is in none. Counts and the Owner's own row; never a member's.
   */
  private async ownerFacts(
    ctx: RequestContext, kpms: readonly KpmDocument[], ownersRead?: Map<string, UserDocument>,
  ): Promise<Map<string, OwnerFacts>> {
    const kpmIds = kpms.map((k) => String(k._id));
    const ownerIds = [...new Set(kpms.map((k) => k.ownerUserId).filter((id): id is string => Boolean(id)))];
    const [account, ownerRows, live] = await Promise.all([
      ownersRead ? Promise.resolve(ownersRead) : this.ownerAccounts(kpms),
      ownerIds.length > 0
        ? this.memberships.findAcrossAllTenants(ctx, {
          userId: { $in: ownerIds }, kpmId: { $in: kpmIds }, status: { $in: ['active', 'pending'] },
        })
        : Promise.resolve([]),
      this.memberships.countPerOfficeAcrossTenants(ctx, kpmIds, { status: { $in: ['active', 'pending'] } }),
    ]);
    return new Map(kpms.map((kpm) => {
      const id = String(kpm._id);
      const user = kpm.ownerUserId ? account.get(kpm.ownerUserId) : undefined;
      const row = kpm.ownerUserId ? ownerRows.find((m) => m.kpmId === id && m.userId === kpm.ownerUserId) : undefined;
      const invitedAt = row?.invitedAt ?? null;
      const ownerState: OwnerState = kpm.ownerUserId
        ? consoleState(invitationStateOf(user?.lastLoginAt, invitedAt))
        : (kpm.pendingOwner ? 'not_invited' : 'none');
      const memberCount = live.get(id) ?? 0;
      return [id, {
        ownerState,
        ownerPhone: user?.phone ?? kpm.pendingOwner?.phone ?? null,
        ownerInvitedAt: invitedAt ? invitedAt.toISOString() : null,
        pendingOwner: kpm.pendingOwner ?? null,
        memberCount,
        membersBesidesOwner: Math.max(0, memberCount - (row ? 1 : 0)),
      }];
    }));
  }

  private async toAdminView(ctx: RequestContext, kpm: KpmDocument): Promise<KpmAdminView> {
    return (await this.toAdminViews(ctx, [kpm]))[0];
  }

  /**
   * Every company on the platform, by name.
   *
   * Here rather than in the controller because its sibling `createCompany` has to be —
   * a duplicate slug needs a domain error, and a controller reaching into a Mongoose
   * model is the shape `backend/CLAUDE.md` calls a defect even where the query is right.
   */
  async listCompanies(ctx: RequestContext): Promise<(Record<string, unknown> & { startedBlank: boolean })[]> {
    this.require(ctx, 'company:crud');
    const rows = await this.companies.find({ deletedAt: null }).sort({ name: 1 }).exec();
    /*
     * ***Dimulai kosong*** (P19.4-T3 AC-12; SA UI-017): a company made blank, **until its default template has one
     * published section** — Manulife's row kept the tag after its template was filled. Worked out here, once for the
     * list, so the screen holds no rule of its own.
     */
    const filled = await this.namedTemplates.withPublishedDefault(rows.map((c) => String(c._id)));
    return rows.map((c) => ({
      ...c.toObject(),
      startedBlank: !c.usesPlatformDefaults && !filled.has(String(c._id)),
    }));
  }

  /**
   * The same list, for somebody who is not signed in yet.
   *
   * A projection rather than a filter on the way out: `find(..., { name: 1 })` means a
   * field added to `companies` later cannot leak through this route by default. The one
   * above returns whole documents because its only caller is a Super Admin.
   */
  async listCompaniesForRegistration(): Promise<{ _id: string; name: string }[]> {
    const rows = await this.companies
      // **Suspended companies are not on offer.** That is what suspending one means here: no
      // new person and no new office attaches to it. Everybody already inside is untouched.
      // **Nor is the Template library** (ADR-0164 §3): it holds templates, and nobody works for it.
      .find({ deletedAt: null, status: 'active', ...INSURERS_ONLY }, { name: 1 })
      .sort({ name: 1 })
      .lean()
      .exec();
    return rows.map((c) => ({ _id: String(c._id), name: String(c.name) }));
  }

  /**
   * Create a company.
   *
   * A duplicate slug used to reach Mongo's unique index unguarded, and `E11000` is
   * neither a `DomainException` nor an `HttpException` — so it fell through the filter
   * to **500 INTERNAL_ERROR**, logged as an unhandled error. The console's own test
   * stubbed a `CONFLICT` code the API could not produce, and the Super Admin manual
   * promised *"if the slug is taken you get a message saying so"*. Three artifacts
   * agreeing with each other and none of them with the server.
   *
   * That mattered less while slugs were typed. The form derives them now, so
   * `Prudential Indonesia` and `Prudential-Indonesia` both reach `prudential-indonesia`
   * and the reader never saw the value that collided — which is why the refusal names
   * the incumbent rather than saying the slug is taken.
   *
   * **The catch is not belt-and-braces.** Two Super Admins creating the same company at
   * once both pass the pre-check; only the index stops the second, and it must arrive as
   * the same 409 the first reader would have got.
   *
   * **What it starts from** (ADR-0164 §4, amended by ADR-0213 §3): `usesPlatformDefaults` true — the default — copies
   * the Template library's ladder, products and carrier rules; false is *Empty*: the default ladder and nothing else.
   * Where there is no Template library, true gives the AgencyBoost defaults from the code, as before the library existed.
   *
   * **No template is made with it** (ADR-0213 §3, B1-8): its page opens on *"+ Template baru"* — *Kosong* or *Salin
   * dari…* any template, the built-in ones included — and the first it makes becomes its default. Until then a KPM made
   * or approved for it starts from the built-in default (`ProvisioningService.planFor`). **Nor a company-level
   * playbook** (ADR-0210 §6): the playbook is a template section, so its templates hold one when they are made or
   * copied. `playbookInTemplates` says so, for migration `0056`.
   */
  async createCompany(
    ctx: RequestContext,
    input: { name: string; slug: string; usesPlatformDefaults?: boolean },
  ): Promise<CompanyDocument> {
    this.require(ctx, 'company:crud');

    const name = input.name.trim();
    const slug = input.slug.trim().toLowerCase();

    // The same filter the partial index uses. A pre-check that ignored `deletedAt`
    // would refuse a slug the index would happily accept.
    const clash = await this.companies.findOne({ slug, deletedAt: null }).exec();
    if (clash) throw this.slugTaken(slug, clash.name);

    // Absent means true: every caller that does not care gets what they always got.
    const usesPlatformDefaults = input.usesPlatformDefaults !== false;

    /*
     * **The Template library it copies from** (ADR-0164 §4): `null` for a company started *Empty*, and where there is no
     * Template library — a database migration `0037` has not run on, which is given the AgencyBoost defaults from the
     * code, as before.
     */
    const library = usesPlatformDefaults ? await this.namedTemplates.library() : null;

    let company: CompanyDocument;
    try {
      // Always an insurer: the Template library is made by migration `0037`, and by nothing else. Its playbook lives in
      // its templates from the start (ADR-0210 §6).
      company = await this.companies.create({
        name, slug, usesPlatformDefaults, kind: 'insurer', playbookInTemplates: true,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        const winner = await this.companies.findOne({ slug, deletedAt: null }).exec();
        throw this.slugTaken(slug, winner?.name ?? 'another company');
      }
      throw err;
    }

    const companyId = String(company._id);
    if (library) {
      /*
       * **A copy of the Template library's company data** (ADR-0164 §4, ADR-0213 §3): its ladder with the leader tiers,
       * its products and its carrier rules. Copies, never links (§6): a later change to the Template reaches no company
       * that already exists. Not its Default template, and no playbook: the Super Admin makes the first template.
       */
      await this.orgLevels.copyLadderFrom(library.companyId, companyId);
      await this.products.copyFromCompany(library.companyId, companyId);
      await this.campaigns.copyRulesFromCompany(library.companyId, companyId);
      await this.namedTemplates.copyCompanyKind(ctx, 'campaign_kinds', library.companyId, companyId);
      await this.recordCompanyCreated(ctx, company, {
        usesPlatformDefaults,
        startedFrom: 'template_library',
        source: { companyId: library.companyId },
      });
      return company;
    }

    // **Every company gets a ladder, at creation.** `memberships.orgLevelId` resolves
    // against it on every join, so a company without one is an office nobody can join —
    // and nothing would say so until somebody tried. ADR-0012 §3 settles that v1 ships
    // one seeded ladder; Super Admin edits it at /admin/org-levels afterwards.
    await this.orgLevels.seedDefaultLadder(companyId);

    /*
     * **The rest is the platform's offer, and it can be declined.**
     *
     * A catalog, because a company with no products is one whose offices have nothing to sell
     * (ADR-0033); the carrier rules, because an office measured against nothing reads as an
     * office that qualifies for nothing (P5-T7, ADR-0026). Both are good defaults and neither
     * is a structural requirement, which is exactly what makes them declinable — the ladder
     * above is not, and stays.
     *
     * A company authoring its own presets from scratch gets nothing here, and its first template
     * holds nothing either, so *blank* means blank on every screen — and in every office made
     * from it (ADR-0115 §1) — rather than blank on some of them.
     */
    if (usesPlatformDefaults) {
      // No Template library to copy (ADR-0164 §4): the AgencyBoost defaults, from the code.
      await this.products.seedForCompany(companyId);
      await this.campaigns.seedForCompany(companyId);
    }

    // No first template (ADR-0213 §3): its page opens on *"+ Template baru"*, and the first it makes is its default.
    await this.recordCompanyCreated(ctx, company, {
      usesPlatformDefaults, startedFrom: usesPlatformDefaults ? 'defaults' : 'empty',
    });
    return company;
  }

  /** `company.created`, once, whichever source the company was made from. */
  private async recordCompanyCreated(
    ctx: RequestContext,
    company: CompanyDocument,
    made: {
      usesPlatformDefaults: boolean;
      /** The Template library's copy, the AgencyBoost defaults from the code (no library), or nothing. */
      startedFrom: 'template_library' | 'defaults' | 'empty';
      /** The Template library it copied from (ADR-0164 §4): its ladder, products and carrier rules. */
      source?: { companyId: string };
    },
  ): Promise<void> {
    await this.audit.record(ctx, {
      action: 'company.created',
      targetCollection: 'companies',
      targetId: String(company._id),
      // The three inherited defaults are recorded, not just the two typed fields. The
      // reason this is audited at all is that offices inherit them, and an audit row
      // that omits the thing its own justification names is not much of a record.
      after: {
        name: company.name,
        slug: company.slug,
        defaultCurrency: company.defaultCurrency,
        defaultLocale: company.defaultLocale,
        defaultTimezone: company.defaultTimezone,
        // Recorded because it decides what nine screens show for the life of the company,
        // and because "it came up empty" is otherwise unanswerable a month later.
        usesPlatformDefaults: made.usesPlatformDefaults,
        // What it was copied from (ADR-0164 §4): the Template library's template by id and name as they were.
        startedFrom: made.startedFrom,
        ...(made.source ? { source: made.source } : {}),
      },
    });
  }

  /**
   * Rename a company, or change its slug.
   *
   * **Both are labels.** Every office points at its company by id and nothing stores the slug,
   * so changing it moves no reference — unlike a config `code`, which invariant §4 makes
   * permanent precisely because things do point at it.
   *
   * The slug clash is checked the same way creation checks it, for the same reason: the partial
   * index is the only thing that actually stops a race, and its refusal has to arrive as the
   * same 409 a first reader would have seen.
   */
  async updateCompany(
    ctx: RequestContext,
    companyId: string,
    input: { name?: string; slug?: string },
  ): Promise<CompanyDocument> {
    this.require(ctx, 'company:crud');

    const company = await this.companies
      .findOne({ _id: companyId, deletedAt: null }).exec()
      // A malformed id from a URL is "not here", not a 500.
      .catch(() => null);
    if (!company) throw new NotFoundException('Company');

    const before = { name: company.name, slug: company.slug };

    if (input.slug !== undefined) {
      const slug = input.slug.trim().toLowerCase();
      if (slug !== company.slug) {
        const clash = await this.companies.findOne({ slug, deletedAt: null }).exec();
        if (clash) throw this.slugTaken(slug, clash.name);
        company.slug = slug;
      }
    }
    if (input.name !== undefined) company.name = input.name.trim();

    try {
      await company.save();
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        const winner = await this.companies.findOne({ slug: company.slug, deletedAt: null }).exec();
        throw this.slugTaken(company.slug, winner?.name ?? 'another company');
      }
      throw err;
    }

    await this.audit.record(ctx, {
      action: 'company.updated',
      targetCollection: 'companies',
      targetId: companyId,
      before,
      after: { name: company.name, slug: company.slug },
    });

    return company;
  }

  /**
   * Suspend a company, or bring it back.
   *
   * **What it does is narrow and stated rather than implied.** A suspended company disappears
   * from the list somebody registering chooses from, so no new person and no new office can
   * attach to it. It does **not** sign anybody out, suspend its offices, or hide their data:
   * those are the office's own lifecycle (`PATCH /admin/tenants/:id/status`) and collapsing the
   * two would mean one click silently locking out several thousand people.
   *
   * Soft, like everything else here (invariant §6). Nothing is deleted.
   */
  async setCompanyStatus(
    ctx: RequestContext,
    companyId: string,
    status: 'active' | 'suspended',
  ): Promise<CompanyDocument> {
    this.require(ctx, 'company:crud');

    const company = await this.companies
      .findOne({ _id: companyId, deletedAt: null }).exec()
      .catch(() => null);
    if (!company) throw new NotFoundException('Company');

    const before = company.status;
    company.status = status;
    await company.save();

    await this.audit.record(ctx, {
      action: `company.${status === 'suspended' ? 'suspended' : 'reactivated'}`,
      targetCollection: 'companies',
      targetId: companyId,
      before: { status: before },
      after: { status },
    });

    return company;
  }

  private slugTaken(slug: string, existingName: string): DomainException {
    return new DomainException(
      ErrorCode.COMPANY_SLUG_TAKEN,
      TENANTS_REFUSALS.COMPANY_SLUG_TAKEN.taken({ slug, existingName }),
      HttpStatus.CONFLICT,
      { slug, existingName },
    );
  }

  async createKpm(ctx: RequestContext, input: CreateKpmInput): Promise<KpmCreated> {
    this.require(ctx, 'kpm:create');

    const company = await this.companies.findOne({ _id: input.companyId, deletedAt: null }).exec();
    if (!company) throw new NotFoundException('Company');
    // **The Template library holds templates, not offices** (ADR-0164 §3). Named, not a 404: the Super Admin
    // chose it, and the console lists it.
    if (isTemplateLibrary(company)) {
      throw new DomainException(
        ErrorCode.COMPANY_IS_TEMPLATE_LIBRARY,
        TENANTS_REFUSALS.COMPANY_IS_TEMPLATE_LIBRARY.holdsNoOffice({ name: company.name }),
        HttpStatus.CONFLICT,
        { companyId: input.companyId },
      );
    }

    const clash = await this.codeHolder(input.companyId, input.code);
    if (clash) throw this.codeTaken(clash, company.name);

    /*
     * ***Pemilik KPM*, settled before the office row exists** (ADR-0212 §1, §2; P19.4-T3 AC-6): an account named by its
     * email is refused here as an approval refuses one (ADR-0191 §5), and a new account's agent code here, so a refused
     * Owner leaves no KPM behind.
     */
    const ownerPlan = input.owner ? await this.planOwner(input.companyId, company.name, input.owner) : null;

    /*
     * **The whole source, resolved and checked before the office row exists** (ADR-0115 §4): each
     * kind's own checks, the ratios against the taxonomy it will have and the checklist's training
     * links against its own modules. A refusal here leaves no office and no rows — there are no
     * transactions (ADR-0002), so checking first is the guarantee.
     */
    const plan = await this.provisioning.planFor(input.companyId, input.startFrom);

    let kpm: KpmDocument;
    try {
      kpm = await this.kpms.create({
        companyId: input.companyId,
        code: input.code,
        branchName: input.branchName,
        address: input.address ?? null,
        contactPhone: input.contactPhone ?? null,
        // The office inherits its company's defaults unless told otherwise.
        timezone: input.timezone ?? company.defaultTimezone,
        locale: company.defaultLocale,
        currency: company.defaultCurrency,
        settings: { ...DEFAULT_KPM_SETTINGS },
        counters: { nextMemberSeq: 1 },
        status: 'active',
        ownerUserId: null,
        startedFrom: plan.startedFrom,
        deletedAt: null,
      });
    } catch (err) {
      // Two creations of one code at once both pass the check; only the index stops the second, and it must arrive
      // as the same 409 naming the office, never a 500 (P19-T3 AC-4).
      if ((err as { code?: number }).code !== 11000) throw err;
      const winner = await this.codeHolder(input.companyId, input.code);
      if (!winner) throw err;
      throw this.codeTaken(winner, company.name);
    }

    /*
     * The office arrives with its configuration (P4-T1, ADR-0018, ADR-0115): **the chosen source
     * and nothing else** — a kind the source holds none of is empty here, and there is no fallback
     * to the platform defaults. Every office has the three cascade activity types whatever its
     * source (ADR-0115 §2), and a capability ladder — the platform's where its source has none
     * (ADR-0116). An *Empty* office has those three and the platform ladder, and nothing else.
     *
     * After the office row, not before: rows belonging to an office that failed to create would
     * be orphans nothing points at.
     */
    const provisioned = await this.provisioning.provision(String(kpm._id), plan);

    /*
     * And publish what was just copied (P4-T6), so the office's agents have something to
     * work against from the first minute rather than after somebody notices a Publish
     * button. Rendered here from the rows that were written above, so it is consistent by
     * construction.
     */
    await this.provisioning.publishInitialSnapshotFor(
      String(kpm._id),
      this.contextFor(ctx, String(kpm._id)),
    );
    // One record per kind, each from the version that kind's seed actually copied (P5-T12), or a
    // `null` version where the source held none of it — all seven since 13.2.
    kpm.seededFrom = provisioned.seededFrom;
    await kpm.save();

    await this.audit.record(ctx, {
      action: 'kpm.created',
      targetCollection: 'kpms',
      targetId: String(kpm._id),
      after: {
        code: kpm.code,
        branchName: kpm.branchName,
        companyId: kpm.companyId,
        // What it was started from, with the template's name as it was (ADR-0115 §4).
        startedFrom: plan.startedFrom,
        seededFrom: kpm.seededFrom,
        activityTypes: provisioned.activityTypes,
        cascadeTypesAdded: provisioned.cascadeAdded,
        // The source had no capability ladder, so the office was given the platform's (ADR-0116).
        capabilityLadderSupplied: provisioned.capabilityLadderSupplied,
        // *Pemilik KPM* as named (ADR-0212 §1), or `null` for *"Lewati, nanti saja"*.
        owner: ownerPlan === null ? null : {
          fullName: ownerPlan.kind === 'existing' ? ownerPlan.user.fullName
            : ownerPlan.kind === 'new' ? ownerPlan.fullName : ownerPlan.pending.fullName,
          kind: ownerPlan.kind,
        },
      },
    });

    if (ownerPlan === null) return { ...(await this.toView(kpm, ctx.reader)), invitationSent: false };

    /*
     * **One unit with the KPM** (ADR-0212 §1, as approval is, ADR-0191 §3): an Owner who cannot be set — the leader
     * limit, a race for the address — undoes the KPM, its configuration and any membership written, and an account
     * made for them, before the refusal is answered.
     */
    const undo: Array<() => Promise<unknown>> = [];
    let owner: UserDocument | null;
    try {
      owner = await this.installOwner(ctx, kpm, ownerPlan, undo);
    } catch (err) {
      for (const step of undo.reverse()) await step().catch(() => undefined);
      await this.discardHalfMade(ctx, String(kpm._id), 'kpm.owner_failed');
      throw err;
    }
    const invitationSent = await this.inviteIfDue(ctx, kpm, owner, input.sendInvitation ?? true);
    return { ...(await this.toView(kpm, ctx.reader)), invitationSent };
  }

  /**
   * **Who the named Owner is** (ADR-0212 §2, §3), asked before anything is written:
   *
   * - **With an email that has an account**, that account — refused as ADR-0191 §5 refuses one: deactivated (`400`),
   *   another company's or with no agent code (`409 TENANT_COMPANY_MISMATCH`), an unverified address (`409
   *   AUTH_EMAIL_NOT_VERIFIED`).
   * - **With an email nobody holds**, an account to make for it: its agent code required (`400`, `owner.agentCode`) —
   *   the Owner is the KPM's root AB under it — and free in the company (`409 AGENT_CODE_TAKEN`).
   * - **With no email**, nobody to make: the Owner waits, named (`kpms.pendingOwner`).
   */
  private async planOwner(companyId: string, companyName: string, owner: OwnerInput): Promise<OwnerPlan> {
    const fullName = owner.fullName.trim();
    const agentCode = owner.agentCode?.trim() || null;
    const email = owner.email?.trim().toLowerCase() || null;
    if (email === null) return { kind: 'pending', pending: { fullName, phone: owner.phone, agentCode } };

    const existing = await this.users.findOne({ email, deletedAt: null }).exec();
    if (existing) {
      if (existing.status === 'deactivated') {
        throw new DomainException(
          ErrorCode.VALIDATION_FAILED,
          TENANTS_REFUSALS.VALIDATION_FAILED.ownerDeactivated,
          HttpStatus.BAD_REQUEST,
          { field: 'owner.email', userId: String(existing._id) },
        );
      }
      await this.refuseOwner(existing, companyId, { requireVerified: true });
      return { kind: 'existing', user: existing, phone: owner.phone };
    }
    if (agentCode === null) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        TENANTS_REFUSALS.VALIDATION_FAILED.ownerAgentCodeNeeded,
        HttpStatus.BAD_REQUEST,
        { field: 'owner.agentCode' },
      );
    }
    const holder = await this.users.findOne({ companyId, agentCode, deletedAt: null }).select('_id').exec();
    if (holder) {
      throw new DomainException(
        ErrorCode.AGENT_CODE_TAKEN,
        TENANTS_REFUSALS.AGENT_CODE_TAKEN.ownerCode({ agentCode, company: companyName }),
        HttpStatus.CONFLICT,
        { field: 'owner.agentCode', agentCode },
      );
    }
    return { kind: 'new', fullName, phone: owner.phone, email, agentCode };
  }

  /**
   * **Make the plan true in the KPM** (ADR-0212 §2, §3): an account made for a new Owner — with no usable password, as
   * the import makes one, its address unverified until the invitation's link proves it (ADR-0190 §3) — the Owner's
   * membership as the KPM's root AB, `ownerUserId`, and `pendingOwner` cleared; or, with no email, `pendingOwner`
   * alone. Each step that wrote pushes its undo. Audited: `kpm.owner_assigned` (or `kpm.owner_transferred`), `kpm
   * .pending_owner_set`. Answers the Owner's account, or `null` for an Owner who waits.
   */
  private async installOwner(
    ctx: RequestContext, kpm: KpmDocument, plan: OwnerPlan, undo: Array<() => Promise<unknown>>,
  ): Promise<UserDocument | null> {
    const kpmId = String(kpm._id);
    if (plan.kind === 'pending') {
      await this.kpms.updateOne({ _id: kpmId }, { $set: { pendingOwner: plan.pending } }).exec();
      kpm.pendingOwner = plan.pending;
      await this.audit.record(ctx, {
        action: 'kpm.pending_owner_set',
        targetCollection: 'kpms',
        targetId: kpmId,
        after: { fullName: plan.pending.fullName },
      });
      return null;
    }

    let user: UserDocument;
    if (plan.kind === 'existing') {
      user = plan.user;
      // The person's own field since UI-101: written only where none is on file, as the import writes it.
      if (!user.phone) {
        await this.users.updateOne({ _id: user._id, phone: null }, { $set: { phone: plan.phone } }).exec();
        user.phone = plan.phone;
      }
    } else {
      if (!this.invitations) throw new Error('An Owner account is made only with OwnerInvitations wired.');
      user = await this.users.create({
        email: plan.email,
        passwordHash: await this.invitations.unusablePassword(),
        fullName: plan.fullName,
        companyId: kpm.companyId,
        agentCode: plan.agentCode,
        phone: plan.phone,
        // Nobody holds this account's password: the invitation, or *Lupa kata sandi?*, sets the first.
        mustChangePassword: false,
        emailVerifiedAt: null,
        status: 'active',
        platformRole: 'none',
      });
      const userId = String(user._id);
      undo.push(() => this.users.updateOne(
        { _id: userId },
        // The address is freed again, since the email index holds a deleted account's too (as the import's undo).
        { $set: { deletedAt: this.clock.now(), email: `undone+${userId}@kpm-owner.invalid` } },
      ).exec());
    }

    const userId = String(user._id);
    await this.ensureOwnerMembership(ctx, kpmId, userId);
    const previousOwnerUserId = kpm.ownerUserId;
    await this.kpms.updateOne({ _id: kpmId }, { $set: { ownerUserId: userId, pendingOwner: null } }).exec();
    kpm.ownerUserId = userId;
    kpm.pendingOwner = null;
    await this.audit.record(ctx, {
      action: previousOwnerUserId ? 'kpm.owner_transferred' : 'kpm.owner_assigned',
      targetCollection: 'kpms',
      targetId: kpmId,
      before: { ownerUserId: previousOwnerUserId ?? null },
      after: { ownerUserId: userId, email: user.email, accountCreated: plan.kind === 'new' },
    });
    return user;
  }

  /**
   * ***"Kirim undangan … sekarang"*** (ADR-0212 §2): sent when it is ticked and the Owner has an account that has never
   * signed in — one that has is *Aktif*, and needs no link to set a password it already has. A failure to send is
   * logged and the KPM stands, as an import's does: the Owner can still use *Lupa kata sandi?*, and *Kirim ulang
   * undangan* is on their card.
   */
  private async inviteIfDue(
    ctx: RequestContext, kpm: KpmDocument, owner: UserDocument | null, send: boolean,
  ): Promise<boolean> {
    if (!send || owner === null || owner.lastLoginAt || !this.invitations) return false;
    try {
      await this.invitations.send(ctx, kpm, owner, { resent: false });
      return true;
    } catch (err) {
      this.logger.error({ err, kpmId: String(kpm._id) }, 'the Owner\'s invitation could not be sent');
      return false;
    }
  }

  /**
   * ***Kirim ulang undangan*** (ADR-0212 §2; P19.4-T3 AC-6): `POST /admin/tenants/:id/owner/invitation`. A new one-time
   * link to the Owner's email, the old revoked, `memberships.invitedAt` stamped again, audited as `kpm.owner_invited`
   * with `resent: true`. Refused `409 TENANT_OWNER_NOT_INVITABLE` with no Owner (`no_owner`), an Owner named with no
   * email (`no_email`), or one who has signed in (`signed_in`); past `OWNER_INVITATION_LIMIT` an hour for the KPM, `429
   * AUTH_RATE_LIMITED`. Nothing is sent on a refusal. Answers the KPM as the list reads it.
   */
  async resendOwnerInvitation(ctx: RequestContext, kpmId: string): Promise<KpmAdminView> {
    this.require(ctx, 'kpm:assign_owner');
    const kpm = await this.liveKpm(kpmId);
    const say = TENANTS_REFUSALS.TENANT_OWNER_NOT_INVITABLE;
    const refusal = (reason: 'no_owner' | 'no_email' | 'signed_in', sentence: Sentence<typeof ErrorCode.TENANT_OWNER_NOT_INVITABLE>) =>
      new DomainException(ErrorCode.TENANT_OWNER_NOT_INVITABLE, sentence, HttpStatus.CONFLICT, { reason, kpmId });
    const user = kpm.ownerUserId
      ? await this.users.findOne({ _id: kpm.ownerUserId, deletedAt: null }).exec().catch(() => null)
      : null;
    if (!user) {
      throw kpm.pendingOwner
        ? refusal('no_email', say.noEmail({ name: kpm.pendingOwner.fullName }))
        : refusal('no_owner', say.noOwner);
    }
    if (user.lastLoginAt) throw refusal('signed_in', say.signedIn({ name: user.fullName }));
    if (!this.invitations) throw new Error('Kirim ulang undangan needs OwnerInvitations wired.');
    this.invitations.limitResend(kpmId);
    await this.invitations.send(ctx, kpm, user, { resent: true });
    return this.toAdminView(ctx, kpm);
  }

  /**
   * A context scoped to an office that is being created.
   *
   * The caller is a Super Admin who is in no tenant, and the tenant-scoped repository fails
   * closed without a `kpmId` — correctly, because forgetting one is a cross-tenant leak.
   * This is the narrow, named exception: an office that exists as of three lines ago.
   */
  private contextFor(ctx: RequestContext, kpmId: string): RequestContext {
    return RequestContext.superAdminInTenant(ctx.userId, kpmId);
  }

  /**
   * Assign or transfer the Owner. Both are Super Admin only, and both are audited with
   * the outgoing and incoming user, because ownership is what makes every other
   * tenant-admin grant possible.
   *
   * **The person is resolved before anything is written.** An earlier version took a
   * user id on trust and stored it, so an office could be left pointing at an account
   * that does not exist — permanently, with nothing to notice it, and with nobody able
   * to administer the office. The console's screen asserted a "user not found" error
   * the service never produced; the API test and the screen test each passed against a
   * contract the other did not implement.
   *
   * Identified by **email or id**. Email is what a Super Admin actually knows and is
   * what §6.1 of roles-and-permissions.md describes; the id is kept because Swagger and
   * the seed output give you one.
   */
  async assignOwner(
    ctx: RequestContext,
    kpmId: string,
    who: { userId?: string; email?: string; owner?: OwnerInput; sendInvitation?: boolean },
  ): Promise<KpmAdminView> {
    this.require(ctx, 'kpm:assign_owner');

    const kpm = await this.kpms
      .findOne({ _id: kpmId, deletedAt: null })
      .exec()
      // A malformed id is "not here", not a 500: these arrive from a URL, and an
      // uncaught CastError renders as INTERNAL_ERROR and is logged as unhandled.
      .catch(() => null);
    if (!kpm) throw new NotFoundException('KPM');

    // *Ganti pemilik* to somebody named, with their email (ADR-0212 §3): an account is found or made, and invited.
    if (who.owner) return this.assignNamedOwner(ctx, kpm, who.owner, who.sendInvitation ?? true);

    const user = await this.resolveOwner(who);
    // Before anything is written (P19-T3 AC-3, AC-5): the office's own company, an agent code, a verified address.
    await this.refuseOwner(user, kpm.companyId, { requireVerified: true });

    // An Owner who is not a member cannot be resolved into the office, so nothing they
    // own is reachable. §6.1 of roles-and-permissions.md creates this on first login;
    // creating it here instead means the office is administrable the moment it is
    // assigned, rather than the first time someone happens to sign in.
    //
    // **Before the office row, since P13.2-T4.** A new Owner who is not yet a member is made
    // the office's root AB, and the leader limit can refuse that (ADR-0113 §2). Written after
    // `ownerUserId`, the refusal left an office owned by somebody with no membership in it —
    // nobody able to administer it, and the screen saying the assignment had failed.
    await this.ensureOwnerMembership(ctx, kpmId, String(user._id));

    const previousOwnerUserId = kpm.ownerUserId;
    kpm.ownerUserId = String(user._id);
    // An Owner named without an email waited here (ADR-0212 §3); one is set now, so the record goes.
    kpm.pendingOwner = null;
    await kpm.save();

    await this.audit.record(ctx, {
      action: previousOwnerUserId ? 'kpm.owner_transferred' : 'kpm.owner_assigned',
      targetCollection: 'kpms',
      targetId: kpmId,
      before: { ownerUserId: previousOwnerUserId },
      after: { ownerUserId: String(user._id), email: user.email },
    });

    return this.toAdminView(ctx, kpm);
  }

  /**
   * ***Ganti pemilik* to a person named with their email** (ADR-0212 §3; P19.4-T3 AC-6): the KPM's pending Owner given
   * an email, or anybody else. Their account — found by the address and refused as any Owner is, or made for it — becomes
   * the Owner and is invited (unless `sendInvitation` is `false`, or they have signed in). `owner.email` is required
   * (`400`): an invitation goes by email, and an Owner with none is already what the KPM has. Checked before anything is
   * written; a failure after the account was made undoes it.
   */
  private async assignNamedOwner(
    ctx: RequestContext, kpm: KpmDocument, owner: OwnerInput, sendInvitation: boolean,
  ): Promise<KpmAdminView> {
    if (!owner.email?.trim()) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        TENANTS_REFUSALS.VALIDATION_FAILED.ownerEmailNeeded,
        HttpStatus.BAD_REQUEST,
        { field: 'owner.email' },
      );
    }
    const company = await this.companies.findOne({ _id: kpm.companyId }).exec().catch(() => null);
    const plan = await this.planOwner(kpm.companyId, company?.name ?? kpm.companyId, owner);
    const undo: Array<() => Promise<unknown>> = [];
    let user: UserDocument | null;
    try {
      user = await this.installOwner(ctx, kpm, plan, undo);
    } catch (err) {
      for (const step of undo.reverse()) await step().catch(() => undefined);
      throw err;
    }
    await this.inviteIfDue(ctx, kpm, user, sendInvitation);
    return this.toAdminView(ctx, kpm);
  }

  /**
   * The Owner's own membership: an AB at the root of the office's tree.
   *
   * Idempotent, because a transfer back to a previous owner must not mint a second row —
   * the partial unique index would reject it, and the right answer is the row they
   * already have. Their hierarchy role is left alone if they are already a member:
   * an office may promote its Owner's account through the ranks like anyone else's.
   */
  private async ensureOwnerMembership(
    ctx: RequestContext,
    kpmId: string,
    userId: string,
  ): Promise<void> {
    const scoped = ctx.kpmId === kpmId
      ? ctx
      : RequestContext.superAdminInTenant(ctx.auditActors.actorUserId, kpmId);

    const existing = await this.memberships.findOne(scoped, {
      userId,
      status: { $in: ['active', 'pending'] },
    });
    if (existing) {
      /*
       * A pending member made the Owner is activated **under the leader limit** (ADR-0113 §2, P13.2
       * exit review): one promoted to AB or AAB while pending was not counted, and activating them here
       * asked nobody. `activate` takes the seat for a pending leader and refuses `409
       * LEADER_LIMIT_REACHED` before anything is written — and before `ownerUserId`, which
       * `assignOwner` writes after this.
       */
      if (existing.status !== 'active') {
        /*
         * An Owner is never a new hire (ADR-0169 §6, ADR-0103): joined today, an existing agent, and given no
         * activation. One who already had a join date here keeps it — it is set once.
         */
        const joining = existing.joinedAs ? {} : await this.hierarchy.joining(scoped, { joinedAs: 'existing_agent' });
        await this.hierarchy.activate(scoped, String(existing._id), { joinedAt: this.clock.now(), ...joining });
      }
      return;
    }

    // The ladder's Senior Leader rung: `AB` on the default ladder, whatever a custom one calls it (ADR-0156).
    const role = await this.hierarchy.entryRungCode(kpmId, 'owner');
    // An existing agent, joined today (ADR-0169 §6): the office's creation is nobody's hire (ADR-0103).
    await this.hierarchy.create(scoped, {
      userId, role, leaderId: null, status: 'active', joining: { joinedAs: 'existing_agent' },
    });
  }

  private async resolveOwner(who: { userId?: string; email?: string }): Promise<UserDocument> {
    const email = who.email?.toLowerCase().trim();
    if (!who.userId && !email) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        TENANTS_REFUSALS.VALIDATION_FAILED.nameTheOwner,
        HttpStatus.BAD_REQUEST,
        { fields: ['email', 'userId'] },
      );
    }

    // An id that is not a valid ObjectId would make Mongoose throw a CastError, which
    // surfaces as a 500. It is a caller mistake, so it is a 404 like any other unknown.
    const byId =
      who.userId && isValidObjectId(who.userId)
        ? await this.users.findOne({ _id: who.userId, deletedAt: null }).exec()
        : null;
    const user = byId ?? (email ? await this.users.findOne({ email, deletedAt: null }).exec() : null);

    if (!user) throw new NotFoundException('User');

    if (user.status === 'deactivated') {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        TENANTS_REFUSALS.VALIDATION_FAILED.ownerDeactivated,
        HttpStatus.BAD_REQUEST,
        { userId: String(user._id) },
      );
    }
    return user;
  }

  /**
   * **Who may own an office of this company** (ADR-0191 §3, ADR-0190 §4; P19-T3 AC-3, AC-5) — asked before anything
   * is written, by `assignOwner`, by approving a KPM request and by a move.
   *
   * - **The office's own company, and an agent code.** The Owner is made the office's root AB, and an office admits
   *   only its insurer's agents (`HierarchyService.agentCodeOf`). Asked *after* the office existed, that rule failed
   *   as `404 KPM` — which is how production was left with two ownerless *stellar* KPMs (UI-165): a Manulife applicant
   *   approved into a Prudential office. Named here instead, with what to do.
   * - **A verified address** (`requireVerified`): since ADR-0190 a person signs in before verifying, and being made an
   *   Owner is one of the two things that still needs the address proven. A move keeps the Owner it has, so asks it not.
   */
  async refuseOwner(
    user: UserDocument,
    companyId: string,
    options: { requireVerified: boolean },
  ): Promise<void> {
    if (!user.companyId || !user.agentCode) {
      throw new DomainException(
        ErrorCode.TENANT_COMPANY_MISMATCH,
        TENANTS_REFUSALS.TENANT_COMPANY_MISMATCH.ownerNoCompany({ name: user.fullName }),
        HttpStatus.CONFLICT,
        { userCompanyId: user.companyId ?? null, kpmCompanyId: companyId },
      );
    }
    if (user.companyId !== companyId) {
      const names = await this.companies.find({ _id: { $in: [user.companyId, companyId] } }).exec().catch(() => []);
      const nameOf = (id: string) => names.find((c) => String(c._id) === id)?.name ?? id;
      throw new DomainException(
        ErrorCode.TENANT_COMPANY_MISMATCH,
        TENANTS_REFUSALS.TENANT_COMPANY_MISMATCH.ownerOtherCompany({
          name: user.fullName, userCompany: nameOf(user.companyId), kpmCompany: nameOf(companyId),
        }),
        HttpStatus.CONFLICT,
        { userCompanyId: user.companyId, kpmCompanyId: companyId },
      );
    }
    // ADR-0190 §4: the one check, in the auth module's words — `409 AUTH_EMAIL_NOT_VERIFIED`, `details.userId`.
    if (options.requireVerified) refuseUnverifiedAddress(user);
  }

  /** The live office holding a code in a company, if any — the one `TENANT_CODE_TAKEN` names. */
  async codeHolder(companyId: string, code: string, exceptKpmId?: string): Promise<KpmDocument | null> {
    return this.kpms
      .findOne({
        companyId, code, deletedAt: null,
        ...(exceptKpmId ? { _id: { $ne: exceptKpmId } } : {}),
      })
      .exec()
      .catch(() => null);
  }

  /** `TENANT_CODE_TAKEN`, naming the office that holds the code and its company (ADR-0191 §4, P19-T3 AC-4). */
  codeTaken(holder: KpmDocument, companyName: string): DomainException {
    return new DomainException(
      ErrorCode.TENANT_CODE_TAKEN,
      TENANTS_REFUSALS.TENANT_CODE_TAKEN.taken({
        code: holder.code, kpm: `KPM ${holder.code} · ${holder.branchName}`, company: companyName,
      }),
      HttpStatus.CONFLICT,
      {
        companyId: holder.companyId, code: holder.code,
        kpmId: String(holder._id), branchName: holder.branchName, companyName,
      },
    );
  }

  /**
   * **Is this code free in this company?** (P19-T3 AC-2): `GET /admin/tenants/code-availability`, read as the Super
   * Admin types a code on a KPM request's card or the *New office* form, so the clash is said before anything is
   * pressed — naming the office that holds it, as `TENANT_CODE_TAKEN` does. An unknown company is 404.
   */
  async codeAvailability(
    ctx: RequestContext,
    companyId: string,
    code: string,
  ): Promise<{ available: boolean; takenBy: { kpmId: string; code: string; branchName: string; companyName: string } | null }> {
    this.require(ctx, 'kpm:create');
    const company = await this.companies.findOne({ _id: companyId, deletedAt: null }).exec().catch(() => null);
    if (!company) throw new NotFoundException('Company');
    const holder = await this.codeHolder(companyId, code.trim());
    return {
      available: !holder,
      takenBy: holder
        ? { kpmId: String(holder._id), code: holder.code, branchName: holder.branchName, companyName: company.name }
        : null,
    };
  }

  /**
   * **Undo an office an approval made, when its Owner could not be set** (ADR-0191 §3, P19-T3 AC-3: *nothing is left
   * behind*). There are no transactions (ADR-0002), so this is the compensation: the office, any membership written in
   * it and the configuration provisioned for it are soft-deleted — never a delete (invariant §6) — and the code is free
   * again, since the index counts live offices only. Audited as `kpm.discarded`, with why.
   */
  async discardHalfMade(ctx: RequestContext, kpmId: string, why: string): Promise<void> {
    const now = this.clock.now();
    const scoped = RequestContext.superAdminInTenant(ctx.auditActors.actorUserId, kpmId);
    const members = await this.memberships.updateMany(scoped, {}, { $set: { deletedAt: now } });
    const retired = await this.provisioning.retireConfigFor(kpmId, now);
    await this.kpms.updateOne({ _id: kpmId, deletedAt: null }, { $set: { deletedAt: now } }).exec();
    await this.audit.record(ctx, {
      action: 'kpm.discarded',
      targetCollection: 'kpms',
      targetId: kpmId,
      before: { deletedAt: null },
      after: { deletedAt: now, why, members, retired },
    });
  }

  /**
   * **The offices requests became, by id — deleted ones too** (P19-T3 AC-3): a decided request names what it made, and
   * says so when that office has since been deleted, rather than losing the line.
   */
  async officesByIds(ids: string[]): Promise<Map<string, { code: string; branchName: string; deleted: boolean }>> {
    const live = ids.filter((id) => isValidObjectId(id));
    if (live.length === 0) return new Map();
    const rows = await this.kpms.find({ _id: { $in: live } }).exec();
    return new Map(rows.map((k) => [
      String(k._id), { code: k.code, branchName: k.branchName, deleted: k.deletedAt !== null },
    ]));
  }

  /**
   * **The accounts *Ganti Owner* chooses from** (ADR-0191 §5, P19-T3 AC-5): `GET /admin/accounts?q=`, by name or email,
   * at most twenty, each with its company, whether its address is verified, and the offices it already owns or belongs
   * to — so the Super Admin sees who is already an Owner or a member before choosing, instead of asking for an exact
   * email. Super Admins are not offered: they sell for nobody.
   *
   * Their memberships are read across offices through the named unscoped method (invariant §1), by the Super Admin
   * who is in none — the same register entry as the overview's.
   */
  async searchAccounts(ctx: RequestContext, q: string): Promise<AccountChoice[]> {
    this.require(ctx, 'kpm:assign_owner');
    const term = (q ?? '').trim();
    if (term.length < 2) {
      throw new InvalidRequestException(TENANTS_REFUSALS.VALIDATION_FAILED.searchTwoCharacters, { field: 'q' });
    }
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await this.users
      .find({ deletedAt: null, platformRole: { $ne: 'super_admin' }, $or: [{ fullName: pattern }, { email: pattern }] })
      .sort({ fullName: 1 })
      .limit(ACCOUNT_SEARCH_LIMIT)
      .exec();
    if (users.length === 0) return [];

    const ids = users.map((u) => String(u._id));
    const [memberships, owned] = await Promise.all([
      this.memberships.findAcrossAllTenants(ctx, { userId: { $in: ids }, status: { $in: ['active', 'pending'] } }),
      this.kpms.find({ ownerUserId: { $in: ids }, deletedAt: null }).exec(),
    ]);
    const kpmIds = [...new Set([...memberships.map((m) => m.kpmId), ...owned.map((k) => String(k._id))])];
    const offices = kpmIds.length > 0
      ? await this.kpms.find({ _id: { $in: kpmIds }, deletedAt: null }).exec()
      : [];
    const companyIds = [...new Set([
      ...users.map((u) => u.companyId).filter((id): id is string => Boolean(id)),
      ...offices.map((k) => k.companyId),
    ])];
    const companies = await this.companies.find({ _id: { $in: companyIds } }).exec().catch(() => []);
    const companyName = new Map(companies.map((c) => [String(c._id), c.name]));
    const office = new Map(offices.map((k) => [String(k._id), k]));

    return users.map((u) => {
      const userId = String(u._id);
      const theirs = new Map<string, AccountOffice>();
      for (const m of memberships.filter((row) => row.userId === userId)) {
        const k = office.get(m.kpmId);
        if (!k) continue;
        theirs.set(m.kpmId, {
          kpmId: m.kpmId, code: k.code, branchName: k.branchName,
          companyName: companyName.get(k.companyId) ?? render(TENANTS_MESSAGES.unknownCompany, ctx.reader),
          isOwner: k.ownerUserId === userId, membershipStatus: m.status === 'pending' ? 'pending' : 'active',
        });
      }
      for (const k of owned.filter((row) => row.ownerUserId === userId)) {
        if (theirs.has(String(k._id))) continue;
        theirs.set(String(k._id), {
          kpmId: String(k._id), code: k.code, branchName: k.branchName,
          companyName: companyName.get(k.companyId) ?? render(TENANTS_MESSAGES.unknownCompany, ctx.reader),
          isOwner: true, membershipStatus: null,
        });
      }
      return {
        userId,
        fullName: u.fullName,
        email: u.email,
        phone: u.phone ?? null,
        companyId: u.companyId ?? null,
        companyName: u.companyId ? (companyName.get(u.companyId) ?? null) : null,
        hasAgentCode: Boolean(u.agentCode),
        emailVerified: Boolean(u.emailVerifiedAt),
        status: u.status,
        offices: [...theirs.values()],
      };
    });
  }

  /**
   * **What an office holds** (ADR-0191 §5, P19-T3 AC-7): its members — every membership, whatever its state, the
   * Owner's included — and its records, every row of every collection that carries the office's `kpmId`, apart from
   * what provisioning writes with it (its configuration) and the audit log. `deletable` when both are zero: what the
   * *Hapus KPM* confirmation shows, and what `DELETE /admin/tenants/:id` asks again.
   */
  async contents(ctx: RequestContext, kpmId: string): Promise<{ members: number; records: number; deletable: boolean }> {
    this.require(ctx, 'kpm:archive');
    const kpm = await this.liveKpm(kpmId);
    return this.countContents(ctx, String(kpm._id));
  }

  private async countContents(
    ctx: RequestContext,
    kpmId: string,
  ): Promise<{ members: number; records: number; deletable: boolean }> {
    const scoped = RequestContext.superAdminInTenant(ctx.auditActors.actorUserId, kpmId);
    const members = await this.memberships.count(scoped, {});
    let records = 0;
    /*
     * Every collection the application registers, so a collection added later is counted without anybody remembering
     * to — a read by count, the office named in every filter. Configuration is not "data": the office was made with it.
     */
    const counted = new Set<string>();
    for (const model of Object.values(this.kpms.db.models)) {
      // By collection, once each: two models may name one collection, and the collection is what holds the rows.
      const collection = model.collection.collectionName;
      if (counted.has(collection) || NOT_OFFICE_DATA.has(collection) || !model.schema.path('kpmId')) continue;
      counted.add(collection);
      const filter: Record<string, unknown> = { kpmId };
      if (model.schema.path('deletedAt')) filter.deletedAt = null;
      records += await model.countDocuments(filter).exec();
    }
    return { members, records, deletable: members === 0 && records === 0 };
  }

  /**
   * **Delete an empty office** (ADR-0191 §5, P19-T3 AC-7) — a soft delete (invariant §6): `deletedAt` on the office and
   * on the configuration provisioned for it, audited as `kpm.deleted` with what it was. Refused `409 TENANT_NOT_EMPTY`,
   * with the counts, for an office with any member or any record: that one is archived, never deleted. Its code is free
   * again in its company. A wrong office the platform made — *stellar* 2001 — is the case (Q-5).
   */
  async deleteKpm(ctx: RequestContext, kpmId: string): Promise<{ deleted: true; kpmId: string }> {
    this.require(ctx, 'kpm:archive');
    const kpm = await this.liveKpm(kpmId);
    const held = await this.countContents(ctx, String(kpm._id));
    if (!held.deletable) {
      throw new DomainException(
        ErrorCode.TENANT_NOT_EMPTY,
        TENANTS_REFUSALS.TENANT_NOT_EMPTY.cannotDelete({ members: held.members, records: held.records }),
        HttpStatus.CONFLICT,
        { members: held.members, records: held.records },
      );
    }
    const now = this.clock.now();
    await this.kpms.updateOne({ _id: kpm._id, deletedAt: null }, { $set: { deletedAt: now } }).exec();
    const retired = await this.provisioning.retireConfigFor(String(kpm._id), now);
    await this.audit.record(ctx, {
      action: 'kpm.deleted',
      targetCollection: 'kpms',
      targetId: String(kpm._id),
      before: { code: kpm.code, branchName: kpm.branchName, companyId: kpm.companyId, status: kpm.status, deletedAt: null },
      after: { deletedAt: now, members: 0, records: 0, retired },
    });
    return { deleted: true, kpmId: String(kpm._id) };
  }

  /**
   * **Move an office to another company** (ADR-0191 §5, P19-T3 AC-6; `kpm:update_company_tag`): only while it has no
   * member but its Owner — the others' agent codes are their insurer's — and with its configuration **provisioned again
   * from the new company's default template**, the old one retired (soft-deleted). The Owner, when there is one, must be
   * the new company's (`refuseOwner`), and keeps their rung by its code on the new company's ladder. The code must be
   * free in the new company (`TENANT_CODE_TAKEN`, naming who holds it). Every check comes first, so a refusal writes
   * nothing. Audited as `kpm.company_moved`, from and to.
   */
  async moveCompany(ctx: RequestContext, kpmId: string, companyId: string): Promise<KpmAdminView> {
    this.require(ctx, 'kpm:update_company_tag');
    const kpm = await this.liveKpm(kpmId);
    const target = await this.companies.findOne({ _id: companyId, deletedAt: null }).exec().catch(() => null);
    if (!target) throw new NotFoundException('Company');
    if (isTemplateLibrary(target)) {
      throw new DomainException(
        ErrorCode.COMPANY_IS_TEMPLATE_LIBRARY,
        TENANTS_REFUSALS.COMPANY_IS_TEMPLATE_LIBRARY.holdsNoOffice({ name: target.name }),
        HttpStatus.CONFLICT,
        { companyId },
      );
    }
    if (kpm.companyId === companyId) {
      throw new InvalidRequestException(TENANTS_REFUSALS.VALIDATION_FAILED.sameCompany, { field: 'companyId' });
    }

    const id = String(kpm._id);
    const scoped = RequestContext.superAdminInTenant(ctx.auditActors.actorUserId, id);
    const others = await this.memberships.count(
      scoped, kpm.ownerUserId ? { userId: { $ne: kpm.ownerUserId } } : {},
    );
    if (others > 0) {
      throw new DomainException(
        ErrorCode.TENANT_NOT_EMPTY,
        TENANTS_REFUSALS.TENANT_NOT_EMPTY.cannotMove({ members: others }),
        HttpStatus.CONFLICT,
        { members: others, records: null },
      );
    }

    // The Owner comes along: theirs must be the new company, and their rung must be on its ladder.
    let ownerMove: { membershipId: string; orgLevelId: string; orgLevelCode: string } | null = null;
    if (kpm.ownerUserId) {
      const owner = await this.users.findOne({ _id: kpm.ownerUserId, deletedAt: null }).exec().catch(() => null);
      if (owner) await this.refuseOwner(owner, companyId, { requireVerified: false });
      const membership = await this.memberships.findOne(scoped, { userId: kpm.ownerUserId });
      if (membership) {
        const level = await this.orgLevels.resolveByCode(companyId, membership.orgLevelCode);
        ownerMove = { membershipId: String(membership._id), orgLevelId: String(level._id), orgLevelCode: level.code };
      }
    }

    const clash = await this.codeHolder(companyId, kpm.code, id);
    if (clash) throw this.codeTaken(clash, target.name);

    // The new company's default template, resolved and checked before anything is written (ADR-0115 §4).
    const plan = await this.provisioning.planFor(companyId);

    const before = { companyId: kpm.companyId, startedFrom: kpm.startedFrom ?? null };
    try {
      await this.kpms.updateOne(
        { _id: id, deletedAt: null }, { $set: { companyId, startedFrom: plan.startedFrom } },
      ).exec();
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      const winner = await this.codeHolder(companyId, kpm.code, id);
      if (!winner) throw err;
      throw this.codeTaken(winner, target.name);
    }

    const now = this.clock.now();
    const retired = await this.provisioning.retireConfigFor(id, now);
    const provisioned = await this.provisioning.provision(id, plan);
    await this.provisioning.publishInitialSnapshotFor(id, this.contextFor(ctx, id));
    await this.kpms.updateOne({ _id: id }, { $set: { seededFrom: provisioned.seededFrom } }).exec();
    if (ownerMove) {
      await this.memberships.updateById(scoped, ownerMove.membershipId, {
        $set: { orgLevelId: ownerMove.orgLevelId, orgLevelCode: ownerMove.orgLevelCode },
      });
    }

    await this.audit.record(ctx, {
      action: 'kpm.company_moved',
      targetCollection: 'kpms',
      targetId: id,
      before,
      after: {
        companyId, startedFrom: plan.startedFrom, seededFrom: provisioned.seededFrom, retired,
        ownerRung: ownerMove?.orgLevelCode ?? null,
      },
    });

    return this.toAdminView(ctx, await this.liveKpm(id));
  }

  /** A live office by id, or 404 — a malformed id from a URL included. */
  private async liveKpm(kpmId: string): Promise<KpmDocument> {
    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec().catch(() => null);
    if (!kpm) throw new NotFoundException('KPM');
    return kpm;
  }

  /**
   * A tenant may not be left ownerless. Clearing the owner without naming a successor
   * would leave nobody able to grant admin access.
   */
  async clearOwner(ctx: RequestContext, kpmId: string): Promise<never> {
    this.require(ctx, 'kpm:assign_owner');
    throw new DomainException(
      ErrorCode.PERM_LAST_OWNER,
      TENANTS_REFUSALS.PERM_LAST_OWNER.alwaysAnOwner,
      HttpStatus.CONFLICT,
      { kpmId },
    );
  }

  async setStatus(
    ctx: RequestContext,
    kpmId: string,
    status: 'active' | 'suspended' | 'archived',
    reason?: string,
  ): Promise<KpmAdminView> {
    this.require(ctx, status === 'suspended' ? 'kpm:suspend' : 'kpm:activate');

    const kpm = await this.kpms
      .findOne({ _id: kpmId, deletedAt: null })
      .exec()
      // A malformed id is "not here", not a 500: these arrive from a URL, and an
      // uncaught CastError renders as INTERNAL_ERROR and is logged as unhandled.
      .catch(() => null);
    if (!kpm) throw new NotFoundException('KPM');

    const before = kpm.status;
    kpm.status = status;
    kpm.suspendedAt = status === 'suspended' ? this.clock.now() : null;
    kpm.suspendedReason = status === 'suspended' ? (reason ?? null) : null;
    await kpm.save();

    await this.audit.record(ctx, {
      action: `kpm.${status}`,
      targetCollection: 'kpms',
      targetId: kpmId,
      before: { status: before },
      after: { status, reason: reason ?? null },
    });

    return this.toAdminView(ctx, kpm);
  }

  /**
   * Set an office's subscription (ADR-0112 §2, P13.2-T3 AC-1, AC-2): its dates, price per leader,
   * leader limit and *keep active*, **the five together**, as the dialog sends them.
   *
   * The Super Admin's alone (`kpm:update_subscription`, blocked in a support session). Checked whole
   * before anything is written; an unknown office is 404. One audit row, `kpm.subscription_updated`,
   * with the five fields before and after — the only history a subscription has (ADR-0112 §5).
   *
   * **Lowering the limit below *Leaders used* is allowed** (ADR-0113 §3): nobody is demoted, and new
   * leaders are refused until the count is under it. The dialog says so before it is saved.
   *
   * Answers the office **as the list reads it**, so the row redraws from the answer.
   */
  async updateSubscription(
    ctx: RequestContext,
    kpmId: string,
    input: SubscriptionInput,
  ): Promise<KpmAdminView> {
    this.require(ctx, 'kpm:update_subscription');
    const next = validateSubscription(input);

    const kpm = await this.kpms
      .findOne({ _id: kpmId, deletedAt: null })
      .exec()
      // A malformed id is "not here", not a 500: these arrive from a URL.
      .catch(() => null);
    if (!kpm) throw new NotFoundException('KPM');

    const before = kpm.subscription ?? null;
    // *Paket* absent from the body keeps the office's (ADR-0211 §1): an older client sending five fields changes no plan.
    if (input.plan === undefined) next.plan = before?.plan ?? null;
    const updated = await this.kpms
      .findOneAndUpdate({ _id: kpmId, deletedAt: null }, { $set: { subscription: next } }, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('KPM');

    await this.audit.record(ctx, {
      action: 'kpm.subscription_updated',
      targetCollection: 'kpms',
      targetId: kpmId,
      before: { subscription: before },
      after: { subscription: next },
    });

    return this.toAdminView(ctx, updated);
  }

  /**
   * The console's front page.
   *
   * **The overview is a queue, not four counters** — the prototype puts `Needs your
   * attention` above the tiles and its footer says why: *"4 items need Superadmin action
   * — nothing here can be delegated to a KPM Owner or Admin"* (`Superadmin.html:272`).
   * The tiles are context for the queue, so they are returned together and rendered in
   * that order.
   *
   * **Two of the tiles are cross-tenant headcounts**, which ADR-0011 deliberately allows:
   * it retook ADR-0005's claim that this console "never reads an office's business data"
   * once the prototype turned up with `Total members` and `Agency Builders` on the front
   * page. Aggregate composition is in; leads, activity, coaching notes and production
   * stay out, and nothing here reads them.
   *
   * One cross-tenant read serves all of it — the totals, the role split and the
   * per-company breakdown — rather than a count per office. At the phase's own benchmark
   * of 500 members that is a few thousand documents; if the platform outgrows that, this
   * becomes a grouped aggregate rather than more round trips.
   */
  async platformOverview(ctx: RequestContext): Promise<PlatformOverview> {
    this.require(ctx, 'platform_metrics:read');

    const [companies, kpms, members, pendingRequests, ladders] = await Promise.all([
      // The insurers: the Template library holds templates, and is no company the platform serves (ADR-0164 §3).
      this.companies.find({ deletedAt: null, ...INSURERS_ONLY }).sort({ name: 1 }).exec(),
      this.kpms.find({ deletedAt: null }).exec(),
      this.memberships.findAcrossAllTenants(ctx, { status: 'active' }),
      // The **model**, not `KpmRequestService` — that service already depends on this
      // one, so injecting it back would be a cycle.
      this.kpmRequests.countDocuments({ status: 'pending', deletedAt: null }).exec(),
      // P3.1-T7 AC-5. The prototype's company meta line reads `Role ladder: Agent → AAB
      // → AB` (`Superadmin.html:311`); until the ladder was data there was nothing behind
      // it, and a literal would have been a sentence no data stood for.
      this.orgLevels.laddersByCompany(
        (await this.companies.find({ deletedAt: null, ...INSURERS_ONLY }).select('_id').exec()).map((c) => String(c._id)),
      ),
    ]);

    const membersByKpm = new Map<string, number>();
    let agencyBuilders = 0;
    for (const m of members) {
      membersByKpm.set(m.kpmId, (membersByKpm.get(m.kpmId) ?? 0) + 1);
      if (m.role === 'ab') agencyBuilders += 1;
    }

    const kpmsByCompany = new Map<string, KpmDocument[]>();
    for (const kpm of kpms) {
      const list = kpmsByCompany.get(kpm.companyId) ?? [];
      list.push(kpm);
      kpmsByCompany.set(kpm.companyId, list);
    }

    return {
      tiles: {
        companies: companies.length,
        kpms: kpms.length,
        totalMembers: members.length,
        agencyBuilders,
      },
      attention: this.attentionQueue(kpms, await this.ownerFacts(ctx, kpms), pendingRequests, ctx.reader),
      companies: companies.map((c) => {
        const theirs = kpmsByCompany.get(String(c._id)) ?? [];
        return {
          companyId: String(c._id),
          name: c.name,
          initials: c.name.slice(0, 2).toUpperCase(),
          kpmCount: theirs.length,
          memberCount: theirs.reduce((n, k) => n + (membersByKpm.get(String(k._id)) ?? 0), 0),
          // Junior first, as the prototype writes it. Empty for a company whose ladder
          // nobody has defined — the card then says so rather than showing an arrow with
          // nothing on either side.
          ladder: (ladders.get(String(c._id)) ?? []).map((l) => l.label),
        };
      }),
    };
  }

  /**
   * What needs the platform's own hand.
   *
   * The prototype seeds four rows from sources we mostly do not have yet: a role-ladder
   * request (P3.1-T7), pending KPM registrations (P3.1-T2), template adoption and a
   * product publish (Phases 4 and 5). **Only one of its sources exists today**, so only
   * one kind of row is produced. A queue with one real row is honest; four invented ones
   * would make the screen look finished and tell the reader nothing true.
   */
  private attentionQueue(
    kpms: KpmDocument[], facts: ReadonlyMap<string, OwnerFacts>, pendingRequests: number, reader: Reader,
  ): AttentionItem[] {
    const items: AttentionItem[] = [];
    // Written for the Super Admin reading the queue (P18.10-T5 AC-4): every word of a row in their language.
    const say = TENANTS_MESSAGES;

    /*
     * **A KPM is set up when it has an Owner and members** (SA R5, SA UI-014; P19.4-T3 AC-8): *"KPM {code} belum punya
     * Owner"* and *"KPM {code} belum punya anggota"* — a member besides the Owner, active or pending — one row each, the
     * KPM's own, gone the moment it is true. By code, and an archived KPM is nobody's to set up. They replace the row
     * that counted the offices with no Owner and named none.
     */
    const open = kpms.filter((k) => k.status !== 'archived').sort((a, b) => a.code.localeCompare(b.code));
    for (const kpm of open) {
      const id = String(kpm._id);
      const href = `/admin/tenants/${id}`;
      if (!kpm.ownerUserId) {
        items.push({
          tag: render(say.unownedTag, reader),
          severity: 'structural',
          title: render(say.noOwnerTitle({ code: kpm.code }), reader),
          detail: render(kpm.pendingOwner ? say.pendingOwnerDetail({ name: kpm.pendingOwner.fullName }) : say.noOwnerDetail, reader),
          href,
          actionLabel: render(say.openOfficeAction, reader),
        });
      }
      if ((facts.get(id)?.membersBesidesOwner ?? 0) === 0) {
        items.push({
          tag: render(say.noMembersTag, reader),
          severity: 'structural',
          title: render(say.noMembersTitle({ code: kpm.code }), reader),
          detail: render(say.noMembersDetail, reader),
          href,
          actionLabel: render(say.openOfficeAction, reader),
        });
      }
    }

    // The second of the prototype's four sources (`Superadmin.html:232-273`). Parity row
    // I-48 promised it would arrive with P3.1-T2; T2 built the entity, the endpoints and
    // the screen, and left the queue row behind — so the only route to that screen was a
    // nav item still flagged `upcoming`, which renders without an href. A shipped
    // surface nobody could reach.
    if (pendingRequests > 0) {
      items.push({
        tag: render(say.requestTag, reader),
        severity: 'approval',
        title: render(say.requestTitle({ count: pendingRequests }), reader),
        detail: render(say.requestDetail, reader),
        href: '/admin/kpm-requests',
        actionLabel: render(say.decideAction, reader),
      });
    }

    return items;
  }

  /**
   * Everybody who administers an office, across every office.
   *
   * ADR-0011 lists this among the destinations the Superadmin prototype declares
   * (`Superadmin.html:196`) and we had not built. It is the platform's answer to *"who
   * can act inside our tenants"*, which nothing else could give without opening each
   * office in turn.
   *
   * **Read-only, and that is the point.** Granting and revoking stay inside the office,
   * where the Owner does them — `kpm_admin:grant` names no tenant grantee but the Owner,
   * and `isOwnerReserved` derives the refusal from that list. A platform screen that
   * could hand out office administration would route around a decision the office owns.
   *
   * Cross-tenant, through the explicitly named unscoped method. `kpm_admin:list` already
   * gives Super Admin `all`; this is what that cell was for.
   */
  async platformAdmins(ctx: RequestContext): Promise<PlatformAdminRow[]> {
    this.require(ctx, 'kpm_admin:list_platform');

    // **Ownership is not on the membership.** `kpms.ownerUserId` holds it, and
    // `ContextResolver` derives `isKpmOwner` by comparing the two — so this has to make
    // the same join rather than filter a field that does not exist. Delegated admin
    // rights *are* on the membership, which is why only one half of this is a query.
    const [kpms, admins] = await Promise.all([
      this.kpms.find({ deletedAt: null }).exec(),
      this.memberships.findAcrossAllTenants(ctx, {
        status: 'active',
        'adminAccess.isKpmAdmin': true,
      }),
    ]);

    const ownerOf = new Map(
      kpms.filter((k) => k.ownerUserId).map((k) => [String(k._id), String(k.ownerUserId)]),
    );
    const owners = await this.memberships.findAcrossAllTenants(ctx, {
      status: 'active',
      userId: { $in: [...new Set(ownerOf.values())] },
    });

    // An Owner who is also a delegated Admin is one person and one row.
    const byId = new Map(admins.map((m) => [String(m._id), m]));
    for (const m of owners) {
      if (ownerOf.get(m.kpmId) === m.userId) byId.set(String(m._id), m);
    }
    const rows = [...byId.values()];
    if (rows.length === 0) return [];

    const users = await this.users
      .find({ _id: { $in: [...new Set(rows.map((r) => r.userId))] } })
      .exec();
    const office = new Map(kpms.map((k) => [String(k._id), `KPM ${k.code} — ${k.branchName}`]));
    const byUser = new Map(users.map((u) => [String(u._id), u]));

    return rows
      .map((r) => {
        const who = byUser.get(r.userId);
        const fullName = who?.fullName ?? render(TENANTS_MESSAGES.unknownPerson, ctx.reader);
        return {
          membershipId: String(r._id),
          fullName,
          email: who?.email ?? '',
          initials: initialsOf(fullName),
          kpmId: r.kpmId,
          kpmLabel: office.get(r.kpmId) ?? render(TENANTS_MESSAGES.unknownOffice, ctx.reader),
          isOwner: ownerOf.get(r.kpmId) === r.userId,
          isAdmin: Boolean(r.adminAccess?.isKpmAdmin),
          // An Owner's rights come with the office, not from a grant, so there is no date
          // to show and a blank is the honest answer rather than the office's own.
          grantedAt: r.adminAccess?.isKpmAdmin
            ? (r.adminAccess.grantedAt?.toISOString() ?? null)
            : null,
        };
      })
      // Grouped by office, Owner first within it: that is the question the screen answers
      // — who runs this one, and who else can act in it.
      .sort(
        (a, b) =>
          a.kpmLabel.localeCompare(b.kpmLabel) || Number(b.isOwner) - Number(a.isOwner) ||
          a.fullName.localeCompare(b.fullName),
      );
  }

  /** Every office, newest first, with its subscription, *Leaders used* and state (P13.2-T3 AC-3). */
  async listAll(ctx: RequestContext): Promise<KpmAdminView[]> {
    this.require(ctx, 'kpm:list_all');
    return this.toAdminViews(
      ctx, await this.kpms.find({ deletedAt: null }).sort({ createdAt: -1 }).exec(),
    );
  }

  /**
   * A tenant's own profile. Readable by its Owner and Admins as well as Super Admin.
   *
   * **The Super Admin's read carries the subscription** (P13.2-T3 AC-8, the detail page's
   * *Lifecycle* card); an Owner's or an Admin's of their own office does not — it is the platform's
   * arrangement with the office, and no tenant role is granted it.
   */
  async readProfile(ctx: RequestContext, kpmId: string): Promise<KpmView | (KpmAdminView & KpmPeople)> {
    this.require(ctx, 'kpm:read_profile');

    // A non-Super-Admin may only read the office they belong to. Returning 404 rather
    // than 403 keeps the existence of other tenants unobservable.
    if (!ctx.isSuperAdmin && ctx.kpmId !== kpmId) throw new NotFoundException('KPM');

    const kpm = await this.kpms
      .findOne({ _id: kpmId, deletedAt: null })
      .exec()
      // A malformed id is "not here", not a 500: these arrive from a URL, and an
      // uncaught CastError renders as INTERNAL_ERROR and is logged as unhandled.
      .catch(() => null);
    if (!kpm) throw new NotFoundException('KPM');
    if (!ctx.isSuperAdmin) return this.toView(kpm, ctx.reader);
    const [view, people] = await Promise.all([this.toAdminView(ctx, kpm), this.peopleOfOffice(ctx, kpm)]);
    return { ...view, ...people };
  }

  /**
   * ***Ringkasan*'s Admins and its counts by role** (P19.4-T3 AC-9; the setup spec's A2): who the KPM's delegated Admins
   * are, each with their invitation's state, read-only — delegation is the Owner's (roles §3.3) — and its live members by
   * rung of the company's ladder. The Super Admin's read of a KPM page; counts and names, never a figure or a contact.
   */
  private async peopleOfOffice(ctx: RequestContext, kpm: KpmDocument): Promise<KpmPeople> {
    const office = RequestContext.superAdminInTenant(ctx.auditActors.actorUserId, String(kpm._id));
    const [rows, ladders] = await Promise.all([
      this.memberships.find(office, { status: { $in: ['active', 'pending'] } }, {
        projection: { userId: 1, orgLevelCode: 1, status: 1, invitedAt: 1, 'adminAccess.isKpmAdmin': 1 },
      }),
      this.orgLevels.laddersByCompany([kpm.companyId]),
    ]);
    const live = rows as unknown as {
      userId: string; orgLevelCode: string; status: string; invitedAt?: Date | null; adminAccess?: { isKpmAdmin?: boolean };
    }[];
    const admins = live.filter((m) => m.adminAccess?.isKpmAdmin === true && m.userId !== kpm.ownerUserId);
    const users = admins.length === 0 ? [] : await this.users.find({ _id: { $in: admins.map((m) => m.userId) } })
      .select('fullName lastLoginAt').lean().exec() as { _id: unknown; fullName: string; lastLoginAt?: Date | null }[];
    const byUser = new Map(users.map((u) => [String(u._id), u]));
    const ladder = ladders.get(kpm.companyId) ?? [];
    const codes = [...new Set([...ladder.map((l) => l.code), ...live.map((m) => m.orgLevelCode)])];
    return {
      admins: admins.map((m) => {
        const user = byUser.get(m.userId);
        return {
          fullName: user?.fullName ?? render(TENANTS_MESSAGES.unknownPerson, ctx.reader),
          state: consoleState(invitationStateOf(user?.lastLoginAt, m.invitedAt)),
        };
      }).sort((a, b) => a.fullName.localeCompare(b.fullName)),
      membersByRole: codes.map((code) => ({
        code,
        label: ladder.find((l) => l.code === code)?.label ?? code,
        count: live.filter((m) => m.orgLevelCode === code).length,
      })).filter((rung) => rung.count > 0 || ladder.some((l) => l.code === rung.code)),
    };
  }

  /**
   * The office's own identity (P4-T5, `KPM_Owner.html:1807-1812`).
   *
   * **The Owner's and the Admin's, like every page under Settings** (ADR-0027), and under the
   * same permission. It was the Owner's alone, behind `kpm:update_identity`, until the product
   * owner gave the Admin the write: an Admin runs the office on the Owner's behalf, and only
   * managing admins is held back.
   *
   * **The office is always the caller's own.** No platform grant reaches this permission, so
   * the Super Admin exception this check used to carry could never run.
   *
   * **Company and KPM Owner are not here.** The prototype disables both fields and labels
   * the first *"tagged by Superadmin"*, which is where the platform-owned boundary was
   * first written down. `kpm:update_company_tag` is Super Admin's alone.
   *
   * **Nor locale, timezone or currency.** ADR-0016 fixes all three for v1, and the office
   * overview already shows them read-only. `kpms.timezone` stays a real column and every
   * day boundary reads it — the thing that rule guards against is the *server's* clock.
   *
   * The fiscal year start month is stored, displayed, and read by nobody until Phase 18.
   * Writing it now costs nothing and means the first period computation does not have to
   * ask every office to go and set it.
   */
  async updateIdentity(
    ctx: RequestContext,
    kpmId: string,
    input: {
      branchName?: string;
      address?: string | null;
      contactPhone?: string | null;
      fiscalYearStartMonth?: number;
    },
  ): Promise<KpmView> {
    this.require(ctx, 'tenant_config:write');
    if (ctx.kpmId !== kpmId) throw new NotFoundException('KPM');

    const set: Record<string, unknown> = {};
    if (input.branchName !== undefined) set.branchName = input.branchName.trim();
    if (input.address !== undefined) set.address = input.address?.trim() || null;
    if (input.contactPhone !== undefined) set.contactPhone = input.contactPhone?.trim() || null;
    if (input.fiscalYearStartMonth !== undefined) {
      set.fiscalYearStartMonth = input.fiscalYearStartMonth;
    }
    if (Object.keys(set).length === 0) throw new InvalidRequestException(TENANTS_REFUSALS.VALIDATION_FAILED.nothingToChange);

    const before = await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec()
      .catch(() => null);
    if (!before) throw new NotFoundException('KPM');

    const kpm = await this.kpms
      .findOneAndUpdate({ _id: kpmId, deletedAt: null }, { $set: set }, { new: true })
      .exec();
    if (!kpm) throw new NotFoundException('KPM');

    await this.audit.record(ctx, {
      action: 'kpm.identity_updated',
      targetCollection: 'kpms',
      targetId: kpmId,
      before: {
        branchName: before.branchName,
        address: before.address,
        contactPhone: before.contactPhone,
        fiscalYearStartMonth: before.fiscalYearStartMonth,
      },
      after: set,
    });

    return this.toView(kpm, ctx.reader);
  }
}
