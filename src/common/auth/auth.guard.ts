import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ContextResolver } from '@/modules/auth/context-resolver';
import { ImpersonationService } from '@/modules/auth/impersonation.service';
import { TokenSigner } from '@/modules/auth/token-signer';
import { ALLOWS_TEMPORARY_PASSWORD, IS_PUBLIC } from './auth.decorators';

/**
 * Verifies the access token and attaches the resolved RequestContext.
 *
 * Roles are resolved from the database on every request rather than read from the
 * token, which is what makes revoking a grant take effect immediately.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly signer: TokenSigner,
    private readonly resolver: ContextResolver,
    private readonly impersonation: ImpersonationService,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      execution.getHandler(),
      execution.getClass(),
    ]);
    if (isPublic) return true;

    const request = execution.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      context?: unknown;
    }>();

    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      throw new DomainException(
        ErrorCode.AUTH_TOKEN_INVALID,
        'Sign in to continue.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    let claims;
    try {
      claims = this.signer.verify(token);
    } catch {
      throw new DomainException(
        ErrorCode.AUTH_TOKEN_EXPIRED,
        'Your session has expired. Sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // An impersonation session encodes the real actor in `sid` as `imp:<userId>`, so
    // both actors reach the audit log.
    const impersonator = claims.sid.startsWith('imp:') ? claims.sid.slice(4) : null;

    /**
     * A support session can be **ended**, and ending it has to bite.
     *
     * The access token is a stateless JWT — that is what keeps every ordinary request off
     * the database — so nothing here consults it except this one branch. Before it,
     * `impersonation/end` wrote an audit row and the token stayed valid for the rest of
     * its hour; anyone holding a copy kept acting as the target.
     *
     * Only `imp:` tokens pay for the lookup, and they are rare by design.
     */
    let readOnlySession = false;
    if (impersonator) {
      const session = await this.impersonation.liveSession(token);
      if (!session) {
        throw new DomainException(
          ErrorCode.AUTH_TOKEN_EXPIRED,
          'That support session has ended.',
          HttpStatus.UNAUTHORIZED,
        );
      }
      /*
       * Read from the **session row**, not from the token (P4-T10).
       *
       * Elevation happens after the token is minted — a second Super Admin approves a
       * session already running — so a flag baked into the JWT could never move. The row
       * is already being read here to check the session is live, so this costs nothing.
       */
      readOnlySession = session.readOnly;
    }

    const context = await this.resolver.resolve(claims.sub, impersonator, readOnlySession);

    /*
     * **A temporary password buys three routes and nothing else.**
     *
     * The roster import generates a password, an admin reads it and emails it on, and the
     * person who signs in with it has demonstrated control of a mailbox — not that the
     * account is theirs. Anybody who saw the email, or the admin's screen, or the
     * spreadsheet it was pasted into, holds the same credential.
     *
     * Enforced here rather than by a redirect on the client, because a redirect leaves
     * the temporary password working against the API for as long as the account exists —
     * and the API is the part somebody with a copy of the credential would use.
     */
    if (context.mustChangePassword) {
      const allowed = this.reflector.getAllAndOverride<boolean>(ALLOWS_TEMPORARY_PASSWORD, [
        execution.getHandler(),
        execution.getClass(),
      ]);
      if (!allowed) {
        throw new DomainException(
          ErrorCode.AUTH_PASSWORD_CHANGE_REQUIRED,
          'Choose your own password before you go any further. The one you signed in with '
            + 'was generated for you, and somebody else has seen it.',
          HttpStatus.FORBIDDEN,
        );
      }
    }

    request.context = context;
    return true;
  }
}
