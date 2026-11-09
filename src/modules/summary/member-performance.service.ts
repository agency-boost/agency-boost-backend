import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { calendarMonth, type LocalDate } from '@/common/time/local-day';
import { ActivityService } from '@/modules/activity/activity.service';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { CoachingReadings } from '@/modules/coaching/coaching-readings';
import { GoalService } from '@/modules/goals/goal.service';
import { LeadReadings } from '@/modules/leads/lead-readings';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { OfficialApe } from '@/modules/production/official-ape';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { closingsIn } from '@/modules/unit-dashboard/unit-figures';
import { officialGoalFigures } from './summary-figures';

/**
 * **A member's four tiles** (ADR-0205 §1, OWN R4, OWN UI-020): the member page's *Aktivitas 7 hari*, *Produksi tahun
 * ini* with *n % dari goal*, *1:1 terakhir* and *Leads* with *n closing*. Each the figure another screen already shows for
 * the same person, read **through the function that screen reads it through**, so the two cannot disagree:
 */
export interface MemberPerformanceView {
  membershipId: string;
  /** The office's day the figures are as of (`kpms.timezone`, invariant §9). */
  today: LocalDate;
  /**
   * ***Aktivitas 7 hari***: every count the person logged over the rolling 7 days, today included — the coaching
   * session's *Activity* card's `totalCount`, by the same `ActivityService.weekOf`.
   */
  activity: { from: LocalDate; to: LocalDate; count: number };
  /**
   * ***Produksi tahun ini*** against the year's goal: the Unit Dashboard's goal cell for the year
   * (`officialGoalFigures`), **the office's figure only** (ADR-0195 §4) — a member's own estimate is no APE here, and
   * reads `null` (*Belum diunggah*). `goalSet` false is ADR-0080's *no goal*: an unsaved default measures nobody, so
   * `targetMinor` and `attainmentPct` are `null` then.
   */
  production: {
    year: string;
    actualMinor: number | null;
    targetMinor: number | null;
    /** `APE_ATTAINMENT_PCT`, capped for display; `null` without a goal or without an official figure. */
    attainmentPct: number | null;
    goalSet: boolean;
  };
  /** ***1:1 terakhir***: their latest 1:1 as coachee, finalized at least once (ADR-0079); `null` is *Belum pernah*. */
  lastOneOnOne: { date: LocalDate } | null;
  /**
   * ***Leads*** with ***n closing***, this month: the person's row on the Unit Dashboard — *Leads penjualan* (their open
   * sales leads, `LeadReadings.countsOfMany`'s `salesOpen`) and *Closing* (their sales leads that first reached *Paid
   * and issued* in the office's calendar month, `closingsIn`).
   */
  leads: { month: string; open: number; closing: number };
}

/**
 * **`GET /members/:membershipId/performance`** (ADR-0205 §1–§2; OD-256's OQ3, its default).
 *
 * **Who** is `CoachResolver.subject` on `member:read_performance`: the Owner and an Admin the office (`own-kpm`, a
 * member who has left included, as every office read of history is), an AB or an AAB the people they coach
 * (`own-downline`, `COACH`), and the caller themselves. Anybody else in the office, a malformed id and another office's
 * member are **404**, indistinguishable; an Agent holds no grant and the guard answers **403** first.
 *
 * **It discloses another member's activity, production and coaching**, so the read writes the §3.5 entry
 * (`SubjectReadAudit`, surface `member_performance`) over the days the figures span — the year to date — last, once
 * the answer exists. A self-read writes none.
 */
@Injectable()
export class MemberPerformanceService {
  constructor(
    private readonly coach: CoachResolver,
    private readonly days: TenantDay,
    private readonly activity: ActivityService,
    private readonly production: OfficialApe,
    private readonly goals: GoalService,
    private readonly sessions: CoachingReadings,
    private readonly leads: LeadReadings,
    private readonly subjectReads: SubjectReadAudit,
  ) {}

  async read(ctx: RequestContext, membershipId: string): Promise<MemberPerformanceView> {
    const subject = await this.coach.subject(ctx, membershipId, 'member:read_performance');
    const office = await this.days.for(ctx);
    const id = subject.membershipId;
    const year = office.today.slice(0, 4);

    const [week, ledgers, lastOnes, counts, closings] = await Promise.all([
      this.activity.weekOf(ctx, subject),
      this.production.ledgersFor(ctx, [id], office.month),
      this.sessions.lastOneOnOnes(ctx, [id]),
      this.leads.countsOfMany(ctx, [id], office),
      this.leads.closingsOfMany(ctx, [id]),
    ]);
    const ledger = ledgers.get(id);
    const standing = ledger?.standing ?? { throughLastMonth: null, thisMonth: null, yearToDate: null };
    const plan = (await this.goals.plansOf(ctx, year, [id], new Map([[id, standing.yearToDate]]))).get(id)!;
    const { yearly, set } = officialGoalFigures({ goal: plan, month: office.month, ...standing, names: new Map() });

    const view: MemberPerformanceView = {
      membershipId: id,
      today: office.today,
      activity: { from: week.from, to: week.to, count: week.totalCount },
      production: {
        year,
        actualMinor: yearly.actualMinor,
        targetMinor: set ? yearly.targetMinor : null,
        attainmentPct: set ? yearly.attainmentPct : null,
        goalSet: set,
      },
      lastOneOnOne: lastOnes.get(id) ? { date: lastOnes.get(id)!.date } : null,
      leads: {
        month: office.month,
        open: counts.get(id)?.salesOpen ?? 0,
        closing: closingsIn(closings.get(id) ?? [], calendarMonth(office.today), office.timezone),
      },
    };

    // Last, once the answer exists (`SubjectReadAudit`): the year to date is the widest span a tile discloses.
    await this.subjectReads.record(ctx, subject, 'member_performance', { from: `${year}-01-01`, to: office.today });
    return view;
  }
}
