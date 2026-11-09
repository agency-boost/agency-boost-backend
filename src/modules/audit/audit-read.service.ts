import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { DateTime } from 'luxon';
import { FilterQuery, Model } from 'mongoose';
import { InvalidRequestException } from '@/common/errors/domain.exception';
import { decodeCursor, encodeCursor } from '@/common/pagination/cursor';
import { readerOf, type Reader } from '@/common/i18n/reader';
import { AUDIT_LOG, DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { CompanyTemplate, CompanyTemplateDocument } from '@/modules/config/company-template.schema';
import { NamedTemplate, NamedTemplateDocument } from '@/modules/config/named-template.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Product, ProductDocument } from '@/modules/products/product.schema';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelDocument } from '@/modules/tenants/company-org-level.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { KpmRequest, KpmRequestDocument } from '@/modules/tenants/kpm-request.schema';
import { User, UserDocument } from '@/modules/users/user.schema';
import { actionLabel, sectionLabel, targetKindLabel } from './audit-labels.messages';
import { AuditLogDocument } from './audit-log.schema';
import { AUDIT_REFUSALS } from './audit.messages';
import { AuditService } from './audit.service';

const SAY = AUDIT_REFUSALS.VALIDATION_FAILED;

/** A 24-character hex id. Anything else makes `$in` throw a CastError on the whole page. */
function isObjectId(value: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(value);
}

/** `leader_note.read` and `leader_note.saved` (ADR-0073): the rows that say a note about somebody exists. */
const LEADER_NOTE_ACTION = /^leader_note\./;

/** The member a leader-note row is about, or `null` for any other row. */
function leaderNoteSubject(row: { action: string; after?: Record<string, unknown> | null }): string | null {
  if (!LEADER_NOTE_ACTION.test(row.action)) return null;
  return String(row.after?.coacheeMembershipId ?? '');
}

/**
 * **Rows read from the log per round trip** while a page is being folded into groups. Not a business number — the page's
 * are `AUDIT_LOG`'s — only how many rows one read fetches: a page of fifty groups of one is one read, and a page whose
 * groups are long (an editing session's ninety autosaves) takes a few more.
 */
const BATCH = 200;

/** One audit row, with the people and the target named where they can be. */
export interface ResolvedAuditRow {
  _id: string;
  createdAt: Date;
  action: string;
  /**
   * **The action in the reader's words** (P19.4-T3 AC-11; SA UI-016): *"Draf template disimpan"*, never
   * `company_template.draft_saved` — or the action as recorded where no label names it.
   */
  actionLabel: string;
  targetCollection: string;
  /** **What kind of thing the target is**, in the reader's words (*"Produk"*, *"Bagian template"*); the collection's name where nothing names it. */
  targetKind: string;
  targetId: string | null;
  /**
   * **The target's name** (P19.4-T3 AC-11): *"Prudential template · Aktivitas & rasio"*, *"PRUProsper"*, *"KPM 0417 ·
   * Bandung"*, a person. `null` when the id resolves to nothing, or to a collection nobody has named yet.
   */
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
 * **One line of the audit page** (§B.32): a run of identical rows read as one — its newest row, named, with how many
 * rows it stands for and when the oldest of them was written. A row nothing repeats is a group of one.
 */
export interface AuditGroup extends ResolvedAuditRow {
  /** How many rows the line stands for: *×28*. `1` for a row nothing repeated. */
  count: number;
  /** The oldest row's time; `createdAt` is the newest's. Equal for a group of one. */
  oldestAt: Date;
}

/** What the page's *Tindakan* and *Pelaku* chips offer: every action and every actor within the reach. */
export interface AuditFacets {
  actions: string[];
  /** Each of `actions` in the reader's words, in the same order (P19.4-T3 AC-11). */
  actionLabels: { action: string; label: string }[];
  actors: { userId: string; name: string | null }[];
}

/** One page of the log, as `GET /admin/audit` answers it. */
export interface AuditPage {
  items: AuditGroup[];
  page: { cursor: string | null; nextCursor: string | null; limit: number; hasMore: boolean };
  /** On the first page only (no `cursor`): the chips' options. `null` on every later page. */
  facets: AuditFacets | null;
}

/** Who reads, and which log: the scope the controller resolved, never the one the query asked for. */
export interface AuditReach {
  /** `null` is the platform-level log. */
  kpmId: string | null;
  readerUserId: string;
  /** Who the labels are written for (P19.4-T3 AC-11); a reader who has chosen nothing where absent. */
  reader?: Reader;
}

/** What narrows the log within the reach. Each one absent narrows nothing. */
export interface AuditFilters {
  companyId?: string;
  action?: string;
  actorUserId?: string;
  /** Office days, `YYYY-MM-DD`, both inclusive. */
  from?: string;
  to?: string;
}

/** A group being folded: its head (the newest row), its count and its oldest time. */
interface Folding {
  head: AuditLogDocument;
  count: number;
  oldest: AuditLogDocument;
}

const timeOf = (row: AuditLogDocument): Date => (row as unknown as { createdAt: Date }).createdAt;

/**
 * Reading the audit log with the people and the things named, a page at a time.
 *
 * **An audit log of ids is a log nobody reads.** Every row on the console said
 * `68f3c1a9… changed 68f3c2b4…`, so answering *"who suspended Surabaya?"* meant three lookups
 * in a database shell — which is the question the log exists to answer, and the one moment
 * nobody wants to be writing queries.
 *
 * **And a log of every row is one nobody reaches the end of** (UI-132): one editing session wrote ninety
 * `company_template.draft_saved` rows. So the read pages, filters and groups on the server (§B.32), and the screen
 * draws what it is sent.
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
    /*
     * **The names the platform's own rows need** (P19.4-T3 AC-11; SA UI-016): a template, a template's section, a
     * product, a rung of a ladder, a KPM request. Platform and company collections, none of them an office's — an
     * office's own records are named by the member the row is about (`targetMembershipId`) or by their KPM, through
     * reads this service already makes, so no tenant-scoped model is read here (invariant §1).
     */
    @InjectModel(NamedTemplate.name) private readonly templates?: Model<NamedTemplateDocument>,
    @InjectModel(CompanyTemplate.name) private readonly templateRows?: Model<CompanyTemplateDocument>,
    @InjectModel(Product.name) private readonly products?: Model<ProductDocument>,
    @InjectModel(CompanyOrgLevel.name) private readonly orgLevels?: Model<CompanyOrgLevelDocument>,
    @InjectModel(KpmRequest.name) private readonly kpmRequests?: Model<KpmRequestDocument>,
  ) {}

  /**
   * **One page of the log** (P19.2-T2 AC-6; `metrics-and-definitions.md` §B.32).
   *
   * Rows are read newest first, **after** the reach, the filters and ADR-0073's drop of the rows about the reader, and
   * folded as they come: a row joins the group above it when it is the next row of that list and has the same actor
   * (and the same effective actor in a support session), the same action and the same target, and is no more than
   * `AUDIT_LOG.GROUP_WINDOW_MINUTES` older than the group's newest row — inclusive. A page ends when a
   * `PAGE_SIZE + 1`th group would begin, so its last group is whole; the cursor names that group's oldest row, and the
   * next page begins at the row after it.
   */
  async page(reach: AuditReach, filters: AuditFilters, cursor?: string): Promise<AuditPage> {
    const after = cursor === undefined ? null : this.cursorOf(cursor);
    const filter = await this.filterOf(reach.kpmId, filters);
    const windowMs = AUDIT_LOG.GROUP_WINDOW_MINUTES * 60_000;

    const groups: Folding[] = [];
    let resumeAfter = after;
    let hasMore = false;
    for (;;) {
      const batch = await this.audit.findNewestFirst(reach.kpmId, filter, resumeAfter, BATCH);
      const kept = await this.withoutNotesAboutTheReader(batch, reach.readerUserId);
      for (const row of kept) {
        const last = groups[groups.length - 1];
        if (last && this.joins(last, row, windowMs)) {
          last.count += 1;
          last.oldest = row;
          continue;
        }
        if (groups.length === AUDIT_LOG.PAGE_SIZE) {
          hasMore = true;
          break;
        }
        groups.push({ head: row, count: 1, oldest: row });
      }
      if (hasMore || batch.length < BATCH) break;
      const tail = batch[batch.length - 1];
      resumeAfter = { at: timeOf(tail), id: String(tail._id) };
    }

    const reader = reach.reader ?? readerOf();
    const named = await this.resolve(groups.map((g) => g.head), reader);
    const items = groups.map((g, i) => ({ ...named[i], count: g.count, oldestAt: timeOf(g.oldest) }));
    const lastGroup = groups[groups.length - 1];
    return {
      items,
      page: {
        cursor: cursor ?? null,
        nextCursor: hasMore && lastGroup
          ? encodeCursor(`${timeOf(lastGroup.oldest).toISOString()}|${String(lastGroup.oldest._id)}`)
          : null,
        limit: AUDIT_LOG.PAGE_SIZE,
        hasMore,
      },
      facets: cursor === undefined ? await this.facetsOf(reach.kpmId, reader) : null,
    };
  }

  /** Same actor, same effective actor, same action, same target — and within the window of the group's newest row. */
  private joins(group: Folding, row: AuditLogDocument, windowMs: number): boolean {
    const head = group.head;
    return String(head.actorUserId ?? '') === String(row.actorUserId ?? '')
      && String(head.effectiveUserId ?? '') === String(row.effectiveUserId ?? '')
      && head.action === row.action
      && head.targetCollection === row.targetCollection
      && String(head.targetId ?? '') === String(row.targetId ?? '')
      && timeOf(head).getTime() - timeOf(row).getTime() <= windowMs;
  }

  /** A cursor this read wrote — `<ISO time>|<row id>`, base64url — or `400`. */
  private cursorOf(cursor: string): { at: Date; id: string } {
    const [iso, id, ...rest] = decodeCursor(cursor).split('|');
    const at = new Date(iso ?? '');
    if (rest.length > 0 || !id || !isObjectId(id) || Number.isNaN(at.getTime()) || at.toISOString() !== iso) {
      throw new InvalidRequestException(SAY.cursorShape);
    }
    return { at, id };
  }

  /**
   * The filters, as one query **within** the scope (which `AuditService` puts first).
   *
   * - **A company**: a row in one of its offices (soft-deleted ones too — their rows are still the company's), a row
   *   whose target is the company itself, or a row whose change names it (`after.companyId`, `before.companyId`):
   *   its products, its templates, its ladder.
   * - **The dates** are office days, from the first's midnight to the midnight after the last, on the scoped office's
   *   calendar — `Asia/Jakarta` for the platform-level log, which belongs to no office (ADR-0016).
   */
  private async filterOf(kpmId: string | null, filters: AuditFilters): Promise<FilterQuery<AuditLogDocument>> {
    const and: FilterQuery<AuditLogDocument>[] = [];
    if (filters.action) and.push({ action: filters.action });
    if (filters.actorUserId) and.push({ actorUserId: filters.actorUserId });
    if (filters.companyId) {
      const offices = await this.kpms.find({ companyId: filters.companyId }, { _id: 1 }).lean().exec();
      and.push({
        $or: [
          { kpmId: { $in: offices.map((o) => String(o._id)) } },
          { targetCollection: 'companies', targetId: filters.companyId },
          { 'after.companyId': filters.companyId },
          { 'before.companyId': filters.companyId },
        ],
      });
    }
    if (filters.from !== undefined || filters.to !== undefined) {
      if (filters.from !== undefined && filters.to !== undefined && filters.to < filters.from) {
        throw new InvalidRequestException(SAY.rangeBackwards);
      }
      const zone = await this.zoneOf(kpmId);
      const range: Record<string, Date> = {};
      if (filters.from !== undefined) range.$gte = this.midnight(filters.from, zone);
      if (filters.to !== undefined) {
        // The midnight after the last day: checked as a day first, so `2026-02-30` is refused rather than rolled over.
        range.$lt = DateTime.fromJSDate(this.midnight(filters.to, zone)).setZone(zone).plus({ days: 1 }).toUTC().toJSDate();
      }
      and.push({ createdAt: range });
    }
    return and.length === 0 ? {} : { $and: and };
  }

  /** The office's midnight beginning a day, as an instant; a day that is not one (`2026-02-30`) is `400`. */
  private midnight(day: string, zone: string): Date {
    const at = DateTime.fromISO(day, { zone });
    if (!at.isValid) throw new InvalidRequestException(SAY.dateShape);
    return at.startOf('day').toUTC().toJSDate();
  }

  /** The scoped office's time zone; the platform's default where the log is the platform's own. */
  private async zoneOf(kpmId: string | null): Promise<string> {
    if (kpmId === null || !isObjectId(kpmId)) return DEFAULT_TENANT_TIMEZONE;
    const kpm = await this.kpms.findById(kpmId, { timezone: 1 }).lean().exec();
    return (kpm as { timezone?: string } | null)?.timezone ?? DEFAULT_TENANT_TIMEZONE;
  }

  /**
   * **The chips' options, within the reach**, whatever the filters — so choosing one action never empties the list of
   * the others. Every action, and every actor named. The actors of `leader_note.*` rows are left out (ADR-0073): the
   * only row by somebody may be a note about the reader, and an actor offered with nothing to show says a note exists.
   */
  private async facetsOf(kpmId: string | null, reader: Reader): Promise<AuditFacets> {
    const [actions, actorIds] = await Promise.all([
      this.audit.distinctWithin(kpmId, 'action'),
      this.audit.distinctWithin(kpmId, 'actorUserId', { action: { $not: LEADER_NOTE_ACTION } }),
    ]);
    const people = await this.lookup(this.users as unknown as Model<Record<string, unknown>>, actorIds.filter(isObjectId));
    const nameOf = (id: string) => {
      const row = people.get(id) as { fullName?: string } | undefined;
      return row?.fullName ? String(row.fullName) : null;
    };
    const sorted = [...actions].sort();
    return {
      actions: sorted,
      actionLabels: sorted.map((action) => ({ action, label: actionLabel(action, reader) })),
      actors: actorIds
        .map((userId) => ({ userId, name: nameOf(userId) }))
        .sort((a, b) => (a.name ?? a.userId).localeCompare(b.name ?? b.userId)),
    };
  }

  /**
   * **Resolved in a handful of round trips, not one per row.** The ids on a page are collected
   * first and each collection read once, so a page costs the same dozen reads whatever its length.
   * `$in` over primary keys, all of them indexed, deleted rows included — a row about a product deleted since still
   * names it. Only the groups' newest rows are named: that is what the page draws.
   *
   * **What is named, and by what** (P19.4-T3 AC-11; SA UI-016):
   * - a template by its name; a template's section as *"<template> · <section>"*, by the row's own `after` (the
   *   template and the kind it was written with), or the section row's where a row carries none;
   * - a product by its name; an office's product switch by the product its row names, in that office's company;
   * - a rung by its label and code; a KPM request by its branch; a KPM as *"KPM 0417 · Bandung"*;
   * - an office's own records — a lead, a session, a goal — by the member the row is about (`targetMembershipId`),
   *   else by the office they are in. No office's record is read for it.
   *
   * **An id that resolves to nothing keeps its id.** A target in a collection nobody has taught
   * this about renders as the id it was, because a blank cell reads as *nothing happened*
   * rather than *this is all we know*.
   */
  private async resolve(rows: AuditLogDocument[], reader: Reader): Promise<ResolvedAuditRow[]> {
    const userIds = new Set<string>();
    const byCollection = new Map<string, Set<string>>();
    const memberIds = new Set<string>();
    const officeIds = new Set<string>();
    const templateIds = new Set<string>();
    const productCodes = new Set<string>();
    for (const row of rows) {
      if (row.actorUserId) userIds.add(String(row.actorUserId));
      if (row.effectiveUserId) userIds.add(String(row.effectiveUserId));
      if (row.kpmId) officeIds.add(String(row.kpmId));
      if (row.targetMembershipId) memberIds.add(String(row.targetMembershipId));
      const written = changeOf(row);
      if (typeof written.templateId === 'string') templateIds.add(written.templateId);
      if (row.targetCollection === 'kpmProductConfigs' && typeof written.code === 'string') productCodes.add(written.code);
      if (!row.targetId) continue;
      const id = String(row.targetId);
      if (row.targetCollection === 'users') userIds.add(id);
      if (row.targetCollection === 'memberships') memberIds.add(id);
      if (row.targetCollection === 'kpms') officeIds.add(id);
      if (row.targetCollection === 'templates') templateIds.add(id);
      const set = byCollection.get(row.targetCollection) ?? new Set<string>();
      set.add(id);
      byCollection.set(row.targetCollection, set);
    }

    const ids = (name: string) => [...(byCollection.get(name) ?? [])].filter(isObjectId);
    const loose = (model: unknown) => model as Model<Record<string, unknown>> | undefined;

    const [people, memberRows, offices, firms, sectionRows, products, codedProducts, rungs, requests] = await Promise.all([
      this.lookup(loose(this.users), [...userIds].filter(isObjectId)),
      // Through the repository's explicitly named cross-tenant method, not the model:
      // invariant §1, and `repositories.tenancy.spec.ts` enforces it.
      this.memberships.byIdsAnywhereForAudit([...memberIds].filter(isObjectId)),
      this.lookup(loose(this.kpms), [...officeIds].filter(isObjectId)),
      this.lookup(loose(this.companies), ids('companies')),
      this.lookup(loose(this.templateRows), [...ids('companyTemplates'), ...ids('platformTemplates')]),
      this.lookup(loose(this.products), ids('products')),
      this.byCode(productCodes),
      this.lookup(loose(this.orgLevels), ids('companyOrgLevels')),
      this.lookup(loose(this.kpmRequests), ids('kpmRequests')),
    ]);
    const members = new Map<string, Record<string, unknown>>(
      memberRows.map((m) => [m._id, m as unknown as Record<string, unknown>]),
    );

    // A membership names a person, and a section row its template, so those are fetched in a second pass.
    for (const section of sectionRows.values()) {
      if (typeof section.templateId === 'string') templateIds.add(section.templateId);
    }
    const [memberPeople, named] = await Promise.all([
      this.lookup(
        loose(this.users),
        [...members.values()]
          .map((m) => String((m as { userId?: string }).userId ?? ''))
          .filter(isObjectId),
      ),
      this.lookup(loose(this.templates), [...templateIds].filter(isObjectId)),
    ]);

    const personName = (id: string | null | undefined): string | null => {
      if (!id) return null;
      const row = people.get(String(id)) ?? memberPeople.get(String(id));
      return row ? String((row as { fullName?: string }).fullName ?? '') || null : null;
    };

    const sources: LabelSources = {
      members, offices, firms, personName, sectionRows, products, codedProducts, rungs, requests, named, reader,
    };
    return rows.map((row) => {
      const office = officeOf(row, offices);
      return {
        _id: String(row._id),
        // `createdAt` comes from `baseSchemaOptions`' timestamps, so it is on the document and
        // not on the class Mongoose types it from.
        createdAt: timeOf(row),
        action: row.action,
        actionLabel: actionLabel(row.action, reader, office?.code ?? null),
        targetCollection: row.targetCollection,
        targetKind: targetKindLabel(row.targetCollection, reader),
        targetId: row.targetId ? String(row.targetId) : null,
        targetLabel: this.labelFor(row, sources),
        actorUserId: row.actorUserId ? String(row.actorUserId) : null,
        actorName: personName(row.actorUserId),
        effectiveUserId: row.effectiveUserId ? String(row.effectiveUserId) : null,
        effectiveName: personName(row.effectiveUserId),
        before: row.before ?? null,
        after: row.after ?? null,
      };
    });
  }

  /** The products a page's office product switches name, by code: one read, every company's, chosen per row below. */
  private async byCode(codes: Set<string>): Promise<Record<string, unknown>[]> {
    if (codes.size === 0 || !this.products) return [];
    const rows = await this.products.find({ code: { $in: [...codes] } }, { code: 1, name: 1, companyId: 1 }).lean().exec();
    return rows as unknown as Record<string, unknown>[];
  }

  /**
   * **A note's audit rows are never served to the person it is about** (ADR-0073; Phase 11 exit review,
   * N1). `leader_note.read` and `leader_note.saved` carry no text, but each says that a note about
   * `after.coacheeMembershipId` exists — and a subject never learns that from anything, a refusal
   * included. An Owner or an Admin holds `audit_log:read` and may be coached by somebody above them, so
   * the rows about them are dropped here, on the server, **before the rows are grouped and the page is
   * counted** (§B.32) — so neither a count nor a page's length says they were there.
   *
   * **Matched by the person, not the membership**: every membership a row names is resolved to its user,
   * through the repository's named cross-tenant method, and a row about any membership of the reader's —
   * one they hold now, one from before they left and rejoined — is the reader's own. Rows about anybody
   * else are served as they were.
   */
  private async withoutNotesAboutTheReader<T extends { action: string; after?: Record<string, unknown> | null }>(
    rows: T[], readerUserId: string,
  ): Promise<T[]> {
    const subjects = [...new Set(rows.map(leaderNoteSubject).filter((id): id is string => id !== null && isObjectId(id)))];
    if (subjects.length === 0) return rows;
    const members = await this.memberships.byIdsAnywhereForAudit(subjects);
    const theirs = new Set(members.filter((m) => m.userId === readerUserId).map((m) => m._id));
    return rows.filter((row) => !theirs.has(leaderNoteSubject(row) ?? ''));
  }

  /**
   * One read per collection, keyed by id. An empty list costs no read at all.
   *
   * The model is typed loosely on purpose: four different document types go through here and
   * every caller reads the result through its own narrow cast, so a generic parameter would
   * only be a shape Mongoose's `lean()` overloads argue with.
   */
  private async lookup(
    model: Model<Record<string, unknown>> | undefined, list: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    if (list.length === 0 || !model) return new Map();
    const rows = await model.find({ _id: { $in: list } }).lean().exec();
    return new Map((rows as unknown as Record<string, unknown>[])
      .map((r) => [String(r._id), r]));
  }

  /**
   * What to call the thing an action happened to.
   *
   * By its collection (P19.4-T3 AC-11, SA UI-016): the platform's and the companies' own collections by the thing's name,
   * and an office's records by the member the row is about, else by their KPM. A collection none of those name falls
   * through to `null`, and the screen shows the id.
   */
  private labelFor(row: AuditLogDocument, src: LabelSources): string | null {
    const id = row.targetId ? String(row.targetId) : null;
    const written = changeOf(row);
    const kpm = (office: Record<string, unknown> | undefined) => (office ? kpmLabel(office) : null);
    switch (row.targetCollection) {
      case 'users':
        return id ? src.personName(id) : null;
      case 'memberships':
        return id ? this.memberLabel(id, src) : null;
      case 'kpms':
        return id ? kpm(src.offices.get(id)) : null;
      case 'companies':
        return id ? ((src.firms.get(id) as { name?: string } | undefined)?.name ?? null) : null;
      case 'templates':
        return id ? nameOf(src.named.get(id)) : null;
      case 'companyTemplates':
      case 'platformTemplates': {
        const section = id ? src.sectionRows.get(id) : undefined;
        const kind = stringOf(written.kind) ?? stringOf(section?.kind);
        const templateId = stringOf(written.templateId) ?? stringOf(section?.templateId);
        const template = templateId ? nameOf(src.named.get(templateId)) : null;
        const part = kind ? sectionLabel(kind, src.reader) : null;
        if (template && part) return `${template} · ${part}`;
        return template ?? part;
      }
      case 'products':
        return id ? nameOf(src.products.get(id)) : null;
      case 'kpmProductConfigs': {
        const code = stringOf(written.code);
        const office = officeOf(row, src.offices);
        const companyId = stringOf(office?.companyId);
        const product = code
          ? src.codedProducts.find((p) => p.code === code && (!companyId || p.companyId === companyId))
          : undefined;
        return nameOf(product) ?? code ?? kpm(office);
      }
      case 'companyOrgLevels': {
        const rung = id ? src.rungs.get(id) as { label?: string; code?: string } | undefined : undefined;
        if (!rung) return null;
        return rung.label && rung.code ? `${rung.label} (${rung.code})` : (rung.label ?? rung.code ?? null);
      }
      case 'kpmRequests': {
        const request = id ? src.requests.get(id) as { branchName?: string } | undefined : undefined;
        return request?.branchName ?? null;
      }
      default: {
        // An office's own record: the member it is about, else the office it is in.
        if (row.targetMembershipId) {
          const who = this.memberLabel(String(row.targetMembershipId), src);
          if (who) return who;
        }
        return kpm(officeOf(row, src.offices));
      }
    }
  }

  /** A membership, by its person and their agent code. */
  private memberLabel(id: string, src: LabelSources): string | null {
    const row = src.members.get(id) as { userId?: string; agentCode?: string } | undefined;
    if (!row) return null;
    const name = src.personName(row.userId);
    if (!name) return null;
    return row.agentCode ? `${name} · ${row.agentCode}` : name;
  }
}

/** What a label is made from: every read of the page, done once. */
interface LabelSources {
  members: Map<string, Record<string, unknown>>;
  offices: Map<string, Record<string, unknown>>;
  firms: Map<string, Record<string, unknown>>;
  personName: (id: string | null | undefined) => string | null;
  sectionRows: Map<string, Record<string, unknown>>;
  products: Map<string, Record<string, unknown>>;
  codedProducts: Record<string, unknown>[];
  rungs: Map<string, Record<string, unknown>>;
  requests: Map<string, Record<string, unknown>>;
  named: Map<string, Record<string, unknown>>;
  reader: Reader;
}

/** The change a row records — its `after`, else its `before` — read for the fields that name its target. */
function changeOf(row: { after?: Record<string, unknown> | null; before?: Record<string, unknown> | null }): Record<string, unknown> {
  return { ...(row.before ?? {}), ...(row.after ?? {}) };
}

const stringOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

const nameOf = (row: Record<string, unknown> | undefined): string | null => stringOf(row?.name);

/** *"KPM 0417 · Bandung"* (SA UI-016): the code and the branch, the same in both languages. */
function kpmLabel(office: Record<string, unknown>): string | null {
  const code = stringOf(office.code);
  const branch = stringOf(office.branchName);
  if (!code) return branch;
  return branch ? `KPM ${code} · ${branch}` : `KPM ${code}`;
}

/** The office a row names: its target, when that is a KPM, else the scope it was written in. */
function officeOf(
  row: { targetCollection: string; targetId?: string | null; kpmId?: string | null },
  offices: Map<string, Record<string, unknown>>,
): { code?: string; companyId?: string } & Record<string, unknown> | undefined {
  const target = row.targetCollection === 'kpms' && row.targetId ? offices.get(String(row.targetId)) : undefined;
  return (target ?? (row.kpmId ? offices.get(String(row.kpmId)) : undefined)) as
    ({ code?: string; companyId?: string } & Record<string, unknown>) | undefined;
}
