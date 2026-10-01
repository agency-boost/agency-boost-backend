import { BadRequestException, HttpStatus, Injectable } from '@nestjs/common';
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
  DomainException, NoMembershipException, NotFoundException, OutOfScopeException,
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
import { AuditService } from '@/modules/audit/audit.service';
import {
  ActivityCategoryRepository, ActivityTypeRepository, RatioDefinitionRepository,
} from '@/modules/config/activity.repository';
import { diverges } from '@/modules/config/ratio.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Kpm } from '@/modules/tenants/kpm.schema';
import { scopeFor } from '@/modules/rbac/permissions';
import { ActivityLogRepository } from './activity-log.repository';
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

export interface ActivitySummaryView {
  from: LocalDate;
  to: LocalDate;
  totals: { activityTypeCode: string; label: string; count: number }[];
  daysLogged: number;
  totalCount: number;
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

/** The Activity Dashboard (P10-T1): the reader's own days over a range, types down and time across. */
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
 * The three reads that take a subject, as `activity_log.read_raw` names them. The Dashboard, the
 * ratios and the Summary take none, so they have no surface here.
 */
export type RawActivitySurface = 'log' | 'summary' | 'compliance';

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
 */
@Injectable()
export class ActivityService {
  constructor(
    private readonly logs: ActivityLogRepository,
    private readonly types: ActivityTypeRepository,
    private readonly categories: ActivityCategoryRepository,
    private readonly memberships: MembershipRepository,
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
  ) {}

  // ------------------------------------------------------------------ reading

  /** One day, for the caller or for somebody their scope reaches. */
  async readDay(
    ctx: RequestContext, input: { membershipId?: string; date?: string },
  ): Promise<ActivityDayView> {
    const office = await this.office(ctx);
    const today = localDayOf(this.clock.now(), office.timezone);
    const subject = await this.subjectFor(ctx, input.membershipId);
    const date = this.requireDay(input.date ?? today);

    const row = await this.logs.findOne(ctx, {
      membershipId: subject.membershipId, localDate: date,
    });
    await this.auditRawRead(ctx, subject, 'log', { from: date, to: date });
    return this.view(row, subject, date, today, office, ctx);
  }

  /** Totals per activity code over a window. The read Phase 10's dashboard will use (P6-T4). */
  async summary(
    ctx: RequestContext,
    input: { membershipId?: string; period?: string; from?: string; to?: string },
  ): Promise<ActivitySummaryView> {
    const office = await this.office(ctx);
    const today = localDayOf(this.clock.now(), office.timezone);
    const subject = await this.subjectFor(ctx, input.membershipId, 'activity_ratios:read');
    const window = this.windowFor(input, today);

    const rows = await this.logs.find(ctx, {
      membershipId: subject.membershipId,
      localDate: { $gte: window.from, $lte: window.to },
    });

    const labels = await this.labelsByCode(ctx, subject.orgLevelCode);
    const totals = new Map<string, number>();
    let totalCount = 0;
    for (const row of rows) {
      for (const entry of row.entries) {
        totals.set(entry.activityTypeCode, (totals.get(entry.activityTypeCode) ?? 0) + entry.count);
        totalCount += entry.count;
      }
    }

    await this.auditRawRead(ctx, subject, 'summary', window);
    return {
      ...window,
      // Every active code, including the ones with no activity: a screen showing only what was
      // logged cannot show that nothing was.
      totals: [...labels.entries()].map(([code, label]) => ({
        activityTypeCode: code, label, count: totals.get(code) ?? 0,
      })),
      daysLogged: rows.length,
      totalCount,
    };
  }

  /**
   * The Activity Dashboard (P10-T1): **your own** days over a range, per type and per column.
   *
   * **No subject.** The screen is first-person and the route takes nobody else's id: a leader reading a
   * downline's day-by-day is Phase 11's coaching copy, and §3.5 owes every such read the audit entry
   * `auditRawRead` writes, which this route would otherwise have to write too.
   *
   * **Summed from what is stored, not from the summary's `totals`.** Those keep only the codes this
   * rung is shown today, while `totalCount` counts everything; reusing them would make a section's
   * rows add up to less than its total the day an office archives a type.
   */
  async dashboard(
    ctx: RequestContext, input: { range?: string; from?: string; to?: string },
  ): Promise<ActivityDashboardView> {
    // The membership first: a Super Admin holds `read_raw` over everything and has no days of their
    // own, and *you have no membership here* is the true answer — not *office not found*.
    const me = this.requireMembership(ctx);
    const office = await this.office(ctx);
    const rung = ctx.membership?.orgLevelCode ?? '';
    const today = localDayOf(this.clock.now(), office.timezone);
    const range = dashboardRange(input, today);
    const buckets = bucketsFor(range);

    const [rows, categories, types] = await Promise.all([
      this.logs.find(ctx, { membershipId: me, localDate: { $gte: range.from, $lte: range.to } }),
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
    return {
      ...range,
      today,
      buckets,
      sections,
      total: total(counts),
      counts,
      daysLogged: rows.length,
      correctedDays: rows.filter((r) => (r.corrections ?? []).length > 0).length,
    };
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
   * **Your own, only**, as the Dashboard is. A leader reading a downline's ratios is Phase 11's coaching
   * copy; Goal Settings' measured line (P10-T9) is two metrics of its own over the goal's cascade codes
   * (ADR-0055), not these — so a subject parameter here would be one nothing calls.
   */
  async ratios(ctx: RequestContext): Promise<ActivityRatiosView> {
    const subject = { membershipId: this.requireMembership(ctx), orgLevelCode: ctx.membership?.orgLevelCode ?? '' };
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
    const subject = await this.subjectFor(ctx, input.membershipId);
    const windowDays = office.settings.complianceWindowDays;

    const rolling = rollingWindow(today, windowDays);
    const month = calendarMonth(today);

    const [inWindow, inMonth, latest] = await Promise.all([
      this.logs.count(ctx, {
        membershipId: subject.membershipId, localDate: { $gte: rolling.from, $lte: rolling.to },
      }),
      this.logs.count(ctx, {
        membershipId: subject.membershipId, localDate: { $gte: month.from, $lte: month.to },
      }),
      this.logs.find(
        ctx, { membershipId: subject.membershipId }, { sort: { localDate: -1 }, limit: 1 },
      ),
    ]);

    // `from: null`, because `lastLoggedOn` discloses the latest day logged, whenever it was.
    await this.auditRawRead(ctx, subject, 'compliance', { from: null, to: today });
    return {
      membershipId: subject.membershipId,
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
    const entries = await this.readCounts(
      ctx, mine, office.settings.activityDailyMaxCount, input.counts,
    );
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

    return this.view(row, { membershipId: me, orgLevelCode: mine }, date, today, office, ctx);
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
    const entries = await this.readCounts(
      ctx, mine, office.settings.activityDailyMaxCount, input.counts,
    );
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

    return this.view(row, { membershipId: me, orgLevelCode: mine }, date, today, office, ctx);
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
   * Whose log is being asked about, refused unless this caller's scope reaches them.
   *
   * `own` is always allowed for the caller themselves. Beyond that the scope comes from the grant
   * list, so widening who may read is a matrix change rather than a code change.
   */
  private async subjectFor(
    ctx: RequestContext,
    asked: string | undefined,
    /*
     * The permission the **route** declares, not a hardcoded one.
     *
     * `summary` is gated on `activity_ratios:read` and this resolved `activity_log:read_raw`. The
     * two grant lists are identical today, so nothing differed — but the matrix keeps them apart
     * because they are expected to diverge, and a narrowed `activity_ratios:read` would have left
     * this enforcing the old, wider scope. Found at the Phase 6 exit review.
     */
    permission: 'activity_log:read_raw' | 'activity_ratios:read' = 'activity_log:read_raw',
  ): Promise<{ membershipId: string; orgLevelCode: string }> {
    const me = ctx.membershipId;
    const subject = asked ?? me;
    if (!subject) {
      throw new NoMembershipException();
    }
    /*
     * The **subject's** rung, not the reader's. A section an office shows only to leaders is not
     * on an agent's day, and a leader opening that agent's day should see the agent's screen —
     * otherwise the row a leader reads and the row the agent filled in are different shapes.
     */
    if (subject === me) return { membershipId: subject, orgLevelCode: ctx.membership?.orgLevelCode ?? '' };

    const scope = scopeFor(ctx, permission);
    if (scope === null || scope === 'own') {
      throw new OutOfScopeException({ subject });
    }

    /*
     * **Resolve the membership before applying the scope, always.**
     *
     * The first version returned early for `own-kpm` and `all` on the reasoning that the log
     * repository already filters by office — which is true and is not enough. The *log* would
     * have been empty, but the answer was a 200 with a blank day for a membership belonging to
     * another office, so an Owner could probe another office's membership ids and tell a real
     * one from an invented one by nothing at all. The tenancy spec caught it.
     *
     * A 404 rather than a 403 throughout: a leader asking about somebody outside their downline
     * should not learn whether that membership exists from the shape of the refusal.
     */
    const member = await this.memberships.findById(ctx, subject);
    if (!member) throw new NotFoundException('Membership');
    const resolved = { membershipId: subject, orgLevelCode: member.orgLevelCode ?? '' };
    if (scope === 'own-kpm' || scope === 'all') return resolved;

    const reaches = scope === 'own-unit'
      ? member.leaderId === me
      : (member.ancestorIds ?? []).includes(me!);
    if (!reaches) throw new NotFoundException('Membership');
    return resolved;
  }

  /**
   * **Every read of another member's raw activity is audited** — `roles-and-permissions.md` §3.5,
   * obligation 1, which Phase 6 granted the reads on and never built (P10.1-T7).
   *
   * The Owner, the Admin and a leader read a member's days because §3.5 dropped a restriction three
   * other grants already routed around; the price of that honesty was that every such read leaves a
   * record of who read whose days, over which range, from which surface. This is that record.
   *
   * **Called last, once the answer exists.** A refused read — out of scope, another office, a date
   * that is not a date, a range that ends before it starts — has thrown before this line, so it
   * writes nothing: the log says what was *disclosed*, not what was asked for.
   *
   * **Reading yourself writes nothing.** Under impersonation the session is the record
   * (`impersonation.started`); a read of a third member there writes this entry naming both actors,
   * as `AuditService.record` always does.
   *
   * **The target is the membership**, so the Super Admin's audit screen names the person, and the
   * member's own *who viewed my activity* view (§3.5 obligation 2, not built yet) is one query on
   * `targetMembershipId`. A failed write never fails the read — `AuditService.record` logs it at
   * error level, the convention every audited write follows.
   */
  private async auditRawRead(
    ctx: RequestContext,
    subject: { membershipId: string },
    surface: RawActivitySurface,
    range: { from: LocalDate | null; to: LocalDate },
  ): Promise<void> {
    if (subject.membershipId === ctx.membershipId) return;
    await this.audit.record(ctx, {
      action: 'activity_log.read_raw',
      targetCollection: 'memberships',
      targetId: subject.membershipId,
      targetMembershipId: subject.membershipId,
      after: { surface, from: range.from, to: range.to },
    });
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

  /** Every active activity type, by code. The vocabulary a count may be filed against. */
  private async labelsByCode(
    ctx: RequestContext, orgLevelCode: string,
  ): Promise<Map<string, string>> {
    const { applicable } = await this.taxonomyFor(ctx, orgLevelCode);
    return new Map(applicable.map((row) => [row.code, row.label] as [string, string]));
  }

  /**
   * Turn `{ CODE: n }` into stored entries.
   *
   * A code the office does not have is refused **by name** rather than dropped: a count filed
   * against a typo would vanish silently, and the agent would believe they had logged it.
   */
  private async readCounts(
    ctx: RequestContext, orgLevelCode: string, max: number, counts: Record<string, number>,
  ) {
    const { applicable, all } = await this.taxonomyFor(ctx, orgLevelCode);
    const byCode = new Map(applicable.map((row) => [row.code, row]));
    const exists = new Set(all.map((row) => row.code));

    const sent = Object.keys(counts ?? {}).map((code) => code.trim().toUpperCase());
    const unknown = sent.filter((code) => !exists.has(code));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `This office has no activity type with the code ${unknown.join(', ')}.`,
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
      return { activityTypeId: String(row._id), activityTypeCode: row.code, count };
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

  private async view(
    row: ActivityLogDocument | null,
    subject: { membershipId: string; orgLevelCode: string },
    date: LocalDate,
    today: LocalDate,
    office: { settings: { activityBackdateGraceDays: number } },
    ctx: RequestContext,
  ): Promise<ActivityDayView> {
    const labels = await this.labelsByCode(ctx, subject.orgLevelCode);
    const stored = new Map((row?.entries ?? []).map((e) => [e.activityTypeCode, e]));

    // Every active type, zeros included — the screen is the office's taxonomy, so a type with no
    // count still has a row to type into.
    const entries: ActivityCountView[] = [...labels.entries()].map(([code, label]) => ({
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
