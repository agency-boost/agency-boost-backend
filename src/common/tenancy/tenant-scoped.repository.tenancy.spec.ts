import mongoose, { Document, Schema } from 'mongoose';
import { RequestContext, TenantMembership } from '@/common/context/request-context';
import { TenantScopedRepository } from './tenant-scoped.repository';
import { MissingTenantContextError } from './tenant-scope.error';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';

/**
 * Cross-tenant isolation is the failure this whole architecture exists to prevent.
 * These run against a real MongoDB, not a mock, because the thing being tested is
 * the query that reaches the database.
 */

interface WidgetDoc extends Document {
  kpmId: string;
  name: string;
  deletedAt: Date | null;
  createdBy: string | null;
  updatedBy: string | null;
}

const WidgetSchema = new Schema<WidgetDoc>({
  kpmId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null },
});
WidgetSchema.index({ kpmId: 1, name: 1 });

class WidgetRepository extends TenantScopedRepository<WidgetDoc> {
  constructor() {
    super(mongoose.model<WidgetDoc>('Widget', WidgetSchema), 'widgets');
  }
}

function ctxFor(kpmId: string, overrides: Partial<TenantMembership> = {}): RequestContext {
  return new RequestContext('user-' + kpmId, 'none', {
    membershipId: 'mem-' + kpmId,
    kpmId,
    orgLevelCode: 'AGENT', hierarchyRole: 'agent',
    status: 'active',
    isKpmOwner: false,
    isKpmAdmin: false, directCount: 0,
    ...overrides,
  });
}

const KPM_A = 'kpm-a';
const KPM_B = 'kpm-b';

describe('TenantScopedRepository — cross-tenant isolation', () => {
  let repo: WidgetRepository;

  beforeAll(async () => {
    await startMongo();
    repo = new WidgetRepository();
  });
  afterAll(stopMongo);
  afterEach(clearCollections);

  describe('a tenant cannot reach another tenant’s data', () => {
    it('findById returns null for another tenant’s document', async () => {
      const b = await repo.create(ctxFor(KPM_B), { name: 'secret' } as Partial<WidgetDoc>);
      expect(await repo.findById(ctxFor(KPM_A), String(b._id))).toBeNull();
      expect(await repo.findById(ctxFor(KPM_B), String(b._id))).not.toBeNull();
    });

    it('find never returns another tenant’s documents', async () => {
      await repo.create(ctxFor(KPM_A), { name: 'mine' } as Partial<WidgetDoc>);
      await repo.create(ctxFor(KPM_B), { name: 'theirs' } as Partial<WidgetDoc>);
      const found = await repo.find(ctxFor(KPM_A));
      expect(found).toHaveLength(1);
      expect(found[0].name).toBe('mine');
    });

    it('an explicit kpmId in the caller’s filter cannot override the context', async () => {
      const b = await repo.create(ctxFor(KPM_B), { name: 'theirs' } as Partial<WidgetDoc>);
      // A caller trying to reach across, deliberately or by accident.
      const found = await repo.find(ctxFor(KPM_A), { kpmId: KPM_B } as never);
      expect(found).toHaveLength(0);
      expect(await repo.findById(ctxFor(KPM_A), String(b._id))).toBeNull();
    });

    it('count and exists are scoped too', async () => {
      await repo.create(ctxFor(KPM_B), { name: 'theirs' } as Partial<WidgetDoc>);
      expect(await repo.count(ctxFor(KPM_A))).toBe(0);
      expect(await repo.exists(ctxFor(KPM_A))).toBe(false);
      expect(await repo.count(ctxFor(KPM_B))).toBe(1);
      expect(await repo.exists(ctxFor(KPM_B))).toBe(true);
    });

    it('updateById cannot modify another tenant’s document', async () => {
      const b = await repo.create(ctxFor(KPM_B), { name: 'original' } as Partial<WidgetDoc>);
      const result = await repo.updateById(ctxFor(KPM_A), String(b._id), {
        $set: { name: 'hijacked' },
      });
      expect(result).toBeNull();
      const untouched = await repo.findById(ctxFor(KPM_B), String(b._id));
      expect(untouched?.name).toBe('original');
    });

    it('softDeleteById cannot delete another tenant’s document', async () => {
      const b = await repo.create(ctxFor(KPM_B), { name: 'theirs' } as Partial<WidgetDoc>);
      expect(await repo.softDeleteById(ctxFor(KPM_A), String(b._id), new Date())).toBeNull();
      expect(await repo.findById(ctxFor(KPM_B), String(b._id))).not.toBeNull();
    });

    it('create always stamps the context’s tenant, never a caller-supplied one', async () => {
      const w = await repo.create(ctxFor(KPM_A), {
        name: 'x',
        kpmId: KPM_B,
      } as Partial<WidgetDoc>);
      expect(w.kpmId).toBe(KPM_A);
    });
  });

  describe('fails closed without a tenant context', () => {
    const noTenant = new RequestContext('u1', 'none', null);

    it.each([
      ['findById', () => repo.findById(noTenant, 'x')],
      ['findOne', () => repo.findOne(noTenant)],
      ['find', () => repo.find(noTenant)],
      ['count', () => repo.count(noTenant)],
      ['exists', () => repo.exists(noTenant)],
      ['create', () => repo.create(noTenant, { name: 'x' } as Partial<WidgetDoc>)],
      ['updateById', () => repo.updateById(noTenant, 'x', { $set: { name: 'y' } })],
      ['softDeleteById', () => repo.softDeleteById(noTenant, 'x', new Date())],
    ])('%s throws rather than querying unscoped', async (_name, call) => {
      await expect(call()).rejects.toThrow(MissingTenantContextError);
    });
  });

  describe('soft delete', () => {
    it('hides a deleted document from normal reads but keeps the row', async () => {
      const ctx = ctxFor(KPM_A);
      const w = await repo.create(ctx, { name: 'gone' } as Partial<WidgetDoc>);
      await repo.softDeleteById(ctx, String(w._id), new Date());

      expect(await repo.findById(ctx, String(w._id))).toBeNull();
      expect(await repo.count(ctx)).toBe(0);

      const raw = await mongoose.connection.collection('widgets').findOne({ _id: w._id });
      expect(raw).not.toBeNull();
      expect(raw?.deletedAt).toBeInstanceOf(Date);
    });
  });

  describe('the cross-tenant escape hatch', () => {
    it('is refused to a non-super-admin', async () => {
      await expect(repo.findAcrossAllTenants(ctxFor(KPM_A))).rejects.toThrow(
        MissingTenantContextError,
      );
    });

    it('returns every tenant’s live documents for a super admin', async () => {
      await repo.create(ctxFor(KPM_A), { name: 'a' } as Partial<WidgetDoc>);
      await repo.create(ctxFor(KPM_B), { name: 'b' } as Partial<WidgetDoc>);
      const all = await repo.findAcrossAllTenants(RequestContext.platform('root'));
      expect(all.map((w) => w.name).sort()).toEqual(['a', 'b']);
    });

    it('still excludes soft-deleted documents', async () => {
      const ctx = ctxFor(KPM_A);
      const w = await repo.create(ctx, { name: 'gone' } as Partial<WidgetDoc>);
      await repo.softDeleteById(ctx, String(w._id), new Date());
      expect(await repo.findAcrossAllTenants(RequestContext.platform('root'))).toHaveLength(0);
    });
  });

  describe('a malformed id is nothing found, wherever it sits in the filter', () => {
    it('answers null for a bad id at the top level and inside $and', async () => {
      const ctx = ctxFor(KPM_A);
      await repo.create(ctx, { name: 'real' } as Partial<WidgetDoc>);

      expect(await repo.findById(ctx, 'not-an-objectid')).toBeNull();
      expect(await repo.findOne(ctx, { _id: 'not-an-objectid' } as never)).toBeNull();
      // The shape the person page actually reads through. A guard that only read the top
      // level went blind the day the id moved inside `$and` to stop a visibility
      // narrowing overwriting it, and the query threw CastError → 500 again.
      expect(
        await repo.findOne(ctx, {
          $and: [{ _id: 'not-an-objectid' }, { name: 'real' }],
        } as never),
      ).toBeNull();
      // Nested two deep, because `$and` branches are themselves filters.
      expect(
        await repo.findOne(ctx, {
          $and: [{ $and: [{ _id: 'not-an-objectid' }] }],
        } as never),
      ).toBeNull();
    });

    it('does not answer null for a bad id inside $or, where it kills only one branch', async () => {
      const ctx = ctxFor(KPM_A);
      const w = await repo.create(ctx, { name: 'real' } as Partial<WidgetDoc>);

      // Disjunction is the case the guard deliberately does not claim: a dead branch is
      // not a dead query. Mongoose still casts the whole filter, so this throws today —
      // the assertion pins that the guard stays out of it rather than quietly answering
      // `null` for a query that has a matching branch.
      await expect(
        repo.findOne(ctx, { $or: [{ _id: 'not-an-objectid' }, { _id: w._id }] } as never),
      ).rejects.toThrow();
    });

    it('walks past a branch that is not a filter at all', async () => {
      const ctx = ctxFor(KPM_A);
      const w = await repo.create(ctx, { name: 'real' } as Partial<WidgetDoc>);

      // Mongo tolerates neither, but the guard runs before Mongo does and must not throw
      // on its way to deciding. It recurses into whatever `$and` holds, so `null` and a
      // primitive are both shapes it can be handed.
      expect(
        await repo.findOne(ctx, { $and: [null, { _id: 'not-an-objectid' }] } as never),
      ).toBeNull();
      // A branch that is not a filter is still nonsense to Mongo, and the guard does not
      // pretend otherwise — it answers only for malformed ids, and lets everything else
      // reach the driver rather than inventing a `null` for a query it has no opinion on.
      await expect(repo.findOne(ctx, { $and: ['nonsense'] } as never)).rejects.toThrow();
      expect(String((await repo.findOne(ctx, { $and: [{}] } as never))?._id)).toBe(String(w._id));
    });

    it('still fails closed on a missing tenant, whatever the id looks like', async () => {
      const noTenant = RequestContext.platform('root');
      await expect(
        repo.findOne(noTenant, { $and: [{ _id: 'not-an-objectid' }] } as never),
      ).rejects.toThrow(MissingTenantContextError);
    });
  });

  describe('audit stamping', () => {
    it('records the acting membership on create and update', async () => {
      const ctx = ctxFor(KPM_A);
      const w = await repo.create(ctx, { name: 'x' } as Partial<WidgetDoc>);
      expect(w.createdBy).toBe('mem-kpm-a');

      const other = ctxFor(KPM_A, { membershipId: 'mem-leader' });
      const updated = await repo.updateById(other, String(w._id), { $set: { name: 'y' } });
      expect(updated?.updatedBy).toBe('mem-leader');
      expect(updated?.createdBy).toBe('mem-kpm-a');
    });
  });

  describe('branch coverage the happy path misses', () => {
    it('scope() defaults its filter when called without one', async () => {
      const ctx = ctxFor(KPM_A);
      await repo.create(ctx, { name: 'x' } as Partial<WidgetDoc>);

      class Defaulting extends WidgetRepository {
        // Three arguments: exercises both the `filter` and `includeDeleted` defaults.
        all(c: RequestContext) {
          return this.model.find(this.scope(c, 'all')).exec();
        }
      }
      expect(await new Defaulting().all(ctx)).toHaveLength(1);
    });

    it('stamps updatedBy on an update that carries no $set of its own', async () => {
      const ctx = ctxFor(KPM_A);
      const w = await repo.create(ctx, { name: 'x' } as Partial<WidgetDoc>);
      const other = ctxFor(KPM_A, { membershipId: 'mem-other' });

      // $unset rather than $set — the `update.$set ?? {}` branch.
      const updated = await repo.updateById(other, String(w._id), {
        $unset: { originalName: '' },
      } as never);

      expect(updated?.updatedBy).toBe('mem-other');
    });

    it('updateMany writes inside the tenant and nowhere else', async () => {
      /*
       * `updateMany` had no test at all until the Phase 4 exit review — in the one module
       * the ratchet holds at 100% branch, which is where an untested write is least
       * acceptable. It is the sharpest method on the class: a single call with a filter
       * that reached across tenants would rewrite another office's rows in one statement.
       */
      const a = ctxFor(KPM_A);
      const b = ctxFor(KPM_B);
      await repo.create(a, { name: 'mine' } as Partial<WidgetDoc>);
      await repo.create(a, { name: 'mine too' } as Partial<WidgetDoc>);
      await repo.create(b, { name: 'theirs' } as Partial<WidgetDoc>);

      const changed = await repo.updateMany(a, {}, { $set: { name: 'renamed' } } as never);

      expect(changed).toBe(2);
      expect((await repo.find(b, {})).map((w) => w.name)).toEqual(['theirs']);
    });

    it('updateMany stamps updatedBy on an update carrying no $set of its own', async () => {
      // The `update.$set ?? {}` half, on the bulk path. If the spread were wrong the stamp
      // would replace the caller's update rather than merge with it.
      const a = ctxFor(KPM_A);
      await repo.create(a, { name: 'x' } as Partial<WidgetDoc>);
      const other = ctxFor(KPM_A, { membershipId: 'mem-bulk' });

      expect(await repo.updateMany(other, {}, { $unset: { originalName: '' } } as never)).toBe(1);
      expect((await repo.find(a, {}))[0].updatedBy).toBe('mem-bulk');
    });
  });

  describe('includeDeleted opt-in', () => {
    it('is off by default and reachable through scope()', async () => {
      const ctx = ctxFor(KPM_A);
      const w = await repo.create(ctx, { name: 'gone' } as Partial<WidgetDoc>);
      await repo.softDeleteById(ctx, String(w._id), new Date());

      class Peeking extends WidgetRepository {
        peek(c: RequestContext) {
          return this.model.find(this.scope(c, 'peek', {}, true)).exec();
        }
      }
      expect(await new Peeking().peek(ctx)).toHaveLength(1);
    });
  });

  /**
   * Rollups (P7-T6).
   *
   * An aggregation is the one read shape that can look correct and still be wrong: a pipeline
   * that counts the whole collection and filters afterwards returns this tenant's number while
   * having read everybody's. So the scope goes into the **first** stage, and a pipeline that does
   * not begin with one is refused rather than quietly repaired.
   */
  describe('aggregation is scoped in its first stage', () => {
    beforeEach(async () => {
      await repo.create(ctxFor(KPM_A), { name: 'a-one' } as never);
      await repo.create(ctxFor(KPM_A), { name: 'a-two' } as never);
      await repo.create(ctxFor(KPM_B), { name: 'b-one' } as never);
    });

    it('counts only this tenant’s rows', async () => {
      const [out] = await repo.aggregate(ctxFor(KPM_A), [
        { $match: {} }, { $count: 'n' },
      ]);

      expect(out).toEqual({ n: 2 });
    });

    it('merges the tenant into a filter the caller supplied', async () => {
      const [out] = await repo.aggregate(ctxFor(KPM_A), [
        { $match: { name: 'a-one' } }, { $count: 'n' },
      ]);

      expect(out).toEqual({ n: 1 });
    });

    it('cannot be aimed at another tenant by naming one', async () => {
      // The caller's `kpmId` is overwritten, not merged with: `{...filter, kpmId}` puts the
      // context last on purpose, so a pipeline asking for KPM B gets KPM A's answer.
      const [out] = await repo.aggregate(ctxFor(KPM_A), [
        { $match: { kpmId: KPM_B } }, { $count: 'n' },
      ]);

      expect(out).toEqual({ n: 2 });
    });

    it('hides soft-deleted rows unless they are asked for', async () => {
      const gone = await repo.findOne(ctxFor(KPM_A), { name: 'a-two' });
      await repo.softDeleteById(ctxFor(KPM_A), String(gone!._id), new Date());

      const [live] = await repo.aggregate(ctxFor(KPM_A), [{ $match: {} }, { $count: 'n' }]);
      const [all] = await repo.aggregate(ctxFor(KPM_A), [{ $match: {} }, { $count: 'n' }], true);

      expect(live).toEqual({ n: 1 });
      expect(all).toEqual({ n: 2 });
    });

    it('refuses a pipeline that does not begin with $match', async () => {
      await expect(repo.aggregate(ctxFor(KPM_A), [{ $count: 'n' }]))
        .rejects.toThrow(/must begin with \$match/);
      await expect(repo.aggregate(ctxFor(KPM_A), []))
        .rejects.toThrow(/must begin with \$match/);
    });

    it('fails closed with no tenant context, like every other read', async () => {
      const noTenant = new RequestContext('u1', 'none', null);

      await expect(repo.aggregate(noTenant, [{ $match: {} }, { $count: 'n' }]))
        .rejects.toBeInstanceOf(MissingTenantContextError);
    });
  });

});
