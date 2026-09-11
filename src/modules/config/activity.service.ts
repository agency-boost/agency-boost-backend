import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import { ActivityCategoryRepository, ActivityTypeRepository } from './activity.repository';
import { ActivityCategoryDocument } from './activity-category.schema';
import { ActivityTypeDocument } from './activity-type.schema';

export interface ActivityTypeView {
  id: string;
  code: string;
  categoryCode: string;
  label: string;
  description: string | null;
  displayOrder: number;
  version: number;
  status: 'active' | 'archived';
}

export interface ActivityCategoryView {
  id: string;
  code: string;
  label: string;
  displayOrder: number;
  version: number;
  status: 'active' | 'archived';
  types: ActivityTypeView[];
}

/** A code somebody typed. Upper snake, because that is what every published code is. */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,39}$/;

/**
 * The office's activity taxonomy (P4-T1).
 *
 * **Everything here is by code.** The prototype keys its twelve items off the integers
 * 1–12 and uses those integers as the primary key everywhere — ratio formulas, goal
 * cascade chips, summary aggregation. An Owner dragging an item would, in that model,
 * silently rebind every one of them. `displayOrder` is the number a reader sees and
 * nothing reads it back (invariant §4).
 *
 * **Archiving, never deleting** (invariant §3). Every activity log ever written names a
 * type. Removing one would orphan them, and they still have to render.
 */
@Injectable()
export class ActivityConfigService {
  constructor(
    private readonly categories: ActivityCategoryRepository,
    private readonly types: ActivityTypeRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------ reads

  /**
   * The whole taxonomy, grouped, in the order the Owner arranged it.
   *
   * `includeArchived` is what the settings screen asks for and the capture screen does
   * not: an agent logging today should not be offered a type the office retired, but an
   * Owner needs to see what they retired in order to bring it back.
   */
  async list(ctx: RequestContext, includeArchived = false): Promise<ActivityCategoryView[]> {
    const filter = includeArchived ? {} : { status: 'active' };
    const [categories, types] = await Promise.all([
      this.categories.find(ctx, filter, { sort: { displayOrder: 1 } }),
      this.types.find(ctx, filter, { sort: { displayOrder: 1 } }),
    ]);

    return categories.map((category) => ({
      ...this.categoryView(category),
      types: types
        .filter((t) => t.categoryCode === category.code)
        .map((t) => this.typeView(t)),
    }));
  }

  /** The active codes, for anything that has to validate a reference against them. */
  async activeTypeCodes(ctx: RequestContext): Promise<string[]> {
    const types = await this.types.find(ctx, { status: 'active' }, { sort: { displayOrder: 1 } });
    return types.map((t) => t.code);
  }

  // ------------------------------------------------------------- categories

  async createCategory(
    ctx: RequestContext,
    input: { code: string; label: string },
  ): Promise<ActivityCategoryView> {
    const code = this.normaliseCode(input.code);
    await this.refuseDuplicateCategory(ctx, code);

    const created = await this.categories.create(ctx, {
      code,
      label: input.label.trim(),
      // Appended, not inserted. Somebody adding a category has not said where it goes,
      // and guessing would renumber rows they did not touch.
      displayOrder: (await this.categories.count(ctx, {})) + 1,
      version: 1,
      status: 'active',
    } as Partial<ActivityCategoryDocument>);

    await this.record(ctx, 'activity_category.created', String(created._id), { code });
    return { ...this.categoryView(created), types: [] };
  }

  async renameCategory(
    ctx: RequestContext,
    id: string,
    label: string,
  ): Promise<ActivityCategoryView> {
    const updated = await this.categories.updateById(ctx, id, {
      $set: { label: label.trim() },
      $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Activity category');
    await this.record(ctx, 'activity_category.renamed', id, { label });
    return { ...this.categoryView(updated), types: [] };
  }

  // ------------------------------------------------------------------ types

  async createType(
    ctx: RequestContext,
    input: { code: string; categoryCode: string; label: string; description?: string | null },
  ): Promise<ActivityTypeView> {
    const code = this.normaliseCode(input.code);
    const categoryCode = this.normaliseCode(input.categoryCode);
    await this.refuseDuplicateType(ctx, code);
    await this.requireLiveCategory(ctx, categoryCode);

    const created = await this.types.create(ctx, {
      code,
      categoryCode,
      label: input.label.trim(),
      description: input.description?.trim() || null,
      displayOrder: (await this.types.count(ctx, {})) + 1,
      version: 1,
      status: 'active',
    } as Partial<ActivityTypeDocument>);

    await this.record(ctx, 'activity_type.created', String(created._id), { code, categoryCode });
    return this.typeView(created);
  }

  /**
   * Change what a type says, never what it is.
   *
   * The `code` is absent from this signature on purpose. A published code is the identity
   * every activity log, ratio formula and goal target holds; changing it would not rename
   * a thing, it would silently point all of them at nothing.
   */
  async updateType(
    ctx: RequestContext,
    id: string,
    input: { label?: string; description?: string | null; categoryCode?: string },
  ): Promise<ActivityTypeView> {
    const set: Record<string, unknown> = {};
    if (input.label !== undefined) set.label = input.label.trim();
    if (input.description !== undefined) set.description = input.description?.trim() || null;
    if (input.categoryCode !== undefined) {
      const categoryCode = this.normaliseCode(input.categoryCode);
      await this.requireLiveCategory(ctx, categoryCode);
      set.categoryCode = categoryCode;
    }
    if (Object.keys(set).length === 0) throw new BadRequestException('Nothing to change.');

    const updated = await this.types.updateById(ctx, id, { $set: set, $inc: { version: 1 } });
    if (!updated) throw new NotFoundException('Activity type');
    await this.record(ctx, 'activity_type.updated', id, set);
    return this.typeView(updated);
  }

  /**
   * Reorder, by naming the whole list.
   *
   * The caller sends every id in the order it wants, and the server writes positions
   * 1..n. Sending a single "move this one to position 4" would need the server to infer
   * what happened to the rest, and two people dragging at once would interleave into an
   * order neither asked for.
   */
  async reorderTypes(ctx: RequestContext, ids: string[]): Promise<ActivityTypeView[]> {
    const live = await this.types.find(ctx, {});
    const known = new Set(live.map((t) => String(t._id)));
    if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
      throw new BadRequestException(
        'Send every activity type, once each, in the order you want them.',
      );
    }

    // Position is presentation. Nothing references it, so no version is bumped: an office
    // that dragged a row has not changed what it counts.
    await Promise.all(
      ids.map((id, index) => this.types.updateById(ctx, id, { $set: { displayOrder: index + 1 } })),
    );
    await this.record(ctx, 'activity_type.reordered', ctx.kpmId ?? '', { count: ids.length });
    return (await this.types.find(ctx, {}, { sort: { displayOrder: 1 } })).map((t) => this.typeView(t));
  }

  /** Archive, which is what this product means by delete (invariant §3). */
  async archiveType(ctx: RequestContext, id: string): Promise<ActivityTypeView> {
    const updated = await this.types.updateById(ctx, id, {
      $set: { status: 'archived', archivedAt: this.clock.now() },
      $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Activity type');
    await this.record(ctx, 'activity_type.archived', id, { code: updated.code });
    return this.typeView(updated);
  }

  async restoreType(ctx: RequestContext, id: string): Promise<ActivityTypeView> {
    const updated = await this.types.updateById(ctx, id, {
      $set: { status: 'active', archivedAt: null },
      $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Activity type');
    await this.record(ctx, 'activity_type.restored', id, { code: updated.code });
    return this.typeView(updated);
  }

  // -------------------------------------------------------------- internals

  private normaliseCode(raw: string): string {
    const code = raw.trim().toUpperCase();
    if (!CODE_SHAPE.test(code)) {
      throw new BadRequestException(
        'A code is 3–40 characters of A–Z, 0–9 and underscore, starting with a letter. '
          + 'It is permanent once saved, so it names the thing rather than describing it.',
      );
    }
    return code;
  }

  private async refuseDuplicateCategory(ctx: RequestContext, code: string): Promise<void> {
    // Archived rows count. A retired code that came back as something else would change
    // the meaning of every archived type still pointing at it.
    if (await this.categories.exists(ctx, { code })) {
      throw new BadRequestException(`This office already has a category called ${code}.`);
    }
  }

  private async refuseDuplicateType(ctx: RequestContext, code: string): Promise<void> {
    if (await this.types.exists(ctx, { code })) {
      throw new BadRequestException(`This office already has an activity type called ${code}.`);
    }
  }

  private async requireLiveCategory(ctx: RequestContext, code: string): Promise<void> {
    if (!(await this.categories.exists(ctx, { code, status: 'active' }))) {
      throw new BadRequestException(`No active category called ${code} in this office.`);
    }
  }

  private categoryView(doc: ActivityCategoryDocument): Omit<ActivityCategoryView, 'types'> {
    return {
      id: String(doc._id),
      code: doc.code,
      label: doc.label,
      displayOrder: doc.displayOrder,
      version: doc.version,
      status: doc.status,
    };
  }

  private typeView(doc: ActivityTypeDocument): ActivityTypeView {
    return {
      id: String(doc._id),
      code: doc.code,
      categoryCode: doc.categoryCode,
      label: doc.label,
      description: doc.description,
      displayOrder: doc.displayOrder,
      version: doc.version,
      status: doc.status,
    };
  }

  private async record(
    ctx: RequestContext,
    action: string,
    targetId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(ctx, {
      action,
      targetCollection: 'activityTypes',
      targetId,
      after,
    });
  }
}
