import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { User, UserDocument } from '@/modules/users/user.schema';
import { AuthToken, AuthTokenDocument } from './auth-token.schema';
import { PasswordService } from './password.service';
import { TokenSigner } from './token-signer';

export const IMPERSONATION_MAX_MINUTES = 60;

/**
 * Support impersonation, time-boxed and dually attributed.
 *
 * The whole feature is defensible only because every action it produces records both
 * the real Super Admin and the person they acted as. That is why impersonating another
 * Super Admin is forbidden to everyone: it would erase exactly that distinction.
 */
@Injectable()
export class ImpersonationService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(AuthToken.name) private readonly tokens: Model<AuthTokenDocument>,
    private readonly signer: TokenSigner,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async start(
    ctx: RequestContext,
    targetUserId: string,
    reason: string,
    durationMinutes = IMPERSONATION_MAX_MINUTES,
  ): Promise<{ accessToken: string; expiresAt: Date }> {
    if (!can(ctx, 'impersonation:start')) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'Only a Super Admin can impersonate a user.',
        HttpStatus.FORBIDDEN,
        { permission: 'impersonation:start' },
      );
    }
    if (ctx.isImpersonating) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'You are already impersonating. End that session first.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!reason?.trim()) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'A reason is required to impersonate a user.',
        HttpStatus.BAD_REQUEST,
        { field: 'reason' },
      );
    }

    const target = await this.users
      .findOne({ _id: targetUserId, deletedAt: null })
      .exec()
      // A malformed id is "not here", not a 500: these arrive from a URL, and an
      // uncaught CastError renders as INTERNAL_ERROR and is logged as unhandled.
      .catch(() => null);
    if (!target) throw new NotFoundException('User');

    if (target.platformRole === 'super_admin') {
      // Granted to nobody, deliberately — see the denial row in the permission matrix.
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'A Super Admin cannot be impersonated.',
        HttpStatus.FORBIDDEN,
        { permission: 'impersonation:target_super_admin' },
      );
    }
    if (String(target._id) === ctx.userId) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'You cannot impersonate yourself.',
        HttpStatus.FORBIDDEN,
      );
    }

    const owned = await this.kpms.findOne({ ownerUserId: targetUserId, deletedAt: null }).exec();
    if (owned && owned.status !== 'active') {
      throw new DomainException(
        ErrorCode.TENANT_SUSPENDED,
        'That office is suspended; impersonation is refused.',
        HttpStatus.FORBIDDEN,
      );
    }

    const minutes = Math.min(Math.max(1, Math.floor(durationMinutes)), IMPERSONATION_MAX_MINUTES);
    const ttlSeconds = minutes * 60;

    await this.audit.record(ctx, {
      action: 'impersonation.started',
      targetCollection: 'users',
      targetId: targetUserId,
      after: { reason: reason.trim(), minutes },
    });

    // `sid` records who is really acting, so the resolved context can carry both.
    const accessToken = this.signer.sign({ sub: targetUserId, sid: `imp:${ctx.userId}` }, ttlSeconds);
    const expiresAt = new Date(this.clock.now().getTime() + ttlSeconds * 1000);

    /**
     * **The session, so that ending it can mean something.**
     *
     * The access token is a stateless JWT: nothing about presenting it consults the
     * database, which is what makes every other request cheap. It also meant `end()` had
     * nothing to revoke — it wrote an audit row and the token stayed valid for the rest
     * of its hour. Anyone holding a copy kept acting as the target.
     *
     * The row is keyed by the token's own hash, like every other credential here, so the
     * guard can ask one indexed question and only for the rare request that carries an
     * `imp:` session.
     */
    await this.tokens.create({
      userId: targetUserId,
      kind: 'impersonation',
      tokenHash: this.passwords.hashToken(accessToken),
      // The real operator, so an audit reader can group a session by who ran it.
      familyId: ctx.userId,
      expiresAt,
      usedAt: null,
      revokedAt: null,
      revokedReason: null,
    });

    return { accessToken, expiresAt };
  }

  /**
   * End the session, and mean it.
   *
   * Every open impersonation row for this person is revoked, not just the token that made
   * this request: an operator who somehow holds two should lose both, and the caller
   * cannot present a token it does not have. The guard refuses a revoked session from the
   * next request onward.
   */
  async end(ctx: RequestContext): Promise<void> {
    if (!ctx.isImpersonating) return;

    await this.tokens
      .updateMany(
        { userId: ctx.userId, kind: 'impersonation', revokedAt: null },
        { $set: { revokedAt: this.clock.now(), revokedReason: 'session ended' } },
      )
      .exec();

    await this.audit.record(ctx, {
      action: 'impersonation.ended',
      targetCollection: 'users',
      targetId: ctx.userId,
    });
  }

  /**
   * Is this impersonation token still live?
   *
   * Called by `AuthGuard`, and **only** for a token carrying an `imp:` session — a
   * refresh-token round trip on every ordinary request would be the wrong trade. A
   * session with no row is refused too: a token minted before this existed, or one whose
   * row was pruned, is not something to trust.
   */
  async isLive(rawToken: string): Promise<boolean> {
    const row = await this.tokens
      .findOne({ tokenHash: this.passwords.hashToken(rawToken), kind: 'impersonation' })
      .exec();
    return Boolean(row && !row.revokedAt && row.expiresAt.getTime() > this.clock.now().getTime());
  }
}
