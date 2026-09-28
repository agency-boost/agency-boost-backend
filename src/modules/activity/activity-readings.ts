import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import type { LocalDate } from '@/common/time/local-day';
import { ActivityLogRepository } from './activity-log.repository';

/**
 * **Activity, as the rest of the product reads it** (P10-T9) — the seam `ProductionReadings` is for
 * production. A module outside this one that needs a member's counts asks here, rather than reading
 * `activityLogs` on its own terms.
 */
@Injectable()
export class ActivityReadings {
  constructor(private readonly logs: ActivityLogRepository) {}

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
}
