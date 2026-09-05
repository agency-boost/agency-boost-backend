import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext, TenantMembership } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { User, UserDocument } from '@/modules/users/user.schema';

/**
 * Builds the RequestContext once per request.
 *
 * Roles are resolved here rather than read from the token, which is what makes
 * revoking a grant take effect immediately (docs/02-specs/api/auth-and-sessions.md).
 *
 * Phase 2 knows about platform role and KPM ownership. Hierarchy membership —
 * AB/AAB/Agent, the leader edge, KPM Admin grants — arrives with the `memberships`
 * collection in Phase 3; until then a non-owner resolves to no membership, which is
 * the same valid state as a brand-new agent who has not joined an office.
 */
@Injectable()
export class ContextResolver {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
  ) {}

  async resolve(userId: string, impersonatorUserId: string | null = null): Promise<RequestContext> {
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

    return new RequestContext(userId, user.platformRole, membership, impersonatorUserId);
  }

  private async resolveMembership(userId: string): Promise<TenantMembership | null> {
    const owned = await this.kpms.findOne({ ownerUserId: userId, deletedAt: null }).exec();
    if (!owned) return null;

    return {
      membershipId: `owner:${String(owned._id)}`,
      kpmId: String(owned._id),
      // An Owner is a person in the office; their hierarchy role arrives in Phase 3
      // with the memberships collection. `ab` is the closest truthful placeholder and
      // grants nothing an Owner does not already hold.
      hierarchyRole: 'ab',
      status: 'active',
      isKpmOwner: true,
      isKpmAdmin: false,
    };
  }
}
