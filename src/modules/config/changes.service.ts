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
};

/** One live row, reduced to what the validate pass needs to reason about. */
interface Known {
  id: string;
  code: string;
  version: number;
  status: 'active' | 'archived';
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

    for (const c of await this.activity.list(ctx, true)) {
      categories.set(c.id, { id: c.id, code: c.code, version: c.version, status: c.status });
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

    const ladder = await this.orgLevels.ladderForOffice(ctx);
    const activeRungs = new Set(ladder.filter((l) => l.status === 'active').map((l) => l.code));

    for (const [index, op] of ops.entries()) {
      const rows = this.rowsFor(op.op, categories, types, ratios);
      const fail = (message: string, code: ErrorCodeValue = ErrorCode.VALIDATION_FAILED) => {
        throw this.atOp(index, op.op, new DomainException(code, message, HttpStatus.BAD_REQUEST));
      };

      // An op nothing handles is refused before anything is written, not skipped quietly.
      const checker = CHECKERS[op.op] as ((body: unknown) => object | void) | undefined;
      if (!checker) fail(`Unknown change ${String(op.op)}.`);

      // The body by its own rules before anything about it is believed — its code included.
      let checked: { code?: string; categoryCode?: string } = {};
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
  }

  private rowsFor(
    op: ChangeOp,
    categories: Map<string, Known>,
    types: Map<string, Known>,
    ratios: Map<string, Known>,
  ): Map<string, Known> {
    if (op.startsWith('category.')) return categories;
    if (op.startsWith('type.')) return types;
    return ratios;
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
    const handlers: Record<ChangeOp, () => Promise<unknown>> = {
      'category.create': () => this.activity.createCategory(ctx, body),
      'category.update': () => this.activity.updateCategory(ctx, id, body),
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
    return new DomainException(code, `Change ${index + 1} (${op}): ${detail}`, status);
  }
}
