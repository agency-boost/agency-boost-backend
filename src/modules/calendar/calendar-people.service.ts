import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException } from '@/common/errors/domain.exception';
import { decodeCursor, encodeCursor } from '@/common/pagination/cursor';
import { refuseWith } from '@/common/validation/fields';
import { CALENDAR } from '@/domain/constants';
import { CoachResolver, type Coachee } from '@/modules/org/coach-resolver';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import type { MembershipDocument } from '@/modules/org/membership.schema';
import { scopeFor } from '@/modules/rbac/permissions';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { CALENDAR_REFUSALS } from './calendar.messages';

/**
 * Where somebody sits relative to the reader, as the picker groups them (`Calendar_Section.html:469-480`):
 * *"Your direct unit"*, *"Your group (AAB teams)"*, *"Other units in your KPM"*, *"KPM leadership"* — in
 * that order. The compare list uses the first two, as *"Direct unit"* and *"AAB & their teams (group)"*.
 */
export const PEOPLE_GROUPS = ['direct_unit', 'group', 'other', 'leadership'] as const;
export type PeopleGroup = (typeof PEOPLE_GROUPS)[number];

/** One person the picker answers: four fields, and the group the reader sees them in (D-picker). */
export interface CalendarPersonRow {
  membershipId: string;
  name: string;
  rung: { code: string; label: string };
  /** `null` for somebody who has no leader — the office's root. */
  leaderName: string | null;
  /**
   * Their current leader is the reader: a direct report, whose tag reads the rung alone. Everybody else's
   * reads *" · under {leaderName}"* — decided here, so two people of one name never confuse it.
   */
  direct: boolean;
  group: PeopleGroup;
}

export interface CalendarPeoplePage {
  items: CalendarPersonRow[];
  page: { cursor: string | null; nextCursor: string | null; limit: number; hasMore: boolean };
}

/** One person a leader may compare, as the popover lists them (D-reach). */
export interface CalendarDownlineRow extends CalendarPersonRow {
  /** Levels below the reader: 1 answers to them directly. */
  depth: number;
  group: Extract<PeopleGroup, 'direct_unit' | 'group'>;
}

export interface CalendarDownline {
  people: CalendarDownlineRow[];
}

/** `GET /calendar/people`'s query, as the DTO has validated its shape. */
export interface PeopleQuery {
  q?: string;
  cursor?: string;
  limit?: number;
}

/** A position in the picker's order: its group, then the path of names from the group's top. */
interface OrderKey {
  g: number;
  p: [string, string][];
}

/**
 * **The people picker and the compare list** (P12-T4 AC-1 to AC-3, P12-T5 AC-2; `functional/calendar.md`,
 * *The people picker* and *Compare*).
 *
 * **The picker is §2 rule 4's exception (a)** (D-picker, ADR-0094): every field role lists the office's
 * active field members — a rung on the company's ladder, `status: active` — in four fields, never the
 * reader, and nothing else about anybody. A member of another office is not in the read at all; a
 * pending or removed member and an Owner or Admin on no rung are not answered.
 *
 * **The compare list is `COACH`** (D-reach): everybody the reader coaches now, an AAB's agents after
 * their AAB — the roster's own reach, through `CoachResolver.coacheesOf`. A reader whose role holds no
 * downline read, an Agent, is answered nobody.
 *
 * Neither is audited: both answer directory facts, as `GET /coaching/coachees/:membershipId` does.
 */
@Injectable()
export class CalendarPeopleService {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly coach: CoachResolver,
    private readonly names: MemberNames,
    private readonly orgLevels: OrgLevelService,
    private readonly days: TenantDay,
  ) {}

  /**
   * **`GET /calendar/people`**: the picker, searched on the server by a case-insensitive part of the
   * full name, in the picker's group order — then tree order, names A to Z within a level — and paged by
   * a cursor on that order, so a member joining between two pages neither repeats nor skips anybody.
   *
   * - *Your direct unit*: the reader's direct reports on the agent rung who lead nobody.
   * - *Your group (AAB teams)*: every other direct report, each followed by everyone below them.
   * - *Other units in your KPM*: everybody else who is not above the reader, in the office's tree order.
   * - *KPM leadership*: the reader's upline, their own leader first (ADR-0094).
   */
  async people(ctx: RequestContext, query: PeopleQuery): Promise<CalendarPeoplePage> {
    const me = requireMembership(ctx);
    const limit = query.limit ?? CALENDAR.PEOPLE_PAGE_MAX;
    const after = query.cursor === undefined ? null : keyOf(query.cursor);

    const [labels, members] = await Promise.all([
      this.ladder(ctx),
      this.memberships.find(ctx, { status: 'active' }, { projection: MEMBER_FIELDS }),
    ]);
    const field = members.filter((m) => labels.has(m.orgLevelCode));
    const self = members.find((m) => String(m._id) === me);
    const names = await this.names.byMembershipId(ctx, [
      ...field.map((m) => String(m._id)), ...field.flatMap((m) => (m.leaderId ? [m.leaderId] : [])),
    ]);
    const nameOf = (id: string) => names.get(id) ?? '';

    const above = self?.ancestorIds ?? [];
    const leading = new Set(field.map((m) => m.leaderId));
    const directs = field.filter((m) => m.leaderId === me);
    const directUnit = new Set(
      directs.filter((m) => m.role === 'agent' && !leading.has(String(m._id))).map((m) => String(m._id)),
    );
    const segment = (id: string): [string, string] => [nameOf(id), id];

    const placed = field
      .filter((m) => String(m._id) !== me)
      .map((m) => {
        const id = String(m._id);
        let key: OrderKey;
        let group: PeopleGroup;
        if (directUnit.has(id)) {
          group = 'direct_unit';
          key = { g: 0, p: [segment(id)] };
        } else if (m.ancestorIds.includes(me)) {
          group = 'group';
          key = { g: 1, p: [...m.ancestorIds.slice(m.ancestorIds.indexOf(me) + 1), id].map(segment) };
        } else if (above.includes(id)) {
          group = 'leadership';
          key = { g: 3, p: [[String(above.length - above.indexOf(id)).padStart(6, '0'), id]] };
        } else {
          group = 'other';
          key = { g: 2, p: [...m.ancestorIds, id].map(segment) };
        }
        return { key, row: this.row(m, nameOf, labels, group, me) };
      });

    const q = query.q?.trim().toLocaleLowerCase() ?? '';
    const ordered = placed
      .filter(({ row }) => q === '' || row.name.toLocaleLowerCase().includes(q))
      .sort((a, b) => compareKeys(a.key, b.key));
    const rest = after === null ? ordered : ordered.filter(({ key }) => compareKeys(key, after) > 0);
    const page = rest.slice(0, limit);
    const hasMore = rest.length > limit;
    return {
      items: page.map(({ row }) => row),
      page: {
        cursor: query.cursor ?? null,
        nextCursor: hasMore ? encodeCursor(JSON.stringify(page[page.length - 1].key)) : null,
        limit,
        hasMore,
      },
    };
  }

  /**
   * **`GET /calendar/downline`**: everybody the reader coaches now (`COACH`, D-reach), grouped as the
   * popover groups them — *Direct unit*, the direct reports on the agent rung who lead nobody; then *AAB &
   * their teams (group)*, every other direct report followed by everyone below them in tree order —
   * names A to Z within a level. Not paginated: one leader's reach, as the coaching roster.
   */
  async downline(ctx: RequestContext): Promise<CalendarDownline> {
    const me = requireMembership(ctx);
    if (scopeFor(ctx, 'calendar_entry:read') !== 'own-downline') return { people: [] };
    const coachees = await this.coach.coacheesOf(ctx, me);
    if (coachees.length === 0) return { people: [] };

    const [labels, names] = await Promise.all([
      this.ladder(ctx),
      this.names.byMembershipId(ctx, [...coachees.map((c) => c.membershipId), ...coachees.map((c) => c.membership.leaderId as string)]),
    ]);
    const nameOf = (id: string) => names.get(id) ?? '';
    const aToZ = (a: Coachee, b: Coachee) =>
      nameOf(a.membershipId).localeCompare(nameOf(b.membershipId)) || a.membershipId.localeCompare(b.membershipId);

    // Every link between the reader and a coachee is a coachee too (`coacheesOf`), so the tree is whole.
    const below = new Map<string, Coachee[]>();
    for (const c of coachees) {
      const leader = c.membership.leaderId as string;
      below.set(leader, [...(below.get(leader) ?? []), c]);
    }
    for (const level of below.values()) level.sort(aToZ);
    const leads = (c: Coachee) => below.has(c.membershipId);
    const row = (c: Coachee, group: CalendarDownlineRow['group']): CalendarDownlineRow => ({
      ...this.row(c.membership, nameOf, labels, group, me),
      group,
      depth: c.depth,
    });
    const subtree = (c: Coachee): CalendarDownlineRow[] =>
      (below.get(c.membershipId) ?? []).flatMap((child) => [row(child, 'group'), ...subtree(child)]);

    const direct = below.get(me) as Coachee[];
    return {
      people: [
        ...direct.filter((c) => c.membership.role === 'agent' && !leads(c)).map((c) => row(c, 'direct_unit')),
        ...direct.filter((c) => c.membership.role !== 'agent' || leads(c)).flatMap((head) => [row(head, 'group'), ...subtree(head)]),
      ],
    };
  }

  private row(
    m: MembershipDocument, nameOf: (id: string) => string, labels: ReadonlyMap<string, string>, group: PeopleGroup,
    readerId: string,
  ): CalendarPersonRow {
    return {
      membershipId: String(m._id),
      name: nameOf(String(m._id)),
      rung: { code: m.orgLevelCode, label: labels.get(m.orgLevelCode) ?? m.orgLevelCode },
      leaderName: m.leaderId ? nameOf(m.leaderId) || null : null,
      direct: m.leaderId === readerId,
      group,
    };
  }

  /** The company's ladder, by code: its labels, and which codes are field rungs at all. */
  private async ladder(ctx: RequestContext): Promise<Map<string, string>> {
    const office = await this.days.office(ctx);
    const levels = office.companyId ? await this.orgLevels.list(ctx, office.companyId) : [];
    return new Map(levels.map((level) => [level.code, level.label]));
  }
}

/** What the picker reads of each member: who they are, where they sit, and their rung. */
const MEMBER_FIELDS = { _id: 1, userId: 1, leaderId: 1, ancestorIds: 1, orgLevelCode: 1, role: 1 } as const;

function requireMembership(ctx: RequestContext): string {
  const me = ctx.membershipId;
  if (!me) throw new NoMembershipException();
  return me;
}

/** The picker's order: by group, then segment by segment — a leader before the people below them. */
function compareKeys(a: OrderKey, b: OrderKey): number {
  if (a.g !== b.g) return a.g - b.g;
  const length = Math.min(a.p.length, b.p.length);
  for (let i = 0; i < length; i += 1) {
    const byName = a.p[i][0].localeCompare(b.p[i][0]);
    if (byName !== 0) return byName;
    if (a.p[i][1] !== b.p[i][1]) return a.p[i][1] < b.p[i][1] ? -1 : 1;
  }
  return a.p.length - b.p.length;
}

/** A cursor the picker wrote, or 400: it is opaque, and one that is not ours is a malformed request. */
function keyOf(cursor: string): OrderKey {
  try {
    const key = JSON.parse(decodeCursor(cursor)) as OrderKey;
    const wellFormed = Number.isInteger(key?.g) && Array.isArray(key.p)
      && key.p.every((s) => Array.isArray(s) && s.length === 2 && s.every((part) => typeof part === 'string'));
    if (wellFormed) return key;
  } catch {
    // Falls through to the refusal below.
  }
  return refuseWith([CALENDAR_REFUSALS.VALIDATION_FAILED.cursorNotOurs]);
}
