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
 * **Training** in the Owner's compliance tree (P18.3-T1 AC-4): the office's offered catalog for the three tab rows,
 * each member's status on the selected module, and the chip — every offered module done.
 *
 * - **What is offered is `OfferedTraining`'s** — the office's newest published snapshot, the one definition every
 *   learner, coach and activation read uses (P18.2-T1 AC-3): every active category in its order, an empty one
 *   included; here only the skills holding a published module, as the *Skill* tabs draw them (AC-4).
 * - **A member's status is `TrainingProgressReadings`'** (`rowsOf`, one query for the selected module over every
 *   member): `done` · `in_progress`, and `not_started` without a row — the learner's own word (ADR-0139). *Completed*
 *   carries the office day it was marked done.
 * - **The chip follows the module** (P19.3-T3 AC-9; the client's UI-093, *"Training tile 2 / 28 vs list 12 / 28"*):
 *   the tree's members whose status on **the selected module** is `done` — the first module when Training is not the
 *   tab read — over the tree's members, so the tile is the sum of the list's *"x / y selesai"* beneath it. It counted
 *   every offered module done (`allOfferedDone`) until 2026-11-05, a figure no list on the page showed. **`of: 0`,
 *   drawn *—*, when nothing is offered**.
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

    // The chip's module (AC-9): the one the tree shows, or the first offered when another tab is read.
    const counted = selection.selected ? item : codes[0] ?? null;
    const rows = counted === null ? [] : await this.progress.rowsOf(ctx, memberIds, { moduleCodes: [counted] });
    const row = new Map(rows.map((r) => [r.membershipId, r]));
    const chip: ComplianceChip = codes.length === 0
      ? { count: 0, of: 0 }
      : { count: memberIds.filter((id) => row.get(id)?.status === 'done').length, of: memberIds.length };

    if (!selection.selected) return { catalog, chip, item: null, cells: null };
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
