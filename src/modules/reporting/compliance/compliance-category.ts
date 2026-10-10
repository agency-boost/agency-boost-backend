import type { RequestContext } from '@/common/context/request-context';
import type { LocalDate } from '@/common/time/local-day';
import type { SubjectReadSurface } from '@/modules/audit/subject-read-audit';
import type { Office } from '@/modules/tenants/tenant-day.service';

/** The six categories, in the prototype's order (`KPM_Owner.html:3013-3020`). */
export const COMPLIANCE_CATEGORIES = ['training', 'goals', 'activity', 'activation', 'events', 'campaigns'] as const;
export type ComplianceCategoryKey = (typeof COMPLIANCE_CATEGORIES)[number];

/** The categories with one item only: an `item` on them is refused 400. */
export const SINGLE_ITEM_CATEGORIES: readonly ComplianceCategoryKey[] = ['goals', 'activity', 'activation'];

/**
 * What every category reads over: the office's day, D-window's year, and the tree's members — active on the office's
 * day and placed by `partitionAgencies` (an unplaced member is in no row and no chip, D-units).
 */
export interface ComplianceScope {
  ctx: RequestContext;
  office: Office;
  today: LocalDate;
  /** D-window: this calendar year in the office's zone, as office days and as instants. */
  year: { from: LocalDate; to: LocalDate; start: Date; end: Date };
  /** The tree's members, placed and active. */
  memberIds: readonly string[];
}

/** A chip's *"{count} / {of}"* (D-chips): done over those it applies to; `of: 0` draws *—*. */
export interface ComplianceChip {
  count: number;
  of: number;
}

/** A standing's override as the tree's cell shows it (D-override). */
export interface ComplianceOverride {
  status: 'qualified' | 'not_met';
  reason: string;
  by: { membershipId: string; name: string };
  /** ISO instant. */
  at: string;
}

/**
 * One member's cell for the selected item. Codes, never words: the screen holds the prototype's labels.
 *
 * - `status`: the first column's code, `null` → the neutral *—* (out of every *done / of*).
 * - `done`: whether the row counts as done; `null` when the item does not apply to them.
 * - `on`: the office day the date column shows, or `null`.
 * - `second`: the second column's code (events: feedback; campaigns: achieved), `null` → *—*.
 */
export interface ComplianceCell {
  status: string | null;
  done: boolean | null;
  on: LocalDate | null;
  second?: string | null;
  /** Activation (OD-159): an expired activation's last day, for the accessible name and tooltip. */
  endedOn?: LocalDate | null;
  /** Campaigns: the override on a stored final standing, `null` without one. */
  override?: ComplianceOverride | null;
  /** Campaigns: the standing is stored and final, so the *Achieved* cell may open the override dialog. */
  overridable?: boolean;
}

/** What one category answers on every read: its catalog, its chip, and — when selected — the item's cells. */
export interface ComplianceCategoryRead<Catalog> {
  catalog: Catalog;
  chip: ComplianceChip;
  /** The item resolved: the one asked, or the prototype's default; `null` for a single-item category. */
  item: string | null;
  /** Keyed by membership id; `null` unless this category is selected. */
  cells: Map<string, ComplianceCell> | null;
  /**
   * *Added by BE-tree (P18.6-T1 AC-9, D-audit-tree), additive*: what the selected category's cells disclose under
   * roles §3.5 — the surface, and each member whose record they carry with the first day disclosed (`null`: the whole
   * record). **Absent when nothing is disclosed** — goals, events, campaigns, the chips, and a category not selected.
   * The service writes it, once, after the answer exists; a category never writes an entry.
   */
  disclosure?: { surface: SubjectReadSurface; subjects: readonly { membershipId: string; from: LocalDate | null }[] };
}

/**
 * **One category of the Owner's compliance tree** (P18.6-T1, T2). Each reads its facts through the owning module's
 * bulk port — a fixed number of queries for any number of members, none per member — and throws `NotFoundException`
 * for an `item` the office does not list (another office's, archived, outside D-window).
 */
export interface ComplianceCategory<Catalog> {
  read(scope: ComplianceScope, selection: { selected: boolean; item: string | null }): Promise<ComplianceCategoryRead<Catalog>>;
}
