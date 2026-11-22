/**
 * **The KPM report's numbers** (P19.24-T1, T2; [ADR-0280](../../../../docs/04-adr/0280-the-kpm-report-is-one-pdf-built-on-the-server-from-the-pages-own-readings.md);
 * the Super Admin spec of 20 November 2026 §4 and §11; `metrics-and-definitions.md` §B.46). Every value is pinned by
 * `kpm-report.spec.ts`. The colour scale is the console's (`CONSOLE.SCALE`), never re-declared here (invariant §7).
 */
export const KPM_REPORT = {
  /**
   * **The months a report may be made for**: the KPM's month and this many before it (thirteen in all). A later month
   * is refused (`400 VALIDATION_FAILED`), as is an earlier one — the pages it reads keep no older month to read.
   */
  MONTHS_BACK: 12,
  /**
   * **The smallest text the file sets, in points** (§11: *"smallest text 12px"*): 12 CSS pixels at 96 dpi on A4, which
   * is 9 pt. Every size the layout uses is at least this; `kpm-report.layout.spec.ts` reads every fragment back.
   */
  MIN_TEXT_PT: 9,
  /**
   * **AB group columns in one *Ringkasan tindakan* table**: more AB groups than this and
   * the table is drawn again below, the *Tindakan* column repeated, so no column falls off an A4 page.
   */
  ACTION_COLUMNS_PER_TABLE: 6,
  /** **Events per *Kehadiran per orang* table**: more events in the month and the table repeats with the next ones. */
  EVENT_COLUMNS_PER_TABLE: 5,
  /**
   * ***7+ masalah di Analisa kualitatif*** (the template's *Ringkasan tindakan*): a person whose latest qualitative
   * answers hold at least this many items with a problem (`QUAL_PERSON_ISSUE_ITEMS`, the *Per orang* tab's *n item*).
   */
  QUAL_MANY_ISSUES: 7,
  /** *3 tindakan minggu ini* names, per action, the AB groups with the most people — at most this many. */
  TOP_GROUPS_PER_ACTION: 2,
  /**
   * **How long a *Kirim ke owner* link opens the report** (OD-428; ADR-0280 §5): days from the moment it is made. Every
   * open is audited; it opens only for the KPM's Owner or a KPM Admin, signed in, never in a view-as session.
   */
  LINK_TTL_DAYS: 7,
  /** How many shared-link opens one account may make an hour: a shared meeting link's limit. */
  LINK_OPENS_PER_HOUR: 30,
  /** **At most this many reports built at once** in one process; the others wait (the proposal's 512 MB container). */
  CONCURRENCY: 2,
} as const;
