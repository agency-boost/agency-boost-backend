import { Injectable, Optional } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { AnalyticsConfigReader } from '@/modules/config/analytics-config.reader';
import type { AdvancedAnalyticsConfig } from '@/modules/config/analytics-config';
import { MonthlyAgentDataRepository, type KodeRow } from './monthly-agent-data.repository';
import type { MetricValue, Provenance } from './monthly-agent-data.schema';
import type { OfficialApe } from './official-ape';
import { fieldInForce } from './upload-columns';

/** A production figure the office holds, and which writer it came from. */
export interface HeldFigure {
  minor: number;
  provenance: 'imported' | 'corrected';
  /** `YYYY-MM` — the latest month the figure reads: the month itself, or a year to date's last month held. */
  month: string;
  /**
   * A correction's membership and moment — who put the figure there by hand, an Owner at the month table or a
   * leader on the Unit Dashboard (Phase 15, ADR-0121) — so every screen showing it can say who. `null` for
   * the file's own figure. A year to date that sums a corrected month names its latest correction.
   */
  correctedBy: string | null;
  correctedAt: Date | null;
}

/** The kodes the product's own readers read (R1, ADR-0214 §6): the four system columns and three older custom ones. */
const APE = 'APE';
const POLICY_COUNT = 'POLICY_COUNT';
const RECRUITMENT = 'RECRUITMENT';
const NEW_ACTIVE_AGENTS = 'NEW_ACTIVE_AGENTS';
const PERSISTENCY = 'PERSISTENCY';
const UNIT_PERSISTENCY = 'UNIT_PERSISTENCY';

/** `YYYY-MM`. */
const MONTH = /^\d{4}-\d{2}$/;
const januaryOf = (month: string) => `${month.slice(0, 4)}-01`;
const previousMonthInYear = (month: string): string | null => {
  const m = Number(month.slice(5, 7));
  return m === 1 ? null : `${month.slice(0, 4)}-${String(m - 1).padStart(2, '0')}`;
};

/**
 * **Production, as the rest of the product reads it** (P9-T6) — **by kode, with the year to date calculated** since
 * P19.5-T2 (ADR-0214 §6, §10).
 *
 * Every surface outside `/kpm/data-upload` that needs a production figure asks here, so there is one
 * answer to *which figure, and from whom* — and it always comes back with its provenance, so the
 * surface can say where the number came from without a second request (AC-1).
 *
 * - **Every figure reads the four system columns by kode** — `APE`, `POLICY_COUNT`, `RECRUITMENT`,
 *   `NEW_ACTIVE_AGENTS` (R1) — so a column the template renames keeps every reader.
 * - **A year to date is `COLUMN_YEAR_TO_DATE`**: the sum of the months held from January to the month, computed here
 *   and never stored (R4). The year to date a file used to carry is kept on the row as a check (`ytdValues`) and read
 *   by nothing here. A month missing from the sum makes it partial — *Belum lengkap* where a screen draws it — and it is
 *   still the figure (ADR-0214 §10).
 * - **The three older custom kodes** — `PERSISTENCY`, `UNIT_PERSISTENCY` — read nothing for a month the KPM's template
 *   holds no such column in force (ADR-0214 §6): never 0.
 */
@Injectable()
// The official APE's implementation (ADR-0195): since P19.5-T2 the Data upload from the template, behind the same port.
export class ProductionReadings implements OfficialApe {
  constructor(
    private readonly data: MonthlyAgentDataRepository,
    /** The KPM's template, read live (ADR-0214 §3), for the custom kodes. `@Optional` for the specs that build this by hand. */
    @Optional() private readonly analytics?: AnalyticsConfigReader,
  ) {}

  /**
   * The APE somebody has produced so far in a year — **the sum of the months the office holds** for them, January to
   * December, each as the file gave it or as somebody corrected it (R4) — or `null` when no month holds one.
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
    if (!MONTH.test(month)) return null;
    const rows = await this.data.findByKode(ctx, { membershipId, month: { $gte: januaryOf(month), $lte: month } }, [APE]);
    return sumHeld(rows.map((row) => ({ month: row.month, cell: row.values[APE] })));
  }

  /**
   * One month's own APE the office holds (P10-T4) — the Summary's *this month* — or `null` when the file
   * for it has not arrived, which is not zero (ADR-0050: a month's file lands after it ends).
   */
  async apeForMonth(ctx: RequestContext, membershipId: string, month: string): Promise<HeldFigure | null> {
    const [row] = await this.data.findByKode(ctx, { membershipId, month }, [APE]);
    const cell = row?.values[APE] ?? null;
    return cell && cell.value !== null ? heldOf(cell, month) : null;
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
    const ledgers = await this.ledgersFor(ctx, membershipIds, month);
    return new Map([...ledgers].map(([id, ledger]) => [id, ledger.standing]));
  }

  /**
   * **`standingsFor`, with the month's two APE cells and who corrected the figures it reads** (Phase 15,
   * D-figures, P15-T3): from **the same one query**, so the Unit Dashboard reads production once for its
   * goal cells and its production cells alike. `standingsFor` is this, with the standing alone.
   *
   * The month's cell is read as the month table reads it (`readCell`); its year to date is the sum through the month
   * (`sumCell`) — corrected when a month in it was, naming the latest correction; `null` is not zero.
   */
  async ledgersFor(
    ctx: RequestContext, membershipIds: readonly string[], month: string,
  ): Promise<Map<string, MonthLedger>> {
    const out = new Map<string, MonthLedger>(membershipIds.map((id) => [id, {
      standing: { yearToDate: null, throughLastMonth: null, thisMonth: null },
      thisMonthCells: { monthly: readCell(undefined), ytd: readCell(undefined) },
    }]));
    if (membershipIds.length === 0 || !MONTH.test(month)) return out;

    const year = month.slice(0, 4);
    const previous = previousMonthInYear(month);
    const rows = await this.data.findByKode(
      ctx,
      { membershipId: { $in: [...new Set(membershipIds)] }, month: { $gte: `${year}-01`, $lte: `${year}-12` } },
      [APE],
    );
    const months = new Map<string, { month: string; cell: MetricValue | null }[]>();
    for (const row of rows) months.set(row.membershipId, [...(months.get(row.membershipId) ?? []), { month: row.month, cell: row.values[APE] }]);

    for (const [id, ledger] of out) {
      const held = months.get(id) ?? [];
      ledger.standing.yearToDate = sumHeld(held);
      ledger.standing.throughLastMonth = previous === null ? null : sumHeld(held.filter((m) => m.month <= previous));
      const own = held.find((m) => m.month === month)?.cell ?? null;
      if (own && own.value !== null) ledger.standing.thisMonth = heldOf(own, month);
      if (held.some((m) => m.month === month)) {
        ledger.thisMonthCells = { monthly: readCell(own), ytd: sumCell(held.filter((m) => m.month <= month)) };
      }
    }
    return out;
  }

  /**
   * **The months the production file shows a policy for each member** (P18.8-T4 AC-1; ADR-0171 §1): every month row
   * whose `POLICY_COUNT` is above zero — as imported, or as corrected by hand — with its id and the count, oldest
   * first. What a first sale *from the monthly file* and the file's closings read. One query for the whole list, on
   * the `(kpmId, membershipId, month)` index; every member asked about gets an entry.
   */
  async policyMonthsOfMany(
    ctx: RequestContext, membershipIds: readonly string[],
  ): Promise<Map<string, { month: string; id: string; policies: number }[]>> {
    const ids = [...new Set(membershipIds)];
    const out = new Map<string, { month: string; id: string; policies: number }[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) return out;
    const rows = await this.data.find(
      ctx,
      { membershipId: { $in: ids }, [`values.${POLICY_COUNT}.value`]: { $gt: 0 } },
      { sort: { month: 1 }, projection: { membershipId: 1, month: 1, [`values.${POLICY_COUNT}`]: 1 } },
    );
    for (const row of rows) {
      const policies = (row.values?.[POLICY_COUNT]?.value ?? 0) as number;
      out.get(row.membershipId)!.push({ month: row.month, id: String(row._id), policies });
    }
    return out;
  }

  /**
   * **Each member's monthly cells over a range of months, for many members at once** (Phase 18, D-period,
   * D-moc): `MAA_COUNT_IN_UNIT` for the period's month, `MONTHLY2_AA` over the last two months held, and the
   * latest rolling persistency a leader's row holds. One query for the whole list, the range's rows at most;
   * every member asked about gets an entry, a month absent where the office holds no row for it.
   */
  async monthCellsFor(
    ctx: RequestContext, membershipIds: readonly string[], range: { from: string; to: string },
  ): Promise<Map<string, Map<string, MonthCells>>> {
    const out = new Map<string, Map<string, MonthCells>>(membershipIds.map((id) => [id, new Map()]));
    if (membershipIds.length === 0) return out;
    const [rows, config] = await Promise.all([
      this.data.findByKode(
        ctx,
        { membershipId: { $in: [...new Set(membershipIds)] }, month: { $gte: range.from, $lte: range.to } },
        MONTH_CELL_KODES,
      ),
      this.config(ctx),
    ]);
    for (const row of rows) {
      (out.get(row.membershipId) as Map<string, MonthCells>).set(row.month, monthCellsOf(row, config));
    }
    return out;
  }

  /**
   * **`monthCellsFor`'s cells, and each member's year to date through any month of the range — from one read** (the
   * forum's scorecard at 500 members, 2026-10-28): one query for the whole list, the range's rows at most, read lean
   * (`MonthlyAgentDataRepository.findByKode`); every member asked about gets an entry, a month absent where the office
   * holds no row for it.
   *
   * **`apeYearToDateThrough(ids, month)`** answers each of those members what the single-member
   * `apeYearToDateThrough` answers: **the sum of the APE held from the month's January to it** — as imported or
   * corrected, `null` where none is (R4). It refuses a month whose January the range does not reach, or past its end,
   * and a member not read: each would answer a figure short of months it never read.
   *
   * **`standingsFor(ids, month)`** answers each of them what `standingsFor` (`ledgersFor`'s standing) answers for the
   * month — the year's sum, the sum through last month and the month's own APE, each a held figure with whoever
   * corrected it. `ledgersFor` reads the month's whole year, so this refuses a month whose January or December the
   * range does not reach, and a member not read.
   */
  async monthCellsAndYearToDateFor(
    ctx: RequestContext, membershipIds: readonly string[], range: { from: string; to: string },
  ): Promise<MonthCellsAndYearToDate> {
    const ids = [...new Set(membershipIds)];
    const cells = new Map<string, Map<string, MonthCells>>(membershipIds.map((id) => [id, new Map()]));
    // Each member's months holding their own APE: a cell emptied by hand, or never given, holds none.
    const ownApe = new Map<string, { month: string; cell: MetricValue | null }[]>(ids.map((id) => [id, []]));
    const [rows, config] = ids.length === 0 ? [[], null] : await Promise.all([
      this.data.findByKode(ctx, { membershipId: { $in: ids }, month: { $gte: range.from, $lte: range.to } }, MONTH_CELL_KODES),
      this.config(ctx),
    ]);
    for (const row of rows) {
      // Every row read is one of the members asked about: the query names no one else.
      (cells.get(row.membershipId) as Map<string, MonthCells>).set(row.month, monthCellsOf(row, config));
      (ownApe.get(row.membershipId) as { month: string; cell: MetricValue | null }[]).push({ month: row.month, cell: row.values[APE] });
    }
    const apeYearToDateThrough = (forIds: readonly string[], month: string): Map<string, HeldFigure | null> => {
      const january = januaryOf(month);
      if (!MONTH.test(month) || january < range.from || month > range.to) {
        throw new Error(`The year to date through ${month} reads ${january} to ${month}; ${range.from} to ${range.to} was read.`);
      }
      const out = new Map<string, HeldFigure | null>();
      for (const id of forIds) {
        const months = ownApe.get(id);
        if (!months) throw new Error(`The year to date of ${id}, whose months were not read.`);
        out.set(id, sumHeld(months.filter((m) => m.month >= january && m.month <= month)));
      }
      return out;
    };
    const standingsFor = (forIds: readonly string[], month: string): Map<string, MonthStanding> => {
      const year = month.slice(0, 4);
      if (!MONTH.test(month) || `${year}-01` < range.from || `${year}-12` > range.to) {
        throw new Error(`A standing at ${month} reads ${year}-01 to ${year}-12; ${range.from} to ${range.to} was read.`);
      }
      // `ledgersFor`'s three, by its rules: the year's sum, the sum through last month — none in January — and the
      // month's own APE where it is held.
      const previous = previousMonthInYear(month);
      const yearToDate = apeYearToDateThrough(forIds, `${year}-12`);
      const throughLastMonth = previous === null ? null : apeYearToDateThrough(forIds, previous);
      return new Map(forIds.map((id) => {
        // A member not read was refused by `apeYearToDateThrough` above.
        const own = (ownApe.get(id) as { month: string; cell: MetricValue | null }[]).find((m) => m.month === month)?.cell ?? null;
        return [id, {
          yearToDate: yearToDate.get(id) as HeldFigure | null,
          throughLastMonth: throughLastMonth === null ? null : throughLastMonth.get(id) as HeldFigure | null,
          thisMonth: own === null || own.value === null ? null : heldOf(own, month),
        }];
      }));
    };
    return { cells, apeYearToDateThrough, standingsFor };
  }

  /**
   * **Every cell a campaign requirement reads, for many members over a range of months** (Phase 18.2, P18.2-T8;
   * D-evaluable): the month's own APE, persistency, new active agents and recruitment count, the policy count
   * `MONTHLY_ACTIVE_AGENT` reads beside APE, and the year to date of the three a calendar year sums — each month's
   * cell **as the month table reads it** (`readCell`), so a campaign's figure is the table's figure for the same
   * months, imported or corrected (exit test 1). **A year to date is the sum of the months held from January**
   * (R4; P19.5-T2), so the read reaches back to the range's first January. One query for the whole list; every member
   * asked about gets an entry, a month absent where the office holds no row of theirs.
   */
  async campaignFiguresFor(
    ctx: RequestContext, membershipIds: readonly string[], range: { from: string; to: string },
  ): Promise<Map<string, Map<string, CampaignMonthFigures>>> {
    const out = new Map<string, Map<string, CampaignMonthFigures>>(membershipIds.map((id) => [id, new Map()]));
    if (membershipIds.length === 0) return out;
    const [rows, config] = await Promise.all([
      this.data.findByKode(
        ctx,
        { membershipId: { $in: [...new Set(membershipIds)] }, month: { $gte: januaryOf(range.from), $lte: range.to } },
        [APE, PERSISTENCY, NEW_ACTIVE_AGENTS, RECRUITMENT, POLICY_COUNT],
        [],
        { month: 1 },
      ),
      this.config(ctx),
    ]);
    // Running sums by member and year, oldest month first.
    const running = new Map<string, { year: string; ape: number | null; naa: number | null; rec: number | null }>();
    const add = (sum: number | null, v: number | null) => (v === null ? sum : (sum ?? 0) + v);
    for (const row of rows) {
      const year = row.month.slice(0, 4);
      const was = running.get(row.membershipId);
      const sums = was && was.year === year ? was : { year, ape: null, naa: null, rec: null };
      const ape = readCell(row.values[APE]).value;
      const naa = readCell(row.values[NEW_ACTIVE_AGENTS]).value;
      const rec = readCell(row.values[RECRUITMENT]).value;
      sums.ape = add(sums.ape, ape);
      sums.naa = add(sums.naa, naa);
      sums.rec = add(sums.rec, rec);
      running.set(row.membershipId, sums);
      if (row.month < range.from) continue;
      (out.get(row.membershipId) as Map<string, CampaignMonthFigures>).set(row.month, {
        apeMonthly: ape,
        apeYtd: sums.ape,
        persistencyMonthly: custom(config, PERSISTENCY, row),
        newActiveAgentsMonthly: naa,
        newActiveAgentsYtd: sums.naa,
        recruitmentMonthly: rec,
        recruitmentYtd: sums.rec,
        policyCountMonthly: readCell(row.values[POLICY_COUNT]).value,
      });
    }
    return out;
  }

  /**
   * **The office's file, month by month, over a range** (Phase 18, D-figures, T2 AC-6): each month's APE —
   * the sum of every figure the office holds for it, a member who has since left included (OD-74: their
   * production stays the office's) — and whether the month is held at all. One aggregate over the office's
   * rows for the range, on the `(kpmId, month, deletedAt)` index; a month with no row is absent.
   *
   * *Since P19.3-T1* (ADR-0200 §5, §7; the data sources' D2 and D8): **each month's recruitment**, the upload's
   * `RECRUITMENT` summed the same way — `null` where no row holds one — and **the moment the month's rows were last
   * written**, by an import or a correction, which a *this month* figure names (*"per 3 Nov"*). *Since P19.5-T2* (D8,
   * ADR-0214 §11): **its *as of* day**, the latest a running month's upload named — what *per <tanggal>* reads first.
   */
  async officeMonths(ctx: RequestContext, range: { from: string; to: string }): Promise<Map<string, OfficeMonth>> {
    const held = (path: string) => ({ $sum: { $cond: [{ $ne: [{ $ifNull: [path, null] }, null] }, 1, 0] } });
    const rows = await this.data.aggregate(ctx, [
      { $match: { month: { $gte: range.from, $lte: range.to } } },
      {
        $group: {
          _id: '$month',
          ape: { $sum: { $ifNull: [`$values.${APE}.value`, 0] } },
          apeHeld: held(`$values.${APE}.value`),
          // The year to date a file carried before P19.5-T2, kept on the row as a check: a month that holds one is held.
          ytdHeld: held(`$ytdValues.${APE}.value`),
          recruitment: { $sum: { $ifNull: [`$values.${RECRUITMENT}.value`, 0] } },
          recruitmentHeld: held(`$values.${RECRUITMENT}.value`),
          writtenAt: { $max: '$updatedAt' },
          asOf: { $max: '$asOf' },
        },
      },
    ]);
    return new Map(rows.map((row) => [String(row._id), {
      apeMonthlyMinor: (row.apeHeld as number) > 0 ? (row.ape as number) : null,
      held: (row.apeHeld as number) + (row.ytdHeld as number) > 0,
      recruitmentMonthly: (row.recruitmentHeld as number) > 0 ? (row.recruitment as number) : null,
      writtenAt: row.writtenAt instanceof Date ? row.writtenAt : null,
      asOf: typeof row.asOf === 'string' ? row.asOf : null,
    }]));
  }

  /** The KPM's configuration, for the custom kodes; `null` where this was built without the reader (every column in force). */
  private async config(ctx: RequestContext): Promise<AdvancedAnalyticsConfig | null> {
    return this.analytics && ctx.kpmId ? (await this.analytics.publishedFor(ctx)).config : null;
  }
}

/** The kodes `MonthCells` reads. */
const MONTH_CELL_KODES = [APE, POLICY_COUNT, PERSISTENCY, UNIT_PERSISTENCY];

/**
 * **A custom kode's month figure**, or `null` where the KPM's template holds no such column in force that month
 * (ADR-0214 §6): archived, never added, or before its start. Without a configuration every column is in force.
 */
function custom(config: AdvancedAnalyticsConfig | null, kode: string, row: KodeRow): number | null {
  if (config && !fieldInForce(config, kode, row.month)) return null;
  return readCell(row.values[kode]).value;
}

/**
 * A member's month, as the Owner's reporting reads it (Phase 18): the monthly cells `MONTHLY_ACTIVE_AGENT` and MOC's
 * persistency read, each as the month table reads it — `null` is nothing held, never zero. *Since P19.3-T1* (ADR-0201
 * §3): MOC's persistency reads a leader's `unitPersistencyMonthly`, the upload's `UNIT_PERSISTENCY`, where it read the
 * leader's own `persistencyMonthly`; that cell stays, a member's own rolling persistency.
 */
export interface MonthCells {
  apeMonthly: number | null;
  policyCountMonthly: number | null;
  persistencyMonthly: number | null;
  /** `UNIT_PERSISTENCY`: the insurer's persistency for this leader's unit, as uploaded on their row; `null` where none is. */
  unitPersistencyMonthly: number | null;
}

/** A row's cells `MonthCells` reads, by kode, each as the month table reads it (`readCell`). */
function monthCellsOf(row: KodeRow, config: AdvancedAnalyticsConfig | null): MonthCells {
  return {
    apeMonthly: readCell(row.values[APE]).value,
    policyCountMonthly: readCell(row.values[POLICY_COUNT]).value,
    persistencyMonthly: custom(config, PERSISTENCY, row),
    unitPersistencyMonthly: custom(config, UNIT_PERSISTENCY, row),
  };
}

/** What `monthCellsAndYearToDateFor` answers: the members' cells over the range, and their year to date through a month of it. */
export interface MonthCellsAndYearToDate {
  /** Each member's cells month by month, as `monthCellsFor` answers them. */
  cells: Map<string, Map<string, MonthCells>>;
  /** Each member's APE summed from `month`'s January to it, as `apeYearToDateThrough`; `null` where none is held. */
  apeYearToDateThrough(membershipIds: readonly string[], month: string): Map<string, HeldFigure | null>;
  /** Each member's standing at `month`, as `standingsFor` (`ledgersFor`'s standing); the range must hold the month's whole year. */
  standingsFor(membershipIds: readonly string[], month: string): Map<string, MonthStanding>;
}

/**
 * A member's month as a campaign reads it (Phase 18.2): each cell as the month table reads it — `null` is nothing held.
 * A `…Ytd` is the sum of the months held from January to this one (R4, P19.5-T2), `null` where none holds one.
 */
export interface CampaignMonthFigures {
  apeMonthly: number | null;
  apeYtd: number | null;
  persistencyMonthly: number | null;
  newActiveAgentsMonthly: number | null;
  newActiveAgentsYtd: number | null;
  recruitmentMonthly: number | null;
  recruitmentYtd: number | null;
  /** What `MONTHLY_ACTIVE_AGENT` reads beside the month's APE, for a Direct Unit's active agents. */
  policyCountMonthly: number | null;
}

/** One month of the office's file, summed: what *Monthly production* draws, and whether the month is held at all. */
export interface OfficeMonth {
  /** The office's APE for the month from its file — the sum of the figures held; `null` when none is. */
  apeMonthlyMinor: number | null;
  /** The office holds a file for the month: at least one APE figure, the month's own or its year to date. */
  held: boolean;
  /**
   * The office's recruitment for the month from its file (D2, P19.3-T1): the upload's `RECRUITMENT` summed over its rows,
   * a leaver's included — `null` when no row holds one.
   */
  recruitmentMonthly: number | null;
  /** When the month's rows were last written — an import, a correction — or `null` for rows that carry no stamp (D8, P19.3-T1). */
  writtenAt: Date | null;
  /** D8 (P19.5-T2): the office day a running month's latest upload stands at, `YYYY-MM-DD`; `null` for a final one. */
  asOf: string | null;
}

/** One cell of the month table, as every reader of it reads it (P9-T6). */
export interface ReadCell {
  /** `null` is nothing held — *Not uploaded yet* — never zero. */
  value: number | null;
  provenance: Provenance | null;
  /** A correction's membership and moment; `null` for every other cell. */
  correctedBy: string | null;
  correctedAt: Date | null;
  reason: string | null;
}

/**
 * **A stored cell as the month table reads it** (P9-T6 AC-1): nothing held and nobody decided it is empty,
 * whatever the row says; a figure emptied **by hand** keeps `corrected` and who did it, with a `null`
 * value — nothing is held, and the table can say who decided that. `ProductionService.readMonth` and the
 * Unit Dashboard read every cell through here, so the two cannot answer differently (exit criterion 2).
 */
export function readCell(stored: MetricValue | null | undefined): ReadCell {
  const corrected = stored?.provenance === 'corrected';
  if (!stored || (stored.value === null && !corrected)) {
    return { value: null, provenance: null, correctedBy: null, correctedAt: null, reason: null };
  }
  return {
    value: stored.value,
    provenance: stored.provenance,
    correctedBy: corrected ? stored.correctedBy ?? null : null,
    correctedAt: corrected ? stored.correctedAt ?? null : null,
    reason: corrected ? stored.reason ?? null : null,
  };
}

/** What a member's month stands on, with the month's two APE cells. */
export interface MonthLedger {
  standing: MonthStanding;
  /** This month's own APE, as the month table reads it, and its year to date — the sum through the month (R4). */
  thisMonthCells: { monthly: ReadCell; ytd: ReadCell };
}

/** What a member's month stands on: the three held figures the Summary and the roster read. */
export interface MonthStanding {
  /** The year's year to date: the sum of its months held (`apeYearToDate`). */
  yearToDate: HeldFigure | null;
  /** The year to date through last month (`apeYearToDateThrough`); `null` in January. */
  throughLastMonth: HeldFigure | null;
  /** This month's own APE (`apeForMonth`); `null` until the month's file arrives. */
  thisMonth: HeldFigure | null;
}

/**
 * **`COLUMN_YEAR_TO_DATE`, as a held figure** (R4; ADR-0214 §10): the months' own figures added, each as the month
 * table reads it — `null` where no month holds one, which is not zero. Corrected when any month in it was, naming the
 * latest correction; its `month` is the latest month held.
 */
export function sumHeld(months: readonly { month: string; cell: MetricValue | null | undefined }[]): HeldFigure | null {
  let total: number | null = null;
  let latest: string | null = null;
  let correction: MetricValue | null = null;
  for (const { month, cell } of months) {
    if (!cell || cell.value === null) continue;
    total = (total ?? 0) + cell.value;
    if (latest === null || month > latest) latest = month;
    if (cell.provenance === 'corrected' && (correction === null || (cell.correctedAt?.getTime() ?? 0) >= (correction.correctedAt?.getTime() ?? 0))) {
      correction = cell;
    }
  }
  if (total === null || latest === null) return null;
  return {
    minor: total,
    provenance: correction ? 'corrected' : 'imported',
    month: latest,
    correctedBy: correction?.correctedBy ?? null,
    correctedAt: correction?.correctedAt ?? null,
  };
}

/** The same sum, as the month table reads a cell (`readCell`): what a ledger's year-to-date cell is. */
export function sumCell(months: readonly { month: string; cell: MetricValue | null | undefined }[]): ReadCell {
  const held = sumHeld(months);
  if (!held) return readCell(undefined);
  return {
    value: held.minor,
    provenance: held.provenance,
    correctedBy: held.correctedBy,
    correctedAt: held.correctedAt,
    reason: held.provenance === 'corrected'
      ? (months.find((m) => m.cell?.provenance === 'corrected' && m.cell.correctedBy === held.correctedBy)?.cell?.reason ?? null)
      : null,
  };
}

/** A stored figure, with the writer it came from — and who corrected it, for a correction. */
function heldOf(cell: MetricValue, month: string): HeldFigure {
  const corrected = cell.provenance === 'corrected';
  return {
    minor: cell.value as number,
    provenance: corrected ? 'corrected' : 'imported',
    month,
    correctedBy: corrected ? cell.correctedBy ?? null : null,
    correctedAt: corrected ? cell.correctedAt ?? null : null,
  };
}
