import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, InvalidRequestException, NotFoundException, PermissionDeniedException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { render } from '@/common/i18n/sentence';
import { decodeCursor, encodeCursor } from '@/common/pagination/cursor';
import { PRODUCT_DATA_CHANGES } from '@/domain/constants';
import { actionLabel, targetKindLabel } from '@/modules/audit/audit-labels.messages';
import { AuditLogDocument } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Product, ProductDocument } from '@/modules/products/product.schema';
import { can, type Permission } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { INSURERS_ONLY } from '@/modules/tenants/template-library';
import { TENANTS_MESSAGES } from '@/modules/tenants/tenants.messages';
import { User, UserDocument } from '@/modules/users/user.schema';
import { ProductDataGrant, ProductDataGrantDocument } from './product-data-grant.schema';
import { PRODUCT_DATA_GRANT_REFUSALS } from './product-data-grant.messages';

const SAY = PRODUCT_DATA_GRANT_REFUSALS;

/** One insurer, by id and name. */
export interface GrantCompany {
  companyId: string;
  name: string;
}

/** **One person's *Kelola data produk*** (ADR-0260 §4), as *KPM Owners & Admins* draws it. */
export interface ProductDataGrantRow {
  userId: string;
  fullName: string;
  email: string;
  /** Their KPM now, and its words — *KPM 0417 — Bandung* — or `null` when they are in none. */
  kpmId: string | null;
  kpmLabel: string | null;
  /**
   * **Whether it grants anything today** (ADR-0260 §2): they are an active KPM Owner or KPM Admin. `false` for a grant
   * kept on record for somebody whose Admin access the Owner took away — it holds nothing until they are one again.
   */
  holds: boolean;
  /** The insurers ticked, A to Z. */
  companies: GrantCompany[];
  grantedAt: string;
  grantedByName: string | null;
  updatedAt: string;
}

/** The grant removed: who, and when. */
export interface ProductDataGrantRevoked {
  userId: string;
  revokedAt: string;
}

/**
 * **One change a product data manager made** (ADR-0260 §6), *Perubahan oleh pengelola*'s line: when, what in words,
 * which product of which company, who and from which KPM — and the ids the screen links by: the company's *Proposal*
 * tab, and the line in the audit log.
 */
export interface ProductDataChangeRow {
  auditId: string;
  createdAt: string;
  action: string;
  actionLabel: string;
  targetCollection: string;
  targetKind: string;
  targetId: string | null;
  actorUserId: string;
  actorName: string | null;
  /** The scope the row was written in — the manager's KPM — for the audit log's *Cakupan*; `null` for the platform's. */
  kpmId: string | null;
  officeLabel: string | null;
  companyId: string | null;
  companyName: string | null;
  productId: string | null;
  productName: string | null;
}

export interface ProductDataChangesPage {
  items: ProductDataChangeRow[];
  page: { cursor: string | null; nextCursor: string | null; limit: number; hasMore: boolean };
}

/**
 * **What a product data manager's change is** (ADR-0260 §6): an action on a premium table, a product's rules, an upload
 * read by the AI or an illustration — the four the company *Proposal* tab writes (ADR-0258, ADR-0259). A grant given or
 * removed is the Super Admin's, never listed.
 */
export const PRODUCT_DATA_CHANGE_ACTION = /^(rate_table|product_rules|intake|illustration)\./;

/** A 24-character hex id. */
const isObjectId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value);

/**
 * ***Kelola data produk*: given, changed, removed, listed — and what its holders changed** (ADR-0260; P19.15-T4 AC-2;
 * the P1b spec's *Giving access* and *Rules*).
 *
 * - **Given to an active KPM Owner or KPM Admin only** — anybody else is `409 PRODUCT_DATA_GRANT_NOT_ELIGIBLE` — for at
 *   least one insurer company. One live grant per person; giving it again changes its companies.
 * - **Removed at once**: `revokedAt` is written and the row kept. `ContextResolver` reads the live grant on each of the
 *   person's requests, so neither a removal nor a change waits for a token to expire.
 * - **Every write audited**, before and after: `product_data_grant.granted`, `.changed`, `.revoked`.
 * - **The Super Admin's alone** (`product_data_grant:read`, `:manage`): a support session acts as its member, who holds
 *   neither.
 */
@Injectable()
export class ProductDataGrantService {
  constructor(
    @InjectModel(ProductDataGrant.name) private readonly grants: Model<ProductDataGrantDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Product.name) private readonly products: Model<ProductDocument>,
    private readonly memberships: MembershipRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** **`GET /admin/product-data-grants`**: every live grant, its holder's name and KPM, newest first. */
  async list(ctx: RequestContext): Promise<ProductDataGrantRow[]> {
    this.require(ctx, 'product_data_grant:read');
    const live = await this.grants.find({ revokedAt: null, deletedAt: null }).sort({ grantedAt: -1, _id: -1 }).exec();
    return this.rowsOf(ctx, live);
  }

  /**
   * **`PUT /admin/product-data-grants/:userId`**: *Kelola data produk* on, for these companies. A person with no live
   * grant is given one (`product_data_grant.granted`); one with a live grant has its companies replaced
   * (`.changed`), and the same companies again change nothing and record nothing.
   */
  async set(ctx: RequestContext, userId: string, companyIds: readonly string[]): Promise<ProductDataGrantRow> {
    this.require(ctx, 'product_data_grant:manage');
    if (companyIds.length === 0) throw new InvalidRequestException(SAY.VALIDATION_FAILED.companiesRequired, { field: 'companyIds' });
    await this.person(userId);
    await this.insurers(companyIds);
    if (!(await this.eligible(ctx, userId))) {
      throw new DomainException(
        ErrorCode.PRODUCT_DATA_GRANT_NOT_ELIGIBLE, SAY.PRODUCT_DATA_GRANT_NOT_ELIGIBLE.notOwnerOrAdmin, HttpStatus.CONFLICT,
        { userId },
      );
    }

    const now = this.clock.now();
    const ticked = [...companyIds];
    const existing = await this.grants.findOne({ userId, revokedAt: null, deletedAt: null }).exec();
    let grant: ProductDataGrantDocument;
    if (!existing) {
      try {
        grant = await this.grants.create({ userId, companyIds: ticked, grantedBy: ctx.userId, grantedAt: now });
      } catch (err) {
        // Another Super Admin gave it between the read and the insert: theirs stands, and this one changes it.
        if ((err as { code?: unknown }).code !== 11000) throw err;
        return this.set(ctx, userId, companyIds);
      }
      await this.audit.record(ctx, {
        action: 'product_data_grant.granted', targetCollection: 'productDataGrants', targetId: String(grant._id),
        before: null, after: { userId, companyIds: ticked },
      });
    } else {
      const before = [...existing.companyIds];
      if (sameSet(before, ticked)) return (await this.rowsOf(ctx, [existing]))[0];
      grant = await this.grants.findOneAndUpdate(
        { _id: existing._id, revokedAt: null },
        { $set: { companyIds: ticked, updatedBy: ctx.userId } },
        { new: true },
      ).exec() ?? existing;
      await this.audit.record(ctx, {
        action: 'product_data_grant.changed', targetCollection: 'productDataGrants', targetId: String(existing._id),
        before: { userId, companyIds: before }, after: { userId, companyIds: ticked },
      });
    }
    return (await this.rowsOf(ctx, [grant]))[0];
  }

  /**
   * **`DELETE /admin/product-data-grants/:userId`**: *Kelola data produk* off, at once. `404` when the person holds no
   * live grant. The row is kept, `revokedAt` and `revokedBy` written, and audited `product_data_grant.revoked`.
   */
  async revoke(ctx: RequestContext, userId: string): Promise<ProductDataGrantRevoked> {
    this.require(ctx, 'product_data_grant:manage');
    const now = this.clock.now();
    const grant = await this.grants.findOneAndUpdate(
      { userId, revokedAt: null, deletedAt: null },
      { $set: { revokedAt: now, revokedBy: ctx.userId } },
      { new: false },
    ).exec();
    if (!grant) throw new NotFoundException('Product data access');
    await this.audit.record(ctx, {
      action: 'product_data_grant.revoked', targetCollection: 'productDataGrants', targetId: String(grant._id),
      before: { userId, companyIds: [...grant.companyIds] }, after: null,
    });
    return { userId, revokedAt: now.toISOString() };
  }

  /**
   * **`GET /admin/product-data-grants/changes`**, *Perubahan oleh pengelola* (ADR-0260 §6; the P1b spec's *Rules*): every
   * change to a company's product data by somebody who holds or held *Kelola data produk*, newest first,
   * `PRODUCT_DATA_CHANGES.PAGE_SIZE` a page. Read from the platform's log, where every change to a company's data is
   * written whoever made it (`AuditService.recordForCompany`), so no read crosses an office's scope.
   */
  async changes(ctx: RequestContext, cursor?: string): Promise<ProductDataChangesPage> {
    this.require(ctx, 'product_data_grant:read');
    const after = cursor === undefined ? null : cursorOf(cursor);
    const holders = (await this.grants.distinct('userId', { deletedAt: null }).exec()).map(String);
    const limit = PRODUCT_DATA_CHANGES.PAGE_SIZE;
    if (holders.length === 0) return { items: [], page: { cursor: cursor ?? null, nextCursor: null, limit, hasMore: false } };

    const rows = await this.audit.findNewestFirst(
      null,
      { actorUserId: { $in: holders }, action: { $regex: PRODUCT_DATA_CHANGE_ACTION } },
      after,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await this.changeRowsOf(ctx, page),
      page: {
        cursor: cursor ?? null,
        nextCursor: hasMore && last ? encodeCursor(`${timeOf(last).toISOString()}|${String(last._id)}`) : null,
        limit,
        hasMore,
      },
    };
  }

  /**
   * **Whether this person could hold it now** (ADR-0260 §1): an active membership whose office they own, or on which
   * they are a KPM Admin. Read across offices through the repository's named method — the Super Admin is in none.
   */
  private async eligible(ctx: RequestContext, userId: string): Promise<boolean> {
    return (await this.holding(ctx, [userId])).has(userId);
  }

  /** Of these people, the ones who are an active KPM Owner or KPM Admin now, each with their KPM. */
  private async holding(ctx: RequestContext, userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const live = await this.memberships.findAcrossAllTenants(ctx, { userId: { $in: [...userIds] }, status: 'active' });
    const offices = await this.kpms
      .find({ _id: { $in: [...new Set(live.map((m) => m.kpmId))].filter(isObjectId) }, deletedAt: null }, { ownerUserId: 1 })
      .lean()
      .exec() as { _id: unknown; ownerUserId?: string | null }[];
    const owner = new Map(offices.map((k) => [String(k._id), k.ownerUserId ? String(k.ownerUserId) : null]));
    const held = new Map<string, string>();
    for (const m of live) {
      if (m.adminAccess?.isKpmAdmin || owner.get(m.kpmId) === m.userId) held.set(m.userId, m.kpmId);
    }
    return held;
  }

  /** The person, or `404`: an unknown id, a deleted account. */
  private async person(userId: string): Promise<void> {
    if (!isObjectId(userId)) throw new NotFoundException('User');
    const found = await this.users.exists({ _id: userId, deletedAt: null }).exec();
    if (!found) throw new NotFoundException('User');
  }

  /** Every id an insurer company that exists, or `400` naming the first that is not. */
  private async insurers(companyIds: readonly string[]): Promise<void> {
    const found = await this.companies
      .find({ _id: { $in: [...companyIds] }, deletedAt: null, ...INSURERS_ONLY }, { _id: 1 })
      .lean()
      .exec();
    const known = new Set(found.map((c) => String(c._id)));
    const missing = companyIds.find((id) => !known.has(id));
    if (missing) {
      throw new InvalidRequestException(SAY.VALIDATION_FAILED.notAnInsurer({ companyId: missing }), {
        field: 'companyIds', companyId: missing,
      });
    }
  }

  /** The rows, named: the holder, their KPM, the insurers A to Z, who gave it. */
  private async rowsOf(ctx: RequestContext, grants: ProductDataGrantDocument[]): Promise<ProductDataGrantRow[]> {
    if (grants.length === 0) return [];
    const people = await this.users
      .find({ _id: { $in: [...new Set(grants.flatMap((g) => [g.userId, g.grantedBy]))].filter(isObjectId) } },
        { fullName: 1, email: 1 })
      .lean()
      .exec() as { _id: unknown; fullName?: string; email?: string }[];
    const person = new Map(people.map((p) => [String(p._id), p]));
    const firms = await this.companies
      .find({ _id: { $in: [...new Set(grants.flatMap((g) => g.companyIds))].filter(isObjectId) } }, { name: 1 })
      .lean()
      .exec() as { _id: unknown; name: string }[];
    const firm = new Map(firms.map((c) => [String(c._id), c.name]));
    const held = await this.holding(ctx, grants.map((g) => g.userId));
    const offices = await this.kpms
      .find({ _id: { $in: [...new Set(held.values())].filter(isObjectId) } }, { code: 1, branchName: 1 })
      .lean()
      .exec() as { _id: unknown; code: string; branchName: string }[];
    const office = new Map(offices.map((k) => [String(k._id), `KPM ${k.code} — ${k.branchName}`]));

    return grants.map((g) => {
      const who = person.get(g.userId);
      const kpmId = held.get(g.userId) ?? null;
      return {
        userId: g.userId,
        fullName: who?.fullName ?? render(TENANTS_MESSAGES.unknownPerson, ctx.reader),
        email: who?.email ?? '',
        kpmId,
        kpmLabel: kpmId ? (office.get(kpmId) ?? null) : null,
        holds: kpmId !== null,
        companies: g.companyIds
          .map((companyId) => ({ companyId, name: firm.get(companyId) ?? companyId }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        grantedAt: g.grantedAt.toISOString(),
        grantedByName: person.get(g.grantedBy)?.fullName ?? null,
        updatedAt: (g.get('updatedAt') as Date | undefined)?.toISOString() ?? g.grantedAt.toISOString(),
      };
    });
  }

  /** A page of audit rows, named: the action in words, the actor, their KPM, the company and the product. */
  private async changeRowsOf(ctx: RequestContext, rows: AuditLogDocument[]): Promise<ProductDataChangeRow[]> {
    const written = rows.map(changeOf);
    const actorIds = [...new Set(rows.map((r) => String(r.actorUserId)))].filter(isObjectId);
    // The row is the platform's (`recordForCompany`), so the holder's office is their membership's: read across offices
    // through the repository's named method, as `holding` reads them. A row written in an office's scope still names it.
    const membershipIds = [...new Set(rows.map((r) => r.actorMembershipId).filter(isObjectId))];
    const acting = membershipIds.length === 0 ? []
      : await this.memberships.findAcrossAllTenants(ctx, { _id: { $in: membershipIds } });
    const officeOfMembership = new Map(acting.map((m) => [String(m._id), String(m.kpmId)]));
    const officeOf = (row: AuditLogDocument) =>
      (row.kpmId ? String(row.kpmId) : null) ?? (row.actorMembershipId ? officeOfMembership.get(String(row.actorMembershipId)) ?? null : null);
    const officeIds = [...new Set(rows.map(officeOf).filter(isObjectId))];
    const companyIds = [...new Set(written.map((w) => w.companyId).filter(isObjectId))];
    const productIds = [...new Set(written.map((w) => w.productId).filter(isObjectId))];
    const [people, offices, firms, products] = await Promise.all([
      this.users.find({ _id: { $in: actorIds } }, { fullName: 1 }).lean().exec() as Promise<{ _id: unknown; fullName?: string }[]>,
      this.kpms.find({ _id: { $in: officeIds } }, { code: 1, branchName: 1 }).lean().exec() as Promise<
        { _id: unknown; code: string; branchName: string }[]>,
      this.companies.find({ _id: { $in: companyIds } }, { name: 1 }).lean().exec() as Promise<{ _id: unknown; name: string }[]>,
      this.products.find({ _id: { $in: productIds } }, { name: 1 }).lean().exec() as Promise<{ _id: unknown; name: string }[]>,
    ]);
    const name = (list: { _id: unknown; fullName?: string; name?: string }[]) =>
      new Map(list.map((x) => [String(x._id), x.fullName ?? x.name ?? null]));
    const personName = name(people);
    const companyName = name(firms);
    const productName = name(products);
    const office = new Map(offices.map((k) => [String(k._id), { code: k.code, label: `KPM ${k.code} · ${k.branchName}` }]));

    return rows.map((row, i) => {
      const { companyId, productId } = written[i];
      const kpmId = officeOf(row);
      const at = kpmId ? office.get(kpmId) : undefined;
      return {
        auditId: String(row._id),
        createdAt: timeOf(row).toISOString(),
        action: row.action,
        actionLabel: actionLabel(row.action, ctx.reader, at?.code ?? null),
        targetCollection: row.targetCollection,
        targetKind: targetKindLabel(row.targetCollection, ctx.reader),
        targetId: row.targetId ? String(row.targetId) : null,
        actorUserId: String(row.actorUserId),
        actorName: personName.get(String(row.actorUserId)) ?? null,
        kpmId,
        officeLabel: at?.label ?? null,
        companyId,
        companyName: companyId ? (companyName.get(companyId) ?? null) : null,
        productId,
        productName: productId ? (productName.get(productId) ?? null) : null,
      };
    });
  }

  private require(ctx: RequestContext, permission: Permission): void {
    if (!can(ctx, permission)) throw new PermissionDeniedException(permission);
  }
}

/** The same ids, whatever their order. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

const timeOf = (row: AuditLogDocument): Date => (row as unknown as { createdAt: Date }).createdAt;

/**
 * **The company and the product a change names**: the row's own `after`, else its `before` — a premium table, a rule set,
 * an intake item and an illustration each carry both (ADR-0258, ADR-0259) — or the product it targets.
 */
function changeOf(row: AuditLogDocument): { companyId: string | null; productId: string | null } {
  const pick = (key: string): string | null => {
    for (const side of [row.after, row.before]) {
      const value = side?.[key];
      if (value !== undefined && value !== null && String(value)) return String(value);
    }
    return null;
  };
  const productId = pick('productId') ?? (row.targetCollection === 'products' && row.targetId ? String(row.targetId) : null);
  return { companyId: pick('companyId'), productId };
}

/** A cursor this read wrote — `<ISO time>|<row id>`, base64url — or `400`. */
function cursorOf(cursor: string): { at: Date; id: string } {
  const [iso, id, ...rest] = decodeCursor(cursor).split('|');
  const at = new Date(iso ?? '');
  if (rest.length > 0 || !isObjectId(id) || Number.isNaN(at.getTime()) || at.toISOString() !== iso) {
    throw new InvalidRequestException(SAY.VALIDATION_FAILED.cursorShape);
  }
  return { at, id };
}
