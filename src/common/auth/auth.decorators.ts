import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import type { Permission } from '@/modules/rbac/permissions';

/** Routes reachable without a token: login, registration, reset links. */
export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Declares the permission a route needs. Checked by PermissionsGuard. */
export const REQUIRED_PERMISSION = 'requiredPermission';
export const RequirePermission = (permission: Permission) =>
  SetMetadata(REQUIRED_PERMISSION, permission);

/** Injects the resolved RequestContext. Never build one by hand in a handler. */
export const Ctx = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestContext => {
  const request = ctx.switchToHttp().getRequest<{ context?: RequestContext }>();
  if (!request.context) {
    throw new Error(
      'RequestContext is missing. A route reading it must be behind AuthGuard — ' +
        'if it is genuinely public, it has no context to read.',
    );
  }
  return request.context;
});
