/**
 * The Unit Dashboard (Phase 15; `functional/unit-dashboard.md`).
 *
 * **The reason a leader's *Update production* writes on every cell it changes** (OD-137, option 2;
 * ADR-0121). The dialog asks for no reason — the prototype draws none (`Overall.html:4679-4701`) — and
 * a correction of the office's figure carries one on every cell and in its audit entry (ADR-0042), so
 * the reason is this sentence, fixed. The month table, the next import's preview and the audit log
 * show it beside the leader's name, and it says where the figure came from.
 */
export const UNIT_DASHBOARD_CORRECTION_REASON = 'Updated on the Unit Dashboard from the company report.';

/** The read's periods and the write's bound (D-period, D-api). */
export const UNIT_DASHBOARD = {
  /** *Last 7 days · This month · This year* (`Overall.html:3895-3897`), in the order drawn. */
  PERIODS: ['7d', 'month', 'year'] as const,
  /** *This month* is first selected (`:3896`). */
  DEFAULT_PERIOD: 'month' as const,
  /**
   * The most rows one *Save all* may carry: the 500-member ceiling an office is measured at
   * (`performance-and-scale.md`), so a leader's whole roster always fits one save.
   */
  MAX_ROWS_PER_SAVE: 500,
  /**
   * **The three views** (the client's message of 11 November 2026, item 7; ADR-0249; `metrics-and-definitions.md`, *The
   * views*), in the order the picker draws them: *Grup langsung* (`DIRECT_GROUP`), *Grup informal* (`INFORMAL_GROUP`),
   * *Semua downline* (`DOWNLINE`). Defined in `domain/metrics/unit-view.ts`.
   */
  VIEWS: ['direct', 'informal', 'downline'] as const,
  /**
   * The most members one *+ Tambah ke grup* may tag at once (`POST /members/groups/:groupId/members`): the 500-member
   * ceiling an office is measured at, so every AB below a leader always fits one request.
   */
  MAX_TAGGED_PER_ADD: 500,
} as const;

export type UnitDashboardPeriod = (typeof UNIT_DASHBOARD.PERIODS)[number];
/** A view of the Unit Dashboard (ADR-0249): `direct`, `informal` or `downline`. */
export type UnitView = (typeof UNIT_DASHBOARD.VIEWS)[number];
