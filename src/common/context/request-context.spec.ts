import { isEffectiveCoreLeader, RequestContext, type HierarchyRole } from './request-context';

/**
 * The factories that mint a context inside a service, rather than from a request.
 *
 * These never reach the guard — they exist because `TenantScopedRepository` needs a
 * `kpmId` and the caller has none yet. That makes them easy to get wrong quietly: no
 * route refuses a bad one, and the only visible consequence is an audit row that names
 * the wrong actor. So they are pinned here.
 */
describe('request context factories', () => {
  const NEWCOMER = '65b1f0c2a4d3e5f6a7b8c9d0';
  const OPERATOR = '65b1f0c2a4d3e5f6a7b8c9d1';
  const OFFICE = '65b1f0c2a4d3e5f6a7b8c9d2';

  describe('joiningTenant', () => {
    it('scopes the write without claiming platform rights', () => {
      const newcomer = new RequestContext(NEWCOMER, 'none', null);
      const scoped = RequestContext.joiningTenant(newcomer, OFFICE);

      expect(scoped.kpmId).toBe(OFFICE);
      // The whole point: an ordinary person joining an office is not a Super Admin for
      // the duration of the write. It said 'super_admin' until 2026-09-06.
      expect(scoped.platformRole).toBe('none');
      // They are not a member yet — claiming a membershipId would attribute the join to
      // a membership that does not exist.
      expect(scoped.membershipId).toBeNull();
    });

    it('carries the impersonator through, so the audit row says who really did it', () => {
      // A Super Admin redeeming an invite on somebody's behalf. The old factory took a
      // bare userId, so `impersonatorUserId` was dropped and the trail recorded the
      // newcomer acting alone — the one thing an impersonation audit exists to prevent.
      const impersonated = new RequestContext(NEWCOMER, 'none', null, OPERATOR);
      const scoped = RequestContext.joiningTenant(impersonated, OFFICE);

      expect(scoped.isImpersonating).toBe(true);
      expect(scoped.auditActors).toEqual({
        actorUserId: OPERATOR,
        effectiveUserId: NEWCOMER,
      });
    });

    it('leaves an ordinary join attributed to the person themselves', () => {
      const newcomer = new RequestContext(NEWCOMER, 'none', null);
      const scoped = RequestContext.joiningTenant(newcomer, OFFICE);

      expect(scoped.isImpersonating).toBe(false);
      expect(scoped.auditActors).toEqual({
        actorUserId: NEWCOMER,
        effectiveUserId: NEWCOMER,
      });
    });
  });

  describe('tenantRead', () => {
    it('names a job rather than inventing an account', () => {
      const scoped = RequestContext.tenantRead(OFFICE, 'invite-preview');

      expect(scoped.kpmId).toBe(OFFICE);
      expect(scoped.platformRole).toBe('none');
      // `'invite-preview'` used to be passed as the userId, where it reads like an
      // account id. The `job:` prefix matches `forJob` and says what it is.
      expect(scoped.userId).toBe('job:invite-preview');
    });
  });

  describe('isLeader (OD-23)', () => {
    function withMembership(role: 'ab' | 'aab' | 'agent', directCount?: number) {
      return new RequestContext(NEWCOMER, 'none', {
        membershipId: '65b1f0c2a4d3e5f6a7b8c9d3',
        kpmId: OFFICE,
        orgLevelCode: role.toUpperCase(),
      hierarchyRole: role,
        status: 'active',
        isKpmOwner: false,
        isKpmAdmin: false,
        ...(directCount === undefined ? {} : { directCount }),
      } as never);
    }

    it('is the graph, not the role: an AAB with nobody under them leads nobody', () => {
      // The prototype infers leader-ness both ways and they disagree exactly here. The
      // graph is the answer the unit dashboard, the coaching roster and the routing list
      // all have to agree on.
      expect(withMembership('aab', 0).isLeader).toBe(false);
      expect(withMembership('ab', 0).isLeader).toBe(false);
    });

    it('is true from the first direct report, whatever the role', () => {
      expect(withMembership('aab', 1).isLeader).toBe(true);
      expect(withMembership('agent', 3).isLeader).toBe(true);
    });

    it('treats an unknown count as nobody, rather than throwing', () => {
      // A membership read from a document written before `directCount` existed.
      expect(withMembership('ab', undefined).isLeader).toBe(false);
    });

    it('is false for somebody who is in no office at all', () => {
      expect(new RequestContext(NEWCOMER, 'none', null).isLeader).toBe(false);
    });
  });

  describe('forJob', () => {
    it('names the job as the actor and scopes it to one office', () => {
      const scoped = RequestContext.forJob(OFFICE, 'nightly-rollup');

      expect(scoped.kpmId).toBe(OFFICE);
      expect(scoped.platformRole).toBe('none');
      // A job is not a person, and the audit row should not read like one did this.
      expect(scoped.userId).toBe('job:nightly-rollup');
      expect(scoped.membershipId).toBe('job:nightly-rollup');
      expect(scoped.isImpersonating).toBe(false);
    });
  });

  describe('platform', () => {
    it('carries no office at all — that is what makes it platform work', () => {
      const scoped = RequestContext.platform(OPERATOR);

      expect(scoped.platformRole).toBe('super_admin');
      expect(scoped.kpmId).toBeNull();
      // Every tenant-scoped repository call fails closed on this, rather than running
      // unscoped: MissingTenantContextError, not a query across all offices.
      expect(scoped.membershipId).toBeNull();
    });
  });

  describe('superAdminInTenant', () => {
    it('is still what provisioning uses, and still says super_admin', () => {
      const scoped = RequestContext.superAdminInTenant(OPERATOR, OFFICE);

      expect(scoped.platformRole).toBe('super_admin');
      expect(scoped.kpmId).toBe(OFFICE);
      expect(scoped.membershipId).toBeNull();
    });
  });
});

/**
 * **The effective Core Leader** (ADR-0159 §1, §4; P18.5-T5 AC-1): the tag on a leader class — one rule, read by the
 * context, the directory, the forum and KPM analytics alike.
 */
describe('the Core Leader', () => {
  const member = (role: HierarchyRole, isCoreLeader?: boolean) => new RequestContext('u', 'none', {
    membershipId: 'm', kpmId: 'k', orgLevelCode: role.toUpperCase(), hierarchyRole: role, status: 'active',
    isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...(isCoreLeader === undefined ? {} : { isCoreLeader }),
  });

  it.each([
    ['ab', true, true], ['aab', true, true], ['agent', true, false],
    ['ab', false, false], ['aab', undefined, false],
  ] as const)('a %s tagged %s is one: %s', (role, tagged, expected) => {
    expect(member(role, tagged).isCoreLeader).toBe(expected);
    expect(isEffectiveCoreLeader({ role, isCoreLeader: tagged })).toBe(expected);
  });

  it('nobody outside an office is one, and nothing without a row is', () => {
    expect(new RequestContext('u', 'none', null).isCoreLeader).toBe(false);
    expect(RequestContext.platform('root').isCoreLeader).toBe(false);
    expect(isEffectiveCoreLeader(null)).toBe(false);
    expect(isEffectiveCoreLeader({ isCoreLeader: true, role: null })).toBe(false);
  });
});

/**
 * **P18.10-T5 AC-1 — the reader is on the context** (ADR-0179 §7): resolved once by `AuthGuard`, what every service
 * writes a sentence for. A context built for a job, or by hand, reads as a reader who has chosen nothing.
 */
describe('P18.10-T5 the context’s reader', () => {
  const member = {
    membershipId: 'm1', kpmId: 'k1', orgLevelCode: 'AB', hierarchyRole: 'ab' as const, status: 'active' as const,
    isKpmOwner: false, isKpmAdmin: false, directCount: 0,
  };

  it('AC-1 reads as nobody’s choice when nothing resolved one: Bahasa Indonesia, words and figures, as it is live', () => {
    expect(new RequestContext('u1', 'none', member).reader).toEqual({ language: 'id', figures: 'id' });
    expect(RequestContext.forJob('k1', 'nightly').reader).toEqual({ language: 'id', figures: 'id' });
  });

  it('AC-1 carries the reader it was given', () => {
    const ctx = new RequestContext('u1', 'none', member, null, null, false, false, { language: 'id', figures: 'id' });
    expect(ctx.reader).toEqual({ language: 'id', figures: 'id' });
  });

  it('AC-1 answers the same context for another reader, every other fact kept', () => {
    const session = new RequestContext('u1', 'none', member, 'root', null, true, true);
    const indonesian = session.withReader({ language: 'id', figures: 'id' });
    expect(indonesian).not.toBe(session);
    expect(indonesian.reader).toEqual({ language: 'id', figures: 'id' });
    expect(indonesian).toMatchObject({
      userId: 'u1', impersonatorUserId: 'root', mustChangePassword: true, impersonationReadOnly: true, membership: member,
    });
    expect(Object.isFrozen(indonesian)).toBe(true);
    // The office a Super Admin acts inside travels too.
    expect(RequestContext.superAdminInTenant('root', 'k9').withReader({ language: 'id', figures: 'id' }).kpmId).toBe('k9');
  });

  it('AC-1 keeps the reader of the request somebody joins an office from', () => {
    const asked = new RequestContext('u1', 'none', null, null, null, false, false, { language: 'id', figures: 'id' });
    expect(RequestContext.joiningTenant(asked, 'k1').reader).toEqual({ language: 'id', figures: 'id' });
  });
});
