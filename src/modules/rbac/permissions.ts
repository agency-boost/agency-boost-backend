import { RequestContext } from '@/common/context/request-context';

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
  /**
   * A rung of the **company's ladder**, by code (P4-T9, ADR-0012).
   *
   * `role: HierarchyRole` until P4-T9 — three fixed names, compared against an enum.
   * That cannot describe a ladder a second insurer has not published yet: a company
   * adding a rung between AAB and AB would have members standing on something no grant
   * mentions, and every hierarchy permission would silently deny them.
   *
   * v1 seeds one ladder whose codes are the upper-cased enum values, so the two are
   * one-to-one and no permission outcome changes — which `ladder-migration.spec.ts`
   * asserts rather than assumes.
   */
  | { kind: 'hierarchy'; orgLevelCode: string }
  /**
   * Anyone signed in, membership or not. Exactly one permission uses it, and the
   * documentation says why: the office directory is `all` for every authenticated user
   * *including one with no KPM yet*, because otherwise nobody could ever join one.
   */
  | { kind: 'authenticated' };

export const SUPER_ADMIN: Grantee = { kind: 'platform', role: 'super_admin' };
export const KPM_OWNER: Grantee = { kind: 'tenant', role: 'kpm_owner' };
export const KPM_ADMIN: Grantee = { kind: 'tenant', role: 'kpm_admin' };
export const AB: Grantee = { kind: 'hierarchy', orgLevelCode: 'AB' };
export const AAB: Grantee = { kind: 'hierarchy', orgLevelCode: 'AAB' };
export const AGENT: Grantee = { kind: 'hierarchy', orgLevelCode: 'AGENT' };
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
  // Cross-tenant composition counts for the console's front page. ADR-0011 retook
  // ADR-0005's "never reads an office's business data": aggregate headcounts are in,
  // because the prototype puts two of them on the overview and nothing else can answer
  // "how big is this platform". Leads, activity, coaching notes and production stay out.
  'platform_metrics:read': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  // The queue the Superadmin prototype puts on its front page. Reading and deciding are
  // separate so a future read-only platform role is a grant, not a refactor.
  'kpm_request:read': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'kpm_request:decide': [{ grantee: SUPER_ADMIN, scope: 'all' }],
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
  /*
   * Filling an office from a spreadsheet (P3.6-T4).
   *
   * It creates accounts and hands back the passwords they start on, so it is deliberately
   * narrow — but not platform-only: an office that hires ten people at once is the case
   * this exists for, and waiting on a platform operator to run it would be the reason
   * nobody uses it. An Owner and an Admin reach **their own office and no other**, which
   * `RosterImportService.office` enforces as a 404 rather than a 403.
   *
   * A leader does not hold it. Creating accounts is administration, not recruitment, and
   * `member:search_untagged_pool` plus a leader code already cover a leader's side.
   */
  'kpm:import_roster': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  /*
   * Tenant configuration: the taxonomies an office's agent screens are driven by (P4-T1).
   *
   * **Read is wide, write is narrow.** Every agent surface renders the office's own
   * activity types, so every member of the office reads them — a taxonomy nobody may read
   * is a capture screen nobody can use. Writing is the Owner and the Admin: it is the
   * settings group the Owner prototype puts them both in, and a leader changing what the
   * office counts would silently change every ratio in it.
   *
   * `own-kpm`, never `all` for a tenant: Super Admin edits the **company template**
   * (ADR-0018, `P4-T8`), not an office's own copy, and the two are different documents on
   * purpose — an office that has diverged keeps its divergence.
   */
  'tenant_config:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-kpm' },
    { grantee: AAB, scope: 'own-kpm' },
    { grantee: AGENT, scope: 'own-kpm' },
  ],
  'tenant_config:write': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'kpm:activate': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'kpm:archive': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'kpm:assign_owner': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'kpm:transfer_ownership': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'company:crud': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  // The company role ladder (ADR-0012). Read is Super Admin only *for now*: nothing
  // tenant-side consumes it until the role-badge maps become server-supplied, and a
  // grant nobody exercises is the opposite of a permission.
  /*
   * The company's KPM template (ADR-0018, P4-T8).
   *
   * Super Admin only, and separate from `company:crud` because they are different acts: one
   * creates the company, the other decides what every office of it starts life counting.
   * A future platform role that maintains presets without creating companies is then a
   * grant rather than a refactor — which is the same argument `kpm_request:read` and
   * `kpm_request:decide` were split on.
   */
  'company_template:read': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'company_template:write': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  /*
   * The company's role ladder, readable by the offices that stand on it (P4-T9).
   *
   * Super Admin only until now, with the reason written down: *"nothing tenant-side
   * consumes it until the role-badge maps become server-supplied, and a grant nobody
   * exercises is the opposite of a permission."* P4-T9 is that change — the badge colours,
   * the labels and the order all come from here now, so five hard-coded maps in the
   * frontend stop being a second definition of a company's vocabulary.
   *
   * Every member reads it, because every member's own badge is drawn from it. Writing
   * stays Super Admin's: the ladder belongs to the company, not to an office (ADR-0012).
   */
  'org_level:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-kpm' },
    { grantee: AAB, scope: 'own-kpm' },
    { grantee: AGENT, scope: 'own-kpm' },
  ],
  'org_level:crud': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'super_admin:grant': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'super_admin:revoke': [{ grantee: SUPER_ADMIN, scope: 'all' }],

  // ---- Impersonation. ----
  'impersonation:start': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'impersonation:target_kpm_admin_or_owner': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  /*
   * Approving a support session to write (§3.13, P4-T10).
   *
   * Held by every Super Admin, and that is not the control — the control is that the
   * approver may not be the operator running the session. A permission cannot express
   * "somebody other than you", so `ImpersonationService.elevate` checks the session's own
   * starter. A grant list that tried to say it would read as two people and mean one.
   */
  'impersonation:elevate_to_write': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  /**
   * Granted to nobody, deliberately. A Super Admin impersonating another Super Admin
   * would erase the only attribution that makes the feature auditable at all.
   */
  'impersonation:target_super_admin': [],

  // ---- Tenant administration. ----
  // The Super Admin grants were missing until 2026-09-06, against a matrix that has
  // always read `all`. An office whose Owner has left is exactly the case a platform
  // operator exists for, and without these there was no way to restore its administration
  // — the office was stuck. `isOwnerReserved` filters platform grantees before it decides,
  // so these do not stop an Admin being refused with `PERM_OWNER_ONLY`; there is a test.
  'kpm_admin:grant': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
  ],
  'kpm_admin:revoke': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
  ],
  'kpm_admin:list': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  // The platform-wide roster is a different question from an office's own admin list, and
  // needs its own grant: `kpm_admin:list` gives an Owner `own-kpm`, so gating the roster
  // on it let an Owner past the guard and left the repository to refuse them — with
  // `MissingTenantContextError`, which is a defence, not an answer. A test now asserts
  // they get `PERM_DENIED` at the door instead.
  'kpm_admin:list_platform': [{ grantee: SUPER_ADMIN, scope: 'all' }],
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
  //
  // **No `SUPER_ADMIN` grant, deliberately.** `GET /members/tree` resolves `kpmId` from
  // the caller's membership, which a Super Admin has none of — so the guard passed, the
  // repository threw `MissingTenantContextError`, and the route answered **500** rather
  // than a tree. That is the same trap `member:read_profile/SUPER_ADMIN` was deferred to
  // avoid; this one was granted anyway. A Super Admin reaches an office by impersonation
  // until a cross-tenant console route exists. Registered in the spec's `DEFERRED` list.
  'org_tree:read': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
    { grantee: AGENT, scope: 'own' },
  ],
  // `own-unit` for an AB, not `own-downline`. These two are the named exceptions to the
  // collapsing rule in roles-and-permissions.md §1: they act on the leader edge the actor
  // owns, so an AB reaches their direct reports and no further. The services already
  // enforce `target.leaderId === me`, so this was a declaration wider than the behaviour
  // — and a permission that claims more than it grants is the kind that gets copied.
  'member:change_role': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-unit' },
    { grantee: AAB, scope: 'own-unit' },
  ],
  // Owner and Admin only. Gated on `member:read_profile` until 2026-09-06, which every
  // member holds — so an agent whose own roster is one row could read every role change
  // in the office, with names, reasons and the acting leader. The service filters by
  // `kpmId` and nothing else, so the permission is the only boundary there is.
  'member:read_role_change_log': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'member:remove_from_team': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-unit' },
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
  // The Owner and an Admin decide anywhere in the office — a request whose leader never
  // looks is the failure the queue exists to prevent. This matched the matrix nowhere
  // until 2026-09-06: the code had only the two leader grants, and office-wide approval
  // worked solely because `assignOwner` happens to make an Owner an AB. An agent
  // promoted to Owner, or an Admin who is an agent, was refused their own queue.
  'leader_request:approve': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-unit' },
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
  // Asking for an office that does not exist. Granted to anybody signed in for the same
  // reason as attaching to one that does: the asker has no office and therefore no
  // hierarchy role, so there is no role to grant it to. The service refuses somebody who
  // already belongs somewhere.
  'kpm_request:create': [{ grantee: AUTHENTICATED, scope: 'own' }],
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
    { grantee: SUPER_ADMIN, scope: 'own' },
    { grantee: KPM_OWNER, scope: 'own' },
    { grantee: KPM_ADMIN, scope: 'own' },
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  'profile:update_self': [
    { grantee: SUPER_ADMIN, scope: 'own' },
    { grantee: KPM_OWNER, scope: 'own' },
    { grantee: KPM_ADMIN, scope: 'own' },
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  // Reading your own inbox, and marking a row read. Granted to everybody signed in and
  // scoped to `own`, like the profile: a notification is addressed to a **person**, and
  // `notifications.kpmId` is nullable because email verification and password reset are
  // sent before anybody has an office. Scoping these to a tenant would hide the
  // notifications a newcomer most needs.
  // `AUTHENTICATED`, not the six roles: somebody who has joined no office still has an
  // inbox, and the first thing in it is their own email verification. Listing the roles
  // refused exactly that person — the test that builds a newcomer caught it.
  'notification:read_inbox': [{ grantee: AUTHENTICATED, scope: 'own' }],
  'notification:mark_read': [{ grantee: AUTHENTICATED, scope: 'own' }],
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

/**
 * Is this a power the office's Owner keeps to themselves?
 *
 * True when no tenant grantee but `KPM_OWNER` appears — admin delegation, ownership
 * transfer, branch info. It lets a refusal say *which* wall was hit: an Admin denied one
 * of these is not missing a role, they are being told the Owner reserved it. Derived
 * from the grant list rather than a second list of "owner things", which would drift.
 */
export function isOwnerReserved(permission: Permission): boolean {
  const grants = PERMISSIONS[permission] as readonly Grant[];
  const tenantGrantees = grants.filter((g) => g.grantee.kind !== 'platform');
  return (
    tenantGrantees.length > 0 &&
    tenantGrantees.every((g) => g.grantee.kind === 'tenant' && g.grantee.role === 'kpm_owner')
  );
}

/**
 * Powers that are refused **inside a support session**, however it was elevated (P4-T10,
 * §3.13).
 *
 * These are the actions whose blast radius reaches past the office being supported, or
 * that would let a session widen itself. A Super Admin has every one of them in their own
 * right; the point is that acting *as somebody else* is not the way to use them. If the
 * support case genuinely needs one, the operator ends the session and does it as
 * themselves, where the audit row says so plainly.
 *
 * Cross-tenant reads are absent from the list because they are structurally impossible: a
 * session's token is pinned to one person, and every scoped read resolves from their
 * membership.
 */
export const BLOCKED_WHILE_IMPERSONATING: readonly Permission[] = [
  'impersonation:start',
  'super_admin:grant',
  'kpm:create',
  'kpm:archive',
  'kpm:transfer_ownership',
  'kpm_admin:grant',
  'kpm_admin:revoke',
  'notification_preference:manage',
];

const BLOCKED = new Set<string>(BLOCKED_WHILE_IMPERSONATING);

/** Is this one of the powers a support session may never use? */
export function isBlockedWhileImpersonating(permission: Permission): boolean {
  return BLOCKED.has(permission);
}

export function can(ctx: RequestContext, permission: Permission): boolean {
  /*
   * The hard-blocked list, checked at the one place every permission question passes
   * through (P4-T10). Putting it in each controller would mean remembering it in each
   * controller — and the row that matters most, `kpm_admin:grant`, was reachable by a
   * Super Admin impersonating an Owner precisely because nothing central said no.
   */
  if (ctx.isImpersonating && isBlockedWhileImpersonating(permission)) return false;

  /*
   * A read-only session may read anything the target can and write nothing.
   *
   * The distinction is made from the permission's own verb rather than from the HTTP
   * method, because the method is the controller's business and this is not: a `POST`
   * that only reads is still a read, and a permission named `:archive` is a write on any
   * verb. Every permission in the registry is `resource:action`, and the read-shaped
   * actions are a short closed list.
   */
  if (ctx.impersonationReadOnly && !isReadLike(permission)) return false;

  return scopeFor(ctx, permission) !== null;
}

/** Actions that only read. Everything else is treated as a write. */
const READ_LIKE = /^(read|list|search|preview|view|export)/;

function isReadLike(permission: Permission): boolean {
  const action = permission.split(':')[1] ?? '';
  /*
   * Prefix only. An `endsWith('_read')` clause used to sit here, and the one permission
   * in the registry it admitted was `notification:mark_read` — which writes. A read-only
   * session could destroy the target's unread state, including the notice telling them
   * the session had started.
   */
  return READ_LIKE.test(action);
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
        // By ladder code, not by enum (P4-T9). Both sides are the company's own
        // vocabulary; neither is a list this file enumerated in advance.
        ctx.membership!.orgLevelCode === grantee.orgLevelCode
      );
    }
  }
}

const SCOPE_ORDER: readonly Scope[] = ['own', 'own-unit', 'own-downline', 'own-kpm', 'all'];

/**
 * When several grants apply, the widest wins.
 *
 * Written without a comparison branch on purpose. Every table below happens to list its
 * grants widest-first, which made the `a < b` arm unreachable and left this module short
 * of the 100% branch coverage the ratchet demands of anything that decides access. The
 * guarantee is unchanged — the result does not depend on the order grants are declared
 * in — but now nothing here can go untested because of how a table happens to be typed.
 */
function wider(a: Scope | null, b: Scope): Scope {
  if (a === null) return b;
  return SCOPE_ORDER[Math.max(SCOPE_ORDER.indexOf(a), SCOPE_ORDER.indexOf(b))];
}
