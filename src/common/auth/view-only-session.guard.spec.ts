import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '@/common/context/request-context';
import { ErrorCode } from '@/common/errors/error-codes';
import { SOURCE_READER, readerIn } from '@/common/i18n/reader';
import { ALLOWED_WHILE_READ_ONLY } from './auth.decorators';
import { READ_METHODS, ViewOnlySessionGuard } from './view-only-session.guard';

/**
 * **P19.4-T2 AC-2 — a support session only looks** (ADR-0206 §4; UI-151, Overview R4), at the guard's own edges.
 * `view-only-session.int.spec.ts` walks every route of the real app through it.
 */
describe('ViewOnlySessionGuard', () => {
  function guardWith(metadata: Record<string, unknown> = {}): ViewOnlySessionGuard {
    const reflector = { getAllAndOverride: (key: string) => metadata[key] } as unknown as Reflector;
    return new ViewOnlySessionGuard(reflector);
  }

  function execution(ctx: RequestContext | undefined, method: string | undefined): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ context: ctx, method }) }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  }

  /** The Owner of an office, as themselves or in a session — the member who holds every write of the office. */
  const owner = (inSession: boolean) => new RequestContext(
    'u-owner', 'none',
    {
      membershipId: 'mem-o', kpmId: 'kpm-a', orgLevelCode: 'AB', hierarchyRole: 'ab',
      status: 'active', isKpmOwner: true, isKpmAdmin: true, directCount: 0,
    },
    inSession ? 'sa-1' : null, null, false, inSession,
  );

  it('P19.4-T2 AC-2 refuses every write in a session, 403 IMPERSONATION_READ_ONLY, whatever the route declares', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(() => guardWith().canActivate(execution(owner(true), method))).toThrow(expect.objectContaining({
        code: ErrorCode.IMPERSONATION_READ_ONLY,
        message: 'This is a view-only session. Nothing can be changed while you view as somebody else.',
      }));
    }
  });

  it('P19.4-T2 AC-2 says it in Indonesian too, as the message ADR-0206 proposed', () => {
    let refusal: unknown;
    try {
      guardWith().canActivate(execution(owner(true), 'POST'));
    } catch (err) {
      refusal = err;
    }
    const exception = refusal as { messageFor: (r: unknown) => string };
    expect(exception.messageFor(readerIn('id')))
      .toBe('Ini sesi hanya melihat. Tidak ada yang bisa diubah selama Anda melihat sebagai orang lain.');
    expect(exception.messageFor(SOURCE_READER)).toContain('view-only session');
  });

  it('P19.4-T2 AC-2 treats a request with no method as a write: closed, not open', () => {
    expect(() => guardWith().canActivate(execution(owner(true), undefined)))
      .toThrow(expect.objectContaining({ code: ErrorCode.IMPERSONATION_READ_ONLY }));
  });

  it('P19.4-T2 AC-2 lets the session read: GET, HEAD and OPTIONS, and nothing else', () => {
    expect([...READ_METHODS]).toEqual(['GET', 'HEAD', 'OPTIONS']);
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(guardWith().canActivate(execution(owner(true), method))).toBe(true);
    }
  });

  it('P19.4-T2 AC-2 lets a route marked @AllowWhileReadOnly() through: ending the session, and a read sent as POST', () => {
    expect(guardWith({ [ALLOWED_WHILE_READ_ONLY]: true }).canActivate(execution(owner(true), 'POST'))).toBe(true);
  });

  it('P19.4-T2 AC-2 decides nothing outside a session, or on a public route with no context', () => {
    for (const method of ['POST', 'DELETE']) {
      expect(guardWith().canActivate(execution(owner(false), method))).toBe(true);
      expect(guardWith().canActivate(execution(undefined, method))).toBe(true);
    }
  });
});
