import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { can, isOwnerReserved, Permission } from '@/modules/rbac/permissions';
import { ALLOWED_WHILE_READ_ONLY, REFUSED_IN_SUPPORT_SESSION, REQUIRED_PERMISSION } from './auth.decorators';
import { AUTH_GUARD_REFUSALS } from './auth.messages';

/**
 * Methods that change nothing. Everything else is a write — including a request that
 * somehow arrives without a method, because the open answer is the wrong default for the
 * control this list backs.
 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Enforces `@RequirePermission`. A route with none declared needs only a session — unless
 * the session is a read-only support session, which may not write through an unannotated
 * route either, and a setup session writes only through a route whose permission is in its
 * scope (ADR-0162). A route marked `@RefuseInSupportSession` is refused to every session.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(execution: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission>(REQUIRED_PERMISSION, [
      execution.getHandler(),
      execution.getClass(),
    ]);

    const request = execution.switchToHttp()
      .getRequest<{ context?: RequestContext; method?: string }>();
    const ctx = request.context;

    /*
     * **A person's own account, in no session's hands** (ADR-0162 §4): read before the read-only test,
     * because an elevated session passes that one.
     */
    if (ctx?.isImpersonating && this.reflector.getAllAndOverride<boolean>(REFUSED_IN_SUPPORT_SESSION, [
      execution.getHandler(),
      execution.getClass(),
    ])) {
      throw new DomainException(ErrorCode.PERM_DENIED, AUTH_GUARD_REFUSALS.PERM_DENIED.ownAccount, HttpStatus.FORBIDDEN);
    }

    /*
     * The read-only guarantee cannot depend on a decorator being remembered (P4-T10).
     *
     * `can()` enforces it from the permission's verb, which is the right test — but only
     * for routes that declare a permission. Fourteen routes on `AuthController` declare
     * none, and four of them write: the exit review renamed an office Owner through
     * `PATCH /auth/me` from inside a session whose own response said `readOnly: true`.
     *
     * So the method decides here, where the verb cannot. It is the cruder test and that
     * is appropriate for a fallback: a read-shaped POST caught by it loses nothing but a
     * round trip, while a write that slips past costs the guarantee the Owner was given.
     */
    if (ctx?.impersonationReadOnly && !READ_METHODS.has(request.method as string)) {
      const exempt = this.reflector.getAllAndOverride<boolean>(ALLOWED_WHILE_READ_ONLY, [
        execution.getHandler(),
        execution.getClass(),
      ]);
      /*
       * **A setup session's scope, by the route's own permission** (ADR-0162 §2). A route that declares
       * none is never in it: the scope names permissions, and a write nobody annotated is the one this
       * fallback exists to refuse. `can()` below still asks whether the member holds it.
       */
      const inScope = required !== undefined && ctx.impersonationWriteScope.includes(required);
      if (!exempt && !inScope) {
        throw new DomainException(
          ErrorCode.PERM_DENIED,
          ctx.impersonationPurpose === 'setup'
            ? AUTH_GUARD_REFUSALS.PERM_DENIED.setupScope
            : AUTH_GUARD_REFUSALS.PERM_DENIED.readOnly,
          HttpStatus.FORBIDDEN,
          required ? { permission: required } : {},
        );
      }
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
