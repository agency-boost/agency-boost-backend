import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { Membership, MembershipDocument } from './membership.schema';

/**
 * The first concrete tenant-scoped repository.
 *
 * It adds exactly one operation the base class does not have — the subtree re-splice
 * below — and no escape hatch to the raw model. Adding one would defeat the chokepoint,
 * and nothing in this module has needed it.
 */
/** Accounts counted, and how many of them signed in within 7 and 30 days (`distinctAccountsAcrossTenants`). */
export interface AccountCounts {
  members: number;
  signedIn7d: number;
  signedIn30d: number;
}

@Injectable()
export class MembershipRepository extends TenantScopedRepository<MembershipDocument> {
  constructor(@InjectModel(Membership.name) model: Model<MembershipDocument>) {
    super(model, 'memberships');
  }

  /**
   * Is this leader code already taken, anywhere?
   *
   * **Deliberately unscoped, and named so.** Leader codes are unique across every office
   * because a joiner presents one before they belong to any — so asking within a tenant
   * would let two offices hold the same code and hand the second joiner to the wrong
   * leader. Invariant §1 asks that a cross-tenant read be an explicitly named method
   * rather than an absent filter, and this is one.
   *
   * Live rows only, matching the partial index: a soft-deleted membership releases its
   * code.
   */
  /**
   * The live membership of one person, in whichever office holds it.
   *
   * **Deliberately unscoped, and named so.** A Super Admin deciding whether they may
   * impersonate somebody has to know which office that person is in and whether they
   * administer it — and the Super Admin is in no office, so there is no tenant to ask
   * within. Invariant §1 asks that a cross-tenant read be an explicitly named method
   * rather than an absent filter, and this is one.
   *
   * v1 allows one live membership per person, so this is a single row or none.
   */
  async liveForUserAnywhere(userId: string): Promise<MembershipDocument | null> {
    return this.model
      .findOne({ userId, status: { $ne: 'removed' }, deletedAt: null })
      .exec();
  }

  /**
   * Who these memberships belong to, in whichever office holds each one.
   *
   * **Deliberately unscoped, and named so.** The Super Admin's audit console shows platform
   * rows from every office at once, and resolving `memberships/68f3…` to a person is the whole
   * reason that screen is readable. The reader is in no tenant, so there is no tenant to ask
   * within — invariant §1 asks that such a read be an explicitly named method rather than an
   * absent filter, and this is one.
   *
   * Soft-deleted rows are **included**: an audit row about a membership that has since been
   * removed still has to say whose it was, which is exactly when somebody is reading the log.
   */
  async byIdsAnywhereForAudit(
    ids: string[],
  ): Promise<{ _id: string; userId: string; agentCode: string | null }[]> {
    if (ids.length === 0) return [];
    const rows = await this.model
      .find({ _id: { $in: ids } }, { userId: 1, agentCode: 1 })
      .lean()
      .exec();
    return rows.map((r) => ({
      _id: String(r._id),
      userId: String(r.userId),
      agentCode: (r as { agentCode?: string | null }).agentCode ?? null,
    }));
  }

  /**
   * How many memberships match one filter, **per office**, for the offices named.
   *
   * **Deliberately unscoped, and named so.** The Super Admin's offices list shows each office's
   * *Leaders used* (ADR-0113, P13.2-T3 AC-3) and the Super Admin is in no office, so there is no
   * tenant to ask within. Invariant §1 asks that such a read be an explicitly named method rather
   * than an absent filter, and this is one: the caller must be a Super Admin, it is narrowed to the
   * offices named, and it returns counts, never a row. `leader-limit.ts` passes the one filter that
   * defines the metric, so the list and the check cannot count differently.
   */
  async countPerOfficeAcrossTenants(
    ctx: RequestContext,
    kpmIds: string[],
    filter: FilterQuery<MembershipDocument>,
  ): Promise<Map<string, number>> {
    if (!ctx.isSuperAdmin) {
      throw new MissingTenantContextError(this.collectionName, 'countPerOfficeAcrossTenants');
    }
    const counts = new Map<string, number>(kpmIds.map((id) => [id, 0]));
    if (kpmIds.length === 0) return counts;
    const rows = await this.model
      .aggregate<{ _id: string; n: number }>([
        { $match: { ...filter, kpmId: { $in: kpmIds }, deletedAt: null } },
        { $group: { _id: '$kpmId', n: { $sum: 1 } } },
      ])
      .exec();
    for (const row of rows) counts.set(String(row._id), row.n);
    return counts;
  }

  /**
   * **How many live memberships stand on one rung, in whichever offices hold them** (ADR-0156 §5, P18.8-T1): what
   * refuses a change of the rung's leader tier while anybody would be re-classed by it.
   *
   * **Deliberately unscoped, and named so.** A rung is the company's, and its members are in every office of that
   * company; the Super Admin who edits the ladder is in none of them. Invariant §1 asks that such a read be an
   * explicitly named method rather than an absent filter, and this is one: the caller must be a Super Admin, and
   * it answers a count, never a row. *Live* is active or pending — a removed member holds no rights to re-class.
   */
  async countHoldingRungAcrossTenants(ctx: RequestContext, orgLevelId: string): Promise<number> {
    if (!ctx.isSuperAdmin) {
      throw new MissingTenantContextError(this.collectionName, 'countHoldingRungAcrossTenants');
    }
    return this.model
      .countDocuments({ orgLevelId, status: { $in: ['active', 'pending'] }, deletedAt: null })
      .exec();
  }

  /**
   * **Each office's composition, joiners and leavers in a month, for every office** (Phase 18, P18-T8, OD-148 →
   * option 1): *Cross-platform analytics*' adoption columns.
   *
   * **Deliberately unscoped, and named so.** The Super Admin reads adoption across offices and is in none, so
   * there is no tenant to ask within; invariant §1 asks that such a read be an explicitly named method rather
   * than an absent filter, and this is one. The caller must be a Super Admin. **Counts, never a row**: by office
   * and rung code the active memberships, and by office the memberships that began and that were removed inside
   * `[monthStart, monthEndExclusive)` — no membership id, no name, nothing a member did (ADR-0011's line).
   *
   * **Began by `joinedAt`, the system's stamp — not the join date** (P18.96-T5 AC-1, kept deliberately): this is the
   * platform's *adoption*, when people started on AgencyBoost, beside *left* by `removedAt`, another stamp. An office's
   * own counts of people read the join date (ADR-0172 §1); here an existing agent added today with a join date years
   * back is a member the platform gained this month.
   */
  async adoptionPerOfficeAcrossTenants(
    ctx: RequestContext, month: { start: Date; endExclusive: Date },
  ): Promise<{
    byRung: { kpmId: string; orgLevelCode: string; n: number }[];
    joined: Map<string, number>;
    left: Map<string, number>;
  }> {
    if (!ctx.isSuperAdmin) {
      throw new MissingTenantContextError(this.collectionName, 'adoptionPerOfficeAcrossTenants');
    }
    const inMonth = { $gte: month.start, $lt: month.endExclusive };
    const [facets] = await this.model
      .aggregate<{
        byRung: { _id: { kpmId: string; orgLevelCode: string }; n: number }[];
        joined: { _id: string; n: number }[];
        left: { _id: string; n: number }[];
      }>([
        { $match: { deletedAt: null, status: { $in: ['active', 'removed'] } } },
        {
          $facet: {
            byRung: [
              { $match: { status: 'active' } },
              { $group: { _id: { kpmId: '$kpmId', orgLevelCode: '$orgLevelCode' }, n: { $sum: 1 } } },
            ],
            joined: [{ $match: { joinedAt: inMonth } }, { $group: { _id: '$kpmId', n: { $sum: 1 } } }],
            left: [{ $match: { status: 'removed', removedAt: inMonth } }, { $group: { _id: '$kpmId', n: { $sum: 1 } } }],
          },
        },
      ])
      .exec();
    return {
      byRung: facets.byRung.map((row) => ({ kpmId: String(row._id.kpmId), orgLevelCode: String(row._id.orgLevelCode), n: row.n })),
      joined: new Map(facets.joined.map((row) => [String(row._id), row.n])),
      left: new Map(facets.left.map((row) => [String(row._id), row.n])),
    };
  }

  /**
   * **How many of each office's members signed in since two instants, for every office** (Phase 18, P18-T8):
   * *Signed in (7 days)* and *(30 days)*, from the account's `lastLoginAt`.
   *
   * **Deliberately unscoped, and named so**, for the reason `adoptionPerOfficeAcrossTenants` gives. The account
   * is global and is joined inside the aggregate, by the membership's `userId`, so neither an id nor a time
   * leaves the database: two counts per office, over its active memberships.
   */
  async signInsPerOfficeAcrossTenants(
    ctx: RequestContext, since: { days7: Date; days30: Date },
  ): Promise<Map<string, { signedIn7d: number; signedIn30d: number }>> {
    if (!ctx.isSuperAdmin) {
      throw new MissingTenantContextError(this.collectionName, 'signInsPerOfficeAcrossTenants');
    }
    const rows = await this.model
      .aggregate<{ _id: string; days7: number; days30: number }>([
        { $match: { deletedAt: null, status: 'active' } },
        // An id that is not an ObjectId names no account: nobody signed in, never a failed read.
        { $project: { kpmId: 1, userId: { $convert: { input: '$userId', to: 'objectId', onError: null, onNull: null } } } },
        {
          $lookup: {
            from: 'users', localField: 'userId', foreignField: '_id', as: 'account',
            pipeline: [{ $project: { _id: 0, lastLoginAt: 1 } }],
          },
        },
        { $project: { kpmId: 1, lastLoginAt: { $first: '$account.lastLoginAt' } } },
        {
          $group: {
            _id: '$kpmId',
            days7: { $sum: { $cond: [{ $gte: [{ $ifNull: ['$lastLoginAt', null] }, since.days7] }, 1, 0] } },
            days30: { $sum: { $cond: [{ $gte: [{ $ifNull: ['$lastLoginAt', null] }, since.days30] }, 1, 0] } },
          },
        },
      ])
      .exec();
    return new Map(rows.map((row) => [String(row._id), { signedIn7d: row.days7, signedIn30d: row.days30 }]));
  }

  /**
   * **How many people — accounts, not memberships — each company's offices and the platform hold, and how many of
   * them signed in since two instants** (Phase 18, P18-T8; the exit review, item 6): the company rows' and the
   * platform row's *Members* and *Signed in* columns. One person with a membership in two offices is one account:
   * counted in each office's row, which counts memberships, and **once** in their company's and the platform's.
   *
   * **Deliberately unscoped, and named so**, for the reason `adoptionPerOfficeAcrossTenants` gives; the caller must
   * be a Super Admin. `offices` is the offices read and each one's company, so a membership of an office not listed
   * — a deleted one — is in no total. The account is joined inside the aggregate and grouped there: **counts, never
   * a row** — no user id, membership id or time leaves the database.
   */
  async distinctAccountsAcrossTenants(
    ctx: RequestContext,
    offices: readonly { kpmId: string; companyId: string }[],
    since: { days7: Date; days30: Date },
  ): Promise<{ companies: Map<string, AccountCounts>; platform: AccountCounts }> {
    if (!ctx.isSuperAdmin) {
      throw new MissingTenantContextError(this.collectionName, 'distinctAccountsAcrossTenants');
    }
    const kpmIds = offices.map((o) => o.kpmId);
    const companyIds = offices.map((o) => o.companyId);
    const counted = (field: 'days7' | 'days30') => ({
      $sum: { $cond: [{ $gte: [{ $ifNull: ['$lastLoginAt', null] }, since[field]] }, 1, 0] },
    });
    const totals = (key: string | null) => ({
      $group: { _id: key, members: { $sum: 1 }, days7: counted('days7'), days30: counted('days30') },
    });
    const [facets] = await this.model
      .aggregate<{
        companies: { _id: string; members: number; days7: number; days30: number }[];
        platform: { members: number; days7: number; days30: number }[];
      }>([
        { $match: { deletedAt: null, status: 'active', kpmId: { $in: kpmIds } } },
        // One row per office, then its company, from the list the caller read: no join on the office collection.
        { $group: { _id: '$kpmId', users: { $addToSet: '$userId' } } },
        {
          $project: {
            users: 1,
            companyId: { $arrayElemAt: [{ $literal: companyIds }, { $indexOfArray: [{ $literal: kpmIds }, '$_id'] }] },
          },
        },
        { $unwind: '$users' },
        // One row per (company, account): a person in two of a company's offices is one row here.
        { $group: { _id: { companyId: '$companyId', userId: '$users' } } },
        // An id that is not an ObjectId names no account: a member, never signed in, never a failed read.
        { $project: { account: { $convert: { input: '$_id.userId', to: 'objectId', onError: null, onNull: null } } } },
        {
          $lookup: {
            from: 'users', localField: 'account', foreignField: '_id', as: 'account',
            pipeline: [{ $project: { _id: 0, lastLoginAt: 1 } }],
          },
        },
        { $project: { companyId: '$_id.companyId', userId: '$_id.userId', lastLoginAt: { $first: '$account.lastLoginAt' } } },
        {
          $facet: {
            companies: [totals('$companyId')],
            // Once more across companies: a person in two companies' offices is one account on the platform.
            platform: [{ $group: { _id: '$userId', lastLoginAt: { $max: '$lastLoginAt' } } }, totals(null)],
          },
        },
      ])
      .exec();
    // No member in any office listed: the platform's facet is empty, and its counts are nought.
    const countsOf = (row = { members: 0, days7: 0, days30: 0 }): AccountCounts => ({
      members: row.members, signedIn7d: row.days7, signedIn30d: row.days30,
    });
    return {
      companies: new Map(facets.companies.map((row) => [String(row._id), countsOf(row)])),
      platform: countsOf(facets.platform[0]),
    };
  }

  async existsWithLeaderCode(code: string): Promise<boolean> {
    return (await this.model.exists({ leaderCode: code, deletedAt: null })) !== null;
  }

  /**
   * The membership a leader code belongs to, wherever it is.
   *
   * The other half of the same escape, and the only way `POST /join/redeem` can work:
   * the caller has no office, so there is no context to scope by.
   */
  async findByLeaderCode(code: string): Promise<MembershipDocument | null> {
    return this.model.findOne({ leaderCode: code, deletedAt: null }).exec();
  }

  /**
   * Re-point a whole subtree's materialised ancestors in one operation.
   *
   * Every descendant needs a *different* new array — its own tail spliced onto the moved
   * member's new path — so a plain `updateMany` cannot express it. The alternative was a
   * loop of one update per descendant: at the stated 500-member budget and Atlas
   * latency that is measured in seconds, for an operation a leader does from a modal.
   *
   * An aggregation-pipeline update does the splice server-side, so it stays one round
   * trip. It lives here rather than at the call site because it is still a bulk write,
   * and a bulk write with a hand-built filter is the one that leaks furthest.
   */
  async respliceSubtree(
    ctx: RequestContext,
    movedId: string,
    newAncestors: string[],
    oldPathLength: number,
    depthShift: number,
  ): Promise<number> {
    const result = await this.model
      .updateMany(this.scope(ctx, 'respliceSubtree', { ancestorIds: movedId }), [
        {
          $set: {
            ancestorIds: {
              $concatArrays: [
                [...newAncestors, movedId],
                // Everything below the moved member is unchanged — only the path above
                // it moved, so this is a splice rather than a re-walk of the tree.
                { $slice: ['$ancestorIds', oldPathLength, { $size: '$ancestorIds' }] },
              ],
            },
            depth: { $add: ['$depth', depthShift] },
            updatedBy: ctx.membershipId,
          },
        },
      ])
      .exec();
    return result.modifiedCount;
  }
}
