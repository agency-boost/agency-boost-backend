import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HierarchyRole, RequestContext } from '@/common/context/request-context';
import {
  AAB, AB, AGENT, BLOCKED_WHILE_IMPERSONATING, can, isBlockedWhileImpersonating, isOwnerReserved, isReadLike, PERMISSIONS,
  Permission, Scope, scopeFor,
} from './permissions';

/**
 * **An Owner or Admin with no field role**: on a rung of no class at all. Impossible in data — every membership
 * stands on a rung, and every rung gives a class (ADR-0156) — but it is what the Owner and Admin columns of a
 * matrix mean: their tenant grants alone. `agent` stood here until the grants matched by class, when it began to
 * hand the Owner every Agent grant.
 */
const NO_CLASS = 'none' as unknown as HierarchyRole;

function ctx(opts: {
  superAdmin?: boolean;
  role?: HierarchyRole;
  owner?: boolean;
  admin?: boolean;
  status?: 'active' | 'pending' | 'removed';
  noMembership?: boolean;
  /**
   * Inside a support session, and whether it may write (P4-T10). **Every session the server builds is read-only since
   * P19.4-T2** (ADR-0206 §4; `ContextResolver`): `readOnly: false` with an impersonator is a context nothing produces
   * any more, kept below where a test pins the hard-blocked list as its own layer of `can()`.
   */
  impersonatedBy?: string;
  readOnly?: boolean;
}): RequestContext {
  return new RequestContext(
    'u1',
    opts.superAdmin ? 'super_admin' : 'none',
    opts.noMembership
      ? null
      : {
          membershipId: 'mem-1',
          kpmId: 'kpm-a',
          orgLevelCode: (opts.role ?? 'agent').toUpperCase(),
          hierarchyRole: opts.role ?? 'agent',
          status: opts.status ?? 'active',
          isKpmOwner: opts.owner ?? false,
          isKpmAdmin: opts.admin ?? false, directCount: 0,
        },
    opts.impersonatedBy ?? null,
    null,
    false,
    opts.readOnly ?? false,
  );
}

describe('permission matrix', () => {
  /*
   * P4-T10's two controls, at the level `can()` actually decides them. The e2e suite
   * covered them through HTTP, which meant the classifier's own edges were never asserted
   * — and one of them was wrong: `notification:mark_read` ends in `_read` and writes.
   */
  describe('P4-T10: a read-only support session', () => {
    const session = (extra: Parameters<typeof ctx>[0] = {}) =>
      ctx({ role: 'ab', impersonatedBy: 'sa-1', readOnly: true, ...extra });

    it('reads what the target can read', () => {
      expect(can(session(), 'notification:read_inbox')).toBe(true);
      expect(can(session(), 'org_tree:read')).toBe(true);
    });

    it('refuses a write however its permission is spelled', () => {
      // `mark_read` is the trap: it ends in `_read` and destroys unread state — including
      // the notice telling the target their account is being impersonated.
      expect(can(session(), 'notification:mark_read')).toBe(false);
      expect(can(session(), 'tenant_config:write')).toBe(false);
      expect(can(session(), 'member:remove_from_team')).toBe(false);
    });

    it('still refuses the hard-blocked list once it may write', () => {
      const elevated = ctx({ role: 'ab', owner: true, impersonatedBy: 'sa-1', readOnly: false });
      expect(can(elevated, 'kpm_admin:grant')).toBe(false);
    });

    it('leaves an ordinary session alone', () => {
      expect(can(ctx({ role: 'ab' }), 'notification:mark_read')).toBe(true);
    });

    it('N7 a permission with no verb is a write: refused to a read-only session, and never read-like', () => {
      // Every registered permission is `resource:action`; one that is not has no action to read, and
      // the classifier answers on the empty string rather than throwing — a write, fail-closed.
      const verbless = 'notification' as Permission;
      expect(isReadLike(verbless)).toBe(false);
      expect(can(session(), verbless)).toBe(false);
      expect(isReadLike('goal:read')).toBe(true);
      expect(isReadLike('goal:update')).toBe(false);
    });
  });

  /*
   * **P19.4-T2 (ADR-0206 §2 to §4, superseding ADR-0162): view-as only looks.** Each of ADR-0162's *"a setup session
   * writes X"* is pinned the other way round: a session as the Owner or an Admin writes none of the old scope — the
   * settings, the people import, the data upload — and reads what they read. The Super Admin's own `all` comes off
   * the import and the nine `data_upload:*` grants; the Owner and the Admin keep `own-kpm`.
   */
  describe('P19.4-T2: view-as only looks (ADR-0206)', () => {
    const OLD_SETUP_SCOPE = [
      'tenant_config:write', 'kpm:import_roster',
      'data_upload:read', 'data_upload:download_template', 'data_upload:upload_and_preview', 'data_upload:commit_import',
      'data_upload:revert_batch', 'data_upload:read_history', 'data_upload:correct_cell', 'data_upload:lock_month',
      'data_upload:reopen_month',
    ] as const satisfies readonly Permission[];
    const DATA_UPLOAD = OLD_SETUP_SCOPE.filter((p) => p.startsWith('data_upload:'));
    const session = (extra: Parameters<typeof ctx>[0] = {}) =>
      ctx({ role: NO_CLASS, owner: true, impersonatedBy: 'sa-1', readOnly: true, ...extra });
    const superAdmin = ctx({ superAdmin: true, noMembership: true });

    it('P19.4-T2 AC-4 the Super Admin holds neither kpm:import_roster nor any of the nine data_upload grants', () => {
      expect(DATA_UPLOAD).toHaveLength(9);
      for (const permission of ['kpm:import_roster', ...DATA_UPLOAD] as Permission[]) {
        expect([permission, scopeFor(superAdmin, permission)]).toEqual([permission, null]);
        expect(PERMISSIONS[permission].map((g) => g.grantee)).not.toContain(PERMISSIONS['kpm:create'][0].grantee);
      }
    });

    it('P19.4-T2 AC-4 the Owner and the Admin keep both, for their own KPM; no leader and no Agent holds either', () => {
      for (const permission of ['kpm:import_roster', ...DATA_UPLOAD] as Permission[]) {
        expect([permission, scopeFor(ctx({ role: NO_CLASS, owner: true }), permission)]).toEqual([permission, 'own-kpm']);
        expect([permission, scopeFor(ctx({ role: NO_CLASS, admin: true }), permission)]).toEqual([permission, 'own-kpm']);
        for (const role of ['ab', 'aab', 'agent'] as const) {
          expect([permission, role, can(ctx({ role }), permission)]).toEqual([permission, role, false]);
        }
      }
    });

    it('P19.4-T2 AC-1 impersonation:elevate_to_write is gone from the registry, with the route it guarded', () => {
      expect(Object.keys(PERMISSIONS)).not.toContain('impersonation:elevate_to_write');
      expect(Object.keys(PERMISSIONS)).toContain('impersonation:start');
    });

    it.each(OLD_SETUP_SCOPE.filter((p) => !isReadLike(p)))('P19.4-T2 AC-2 %s: a session as the Owner or an Admin may not write it', (permission) => {
      expect(can(session(), permission)).toBe(false);
      expect(can(session({ owner: false, admin: true }), permission)).toBe(false);
      // The Owner themselves, as ever.
      expect(can(ctx({ role: NO_CLASS, owner: true }), permission)).toBe(true);
    });

    it('P19.4-T2 AC-2 a session as the Owner writes nothing at all, and reads what the Owner reads', () => {
      // The Owner is their office's root AB: a session as them holds the AB's grants too, and may write none.
      const asRootAb = session({ role: 'ab' });
      const writes = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => !isReadLike(p));
      expect(writes.filter((p) => can(asRootAb, p))).toEqual([]);
      for (const read of ['tenant_config:read', 'lead:read', 'data_upload:read', 'data_upload:read_history'] as Permission[]) {
        expect([read, can(asRootAb, read)]).toEqual([read, true]);
      }
    });

    it('P19.4-T2 AC-2 the blocked list still applies to every session', () => {
      for (const permission of BLOCKED_WHILE_IMPERSONATING) {
        expect([permission, can(session({ role: 'ab' }), permission)]).toEqual([permission, false]);
      }
    });

    it('AC-3 activity_log:create is on the blocked list: refused to every session, elevated included', () => {
      expect(isBlockedWhileImpersonating('activity_log:create')).toBe(true);
      for (const role of ['ab', 'aab', 'agent'] as const) {
        expect(can(ctx({ role, impersonatedBy: 'sa-1', readOnly: false }), 'activity_log:create')).toBe(false);
        expect(can(ctx({ role, impersonatedBy: 'sa-1', readOnly: true }), 'activity_log:create')).toBe(false);
        // The member themselves, as ever.
        expect(can(ctx({ role }), 'activity_log:create')).toBe(true);
      }
    });

    it('AC-3 activity_log:update, the correction, is on the blocked list too: refused to every session, elevated included', () => {
      expect(isBlockedWhileImpersonating('activity_log:update')).toBe(true);
      for (const role of ['ab', 'aab', 'agent'] as const) {
        expect(can(ctx({ role, impersonatedBy: 'sa-1', readOnly: false }), 'activity_log:update')).toBe(false);
        expect(can(ctx({ role, impersonatedBy: 'sa-1', readOnly: true }), 'activity_log:update')).toBe(false);
        // The member themselves, as ever.
        expect(can(ctx({ role }), 'activity_log:update')).toBe(true);
      }
    });
  });

  /*
   * P18.8-T3 (ADR-0170): **+ Add agent** and the transfer it may ask for. A leader adds to their own unit, the office
   * anywhere; nobody else, and no session that is not the member's own write.
   */
  describe('P18.8-T3 member:invite and member:transfer_approve', () => {
    it('P18.8-T3 AC-7 member:invite: an AB and an AAB their own unit, the Owner and an Admin the office; an Agent and the Super Admin none', () => {
      expect(scopeFor(ctx({ role: 'ab' }), 'member:invite')).toBe('own-unit');
      expect(scopeFor(ctx({ role: 'aab' }), 'member:invite')).toBe('own-unit');
      expect(scopeFor(ctx({ role: NO_CLASS, owner: true }), 'member:invite')).toBe('own-kpm');
      expect(scopeFor(ctx({ role: NO_CLASS, admin: true }), 'member:invite')).toBe('own-kpm');
      expect(can(ctx({ role: 'agent' }), 'member:invite')).toBe(false);
      expect(can(ctx({ superAdmin: true, noMembership: true }), 'member:invite')).toBe(false);
      // A pending member is let in by somebody else; they add nobody.
      expect(can(ctx({ role: 'ab', status: 'pending' }), 'member:invite')).toBe(false);
    });

    it('P18.8-T3 AC-7 member:transfer_approve: the Owner and an Admin, and no leader — nobody decides their own request', () => {
      expect(scopeFor(ctx({ role: NO_CLASS, owner: true }), 'member:transfer_approve')).toBe('own-kpm');
      expect(scopeFor(ctx({ role: NO_CLASS, admin: true }), 'member:transfer_approve')).toBe('own-kpm');
      for (const role of ['ab', 'aab', 'agent'] as const) expect([role, can(ctx({ role }), 'member:transfer_approve')]).toEqual([role, false]);
      expect(can(ctx({ superAdmin: true, noMembership: true }), 'member:transfer_approve')).toBe(false);
    });

    it('P18.8-T3 AC-7 neither is a session’s: every session only looks (P19.4-T2); not blocked outright, as the member writes it', () => {
      for (const permission of ['member:invite', 'member:transfer_approve'] as const) {
        expect(isReadLike(permission)).toBe(false);
        expect(can(ctx({ role: 'ab', owner: true, impersonatedBy: 'sa-1', readOnly: true }), permission)).toBe(false);
        expect(isBlockedWhileImpersonating(permission)).toBe(false);
      }
    });
  });

  describe('P19.7-T2 the proposal’s five grants (ADR-0221 §2; roles §3.7)', () => {
    const PROPOSAL_GRANTS = [
      'proposal:create', 'proposal:read', 'proposal:update', 'proposal:delete', 'proposal:download',
    ] as const;

    it('P19.7-T2 AC-1 gives the AB, the AAB and the Agent each one `own`, and nothing wider', () => {
      for (const permission of PROPOSAL_GRANTS) {
        for (const role of ['ab', 'aab', 'agent'] as const) {
          expect([permission, role, scopeFor(ctx({ role }), permission)]).toEqual([permission, role, 'own']);
        }
      }
    });

    it('P19.7-T2 AC-13 gives the Owner and an Admin none as such, and the Super Admin none: no leader’s or office reach', () => {
      for (const permission of PROPOSAL_GRANTS) {
        expect([permission, can(ctx({ role: NO_CLASS, owner: true }), permission)]).toEqual([permission, false]);
        expect([permission, can(ctx({ role: NO_CLASS, admin: true }), permission)]).toEqual([permission, false]);
        expect([permission, can(ctx({ superAdmin: true, noMembership: true }), permission)]).toEqual([permission, false]);
      }
    });

    it('P19.7-T2 AC-1 lets the Owner and an Admin make their own in Akun saya, through their own rung', () => {
      expect(scopeFor(ctx({ role: 'ab', owner: true }), 'proposal:create')).toBe('own');
      expect(scopeFor(ctx({ role: 'agent', admin: true }), 'proposal:update')).toBe('own');
    });

    it('P19.7-T2 AC-14 a view-only session reads (proposal:read) and is refused every other grant, the PDF included (Acc. 22)', () => {
      const viewAs = ctx({ role: 'agent', impersonatedBy: 'sa-1', readOnly: true });
      expect(can(viewAs, 'proposal:read')).toBe(true);
      for (const permission of ['proposal:create', 'proposal:update', 'proposal:delete', 'proposal:download'] as const) {
        expect([permission, isReadLike(permission), can(viewAs, permission)]).toEqual([permission, false, false]);
      }
    });
  });

  describe('code and documentation agree', () => {
    // The matrix is documented for humans and executed by machines. If the two drift,
    // one of them is lying and reviewers cannot tell which.
    const doc = readFileSync(
      join(__dirname, '../../../../docs/00-product/roles-and-permissions.md'),
      'utf8',
    );

    /**
     * Every row of the matrix: the permissions it names, and its six cells.
     *
     * A row may name several permissions — `leader_request:approve` / `decline` — and the second is
     * written as a bare suffix sharing the first one's namespace.
     */
    const ROWS = doc.split('\n').flatMap((line) => {
      if (!line.startsWith('| `')) return [];
      const parts = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (parts.length !== 7) return [];
      const names = [...parts[0].matchAll(/`([a-z_]+:?[a-z_]*)`/g)].map((m) => m[1]);
      if (names.length === 0) return [];
      const namespace = names[0].split(':')[0];
      return [{
        names: names.map((n) => (n.includes(':') ? n : `${namespace}:${n}`)),
        cells: parts.slice(1),
      }];
    });

    it.each(Object.keys(PERMISSIONS))('%s appears in roles-and-permissions.md', (permission) => {
      // Spelled out, or as a matrix row's bare suffix: `coaching_session:create` / `edit` (P11-T3).
      const named = doc.includes(permission) || ROWS.some((row) => row.names.includes(permission));
      expect([permission, named]).toEqual([permission, true]);
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
      // `kpm:read_profile` for the AB, the AAB and the Agent: no longer deferred (the Phase 17 exit review). The
      // code is the truth — they do not hold it — and roles §3.2 says "—" for the three, pinned cell by cell.
      'member:change_role/SUPER_ADMIN': 'the member routes resolve kpmId from the caller\'s ' +
        'membership, which a Super Admin has none of — the grant would produce ' +
        'MissingTenantContextError, not access. A Super Admin reaches an office by ' +
        'impersonation; a cross-tenant console route is Phase 3.1.',
      'org_tree:read/SUPER_ADMIN': 'as member:change_role — and this one was granted for a ' +
        'while: GET /members/tree passed the guard and then answered 500 INTERNAL_ERROR, ' +
        'because the repository throws MissingTenantContextError when there is no kpmId. ' +
        'Found at the Phase 3.1 exit review.',
      'member:read_profile/SUPER_ADMIN': 'as member:change_role',
      'member:remove_from_team/SUPER_ADMIN': 'as member:change_role',
      'notification:receive/KPM_OWNER': 'notifications are delivered but not yet subscribed ' +
        'to by office or by unit; the routing phase implements the wider scopes',
      'notification:receive/KPM_ADMIN': 'as KPM_OWNER',
      'notification:receive/AB': 'as KPM_OWNER — own-unit delivery is the routing phase',
      'notification:receive/AAB': 'as KPM_OWNER',
      // `commission_rates:read` for the field roles is granted since the catalog's field read carries
      // the schedule (Phase 14, OD-135): its five deferrals are gone with it.
    };

    /**
     * **Every token in a cell, not only the widest** (P11-T3).
     *
     * This compared the widest scope per cell until coaching brought cells that hold two —
     * `own` · `own-downline`, an AB who coaches and is coached. §3 says a wider token never silently
     * includes the reader's own records, so a registry granting `own-downline` alone would have
     * passed while dropping the `own` the matrix states. A cell is compared as the whole set, in
     * widening order, and `—` as null.
     */
    function spelled(scopes: Set<Scope>): string | null {
      if (scopes.size === 0) return null;
      return WIDENING.filter((scope) => scopes.has(scope)).join(' · ');
    }

    /** The scopes the matrix gives this permission in each column. */
    function documented(permission: string): Array<string | null> {
      const cells = COLUMNS.map(() => new Set<Scope>());
      // A permission can appear in several rows under different conditions — change_role is split
      // Agent↔AAB from to/from AB. The grant list holds their union.
      for (const row of ROWS.filter((r) => r.names.includes(permission))) {
        row.cells.forEach((cell, i) => {
          for (const [, token] of cell.matchAll(/`([a-z-]+)`/g)) {
            if (WIDENING.includes(token as Scope)) cells[i].add(token as Scope);
          }
        });
      }
      return cells.map(spelled);
    }

    /** What the grant list gives this permission, in the matrix's column order. */
    function implemented(permission: Permission): Array<string | null> {
      return COLUMNS.map((column) => {
        const grants = PERMISSIONS[permission] as ReadonlyArray<{
          grantee: { kind: string; role?: string; roleClass?: string };
          scope: Scope;
        }>;
        const held = grants.filter((g) => {
          if (g.grantee.kind === 'authenticated') return true;
          if (column === 'SUPER_ADMIN') return g.grantee.kind === 'platform';
          if (column === 'KPM_OWNER') return g.grantee.role === 'kpm_owner';
          if (column === 'KPM_ADMIN') return g.grantee.role === 'kpm_admin';
          // By class since ADR-0156: the column headings name the three classes, upper-cased —
          // which are the default ladder's codes, so the matrix reads as it always did.
          return g.grantee.kind === 'hierarchy' && g.grantee.roleClass === column.toLowerCase();
        });
        return spelled(new Set(held.map((g) => g.scope)));
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

    /**
     * **Doc → code, by name** (the Phase 18.1 permission review, M2). This compared a count until then: the
     * document had to name at least as many permissions as the code, which passed whatever the names were. Now
     * every permission a row of §3's matrix names — struck rows included, a row's `(annotation)` aside — is in
     * `PERMISSIONS`, or listed below with the one-line reason it is not.
     */
    const MATRIX = doc.slice(doc.indexOf('\n## 3. The permission matrix'), doc.indexOf('\n## 4. Navigation by role'));
    const NAMED_IN_MATRIX = new Set(MATRIX.split('\n').flatMap((line) => {
      if (!/^\| (~~)?`/.test(line)) return [];
      const parts = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (parts.length !== 7) return [];
      const names = [...parts[0].replace(/\([^)]*\)/g, '').matchAll(/`([a-z_]+(?::[a-z_]+)?)`/g)].map((m) => m[1]);
      if (names.length === 0) return [];
      const namespace = names[0].split(':')[0];
      return names.map((n, i) => (n.includes(':') || i === 0 ? n : `${namespace}:${n}`));
    }));

    const STRUCK = 'struck in §3: the row stays as the dated record of a permission that was removed or folded';
    const DENIAL = 'a denial row, granted to nobody: there is no route for it to guard';
    const DERIVED = 'derived from the read it inherits: no route of its own, and the reads answer for it';
    const UNDECLARED = 'documented, and no route declares it: what it describes is guarded by another permission or not built';
    /** Documented in §3 and deliberately not in `PERMISSIONS`. Adding to it without a reason is what it exists to prevent. */
    const DOCUMENTED_NOT_IN_CODE: Record<string, string> = {
      'leader_meeting:manage_coeditors': `${STRUCK} (D-coeditors: the Core Leader tag is the list)`,
      'leader_meeting:export_pdf': `${DERIVED} (\`read\` and \`read_shared_link\`, \`can.print\`)`,
      'export:any': DERIVED,
      'member:revoke_invite': `${STRUCK} (P3.2-T1)`,
      'new_hire:mark_left': `${STRUCK} (UI V1, UI-025: retired with its route, ADR-0180 §6)`,
      'org_tree:drill_to_unit_dashboard': `${STRUCK} (P15-T0, D-reach)`,
      'coaching_note:write': STRUCK,
      'coaching_session:share': STRUCK,
      'rollup:recompute_backfill': STRUCK,
      'attack_plan:generate': `${STRUCK} (OD-133: nothing is generated or stored)`,
      'attack_plan:attach_to_lead': `${STRUCK} (OD-133)`,
      'attack_plan:read_telemetry': `${STRUCK} (OD-133)`,
      'sales_attack_plan:read': `${STRUCK} (folded into \`product_catalog:read\`, OD-133)`,
      'activity_log:proxy_create': DENIAL,
      'campaign_qualification:evaluate': `${DENIAL} (qualification is computed by the system)`,
      'leader_request:decline': 'the decline route is guarded by `leader_request:approve`, which the same row names',
      'impersonation:stop': 'ending a support session needs only the session: `POST /admin/impersonate/end` declares no permission',
      'campaign_payout:mark': `${STRUCK} (OD-155: no payouts in v1 — the final standing is the record, the office pays outside the product)`,
      'campaign_payout:reverse_paid': `${STRUCK} (OD-155)`,
      'company_campaign:crud': 'OD-156: company campaigns are deferred beyond v1 — every campaign is the office\'s',
      'company_campaign:hide': 'OD-156: deferred beyond v1, with `company_campaign:crud`',
      // OD-156 (answered 2026-10-10, ADR-0034's second half): company-wide events are deferred beyond v1.
      'company_event:crud': 'deferred beyond v1 (OD-156): an office records a company event it hosts as its own, `issuer: company`',
      'company_event:hide': 'deferred beyond v1 (OD-156): with no company-wide event there is nothing for an office to hide',
      'training_progress:verify': `${STRUCK} (OD-149: completion is the member’s own word, and nothing verifies it)`,
      'recruitment_playbook:write': `${STRUCK} (P19.4-T5, ADR-0210 §2: the playbook is a template section, under \`company_template:write\`)`,
      'impersonation:elevate_to_write': `${STRUCK} (P19.4-T2, ADR-0206 §3: a session only looks, so there is no write to approve)`,
      'member:list_directory': UNDECLARED,
      'member:add_leader_by_code': UNDECLARED,
      'member:reassign_leader': UNDECLARED,
      'member:move_subtree': UNDECLARED,
      'member:read_removed_log': UNDECLARED,
      'member:restore_removed': UNDECLARED,
      'kpm_registration:switch': UNDECLARED,
      'kpm_registration:approve_switch': UNDECLARED,
      'leader:switch': UNDECLARED,
      'goal:set_kpm_defaults_and_floors': UNDECLARED,
      'lead:reassign_owner': UNDECLARED,
      'moc_evaluation:read': UNDECLARED,
      'moc_rules:update': UNDECLARED,
      'production_club_tiers:update': UNDECLARED,
      'notification_preference:read': UNDECLARED,
      'notification_defaults:update': UNDECLARED,
    };

    it('P18.1-T2 AC-1 every permission §3’s matrix names is in the code, or listed with why it is not (M2)', () => {
      expect(NAMED_IN_MATRIX.size).toBeGreaterThan(Object.keys(PERMISSIONS).length);
      const missing = [...NAMED_IN_MATRIX].filter((name) => !(name in PERMISSIONS) && !DOCUMENTED_NOT_IN_CODE[name]);
      expect(missing).toEqual([]);
    });

    it('P18.1-T2 AC-1 lists nothing the code has since built or the matrix no longer names', () => {
      const stale = Object.keys(DOCUMENTED_NOT_IN_CODE).filter((name) => name in PERMISSIONS || !NAMED_IN_MATRIX.has(name));
      expect(stale).toEqual([]);
    });

    it('P18.1-T2 AC-1 the matrix names every permission of the code, by name', () => {
      expect(Object.keys(PERMISSIONS).filter((name) => !NAMED_IN_MATRIX.has(name))).toEqual([]);
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
    });

    it('gives an Admin every settings page the Owner has, Branch info included (ADR-0027)', () => {
      expect(can(ctx({ owner: true }), 'tenant_config:write')).toBe(true);
      expect(can(ctx({ admin: true }), 'tenant_config:write')).toBe(true);
      // Nobody else writes an office's settings: a leader would change what the office
      // counts, and a Super Admin edits the company's template, not the office's copy.
      expect(can(ctx({ role: 'ab' }), 'tenant_config:write')).toBe(false);
      expect(can(ctx({ superAdmin: true, noMembership: true }), 'tenant_config:write')).toBe(false);
    });

    it('holds back from an Admin nothing but managing admins (ADR-0028)', () => {
      /*
       * The product owner's rule, made executable: a KPM Admin can do everything the KPM Owner
       * can, in every feature built and every one to come, except grant or revoke admin
       * access. A new entry here is a product decision about what an Admin may not do, so it
       * fails the build until somebody has made it on purpose, with an ADR.
       */
      const reserved = (Object.keys(PERMISSIONS) as Permission[]).filter(isOwnerReserved).sort();
      expect(reserved).toEqual(['kpm_admin:grant', 'kpm_admin:revoke']);
    });

    it('grants the Admin exactly what it grants the Owner, scope and status alike (ADR-0028)', () => {
      /*
       * Stronger than the test above, which only sees a permission the Owner holds *alone*. An
       * Admin granted a narrower scope than the Owner — `own-unit` against `own-kpm` — would
       * pass that one and still break the rule, so this compares the two grants whole.
       */
      type TenantGrant = {
        grantee: { kind: string; role?: string };
        scope: Scope;
        whileStatus?: readonly string[];
      };
      const as = (grants: readonly TenantGrant[], role: 'kpm_owner' | 'kpm_admin') =>
        grants
          .filter((g) => g.grantee.kind === 'tenant' && g.grantee.role === role)
          .map((g) => `${g.scope}|${[...(g.whileStatus ?? ['active'])].sort().join(',')}`)
          .sort();

      const differ = (Object.keys(PERMISSIONS) as Permission[])
        .filter((permission) => {
          const grants = PERMISSIONS[permission] as readonly TenantGrant[];
          return JSON.stringify(as(grants, 'kpm_owner')) !== JSON.stringify(as(grants, 'kpm_admin'));
        })
        .sort();
      expect(differ).toEqual(['kpm_admin:grant', 'kpm_admin:revoke']);
      // And the one that used to differ is now held by both.
      expect(can(ctx({ admin: true }), 'audit_log:export')).toBe(true);
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

  /*
   * **A rung's leader tier decides its rights** (P18.5-T1 AC-4, ADR-0156 §3). A hierarchy grant matches the class a
   * membership was given from its rung's tier, whatever the rung is called: a company's `SM` marked *Senior Leader*
   * holds exactly AB's grants, its `UM` marked *Associate Leader* exactly AAB's, a rung of no tier exactly AGENT's —
   * and an `AB` rung marked *Not a leader* holds AGENT's, never AB's. Every permission, every scope.
   */
  describe('P18.5-T1 — the leader tier: a grant matches the class, not the rung’s code', () => {
    const PERMS = Object.keys(PERMISSIONS) as Permission[];
    /** A member standing on `orgLevelCode`, of the class its tier gave them. */
    const on = (orgLevelCode: string, role: HierarchyRole, over: Parameters<typeof ctx>[0] = {}) => {
      const base = ctx({ role, ...over });
      return new RequestContext(base.userId, 'none', { ...base.membership!, orgLevelCode });
    };
    const scopes = (c: RequestContext) => PERMS.map((p) => [p, scopeFor(c, p)]);

    it.each([
      ['SM', 'ab'], ['UM', 'aab'], ['FA', 'agent'],
    ] as const)('AC-4 a custom rung %s of class %s holds exactly that class’s grants on the default ladder', (code, role) => {
      expect(scopes(on(code, role))).toEqual(scopes(ctx({ role })));
    });

    it('AC-4 an AB rung marked Not a leader holds the Agent’s grants and none of the AB’s', () => {
      expect(scopes(on('AB', 'agent'))).toEqual(scopes(ctx({ role: 'agent' })));
      expect(can(on('AB', 'agent'), 'leader_request:approve')).toBe(false);
      expect(can(on('SM', 'ab'), 'leader_request:approve')).toBe(true);
    });

    it('AC-4 the class decides for an Owner too, beside their tenant grants (§1.1)', () => {
      expect(scopes(on('SM', 'ab', { owner: true }))).toEqual(scopes(ctx({ role: 'ab', owner: true })));
    });

    it('AC-4 a pending or removed member of a leader class holds no hierarchy right, whatever the rung', () => {
      expect(can(on('SM', 'ab', { status: 'pending' }), 'leader_request:approve')).toBe(false);
      expect(can(on('SM', 'ab', { status: 'removed' }), 'leader_request:approve')).toBe(false);
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
      // Nor these: their own profile, so that somebody in no office can still sign out and
      // correct their details (ADR-0189 §5, P19-T4 AC-5).
      'profile:read_self',
      'profile:update_self',
      // And a link they are a party to (ADR-0199 §1, §5): a link stays if a role changes, and either login removes it.
      'account_link:manage_self',
    ];

    it('holds only the permissions that let somebody join, and nothing else', () => {
      const stranger = ctx({ noMembership: true });
      for (const p of Object.keys(PERMISSIONS) as Permission[]) {
        expect([p, can(stranger, p)]).toEqual([p, JOIN_FLOW.includes(p)]);
      }
    });

    it('P19-T4 AC-5 reads and edits their own profile, as every role does — the profile always opens', () => {
      const stranger = ctx({ noMembership: true });
      expect(can(stranger, 'profile:read_self')).toBe(true);
      expect(can(stranger, 'profile:update_self')).toBe(true);
      expect(scopeFor(stranger, 'profile:read_self')).toBe('own');
      expect(scopeFor(stranger, 'profile:update_self')).toBe('own');
      // A pending or a removed membership too: the page that lets them sign out is never refused.
      for (const status of ['pending', 'removed'] as const) {
        expect(can(ctx({ role: 'agent', status }), 'profile:read_self')).toBe(true);
      }
      for (const who of [ctx({ superAdmin: true, noMembership: true }), ctx({ owner: true }), ctx({ admin: true }),
        ctx({ role: 'ab' }), ctx({ role: 'aab' }), ctx({ role: 'agent' })]) {
        expect(scopeFor(who, 'profile:read_self')).toBe('own');
        expect(scopeFor(who, 'profile:update_self')).toBe('own');
      }
    });

    it('P19-T4 AC-5 still refuses a write to the profile in a read-only support session, and lets it read', () => {
      const session = ctx({ role: 'agent', impersonatedBy: 'sa-1', readOnly: true });
      expect(can(session, 'profile:read_self')).toBe(true);
      expect(can(session, 'profile:update_self')).toBe(false);
      // Nor does the profile reach anybody else's: `own` is the widest it ever is (ADR-0189 §6).
      expect(scopeFor(ctx({ owner: true }), 'profile:update_self')).not.toBe('own-kpm');
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
      // A profile is a person's, never an office's (ADR-0189 §5): everybody signed in reads and edits their own.
      'profile:read_self',
      'profile:update_self',
      // A party to a link, whoever they are now (ADR-0199 §1, §5): the service answers 404 for a link that is not theirs.
      'account_link:manage_self',
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

  /*
   * **Coaching's permissions, a positive and a negative for each of the six roles** (P11-T3 AC-4,
   * §7.2), at the level `can()` decides them — the API refusing what a screen hides.
   *
   * The routes arrive in P11-T5 to T10, each with its own per-role HTTP test; these pin the matrix
   * they will declare. Who is inside a grant's scope — `COACH`, and 404 outside it — is
   * `coach-resolver.tenancy.spec.ts`'s question.
   */
  /*
   * **P19.2-T1 AC-8 — linked logins** (UI-169 item 5; ADR-0199 §1, §7; roles §3.11b): *Tambah akun* is the Owner's, the
   * Admin's and the Super Admin's, `own`, and nobody else's; switching and removing are any party's, `own`; and **neither is
   * held in any support session** — read-only, setup or elevated — so the member's `me` offers no *Tambah akun* there.
   */
  describe('P19.2-T1 AC-8 — linked logins (roles §3.11b, ADR-0199)', () => {
    it.each([
      ['a Super Admin', ctx({ superAdmin: true, noMembership: true }), true],
      ['an Owner', ctx({ owner: true, role: NO_CLASS }), true],
      ['an Admin', ctx({ admin: true, role: NO_CLASS }), true],
      ['an Owner who is also an AB', ctx({ owner: true, role: 'ab' }), true],
      ['an AB', ctx({ role: 'ab' }), false],
      ['an AAB', ctx({ role: 'aab' }), false],
      ['an Agent', ctx({ role: 'agent' }), false],
      ['somebody in no office', ctx({ noMembership: true }), false],
    ])('P19.2-T1 AC-8 account_link:create — %s: %s', (_who, who, allowed) => {
      expect(can(who, 'account_link:create')).toBe(allowed);
      expect(scopeFor(who, 'account_link:create')).toBe(allowed ? 'own' : null);
    });

    it('P19.2-T1 AC-8 account_link:manage_self is any signed-in person’s, own — the service answers 404 for another’s link', () => {
      for (const who of [ctx({ superAdmin: true, noMembership: true }), ctx({ owner: true }), ctx({ role: 'agent' }), ctx({ noMembership: true })]) {
        expect(scopeFor(who, 'account_link:manage_self')).toBe('own');
      }
    });

    it.each([
      ['read-only', { readOnly: true }],
      // The blocked list's own layer: a context no session has since P19.4-T2 (ADR-0206 §4).
      ['elevated', { readOnly: false }],
    ])('P19.2-T1 AC-8 a %s support session holds neither, as the Owner', (_kind, session) => {
      const asOwner = ctx({ owner: true, impersonatedBy: 'sa-1', ...session });
      expect(can(asOwner, 'account_link:create')).toBe(false);
      expect(can(asOwner, 'account_link:manage_self')).toBe(false);
      expect(isBlockedWhileImpersonating('account_link:create')).toBe(true);
      expect(isBlockedWhileImpersonating('account_link:manage_self')).toBe(true);
    });
  });

  describe('P11-T3 — coaching (roles §3.8, functional/coaching.md *The permissions*)', () => {
    const COACHING = [
      'coaching_session:create', 'coaching_session:edit', 'coaching_session:read',
      'coaching_session:finalize', 'coaching_session:reopen', 'coaching_session:export_pdf',
      'coaching_profile:read', 'coaching_profile:update', 'leader_notes:read', 'leader_notes:write',
    ] as const satisfies readonly Permission[];

    /**
     * The six columns, each as nothing more than that role. **The Owner and the Admin stand on no rung** (`NO_CLASS`):
     * since P19.9-T6 the Agent rung holds the coach's grants (ADR-0234), so an Owner on it would read as that Agent —
     * which is the hierarchy (§1.1), and pinned below — and the column is about the office as such.
     */
    const ROLES: Record<string, RequestContext> = {
      SUPER_ADMIN: ctx({ superAdmin: true, noMembership: true }),
      KPM_OWNER: ctx({ owner: true, role: NO_CLASS }),
      KPM_ADMIN: ctx({ admin: true, role: NO_CLASS }),
      AB: ctx({ role: 'ab' }),
      AAB: ctx({ role: 'aab' }),
      AGENT: ctx({ role: 'agent' }),
    };

    /**
     * The widest scope each role holds, or null for `—`, read from the coaching spec's table: **every upline**, the
     * Agent on their rung included since P19.9-T6 (ADR-0234, OD-287).
     */
    const LEADERS: Record<string, Scope | null> = {
      SUPER_ADMIN: null, KPM_OWNER: null, KPM_ADMIN: null, AB: 'own-downline', AAB: 'own-downline', AGENT: 'own-downline',
    };
    const EXPECTED: Record<(typeof COACHING)[number], Record<string, Scope | null>> = {
      'coaching_session:create': LEADERS,
      'coaching_session:edit': LEADERS,
      'coaching_session:read': {
        SUPER_ADMIN: 'all', KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm',
        AB: 'own-downline', AAB: 'own-downline', AGENT: 'own-downline',
      },
      'coaching_session:finalize': LEADERS,
      'coaching_session:reopen': {
        SUPER_ADMIN: 'all', KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm',
        AB: 'own-downline', AAB: 'own-downline', AGENT: 'own-downline',
      },
      'coaching_session:export_pdf': {
        SUPER_ADMIN: null, KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm',
        AB: 'own-downline', AAB: 'own-downline', AGENT: 'own-downline',
      },
      'coaching_profile:read': LEADERS,
      'coaching_profile:update': LEADERS,
      'leader_notes:read': LEADERS,
      'leader_notes:write': LEADERS,
    };

    const cells = COACHING.flatMap((permission) =>
      Object.keys(ROLES).map((role) => [permission, role, EXPECTED[permission][role]] as const));

    it.each(cells.filter(([, , scope]) => scope !== null))(
      'P11-T3 AC-4 positive: %s is held by %s at %s',
      (permission, role, scope) => {
        expect(can(ROLES[role], permission)).toBe(true);
        expect(scopeFor(ROLES[role], permission)).toBe(scope);
      },
    );

    it.each(cells.filter(([, , scope]) => scope === null))(
      'P11-T3 AC-4 negative: %s is refused to %s',
      (permission, role) => {
        expect(can(ROLES[role], permission)).toBe(false);
      },
    );

    it.each(COACHING)('P11-T3 AC-4 negative: %s is refused to a removed or pending leader', (permission) => {
      // The other negative for a role that holds the grant: a hierarchy right is an active member's.
      for (const status of ['removed', 'pending'] as const) {
        expect(can(ctx({ role: 'ab', status }), permission)).toBe(false);
        expect(can(ctx({ role: 'aab', status }), permission)).toBe(false);
        expect(can(ctx({ role: 'agent', status }), permission)).toBe(false);
      }
    });

    it('P11-T3 AC-1: the AAB holds what the AB holds on every coaching row (ADR-0074)', () => {
      for (const permission of COACHING) {
        expect([permission, scopeFor(ROLES.AAB, permission)])
          .toEqual([permission, scopeFor(ROLES.AB, permission)]);
      }
    });

    it('P19.9-T6 AC-1: the Agent holds what the AB holds on every coaching row — every upline coaches (ADR-0234)', () => {
      for (const permission of COACHING) {
        expect([permission, scopeFor(ROLES.AGENT, permission)])
          .toEqual([permission, scopeFor(ROLES.AB, permission)]);
      }
    });

    it('P19.9-T6 AC-1: and on every read the person’s tabs make, `own` · `own-downline` as two grants', () => {
      const tokens = (permission: Permission) => (PERMISSIONS[permission] as readonly { grantee: unknown; scope: Scope }[])
        .filter((g) => g.grantee === AGENT).map((g) => g.scope);
      for (const permission of [
        'activity_log:read_raw', 'activity_ratios:read', 'personal_summary:read', 'goal:read', 'goal:update',
        'lead:read', 'lead:create', 'lead:update', 'lead:mark_outcome', 'training_progress:read',
        'campaign_qualification:read',
      ] as const) {
        expect([permission, tokens(permission)]).toEqual([permission, ['own', 'own-downline']]);
      }
      // The Survei tab's read has no `own` for anybody on a rung: *Survei saya* is not built (OD-267).
      expect(tokens('survey_answers:read')).toEqual(['own-downline']);
      // Nothing the decision did not reach: the lead's delete stays the owner's, Potensi stays out of an Agent's reach,
      // and the calendar's compare is not coaching's (roles §3.15).
      expect(tokens('lead:delete')).toEqual(['own']);
      expect(tokens('unit_dashboard:read_potensi')).toEqual([]);
      expect(tokens('unit_dashboard:update_production')).toEqual([]);
      expect(scopeFor(ROLES.AGENT, 'calendar_entry:read')).toBe('own');
    });

    it('P19.9-T6 AC-4: an Owner or an Admin on no rung coaches nobody; on the Agent rung they coach as that Agent (§1.1)', () => {
      for (const office of [ROLES.KPM_OWNER, ROLES.KPM_ADMIN]) {
        for (const permission of ['coaching_session:create', 'coaching_session:finalize', 'coaching_profile:update', 'leader_notes:write'] as const) {
          expect([permission, can(office, permission)]).toEqual([permission, false]);
        }
      }
      expect(scopeFor(ctx({ role: 'agent', owner: true }), 'coaching_session:create')).toBe('own-downline');
      expect(scopeFor(ctx({ role: 'agent', admin: true }), 'leader_notes:write')).toBe('own-downline');
    });

    it('P11-T3 AC-1: a leader who is coached holds `own` beside `own-downline`, as two grants', () => {
      // §3: a wider token never silently includes the reader's own records.
      const ownToo = (permission: Permission, grantee: typeof AB) =>
        (PERMISSIONS[permission] as readonly { grantee: unknown; scope: Scope }[])
          .some((g) => g.grantee === grantee && g.scope === 'own');
      for (const permission of ['coaching_session:read', 'coaching_session:export_pdf', 'leader_notes:read'] as const) {
        expect([permission, ownToo(permission, AB), ownToo(permission, AAB)]).toEqual([permission, true, true]);
      }
      // The Agent too, who is coached and, leading somebody, coaches (P19.9-T6).
      for (const permission of ['coaching_session:read', 'coaching_session:export_pdf', 'leader_notes:read'] as const) {
        expect([permission, ownToo(permission, AGENT)]).toEqual([permission, true]);
      }
      // …and nowhere a session is written or a profile kept: `COACH` never reaches oneself.
      for (const permission of ['coaching_session:create', 'coaching_profile:read', 'leader_notes:write'] as const) {
        expect([permission, ownToo(permission, AB), ownToo(permission, AGENT)]).toEqual([permission, false, false]);
      }
    });

    it('P11-T3 AC-1: coaching_session:share is struck, and never in the registry (ADR-0077, ADR-0083)', () => {
      expect(Object.keys(PERMISSIONS)).not.toContain('coaching_session:share');
    });

    it('P11-T3 AC-7 office_roles_cannot_read_leader_notes: the Owner, the Admin and the Super Admin as such', () => {
      for (const office of [ROLES.KPM_OWNER, ROLES.KPM_ADMIN, ROLES.SUPER_ADMIN, ctx({ superAdmin: true, role: NO_CLASS })]) {
        expect(can(office, 'leader_notes:read')).toBe(false);
        expect(can(office, 'coaching_profile:read')).toBe(false);
      }
      // One who is also an AB holds the AB's grant, which is the hierarchy, not the office (§1.1).
      // Whether they reach a given note is the reader predicate's: an ancestor of its author.
      expect(can(ctx({ role: 'ab', owner: true }), 'leader_notes:read')).toBe(true);
      expect(can(ctx({ role: 'aab', admin: true }), 'leader_notes:read')).toBe(true);
    });

    it('P11-T3 AC-7 support_session_cannot_read_leader_notes: read-only or elevated (§3.13)', () => {
      expect(isBlockedWhileImpersonating('leader_notes:read')).toBe(true);
      const readOnly = ctx({ role: 'ab', impersonatedBy: 'sa-1', readOnly: true });
      const elevated = ctx({ role: 'ab', impersonatedBy: 'sa-1', readOnly: false });
      expect(can(readOnly, 'leader_notes:read')).toBe(false);
      expect(can(elevated, 'leader_notes:read')).toBe(false);
      // The same leader outside a session reads them.
      expect(can(ctx({ role: 'ab' }), 'leader_notes:read')).toBe(true);
    });

    it('OD-108 support_session_cannot_write_leader_notes: an elevated session cannot save a note in the leader’s name', () => {
      expect(isBlockedWhileImpersonating('leader_notes:write')).toBe(true);
      const readOnly = ctx({ role: 'ab', impersonatedBy: 'sa-1', readOnly: true });
      const elevated = ctx({ role: 'ab', impersonatedBy: 'sa-1', readOnly: false });
      const elevatedAab = ctx({ role: 'aab', impersonatedBy: 'sa-1', readOnly: false });
      expect(can(readOnly, 'leader_notes:write')).toBe(false);
      expect(can(elevated, 'leader_notes:write')).toBe(false);
      expect(can(elevatedAab, 'leader_notes:write')).toBe(false);
      // Only the note is blocked: the same elevated session keeps the leader's other coaching writes.
      expect(can(elevated, 'coaching_session:edit')).toBe(true);
      // P11-T9 AC-9: the ladder and the grids are not notes, so `coaching_profile:update` is not blocked.
      expect(isBlockedWhileImpersonating('coaching_profile:update')).toBe(false);
      expect(can(elevated, 'coaching_profile:update')).toBe(true);
      // The same leaders outside a session write their own.
      expect(can(ctx({ role: 'ab' }), 'leader_notes:write')).toBe(true);
      expect(can(ctx({ role: 'aab' }), 'leader_notes:write')).toBe(true);
    });

    it('P11-T3 AC-4: a read-only support session reads a session and its print, and writes nothing', () => {
      const readOnly = ctx({ role: 'ab', impersonatedBy: 'sa-1', readOnly: true });
      expect(can(readOnly, 'coaching_session:read')).toBe(true);
      expect(can(readOnly, 'coaching_session:export_pdf')).toBe(true);
      expect(can(readOnly, 'coaching_profile:read')).toBe(true);
      for (const write of [
        'coaching_session:create', 'coaching_session:edit', 'coaching_session:finalize',
        'coaching_session:reopen', 'coaching_profile:update', 'leader_notes:write',
      ] as const) {
        expect([write, can(readOnly, write)]).toEqual([write, false]);
      }
    });
  });
  /*
   * **The calendar's permissions, a positive and a negative for each of the six roles** (P12-T1 AC-5,
   * roles §3.15, §7.2), at the level `can()` decides them — the API refusing what a screen hides. Who is
   * inside a grant's per-entry scope — the organiser, an attendee, `COACH` — and 404 outside it is the
   * calendar's own suites' question.
   *
   * **An Owner or Admin with no field role** stands on no rung the matrix names: one who also holds a rung
   * holds that rung's grants (§1.1), which the `ab` and `aab` rows already prove.
   */
  describe('P12-T1 — calendar (roles §3.15, functional/calendar.md *The permissions*)', () => {
    const CALENDAR = [
      'calendar_entry:read', 'calendar_entry:create', 'calendar_entry:update', 'calendar_entry:delete',
      'calendar_entry:answer', 'calendar_entry:block', 'calendar_invitee:search',
    ] as const satisfies readonly Permission[];

    const officeOnly = (over: Parameters<typeof ctx>[0]) => {
      const base = ctx(over);
      return new RequestContext(base.userId, 'none', { ...base.membership!, orgLevelCode: 'NO_RUNG', hierarchyRole: NO_CLASS });
    };
    const ROLES: Record<string, RequestContext> = {
      SUPER_ADMIN: ctx({ superAdmin: true, noMembership: true }),
      KPM_OWNER: officeOnly({ owner: true }),
      KPM_ADMIN: officeOnly({ admin: true }),
      AB: ctx({ role: 'ab' }),
      AAB: ctx({ role: 'aab' }),
      AGENT: ctx({ role: 'agent' }),
    };

    const FIELD_OWN: Record<string, Scope | null> = {
      SUPER_ADMIN: null, KPM_OWNER: null, KPM_ADMIN: null, AB: 'own', AAB: 'own', AGENT: 'own',
    };
    const EXPECTED: Record<(typeof CALENDAR)[number], Record<string, Scope | null>> = {
      // The widest: `own` · attendee · `own-downline` for a leader, `own` · attendee for an Agent.
      'calendar_entry:read': { ...FIELD_OWN, AB: 'own-downline', AAB: 'own-downline' },
      'calendar_entry:create': FIELD_OWN,
      'calendar_entry:update': FIELD_OWN,
      'calendar_entry:delete': FIELD_OWN,
      'calendar_entry:answer': FIELD_OWN,
      'calendar_entry:block': { ...FIELD_OWN, AB: 'own-downline', AAB: 'own-downline', AGENT: null },
      'calendar_invitee:search': { ...FIELD_OWN, AB: 'own-kpm', AAB: 'own-kpm', AGENT: 'own-kpm' },
    };

    const cells = CALENDAR.flatMap((permission) =>
      Object.keys(ROLES).map((role) => [permission, role, EXPECTED[permission][role]] as const));

    it.each(cells.filter(([, , scope]) => scope !== null))(
      'P12-T1 AC-5 positive: %s is held by %s at %s',
      (permission, role, scope) => {
        expect(can(ROLES[role], permission)).toBe(true);
        expect(scopeFor(ROLES[role], permission)).toBe(scope);
      },
    );

    it.each(cells.filter(([, , scope]) => scope === null))(
      'P12-T1 AC-5 negative: %s is refused to %s',
      (permission, role) => {
        expect(can(ROLES[role], permission)).toBe(false);
      },
    );

    it.each(CALENDAR)('P12-T1 AC-5 negative: %s is refused to a removed or pending member', (permission) => {
      for (const status of ['removed', 'pending'] as const) {
        for (const role of ['ab', 'aab', 'agent'] as const) expect(can(ctx({ role, status }), permission)).toBe(false);
      }
    });

    it('P12-T1 AC-5 a leader holds `own` beside `own-downline` on the read, as two grants; the block is COACH alone', () => {
      const has = (permission: Permission, grantee: typeof AB, scope: Scope) =>
        (PERMISSIONS[permission] as readonly { grantee: unknown; scope: Scope }[])
          .some((g) => g.grantee === grantee && g.scope === scope);
      for (const grantee of [AB, AAB]) {
        expect([has('calendar_entry:read', grantee, 'own'), has('calendar_entry:read', grantee, 'own-downline')]).toEqual([true, true]);
        // `COACH` never reaches oneself: a block on yourself is not a grant anybody holds.
        expect(has('calendar_entry:block', grantee, 'own')).toBe(false);
      }
    });

    it('P12-T1 AC-5 the reads are read-like and every write is not, so a read-only support session reads and writes nothing', () => {
      expect(CALENDAR.filter((p) => isReadLike(p))).toEqual(['calendar_entry:read', 'calendar_invitee:search']);
      const readOnly = ctx({ role: 'ab', impersonatedBy: 'sa-1', readOnly: true });
      expect(can(readOnly, 'calendar_entry:read')).toBe(true);
      expect(can(readOnly, 'calendar_invitee:search')).toBe(true);
      for (const write of [
        'calendar_entry:create', 'calendar_entry:update', 'calendar_entry:delete', 'calendar_entry:answer', 'calendar_entry:block',
      ] as const) {
        expect([write, can(readOnly, write)]).toEqual([write, false]);
      }
    });

    it('P12-T1 AC-5 no calendar permission is blocked outright in a support session: an elevated one writes as the member', () => {
      const elevated = ctx({ role: 'ab', impersonatedBy: 'sa-1', readOnly: false });
      for (const permission of CALENDAR) {
        expect([permission, isBlockedWhileImpersonating(permission), can(elevated, permission)]).toEqual([permission, false, true]);
      }
    });

    it('P12-T1 AC-5 an Owner or Admin who also stands on a rung holds that rung’s calendar (§1.1)', () => {
      expect(scopeFor(ctx({ role: 'ab', owner: true }), 'calendar_entry:block')).toBe('own-downline');
      expect(scopeFor(ctx({ role: 'agent', admin: true }), 'calendar_entry:read')).toBe('own');
    });
  });

  describe('Phase 13 — activation and new hires (roles §3.8, functional/activation.md *The permissions*)', () => {
    const ACTIVATION = [
      'activation:read', 'activation:update_manual_item', 'activation:set_start_date', 'activation:graduate',
      'new_hires:read_roster', 'activation_note:write',
    ] as const satisfies readonly Permission[];

    const officeOnly = (over: Parameters<typeof ctx>[0]) => {
      const base = ctx(over);
      return new RequestContext(base.userId, 'none', { ...base.membership!, orgLevelCode: 'NO_RUNG', hierarchyRole: NO_CLASS });
    };
    const ROLES: Record<string, RequestContext> = {
      SUPER_ADMIN: ctx({ superAdmin: true, noMembership: true }),
      KPM_OWNER: officeOnly({ owner: true }),
      KPM_ADMIN: officeOnly({ admin: true }),
      AB: ctx({ role: 'ab' }),
      AAB: ctx({ role: 'aab' }),
      AGENT: ctx({ role: 'agent' }),
    };
    const NONE: Record<string, Scope | null> = { SUPER_ADMIN: null, KPM_OWNER: null, KPM_ADMIN: null };
    const FIELD = (scope: Scope) => ({ ...NONE, AB: scope, AAB: scope, AGENT: scope });
    /** The widest scope each role holds — the Agent's downline grants included (OD-122, ADR-0087). */
    const EXPECTED: Record<(typeof ACTIVATION)[number], Record<string, Scope | null>> = {
      'activation:read': FIELD('own-downline'),
      'activation:update_manual_item': FIELD('own-downline'),
      'activation:set_start_date': FIELD('own-downline'),
      'activation:graduate': FIELD('own'),
      'new_hires:read_roster': FIELD('own-downline'),
      'activation_note:write': FIELD('own-downline'),
    };
    const cells = ACTIVATION.flatMap((permission) =>
      Object.keys(ROLES).map((role) => [permission, role, EXPECTED[permission][role]] as const));

    it.each(cells.filter(([, , scope]) => scope !== null))(
      'P13-T5 AC-8 positive: %s is held by %s at %s',
      (permission, role, scope) => {
        expect(can(ROLES[role], permission)).toBe(true);
        expect(scopeFor(ROLES[role], permission)).toBe(scope);
      },
    );

    it.each(cells.filter(([, , scope]) => scope === null))(
      'P13-T5 AC-8 negative (D-owner): %s is refused to %s',
      (permission, role) => {
        expect(can(ROLES[role], permission)).toBe(false);
      },
    );

    it.each(ACTIVATION)('P13-T5 AC-8 negative: %s is refused to a removed or pending member', (permission) => {
      for (const status of ['removed', 'pending'] as const) {
        for (const role of ['ab', 'aab', 'agent'] as const) expect(can(ctx({ role, status }), permission)).toBe(false);
      }
    });

    it('P13-T2 AC-3 the hire’s own and a leader’s are two grants; graduation is the hire’s alone, the start date and the note a leader’s alone', () => {
      const has = (permission: Permission, grantee: typeof AB, scope: Scope) =>
        (PERMISSIONS[permission] as readonly { grantee: unknown; scope: Scope }[])
          .some((g) => g.grantee === grantee && g.scope === scope);
      for (const grantee of [AB, AAB, AGENT]) {
        for (const permission of ['activation:read', 'activation:update_manual_item'] as const) {
          expect([permission, has(permission, grantee, 'own'), has(permission, grantee, 'own-downline')]).toEqual([permission, true, true]);
        }
        expect(has('activation:graduate', grantee, 'own-downline')).toBe(false);
        for (const permission of ['activation:set_start_date', 'activation_note:write', 'new_hires:read_roster'] as const) {
          expect([permission, has(permission, grantee, 'own')]).toEqual([permission, false]);
        }
      }
      // A linked item is ticked by nobody: not a grant anybody holds, but its link's liveness.
      expect(Object.keys(PERMISSIONS)).not.toContain('activation:auto_complete');
    });

    it('P13-T4 AC-9 the reads are read-like and every write is not, so a read-only support session reads and writes nothing', () => {
      expect(ACTIVATION.filter((p) => isReadLike(p))).toEqual(['activation:read', 'new_hires:read_roster']);
      const readOnly = ctx({ role: 'agent', impersonatedBy: 'sa-1', readOnly: true });
      expect([can(readOnly, 'activation:read'), can(readOnly, 'new_hires:read_roster')]).toEqual([true, true]);
      for (const write of ['activation:update_manual_item', 'activation:set_start_date', 'activation:graduate', 'activation_note:write'] as const) {
        expect([write, can(readOnly, write)]).toEqual([write, false]);
      }
    });

    it('P13-T6 AC-5 none but graduation is blocked outright: an elevated session writes as the member, both actors on the record', () => {
      const elevated = ctx({ role: 'aab', impersonatedBy: 'sa-1', readOnly: false });
      for (const permission of ACTIVATION.filter((p) => p !== 'activation:graduate')) {
        expect([permission, isBlockedWhileImpersonating(permission), can(elevated, permission)]).toEqual([permission, false, true]);
      }
    });

    it('Phase 13 exit review N4 graduation is the hire’s own declaration (ADR-0100): refused to a support session, read-only or elevated', () => {
      expect(isBlockedWhileImpersonating('activation:graduate')).toBe(true);
      for (const role of ['ab', 'aab', 'agent'] as const) {
        for (const readOnly of [true, false]) {
          const session = ctx({ role, impersonatedBy: 'sa-1', readOnly });
          expect([role, readOnly, can(session, 'activation:graduate')]).toEqual([role, readOnly, false]);
        }
        // The same member outside a session graduates their own.
        expect([role, can(ctx({ role }), 'activation:graduate')]).toEqual([role, true]);
      }
      // Only graduation: the same elevated session still ticks the hire's items as them.
      expect(can(ctx({ role: 'agent', impersonatedBy: 'sa-1', readOnly: false }), 'activation:update_manual_item')).toBe(true);
    });

    it('P13-T5 AC-8 an Owner or Admin who also stands on a rung holds that rung’s grants (§1.1)', () => {
      expect(scopeFor(ctx({ role: 'ab', owner: true }), 'new_hires:read_roster')).toBe('own-downline');
      expect(scopeFor(ctx({ role: 'agent', admin: true }), 'activation:graduate')).toBe('own');
    });

    /*
     * **OD-158 → option 1 (P18.3-T1 AC-7, exit test 2)**: the Owner and the Admins read a hire's activation as the
     * compliance tree's status alone — under `kpm_analytics:read` — and hold no activation grant of their own: no
     * checklist, no start-date correction, no reversal of a graduation. Every permission of the two families, today's
     * and any added later, is granted to no office role and no platform role; one who stands on a rung holds that
     * rung's, as the member they are (§1.1), which reaches only the hires they coach.
     */
    it('UI-025 new_hire:mark_left is retired with its route: nobody holds it (ADR-0180 §6)', () => {
      expect('new_hire:mark_left' in PERMISSIONS).toBe(false);
      expect(Object.keys(PERMISSIONS).filter((name) => name.startsWith('new_hire:'))).toEqual([]);
    });

    it('P18.3-T1 AC-7 OD-158: no activation or new-hires permission is granted to the Owner, the Admin or the Super Admin', () => {
      const families = (Object.keys(PERMISSIONS) as Permission[])
        .filter((p) => /^(activation|activation_note|new_hires):/.test(p));
      expect(families.sort()).toEqual([...ACTIVATION].sort());
      for (const permission of families) {
        const roles = (PERMISSIONS[permission] as readonly { grantee: { kind: string } }[]).map((g) => g.grantee.kind);
        expect([permission, roles.filter((kind) => kind !== 'hierarchy')]).toEqual([permission, []]);
        for (const role of ['KPM_OWNER', 'KPM_ADMIN', 'SUPER_ADMIN']) {
          expect([permission, role, can(ROLES[role], permission)]).toEqual([permission, role, false]);
        }
      }
      // What they read of a hire instead: the tree, under the analytics' own permission.
      expect([can(ROLES.KPM_OWNER, 'kpm_analytics:read'), can(ROLES.KPM_ADMIN, 'kpm_analytics:read')]).toEqual([true, true]);
    });
  });

  /*
   * **The Core Leader** (ADR-0159, P18.5-T5 AC-2, AC-4, AC-6): who sets the tag, and what the tag's holder reads. The
   * tag itself is not a grant — `can()` never reads it; the services that narrow by it are tested over HTTP
   * (`reporting.int.spec.ts`, `compliance.int.spec.ts`, `leader-meetings.int.spec.ts`).
   */
  describe('P18.5-T5 — the Core Leader (ADR-0159)', () => {
    const ROLES: Record<string, RequestContext> = {
      SUPER_ADMIN: ctx({ superAdmin: true, noMembership: true }),
      KPM_OWNER: ctx({ owner: true, role: NO_CLASS }),
      KPM_ADMIN: ctx({ admin: true, role: NO_CLASS }),
      AB: ctx({ role: 'ab' }),
      AAB: ctx({ role: 'aab' }),
      AGENT: ctx({ role: 'agent' }),
    };

    it.each([
      ['SUPER_ADMIN', 'all'], ['KPM_OWNER', 'own-kpm'], ['KPM_ADMIN', 'own-kpm'], ['AB', null], ['AAB', null], ['AGENT', null],
    ] as const)('P18.5-T5 AC-2 member:tag_core_leader for %s: %s', (role, scope) => {
      expect(scopeFor(ROLES[role], 'member:tag_core_leader')).toBe(scope);
      expect(can(ROLES[role], 'member:tag_core_leader')).toBe(scope !== null);
    });

    it('P18.5-T5 AC-2 a read-only support session cannot set the tag; an elevated one can, as its member', () => {
      expect(can(ctx({ owner: true, impersonatedBy: 'sa-1', readOnly: true }), 'member:tag_core_leader')).toBe(false);
      expect(can(ctx({ owner: true, impersonatedBy: 'sa-1', readOnly: false }), 'member:tag_core_leader')).toBe(true);
    });

    it.each([
      ['KPM_OWNER', true], ['KPM_ADMIN', true], ['AB', true], ['AAB', true], ['AGENT', false],
    ] as const)('P18.5-T5 AC-4 kpm_analytics:read lets %s through the guard: %s', (role, held) => {
      expect(can(ROLES[role], 'kpm_analytics:read')).toBe(held);
    });

    it('P18.5-T5 AC-4 a read-only support session as a leader reads the analytics, as its member', () => {
      expect(can(ctx({ role: 'aab', impersonatedBy: 'sa-1', readOnly: true }), 'kpm_analytics:read')).toBe(true);
    });

    it('P18.5-T5 AC-4 a removed or pending leader holds nothing', () => {
      for (const status of ['removed', 'pending'] as const) {
        expect(can(ctx({ role: 'ab', status }), 'kpm_analytics:read')).toBe(false);
      }
    });
  });

  /*
   * **The Unit Dashboard's permissions, a positive and a negative per role** (P15-T1 AC-1, P15-T3 AC-4), at
   * the level `can()` decides them. Who is inside a grant — `COACH`, and 404 outside it — is the module's
   * own specs' question (`unit-dashboard.int.spec.ts`, `unit-dashboard.tenancy.spec.ts`).
   */
  describe('Phase 18.2 — campaigns, the member’s side (roles §3.11)', () => {
    const CAMPAIGN = [
      'campaign:read_list', 'campaign:chase', 'campaign_qualification:read', 'campaign_settings:read',
    ] as const satisfies readonly Permission[];
    const officeOnly = (over: Parameters<typeof ctx>[0]) => {
      const base = ctx(over);
      return new RequestContext(base.userId, 'none', { ...base.membership!, orgLevelCode: 'NO_RUNG', hierarchyRole: NO_CLASS });
    };
    const ROLES: Record<string, RequestContext> = {
      SUPER_ADMIN: ctx({ superAdmin: true, noMembership: true }),
      KPM_OWNER: officeOnly({ owner: true }),
      KPM_ADMIN: officeOnly({ admin: true }),
      AB: ctx({ role: 'ab' }),
      AAB: ctx({ role: 'aab' }),
      AGENT: ctx({ role: 'agent' }),
    };
    /** The widest scope each role holds (roles §3.11). */
    const EXPECTED: Record<(typeof CAMPAIGN)[number], Record<string, Scope | null>> = {
      'campaign:read_list': {
        SUPER_ADMIN: 'all', KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm', AB: 'own-kpm', AAB: 'own-kpm', AGENT: 'own-kpm',
      },
      'campaign:chase': { SUPER_ADMIN: null, KPM_OWNER: null, KPM_ADMIN: null, AB: 'own', AAB: 'own', AGENT: 'own' },
      'campaign_qualification:read': {
        // P19.9-T6 (ADR-0234): an Agent who leads reads their coachees' chases, the coaching Summary tab's card.
        SUPER_ADMIN: 'all', KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm', AB: 'own-downline', AAB: 'own-unit', AGENT: 'own-downline',
      },
      // Leak 15: the settings reads, the Owner's and the Admins' — never a field rung.
      'campaign_settings:read': { SUPER_ADMIN: 'all', KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm', AB: null, AAB: null, AGENT: null },
    };
    const cells = CAMPAIGN.flatMap((permission) =>
      Object.keys(ROLES).map((role) => [permission, role, EXPECTED[permission][role]] as const));

    it.each(cells.filter(([, , scope]) => scope !== null))(
      'P18.2-T7 AC-1, P18.2-T9 AC-2 positive: %s is held by %s at %s',
      (permission, role, scope) => {
        expect(can(ROLES[role], permission)).toBe(true);
        expect(scopeFor(ROLES[role], permission)).toBe(scope);
      },
    );

    it.each(cells.filter(([, , scope]) => scope === null))(
      'P18.2-T7 AC-1 negative: %s is refused to %s',
      (permission, role) => {
        expect(can(ROLES[role], permission)).toBe(false);
      },
    );

    it('P18.2-T7 AC-1 the Owner and the Admin chase by the rung they hold, in their field view (ADR-0114)', () => {
      expect(can(ctx({ role: 'ab', owner: true }), 'campaign:chase')).toBe(true);
      expect(can(ctx({ role: 'agent', admin: true }), 'campaign:chase')).toBe(true);
    });

    it('P18.2-T7 AC-1 a support session reads campaigns and is refused the chase, read-only or elevated (ADR-0143)', () => {
      const readOnly = ctx({ role: 'agent', impersonatedBy: 'sa-1', readOnly: true });
      expect(can(readOnly, 'campaign:read_list')).toBe(true);
      expect(can(readOnly, 'campaign_qualification:read')).toBe(true);
      expect(can(readOnly, 'campaign:chase')).toBe(false);
      expect(isBlockedWhileImpersonating('campaign:chase')).toBe(true);
      expect(can(ctx({ role: 'agent', impersonatedBy: 'sa-1', readOnly: false }), 'campaign:chase')).toBe(false);
      // Outside a session the member chases.
      expect(can(ctx({ role: 'agent' }), 'campaign:chase')).toBe(true);
    });

    it.each(CAMPAIGN)('P18.2-T7 AC-1 negative: %s is refused to a removed or pending member', (permission) => {
      for (const status of ['removed', 'pending'] as const) {
        for (const role of ['ab', 'aab', 'agent'] as const) expect(can(ctx({ role, status }), permission)).toBe(false);
      }
    });

    it('P18.2-T7 AC-1 only the reads are read-like', () => {
      expect(CAMPAIGN.filter((p) => isReadLike(p))).toEqual(['campaign:read_list', 'campaign_qualification:read', 'campaign_settings:read']);
    });

    it('P18.2-T7 leak 15 the settings read is refused to every field rung, the Owner and the Admin keeping it as the rung they hold', () => {
      for (const role of ['ab', 'aab', 'agent'] as const) expect(can(ctx({ role }), 'campaign_settings:read')).toBe(false);
      expect(can(ctx({ role: 'agent', owner: true }), 'campaign_settings:read')).toBe(true);
      expect(can(ctx({ role: 'ab', admin: true, impersonatedBy: 'sa-1', readOnly: true }), 'campaign_settings:read')).toBe(true);
    });
  });

  /*
   * **The override of a final standing** (P18.3-T2 AC-5; roles §3.11, D-override): the Owner and the Admins `own-kpm`,
   * the Super Admin `all` — which writes only inside an elevated support session, as its member — and no field rung.
   */
  describe('Phase 18.3 — the override of a final standing (roles §3.11)', () => {
    const officeOnly = (over: Parameters<typeof ctx>[0]) => {
      const base = ctx(over);
      return new RequestContext(base.userId, 'none', { ...base.membership!, orgLevelCode: 'NO_RUNG', hierarchyRole: NO_CLASS });
    };
    const ROLES: [string, RequestContext, Scope | null][] = [
      ['SUPER_ADMIN', ctx({ superAdmin: true, noMembership: true }), 'all'],
      ['KPM_OWNER', officeOnly({ owner: true }), 'own-kpm'],
      ['KPM_ADMIN', officeOnly({ admin: true }), 'own-kpm'],
      ['AB', ctx({ role: 'ab' }), null],
      ['AAB', ctx({ role: 'aab' }), null],
      ['AGENT', ctx({ role: 'agent' }), null],
    ];

    it.each(ROLES.filter(([, , scope]) => scope !== null))(
      'P18.3-T2 AC-5 positive: campaign_qualification:override is held by %s',
      (_role, context, scope) => {
        expect(can(context, 'campaign_qualification:override')).toBe(true);
        expect(scopeFor(context, 'campaign_qualification:override')).toBe(scope);
      },
    );

    it.each(ROLES.filter(([, , scope]) => scope === null))(
      'P18.3-T2 AC-5 negative: campaign_qualification:override is refused to %s',
      (_role, context) => {
        expect(can(context, 'campaign_qualification:override')).toBe(false);
      },
    );

    it('P18.3-T2 AC-5 the Owner and the Admin hold it whatever rung they stand on; a removed or pending member never', () => {
      expect(can(ctx({ role: 'ab', owner: true }), 'campaign_qualification:override')).toBe(true);
      expect(can(ctx({ role: 'agent', admin: true }), 'campaign_qualification:override')).toBe(true);
      for (const status of ['removed', 'pending'] as const) {
        for (const role of ['ab', 'aab', 'agent'] as const) expect(can(ctx({ role, status }), 'campaign_qualification:override')).toBe(false);
      }
    });

    it('P18.3-T2 AC-5 a write: refused in a read-only support session, held in an elevated one as the member', () => {
      expect(isReadLike('campaign_qualification:override')).toBe(false);
      expect(isBlockedWhileImpersonating('campaign_qualification:override')).toBe(false);
      expect(can(ctx({ role: 'ab', owner: true, impersonatedBy: 'sa-1', readOnly: true }), 'campaign_qualification:override')).toBe(false);
      expect(can(ctx({ role: 'ab', owner: true, impersonatedBy: 'sa-1', readOnly: false }), 'campaign_qualification:override')).toBe(true);
      // An elevated session as a field member holds what the member holds: nothing.
      expect(can(ctx({ role: 'agent', impersonatedBy: 'sa-1', readOnly: false }), 'campaign_qualification:override')).toBe(false);
    });
  });

  describe('Phase 15 — the Unit Dashboard (roles §3.8, functional/unit-dashboard.md *The permissions*)', () => {
    const UNIT = ['unit_dashboard:read', 'unit_dashboard:update_production'] as const satisfies readonly Permission[];
    const officeOnly = (over: Parameters<typeof ctx>[0]) => {
      const base = ctx(over);
      return new RequestContext(base.userId, 'none', { ...base.membership!, orgLevelCode: 'NO_RUNG', hierarchyRole: NO_CLASS });
    };
    const ROLES: Record<string, RequestContext> = {
      SUPER_ADMIN: ctx({ superAdmin: true, noMembership: true }),
      KPM_OWNER: officeOnly({ owner: true }),
      KPM_ADMIN: officeOnly({ admin: true }),
      AB: ctx({ role: 'ab' }),
      AAB: ctx({ role: 'aab' }),
      AGENT: ctx({ role: 'agent' }),
    };
    /** The widest scope each role holds (contract, roles §3.8). */
    const EXPECTED: Record<(typeof UNIT)[number], Record<string, Scope | null>> = {
      'unit_dashboard:read': {
        SUPER_ADMIN: 'all', KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm', AB: 'own-downline', AAB: 'own-downline', AGENT: 'own-downline',
      },
      'unit_dashboard:update_production': {
        SUPER_ADMIN: null, KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm', AB: 'own-downline', AAB: 'own-downline', AGENT: null,
      },
    };
    const cells = UNIT.flatMap((permission) =>
      Object.keys(ROLES).map((role) => [permission, role, EXPECTED[permission][role]] as const));

    it.each(cells.filter(([, , scope]) => scope !== null))(
      'P15-T1 AC-1, P15-T3 AC-4 positive: %s is held by %s at %s',
      (permission, role, scope) => {
        expect(can(ROLES[role], permission)).toBe(true);
        expect(scopeFor(ROLES[role], permission)).toBe(scope);
      },
    );

    it.each(cells.filter(([, , scope]) => scope === null))(
      'P15-T3 AC-4 negative: %s is refused to %s',
      (permission, role) => {
        expect(can(ROLES[role], permission)).toBe(false);
      },
    );

    it.each(UNIT)('P15-T1 AC-1 negative: %s is refused to a removed or pending member', (permission) => {
      for (const status of ['removed', 'pending'] as const) {
        for (const role of ['ab', 'aab', 'agent'] as const) expect(can(ctx({ role, status }), permission)).toBe(false);
      }
    });

    it('P15-T1 AC-1 a leader holds `own` beside `own-downline` on both, as two grants; the Agent both on the read and neither on the write', () => {
      const has = (permission: Permission, grantee: typeof AB, scope: Scope) =>
        (PERMISSIONS[permission] as readonly { grantee: unknown; scope: Scope }[])
          .some((g) => g.grantee === grantee && g.scope === scope);
      for (const grantee of [AB, AAB]) {
        for (const permission of UNIT) {
          expect([permission, has(permission, grantee, 'own'), has(permission, grantee, 'own-downline')]).toEqual([permission, true, true]);
        }
      }
      // ADR-0087: an Agent with a direct report is a leader; COACH narrows the downline grant for one who is not.
      expect([has('unit_dashboard:read', AGENT, 'own'), has('unit_dashboard:read', AGENT, 'own-downline')]).toEqual([true, true]);
      expect([has('unit_dashboard:update_production', AGENT, 'own'), has('unit_dashboard:update_production', AGENT, 'own-downline')])
        .toEqual([false, false]);
      // `org_tree:drill_to_unit_dashboard` folds into the read (roles §3.4): a link, never a permission.
      expect(Object.keys(PERMISSIONS)).not.toContain('org_tree:drill_to_unit_dashboard');
    });

    it('P15-T3 AC-4 the read is read-like and the save is not: a read-only support session reads and is refused the save', () => {
      expect(UNIT.filter((p) => isReadLike(p))).toEqual(['unit_dashboard:read']);
      const readOnly = ctx({ role: 'ab', impersonatedBy: 'sa-1', readOnly: true });
      expect(can(readOnly, 'unit_dashboard:read')).toBe(true);
      expect(can(readOnly, 'unit_dashboard:update_production')).toBe(false);
      // Not blocked outright: an elevated session corrects as the member, both actors on the audit row.
      const elevated = ctx({ role: 'ab', impersonatedBy: 'sa-1', readOnly: false });
      expect(isBlockedWhileImpersonating('unit_dashboard:update_production')).toBe(false);
      expect(can(elevated, 'unit_dashboard:update_production')).toBe(true);
    });

    it('P15-T1 AC-1 an Owner or Admin who also stands on a rung reads as the office, its widest grant (§1.1)', () => {
      expect(scopeFor(ctx({ role: 'ab', owner: true }), 'unit_dashboard:read')).toBe('own-kpm');
      expect(scopeFor(ctx({ role: 'agent', admin: true }), 'unit_dashboard:update_production')).toBe('own-kpm');
    });
  });

  /*
   * **Recruitment tools' permissions, a positive and a negative for each of the six roles** (P17-T2 AC-5,
   * P17-T4 AC-7, P17-T8 AC-3; the contract's table): the field read every member holds, the office's writes
   * on `tenant_config:write`, and the playbook — a template section since P19.4-T5 (ADR-0210 §2), read on
   * `company_template:read` and written on `company_template:write` — the Super Admin's alone. Over HTTP, per route, is
   * `recruitment.controller.int.spec.ts` and `template-org-levels.int.spec.ts`.
   */
  describe('Phase 17 — recruitment tools (the contract’s permissions table)', () => {
    const RECRUITMENT = [
      'recruitment:read', 'tenant_config:write', 'company_template:read', 'company_template:write',
    ] as const satisfies readonly Permission[];
    const ROLES: Record<string, RequestContext> = {
      SUPER_ADMIN: ctx({ superAdmin: true, noMembership: true }),
      KPM_OWNER: ctx({ owner: true }),
      KPM_ADMIN: ctx({ admin: true }),
      AB: ctx({ role: 'ab' }),
      AAB: ctx({ role: 'aab' }),
      AGENT: ctx({ role: 'agent' }),
    };
    const EXPECTED: Record<(typeof RECRUITMENT)[number], Record<string, Scope | null>> = {
      'recruitment:read': {
        SUPER_ADMIN: 'all', KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm', AB: 'own-kpm', AAB: 'own-kpm', AGENT: 'own-kpm',
      },
      'tenant_config:write': {
        SUPER_ADMIN: null, KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm', AB: null, AAB: null, AGENT: null,
      },
      'company_template:read': {
        SUPER_ADMIN: 'all', KPM_OWNER: null, KPM_ADMIN: null, AB: null, AAB: null, AGENT: null,
      },
      'company_template:write': {
        SUPER_ADMIN: 'all', KPM_OWNER: null, KPM_ADMIN: null, AB: null, AAB: null, AGENT: null,
      },
    };
    const cells = RECRUITMENT.flatMap((permission) =>
      Object.keys(ROLES).map((role) => [permission, role, EXPECTED[permission][role]] as const));

    it.each(cells.filter(([, , scope]) => scope !== null))(
      'P17-T2 AC-5, P17-T4 AC-7, P17-T8 AC-3 positive: %s is held by %s at %s',
      (permission, role, scope) => {
        expect(can(ROLES[role], permission)).toBe(true);
        expect(scopeFor(ROLES[role], permission)).toBe(scope);
      },
    );

    it.each(cells.filter(([, , scope]) => scope === null))(
      'P17-T2 AC-5, P17-T4 AC-7, P17-T8 AC-3 negative: %s is refused to %s',
      (permission, role) => {
        expect(can(ROLES[role], permission)).toBe(false);
      },
    );

    it('P17-T2 AC-5 the field read is refused to a removed or pending member, and to somebody in no office', () => {
      for (const status of ['removed', 'pending'] as const) {
        for (const role of ['ab', 'aab', 'agent'] as const) expect(can(ctx({ role, status }), 'recruitment:read')).toBe(false);
      }
      expect(can(ctx({ noMembership: true }), 'recruitment:read')).toBe(false);
    });

    it('P17-T4 AC-7 a read-only support session reads the plan and the pitch, and is refused every write', () => {
      expect(isReadLike('recruitment:read')).toBe(true);
      expect(isReadLike('company_template:write')).toBe(false);
      for (const target of [{ role: 'agent' as const }, { owner: true }, { admin: true }]) {
        const readOnly = ctx({ ...target, impersonatedBy: 'sa-1', readOnly: true });
        expect(can(readOnly, 'recruitment:read')).toBe(true);
        expect(can(readOnly, 'tenant_config:write')).toBe(false);
      }
    });

    it('P17-T4 AC-7 an elevated session as the Owner writes the office’s pitch, as its member; no session writes the playbook', () => {
      const elevated = ctx({ owner: true, impersonatedBy: 'sa-1', readOnly: false });
      expect(isBlockedWhileImpersonating('tenant_config:write')).toBe(false);
      expect(can(elevated, 'tenant_config:write')).toBe(true);
      expect(can(elevated, 'recruitment:read')).toBe(true);
      // A session acts as its member, whose context holds no platform grant.
      expect(can(elevated, 'company_template:write')).toBe(false);
      expect(can(elevated, 'company_template:read')).toBe(false);
    });

    it('P19.4-T5 AC-11 recruitment_playbook:write is retired: the playbook is written on company_template:write (ADR-0210 §2)', () => {
      expect(Object.keys(PERMISSIONS)).toEqual(expect.arrayContaining(['recruitment:read', 'company_template:write']));
      expect(Object.keys(PERMISSIONS)).not.toContain('recruitment_playbook:write');
      // No office override of the playbook exists (OD-88), so no tenant grantee holds any recruitment write.
      const tenantWrites = (Object.keys(PERMISSIONS) as Permission[])
        .filter((p) => p.startsWith('recruitment') && !isReadLike(p))
        .flatMap((p) => (PERMISSIONS[p] as readonly { grantee: { kind: string } }[]).filter((g) => g.grantee.kind !== 'platform'));
      expect(tenantWrites).toEqual([]);
    });
  });

  /*
   * **The Owner's reporting, a positive and a negative for each of the six roles** (P18-T1 AC-1, P18-T2 AC-10,
   * P18-T8 AC-1; the contract's permissions table, roles §3.9). Over HTTP, per route, is `reporting.int.spec.ts`.
   */
  describe('Phase 18 — the Owner’s reporting (roles §3.9)', () => {
    const REPORTING = [
      'kpm_overview:read', 'kpm_overview:set_recruit_target', 'kpm_analytics:read', 'platform_analytics:read',
    ] as const satisfies readonly Permission[];
    const ROLES: Record<string, RequestContext> = {
      SUPER_ADMIN: ctx({ superAdmin: true, noMembership: true }),
      KPM_OWNER: ctx({ owner: true }),
      KPM_ADMIN: ctx({ admin: true }),
      AB: ctx({ role: 'ab' }),
      AAB: ctx({ role: 'aab' }),
      AGENT: ctx({ role: 'agent' }),
    };
    const EXPECTED: Record<(typeof REPORTING)[number], Record<string, Scope | null>> = {
      'kpm_overview:read': { SUPER_ADMIN: 'all', KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm', AB: null, AAB: null, AGENT: null },
      'kpm_overview:set_recruit_target': { SUPER_ADMIN: null, KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm', AB: null, AAB: null, AGENT: null },
      // ADR-0159 §2 (P18.5-T5 AC-4): an AB and an AAB hold it; the services answer one who is no Core Leader 404.
      'kpm_analytics:read': { SUPER_ADMIN: 'all', KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm', AB: 'own-kpm', AAB: 'own-kpm', AGENT: null },
      'platform_analytics:read': { SUPER_ADMIN: 'all', KPM_OWNER: null, KPM_ADMIN: null, AB: null, AAB: null, AGENT: null },
    };
    const cells = REPORTING.flatMap((permission) =>
      Object.keys(ROLES).map((role) => [permission, role, EXPECTED[permission][role]] as const));

    it.each(cells.filter(([, , scope]) => scope !== null))(
      'P18-T1 AC-1, P18-T2 AC-10, P18-T8 AC-1 positive: %s is held by %s at %s',
      (permission, role, scope) => {
        expect(can(ROLES[role], permission)).toBe(true);
        expect(scopeFor(ROLES[role], permission)).toBe(scope);
      },
    );

    it.each(cells.filter(([, , scope]) => scope === null))(
      'P18-T1 AC-1, P18-T2 AC-10, P18-T8 AC-1 negative: %s is refused to %s',
      (permission, role) => {
        expect(can(ROLES[role], permission)).toBe(false);
      },
    );

    it('P18-T1 AC-1 an Owner or Admin who also stands on a rung reads as the office; a removed or pending one holds nothing', () => {
      expect(scopeFor(ctx({ role: 'ab', owner: true }), 'kpm_overview:read')).toBe('own-kpm');
      expect(scopeFor(ctx({ role: 'agent', admin: true }), 'kpm_analytics:read')).toBe('own-kpm');
      for (const status of ['removed', 'pending'] as const) {
        expect(can(ctx({ role: 'ab', status }), 'kpm_overview:read')).toBe(false);
      }
    });

    it('P18-T1 AC-1 a read-only support session reads the Overview and the analytics, and is refused the target', () => {
      expect(REPORTING.filter((p) => isReadLike(p))).toEqual(['kpm_overview:read', 'kpm_analytics:read', 'platform_analytics:read']);
      for (const target of [{ owner: true }, { admin: true }]) {
        const readOnly = ctx({ ...target, impersonatedBy: 'sa-1', readOnly: true });
        expect(can(readOnly, 'kpm_overview:read')).toBe(true);
        expect(can(readOnly, 'kpm_analytics:read')).toBe(true);
        expect(can(readOnly, 'kpm_overview:set_recruit_target')).toBe(false);
      }
    });

    it('P18-T1 AC-1 an elevated session writes the target as its member; no session holds the platform’s read', () => {
      const elevated = ctx({ owner: true, impersonatedBy: 'sa-1', readOnly: false });
      expect(isBlockedWhileImpersonating('kpm_overview:set_recruit_target')).toBe(false);
      expect(can(elevated, 'kpm_overview:set_recruit_target')).toBe(true);
      // A session acts as its member, whose context holds no platform grant (D-admin).
      expect(can(elevated, 'platform_analytics:read')).toBe(false);
      expect(can(ctx({ owner: true, impersonatedBy: 'sa-1', readOnly: true }), 'platform_analytics:read')).toBe(false);
    });

    it('P18-T8 AC-1 the platform’s analytics is its own permission, apart from the overview’s counts', () => {
      expect(PERMISSIONS['platform_analytics:read']).not.toBe(PERMISSIONS['platform_metrics:read']);
      expect(Object.keys(PERMISSIONS)).toEqual(expect.arrayContaining(['platform_analytics:read', 'platform_metrics:read']));
    });
  });

  /*
   * **The Super Admin's reads across KPMs** (P19.4-T3 AC-16; ADR-0207 §1; roles §3.9): two grants, the Super Admin's
   * alone, every tenant role refused, and no support session holding either — a positive and a negative per role.
   */
  /*
   * **The Super Admin changes no KPM data** (P19.4-T3, F2's note; ADR-0206 §1): the office's activity binding is the
   * Owner's and the Admin's to set, and placing a member in a unit is the office's own — a positive and a negative per role.
   */
  describe('P19.4-T3 F2 — the Super Admin writes no KPM setting and no member (ADR-0206 §1)', () => {
    const SA = ctx({ superAdmin: true, noMembership: true });

    it('P19.4-T3 F2 activity_binding:write is the Owner’s and the Admin’s at own-kpm, and nobody else’s', () => {
      expect(scopeFor(ctx({ owner: true }), 'activity_binding:write')).toBe('own-kpm');
      expect(scopeFor(ctx({ admin: true }), 'activity_binding:write')).toBe('own-kpm');
      for (const who of [SA, ctx({ role: 'ab' }), ctx({ role: 'aab' }), ctx({ role: 'agent' })]) {
        expect(can(who, 'activity_binding:write')).toBe(false);
      }
      // The Super Admin still reads it, on the KPM page's card.
      expect(scopeFor(SA, 'activity_binding:read')).toBe('all');
    });

    it('P19.4-T3 F2 a view-as session as the Owner is refused the binding’s write', () => {
      expect(can(ctx({ owner: true, impersonatedBy: 'sa-1', readOnly: true }), 'activity_binding:write')).toBe(false);
    });

    it('P19.4-T3 F2 member:add_untagged_to_unit is refused to the Super Admin; the office keeps it', () => {
      expect(can(SA, 'member:add_untagged_to_unit')).toBe(false);
      expect(scopeFor(ctx({ owner: true }), 'member:add_untagged_to_unit')).toBe('own-kpm');
      expect(scopeFor(ctx({ admin: true }), 'member:add_untagged_to_unit')).toBe('own-kpm');
      expect(scopeFor(ctx({ role: 'ab' }), 'member:add_untagged_to_unit')).toBe('own-downline');
      expect(scopeFor(ctx({ role: 'aab' }), 'member:add_untagged_to_unit')).toBe('own-unit');
      expect(can(ctx({ role: 'agent' }), 'member:add_untagged_to_unit')).toBe(false);
    });
  });

  describe('P19.4-T3 — the platform reads (ADR-0207 §1)', () => {
    const PLATFORM_READS = ['platform_members:read', 'platform_kpm_figures:read'] as const satisfies readonly Permission[];
    const ROLES: Record<string, RequestContext> = {
      KPM_OWNER: ctx({ owner: true }),
      KPM_ADMIN: ctx({ admin: true }),
      AB: ctx({ role: 'ab' }),
      AAB: ctx({ role: 'aab' }),
      AGENT: ctx({ role: 'agent' }),
    };

    it.each(PLATFORM_READS)('P19.4-T3 AC-16 positive: %s is the Super Admin’s, at all', (permission) => {
      expect(scopeFor(ctx({ superAdmin: true, noMembership: true }), permission)).toBe('all');
      expect(isReadLike(permission)).toBe(true);
    });

    it.each(PLATFORM_READS.flatMap((permission) => Object.keys(ROLES).map((role) => [permission, role] as const)))(
      'P19.4-T3 AC-16 negative: %s is refused to %s',
      (permission, role) => {
        expect(can(ROLES[role], permission)).toBe(false);
      },
    );

    it.each(PLATFORM_READS)('P19.4-T3 AC-16 negative: no view-as session holds %s', (permission) => {
      for (const target of [{ owner: true }, { admin: true }, { role: 'ab' as const }]) {
        expect(can(ctx({ ...target, impersonatedBy: 'sa-1', readOnly: true }), permission)).toBe(false);
      }
    });

    it('P19.4-T3 AC-16 the two are apart from each other and from the adoption read (ADR-0207 §1)', () => {
      expect(PERMISSIONS['platform_members:read']).not.toBe(PERMISSIONS['platform_kpm_figures:read']);
      expect(PERMISSIONS['platform_members:read']).not.toBe(PERMISSIONS['platform_analytics:read']);
    });
  });

  describe('P19.6-T5 — the Super Admin’s guide (ADR-0219 §4)', () => {
    const OTHERS: Record<string, RequestContext> = {
      KPM_OWNER: ctx({ owner: true }),
      KPM_ADMIN: ctx({ admin: true }),
      AB: ctx({ role: 'ab' }),
      AAB: ctx({ role: 'aab' }),
      AGENT: ctx({ role: 'agent' }),
      'somebody in no office': ctx({ noMembership: true }),
    };

    it('P19.6-T5 AC-4 positive: platform_guide:read is the Super Admin’s alone, at all, a read', () => {
      expect(PERMISSIONS['platform_guide:read']).toEqual([{ grantee: { kind: 'platform', role: 'super_admin' }, scope: 'all' }]);
      expect(scopeFor(ctx({ superAdmin: true, noMembership: true }), 'platform_guide:read')).toBe('all');
      expect(isReadLike('platform_guide:read')).toBe(true);
    });

    it.each(Object.keys(OTHERS))('P19.6-T5 AC-4 negative: platform_guide:read is refused to %s', (who) => {
      expect(can(OTHERS[who], 'platform_guide:read')).toBe(false);
    });

    it('P19.6-T5 AC-4 negative: no view-as session holds platform_guide:read, whoever it shows', () => {
      for (const target of [{ owner: true }, { admin: true }, { role: 'ab' as const }, { role: 'agent' as const }]) {
        expect(can(ctx({ ...target, impersonatedBy: 'sa-1', readOnly: true }), 'platform_guide:read')).toBe(false);
      }
    });
  });

  /*
   * **The forum's permissions, a positive and a negative per role** (P18.1-T2 AC-1, P18.1-T3 AC-1; roles §3.14 as
   * answered). A field member's `own-kpm` here is the guard's half: the tag is the service's, which answers 404
   * to a field member not tagged — `leader-meetings.int.spec.ts` proves it over HTTP, role by role.
   */
  describe('Phase 18.1 — the Strategic Leader Forum (roles §3.14)', () => {
    const FORUM = [
      'leader_meeting:read', 'leader_meeting:create', 'leader_meeting:reschedule', 'leader_meeting:delete',
      'leader_meeting:edit', 'leader_meeting:share_link', 'leader_meeting:read_shared_link',
    ] as const satisfies readonly Permission[];
    const ROLES: Record<string, RequestContext> = {
      SUPER_ADMIN: ctx({ superAdmin: true, noMembership: true }),
      KPM_OWNER: ctx({ owner: true }),
      KPM_ADMIN: ctx({ admin: true }),
      AB: ctx({ role: 'ab' }),
      AAB: ctx({ role: 'aab' }),
      AGENT: ctx({ role: 'agent' }),
    };
    const OFFICE = { KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm' } as const;
    const FIELD = { AB: 'own-kpm', AAB: 'own-kpm', AGENT: 'own-kpm' } as const;
    const NO_FIELD = { AB: null, AAB: null, AGENT: null } as const;
    const EXPECTED: Record<(typeof FORUM)[number], Record<string, Scope | null>> = {
      'leader_meeting:read': { SUPER_ADMIN: 'all', ...OFFICE, ...FIELD },
      'leader_meeting:create': { SUPER_ADMIN: null, ...OFFICE, ...NO_FIELD },
      'leader_meeting:reschedule': { SUPER_ADMIN: null, ...OFFICE, ...NO_FIELD },
      'leader_meeting:delete': { SUPER_ADMIN: null, ...OFFICE, ...NO_FIELD },
      'leader_meeting:edit': { SUPER_ADMIN: null, ...OFFICE, ...FIELD },
      'leader_meeting:share_link': { SUPER_ADMIN: null, ...OFFICE, ...FIELD },
      'leader_meeting:read_shared_link': { SUPER_ADMIN: 'all', ...OFFICE, ...FIELD },
    };
    const cells = FORUM.flatMap((permission) =>
      Object.keys(ROLES).map((role) => [permission, role, EXPECTED[permission][role]] as const));

    it.each(cells.filter(([, , scope]) => scope !== null))(
      'P18.1-T2 AC-1, P18.1-T3 AC-1 positive: %s is held by %s at %s',
      (permission, role, scope) => {
        expect(can(ROLES[role], permission)).toBe(true);
        expect(scopeFor(ROLES[role], permission)).toBe(scope);
      },
    );

    it.each(cells.filter(([, , scope]) => scope === null))(
      'P18.1-T2 AC-1, P18.1-T3 AC-1 negative: %s is refused to %s',
      (permission, role) => {
        expect(can(ROLES[role], permission)).toBe(false);
      },
    );

    it('P18.1-T2 AC-1 manage_coeditors and export_pdf are no permission of the code (D-coeditors; export_pdf has no route)', () => {
      expect(Object.keys(PERMISSIONS)).not.toContain('leader_meeting:manage_coeditors');
      expect(Object.keys(PERMISSIONS)).not.toContain('leader_meeting:export_pdf');
      expect(Object.keys(PERMISSIONS)).not.toContain('leader_meeting:list');
    });

    it('P18.1-T2 AC-1 a removed or pending field member holds none of them; nobody outside an office holds any', () => {
      for (const status of ['removed', 'pending'] as const) {
        for (const role of ['ab', 'aab', 'agent'] as const) {
          for (const permission of FORUM) expect([permission, can(ctx({ role, status }), permission)]).toEqual([permission, false]);
        }
      }
      for (const permission of FORUM) expect(can(ctx({ noMembership: true }), permission)).toBe(false);
    });

    it('P18.1-T2 AC-1 a read-only support session reads a meeting and a link, and is refused every write', () => {
      expect(FORUM.filter((p) => isReadLike(p))).toEqual(['leader_meeting:read', 'leader_meeting:read_shared_link']);
      for (const target of [{ owner: true }, { admin: true }, { role: 'ab' as const }, { role: 'agent' as const }]) {
        const readOnly = ctx({ ...target, impersonatedBy: 'sa-1', readOnly: true });
        expect(can(readOnly, 'leader_meeting:read')).toBe(true);
        expect(can(readOnly, 'leader_meeting:read_shared_link')).toBe(true);
        for (const write of FORUM.filter((p) => !isReadLike(p))) expect([write, can(readOnly, write)]).toEqual([write, false]);
      }
    });

    it('P18.1-T2 AC-1 an elevated session writes as its member: none of the forum is on the hard-blocked list', () => {
      const elevated = ctx({ owner: true, impersonatedBy: 'sa-1', readOnly: false });
      for (const permission of FORUM) {
        expect(isBlockedWhileImpersonating(permission)).toBe(false);
        expect(can(elevated, permission)).toBe(true);
      }
      expect(FORUM.some((p) => isOwnerReserved(p))).toBe(false);
    });
  });

  describe('Phase 14 — the sales tools (roles §3.10)', () => {
    it('P14 exit review N1: no attack_plan:* or sales_attack_plan:read permission exists (D-api, ADR-0117)', () => {
      expect(Object.keys(PERMISSIONS).filter((p) => p.startsWith('attack_plan:') || p === 'sales_attack_plan:read')).toEqual([]);
    });

    it('P14 exit review: product_settings:read is the Owner’s and the Admin’s, never a field member’s', () => {
      // The settings reads carry the office's drafts (ADR-0037); `tenant_config:read`, every member's, no longer covers them.
      expect(scopeFor(ctx({ owner: true }), 'product_settings:read')).toBe('own-kpm');
      expect(scopeFor(ctx({ admin: true }), 'product_settings:read')).toBe('own-kpm');
      expect(scopeFor(ctx({ superAdmin: true, noMembership: true }), 'product_settings:read')).toBe('all');
      for (const role of ['ab', 'aab', 'agent'] as const) {
        expect([role, can(ctx({ role }), 'product_settings:read')]).toEqual([role, false]);
        // The field read of the same shelf is theirs.
        expect([role, can(ctx({ role }), 'product_catalog:read')]).toEqual([role, true]);
      }
    });

    it('P14 exit review: a read by its verb, so a read-only session as the Owner keeps it and as an agent does not gain it', () => {
      expect(isReadLike('product_settings:read')).toBe(true);
      expect(can(ctx({ owner: true, impersonatedBy: 'sa-1', readOnly: true }), 'product_settings:read')).toBe(true);
      expect(can(ctx({ role: 'agent', impersonatedBy: 'sa-1', readOnly: true }), 'product_settings:read')).toBe(false);
    });
  });

  /*
   * **Events** (P18.2-T5 AC-1, AC-2; P18.2-T6 AC-1; roles §3.10, §3.11 as OD-31 and OD-151 answered them): a positive
   * and a negative for each of the six roles, at the level `can()` decides — the API refusing what a screen hides.
   * Who is inside an event's audience, and the 404 outside it, is `event-guest.tenancy.spec.ts`'s question.
   */
  describe('Phase 18.2 — events (roles §3.10, §3.11)', () => {
    const OWNER_AB = ctx({ owner: true, role: 'ab' });
    const ADMIN_AB = ctx({ admin: true, role: 'ab' });
    const SA = ctx({ superAdmin: true, noMembership: true });
    const FIELD = (['ab', 'aab', 'agent'] as const).map((role) => [role, ctx({ role })] as const);

    it('P18.2-T5 AC-1 every member reads the events list; the Super Admin only through a support session', () => {
      for (const [role, who] of [...FIELD, ['owner', OWNER_AB], ['admin', ADMIN_AB]] as const) {
        expect([role, scopeFor(who, 'event:read_list')]).toEqual([role, 'own-kpm']);
      }
      expect(scopeFor(SA, 'event:read_list')).toBe('all');
      expect(can(ctx({ role: 'agent', status: 'pending' }), 'event:read_list')).toBe(false);
    });

    it('P18.2-T5 AC-1 RSVP, cancel and the claim are a field member’s own — the Owner and the Admin hold them as the AB they are', () => {
      for (const permission of ['event:rsvp', 'event:cancel_rsvp', 'event_attendance:self_claim'] as const) {
        for (const [role, who] of FIELD) expect([permission, role, scopeFor(who, permission)]).toEqual([permission, role, 'own']);
        expect([permission, scopeFor(OWNER_AB, permission)]).toEqual([permission, 'own']);
        // An Owner who held no rung would hold none of them: the grant is the rung's, not the office's.
        expect([permission, can(ctx({ owner: true, role: 'agent', noMembership: true }), permission)]).toEqual([permission, false]);
        expect([permission, can(SA, permission)]).toEqual([permission, false]);
      }
    });

    it('P18.2-T5 AC-1 only the Owner and the Admins confirm attendance; no leader, no agent (OD-31)', () => {
      expect(scopeFor(ctx({ owner: true }), 'event_attendance:confirm')).toBe('own-kpm');
      expect(scopeFor(ctx({ admin: true }), 'event_attendance:confirm')).toBe('own-kpm');
      for (const [role, who] of FIELD) expect([role, can(who, 'event_attendance:confirm')]).toEqual([role, false]);
      expect(isReadLike('event_attendance:confirm')).toBe(false);
    });

    it('P18.2-T6 AC-1 feedback: every field rung submits; the AB and the AAB read their own, the office reads every row', () => {
      for (const [role, who] of FIELD) {
        expect([role, scopeFor(who, 'event_feedback:submit')]).toEqual([role, 'own']);
        expect([role, scopeFor(who, 'event_feedback:read')]).toEqual([role, 'own']);
      }
      expect(scopeFor(ctx({ owner: true }), 'event_feedback:read')).toBe('own-kpm');
      expect(scopeFor(ctx({ admin: true }), 'event_feedback:read')).toBe('own-kpm');
      expect(can(ctx({ owner: true, noMembership: true }), 'event_feedback:submit')).toBe(false);
    });

    it('P18.2-T5 AC-2 the events settings read is the Owner’s and the Admin’s, never a field member’s (the leak)', () => {
      expect(scopeFor(ctx({ owner: true }), 'event_settings:read')).toBe('own-kpm');
      expect(scopeFor(ctx({ admin: true }), 'event_settings:read')).toBe('own-kpm');
      expect(scopeFor(SA, 'event_settings:read')).toBe('all');
      for (const [role, who] of FIELD) {
        expect([role, can(who, 'event_settings:read')]).toEqual([role, false]);
        expect([role, can(who, 'event:read_list')]).toEqual([role, true]);
      }
    });

    it('P18.2-T5 AC-1 a read-only session reads and writes nothing; an elevated one never RSVPs, claims or answers for the member', () => {
      const readOnlyAgent = ctx({ role: 'agent', impersonatedBy: 'sa-1', readOnly: true });
      expect(can(readOnlyAgent, 'event:read_list')).toBe(true);
      for (const write of ['event:rsvp', 'event:cancel_rsvp', 'event_attendance:self_claim', 'event_feedback:submit'] as const) {
        expect([write, can(readOnlyAgent, write)]).toEqual([write, false]);
      }
      const readOnlyOwner = ctx({ owner: true, impersonatedBy: 'sa-1', readOnly: true });
      expect(can(readOnlyOwner, 'event_settings:read')).toBe(true);
      expect(can(readOnlyOwner, 'event_feedback:read')).toBe(true);
      expect(can(readOnlyOwner, 'event_attendance:confirm')).toBe(false);

      const elevatedAgent = ctx({ role: 'agent', impersonatedBy: 'sa-1', readOnly: false });
      expect(can(elevatedAgent, 'event:read_list')).toBe(true);
      for (const own of ['event:rsvp', 'event:cancel_rsvp', 'event_attendance:self_claim', 'event_feedback:submit'] as const) {
        expect([own, isBlockedWhileImpersonating(own)]).toEqual([own, true]);
        expect([own, can(elevatedAgent, own)]).toEqual([own, false]);
        // The member themselves, outside any session, still holds it.
        expect([own, can(ctx({ role: 'agent' }), own)]).toEqual([own, true]);
      }
      expect(can(ctx({ owner: true, impersonatedBy: 'sa-1', readOnly: false }), 'event_attendance:confirm')).toBe(true);
    });
  });

  /*
   * **Training** (P18.2-T1 AC-1, AC-8; P18.2-T2 AC-1; P18.2-T4 AC-1; roles §3.7 as OD-149 and D-support answered it):
   * a positive and a negative for each of the six roles, at the level `can()` decides — the API refusing what a
   * screen hides. Who `?for=` reaches (`COACH`, and 404 outside it) is `training-progress.tenancy.spec.ts`'s question.
   */
  describe('Phase 18.2 — training (roles §3.7)', () => {
    const TRAINING = [
      'training_progress:read', 'training_progress:update', 'training_settings:read', 'activation_settings:read',
    ] as const satisfies readonly Permission[];
    const officeOnly = (over: Parameters<typeof ctx>[0]) => {
      const base = ctx(over);
      return new RequestContext(base.userId, 'none', { ...base.membership!, orgLevelCode: 'NO_RUNG', hierarchyRole: NO_CLASS });
    };
    const ROLES: Record<string, RequestContext> = {
      SUPER_ADMIN: ctx({ superAdmin: true, noMembership: true }),
      KPM_OWNER: officeOnly({ owner: true }),
      KPM_ADMIN: officeOnly({ admin: true }),
      AB: ctx({ role: 'ab' }),
      AAB: ctx({ role: 'aab' }),
      AGENT: ctx({ role: 'agent' }),
    };
    const EXPECTED: Record<(typeof TRAINING)[number], Record<string, Scope | null>> = {
      // P19.9-T6 (ADR-0234): an Agent who leads reads their coachees' training, the coaching Training tab.
      'training_progress:read': {
        SUPER_ADMIN: 'all', KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm', AB: 'own-downline', AAB: 'own-unit', AGENT: 'own-downline',
      },
      // The AB and the AAB learn too (the matrix's defect, fixed); the Owner and the Admin through a rung only.
      'training_progress:update': {
        SUPER_ADMIN: null, KPM_OWNER: null, KPM_ADMIN: null, AB: 'own', AAB: 'own', AGENT: 'own',
      },
      // The leak (AC-8): the settings reads are the office's administration's.
      'training_settings:read': {
        SUPER_ADMIN: 'all', KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm', AB: null, AAB: null, AGENT: null,
      },
      // The exit review's B2: the activation checklist's settings read, the same shape.
      'activation_settings:read': {
        SUPER_ADMIN: 'all', KPM_OWNER: 'own-kpm', KPM_ADMIN: 'own-kpm', AB: null, AAB: null, AGENT: null,
      },
    };
    const cells = TRAINING.flatMap((permission) =>
      Object.keys(ROLES).map((role) => [permission, role, EXPECTED[permission][role]] as const));

    it.each(cells.filter(([, , scope]) => scope !== null))(
      'P18.2-T1 AC-1 positive: %s is held by %s at %s',
      (permission, role, scope) => {
        expect(can(ROLES[role], permission)).toBe(true);
        expect(scopeFor(ROLES[role], permission)).toBe(scope);
      },
    );

    it.each(cells.filter(([, , scope]) => scope === null))(
      'P18.2-T1 AC-1 negative: %s is refused to %s',
      (permission, role) => {
        expect(can(ROLES[role], permission)).toBe(false);
      },
    );

    it('P18.2-T1 AC-1 an Owner or Admin standing on a rung learns as that rung (ADR-0114)', () => {
      expect(scopeFor(ctx({ owner: true, role: 'ab' }), 'training_progress:update')).toBe('own');
      expect(scopeFor(ctx({ admin: true, role: 'agent' }), 'training_progress:update')).toBe('own');
      // …and still reads the office's settings as its administration.
      expect(scopeFor(ctx({ owner: true, role: 'ab' }), 'training_settings:read')).toBe('own-kpm');
    });

    it('P18.2-T1 AC-1 a removed or pending member neither reads nor sets their training', () => {
      for (const status of ['removed', 'pending'] as const) {
        for (const role of ['ab', 'aab', 'agent'] as const) {
          expect([status, role, can(ctx({ role, status }), 'training_progress:read')]).toEqual([status, role, false]);
          expect([status, role, can(ctx({ role, status }), 'training_progress:update')]).toEqual([status, role, false]);
        }
      }
    });

    it('P18.2-T1 AC-1 D-support: no support session sets a status, read-only or elevated; both read', () => {
      expect(isBlockedWhileImpersonating('training_progress:update')).toBe(true);
      expect(isReadLike('training_progress:read')).toBe(true);
      expect(isReadLike('training_settings:read')).toBe(true);
      for (const role of ['ab', 'aab', 'agent'] as const) {
        for (const readOnly of [true, false]) {
          const session = ctx({ role, impersonatedBy: 'sa-1', readOnly });
          expect([role, readOnly, can(session, 'training_progress:update')]).toEqual([role, readOnly, false]);
          expect([role, readOnly, can(session, 'training_progress:read')]).toEqual([role, readOnly, true]);
        }
        expect([role, can(ctx({ role }), 'training_progress:update')]).toEqual([role, true]);
      }
      // A read-only session as the Owner keeps the settings read (AC-8).
      expect(can(ctx({ owner: true, impersonatedBy: 'sa-1', readOnly: true }), 'training_settings:read')).toBe(true);
    });

    it('P18.2-T2 AC-1 `verify` is struck (OD-149): no code grants it', () => {
      expect(Object.keys(PERMISSIONS)).not.toContain('training_progress:verify');
    });
  });

  /*
   * **P19.5-T4 — the surveys and the KPM's Advanced analytics** (ADR-0216 §8, ADR-0215 §2; roles §3.8, §3.9), at the level
   * `can()` decides them: positive and negative per role. The services' own refusals — an invitee only, `COACH`, a Core
   * Leader, a view-as session — are `surveys.int.spec.ts`'s and `surveys.tenancy.spec.ts`'s.
   */
  describe('P19.5-T4 — surveys (roles §3.8, §3.9; ADR-0216 §8)', () => {
    const roles = {
      SUPER_ADMIN: ctx({ superAdmin: true, noMembership: true }),
      KPM_OWNER: ctx({ role: NO_CLASS, owner: true }),
      KPM_ADMIN: ctx({ role: NO_CLASS, admin: true }),
      AB: ctx({ role: 'ab' }),
      AAB: ctx({ role: 'aab' }),
      AGENT: ctx({ role: 'agent' }),
    } as const;
    const holders: Record<string, (keyof typeof roles)[]> = {
      'survey:respond': ['KPM_OWNER', 'KPM_ADMIN', 'AB', 'AAB', 'AGENT'],
      // P19.9-T6 (ADR-0234): every upline opens the coaching page, an Agent who leads included.
      'survey_answers:read': ['KPM_OWNER', 'KPM_ADMIN', 'AB', 'AAB', 'AGENT'],
      'advanced_analytics:read': ['KPM_OWNER', 'KPM_ADMIN', 'AB', 'AAB'],
      'advanced_analytics:write': ['KPM_OWNER', 'KPM_ADMIN'],
    };
    for (const [permission, held] of Object.entries(holders)) {
      for (const role of Object.keys(roles) as (keyof typeof roles)[]) {
        const holds = held.includes(role);
        it(`P19.5-T4 ${holds ? 'positive' : 'negative'}: ${permission} is ${holds ? 'held by' : 'refused to'} ${role}`, () => {
          expect(can(roles[role], permission as Permission)).toBe(holds);
        });
      }
    }

    it('P19.5-T4 AC-16 survey_answers:read is the Owner’s and the Admins’ office, a leader’s downline — never the Super Admin', () => {
      expect(scopeFor(roles.KPM_OWNER, 'survey_answers:read')).toBe('own-kpm');
      expect(scopeFor(roles.AB, 'survey_answers:read')).toBe('own-downline');
      expect(scopeFor(roles.AAB, 'survey_answers:read')).toBe('own-downline');
      expect(scopeFor(roles.SUPER_ADMIN, 'survey_answers:read')).toBeNull();
      // P19.9-T6: an Agent's downline, as any upline's; `COACH` reaches nobody for one who leads nobody.
      expect(scopeFor(roles.AGENT, 'survey_answers:read')).toBe('own-downline');
    });

    it('P19.5-T4 a view-as session holds no survey write: survey:respond and advanced_analytics:write are not reads', () => {
      const session = ctx({ role: 'agent', impersonatedBy: 'sa-1', readOnly: true });
      expect(can(session, 'survey:respond')).toBe(false);
      expect(can(ctx({ role: NO_CLASS, owner: true, impersonatedBy: 'sa-1', readOnly: true }), 'advanced_analytics:write')).toBe(false);
      // Its reads still hold the grant (the service answers the form without the saved answers, ADR-0216 §3).
      expect(scopeFor(session, 'survey:respond')).toBe('own');
      expect(isReadLike('survey_answers:read')).toBe(true);
    });
  });
});
