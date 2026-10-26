import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext, TenantMembership, isEffectiveCoreLeader } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { formatDate } from '@/common/format/format';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { isEnded } from '@/modules/tenants/subscription';
import { User, UserDocument } from '@/modules/users/user.schema';
import { Membership, MembershipDocument } from '@/modules/org/membership.schema';

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
  ) {}

  async resolve(
    userId: string,
    impersonatorUserId: string | null = null,
    /**
     * Whether the support session may write (P4-T10).
     *
     * Passed in by the guard, which has already looked the session up to check it is
     * live — reading it a second time here would be a second question about the same row.
     */
    impersonationReadOnly = false,
    /**
     * A support session **leaving** — the one route marked `AllowWhileOfficeUnavailable` (P13.2 exit
     * review): the office's suspension or archive is not refused, so an operator can end a session in
     * an office suspended under it. Ignored outside a session.
     */
    leavingSupport = false,
    /**
     * A setup session's write scope, off the same session row (ADR-0162 §2). Ignored outside a session.
     */
    impersonationWriteScope: readonly string[] = [],
  ): Promise<RequestContext> {
    const user = await this.users.findOne({ _id: userId, deletedAt: null }).exec();
    if (!user) {
      throw new DomainException(
        ErrorCode.AUTH_TOKEN_INVALID,
        'Your session is no longer valid. Sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (user.status === 'deactivated') {
      throw new DomainException(
        ErrorCode.AUTH_ACCOUNT_DEACTIVATED,
        'This account has been deactivated.',
        HttpStatus.FORBIDDEN,
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
          'This office is suspended, so nobody in it can use AgencyBoost until it is reactivated. '
            + 'The office’s Owner can ask AgencyBoost about it.',
          HttpStatus.FORBIDDEN,
          office,
        );
      }
      if (kpm?.status === 'archived' && !exempt) {
        throw new DomainException(
          ErrorCode.TENANT_ARCHIVED,
          'This office is archived. Its records are kept, and nobody in it can use AgencyBoost.',
          HttpStatus.FORBIDDEN,
          office,
        );
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
          `This office’s subscription ended on ${formatDate(kpm.subscription?.endDate ?? '')}. Nobody in it can use `
            + 'AgencyBoost until it is renewed. Contact AgencyBoost.',
          HttpStatus.FORBIDDEN,
          { endDate: kpm.subscription?.endDate ?? null, ...office },
        );
      }
    }

    return new RequestContext(
      userId, user.platformRole, membership, impersonatorUserId, null,
      user.mustChangePassword === true,
      // Never outside a session: somebody acting as themselves is not being restrained.
      impersonatorUserId !== null && impersonationReadOnly,
      impersonatorUserId !== null ? Object.freeze([...impersonationWriteScope]) : [],
    );
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
