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
 * An account created by the roster import (P3.2-T4) arrives with a generated password
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
 * Reachable inside a support session by a method that is not `GET`, `HEAD` or `OPTIONS` (P4-T10; P19.4-T2).
 *
 * `ViewOnlySessionGuard` refuses every such request a session makes, `403 IMPERSONATION_READ_ONLY`, including on
 * routes that declare no permission at all — because the guarantee the Owner was given is about *writes*, not about
 * which routes somebody remembered to annotate (ADR-0206 §4).
 *
 * **Three routes carry it, and `view-only-session.int.spec.ts` pins the list:** ending the session —
 * `POST /admin/impersonate/end`, without which the operator is stranded inside the session they are leaving — and two
 * reads sent as `POST` for their bodies, which write nothing: the goal calculator's preview and opening a training
 * item. Signing out carries it too, and is public. A route joins only by writing nothing, and the spec says why.
 */
export const ALLOWED_WHILE_READ_ONLY = 'allowedWhileReadOnly';
export const AllowWhileReadOnly = () => SetMetadata(ALLOWED_WHILE_READ_ONLY, true);

/**
 * **Refused in every support session** (ADR-0162 §4). *Since P19.4-T2 every session only looks, and these routes'
 * writes meet `ViewOnlySessionGuard` first (ADR-0206 §4); the mark stays, so the refusal is the route's own as well.*
 *
 * A person's own account: their profile, their password and where they are signed in. A read-only session
 * was refused these by their method already; an elevated one let them through, so a session approved to fix
 * an office's settings could rename the Owner, change their password or sign them out of their phone. None of
 * that is support: only the person may, as themselves. `PermissionsGuard` reads it before anything else.
 */
export const REFUSED_IN_SUPPORT_SESSION = 'refusedInSupportSession';
export const RefuseInSupportSession = () => SetMetadata(REFUSED_IN_SUPPORT_SESSION, true);

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
