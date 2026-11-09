import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { InvalidRequestException, NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import { addDays, endOfMonth, type LocalDate } from '@/common/time/local-day';
import {
  ANALYTICS_SECTION_SLUGS, DEMOGRAPHICS, LEADER_CLASSES, type AnalyticsSectionKode, type Gender, type WorkStatus,
} from '@/domain/constants';
import { manpowerByDimension, type Demographics } from '@/domain/metrics/demographics';
import { maaMonthlyAvg } from '@/domain/metrics/held-months';
import { maaCountInUnit } from '@/domain/metrics/maa-count-in-unit';
import { monthlyActiveAgent } from '@/domain/metrics/monthly-active-agent';
import { rateOver } from '@/domain/metrics/rate';
import {
  daysLogged, eventNpsForPeriod, oneOnOnesPerWeek, powerUserCount, targetAttainment, weeklyActivityTarget,
} from '@/domain/metrics/subgroup';
import { oneDecimal } from '@/domain/metrics/quant';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { AuditService } from '@/modules/audit/audit.service';
import { CoachingReadings } from '@/modules/coaching/coaching-readings';
import type { AdvancedAnalyticsConfig } from '@/modules/config/analytics-config';
import { AnalyticsConfigReader } from '@/modules/config/analytics-config.reader';
import { EventReadings } from '@/modules/events/event-readings';
import { LeaderScorecardService } from '@/modules/leader-meetings/scorecard/scorecard.service';
import {
  BLOCKED_ROW_KEYS, ROW_KEYS, ROW_UNITS, TARGET_ROW_KEYS, type RowKey, type ScorecardCell, type ScorecardUnit,
} from '@/modules/leader-meetings/scorecard/scorecard.types';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';
import { OfficialApe } from '@/modules/production/official-ape';
import { readCell } from '@/modules/production/production-readings';
import { missingMonthsOf, UploadCompleteness } from '@/modules/production/upload-completeness';
import { can } from '@/modules/rbac/permissions';
import { SurveyRunRepository } from '@/modules/surveys/survey.repositories';
import { runState } from '@/modules/surveys/survey-rules';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { User, UserDocument } from '@/modules/users/user.schema';
import { partitionAgencies } from '../agency-partition';
import { OfficePeople, rungsFor } from '../office-people';
import { ADVANCED_ANALYTICS_REFUSALS as SAY } from './advanced-analytics.messages';
import { AnalyticsTargetRepository } from './advanced-analytics.repositories';
import { QuantRuns, type QuantView } from './quant-runs.service';

/** A section the page shows: its template kode (or *Event*'s), and its address. */
export interface SectionRef { kode: AnalyticsSectionKode | 'EVENTS'; slug: string }

/** `GET /kpm/advanced-analytics`: the tabs, in the template's order, then *Event*. */
export interface ShellView {
  templateName: string | null;
  version: number;
  sections: SectionRef[];
  /** The targets: the Owner's and the Admins', never a view-as session or the Super Admin. */
  canWrite: boolean;
  /** *Unggah data*, the empty state's next step (D-37): whoever may upload the month. */
  canUpload: boolean;
}

export interface AbOption { membershipId: string; name: string }

export interface DemographicsView extends Demographics {
  month: string;
  ab: AbOption | null;
  abs: AbOption[];
}

export interface EventsView {
  /** `ytd` (January to today) or a month, `YYYY-MM`. */
  period: { kind: 'ytd' | 'month'; from: LocalDate; to: LocalDate };
  ab: AbOption | null;
  abs: AbOption[];
  /** `EVENT_NPS_FOR_PERIOD`. */
  kpm: { nps: number | null; average: number | null; n: number };
  events: { eventId: string; title: string; startsOn: LocalDate; nps: number | null; average: number | null; n: number }[];
}

/** One cell of MAPA: the forum's cell, or *future* for a month not begun. */
export type MapaCell = { kind: 'figure'; value: number } | { kind: 'pending' | 'none' | 'blocked' | 'not_uploaded' | 'future' };

export interface MapaRow {
  row: RowKey;
  unit: ScorecardUnit;
  /** A row the forum tracks month by month; the others read *Not tracked* in a month and hold a year figure only. */
  monthly: boolean;
  /** The row takes a typed monthly target (the forum's five). */
  targetable: boolean;
  months: { month: string; value: MapaCell; lastYear: MapaCell; target: number | null; joined?: number }[];
  ytd: MapaCell;
  ytdLastYear: MapaCell;
}

export interface MapaView {
  year: string;
  /** The months the year columns sum through: this month, or December of a past year. */
  through: string;
  /** *Belum lengkap* (ADR-0214 §10): the months of each year column not complete, the current month never named. */
  ytdMissingMonths: string[];
  ytdLastYearMissingMonths: string[];
  rows: MapaRow[];
  canWrite: boolean;
}

export interface SubgroupRow {
  head: { membershipId: string; name: string };
  manpower: number;
  leaders: number;
  maa: { baseline: number | null; lastMonth: number | null; mtd: number | null; asOf: string | null };
  targets: { aa: number; rec: number; isDefault: boolean };
  adoption: { headDays: number; downlinePct: number | null };
  powerUsers: number;
  oneOnOnesPerWeek: number;
  weeklyActivityTarget: number;
  recruitment: { baseline: number | null; ytd: number | null; missingMonths: string[] };
  attainment: { aaPct: number | null; aaOk: boolean | null; recPct: number | null; recOk: boolean | null };
}

export interface SubgroupView {
  month: string;
  thresholds: { okPct: number; powerUserDays: number; powerUserWindow: number };
  rows: SubgroupRow[];
  canWrite: boolean;
}

const RECRUITMENT_KODE = 'RECRUITMENT';
const DAYS_ADOPTION = 30;

/**
 * **The KPM's *Advanced analytics* page** (P19.5-T3; ADR-0215; `functional/advanced-analytics.md`): the shell, and
 * *Demografi KPM*, *MAPA driver*, *Analitik kuantitatif*, *Perbaikan sub-group* and *Event*, each its own read.
 * *NPS KPM* and *Analitik kualitatif* are the surveys' (`SurveyRunsService`, ADR-0216).
 *
 * - **Who:** the Owner, the Admins and a Core Leader (`advanced_analytics:read`; any other field member `404`); and the
 *   Super Admin through `advancedAnalyticsForOffice`, a platform read's context (ADR-0207 §4; ADR-0215 §9).
 * - **A section that is off** in the template answers `404 NOT_FOUND`; its data is kept (spec §5, AC-11).
 * - **Every figure through the function that already computes it** — the forum's scorecard for MAPA, the Overview's
 *   people and readings, the events' readings — and every read through the tenant repositories (invariant §1).
 */
@Injectable()
export class AdvancedAnalyticsService {
  constructor(
    private readonly analytics: AnalyticsConfigReader,
    private readonly tenantDay: TenantDay,
    private readonly people: OfficePeople,
    private readonly memberships: MembershipRepository,
    private readonly names: MemberNames,
    /** Global (invariant §2): a person's birth date and gender, ADR-0158's fields, by the memberships' `userId`. */
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly events: EventReadings,
    private readonly activity: ActivityReadings,
    private readonly coaching: CoachingReadings,
    private readonly monthRows: MonthlyAgentDataRepository,
    private readonly production: OfficialApe,
    private readonly completeness: UploadCompleteness,
    private readonly scorecard: LeaderScorecardService,
    private readonly targets: AnalyticsTargetRepository,
    private readonly quant: QuantRuns,
    private readonly surveyRuns: SurveyRunRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------------------------------- reads

  /** **`GET /kpm/advanced-analytics`** — the tabs: the template's sections that are on, in its order, then *Event*. */
  async shell(ctx: RequestContext): Promise<ShellView> {
    reader(ctx);
    const published = await this.analytics.publishedFor(ctx);
    const office = await this.tenantDay.office(ctx);
    const open = await this.openSurveyKinds(ctx, office.today);
    const sections: SectionRef[] = published.config.sections
      .filter((s) => s.enabled || (s.kode === 'NPS' && open.has('nps')) || (s.kode === 'QUAL' && open.has('qual')))
      .map((s) => ({ kode: s.kode, slug: ANALYTICS_SECTION_SLUGS[s.kode] }));
    sections.push({ kode: 'EVENTS', slug: ANALYTICS_SECTION_SLUGS.EVENTS });
    return {
      templateName: published.templateName,
      version: published.version,
      sections,
      canWrite: canWrite(ctx),
      canUpload: can(ctx, 'data_upload:upload_and_preview') && !ctx.isImpersonating && !ctx.isPlatformRead,
    };
  }

  /** **`GET …/demographics`** — manpower at the month's end, by each dimension (AC-2). */
  async demographics(ctx: RequestContext, query: { month?: string; ab?: string }): Promise<DemographicsView> {
    reader(ctx);
    const config = await this.section(ctx, 'DEMOGRAPHICS');
    const office = await this.tenantDay.office(ctx);
    const month = this.monthOf(query.month, office.month);
    const { abs, group, ab } = await this.abFilter(ctx, query.ab);
    const end = month === office.month
      ? this.clock.endOfLocalDay(office.timezone, office.today)
      : this.clock.monthBounds(office.timezone, month).endExclusive;
    const lastDay = month === office.month ? office.today : endOfMonth(`${month}-01`);
    const rows = await this.memberships.find(
      ctx, { status: { $in: ['active', 'removed'] }, ...(group ? { _id: { $in: [...group] } } : {}) },
      { projection: { userId: 1, orgLevelCode: 1, status: 1, workStatus: 1, joinDate: 1, joinedAt: 1, removedAt: 1 } },
    );
    const userIds = [...new Set(rows.map((r) => r.userId).filter((id) => isValidObjectId(id)))];
    const facts = userIds.length === 0 ? [] : await this.users
      .find({ _id: { $in: userIds } }, { dateOfBirth: 1, gender: 1 }).lean().exec() as { _id: unknown; dateOfBirth?: string | null; gender?: Gender | null }[];
    const byUser = new Map(facts.map((u) => [String(u._id), u]));
    const members = rows.map((r) => {
      const user = byUser.get(r.userId);
      return {
        orgLevelCode: r.orgLevelCode,
        workStatus: (r.workStatus ?? null) as WorkStatus | null,
        gender: user?.gender ?? null,
        dateOfBirth: user?.dateOfBirth ?? null,
        joinDate: r.joinDate ?? null,
        counted: {
          status: r.status as 'active' | 'removed', joinedAt: r.joinedAt ?? null, removedAt: r.removedAt ?? null,
          joinDateStart: r.joinDate ? this.clock.startOfLocalDay(office.timezone, r.joinDate) : null,
        },
      };
    });
    const ladder = await this.people.ladder(ctx, office.companyId);
    const figures = manpowerByDimension(
      members, { endOfDay: end, lastDay },
      rungsFor(ladder, members.map((m) => m.orgLevelCode)),
      { ageBandUpper: config.thresholds.ageBandUpper, ageLabelFloor: DEMOGRAPHICS.AGE_LABEL_FLOOR, tenureBands: config.thresholds.tenureBands },
    );
    return { month, ab, abs, ...figures };
  }

  /** **`GET …/events`** — each event's NPS over its confirmed attendees, and the KPM's for the period (AC-3). */
  async eventsNps(ctx: RequestContext, query: { month?: string; ab?: string }): Promise<EventsView> {
    reader(ctx);
    const office = await this.tenantDay.office(ctx);
    const month = query.month === undefined ? null : this.monthOf(query.month, office.month);
    const from: LocalDate = month ? `${month}-01` : `${office.month.slice(0, 4)}-01-01`;
    const to: LocalDate = month ? (month === office.month ? office.today : endOfMonth(`${month}-01`)) : office.today;
    const { abs, group, ab } = await this.abFilter(ctx, query.ab);
    const facts = await this.events.eventsBetween(
      ctx, this.clock.startOfLocalDay(office.timezone, from), this.clock.endOfLocalDay(office.timezone, to),
    );
    const pooled: number[] = [];
    const events: EventsView['events'] = [];
    for (const event of facts) {
      const summary = await this.events.feedbackSummary(ctx, event.id);
      const scores = (summary?.rows ?? [])
        .filter((r) => r.counted && (!group || group.has(r.membershipId)))
        .map((r) => r.score);
      if (scores.length === 0) continue;
      pooled.push(...scores);
      const reading = eventNpsForPeriod(scores);
      events.push({ eventId: event.id, title: event.title, startsOn: event.startsOn, nps: reading.nps, average: reading.average, n: reading.n });
    }
    const kpm = eventNpsForPeriod(pooled);
    return {
      period: { kind: month ? 'month' : 'ytd', from, to },
      ab, abs,
      kpm: { nps: kpm.nps, average: kpm.average, n: kpm.n },
      events,
    };
  }

  /** **`GET …/quant`** — the ten metrics against the peer median (AC-5 to AC-9). */
  async quantView(ctx: RequestContext, query: { periodEnd?: string }): Promise<QuantView> {
    reader(ctx);
    const config = await this.section(ctx, 'QUANT');
    return this.quant.read(ctx, config.thresholds, query.periodEnd);
  }

  /** **`GET …/mapa`** — the forum's nine rows by month for a year, against last year and the KPM's targets (AC-4, AC-5). */
  async mapa(ctx: RequestContext, query: { year?: string }): Promise<MapaView> {
    reader(ctx);
    await this.section(ctx, 'MAPA');
    const office = await this.tenantDay.office(ctx);
    const thisYear = office.month.slice(0, 4);
    const year = query.year ?? thisYear;
    if (year > thisYear) throw new InvalidRequestException(SAY.VALIDATION_FAILED.yearShape, { field: 'year' });
    const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
    const through = year === thisYear ? office.month : `${year}-12`;
    const shown = months.filter((m) => m <= through);

    // The forum's own scorecard, once for each month: its *This Month*, *This Month, Last Year*, *YTD {Y}* and *YTD {Y−1}*.
    const cards = await Promise.all(shown.map((m) => this.scorecard.compute({
      kpmId: ctx.kpmId!, timezone: office.timezone, meetingDate: m === office.month ? office.today : endOfMonth(`${m}-01`),
    })));
    const last = cards[cards.length - 1];
    const lastYear = String(Number(year) - 1);
    const [targets, hires, fill] = await Promise.all([
      this.targets.mapaFor(ctx, months),
      this.memberships.find(
        ctx, { joinedAs: 'new_hire', joinDate: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } }, { projection: { joinDate: 1 } },
      ),
      this.completeness.forRange(ctx, { from: `${lastYear}-01`, to: through }),
    ]);
    const joinedIn = new Map<string, number>();
    for (const h of hires) {
      const m = (h.joinDate as string).slice(0, 7);
      joinedIn.set(m, (joinedIn.get(m) ?? 0) + 1);
    }
    const target = new Map(targets.map((t) => [`${t.month}|${t.row}`, t.value]));
    const ape = fill.config.config.uploadFields.find((f) => f.kode === 'APE') ?? { effectiveFrom: '0000-01' };
    const missing = (m: string) => missingMonthsOf(ape, m, fill.historyFrom, fill.fills).filter((x) => x !== office.month);
    const cellOf = (cell: ScorecardCell | undefined): MapaCell =>
      !cell || cell.kind === 'unrecorded' ? { kind: 'none' } : cell.kind === 'figure' ? { kind: 'figure', value: cell.value } : { kind: cell.kind };

    const rows: MapaRow[] = ROW_KEYS.map((row) => {
      const monthly = !BLOCKED_ROW_KEYS.includes(row);
      const targetable = (TARGET_ROW_KEYS as readonly string[]).includes(row);
      return {
        row,
        unit: ROW_UNITS[row],
        monthly,
        targetable,
        months: months.map((m) => {
          const i = shown.indexOf(m);
          const cells = i === -1 ? null : cards[i].rows.find((r) => r.key === row)?.cells ?? null;
          const value = cells ? cellOf(cells.thisMonth) : { kind: 'future' as const };
          const out: MapaRow['months'][number] = {
            month: m,
            value,
            lastYear: cells ? cellOf(cells.thisMonthLastYear) : { kind: 'future' },
            target: targetable ? target.get(`${m}|${row}`) ?? null : null,
          };
          // D2's ⓘ (ADR-0215 §7): the uploaded recruitment beside the members who joined as new hires that month.
          if (row === 'flc' && value.kind === 'figure' && (joinedIn.get(m) ?? 0) !== value.value) out.joined = joinedIn.get(m) ?? 0;
          return out;
        }),
        ytd: last ? cellOf(last.rows.find((r) => r.key === row)?.cells.ytd) : { kind: 'future' },
        ytdLastYear: last ? cellOf(last.rows.find((r) => r.key === row)?.cells.ytdLastYear) : { kind: 'future' },
      };
    });
    return {
      year,
      through,
      ytdMissingMonths: missing(through),
      ytdLastYearMissingMonths: missing(`${lastYear}${through.slice(4)}`),
      rows,
      canWrite: canWrite(ctx),
    };
  }

  /** **`GET …/subgroup`** — one row per AB's agency, this month (AC-10). */
  async subgroup(ctx: RequestContext): Promise<SubgroupView> {
    reader(ctx);
    const config = await this.section(ctx, 'SUBGROUP');
    const t = config.thresholds;
    const office = await this.tenantDay.office(ctx);
    const year = office.month.slice(0, 4);
    const lastYear = String(Number(year) - 1);
    const lastMonth = shift(office.month, -1);
    const roster = await this.people.read(ctx, this.clock.startOfLocalDay(office.timezone, `${lastYear}-01-01`), office.timezone);
    const { agencies } = partitionAgencies(roster.everyone.map((p) => ({ ...p, active: p.status === 'active' })));
    const activeIds = roster.active.map((p) => p.membershipId);
    const windowDays = Math.max(DAYS_ADOPTION, t.powerUserWindow);
    const days = Array.from({ length: windowDays }, (_, i) => addDays(office.today, -i));
    const adoptionDays = days.slice(0, DAYS_ADOPTION);
    const powerDays = days.slice(0, t.powerUserWindow);
    const [rows, held, saved, sessions, set, fill] = await Promise.all([
      this.monthRows.findByKode(ctx, { month: { $gte: `${lastYear}-01`, $lte: office.month } }, ['APE', 'POLICY_COUNT', RECRUITMENT_KODE]),
      this.production.officeMonths(ctx, { from: `${lastYear}-01`, to: office.month }),
      this.activity.perPersonPerDay(ctx, activeIds, days),
      this.coaching.countedSince(ctx, activeIds, addDays(office.today, -(DAYS_ADOPTION - 1))),
      this.targets.subgroupAll(ctx),
      this.completeness.forRange(ctx, { from: `${year}-01`, to: office.month }),
    ]);
    const cell = new Map(rows.map((r) => [`${r.membershipId}|${r.month}`, r]));
    const savedDays = new Map([...saved].map(([id, byDay]) => [id, new Set(byDay.keys())]));
    const activeIn = (id: string, m: string): boolean | null => {
      const r = cell.get(`${id}|${m}`);
      return r ? monthlyActiveAgent(readCell(r.values.APE).value, readCell(r.values.POLICY_COUNT).value) : null;
    };
    const recruitmentOf = (ids: readonly string[], months: readonly string[]): number | null => {
      const values = ids.flatMap((id) => months.map((m) => readCell(cell.get(`${id}|${m}`)?.values[RECRUITMENT_KODE]).value))
        .filter((v): v is number => v !== null);
      return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
    };
    const yearMonths = (y: string, to: string) => Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`).filter((m) => m <= to);
    const recruitmentField = fill.config.config.uploadFields.find((f) => f.kode === RECRUITMENT_KODE) ?? { effectiveFrom: '0000-01' };
    const recruitmentMissing = missingMonthsOf(recruitmentField, office.month, fill.historyFrom, fill.fills).filter((m) => m !== office.month);
    const names = roster.names;
    const byId = new Map(roster.everyone.map((p) => [p.membershipId, p]));

    const out: SubgroupRow[] = agencies.map((agency) => {
      const ids = agency.memberIds;
      const leaders = ids.filter((id) => (LEADER_CLASSES as readonly string[]).includes(byId.get(id)?.role ?? ''));
      const maaOf = (m: string) => maaCountInUnit(ids.map((id) => activeIn(id, m)), held.get(m)?.held === true);
      const own = set.get(agency.headId);
      const targets = own
        ? { aa: own.aaTarget, rec: own.recTarget, isDefault: false }
        : { aa: t.subgroupHeadDefaults.aa, rec: t.subgroupHeadDefaults.rec, isDefault: true };
      const baseline = maaMonthlyAvg(yearMonths(lastYear, `${lastYear}-12`).map(maaOf));
      const mtd = maaOf(office.month);
      const ytd = recruitmentOf(ids, yearMonths(year, office.month));
      const downline = ids.filter((id) => id !== agency.headId);
      const coaches = new Set(leaders);
      const aa = targetAttainment(mtd, targets.aa, t.subgroupOkPct);
      const rec = targetAttainment(ytd, targets.rec, t.subgroupOkPct);
      return {
        head: { membershipId: agency.headId, name: names.get(agency.headId) ?? '' },
        manpower: ids.length,
        leaders: leaders.length,
        maa: { baseline: baseline === null ? null : oneDecimal(baseline), lastMonth: maaOf(lastMonth), mtd, asOf: held.get(office.month)?.asOf ?? null },
        targets,
        adoption: {
          headDays: daysLogged(savedDays.get(agency.headId), adoptionDays),
          downlinePct: rateOver(downline.filter((id) => daysLogged(savedDays.get(id), adoptionDays) > 0).length, downline.length).pct,
        },
        powerUsers: powerUserCount(ids, savedDays, powerDays, t.powerUserDays),
        oneOnOnesPerWeek: oneOnOnesPerWeek(sessions.filter((s) => coaches.has(s.coachMembershipId)).length),
        weeklyActivityTarget: weeklyActivityTarget(t.subgroupWeekMultiplier, targets.aa),
        recruitment: { baseline: recruitmentOf(ids, yearMonths(lastYear, `${lastYear}-12`)), ytd, missingMonths: recruitmentMissing },
        attainment: { aaPct: aa.pct, aaOk: aa.ok, recPct: rec.pct, recOk: rec.ok },
      };
    }).sort((a, b) => a.head.name.localeCompare(b.head.name));

    return {
      month: office.month,
      thresholds: { okPct: t.subgroupOkPct, powerUserDays: t.powerUserDays, powerUserWindow: t.powerUserWindow },
      rows: out,
      canWrite: canWrite(ctx),
    };
  }

  // ------------------------------------------------------------------------------------------------ writes

  /** **`PUT …/targets/mapa`** — a MAPA target, or `null` (*TBD*); audited with before and after. */
  async setMapaTarget(ctx: RequestContext, input: { month: string; row: string; value: number | null }): Promise<{ month: string; row: string; value: number | null }> {
    requireMember(ctx);
    await this.section(ctx, 'MAPA');
    const { id, before } = await this.targets.setMapa(ctx, input.month, input.row, input.value);
    if (before !== input.value) {
      await this.audit.record(ctx, {
        action: 'advanced_analytics.target_set', targetCollection: 'analyticsTargets', targetId: id,
        before: before === undefined ? null : { kind: 'mapa', month: input.month, row: input.row, value: before },
        after: { kind: 'mapa', month: input.month, row: input.row, value: input.value },
      });
    }
    return { month: input.month, row: input.row, value: input.value };
  }

  /** **`PUT …/targets/subgroup/:headMembershipId`** — a head of group's targets; a head who is no AB of this KPM is 404. */
  async setSubgroupTarget(
    ctx: RequestContext, headMembershipId: string, input: { aaTarget: number; recTarget: number },
  ): Promise<{ headMembershipId: string; aaTarget: number; recTarget: number }> {
    requireMember(ctx);
    await this.section(ctx, 'SUBGROUP');
    const head = await this.memberships.findOne(ctx, { _id: headMembershipId, status: 'active', role: 'ab' });
    if (!head) throw new NotFoundException('Membership');
    const { id, before } = await this.targets.setSubgroup(ctx, headMembershipId, input.aaTarget, input.recTarget);
    if (!before || before.aaTarget !== input.aaTarget || before.recTarget !== input.recTarget) {
      await this.audit.record(ctx, {
        action: 'advanced_analytics.target_set', targetCollection: 'analyticsTargets', targetId: id,
        targetMembershipId: headMembershipId,
        before: before ? { kind: 'subgroup', ...before } : null,
        after: { kind: 'subgroup', aaTarget: input.aaTarget, recTarget: input.recTarget },
      });
    }
    return { headMembershipId, ...input };
  }

  // ------------------------------------------------------------------------------- the Super Admin's read

  /**
   * **A section over a named KPM, read-only, for the Super Admin** (ADR-0207 §4; ADR-0215 §9; P19.5-T3 AC-12): the KPM's
   * own function, through a platform read's context — refused any other context (`OfficePeople.requirePlatformRead`).
   */
  async advancedAnalyticsForOffice(
    ctx: RequestContext, section: string, query: { month?: string; ab?: string; year?: string; periodEnd?: string },
  ): Promise<unknown> {
    OfficePeople.requirePlatformRead(ctx);
    switch (section) {
      case 'shell': return this.shell(ctx);
      case 'demographics': return this.demographics(ctx, query);
      case 'mapa': return this.mapa(ctx, query);
      case 'quant': return this.quantView(ctx, query);
      case 'subgroup': return this.subgroup(ctx);
      case 'events': return this.eventsNps(ctx, query);
      default: throw new NotFoundException('Advanced analytics');
    }
  }

  // ------------------------------------------------------------------------------------------------ parts

  /** The template's configuration, the section on — or `404`: a section that is off has no read (AC-11). */
  private async section(ctx: RequestContext, kode: AnalyticsSectionKode): Promise<AdvancedAnalyticsConfig> {
    const { config } = await this.analytics.publishedFor(ctx);
    if (!config.sections.some((s) => s.kode === kode && s.enabled)) throw new NotFoundException('Advanced analytics', { section: kode });
    return config;
  }

  /** A month asked for: no later than this one. */
  private monthOf(asked: string | undefined, current: string): string {
    if (asked === undefined) return current;
    if (asked > current) throw new InvalidRequestException(SAY.VALIDATION_FAILED.monthShape, { field: 'month' });
    return asked;
  }

  /** The AB filter (ADR-0204 §2): the office's ABs, and the Group of the one asked — `404` for anybody else. */
  private async abFilter(ctx: RequestContext, ab: string | undefined): Promise<{ abs: AbOption[]; group: Set<string> | null; ab: AbOption | null }> {
    const heads = await this.memberships.find(ctx, { status: 'active', role: 'ab' }, { projection: { _id: 1 } });
    const ids = heads.map((h) => String(h._id));
    const names = await this.names.byMembershipId(ctx, ids);
    const abs = ids.map((id) => ({ membershipId: id, name: names.get(id) ?? '' })).sort((a, b) => a.name.localeCompare(b.name));
    if (ab === undefined) return { abs, group: null, ab: null };
    const chosen = abs.find((a) => a.membershipId === ab);
    if (!chosen) throw new NotFoundException('Membership');
    const below = await this.memberships.find(ctx, { ancestorIds: ab }, { projection: { _id: 1 } });
    return { abs, group: new Set([ab, ...below.map((m) => String(m._id))]), ab: chosen };
  }

  /** The survey kinds with a run open today: their tabs stay while it runs (ADR-0216 §2). */
  private async openSurveyKinds(ctx: RequestContext, today: LocalDate): Promise<Set<'nps' | 'qual'>> {
    const runs = await this.surveyRuns.list(ctx);
    return new Set(runs.filter((r) => runState(r, today) === 'open').map((r) => r.kind));
  }
}

/**
 * **Who reads the page** (ADR-0215 §2): the Owner, an Admin or a Core Leader — any other field member `404 NOT_FOUND`,
 * as KPM analytics answers them; a Super Admin outside a session `TENANT_NO_MEMBERSHIP`; a platform read, which the
 * route's own guard and `requirePlatformRead` have let through.
 */
function reader(ctx: RequestContext): void {
  if (ctx.isPlatformRead) return;
  if (!ctx.membershipId || !ctx.kpmId) throw new NoMembershipException();
  const office = ctx.membership?.isKpmOwner === true || ctx.membership?.isKpmAdmin === true;
  if (!office && !ctx.isCoreLeader) throw new NotFoundException('Advanced analytics');
}

function requireMember(ctx: RequestContext): void {
  if (!ctx.membershipId || !ctx.kpmId) throw new NoMembershipException();
}

/** The targets: `advanced_analytics:write`, never in a view-as session or a platform read. */
function canWrite(ctx: RequestContext): boolean {
  return can(ctx, 'advanced_analytics:write') && !ctx.isImpersonating && !ctx.isPlatformRead;
}

function shift(month: string, by: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
