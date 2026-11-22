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
/** A membership as *All members* reads it (`listMembershipsAcrossTenants`, ADR-0207 §2): the listed fields alone. */
export interface MembershipListRow {
  _id: unknown;
  kpmId: string;
  userId: string;
  agentCode: string;
  orgLevelCode: string;
  role: 'ab' | 'aab' | 'agent';
  leaderId: string | null;
  status: 'active' | 'pending' | 'removed';
  joinedAt?: Date | null;
  joinDate?: string | null;
  removedAt?: Date | null;
  invitedAt?: Date | null;
  adminAccess?: { isKpmAdmin?: boolean } | null;
  createdAt?: Date;
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
   * **The agent codes registered in the offices named** (P19.5-T1 AC-11; ADR-0214 §7): every active membership's code,
   * distinct, for the test of a template's agent-code pattern over every KPM on the template.
   *
   * **Deliberately unscoped, and named so.** The pattern is the template's, and the template's KPMs are many offices;
   * the Super Admin who edits it is in none of them. Invariant §1 asks that such a read be an explicitly named method
   * rather than an absent filter, and this is one: the caller must be a Super Admin, it is narrowed to the offices
   * named, and it answers codes alone — never a name, an office or a row. A code the insurer issued is the company's,
   * so naming up to five that do not match is what the publish dialog does (AA UI-018).
   */
  async agentCodesInOfficesAcrossTenants(ctx: RequestContext, kpmIds: readonly string[]): Promise<string[]> {
    if (!ctx.isSuperAdmin) {
      throw new MissingTenantContextError(this.collectionName, 'agentCodesInOfficesAcrossTenants');
    }
    if (kpmIds.length === 0) return [];
    const codes = await this.model
      .distinct('agentCode', { kpmId: { $in: [...kpmIds] }, status: 'active', deletedAt: null })
      .exec() as unknown[];
    return codes.filter((c): c is string => typeof c === 'string' && c.trim() !== '').sort();
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
   * **The memberships of the named offices, for the Super Admin's *All members*** (ADR-0207 §2, §4; P19.4-T3 AC-1):
   * one row per membership, active, pending or removed, in the offices `kpmIds` names — `kpmId` is written last, so
   * nothing in `filter` can widen it — soft-deleted rows left out.
   *
   * **Deliberately unscoped, and named so**, as invariant §1 asks: the Super Admin is in no office. Anybody else is
   * refused as an unscoped read is. Only the fields the list needs are read (`projection`): who, where, which rung and
   * class, the leader, the status and its dates, the Admin flag and the invitation's stamp — never a figure. Who may
   * call it, and why, is `named-cross-tenant-reads.tenancy.spec.ts`'s register.
   */
  async listMembershipsAcrossTenants(
    ctx: RequestContext,
    kpmIds: readonly string[],
    filter: FilterQuery<MembershipDocument> = {},
  ): Promise<MembershipListRow[]> {
    if (!ctx.isSuperAdmin) {
      throw new MissingTenantContextError(this.collectionName, 'listMembershipsAcrossTenants');
    }
    if (kpmIds.length === 0) return [];
    return this.model
      .find(
        { ...filter, kpmId: { $in: [...kpmIds] }, deletedAt: null } as FilterQuery<MembershipDocument>,
        {
          kpmId: 1, userId: 1, agentCode: 1, orgLevelCode: 1, role: 1, leaderId: 1, status: 1, joinedAt: 1, joinDate: 1,
          removedAt: 1, invitedAt: 1, 'adminAccess.isKpmAdmin': 1, createdAt: 1,
        },
      )
      .lean<MembershipListRow[]>()
      .exec();
  }

  /**
   * **How many live memberships each account holds, in whichever offices hold them** (P19.12-T2 AC-1; ADR-0245 §1): the
   * Super Admin's *Akun terdaftar* — *Tanpa KPM* is an account with none, *Punya KPM* one with at least one, and each
   * row's *n KPM*. *Live* is active or pending: a membership that ended (`removed`) or was erased (`deletedAt`) is none.
   *
   * **Deliberately unscoped, and named so**, as invariant §1 asks: an account is global and the Super Admin is in no
   * office. Anybody else is refused as an unscoped read is. It answers a count per user id — never an office, a row, a
   * name or a rung. Who may call it, and why, is `named-cross-tenant-reads.tenancy.spec.ts`'s register.
   */
  async liveMembershipCountsPerUserAcrossTenants(ctx: RequestContext): Promise<Map<string, number>> {
    if (!ctx.isSuperAdmin) {
      throw new MissingTenantContextError(this.collectionName, 'liveMembershipCountsPerUserAcrossTenants');
    }
    const rows = await this.model
      .aggregate<{ _id: string; n: number }>([
        { $match: { deletedAt: null, status: { $in: ['active', 'pending'] } } },
        { $group: { _id: '$userId', n: { $sum: 1 } } },
      ])
      .exec();
    return new Map(rows.map((row) => [String(row._id), row.n]));
  }

  /**
   * **A person's test-account flag, copied onto every membership they hold** (P19.23-T3 AC-1; ADR-0267 §1): the Super
   * Admin's *Akun tes* switch on *Anggota*'s detail writes `users.testAccount`, and this writes its copy
   * (`memberships.testAccount`) — which every read of a KPM's members filters on (`NOT_A_TEST_ACCOUNT`) — in each office
   * the person is in, a removed or erased membership included, so the two can never disagree.
   *
   * **Deliberately unscoped, and named so**, as invariant §1 asks: identity is global and the Super Admin is in no office.
   * Anybody else is refused as an unscoped write is. It writes the one field and answers how many rows it touched — never
   * a row, an office or a name. Who may call it, and why, is `named-cross-tenant-reads.tenancy.spec.ts`'s register.
   */
  async setTestAccountAcrossTenants(ctx: RequestContext, userId: string, testAccount: boolean): Promise<number> {
    if (!ctx.isSuperAdmin) {
      throw new MissingTenantContextError(this.collectionName, 'setTestAccountAcrossTenants');
    }
    const result = await this.model.updateMany({ userId }, { $set: { testAccount } }).exec();
    return result.matchedCount;
  }

  /**
   * **How many live memberships stand on one rung, in whichever offices hold them** (ADR-0156 §5, P18.5-T1): what
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
