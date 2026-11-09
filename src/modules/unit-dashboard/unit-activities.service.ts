import { HttpStatus, Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { isLocalDate, rollingWindow, type LocalDate } from '@/common/time/local-day';
import { PERIOD } from '@/domain/constants';
import { ActivityRatioReadings, type ActivityRatioView } from '@/modules/activity/activity-ratio-readings';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { ActivityCategoryRepository, ActivityTypeRepository } from '@/modules/config/activity.repository';
import { MemberNames } from '@/modules/org/member-names.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { UNIT_DASHBOARD_REFUSALS } from './unit-dashboard.messages';
import { UnitDashboardService, type UnitPeople } from './unit-dashboard.service';
import { activityPeriodOf, type ActivityPeriod, type ActivitySpan } from './unit-figures';

/** A count against one activity code. Only codes counted above zero are listed. */
export interface CodeCount {
  code: string;
  count: number;
}

/** One person's column of the Activities table. */
export interface ActivitiesPerson {
  membershipId: string;
  name: string;
  isReader: boolean;
  /** In the *Unit* (the head and their direct agents who lead nobody); everybody is in the *Group*. */
  inUnit: boolean;
  /** Their profile photo, signed, when they have one (UI V1, UI-111); the column draws initials otherwise. */
  photoUrl: string | null;
  counts: CodeCount[];
  /** Their counts summed: the navy *Total* row's cell. */
  total: number;
}

/** A scope's *Total* column: each code summed over the scope's people, and those summed. */
export interface ScopeTotals {
  counts: CodeCount[];
  total: number;
}

/** One activity type's row of the table: the office's name, and its *Nama singkat* for the one line (MOB UI-180). */
export interface ActivitiesType {
  code: string;
  label: string;
  /** The office's *Nama singkat* (P19.8-T4, ADR-0229 §5), `null` for none: the row shows `label` on up to two lines. */
  shortLabel: string | null;
  status: 'active' | 'archived';
}

/** A section of the table (`Leads generation`, `Selling`, …), as the office named and ordered it. */
export interface ActivitiesSection {
  code: string;
  label: string;
  status: 'active' | 'archived';
  types: ActivitiesType[];
}

/** One person's five ratios on the ratio card (P19.8-T4 AC-7, MOB UI-184): asked by `ratioFor`. */
export interface PersonRatios {
  membershipId: string;
  /** The Ratio page's ratios over their own counts, the same 30 days, on their own rung. */
  ratios: ActivityRatioView[];
}

export interface UnitActivitiesView {
  today: LocalDate;
  period: ActivityPeriod;
  head: { membershipId: string; name: string; isReader: boolean };
  empty: boolean;
  sections: ActivitiesSection[];
  people: ActivitiesPerson[];
  totals: { unit: ScopeTotals; group: ScopeTotals };
  /**
   * *Ratio · 30 hari terakhir*: always the last 30 days, whatever the period (UI-001). `person` is one member's, when
   * `ratioFor` names somebody of the *Group* (P19.8-T4 AC-7, MOB UI-184); `null` otherwise.
   */
  ratios: {
    from: LocalDate; to: LocalDate; days: number; unit: ActivityRatioView[]; group: ActivityRatioView[];
    person: PersonRatios | null;
  };
}

/**
 * **The Unit Dashboard's *Activities* tab** (UI V1, Phase 18.11 T4; UI-001, D-17; `functional/unit-dashboard.md`, *UI V1
 * (2026-10-30)*): `GET /unit/dashboard/activities`.
 *
 * - **Whose**: the dashboard's own reach (`UnitDashboardService.people`) — the reader's unit, or `for` a leader below
 *   them; the Owner and an Admin any leader's; 404 outside it, never 403.
 * - **The table**: every person's count per activity code over a week (Monday to Sunday) or a calendar month on the
 *   office's calendar (`ActivityReadings.countsOverMany`, archived types included), with each scope's *Total* column —
 *   *Unit* and *Group* — summed here, so the screen adds nothing up. Counts only, never points.
 * - **The sections**: the office's, in its order — every active one with its active types, and an archived one or type
 *   only while the period holds a count against it (ADR-0163 §6: archiving never erases what was logged).
 * - **The ratios**: the Ratio page's own computation (`ActivityRatioReadings.ratiosOfSets`, the one-member set of which
 *   is `GET /activity/ratios`) over the *Unit*'s and the *Group*'s counts summed, the last 30 days ending on the office's
 *   today (`ROLLING_30D`), on the head's rung. **One person's** (P19.8-T4 AC-7; MOB UI-184; ADR-0229 §7), when
 *   `ratioFor` names a member of the *Group*: the same computation over their counts alone, on their own rung — what
 *   their Ratio page shows. Anybody else — outside the *Group*, gone, another office's — is `404`, as `for` is.
 * - **The read is recorded**: one §3.5 entry per member shown other than the reader, in one insert, surface
 *   `unit_dashboard`, over the days it disclosed. It fails open.
 *
 * A fixed number of queries whatever the roster's size: none per person.
 */
@Injectable()
export class UnitActivitiesService {
  constructor(
    private readonly dashboard: UnitDashboardService,
    private readonly days: TenantDay,
    private readonly activity: ActivityReadings,
    private readonly ratios: ActivityRatioReadings,
    private readonly categories: ActivityCategoryRepository,
    private readonly types: ActivityTypeRepository,
    private readonly subjectReads: SubjectReadAudit,
    private readonly names: MemberNames,
  ) {}

  async read(
    ctx: RequestContext, query: { span?: ActivitySpan; date?: string; for?: string; ratioFor?: string } = {},
  ): Promise<UnitActivitiesView> {
    const office = await this.days.office(ctx);
    const date = query.date ?? office.today;
    if (!isLocalDate(date)) throw invalid('dateShape', { field: 'date' });
    if (date > office.today) throw invalid('futureDate', { field: 'date', today: office.today });
    const period = activityPeriodOf(query.span ?? 'week', date, office.today);

    const people = await this.dashboard.people(ctx, query.for);
    const shown = people.empty ? [] : people.group;
    // One person's ratios only within the dashboard's reach: a member of the *Group* shown, never the 404's other cases.
    const asked = query.ratioFor === undefined ? null : askedOf(people, shown, query.ratioFor);
    const ratioWindow = rollingWindow(office.today, PERIOD.ROLLING_30D_DAYS);
    const [counts, categories, types, ratios, personRatios, pictured] = await Promise.all([
      this.activity.countsOverMany(ctx, shown, { from: period.from, to: period.to }),
      this.categories.find(ctx, {}, { sort: { displayOrder: 1 } }),
      this.types.find(ctx, {}, { sort: { displayOrder: 1 } }),
      this.ratios.ratiosOfSets(
        ctx, { unit: people.empty ? [] : people.unit, group: shown }, people.head.orgLevelCode, ratioWindow,
      ),
      asked === null
        ? Promise.resolve(null)
        : this.ratios.ratiosOfSets(ctx, { one: [asked.membershipId] }, asked.rung, ratioWindow)
          .then((sets): PersonRatios => ({ membershipId: asked.membershipId, ratios: sets.one })),
      // Each column's photo, signed in one batch (UI-111); `people` named them already, so only the photos are new.
      this.names.pictured(ctx, shown),
    ]);

    const unit = new Set(people.unit);
    const columns: ActivitiesPerson[] = shown.map((id) => {
      const mine = counts.get(id) ?? new Map<string, number>();
      return {
        membershipId: id,
        name: people.names.get(id) ?? '',
        isReader: id === ctx.membershipId,
        inUnit: unit.has(id),
        photoUrl: pictured.get(id)?.photoUrl ?? null,
        counts: listed(mine),
        total: sum(mine.values()),
      };
    });

    // What the period holds a count against, for keeping an archived section or type on the table.
    const counted = new Set(columns.flatMap((p) => p.counts.map((c) => c.code)));
    const sections = categories
      .map((c): ActivitiesSection => ({
        code: c.code,
        label: c.label,
        status: c.status,
        types: types
          .filter((t) => t.categoryCode === c.code && (t.status === 'active' || counted.has(t.code)))
          .map((t): ActivitiesType => ({ code: t.code, label: t.label, shortLabel: t.shortLabel ?? null, status: t.status })),
      }))
      .filter((s) => (s.status === 'active' || s.types.some((t) => counted.has(t.code))) && s.types.length > 0);

    const view: UnitActivitiesView = {
      today: office.today,
      period,
      head: {
        membershipId: people.head.membershipId,
        name: people.names.get(people.head.membershipId) ?? '',
        isReader: people.head.isReader,
      },
      empty: people.empty,
      sections,
      people: columns,
      totals: {
        unit: totalsOf(columns.filter((p) => p.inUnit)),
        group: totalsOf(columns),
      },
      ratios: {
        ...ratioWindow, days: PERIOD.ROLLING_30D_DAYS, unit: ratios.unit, group: ratios.group, person: personRatios,
      },
    };

    // Last, once the answer exists: the days disclosed — the period up to today, and the ratios' 30 days. Those end on
    // today, and the period's disclosed days never run past it, so today ends the span.
    await this.subjectReads.recordMany(ctx, columns, 'unit_dashboard', {
      from: period.from < ratioWindow.from ? period.from : ratioWindow.from,
      to: ratioWindow.to,
    });
    return view;
  }
}

const sum = (values: Iterable<number>) => [...values].reduce((total, n) => total + n, 0);

/**
 * **The person `ratioFor` names, on their own rung** (P19.8-T4 AC-7, AC-13): a member of the *Group* shown, whose rung
 * `people.rungs` holds for every one of them. Anybody else is `404`, as `for` is. A member without a rung would be a
 * defect in `people`; it is the same `404`, never another rung's definitions passed off as theirs.
 */
function askedOf(people: UnitPeople, shown: readonly string[], membershipId: string): { membershipId: string; rung: string } {
  const rung = shown.includes(membershipId) ? people.rungs.get(membershipId) : undefined;
  if (rung === undefined) throw new NotFoundException('Member');
  return { membershipId, rung };
}

/** A person's counts as a list, codes above zero, A to Z by code so the answer is stable. */
function listed(counts: ReadonlyMap<string, number>): CodeCount[] {
  return [...counts]
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, count]) => ({ code, count }));
}

/** A scope's *Total* column: each code summed over its people, then those summed. */
function totalsOf(people: readonly ActivitiesPerson[]): ScopeTotals {
  const byCode = new Map<string, number>();
  for (const person of people) {
    for (const { code, count } of person.counts) byCode.set(code, (byCode.get(code) ?? 0) + count);
  }
  return { counts: listed(byCode), total: sum(people.map((p) => p.total)) };
}

/** `400 VALIDATION_FAILED` on `date`, its sentence in both languages. */
function invalid(key: 'dateShape' | 'futureDate', details: Record<string, unknown>): DomainException {
  return new DomainException(
    ErrorCode.VALIDATION_FAILED, UNIT_DASHBOARD_REFUSALS.VALIDATION_FAILED[key], HttpStatus.BAD_REQUEST, details,
  );
}
