import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext, TenantMembership, isEffectiveCoreLeader } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { readerOf, type Reader } from '@/common/i18n/reader';
import { isLanguage, type Language } from '@/domain/constants/language';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { isEnded } from '@/modules/tenants/subscription';
import { User, UserDocument } from '@/modules/users/user.schema';
import { Membership, MembershipDocument } from '@/modules/org/membership.schema';
import { ProductDataGrant, ProductDataGrantDocument } from '@/modules/product-data/product-data-grant.schema';
import { AUTH_REFUSALS } from './auth.messages';

/**
 * Builds the RequestContext once per request.
 *
 * Roles are resolved here rather than read from the token, which is what makes
 * revoking a grant take effect immediately (docs/02-specs/api/auth-and-sessions.md).
 *
 * A user with no membership is valid, not an error — that is the person who has
 * registered and not yet joined an office.
 */
@Injectable()
export class ContextResolver {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Membership.name) private readonly memberships: Model<MembershipDocument>,
    // The office's today, for the end of its subscription (ADR-0112 §3). Never `new Date()`.
    private readonly clock: Clock,
    /*
     * **The person's *Kelola data produk* grant** (ADR-0260 §2; P19.15-T4 AC-2), read here on every request of an active
     * Owner or Admin, so giving, changing or removing it is in force from their next request. Optional so a spec that is
     * about something else may build the resolver without it: nobody then holds one.
     */
    @Optional() @InjectModel(ProductDataGrant.name) private readonly grants?: Model<ProductDataGrantDocument>,
  ) {}

  async resolve(
    userId: string,
    /**
     * The Super Admin behind a support session, or `null`. **A session only looks** (ADR-0206 §4; P19.4-T2): the
     * context is read-only whenever this is set. The guard passed the row's `readOnly` until then, which a second
     * Super Admin's elevation could turn off.
     */
    impersonatorUserId: string | null = null,
    /**
     * A support session **leaving** — the one route marked `AllowWhileOfficeUnavailable` (P13.2 exit
     * review): the office's suspension or archive is not refused, so an operator can end a session in
     * an office suspended under it. Ignored outside a session.
     */
    leavingSupport = false,
    /**
     * **The language the request's `Accept-Language` names** (P18.10-T5 AC-1), read by the guard, or `null`. The
     * request's reader is it, else the person's saved `users.locale` — off the row read here, no extra read — else a
     * reader who has chosen nothing. **Never the person's own choice in a support session**: it is neither read nor
     * written there (ADR-0179 §2), so the support person's screen's language, or nobody's.
     */
    headerLanguage: Language | null = null,
    /**
     * **The KPM a Super Admin works inside** (ADR-0268 §3; P19.17 F2): the request's `X-Kpm-Id`, read by the guard, or
     * `null`. Honoured **only for a `platformRole: 'super_admin'` account acting as themselves** — the context is then
     * that KPM's Owner's (`RequestContext.superAdminInKpm`, `can()`), whatever membership the account holds elsewhere.
     * **Ignored for everybody else**, a support session included (its user is the member, never a Super Admin), so a
     * stale header left in a browser after a sign-in as somebody else changes nothing. A KPM that does not exist, or has
     * been deleted, is `404 NOT_FOUND`; a suspended or archived one is entered — the Super Admin is who mends it.
     */
    enteredKpmId: string | null = null,
  ): Promise<RequestContext> {
    const user = await this.users.findOne({ _id: userId, deletedAt: null }).exec();
    if (!user) {
      throw new DomainException(
        ErrorCode.AUTH_TOKEN_INVALID,
        AUTH_REFUSALS.AUTH_TOKEN_INVALID.noLongerValid,
        HttpStatus.UNAUTHORIZED,
      );
    }
    const stored = impersonatorUserId === null && isLanguage(user.locale) ? user.locale : null;
    const reader = readerOf({ header: headerLanguage, stored });
    // Every refusal below is the person's own, so it is written in their language, saved or sent (`writtenFor`).
    if (user.status === 'deactivated') {
      throw new DomainException(
        ErrorCode.AUTH_ACCOUNT_DEACTIVATED,
        AUTH_REFUSALS.AUTH_ACCOUNT_DEACTIVATED.deactivated,
        HttpStatus.FORBIDDEN,
      ).writtenFor(reader);
    }

    if (enteredKpmId !== null && user.platformRole === 'super_admin' && impersonatorUserId === null) {
      return RequestContext.superAdminInKpm(
        new RequestContext(userId, 'super_admin', null, null, null, user.mustChangePassword === true, false, reader),
        await this.enteredKpm(enteredKpmId, reader),
      );
    }

    const membership = await this.resolveMembership(userId);

    // A suspended office short-circuits every request from its members, with a code
    // distinct from a permission failure so the UI can explain it.
    if (membership) {
      const kpm = await this.kpms.findOne({ _id: membership.kpmId, deletedAt: null }).exec();
      /*
       * **The office is named in each refusal** (ADR-0112 §4, P13.2-T3 AC-9): the app replaces
       * itself with a page that says which office and what happened, and it has nothing else to
       * read that from — every other request meets the same refusal. Code and branch only: what a
       * member already knows about their own office.
       *
       * Each sentence is true for the Owner too, who reads it as well: *"Contact your KPM Owner"*
       * was this refusal's advice to the one person it could not help.
       */
      const office = kpm ? { kpmCode: kpm.code, branch: kpm.branchName } : undefined;
      const exempt = leavingSupport && impersonatorUserId !== null;
      if (kpm?.status === 'suspended' && !exempt) {
        throw new DomainException(
          ErrorCode.TENANT_SUSPENDED,
          AUTH_REFUSALS.TENANT_SUSPENDED.suspended,
          HttpStatus.FORBIDDEN,
          office,
        ).writtenFor(reader);
      }
      if (kpm?.status === 'archived' && !exempt) {
        throw new DomainException(
          ErrorCode.TENANT_ARCHIVED,
          AUTH_REFUSALS.TENANT_ARCHIVED.archived,
          HttpStatus.FORBIDDEN,
          office,
        ).writtenFor(reader);
      }
      /*
       * **The end of a subscription, beside the suspension and after it** (ADR-0112 §3): a
       * suspended or archived office keeps its own code, which wins. From 00:00 of the office day
       * after the end date — the office's day, through the clock port, never the server's — unless
       * the office is kept active.
       *
       * **Never in a support session.** An operator looking into an ended office is how somebody
       * finds out why its members cannot get in; refusing them too would leave nobody able to look.
       * A suspended office stays refused to them, as it always was. The Super Admin is nobody's
       * member, so never reaches this branch at all.
       */
      if (kpm && impersonatorUserId === null && isEnded(kpm, this.clock)) {
        throw new DomainException(
          ErrorCode.TENANT_SUBSCRIPTION_ENDED,
          AUTH_REFUSALS.TENANT_SUBSCRIPTION_ENDED.ended({ endDate: kpm.subscription?.endDate ?? '' }),
          HttpStatus.FORBIDDEN,
          { endDate: kpm.subscription?.endDate ?? null, ...office },
        ).writtenFor(reader);
      }
    }

    return new RequestContext(
      userId, user.platformRole, membership, impersonatorUserId, null,
      user.mustChangePassword === true,
      // Every session, and never outside one: somebody acting as themselves is not being restrained.
      impersonatorUserId !== null,
      reader,
      await this.productDataCompaniesOf(userId, membership),
    );
  }

  /**
   * **The KPM named by `X-Kpm-Id`, or `404`** (ADR-0268 §3): an id that is not an ObjectId is refused before it reaches
   * the query, so a malformed header is a `404`, never a cast error's `500`. The id is read back from the row.
   */
  private async enteredKpm(kpmId: string, reader: Reader): Promise<string> {
    const kpm = isValidObjectId(kpmId)
      ? await this.kpms.findOne({ _id: kpmId, deletedAt: null }).select('_id').exec()
      : null;
    if (!kpm) throw new NotFoundException('KPM').writtenFor(reader);
    return String(kpm._id);
  }

  /**
   * **The companies their *Kelola data produk* grant ticks** (ADR-0260 §2): read only for an **active KPM Owner or KPM
   * Admin**, who alone may hold it — anybody else is answered empty without a read, so an agent's request costs nothing
   * more. A grant removed, or an Admin whose access the Owner took away, holds nothing from the next request. In a
   * support session it is read as for the person, so the session sees their *Data produk* — read-only, as every
   * session is (`can()`, by the permission's verb).
   */
  private async productDataCompaniesOf(userId: string, membership: TenantMembership | null): Promise<readonly string[]> {
    if (!this.grants || membership?.status !== 'active' || !(membership.isKpmOwner || membership.isKpmAdmin)) return [];
    const grant = await this.grants
      .findOne({ userId, revokedAt: null, deletedAt: null }, { companyIds: 1 })
      .lean()
      .exec() as { companyIds?: string[] } | null;
    return grant?.companyIds ?? [];
  }

  /**
   * The real membership row, from Phase 3 onward.
   *
   * v1 allows one live membership per person, so this is a single lookup. `pending` is
   * resolved as well as `active`: someone waiting on approval has a membership and a
   * KPM, and telling them so is what lets the app say "waiting for your leader" rather
   * than "you are in no office".
   *
   * Ownership is read from the office, not stored on the membership — `kpms.ownerUserId`
   * is the single writer, and P2 made assigning it the only way it changes.
   */
  private async resolveMembership(userId: string): Promise<TenantMembership | null> {
    const membership = await this.memberships
      .findOne({ userId, status: { $in: ['active', 'pending'] }, deletedAt: null })
      .exec();
    if (!membership) return null;

    const owned = await this.kpms
      .findOne({ _id: membership.kpmId, ownerUserId: userId, deletedAt: null })
      .exec();

    return {
      membershipId: String(membership._id),
      kpmId: membership.kpmId,
      // The rung a permission grant is compared against (P4-T9). Denormalised onto the
      // membership precisely so this path stays two lookups rather than three.
      orgLevelCode: membership.orgLevelCode,
      hierarchyRole: membership.role,
      status: membership.status,
      isKpmOwner: owned !== null,
      isKpmAdmin: membership.adminAccess?.isKpmAdmin ?? false,
      // Leadership is the graph, not the role (OD-23).
      directCount: membership.directCounts?.total ?? 0,
      /*
       * ADR-0159 §4: **the effective Core Leader**, read from the membership on every request — the tag on a leader
       * class, so tagging or untagging somebody, or moving them off a leader rung, takes effect on their next call.
       */
      isCoreLeader: isEffectiveCoreLeader(membership),
    };
  }
}
