import { RequestContext, type HierarchyRole } from '@/common/context/request-context';

/**
 * The permission matrix as executable policy.
 *
 * Every string here has a row in docs/00-product/roles-and-permissions.md, and a test
 * asserts that correspondence in both directions — a permission in code that the
 * documentation does not describe is as much a defect as the reverse.
 */

/**
 * What a grant is scoped to. Reaching further than this is **404**, `NOT_FOUND`, on every subject
 * read and write: a 403 would confirm that the person exists (P11-T3 AC-3, `conventions.md`).
 */
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
   * A **class** of the hierarchy (ADR-0156 §3): `ab`, `aab` or `agent` — the `role` a membership is given from
   * its rung's leader tier (*Senior Leader*, *Associate Leader*, none) wherever it is placed on a rung.
   *
   * By rung code from P4-T9 until P18.8-T1, and that was the defect ADR-0156 names: a member on a rung the Super
   * Admin added — `SM`, say — stood on something no grant mentioned, and held none of AB's, AAB's or AGENT's
   * rights. A custom rung worked for nothing. By class, a rung marked *Senior Leader* holds exactly AB's grants
   * whatever it is called, and the matrix is unchanged for the default ladder, whose codes are the classes
   * upper-cased (`permissions.spec.ts`, *the leader tier*).
   */
  | { kind: 'hierarchy'; roleClass: HierarchyRole }
  /**
   * Anyone signed in, membership or not. Exactly one permission uses it, and the
   * documentation says why: the office directory is `all` for every authenticated user
   * *including one with no KPM yet*, because otherwise nobody could ever join one.
   */
  | { kind: 'authenticated' };

export const SUPER_ADMIN: Grantee = { kind: 'platform', role: 'super_admin' };
export const KPM_OWNER: Grantee = { kind: 'tenant', role: 'kpm_owner' };
export const KPM_ADMIN: Grantee = { kind: 'tenant', role: 'kpm_admin' };
export const AB: Grantee = { kind: 'hierarchy', roleClass: 'ab' };
export const AAB: Grantee = { kind: 'hierarchy', roleClass: 'aab' };
export const AGENT: Grantee = { kind: 'hierarchy', roleClass: 'agent' };
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
  /*
   * The quote tool's price table (ADR-0111 §3, P13.2-T2): `GET /admin/billing/prices`. The Super
   * Admin's alone, since the 101+ tier's real rates are AgencyBoost's own (`Billing_Subscription.html:500`).
   * A support session acts as its member, whose context holds no platform grant, so it is refused too.
   * A read, and the only one: the tool writes nothing (ADR-0111 §2).
   */
  'billing:read_prices': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'kpm:read_profile': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
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
  /*
   * **Every page under Settings, Branch info included** (ADR-0027) — one permission rather
   * than one per screen, because every such page is reached by the same people. Branch info
   * had its own Owner-only `kpm:update_identity` until the product owner gave the Admin the
   * same write; a page that one day needs a different rule gets its own permission then.
   */
  'tenant_config:write': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'kpm:activate': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'kpm:archive': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'kpm:assign_owner': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  'kpm:transfer_ownership': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  /*
   * An office's subscription — its dates, price per leader, leader limit and *keep active*
   * (ADR-0112 §2, P13.2-T3): `PATCH /admin/tenants/:kpmId/subscription`. **The Super Admin's
   * alone.** It is the commercial relationship with AgencyBoost, and its end cuts every member off,
   * so no tenant grantee holds it — not the Owner, whose office it is — and it is on
   * `BLOCKED_WHILE_IMPERSONATING` below, so a support session cannot write it in a member's name.
   */
  'kpm:update_subscription': [{ grantee: SUPER_ADMIN, scope: 'all' }],
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
   * **An office's activity binding** (ADR-0163 §3, P18.9-T2): which activity types each cascade role counts —
   * *Set appointment*, *Sales meeting*, *Submission polis*. The Super Admin keeps it, per office, at
   * `GET`/`PUT /admin/tenants/:kpmId/activity-binding`, through a named cross-tenant method; the Owner and the
   * Admin read their own office's on their activity types screen (`GET /kpm/settings/activity-binding`), and the
   * admin route answers them their own office and 404 for any other. Nobody else reads it: an agent's screens
   * read the counts it produces, never the binding. A template's binding is `company_template:write`.
   */
  'activity_binding:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'activity_binding:write': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  /*
   * The company's product catalog (ADR-0033, P5-T4).
   *
   * Super Admin's alone, and separate from `company_template:write` although both edit the
   * company's side: a template is copied into an office once, at creation, and a product is
   * **read live** — withdrawing one stops every office of the company selling it on their next
   * read. The two have different blast radii, so they are different permissions.
   *
   * The office-side read is `product_catalog:read`, below.
   */
  'product_catalog:crud': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  /*
   * The office's shelf, as its field members read it (Phase 14, D-api; roles §3.10): the Product
   * Catalog, one product's drawer, a document's link, and the Sales Attack Plan — into which
   * `sales_attack_plan:read` and `attack_plan:generate` were folded, nothing being generated or stored
   * (OD-133). **Field reads, apart from the settings routes**, which carry the office's drafts and
   * review state and are `product_settings:read`, below.
   *
   * Every member of the office, `own-kpm`: the Owner and the Admin reach it through their field view
   * (ADR-0114). The Super Admin's `all` is the matrix's, and reads nothing on its own — a Super Admin
   * outside a support session belongs to no office, so the read refuses them as every scoped read
   * does (`403 TENANT_NO_MEMBERSHIP`); inside one, the member's own grant answers. A read, so a
   * read-only session holds it.
   */
  'product_catalog:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-kpm' },
    { grantee: AAB, scope: 'own-kpm' },
    { grantee: AGENT, scope: 'own-kpm' },
  ],
  /*
   * **Recruitment tools, as the field reads them** (Phase 17, D-api; roles §3.x): the Recruitment Attack
   * Plan for a candidate brief, the office's four pitch documents with their states and ticks, and a
   * document's link signed for 300 seconds. **Both screens read one answer** — the agents' tab and the
   * Owner's and the Admin's settings page — since nothing in it is the office's draft: the ticks are what
   * the banner already counts for agents (`:797-820`). The office's writes are `tenant_config:write`
   * (ADR-0027); the playbook's, `recruitment_playbook:write`, below.
   *
   * Every member of the office, `own-kpm`: the Owner and the Admin reach the agents' tabs through their
   * field view (ADR-0114). The Super Admin's `all` reads nothing on its own — outside a support session
   * there is no office to read, and the read refuses them `403 TENANT_NO_MEMBERSHIP` as every scoped read
   * does; inside one, the member's own grant answers. A read by its verb, so a read-only session holds it.
   */
  'recruitment:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-kpm' },
    { grantee: AAB, scope: 'own-kpm' },
    { grantee: AGENT, scope: 'own-kpm' },
  ],
  /*
   * **Saving a company's recruitment playbook** (OD-88 → option 5, ADR-0125; P17-T8): the words every
   * office of the company reads live on its next plan. The Super Admin's alone, and apart from
   * `company_template:write` for the reason `product_catalog:crud` is apart from it: a template is copied
   * into an office once, while the playbook — like a product — reaches every office at once. Read on the
   * console under `company_template:read`. No office edits it (OD-88: no office override).
   */
  'recruitment_playbook:write': [{ grantee: SUPER_ADMIN, scope: 'all' }],
  /*
   * **The settings reads of the office's products** (the Phase 14 exit review; roles §3.10):
   * `GET /kpm/settings/products`, a slot's signed link there, the script-review queue and the effective
   * read. They carry what ADR-0037 keeps from agents — the office's drafts (`overrides`), the review
   * state and a rejection's reason — and they sat on `tenant_config:read`, which every member of the
   * office holds because every agent screen renders the office's taxonomy. So an agent could read the
   * Owner's unapproved script by asking the settings route for it.
   *
   * The Owner and the Admin, `own-kpm`: whoever writes the office's settings (`tenant_config:write`)
   * reads them. The Super Admin's `all` mirrors `tenant_config:read`'s and reads nothing on its own — in
   * no office, the shelf has no company to resolve and answers 404; inside a support session the
   * member's own grant answers. A read by its verb, so a read-only session as an Owner keeps it.
   */
  'product_settings:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  /*
   * What somebody earns on a product (ADR-0038, closing OD-43; OD-135).
   *
   * A figure an agent reads as their pay: the catalog read leaves `commissionSchedule` out
   * entirely for anybody without this, rather than sending it and hiding it on screen.
   *
   * **One schedule per product, every agent's** (OD-135, ADR-0119): the company's, the same for
   * whoever sells it. So the leader's `own-downline` — ADR-0038's *"the rates of the people they
   * lead"* — and their `own` read the same row, and the field reads ask only whether the reader holds
   * the grant at all, at any scope. The scopes are the matrix's, kept for the day a rate is per agent.
   */
  'commission_rates:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own' },
    { grantee: AAB, scope: 'own-downline' },
    { grantee: AGENT, scope: 'own' },
  ],
  /*
   * Approving an office's own sales-script override before agents read it (ADR-0037, P5-T10).
   *
   * **The one deliberate exception to ADR-0027**, which otherwise makes every page under Settings
   * a single `tenant_config:write`. The answer to *"who may change this office's configuration"* is
   * one answer; *"who may approve a script"* is a question that decision expects to revisit, and a
   * separate permission is what makes moving it to Super Admin, or to a company compliance role, a
   * grant change rather than a redesign.
   *
   * **A gate, not an independent review.** The office both writes and approves. What it guarantees
   * is that no half-finished script reaches an agent and that every script an agent read carries a
   * name and a time — and the manual says exactly that, so nobody reads a tick as somebody else's
   * compliance sign-off.
   */
  'sales_script:approve': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
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

  /*
   * The metric registry — the platform's own vocabulary (P5-T9, invariant 8).
   *
   * **Read by everybody, because every role's screens name metrics**, and written by nobody: it
   * is a constant in `domain/constants`, not a row. A Super Admin authoring a company's carrier
   * rules needs it, and so does an Owner writing a campaign requirement — and the campaigns
   * screen had been carrying its own hard-coded copy of five of them, which is the second
   * definition of a metric invariant 7 exists to prevent.
   *
   * It carries no tenant data at all: the same list, for everybody, whatever office they are in.
   */
  'metric_registry:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-kpm' },
    { grantee: AAB, scope: 'own-kpm' },
    { grantee: AGENT, scope: 'own-kpm' },
  ],
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
  // The Owner's alone until ADR-0028. No route reads it yet; when one does, it is both of theirs.
  'audit_log:export': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],

  // ---- Activity logging (P6, `roles-and-permissions.md` §3.5). ----
  /*
   * **Writing is `own` and nothing else, on purpose.**
   *
   * Not the leader, not the Owner, not a Super Admin, not an elevated impersonation session. §3.5
   * gives the reason: the daily log is the evidentiary base for compliance, MAA status, coaching
   * coverage and campaign qualification, and a proxy write destroys its meaning. The service
   * enforces it structurally as well — the write path takes no subject at all — because a grant
   * list is a statement and a missing parameter is a guarantee.
   */
  'activity_log:create': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  /** Correcting a frozen day (ADR-0042). Still `own`: a correction is a write. */
  'activity_log:update': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  /*
   * **Reading is wide, and §3.5 explains why it was widened rather than clawed back.** The Owner
   * and Admin were once limited to the binary compliance projection, and three other grants in
   * the same matrix — personal summary, KPM analytics, the unit dashboard's per-person breakdown —
   * routed around it. An access control three endpoints defeat is not a control; it is a false
   * statement in a document.
   */
  'activity_log:read_raw': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
    { grantee: AGENT, scope: 'own' },
  ],
  /*
   * The Personal Summary (P10-T4). The matrix's grant, whole: without `for` the route is the caller's
   * own, and with it the grant reaches the subject through `CoachResolver.subject` (P11-T4).
   */
  'personal_summary:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
    { grantee: AGENT, scope: 'own' },
  ],
  'activity_ratios:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
    { grantee: AGENT, scope: 'own' },
  ],
  /*
   * **`activity_log:proxy_create` is deliberately absent from this registry.**
   *
   * §3.5 documents the row and grants it to nobody: *"No role may log activity on behalf of
   * another person… If proxy logging is ever added it must be a distinct action with visible
   * attribution on the agent's own screen."* Declaring it here with an empty grant list would
   * trip the rule that a permission nobody holds is probably a mistake — and it would be worth
   * tripping, because a key here is something a route can declare, and no route should. The
   * guarantee is structural instead: `ActivityService`'s write path takes no subject at all.
   */

  /*
   * ---- Leads (P7). ----
   *
   * **The opposite decision from the activity log above, and §3.7 gives the reason.** A day's log
   * is evidence, so nobody but its subject writes it; a lead is a shared working board, and a real
   * 1-on-1 does update it live. A leader writes a downline's lead and the write carries their name
   * (ADR-0044). The two records sit next to each other in this file deliberately: the next reader
   * should be able to see that the difference is intended.
   *
   * **The scopes are registered; the service still serves `own`.** Resolving a downline is
   * P7-T7's, which is also where the attribution and the version rule land. That fails closed — a
   * leader sees their own leads until then — rather than open.
   *
   * **Super Admin's `all` is `DEFERRED`, not enforced.** The routes resolve `kpmId` from the
   * caller's membership and a Super Admin has none, so the grant yields MissingTenantContextError
   * rather than access. §3.7 argues minimisation harder for a platform reader than for an office
   * one, so it is a row to revisit rather than a route to build.
   */
  'lead:create': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
    { grantee: AGENT, scope: 'own' },
  ],
  'lead:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
    { grantee: AGENT, scope: 'own' },
  ],
  'lead:update': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
    { grantee: AGENT, scope: 'own' },
  ],
  /*
   * **`own` and nothing else** (§3.7). Not the coach — the coaching leads table has no delete —
   * and not the admin, who may not read the rows at all. Soft, with a retention window.
   */
  /**
   * **`own` for everybody who carries leads, which is the point** — not *agents only*.
   *
   * This granted `AGENT` alone until P7-T7, and the sentence behind it — *"soft, and the agent's
   * alone; not the coach"* — meant **the owner's alone**. The thing that stops a coach deleting
   * somebody's record is the `own` *scope*, not the absence of the grant: an AAB and an AB carry
   * their own prospects like anybody else, and they could not delete one. Found writing AC-5's
   * six-role tests, which is what those are for.
   */
  /**
   * Counts, and never rows (§3.7, P7-T6).
   *
   * **The one lead permission the Owner and the Admin hold.** A lead carries third-party personal
   * data an agent typed about somebody who never interacted with the platform, and minimisation
   * applies inside the tenant too — so an office's administrators are told *how many*, which is
   * what running an office needs, and never *who*.
   */
  /**
   * A goal is an agent's own plan, and §3.6 reads differently from §3.7 because of it.
   *
   * **The Owner and the Admin hold `own-kpm` on both**, where on a lead they hold counts and no
   * rows. A lead carries a third party's name and phone number, typed about somebody who never
   * interacted with the platform; a goal carries an agent's own intentions about their own
   * production. Minimisation has nothing to bite on here.
   *
   * The AB/AAB grant is the **coaching** grant: the Coaching Session mounts a writable replica of
   * the coachee's Goal Settings (Phase 11). A leader saves directly and the goal carries their name
   * (ADR-0046).
   */
  'goal:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
    { grantee: AGENT, scope: 'own' },
  ],
  /** No Super Admin grant at all, not even the nominal one `goal:read` carries (§3.6). */
  'goal:update': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
    { grantee: AGENT, scope: 'own' },
  ],
  'lead:read_aggregate_counts': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
    { grantee: AGENT, scope: 'own' },
  ],
  'lead:delete': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  /**
   * Closing a lead. Its own permission because it is its own act: the status says where somebody
   * is, the outcome says the work stopped and how it ended.
   */
  'lead:mark_outcome': [
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
    { grantee: AGENT, scope: 'own' },
  ],

  /*
   * ---- Coaching (P11-T3, `roles-and-permissions.md` §3.8 as ADR-0073, ADR-0074 and ADR-0078 amend
   * it, and `functional/coaching.md`, *The permissions*). ----
   *
   * **On a session or a profile a token names the coachee**: `own` is a session about the reader,
   * `own-downline` one about somebody below them, which is `COACH` (`CoachResolver`, in the org
   * module). The AAB's cells are the AB's: a leader coaches their whole downline, never sideways and
   * never themselves (ADR-0074).
   *
   * **`own` · `own-downline` is two grants, written as two.** A wider token never silently includes
   * the reader's own records (§3), so an AB who is also a coachee holds both, and the matrix spec
   * compares the whole set of tokens in each cell, not only the widest.
   *
   * **The Super Admin's `all` on `read` and `reopen` is not access.** The routes resolve the office
   * from the caller's membership, as `lead:*`'s do, and a Super Admin has none; they reach coaching
   * only by impersonation, and a leader note not even then.
   *
   * **`coaching_session:share` is not here, and never will be**: nothing in the product shares a
   * session (ADR-0077, ADR-0083), and §3.8 strikes the row.
   */
  'coaching_session:create': [
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-downline' },
  ],
  'coaching_session:edit': [
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-downline' },
  ],
  'coaching_session:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own' },
    { grantee: AAB, scope: 'own-downline' },
    { grantee: AGENT, scope: 'own' },
  ],
  'coaching_session:finalize': [
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-downline' },
  ],
  /** A correction, inside ADR-0079's window. The Owner and the Admin correct; they never coach. */
  'coaching_session:reopen': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-downline' },
  ],
  /** The print of a finalized session (ADR-0077). A read, so a read-only support session may. */
  'coaching_session:export_pdf': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own' },
    { grantee: AAB, scope: 'own-downline' },
    { grantee: AGENT, scope: 'own' },
  ],
  /*
   * The capability ladder and the skill tracker: one profile per coachee, the shared assessment of
   * their current coaches. Not `own` for anybody — the coachee never reads it — and nothing for the
   * office layer, which never sits on the leader-only tab.
   */
  'coaching_profile:read': [
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-downline' },
  ],
  'coaching_profile:update': [
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-downline' },
  ],
  /*
   * **A note's owner is its author, not its subject** (ADR-0073): `own` is what the reader wrote,
   * `own-downline` what anybody below them wrote. The token alone cannot say *never the subject*,
   * so the reader rule is its own predicate, `CoachResolver.readsLeaderNote`, which tests the
   * subject before anything else. Never the Owner, the Admin or the Super Admin as such, and never
   * in a support session (`BLOCKED_WHILE_IMPERSONATING`, below).
   */
  'leader_notes:read': [
    { grantee: AB, scope: 'own' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own' },
    { grantee: AAB, scope: 'own-downline' },
  ],
  /** Written only by its author, about somebody they coach now: the `COACH` grant. */
  'leader_notes:write': [
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-downline' },
  ],

  /*
   * ---- Calendar (P12-T1, `roles-and-permissions.md` §3.15; `functional/calendar.md`, *The
   * permissions*). ----
   *
   * **On an entry, `own` is two per-entry grants**: an entry the reader organises, and — as §3.14's
   * co-editor is — an entry whose attendee list holds the reader. Neither is a hierarchy scope; the
   * calendar service narrows *theirs* to the organiser or to the list, route by route, and answers 404
   * outside it. Hence *attendee (`own`)* on the answer's row.
   *
   * **`own-downline` is `COACH`** (§1.3, ADR-0074): on the read, the compare read
   * (`GET /calendar/entries?for=`) and the compare list; on the block, *Block time*'s reach. Written as a
   * second grant beside `own`, as coaching's are: a wider token never silently includes the reader's own.
   * **An Agent compares and blocks nobody**, as an Agent coaches nobody.
   *
   * **`calendar_invitee:search` is the people picker** (D-picker, ADR-0094): the office's active field
   * members, in four fields — §2 rule 4's exception (a).
   *
   * **The Owner, the Admin and the Super Admin have no calendar** (ADR-0094): one who also stands on a
   * rung reads and writes as that member (§1.1). `read` and `search` are reads; `create`, `update`,
   * `delete`, `answer` and `block` are writes, refused to a read-only support session by their verb. None
   * is on `BLOCKED_WHILE_IMPERSONATING`: an elevated session writes as the member (§3.13).
   */
  'calendar_entry:read': [
    { grantee: AB, scope: 'own' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own' },
    { grantee: AAB, scope: 'own-downline' },
    { grantee: AGENT, scope: 'own' },
  ],
  'calendar_entry:create': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  'calendar_entry:update': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  'calendar_entry:delete': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  /** An invitee's own answer (ADR-0097): the attendee grant, at `own`. */
  'calendar_entry:answer': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  /** *Block time* on a member the leader coaches (ADR-0098): their own entry, placed on the member. */
  'calendar_entry:block': [
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-downline' },
  ],
  'calendar_invitee:search': [
    { grantee: AB, scope: 'own-kpm' },
    { grantee: AAB, scope: 'own-kpm' },
    { grantee: AGENT, scope: 'own-kpm' },
  ],

  /*
   * ---- 90-day activation and new hires (Phase 13, `roles-and-permissions.md` §3.8;
   * `functional/activation.md`, *The permissions*). ----
   *
   * **`own` is the hire's own activation; `own-downline` is `COACH`** (ADR-0074): a hire the reader
   * coaches now, at any depth, never themselves. Written as two grants, as coaching's are: a wider token
   * never silently includes the reader's own. **The Agent holds the downline grants** because an Agent
   * with a direct report is a leader (ADR-0087, OD-122) — `COACH` narrows it to nobody for one who leads
   * nobody. Outside the reach is 404, never 403.
   *
   * **The Owner, the Admin and the Super Admin have none** (D-owner): no prototype draws them an
   * activation screen, and one who also stands on a rung reads and writes as that member (§1.1).
   * `activation:read` and `new_hires:read_roster` are reads; every other is a write, refused to a
   * read-only support session by its verb. An elevated session writes as the member, both actors on the
   * audit row (§3.13) — **except graduation**, which is on `BLOCKED_WHILE_IMPERSONATING`: it is the hire's
   * own declaration (ADR-0100), and nobody makes it for them. A linked item is ticked by nobody — not a
   * grant but a link's liveness (`mayTickByHand`), so there is no `activation:auto_complete` here.
   */
  'activation:read': [
    { grantee: AB, scope: 'own' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own' },
    { grantee: AAB, scope: 'own-downline' },
    { grantee: AGENT, scope: 'own' },
    { grantee: AGENT, scope: 'own-downline' },
  ],
  /** The hire's own manual items, with their note and date; a leader's, on a hire they coach (OD-121). */
  'activation:update_manual_item': [
    { grantee: AB, scope: 'own' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own' },
    { grantee: AAB, scope: 'own-downline' },
    { grantee: AGENT, scope: 'own' },
    { grantee: AGENT, scope: 'own-downline' },
  ],
  /** A leader's correction of a hire's start date (OD-118). The hire's own is read-only. */
  'activation:set_start_date': [
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-downline' },
    { grantee: AGENT, scope: 'own-downline' },
  ],
  /** The hire's own *Mark activation complete →*, at 100% (OD-28). Nobody graduates anybody else. */
  'activation:graduate': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  /** *Your New Hires*: the open activations the reader reaches through `COACH` (OD-122, D-group). */
  'new_hires:read_roster': [
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-downline' },
    { grantee: AGENT, scope: 'own-downline' },
  ],
  /**
   * The detail's *Coaching note* (OD-117): one per hire, written by a leader who coaches them, **read by
   * the hire** on their own page. Not a Leader Note, which its subject never reads (ADR-0073), and not
   * read through `leader_notes:read`: it rides the activation the hire reads.
   */
  'activation_note:write': [
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-downline' },
    { grantee: AGENT, scope: 'own-downline' },
  ],
  /*
   * ***Mark left*** (P18.96-T6 AC-4; ADR-0173 §3, ADR-0169 §4 as amended): `POST /new-hires/:membershipId/left` records
   * that a new hire has left — `leftAt`, which decides their 3M activation — and removes them through the removal's own
   * path, so they leave every count of people; their history stays. Not `member:remove_from_team`'s rules: a leader
   * above the direct one may mark it, and a new hire who leads somebody is refused. **A leader's for the new hires they coach** (`COACH`, as
   * `new_hires:read_roster` lists them): an AB and an AAB. **The Owner and an Admin for the office's**, at `own-kpm` —
   * a fact about a membership, not the checklist ADR-0148 keeps them from changing. **Not an Agent who leads**, whose
   * roster shows the row without it, and not the Super Admin's. A write: a read-only support session is refused it, an
   * elevated one writes as its member with both actors audited (§3.13).
   */
  'new_hire:mark_left': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-downline' },
  ],

  /*
   * ---- Training progress (P18.5-T1, T4; roles §3.7; `functional/training.md`, *The permissions*). ----
   *
   * **The read is the Personal Summary's shape** (`personal_summary:read`): the reader's own at `own`, and with
   * `?for=` another member through `CoachResolver.subject` — the Owner's and the Admin's `own-kpm` the whole office
   * (leavers included), an AB's and an AAB's their COACH reach, as campaigns and the Unit Dashboard read it (the exit
   * review, 2026-10-10). An Agent's `own` reaches nobody else. The Super Admin's `all` reads nothing on its own: outside a support session there
   * is no office, and inside one the member's own grant answers. A read, so a read-only session holds it — and
   * opening an item (`POST …/open`) is under it, answered in a support session and recorded only under `update`.
   *
   * **The write is the learner's own, on every field rung** — the AB and the AAB learn too (the matrix's defect,
   * `Overall.html:4400`, `:7760`); the Owner and the Admin learn through the rung they stand on (ADR-0114). No
   * route takes a subject: nobody sets another person's status. On `BLOCKED_WHILE_IMPERSONATING`, below
   * (D-support): the status is the member's own declaration (OD-149), and the metric measures exactly that.
   * `training_progress:verify` is struck (OD-149): nothing verifies the member's word.
   */
  'training_progress:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
    { grantee: AGENT, scope: 'own' },
  ],
  'training_progress:update': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  /*
   * **The settings reads of the office's training** (P18.5-T1 AC-8, the leak): `GET /kpm/settings/training`, a
   * module's content there, and an item's signed address. They carry what agents are not offered — drafts, archived
   * rows, a draft module's files — and sat on `tenant_config:read`, which every member holds, so an agent could read
   * a draft module's material by asking the settings route. The Owner and the Admin, `own-kpm`: whoever writes the
   * office's settings reads them, as `product_settings:read` (Phase 14) is. The learner reads through
   * `training_progress:read`, which checks *offered* itself. The Super Admin's `all` mirrors `tenant_config:read`'s
   * and reads nothing on its own. A read by its verb, so a read-only session as an Owner keeps it.
   */
  'training_settings:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  /*
   * **The settings read of the office's activation checklist** (the Phase 18.5 exit review, permission review B2):
   * `GET /kpm/settings/activation-checklist`. It answers the office's **draft** checklist and names each training
   * link by the module's working title — a draft module's included — and it sat on `tenant_config:read`, which every
   * member holds. The Owner and the Admin, `own-kpm`, as `training_settings:read`; a field member reads their own
   * activation (`activation:read`), whose links are named from what the office offers. The Super Admin's `all`
   * reads nothing on its own. A read by its verb, so a read-only session as an Owner keeps it.
   */
  'activation_settings:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],

  /*
   * ---- The Unit Dashboard (Phase 15; roles §3.8, `functional/unit-dashboard.md`, *The permissions*). ----
   *
   * **The read is coaching's reach** (D-reach, ADR-0074, ADR-0087): a leader's unit is the leader and
   * everybody `CoachResolver.coacheesOf` answers, the whole downline on the current edges. `own` is the
   * reader's own row; `own-downline` everybody below them; written as two grants, as coaching's are. **The
   * Agent holds both** (decided at the exit review, as activation's grants are, OD-122): an Agent with a
   * direct report is a leader (ADR-0087), and `COACH` narrows the grant to nobody for one who leads nobody,
   * who is answered an empty unit, never a 403. The service reads the scope actually held
   * (`CoachResolver.unitOf`): `own` alone would be an empty unit, never a fallback to `COACH`. The
   * Owner and the Admin read any leader's unit in the office (`own-kpm`), through their field view. The
   * Super Admin's `all` is not access: the read resolves the office from the caller's membership, so one
   * reaches a unit only inside a support session, as its member. `org_tree:drill_to_unit_dashboard`
   * folds into this (roles §3.4): a link, not a permission.
   *
   * **The write is a correction of the office's figure** (OD-137, option 2; ADR-0121): the leader's
   * *Update production*, for the reader and the unit below them, and for the Owner and the Admin any
   * active member of the office. Not the Agent's, and not the Super Admin's. A write by its verb, so a
   * read-only support session reads the dashboard and is refused the save.
   */
  'unit_dashboard:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own' },
    { grantee: AAB, scope: 'own-downline' },
    { grantee: AGENT, scope: 'own' },
    { grantee: AGENT, scope: 'own-downline' },
  ],
  'unit_dashboard:update_production': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own' },
    { grantee: AAB, scope: 'own-downline' },
  ],

  /*
   * ---- The Owner's reporting (Phase 18; roles §3.9, `functional/kpm-analytics.md`, *The permissions*). ----
   *
   * **The office's console, the Owner's and the Admin's alike** (ADR-0028): the KPM Overview, its not-logged
   * list and the recruitment target's write, and KPM analytics — every figure over the office, `own-kpm`. No
   * field role holds the Overview: a leader's own reporting is the Unit Dashboard. KPM analytics is a Core
   * Leader's as well (below). The Super Admin's `all` on the
   * two reads is not access on its own: both resolve the office from the caller's membership, so one reads an
   * office only inside a support session, as its member, and is answered `TENANT_NO_MEMBERSHIP` outside one.
   * **The target is a write by its verb**: a read-only session reads the Overview and is refused it; an elevated
   * one writes it as its member, both actors on the audit row. Not the Super Admin's own.
   */
  'kpm_overview:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'kpm_overview:set_recruit_target': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  /*
   * **And a Core Leader's** (ADR-0159 §2, P18.8-T5 AC-4): AB and AAB hold it at `own-kpm`, which lets the request
   * through the guard, and **the reporting services answer `404 NOT_FOUND` to a leader who is not a Core Leader** —
   * tagged, on a leader rung, read on every request (`OfficePeople.requireAnalyticsReader`) — the forum's rule. A
   * Core Leader reads the whole office, read-only: no write in this module is granted to a field role. No Agent
   * holds it, since no Agent can be one.
   */
  'kpm_analytics:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-kpm' },
    { grantee: AAB, scope: 'own-kpm' },
  ],
  /*
   * *Cross-platform analytics* (P18-T8; OD-148 → option 1, D-admin): adoption across offices, inside ADR-0011's
   * line — composition, joiners, leavers and sign-ins, counted; no member, no business figure. **The Super
   * Admin's alone.** A support session acts as its member, whose context holds no platform grant, so it is
   * refused too.
   */
  'platform_analytics:read': [{ grantee: SUPER_ADMIN, scope: 'all' }],

  /*
   * ---- The Strategic Leader Forum (Phase 18.1; roles §3.14, `functional/leader-forum.md`). ----
   *
   * **The tag is the list** (D-coeditors, roles §1.4): the Owner and the Admins read and write every meeting of
   * the office whatever their tag; an AB, an AAB or an Agent holds `read`, `edit` and `share_link` here at
   * `own-kpm`, which lets the request through the guard, and **the forum's service answers `404 NOT_FOUND` to one
   * not tagged *Core Leader*** — on every route, the list included — because the tag is a fact of the membership
   * read on each request, not of the context, and a refusal must never confirm that a meeting exists.
   *
   * Making, moving and deleting a meeting are the Owner's and the Admins' alone (ADR-0130 §6). A shared link opens
   * for **every** member of the office, any rung, tagged or not (ADR-0131 §5); `read_shared_link` grants nothing
   * without a live link. The Super Admin's `all` on the two reads is not access on its own: every route resolves
   * the office from the caller's membership, so one reads a meeting only inside a support session, as its member,
   * and is answered `TENANT_NO_MEMBERSHIP` outside one. A read-only session reads by the verbs and writes nothing.
   * `manage_coeditors` is struck (D-coeditors), and `export_pdf` has no route: it inherits the two reads, which
   * answer `can.print`.
   */
  'leader_meeting:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-kpm' },
    { grantee: AAB, scope: 'own-kpm' },
    { grantee: AGENT, scope: 'own-kpm' },
  ],
  'leader_meeting:create': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'leader_meeting:reschedule': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'leader_meeting:delete': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'leader_meeting:edit': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-kpm' },
    { grantee: AAB, scope: 'own-kpm' },
    { grantee: AGENT, scope: 'own-kpm' },
  ],
  'leader_meeting:share_link': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-kpm' },
    { grantee: AAB, scope: 'own-kpm' },
    { grantee: AGENT, scope: 'own-kpm' },
  ],
  'leader_meeting:read_shared_link': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-kpm' },
    { grantee: AAB, scope: 'own-kpm' },
    { grantee: AGENT, scope: 'own-kpm' },
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
  /*
   * **+ Add agent** (ADR-0170 §1, P18.96-T3 AC-1): the one form — `POST /new-hires/agents` — and the invites it makes,
   * listed, resent and cancelled, and the transfer requests it asked for. An AB and an AAB for **their own unit**:
   * the person joins under them, and nobody else's unit is theirs to add to, nor anybody else's invite theirs to read.
   * The Owner and an Admin for the office: any active member's unit, named in the body. **Not the Agent's**, whose
   * code still lets anybody walk in. **Not the Super Admin's**, and not a setup session's (`SETUP_SESSION_WRITE_SCOPE`
   * names the office's settings, its import and its production file, never a person): a support session reaches the
   * office as its member, and a write by its verb is refused to a read-only one. Revived in P18.96-T3 after its
   * retirement in P3.6-T1, for a different thing — an invite to one named person, not a reusable code.
   */
  'member:invite': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-unit' },
    { grantee: AAB, scope: 'own-unit' },
  ],
  /*
   * **Deciding a transfer request** (ADR-0170 §4, P18.96-T3 AC-3): the office's queue, and approving — which moves the
   * member through `HierarchyService.reparent`, with history — or declining. The Owner's and an Admin's alone: no
   * leader moves a member directly, so the leader who asked never decides their own request.
   */
  'member:transfer_approve': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
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
  /*
   * **A leader past the office's limit waits for AgencyBoost** (ADR-0157). Asking — and cancelling an ask — is
   * held by whoever may make the write the limit refused: the Owner and an Admin office-wide, an AB and an AAB
   * over the people they act on, as `member:change_role` and `leader_request:approve` reach. The service asks
   * the same question the write would — may *this* reader change *this* member's rung, or let them in — so the
   * grant says who may ask at all, and never widens the act. A write by its verb: a read-only support session is
   * refused it, an elevated one asks in the member's name with both actors audited.
   */
  'leader_limit_request:create': [
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-unit' },
    { grantee: AAB, scope: 'own-unit' },
  ],
  /*
   * The office's requests: the Owner and an Admin read every one, an AB or AAB those they asked. The Super Admin
   * reads the platform's queue (`GET /admin/leader-limit-requests`), through the repository's named unscoped
   * methods. A read by its verb, so a read-only support session keeps it.
   */
  'leader_limit_request:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-unit' },
    { grantee: AAB, scope: 'own-unit' },
  ],
  /* Approving carries the act out past the limit; declining changes nothing. AgencyBoost's alone (ADR-0157 §3). */
  'leader_limit_request:decide': [{ grantee: SUPER_ADMIN, scope: 'all' }],

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
  /*
   * P9-T1. **Reading the month table is its own grant.** §3.9 listed eight `data_upload:*`
   * permissions — download, preview, commit, correct, revert, history, lock, reopen — and every one
   * is a write or a side-channel; nothing covered *look at the figures*. Reading under a write grant
   * would be one permission doing two jobs, and the day the two jobs need different holders it
   * cannot be split without touching every route. The other eight arrive with the tasks that raise
   * them, so a grant never exists in code before a route can use it.
   */
  'data_upload:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  // P9-T2. The file to fill in. Its own grant rather than `read`'s, as §3.9 has it: an office that
  // one day lets a leader see the table need not let them issue a file in the office's name.
  'data_upload:download_template': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  // P9-T3. Reading a filled file and saying what it would change. Writes nothing — committing is
  // `commit_import`, its own grant, which arrives with P9-T4.
  'data_upload:upload_and_preview': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  // P9-T4. Confirm import writes the month's figures; revert puts back what one import wrote; the
  // history lists what went through. The Owner and the Admin alike — attribution over a second person
  // (§3.9's note, ADR-0028).
  'data_upload:commit_import': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'data_upload:revert_batch': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'data_upload:read_history': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  // P9-T5. One figure by hand, with a reason, audited — and the only way a figure is cleared.
  'data_upload:correct_cell': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  // ADR-0050. Locking and reopening are acts on the month, each audited.
  'data_upload:lock_month': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  'data_upload:reopen_month': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  /*
   * **Events: the member's side** (P18.5-T5, P18.5-T6; roles §3.11 as OD-31 and OD-151 answered it).
   *
   * Every member reads the events whose audience holds them (`GET /events`, the audience resolved server-side as at
   * the event's start, ADR-0039); the Owner and the Admin read them in their field view **as the AB they are**
   * (ADR-0114), and RSVP, claim and answer through that rung's grant. The Super Admin's `all` reads nothing on its
   * own — outside a support session there is no office, and the read answers `TENANT_NO_MEMBERSHIP`.
   */
  'event:read_list': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-kpm' },
    { grantee: AAB, scope: 'own-kpm' },
    { grantee: AGENT, scope: 'own-kpm' },
  ],
  'event:rsvp': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  'event:cancel_rsvp': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  /*
   * *"I actually attended this event"* (`Overall.html:8732-8741`): the member's own word, which unlocks the feedback
   * form and **never makes `attended`** (OD-31, exit test 2). On `BLOCKED_WHILE_IMPERSONATING`, below, with the RSVP
   * pair above it.
   */
  'event_attendance:self_claim': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  /*
   * **The roll call** (OD-31, D-rollcall): the Owner and the Admins, and **nobody for their own row** — the service
   * refuses the caller's own membership `400 EVENT_ATTENDANCE_SELF`, so an Admin confirms the Owner. No leader: a
   * confirmation is a fact about the office's event, not a judgement about one's own downline, and a leader
   * confirming would let a unit inflate its own number. No designated host (OD-31's option 2, not taken).
   */
  'event_attendance:confirm': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  /* The member's answer, once. On `BLOCKED_WHILE_IMPERSONATING`, below: an opinion is the member's own. */
  'event_feedback:submit': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  /*
   * **The *Feedback Summary* is the office's administration's** (OD-151: names shown to the Owner and the Admins),
   * and a member reads their own answer — the AB and the AAB too, who answer like everybody (roles corrected,
   * P18.5-T6 AC-1). No leader reads another's: `own` reaches only the reader's own row on `GET /events`, and the
   * summary route refuses anything narrower than `own-kpm`.
   */
  'event_feedback:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  /*
   * **The settings reads of the office's events** (P18.5-T5 AC-2, the leak): `GET /kpm/settings/events` and the
   * picker's people. (The roll call's read is `event_attendance:confirm`'s, the write it serves.) The list carries leader-only events and invitee lists, which ADR-0039 keeps from
   * members, and it sat on `tenant_config:read`, which every member holds — so an agent could read who was invited
   * to a meeting they were not. As `product_settings:read` (the Phase 14 exit review): the Owner and the Admin; the
   * Super Admin's `all` reads only through a support session. A read by its verb, so a read-only session as the
   * Owner keeps it.
   */
  'event_settings:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  /*
   * **Campaigns: the member's side** (P18.5-T7, T8, T9; roles §3.11).
   *
   * `campaign:read_list` — the office's active campaigns and one campaign's dialog (`GET /campaigns`,
   * `GET /campaigns/:code`), every member; the Owner and the Admin in their field view (ADR-0114). The Super Admin's
   * `all` reads only inside a support session, as its member: outside one the read answers `TENANT_NO_MEMBERSHIP`.
   */
  'campaign:read_list': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-kpm' },
    { grantee: AAB, scope: 'own-kpm' },
    { grantee: AGENT, scope: 'own-kpm' },
  ],
  /*
   * *☆ Chase* / *⭐ Chasing* — the member's own enrolment (OD-153). The Owner and the Admin chase by the rung they hold.
   * **Refused in every support session**, read-only or elevated (`BLOCKED_WHILE_IMPERSONATING`, ADR-0143), which draws
   * no chase.
   */
  'campaign:chase': [
    { grantee: AB, scope: 'own' },
    { grantee: AAB, scope: 'own' },
    { grantee: AGENT, scope: 'own' },
  ],
  /*
   * **Whose chases and standings a reader sees** (P18.5-T9, `GET /campaigns/chasing?for=`; the 18.6 port): the
   * reader's own always, and as far as coaching reaches — an AB their downline, an AAB their unit read as the subtree
   * (roles §2 rule 2, ADR-0074), resolved through `CoachResolver`; the Owner and the Admin the office. 404 beyond it.
   * The Unit Dashboard serves chases inside this reach and no further (`unit-dashboard.service.ts`).
   */
  'campaign_qualification:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
    { grantee: AB, scope: 'own-downline' },
    { grantee: AAB, scope: 'own-unit' },
    { grantee: AGENT, scope: 'own' },
  ],
  /*
   * **The settings reads of the office's campaigns** (the phase file's *Found while preparing* 15, closed by P18.5-T7):
   * `GET /kpm/settings/campaigns` — archived campaigns and requirements outside the evaluable set included — and the
   * carrier rules beside it sat on `tenant_config:read`, which every member holds: the shape of the training and events
   * leaks. As `training_settings:read` and `event_settings:read`: the Owner and the Admin; the Super Admin's `all` reads
   * only through a support session. A member reads campaigns through `campaign:read_list`, which answers active ones.
   * A read by its verb, so a read-only session as the Owner keeps it.
   */
  'campaign_settings:read': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
  /*
   * **The override of a final standing** (P18.6-T2 AC-5; ADR-0144 §4, roles §3.11; D-override): `PUT` and `DELETE
   * /kpm/settings/campaigns/:code/standings/:membershipId/override`, a result set to *Achieved* or *Not achieved* with a
   * reason, and cleared with one. The Owner and the Admins, their own office (ADR-0028). The Super Admin's `all`
   * writes nothing on its own — outside a support session there is no office (`TENANT_NO_MEMBERSHIP`), and inside one
   * the member's own grant answers — so it reaches an override only in an **elevated** session, both actors on the
   * entry; a read-only session is refused by the verb (`override` is not read-like). No field rung holds it.
   */
  'campaign_qualification:override': [
    { grantee: SUPER_ADMIN, scope: 'all' },
    { grantee: KPM_OWNER, scope: 'own-kpm' },
    { grantee: KPM_ADMIN, scope: 'own-kpm' },
  ],
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
 * True when no tenant grantee but `KPM_OWNER` appears — since ADR-0028, granting and
 * revoking admin access and nothing else: a KPM Admin holds every other power the Owner
 * does. It lets a refusal say *which* wall was hit: an Admin denied one of these is not
 * missing a role, they are being told the Owner reserved it. Derived from the grant list
 * rather than a second list of "owner things", which would drift — Branch info and the
 * audit log export stopped being ones (ADR-0027, ADR-0028) without this function changing.
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
  // ADR-0112 §2: an office's subscription is the platform's, and its end cuts every member off.
  'kpm:update_subscription',
  'kpm_admin:grant',
  'kpm_admin:revoke',
  'notification_preference:manage',
  /*
   * ADR-0073, roles §3.13: a leader's candid note about a person is not support data. A session
   * acts as the user it impersonates, and a note read is refused inside one, read-only or elevated.
   */
  'leader_notes:read',
  /*
   * OD-108, option 1 (decided 2026-10-02): **the write as well.** A read-only session refuses it by
   * its verb already; an elevated one would hold it through the leader's `COACH` grant and could save
   * a note in the leader's name — a blank one included — over a note it may not read. A support
   * session neither reads nor writes a note: the operator reproduces a failing save on a test office.
   */
  'leader_notes:write',
  /*
   * ADR-0100 (the Phase 13 exit review, N4): **graduation is the hire's own declaration** — *I have done
   * all of it* — and an elevated session would make it in their name. A read-only one refuses it by its
   * verb already. The operator reproduces a failing graduation on a test office, as a note's save is.
   */
  'activation:graduate',
  /*
   * D-support (P18.5-T1 AC-1): **a training status is the member's own word** (OD-149) — *I have done this
   * module* — and an elevated session would declare it in their name; a read-only one refuses it by its verb
   * already. Opening an item in a session is answered and records nothing (`TrainingProgressService.open`).
   */
  'training_progress:update',
  /*
   * P18.5-T5, T6: **the member's own word about an event** — *Join event*, *Cancel RSVP*, *"I actually attended this
   * event"* and their score. A read-only session refuses all four by their verbs already; an elevated one would say
   * it in the member's name, and the roll call's *RSVP'd* / *Said they came* and the NPS measure exactly that word
   * (D-support's reasoning, ADR-0100's; the RSVP pair added at the phase's exit review).
   */
  'event:rsvp',
  'event:cancel_rsvp',
  'event_attendance:self_claim',
  'event_feedback:submit',
  /*
   * ADR-0143 (the Phase 18.5 permission review): **a chase is enrolment** — the member's own declaration that they
   * are taking part, which only a chaser's standing records. A read-only session refuses it by its verb already; an
   * elevated one would enrol the member in their name. The operator reproduces a failing chase on a test office.
   */
  'campaign:chase',
  /*
   * ADR-0162 §4: **the day's log is the member's own word**, and §3.5 above says no proxy writes it — *"not an
   * elevated impersonation session"*. The grant list said so and this list did not, so an elevated session held it
   * through the member's `own` grant. A read-only one, and a setup one, refuse it by its verb already.
   */
  'activity_log:create',
  /*
   * And **its correction** (the permission review of Phases 18.8 and 18.9, 2026-10-26): rewriting a frozen day is the
   * same word, the member's, and it moves the compliance tree and a campaign's evidence just as a first save does.
   */
  'activity_log:update',
];

const BLOCKED = new Set<string>(BLOCKED_WHILE_IMPERSONATING);

/**
 * **What a setup session may write, and nothing else** (ADR-0162 §2): the office's settings, its people
 * import and its production file — the setup screens' own permissions. Stored on the session row as
 * `writeScope` when one starts, so a session already running keeps the scope it was started with.
 *
 * `data_upload:*` is the whole of the data upload's grants, its reads included (they are reads anyway).
 * Nothing on `BLOCKED_WHILE_IMPERSONATING` is in it, and a test keeps it that way.
 */
export const SETUP_SESSION_WRITE_SCOPE: readonly Permission[] = Object.freeze([
  'tenant_config:write',
  'kpm:import_roster',
  ...(Object.keys(PERMISSIONS) as Permission[]).filter((p) => p.startsWith('data_upload:')),
]);

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
  /*
   * **A setup session is a read-only one with a scope** (ADR-0162 §2): a write whose permission the session row
   * names goes on to the ordinary question below — the scope lets a write through, it grants nothing the member
   * does not hold. Every other write is refused exactly as above.
   */
  if (ctx.impersonationReadOnly && !isReadLike(permission)
    && !ctx.impersonationWriteScope.includes(permission)) return false;

  return scopeFor(ctx, permission) !== null;
}

/** Actions that only read. Everything else is treated as a write. */
const READ_LIKE = /^(read|list|search|preview|view|export)/;

/**
 * Does this permission only read? By its own verb, a prefix of the short closed list above; anything
 * else — a permission with no verb at all included — is a write. Exported for `CoachResolver.subject`,
 * which resolves a write's subject more narrowly than a read's (a member who has left is history to
 * read, never somebody to write for).
 */
export function isReadLike(permission: Permission): boolean {
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
        // By class, not by rung code (ADR-0156 §3): the class is derived from the rung's
        // leader tier, so a rung a company named itself holds its tier's rights.
        ctx.membership!.hierarchyRole === grantee.roleClass
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
