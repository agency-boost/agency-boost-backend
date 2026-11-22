/**
 * **Informal groups and the monthly targets per AB group** (P19.17-T4; ADR-0270; `metrics-and-definitions.md` §A.19,
 * *AB group targets*). One source for every bound (invariant §7); the frontend reads them from the API, never re-declares.
 */
export const INFORMAL_GROUPS = {
  /** The longest group name, as `groups.name` stores it. */
  NAME_MAX: 80,
  /**
   * The most ABs one *+ Tambah ke grup* may move at once (`POST /members/groups/:groupId/members`): the 500-member
   * ceiling an office is measured at (`performance-and-scale.md`), `UNIT_DASHBOARD.MAX_TAGGED_PER_ADD`'s.
   */
  MAX_PER_ADD: 500,
} as const;

/**
 * **`abGroupTargets`** — *Target Active Agent per bulan* and *Target Rekrut per bulan*, one pair per AB group per month
 * (ADR-0270 §4).
 */
export const AB_GROUP_TARGETS = {
  /** The largest target the −/+ steppers and the API take, for an AB group of any size. */
  MAX: 999,
  /** The first month a target may be set for: the first month the production upload is required (Jan 2024). */
  EARLIEST_MONTH: '2024-01',
  /** How far ahead of the office's month a target may be set: the year ahead. */
  MONTHS_AHEAD: 12,
  /** The APE target of a month is the year's Goal Setting divided by this. */
  MONTHS_PER_YEAR: 12,
} as const;
