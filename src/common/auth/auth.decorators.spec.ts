import { ExecutionContext } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { resolveCtx } from './auth.decorators';

describe('@Ctx()', () => {
  function execution(context?: RequestContext) {
    return {
      switchToHttp: () => ({ getRequest: () => ({ context }) }),
    } as unknown as ExecutionContext;
  }

  it('hands the handler the context AuthGuard attached', () => {
    const ctx = new RequestContext('65b1f0c2a4d3e5f6a7b8c9d0', 'none', null);
    expect(resolveCtx(undefined, execution(ctx))).toBe(ctx);
  });

  it('says what is wrong when a route reads a context nothing attached', () => {
    // A handler taking @Ctx() on a @Public() route, or on a controller the guard is not
    // registered for. Returning undefined would surface three frames later as
    // "cannot read kpmId of undefined"; this names the mistake where it happens.
    expect(() => resolveCtx(undefined, execution())).toThrow(/must be behind AuthGuard/);
  });
});
