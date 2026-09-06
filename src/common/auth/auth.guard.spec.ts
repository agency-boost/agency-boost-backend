import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '@/common/context/request-context';
import { ErrorCode } from '@/common/errors/error-codes';
import { ContextResolver } from '@/modules/auth/context-resolver';
import { TokenSigner } from '@/modules/auth/token-signer';
import { AuthGuard } from './auth.guard';

/**
 * The gate every non-public route sits behind.
 *
 * The e2e suite walks the happy path and the missing-header path over HTTP. What it
 * cannot easily reach is a token that parses as a Bearer header and then fails
 * verification — a tampered signature, or one issued under a rotated key. That branch
 * decides whether somebody is told to sign in again or handed a 500, so it is pinned
 * here rather than left to the one case a running server happens to produce.
 */
describe('AuthGuard', () => {
  const USER = '65b1f0c2a4d3e5f6a7b8c9d0';

  function execution(authorization?: string, isPublic = false) {
    const request: { headers: Record<string, string | undefined>; context?: unknown } = {
      headers: { authorization },
    };
    return {
      request,
      context: {
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
      reflector: { getAllAndOverride: () => isPublic } as unknown as Reflector,
    };
  }

  const resolver = {
    resolve: jest.fn(async (userId: string, impersonator: string | null) =>
      new RequestContext(userId, 'none', null, impersonator),
    ),
  } as unknown as ContextResolver;

  beforeEach(() => jest.clearAllMocks());

  it('lets a public route through without looking at the header', async () => {
    const signer = { verify: jest.fn() } as unknown as TokenSigner;
    const { context, reflector } = execution(undefined, true);

    await expect(new AuthGuard(reflector, signer, resolver).canActivate(context))
      .resolves.toBe(true);
    expect(signer.verify).not.toHaveBeenCalled();
  });

  it('refuses a request with no Bearer header', async () => {
    const signer = { verify: jest.fn() } as unknown as TokenSigner;
    const { context, reflector } = execution(undefined);

    await expect(new AuthGuard(reflector, signer, resolver).canActivate(context))
      .rejects.toMatchObject({ code: ErrorCode.AUTH_TOKEN_INVALID });
  });

  it('refuses an Authorization header that is not a Bearer token', async () => {
    const signer = { verify: jest.fn() } as unknown as TokenSigner;
    const { context, reflector } = execution('Basic abc123');

    await expect(new AuthGuard(reflector, signer, resolver).canActivate(context))
      .rejects.toMatchObject({ code: ErrorCode.AUTH_TOKEN_INVALID });
    expect(signer.verify).not.toHaveBeenCalled();
  });

  it('turns a token that fails verification into "sign in again", not a 500', async () => {
    const signer = {
      verify: jest.fn(() => {
        throw new Error('signature mismatch');
      }),
    } as unknown as TokenSigner;
    const { context, reflector } = execution('Bearer tampered.token.here');

    await expect(new AuthGuard(reflector, signer, resolver).canActivate(context))
      .rejects.toMatchObject({ code: ErrorCode.AUTH_TOKEN_EXPIRED, status: 401 });
  });

  it('resolves the context from the database, not from the token', async () => {
    const signer = {
      verify: jest.fn(() => ({ sub: USER, sid: 'session-1' })),
    } as unknown as TokenSigner;
    const { context, reflector, request } = execution('Bearer good.token');

    await expect(new AuthGuard(reflector, signer, resolver).canActivate(context))
      .resolves.toBe(true);
    // Roles come from `resolve`, which reads the row — that is what makes revoking a
    // grant take effect on the next request rather than at the next sign-in.
    expect(resolver.resolve).toHaveBeenCalledWith(USER, null);
    expect((request.context as RequestContext).userId).toBe(USER);
  });

  it('carries the real actor out of an impersonation session id', async () => {
    const OPERATOR = '65b1f0c2a4d3e5f6a7b8c9d1';
    const signer = {
      verify: jest.fn(() => ({ sub: USER, sid: `imp:${OPERATOR}` })),
    } as unknown as TokenSigner;
    const { context, reflector, request } = execution('Bearer impersonating.token');

    await new AuthGuard(reflector, signer, resolver).canActivate(context);
    expect(resolver.resolve).toHaveBeenCalledWith(USER, OPERATOR);
    expect((request.context as RequestContext).isImpersonating).toBe(true);
  });
});
