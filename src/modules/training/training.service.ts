import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { FilterQuery, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
// The domain's, not Nest's: it answers `NOT_FOUND`, the code every tenant-scoped refusal uses.
import { NotFoundException } from '@/common/errors/domain.exception';
import type { TrainingPublishState } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { AssetService } from '@/modules/assets/asset.service';
import { Kpm } from '@/modules/tenants/kpm.schema';
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
import {
  checkTrainingContent, emptyContent, storageKeysOf, type CheckedContent,
} from './training-content';

type Status = 'active' | 'archived';

/** A module's content as a screen reads it, with where each half came from. */
export interface TrainingContentView {
  moduleCode: string;
  title: string;
  /** What agents in this office are shown: the office's replacement, or the company's. */
  content: CheckedContent;
  /** The company's material, always — so the screen can say what "use theirs again" restores. */
  companyContent: CheckedContent;
  /** False while this office is using the company's material unchanged. */
  overridden: boolean;
}

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
    // P5-T2. Content is files, and files are the asset registry's (ADR-0032).
    private readonly assets: AssetService,
    @InjectModel(Kpm.name) private readonly kpms: Model<Kpm>,
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

  // ------------------------------------------------------ a module's content (P5-T2, ADR-0032)

  /**
   * A signed upload for training material, in this office's folder.
   *
   * The folder is **fixed by the server**, not taken from the caller: a client that chose its own
   * would decide where somebody else's erasure sweep looks.
   */
  async requestContentUpload(
    ctx: RequestContext,
    params: { filename: string; mimeType: string; bytes: number },
  ) {
    return this.assets.requestUpload(ctx, { folder: 'training', ...params });
  }

  /** Ask storage what actually landed, and record that (ADR-0040). */
  async confirmContentUpload(ctx: RequestContext, storageKey: string) {
    const asset = await this.assets.confirmUpload(ctx, storageKey);
    return {
      storageKey: asset.storageKey, mimeType: asset.mimeType, bytes: asset.bytes,
    };
  }

  /**
   * What this office shows for a module, and what the company gave it.
   *
   * Both halves, always: a screen offering *"use the company's material again"* has to be able to
   * say what that would restore, and an Owner deciding whether to replace something needs to see
   * what they are replacing.
   */
  async readContent(ctx: RequestContext, code: string): Promise<TrainingContentView> {
    const module = await this.requireModule(ctx, code);
    const companyContent = asContent(module.companyContent);
    return {
      moduleCode: module.code,
      title: module.title,
      content: module.officeContent ? asContent(module.officeContent) : companyContent,
      companyContent,
      overridden: module.officeContent !== null,
    };
  }

  /**
   * Replace this office's content for one module (AC-6, AC-9).
   *
   * **The whole document, and it lands on `officeContent`.** The company's row is never touched —
   * that is what makes the replacement this office's alone, and what lets `resetContent` put the
   * company's material back.
   *
   * Reference counts are moved by **diffing** old against new rather than by the caller telling us
   * what changed: a screen that sends the whole document cannot be trusted to also narrate its own
   * edits, and a count that drifts makes a live file look like an orphan.
   */
  async saveContent(
    ctx: RequestContext, code: string, body: unknown,
  ): Promise<TrainingContentView> {
    const module = await this.requireModule(ctx, code);
    const next = checkTrainingContent(body);
    await this.requireOfficeAssets(ctx, next);

    const before = module.officeContent ? storageKeysOf(asContent(module.officeContent)) : [];
    const after = storageKeysOf(next);
    await this.moveReferences(ctx, before, after);

    /*
     * **No version moves** (the Phase 18.5 exit review): a module's `version` is what the office's publish bar compares
     * (`TenantConfigService.fingerprint`), and its content is not snapshot material — it reaches agents at once, read
     * live. Moving it here told an Owner who had only replaced a file that the office had something to publish.
     */
    await this.modules.updateById(ctx, String(module._id), {
      $set: { officeContent: next },
    });
    await this.record(ctx, 'training_module.content_saved', 'trainingModules', module, {
      code: module.code,
      files: next.files.length,
      videos: next.videos.length,
      links: next.links.length,
    });
    return this.readContent(ctx, code);
  }

  /**
   * Give the module back its company material (AC-9).
   *
   * Removing the replacement is writing `null`, which is the whole of the fallback rule. The
   * office's own uploads are released rather than deleted — somebody may put them back, and
   * deleting a file because it stopped being referenced is a decision nobody made.
   */
  async resetContent(ctx: RequestContext, code: string): Promise<TrainingContentView> {
    const module = await this.requireModule(ctx, code);
    if (module.officeContent === null) return this.readContent(ctx, code);

    await this.moveReferences(ctx, storageKeysOf(asContent(module.officeContent)), []);
    // No version moves, as a save's does not: content is read live, not published (the Phase 18.5 exit review).
    await this.modules.updateById(ctx, String(module._id), {
      $set: { officeContent: null },
    });
    await this.record(ctx, 'training_module.content_reset', 'trainingModules', module, {
      code: module.code,
    });
    return this.readContent(ctx, code);
  }

  /**
   * A short-lived signed URL for one item of a module's content.
   *
   * **Which registry answers depends on which half the item is in**, not on what the caller says:
   * a file the office uploaded is read as the office's, and the company's shared material is read
   * through the named unscoped method filtered by this office's own company (ADR-0032). A key that
   * is in neither half of this module is a 404, so knowing a storage key buys nothing.
   */
  async contentUrl(ctx: RequestContext, code: string, storageKey: string): Promise<string> {
    const module = await this.requireModule(ctx, code);
    const office = module.officeContent ? asContent(module.officeContent) : null;

    if (office && storageKeysOf(office).includes(storageKey)) {
      return this.assets.urlFor(ctx, storageKey);
    }
    if (storageKeysOf(asContent(module.companyContent)).includes(storageKey)) {
      return this.assets.companyUrlFor(await this.companyOf(ctx), storageKey);
    }
    throw new NotFoundException('Asset');
  }

  /** The company this office belongs to — never a value the caller sent. */
  private async companyOf(ctx: RequestContext): Promise<string> {
    const kpm = await this.kpms.findById(ctx.kpmId).select('companyId').lean().exec();
    const companyId = (kpm as { companyId?: string } | null)?.companyId;
    if (!companyId) throw new NotFoundException('Kpm');
    return companyId;
  }

  /**
   * Every file named in a save is one this office actually uploaded and confirmed.
   *
   * Without it a body could name the company's key, or another office's, and attach it to this
   * office's module — and the delivery URL would then be issued against the wrong registry.
   */
  private async requireOfficeAssets(ctx: RequestContext, content: CheckedContent): Promise<void> {
    for (const storageKey of storageKeysOf(content)) {
      // `urlFor` is the same check delivery makes: it exists, it is this office's, and its bytes
      // arrived. Reusing it means the two can never disagree about what is attachable.
      await this.assets.urlFor(ctx, storageKey);
    }
  }

  /** Retain what is newly referenced, release what no longer is. */
  private async moveReferences(
    ctx: RequestContext, before: string[], after: string[],
  ): Promise<void> {
    const had = new Set(before);
    const has = new Set(after);
    for (const key of has) if (!had.has(key)) await this.assets.retain(ctx, key);
    for (const key of had) if (!has.has(key)) await this.assets.release(ctx, key);
  }

  private async requireModule(
    ctx: RequestContext, code: string,
  ): Promise<TrainingModuleDocument> {
    const module = await this.modules.findOne(ctx, { code: code.toUpperCase() });
    if (!module) throw new NotFoundException('TrainingModule');
    return module;
  }

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

/**
 * A stored subdocument as the plain shape the checker and the screens speak.
 *
 * `toObject()` rather than a spread: spreading a Mongoose subdocument copies its internals and
 * none of its fields, so `storageKey` came back `undefined` and a file the office had just
 * attached read as one the module did not hold.
 */
export function asContent(raw: unknown): CheckedContent {
  const plain = <T>(value: unknown): T => {
    const doc = value as { toObject?: () => unknown };
    return (typeof doc?.toObject === 'function' ? doc.toObject() : { ...(value as object) }) as T;
  };
  const row = plain<Partial<CheckedContent>>(raw ?? {});
  return {
    ...emptyContent(),
    files: (row.files ?? []).map((f) => plain<CheckedContent['files'][number]>(f)),
    videos: (row.videos ?? []).map((f) => plain<CheckedContent['files'][number]>(f)),
    links: (row.links ?? []).map((l) => plain<CheckedContent['links'][number]>(l)),
  };
}
