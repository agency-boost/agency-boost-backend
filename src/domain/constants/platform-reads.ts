/**
 * **The Super Admin's reads across KPMs** (ADR-0207; P19.4-T3; `metrics-and-definitions.md` §B.35): the page size, the
 * fixed purposes each read records, and the audit actions. One source, pinned by `platform-reads.spec.ts`.
 */
export const PLATFORM_READ = {
  /** Rows a page of *All members* and of the KPM comparison (ADR-0207 §2: *50 a page*). */
  PAGE_SIZE: 50,
  /** The shortest search *All members* takes: one letter would match most of the platform. */
  SEARCH_MIN_LENGTH: 2,
  /** The months *Data bulanan* and *Ringkasan*'s grid show, ending with the KPM's current month (A2). */
  DATA_MONTHS: 12,
  /**
   * **The purpose recorded on every entry** (ADR-0207 §6): fixed per read, never typed — these reads are the console's
   * routine work, not a support case. English, as the log's own words are.
   */
  PURPOSE: {
    members: 'Platform support: finding a member’s office',
    figures: 'Platform account management: how each KPM uses AgencyBoost',
  },
  /** The audit actions, one per read (ADR-0207 §5). */
  ACTION: {
    members: 'platform_read.members',
    kpmComparison: 'platform_read.kpm_comparison',
    kpmAnalytics: 'platform_read.kpm_analytics',
    kpmData: 'platform_read.kpm_data',
    companyKpms: 'platform_read.company_kpms',
    /** P19.5-T3 (ADR-0215 §9): *Lihat sebagai KPM*'s *Advanced analytics* tab, each visit. */
    kpmAdvancedAnalytics: 'platform_read.kpm_advanced_analytics',
  },
} as const;

/** *All members*' role filter: a class of the ladder, as every company's rungs are classed (ADR-0156). */
export const PLATFORM_MEMBER_ROLES = ['ab', 'aab', 'agent'] as const;
export type PlatformMemberRole = (typeof PLATFORM_MEMBER_ROLES)[number];

/** *All members*' status filter (SA R1): a membership's own status. */
export const PLATFORM_MEMBER_STATUSES = ['active', 'pending', 'removed'] as const;
export type PlatformMemberStatus = (typeof PLATFORM_MEMBER_STATUSES)[number];

/** The KPM comparison's sortable columns (ADR-0207 §7): a column, ascending; `-` before it, descending. */
export const KPM_COMPARISON_SORTS = [
  'kpm', 'company', 'members', 'activeThisMonth', 'activeUsers', 'coached7d', 'coached30d', 'production', 'recruitment',
] as const;
export type KpmComparisonSort = (typeof KPM_COMPARISON_SORTS)[number];
