import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '@/common/context/request-context';
import { ErrorCode } from '@/common/errors/error-codes';
import { REFUSED_IN_SUPPORT_SESSION, REQUIRED_PERMISSION } from './auth.decorators';
import { PermissionsGuard } from './permissions.guard';

/**
 * The guard had no unit test until the Phase 4 exit review, which is how the read-only
 * hole survived: the e2e suite proved the control through `POST /join/kpm`, a route that
 * declares a permission, and the four unannotated writes on `AuthController` were never
 * asked about.
 *
 * **A session's writes are `ViewOnlySessionGuard`'s since P19.4-T2** (ADR-0206 §4), and its spec asks them. This guard
 * no longer looks at the method: what it still refuses a session is a write *permission*, by `can()`'s verb — on any
 * method — and a person's own account.
 */
describe('PermissionsGuard', () => {
  /** A reflector answering from a plain map, so no Nest metadata plumbing is involved. */
  function guardWith(metadata: Record<string, unknown>): PermissionsGuard {
    const reflector = {
      getAllAndOverride: (key: string) => metadata[key],
    } as unknown as Reflector;
    return new PermissionsGuard(reflector);
  }

  function execution(ctx: RequestContext | undefined, method: string): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ context: ctx, method }) }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  }

  const member = (readOnly: boolean, impersonated = true) =>
    new RequestContext(
      'u1', 'none',
      {
        membershipId: 'mem-1', kpmId: 'kpm-a', orgLevelCode: 'AB', hierarchyRole: 'ab',
        status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      },
      impersonated ? 'sa-1' : null, null, false, readOnly,
    );

  describe('a route that declares no permission', () => {
    it('needs only a session', () => {
      expect(guardWith({}).canActivate(execution(member(false, false), 'POST'))).toBe(true);
    });

    it('P19.4-T2 AC-2 leaves a session\'s method to ViewOnlySessionGuard, which runs first: no fallback here', () => {
      // The method fallback that stood here — and a setup session's scope inside it (ADR-0162) — is gone.
      for (const method of ['GET', 'POST', 'PATCH', undefined]) {
        expect(guardWith({}).canActivate(execution(member(true), method as string))).toBe(true);
      }
    });

    it('leaves a public route alone, where there is no context to read', () => {
      expect(guardWith({}).canActivate(execution(undefined, 'POST'))).toBe(true);
    });
  });

  describe('a person\'s own account (ADR-0162 §4)', () => {
    it('refuses it in every session, on a read as on a write', () => {
      const guard = guardWith({ [REFUSED_IN_SUPPORT_SESSION]: true });
      for (const method of ['GET', 'PATCH']) {
        expect(() => guard.canActivate(execution(member(true), method))).toThrow(expect.objectContaining({
          code: ErrorCode.PERM_DENIED, message: expect.stringContaining('own account'),
        }));
      }
    });

    it('leaves the same route alone for the person themselves', () => {
      const guard = guardWith({ [REFUSED_IN_SUPPORT_SESSION]: true });
      expect(guard.canActivate(execution(member(false, false), 'PATCH'))).toBe(true);
    });
  });

  describe('a route that declares one', () => {
    it('P19.4-T2 AC-2 refuses a session a write permission by its verb, whatever the method: no scope lets it through', () => {
      // A setup session's scope let `tenant_config:write`, `kpm:import_roster` and `data_upload:*` through (ADR-0162).
      for (const permission of ['tenant_config:write', 'kpm:import_roster', 'data_upload:commit_import']) {
        const guard = guardWith({ [REQUIRED_PERMISSION]: permission });
        for (const method of ['GET', 'POST']) {
          expect(() => guard.canActivate(execution(member(true), method)))
            .toThrow(expect.objectContaining({ code: ErrorCode.PERM_DENIED, details: { permission } }));
        }
      }
    });

    it('names the Owner when the power is one the Owner reserved', () => {
      /*
       * `PERM_DENIED` would be true and useless — a KPM Admin reading it cannot tell
       * "ask the Owner" from "this is not for your role at all".
       */
      const guard = guardWith({ [REQUIRED_PERMISSION]: 'kpm_admin:grant' });
      const admin = new RequestContext('u2', 'none', {
        membershipId: 'mem-2', kpmId: 'kpm-a', orgLevelCode: 'AB', hierarchyRole: 'ab',
        status: 'active', isKpmOwner: false, isKpmAdmin: true, directCount: 0,
      });
      expect(() => guard.canActivate(execution(admin, 'POST')))
        .toThrow(expect.objectContaining({ code: ErrorCode.PERM_OWNER_ONLY }));
    });

    it('admits a caller who holds it', () => {
      const guard = guardWith({ [REQUIRED_PERMISSION]: 'org_tree:read' });
      expect(guard.canActivate(execution(member(false, false), 'GET'))).toBe(true);
    });
  });
});
