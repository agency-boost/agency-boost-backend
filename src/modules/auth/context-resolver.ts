import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext, TenantMembership } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
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
      if (kpm?.status === 'suspended') {
        throw new DomainException(
          ErrorCode.TENANT_SUSPENDED,
          'This office is suspended. Contact your KPM Owner.',
          HttpStatus.FORBIDDEN,
        );
      }
      if (kpm?.status === 'archived') {
        throw new DomainException(
          ErrorCode.TENANT_ARCHIVED,
          'This office is archived and read-only.',
          HttpStatus.FORBIDDEN,
        );
      }
    }

    return new RequestContext(
      userId, user.platformRole, membership, impersonatorUserId, null,
      user.mustChangePassword === true,
      // Never outside a session: somebody acting as themselves is not being restrained.
      impersonatorUserId !== null && impersonationReadOnly,
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
    };
  }
}
