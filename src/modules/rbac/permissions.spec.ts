import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HierarchyRole, RequestContext } from '@/common/context/request-context';
import { can, PERMISSIONS, Permission, Scope, scopeFor } from './permissions';

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

    /**
     * The matrix is six columns of scopes, and until 2026-09-06 nothing compared them to
     * anything. `toContain(permission)` above asks only whether the *name* occurs
     * somewhere in the file — which is how `leader_request:approve` sat documented at
     * `own-kpm` for a KPM Admin while the code granted it to nobody but a leader, through
     * an entire phase, with the row visible in the doc the whole time.
     *
     * This reads the cells. Every difference is either fixed or listed below with the
     * reason it stands, so drift cannot arrive silently again.
     */
    const COLUMNS = [
      'SUPER_ADMIN', 'KPM_OWNER', 'KPM_ADMIN', 'AB', 'AAB', 'AGENT',
    ] as const;
    const WIDENING: Scope[] = ['own', 'own-unit', 'own-downline', 'own-kpm', 'all'];

    /**
     * Documented grants the code deliberately does not implement yet, each with the
     * reason and what settles it. Emptying this list is the goal; adding to it without a
     * reason is the thing it exists to prevent.
     */
    const DEFERRED: Record<string, string> = {
      'kpm:read_profile/AB': 'branch info for a member is a later phase; the only route on ' +
        'this permission today is GET /admin/tenants/:id, and granting it here would open ' +
        'an /admin route to agents',
      'kpm:read_profile/AAB': 'as AB',
      'kpm:read_profile/AGENT': 'as AB',
      'member:change_role/SUPER_ADMIN': 'the member routes resolve kpmId from the caller\'s ' +
        'membership, which a Super Admin has none of — the grant would produce ' +
        'MissingTenantContextError, not access. A Super Admin reaches an office by ' +
        'impersonation; a cross-tenant console route is Phase 3.5.',
      'org_tree:read/SUPER_ADMIN': 'as member:change_role — and this one was granted for a ' +
        'while: GET /members/tree passed the guard and then answered 500 INTERNAL_ERROR, ' +
        'because the repository throws MissingTenantContextError when there is no kpmId. ' +
        'Found at the Phase 3.5 exit review.',
      'member:invite/SUPER_ADMIN': 'as member:change_role',
      'member:read_profile/SUPER_ADMIN': 'as member:change_role',
      'member:remove_from_team/SUPER_ADMIN': 'as member:change_role',
      'notification:receive/KPM_OWNER': 'notifications are delivered but not yet subscribed ' +
        'to by office or by unit; the routing phase implements the wider scopes',
      'notification:receive/KPM_ADMIN': 'as KPM_OWNER',
      'notification:receive/AB': 'as KPM_OWNER — own-unit delivery is the routing phase',
      'notification:receive/AAB': 'as KPM_OWNER',
    };

    /** The widest scope the matrix gives this permission in this column, or null. */
    function documented(permission: string): Array<Scope | null> {
      const cells: Array<Scope | null> = [null, null, null, null, null, null];
      for (const line of doc.split('\n')) {
        if (!line.startsWith('| `')) continue;
        const parts = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (parts.length !== 7) continue;

        // A row may name several permissions — `leader_request:approve` / `decline` — and
        // the second is written as a bare suffix sharing the first one's namespace.
        const names = [...parts[0].matchAll(/`([a-z_]+:?[a-z_]*)`/g)].map((m) => m[1]);
        if (names.length === 0) continue;
        const namespace = names[0].split(':')[0];
        const full = names.map((n) => (n.includes(':') ? n : `${namespace}:${n}`));
        if (!full.includes(permission)) continue;

        // A permission can appear in several rows under different conditions — change_role
        // is split Agent↔AAB from to/from AB. The grant list holds their union.
        parts.slice(1).forEach((cell, i) => {
          const scopes = [...cell.matchAll(/`([a-z-]+)`/g)]
            .map((m) => m[1] as Scope)
            .filter((v) => WIDENING.includes(v));
          if (scopes.length === 0) return;
          const widest = scopes.reduce((a, b) =>
            WIDENING.indexOf(b) > WIDENING.indexOf(a) ? b : a);
          const held = cells[i];
          if (held === null || WIDENING.indexOf(widest) > WIDENING.indexOf(held)) {
            cells[i] = widest;
          }
        });
      }
      return cells;
    }

    /** What the grant list gives this permission, in the matrix's column order. */
    function implemented(permission: Permission): Array<Scope | null> {
      return COLUMNS.map((column) => {
        const grants = PERMISSIONS[permission] as ReadonlyArray<{
          grantee: { kind: string; role?: string };
          scope: Scope;
        }>;
        const held = grants.filter((g) => {
          if (g.grantee.kind === 'authenticated') return true;
          if (column === 'SUPER_ADMIN') return g.grantee.kind === 'platform';
          if (column === 'KPM_OWNER') return g.grantee.role === 'kpm_owner';
          if (column === 'KPM_ADMIN') return g.grantee.role === 'kpm_admin';
          return g.grantee.role === column.toLowerCase();
        });
        if (held.length === 0) return null;
        return held
          .map((g) => g.scope)
          .reduce((a, b) => (WIDENING.indexOf(b) > WIDENING.indexOf(a) ? b : a));
      });
    }

    it('grants exactly what the matrix documents, cell by cell', () => {
      const drift: string[] = [];
      for (const permission of Object.keys(PERMISSIONS) as Permission[]) {
        const documentedCells = documented(permission);
        // A permission with no matrix row at all is caught by the test above.
        if (documentedCells.every((c) => c === null)) continue;

        implemented(permission).forEach((code, i) => {
          const expected = documentedCells[i];
          if (code === expected) return;
          const key = `${permission}/${COLUMNS[i]}`;
          if (DEFERRED[key]) return;
          drift.push(`${key}: code=${code ?? '—'} doc=${expected ?? '—'}`);
        });
      }
      expect(drift).toEqual([]);
    });

    it('defers nothing that the code has since implemented', () => {
      // A stale deferral is how a list like this rots into a permanent excuse.
      const stale = Object.keys(DEFERRED).filter((key) => {
        const [permission, column] = key.split('/');
        const i = COLUMNS.indexOf(column as (typeof COLUMNS)[number]);
        return implemented(permission as Permission)[i] === documented(permission)[i];
      });
      expect(stale).toEqual([]);
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

    it('gives an admin who is a plain agent the office, not a unit', () => {
      // This asserted the opposite until 2026-09-06 — that an agent-Admin is *refused*
      // `leader_request:approve` — and it was wrong twice over. §1.6 gives an Admin the
      // Owner's whole operational surface minus four reserved powers, and approving a
      // join is not among them; the matrix has said `own-kpm` all along. Approving a
      // join is an office action, not an AB right, so it was a poor example of the
      // orthogonality this block is about.
      //
      // What is actually orthogonal: admin rights arrive from the office and hierarchy
      // rights from the graph. An agent-Admin administers the office and still leads
      // nobody — leadership is `directCounts.total > 0` (OD-23), which no permission
      // can confer.
      const agentAdmin = ctx({ role: 'agent', admin: true });
      expect(can(agentAdmin, 'audit_log:read')).toBe(true);
      expect(can(agentAdmin, 'leader_request:approve')).toBe(true);
      expect(scopeFor(agentAdmin, 'leader_request:approve')).toBe('own-kpm');

      // …and gains nothing the Owner keeps.
      expect(can(agentAdmin, 'kpm_admin:grant')).toBe(false);
    });

    it('refuses the office-wide queue to a leader who is not an admin', () => {
      // The other direction: an AB decides what was addressed to them, never the office.
      expect(scopeFor(ctx({ role: 'ab' }), 'leader_request:approve')).toBe('own-unit');
      expect(scopeFor(ctx({ role: 'aab' }), 'leader_request:approve')).toBe('own-unit');
      expect(can(ctx({ role: 'agent' }), 'leader_request:approve')).toBe(false);
    });

    it('keeps the role change log to the office administration', () => {
      // It was gated on `member:read_profile`, which every member holds — so an agent
      // could read every role change in the office, with names and reasons, for people
      // whose roster row they cannot see.
      expect(can(ctx({ owner: true }), 'member:read_role_change_log')).toBe(true);
      expect(can(ctx({ admin: true }), 'member:read_role_change_log')).toBe(true);
      for (const role of ['ab', 'aab', 'agent'] as const) {
        expect(can(ctx({ role }), 'member:read_role_change_log')).toBe(false);
      }
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
    /**
     * Exactly two, and both exist so that somebody in no office can get into one.
     * `roles-and-permissions.md` says it outright: the office directory is granted to
     * every authenticated user *including one with no KPM yet*, because otherwise
     * nobody could ever join.
     */
    const JOIN_FLOW: readonly Permission[] = [
      'kpm:read_directory',
      'kpm_registration:create',
      // The other door: redeeming a leader's invite skips the search and the approval,
      // and the person redeeming one is by definition in no office yet.
      'join_via_code_link_qr',
      // The third: asking for an office that does not exist. Somebody whose branch has
      // never been provisioned cannot find it in the directory, and until 2026-09-06 the
      // product had no answer for them at all (ADR-0011).
      'kpm_request:create',
      // Not a door, but held by the same person for the same reason: their own inbox,
      // whose first row is the email verification that gets them in.
      'notification:read_inbox',
      'notification:mark_read',
    ];

    it('holds only the permissions that let somebody join, and nothing else', () => {
      const stranger = ctx({ noMembership: true });
      for (const p of Object.keys(PERMISSIONS) as Permission[]) {
        expect([p, can(stranger, p)]).toEqual([p, JOIN_FLOW.includes(p)]);
      }
    });

    it('cannot search for a leader before registering an office', () => {
      // The next step in the chain, and it is gated: a leader search is scoped to one
      // office, so there has to be one.
      expect(can(ctx({ noMembership: true }), 'leader:search_directory')).toBe(false);
      expect(can(ctx({ noMembership: true }), 'leader_request:create')).toBe(false);
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

    /**
     * The mirror image: granted to everyone, deliberately, so there is no negative case
     * to find. All three are a way into an office — refusing any of them to somebody
     * outside one would close a door that is the only one they have.
     */
    const UNIVERSAL_GRANTS: readonly string[] = [
      'kpm:read_directory',
      'kpm_registration:create',
      'join_via_code_link_qr',
      // Asking for an office that has never existed. The service, not the grant, is what
      // refuses somebody who already belongs somewhere — a permission cannot express
      // "unless you already did this".
      'kpm_request:create',
      // A notification is addressed to a person, and the first one anybody receives is
      // their own email verification — sent before they have joined anything.
      'notification:read_inbox',
      'notification:mark_read',
    ];

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
      if (UNIVERSAL_GRANTS.includes(p)) {
        expect(results.every(Boolean)).toBe(true);
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
