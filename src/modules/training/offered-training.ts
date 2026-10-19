import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { ConfigSnapshotRepository } from '@/modules/config/activity.repository';
import {
  TrainingService, type TrainingCategoryView, type TrainingModuleView, type TrainingSkillView,
} from './training.service';

/** What a snapshot read takes: the training tree, and the version it is ordered by. */
const SNAPSHOT_TRAINING = { 'payload.training': 1, version: 1 } as const;

/** Where one offered module sits: its own row as offered, its skill, and its category. */
export interface OfferedModule {
  module: TrainingModuleView;
  skill: TrainingSkillView;
  category: TrainingCategoryView;
}

/** The offered catalog, as a tree in display order and indexed by module code. */
export interface OfferedCatalog {
  tree: TrainingCategoryView[];
  modules: ReadonlyMap<string, OfferedModule>;
}

/**
 * **What a member is offered: the office's published snapshot's training** (P18.5-T1 AC-3; `functional/training.md`,
 * *Offered*). One definition, read by every learner route, the coach's read, the activation evaluator's orphan rule
 * (D-orphan) and 18.6's tree, so none of them can disagree about what a member could have done.
 *
 * **The snapshot, not the live rows.** A draft is never offered; a module archived or unpublished is offered until
 * the office publishes that; a module published in the working copy is not offered until the office publishes it
 * — the rule `GET /kpm/config` already serves agents (`TenantConfigService.readPublished`). A snapshot published
 * before training existed carries none, and offers nothing. **An office with no snapshot at all** — one created
 * before snapshots, never the normal state — is offered its live published modules, the fallback `readPublished`
 * takes for the same case.
 *
 * Read here rather than through `TenantConfigService`, which renders the snapshot **from** `TrainingService` and the
 * activation checklist: the activation evaluator reads this, and a reader of the snapshot's renderer inside what the
 * renderer renders would be a cycle. The rule is the same one: the newest snapshot by version.
 */
@Injectable()
export class OfferedTraining {
  constructor(
    private readonly snapshots: ConfigSnapshotRepository,
    private readonly training: TrainingService,
  ) {}

  /** The offered taxonomy: active categories in order, each with its active skills, each with its published modules. */
  async tree(ctx: RequestContext): Promise<TrainingCategoryView[]> {
    // Its training alone: a snapshot carries the office's whole configuration, and this read is on every learner
    // route and every activation read that binds a module (the exit review, training review 3).
    const [newest] = await this.snapshots.find(ctx, {}, { sort: { version: -1 }, limit: 1, projection: SNAPSHOT_TRAINING });
    if (!newest) return this.training.offered(ctx);
    return (newest.payload as { training?: TrainingCategoryView[] }).training ?? [];
  }

  /** The tree, and every offered module by code with where it sits. One read. */
  async catalog(ctx: RequestContext): Promise<OfferedCatalog> {
    return indexCatalog(await this.tree(ctx));
  }

  /** The offered module codes — the evaluator's and the orphan rule's question, answered in one read. */
  async moduleCodes(ctx: RequestContext): Promise<ReadonlySet<string>> {
    return new Set((await this.catalog(ctx)).modules.keys());
  }
}

/** Index an offered tree by module code. Exported for its spec and for a caller holding a tree already. */
export function indexCatalog(tree: TrainingCategoryView[]): OfferedCatalog {
  const modules = new Map<string, OfferedModule>();
  for (const category of tree) {
    for (const skill of category.skills) {
      for (const module of skill.modules) modules.set(module.code, { module, skill, category });
    }
  }
  return { tree, modules };
}
