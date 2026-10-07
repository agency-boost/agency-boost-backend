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

/**
 * Reachable inside a read-only support session (P4-T10).
 *
 * `PermissionsGuard` refuses every mutating request a read-only session makes, including
 * on routes that declare no permission at all — because the guarantee the Owner was given
 * is about *writes*, not about which routes somebody remembered to annotate. The exit
 * review found `PATCH /auth/me` renaming the office Owner from inside a session whose own
 * response said `readOnly: true`.
 *
 * Two routes have to survive that: ending the session, and signing out. Blocking either
 * strands the operator inside the session they are trying to leave — which is how
 * `POST /admin/impersonate/end` was already unreachable once, for a different reason, and
 * nothing said so.
 */
export const ALLOWED_WHILE_READ_ONLY = 'allowedWhileReadOnly';
export const AllowWhileReadOnly = () => SetMetadata(ALLOWED_WHILE_READ_ONLY, true);

/**
 * Reachable by **a support session whose office cannot be used** (P13.2 exit review).
 *
 * `ContextResolver` refuses every request of a suspended or archived office's member, and a support
 * session is one of its members — so an office suspended while a Super Admin was in it left them no
 * way out: *End support session* met `TENANT_SUSPENDED` like everything else, the session stayed live
 * for the rest of its hour and no `impersonation.ended` row was written. One route carries this:
 * ending the session. It exempts a support session only; a member's own request is refused as before.
 */
export const ALLOWED_WHILE_OFFICE_UNAVAILABLE = 'allowedWhileOfficeUnavailable';
export const AllowWhileOfficeUnavailable = () => SetMetadata(ALLOWED_WHILE_OFFICE_UNAVAILABLE, true);
