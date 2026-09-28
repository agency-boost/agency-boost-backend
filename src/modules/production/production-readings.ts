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
}
