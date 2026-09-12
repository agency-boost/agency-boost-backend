import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { can, isOwnerReserved, Permission } from '@/modules/rbac/permissions';
import { ALLOWED_WHILE_READ_ONLY, REQUIRED_PERMISSION } from './auth.decorators';

/**
 * Methods that change nothing. Everything else is a write — including a request that
 * somehow arrives without a method, because the open answer is the wrong default for the
 * control this list backs.
 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Enforces `@RequirePermission`. A route with none declared needs only a session — unless
 * the session is a read-only support session, which may not write through an unannotated
 * route either.
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
      if (!exempt) {
        throw new DomainException(
          ErrorCode.PERM_DENIED,
          'This is a read-only support session. Ask the office to make the change, or '
            + 'request write access from a second Super Admin.',
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
      ownerReserved
        ? 'Only this office’s Owner can do that.'
        : 'You do not have permission to perform this action.',
      HttpStatus.FORBIDDEN,
      { permission: required },
    );
  }
}
