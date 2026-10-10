import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { goalSet, goalSetRate } from '@/domain/metrics/goal-set';
import { GoalService } from '@/modules/goals/goal.service';
import type {
  ComplianceCategory, ComplianceCategoryRead, ComplianceCell, ComplianceScope,
} from './compliance-category';

/** *"{YYYY} goals"* (`Owner:3015`, contradiction 3): the office's calendar year — a goal is annual (ADR-0049). */
export interface GoalsComplianceCatalog {
  year: string;
}

/**
 * **Goal Setting** in the Owner's compliance tree (P18.6-T1 AC-5): one item, the office's calendar year.
 *
 * - **A goal set is OD-160's one predicate** (`goalSet`, `domain/metrics/goal-set.ts`): saved for the year with an
 *   annual APE target above zero — the Overview's *"{n} members have no goal set…"* reads the same function. *Set*
 *   carries the office day it was saved; *Not set* nothing. There is no draft (ADR-0049).
 * - **The plans are `GoalService.plansOf`'s**, every member's in one read (`GOAL_SET_RATE` reads no production, so no
 *   year to date is passed: the annual target does not depend on it).
 * - **The chip** is `GOAL_SET_RATE` over the tree's members (D-chips). It equals the Overview's headcount less its
 *   `membersWithoutGoal`, less the members the tree places nowhere (`compliance.reconciliation.int.spec.ts`).
 * - **No §3.5 entry** (D-audit-tree; `goals.md`: a goal is no activity record).
 */
@Injectable()
export class GoalsComplianceCategory implements ComplianceCategory<GoalsComplianceCatalog> {
  constructor(
    private readonly goals: GoalService,
    private readonly clock: Clock,
  ) {}

  async read(
    scope: ComplianceScope, selection: { selected: boolean; item: string | null },
  ): Promise<ComplianceCategoryRead<GoalsComplianceCatalog>> {
    const year = scope.today.slice(0, 4);
    const plans = await this.goals.plansOf(scope.ctx, year, scope.memberIds, new Map());
    const rate = goalSetRate(scope.memberIds, plans);
    const chip = { count: rate.count, of: rate.of };
    if (!selection.selected) return { catalog: { year }, chip, item: null, cells: null };

    const cells = new Map<string, ComplianceCell>(scope.memberIds.map((id): [string, ComplianceCell] => {
      const plan = plans.get(id)!;
      return goalSet(plan)
        ? [id, { status: 'set', done: true, on: this.clock.localDateFor(scope.office.timezone, new Date(plan.savedAt!)) }]
        : [id, { status: 'not_set', done: false, on: null }];
    }));
    return { catalog: { year }, chip, item: null, cells };
  }
}
