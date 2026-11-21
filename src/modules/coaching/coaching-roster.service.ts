import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException } from '@/common/errors/domain.exception';
import type { LocalDate } from '@/common/time/local-day';
import type { UnitView } from '@/domain/constants';
import type { CoachingStatus } from '@/domain/constants/coaching-status';
import type { GoalPaceStatus } from '@/domain/metrics/goal-pace-status';
import { oneOnOneOverdue } from '@/domain/metrics/coaching-recency';
import type { ViewsOffered } from '@/domain/metrics/unit-view';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MemberNames } from '@/modules/org/member-names.service';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { UnitDashboardService, type UnitPeople } from '@/modules/unit-dashboard/unit-dashboard.service';
import { CoachingReadings } from './coaching-readings';
import { PaceStatusReadings } from './pace-status';

/** A member, by the membership that identifies them (invariant §2). */
export interface RosterPerson {
  membershipId: string;
  name: string;
}

/** `DAYS_SINCE_LAST_COACHING`, and the session that set it. */
export interface RosterLastOneOnOne {
  /** Whole days in the office's calendar: 0 is today. */
  days: number;
  /** That session's day, `YYYY-MM-DD`. */
  date: LocalDate;
  /** `days` is above the office's `coachingOverdueDays`. */
  overdue: boolean;
  /** Who led it, whoever that was; `null` when their membership cannot be named. */
  coach: RosterPerson | null;
}

/** `COACHING_STATUS` on a row (P19.18-T5 AC-2; ADR-0267 §5): the coaching status tile, and *oleh <coach>* under it. */
export interface RosterCoachingStatus {
  status: CoachingStatus;
  /** `DAYS_SINCE_LAST_COACHING`; `null` for *Belum pernah coaching*. */
  days: number | null;
  /** Who led the latest 1-on-1: *oleh …*; `null` with none, or when they can no longer be named. */
  coach: RosterPerson | null;
}

/** One person on the roster: verdicts and dates, and **no count of any activity** (P11-T6 AC-6). */
export interface RosterRow extends RosterPerson {
  /** Their profile photo as a signed link (UI V1, UI-111); `null` for none: the row draws initials. */
  photoUrl: string | null;
  rung: { code: string; label: string };
  /** Edges from the reader: 1 is a direct report; 0 the reader's own row. */
  depth: number;
  /** `null` until their first finalized session: *No 1:1 yet*. */
  lastOneOnOne: RosterLastOneOnOne | null;
  status: GoalPaceStatus;
  /** `COACHING_STATUS` (P19.18-T5 AC-2): red *Belum pernah coaching*, green to 14 days, yellow after. */
  coaching: RosterCoachingStatus;
  /** The WhatsApp number on their account (P19.18-T5 AC-2); `null` without one, on the reader's own row and for a leaver. */
  phone: string | null;
  /** The reader's own row (*ANDA*): it opens *Catatan coaching saya*. */
  isReader: boolean;
  /**
   * **The row opens their *Coaching Session*** (`COACH`, ADR-0074): somebody the reader coaches. On the whole office of
   * the Owner or an Admin, somebody outside their own downline — another root, *Belum punya leader* — is listed and does
   * not open (`GET /coaching/coachees/:id` would answer 404).
   */
  opens: boolean;
}

/** A team inside a unit (P19.18-T5 AC-2): an AAB with people, drawn as a team line, never a nested folder. */
export interface RosterTeam {
  key: string;
  leader: RosterPerson & { photoUrl: string | null };
  /** *n orang*: the team leader and everybody below them in the view. */
  count: number;
  /** The team leader first, then their people who lead nobody, AB → AAB → agents. */
  rows: RosterRow[];
}

/**
 * **One unit of the roster** (P19.18-T5 AC-2; ADR-0271 §9): the reader's own (*Unit Anda*: them and their direct reports
 * who lead nobody and are no AB), an AB's — or anybody hung from the reader — or *Belum punya leader*; its people, then
 * every team inside it at any depth, each a team line.
 */
export interface RosterSection {
  /** `own`, the unit leader's membership, or `unled`. */
  key: string;
  kind: 'own' | 'unit' | 'unled';
  /** The orange line's photo and name; `null` for *Belum punya leader*. */
  leader: (RosterPerson & { photoUrl: string | null }) | null;
  /** *n orang*: everybody in it, its teams included. */
  count: number;
  /** The unit's leader first (the reader in *Unit Anda*), then the people who lead nobody, AB → AAB → agents. */
  rows: RosterRow[];
  teams: RosterTeam[];
}

export interface CoachingRosterView {
  /** The office's today, which every figure on the roster is as of. */
  today: LocalDate;
  /** The office's `coachingOverdueDays`: the browser's configuration does not carry it. */
  overdueAfterDays: number;
  /**
   * **The view** (P19.18-T5 AC-1; ADR-0271 §9): *Semua downline* unless the reader narrows it (*Semua downline ⌄*) — for
   * the KPM Owner or an Admin the whole office; the views as the Unit Dashboard offers them.
   */
  scope: UnitView;
  scopes: ViewsOffered;
  /** *Semua orang · n*: everybody on the roster, the reader included. */
  total: number;
  sections: RosterSection[];
}

/**
 * **`GET /coaching/coachees` — the coaching roster** (P11-T6; `functional/coaching.md`, the roster and the Data contract;
 * P19.18-T5, ADR-0271 §9).
 *
 * **The view**, as the Unit Dashboard reads it (`UnitDashboardService.people`, the same reach and the same 404s): **every
 * leader's whole downline** — *Semua downline*, or the widest view their team has — and **for the KPM Owner or an Admin
 * the whole office** (P19.18-T5 AC-1; the brief's part B, gap 2), test accounts left out (ADR-0267 §1). The reader may
 * narrow it to *Direct Unit*, *Grup langsung* or *Grup informal* (`scope`). A reader who coaches nobody — an Agent or an
 * AAB who leads nobody, an Owner or an Admin who stands above nobody — gets an empty roster, not an error.
 *
 * **Grouped as the Unit Dashboard's roster** (AC-2): *Unit Anda* first — the reader and their direct reports who lead
 * nobody and are no AB — then one section per unit below the reader, an AB's, with every team inside it as a team line
 * (an AAB with people), then *Belum punya leader*. Inside each, the leader first, then AB → AAB → agents, A to Z
 * (`classRank`, the roster's order). **An AB below the Owner is a unit of their own, never an AAB**.
 *
 * **Verdicts and dates, never a figure** (P11-T6 AC-6): *Last 1:1* is `DAYS_SINCE_LAST_COACHING` and its session's coach;
 * the tile is `COACHING_STATUS` (14 days, ADR-0267 §5); *Status* is `GOAL_PACE_STATUS`. The counts the status reads stay on
 * the server, so the read discloses no row and no count and writes no §3.5 entry (`functional/coaching.md`, *Audit*).
 *
 * **A fixed number of queries whatever the roster's size** — the office, the view, the sessions, the goals, the
 * production, the month's activity, the ladder and the names — none of them per person (P11-T6 AC-9).
 */
@Injectable()
export class CoachingRosterService {
  constructor(
    private readonly coach: CoachResolver,
    private readonly sessions: CoachingReadings,
    private readonly paces: PaceStatusReadings,
    private readonly names: MemberNames,
    private readonly orgLevels: OrgLevelService,
    private readonly days: TenantDay,
    /** P19.18-T5 (ADR-0271 §9): the Unit Dashboard's views — whose people the roster lists, and how they hang together. */
    private readonly views: UnitDashboardService,
  ) {}

  async read(ctx: RequestContext, query: { scope?: UnitView } = {}): Promise<CoachingRosterView> {
    const me = ctx.membershipId;
    if (!me) throw new NoMembershipException();

    const office = await this.days.office(ctx);
    const overdueAfterDays = office.settings.coachingOverdueDays;
    /*
     * The widest view by default: *Semua downline* where it is offered, and where it is not — no AB below — the
     * dashboard's own default, which is then everybody below the reader. The reader's own choice while it is offered.
     */
    const people = await this.views.people(ctx, undefined, { views: true, scope: query.scope ?? 'downline' });
    const scopes = coachingScopes(people.scopes);
    // The Owner or an Admin reads the whole office (`views` in `people`): some of it may be outside their own downline.
    const officeWide = Boolean(ctx.membership?.isKpmOwner || ctx.membership?.isKpmAdmin);
    /*
     * Somebody who coaches nobody: an empty roster. The Owner or an Admin who narrowed the office to a view holding nobody
     * but themselves (*Direct Unit*) keeps their own row — and the picker — to widen it again.
     */
    const narrowed = officeWide && people.scopes.offered.length > 1;
    if (people.empty && !narrowed) return { today: office.today, overdueAfterDays, scope: people.scope, scopes, total: 0, sections: [] };

    const ids = people.group;
    const [statuses, paces, ladder, coached] = await Promise.all([
      this.sessions.statusOf(ctx, ids, office),
      this.paces.paceOf(ctx, ids, {
        today: office.today, month: office.month, onTrackRatio: office.settings.onTrackPaceThreshold,
      }),
      office.companyId ? this.orgLevels.list(ctx, office.companyId) : Promise.resolve([]),
      // Who opens: everybody below the reader. Office-wide the view holds people outside it — one read of the reach.
      officeWide ? this.coach.coacheesOf(ctx, me).then((cs) => new Set(cs.map((c) => c.membershipId))) : Promise.resolve(null),
    ]);
    // The last 1:1's coach may be anybody who coached them: a leader above the reader, or one who left.
    const coachIds = [...statuses.values()].flatMap((r) => (r.last ? [r.last.coachMembershipId] : []));
    // The rows' photos signed with their names (UI V1, UI-111) and their numbers (WhatsApp); a coach is only named.
    const pictured = await this.names.pictured(ctx, [...ids, ...coachIds], ids, { phones: true });
    const nameOf = (id: string) => pictured.get(id)?.name ?? people.names.get(id) ?? '';
    const labels = new Map(ladder.map((level) => [level.code, level.label]));
    const person = (id: string | null): RosterPerson | null => {
      const name = id === null ? undefined : pictured.get(id)?.name;
      return name === undefined ? null : { membershipId: id as string, name };
    };
    const depthOf = depthsOf(people);

    const row = (id: string): RosterRow => {
      const recent = statuses.get(id)!;
      const last = id === me ? null : recent.last;
      const days = recent.daysSinceLastCoaching;
      const code = people.rungs.get(id) ?? '';
      return {
        membershipId: id,
        name: nameOf(id),
        photoUrl: pictured.get(id)?.photoUrl ?? null,
        rung: { code, label: labels.get(code) ?? code },
        depth: depthOf.get(id) ?? 0,
        lastOneOnOne: last === null ? null : {
          days: days as number,
          date: last.date,
          overdue: oneOnOneOverdue(days as number, overdueAfterDays),
          coach: person(last.coachMembershipId),
        },
        status: paces.get(id)!.status,
        coaching: { status: recent.status, days, coach: recent.last ? person(recent.last.coachMembershipId) : null },
        phone: id === me ? null : pictured.get(id)?.phone ?? null,
        isReader: id === me,
        opens: id === me || coached === null || coached.has(id),
      };
    };

    const sections = sectionsOf(people).map((s): RosterSection => {
      const leader = s.leader === null ? null : { membershipId: s.leader, name: nameOf(s.leader), photoUrl: pictured.get(s.leader)?.photoUrl ?? null };
      return {
        key: s.kind === 'own' ? 'own' : s.kind === 'unled' ? 'unled' : (s.leader as string),
        kind: s.kind,
        leader,
        count: s.rows.length + s.teams.reduce((sum, t) => sum + t.rows.length, 0),
        rows: s.rows.map(row),
        teams: s.teams.map((t) => ({
          key: t.leader,
          leader: { membershipId: t.leader, name: nameOf(t.leader), photoUrl: pictured.get(t.leader)?.photoUrl ?? null },
          count: t.rows.length,
          rows: t.rows.map(row),
        })),
      };
    });
    return { today: office.today, overdueAfterDays, scope: people.scope, scopes, total: ids.length, sections };
  }
}

/**
 * **The roster's views** (P19.18-T5 AC-1): the dashboard's offered views, and *Semua downline* — or the widest offered —
 * as what a read without `scope` answers: everybody the reader coaches.
 */
function coachingScopes(views: ViewsOffered): ViewsOffered {
  const widest = views.offered.includes('downline') ? 'downline' : views.default;
  return { offered: views.offered, default: widest };
}

/** Each person's edges from the reader in the view, by `parentOf` (`placeView`); 0 the reader, 1 under *Belum punya leader*. */
function depthsOf(people: UnitPeople): Map<string, number> {
  const out = new Map<string, number>([[people.head.membershipId, 0]]);
  const depth = (id: string, seen: number): number => {
    const known = out.get(id);
    if (known !== undefined) return known;
    const parent = people.parentOf.get(id);
    const d = parent === null || parent === undefined || seen > 64 ? 1 : depth(parent, seen + 1) + 1;
    out.set(id, d);
    return d;
  };
  for (const id of people.group) depth(id, 0);
  return out;
}

/** A section before its rows are drawn: ids only. */
interface PlacedSection {
  kind: 'own' | 'unit' | 'unled';
  leader: string | null;
  rows: string[];
  teams: { leader: string; rows: string[] }[];
}

/**
 * **The view's people as the roster draws them** (P19.18-T5 AC-2), off the dashboard's own order (`people.group`, which
 * `rosterScopes` gives: the Direct Unit, then each unit's leader, its people who lead nobody, then its teams, depth first;
 * then *Belum punya leader*). A person who leads somebody in the view, below a section's leader, starts a team; a team
 * nested in a team is a team line of its own, in the same section.
 */
export function sectionsOf(people: UnitPeople): PlacedSection[] {
  const head = people.head.membershipId;
  const own = new Set(people.unit);
  const leads = new Set<string>();
  for (const id of people.group) {
    const parent = people.parentOf.get(id);
    if (id !== head && parent) leads.add(parent);
  }
  const sections: PlacedSection[] = [{ kind: 'own', leader: head, rows: [], teams: [] }];
  let section = sections[0];
  let team: { leader: string; rows: string[] } | null = null;
  for (const id of people.group) {
    const parent = people.parentOf.get(id);
    if (id === head || own.has(id)) {
      sections[0].rows.push(id);
      continue;
    }
    if (parent === null) {
      // *Belum punya leader*: one section, last.
      if (section.kind !== 'unled') {
        section = { kind: 'unled', leader: null, rows: [], teams: [] };
        sections.push(section);
      }
      section.rows.push(id);
      team = null;
      continue;
    }
    if (parent === head) {
      // A unit below the reader: an AB, an AAB with a team, or somebody hung from the reader.
      section = { kind: 'unit', leader: id, rows: [id], teams: [] };
      sections.push(section);
      team = null;
      continue;
    }
    if (leads.has(id)) {
      // A team inside the unit: its own line, its leader first.
      team = { leader: id, rows: [id] };
      section.teams.push(team);
      continue;
    }
    // Somebody who leads nobody: in the team their leader heads, else in the unit's own rows.
    if (team !== null && parent === team.leader) team.rows.push(id);
    else if (parent === section.leader) section.rows.push(id);
    else {
      const owner = section.teams.find((t) => t.leader === parent);
      if (owner) owner.rows.push(id);
      else section.rows.push(id);
    }
  }
  return sections.filter((s) => s.rows.length > 0 || s.teams.length > 0);
}
