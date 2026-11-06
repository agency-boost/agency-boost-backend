import { Injectable } from '@nestjs/common';
import { rollingWindow } from '@/common/time/local-day';
import { PERIOD } from '@/domain/constants';
import { activityComplianceRate, loggedWithin } from '@/domain/metrics/activity-logged';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import type {
  ComplianceCategory, ComplianceCategoryRead, ComplianceCell, ComplianceScope,
} from './compliance-category';

/**
 * **Activity Mgmt** in the Owner's compliance tree (P18.3-T1 AC-6): one item, *"Activity log — last 7 days"*.
 *
 * - **The Overview's own functions** (*Settled already*): each member's latest day logged
 *   (`ActivityReadings.lastLoggedOnMany`, one aggregate for everybody, bounded to the window) and `loggedWithin` over
 *   `ROLLING_7D` — today and the six days before it **in the office's calendar**, so a day saved at 23:59 Jakarta time
 *   is that day's and one at 00:01 the next's. *Logged* carries the latest day; *Missed* nothing. No *Partial*: the
 *   prototype's tooltip says there is none.
 * - **The chip** is `ACTIVITY_COMPLIANCE_RATE`'s count over the tree's members — the Overview's
 *   `loggedThisWeek.logged`, less the members the tree places nowhere (`compliance.reconciliation.int.spec.ts`).
 * - **Disclosure** (D-audit-tree): selected, every member listed, surface `kpm_compliance`, `from: null` — the latest
 *   day logged is disclosed whenever it was, as the Overview's not-logged list records it.
 */
@Injectable()
export class ActivityComplianceCategory implements ComplianceCategory<null> {
  constructor(private readonly activity: ActivityReadings) {}

  async read(
    scope: ComplianceScope, selection: { selected: boolean; item: string | null },
  ): Promise<ComplianceCategoryRead<null>> {
    const { ctx, memberIds } = scope;
    const week = rollingWindow(scope.today, PERIOD.ROLLING_7D_DAYS);
    const latest = await this.activity.lastLoggedOnMany(ctx, memberIds, week);
    const chip = { count: activityComplianceRate(memberIds, latest, week).logged, of: memberIds.length };
    if (!selection.selected) return { catalog: null, chip, item: null, cells: null };

    const cells = new Map<string, ComplianceCell>(memberIds.map((id): [string, ComplianceCell] => {
      const last = latest.get(id);
      return loggedWithin(last, week)
        ? [id, { status: 'logged', done: true, on: last! }]
        : [id, { status: 'missed', done: false, on: null }];
    }));
    return {
      catalog: null,
      chip,
      item: null,
      cells,
      disclosure: { surface: 'kpm_compliance', subjects: memberIds.map((membershipId) => ({ membershipId, from: null })) },
    };
  }
}
