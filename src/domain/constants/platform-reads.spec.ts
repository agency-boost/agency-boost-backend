import {
  KPM_COMPARISON_SORTS, PLATFORM_ACCOUNT_KPM_FILTERS, PLATFORM_MEMBER_ROLES, PLATFORM_MEMBER_STATUSES, PLATFORM_READ,
} from './index';

/** `metrics-and-definitions.md` §B.35 (P19.4-T3; ADR-0207): each value pinned, so a drift fails here first. */
describe('P19.4-T3 the platform reads’ constants (§B.35)', () => {
  it('P19.4-T3 AC-1 a page is fifty rows; a search two characters; Data bulanan twelve months', () => {
    expect(PLATFORM_READ.PAGE_SIZE).toBe(50);
    expect(PLATFORM_READ.SEARCH_MIN_LENGTH).toBe(2);
    expect(PLATFORM_READ.DATA_MONTHS).toBe(12);
  });

  it('P19.4-T3 AC-16 the purposes and the actions ADR-0207 §5 and §6 name', () => {
    expect(PLATFORM_READ.PURPOSE).toEqual({
      members: 'Platform support: finding a member’s office',
      figures: 'Platform account management: how each KPM uses AgencyBoost',
      // P19.12-T2 AC-1 (ADR-0245 §1): *Akun terdaftar*.
      accounts: 'Platform support: finding a registered account',
    });
    expect(Object.values(PLATFORM_READ.ACTION)).toEqual([
      'platform_read.members', 'platform_read.kpm_comparison', 'platform_read.kpm_analytics', 'platform_read.kpm_data',
      'platform_read.company_kpms',
      // P19.5-T3 AC-12 (ADR-0215 §9): the *Advanced analytics* tab, audited per visit.
      'platform_read.kpm_advanced_analytics',
      // P19.12-T2 AC-1 (ADR-0245 §1): *Akun terdaftar*, audited per read.
      'platform_read.accounts',
    ]);
  });

  it('P19.4-T3 AC-1 the filters and the sorts', () => {
    expect(PLATFORM_MEMBER_ROLES).toEqual(['ab', 'aab', 'agent']);
    expect(PLATFORM_MEMBER_STATUSES).toEqual(['active', 'pending', 'removed']);
    expect(KPM_COMPARISON_SORTS).toEqual([
      'kpm', 'company', 'members', 'activeThisMonth', 'activeUsers', 'coached7d', 'coached30d', 'production', 'recruitment',
    ]);
  });

  it('P19.12-T2 AC-1 Akun terdaftar’s KPM filter: Tanpa KPM and Punya KPM', () => {
    expect(PLATFORM_ACCOUNT_KPM_FILTERS).toEqual(['none', 'some']);
  });
});
