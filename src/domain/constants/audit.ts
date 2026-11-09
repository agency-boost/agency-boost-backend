/**
 * **The audit log's pages** (UI-132 and its Appendix D row; the phase file's *Decisions* 4). How much one read of
 * `GET /admin/audit` answers, and when repeated rows read as one.
 *
 * Documented once in `docs/00-product/metrics-and-definitions.md` §B.32 and pinned by `audit.spec.ts`. Read by
 * `modules/audit/audit-read.service.ts`, which pages, filters and groups the log on the server; the screen draws the
 * count and asks for the next page with the cursor the read returned, and holds neither number itself.
 */
export const AUDIT_LOG = Object.freeze({
  /**
   * **Groups one read answers**, a single row being a group of one (UI-132: *"first 50 entries, then Muat lagi"*). A
   * page ends after its fiftieth group closes, so no group is split across two pages, and the next page starts after
   * that group's oldest row.
   */
  PAGE_SIZE: 50,
  /**
   * **Minutes: the longest a group spans**, from its newest row to its oldest, **inclusive** — a row exactly ten
   * minutes older than the group's newest still joins it (UI-132: *"consecutive identical actions by the same actor
   * on the same target within 10 minutes grouped with a count pill"*).
   */
  GROUP_WINDOW_MINUTES: 10,
});
