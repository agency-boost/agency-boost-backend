import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { AuditService } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { can } from '@/modules/rbac/permissions';
import { User, UserDocument } from '@/modules/users/user.schema';

/** What the switch answers: the account, its flag now, and how many memberships carry the copy. */
export interface TestAccountSet {
  userId: string;
  testAccount: boolean;
  memberships: number;
}

/**
 * ***Akun tes*, the Super Admin's switch on *Anggota*'s detail** (P19.23-T3 AC-1; ADR-0267 §1; ADR-0277).
 *
 * A test account is never listed, counted, summed or ranked in any KPM. Migration `0065` flagged the accounts whose names
 * said so; everybody else is flagged — or unflagged, when one was flagged by mistake — here.
 *
 * - **Both copies, together** (ADR-0267 §1): `users.testAccount`, the source, and `memberships.testAccount` on every
 *   membership the person holds in any KPM, which is what each read of a KPM's members filters on. The membership write
 *   goes through the named cross-tenant method (`setTestAccountAcrossTenants`): identity is global and the Super Admin is
 *   in no office.
 * - **The Super Admin's alone, as themselves** (`test_account:set`): every tenant role is refused by the guard and here,
 *   and a support session — whose context is the member's — holds no platform grant. A Super Admin's own account is no
 *   member of anything and is `404` here, as an id that names nobody is.
 * - **Audited** as `user.test_account_set`, before → after, naming the KPMs the person is in (`after.kpmIds`).
 * - Setting the flag it already has writes nothing and records nothing; the answer is the same.
 */
@Injectable()
export class TestAccounts {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly memberships: MembershipRepository,
    private readonly audit: AuditService,
  ) {}

  async set(ctx: RequestContext, userId: string, testAccount: boolean): Promise<TestAccountSet> {
    if (!ctx.isSuperAdmin || ctx.isImpersonating || !can(ctx, 'test_account:set')) {
      throw new PermissionDeniedException('test_account:set');
    }
    const user = isValidObjectId(userId)
      ? await this.users.findOne({ _id: userId, deletedAt: null }).select('testAccount platformRole').exec()
      : null;
    if (!user || user.platformRole === 'super_admin') throw new NotFoundException('User');

    const held = await this.memberships.findAcrossAllTenants(ctx, { userId });
    const kpmIds = [...new Set(held.map((m) => m.kpmId))].sort();
    const before = user.testAccount === true;
    if (before === testAccount) return { userId, testAccount, memberships: held.length };

    await this.users.updateOne({ _id: userId }, { $set: { testAccount } }).exec();
    const memberships = await this.memberships.setTestAccountAcrossTenants(ctx, userId, testAccount);
    await this.audit.record(ctx, {
      action: 'user.test_account_set',
      targetCollection: 'users',
      targetId: userId,
      before: { testAccount: before },
      after: { testAccount, memberships, kpmIds },
    });
    return { userId, testAccount, memberships };
  }
}
