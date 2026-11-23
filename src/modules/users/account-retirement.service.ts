import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { render } from '@/common/i18n/sentence';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthToken, type AuthTokenDocument } from '@/modules/auth/auth-token.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import type { MembershipDocument } from '@/modules/org/membership.schema';
import { MemberInviteRepository } from '@/modules/org/org.repositories';
import { RemovalService } from '@/modules/org/removal.service';
import { UserInvitationRepository } from '@/modules/org/user-invitation.repository';
import { can } from '@/modules/rbac/permissions';
import { ownedBy } from '@/modules/tenants/kpm-owners';
import { Kpm, type KpmDocument } from '@/modules/tenants/kpm.schema';
import { ACCOUNT_RETIREMENT_REFUSALS } from './account-retirement.messages';
import { retiredEmailOf, User, type UserDocument } from './user.schema';

const SAY = ACCOUNT_RETIREMENT_REFUSALS;

/** The permission both routes require (roles §3.2; ADR-0289 §3). */
export const RETIRE_ACCOUNT = 'account:retire' as const;

/** The audit actions (labelled in `audit-labels.messages.ts`). */
export const ACCOUNT_RETIRED = 'account.retired' as const;
export const ACCOUNT_RETIRE_UNDONE = 'account.retire_undone' as const;

/** What `revokedReason` says on the sessions and links a retirement ends. */
const REVOKED_REASON = 'account retired';

/** One refusal, as the confirmation shows it in place of its button. */
export interface RetirementRefusal { code: string; message: string; details: Record<string, unknown> }

/** **What *Hapus akun* would do, before it is done** (`GET /admin/accounts/:userId/retirement`). */
export interface RetirementPreview {
  userId: string;
  fullName: string;
  email: string;
  /** The one live membership (v1: one per person), which retiring ends; `null` when they are in no KPM. */
  membership: { membershipId: string; kpmId: string; kpmName: string; kpmCode: string; status: string } | null;
  /** Every KPM where they have been a member, ended or not — whose history stays. */
  kpmsWithHistory: number;
  /** Why it is refused, if it is: its sentence in the reader's language. `null` when nothing stands in the way. */
  refusal: RetirementRefusal | null;
}

/** **What it did** (`POST /admin/accounts/:userId/retirement`). */
export interface RetirementResult {
  userId: string;
  fullName: string;
  retiredAt: string;
  /** The membership it ended, if any. */
  membershipEnded: { membershipId: string; kpmId: string } | null;
  invitationsCancelled: number;
}

/**
 * ***Hapus akun*: the Super Admin retires an account** (P19.31-T1;
 * [ADR-0289](../../../../docs/04-adr/0289-the-super-admin-may-retire-an-account-so-its-address-and-code-can-be-used-again-and-its-history-stays.md)).
 *
 * **Retiring is not erasing.** The login identity ends; nothing of the person's history moves or disappears:
 *
 * - **Refused** (`409`, each with its code and what to do first): an AgencyBoost team account
 *   (`ACCOUNT_RETIRE_PLATFORM_TEAM`); an owner of any KPM (`ACCOUNT_RETIRE_OWNER` — removed as owner first, never the
 *   last); anybody people report to in a live membership (`ACCOUNT_RETIRE_HAS_REPORTS` — moved first). Unknown or already
 *   retired: `404`. Only the Super Admin as themselves (`account:retire`, blocked in a support session).
 * - **The account**: soft-deleted (`deletedAt`, `deletedByUserId`, `deletedReason`), its address moved to the tombstone
 *   `retired+<userId>@akun-dihapus.invalid` (the email index is unique over soft-deleted rows too), its name kept; its
 *   agent code released by `deletedAt` (that index covers live rows only). Its refresh tokens and every unused link are
 *   revoked, so nothing signs in as it again — `AuthGuard`'s read of the account filters `deletedAt` too.
 * - **Its open invitations** — *Tambah user*'s made for it or to its address, *+ Tambah agent*'s waiting on its code —
 *   cancelled.
 * - **Its live membership** (v1: one) **ended through the removal itself** (`RemovalService.depart`: status *removed*,
 *   the open edge closed, a `removed` event, the leader's counts, `member.removed` in the KPM's log, the departure hooks),
 *   as the Super Admin inside that KPM — without the notice, on a login that has ended. Every other membership, and all
 *   history, stays as it is.
 * - **All or nothing** (the provisioning undo pattern): the account, the links and the invitations are written first,
 *   each leaving its undo; the membership's end is last, and if it fails every undo runs, newest first, and
 *   `account.retire_undone` says so.
 * - **Audited** `account.retired` in the platform's log and the KPM's whose membership it ended: who, the reason, the
 *   membership, the invitations — **the original address in `before`**, the one place it is kept.
 */
@Injectable()
export class AccountRetirementService {
  private readonly logger = new Logger(AccountRetirementService.name);

  constructor(
    // `users`, `authTokens` and `kpms` are platform-global; memberships and invitations go through their repositories.
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(AuthToken.name) private readonly tokens: Model<AuthTokenDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    private readonly members: MembershipRepository,
    private readonly invitations: UserInvitationRepository,
    private readonly memberInvites: MemberInviteRepository,
    private readonly removals: RemovalService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** **`GET /admin/accounts/:userId/retirement`** — what would end, what stays, and a refusal if one applies. */
  async preview(ctx: RequestContext, userId: string): Promise<RetirementPreview> {
    const { account, membership, kpm } = await this.read(ctx, userId);
    const refused = await this.refusalOf(ctx, account, membership, kpm);
    const refusal: RetirementRefusal | null = refused
      ? { code: refused.code, message: render(refused.sentence, ctx.reader), details: (refused.details ?? {}) as Record<string, unknown> }
      : null;
    const history = await this.kpmsWithHistory(String(account._id));
    return {
      userId: String(account._id),
      fullName: account.fullName,
      email: account.email,
      membership: membership && kpm ? {
        membershipId: String(membership._id), kpmId: String(kpm._id), kpmName: kpm.branchName, kpmCode: kpm.code,
        status: membership.status,
      } : null,
      kpmsWithHistory: history,
      refusal,
    };
  }

  /** **`POST /admin/accounts/:userId/retirement`** — `{ reason, fullName }`, the name typed to confirm. */
  async retire(ctx: RequestContext, userId: string, input: { reason: string; fullName: string }): Promise<RetirementResult> {
    const { account, membership, kpm } = await this.read(ctx, userId);
    if (normalised(input.fullName) !== normalised(account.fullName)) {
      throw new DomainException(ErrorCode.VALIDATION_FAILED, SAY.VALIDATION_FAILED.nameMismatch, HttpStatus.BAD_REQUEST, {
        field: 'fullName',
      });
    }
    const refusal = await this.refusalOf(ctx, account, membership, kpm);
    if (refusal) throw refusal;

    const now = this.clock.now();
    const id = String(account._id);
    const reason = input.reason.trim();
    const original = { email: account.email, status: account.status };
    const undo: Array<() => Promise<unknown>> = [];

    try {
      // 1. The account: soft-deleted, its address moved to its tombstone, its name kept.
      const { modifiedCount } = await this.users.updateOne(
        { _id: id, deletedAt: null },
        {
          $set: {
            deletedAt: now, deletedByUserId: ctx.auditActors.actorUserId ?? ctx.userId, deletedReason: reason,
            email: retiredEmailOf(id),
          },
        },
      ).exec();
      if (modifiedCount === 0) throw new NotFoundException('User');
      undo.push(() => this.users.updateOne(
        { _id: id },
        { $set: { deletedAt: null, deletedByUserId: null, deletedReason: null, email: original.email } },
      ).exec());

      // 2. Every session and unused link: nothing signs in as it, nothing resets it.
      const live = await this.tokens.find({ userId: id, revokedAt: null, usedAt: null }).select('_id').exec();
      const tokenIds = live.map((t) => t._id);
      if (tokenIds.length > 0) {
        await this.tokens.updateMany({ _id: { $in: tokenIds } }, { $set: { revokedAt: now, revokedReason: REVOKED_REASON } }).exec();
        undo.push(() => this.tokens.updateMany({ _id: { $in: tokenIds } }, { $set: { revokedAt: null, revokedReason: null } }).exec());
      }

      // 3. Its open invitations.
      const byActor = { cancelledAt: now };
      const cancelled = await this.invitations.cancelWaitingForAccountAcrossTenants(
        ctx, { userId: id, email: original.email }, { ...byActor, cancelledByUserId: ctx.auditActors.actorUserId ?? ctx.userId },
      );
      undo.push(() => this.invitations.reopenAcrossTenants(ctx, cancelled));
      const cancelledInvites = account.agentCode && account.companyId
        ? await this.memberInvites.cancelPendingForCodeAcrossTenants(ctx, account.companyId, account.agentCode, {
          ...byActor, cancelledByMembershipId: null,
        })
        : [];
      undo.push(() => this.memberInvites.reopenAcrossTenants(ctx, cancelledInvites));

      // 4. Last: the live membership, ended by the removal itself, as the Super Admin inside its KPM.
      if (membership && kpm) {
        const inKpm = RequestContext.superAdminInKpm(ctx, String(kpm._id));
        await this.removals.depart(inKpm, membership, {
          at: now, reason, notify: false, after: { accountRetired: true },
        });
      }

      const result: RetirementResult = {
        userId: id,
        fullName: account.fullName,
        retiredAt: now.toISOString(),
        membershipEnded: membership && kpm ? { membershipId: String(membership._id), kpmId: String(kpm._id) } : null,
        invitationsCancelled: cancelled.length + cancelledInvites.length,
      };
      const entry = {
        action: ACCOUNT_RETIRED,
        targetCollection: 'users',
        targetId: id,
        targetMembershipId: membership ? String(membership._id) : null,
        // The original address is kept here and nowhere else (ADR-0289 §1, §5).
        before: { email: original.email, status: original.status, membership: membership ? { id: String(membership._id), status: membership.status } : null },
        after: {
          reason, email: retiredEmailOf(id), membershipEnded: result.membershipEnded,
          userInvitationsCancelled: cancelled, memberInvitesCancelled: cancelledInvites,
        },
      };
      await this.audit.recordInScopesOrFail(ctx, [
        { kpmId: null, entry },
        ...(kpm ? [{ kpmId: String(kpm._id), entry }] : []),
      ]).catch((err: unknown) => {
        // Everything is written: the account is retired whether or not its row landed. Said loudly, never undone.
        this.logger.error({ err, userId: id }, 'an account was retired but its audit row could not be written');
      });
      return result;
    } catch (err) {
      for (const step of [...undo].reverse()) {
        try {
          await step();
        } catch (undoErr) {
          this.logger.error({ err: undoErr, userId: id }, 'a retirement could not undo one of its writes');
        }
      }
      if (undo.length > 0) {
        await this.audit.record(ctx, {
          action: ACCOUNT_RETIRE_UNDONE,
          targetCollection: 'users',
          targetId: id,
          after: { writesUndone: undo.length, reason: err instanceof DomainException ? err.code : 'write_failed' },
        });
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------------------------- parts

  private require(ctx: RequestContext): void {
    if (!ctx.isSuperAdmin || ctx.isImpersonating || !can(ctx, RETIRE_ACCOUNT)) throw new PermissionDeniedException(RETIRE_ACCOUNT);
  }

  /** The live account (`404` for an unknown or retired one), its one live membership, and that membership's KPM. */
  private async read(ctx: RequestContext, userId: string): Promise<{
    account: UserDocument; membership: MembershipDocument | null; kpm: KpmDocument | null;
  }> {
    this.require(ctx);
    const account = isValidObjectId(userId) ? await this.users.findOne({ _id: userId, deletedAt: null }).exec() : null;
    if (!account) throw new NotFoundException('User');
    const membership = await this.members.liveForUserAnywhere(String(account._id));
    const kpm = membership ? await this.kpms.findOne({ _id: membership.kpmId }).exec() : null;
    return { account, membership, kpm };
  }

  /** **The first refusal that applies** (ADR-0289 §2), or `null`. */
  private async refusalOf(
    ctx: RequestContext, account: UserDocument, membership: MembershipDocument | null, kpm: KpmDocument | null,
  ): Promise<DomainException | null> {
    if (account.platformRole === 'super_admin') {
      return new DomainException(
        ErrorCode.ACCOUNT_RETIRE_PLATFORM_TEAM, SAY.ACCOUNT_RETIRE_PLATFORM_TEAM.platformTeam, HttpStatus.CONFLICT,
        { userId: String(account._id) },
      );
    }
    const owned = await this.kpms.find({ ...ownedBy(String(account._id)), deletedAt: null }).select('branchName code').exec();
    if (owned.length > 0) {
      return new DomainException(
        ErrorCode.ACCOUNT_RETIRE_OWNER,
        SAY.ACCOUNT_RETIRE_OWNER.owner({ kpms: owned.map((k) => k.branchName).join(', ') }),
        HttpStatus.CONFLICT,
        { userId: String(account._id), kpms: owned.map((k) => ({ kpmId: String(k._id), code: k.code })) },
      );
    }
    if (membership && kpm) {
      const reports = await this.members.count(
        RequestContext.superAdminInKpm(ctx, String(kpm._id)), { leaderId: String(membership._id), status: { $ne: 'removed' } },
      );
      if (reports > 0) {
        return new DomainException(
          ErrorCode.ACCOUNT_RETIRE_HAS_REPORTS,
          SAY.ACCOUNT_RETIRE_HAS_REPORTS.reports({ count: reports, kpm: kpm.branchName }),
          HttpStatus.CONFLICT,
          { userId: String(account._id), membershipId: String(membership._id), kpmId: String(kpm._id), reports },
        );
      }
    }
    return null;
  }

  /** In how many KPMs the person has a membership of any status — the history that stays. */
  private async kpmsWithHistory(userId: string): Promise<number> {
    const rows = await this.members.kpmIdsOfUserAnywhere(userId);
    return rows.length;
  }
}

/** A name compared as a person types it: spaces collapsed, any case. */
function normalised(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLocaleLowerCase('id-ID');
}
