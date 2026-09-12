import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestContext } from '@/common/context/request-context';
import { AdminController } from './admin.controller';

/**
 * The Super Admin console's scoping rules. The service layer is tested elsewhere; what
 * matters here is which tenant each request resolves to, because getting that wrong
 * either hides a log or leaks one.
 */
describe('AdminController', () => {
  const owner = new RequestContext('u-owner', 'none', {
    membershipId: 'mem-owner',
    kpmId: 'kpm-a',
    orgLevelCode: 'AB', hierarchyRole: 'ab',
    status: 'active',
    isKpmOwner: true,
    isKpmAdmin: false, directCount: 0,
  });

  function make() {
    const audit = { findForTenant: jest.fn(async () => []), record: jest.fn(async () => undefined) };
    const controller = new AdminController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      audit as never,
      {} as never,
      {} as never,
    );
    return { controller, audit };
  }

  it('reads the platform log for a Super Admin who names no tenant', async () => {
    const { controller, audit } = make();
    await controller.readAudit(RequestContext.platform('root'), {});
    expect(audit.findForTenant).toHaveBeenCalledWith(null, 100);
  });

  it('narrows to the named tenant for a Super Admin', async () => {
    const { controller, audit } = make();
    await controller.readAudit(RequestContext.platform('root'), { kpmId: 'kpm-b' });
    expect(audit.findForTenant).toHaveBeenCalledWith('kpm-b', 100);
  });

  it('pins a tenant admin to their own office whatever they pass', async () => {
    const { controller, audit } = make();
    await controller.readAudit(owner, { kpmId: 'kpm-b' });
    expect(audit.findForTenant).toHaveBeenCalledWith('kpm-a', 100);
  });

  // Creating a company used to happen *here*, against an injected Mongoose model — the
  // one handler in this controller that did not delegate, and therefore the one place a
  // duplicate slug had nowhere to be caught. It lives in TenantService now, and so does
  // its test: `tenant.service.tenancy.spec.ts` has a real database, which is the only
  // way to prove the unique index and the pre-check agree.

  /*
   * The gate the exit review found missing (P4-T9 fallout).
   *
   * Read from the decorator rather than through HTTP, because the defect was not a
   * behaviour anybody could see — the route answered 200 exactly as designed. It was a
   * *permission name* that widened underneath a route which had been correct for a year.
   * A test that calls the endpoint asserts the answer; this asserts the reason.
   */
  describe('the platform-wide ladder read', () => {
    const source = readFileSync(join(__dirname, 'admin.controller.ts'), 'utf8');

    it('is gated on a permission only Super Admin holds', () => {
      const route = source.slice(source.indexOf("@Get('org-levels')"));
      const permission = /@RequirePermission\('([^']+)'\)/.exec(route)?.[1];

      expect(permission).toBe('org_level:crud');
      // The one that widened. Naming it here means a future widening of `org_level:read`
      // cannot quietly re-open this route.
      expect(permission).not.toBe('org_level:read');
    });
  });
});
