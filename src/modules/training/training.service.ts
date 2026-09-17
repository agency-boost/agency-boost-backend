import { BadRequestException, Injectable } from '@nestjs/common';
import type { FilterQuery } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
// The domain's, not Nest's: it answers `NOT_FOUND`, the code every tenant-scoped refusal uses.
import { NotFoundException } from '@/common/errors/domain.exception';
import type { TrainingPublishState } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { TrainingCategoryDocument } from './training-category.schema';
import { TrainingModuleDocument } from './training-module.schema';
import { TrainingSkillDocument } from './training-skill.schema';
import {
  checkTrainingCategoryCreate, checkTrainingCategoryUpdate, checkTrainingModuleCreate,
  checkTrainingModuleUpdate, checkTrainingSkillCreate, checkTrainingSkillUpdate,
} from './training-input';
import {
  TrainingCategoryRepository, TrainingModuleRepository, TrainingSkillRepository,
} from './training.repository';

type Status = 'active' | 'archived';

export interface TrainingModuleView {
  id: string;
  code: string;
  skillCode: string;
  title: string;
  publishState: TrainingPublishState;
  displayOrder: number;
  version: number;
  status: Status;
}

/** A skill on its own, as a write answers. */
export interface TrainingSkillRow {
  id: string;
  code: string;
  categoryCode: string;
  label: string;
  displayOrder: number;
  version: number;
  status: Status;
}

export interface TrainingSkillView extends TrainingSkillRow {
  modules: TrainingModuleView[];
}

/** A category on its own, as a write answers. */
export interface TrainingCategoryRow {
  id: string;
  code: string;
  label: string;
  description: string | null;
  displayOrder: number;
  version: number;
  status: Status;
}

export interface TrainingCategoryView extends TrainingCategoryRow {
  skills: TrainingSkillView[];
}

/** Archiving, as every level writes it: nothing is removed (invariant §3). */
const archived = (at: Date) => ({ $set: { status: 'archived', archivedAt: at }, $inc: { version: 1 } });
const restored = { $set: { status: 'active', archivedAt: null }, $inc: { version: 1 } };

/**
 * An office's training taxonomy: categories, the skills inside them, and the modules that teach
 * each skill (P5-T1, ADR-0029).
 *
 * **Everything is by code.** A module holds its skill's code and a skill its category's; the
 * prototype keys modules by the integers 1–10, and an activation item or a progress record
 * pointing at a position would follow whatever moved into it (invariant §4).
 *
 * **A module's category is its skill's.** Nothing here stores it on the module, so a skill that
 * moves takes its modules with it, and the two can never disagree.
 *
 * **Archiving cascades down, restoring does not, and nothing lives under an archived parent.**
 * A live module under a retired skill would be offered from nowhere; bringing back a skill is not
 * the same decision as bringing back everything it once held; and a restore or a create under an
 * archived parent would put a row where no screen renders it.
 *
 * Every write runs its checker first (ADR-0030) — the same one the staged batch's validate pass
 * runs before it writes anything.
 */
@Injectable()
export class TrainingService {
  constructor(
    private readonly categories: TrainingCategoryRepository,
    private readonly skills: TrainingSkillRepository,
    private readonly modules: TrainingModuleRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * The taxonomy as the settings screens read it: nested, in display order, **drafts
   * included**. `includeArchived` is the screen's, so an Owner can bring a row back.
   */
  async list(ctx: RequestContext, includeArchived = false): Promise<TrainingCategoryView[]> {
    const live = includeArchived ? {} : { status: 'active' };
    return this.tree(ctx, live, live, live);
  }

  /**
   * What agents are offered: active categories and skills, and **published** active modules.
   *
   * What the published snapshot carries (`TenantConfigService`). A category with nothing
   * published still comes back, empty, so a screen can say so rather than hide it.
   */
  async offered(ctx: RequestContext): Promise<TrainingCategoryView[]> {
    return this.tree(
      ctx, { status: 'active' }, { status: 'active' }, { status: 'active', publishState: 'published' },
    );
  }

  // ------------------------------------------------------------------ categories

  async createCategory(ctx: RequestContext, body: unknown): Promise<TrainingCategoryRow> {
    const input = checkTrainingCategoryCreate(body);
    await this.refuseTaken(ctx, 'category', input.code);

    const created = await this.categories.create(ctx, {
      ...input,
      // Appended: somebody adding one has not said where it goes.
      displayOrder: (await this.categories.count(ctx, {})) + 1,
      version: 1,
      status: 'active',
      archivedAt: null,
    } as Partial<TrainingCategoryDocument>);

    await this.record(ctx, 'training_category.created', 'trainingCategories', created, { code: input.code });
    return this.categoryRow(created);
  }

  /** Label and description. **Never the code.** */
  async updateCategory(ctx: RequestContext, id: string, body: unknown): Promise<TrainingCategoryRow> {
    const input = checkTrainingCategoryUpdate(body);
    if (Object.keys(input).length === 0) throw new BadRequestException('Nothing to change.');

    const updated = await this.categories.updateById(ctx, id, { $set: input, $inc: { version: 1 } });
    if (!updated) throw new NotFoundException('Training category');
    await this.record(ctx, 'training_category.updated', 'trainingCategories', updated, { ...input });
    return this.categoryRow(updated);
  }

  /** Archive a category **and everything under it** that is still active. */
  async archiveCategory(ctx: RequestContext, id: string): Promise<TrainingCategoryRow> {
    const at = this.clock.now();
    const updated = await this.categories.updateById(ctx, id, archived(at));
    if (!updated) throw new NotFoundException('Training category');

    // Every skill it holds, archived or not: a module still active under an archived skill is
    // one the cascade must reach as well.
    const skillCodes = (await this.skills.find(ctx, { categoryCode: updated.code })).map((s) => s.code);
    const skillsArchived = await this.skills.updateMany(
      ctx, { categoryCode: updated.code, status: 'active' }, archived(at),
    );
    const modulesArchived = await this.modules.updateMany(
      ctx, { skillCode: { $in: skillCodes }, status: 'active' }, archived(at),
    );

    await this.record(ctx, 'training_category.archived', 'trainingCategories', updated, {
      code: updated.code, skillsArchived, modulesArchived,
    });
    return this.categoryRow(updated);
  }

  /** The category alone. What it once held stays archived. */
  async restoreCategory(ctx: RequestContext, id: string): Promise<TrainingCategoryRow> {
    const updated = await this.categories.updateById(ctx, id, restored);
    if (!updated) throw new NotFoundException('Training category');
    await this.record(ctx, 'training_category.restored', 'trainingCategories', updated, { code: updated.code });
    return this.categoryRow(updated);
  }

  // ---------------------------------------------------------------------- skills

  async createSkill(ctx: RequestContext, body: unknown): Promise<TrainingSkillRow> {
    const input = checkTrainingSkillCreate(body);
    await this.refuseTaken(ctx, 'skill', input.code);
    await this.requireActiveCategory(ctx, input.categoryCode);

    const created = await this.skills.create(ctx, {
      ...input,
      displayOrder: (await this.skills.count(ctx, { categoryCode: input.categoryCode })) + 1,
      version: 1,
      status: 'active',
      archivedAt: null,
    } as Partial<TrainingSkillDocument>);

    await this.record(ctx, 'training_skill.created', 'trainingSkills', created, {
      code: input.code, categoryCode: input.categoryCode,
    });
    return this.skillRow(created);
  }

  /**
   * Label, and the category it sits in. **Never the code.** A skill that moves takes its modules
   * with it — their category is the skill's — and goes to the end of its new category.
   */
  async updateSkill(ctx: RequestContext, id: string, body: unknown): Promise<TrainingSkillRow> {
    const input = checkTrainingSkillUpdate(body);
    const existing = await this.skills.findById(ctx, id);
    if (!existing) throw new NotFoundException('Training skill');

    const set: Record<string, unknown> = {};
    if (input.label !== undefined) set.label = input.label;
    if (input.categoryCode !== undefined && input.categoryCode !== existing.categoryCode) {
      await this.requireActiveCategory(ctx, input.categoryCode);
      set.categoryCode = input.categoryCode;
      set.displayOrder = (await this.skills.count(ctx, { categoryCode: input.categoryCode })) + 1;
    }
    if (Object.keys(set).length === 0) throw new BadRequestException('Nothing to change.');

    const updated = await this.skills.updateById(ctx, id, { $set: set, $inc: { version: 1 } });
    if (!updated) throw new NotFoundException('Training skill');
    await this.record(ctx, 'training_skill.updated', 'trainingSkills', updated, set);
    return this.skillRow(updated);
  }

  /** Archive a skill **and its modules** that are still active. */
  async archiveSkill(ctx: RequestContext, id: string): Promise<TrainingSkillRow> {
    const at = this.clock.now();
    const updated = await this.skills.updateById(ctx, id, archived(at));
    if (!updated) throw new NotFoundException('Training skill');

    const modulesArchived = await this.modules.updateMany(
      ctx, { skillCode: updated.code, status: 'active' }, archived(at),
    );
    await this.record(ctx, 'training_skill.archived', 'trainingSkills', updated, {
      code: updated.code, modulesArchived,
    });
    return this.skillRow(updated);
  }

  /** The skill alone — and only into a category that is itself active. */
  async restoreSkill(ctx: RequestContext, id: string): Promise<TrainingSkillRow> {
    const existing = await this.skills.findById(ctx, id);
    if (!existing) throw new NotFoundException('Training skill');
    if (!(await this.categories.exists(ctx, { code: existing.categoryCode, status: 'active' }))) {
      throw new BadRequestException(
        `${existing.code} is in ${existing.categoryCode}, which is archived. Restore the category `
          + 'first — a skill in an archived category shows on no screen.',
      );
    }

    const updated = await this.skills.updateById(ctx, id, restored);
    await this.record(ctx, 'training_skill.restored', 'trainingSkills', updated!, { code: existing.code });
    return this.skillRow(updated!);
  }

  // --------------------------------------------------------------------- modules

  async createModule(ctx: RequestContext, body: unknown): Promise<TrainingModuleView> {
    const input = checkTrainingModuleCreate(body);
    await this.refuseTaken(ctx, 'module', input.code);
    await this.requireActiveSkill(ctx, input.skillCode);

    const created = await this.modules.create(ctx, {
      ...input,
      displayOrder: (await this.modules.count(ctx, { skillCode: input.skillCode })) + 1,
      version: 1,
      status: 'active',
      archivedAt: null,
    } as Partial<TrainingModuleDocument>);

    await this.record(ctx, 'training_module.created', 'trainingModules', created, {
      code: input.code, skillCode: input.skillCode, publishState: input.publishState,
    });
    return this.moduleView(created);
  }

  /**
   * Title, publish state and the skill it teaches. **Never the code.** Publishing or
   * unpublishing a module is an edit like any other, and reaches agents when the office next
   * publishes.
   */
  async updateModule(ctx: RequestContext, id: string, body: unknown): Promise<TrainingModuleView> {
    const input = checkTrainingModuleUpdate(body);
    const existing = await this.modules.findById(ctx, id);
    if (!existing) throw new NotFoundException('Training module');

    const set: Record<string, unknown> = {};
    if (input.title !== undefined) set.title = input.title;
    if (input.publishState !== undefined) set.publishState = input.publishState;
    if (input.skillCode !== undefined && input.skillCode !== existing.skillCode) {
      await this.requireActiveSkill(ctx, input.skillCode);
      set.skillCode = input.skillCode;
      set.displayOrder = (await this.modules.count(ctx, { skillCode: input.skillCode })) + 1;
    }
    if (Object.keys(set).length === 0) throw new BadRequestException('Nothing to change.');

    const updated = await this.modules.updateById(ctx, id, { $set: set, $inc: { version: 1 } });
    if (!updated) throw new NotFoundException('Training module');
    await this.record(ctx, 'training_module.updated', 'trainingModules', updated, set);
    return this.moduleView(updated);
  }

  async archiveModule(ctx: RequestContext, id: string): Promise<TrainingModuleView> {
    const updated = await this.modules.updateById(ctx, id, archived(this.clock.now()));
    if (!updated) throw new NotFoundException('Training module');
    await this.record(ctx, 'training_module.archived', 'trainingModules', updated, { code: updated.code });
    return this.moduleView(updated);
  }

  /** The module alone — and only under a skill that is itself active. */
  async restoreModule(ctx: RequestContext, id: string): Promise<TrainingModuleView> {
    const existing = await this.modules.findById(ctx, id);
    if (!existing) throw new NotFoundException('Training module');
    if (!(await this.skills.exists(ctx, { code: existing.skillCode, status: 'active' }))) {
      throw new BadRequestException(
        `${existing.code} teaches ${existing.skillCode}, which is archived. Restore the skill `
          + 'first — a module under an archived skill shows on no screen.',
      );
    }

    const updated = await this.modules.updateById(ctx, id, restored);
    await this.record(ctx, 'training_module.restored', 'trainingModules', updated!, { code: existing.code });
    return this.moduleView(updated!);
  }

  // -------------------------------------------------------------------- internals

  private async tree(
    ctx: RequestContext,
    categoryFilter: FilterQuery<TrainingCategoryDocument>,
    skillFilter: FilterQuery<TrainingSkillDocument>,
    moduleFilter: FilterQuery<TrainingModuleDocument>,
  ): Promise<TrainingCategoryView[]> {
    const order = { sort: { displayOrder: 1 as const } };
    const [categories, skills, modules] = await Promise.all([
      this.categories.find(ctx, categoryFilter, order),
      this.skills.find(ctx, skillFilter, order),
      this.modules.find(ctx, moduleFilter, order),
    ]);
    return categories.map((category) => ({
      ...this.categoryRow(category),
      skills: skills
        .filter((skill) => skill.categoryCode === category.code)
        .map((skill) => ({
          ...this.skillRow(skill),
          modules: modules
            .filter((module) => module.skillCode === skill.code)
            .map((module) => this.moduleView(module)),
        })),
    }));
  }

  /**
   * A code is never reused **within its level**, counting archived rows: a retired code that came
   * back as something else would change the meaning of everything still pointing at it.
   */
  private async refuseTaken(
    ctx: RequestContext, level: 'category' | 'skill' | 'module', code: string,
  ): Promise<void> {
    const repository = { category: this.categories, skill: this.skills, module: this.modules }[level];
    if (await (repository as TrainingCategoryRepository).exists(ctx, { code })) {
      throw new BadRequestException(
        `This office already has a training ${level} called ${code}. A code is never reused.`,
      );
    }
  }

  private async requireActiveCategory(ctx: RequestContext, code: string): Promise<void> {
    if (!(await this.categories.exists(ctx, { code, status: 'active' }))) {
      throw new BadRequestException(`No active training category called ${code} in this office.`);
    }
  }

  private async requireActiveSkill(ctx: RequestContext, code: string): Promise<void> {
    if (!(await this.skills.exists(ctx, { code, status: 'active' }))) {
      throw new BadRequestException(`No active training skill called ${code} in this office.`);
    }
  }

  private categoryRow(doc: TrainingCategoryDocument): TrainingCategoryRow {
    return {
      id: String(doc._id),
      code: doc.code,
      label: doc.label,
      description: doc.description,
      displayOrder: doc.displayOrder,
      version: doc.version,
      status: doc.status,
    };
  }

  private skillRow(doc: TrainingSkillDocument): TrainingSkillRow {
    return {
      id: String(doc._id),
      code: doc.code,
      categoryCode: doc.categoryCode,
      label: doc.label,
      displayOrder: doc.displayOrder,
      version: doc.version,
      status: doc.status,
    };
  }

  private moduleView(doc: TrainingModuleDocument): TrainingModuleView {
    return {
      id: String(doc._id),
      code: doc.code,
      skillCode: doc.skillCode,
      title: doc.title,
      publishState: doc.publishState,
      displayOrder: doc.displayOrder,
      version: doc.version,
      status: doc.status,
    };
  }

  private async record(
    ctx: RequestContext,
    action: string,
    targetCollection: string,
    target: { _id: unknown },
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(ctx, { action, targetCollection, targetId: String(target._id), after });
  }
}
