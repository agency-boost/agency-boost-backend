import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException } from '@/common/errors/domain.exception';
import { addDays, rollingWindow, type LocalDate } from '@/common/time/local-day';
import { HOME, quoteOfTheDay, type HomeQuotePose } from '@/domain/constants/home';
import { coachingCoverage } from '@/domain/metrics/coaching-coverage';
import { newHireBeforeFirstSale, type ProductionStanding } from '@/domain/metrics/counts-for-production';
import { activeAgentSplit, type ProductionRow } from '@/domain/metrics/unit-rollup';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { officeClockOf } from '@/modules/calendar/calendar-time';
import { CalendarService } from '@/modules/calendar/calendar.service';
import { CoachingReadings } from '@/modules/coaching/coaching-readings';
import { PaceStatusReadings } from '@/modules/coaching/pace-status';
import { LeadReadings } from '@/modules/leads/lead-readings';
import { LeadRepository } from '@/modules/leads/lead.repository';
import type { LeadType } from '@/modules/leads/lead.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { TenantDay, type Office } from '@/modules/tenants/tenant-day.service';
import { UnitDashboardService, type UnitPeople } from '@/modules/unit-dashboard/unit-dashboard.service';
import { AvatarLinks } from '@/modules/users/avatar.service';
import { User, type UserDocument } from '@/modules/users/user.schema';
import { byReport, daysWithCounts, splitOf, type CountOf, type SplitFigure } from './home-figures';

/** A person a Home row names: who, and the WhatsApp number on their account (`users.phone`), `null` with none. */
export interface HomePerson {
  membershipId: string;
  name: string;
  phone: string | null;
}

/**
 * One row of ***Aksi hari ini*** (UI-100): today's open *Tugas* — the coaching action items, then the leads' next
 * actions — and then the next agenda items.
 */
export type HomeAction =
  | {
    kind: 'coaching';
    sessionId: string;
    itemId: string;
    text: string;
    /** *Dari: NAME* — the leader who coached them; `null` when that membership can no longer be named. */
    from: HomePerson | null;
  }
  | {
    kind: 'lead';
    leadId: string;
    name: string;
    type: LeadType | null;
    note: string | null;
    contact: { phone: string | null; email: string | null };
    /** The lead's `version`, for *Isi nomor WhatsApp*'s `PATCH /leads/:id`. */
    version: number;
  }
  | {
    kind: 'agenda';
    /** A calendar entry, or an event the reader joined (UI-104 point 1). */
    source: 'entry' | 'event';
    id: string;
    /** An entry's type code (`meeting`, `client`, …), or a joined event's type as the office named it. */
    type: string;
    title: string;
    /** The office day and the office time it starts: `2026-10-30`, `15:00`. */
    date: LocalDate;
    start: string;
  };

/** One person on ***Laporan tim*** (UI-101), in its order. */
export interface HomeTeamPerson extends HomePerson {
  /** A signed link to their photo (UI-111), never the stored key; `null` draws initials. */
  photoUrl: string | null;
  /** In the reader's *Unit* — them and their direct agents who lead nobody; everybody is in the *Group*. */
  inUnit: boolean;
  /** The day's saved total (`ActivityReadings.perPersonPerDay`), `null` for no saved day. */
  yesterday: number | null;
  today: number | null;
}

export interface HomeView {
  today: LocalDate;
  yesterday: LocalDate;
  /** The office's month, `YYYY-MM`: *Active Agent Oktober*. */
  month: string;
  /** The office's wall clock as the read was made: the greeting's time of day. */
  now: { minute: number };
  quote: { index: number; text: string; person: string; pose: HomeQuotePose };
  /** *Aktivitas saya* and the chart: the reader's saved totals, the seven days ending today, oldest first. */
  activity: { today: number; yesterday: number; days: { date: LocalDate; count: number }[]; total: number };
  /** *Jadwal hari ini*: timed items today, and today's open *Tugas*. */
  schedule: { meetings: number; tasks: number };
  actions: HomeAction[];
  /**
   * The leader's blocks — the two tiles, *Laporan tim* and *Tim saya* — for **every leader by role** (ADR-0189 §4,
   * P19-T4 AC-2): an AB or an AAB, an Owner or an Admin, whether or not anybody reports to them yet, at zero when
   * nobody does. `null` for an Agent who leads nobody.
   */
  leader: HomeLeader | null;
}

/** The leader's part of Home (UI-100, UI-101; *Tim saya*, UI-159 item 2). */
export interface HomeLeader {
  activeAgent: SplitFigure;
  coached7d: SplitFigure;
  team: HomeTeamPerson[];
  /** *Anggota tim*: everybody in the reader's Group but the reader — *Laporan tim*'s people. */
  members: number;
  /**
   * *Recruitment pipeline*: `RECRUITMENT_PIPELINE_NOW` over the reader's Group, the reader included — the Unit
   * Dashboard's *Leads* column's recruitment count (`LeadReadings.countsOfMany`), summed. The reader's own with no team.
   */
  recruitmentPipeline: number;
  /** *New hires*: the Unit Dashboard's *Tim Anda* tile's — the Group's new hires before a first sale (ADR-0172 §1). */
  newHires: number;
}

/**
 * **Home** (UI V1, 2026-10-30, Phase 18.11 T11; UI-100, UI-101; ADR-0180 §10; `functional/home.md`): `GET /home`, one
 * read for every block of the page every field member lands on. **It is about the reader** — their activity, their
 * schedule, their leads — and, for somebody who leads, two tiles and the team's report list.
 *
 * **Every figure is the function another screen already uses**, so Home never disagrees with it:
 *
 * - **Aktivitas saya and the chart**: `ActivityReadings.perPersonPerDay`, the day's saved total — the number Activity
 *   Management saves and shows — for the seven office days ending today (`ROLLING_7D`).
 * - **Active Agent <Bulan>**: the Unit Dashboard's tile exactly — its reach and its *Unit* / *Group* (`people`), each
 *   person's `PACING_TO_MAA` (`PaceStatusReadings.paceOf`, the office's month) and new-hire standing, through
 *   `activeAgentSplit`: out of manpower, the head and the new hires included (UI-013).
 * - **Coaching 7 hari**: `COACHING_COVERAGE` over `COACHED_7D` (§A.3; `coachingCoverage`), over the same two scopes and
 *   the same manpower — the head included, as the analytics' unit rows count theirs; coached by anyone.
 * - **Laporan tim**: the same per-person-per-day count as the Group Tree's *Hari ini* (O-5), yesterday and today, for
 *   everybody in the reader's Group but the reader, in UI-101's order (`byReport`), with each one's photo (signed,
 *   UI-111) and WhatsApp number.
 * - **Jadwal hari ini and Aksi hari ini**: Calendar's own count of the reader's today (`CalendarService.today`, UI-104
 *   point 7) — timed things (entries not declined, a trip left out, and the events they joined) and open *Tugas* (the
 *   action items of their newest 1:1 due today and their own open leads whose next action is today, a ticked one gone),
 *   in the Agenda checklist's order. *Aksi hari ini* takes three: the *Tugas*, then today's timed things not yet ended,
 *   then the next timed things on the days after, the events they joined included (`CalendarService.nextAfterToday`).
 * - **The quote and the pose**: `quoteOfTheDay`, by the office's day.
 *
 * **Reach**: the reader's own data on `personal_summary:read`; the leader's blocks by `unit_dashboard:read`'s reach
 * (`UnitDashboardService.people`, which answers somebody who leads nobody an empty unit). **Recorded** (roles §3.5): one
 * entry per person on *Laporan tim*, surface `home`, over yesterday and today, in one insert, last; it fails open.
 * A fixed number of queries whatever the team's size.
 */
@Injectable()
export class HomeService {
  constructor(
    private readonly days: TenantDay,
    private readonly unit: UnitDashboardService,
    private readonly paces: PaceStatusReadings,
    private readonly coaching: CoachingReadings,
    private readonly activity: ActivityReadings,
    private readonly memberships: MembershipRepository,
    private readonly leads: LeadRepository,
    private readonly leadCounts: LeadReadings,
    private readonly calendar: CalendarService,
    private readonly subjectReads: SubjectReadAudit,
    private readonly avatars: AvatarLinks,
    private readonly clock: Clock,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  async read(ctx: RequestContext): Promise<HomeView> {
    const me = ctx.membershipId;
    if (!me) throw new NoMembershipException();
    const office = await this.days.office(ctx);
    const yesterday = addDays(office.today, -1);
    const chartDays = daysOf(rollingWindow(office.today, HOME.CHART_DAYS));
    const now = this.clock.now();

    const [mine, people, schedule] = await Promise.all([
      this.activity.perPersonPerDay(ctx, [me], chartDays),
      this.unit.people(ctx),
      this.scheduleOf(ctx, me, office),
    ]);
    const days = daysWithCounts(chartDays, mine.get(me));
    // By role, never by the data (ADR-0189 §4): a leader who leads nobody yet gets the block at zero, not `null`.
    const leader = !people.empty
      ? await this.leaderOf(ctx, me, office, people, yesterday)
      : leadsByRole(ctx) ? await this.zeroLeaderOf(ctx, me, office) : null;

    const view: HomeView = {
      today: office.today,
      yesterday,
      month: office.month,
      now: { minute: officeClockOf(office.timezone, now).minute },
      quote: quoteOfTheDay(office.today),
      activity: {
        today: days[days.length - 1].count,
        yesterday: days[days.length - 2]?.count ?? 0,
        days,
        total: days.reduce((sum, d) => sum + d.count, 0),
      },
      schedule: { meetings: schedule.meetings, tasks: schedule.tasks },
      actions: schedule.actions,
      leader,
    };

    // Last, once the answer exists: the team list discloses each person's yesterday and today.
    if (leader) await this.subjectReads.recordMany(ctx, leader.team, 'home', { from: yesterday, to: office.today });
    return view;
  }

  /**
   * **The leader's blocks** (UI-100, UI-101): *Active Agent* and *Coaching 7 hari* over the Unit Dashboard's two scopes,
   * and the team's report list.
   */
  private async leaderOf(
    ctx: RequestContext, me: string, office: Office, people: UnitPeople, yesterday: LocalDate,
  ): Promise<HomeLeader> {
    const unitIds = people.unit;
    const inUnit = new Set(unitIds);
    const aabIds = people.group.filter((id) => !inUnit.has(id));
    const team = people.group.filter((id) => id !== me);

    const [paces, rows, sessions, perDay, named, leadCounts] = await Promise.all([
      this.paces.paceOf(ctx, people.group, {
        today: office.today, month: office.month, onTrackRatio: office.settings.onTrackPaceThreshold,
      }),
      this.memberships.find(ctx, { _id: { $in: people.group } }, { projection: { joinedAs: 1, firstSaleDate: 1, userId: 1 } }),
      this.coaching.countedSince(ctx, people.group, addDays(office.today, -HOME.COACHED_WINDOW_DAYS)),
      this.activity.perPersonPerDay(ctx, team, [yesterday, office.today]),
      this.peopleOf(ctx, team, { photos: true }),
      this.leadCounts.countsOfMany(ctx, people.group, { month: office.month }),
    ]);

    // *Active Agent*: the Unit Dashboard's own rollup, row by row. Only `pacingToMaa` and the new-hire standing are
    // read by `potentialActive`; the goal figure is the paired goal's, which this tile does not show.
    const standing = new Map(rows.map((m) => [String(m._id), { joinedAs: m.joinedAs ?? null, firstSaleDate: m.firstSaleDate ?? null }]));
    const rowOf = (id: string): ProductionRow => ({
      goal: { targetMinor: null, actualMinor: null },
      pacingToMaa: paces.get(id)?.pacingToMaa ?? null,
      newHireBeforeFirstSale: newHireBeforeFirstSale(standing.get(id) ?? NO_STANDING, office.today),
    });
    const active = activeAgentSplit(unitIds.map(rowOf), aabIds.map(rowOf));

    // *Coaching 7 hari*: `COACHING_COVERAGE` at `COACHED_7D`, each scope whole — its head included — coached by anyone.
    const between = (from: string, to: string) => this.clock.daysBetween(office.timezone, from, to);
    const coached = (scope: readonly string[]): CountOf => {
      const window = coachingCoverage({ scope, leaderMembershipId: null, sessions, today: office.today, daysBetween: between })
        .find((w) => w.windowDays === HOME.COACHED_WINDOW_DAYS)!;
      return { count: window.coached, of: window.members };
    };

    const list = byReport(team.map((id) => {
      const person = named.get(id);
      const counts = perDay.get(id);
      return {
        membershipId: id,
        name: person?.name ?? people.names.get(id) ?? '',
        phone: person?.phone ?? null,
        photoUrl: person?.photoUrl ?? null,
        inUnit: inUnit.has(id),
        yesterday: counts?.get(yesterday) ?? null,
        today: counts?.get(office.today) ?? null,
      };
    }));

    return {
      activeAgent: splitOf(active.unit, active.aab),
      coached7d: splitOf(coached(unitIds), coached(aabIds)),
      team: list,
      members: team.length,
      recruitmentPipeline: sumRecruitOpen(leadCounts),
      // The Unit Dashboard's own count: every row of the Group before a first sale (`rollUpProduction`'s `newHires`).
      newHires: people.group.filter((id) => rowOf(id).newHireBeforeFirstSale).length,
    };
  }

  /**
   * **A leader with nobody yet** (ADR-0189 §4, P19-T4 AC-2; UI-159 item 2): the same block at zero, so Home shows they
   * have team tools from the first day — no tile reads anybody, the reader's own recruitment pipeline aside, which is
   * theirs whether or not a team exists. Nobody is on *Laporan tim*, so nothing is recorded as read.
   */
  private async zeroLeaderOf(ctx: RequestContext, me: string, office: Office): Promise<HomeLeader> {
    const nobody: CountOf = { count: 0, of: 0 };
    const own = await this.leadCounts.countsOfMany(ctx, [me], { month: office.month });
    return {
      activeAgent: splitOf(nobody, nobody),
      coached7d: splitOf(nobody, nobody),
      team: [],
      members: 0,
      recruitmentPipeline: sumRecruitOpen(own),
      newHires: 0,
    };
  }

  /**
   * **Today's schedule and the top of the list** (UI-100 *Jadwal hari ini*, *Aksi hari ini*; UI-104 point 7):
   * Calendar's own count of the reader's today (`CalendarService.today`) — its timed things and its open *Tugas*, in the
   * Agenda checklist's order — so a tick in Calendar lowers Home at once. The three rows are today's *Tugas* first;
   * then today's timed things not yet ended; then, still short, the reader's next timed things on the days after —
   * entries and joined events, from Calendar (`CalendarService.nextAfterToday`).
   */
  private async scheduleOf(ctx: RequestContext, me: string, office: Office) {
    const today = await this.calendar.today(ctx);
    const tasks = today.taskItems.slice(0, HOME.ACTIONS_SHOWN);
    // A lead row's WhatsApp saves the number with the email beside it (`PATCH /leads/:id` writes the pair): both, read here.
    const leadIds = tasks.flatMap((task) => (task.lead ? [task.lead.leadId] : []));
    const leadRows = leadIds.length === 0 ? [] : await this.leads.find(ctx, { _id: { $in: leadIds }, ownerMembershipId: me });
    const leadOf = new Map(leadRows.map((lead) => [String(lead._id), lead]));

    const rows: HomeAction[] = tasks.map((task): HomeAction => {
      if (task.coaching) {
        return {
          kind: 'coaching',
          sessionId: task.coaching.sessionId,
          itemId: task.coaching.itemId,
          text: task.note,
          from: task.name ? { membershipId: task.coaching.coachMembershipId, name: task.name, phone: task.phone } : null,
        };
      }
      const lead = leadOf.get(task.lead!.leadId);
      return {
        kind: 'lead',
        leadId: task.lead!.leadId,
        name: task.name,
        type: lead?.type ?? null,
        note: task.note || null,
        contact: { phone: lead?.contact?.phone ?? task.phone, email: lead?.contact?.email ?? null },
        version: lead?.version ?? task.lead!.version,
      };
    });
    for (const item of today.upcoming) {
      if (rows.length >= HOME.ACTIONS_SHOWN) break;
      rows.push({
        kind: 'agenda', source: item.kind, id: item.id, type: item.type, title: item.title, date: office.today, start: item.start,
      });
    }

    // Still short: the reader's next timed things after today — their entries and the events they joined, soonest
    // first (Calendar's own read, so Home never writes Calendar's rules again).
    for (const item of await this.calendar.nextAfterToday(ctx, HOME.ACTIONS_SHOWN - rows.length)) {
      rows.push({
        kind: 'agenda', source: item.kind, id: item.id, type: item.type, title: item.title, date: item.date, start: item.start,
      });
    }
    return { meetings: today.meetings, tasks: today.tasks, actions: rows };
  }

  /**
   * **People by membership, with their account's name, phone and — asked for — photo**: the memberships read through
   * the tenant repository first, so a user is reached only through a membership this office holds (invariant §2); the
   * photo signed (UI-111). One read of each collection, whatever the list's length.
   */
  private async peopleOf(
    ctx: RequestContext, ids: readonly string[], { photos = false }: { photos?: boolean } = {},
  ): Promise<Map<string, HomePerson & { photoUrl: string | null }>> {
    const out = new Map<string, HomePerson & { photoUrl: string | null }>();
    if (ids.length === 0) return out;
    const members = await this.memberships.find(ctx, { _id: { $in: [...new Set(ids)] } }, { projection: { userId: 1 } });
    const userIds = [...new Set(members.map((m) => String(m.userId)))];
    const users = userIds.length === 0 ? [] : await this.users
      .find({ _id: { $in: userIds } })
      .select(photos ? 'fullName phone avatarUrl' : 'fullName phone')
      .lean()
      .exec() as unknown as { _id: unknown; fullName?: string; phone?: string | null; avatarUrl?: string | null }[];
    const byUser = new Map(users.map((u) => [String(u._id), u]));
    const links = photos ? await this.avatars.linksFor(users.map((u) => u.avatarUrl)) : new Map<string, string>();
    for (const member of members) {
      const user = byUser.get(String(member.userId));
      if (!user?.fullName) continue;
      out.set(String(member._id), {
        membershipId: String(member._id),
        name: user.fullName,
        phone: user.phone ?? null,
        photoUrl: user.avatarUrl ? links.get(user.avatarUrl) ?? null : null,
      });
    }
    return out;
  }
}

const NO_STANDING: ProductionStanding = { joinedAs: null, firstSaleDate: null };

/**
 * **A leader by role** (ADR-0189 §1, §4; OD-247's default): on a leader rung — an AB or an AAB by class (ADR-0156 §3),
 * whatever the company calls it — or running the office as its Owner or an Admin. Never by a count.
 */
export function leadsByRole(ctx: RequestContext): boolean {
  const membership = ctx.membership;
  if (!membership || membership.status !== 'active') return false;
  return membership.hierarchyRole === 'ab' || membership.hierarchyRole === 'aab'
    || membership.isKpmOwner || membership.isKpmAdmin;
}

/** `RECRUITMENT_PIPELINE_NOW`, summed over the people asked about. */
function sumRecruitOpen(counts: ReadonlyMap<string, { recruitOpen: number }>): number {
  let total = 0;
  for (const row of counts.values()) total += row.recruitOpen;
  return total;
}

/** Every office day of a window, oldest first. */
function daysOf(window: { from: LocalDate; to: LocalDate }): LocalDate[] {
  const out: LocalDate[] = [];
  for (let day = window.from; day <= window.to; day = addDays(day, 1)) out.push(day);
  return out;
}
