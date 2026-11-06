import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { headerLanguage, readerOf, type Reader } from '@/common/i18n/reader';
import { ContextResolver } from '@/modules/auth/context-resolver';
import { ImpersonationService } from '@/modules/auth/impersonation.service';
import { TokenSigner } from '@/modules/auth/token-signer';
import { ALLOWED_WHILE_OFFICE_UNAVAILABLE, ALLOWS_TEMPORARY_PASSWORD, IS_PUBLIC } from './auth.decorators';
import { AUTH_GUARD_REFUSALS } from './auth.messages';

/**
 * Verifies the access token and attaches the resolved RequestContext.
 *
 * Roles are resolved from the database on every request rather than read from the
 * token, which is what makes revoking a grant take effect immediately.
 *
 * **It resolves the request's reader too** (ADR-0179 §7; P18.10-T5 AC-1), first of all and on every route, public
 * ones included: the `Accept-Language` the app sent, and — once the person is read — their saved `users.locale`. The
 * error filter writes every refusal for it, and every service reads it off the context.
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

    const request = execution.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      context?: unknown;
      reader?: Reader;
    }>();

    // Before anything is refused, and on a public route as on any other: nobody is known yet, so the header alone.
    const language = headerLanguage(request.headers['accept-language']);
    request.reader = readerOf({ header: language });
    if (isPublic) return true;

    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      throw new DomainException(
        ErrorCode.AUTH_TOKEN_INVALID,
        AUTH_GUARD_REFUSALS.AUTH_TOKEN_INVALID.signIn,
        HttpStatus.UNAUTHORIZED,
      );
    }

    let claims;
    try {
      claims = this.signer.verify(token);
    } catch {
      throw new DomainException(
        ErrorCode.AUTH_TOKEN_EXPIRED,
        AUTH_GUARD_REFUSALS.AUTH_TOKEN_EXPIRED.expired,
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
    if (impersonator) {
      /*
       * **Only a session that only looks is live** (ADR-0206 §5; P19.4-T2): `liveSession` answers `null` for a row
       * that was started as a setup session or elevated to write, as for one ended or expired — so a token minted
       * before the deploy, whose row the migration missed, is refused here like any ended session.
       */
      const session = await this.impersonation.liveSession(token);
      if (!session) {
        throw new DomainException(
          ErrorCode.AUTH_TOKEN_EXPIRED,
          AUTH_GUARD_REFUSALS.AUTH_TOKEN_EXPIRED.supportEnded,
          HttpStatus.UNAUTHORIZED,
        );
      }
    }

    /*
     * **Leaving a support session is never refused for the office** (P13.2 exit review): the one route
     * marked for it lets a session out of an office suspended or archived under it. Only a session —
     * a member's own request to the same route meets the office's refusal as before.
     */
    const leavingSupport = impersonator !== null && this.reflector.getAllAndOverride<boolean>(
      ALLOWED_WHILE_OFFICE_UNAVAILABLE, [execution.getHandler(), execution.getClass()],
    ) === true;

    const context = await this.resolver.resolve(claims.sub, impersonator, leavingSupport, language);
    // The person read: their saved language, behind the header (AC-1).
    request.reader = context.reader;

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
          AUTH_GUARD_REFUSALS.AUTH_PASSWORD_CHANGE_REQUIRED.chooseYourOwn,
          HttpStatus.FORBIDDEN,
        );
      }
    }

    request.context = context;
    return true;
  }
}
