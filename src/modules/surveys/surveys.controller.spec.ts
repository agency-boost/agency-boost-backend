import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { REQUIRED_PERMISSION } from '@/common/auth/auth.decorators';
import { RequestContext, type TenantMembership } from '@/common/context/request-context';
import { can, isReadLike } from '@/modules/rbac/permissions';
import { SurveysController } from './surveys.controller';
import { SurveysService } from './surveys.service';

/**
 * **Every handler of `SurveysController` declares its permission, or is a named `requireRespondent` read** (P19.5-T4;
 * ADR-0216 §8; roles §3.8). The three reads declare none on purpose: `survey:respond` is not a read by its verb
 * (`isReadLike`), so `can()` refuses it to every view-as session (ADR-0206 §4), and declaring it would refuse a session
 * the member's own reads — the form without its answers, the list, the reminder. `SurveysService` checks the grant
 * instead, before it reads anything. A handler added here with neither fails this walk.
 */
const RESPONDENT_READS: readonly { handler: keyof SurveysController; service: 'pending' | 'list' | 'form' }[] = [
  { handler: 'pending', service: 'pending' }, // GET /surveys/pending
  { handler: 'list', service: 'list' }, // GET /surveys
  { handler: 'form', service: 'form' }, // GET /surveys/:runId
];

const prototype = SurveysController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
const handlers = Object.getOwnPropertyNames(prototype)
  .filter((name) => name !== 'constructor')
  .map((name) => ({
    name,
    // A route, rather than a helper: `@Get`/`@Post` stamp the method.
    method: Reflect.getMetadata(METHOD_METADATA, prototype[name]) as RequestMethod | undefined,
    permission: new Reflector().get<string | undefined>(REQUIRED_PERMISSION, prototype[name]),
  }))
  .filter((h) => h.method !== undefined);

const MEMBER: TenantMembership = {
  membershipId: 'mem-indah', kpmId: 'kpm-0417', orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
  isKpmOwner: false, isKpmAdmin: false, directCount: 0,
};

describe('P19.5-T4 SurveysController: every handler declares a permission or is a named respondent read', () => {
  it('P19.5-T4 ADR-0216 §8 no handler declares nothing unless it is a named requireRespondent read', () => {
    const named = new Set<string>(RESPONDENT_READS.map((r) => r.handler));
    expect(handlers.filter((h) => !h.permission && !named.has(h.name)).map((h) => h.name)).toEqual([]);
    // The list names live handlers, and each of them is a GET that declares nothing.
    expect(handlers.filter((h) => named.has(h.name)).map((h) => [h.name, h.method, h.permission]).sort())
      .toEqual([...named].map((name) => [name, RequestMethod.GET, undefined]).sort());
  });

  it('P19.5-T4 ADR-0216 §8 every write declares survey:respond', () => {
    const writes = handlers.filter((h) => h.method !== RequestMethod.GET);
    expect(writes.map((h) => h.name).sort()).toEqual(['answer', 'popupShown', 'submit']);
    expect(writes.every((h) => h.permission === 'survey:respond')).toBe(true);
  });

  it('P19.5-T4 ADR-0206 §4 why the reads declare none: survey:respond is no read by its verb, so a session would be refused it', () => {
    expect(isReadLike('survey:respond')).toBe(false);
    const member = new RequestContext('u-indah', 'none', MEMBER);
    const session = new RequestContext('u-indah', 'none', MEMBER, 'u-super', null, false, true);
    expect(can(member, 'survey:respond')).toBe(true);
    expect(can(session, 'survey:respond')).toBe(false);
  });

  it.each(RESPONDENT_READS)('P19.5-T4 ADR-0216 §8 $handler checks the grant in the service before it reads anything', async ({ service }) => {
    // Every dependency throws if touched: the refusal has to come first.
    const touched = new Proxy({}, { get: () => () => { throw new Error('read before the grant was checked'); } });
    const surveys = new SurveysService(
      touched as never, touched as never, touched as never, touched as never, touched as never, touched as never,
      touched as never, touched as never, touched as never,
    );
    const outside = RequestContext.platform('u-super');
    const call = service === 'form' ? surveys.form(outside, 'run-1') : surveys[service](outside);
    await expect(call).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
  });
});
