import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { can, type Permission } from '@/modules/rbac/permissions';
import { User, UserDocument } from '@/modules/users/user.schema';
import { PLATFORM_TEAM_REFUSALS as SAY } from './platform-team.messages';

/** One Super Admin, as *Tim Super Admin* lists them. */
export interface SuperAdminRow {
  userId: string;
  fullName: string;
  email: string;
  status: 'invited' | 'active' | 'deactivated';
  isYou: boolean;
}

/** Still able to act: a Super Admin who is not deactivated and not erased. */
const ACTIVE_SUPER_ADMIN = { platformRole: 'super_admin', deletedAt: null, status: { $ne: 'deactivated' } } as const;

/**
 * ***Tim Super Admin*** (P19.23-T6 AC-2; ADR-0279; spec §10: *"AgencyBoost staff only; add / revoke"*): the platform's
 * own people. `users.platformRole` is the role; this is the console's way to give and take it, after the first one the
 * CLI makes (`cli/create-super-admin.ts`).
 *
 * - **Add: an account that exists, has proved its address, and is in no KPM.** No account is made here — the person
 *   registers, verifies, and is added — so the platform's every power never goes to an address nobody has proved
 *   (`SUPER_ADMIN_UNVERIFIED`). A live KPM membership refuses (`SUPER_ADMIN_HAS_MEMBERSHIP`): a Super Admin is never a
 *   KPM role (spec §1). Adding somebody who already is one changes nothing and records nothing.
 * - **Revoke: never yourself, never the last.** Removing your own role is refused (`SUPER_ADMIN_SELF`) — another Super
 *   Admin does it, so every removal is a second person's act and nobody locks themselves out mid-session. The last
 *   active Super Admin is never removed (`SUPER_ADMIN_LAST`); two removals racing are checked again after the write and
 *   the second is undone, so the platform is never left with nobody.
 * - **Every change audited** in the platform's log, `super_admin.granted` / `.revoked`, the account as the target, the
 *   role before and after. Effective at the person's next request: `ContextResolver` reads the role on every one.
 *
 * Platform-level: `users` is global (invariant §2), and the membership check is the repository's named unscoped read.
 */
@Injectable()
export class PlatformTeamService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly memberships: MembershipRepository,
    private readonly audit: AuditService,
  ) {}

  private require(ctx: RequestContext, permission: Permission): void {
    if (!can(ctx, permission)) throw new PermissionDeniedException(permission);
  }

  /** **`GET /admin/platform/team`**: every Super Admin not erased, by name, the reader marked. */
  async list(ctx: RequestContext): Promise<SuperAdminRow[]> {
    this.require(ctx, 'super_admin:read');
    return this.team(ctx);
  }

  /** **`POST /admin/platform/team`**: make the account with this email a Super Admin. Answers the team. */
  async add(ctx: RequestContext, email: string): Promise<SuperAdminRow[]> {
    this.require(ctx, 'super_admin:grant');
    const address = email.trim().toLowerCase();
    const user = await this.users.findOne({ email: address, deletedAt: null }).exec();
    if (!user || user.status === 'deactivated') {
      const reason = user ? 'deactivated' : 'no_account';
      throw new DomainException(
        ErrorCode.SUPER_ADMIN_NO_ACCOUNT,
        user ? SAY.SUPER_ADMIN_NO_ACCOUNT.deactivated : SAY.SUPER_ADMIN_NO_ACCOUNT.noAccount,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { field: 'email', reason },
      );
    }
    if (user.platformRole === 'super_admin') return this.team(ctx);
    if (!user.emailVerifiedAt) {
      throw new DomainException(
        ErrorCode.SUPER_ADMIN_UNVERIFIED, SAY.SUPER_ADMIN_UNVERIFIED.unverified, HttpStatus.UNPROCESSABLE_ENTITY, { field: 'email' },
      );
    }
    const userId = String(user._id);
    if (await this.memberships.liveForUserAnywhere(userId)) {
      throw new DomainException(
        ErrorCode.SUPER_ADMIN_HAS_MEMBERSHIP, SAY.SUPER_ADMIN_HAS_MEMBERSHIP.member, HttpStatus.CONFLICT, { field: 'email' },
      );
    }

    const updated = await this.users
      .updateOne({ _id: userId, platformRole: { $ne: 'super_admin' } }, { $set: { platformRole: 'super_admin' } })
      .exec();
    if (updated.modifiedCount > 0) {
      await this.audit.record(ctx, {
        action: 'super_admin.granted',
        targetCollection: 'users',
        targetId: userId,
        before: { platformRole: 'none' },
        after: { platformRole: 'super_admin', email: user.email },
      });
    }
    return this.team(ctx);
  }

  /** **`DELETE /admin/platform/team/:userId`**: take the role away. Answers the team. */
  async revoke(ctx: RequestContext, userId: string): Promise<SuperAdminRow[]> {
    this.require(ctx, 'super_admin:revoke');
    const user = isValidObjectId(userId)
      ? await this.users.findOne({ _id: userId, platformRole: 'super_admin', deletedAt: null }).exec()
      : null;
    if (!user) throw new NotFoundException('User');
    if (String(user._id) === ctx.userId) {
      throw new DomainException(ErrorCode.SUPER_ADMIN_SELF, SAY.SUPER_ADMIN_SELF.self, HttpStatus.CONFLICT);
    }
    const others = await this.users.countDocuments({ ...ACTIVE_SUPER_ADMIN, _id: { $ne: user._id } }).exec();
    if (others === 0) throw this.last();

    const updated = await this.users
      .updateOne({ _id: user._id, platformRole: 'super_admin' }, { $set: { platformRole: 'none' } })
      .exec();
    if (updated.modifiedCount === 0) return this.team(ctx);
    // Two removals racing each saw the other: the second to land is undone, so one active Super Admin always remains.
    if (await this.users.countDocuments(ACTIVE_SUPER_ADMIN).exec() === 0) {
      await this.users.updateOne({ _id: user._id }, { $set: { platformRole: 'super_admin' } }).exec();
      throw this.last();
    }
    await this.audit.record(ctx, {
      action: 'super_admin.revoked',
      targetCollection: 'users',
      targetId: String(user._id),
      before: { platformRole: 'super_admin' },
      after: { platformRole: 'none', email: user.email },
    });
    return this.team(ctx);
  }

  private async team(ctx: RequestContext): Promise<SuperAdminRow[]> {
    const rows = await this.users
      .find({ platformRole: 'super_admin', deletedAt: null }, { fullName: 1, email: 1, status: 1 })
      .sort({ fullName: 1, _id: 1 })
      .lean()
      .exec();
    return (rows as unknown as { _id: unknown; fullName: string; email: string; status: SuperAdminRow['status'] }[])
      .map((u) => ({
        userId: String(u._id),
        fullName: u.fullName,
        email: u.email,
        status: u.status ?? 'active',
        isYou: String(u._id) === ctx.userId,
      }));
  }

  private last(): DomainException {
    return new DomainException(ErrorCode.SUPER_ADMIN_LAST, SAY.SUPER_ADMIN_LAST.last, HttpStatus.CONFLICT);
  }
}
