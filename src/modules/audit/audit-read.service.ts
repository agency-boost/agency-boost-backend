import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { User, UserDocument } from '@/modules/users/user.schema';
import { AuditService } from './audit.service';

/** A 24-character hex id. Anything else makes `$in` throw a CastError on the whole page. */
function isObjectId(value: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(value);
}

/** One audit row, with the people and the target named where they can be. */
export interface ResolvedAuditRow {
  _id: string;
  createdAt: Date;
  action: string;
  targetCollection: string;
  targetId: string | null;
  /** `null` when the id resolves to nothing, or to a collection nobody has named yet. */
  targetLabel: string | null;
  actorUserId: string | null;
  actorName: string | null;
  effectiveUserId: string | null;
  effectiveName: string | null;
  /** The mutation itself, unchanged. Already part of this shape before names were added. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * Reading the audit log with the people and the things named.
 *
 * **An audit log of ids is a log nobody reads.** Every row on the console said
 * `68f3c1a9… changed 68f3c2b4…`, so answering *"who suspended Surabaya?"* meant three lookups
 * in a database shell — which is the question the log exists to answer, and the one moment
 * nobody wants to be writing queries.
 *
 * **A separate service from `AuditService`, deliberately.** That one is written to by eleven
 * modules and constructed directly in eight tests; giving it four more required dependencies
 * so that one screen can read names would make every writer carry the reader's baggage. It
 * also keeps the append-only surface honest: this class holds no `record`.
 */
@Injectable()
export class AuditReadService {
  constructor(
    private readonly audit: AuditService,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly memberships: MembershipRepository,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
  ) {}

  /**
   * **Resolved in a handful of round trips, not one per row.** The ids on a page are collected
   * first and each collection read once, so a hundred rows cost five reads rather than two
   * hundred. `$in` over primary keys, all of them indexed.
   *
   * **An id that resolves to nothing keeps its id.** A target in a collection nobody has taught
   * this about renders as the id it was, because a blank cell reads as *nothing happened*
   * rather than *this is all we know*.
   */
  async findForTenant(kpmId: string | null, limit = 100): Promise<ResolvedAuditRow[]> {
    const rows = await this.audit.findForTenant(kpmId, limit);

    const userIds = new Set<string>();
    const byCollection = new Map<string, Set<string>>();
    for (const row of rows) {
      if (row.actorUserId) userIds.add(String(row.actorUserId));
      if (row.effectiveUserId) userIds.add(String(row.effectiveUserId));
      if (!row.targetId) continue;
      if (row.targetCollection === 'users') userIds.add(String(row.targetId));
      const set = byCollection.get(row.targetCollection) ?? new Set<string>();
      set.add(String(row.targetId));
      byCollection.set(row.targetCollection, set);
    }

    const ids = (name: string) => [...(byCollection.get(name) ?? [])].filter(isObjectId);

    const [people, memberRows, offices, firms] = await Promise.all([
      this.lookup(this.users as unknown as Model<Record<string, unknown>>, [...userIds].filter(isObjectId)),
      // Through the repository's explicitly named cross-tenant method, not the model:
      // invariant §1, and `repositories.tenancy.spec.ts` enforces it.
      this.memberships.byIdsAnywhereForAudit(ids('memberships')),
      this.lookup(this.kpms as unknown as Model<Record<string, unknown>>, ids('kpms')),
      this.lookup(this.companies as unknown as Model<Record<string, unknown>>, ids('companies')),
    ]);
    const members = new Map<string, Record<string, unknown>>(
      memberRows.map((m) => [m._id, m as unknown as Record<string, unknown>]),
    );

    // A membership names a person, so the users behind them are fetched in a second pass.
    const memberPeople = await this.lookup(
      this.users as unknown as Model<Record<string, unknown>>,
      [...members.values()]
        .map((m) => String((m as { userId?: string }).userId ?? ''))
        .filter(isObjectId),
    );

    const personName = (id: string | null | undefined): string | null => {
      if (!id) return null;
      const row = people.get(String(id)) ?? memberPeople.get(String(id));
      return row ? String((row as { fullName?: string }).fullName ?? '') || null : null;
    };

    return rows.map((row) => ({
      _id: String(row._id),
      // `createdAt` comes from `baseSchemaOptions`' timestamps, so it is on the document and
      // not on the class Mongoose types it from.
      createdAt: (row as unknown as { createdAt: Date }).createdAt,
      action: row.action,
      targetCollection: row.targetCollection,
      targetId: row.targetId ? String(row.targetId) : null,
      targetLabel: this.labelFor(row.targetCollection, row.targetId ? String(row.targetId) : null, {
        members, offices, firms, personName,
      }),
      actorUserId: row.actorUserId ? String(row.actorUserId) : null,
      actorName: personName(row.actorUserId),
      effectiveUserId: row.effectiveUserId ? String(row.effectiveUserId) : null,
      effectiveName: personName(row.effectiveUserId),
      before: row.before ?? null,
      after: row.after ?? null,
    }));
  }

  /**
   * One read per collection, keyed by id. An empty list costs no read at all.
   *
   * The model is typed loosely on purpose: four different document types go through here and
   * every caller reads the result through its own narrow cast, so a generic parameter would
   * only be a shape Mongoose's `lean()` overloads argue with.
   */
  private async lookup(
    model: Model<Record<string, unknown>>, list: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    if (list.length === 0) return new Map();
    const rows = await model.find({ _id: { $in: list } }).lean().exec();
    return new Map((rows as unknown as Record<string, unknown>[])
      .map((r) => [String(r._id), r]));
  }

  /**
   * What to call the thing an action happened to.
   *
   * Only the collections a platform reader actually meets are named. The rest fall through to
   * `null` and the screen shows the id — adding a collection here is one line, and guessing at
   * one would be a label that quietly means nothing.
   */
  private labelFor(
    collection: string,
    id: string | null,
    src: {
      members: Map<string, Record<string, unknown>>;
      offices: Map<string, Record<string, unknown>>;
      firms: Map<string, Record<string, unknown>>;
      personName: (id: string | null | undefined) => string | null;
    },
  ): string | null {
    if (!id) return null;
    switch (collection) {
      case 'users':
        return src.personName(id);
      case 'memberships': {
        const row = src.members.get(id) as { userId?: string; agentCode?: string } | undefined;
        if (!row) return null;
        const name = src.personName(row.userId);
        if (!name) return null;
        return row.agentCode ? `${name} · ${row.agentCode}` : name;
      }
      case 'kpms': {
        const row = src.offices.get(id) as { code?: string; branchName?: string } | undefined;
        return row ? [row.code, row.branchName].filter(Boolean).join(' · ') || null : null;
      }
      case 'companies':
        return (src.firms.get(id) as { name?: string } | undefined)?.name ?? null;
      default:
        return null;
    }
  }
}
