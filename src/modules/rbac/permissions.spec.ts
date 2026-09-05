import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HierarchyRole, RequestContext } from '@/common/context/request-context';
import { can, PERMISSIONS, Permission, scopeFor } from './permissions';

function ctx(opts: {
  superAdmin?: boolean;
  role?: HierarchyRole;
  owner?: boolean;
  admin?: boolean;
  status?: 'active' | 'pending' | 'removed';
  noMembership?: boolean;
}): RequestContext {
  return new RequestContext(
    'u1',
    opts.superAdmin ? 'super_admin' : 'none',
    opts.noMembership
      ? null
      : {
          membershipId: 'mem-1',
          kpmId: 'kpm-a',
          hierarchyRole: opts.role ?? 'agent',
          status: opts.status ?? 'active',
          isKpmOwner: opts.owner ?? false,
          isKpmAdmin: opts.admin ?? false, directCount: 0,
        },
  );
}

describe('permission matrix', () => {
  describe('code and documentation agree', () => {
    // The matrix is documented for humans and executed by machines. If the two drift,
    // one of them is lying and reviewers cannot tell which.
    const doc = readFileSync(
      join(__dirname, '../../../../docs/00-product/roles-and-permissions.md'),
      'utf8',
    );

    it.each(Object.keys(PERMISSIONS))('%s appears in roles-and-permissions.md', (permission) => {
      expect(doc).toContain(permission);
    });

    it('documents at least as many permissions as the code defines', () => {
      const documented = new Set(doc.match(/`[a-z_]+:[a-z_]+`/g)?.map((m) => m.slice(1, -1)) ?? []);
      const inCode = Object.keys(PERMISSIONS);
      expect(documented.size).toBeGreaterThanOrEqual(inCode.length);
    });
  });

  describe('platform permissions', () => {
    it('lets only a Super Admin create a KPM', () => {
      expect(can(ctx({ superAdmin: true }), 'kpm:create')).toBe(true);
      for (const other of [
        ctx({ owner: true }),
        ctx({ admin: true }),
        ctx({ role: 'ab' }),
        ctx({ role: 'aab' }),
        ctx({ role: 'agent' }),
        ctx({ noMembership: true }),
      ]) {
        expect(can(other, 'kpm:create')).toBe(false);
      }
    });

    it('lets only a Super Admin impersonate', () => {
      expect(can(ctx({ superAdmin: true }), 'impersonation:start')).toBe(true);
      expect(can(ctx({ owner: true }), 'impersonation:start')).toBe(false);
      expect(can(ctx({ admin: true }), 'impersonation:start')).toBe(false);
    });
  });

  describe('tenant-admin rights are independent of hierarchy role', () => {
    it('grants an AB who is also a KPM Admin both sets', () => {
      const abAdmin = ctx({ role: 'ab', admin: true });
      expect(can(abAdmin, 'leader_request:approve')).toBe(true); // from AB
      expect(can(abAdmin, 'audit_log:read')).toBe(true); // from KPM Admin
    });

    it('does not grant admin rights to an AB who is not an admin', () => {
      expect(can(ctx({ role: 'ab' }), 'audit_log:read')).toBe(false);
    });

    it('does not grant AB rights to an admin who is a plain agent', () => {
      const agentAdmin = ctx({ role: 'agent', admin: true });
      expect(can(agentAdmin, 'leader_request:approve')).toBe(false);
      expect(can(agentAdmin, 'audit_log:read')).toBe(true);
    });

    it('reserves owner-only actions from an admin', () => {
      expect(can(ctx({ owner: true }), 'kpm_admin:grant')).toBe(true);
      expect(can(ctx({ admin: true }), 'kpm_admin:grant')).toBe(false);
      expect(can(ctx({ owner: true }), 'kpm:update_identity')).toBe(true);
      expect(can(ctx({ admin: true }), 'kpm:update_identity')).toBe(false);
    });
  });

  describe('scope resolution', () => {
    it('gives a leader reach over their unit and an agent only their own', () => {
      expect(scopeFor(ctx({ role: 'ab' }), 'member:read_profile')).toBe('own-downline');
      expect(scopeFor(ctx({ role: 'aab' }), 'member:read_profile')).toBe('own-unit');
      expect(scopeFor(ctx({ role: 'agent' }), 'member:read_profile')).toBe('own');
      expect(scopeFor(ctx({ owner: true }), 'member:read_profile')).toBe('own-kpm');
      expect(scopeFor(ctx({ superAdmin: true }), 'kpm:read_profile')).toBe('all');
    });

    it('takes the widest scope when several grants apply', () => {
      // An AB who is also the KPM Owner reads the whole office, not just a downline.
      expect(scopeFor(ctx({ role: 'ab', owner: true }), 'member:read_profile')).toBe('own-kpm');
    });

    it('returns null rather than a scope when the permission is not held', () => {
      expect(scopeFor(ctx({ role: 'agent' }), 'kpm:create')).toBeNull();
    });
  });

  describe('membership status gates hierarchy rights', () => {
    it.each(['pending', 'removed'] as const)('denies a %s member their role rights', (status) => {
      expect(can(ctx({ role: 'ab', status }), 'leader_request:approve')).toBe(false);
    });

    it('grants them to an active member', () => {
      expect(can(ctx({ role: 'ab', status: 'active' }), 'leader_request:approve')).toBe(true);
    });

    it('still honours a tenant-admin grant, which is not a hierarchy right', () => {
      // Admin access is granted per person, not derived from their place in the tree.
      expect(can(ctx({ role: 'ab', status: 'removed', admin: true }), 'audit_log:read')).toBe(
        true,
      );
    });
  });

  describe('a user with no membership', () => {
    it('holds no tenant or hierarchy permission', () => {
      const stranger = ctx({ noMembership: true });
      for (const p of Object.keys(PERMISSIONS) as Permission[]) {
        expect(can(stranger, p)).toBe(false);
      }
    });

    it('is still valid — that is the new agent who has not joined an office', () => {
      expect(ctx({ noMembership: true }).kpmId).toBeNull();
    });
  });

  describe('every permission has a positive and a negative case', () => {
    /**
     * Permissions granted to nobody, on purpose. These are denial rows in the
     * documentation — recording that a thing is forbidden is as much a decision as
     * recording who may do it.
     */
    const DELIBERATE_DENIALS: readonly string[] = ['impersonation:target_super_admin'];

    const ALL = [
      ctx({ superAdmin: true }),
      ctx({ owner: true }),
      ctx({ admin: true }),
      ctx({ role: 'ab' }),
      ctx({ role: 'aab' }),
      ctx({ role: 'agent' }),
      ctx({ noMembership: true }),
    ];

    it.each(Object.keys(PERMISSIONS))('%s is granted to some roles and denied to others', (p) => {
      const results = ALL.map((c) => can(c, p as Permission));

      if (DELIBERATE_DENIALS.includes(p)) {
        expect(results.every((r) => !r)).toBe(true);
        return;
      }
      expect(results.some(Boolean)).toBe(true); // somebody can
      expect(results.some((r) => !r)).toBe(true); // somebody cannot
    });

    it('denies impersonating another Super Admin to everyone, including a Super Admin', () => {
      // Dual attribution is what makes impersonation auditable; a Super Admin acting
      // as another Super Admin erases exactly that.
      expect(can(ctx({ superAdmin: true }), 'impersonation:target_super_admin')).toBe(false);
    });
  });
});
