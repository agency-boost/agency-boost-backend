import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '@/common/context/request-context';
import { ErrorCode } from '@/common/errors/error-codes';
import { readerIn } from '@/common/i18n/reader';
import { ContextResolver } from '@/modules/auth/context-resolver';
import { ImpersonationService } from '@/modules/auth/impersonation.service';
import { TokenSigner } from '@/modules/auth/token-signer';
import { ALLOWED_WHILE_OFFICE_UNAVAILABLE } from './auth.decorators';
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

  function execution(authorization?: string, isPublic = false, language?: string) {
    const request: { headers: Record<string, string | undefined>; context?: unknown; reader?: unknown } = {
      headers: { authorization, 'accept-language': language },
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

  /** The resolver's answer for somebody who saved Bahasa Indonesia: the reader `ContextResolver` builds from the row. */
  const savedIndonesian = {
    resolve: jest.fn(async (userId: string) => new RequestContext(
      userId, 'none', null, null, null, false, false, [], readerIn('id'),
    )),
  } as unknown as ContextResolver;

  /**
   * Only an `imp:` token reaches `liveSession`, so every case below leaves it untouched.
   * The impersonation cases set it explicitly.
   *
   * It answers the **session row**, not a boolean: since P4-T10 the guard reads `readOnly`
   * from it, because elevation happens after the token is minted and a flag baked into a
   * JWT could never move.
   */
  const live = (answer = true, readOnly = true, writeScope?: string[]) =>
    ({
      liveSession: jest.fn(async () => (answer ? { readOnly, writeScope } : null)),
    }) as unknown as ImpersonationService;

  beforeEach(() => jest.clearAllMocks());

  it('lets a public route through without looking at the header', async () => {
    const signer = { verify: jest.fn() } as unknown as TokenSigner;
    const { context, reflector } = execution(undefined, true);

    await expect(new AuthGuard(reflector, signer, resolver, live()).canActivate(context))
      .resolves.toBe(true);
    expect(signer.verify).not.toHaveBeenCalled();
  });

  it('refuses a request with no Bearer header', async () => {
    const signer = { verify: jest.fn() } as unknown as TokenSigner;
    const { context, reflector } = execution(undefined);

    await expect(new AuthGuard(reflector, signer, resolver, live()).canActivate(context))
      .rejects.toMatchObject({ code: ErrorCode.AUTH_TOKEN_INVALID });
  });

  it('refuses an Authorization header that is not a Bearer token', async () => {
    const signer = { verify: jest.fn() } as unknown as TokenSigner;
    const { context, reflector } = execution('Basic abc123');

    await expect(new AuthGuard(reflector, signer, resolver, live()).canActivate(context))
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

    await expect(new AuthGuard(reflector, signer, resolver, live()).canActivate(context))
      .rejects.toMatchObject({ code: ErrorCode.AUTH_TOKEN_EXPIRED, status: 401 });
  });

  it('resolves the context from the database, not from the token', async () => {
    const signer = {
      verify: jest.fn(() => ({ sub: USER, sid: 'session-1' })),
    } as unknown as TokenSigner;
    const { context, reflector, request } = execution('Bearer good.token');

    await expect(new AuthGuard(reflector, signer, resolver, live()).canActivate(context))
      .resolves.toBe(true);
    // Roles come from `resolve`, which reads the row — that is what makes revoking a
    // grant take effect on the next request rather than at the next sign-in.
    // `false`: a person acting as themselves is not being restrained (P4-T10).
    expect(resolver.resolve).toHaveBeenCalledWith(USER, null, false, false, [], null);
    expect((request.context as RequestContext).userId).toBe(USER);
  });

  it('carries the real actor out of an impersonation session id', async () => {
    const OPERATOR = '65b1f0c2a4d3e5f6a7b8c9d1';
    const signer = {
      verify: jest.fn(() => ({ sub: USER, sid: `imp:${OPERATOR}` })),
    } as unknown as TokenSigner;
    const { context, reflector, request } = execution('Bearer impersonating.token');

    await new AuthGuard(reflector, signer, resolver, live()).canActivate(context);
    // `true`: every session is read-only until a second Super Admin says otherwise.
    expect(resolver.resolve).toHaveBeenCalledWith(USER, OPERATOR, true, false, [], null);
    expect((request.context as RequestContext).isImpersonating).toBe(true);
  });

  it('ADR-0162: carries a setup session\'s write scope off the row, and an empty one off a row with none', async () => {
    const OPERATOR = '65b1f0c2a4d3e5f6a7b8c9d1';
    const signer = { verify: jest.fn(() => ({ sub: USER, sid: `imp:${OPERATOR}` })) } as unknown as TokenSigner;
    const { context, reflector } = execution('Bearer impersonating.token');

    await new AuthGuard(reflector, signer, resolver, live(true, true, ['tenant_config:write'])).canActivate(context);
    expect(resolver.resolve).toHaveBeenLastCalledWith(USER, OPERATOR, true, false, ['tenant_config:write'], null);

    // A row from before the scope existed is a support session: it writes nothing.
    await new AuthGuard(reflector, signer, resolver, live(true, true)).canActivate(context);
    expect(resolver.resolve).toHaveBeenLastCalledWith(USER, OPERATOR, true, false, [], null);
  });

  /*
   * **P18.98-T5 AC-1 — the request's reader, resolved once**: the header alone before anybody is known — on a public
   * route, and for the refusals before the person is read — then the resolver's, from the user it already reads.
   */
  describe('P18.98-T5 AC-1 the request’s reader', () => {
    it('AC-1 reads the header on a public route, where nobody is known', async () => {
      const signer = { verify: jest.fn() } as unknown as TokenSigner;
      const { context, reflector, request } = execution(undefined, true, 'id');
      await new AuthGuard(reflector, signer, resolver, live()).canActivate(context);
      expect(request.reader).toEqual({ language: 'id', figures: 'id' });
    });

    it('AC-1 reads nobody’s choice without a header — English until the default is live', async () => {
      const signer = { verify: jest.fn() } as unknown as TokenSigner;
      const { context, reflector, request } = execution(undefined, true);
      await new AuthGuard(reflector, signer, resolver, live()).canActivate(context);
      expect(request.reader).toEqual({ language: 'en', figures: 'id' });
    });

    it('AC-1 writes a refusal before the person is known in the header’s language', async () => {
      const signer = { verify: jest.fn() } as unknown as TokenSigner;
      const { context, reflector, request } = execution(undefined, false, 'id');
      await expect(new AuthGuard(reflector, signer, resolver, live()).canActivate(context))
        .rejects.toMatchObject({ code: ErrorCode.AUTH_TOKEN_INVALID });
      expect(request.reader).toEqual({ language: 'id', figures: 'id' });
    });

    it('AC-1 hands the resolver the header, and keeps the reader it resolved from the person', async () => {
      const signer = { verify: jest.fn(() => ({ sub: USER, sid: 'session-1' })) } as unknown as TokenSigner;
      const { context, reflector, request } = execution('Bearer good.token', false, 'EN');
      await new AuthGuard(reflector, signer, resolver, live()).canActivate(context);
      expect(resolver.resolve).toHaveBeenCalledWith(USER, null, false, false, [], 'en');
      // The resolver's context's reader — here nobody's choice, the stub reading no row — is the request's.
      expect(request.reader).toEqual((request.context as RequestContext).reader);

      const saved = execution('Bearer good.token');
      await new AuthGuard(saved.reflector, signer, savedIndonesian, live()).canActivate(saved.context);
      expect(saved.request.reader).toEqual({ language: 'id', figures: 'id' });
      expect((saved.request.context as RequestContext).reader).toEqual({ language: 'id', figures: 'id' });
    });
  });

  /*
   * **Ending a support session is never refused for the office** (P13.2 exit review): the route marked
   * `AllowWhileOfficeUnavailable` asks the resolver to let a session out of an office suspended under
   * it. Only a session: a member's own request to the same route is resolved as any other.
   */
  describe('leaving a support session in an office nobody can use', () => {
    const OPERATOR = '65b1f0c2a4d3e5f6a7b8c9d1';
    const marked = {
      getAllAndOverride: (key: string) => key === ALLOWED_WHILE_OFFICE_UNAVAILABLE,
    } as unknown as Reflector;

    it('asks the resolver to let a session through on the marked route', async () => {
      const signer = { verify: jest.fn(() => ({ sub: USER, sid: `imp:${OPERATOR}` })) } as unknown as TokenSigner;
      const { context } = execution('Bearer impersonating.token');
      await new AuthGuard(marked, signer, resolver, live()).canActivate(context);
      expect(resolver.resolve).toHaveBeenCalledWith(USER, OPERATOR, true, true, [], null);
    });

    it('never for somebody acting as themselves, on the same route', async () => {
      const signer = { verify: jest.fn(() => ({ sub: USER, sid: 'session-1' })) } as unknown as TokenSigner;
      const { context } = execution('Bearer good.token');
      await new AuthGuard(marked, signer, resolver, live()).canActivate(context);
      expect(resolver.resolve).toHaveBeenCalledWith(USER, null, false, false, [], null);
    });
  });
});
