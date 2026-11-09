import type { RequestContext } from '@/common/context/request-context';
import type {
  HeldFigure, MonthCellsAndYearToDate, MonthLedger, MonthStanding, OfficeMonth,
} from './production-readings';

/**
 * **The official APE: the one port through which the product reads what a member produced** (ADR-0195; P19.1-T4
 * AC-13, the 6 November handover's UI-157 items 5 and 6).
 *
 * *Official* is the office's production file — imported, or corrected by hand at the month table or on the Unit
 * Dashboard — and nothing else. **A member's own estimate is not here and never will be**: it is the figure typed on
 * Goal Settings or the Summary (*perkiraan Anda*, `goals.apeAchievedMinor`, provenance `self_reported`), stored on the
 * member's plan apart from the office's monthly rows, read by the member's own screens and by nobody else's.
 *
 * Every reader of a goal's figures asks here — the Summary, Goal Settings, the Unit Dashboard, the coaching roster's
 * status, the KPM Overview and Analytics, the forum's scorecard and the 7-day targets — so that when Phase 19.5 moves
 * the source of the official figure (the Data upload from the company's template), it provides another implementation
 * of this class and no screen and no service changes. `ProductionReadings` is the implementation today
 * (`app.module.ts`: `{ provide: OfficialApe, useExisting: ProductionReadings }`); its other reads — a campaign's cells,
 * a first sale's policies — are not APE a goal is measured against, and stay on it.
 *
 * Each method answers as `ProductionReadings` documents it: `null` is *nothing held*, never zero.
 */
export abstract class OfficialApe {
  /** The latest year-to-date figure the office holds for the member's year, or `null`. */
  abstract apeYearToDate(ctx: RequestContext, membershipId: string, year: string): Promise<HeldFigure | null>;

  /** The same, no later than `month` — the year to date through last month a month's target is taken from (ADR-0056). */
  abstract apeYearToDateThrough(ctx: RequestContext, membershipId: string, month: string): Promise<HeldFigure | null>;

  /** One month's own APE, or `null` until the month's file arrives. */
  abstract apeForMonth(ctx: RequestContext, membershipId: string, month: string): Promise<HeldFigure | null>;

  /** Many members' standings at a month — the year to date, through last month and this month's own — with the month's two APE cells. */
  abstract ledgersFor(ctx: RequestContext, membershipIds: readonly string[], month: string): Promise<Map<string, MonthLedger>>;

  /** `ledgersFor`'s standings alone. */
  abstract standingsFor(ctx: RequestContext, membershipIds: readonly string[], month: string): Promise<Map<string, MonthStanding>>;

  /** The members' month cells over a range and their year to date through any month of it, from one read. */
  abstract monthCellsAndYearToDateFor(
    ctx: RequestContext, membershipIds: readonly string[], range: { from: string; to: string },
  ): Promise<MonthCellsAndYearToDate>;

  /** The office's file summed month by month over a range, and whether each month is held. */
  abstract officeMonths(ctx: RequestContext, range: { from: string; to: string }): Promise<Map<string, OfficeMonth>>;
}
