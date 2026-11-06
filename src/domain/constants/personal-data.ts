/**
 * What a person records about themselves (ADR-0158, P18.5-T4): a birth date, a gender, the month they
 * joined their insurer, and how they work in an office — and the shape of the agent code they are given.
 *
 * Documented once in `docs/00-product/metrics-and-definitions.md` and pinned by `personal-data.spec.ts`.
 * The frontend re-declares none of it: the registration screen and `/profile` send what was typed, and
 * show the server's sentence when it is refused.
 */
export const PERSONAL_DATA = {
  /**
   * **A person is at least this old** on the day they register or are imported (ADR-0158 §2): their date
   * of birth is this many years ago, or earlier, in the office's calendar. An agent contract is an adult's.
   */
  MIN_AGE_YEARS: 18,
} as const;

/** `users.gender` (ADR-0158 §1). The client's two, for its reporting; the screens say *Male* and *Female*. */
export const GENDERS = ['male', 'female'] as const;
export type Gender = (typeof GENDERS)[number];

/**
 * `memberships.workStatus` (ADR-0158 §1): how somebody works **in this office**. Not the membership's
 * `status` (active, pending, removed). The roster file writes them `full-time` and `part-time`; the
 * screens say *Full-time* and *Part-time*.
 */
export const WORK_STATUSES = ['full_time', 'part_time'] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

/**
 * **An agent code is digits, three to thirty-two of them** (ADR-0158 §4), on every new write:
 * registration, the roster import, an Owner created. A code already held keeps its letters — it is the
 * join key the production import matches on, and nothing rewrites one.
 */
export const AGENT_CODE_PATTERN = /^\d{3,32}$/;
