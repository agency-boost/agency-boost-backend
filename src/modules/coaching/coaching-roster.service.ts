import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException } from '@/common/errors/domain.exception';
import type { LocalDate } from '@/common/time/local-day';
import type { GoalPaceStatus } from '@/domain/metrics/goal-pace-status';
import { oneOnOneOverdue } from '@/domain/metrics/coaching-recency';
import { CoachResolver, type Coachee } from '@/modules/org/coach-resolver';
import { MemberNames } from '@/modules/org/member-names.service';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
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

/** One person on the roster: verdicts and dates, and **no count of any activity** (P11-T6 AC-6). */
export interface RosterRow extends RosterPerson {
  /** Their profile photo as a signed link (UI V1, UI-111); `null` for none: the row draws initials. */
  photoUrl: string | null;
  rung: { code: string; label: string };
  /** Edges from the reader: 1 is a direct report. */
  depth: number;
  /** `null` until their first finalized session: *No 1:1 yet*. */
  lastOneOnOne: RosterLastOneOnOne | null;
  status: GoalPaceStatus;
}

/** A direct report who leads, and their whole subtree beneath them, in tree order. */
export interface RosterUnit {
  head: RosterRow;
  members: RosterRow[];
}

export interface CoachingRosterView {
  /** The office's today, which every figure on the roster is as of. */
  today: LocalDate;
  /** The office's `coachingOverdueDays`: the browser's configuration does not carry it. */
  overdueAfterDays: number;
  directAgents: RosterRow[];
  units: RosterUnit[];
}

/**
 * **`GET /coaching/coachees` — the coaching roster** (P11-T6; `functional/coaching.md`, the roster and the
 * Data contract).
 *
 * **Everyone the reader coaches, and nobody else**: `CoachResolver.coacheesOf`, which is `COACH` — the
 * reader's whole downline on the current edges, at any depth, every link active, never themselves
 * (ADR-0074). A reader who coaches nobody — an Agent, an AAB who leads nobody, an Owner or an Admin who
 * stands above nobody — gets an empty roster, not an error: the grant on `coaching_session:read` is
 * theirs, and there is simply nobody on it. An Owner who is also the root AB coaches the whole office as
 * that AB, which is the hierarchy and not an Owner grant.
 *
 * **Grouped as the prototype groups it** (`Overall.html:10648-10657`): the reader's direct reports on the
 * agent rung, then each direct report who leads — on another rung, or leading anybody at all — heading a
 * unit with their whole subtree beneath them in tree order: a nested head is followed by their own
 * members, one level deeper. Names A to Z within a level. A direct report on the agent rung who leads
 * somebody heads a unit rather than sitting in *Your direct agents*, so nobody `COACH` reaches is ever
 * left off the roster.
 *
 * **Verdicts and dates, never a figure** (P11-T6 AC-6): *Last 1:1* is `DAYS_SINCE_LAST_COACHING` and its
 * session's coach; *Status* is `GOAL_PACE_STATUS`. The counts the status reads stay on the server, so the
 * read discloses no row and no count and writes no §3.5 entry (`functional/coaching.md`, *Audit*).
 *
 * **A fixed number of queries whatever the roster's size** — the office, the reach, the sessions, the
 * goals, the production, the month's activity, the ladder and the names — none of them per person
 * (P11-T6 AC-9). Not paginated: it is one leader's reach, drawn whole.
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
  ) {}

  async read(ctx: RequestContext): Promise<CoachingRosterView> {
    const me = ctx.membershipId;
    if (!me) throw new NoMembershipException();

    const office = await this.days.office(ctx);
    const overdueAfterDays = office.settings.coachingOverdueDays;
    const coachees = await this.coach.coacheesOf(ctx, me);
    if (coachees.length === 0) return { today: office.today, overdueAfterDays, directAgents: [], units: [] };

    const ids = coachees.map((c) => c.membershipId);
    const [recency, paces, ladder] = await Promise.all([
      this.sessions.recencyOf(ctx, ids, office),
      this.paces.paceOf(ctx, ids, {
        today: office.today, month: office.month, onTrackRatio: office.settings.onTrackPaceThreshold,
      }),
      office.companyId ? this.orgLevels.list(ctx, office.companyId) : Promise.resolve([]),
    ]);
    // The last 1:1's coach may be anybody who coached them: a leader above the reader, or one who left.
    const coachIds = [...recency.values()].flatMap((r) => (r.last ? [r.last.coachMembershipId] : []));
    // The rows' photos signed with their names (UI V1, UI-111); a last 1:1's coach is only named.
    const people = await this.names.pictured(ctx, [...ids, ...coachIds], ids);
    const names = new Map([...people].map(([id, p]) => [id, p.name]));
    const labels = new Map(ladder.map((level) => [level.code, level.label]));

    const nameOf = (c: Coachee) => names.get(c.membershipId) ?? '';
    const aToZ = (a: Coachee, b: Coachee) =>
      nameOf(a).localeCompare(nameOf(b)) || a.membershipId.localeCompare(b.membershipId);

    const row = (c: Coachee): RosterRow => {
      const recent = recency.get(c.membershipId)!;
      const last = recent.last;
      const coachName = last ? names.get(last.coachMembershipId) : undefined;
      const days = recent.daysSinceLastCoaching as number;
      return {
        membershipId: c.membershipId,
        name: nameOf(c),
        photoUrl: people.get(c.membershipId)?.photoUrl ?? null,
        rung: { code: c.membership.orgLevelCode, label: labels.get(c.membership.orgLevelCode) ?? c.membership.orgLevelCode },
        depth: c.depth,
        lastOneOnOne: last === null ? null : {
          days,
          date: last.date,
          overdue: oneOnOneOverdue(days, overdueAfterDays),
          coach: coachName === undefined ? null : { membershipId: last.coachMembershipId, name: coachName },
        },
        status: paces.get(c.membershipId)!.status,
      };
    };

    // The tree below the reader, each level A to Z. Every link between is a coachee too (`coacheesOf`).
    const below = new Map<string, Coachee[]>();
    for (const c of coachees) {
      const leader = c.membership.leaderId as string;
      below.set(leader, [...(below.get(leader) ?? []), c]);
    }
    for (const level of below.values()) level.sort(aToZ);
    const leads = (c: Coachee) => below.has(c.membershipId);
    const subtree = (c: Coachee): RosterRow[] =>
      (below.get(c.membershipId) ?? []).flatMap((child) => [row(child), ...subtree(child)]);

    // Somebody coached is below a direct report of the reader, or is one: the list has at least one.
    const direct = below.get(me) as Coachee[];
    return {
      today: office.today,
      overdueAfterDays,
      directAgents: direct.filter((c) => c.membership.role === 'agent' && !leads(c)).map(row),
      units: direct
        .filter((c) => c.membership.role !== 'agent' || leads(c))
        .map((head) => ({ head: row(head), members: subtree(head) })),
    };
  }
}
