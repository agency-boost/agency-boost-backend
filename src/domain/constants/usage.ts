/**
 * **Pemakaian AgencyBoost — the usage of the app, per person** (`revisions/2026-11-19/DATA-DEFINITIONS.md`, *Activity
 * and ratios*; ADR-0267 §4; `metrics-and-definitions.md` §A.20 and §B.42). Every value is pinned by `usage.spec.ts`.
 *
 * **Fixed**, not an office setting: *Pakai 14 hari terakhir* and *Power user ★* are read the same way on every page and
 * in every KPM. Advanced analytics' sub-group template keeps its own `powerUserDays` and `powerUserWindow`, which start
 * from these two (`SUBGROUP`, ADR-0215 §7) and an office may change there only.
 */
export const USAGE = {
  /**
   * *Pakai 14 hari terakhir* / *≤ 14 hari*: the latest day logged is **at most this many days** before the office's
   * today — today counting 0, so 15 dates, as `COACHED_7D`'s `≤ 7` spans 8. More than this is *> 14 hari*.
   */
  RECENT_MAX_DAYS: 14,
  /** *Power user ★*: activity logged on at least this many days … */
  POWER_USER_MIN_DAYS: 10,
  /** … of the last this many days, the office's today included (`rollingWindow`). */
  POWER_USER_WINDOW_DAYS: 30,
} as const;

/**
 * A person's usage bucket, in the order the pages draw it: *Belum pernah* (never logged), *> 14 hari*, *≤ 14 hari*.
 * Codes, never the words: a page writes them in its reader's language.
 */
export const USAGE_STATUSES = ['never', 'lapsed', 'recent'] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];
