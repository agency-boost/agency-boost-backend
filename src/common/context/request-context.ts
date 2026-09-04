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
}

export class RequestContext {
  constructor(
    readonly userId: string,
    readonly platformRole: PlatformRole,
    /** Absent for a brand-new agent who has not joined a KPM yet. That is valid, not an error. */
    readonly membership: TenantMembership | null,
    /** Set only inside an impersonation session — the real actor behind the effective one. */
    readonly impersonatorUserId: string | null = null,
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
    return this.membership?.kpmId ?? null;
  }

  get membershipId(): string | null {
    return this.membership?.membershipId ?? null;
  }

  /** Leader-ness is derived from the hierarchy, never stored as a role. */
  get isLeader(): boolean {
    const role = this.membership?.hierarchyRole;
    return role === 'ab' || role === 'aab';
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
    });
  }
}
