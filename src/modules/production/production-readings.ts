import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { MonthlyAgentDataRepository } from './monthly-agent-data.repository';

/** A production figure the office holds, and which writer it came from. */
export interface HeldFigure {
  minor: number;
  provenance: 'imported' | 'corrected';
  /** `YYYY-MM` — the month whose year-to-date figure this is. */
  month: string;
}

/**
 * **Production, as the rest of the product reads it** (P9-T6).
 *
 * Every surface outside `/kpm/data-upload` that needs a production figure asks here, so there is one
 * answer to *which figure, and from whom* — and it always comes back with its provenance, so the
 * surface can say where the number came from without a second request (AC-1).
 */
@Injectable()
export class ProductionReadings {
  constructor(private readonly data: MonthlyAgentDataRepository) {}

  /**
   * The APE somebody has produced so far in a year: the **latest month's year-to-date figure** the
   * office holds — as the carrier's file gave it, or as somebody corrected it by hand — or `null`
   * when there is none yet.
   *
   * The latest month *with a figure*: a month nobody has uploaded, or whose YTD was cleared by hand,
   * says nothing about the year, so the month before it answers.
   */
  async apeYearToDate(ctx: RequestContext, membershipId: string, year: string): Promise<HeldFigure | null> {
    if (!/^\d{4}$/.test(year)) return null;
    return this.apeYearToDateThrough(ctx, membershipId, `${year}-12`);
  }

  /**
   * The same, but **no later than `month`** (P10-T4): the year to date as it stood through last month,
   * which is what this month's APE target is taken from (ADR-0056). January has nothing before it.
   */
  async apeYearToDateThrough(ctx: RequestContext, membershipId: string, month: string): Promise<HeldFigure | null> {
    if (!/^\d{4}-\d{2}$/.test(month)) return null;
    const [row] = await this.data.find(
      ctx,
      { membershipId, month: { $gte: `${month.slice(0, 4)}-01`, $lte: month }, 'apeYtd.value': { $ne: null } },
      { sort: { month: -1 }, limit: 1 },
    );
    if (!row) return null;
    return {
      minor: row.apeYtd.value as number,
      provenance: row.apeYtd.provenance === 'corrected' ? 'corrected' : 'imported',
      month: row.month,
    };
  }

  /**
   * One month's own APE the office holds (P10-T4) — the Summary's *this month* — or `null` when the file
   * for it has not arrived, which is not zero (ADR-0050: a month's file lands after it ends).
   */
  async apeForMonth(ctx: RequestContext, membershipId: string, month: string): Promise<HeldFigure | null> {
    const row = await this.data.findOne(ctx, { membershipId, month, 'apeMonthly.value': { $ne: null } });
    if (!row) return null;
    return {
      minor: row.apeMonthly.value as number,
      provenance: row.apeMonthly.provenance === 'corrected' ? 'corrected' : 'imported',
      month: row.month,
    };
  }

  /**
   * **The three figures above, for many members at once** (P11-T6) — what a member's month stands on:
   * the year to date (`apeYearToDate`), the year to date through last month (`apeYearToDateThrough`) and
   * this month's own APE (`apeForMonth`), each by the same rule as its single-member reading.
   *
   * One query for the whole list, the year's rows at most twelve per member, so a roster of five hundred
   * costs one read rather than fifteen hundred. Every member asked about gets an entry, `null` where the
   * office holds nothing.
   */
  async standingsFor(
    ctx: RequestContext, membershipIds: readonly string[], month: string,
  ): Promise<Map<string, MonthStanding>> {
    const out = new Map<string, MonthStanding>(
      membershipIds.map((id) => [id, { yearToDate: null, throughLastMonth: null, thisMonth: null }]),
    );
    if (membershipIds.length === 0 || !/^\d{4}-\d{2}$/.test(month)) return out;

    const year = month.slice(0, 4);
    const monthNumber = Number(month.slice(5, 7));
    // January has nothing before it: its target is taken from no year to date (`ytdBeforeThisMonth`).
    const previous = monthNumber === 1 ? null : `${year}-${String(monthNumber - 1).padStart(2, '0')}`;
    const rows = await this.data.find(
      ctx,
      { membershipId: { $in: [...new Set(membershipIds)] }, month: { $gte: `${year}-01`, $lte: `${year}-12` } },
      { sort: { month: -1 }, projection: { membershipId: 1, month: 1, apeYtd: 1, apeMonthly: 1 } },
    );

    // Newest month first, so the first held figure a member meets is the latest one.
    for (const row of rows) {
      // Every row read is one of the members asked about: the query names no one else.
      const standing = out.get(row.membershipId) as MonthStanding;
      // Both cells are required with a default, so a hydrated row always has them (`cell()` in the schema).
      if (row.apeYtd.value !== null) {
        standing.yearToDate ??= heldOf(row.apeYtd, row.month);
        if (previous !== null && row.month <= previous) standing.throughLastMonth ??= heldOf(row.apeYtd, row.month);
      }
      if (row.month === month && row.apeMonthly.value !== null) {
        standing.thisMonth = heldOf(row.apeMonthly, row.month);
      }
    }
    return out;
  }
}

/** What a member's month stands on: the three held figures the Summary and the roster read. */
export interface MonthStanding {
  /** The latest year-to-date figure of the year (`apeYearToDate`). */
  yearToDate: HeldFigure | null;
  /** The latest year-to-date figure no later than last month (`apeYearToDateThrough`); `null` in January. */
  throughLastMonth: HeldFigure | null;
  /** This month's own APE (`apeForMonth`); `null` until the month's file arrives. */
  thisMonth: HeldFigure | null;
}

/** A stored figure, with the writer it came from. */
function heldOf(cell: { value: number | null; provenance: string | null }, month: string): HeldFigure {
  return {
    minor: cell.value as number,
    provenance: cell.provenance === 'corrected' ? 'corrected' : 'imported',
    month,
  };
}
