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
   * **The sections a rung is shown**, in the office's order, each with every type it holds — archived ones
   * included, so a reader can keep what was logged against them (P10-T5).
   *
   * The rule is ADR-0020's, on the **category**: an active one whose `appliesToOrgLevelCodes` is empty or
   * names the rung. A section the office restricted to leaders is not an agent's to be shown.
   *
   * Each carries the summary tile it counts toward (ADR-0064) — `null` for a tile of its own — so the
   * Summary's chips group the way the strips do (P10.1-T6).
   */
  async sectionsShown(ctx: RequestContext, orgLevelCode: string): Promise<{
    code: string; label: string; summaryGroupCode: string | null; summaryGroupLabel: string | null;
    types: { code: string; label: string; status: 'active' | 'archived' }[];
  }[]> {
    const [categories, types] = await Promise.all([
      this.categories.find(ctx, { status: 'active' }, { sort: { displayOrder: 1 } }),
      this.types.find(ctx, {}, { sort: { displayOrder: 1 } }),
    ]);
    return categories
      .filter((c) => (c.appliesToOrgLevelCodes ?? []).length === 0 || (c.appliesToOrgLevelCodes ?? []).includes(orgLevelCode))
      .map((c) => ({
        code: c.code,
        label: c.label,
        summaryGroupCode: c.summaryGroupCode ?? null,
        summaryGroupLabel: c.summaryGroupLabel ?? null,
        types: types
          .filter((t) => t.categoryCode === c.code)
          .map((t) => ({ code: t.code, label: t.label, status: t.status })),
      }));
  }
}
