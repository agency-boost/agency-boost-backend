import type { TrainingStatus } from '@/domain/constants';
import { rateOver } from './rate';

/**
 * **`TRAINING_COMPLETION_PCT`** (`metrics-and-definitions.md`, *Training completion*; P18.2-T2 AC-2): the share
 * of the modules **offered** in a scope that a member has marked *Done*. One function, invariant §8: the
 * learner's list, the coach's *Training* tab, `/coaching/me/training` and Phase 18.3's tree all count through it.
 *
 * - **The scope** is the whole catalog, one category, or one skill (ADR-0029's middle level).
 * - **The denominator is the modules offered in it** — in the office's published snapshot: active, under an
 *   active skill and category, published. A draft, a module archived or unpublished and published since, and
 *   one published in the working copy but not yet by the office are in neither number.
 * - **The numerator is those whose status is `done`** — `in_progress` is not done (OD-149: the member's own
 *   word, as the prototype's toggle sets it).
 * - **An empty scope is `null`**, drawn *(0/0)*, never 0% — there is no share of nothing (metrics' notes; the
 *   prototype's empty categories would otherwise put every member at 8%).
 * - **A module done and then withdrawn** stays on the member's record (D-history) and in **neither** number:
 *   it is not offered, so it is not in the scope.
 *
 * `POINT_IN_TIME` (`registry.ts`): the status now, against the catalog now. Pure: codes and statuses in, the
 * figure out. The percentage is a whole percent, rounded half up, by `rateOver` — the rule every share of a
 * group the product draws uses.
 */
export interface TrainingCompletion {
  /** Offered modules in the scope whose status is `done`. */
  done: number;
  /** Offered modules in the scope. */
  total: number;
  /** `done / total` as a whole percent; `null` when the scope offers nothing. */
  pct: number | null;
}

/** Each member's status by module code. A module with no row is `not_started`. */
export type TrainingStatuses = ReadonlyMap<string, TrainingStatus>;

/** `TRAINING_COMPLETION_PCT` over one scope: the codes it offers, and the member's statuses. */
export function trainingCompletion(
  offeredModuleCodes: Iterable<string>, statuses: TrainingStatuses,
): TrainingCompletion {
  // A set: a code offered twice in one scope is one module, counted once on both sides.
  const offered = new Set(offeredModuleCodes);
  let done = 0;
  for (const code of offered) if (statuses.get(code) === 'done') done += 1;
  const rate = rateOver(done, offered.size);
  return { done: rate.count, total: rate.of, pct: rate.pct };
}

/** The offered catalog's shape, as far as counting goes: categories → skills → modules, by code. */
export interface OfferedTrainingScope {
  code: string;
  skills: readonly { code: string; modules: readonly { code: string }[] }[];
}

/** One member's completion at every scope of the offered catalog, from one pass over it. */
export interface TrainingCompletionByScope {
  catalog: TrainingCompletion;
  categories: ReadonlyMap<string, TrainingCompletion>;
  skills: ReadonlyMap<string, TrainingCompletion>;
  /**
   * **Every offered module done** — what 18.3's compliance chip counts a member toward (`KPM_Owner.html:
   * 3462-3468`). `false` when nothing is offered: a member is not *complete* on an empty catalog.
   */
  allOfferedDone: boolean;
}

/** `trainingCompletion` at the catalog, each category and each skill of the offered tree. */
export function completionByScope(
  tree: readonly OfferedTrainingScope[], statuses: TrainingStatuses,
): TrainingCompletionByScope {
  const categories = new Map<string, TrainingCompletion>();
  const skills = new Map<string, TrainingCompletion>();
  const everyModule: string[] = [];
  for (const category of tree) {
    const inCategory: string[] = [];
    for (const skill of category.skills) {
      const codes = skill.modules.map((m) => m.code);
      skills.set(skill.code, trainingCompletion(codes, statuses));
      inCategory.push(...codes);
    }
    categories.set(category.code, trainingCompletion(inCategory, statuses));
    everyModule.push(...inCategory);
  }
  const catalog = trainingCompletion(everyModule, statuses);
  return { catalog, categories, skills, allOfferedDone: catalog.total > 0 && catalog.done === catalog.total };
}
