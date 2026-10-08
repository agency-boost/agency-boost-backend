import { BadRequestException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { User, UserDocument } from '@/modules/users/user.schema';
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
import { DEFAULT_KPM_SETTINGS, Kpm, KpmDocument, type KpmSubscription } from './kpm.schema';
import { countLeadersUsedPerOffice } from '@/modules/org/leader-limit';
import {
  subscriptionStateOf, validateSubscription, type SubscriptionInput, type SubscriptionState,
} from './subscription';

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
    // A company's named templates (ADR-0115): its first one is made with it.
    private readonly namedTemplates: NamedTemplateService,
  ) {}

  private require(ctx: RequestContext, permission: Parameters<typeof can>[1]): void {
    if (!can(ctx, permission)) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'You do not have permission to perform this action.',
        HttpStatus.FORBIDDEN,
        { permission },
      );
    }
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
  private async toViews(kpms: KpmDocument[]): Promise<KpmView[]> {
    if (kpms.length === 0) return [];

    const ownerIds = [...new Set(kpms.map((k) => k.ownerUserId).filter((id): id is string => Boolean(id)))];
    const [owners, companies] = await Promise.all([
      ownerIds.length > 0 ? this.users.find({ _id: { $in: ownerIds } }).exec() : Promise.resolve([]),
      this.companies.find({ _id: { $in: [...new Set(kpms.map((k) => k.companyId))] } }).exec(),
    ]);
    const byUser = new Map(owners.map((u) => [String(u._id), u]));
    const byCompany = new Map(companies.map((c) => [String(c._id), c]));

    return kpms.map((k) => {
      const owner = k.ownerUserId ? byUser.get(k.ownerUserId) : undefined;
      return {
        _id: String(k._id),
        companyId: k.companyId,
        companyName: byCompany.get(k.companyId)?.name ?? 'Unknown company',
        code: k.code,
        branchName: k.branchName,
        address: k.address ?? null,
        contactPhone: k.contactPhone ?? null,
        ownerUserId: k.ownerUserId ?? null,
        // An owner whose account has gone still gets a row: 'Unknown' says the office is
        // owned and the account is missing, which is a different problem from unowned.
        ownerName: k.ownerUserId ? (owner?.fullName ?? 'Unknown') : null,
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

  private async toView(kpm: KpmDocument): Promise<KpmView> {
    return (await this.toViews([kpm]))[0];
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
    const [views, leaders] = await Promise.all([
      this.toViews(kpms),
      countLeadersUsedPerOffice(this.memberships, ctx, kpms.map((k) => String(k._id))),
    ]);
    return views.map((view, i) => ({
      ...view,
      subscription: kpms[i].subscription ?? null,
      leadersUsed: leaders.get(view._id) ?? 0,
      subscriptionState: subscriptionStateOf(kpms[i], this.clock),
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
  async listCompanies(ctx: RequestContext): Promise<CompanyDocument[]> {
    this.require(ctx, 'company:crud');
    return this.companies.find({ deletedAt: null }).sort({ name: 1 }).exec();
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
      .find({ deletedAt: null, status: 'active' }, { name: 1 })
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

    let company: CompanyDocument;
    try {
      company = await this.companies.create({ name, slug, usesPlatformDefaults });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        const winner = await this.companies.findOne({ slug, deletedAt: null }).exec();
        throw this.slugTaken(slug, winner?.name ?? 'another company');
      }
      throw err;
    }

    // **Every company gets a ladder, at creation.** `memberships.orgLevelId` resolves
    // against it on every join, so a company without one is an office nobody can join —
    // and nothing would say so until somebody tried. ADR-0012 §3 settles that v1 ships
    // one seeded ladder; Super Admin edits it at /admin/org-levels afterwards.
    await this.orgLevels.seedDefaultLadder(String(company._id));

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
      await this.products.seedForCompany(String(company._id));
      await this.campaigns.seedForCompany(String(company._id));
    }

    /*
     * **Its first template, and its default** (ADR-0115 §3): *"{name} template"*, each kind a
     * published version 1 of the AgencyBoost defaults, or nothing for a company that declined them.
     * Approving a KPM request starts the office from it, so a company is never without one.
     */
    await this.namedTemplates.createFirst(ctx, company);

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
        usesPlatformDefaults,
      },
    });

    return company;
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
      `The slug "${slug}" already belongs to ${existingName}. Edit the slug to something unique.`,
      HttpStatus.CONFLICT,
      { slug, existingName },
    );
  }

  async createKpm(ctx: RequestContext, input: CreateKpmInput): Promise<KpmView> {
    this.require(ctx, 'kpm:create');

    const company = await this.companies.findOne({ _id: input.companyId, deletedAt: null }).exec();
    if (!company) throw new NotFoundException('Company');

    const clash = await this.kpms
      .findOne({ companyId: input.companyId, code: input.code, deletedAt: null })
      .exec();
    if (clash) {
      throw new DomainException(
        ErrorCode.TENANT_CODE_TAKEN,
        `KPM code ${input.code} is already used by ${company.name}.`,
        HttpStatus.CONFLICT,
        { companyId: input.companyId, code: input.code },
      );
    }

    /*
     * **The whole source, resolved and checked before the office row exists** (ADR-0115 §4): each
     * kind's own checks, the ratios against the taxonomy it will have and the checklist's training
     * links against its own modules. A refusal here leaves no office and no rows — there are no
     * transactions (ADR-0002), so checking first is the guarantee.
     */
    const plan = await this.provisioning.planFor(input.companyId, input.startFrom);

    const kpm = await this.kpms.create({
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
      },
    });

    return this.toView(kpm);
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
    who: { userId?: string; email?: string },
  ): Promise<KpmAdminView> {
    this.require(ctx, 'kpm:assign_owner');

    const kpm = await this.kpms
      .findOne({ _id: kpmId, deletedAt: null })
      .exec()
      // A malformed id is "not here", not a 500: these arrive from a URL, and an
      // uncaught CastError renders as INTERNAL_ERROR and is logged as unhandled.
      .catch(() => null);
    if (!kpm) throw new NotFoundException('KPM');

    const user = await this.resolveOwner(who);

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
        await this.hierarchy.activate(scoped, String(existing._id), { joinedAt: this.clock.now() });
      }
      return;
    }

    await this.hierarchy.create(scoped, { userId, role: 'ab', leaderId: null, status: 'active' });
  }

  private async resolveOwner(who: { userId?: string; email?: string }): Promise<UserDocument> {
    const email = who.email?.toLowerCase().trim();
    if (!who.userId && !email) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Name the new owner by email or by user id.',
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
        'That account is deactivated and cannot own an office.',
        HttpStatus.BAD_REQUEST,
        { userId: String(user._id) },
      );
    }
    return user;
  }

  /**
   * A tenant may not be left ownerless. Clearing the owner without naming a successor
   * would leave nobody able to grant admin access.
   */
  async clearOwner(ctx: RequestContext, kpmId: string): Promise<never> {
    this.require(ctx, 'kpm:assign_owner');
    throw new DomainException(
      ErrorCode.PERM_LAST_OWNER,
      'A KPM must always have an Owner. Transfer ownership instead of removing it.',
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
      this.companies.find({ deletedAt: null }).sort({ name: 1 }).exec(),
      this.kpms.find({ deletedAt: null }).exec(),
      this.memberships.findAcrossAllTenants(ctx, { status: 'active' }),
      // The **model**, not `KpmRequestService` — that service already depends on this
      // one, so injecting it back would be a cycle.
      this.kpmRequests.countDocuments({ status: 'pending', deletedAt: null }).exec(),
      // P3.5-T7 AC-5. The prototype's company meta line reads `Role ladder: Agent → AAB
      // → AB` (`Superadmin.html:311`); until the ladder was data there was nothing behind
      // it, and a literal would have been a sentence no data stood for.
      this.orgLevels.laddersByCompany(
        (await this.companies.find({ deletedAt: null }).select('_id').exec()).map((c) => String(c._id)),
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
      attention: this.attentionQueue(kpms, pendingRequests),
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
   * request (P3.5-T7), pending KPM registrations (P3.5-T2), template adoption and a
   * product publish (Phases 4 and 5). **Only one of its sources exists today**, so only
   * one kind of row is produced. A queue with one real row is honest; four invented ones
   * would make the screen look finished and tell the reader nothing true.
   */
  private attentionQueue(kpms: KpmDocument[], pendingRequests: number): AttentionItem[] {
    const items: AttentionItem[] = [];

    const unowned = kpms.filter((k) => !k.ownerUserId && k.status !== 'archived');
    if (unowned.length > 0) {
      items.push({
        tag: 'KPM owner',
        severity: 'structural',
        title:
          unowned.length === 1
            ? '1 office has no Owner'
            : `${unowned.length} offices have no Owner`,
        detail:
          'Nobody can administer an office until an Owner is assigned, and only the platform can assign one.',
        href: '/admin/tenants',
        actionLabel: 'Review',
      });
    }

    // The second of the prototype's four sources (`Superadmin.html:232-273`). Parity row
    // I-48 promised it would arrive with P3.5-T2; T2 built the entity, the endpoints and
    // the screen, and left the queue row behind — so the only route to that screen was a
    // nav item still flagged `upcoming`, which renders without an href. A shipped
    // surface nobody could reach.
    if (pendingRequests > 0) {
      items.push({
        tag: 'KPM request',
        severity: 'approval',
        title:
          pendingRequests === 1
            ? '1 office is waiting for a decision'
            : `${pendingRequests} offices are waiting for a decision`,
        detail:
          'Somebody has asked for an office and nobody has approved or declined it yet. Until one of those happens they have no way in.',
        href: '/admin/kpm-requests',
        actionLabel: 'Decide',
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
        const fullName = who?.fullName ?? 'Unknown';
        return {
          membershipId: String(r._id),
          fullName,
          email: who?.email ?? '',
          initials: initialsOf(fullName),
          kpmId: r.kpmId,
          kpmLabel: office.get(r.kpmId) ?? 'Unknown office',
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
  async readProfile(ctx: RequestContext, kpmId: string): Promise<KpmView | KpmAdminView> {
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
    return ctx.isSuperAdmin ? this.toAdminView(ctx, kpm) : this.toView(kpm);
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
    if (Object.keys(set).length === 0) throw new BadRequestException('Nothing to change.');

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

    return this.toView(kpm);
  }
}
