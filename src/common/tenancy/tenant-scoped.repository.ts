import { FilterQuery, Model, QueryOptions, UpdateQuery, Document } from 'mongoose';
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
    return this.model.findOne(this.scope(ctx, 'findById', { _id: id } as FilterQuery<T>)).exec();
  }

  async findOne(ctx: RequestContext, filter: FilterQuery<T> = {}): Promise<T | null> {
    return this.model.findOne(this.scope(ctx, 'findOne', filter)).exec();
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
