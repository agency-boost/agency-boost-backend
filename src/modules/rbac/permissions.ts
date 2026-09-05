import { HierarchyRole, RequestContext } from '@/common/context/request-context';

/**
 * The permission matrix as executable policy.
 *
 * Every string here has a row in docs/00-product/roles-and-permissions.md, and a test
 * asserts that correspondence in both directions — a permission in code that the
 * documentation does not describe is as much a defect as the reverse.
 */

/** What a grant is scoped to. Reaching further than this is `PERM_OUT_OF_SCOPE`. */
export type Scope = 'own' | 'own-unit' | 'own-downline' | 'own-kpm' | 'all';

/**
 * Tenant-admin rights are **independent** of hierarchy role: a person can be an AB and
 * a KPM Admin at once, and the two grant different things. Modelling them as one enum
 * would make that unrepresentable.
 */
export type Grantee =
  | { kind: 'platform'; role: 'super_admin' }
  | { kind: 'tenant'; role: 'kpm_owner' | 'kpm_admin' }
  | { kind: 'hierarchy'; role: HierarchyRole }
  /**
   * Anyone signed in, membership or not. Exactly one permission uses it, and the
   * documentation says why: the office directory is `all` for every authenticated user
   * *including one with no KPM yet*, because otherwise nobody could ever join one.
   */
  | { kind: 'authenticated' };

export const SUPER_ADMIN: Grantee = { kind: 'platform', role: 'super_admin' };
export const KPM_OWNER: Grantee = { kind: 'tenant', role: 'kpm_owner' };
export const KPM_ADMIN: Grantee = { kind: 'tenant', role: 'kpm_admin' };
export const AB: Grantee = { kind: 'hierarchy', role: 'ab' };
export const AAB: Grantee = { kind: 'hierarchy', role: 'aab' };
export const AGENT: Grantee = { kind: 'hierarchy', role: 'agent' };
export const AUTHENTICATED: Grantee = { kind: 'authenticated' };

export interface Grant {
  readonly grantee: Grantee;
  readonly scope: Scope;
  /**
   * Which membership statuses the grant survives. Active only, unless stated.
   *
   * The join flow is the exception that needs stating: registering to an office makes
   * you `pending`, and the whole point of that state is that you can then look for a
   * leader. Without this, the person the flow exists for would be refused by it.
   *
   * It lives on the grant rather than in the check, so the exception is visible beside
   * the permission it applies to instead of being a special case buried in `holds`.
   */
  readonly whileStatus?: readonly ('active' | 'pending')[];
}

/**
 * `resource:action` → who may do it, and how far their reach extends.
 *
 * Names come from docs/00-product/roles-and-permissions.md, which defines 148 of them
 * across the whole product. This is the subset Phase 2 implements; later phases add
 * their own. A test asserts every name here exists in that document — the code does
 * not get to invent vocabulary.
 */
export const PERMISSIONS = {
  // ---- Platform. Tenant management only in v1 (ADR-0005). ----
  'kpm:create': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'kpm:list_all': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'kpm:read_profile': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  /** Branch info: the office's own identity, editable by its Owner. */
  'kpm:update_identity': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
  ],
  /** The company tag is Super Admin's alone — the prototype disables the field. */
  'kpm:update_company_tag': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'kpm:suspend': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'kpm:activate': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'kpm:archive': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'kpm:assign_owner': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'kpm:transfer_ownership': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'company:crud': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'super_admin:grant': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'super_admin:revoke': [{ grantee: SUPER_ADMIN, scope: 'all' }],

  // ---- Impersonation. ----
  'impersonation:start': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'impersonation:target_kpm_admin_or_owner': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  /**
   * Granted to nobody, deliberately. A Super Admin impersonating another Super Admin
   * would erase the only attribution that makes the feature auditable at all.
   */
  'impersonation:target_super_admin': [],
  'impersonation:read_session_log': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
  ],

  // ---- Tenant administration. ----
  'kpm_admin:grant': [{ grantee: KPM_OWNER, scope: 'own-kpm' }],
  'kpm_admin:revoke': [{ grantee: KPM_OWNER, scope: 'own-kpm' }],
  'kpm_admin:list': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'audit_log:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'audit_log:export': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
  ],

  // ---- Membership. ----
  'member:read_profile': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
    { grantee: AGENT, scope: 'own' },
  ],
  'member:invite': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
  ],
  // Tags, and only the office's admins set them. A group is not hierarchy and not
  // access, so no leader grant: it is the office's own way of organising, not a unit's.
  'member:tag_group': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'member:tag_core_leader': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'group_informal:create': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'group_informal:update': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'group_informal:archive': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],

  // The tree is a read of the same graph the roster reads, and it narrows the same way:
  // a tenant admin sees the office, everyone else sees themselves and their downline.
  // An agent's tree is degenerate — their leader and themselves — and it is granted
  // anyway so the API answers rather than 403s; the nav hides it for them.
  'org_tree:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
    { grantee: AGENT, scope: 'own' },
  ],
  'member:change_role': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
  ],
  'member:remove_from_team': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
  ],
  'leader_request:read_inbox': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-unit' },
    { grantee: AAB, scope: 'own-unit' },
  ],
  // Sending an approved agent into one of your own AABs' units instead of your own.
  // AB only: an AAB's reports are agents, so there is no sub-unit to route into.
  'leader_request:route_to_sub_unit': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
  ],
  'member:search_untagged_pool': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-kpm' },
    { grantee: AAB, scope: 'own-kpm' },
  ],
  'member:add_untagged_to_unit': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
  ],
  'leader_request:approve': [
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
  ],

  // ---- Joining an office. ----
  //
  // `kpm:read_directory` is the only cross-tenant read a non-Super-Admin has, and it is
  // granted to everyone — including someone with no office at all, because otherwise
  // nobody could ever join one. It is projection-limited to code, branch name, company
  // and city: no member counts, no production, no owner name.
  'kpm:read_directory': [{ grantee: AUTHENTICATED, scope: 'all' }],
  // Attaching yourself to an office. Held by anyone signed in, because the person who
  // needs it is by definition in no office yet — the service refuses a second one.
  'kpm_registration:create': [{ grantee: AUTHENTICATED, scope: 'own' }],
  // From here on a membership exists, and `pending` is the state these are *for*.
  'leader:search_directory': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-kpm', whileStatus: ['active', 'pending'] },
    { grantee: AAB, scope: 'own-kpm', whileStatus: ['active', 'pending'] },
    { grantee: AGENT, scope: 'own-kpm', whileStatus: ['active', 'pending'] },
  ],
  'leader_request:create': [
    { grantee: AB, scope: 'own', whileStatus: ['active', 'pending'] },
    { grantee: AAB, scope: 'own', whileStatus: ['active', 'pending'] },
    { grantee: AGENT, scope: 'own', whileStatus: ['active', 'pending'] },
  ],
  'member:revoke_invite': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
  ],
  // The joiner's side of an invite. Held by anyone signed in for the same reason
  // `kpm_registration:create` is: the person redeeming one is in no office yet.
  'join_via_code_link_qr': [{ grantee: AUTHENTICATED, scope: 'own' }],
  'leader_request:cancel': [
    { grantee: AB, scope: 'own', whileStatus: ['active', 'pending'] },
    { grantee: AAB, scope: 'own', whileStatus: ['active', 'pending'] },
    { grantee: AGENT, scope: 'own', whileStatus: ['active', 'pending'] },
  ],

  // ---- Own records. ----
  'profile:read_self': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  'profile:update_self': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  'notification:receive': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  'notification_preference:manage': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
} as const satisfies Record<string, readonly Grant[]>;

export type Permission = keyof typeof PERMISSIONS;

/** Does this context hold the permission at all, and at what scope? */
export function scopeFor(ctx: RequestContext, permission: Permission): Scope | null {
  const grants = PERMISSIONS[permission] as readonly Grant[];
  let widest: Scope | null = null;

  for (const grant of grants) {
    if (!holds(ctx, grant)) continue;
    widest = wider(widest, grant.scope);
  }
  return widest;
}

export function can(ctx: RequestContext, permission: Permission): boolean {
  return scopeFor(ctx, permission) !== null;
}

function holds(ctx: RequestContext, grant: Grant): boolean {
  const { grantee } = grant;
  switch (grantee.kind) {
    case 'authenticated':
      // The guard has already established who they are; that is the whole test.
      return true;
    case 'platform':
      return ctx.isSuperAdmin;
    case 'tenant':
      if (!ctx.membership) return false;
      return grantee.role === 'kpm_owner' ? ctx.membership.isKpmOwner : ctx.membership.isKpmAdmin;
    case 'hierarchy': {
      // A hierarchy grant applies to an active member unless the grant says otherwise.
      // A removed membership never carries rights, whatever a grant says.
      const allowed = grant.whileStatus ?? ['active'];
      const status = ctx.membership?.status;
      return (
        status !== undefined &&
        status !== 'removed' &&
        (allowed as readonly string[]).includes(status) &&
        ctx.membership!.hierarchyRole === grantee.role
      );
    }
  }
}

const SCOPE_ORDER: readonly Scope[] = ['own', 'own-unit', 'own-downline', 'own-kpm', 'all'];

/** When several grants apply, the widest wins. */
function wider(a: Scope | null, b: Scope): Scope {
  if (a === null) return b;
  return SCOPE_ORDER.indexOf(a) >= SCOPE_ORDER.indexOf(b) ? a : b;
}
