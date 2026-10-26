import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '@/common/context/request-context';
import { ErrorCode } from '@/common/errors/error-codes';
import { ALLOWED_WHILE_READ_ONLY, REFUSED_IN_SUPPORT_SESSION, REQUIRED_PERMISSION } from './auth.decorators';
import { SETUP_SESSION_WRITE_SCOPE } from '@/modules/rbac/permissions';
import { PermissionsGuard } from './permissions.guard';

/**
 * The guard had no unit test until the Phase 4 exit review, which is how the read-only
 * hole survived: the e2e suite proved the control through `POST /join/kpm`, a route that
 * declares a permission, and the four unannotated writes on `AuthController` were never
 * asked about.
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

    it('is still refused a write inside a read-only support session', () => {
      /*
       * The exit review's finding. `PATCH /auth/me` declares no permission, so `can()`
       * never ran, and a session whose own response said `readOnly: true` renamed the
       * office Owner.
       */
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(() => guardWith({}).canActivate(execution(member(true), method)))
          .toThrow(expect.objectContaining({ code: ErrorCode.PERM_DENIED }));
      }
    });

    it('lets the same session read', () => {
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        expect(guardWith({}).canActivate(execution(member(true), method))).toBe(true);
      }
    });

    it('treats a request with no method as a write', () => {
      // Fail closed. A request reaching the guard without a method is a wiring anomaly,
      // and the open answer is the wrong default for a control the Owner was promised.
      expect(() => guardWith({}).canActivate(execution(member(true), undefined as never)))
        .toThrow(expect.objectContaining({ code: ErrorCode.PERM_DENIED }));
    });

    it('lets a route opt out, so the operator can leave the session', () => {
      // `POST /admin/impersonate/end` and `POST /auth/logout`. Blocking either strands
      // them inside the session they are trying to end.
      const guard = guardWith({ [ALLOWED_WHILE_READ_ONLY]: true });
      expect(guard.canActivate(execution(member(true), 'POST'))).toBe(true);
    });

    it('leaves a public route alone, where there is no context to read', () => {
      expect(guardWith({}).canActivate(execution(undefined, 'POST'))).toBe(true);
    });
  });

  /*
   * ADR-0162 (P18.9-T1 AC-2, AC-3): the method fallback lets a setup session's write through only when the
   * route's own permission is in its scope, and a person's own account is refused in every session.
   */
  describe('a setup session (ADR-0162)', () => {
    const owner = (readOnly: boolean, writeScope: readonly string[] = SETUP_SESSION_WRITE_SCOPE) =>
      new RequestContext(
        'u-owner', 'none',
        {
          membershipId: 'mem-o', kpmId: 'kpm-a', orgLevelCode: 'AB', hierarchyRole: 'ab',
          status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
        },
        'sa-1', null, false, readOnly, writeScope,
      );

    it('AC-2 lets a write through when the route declares a permission in the scope', () => {
      for (const permission of ['tenant_config:write', 'kpm:import_roster', 'data_upload:commit_import']) {
        const guard = guardWith({ [REQUIRED_PERMISSION]: permission });
        expect(guard.canActivate(execution(owner(true), 'POST'))).toBe(true);
      }
    });

    it('AC-2 refuses a write outside the scope, saying what a setup session may change', () => {
      const guard = guardWith({ [REQUIRED_PERMISSION]: 'member:change_role' });
      expect(() => guard.canActivate(execution(owner(true), 'PATCH'))).toThrow(expect.objectContaining({
        code: ErrorCode.PERM_DENIED,
        message: expect.stringContaining('change the office\'s settings, import people and upload production files'),
      }));
    });

    it('AC-2 refuses a write through a route that declares no permission: the scope names permissions', () => {
      expect(() => guardWith({}).canActivate(execution(owner(true), 'POST')))
        .toThrow(expect.objectContaining({ code: ErrorCode.PERM_DENIED }));
    });

    it('AC-2 a read-only session with no scope is refused the same route', () => {
      const guard = guardWith({ [REQUIRED_PERMISSION]: 'tenant_config:write' });
      expect(() => guard.canActivate(execution(owner(true, []), 'POST')))
        .toThrow(expect.objectContaining({ message: expect.stringContaining('read-only support session') }));
    });

    it('AC-3 refuses a person\'s own account in every session — read-only, setup and elevated', () => {
      const guard = guardWith({ [REFUSED_IN_SUPPORT_SESSION]: true });
      for (const ctx of [member(true), owner(true), owner(false), member(false)]) {
        expect(() => guard.canActivate(execution(ctx, 'PATCH'))).toThrow(expect.objectContaining({
          code: ErrorCode.PERM_DENIED, message: expect.stringContaining('own account'),
        }));
      }
    });

    it('AC-3 leaves the same route alone for the person themselves', () => {
      const guard = guardWith({ [REFUSED_IN_SUPPORT_SESSION]: true });
      expect(guard.canActivate(execution(member(false, false), 'PATCH'))).toBe(true);
    });
  });

  describe('a route that declares one', () => {
    it('refuses a read-only session before asking about the permission', () => {
      const guard = guardWith({ [REQUIRED_PERMISSION]: 'tenant_config:write' });
      expect(() => guard.canActivate(execution(member(true), 'POST')))
        .toThrow(expect.objectContaining({ code: ErrorCode.PERM_DENIED }));
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
