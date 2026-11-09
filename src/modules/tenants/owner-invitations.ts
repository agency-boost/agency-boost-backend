import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ROSTER_INVITATION } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { AUTH_REFUSALS } from '@/modules/auth/auth.messages';
import { AuthToken, type AuthTokenDocument } from '@/modules/auth/auth-token.schema';
import { PasswordService } from '@/modules/auth/password.service';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { MembershipRepository } from '@/modules/org/membership.repository';
import type { UserDocument } from '@/modules/users/user.schema';
import type { KpmDocument } from './kpm.schema';

/**
 * How many invitations one KPM's Owner may be sent within `OWNER_INVITATION_WINDOW_SECONDS` (ADR-0212 §2: *"limited
 * as a reset is"*) — `POST /auth/forgot-password`'s three an hour, so *Kirim ulang undangan* cannot be used to flood a
 * mailbox any faster than *Lupa kata sandi?* can.
 */
export const OWNER_INVITATION_LIMIT = 3;
export const OWNER_INVITATION_WINDOW_SECONDS = 60 * 60;

/** What sending an Owner's invitation answers: when it went, so the card reads *Diundang* at once. */
export interface OwnerInvitationSent {
  invitedAt: Date;
}

/**
 * **The Owner's invitation** (ADR-0212 §2; P19.4-T3 AC-6): to a KPM's Owner, by **email**, a one-time link to choose a
 * password — the member invitation's mechanism (ADR-0205 §10): a `password_reset` token the app's `/reset-password`
 * page consumes, alive for `ROSTER_INVITATION.TTL_DAYS`, worded for an Owner (`kpm.owner_invitation`). Setting the
 * password there proves the mailbox, which verifies the address (ADR-0190 §3).
 *
 * - **A new link revokes the old.** Every open reset link of the account is revoked before the new one is made, so
 *   only the latest invitation works.
 * - **The state**: `memberships.invitedAt` is stamped on the Owner's membership in that KPM — what *Diundang* reads.
 * - **Audited** as `kpm.owner_invited`, `after: { userId, email, resent }`, in the platform's log with the KPM as target.
 * - **Nothing by WhatsApp or SMS** (ADR-0212 §4, ADR-0010): the link is never put where a chat could carry it.
 *
 * Apart from `TenantService`, which builds the KPM and its Owner, so the specs that construct that service by hand do
 * not have to wire the mail; it is given to `TenantService` as an optional collaborator.
 */
@Injectable()
export class OwnerInvitations {
  constructor(
    private readonly passwords: PasswordService,
    @InjectModel(AuthToken.name) private readonly tokens: Model<AuthTokenDocument>,
    private readonly notifications: NotificationService,
    private readonly limiter: RateLimiter,
    private readonly memberships: MembershipRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** A password hash nobody holds the password to: what a new Owner's account is made with, as an import's is. */
  async unusablePassword(): Promise<string> {
    return this.passwords.hash(this.passwords.generateToken());
  }

  /**
   * **Refuse a resend past the limit** (`429 AUTH_RATE_LIMITED`, `details.retryAfterSeconds`), per KPM. Asked by *Kirim
   * ulang undangan* before anything is written; the first invitation, sent as the KPM is made, does not spend it.
   */
  limitResend(kpmId: string): void {
    const retryAfter = this.limiter.check(`owner-invitation:${kpmId}`, OWNER_INVITATION_LIMIT, OWNER_INVITATION_WINDOW_SECONDS);
    if (retryAfter === null) return;
    throw new DomainException(
      ErrorCode.AUTH_RATE_LIMITED,
      AUTH_REFUSALS.AUTH_RATE_LIMITED.tooMany({ minutes: Math.ceil(retryAfter / 60) }),
      HttpStatus.TOO_MANY_REQUESTS,
      { retryAfterSeconds: retryAfter },
    );
  }

  /** Send the Owner of `kpm` — `owner`, who has an account and a membership there — their invitation. */
  async send(
    ctx: RequestContext,
    kpm: KpmDocument,
    owner: UserDocument,
    options: { resent: boolean },
  ): Promise<OwnerInvitationSent> {
    const now = this.clock.now();
    const userId = String(owner._id);
    const kpmId = String(kpm._id);
    // Only the latest link works: any reset link still open for the account is revoked first.
    await this.tokens.updateMany(
      { userId, kind: 'password_reset', usedAt: null, revokedAt: null },
      { $set: { revokedAt: now, revokedReason: 'owner_invitation_resent' } },
    ).exec();
    const raw = this.passwords.generateToken();
    await this.tokens.create({
      userId,
      kind: 'password_reset',
      tokenHash: this.passwords.hashToken(raw),
      expiresAt: new Date(now.getTime() + ROSTER_INVITATION.TTL_DAYS * 24 * 60 * 60_000),
    });
    await this.notifications.send({
      userId,
      kpmId,
      templateId: NotificationTemplate.OWNER_INVITATION,
      payload: {
        token: raw,
        fullName: owner.fullName,
        office: `KPM ${kpm.code} · ${kpm.branchName}`,
        days: ROSTER_INVITATION.TTL_DAYS,
      },
    });
    // *Diundang*: the Owner's membership in this KPM, through the scoped repository with the office named.
    const scoped = RequestContext.superAdminInTenant(ctx.auditActors.actorUserId, kpmId);
    await this.memberships.updateMany(
      scoped,
      { userId, status: { $in: ['active', 'pending'] } },
      { $set: { invitedAt: now } },
    );
    await this.audit.record(ctx, {
      action: 'kpm.owner_invited',
      targetCollection: 'kpms',
      targetId: kpmId,
      after: { userId, email: owner.email, resent: options.resent },
    });
    return { invitedAt: now };
  }
}
