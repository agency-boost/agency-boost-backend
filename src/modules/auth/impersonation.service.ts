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
    private readonly signer: TokenSigner,
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

    const target = await this.users.findOne({ _id: targetUserId, deletedAt: null }).exec();
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

    return {
      // `sid` records who is really acting, so the resolved context can carry both.
      accessToken: this.signer.sign(
        { sub: targetUserId, sid: `imp:${ctx.userId}` },
        ttlSeconds,
      ),
      expiresAt: new Date(this.clock.now().getTime() + ttlSeconds * 1000),
    };
  }

  async end(ctx: RequestContext): Promise<void> {
    if (!ctx.isImpersonating) return;
    await this.audit.record(ctx, {
      action: 'impersonation.ended',
      targetCollection: 'users',
      targetId: ctx.userId,
    });
  }
}
