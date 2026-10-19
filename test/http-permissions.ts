import { CanActivate, ExecutionContext, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRED_PERMISSION } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { VALIDATION_PIPE_OPTIONS } from '@/bootstrap';

/**
 * The pieces every controller int-spec needs to ask *"who does the API refuse?"*.
 *
 * **A service test cannot see a decorator.** The suite proved tenant isolation and every business
 * rule by calling services directly, which leaves `@RequirePermission` unexecuted — so a dropped or
 * mistyped decorator ships green. The Phase 5 exit review found five controllers reached by no test
 * at all; this is what the specs that close that gap are built from, written once so the awkward
 * parts (a mutable session, reading metadata off a prototype) are not re-derived five times.
 */

/** The office every fixture below belongs to. A spec creates it; the ids only have to agree. */
export const FIXTURE_KPM = '66f0000000000000000000a1';

const member = (over: Record<string, unknown> = {}) => ({
  membershipId: 'mem-a', kpmId: FIXTURE_KPM, orgLevelCode: 'AB', hierarchyRole: 'ab' as const,
  status: 'active' as const, isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
});

export const SUPER_ADMIN = RequestContext.platform('root');
export const OWNER = new RequestContext('u-owner', 'none', member({ isKpmOwner: true }) as never);
export const ADMIN = new RequestContext('u-admin', 'none', member({ isKpmAdmin: true }) as never);
export const AB = new RequestContext('u-ab', 'none', member() as never);
export const AAB = new RequestContext('u-aab', 'none', member({
  orgLevelCode: 'AAB', hierarchyRole: 'aab',
}) as never);
export const AGENT = new RequestContext('u-agent', 'none', member({
  orgLevelCode: 'AGENT', hierarchyRole: 'agent',
}) as never);

/** Everybody in the office who is not an administrator of it, plus the platform. */
export const NOT_ADMINISTRATORS: [string, RequestContext][] = [
  ['an AB', AB], ['an AAB', AAB], ['an agent', AGENT],
  // A Super Admin edits the **company template**, never an office's own copy (ADR-0018). Being
  // refused an office's settings is the design, not an oversight, so it is asserted like the rest.
  ['a Super Admin', SUPER_ADMIN],
];

/** Everybody in the office, whatever their rung — who may *read* its configuration. */
export const EVERY_MEMBER: [string, RequestContext][] = [
  ['the Owner', OWNER], ['the Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an agent', AGENT],
];

/** Who the stubbed auth guard will say is signed in. Set it in a `beforeEach`, then per test. */
export const session: { current: RequestContext } = { current: SUPER_ADMIN };

/**
 * Stands in for `AuthGuard` only.
 *
 * Which session is signed in — a real token, a real membership, impersonation — is
 * `auth.e2e.int.spec.ts`'s question. Whether `PermissionsGuard` then refuses is these specs'.
 */
export class StubAuth implements CanActivate {
  canActivate(execution: ExecutionContext): boolean {
    execution.switchToHttp().getRequest<{ context: RequestContext }>().context = session.current;
    return true;
  }
}

/**
 * Every route a controller declares, mapped to the permission its decorator names.
 *
 * Compared against an expected map with `toEqual`, so three different failures are caught by one
 * assertion: a route with no decorator, a route carrying the **wrong** permission, and a route
 * added without anybody deciding who may reach it.
 *
 * The middle one is the reason this reads the name rather than counting decorators.
 * `sales_script:approve` and `tenant_config:write` are granted to exactly the same two roles, so
 * swapping them changes no behaviour and no role test would notice — while undoing the reason
 * ADR-0037 made them separate, which is that the answers are expected to diverge later.
 */
export function declaredPermissions(controller: new (...args: never[]) => unknown) {
  const prototype = controller.prototype as Record<string, () => unknown>;
  const reflector = new Reflector();

  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    // A route rather than a private helper: `@Get`/`@Post` and friends stamp the method.
    .filter((name) => Reflect.getMetadata('method', prototype[name]) !== undefined)
    .reduce<Record<string, string | undefined>>((all, name) => ({
      ...all, [name]: reflector.get<string>(REQUIRED_PERMISSION, prototype[name]),
    }), {});
}

/**
 * The pipe the deployed server runs, not a convenient subset of it.
 *
 * Built from `bootstrap.ts`'s own options rather than a copy: a spec that configures its own is
 * testing a server nobody runs, which is how three DTOs shipped unreachable over HTTP.
 */
export function productionPipe() {
  return new ValidationPipe(VALIDATION_PIPE_OPTIONS);
}
