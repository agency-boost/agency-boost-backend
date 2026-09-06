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

/**
 * Reads the context AuthGuard attached.
 *
 * Exported separately from the decorator because `createParamDecorator` keeps its
 * factory private, and the branch that matters here — a handler reading a context that
 * was never attached — is a wiring mistake no request can produce once the wiring is
 * right. It is worth a test precisely because it fires only when somebody is already
 * confused, and the message is what tells them what they did.
 */
export function resolveCtx(_data: unknown, ctx: ExecutionContext): RequestContext {
  const request = ctx.switchToHttp().getRequest<{ context?: RequestContext }>();
  if (!request.context) {
    throw new Error(
      'RequestContext is missing. A route reading it must be behind AuthGuard — ' +
        'if it is genuinely public, it has no context to read.',
    );
  }
  return request.context;
}

/** Injects the resolved RequestContext. Never build one by hand in a handler. */
export const Ctx = createParamDecorator(resolveCtx);
