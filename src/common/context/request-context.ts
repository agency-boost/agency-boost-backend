/**
 * Everything authorization needs, resolved once per request and immutable thereafter.
 *
 * Roles are NOT carried in the access token: they are resolved per request so that
 * revoking a KPM Admin grant takes effect immediately rather than at the next token
 * refresh. See docs/02-specs/api/auth-and-sessions.md.
 */

export type HierarchyRole = 'ab' | 'aab' | 'agent';
export type PlatformRole = 'super_admin' | 'none';

export interface TenantMembership {
  readonly membershipId: string;
  readonly kpmId: string;
  readonly hierarchyRole: HierarchyRole;
  readonly status: 'active' | 'pending' | 'removed';
  readonly isKpmOwner: boolean;
  readonly isKpmAdmin: boolean;
  /**
   * Active direct reports. Carried because leadership is a graph property, not a role
   * (OD-23) — an AAB with no reports leads nobody, and every surface gated on
   * leadership is asking about people you actually lead.
   */
  readonly directCount: number;
}

export class RequestContext {
  constructor(
    readonly userId: string,
    readonly platformRole: PlatformRole,
    /** Absent for a brand-new agent who has not joined a KPM yet. That is valid, not an error. */
    readonly membership: TenantMembership | null,
    /** Set only inside an impersonation session — the real actor behind the effective one. */
    readonly impersonatorUserId: string | null = null,
    /**
     * The office a Super Admin is acting inside, when they belong to none.
     *
     * Provisioning writes into a tenant the actor is not a member of, and the tenant
     * repository needs a `kpmId`. Naming the office here is honest about what is
     * happening; fabricating a membership would attribute the write to a member who
     * does not exist.
     */
    private readonly actingInKpmId: string | null = null,
    /**
     * They are signed in on a password somebody else chose for them.
     *
     * Set on an account created by the roster import (P3.6-T4): the admin was handed a
     * generated password to pass on, so until it is replaced, the person holding this
     * session is not demonstrably the person the account belongs to.
     *
     * `AuthGuard` refuses everything but the handful of routes that let them fix it. The
     * flag lives on the context rather than being re-read per route because the guard
     * already resolves the user on every request — the check costs nothing.
     */
    readonly mustChangePassword: boolean = false,
  ) {
    Object.freeze(this);
  }

  get isSuperAdmin(): boolean {
    return this.platformRole === 'super_admin';
  }

  get isImpersonating(): boolean {
    return this.impersonatorUserId !== null;
  }

  /** The tenant this request operates in, or null for a platform-level or unjoined request. */
  get kpmId(): string | null {
    return this.membership?.kpmId ?? this.actingInKpmId;
  }

  get membershipId(): string | null {
    return this.membership?.membershipId ?? null;
  }

  /**
   * Leader-ness is derived from the hierarchy, never from the role (OD-23).
   *
   * The prototype infers it both ways and they disagree for an AAB with no direct
   * reports, who renders no unit block despite holding the role. The graph is the
   * answer that makes the unit dashboard, the coaching roster and the list of people an
   * approval can be routed to agree with one another.
   *
   * A promotion to AAB does not by itself make someone a leader; their first direct
   * report does, and losing their last one ends it.
   */
  get isLeader(): boolean {
    return (this.membership?.directCount ?? 0) > 0;
  }

  /**
   * The actor recorded in the audit log. Under impersonation both are recorded —
   * `actorUserId` is the real Super Admin, `effectiveUserId` is who they acted as.
   */
  get auditActors(): { actorUserId: string; effectiveUserId: string } {
    return {
      actorUserId: this.impersonatorUserId ?? this.userId,
      effectiveUserId: this.userId,
    };
  }

  /** A context for platform-level work with no tenant. Super Admin only. */
  static platform(userId: string): RequestContext {
    return new RequestContext(userId, 'super_admin', null);
  }

  /** A context for a background job operating on one tenant explicitly. */
  static forJob(kpmId: string, jobName: string): RequestContext {
    return new RequestContext(`job:${jobName}`, 'none', {
      membershipId: `job:${jobName}`,
      kpmId,
      hierarchyRole: 'agent',
      status: 'active',
      isKpmOwner: false,
      isKpmAdmin: false,
      directCount: 0,
    });
  }

  /**
   * A Super Admin acting inside one office, named explicitly.
   *
   * Provisioning writes into a tenant the actor does not belong to — assigning an owner
   * creates that owner's membership. The tenant repository needs a `kpmId` and a Super
   * Admin has none, so the office is named here rather than the write being let out
   * through an unscoped path.
   *
   * `userId` is kept, not replaced with a job label, so the history row still says who
   * did it. `membershipId` stays null: they are not a member, and pretending otherwise
   * would attribute the change to a membership that does not exist.
   */
  static superAdminInTenant(userId: string, kpmId: string): RequestContext {
    return new RequestContext(userId, 'super_admin', null, null, kpmId);
  }

  /**
   * Somebody writing themselves into an office they have not joined yet.
   *
   * The join flow has the same shape as Super Admin provisioning — a write into a tenant
   * the actor is not yet a member of — and until 2026-09-06 it borrowed
   * `superAdminInTenant` for it. That was wrong twice.
   *
   * It claimed `platformRole: 'super_admin'` for an ordinary newcomer. Nothing reads
   * platform role off these contexts today (the repository wants only a `kpmId`, and the
   * guard runs on the real request context, never this one), so it opened no hole — but
   * "the newcomer is a Super Admin for this write" is one refactor away from being one,
   * and it is not the sentence anybody meant to write.
   *
   * The live defect was the second one: it took a bare `userId` and dropped
   * `impersonatorUserId` with it. A Super Admin redeeming an invite on somebody's behalf
   * was audited as the newcomer acting alone. This carries the whole context through, so
   * `auditActors` still answers *who really did this*.
   */
  static joiningTenant(ctx: RequestContext, kpmId: string): RequestContext {
    return new RequestContext(ctx.userId, 'none', null, ctx.impersonatorUserId, kpmId);
  }

  /**
   * A read against one office by somebody outside it, and possibly nobody at all.
   *
   * The invite preview is unauthenticated — it is what a joiner sees before committing —
   * so there is no user to name. It used to pass the literal string `'invite-preview'`
   * as a userId, which reads like an account. A job label says what it is.
   */
  static tenantRead(kpmId: string, reason: string): RequestContext {
    return new RequestContext(`job:${reason}`, 'none', null, null, kpmId);
  }
}
