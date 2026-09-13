import { HttpStatus, Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import type { ErrorCodeValue } from '@/common/errors/error-codes';
import { ErrorCode } from '@/common/errors/error-codes';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { ActivityConfigService } from './activity.service';
import { RatioService } from './ratio.service';
import { TenantConfigService, type TenantConfigView } from './tenant-config.service';
import type { ChangeOp, ConfigChangeDto } from './changes.dto';

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
 * **What the projection checks, and what it does not.** It checks the things only a batch
 * can get wrong: a stale `expectedVersion`, a code that collides with a live row *or with
 * an earlier op in the same batch*, a `categoryCode` naming nothing, a rung the company
 * does not have, a formula change on a platform ratio. Each op's own remaining rules stay
 * in the service that owns them — one rule, one place — and are checked as it is applied.
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
    for (const r of await this.ratios.list(ctx, true)) {
      ratios.set(r.id, { id: r.id, code: r.code, version: r.version, status: r.status });
    }
    const platformRatios = new Set(
      (await this.ratios.list(ctx, true)).filter((r) => r.origin === 'platform').map((r) => r.id),
    );

    const ladder = await this.orgLevels.ladderForOffice(ctx);
    const activeRungs = new Set(ladder.filter((l) => l.status === 'active').map((l) => l.code));

    for (const [index, op] of ops.entries()) {
      const rows = this.rowsFor(op.op, categories, types, ratios);
      const fail = (message: string, code: ErrorCodeValue = ErrorCode.VALIDATION_FAILED) => {
        throw this.atOp(index, op.op, new DomainException(code, message, HttpStatus.BAD_REQUEST));
      };

      if (op.op.endsWith('.create')) {
        const code = String(op.body?.code ?? '').trim().toUpperCase();
        if (!code) fail('A create needs a code.');
        // Counting archived rows, and counting earlier ops: a code is never reused once
        // published (ADR-0006), and two creates in one batch must not collide either.
        if ([...rows.values()].some((r) => r.code === code)) {
          fail(`${code} is already in use in this office. A code is never reused.`);
        }
        rows.set(`pending:${index}`, { id: `pending:${index}`, code, version: 1, status: 'active' });

        if (op.op === 'type.create') {
          const parent = String(op.body?.categoryCode ?? '').trim().toUpperCase();
          if (![...categories.values()].some((c) => c.code === parent && c.status === 'active')) {
            fail(`No active section called ${parent}. Add the section first, or check the code.`);
          }
        }
      } else {
        const row = op.id ? rows.get(op.id) : undefined;
        if (!row) fail('That row is not in this office.', ErrorCode.NOT_FOUND);
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

        if (op.op === 'ratio.update' && platformRatios.has(op.id!)
          && (op.body?.numerator !== undefined || op.body?.denominator !== undefined)) {
          fail(
            `${row!.code} is one of the five ratios every office measures the same way, so `
              + 'its formula is fixed. Its benchmark, label and who it applies to are yours.',
            ErrorCode.CONFIG_RATIO_FORMULA_FIXED,
          );
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

  /** Each op hands off to the service that owns the rule, unchanged. */
  private async run(ctx: RequestContext, op: ConfigChangeDto): Promise<void> {
    const body = (op.body ?? {}) as never;
    const id = op.id ?? '';
    switch (op.op) {
      case 'category.create': await this.activity.createCategory(ctx, body); return;
      case 'category.update': await this.activity.updateCategory(ctx, id, body); return;
      case 'category.archive': await this.activity.archiveCategory(ctx, id); return;
      case 'category.restore': await this.activity.restoreCategory(ctx, id); return;
      case 'type.create': await this.activity.createType(ctx, body); return;
      case 'type.update': await this.activity.updateType(ctx, id, body); return;
      case 'type.archive': await this.activity.archiveType(ctx, id); return;
      case 'type.restore': await this.activity.restoreType(ctx, id); return;
      case 'ratio.create': await this.ratios.create(ctx, body); return;
      case 'ratio.update': await this.ratios.update(ctx, id, body); return;
      case 'ratio.archive': await this.ratios.archive(ctx, id); return;
      case 'ratio.restore': await this.ratios.restore(ctx, id); return;
      default: throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        `Unknown change ${String(op.op)}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
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
