import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { can, isOwnerReserved, Permission } from '@/modules/rbac/permissions';
import { REQUIRED_PERMISSION } from './auth.decorators';

/** Enforces `@RequirePermission`. A route with none declared needs only a session. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(execution: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission>(REQUIRED_PERMISSION, [
      execution.getHandler(),
      execution.getClass(),
    ]);
    if (!required) return true;

    const request = execution.switchToHttp().getRequest<{ context?: RequestContext }>();
    const ctx = request.context;
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
