import { BadRequestException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import {
  ActivityCategoryRepository, ActivityTypeRepository, RatioDefinitionRepository,
} from './activity.repository';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { ActivityCategoryDocument } from './activity-category.schema';
import { ActivityTypeDocument } from './activity-type.schema';
import {
  checkCategoryCreate, checkCategoryUpdate, checkTypeCreate, checkTypeUpdate,
} from './config-input';
import { refuseSummaryGroupConflict } from './summary-group';

/**
 * How a category write reaches the service.
 *
 * `summaryGroupsChecked` is the staged batch saying it has already checked ADR-0064's one-label
 * rule against the state the **whole batch** leaves. Renaming a two-section tile takes two ops,
 * and the state between them disagrees by construction — checked per op, no group could ever be
 * renamed.
 */
export interface CategoryWriteOptions {
  summaryGroupsChecked?: boolean;
}

export interface ActivityTypeView {
  id: string;
  code: string;
  categoryCode: string;
  label: string;
  description: string | null;
  displayOrder: number;
  version: number;
  status: 'active' | 'archived';
  /**
   * **Derived from the category, never stored on the type** (ADR-0020, P4-T18).
   *
   * Resolved here so `/kpm/config` — and therefore the published snapshot, and therefore
   * Phase 6's capture screen — carries one answer already computed. Three call sites
   * already flatten types away from their categories, and making each re-find its parent
   * would be three chances to get visibility wrong.
   *
   * A snapshot published before this existed carries the derivation of its own day. That
   * is correct: a snapshot is what was published, not what would be published now.
   */
  appliesToOrgLevelCodes: string[];
}

export interface ActivityCategoryView {
  id: string;
  code: string;
  label: string;
  description: string | null;
  /** The stored truth. Empty means every rung; it cascades to every type inside. */
  appliesToOrgLevelCodes: string[];
  /**
   * The summary tile this section counts toward, and its label (ADR-0064). `null` on both: a
   * tile of its own, under `label`. Presentation only — the strips read it, and no metric does.
   */
  summaryGroupCode: string | null;
  summaryGroupLabel: string | null;
  displayOrder: number;
  version: number;
  status: 'active' | 'archived';
  types: ActivityTypeView[];
}

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
    /*
     * The **repository**, not `RatioService` — that service already depends on this one,
     * and injecting it back would be a cycle. The cross-check only needs to read which
     * ratios name this section's types, which is a query, not a policy.
     */
    private readonly ratios: RatioDefinitionRepository,
    private readonly orgLevels: OrgLevelService,
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
        // The cascade, resolved once here so nothing downstream re-derives it.
        .map((t) => this.typeView(t, category.appliesToOrgLevelCodes)),
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
    body: {
      code: string; label: string; description?: string | null;
      appliesToOrgLevelCodes?: string[];
      summaryGroupCode?: string | null; summaryGroupLabel?: string | null;
    },
    options: CategoryWriteOptions = {},
  ): Promise<ActivityCategoryView> {
    // The body's own rules first, however it arrived — a route or the batch (ADR-0030).
    const input = checkCategoryCreate(body);
    const { code } = input;
    await this.refuseDuplicateCategory(ctx, code);
    if (!options.summaryGroupsChecked) {
      await this.refuseSummaryGroupConflict(ctx, null, input);
    }

    const created = await this.categories.create(ctx, {
      code,
      label: input.label,
      description: input.description,
      appliesToOrgLevelCodes: await this.orgLevels.checkedRungs(
        ctx, input.appliesToOrgLevelCodes, 'section',
      ),
      summaryGroupCode: input.summaryGroupCode,
      summaryGroupLabel: input.summaryGroupLabel,
      // Appended, not inserted. Somebody adding a category has not said where it goes,
      // and guessing would renumber rows they did not touch.
      displayOrder: (await this.categories.count(ctx, {})) + 1,
      version: 1,
      status: 'active',
    } as Partial<ActivityCategoryDocument>);

    await this.record(ctx, 'activity_category.created', String(created._id), { code });
    return { ...this.categoryView(created), types: [] };
  }

  /**
   * Label, description, who the section is for, and the summary tile it counts toward. **Never
   * the code** (ADR-0006).
   *
   * **Regrouping bumps the version** like any other edit (ADR-0064), so it shows on the publish
   * bar and reaches agents only when the office publishes (P4-T6). It is refused when it would
   * leave two sections of one tile with different labels.
   *
   * Narrowing `appliesToOrgLevelCodes` is checked against the ratios that count this
   * section's types: a ratio that still applies to a rung this section no longer does
   * divides by activity nobody on that rung can log, which reads on their screen as their
   * own failure. That is the defect ADR-0020 closed from the other side, and closing it
   * only at the ratio would leave the likelier door open — narrowing is the new control.
   */
  async updateCategory(
    ctx: RequestContext,
    id: string,
    body: {
      label?: string; description?: string | null; appliesToOrgLevelCodes?: string[];
      summaryGroupCode?: string | null; summaryGroupLabel?: string | null;
    },
    options: CategoryWriteOptions = {},
  ): Promise<ActivityCategoryView> {
    const input = checkCategoryUpdate(body);
    const existing = await this.categories.findById(ctx, id);
    if (!existing) throw new NotFoundException('Activity category');

    const set: Record<string, unknown> = {};
    if (input.label !== undefined) set.label = input.label;
    if (input.description !== undefined) set.description = input.description;
    if (input.appliesToOrgLevelCodes !== undefined) {
      const rungs = await this.orgLevels.checkedRungs(ctx, input.appliesToOrgLevelCodes, 'section');
      await this.refuseUnreachableInputs(ctx, existing.code, rungs);
      set.appliesToOrgLevelCodes = rungs;
    }
    // The checker has already refused one without the other, so one being present means both are.
    if (input.summaryGroupCode !== undefined) {
      const group = {
        summaryGroupCode: input.summaryGroupCode,
        summaryGroupLabel: input.summaryGroupLabel ?? null,
      };
      if (!options.summaryGroupsChecked) await this.refuseSummaryGroupConflict(ctx, id, group);
      Object.assign(set, group);
    }
    if (Object.keys(set).length === 0) throw new BadRequestException('Nothing to change.');

    const updated = await this.categories.updateById(ctx, id, {
      $set: set, $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Activity category');
    await this.record(ctx, 'activity_category.updated', id, set);
    return { ...this.categoryView(updated), types: [] };
  }

  /**
   * Archive a section, **and the types inside it**.
   *
   * A live type in a retired section would be loggable from nowhere: the capture screen
   * groups by category, so it would simply stop appearing while still counting as active
   * to every validator that asks. Cascading is the honest state, and it is reversible —
   * restoring the section leaves the types archived, because bringing back a section is
   * not the same decision as bringing back everything that was ever in it.
   *
   * Archiving is not narrowing: it produces an honest absence rather than a number with
   * nothing underneath it, so it needs no ratio cross-check. A ratio naming an archived
   * type keeps computing over the history that type already has.
   */
  async archiveCategory(ctx: RequestContext, id: string): Promise<ActivityCategoryView> {
    const at = this.clock.now();
    const updated = await this.categories.updateById(ctx, id, {
      $set: { status: 'archived', archivedAt: at }, $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Activity category');

    const cascaded = await this.types.updateMany(
      ctx,
      { categoryCode: updated.code, status: 'active' },
      { $set: { status: 'archived', archivedAt: at }, $inc: { version: 1 } },
    );
    await this.record(ctx, 'activity_category.archived', id, {
      code: updated.code, typesArchived: cascaded,
    });
    return { ...this.categoryView(updated), types: [] };
  }

  async restoreCategory(ctx: RequestContext, id: string): Promise<ActivityCategoryView> {
    const updated = await this.categories.updateById(ctx, id, {
      $set: { status: 'active', archivedAt: null }, $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Activity category');
    await this.record(ctx, 'activity_category.restored', id, { code: updated.code });
    return { ...this.categoryView(updated), types: [] };
  }

  /**
   * Reorder the sections, by naming all of them.
   *
   * Same contract as `reorderTypes` and the same reason: a single "move this to position
   * 3" would make the server infer what happened to the rest, and two people dragging at
   * once would interleave into an order neither asked for. **Bumps no version** — position
   * is presentation, and nothing reads it back (invariant §4).
   */
  async reorderCategories(ctx: RequestContext, ids: string[]): Promise<ActivityCategoryView[]> {
    const live = await this.categories.find(ctx, {});
    const known = new Set(live.map((c) => String(c._id)));
    if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
      throw new BadRequestException('Send every section, once each, in the order you want them.');
    }

    await Promise.all(
      ids.map((id, i) => this.categories.updateById(ctx, id, { $set: { displayOrder: i + 1 } })),
    );
    await this.record(ctx, 'activity_category.reordered', ctx.kpmId ?? '', { count: ids.length });
    return this.list(ctx, true);
  }

  /** Kept for the callers that only rename. */
  renameCategory(ctx: RequestContext, id: string, label: string): Promise<ActivityCategoryView> {
    return this.updateCategory(ctx, id, { label });
  }

  // ------------------------------------------------------------------ types

  async createType(
    ctx: RequestContext,
    body: { code: string; categoryCode: string; label: string; description?: string | null },
  ): Promise<ActivityTypeView> {
    const { code, categoryCode, label, description } = checkTypeCreate(body);
    await this.refuseDuplicateType(ctx, code);
    await this.requireLiveCategory(ctx, categoryCode);

    const created = await this.types.create(ctx, {
      code,
      categoryCode,
      label,
      description,
      displayOrder: (await this.types.count(ctx, {})) + 1,
      version: 1,
      status: 'active',
    } as Partial<ActivityTypeDocument>);

    await this.record(ctx, 'activity_type.created', String(created._id), { code, categoryCode });
    return this.typeView(created, await this.rungsOf(ctx, created.categoryCode));
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
    body: { label?: string; description?: string | null; categoryCode?: string },
  ): Promise<ActivityTypeView> {
    const input = checkTypeUpdate(body);
    const set: Record<string, unknown> = {};
    if (input.label !== undefined) set.label = input.label;
    if (input.description !== undefined) set.description = input.description;
    if (input.categoryCode !== undefined) {
      await this.requireLiveCategory(ctx, input.categoryCode);
      set.categoryCode = input.categoryCode;
    }
    if (Object.keys(set).length === 0) throw new BadRequestException('Nothing to change.');

    const updated = await this.types.updateById(ctx, id, { $set: set, $inc: { version: 1 } });
    if (!updated) throw new NotFoundException('Activity type');
    await this.record(ctx, 'activity_type.updated', id, set);
    return this.typeView(updated, await this.rungsOf(ctx, updated.categoryCode));
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
    const categories = await this.categories.find(ctx, {});
    const rungs = new Map(categories.map((c) => [c.code, c.appliesToOrgLevelCodes]));
    return (await this.types.find(ctx, {}, { sort: { displayOrder: 1 } }))
      .map((t) => this.typeView(t, rungs.get(t.categoryCode) ?? []));
  }

  /** Archive, which is what this product means by delete (invariant §3). */
  async archiveType(ctx: RequestContext, id: string): Promise<ActivityTypeView> {
    const updated = await this.types.updateById(ctx, id, {
      $set: { status: 'archived', archivedAt: this.clock.now() },
      $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Activity type');
    await this.record(ctx, 'activity_type.archived', id, { code: updated.code });
    return this.typeView(updated, await this.rungsOf(ctx, updated.categoryCode));
  }

  async restoreType(ctx: RequestContext, id: string): Promise<ActivityTypeView> {
    const updated = await this.types.updateById(ctx, id, {
      $set: { status: 'active', archivedAt: null },
      $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Activity type');
    await this.record(ctx, 'activity_type.restored', id, { code: updated.code });
    return this.typeView(updated, await this.rungsOf(ctx, updated.categoryCode));
  }

  // -------------------------------------------------------------- internals

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

  /**
   * ADR-0064's tile rules — one label, and a shared tile's code no section outside it carries —
   * over every section this office holds **once this write lands**, archived ones included,
   * because an archived section still renders the days it holds.
   *
   * `replacing` is the row being edited, or `null` for a new one, whose `code` the group carries.
   */
  private async refuseSummaryGroupConflict(
    ctx: RequestContext,
    replacing: string | null,
    group: { code?: string; summaryGroupCode: string | null; summaryGroupLabel: string | null },
  ): Promise<void> {
    // Leaving a tile disagrees with nobody, and an edit never changes a code. A new section is
    // checked even outside every tile: its code may be a shared tile's.
    if (!group.summaryGroupCode && replacing !== null) return;
    // In display order, the edited row in its own place and a new one last — the order the batch's
    // projection holds, so a refusal lists the labels alike on either path.
    const rows = (await this.categories.find(ctx, {}, { sort: { displayOrder: 1 } }))
      .map((c) => (String(c._id) === replacing
        ? { ...group, code: c.code }
        : { code: c.code, summaryGroupCode: c.summaryGroupCode, summaryGroupLabel: c.summaryGroupLabel }));
    refuseSummaryGroupConflict(replacing === null ? [...rows, group] : rows);
  }

  private categoryView(doc: ActivityCategoryDocument): Omit<ActivityCategoryView, 'types'> {
    return {
      id: String(doc._id),
      code: doc.code,
      label: doc.label,
      description: doc.description,
      appliesToOrgLevelCodes: doc.appliesToOrgLevelCodes,
      // `?? null`: a row written before the field existed has no key at all (migration 0021
      // writes one, and a read before it runs still answers in one shape).
      summaryGroupCode: doc.summaryGroupCode ?? null,
      summaryGroupLabel: doc.summaryGroupLabel ?? null,
      displayOrder: doc.displayOrder,
      version: doc.version,
      status: doc.status,
    };
  }

  /**
   * Refuse a narrowing that would leave a ratio dividing by activity nobody can log.
   *
   * With `effective(X) = X.length ? X : every active rung`, a ratio counting this
   * section's types must satisfy `effective(section) ⊇ effective(ratio)`. The case a
   * naive check misses is **ratio empty, section narrowed**: "empty" reads as
   * unconstrained on both sides, and an unconstrained ratio over a narrowed section is
   * exactly the permanent-alert defect ADR-0020 closed — an agent reading a figure with
   * nothing underneath it, marked as their failure.
   *
   * Names the ratios, because "this would break a ratio" sends an Owner to read all six.
   */
  private async refuseUnreachableInputs(
    ctx: RequestContext, categoryCode: string, rungs: string[],
  ): Promise<void> {
    if (rungs.length === 0) return; // Widening to everyone can break nothing.

    const mine = new Set(
      (await this.types.find(ctx, { categoryCode, status: 'active' })).map((t) => t.code),
    );
    if (mine.size === 0) return;

    const ladder = await this.orgLevels.ladderForOffice(ctx);
    const everyRung = ladder.filter((l) => l.status === 'active').map((l) => l.code);
    const section = new Set(rungs);

    const broken: string[] = [];
    for (const ratio of await this.ratios.find(ctx, { status: 'active' })) {
      const counts = [...ratio.numerator, ...ratio.denominator].some((c) => mine.has(c));
      if (!counts) continue;
      const applies = ratio.appliesToOrgLevelCodes.length
        ? ratio.appliesToOrgLevelCodes
        : everyRung;
      if (applies.some((r) => !section.has(r))) broken.push(ratio.code);
    }

    if (broken.length) {
      throw new DomainException(
        ErrorCode.CONFIG_RATIO_UNREACHABLE_INPUT,
        `${broken.join(', ')} counts activity in this section, and applies to rungs the `
          + 'section would no longer be shown to. Those agents would be measured on '
          + 'something they cannot log. Narrow the ratio first, or widen the section.',
        HttpStatus.BAD_REQUEST,
        { ratios: broken },
      );
    }
  }

  /**
   * The rungs a type inherits, read from its category.
   *
   * A lookup per returned row would be wrong in a list; `list()` therefore resolves the
   * cascade itself and this exists for the single-row paths, where one extra read is
   * cheaper than making every caller remember the rule.
   */
  private async rungsOf(ctx: RequestContext, categoryCode: string): Promise<string[]> {
    const [category] = await this.categories.find(ctx, { code: categoryCode });
    return category?.appliesToOrgLevelCodes ?? [];
  }

  /** `appliesToOrgLevelCodes` comes from the category — the type never stores its own. */
  private typeView(doc: ActivityTypeDocument, categoryRungs: string[]): ActivityTypeView {
    return {
      id: String(doc._id),
      code: doc.code,
      categoryCode: doc.categoryCode,
      label: doc.label,
      description: doc.description,
      appliesToOrgLevelCodes: categoryRungs,
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
