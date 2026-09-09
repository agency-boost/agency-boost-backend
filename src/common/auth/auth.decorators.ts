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
 * Reachable while somebody is still on a password they did not choose.
 *
 * An account created by the roster import (P3.6-T4) arrives with a generated password
 * that an admin has read, written down and sent by email. Until it is replaced, the
 * session proves control of a mailbox and nothing more — so `AuthGuard` refuses every
 * route that does not carry this.
 *
 * The list is deliberately tiny: see who you are, change the password, sign out. It is a
 * decorator rather than a path list inside the guard so that a route joining the list is
 * a visible edit next to that route, not a string somebody appended to an array.
 */
export const ALLOWS_TEMPORARY_PASSWORD = 'allowsTemporaryPassword';
export const AllowTemporaryPassword = () => SetMetadata(ALLOWS_TEMPORARY_PASSWORD, true);

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
