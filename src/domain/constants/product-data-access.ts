/**
 * ***Kelola data produk*'s list and the premium table notices** (P19.15-T4; ADR-0260, ADR-0261;
 * `metrics-and-definitions.md` §B.41). Pinned by `product-data-access.spec.ts`.
 */
export const PRODUCT_DATA_CHANGES = Object.freeze({
  /** *Perubahan oleh pengelola*: changes one read answers, newest first, then *Muat lagi* — the audit log's fifty. */
  PAGE_SIZE: 50,
});

export const PREMIUM_TABLE_NOTICES = Object.freeze({
  /**
   * **Days before a premium table's *Berlaku sampai*** that the Super Admins are told it ends, when no newer version is
   * scheduled (the P1b spec's *Notifications*: *"15 days before a table's 'Berlaku sampai' date"*). Counted in office
   * days, `Asia/Jakarta`: a table ending 30 November is announced on the run of 15 November, and on any later run until
   * the notice is sent, up to and including its last day.
   */
  EXPIRY_NOTICE_DAYS: 15,
  /**
   * **When the daily run starts, office time** (`HH:mm`, `Asia/Jakarta`): ten minutes after 00:00, when a scheduled
   * version comes into force (P19.15-T1 AC-3), so its announcement names a version already in force. Written once more,
   * in `deploy/systemd/agencyboost-daily.timer`'s `OnCalendar=`, which a test compares with this.
   */
  DAILY_RUN_AT: '00:10',
});
