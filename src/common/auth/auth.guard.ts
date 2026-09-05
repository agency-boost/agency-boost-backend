import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ContextResolver } from '@/modules/auth/context-resolver';
import { TokenSigner } from '@/modules/auth/token-signer';
import { IS_PUBLIC } from './auth.decorators';

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
    request.context = await this.resolver.resolve(claims.sub, impersonator);
    return true;
  }
}
