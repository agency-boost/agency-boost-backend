import { BadRequestException, HttpStatus, Injectable, Optional, Inject } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
/*
 * **The project's own exceptions, not Nest's.** `DomainExceptionFilter` assigns a catalogued code
 * only to a `DomainException`; every other `HttpException` is bucketed by status, and anything that
 * is not a 400 becomes `INTERNAL_ERROR`. So a plain `NotFoundException` from `@nestjs/common`
 * answered 404 with `code: "INTERNAL_ERROR"` — the tenant boundary, the most important refusal in
 * this module, reporting itself as a server fault. Found at the Phase 6 exit review.
 */
import {
  DomainException, NoMembershipException, NotFoundException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import {
  calendarMonth, isFutureDay, isLocalDate, isWithinCorrectionWindow, localDayOf, rollingWindow,
  type LocalDate,
} from '@/common/time/local-day';
import {
  ACTIVITY, DEFAULT_TENANT_TIMEZONE, PERFORMANCE, PERIOD, SEED_RATIO_PURPOSES,
} from '@/domain/constants';
import type { RatioDisplayUnit } from '@/domain/constants/ratio-display';
import { subPeriodActivityTarget, type CascadeTargets } from '@/domain/metrics/sub-period-activity-target';
import { AuditService } from '@/modules/audit/audit.service';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import {
  ActivityCategoryRepository, ActivityTypeRepository, RatioDefinitionRepository,
} from '@/modules/config/activity.repository';
import { diverges } from '@/modules/config/ratio.service';
import { TenantConfigService } from '@/modules/config/tenant-config.service';
import { GoalService } from '@/modules/goals/goal.service';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { ProductionReadings } from '@/modules/production/production-readings';
import {
  sectionChips, summaryPlan, type ActivityTargetKey, type SectionChip,
} from '@/modules/summary/summary-figures';
import { Kpm } from '@/modules/tenants/kpm.schema';
import { ActivityLogRepository } from './activity-log.repository';
import { ActivityReadings } from './activity-readings';
import { ActivationEvents, signalActivation } from '@/modules/activation/activation-events.port';
import type { ActivityLogDocument } from './activity-log.schema';
import {
  bucketIndex, bucketsFor, dashboardRange, type DashboardBucket, type DashboardRange,
} from './activity-dashboard';
import { appliesTo, computeRatio, type RatioStatus } from './activity-ratios';

/** One activity type's count on one day, as the wire carries it. */
export interface ActivityCountView {
  activityTypeId: string;
  activityTypeCode: string;
  label: string;
  count: number;
}

export interface ActivityDayView {
  membershipId: string;
  localDate: LocalDate;
  entries: ActivityCountView[];
  totalCount: number;
  version: number;
  /** Null while the day is still freely editable. */
  frozenAt: string | null;
  /** Whether *this* caller may still write it — the screen's Save button reads this. */
  editable: boolean;
  correctionCount: number;
}

/**
 * One of the goal's three cascade codes over the window, against its target (P11-T4): the coaching
 * session's Activity card, *{logged} / {target}*, labelled *pro-rated*.
 */
export interface ActivityWindowTargetView {
  key: ActivityTargetKey;
  /** The goal's own code for this count — `cascadeMapping`, never an item number (invariant §4). */
  code: string;
  /** Every stored entry against the code in the window, archived types included. */
  logged: number;
  /**
   * `SUB_PERIOD_ACTIVITY_TARGET` for `ROLLING_7D`: this month's `SUMMARY_ACTIVITY_TARGET` pro-rated.
   * `null` without an APE target, and `null` for every other period and for a custom range.
   */
  target: number | null;
}

export interface ActivitySummaryView {
  from: LocalDate;
  to: LocalDate;
  totals: { activityTypeCode: string; label: string; count: number }[];
  daysLogged: number;
  totalCount: number;
  /** The three cascade codes, in the prototype's order: leads contacted, appointments, closings. */
  targets: ActivityWindowTargetView[];
  /** The subject's summary tiles over the window, grouped as `GET /summary`'s `activity.sections` (ADR-0064). */
  sections: SectionChip[];
}

/**
 * Why a row is on the Dashboard. `shown` is a type the reader logs against today; the other two are
 * history that has to stay visible so the totals add up (invariant §3) — a type the office archived,
 * or one in a section no longer shown to this rung.
 */
export type DashboardStanding = 'shown' | 'archived' | 'not_shown';

export interface DashboardTypeView {
  code: string;
  label: string;
  description: string | null;
  /** The number the log screen shows beside it — display order, never an identity (invariant §4). */
  displayOrder: number;
  standing: DashboardStanding;
  total: number;
  /** One per bucket, in the buckets' order. */
  counts: number[];
}

export interface DashboardSectionView {
  code: string;
  label: string;
  standing: DashboardStanding;
  total: number;
  counts: number[];
  types: DashboardTypeView[];
}

/**
 * The Activity Dashboard (P10-T1): one member's days over a range, types down and time across — the
 * reader's own, or a coachee's on coaching's *Activity* tab (P13.1-T9).
 */
export interface ActivityDashboardView {
  range: DashboardRange;
  from: LocalDate;
  to: LocalDate;
  days: number;
  /** The office's today, so the screen can bound a custom range without a clock of its own. */
  today: LocalDate;
  /** Most recent first. */
  buckets: DashboardBucket[];
  sections: DashboardSectionView[];
  total: number;
  counts: number[];
  /** Days with an entry, zeroes included (ADR-0042). */
  daysLogged: number;
  /** Days in the range corrected after they closed — counted at their current figures, and said so. */
  correctedDays: number;
}

/** One activity code in a ratio's formula, as the office names and numbers it. */
export interface RatioTermView {
  code: string;
  label: string;
  /** The number the log screen shows — display order, never an identity (invariant §4). 0 when unknown. */
  displayOrder: number;
}

/** One of the office's ratios, computed over the member's last 30 days (P10-T2). */
export interface ActivityRatioView {
  code: string;
  label: string;
  comparison: 'gte' | 'band';
  displayUnit: RatioDisplayUnit;
  /** The office's own benchmark — a proportion for a rate, points either side for the balance. */
  benchmark: number;
  /**
   * The section the ratio measures, read from its denominator — *Selling* for a selling success rate —
   * or *Balance* for the two-sided one. `null` when the denominator spans sections.
   */
  tag: { code: string | null; label: string } | null;
  numerator: RatioTermView[];
  denominator: RatioTermView[];
  /**
   * The balance's two ends, named by the section each side counts — *Selling* and *Recruitment* on the
   * seed — so an office that rebuilds it is not told it leans toward selling. `null` for a rate, and a
   * side is `null` when its codes span sections.
   */
  sides: { numerator: string | null; denominator: string | null } | null;
  /** The platform's sentence for what it measures; `null` for an office's own formula, or one it changed. */
  purpose: string | null;
  divergesFromStandard: boolean;
  value: number | null;
  share: number | null;
  numeratorCount: number;
  denominatorCount: number;
  status: RatioStatus;
}

export interface ActivityRatiosView {
  membershipId: string;
  from: LocalDate;
  to: LocalDate;
  days: number;
  ratios: ActivityRatioView[];
}

/**
 * **What a member may log against** (P13.1-T2): the types of the sections their rung is shown, and
 * every code the office has at all — which is what tells *not your section* from *no such type*.
 */
interface LogVocabulary {
  /** In display order. `id` is the type's own, stored beside the code on every entry. */
  applicable: { id: string; code: string; label: string }[];
  codes: Set<string>;
}

export interface ActivityComplianceView {
  membershipId: string;
  /** `ACTIVITY_COMPLIANCE_7D` — logged at least once in the rolling window. */
  compliant7d: boolean;
  /** `ACTIVITY_COMPLIANCE_MONTH` — logged at least once this calendar month. */
  compliantMonth: boolean;
  /** Null when the member has never logged, which reads as *Never logged* rather than 0. */
  lastLoggedOn: LocalDate | null;
  windowDays: number;
}

/**
 * What an agent did, day by day (P6-T1, P6-T3, P6-T4, P6-T5, P6-T6).
 *
 * **Only the person themselves writes their own log.** `roles-and-permissions.md` §3.5 grants
 * `activity_log:proxy_create` to nobody at all, with the reason: the daily log is the evidentiary
 * base for compliance, MAA status, coaching coverage and campaign qualification, and a proxy write
 * destroys its meaning. That is enforced structurally here rather than by validation — the write
 * path takes **no** subject at all and always writes `ctx.membershipId`, so there is no argument
 * anybody could pass to log for somebody else.
 *
 * **Reading is wide and writing is narrow, and the asymmetry is the design.** A leader reads a
 * downline's rows because coaching depends on it — and every such read is audited (P10.1-T7).
 *
 * **Whose days a read is about is not decided here** (P11-T3). `CoachResolver.subject` resolves the
 * subject the way every subject read in the product does, and `SubjectReadAudit` writes the entry
 * the way every one of them does. The three reads below name the permission and the surface.
 */
@Injectable()
export class ActivityService {
  constructor(
    private readonly logs: ActivityLogRepository,
    private readonly types: ActivityTypeRepository,
    private readonly categories: ActivityCategoryRepository,
    private readonly coach: CoachResolver,
    /*
     * The office's own row, read by `_id: ctx.kpmId` in `office()` and nowhere else. `Kpm` is the
     * tenant record itself, not a tenant-scoped collection — it has no `kpmId` to scope by — and
     * `repositories.tenancy.spec.ts` names it so, with the reason (P10.1-T7, closing Phase 10's
     * carry-forward #1).
     */
    @InjectModel(Kpm.name) private readonly kpms: Model<Kpm>,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly ratioDefinitions: RatioDefinitionRepository,
    private readonly subjectReads: SubjectReadAudit,
    /*
     * The month's plan the 7-day targets are pro-rated from (P11-T4): the goal and the office's
     * production, read as `GET /summary` reads them, and the sections a rung is shown.
     */
    private readonly goals: GoalService,
    private readonly production: ProductionReadings,
    private readonly readings: ActivityReadings,
    /*
     * P13-T3 AC-5: a day saved or corrected may complete a hire's four weeks of activity. A port the
     * activation module answers, so activity does not depend on it; optional, failing open.
     */
    @Optional() @Inject(ActivationEvents) private readonly activation: ActivationEvents | null = null,
    /*
     * P13.1-T2: the published copy Log Activity draws its rows from (`/kpm/config`), so the day it opens
     * and the save after it read the vocabulary the screen shows. The application always provides it;
     * optional so a hand-built instance that saves no day — the seed's snapshot builder — need not
     * construct the whole configuration renderer. Without it the vocabulary is the working copy, which is
     * what `readPublished` itself answers an office with nothing published.
     *
     * **The token is named**, as the activation port's is: a parameter typed `X | null` is emitted as
     * `Object`, which no provider answers, so `@Optional()` alone resolved it to null in the real graph and
     * the save read the draft again (`app.module.int.spec.ts` pins it).
     */
    @Optional() @Inject(TenantConfigService) private readonly published: TenantConfigService | null = null,
  ) {}

  // ------------------------------------------------------------------ reading

  /**
   * One day, for the caller or for somebody their scope reaches. Its rows are the published vocabulary on
   * the subject's rung (P13.1-T2), read once beside the day: the rows Log Activity draws, so every code the
   * screen sends back on Save is one the save accepts.
   */
  async readDay(
    ctx: RequestContext, input: { membershipId?: string; date?: string },
  ): Promise<ActivityDayView> {
    const office = await this.office(ctx);
    const today = localDayOf(this.clock.now(), office.timezone);
    const subject = await this.coach.subject(ctx, input.membershipId, 'activity_log:read_raw');
    const date = this.requireDay(input.date ?? today);

    const [row, vocabulary] = await Promise.all([
      this.logs.findOne(ctx, { membershipId: subject.membershipId, localDate: date }),
      this.vocabularyFor(ctx, subject.orgLevelCode),
    ]);
    await this.subjectReads.record(ctx, subject, 'log', { from: date, to: date });
    return this.view(row, subject, date, today, office, vocabulary, ctx);
  }

  /**
   * Totals per activity code over a window (P6-T4) — and, for the coaching session's Activity card and its
   * drill (P11-T4 AC-4), the goal's three cascade codes against their pro-rated targets and the summary
   * tiles the subject is shown.
   *
   * - **`targets`**: `SUB_PERIOD_ACTIVITY_TARGET` for `ROLLING_7D` only — this month's
   *   `SUMMARY_ACTIVITY_TARGET`, computed by the Summary's own `summaryPlan` and pro-rated, so the
   *   session's card and the coachee's Summary tab cannot disagree about the month. Any other period, or
   *   a custom range, keeps the counts and has no target: `null`.
   * - **`sections`**: the subject's tiles, by the Summary's own `sectionChips`, on **the subject's rung**
   *   (ADR-0020): the cascade tiles left to the targets, a tile per `summaryGroupCode` (ADR-0064).
   * - **Whose** is `CoachResolver.subject` on `activity_ratios:read`, and another member's read writes the
   *   §3.5 entry, surface `summary`, last, once the answer exists. A self-read writes none.
   */
  async summary(
    ctx: RequestContext,
    input: { membershipId?: string; period?: string; from?: string; to?: string },
  ): Promise<ActivitySummaryView> {
    const office = await this.office(ctx);
    const today = localDayOf(this.clock.now(), office.timezone);
    const subject = await this.coach.subject(ctx, input.membershipId, 'activity_ratios:read');
    const view = await this.summaryOver(ctx, subject, input, today);

    // Last, once the answer exists; nothing for the caller's own read (`SubjectReadAudit`).
    await this.subjectReads.record(ctx, subject, 'summary', { from: view.from, to: view.to });
    return view;
  }

  /**
   * **The last 7 days of a subject the caller already resolved, and no audit entry** (P11-T4): the
   * subject-taking internal of `summary` for `ROLLING_7D`, as `ratiosOf` is of `ratios` — the counts, the
   * three cascade codes against their pro-rated targets, and the tiles. The coaching session's snapshot
   * reads it at finalize, which writes its own entry for what it disclosed.
   */
  async weekOf(
    ctx: RequestContext, subject: { membershipId: string; orgLevelCode: string },
  ): Promise<ActivitySummaryView> {
    const office = await this.office(ctx);
    const today = localDayOf(this.clock.now(), office.timezone);
    return this.summaryOver(ctx, subject, { period: 'ROLLING_7D' }, today);
  }

  private async summaryOver(
    ctx: RequestContext,
    subject: { membershipId: string; orgLevelCode: string },
    input: { period?: string; from?: string; to?: string },
    today: LocalDate,
  ): Promise<ActivitySummaryView> {
    const window = this.windowFor(input, today);
    // *Last 7 days* by name is the only window a month's targets are pro-rated to: a custom range is not.
    const weekly = !input.from && !input.to && (input.period ?? 'ROLLING_7D') === 'ROLLING_7D';

    const [rows, labels, shown, plan] = await Promise.all([
      this.logs.find(ctx, {
        membershipId: subject.membershipId,
        localDate: { $gte: window.from, $lte: window.to },
      }),
      this.labelsByCode(ctx, subject.orgLevelCode),
      // The subject's rung, not the reader's (ADR-0020): a leader reads the coachee's own tiles.
      this.readings.sectionsShown(ctx, subject.orgLevelCode),
      this.monthPlan(ctx, subject.membershipId, today, weekly),
    ]);

    const totals = new Map<string, number>();
    let totalCount = 0;
    for (const row of rows) {
      for (const entry of row.entries) {
        totals.set(entry.activityTypeCode, (totals.get(entry.activityTypeCode) ?? 0) + entry.count);
        totalCount += entry.count;
      }
    }

    const week = weekly ? subPeriodActivityTarget(plan.monthly) : null;
    const { leadsCode, appointmentsCode, closingsCode } = plan.mapping;
    const target = (key: ActivityTargetKey, code: string, of: number | undefined): ActivityWindowTargetView => ({
      key, code, logged: totals.get(code) ?? 0, target: of ?? null,
    });

    return {
      ...window,
      // Every active code, including the ones with no activity: a screen showing only what was
      // logged cannot show that nothing was.
      totals: [...labels.entries()].map(([code, label]) => ({
        activityTypeCode: code, label, count: totals.get(code) ?? 0,
      })),
      daysLogged: rows.length,
      totalCount,
      targets: [
        target('leads', leadsCode, week?.leads),
        target('appointments', appointmentsCode, week?.appointments),
        target('closings', closingsCode, week?.policies),
      ],
      sections: sectionChips(shown, totals, [leadsCode, appointmentsCode, closingsCode]),
    };
  }

  /**
   * The Activity Dashboard (P10-T1): a member's days over a range, per type and per column.
   *
   * **Yours, or a coachee's** (P13.1-T9). Without `for` it is the reader's own, as `/activity/dashboard`
   * shows it. With one it is coaching's *Activity* tab: the subject resolved by `CoachResolver.subject` on
   * `activity_log:read_raw` as `GET /activity/log` resolves its own — `own` reaches only the caller, a
   * hierarchy token `COACH`, `own-kpm` the office; outside it, 404 — and drawn on **the subject's rung**
   * (ADR-0020), so a leader reads the sections the coachee is shown. Another member's read writes the
   * §3.5 entry, surface `activity_dashboard`, over the range, last, once the answer exists; a self-read
   * writes none. It was first-person only until 2026-10-07, when the client asked for the same data in
   * coaching, which is where a leader's read of a downline and its audit entry live.
   *
   * **Summed from what is stored, not from the summary's `totals`.** Those keep only the codes this
   * rung is shown today, while `totalCount` counts everything; reusing them would make a section's
   * rows add up to less than its total the day an office archives a type.
   */
  async dashboard(
    ctx: RequestContext, input: { for?: string; range?: string; from?: string; to?: string },
  ): Promise<ActivityDashboardView> {
    // The membership first: a Super Admin holds `read_raw` over everything and has no days of their
    // own, and *you have no membership here* is the true answer — not *office not found*.
    this.requireMembership(ctx);
    const office = await this.office(ctx);
    const subject = await this.coach.subject(ctx, input.for, 'activity_log:read_raw');
    // The subject's rung, not the reader's (ADR-0020): a leader reads the coachee's own sections.
    const rung = subject.orgLevelCode;
    const today = localDayOf(this.clock.now(), office.timezone);
    const range = dashboardRange(input, today);
    const buckets = bucketsFor(range);

    const [rows, categories, types] = await Promise.all([
      this.logs.find(ctx, { membershipId: subject.membershipId, localDate: { $gte: range.from, $lte: range.to } }),
      this.categories.find(ctx, {}, { sort: { displayOrder: 1 } }),
      this.types.find(ctx, {}, { sort: { displayOrder: 1 } }),
    ]);

    const byCode = new Map<string, number[]>();
    for (const row of rows) {
      const column = bucketIndex(buckets, row.localDate);
      for (const entry of row.entries) {
        if (entry.count === 0) continue;
        const counts = byCode.get(entry.activityTypeCode) ?? buckets.map(() => 0);
        counts[column] += entry.count;
        byCode.set(entry.activityTypeCode, counts);
      }
    }
    const zero = () => buckets.map(() => 0);
    const sum = (lists: number[][]) => buckets.map((_, i) => lists.reduce((t, l) => t + l[i], 0));
    const total = (counts: number[]) => counts.reduce((t, n) => t + n, 0);

    const shownHere = (c: { status: string; appliesToOrgLevelCodes?: string[] }) => c.status === 'active'
      && ((c.appliesToOrgLevelCodes ?? []).length === 0 || (c.appliesToOrgLevelCodes ?? []).includes(rung));
    const placed = new Set<string>();

    const section = (
      code: string, label: string, standing: DashboardStanding, members: typeof types,
    ): DashboardSectionView | null => {
      const rowsHere = members
        .filter((t) => (standing === 'shown' && t.status === 'active') || byCode.has(t.code))
        .map((t): DashboardTypeView => {
          placed.add(t.code);
          const counts = byCode.get(t.code) ?? zero();
          return {
            code: t.code,
            label: t.label,
            description: t.description ?? null,
            displayOrder: t.displayOrder,
            standing: standing !== 'shown' ? standing : t.status === 'active' ? 'shown' : 'archived',
            total: total(counts),
            counts,
          };
        });
      if (standing !== 'shown' && rowsHere.length === 0) return null;
      const counts = sum(rowsHere.map((r) => r.counts));
      return { code, label, standing, total: total(counts), counts, types: rowsHere };
    };

    const ordered = [
      ...categories.filter(shownHere),
      ...categories.filter((c) => !shownHere(c)),
    ];
    const sections = ordered
      .map((c) => section(
        c.code, c.label, shownHere(c) ? 'shown' : c.status === 'active' ? 'not_shown' : 'archived',
        types.filter((t) => t.categoryCode === c.code),
      ))
      .filter((s): s is DashboardSectionView => s !== null);

    // A count against a code no category holds. Nothing writes one — a code is refused unless the
    // office has it — but a row the totals include and the table does not is the defect this screen
    // exists to avoid, so it gets a section rather than a silent gap.
    const stray = [...byCode.keys()].filter((code) => !placed.has(code));
    if (stray.length > 0) {
      const counts = stray.map((code) => byCode.get(code)!);
      sections.push({
        code: '', label: 'Other', standing: 'archived', total: total(sum(counts)), counts: sum(counts),
        types: stray.map((code, i) => ({
          code, label: code, description: null, displayOrder: 0, standing: 'archived',
          total: total(counts[i]), counts: counts[i],
        })),
      });
    }

    const counts = sum(sections.map((s) => s.counts));
    const view: ActivityDashboardView = {
      ...range,
      today,
      buckets,
      sections,
      total: total(counts),
      counts,
      daysLogged: rows.length,
      correctedDays: rows.filter((r) => (r.corrections ?? []).length > 0).length,
    };

    // Last, once the answer exists; nothing for the caller's own read (`SubjectReadAudit`).
    await this.subjectReads.record(ctx, subject, 'activity_dashboard', { from: view.from, to: view.to });
    return view;
  }

  /**
   * The office's ratios, computed over a member's last 30 days (P10-T2, P10-T3).
   *
   * **The window is `ROLLING_30D`, fixed** (ADR-0022) — *last 30 days* in every office. **The
   * definitions are the office's own**: its formulas, including one it changed (ADR-0024), and its
   * benchmarks. **The counts are every stored entry by code**, archived types included: archiving a
   * type does not stop the ratios that name it from computing over the days it covers.
   *
   * **Only the ratios that are a question about the subject's rung** (ADR-0020): one that does not
   * apply is left out of the answer altogether — hidden, never shown as failed. The subject's rung,
   * not the reader's: a leader reading a downline reads the downline's ratios.
   *
   * **Yours, or a coachee's** (P11-T4 AC-2): `for` names the subject, resolved by `CoachResolver.subject`
   * on `activity_ratios:read` as every subject read is — `own` reaches only the caller, a hierarchy token
   * `COACH`, `own-kpm` the office; outside it, 404. The session's Ratios card reads it. Another member's
   * ratios write the §3.5 entry, surface `ratios`, over the 30 days, once the answer exists; a self-read
   * writes none.
   */
  async ratios(ctx: RequestContext, forMembershipId?: string): Promise<ActivityRatiosView> {
    const subject = await this.coach.subject(ctx, forMembershipId, 'activity_ratios:read');
    const view = await this.ratiosOf(ctx, subject);
    await this.subjectReads.record(ctx, subject, 'ratios', { from: view.from, to: view.to });
    return view;
  }

  /**
   * **The ratios of a subject the caller already resolved**, on the subject's rung, and **no audit
   * entry** (P11-T4 AC-1): the subject-taking internal of `ratios`, for a read that resolved the
   * subject on its own permission and writes its own §3.5 entry. `GET /summary?for=` is one, and its
   * one entry covers the ratios its insight cards read — a second entry here would record one
   * disclosure twice.
   */
  async ratiosOf(
    ctx: RequestContext, subject: { membershipId: string; orgLevelCode: string },
  ): Promise<ActivityRatiosView> {
    const office = await this.office(ctx);
    const today = localDayOf(this.clock.now(), office.timezone);
    const window = rollingWindow(today, PERIOD.ROLLING_30D_DAYS);

    const [rows, definitions, categories, types] = await Promise.all([
      this.logs.find(ctx, { membershipId: subject.membershipId, localDate: { $gte: window.from, $lte: window.to } }),
      this.ratioDefinitions.find(ctx, { status: 'active' }, { sort: { displayOrder: 1 } }),
      this.categories.find(ctx, {}),
      this.types.find(ctx, {}),
    ]);

    const sums = new Map<string, number>();
    for (const row of rows) {
      for (const entry of row.entries) {
        sums.set(entry.activityTypeCode, (sums.get(entry.activityTypeCode) ?? 0) + entry.count);
      }
    }
    const typeOf = new Map(types.map((t) => [t.code, t]));
    const sectionOf = new Map(categories.map((c) => [c.code, c]));
    const term = (code: string): RatioTermView => {
      const type = typeOf.get(code);
      return { code, label: type?.label ?? code, displayOrder: type?.displayOrder ?? 0 };
    };
    /** The one section a list of codes belongs to, or undefined when they span more than one. */
    const sectionFor = (codes: readonly string[]) => {
      const sections = [...new Set(codes.map((code) => typeOf.get(code)?.categoryCode))];
      return sections.length === 1 && sections[0] ? sectionOf.get(sections[0]) : undefined;
    };
    const tagFor = (comparison: string, denominator: readonly string[]) => {
      if (comparison === 'band') return { code: null, label: 'Balance' };
      const section = sectionFor(denominator);
      return section ? { code: section.code, label: section.label } : null;
    };

    return {
      membershipId: subject.membershipId,
      ...window,
      days: PERIOD.ROLLING_30D_DAYS,
      ratios: definitions
        .filter((d) => appliesTo(d.appliesToOrgLevelCodes, subject.orgLevelCode))
        .map((d): ActivityRatioView => {
          const diverged = diverges(d);
          return {
            code: d.code,
            label: d.label,
            comparison: d.comparison,
            displayUnit: d.displayUnit,
            benchmark: d.benchmark,
            tag: tagFor(d.comparison, d.denominator),
            sides: d.comparison === 'band'
              ? { numerator: sectionFor(d.numerator)?.label ?? null, denominator: sectionFor(d.denominator)?.label ?? null }
              : null,
            numerator: d.numerator.map(term),
            denominator: d.denominator.map(term),
            purpose: d.origin === 'platform' && !diverged ? SEED_RATIO_PURPOSES[d.code] ?? null : null,
            divergesFromStandard: diverged,
            ...computeRatio(d, sums),
          };
        }),
    };
  }

  /**
   * The three compliance metrics for one member (P6-T5).
   *
   * **Existence, not `totalCount > 0`** (ADR-0042, resolving OD-30). The metric asks whether this
   * person reported; whether they were busy is what the five ratios measure, and one number
   * answering two questions is what invariant §8 forbids. An agent can therefore hold a streak by
   * saving zeroes, which was accepted openly rather than discovered later.
   */
  async compliance(
    ctx: RequestContext, input: { membershipId?: string },
  ): Promise<ActivityComplianceView> {
    const office = await this.office(ctx);
    const today = localDayOf(this.clock.now(), office.timezone);
    const subject = await this.coach.subject(ctx, input.membershipId, 'activity_log:read_raw');
    const view = await this.complianceOn(ctx, subject.membershipId, today, office.settings.complianceWindowDays);

    // `from: null`, because `lastLoggedOn` discloses the latest day logged, whenever it was.
    await this.subjectReads.record(ctx, subject, 'compliance', { from: null, to: today });
    return view;
  }

  /**
   * **The compliance metrics of a subject the caller already resolved, and no audit entry** (P11-T4
   * AC-1): the subject-taking internal of `compliance`, as `ratiosOf` is of `ratios`. `GET /summary?for=`
   * resolves its subject on `personal_summary:read` and writes the one entry its read discloses; the
   * `compliance` surface's entry would be a second record of the same read.
   */
  async complianceOf(ctx: RequestContext, membershipId: string): Promise<ActivityComplianceView> {
    const office = await this.office(ctx);
    const today = localDayOf(this.clock.now(), office.timezone);
    return this.complianceOn(ctx, membershipId, today, office.settings.complianceWindowDays);
  }

  private async complianceOn(
    ctx: RequestContext, membershipId: string, today: LocalDate, windowDays: number,
  ): Promise<ActivityComplianceView> {
    const rolling = rollingWindow(today, windowDays);
    const month = calendarMonth(today);

    const [inWindow, inMonth, latest] = await Promise.all([
      this.logs.count(ctx, {
        membershipId, localDate: { $gte: rolling.from, $lte: rolling.to },
      }),
      this.logs.count(ctx, {
        membershipId, localDate: { $gte: month.from, $lte: month.to },
      }),
      this.logs.find(ctx, { membershipId }, { sort: { localDate: -1 }, limit: 1 }),
    ]);

    return {
      membershipId,
      compliant7d: inWindow > 0,
      compliantMonth: inMonth > 0,
      lastLoggedOn: latest[0]?.localDate ?? null,
      windowDays,
    };
  }

  // ------------------------------------------------------------------ writing

  /**
   * Save a day (P6-T1, P6-T3).
   *
   * Takes no subject: it always writes the caller's own log. Inside the correction window a save
   * replaces the row and bumps `version` — there is nothing older that mattered yet. After the
   * window the day is frozen and this refuses, pointing at the correction route.
   */
  async saveDay(
    ctx: RequestContext,
    input: { date?: string; counts: Record<string, number> },
  ): Promise<ActivityDayView> {
    const office = await this.office(ctx);
    const today = localDayOf(this.clock.now(), office.timezone);
    const me = this.requireMembership(ctx);
    const date = this.requireDay(input.date ?? today);

    if (isFutureDay(date, today)) {
      throw new DomainException(
        ErrorCode.ACTIVITY_FUTURE_DATE,
        `${date} has not happened yet in this office. A day is logged after it, not before.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { date, today },
      );
    }

    const grace = office.settings.activityBackdateGraceDays;
    if (!isWithinCorrectionWindow(date, today, grace)) {
      // Its own code, because the client can act on it: this is the one refusal with a next
      // step, and the screen switches to the correction form rather than showing a message.
      throw new DomainException(
        ErrorCode.ACTIVITY_DATE_OUT_OF_WINDOW,
        `${date} is closed for editing. Correct it instead, with a reason — the correction stays `
        + 'beside the numbers anybody has already read.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { date, graceDays: grace },
      );
    }

    const mine = ctx.membership?.orgLevelCode ?? '';
    // Read once, for the check and for the answer: the save's vocabulary is the one the screen showed.
    const vocabulary = await this.vocabularyFor(ctx, mine);
    const entries = this.readCounts(vocabulary, office.settings.activityDailyMaxCount, input.counts);
    const totalCount = entries.reduce((sum: number, e: { count: number }) => sum + e.count, 0);
    const existing = await this.logs.findOne(ctx, { membershipId: me, localDate: date });

    const row = existing
      ? await this.logs.updateById(ctx, String(existing._id), {
        $set: { entries, totalCount, updatedBy: ctx.userId },
        $inc: { version: 1 },
      })
      : await this.logs.create(ctx, {
        membershipId: me,
        localDate: date,
        entries,
        totalCount,
        source: 'self',
        enteredByMembershipId: me,
        version: 1,
        frozenAt: null,
        corrections: [],
        createdBy: ctx.userId,
      } as never);

    await this.audit.record(ctx, {
      action: existing ? 'activity_log.replaced' : 'activity_log.created',
      targetCollection: 'activityLogs',
      targetId: String(row!._id),
      after: { localDate: date, totalCount },
    });
    // P13-T3 AC-4: a day logged above zero may make the hire's fourth consecutive week.
    await signalActivation(this.activation, ctx, me, 'feature:activity');

    return this.view(row, { membershipId: me, orgLevelCode: mine }, date, today, office, vocabulary, ctx);
  }

  /**
   * Correct a frozen day (P6-T3, ADR-0042).
   *
   * The whole prior state moves into `corrections[]` — not a diff, because a diff is only
   * meaningful against a base somebody still holds, and the point is that a leader who coached
   * against Tuesday's numbers can still read Tuesday's numbers.
   */
  async correctDay(
    ctx: RequestContext,
    input: { date: string; counts: Record<string, number>; reason: string },
  ): Promise<ActivityDayView> {
    const office = await this.office(ctx);
    const today = localDayOf(this.clock.now(), office.timezone);
    const me = this.requireMembership(ctx);
    const date = this.requireDay(input.date);
    const reason = (input.reason ?? '').trim();

    if (!reason) {
      throw new BadRequestException(
        'Say why the day is being corrected. A correction nobody can explain is a number that '
        + 'changed for no reason anybody can find.',
      );
    }

    const existing = await this.logs.findOne(ctx, { membershipId: me, localDate: date });
    if (!existing) {
      throw new NotFoundException(
        `There is no entry for ${date} to correct. Log the day instead.`,
      );
    }

    const grace = office.settings.activityBackdateGraceDays;
    if (isWithinCorrectionWindow(date, today, grace)) {
      throw new BadRequestException(
        `${date} is still open — save it normally. A correction is for a day somebody has `
        + 'already read.',
      );
    }

    const mine = ctx.membership?.orgLevelCode ?? '';
    const vocabulary = await this.vocabularyFor(ctx, mine);
    const entries = this.readCounts(vocabulary, office.settings.activityDailyMaxCount, input.counts);
    const totalCount = entries.reduce((sum: number, e: { count: number }) => sum + e.count, 0);
    const now = this.clock.now();

    const row = await this.logs.updateById(ctx, String(existing._id), {
      $set: {
        entries,
        totalCount,
        // Set on the first correction and never moved: it marks when the day stopped being
        // freely editable, not when it was last touched.
        frozenAt: existing.frozenAt ?? now,
        updatedBy: ctx.userId,
      },
      $inc: { version: 1 },
      $push: {
        corrections: {
          version: existing.version,
          entries: existing.entries,
          totalCount: existing.totalCount,
          at: now,
          byMembershipId: me,
          reason,
        },
      },
    } as never);

    await this.audit.record(ctx, {
      action: 'activity_log.corrected',
      targetCollection: 'activityLogs',
      targetId: String(existing._id),
      before: { totalCount: existing.totalCount },
      after: { totalCount, reason },
    });
    // A corrected day counts as corrected (ADR-0042): it may make the fourth week, and never unmakes one.
    await signalActivation(this.activation, ctx, me, 'feature:activity');

    return this.view(row, { membershipId: me, orgLevelCode: mine }, date, today, office, vocabulary, ctx);
  }

  // ---------------------------------------------------------------- internals

  /** The office's timezone and knobs. Never the server clock, never the browser (invariant §9). */
  private async office(ctx: RequestContext) {
    const kpm = await this.kpms.findById(ctx.kpmId).select('timezone settings').lean().exec();
    if (!kpm) throw new NotFoundException('Kpm');
    const settings = (kpm as { settings?: Record<string, number> }).settings ?? {};
    return {
      timezone: (kpm as { timezone?: string }).timezone ?? DEFAULT_TENANT_TIMEZONE,
      settings: {
        activityDailyMaxCount: settings.activityDailyMaxCount ?? ACTIVITY.COUNT_MAX,
        activityBackdateGraceDays:
          settings.activityBackdateGraceDays ?? ACTIVITY.BACKDATE_GRACE_DAYS,
        // The platform defaults, not literals: these are the same numbers `kpm.schema.ts` seeds
        // `KpmSettings` from, and a second copy here is what invariant §7 forbids.
        complianceWindowDays: settings.complianceWindowDays ?? PERFORMANCE.COMPLIANCE_WINDOW_DAYS,
      },
    };
  }

  /**
   * The goal's cascade codes, and — for a 7-day read — this month's `SUMMARY_ACTIVITY_TARGET`, read and
   * computed exactly as `GET /summary` computes its *Monthly* targets (`summaryPlan`): the plan through
   * `GoalService.planOf`, the year to date through last month and this month's own APE. Another window
   * needs only the codes, so it reads no production.
   */
  private async monthPlan(
    ctx: RequestContext, membershipId: string, today: LocalDate, weekly: boolean,
  ): Promise<{
    mapping: { leadsCode: string; appointmentsCode: string; closingsCode: string };
    monthly: CascadeTargets | null;
  }> {
    const year = today.slice(0, 4);
    const month = today.slice(0, 7);
    const monthNumber = Number(today.slice(5, 7));
    const previous = monthNumber === 1 ? null : `${year}-${String(monthNumber - 1).padStart(2, '0')}`;
    const [goal, through, thisMonth] = await Promise.all([
      this.goals.planOf(ctx, year, membershipId),
      weekly && previous ? this.production.apeYearToDateThrough(ctx, membershipId, previous) : null,
      weekly ? this.production.apeForMonth(ctx, membershipId, month) : null,
    ]);
    const plan = weekly
      ? summaryPlan({ goal, month, throughLastMonthMinor: through?.minor ?? null, thisMonthMinor: thisMonth?.minor ?? null })
      : null;
    return { mapping: goal.cascadeMapping, monthly: plan?.monthlyCounts ?? null };
  }

  private requireMembership(ctx: RequestContext): string {
    if (!ctx.membershipId) {
      // `TENANT_NO_MEMBERSHIP` — the code the rest of the product already uses for exactly this.
      throw new NoMembershipException();
    }
    return ctx.membershipId;
  }

  private requireDay(value: string): LocalDate {
    if (!isLocalDate(value)) {
      throw new BadRequestException(`${value} is not a date. Days are written YYYY-MM-DD.`);
    }
    return value;
  }

  /**
   * Which activity types this rung is shown (ADR-0020, P4-T18).
   *
   * The rule lives on the **category** and cascades to its types; an empty list means every rung.
   * The Phase 6 exit review found the module ignoring it entirely — a plain agent was offered the
   * recruitment section their office had restricted to leaders, and every count they put in it
   * fed `SELLING_VS_RECRUITMENT`, which is the exact judgement ADR-0020 exists to stop them being
   * measured by.
   */
  private async taxonomyFor(ctx: RequestContext, orgLevelCode: string) {
    const [categories, all] = await Promise.all([
      this.categories.find(ctx, { status: 'active' }),
      this.types.find(ctx, { status: 'active' }, { sort: { displayOrder: 1 } }),
    ]);
    const shown = new Set(
      categories
        .filter((c) => (c.appliesToOrgLevelCodes ?? []).length === 0
          || (c.appliesToOrgLevelCodes ?? []).includes(orgLevelCode))
        .map((c) => c.code),
    );
    // Both lists, from one pair of queries. They were fetched separately until the exit review's
    // own measurement caught `readDay` at 433 ms against a 300 ms budget — the applicability fix
    // had added a round trip to every path that touched it, twice on the write.
    return { applicable: all.filter((t) => shown.has(t.categoryCode)), all };
  }

  /**
   * Every active activity type this rung is shown, by code, in the working copy: the summary's
   * `totals` (P6-T4). Not the log's vocabulary any more, which is the published one (`vocabularyFor`).
   */
  private async labelsByCode(
    ctx: RequestContext, orgLevelCode: string,
  ): Promise<Map<string, string>> {
    const { applicable } = await this.taxonomyFor(ctx, orgLevelCode);
    return new Map(applicable.map((row) => [row.code, row.label] as [string, string]));
  }

  /**
   * **The vocabulary a day is read and saved in: the office's published copy, on a rung** (P13.1-T2).
   *
   * Log Activity draws its sections and rows from `/kpm/config` — the snapshot agents work against
   * (P4-T6), never the draft an Owner is editing — and hides a section the reader's rung is not shown.
   * The day's rows and the save's check read that same copy through the same read, `readPublished`, so
   * a row on screen is a row the save takes and a code no screen offers is refused. They read the live
   * rows until 2026-10-07, and the client found the gap: a type archived in the draft after publishing
   * stayed on screen and its count was refused on Save as a code the office did not have — the seed's
   * `DEV_COACHING_RECEIVED`, and any office between an archive and its next publish. A type created in
   * the draft was the other way round: on no screen, and accepted.
   *
   * - **One read, one document.** `readDay` holds its 300 ms budget with it, beside the day's own read.
   * - **The screen's rule for a section** (ADR-0020): active, and for every rung or naming this one.
   *   The snapshot carries active rows only; the status is read again because the screen reads it.
   * - **Nothing published reads the working copy**, on both sides: `readPublished` falls back to it, so
   *   the screen and the save still agree. An office whose copy holds no type for the rung shows the
   *   empty-configuration card and no Save, and any code sent is refused here by name.
   */
  private async vocabularyFor(ctx: RequestContext, orgLevelCode: string): Promise<LogVocabulary> {
    if (!this.published) {
      const { applicable, all } = await this.taxonomyFor(ctx, orgLevelCode);
      return {
        applicable: applicable.map((t) => ({ id: String(t._id), code: t.code, label: t.label })),
        codes: new Set(all.map((t) => t.code)),
      };
    }
    const published = (await this.published.readPublished(ctx)).activity;
    const sections = published.filter((c) => c.status === 'active');
    const typesOf = (list: typeof published) => list
      .flatMap((c) => c.types.filter((t) => t.status === 'active'))
      .sort((a, b) => a.displayOrder - b.displayOrder);
    return {
      applicable: typesOf(sections.filter((c) => appliesTo(c.appliesToOrgLevelCodes, orgLevelCode)))
        .map((t) => ({ id: t.id, code: t.code, label: t.label })),
      /*
       * **Every type the copy holds, whatever its section's standing** — as the working copy's `all` was —
       * so a type the office has, in a section it does not show, keeps its own refusal,
       * `ACTIVITY_TYPE_NOT_APPLICABLE`, rather than reading as a code the office lacks (P13.1-T2 AC-3; the
       * exit review's finding 5).
       */
      codes: new Set(typesOf(published).map((t) => t.code)),
    };
  }

  /**
   * Turn `{ CODE: n }` into stored entries, against the vocabulary the screen showed (`vocabularyFor`).
   *
   * A code the office does not have is refused **by name** rather than dropped: a count filed
   * against a typo would vanish silently, and the agent would believe they had logged it. *Has* means
   * has published: a type the Owner has created and not published is on nobody's screen yet.
   */
  private readCounts(vocabulary: LogVocabulary, max: number, counts: Record<string, number>) {
    const { applicable, codes } = vocabulary;
    const byCode = new Map(applicable.map((row) => [row.code, row]));

    const sent = Object.keys(counts ?? {}).map((code) => code.trim().toUpperCase());
    const unknown = sent.filter((code) => !codes.has(code));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `This office has no activity type with the code ${unknown.join(', ')} in the list it has published.`,
      );
    }

    // A code that exists but belongs to a section this rung is not shown. Its own code, because
    // the row should not have been on screen: the client reloads its configuration rather than
    // showing a validation message about a field it offered.
    const hidden = sent.filter((code) => !byCode.has(code));
    if (hidden.length > 0) {
      throw new DomainException(
        ErrorCode.ACTIVITY_TYPE_NOT_APPLICABLE,
        `${hidden.join(', ')} counts activity in a section your office does not show your rung.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { codes: hidden },
      );
    }

    return applicable.map((row) => {
      const raw = Number(counts?.[row.code] ?? counts?.[row.code.toLowerCase()] ?? 0);
      // The prototype's clamp, kept: `Math.max(0, Math.min(999, n))`, and a non-number is 0.
      const count = Number.isFinite(raw) ? Math.max(0, Math.min(max, Math.trunc(raw))) : 0;
      return { activityTypeId: row.id, activityTypeCode: row.code, count };
    });
  }

  /**
   * A named period (ADR-0022), or a custom range. **Both rolling lengths are constants**: `ROLLING_7D`
   * was a literal 7, and `ROLLING_30D` read `kpms.settings.ratioWindowDays` — an office setting for a
   * window ADR-0022 fixed, so *"last 30 days"* could have meant something else in the next office.
   */
  private windowFor(
    input: { period?: string; from?: string; to?: string },
    today: LocalDate,
  ): { from: LocalDate; to: LocalDate } {
    if (input.from || input.to) {
      const from = this.requireDay(input.from ?? today);
      const to = this.requireDay(input.to ?? today);
      if (from > to) {
        throw new BadRequestException('The range starts after it ends.');
      }
      return { from, to };
    }
    switch (input.period ?? 'ROLLING_7D') {
      case 'CALENDAR_MONTH': return calendarMonth(today);
      case 'ROLLING_30D': return rollingWindow(today, PERIOD.ROLLING_30D_DAYS);
      case 'ROLLING_7D': return rollingWindow(today, PERIOD.ROLLING_7D_DAYS);
      default:
        throw new BadRequestException(
          `${input.period} is not a period. One of: ROLLING_7D, ROLLING_30D, CALENDAR_MONTH.`,
        );
    }
  }

  private view(
    row: ActivityLogDocument | null,
    subject: { membershipId: string; orgLevelCode: string },
    date: LocalDate,
    today: LocalDate,
    office: { settings: { activityBackdateGraceDays: number } },
    vocabulary: LogVocabulary,
    ctx: RequestContext,
  ): ActivityDayView {
    const stored = new Map((row?.entries ?? []).map((e) => [e.activityTypeCode, e]));

    // Every type of the published vocabulary, zeros included — the screen is the office's taxonomy,
    // so a type with no count still has a row to type into.
    const entries: ActivityCountView[] = vocabulary.applicable.map(({ code, label }) => ({
      activityTypeId: stored.get(code)?.activityTypeId ?? '',
      activityTypeCode: code,
      label,
      count: stored.get(code)?.count ?? 0,
    }));

    const open = isWithinCorrectionWindow(date, today, office.settings.activityBackdateGraceDays);
    return {
      membershipId: subject.membershipId,
      localDate: date,
      entries,
      totalCount: row?.totalCount ?? 0,
      version: row?.version ?? 0,
      frozenAt: row?.frozenAt ? row.frozenAt.toISOString() : null,
      editable: subject.membershipId === ctx.membershipId && open && !isFutureDay(date, today),
      correctionCount: row?.corrections?.length ?? 0,
    };
  }
}
