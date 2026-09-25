import {
  Document, FilterQuery, Model, PipelineStage, QueryOptions, UpdateQuery, isValidObjectId,
} from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from './tenant-scope.error';

/**
 * The single chokepoint for tenant isolation.
 *
 * Services receive a repository, never a Mongoose model. Every filter and every write
 * has `kpmId` injected from the request context, so application code *cannot* forget
 * it — which is the point, because forgetting it once is a cross-tenant leak and there
 * is no database-level second line of defence (ADR-0002).
 *
 * Soft delete is also applied here: `deletedAt: null` is part of the default filter, so
 * a caller has to opt in to seeing deleted rows. Nothing is ever hard-deleted
 * (.claude/rules/domain-invariants.md §6).
 */
/**
 * Is there an `_id` in this filter that cannot match anything?
 *
 * Only **conjunctive** positions count — the top level and `$and` branches — because
 * those are the ones where a malformed id proves the whole query matches nothing. A
 * malformed id inside `$or` proves only that one branch is dead, and answering `null` for
 * the whole query would be wrong.
 *
 * It recurses because the person page reads through `$and: [{ _id }, visibility]`: the
 * visibility narrowing for `own` is `{ _id: self }`, which collides with the requested id
 * when spread, so the id had to move inside `$and` — and a guard that only read the top
 * level stopped seeing it. That regression was caught by the tenancy suite, which is the
 * argument for it living here rather than in each caller.
 */
function hasUnmatchableId(filter: unknown): boolean {
  if (filter === null || typeof filter !== 'object') return false;
  const node = filter as Record<string, unknown>;
  const id = node._id;
  if (typeof id === 'string' && !isValidObjectId(id)) return true;
  const and = node.$and;
  return Array.isArray(and) && and.some((branch) => hasUnmatchableId(branch));
}

export abstract class TenantScopedRepository<T extends Document> {
  protected constructor(
    protected readonly model: Model<T>,
    protected readonly collectionName: string,
  ) {}

  /** Resolve the tenant, or fail closed. */
  private requireKpmId(ctx: RequestContext, operation: string): string {
    const kpmId = ctx.kpmId;
    if (!kpmId) {
      throw new MissingTenantContextError(this.collectionName, operation);
    }
    return kpmId;
  }

  /**
   * Every read and write goes through here. `includeDeleted` is opt-in and rare —
   * an audit view, or an erasure job.
   */
  protected scope(
    ctx: RequestContext,
    operation: string,
    filter: FilterQuery<T> = {},
    includeDeleted = false,
  ): FilterQuery<T> {
    const scoped: Record<string, unknown> = {
      ...filter,
      kpmId: this.requireKpmId(ctx, operation),
    };
    if (!includeDeleted) {
      scoped.deletedAt = null;
    }
    return scoped as FilterQuery<T>;
  }

  async findById(ctx: RequestContext, id: string): Promise<T | null> {
    /**
     * A malformed id is **nothing found**, not a server fault.
     *
     * Every one of these ids arrives from a URL. Without this, Mongoose throws a
     * `CastError`, which is neither a `DomainException` nor an `HttpException` and so
     * renders as `500 INTERNAL_ERROR`, logged as unhandled — for somebody who typed a
     * character wrong. Two services had already noticed and were catching it locally
     * (`GroupService.find`, `NotificationService.markRead`); doing it once here is the
     * point of having one chokepoint.
     */
    // **Scope first.** Failing closed is the design, and it must not depend on the shape
    // of the id: a malformed id with no tenant context still has to throw, or the check
    // that proves this repository never queries unscoped can be skipped by typing a bad
    // character. The tenancy suite catches this exact ordering.
    const scoped = this.scope(ctx, 'findById', { _id: id } as FilterQuery<T>);
    if (!isValidObjectId(id)) return null;
    return this.model.findOne(scoped).exec();
  }

  async findOne(ctx: RequestContext, filter: FilterQuery<T> = {}): Promise<T | null> {
    const scoped = this.scope(ctx, 'findOne', filter);
    // `findOne({ $and: [{ _id }, visibility] })` is how the person page reads, so this is
    // as URL-facing as `findById` and needs the same answer: a malformed id is nothing
    // found, not a `CastError` rendered as 500 for somebody who mistyped a character.
    if (hasUnmatchableId(filter)) return null;
    return this.model.findOne(scoped).exec();
  }

  async find(
    ctx: RequestContext,
    filter: FilterQuery<T> = {},
    options: QueryOptions<T> = {},
  ): Promise<T[]> {
    return this.model.find(this.scope(ctx, 'find', filter), null, options).exec();
  }

  async count(ctx: RequestContext, filter: FilterQuery<T> = {}): Promise<number> {
    return this.model.countDocuments(this.scope(ctx, 'count', filter)).exec();
  }

  /**
   * A rollup, with the tenant injected into the pipeline's **first** stage.
   *
   * **The first stage is replaced, not prepended to.** A caller passes `[{ $match: … }, …]` and
   * that match is merged with `kpmId` and `deletedAt`, so a pipeline cannot begin by reading the
   * whole collection and narrowing afterwards — which would be a cross-tenant read that happens to
   * return the right answer, and the reason invariant §1 says queries go through here at all. A
   * pipeline whose first stage is anything else is refused rather than quietly scoped, because
   * *where* the scope lands changes the plan as well as the result.
   *
   * `raw-writes.tenancy.spec.ts` is what stops the model being reached around instead.
   */
  async aggregate(
    ctx: RequestContext,
    pipeline: Record<string, unknown>[],
    includeDeleted = false,
  ): Promise<Record<string, unknown>[]> {
    const [first, ...rest] = pipeline;
    if (!first || !('$match' in first)) {
      throw new Error(
        `${this.collectionName}: an aggregation must begin with $match, so the tenant scope is `
        + 'the first thing the plan applies.',
      );
    }
    const scoped = this.scope(
      ctx, 'aggregate', first.$match as FilterQuery<T>, includeDeleted,
    );
    return this.model
      .aggregate([{ $match: scoped }, ...rest] as unknown as PipelineStage[])
      .exec();
  }

  /**
   * Create the row matching `filter`, or update it if it is there — **one round trip**.
   *
   * The shape a read-then-write gets wrong. Two saves genuinely race in this product: an agent on a
   * phone and their leader on a laptop in the same 1-on-1, both reading *nothing there yet* and both
   * inserting. Read-then-write turns that into a duplicate-key error for whoever is second; an
   * upsert turns it into what they both meant.
   *
   * `$setOnInsert` carries what only a **new** row gets — the fields an update must not reset. The
   * tenant is injected into both the filter and the insert, so a row created this way is scoped the
   * moment it exists.
   */
  async upsertOne(
    ctx: RequestContext,
    filter: FilterQuery<T>,
    update: UpdateQuery<T>,
  ): Promise<T> {
    const kpmId = this.requireKpmId(ctx, 'upsertOne');
    const scoped = this.scope(ctx, 'upsertOne', filter);
    const created = await this.model
      .findOneAndUpdate(
        scoped,
        {
          ...update,
          $set: { ...(update.$set ?? {}), updatedBy: ctx.membershipId },
          $setOnInsert: {
            ...(update.$setOnInsert ?? {}),
            kpmId,
            deletedAt: null,
            createdBy: ctx.membershipId,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .exec();
    return created as T;
  }

  async exists(ctx: RequestContext, filter: FilterQuery<T> = {}): Promise<boolean> {
    return (await this.model.exists(this.scope(ctx, 'exists', filter))) !== null;
  }

  async create(ctx: RequestContext, doc: Partial<T>): Promise<T> {
    const kpmId = this.requireKpmId(ctx, 'create');
    const created = new this.model({
      ...doc,
      kpmId,
      deletedAt: null,
      createdBy: ctx.membershipId,
      updatedBy: ctx.membershipId,
    });
    return created.save();
  }

  async updateById(ctx: RequestContext, id: string, update: UpdateQuery<T>): Promise<T | null> {
    return this.model
      .findOneAndUpdate(
        this.scope(ctx, 'updateById', { _id: id } as FilterQuery<T>),
        { ...update, $set: { ...(update.$set ?? {}), updatedBy: ctx.membershipId } },
        { new: true },
      )
      .exec();
  }

  /**
   * Update every row matching a filter, scoped.
   *
   * A real operation rather than a convenience — cancelling every request somebody still
   * has open is one write, and doing it as a read plus a loop would be several, none of
   * them atomic with the others. `raw-writes.tenancy.spec.ts` exists because this shape
   * was being hand-written; here the tenant is injected like everywhere else.
   */
  async updateMany(
    ctx: RequestContext,
    filter: FilterQuery<T>,
    update: UpdateQuery<T>,
  ): Promise<number> {
    const result = await this.model
      .updateMany(
        this.scope(ctx, 'updateMany', filter),
        { ...update, $set: { ...(update.$set ?? {}), updatedBy: ctx.membershipId } },
      )
      .exec();
    return result.modifiedCount;
  }

  /** Soft delete. There is no hard delete on this class, deliberately. */
  async softDeleteById(ctx: RequestContext, id: string, at: Date): Promise<T | null> {
    return this.model
      .findOneAndUpdate(
        this.scope(ctx, 'softDeleteById', { _id: id } as FilterQuery<T>),
        { $set: { deletedAt: at, updatedBy: ctx.membershipId } },
        { new: true },
      )
      .exec();
  }

  /**
   * Cross-tenant read. Deliberately verbose so the call site is greppable and every
   * use is reviewable. Super Admin only — the caller enforces that.
   */
  async findAcrossAllTenants(ctx: RequestContext, filter: FilterQuery<T> = {}): Promise<T[]> {
    if (!ctx.isSuperAdmin) {
      throw new MissingTenantContextError(this.collectionName, 'findAcrossAllTenants');
    }
    return this.model.find({ ...filter, deletedAt: null } as FilterQuery<T>).exec();
  }
}
