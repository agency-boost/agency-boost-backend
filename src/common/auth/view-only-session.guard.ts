import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ALLOWED_WHILE_READ_ONLY } from './auth.decorators';
import { AUTH_GUARD_REFUSALS } from './auth.messages';

/**
 * Methods that change nothing. Everything else is a write — including a request that somehow arrives without a
 * method, because the open answer is the wrong default for the control this list backs.
 */
export const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * **A support session only looks** (P19.4-T2; ADR-0206 §4; UI-151, Overview R4, A-R8).
 *
 * Registered globally after `AuthGuard` and before `PermissionsGuard`, so it runs on every controller and before any
 * route's own guard. In a session, a request whose method is not `GET`, `HEAD` or `OPTIONS` is refused
 * `403 IMPERSONATION_READ_ONLY` — whatever permission the route declares, or none — and nothing is written.
 *
 * **By method, not by permission.** The permission's verb is `can()`'s test, and it stays: a `GET` that would need a
 * write grant is still refused there. But a route that declares no permission, or a read-like one on a write, is
 * exactly what a verb cannot catch, and the guarantee is about *writes*, not about which routes somebody remembered to
 * annotate. The exit review of P4-T10 found `PATCH /auth/me` renaming an office's Owner from inside a session whose
 * own answer said `readOnly: true`.
 *
 * **The routes marked `@AllowWhileReadOnly()` pass**, and there are three, pinned by `view-only-session.int.spec.ts`:
 * `POST /admin/impersonate/end`, which ends the session (blocking it would strand the operator inside it), and two
 * reads sent as `POST` for their bodies, which write nothing — the goal calculator's preview and opening a training
 * item (a session is answered the address and nothing is recorded, `training_progress:update` being refused it).
 * `POST /auth/refresh` and `POST /auth/logout` are public: they carry the Super Admin's own cookie and no session
 * token, so they are not requests of the session.
 */
@Injectable()
export class ViewOnlySessionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(execution: ExecutionContext): boolean {
    const request = execution.switchToHttp().getRequest<{ context?: RequestContext; method?: string }>();
    // A public route has no context, and a request outside a session is not this guard's to decide.
    if (!request.context?.isImpersonating) return true;
    if (READ_METHODS.has(String(request.method).toUpperCase())) return true;
    const exempt = this.reflector.getAllAndOverride<boolean>(ALLOWED_WHILE_READ_ONLY, [
      execution.getHandler(),
      execution.getClass(),
    ]);
    if (exempt) return true;
    throw new DomainException(
      ErrorCode.IMPERSONATION_READ_ONLY,
      AUTH_GUARD_REFUSALS.IMPERSONATION_READ_ONLY.viewOnly,
      HttpStatus.FORBIDDEN,
    );
  }
}
