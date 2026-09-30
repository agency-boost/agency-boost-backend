import { HttpStatus, Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import type { ErrorCodeValue } from '@/common/errors/error-codes';
import { ErrorCode } from '@/common/errors/error-codes';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { ActivityConfigService } from './activity.service';
import { resolveDisplayUnit, type RatioDisplayUnit } from '@/domain/constants';
import { RatioService } from './ratio.service';
import { TenantConfigService, type TenantConfigView } from './tenant-config.service';
import type { ChangeOp, ConfigChangeDto } from './changes.dto';
import {
  checkCategoryCreate, checkCategoryUpdate, checkNoFields, checkRatioCreate, checkRatioUpdate,
  checkTypeCreate, checkTypeUpdate,
} from './config-input';
import { TrainingService } from '@/modules/training/training.service';
import { refuseSummaryGroupConflict, type SummaryGrouped } from './summary-group';
import {
  checkTrainingCategoryCreate, checkTrainingCategoryUpdate, checkTrainingModuleCreate,
  checkTrainingModuleUpdate, checkTrainingSkillCreate, checkTrainingSkillUpdate,
} from '@/modules/training/training-input';

/**
 * Each op's own field rules — the checker its service runs (ADR-0030).
 *
 * Run by the validate pass as well as by the service, and that is the point: a body refused
 * only when its service applies it is refused after the ops before it have been written.
 */
const CHECKERS: Record<ChangeOp, (body: unknown) => object | void> = {
  'category.create': checkCategoryCreate,
  'category.update': checkCategoryUpdate,
  'category.archive': checkNoFields,
  'category.restore': checkNoFields,
  'type.create': checkTypeCreate,
  'type.update': checkTypeUpdate,
  'type.archive': checkNoFields,
  'type.restore': checkNoFields,
  'ratio.create': checkRatioCreate,
  'ratio.update': checkRatioUpdate,
  'ratio.archive': checkNoFields,
  'ratio.restore': checkNoFields,
  'trainingCategory.create': checkTrainingCategoryCreate,
  'trainingCategory.update': checkTrainingCategoryUpdate,
  'trainingCategory.archive': checkNoFields,
  'trainingCategory.restore': checkNoFields,
  'trainingSkill.create': checkTrainingSkillCreate,
  'trainingSkill.update': checkTrainingSkillUpdate,
  'trainingSkill.archive': checkNoFields,
  'trainingSkill.restore': checkNoFields,
  'trainingModule.create': checkTrainingModuleCreate,
  'trainingModule.update': checkTrainingModuleUpdate,
  'trainingModule.archive': checkNoFields,
  'trainingModule.restore': checkNoFields,
};

/** What a checked body may say about where a row sits. */
interface Checked {
  code?: string;
  categoryCode?: string;
  skillCode?: string;
  summaryGroupCode?: string | null;
  summaryGroupLabel?: string | null;
}

/** One live row, reduced to what the validate pass needs to reason about. */
interface Known {
  id: string;
  code: string;
  version: number;
  status: 'active' | 'archived';
  /** A training skill's category code, or a training module's skill code. */
  parent?: string;
}

/**
 * Apply a batch of stated changes, or none of them (P4-T19).
 *
 * **Why a batch at all.** The settings screens used to write on every keystroke's Save, so
 * an Owner restructuring a taxonomy walked through states their own office was briefly in.
 * The publish gate hid that from *agents*; it never hid it from the Owner, and it could not
 * hide a half-finished restructure from the next admin to open the screen. Now the screen
 * stages edits and sends one request.
 *
 * **Validate everything, then write.** The two things that make this worth doing are both
 * in the validate pass:
 *
 * - an op that refuses leaves the office **exactly** as it was, so an Owner never has to
 *   work out which half of their change landed;
 * - `type.create` can name a category `category.create` makes three ops earlier, because
 *   validation runs against a *projection* — the live rows with the earlier ops folded in
 *   — rather than against the database.
 *
 * **What the projection checks, and what it does not.** Every op's own field rules first —
 * lengths, ranges, types, unknown fields — through the checker its service runs (ADR-0030).
 * Then the things only a batch can get wrong: a stale `expectedVersion`, a code that
 * collides with a live row *or with an earlier op in the same batch*, a `categoryCode`
 * naming nothing, a rung the company does not have. Rules that need more of the database
 * than the projection holds stay in the service that owns them, and are checked as it is
 * applied.
 *
 * That leaves a residual: a rule this pass does not model could refuse op *n* after ops
 * `1..n-1` are written. It is rare by construction (the pass models every refusal these
 * screens can produce) and recoverable (nothing has reached agents — publishing is still a
 * separate act). A transaction would close it and needs a replica set the test suite does
 * not have; that is the trade, written down rather than discovered.
 */
@Injectable()
export class ConfigChangeService {
  constructor(
    private readonly activity: ActivityConfigService,
    private readonly ratios: RatioService,
    private readonly config: TenantConfigService,
    private readonly orgLevels: OrgLevelService,
    private readonly training: TrainingService,
  ) {}

  async apply(ctx: RequestContext, ops: ConfigChangeDto[]): Promise<TenantConfigView> {
    await this.validate(ctx, ops);
    for (const [index, op] of ops.entries()) {
      try {
        await this.run(ctx, op);
      } catch (err) {
        // Name the op. "Nothing to change" on its own leaves an Owner scanning a form.
        throw this.atOp(index, op.op, err);
      }
    }
    return this.config.read(ctx);
  }

  // ------------------------------------------------------------------ validate

  private async validate(ctx: RequestContext, ops: ConfigChangeDto[]): Promise<void> {
    const categories = new Map<string, Known>();
    const types = new Map<string, Known>();
    const ratios = new Map<string, Known>();
    /*
     * Each section's summary tile (ADR-0064), archived sections included, projected through the
     * batch and checked once at the end: renaming a two-section tile takes two ops, and the state
     * between them disagrees by construction.
     */
    const groups = new Map<string, SummaryGrouped>();
    /** The last op to touch each tile — the one a refusal names. */
    const groupTouchedBy = new Map<string, number>();

    for (const c of await this.activity.list(ctx, true)) {
      categories.set(c.id, { id: c.id, code: c.code, version: c.version, status: c.status });
      groups.set(c.id, { summaryGroupCode: c.summaryGroupCode, summaryGroupLabel: c.summaryGroupLabel });
      for (const t of c.types) {
        types.set(t.id, { id: t.id, code: t.code, version: t.version, status: t.status });
      }
    }
    /* The rule and unit each ratio holds, so a unit that no longer fits is refused here. */
    const ratioShapes = new Map<string, { comparison: 'gte' | 'band'; displayUnit: RatioDisplayUnit }>();
    for (const r of await this.ratios.list(ctx, true)) {
      ratios.set(r.id, { id: r.id, code: r.code, version: r.version, status: r.status });
      ratioShapes.set(r.id, { comparison: r.comparison, displayUnit: r.displayUnit });
    }

    /* The training tree (P5-T1), with each row's parent, so the tree's own rules hold here too. */
    const trainingCategories = new Map<string, Known>();
    const trainingSkills = new Map<string, Known>();
    const trainingModules = new Map<string, Known>();
    for (const c of await this.training.list(ctx, true)) {
      trainingCategories.set(c.id, { id: c.id, code: c.code, version: c.version, status: c.status });
      for (const s of c.skills) {
        trainingSkills.set(s.id, {
          id: s.id, code: s.code, version: s.version, status: s.status, parent: s.categoryCode,
        });
        for (const m of s.modules) {
          trainingModules.set(m.id, {
            id: m.id, code: m.code, version: m.version, status: m.status, parent: m.skillCode,
          });
        }
      }
    }
    const tree = { categories: trainingCategories, skills: trainingSkills, modules: trainingModules };

    const ladder = await this.orgLevels.ladderForOffice(ctx);
    const activeRungs = new Set(ladder.filter((l) => l.status === 'active').map((l) => l.code));

    const rowsByKind: Record<string, Map<string, Known>> = {
      category: categories,
      type: types,
      ratio: ratios,
      trainingCategory: trainingCategories,
      trainingSkill: trainingSkills,
      trainingModule: trainingModules,
    };

    for (const [index, op] of ops.entries()) {
      const rows = rowsByKind[op.op.split('.')[0]];
      const fail = (message: string, code: ErrorCodeValue = ErrorCode.VALIDATION_FAILED) => {
        throw this.atOp(index, op.op, new DomainException(code, message, HttpStatus.BAD_REQUEST));
      };

      // An op nothing handles is refused before anything is written, not skipped quietly.
      const checker = CHECKERS[op.op] as ((body: unknown) => object | void) | undefined;
      if (!checker) fail(`Unknown change ${String(op.op)}.`);

      // The body by its own rules before anything about it is believed — its code included.
      let checked: Checked = {};
      try {
        checked = (checker!(op.body) ?? {}) as typeof checked;
      } catch (err) {
        throw this.atOp(index, op.op, err);
      }

      if (op.op.endsWith('.create')) {
        const code = checked.code!;
        // Counting archived rows, and counting earlier ops: a code is never reused once
        // published (ADR-0006), and two creates in one batch must not collide either.
        if ([...rows.values()].some((r) => r.code === code)) {
          fail(`${code} is already in use in this office. A code is never reused.`);
        }
        rows.set(`pending:${index}`, { id: `pending:${index}`, code, version: 1, status: 'active' });

        if (op.op === 'type.create') {
          const parent = checked.categoryCode!;
          if (![...categories.values()].some((c) => c.code === parent && c.status === 'active')) {
            fail(`No active section called ${parent}. Add the section first, or check the code.`);
          }
        }
      } else {
        const row = op.id ? rows.get(op.id) : undefined;
        if (!row) {
          /*
           * **404, the way every single-operation route answers this** — and `fail` cannot
           * produce one, because it fixes the status at `400`.
           *
           * The projection above is built from `ctx`-scoped reads, so an id belonging to
           * another office lands in exactly this branch. Answering `400` told that caller
           * their request was malformed, when what is true is that the row is not theirs —
           * a different question, and the one `NotFoundException` exists to answer without
           * confirming the id exists somewhere (ADR-0002).
           */
          throw this.atOp(index, op.op, new NotFoundException('That row'));
        }
        if (op.expectedVersion === undefined) {
          fail('Every change to an existing row must say which version it was read at.');
        }
        if (row!.version !== op.expectedVersion) {
          throw this.atOp(index, op.op, new DomainException(
            ErrorCode.VERSION_CONFLICT,
            `${row!.code} changed while you were editing — it is now version `
              + `${row!.version} and you read version ${op.expectedVersion}. Reload to see `
              + 'what somebody else did, then make your change again.',
            HttpStatus.CONFLICT,
          ));
        }
        // The projection moves on, so two ops against one row in a batch both hold.
        row!.version += 1;
        if (op.op.endsWith('.archive')) row!.status = 'archived';
        if (op.op.endsWith('.restore')) row!.status = 'active';

      }

      if (op.op.startsWith('training')) this.projectTraining(op, index, checked, tree, fail);

      if (op.op === 'category.create' || op.op === 'category.update') {
        const key = op.op === 'category.create' ? `pending:${index}` : op.id!;
        // A checked update carries both or neither, so `undefined` means the tile is untouched.
        if (checked.summaryGroupCode !== undefined) {
          const before = groups.get(key)?.summaryGroupCode;
          groups.set(key, {
            summaryGroupCode: checked.summaryGroupCode,
            summaryGroupLabel: checked.summaryGroupLabel ?? null,
          });
          for (const code of [before, checked.summaryGroupCode]) if (code) groupTouchedBy.set(code, index);
        }
      }

      /*
       * The display unit against the rule it will sit under (P4-T25), in the projection like
       * every other refusal — so a batch that sets `percent` on a band ratio is refused
       * before its earlier ops are written, not halfway through applying them.
       */
      if (op.op === 'ratio.create' || op.op === 'ratio.update') {
        const shape = op.id ? ratioShapes.get(op.id) : undefined;
        const comparison = op.body?.comparison ?? shape?.comparison;
        const requested = op.body?.displayUnit;
        const touched = op.op === 'ratio.create'
          || requested !== undefined || op.body?.comparison !== undefined;
        if (touched && (comparison === 'gte' || comparison === 'band')) {
          const resolved = resolveDisplayUnit(
            comparison,
            requested === undefined ? undefined : String(requested),
            shape?.displayUnit,
          );
          if (resolved.refusal !== undefined) {
            fail(resolved.refusal, ErrorCode.CONFIG_RATIO_UNIT_MISMATCH);
          } else if (shape) {
            ratioShapes.set(op.id!, { comparison, displayUnit: resolved.unit });
          }
        }
      }

      const rungs = op.body?.appliesToOrgLevelCodes;
      if (Array.isArray(rungs)) {
        const unknown = rungs
          .map((r) => String(r).trim().toUpperCase())
          .filter((r) => !activeRungs.has(r));
        if (unknown.length) {
          fail(
            `${unknown.join(', ')} is not an active rung on your company’s ladder.`,
            ErrorCode.CONFIG_RUNG_UNKNOWN,
          );
        }
      }
    }

    /*
     * One tile, one label — over the state the whole batch leaves, before anything is written.
     * Named for the last op that touched the tile, since that is the edit that left it split.
     */
    try {
      refuseSummaryGroupConflict([...groups.values()]);
    } catch (err) {
      const code = (err as { details?: { summaryGroupCode?: string } }).details?.summaryGroupCode ?? '';
      const index = groupTouchedBy.get(code) ?? ops.length - 1;
      throw this.atOp(index, ops[index].op, err);
    }
  }

  /**
   * The training tree's own rules, in the projection (P5-T1) — so a batch that breaks one is
   * refused before its earlier ops are written, like every other refusal here.
   *
   * - A skill needs an active category, and a module an active skill — **counting ops earlier
   *   in the batch**, so a module may name a skill created three ops before it.
   * - Nothing is restored under an archived parent.
   * - An archive reaches down, so a later op cannot create or restore under what it retired.
   *
   * The row itself — its code, its version, its own status — the loop above has already moved.
   */
  private projectTraining(
    op: ConfigChangeDto,
    index: number,
    checked: Checked,
    tree: { categories: Map<string, Known>; skills: Map<string, Known>; modules: Map<string, Known> },
    fail: (message: string) => never,
  ): void {
    const active = (rows: Map<string, Known>, code: string) =>
      [...rows.values()].some((r) => r.code === code && r.status === 'active');
    // An existing row always has an id here: the loop above answered 404 for one without.
    const row = op.op.endsWith('.create') ? undefined : this.rowIn(op.op, op.id!, tree);
    const pending = (rows: Map<string, Known>) => rows.get(`pending:${index}`)!;

    switch (op.op) {
      case 'trainingSkill.create':
        if (!active(tree.categories, checked.categoryCode!)) {
          fail(`No active training category called ${checked.categoryCode}. Add it first, or check the code.`);
        }
        pending(tree.skills).parent = checked.categoryCode;
        return;
      case 'trainingModule.create':
        if (!active(tree.skills, checked.skillCode!)) {
          fail(`No active training skill called ${checked.skillCode}. Add it first, or check the code.`);
        }
        pending(tree.modules).parent = checked.skillCode;
        return;
      case 'trainingSkill.update':
        if (checked.categoryCode !== undefined && checked.categoryCode !== row!.parent) {
          if (!active(tree.categories, checked.categoryCode)) {
            fail(`No active training category called ${checked.categoryCode} to move ${row!.code} into.`);
          }
          row!.parent = checked.categoryCode;
        }
        return;
      case 'trainingModule.update':
        if (checked.skillCode !== undefined && checked.skillCode !== row!.parent) {
          if (!active(tree.skills, checked.skillCode)) {
            fail(`No active training skill called ${checked.skillCode} to move ${row!.code} under.`);
          }
          row!.parent = checked.skillCode;
        }
        return;
      case 'trainingSkill.restore':
        if (!active(tree.categories, row!.parent!)) {
          fail(`${row!.code} is in ${row!.parent}, which is archived. Restore the category first.`);
        }
        return;
      case 'trainingModule.restore':
        if (!active(tree.skills, row!.parent!)) {
          fail(`${row!.code} teaches ${row!.parent}, which is archived. Restore the skill first.`);
        }
        return;
      case 'trainingCategory.archive': {
        const skills = [...tree.skills.values()].filter((s) => s.parent === row!.code);
        for (const skill of skills) skill.status = 'archived';
        const codes = new Set(skills.map((s) => s.code));
        for (const module of tree.modules.values()) {
          if (codes.has(module.parent!)) module.status = 'archived';
        }
        return;
      }
      case 'trainingSkill.archive':
        for (const module of tree.modules.values()) {
          if (module.parent === row!.code) module.status = 'archived';
        }
        return;
      default:
        // Category creates, updates and restores, and module archives: nothing about the tree's
        // shape changes beyond the row itself.
        return;
    }
  }

  /** An existing training row, by the level its op names. */
  private rowIn(
    op: string,
    id: string,
    tree: { categories: Map<string, Known>; skills: Map<string, Known>; modules: Map<string, Known> },
  ): Known | undefined {
    if (op.startsWith('trainingSkill.')) return tree.skills.get(id);
    if (op.startsWith('trainingModule.')) return tree.modules.get(id);
    return tree.categories.get(id);
  }

  // --------------------------------------------------------------------- apply

  /**
   * Each op hands off to the service that owns the rule, unchanged.
   *
   * A table rather than a switch, and with no default: the validate pass has already refused
   * any op without a checker, and `Record<ChangeOp, …>` makes a new op without a handler a
   * compile error rather than a branch nothing can reach.
   */
  private async run(ctx: RequestContext, op: ConfigChangeDto): Promise<void> {
    const body = (op.body ?? {}) as never;
    const id = op.id ?? '';
    // The validate pass checked every tile against the state the whole batch leaves (ADR-0064).
    const grouped = { summaryGroupsChecked: true };
    const handlers: Record<ChangeOp, () => Promise<unknown>> = {
      'category.create': () => this.activity.createCategory(ctx, body, grouped),
      'category.update': () => this.activity.updateCategory(ctx, id, body, grouped),
      'category.archive': () => this.activity.archiveCategory(ctx, id),
      'category.restore': () => this.activity.restoreCategory(ctx, id),
      'type.create': () => this.activity.createType(ctx, body),
      'type.update': () => this.activity.updateType(ctx, id, body),
      'type.archive': () => this.activity.archiveType(ctx, id),
      'type.restore': () => this.activity.restoreType(ctx, id),
      'ratio.create': () => this.ratios.create(ctx, body),
      'ratio.update': () => this.ratios.update(ctx, id, body),
      'ratio.archive': () => this.ratios.archive(ctx, id),
      'ratio.restore': () => this.ratios.restore(ctx, id),
      'trainingCategory.create': () => this.training.createCategory(ctx, body),
      'trainingCategory.update': () => this.training.updateCategory(ctx, id, body),
      'trainingCategory.archive': () => this.training.archiveCategory(ctx, id),
      'trainingCategory.restore': () => this.training.restoreCategory(ctx, id),
      'trainingSkill.create': () => this.training.createSkill(ctx, body),
      'trainingSkill.update': () => this.training.updateSkill(ctx, id, body),
      'trainingSkill.archive': () => this.training.archiveSkill(ctx, id),
      'trainingSkill.restore': () => this.training.restoreSkill(ctx, id),
      'trainingModule.create': () => this.training.createModule(ctx, body),
      'trainingModule.update': () => this.training.updateModule(ctx, id, body),
      'trainingModule.archive': () => this.training.archiveModule(ctx, id),
      'trainingModule.restore': () => this.training.restoreModule(ctx, id),
    };
    await handlers[op.op]();
  }

  /**
   * Say which op failed, and keep the original message.
   *
   * A batch of twenty edits reporting only *"Nothing to change"* sends an Owner to read
   * their own form looking for which row meant it.
   */
  private atOp(index: number, op: ChangeOp, err: unknown): unknown {
    const detail = err instanceof Error ? err.message : String(err);
    const code = err instanceof DomainException ? err.code : ErrorCode.VALIDATION_FAILED;
    const status = err instanceof DomainException ? err.getStatus() : HttpStatus.BAD_REQUEST;
    // The details travel with the refusal: a mismatched tile names its code and its labels
    // (ADR-0064), and a screen pointing at the field needs them as much as a single route's does.
    const details = err instanceof DomainException ? err.details : undefined;
    return new DomainException(code, `Change ${index + 1} (${op}): ${detail}`, status, details);
  }
}
