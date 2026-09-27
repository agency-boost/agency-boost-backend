/**
 * The monthly production upload (P9-T3, P9-T4).
 *
 * **Why a ceiling at all.** The file is read into memory and parsed in one request, so something has
 * to bound it — and the bound is generous on purpose. A row of the template is about a hundred bytes;
 * a megabyte is ten thousand agents, which is more than any office this product serves. A file that
 * size is not a bigger office, it is the wrong file.
 */
export const PRODUCTION_UPLOAD = {
  /** 1 MiB. Refused with `ASSET_TOO_LARGE` before a byte of it is parsed. */
  MAX_BYTES: 1024 * 1024,
  /**
   * How long an import may sit half-written before the next write to its month finishes it off.
   *
   * An import that fails in the middle puts back what it changed before it answers. One whose
   * process dies cannot, so the next commit or revert of that month does it — but only for an
   * import this old, so that it never undoes one another request is still writing (P9-T4 AC-7).
   */
  STRANDED_AFTER_MINUTES: 10,
} as const;

/** A month's production, once written (ADR-0050). */
export const PRODUCTION = {
  /**
   * Days after a month ends that it stays open to imports and corrections; after that it locks.
   *
   * The platform default, seeded into `kpms.settings.productionLockGraceDays` and the office's
   * thereafter. **The same number as `ACTIVITY.BACKDATE_GRACE_DAYS`**, as ADR-0050 decided — one
   * rule a reader learns once — and a test pins the two together, because importing that constant
   * here would make this module and the index import each other.
   */
  LOCK_GRACE_DAYS: 7,
} as const;
