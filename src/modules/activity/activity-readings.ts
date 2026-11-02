import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import type { LocalDate } from '@/common/time/local-day';
import { ActivityCategoryRepository, ActivityTypeRepository } from '@/modules/config/activity.repository';
import { ActivityLogRepository } from './activity-log.repository';

/**
 * **Activity, as the rest of the product reads it** (P10-T9) — the seam `ProductionReadings` is for
 * production. A module outside this one that needs a member's counts asks here, rather than reading
 * `activityLogs` on its own terms.
 */
@Injectable()
export class ActivityReadings {
  constructor(
    private readonly logs: ActivityLogRepository,
    private readonly categories: ActivityCategoryRepository,
    private readonly types: ActivityTypeRepository,
  ) {}

  /**
   * Every code's count over a member's stored days in a window, **archived types included** — the
   * ratio engine's rule: archiving a type does not erase what was logged against it.
   */
  async countsOver(
    ctx: RequestContext, membershipId: string, window: { from: LocalDate; to: LocalDate },
  ): Promise<Map<string, number>> {
    const rows = await this.logs.find(ctx, {
      membershipId, localDate: { $gte: window.from, $lte: window.to },
    });
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const entry of row.entries) {
        counts.set(entry.activityTypeCode, (counts.get(entry.activityTypeCode) ?? 0) + entry.count);
      }
    }
    return counts;
  }

  /**
   * **`countsOver` for many members at once** (P11-T6): the same counts, archived types included, summed
   * in one aggregate for the whole list — a roster of five hundred costs one query rather than five
   * hundred. A member with no day in the window is absent from the map, as an empty `countsOver` is empty.
   */
  async countsOverMany(
    ctx: RequestContext, membershipIds: readonly string[], window: { from: LocalDate; to: LocalDate },
  ): Promise<Map<string, Map<string, number>>> {
    const out = new Map<string, Map<string, number>>();
    if (membershipIds.length === 0) return out;
    const rows = await this.logs.aggregate(ctx, [
      {
        $match: {
          membershipId: { $in: [...new Set(membershipIds)] },
          localDate: { $gte: window.from, $lte: window.to },
        },
      },
      { $unwind: '$entries' },
      {
        $group: {
          _id: { membershipId: '$membershipId', code: '$entries.activityTypeCode' },
          count: { $sum: '$entries.count' },
        },
      },
    ]);
    for (const row of rows) {
      const { membershipId, code } = row._id as { membershipId: string; code: string };
      const counts = out.get(membershipId) ?? new Map<string, number>();
      counts.set(code, row.count as number);
      out.set(membershipId, counts);
    }
    return out;
  }

  /**
   * **Each person's activity count on each of a few days, for many people at once** (UI V1, Phase 18.99 T9: UI-059's
   * *Hari ini* pill on the Group Tree, O-5; and UI-101's *Kmrn* / *Hari ini* on Home's team list, D-22) — the day's
   * `totalCount`, the number Activity Management saves and shows for that day, so the pill and the log never disagree.
   *
   * - **`days` are office days** (`YYYY-MM-DD` in the office's zone, invariant §9): the caller resolves *today* and
   *   *yesterday* through `TenantDay`, never the server's clock.
   * - **A day with no row is absent** from a person's map, and a person with no row on any of the days is absent from
   *   the answer: *not reported*. A saved all-zero day is present, with 0 (ADR-0042: it says *nothing happened*); a
   *   screen that draws both as *Belum lapor* decides that itself.
   * - **One query for the whole list**, within the office (the repository adds `kpmId`), on the
   *   `(kpmId, localDate, membershipId)` index; a deleted day is never read.
   */
  async perPersonPerDay(
    ctx: RequestContext, membershipIds: readonly string[], days: readonly LocalDate[],
  ): Promise<Map<string, Map<LocalDate, number>>> {
    const out = new Map<string, Map<LocalDate, number>>();
    if (membershipIds.length === 0 || days.length === 0) return out;
    const rows = await this.logs.find(
      ctx,
      { membershipId: { $in: [...new Set(membershipIds)] }, localDate: { $in: [...new Set(days)] } },
      { projection: { membershipId: 1, localDate: 1, totalCount: 1 } },
    );
    for (const row of rows) {
      const byDay = out.get(row.membershipId) ?? new Map<LocalDate, number>();
      byDay.set(row.localDate, row.totalCount ?? 0);
      out.set(row.membershipId, byDay);
    }
    return out;
  }

  /**
   * **The days each member logged above zero, from a day on, for many members at once** (P13-T3 AC-4,
   * AC-7): what an activation's `feature:activity` item reads its four weeks from. An all-zero saved day
   * is not among them (ADR-0042: it says *nothing happened*), and a corrected day reads as corrected. One
   * query for the whole list, within the office, oldest first.
   */
  async activeDaysOfMany(
    ctx: RequestContext, membershipIds: readonly string[], from: LocalDate,
  ): Promise<Map<string, { date: LocalDate; id: string; byMembershipId: string }[]>> {
    const out = new Map<string, { date: LocalDate; id: string; byMembershipId: string }[]>();
    if (membershipIds.length === 0) return out;
    const rows = await this.logs.find(
      ctx,
      { membershipId: { $in: [...new Set(membershipIds)] }, localDate: { $gte: from }, totalCount: { $gt: 0 } },
      { sort: { localDate: 1 }, projection: { membershipId: 1, localDate: 1, enteredByMembershipId: 1 } },
    );
    for (const row of rows) {
      const days = out.get(row.membershipId) ?? [];
      days.push({ date: row.localDate, id: String(row._id), byMembershipId: row.enteredByMembershipId });
      out.set(row.membershipId, days);
    }
    return out;
  }

  /**
   * **Each member's latest day logged within a range, for many members at once** (Phase 18, D-figures,
   * D-directory): the Overview's engagement cards and its not-logged list, and the directory's *Last activity*.
   * `ACTIVITY_COMPLIANCE_7D`'s and `_MONTH`'s own fact — *did this person report*, any saved day, an all-zero
   * one included (ADR-0042). One aggregate for the whole list, within the office, on the
   * `(kpmId, membershipId, localDate)` index walked newest first; a member with no day in the range is absent.
   *
   * **Bounded where the question is** (the Phase 18 exit review, item 5): `from` and `to` are inclusive and each
   * optional. A card that asks *did they log this month, or this week* passes the earliest day it asks about, so
   * the read walks weeks of a member's log rather than years of it; only *"Last logged n days ago"* — the
   * not-logged list and the directory's column — needs the whole history, and passes neither.
   */
  async lastLoggedOnMany(
    ctx: RequestContext, membershipIds: readonly string[], range: { from?: LocalDate; to?: LocalDate } = {},
  ): Promise<Map<string, LocalDate>> {
    const out = new Map<string, LocalDate>();
    if (membershipIds.length === 0) return out;
    const localDate = {
      ...(range.from === undefined ? {} : { $gte: range.from }),
      ...(range.to === undefined ? {} : { $lte: range.to }),
    };
    const rows = await this.logs.aggregate(ctx, [
      {
        $match: {
          membershipId: { $in: [...new Set(membershipIds)] },
          ...(Object.keys(localDate).length === 0 ? {} : { localDate }),
        },
      },
      { $sort: { membershipId: -1, localDate: -1 } },
      { $group: { _id: '$membershipId', last: { $first: '$localDate' } } },
    ]);
    for (const row of rows) out.set(String(row._id), row.last as LocalDate);
    return out;
  }

  /**
   * **The sections a rung is shown**, in the office's order, each with every type it holds — archived ones
   * included, so a reader can keep what was logged against them (P10-T5).
   *
   * The rule is ADR-0020's, on the **category**: an active one whose `appliesToOrgLevelCodes` is empty or
   * names the rung. A section the office restricted to leaders is not an agent's to be shown.
   *
   * **And every archived section, marked `archived`** (ADR-0163 §6, P18.9-T2 AC-5): a period that holds counts
   * against its types keeps them on its summary tile, as the Activity Dashboard keeps an archived section's rows.
   * Which of them the period holds counts for is the caller's to know — `sectionChips` keeps those and drops the
   * rest, so a section archived before the period began shows nothing.
   *
   * Each carries the summary tile it counts toward (ADR-0064) — `null` for a tile of its own — so the
   * Summary's chips group the way the strips do (P10.1-T6).
   */
  async sectionsShown(ctx: RequestContext, orgLevelCode: string): Promise<{
    code: string; label: string; summaryGroupCode: string | null; summaryGroupLabel: string | null;
    status: 'active' | 'archived';
    types: { code: string; label: string; status: 'active' | 'archived' }[];
  }[]> {
    const [categories, types] = await Promise.all([
      this.categories.find(ctx, {}, { sort: { displayOrder: 1 } }),
      this.types.find(ctx, {}, { sort: { displayOrder: 1 } }),
    ]);
    const shown = (c: { appliesToOrgLevelCodes?: string[] }) =>
      (c.appliesToOrgLevelCodes ?? []).length === 0 || (c.appliesToOrgLevelCodes ?? []).includes(orgLevelCode);
    return categories
      .filter((c) => c.status === 'archived' || shown(c))
      .map((c) => ({
        code: c.code,
        label: c.label,
        summaryGroupCode: c.summaryGroupCode ?? null,
        summaryGroupLabel: c.summaryGroupLabel ?? null,
        status: c.status,
        types: types
          .filter((t) => t.categoryCode === c.code)
          .map((t) => ({ code: t.code, label: t.label, status: t.status })),
      }));
  }
}
