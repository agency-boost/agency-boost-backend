/**
 * **The Super Admin console's numbers** (P19.23-T1, T2; ADR-0277; the Super Admin spec of 20 November 2026 §3 and §5;
 * `metrics-and-definitions.md` §B.45). Every value is pinned by `console.spec.ts`; the app reads them from
 * `GET /admin/dashboard` (`scale`), never re-declaring them (invariant §7).
 */
export const CONSOLE = {
  /**
   * **The colour scale, everywhere in the console** (spec §3: *"green ≥ 80%, yellow 50–79%, red < 50%"*): a percentage
   * at or above `GREEN_FROM_PCT` is green, at or above `YELLOW_FROM_PCT` yellow, anything lower red. Whole percentages,
   * rounded half up before they are compared.
   */
  SCALE: { GREEN_FROM_PCT: 80, YELLOW_FROM_PCT: 50 },
  /** *Anggota*'s card on a KPM's page (spec §5: *"first 5 + Lihat semua"*): how many members it lists. */
  LANDING_MEMBERS: 5,
  /** How many KPMs the dashboard reads at once: each is a few tenant-scoped reads of its own. */
  CONCURRENCY: 4,
} as const;

/**
 * **What needs action on a KPM** (P19.23-T1 AC-3, T2 AC-1; ADR-0277 §2), in the order a KPM card names the first it has:
 * a state the Super Admin already set (`suspended`, `archived`) is shown and is not *Perlu tindakan*; the other four are.
 * Codes, never words: the page writes them in its reader's language.
 */
export const KPM_ISSUES = [
  'suspended', 'archived', 'subscription_ended', 'owner_not_invited', 'no_members', 'data_missing',
] as const;
export type KpmIssue = (typeof KPM_ISSUES)[number];

/** The issues that are *Perlu tindakan*: counted on the KPM list's tile and listed on the dashboard, one row each. */
export const KPM_ACTION_ISSUES: readonly KpmIssue[] = ['subscription_ended', 'owner_not_invited', 'no_members', 'data_missing'];
