import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { can, isOwnerReserved, Permission } from '@/modules/rbac/permissions';
import { REFUSED_IN_SUPPORT_SESSION, REQUIRED_PERMISSION } from './auth.decorators';
import { AUTH_GUARD_REFUSALS } from './auth.messages';

/**
 * Enforces `@RequirePermission`. A route with none declared needs only a session. A route marked
 * `@RefuseInSupportSession` is refused to every session.
 *
 * **A session's writes are not refused here** (P19.4-T2; ADR-0206 §4): `ViewOnlySessionGuard` runs first and refuses
 * every one by its method, `403 IMPERSONATION_READ_ONLY`, whatever permission the route declares. This guard's method
 * fallback, and a setup session's scope within it (ADR-0162), are gone with the setup session and write elevation.
 * `can()` still refuses a session every permission that is not read-like.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(execution: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission>(REQUIRED_PERMISSION, [
      execution.getHandler(),
      execution.getClass(),
    ]);

    const request = execution.switchToHttp().getRequest<{ context?: RequestContext }>();
    const ctx = request.context;

    /*
     * **A person's own account, in no session's hands** (ADR-0162 §4): its writes meet `ViewOnlySessionGuard` first;
     * this refuses a read of it too — the sessions a person is signed in on, their linked login.
     */
    if (ctx?.isImpersonating && this.reflector.getAllAndOverride<boolean>(REFUSED_IN_SUPPORT_SESSION, [
      execution.getHandler(),
      execution.getClass(),
    ])) {
      throw new DomainException(ErrorCode.PERM_DENIED, AUTH_GUARD_REFUSALS.PERM_DENIED.ownAccount, HttpStatus.FORBIDDEN);
    }

    if (!required) return true;
    if (ctx && can(ctx, required)) return true;

    // Somebody already inside the office, refused a power the Owner reserved, is told
    // exactly that. `PERM_DENIED` would be true and useless — a KPM Admin reading it
    // has no way to tell "ask the Owner" from "this is not for your role at all".
    const ownerReserved = ctx?.kpmId != null && isOwnerReserved(required);
    throw new DomainException(
      ownerReserved ? ErrorCode.PERM_OWNER_ONLY : ErrorCode.PERM_DENIED,
      ownerReserved ? AUTH_GUARD_REFUSALS.PERM_OWNER_ONLY.ownerOnly : AUTH_GUARD_REFUSALS.PERM_DENIED.noPermission,
      HttpStatus.FORBIDDEN,
      { permission: required },
    );
  }
}
