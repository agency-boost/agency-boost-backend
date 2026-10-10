import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { NotFoundException } from '@/common/errors/domain.exception';
import { OfferedTraining } from '@/modules/training/offered-training';
import { TrainingProgressReadings } from '@/modules/training/training-progress-readings';
import type {
  ComplianceCategory, ComplianceCategoryRead, ComplianceCell, ComplianceChip, ComplianceScope,
} from './compliance-category';

/** One offered module, as the *Module* tabs list it. */
export interface ComplianceTrainingModule {
  code: string;
  title: string;
}

/** One skill holding at least one offered module: a *Skill* tab. */
export interface ComplianceTrainingSkill {
  code: string;
  label: string;
  modules: ComplianceTrainingModule[];
}

/** One offered category: a *Category* tab — with no skill, *"Modules for {name} are coming soon."*. */
export interface ComplianceTrainingCategory {
  code: string;
  label: string;
  skills: ComplianceTrainingSkill[];
}

export type TrainingComplianceCatalog = ComplianceTrainingCategory[];

/**
 * **Training** in the Owner's compliance tree (P18.6-T1 AC-4): the office's offered catalog for the three tab rows,
 * each member's status on the selected module, and the chip — every offered module done.
 *
 * - **What is offered is `OfferedTraining`'s** — the office's newest published snapshot, the one definition every
 *   learner, coach and activation read uses (P18.5-T1 AC-3): every active category in its order, an empty one
 *   included; here only the skills holding a published module, as the *Skill* tabs draw them (AC-4).
 * - **A member's status is `TrainingProgressReadings`'** (`rowsOf`, one query for the selected module over every
 *   member): `done` · `in_progress`, and `not_started` without a row — the learner's own word (ADR-0139). *Completed*
 *   carries the office day it was marked done.
 * - **The chip** (D-chips): members whose `allOfferedDone` is true (`ofMany`, `TRAINING_COMPLETION_PCT`'s own
 *   `completionByScope`) over the tree's members — **`of: 0`, drawn *—*, when nothing is offered**: nobody is complete
 *   on an empty catalog.
 * - **No item without one asked**: the first module of the first skill of the first category that holds one; none
 *   offered, none. **A module the office does not offer is 404** — another office's, archived, a draft.
 * - **Disclosure** (D-audit-tree): selected, each member's status on a module is their training record, surface
 *   `training` from the whole record (`from: null`), as the coach's tab writes it; nothing when no module is selected.
 */
@Injectable()
export class TrainingComplianceCategory implements ComplianceCategory<TrainingComplianceCatalog> {
  constructor(
    private readonly offered: OfferedTraining,
    private readonly progress: TrainingProgressReadings,
    private readonly clock: Clock,
  ) {}

  async read(
    scope: ComplianceScope, selection: { selected: boolean; item: string | null },
  ): Promise<ComplianceCategoryRead<TrainingComplianceCatalog>> {
    const { ctx, memberIds } = scope;
    const catalog: TrainingComplianceCatalog = (await this.offered.tree(ctx)).map((category) => ({
      code: category.code,
      label: category.label,
      skills: category.skills
        .filter((skill) => skill.modules.length > 0)
        .map((skill) => ({
          code: skill.code,
          label: skill.label,
          modules: skill.modules.map((module) => ({ code: module.code, title: module.title })),
        })),
    }));
    const codes = catalog.flatMap((c) => c.skills.flatMap((s) => s.modules.map((m) => m.code)));
    if (selection.item !== null && !codes.includes(selection.item)) throw new NotFoundException('Training module');
    const item = selection.selected ? selection.item ?? codes[0] ?? null : null;

    const [views, rows] = await Promise.all([
      this.progress.ofMany(ctx, memberIds),
      item === null ? Promise.resolve([]) : this.progress.rowsOf(ctx, memberIds, { moduleCodes: [item] }),
    ]);
    const chip: ComplianceChip = codes.length === 0
      ? { count: 0, of: 0 }
      // `ofMany` answers a view for every member asked.
      : { count: memberIds.filter((id) => views.get(id)!.allOfferedDone).length, of: memberIds.length };

    if (!selection.selected) return { catalog, chip, item: null, cells: null };
    const row = new Map(rows.map((r) => [r.membershipId, r]));
    const cells = new Map<string, ComplianceCell>(memberIds.map((id): [string, ComplianceCell] => {
      if (item === null) return [id, { status: null, done: null, on: null }];
      const status = row.get(id)?.status ?? 'not_started';
      const completedAt = row.get(id)?.completedAt ?? null;
      return [id, {
        status,
        done: status === 'done',
        on: status === 'done' && completedAt !== null ? this.clock.localDateFor(scope.office.timezone, completedAt) : null,
      }];
    }));
    return {
      catalog,
      chip,
      item,
      cells,
      ...(item === null ? {} : {
        disclosure: { surface: 'training' as const, subjects: memberIds.map((membershipId) => ({ membershipId, from: null })) },
      }),
    };
  }
}
