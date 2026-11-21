import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { AUTH_GUARD_REFUSALS } from '@/common/auth/auth.messages';
import { canManageMember, requireOfficeSteward } from '@/common/auth/office-steward';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, InvalidRequestException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { addDays, endOfMonth, type LocalDate } from '@/common/time/local-day';
import {
  AB_GROUP_TARGETS, ANALYTICS_SECTION_KODES, ANALYTICS_SECTION_SLUGS, DEMOGRAPHICS, type AnalyticsSectionKode, type Gender,
  type WorkStatus,
} from '@/domain/constants';
import { DEMOGRAPHIC_DATA, INFORMAL_GROUP, type DemographicField } from '@/domain/constants/advanced-analytics';
import {
  completenessSummary, fieldCompleteness, missingFields, type FieldCompleteness,
} from '@/domain/metrics/demographic-completeness';
import { ageBandOf, manpowerByDimension, wholeYears, type Demographics } from '@/domain/metrics/demographics';
import {
  changeOf, MAPA_ROW_KEYS, MAPA_ROWS, monthlyMean, type MapaGroup, type MapaRowKey, type MapaUnit,
} from '@/domain/metrics/mapa';
import { memberAt } from '@/domain/metrics/office-headcount';
import { monthlyActiveAgent } from '@/domain/metrics/monthly-active-agent';
import {
  eventNpsForPeriod, oneOnOnesPerWeek, oneOnOneTarget, progressPct, progressTone, usagePct, type ProgressTone,
} from '@/domain/metrics/subgroup';
import { plusMonths } from '@/domain/metrics/quant';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { AuditService } from '@/modules/audit/audit.service';
import { CoachingReadings } from '@/modules/coaching/coaching-readings';
import type { AdvancedAnalyticsConfig } from '@/modules/config/analytics-config';
import { AnalyticsConfigReader } from '@/modules/config/analytics-config.reader';
import { EventReadings } from '@/modules/events/event-readings';
import { LeaderScorecardService } from '@/modules/leader-meetings/scorecard/scorecard.service';
import type { ColumnKey, ComputedScorecard, RowKey } from '@/modules/leader-meetings/scorecard/scorecard.types';
import { LeadReadings } from '@/modules/leads/lead-readings';
import { NOT_A_TEST_ACCOUNT } from '@/modules/org/counted-members';
import { MemberNames, type PicturedPerson } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { recruitsJoined } from '@/modules/org/recruits';
import { activeAgentsIn } from '@/modules/production/active-agents';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';
import { OfficialApe } from '@/modules/production/official-ape';
import { ProductionReadings } from '@/modules/production/production-readings';
import { UploadCompleteness } from '@/modules/production/upload-completeness';
import { can } from '@/modules/rbac/permissions';
import { SurveyRunRepository } from '@/modules/surveys/survey.repositories';
import { runState } from '@/modules/surveys/survey-rules';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { birthDateProblem } from '@/modules/users/personal-data';
import { User, UserDocument } from '@/modules/users/user.schema';
import { AbGroupTargetsService } from '../ab-group-targets/ab-group-targets.service';
import { OfficeGroups, type InformalPartition } from '../office-groups';
import { OfficePeople, rungsFor } from '../office-people';
import { ADVANCED_ANALYTICS_REFUSALS as SAY } from './advanced-analytics.messages';
import { AnalyticsTargetRepository } from './advanced-analytics.repositories';
import {
  dayFromFile, demographicsFile, readDemographicsFile, workStatusFromFile, type DemographicsFileRow,
} from './demographics-file';
import { QuantRuns, type QuantView } from './quant-runs.service';

// ------------------------------------------------------------------------------------------------------ the shell

/** A section the page shows: its template kode (or *Event*'s), and its address. */
export interface SectionRef { kode: AnalyticsSectionKode | 'EVENTS'; slug: string }

/** `GET /kpm/advanced-analytics`: the tabs, in the fixed order, then *Event*. */
export interface ShellView {
  templateName: string | null;
  version: number;
  sections: SectionRef[];
  /** The office's targets and groups may be changed here: a steward of the KPM, never view-as or a platform read. */
  canWrite: boolean;
  /** *Unggah data*, the empty state's next step (D-37): whoever may upload the month. */
  canUpload: boolean;
}

export interface AbOption { membershipId: string; name: string }

/** A person as a row draws them: the name in capitals, the orange *AB* / *AAB* before it, the photo. */
export interface PersonRef {
  membershipId: string;
  name: string;
  photoUrl: string | null;
  /** `ab`, `aab` or `agent`: the label before the name, none for an agent. */
  role: string;
}

// ------------------------------------------------------------------------------------------------------ Demografi

/** One member on *Data anggota*. */
export interface DemographicsMemberRow extends PersonRef {
  agentCode: string | null;
  uplineName: string | null;
  workStatus: WorkStatus | null;
  /** The age band — never the birth date itself on the page — or `null`, *Belum diisi*. */
  ageBand: 'gen_z' | 'gen_y' | 'gen_x' | null;
  joinDate: LocalDate | null;
  /** The required fields not on file: *Belum diisi*. Empty: *Data lengkap*. */
  missing: DemographicField[];
  /** For *Kirim pengingat* (`wa.me`), `null` with none. */
  phone: string | null;
}

export interface DemographicsView extends Demographics {
  month: string;
  ab: AbOption | null;
  abs: AbOption[];
  /** *Data dari profil anggota · {day}*: the office's day the read was made. */
  asOf: LocalDate;
  summary: { manpower: number; complete: number; incomplete: number; completePct: number | null; incompletePct: number | null };
  completeness: FieldCompleteness[];
  /** Every member counted, the ones with data missing first, then A to Z. */
  members: DemographicsMemberRow[];
  /** *n berhenti*: members who left from January to the month's end. */
  left: number;
  /** *Upload data* may be used: a steward, never view-as or a platform read. */
  canUpload: boolean;
}

/** What *Upload* answers: each row read, and what became of it. */
export interface DemographicsUploadResult {
  updated: number;
  unchanged: number;
  skipped: number;
  rows: {
    line: number;
    agentCode: string;
    name: string | null;
    status: 'updated' | 'unchanged' | 'not_found' | 'not_yours' | 'invalid';
    fields: DemographicField[];
    problems: { field: DemographicField; value: string }[];
  }[];
}

// ------------------------------------------------------------------------------------------------------ Event

export interface EventsView {
  /** `ytd` (January to today) or a month, `YYYY-MM`. */
  period: { kind: 'ytd' | 'month'; from: LocalDate; to: LocalDate };
  ab: AbOption | null;
  abs: AbOption[];
  /** `EVENT_NPS_FOR_PERIOD`. */
  kpm: { nps: number | null; average: number | null; n: number };
  events: { eventId: string; title: string; startsOn: LocalDate; nps: number | null; average: number | null; n: number }[];
}

// ------------------------------------------------------------------------------------------------------ MAPA

/** A change as the table draws it: ▲/▼ in % of the earlier figure, or in points for a percentage row. */
export interface MapaChange { value: number | null; kind: 'pct' | 'points' }

export interface MapaRowView {
  key: MapaRowKey;
  group: MapaGroup;
  unit: MapaUnit;
  ytdLastYear: number | null;
  ytd: number | null;
  ytdChange: MapaChange;
  sameMonthLastYear: number | null;
  lastMonth: number | null;
  thisMonth: number | null;
  changeVsSameMonth: MapaChange;
  changeVsLastMonth: MapaChange;
  /** *Target bulanan*, read-only: APE, Active Agent and Rekrut; `null` (*–*) for the rest, or with none set. */
  target: number | null;
}

/** One tile of *Bulan ini vs target*. */
export interface MapaHeadline { value: number | null; target: number | null; pct: number | null; tone: ProgressTone | null }

export interface MapaView {
  /** The month shown, `YYYY-MM`. */
  month: string;
  /** The office's month: the picker's latest. */
  currentMonth: string;
  /** The picker's earliest: January of the year before the office's. */
  earliestMonth: string;
  /** *Diperbarui {day}*: the office's day its latest production file was uploaded, of the months read; `null` with none. */
  asOf: LocalDate | null;
  /** *data sampai {Bul}*: the latest month up to `month` the office's file holds; `null` with none. */
  dataThrough: string | null;
  headline: { ape: MapaHeadline; activeAgent: MapaHeadline; rekrut: MapaHeadline };
  rows: MapaRowView[];
}

// ------------------------------------------------------------------------------------------------------ Informal group

/** A driver against its target, and its colour. */
export interface DriverFigure { value: number | null; target: number | null; pct: number | null; tone: ProgressTone | null }

/** *Pemakaian AgencyBoost*: the downline's share and the leaders'. Coloured by the downline's — the leaders' with none. */
export interface UsageFigure { downlinePct: number | null; leaderPct: number | null; tone: ProgressTone | null }

export interface InformalDrivers {
  /** Monthly Active Agent, MTD, against the summed Active Agent target. */
  maa: DriverFigure;
  usage: UsageFigure;
  /** 1-on-1 per minggu, against 2 × the Active Agent target. */
  oneOnOne: DriverFigure;
  /** Rekrut YTD, against the summed Rekrut targets January to the month. */
  rekrut: DriverFigure;
}

export interface InformalAbGroupRow {
  ab: PersonRef & { agentCode: string | null; isGroupLeader: boolean; isCoreLeader: boolean };
  /** *n orang di grupnya*, the AB included. */
  people: number;
  leaders: number;
  drivers: InformalDrivers;
}

export interface InformalGroupCard {
  /** `null`: *Tanpa group*. */
  group: { groupId: string; name: string } | null;
  /** The Group Leaders, A to Z. */
  leaders: { membershipId: string; name: string; photoUrl: string | null }[];
  counts: { leaders: number; people: number; abGroups: number };
  drivers: InformalDrivers;
  abGroups: InformalAbGroupRow[];
}

export interface SubgroupView {
  month: string;
  currentMonth: string;
  earliestMonth: string;
  /** **Total KPM**: every active member, the ones under no AB included. */
  total: { groups: number; leaders: number; people: number; drivers: InformalDrivers };
  groups: InformalGroupCard[];
  /** Targets and groups may be changed: a steward of the KPM, never view-as or a platform read. */
  canWrite: boolean;
}

export const SHEET_DRIVERS = ['maa', 'usage', 'coaching', 'rekrut'] as const;
export type SheetDriver = (typeof SHEET_DRIVERS)[number];

export interface SheetPerson extends PersonRef { phone: string | null }

/** **The people behind one number of an AB group** — the sheet a pill opens (P19.22-T5 AC-4). */
export interface InformalSheetView {
  driver: SheetDriver;
  month: string;
  /** The AB: *WhatsApp {first name} · kirim daftar ini* goes to them. */
  ab: SheetPerson;
  drivers: InformalDrivers;
  /** MAA: active (APE, polis), then not yet, nearest first. */
  maa?: {
    active: { person: SheetPerson; apeMinor: number | null; policies: number | null }[];
    notYet: { person: SheetPerson; potensi: number; lastActiveMonth: string | null }[];
  };
  /** Pemakaian: not in the window first, then those who used it, power users ★ first. */
  usage?: {
    notUsed: { person: SheetPerson; lastLoggedOn: LocalDate | null; daysSince: number | null }[];
    used: { person: SheetPerson; powerUser: boolean; daysLogged: number; daysSince: number | null }[];
  };
  /** 1-on-1: never (red), more than 14 days (yellow), within 14 days (green). */
  coaching?: { person: SheetPerson; status: 'never' | 'lapsed' | 'recent'; daysSince: number | null }[];
  /** Rekrut: who joined this year and who recruited them; the recruit potential in Leads. */
  rekrut?: {
    joined: { person: SheetPerson; joinDate: LocalDate; recruiter: { membershipId: string; name: string } | null }[];
    potential: number;
  };
}

/**
 * **The KPM's *Advanced analytics* page** (P19.5-T3, P19.22; ADR-0215, ADR-0275; `functional/advanced-analytics.md`): the
 * shell, *Demografi*, *MAPA driver*, *Analisa kuantitatif*, *Informal group* and *Event*, each its own read. *NPS* and
 * *Analisa kualitatif* are the surveys' (`SurveyRunsService`, ADR-0216, ADR-0276).
 *
 * - **Who:** the KPM's stewards — the Super Admin inside it, the Owner, an Admin, a core leader (`requireOfficeSteward`,
 *   ADR-0268 §1; OD-377) — any other member `404`; and the Super Admin's platform read (`advancedAnalyticsForOffice`).
 * - **A section that is off** in the template answers `404 NOT_FOUND`; its data is kept.
 * - **Test accounts are never counted or listed** (ADR-0267 §1): every read of the members carries `NOT_A_TEST_ACCOUNT`.
 * - **Every figure through the function that already computes it** — the forum's scorecard for MAPA, `RECRUITS_JOINED`,
 *   `activeAgentsIn`, `usageOf`, `COACHING_STATUS`, the AB groups' targets — and every read through the tenant
 *   repositories (invariant §1).
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
    /*
     * Unread since P19.22 (ADR-0275 §3, §5): MAPA reads the forum's scorecard and *Informal group* `activeAgentsIn`.
     * Kept in the constructor's place, so every caller that builds the service by hand still does.
     */
    _monthRows: MonthlyAgentDataRepository,
    /** The official APE (ADR-0195): `ProductionReadings` answers the port, and the month's cells are its own. */
    @Inject(OfficialApe) private readonly production: ProductionReadings,
    _completeness: UploadCompleteness,
    private readonly scorecard: LeaderScorecardService,
    /** The typed MAPA targets of P19.5-T3, kept and no longer read: the targets are the AB groups' (ADR-0275 §3). */
    _targets: AnalyticsTargetRepository,
    private readonly quant: QuantRuns,
    private readonly surveyRuns: SurveyRunRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    /** P19.13-T3 (ADR-0253 §5), P19.22-T5: *Informal group*'s cards are the informal groups of AB groups. */
    private readonly officeGroups: OfficeGroups,
    /**
     * P19.17-T4 (ADR-0270 §4, §6): the AB groups' monthly targets. Optional for the specs that build this service for
     * other sections; the application always provides it, and without it no target is read.
     */
    @Optional() @Inject(AbGroupTargetsService) private readonly abGroupTargets: AbGroupTargetsService | null = null,
    /** P19.22-T5: the recruit potential and the *potensi* behind the MAA sheet. Optional, as above: without it, 0. */
    @Optional() @Inject(LeadReadings) private readonly leads: LeadReadings | null = null,
  ) {}

  // ------------------------------------------------------------------------------------------------- the shell

  /**
   * **`GET /kpm/advanced-analytics`** — the tabs **in the fixed order** *Demografi · MAPA driver · NPS · Kuantitatif ·
   * Kualitatif · Informal group · Event* (P19.22-T1 AC-1; ADR-0275 §1): the template's sections that are on — NPS and
   * *Kualitatif* also while a run of them is open — then *Event*.
   */
  async shell(ctx: RequestContext): Promise<ShellView> {
    reader(ctx);
    const published = await this.analytics.publishedFor(ctx);
    const office = await this.tenantDay.office(ctx);
    const open = await this.openSurveyKinds(ctx, office.today);
    const on = new Set(published.config.sections
      .filter((s) => s.enabled || (s.kode === 'NPS' && open.has('nps')) || (s.kode === 'QUAL' && open.has('qual')))
      .map((s) => s.kode));
    const sections: SectionRef[] = ANALYTICS_SECTION_KODES
      .filter((kode) => on.has(kode))
      .map((kode) => ({ kode, slug: ANALYTICS_SECTION_SLUGS[kode] }));
    sections.push({ kode: 'EVENTS', slug: ANALYTICS_SECTION_SLUGS.EVENTS });
    return {
      templateName: published.templateName,
      version: published.version,
      sections,
      canWrite: canWrite(ctx),
      canUpload: can(ctx, 'data_upload:upload_and_preview') && writable(ctx),
    };
  }

  // ------------------------------------------------------------------------------------------------- Demografi

  /**
   * **`GET …/demographics`** — *Demografi* (P19.22-T2 AC-1; ADR-0275 §2): the summary (*Total manpower*, *Data lengkap*,
   * *Perlu melengkapi*), *Komposisi anggota* — manpower at the month's end by each dimension, a missing field under
   * *Belum diisi* — *Kelengkapan data* per field, Leader vs Agent, and *Data anggota*. With `ab`, over that AB's group.
   */
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
      ctx,
      { status: { $in: ['active', 'removed'] }, ...NOT_A_TEST_ACCOUNT, ...(group ? { _id: { $in: [...group] } } : {}) },
      {
        projection: {
          userId: 1, orgLevelCode: 1, role: 1, status: 1, workStatus: 1, joinDate: 1, joinedAt: 1, removedAt: 1, leaderId: 1,
          agentCode: 1,
        },
      },
    );
    const userIds = [...new Set(rows.map((r) => r.userId).filter((id) => isValidObjectId(id)))];
    const facts = userIds.length === 0 ? [] : await this.users
      .find({ _id: { $in: userIds } }, { dateOfBirth: 1, gender: 1 }).lean().exec() as { _id: unknown; dateOfBirth?: string | null; gender?: Gender | null }[];
    const byUser = new Map(facts.map((u) => [String(u._id), u]));
    const members = rows.map((r) => {
      const user = byUser.get(r.userId);
      return {
        membershipId: String(r._id),
        role: r.role as string,
        leaderId: r.leaderId ?? null,
        agentCode: r.agentCode ?? null,
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
    const here = members.filter((m) => memberAt(m.counted, end));
    const yearStart = this.clock.startOfLocalDay(office.timezone, `${month.slice(0, 4)}-01-01`);
    const left = members.filter((m) => m.counted.status === 'removed' && m.counted.removedAt !== null
      && m.counted.removedAt >= yearStart && m.counted.removedAt < end).length;
    const ids = here.map((m) => m.membershipId);
    const leaderIds = [...new Set(here.map((m) => m.leaderId).filter((id): id is string => id !== null))];
    const people = await this.names.pictured(ctx, [...ids, ...leaderIds], ids, { phones: true });
    const list: DemographicsMemberRow[] = here.map((m) => {
      const person = people.get(m.membershipId);
      const age = m.dateOfBirth ? wholeYears(m.dateOfBirth, lastDay) : null;
      return {
        membershipId: m.membershipId,
        name: person?.name ?? '',
        photoUrl: person?.photoUrl ?? null,
        role: m.role,
        agentCode: m.agentCode,
        uplineName: m.leaderId ? people.get(m.leaderId)?.name ?? null : null,
        workStatus: m.workStatus,
        ageBand: age === null ? null : ageBandOf(age, config.thresholds.ageBandUpper),
        joinDate: m.joinDate,
        missing: missingFields(m),
        phone: person?.phone ?? null,
      };
    }).sort((a, b) => Number(b.missing.length > 0) - Number(a.missing.length > 0) || a.name.localeCompare(b.name));
    const summary = completenessSummary(here);
    return {
      month, ab, abs, ...figures,
      asOf: office.today,
      summary: { manpower: here.length, ...summary },
      completeness: fieldCompleteness(here),
      members: list,
      left,
      canUpload: writable(ctx) && !ctx.isPlatformRead,
    };
  }

  /**
   * **`GET …/demographics/file`** — *Unduh daftar (CSV)* (P19.22-T2 AC-1): every member counted today, A to Z, with what
   * is on file. Named `<kpmCode>-demografi-<YYYY-MM-DD>.csv`. Not for a platform read.
   */
  async demographicsFile(ctx: RequestContext): Promise<{ filename: string; file: string }> {
    requireOfficeSteward(ctx, 'Advanced analytics');
    await this.section(ctx, 'DEMOGRAPHICS');
    const office = await this.tenantDay.office(ctx);
    const rows = await this.memberships.find(
      ctx, { status: 'active', ...NOT_A_TEST_ACCOUNT },
      { projection: { userId: 1, role: 1, workStatus: 1, joinDate: 1, leaderId: 1, agentCode: 1 } },
    );
    const ids = rows.map((r) => String(r._id));
    const leaderIds = rows.map((r) => r.leaderId).filter((id): id is string => Boolean(id));
    const [people, dates, header] = await Promise.all([
      this.names.byMembershipId(ctx, [...ids, ...leaderIds]),
      this.birthDates(rows.map((r) => r.userId)),
      this.people.header(ctx),
    ]);
    const file: DemographicsFileRow[] = rows.map((r) => ({
      agentCode: r.agentCode ?? '',
      name: people.get(String(r._id)) ?? '',
      role: (r.role as string).toUpperCase(),
      upline: r.leaderId ? people.get(r.leaderId) ?? '' : '',
      workStatus: (r.workStatus ?? null) as WorkStatus | null,
      dateOfBirth: dates.get(String(r.userId)) ?? null,
      joinDate: r.joinDate ?? null,
    })).sort((a, b) => a.name.localeCompare(b.name));
    return { filename: `${header.code || 'kpm'}-demografi-${office.today}.csv`, file: demographicsFile(file) };
  }

  /**
   * **`POST …/demographics/upload`** — *Upload*: the filled list (P19.22-T2 AC-1; ADR-0275 §2; OD-413). Each row is the
   * member with its agent code in this KPM; **a filled cell writes its field, an empty one changes nothing**. *Status
   * kerja* and *Tanggal bergabung* on the membership, *Tanggal lahir* on the person's account (invariant §2) — each
   * checked as the profile checks it, against the office's today. A core leader changes only their own downline
   * (`canManageMember`, ADR-0268 §1); anybody else's row is `not_yours`. **Each member changed is audited**
   * (`member.personal_completed`, before and after). Answers what became of every row.
   */
  async uploadDemographics(ctx: RequestContext, input: { file: string }): Promise<DemographicsUploadResult> {
    requireOfficeSteward(ctx, 'Advanced analytics');
    // `ViewOnlySessionGuard` refuses a view-as session's POST before it gets here; the service refuses it as well.
    if (ctx.isImpersonating) {
      throw new DomainException(ErrorCode.IMPERSONATION_READ_ONLY, AUTH_GUARD_REFUSALS.IMPERSONATION_READ_ONLY.viewOnly, HttpStatus.FORBIDDEN);
    }
    await this.section(ctx, 'DEMOGRAPHICS');
    if (Buffer.byteLength(input.file, 'utf8') > DEMOGRAPHIC_DATA.FILE_MAX_BYTES) {
      throw new InvalidRequestException(SAY.VALIDATION_FAILED.fileTooLarge({ bytes: DEMOGRAPHIC_DATA.FILE_MAX_BYTES }), { field: 'file' });
    }
    const entries = readDemographicsFile(input.file);
    if (entries === null) throw new InvalidRequestException(SAY.VALIDATION_FAILED.fileNoCode, { field: 'file' });
    const office = await this.tenantDay.office(ctx);
    const codes = [...new Set(entries.map((e) => e.agentCode).filter(Boolean))];
    const rows = codes.length === 0 ? [] : await this.memberships.find(
      ctx, { status: 'active', agentCode: { $in: codes }, ...NOT_A_TEST_ACCOUNT },
      { projection: { userId: 1, workStatus: 1, joinDate: 1, agentCode: 1, ancestorIds: 1 } },
    );
    const byCode = new Map(rows.map((r) => [r.agentCode as string, r]));
    const dates = await this.birthDates(rows.map((r) => r.userId));
    const names = await this.names.byMembershipId(ctx, rows.map((r) => String(r._id)));
    const result: DemographicsUploadResult = { updated: 0, unchanged: 0, skipped: 0, rows: [] };
    const done = new Set<string>();
    for (const entry of entries) {
      const member = byCode.get(entry.agentCode);
      const base = { line: entry.line, agentCode: entry.agentCode, fields: [] as DemographicField[], problems: [] as { field: DemographicField; value: string }[] };
      if (!member || done.has(String(member._id))) {
        result.skipped += 1;
        result.rows.push({ ...base, name: null, status: 'not_found' });
        continue;
      }
      const id = String(member._id);
      done.add(id);
      const name = names.get(id) ?? null;
      if (!canManageMember(ctx, { membershipId: id, ancestorIds: member.ancestorIds })) {
        result.skipped += 1;
        result.rows.push({ ...base, name, status: 'not_yours' });
        continue;
      }
      const before: Partial<Record<DemographicField, string | null>> = {};
      const after: Partial<Record<DemographicField, string>> = {};
      if (entry.workStatus !== undefined) {
        const value = workStatusFromFile(entry.workStatus);
        if (value === null) base.problems.push({ field: 'workStatus', value: entry.workStatus });
        else if (value !== (member.workStatus ?? null)) { before.workStatus = member.workStatus ?? null; after.workStatus = value; }
      }
      if (entry.dateOfBirth !== undefined) {
        const value = dayFromFile(entry.dateOfBirth);
        const current = dates.get(String(member.userId)) ?? null;
        if (value === null || birthDateProblem(value, office.today) !== null) base.problems.push({ field: 'dateOfBirth', value: entry.dateOfBirth });
        else if (value !== current) { before.dateOfBirth = current; after.dateOfBirth = value; }
      }
      if (entry.joinDate !== undefined) {
        const value = dayFromFile(entry.joinDate);
        if (value === null || value > office.today) base.problems.push({ field: 'joinDate', value: entry.joinDate });
        else if (value !== (member.joinDate ?? null)) { before.joinDate = member.joinDate ?? null; after.joinDate = value; }
      }
      const fields = (Object.keys(after) as DemographicField[]);
      if (fields.length > 0) {
        const own: Record<string, string> = {};
        if (after.workStatus !== undefined) own.workStatus = after.workStatus;
        if (after.joinDate !== undefined) own.joinDate = after.joinDate;
        if (Object.keys(own).length > 0) await this.memberships.updateById(ctx, id, { $set: own });
        if (after.dateOfBirth !== undefined) {
          await this.users.updateOne({ _id: member.userId }, { $set: { dateOfBirth: after.dateOfBirth } }).exec();
        }
        await this.audit.record(ctx, {
          action: 'member.personal_completed', targetCollection: 'memberships', targetId: id, targetMembershipId: id,
          before: { ...before, via: 'advanced_analytics.demographics_upload' },
          after: { ...after, via: 'advanced_analytics.demographics_upload' },
        });
      }
      const status = base.problems.length > 0 && fields.length === 0 ? 'invalid' : fields.length > 0 ? 'updated' : 'unchanged';
      if (status === 'updated') result.updated += 1;
      else if (status === 'unchanged') result.unchanged += 1;
      else result.skipped += 1;
      result.rows.push({ ...base, name, status, fields });
    }
    return result;
  }

  // ------------------------------------------------------------------------------------------------- Event

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

  // ------------------------------------------------------------------------------------------------- Kuantitatif

  /**
   * **`GET …/quant`** — *Analisa kuantitatif* (P19.22-T4; ADR-0275 §4): a half-year's ten metrics against the peer
   * median and *Semester lalu*, and each metric's distribution per leader, the leaders named and pictured.
   */
  async quantView(ctx: RequestContext, query: { periodEnd?: string }): Promise<QuantView & {
    companyName: string;
    metrics: (QuantView['metrics'][number] & { distribution: { leaders: (QuantView['metrics'][number]['distribution']['leaders'][number] & { name: string; photoUrl: string | null })[] } })[];
  }> {
    reader(ctx);
    const config = await this.section(ctx, 'QUANT');
    const [view, header] = await Promise.all([this.quant.read(ctx, config.thresholds, query.periodEnd), this.people.header(ctx)]);
    const ids = [...new Set(view.metrics.flatMap((m) => m.distribution.leaders.map((l) => l.membershipId)))];
    const people = await this.names.pictured(ctx, ids);
    return {
      ...view,
      companyName: header.companyName,
      metrics: view.metrics.map((m) => ({
        ...m,
        distribution: {
          ...m.distribution,
          leaders: m.distribution.leaders.map((l) => ({
            ...l, name: people.get(l.membershipId)?.name ?? '', photoUrl: people.get(l.membershipId)?.photoUrl ?? null,
          })),
        },
      })),
    };
  }

  // ------------------------------------------------------------------------------------------------- MAPA

  /**
   * **`GET …/mapa`** — *MAPA driver* for a month (P19.22-T3; ADR-0275 §3): *Bulan ini vs target* for APE, Active Agent and
   * Rekrut, and the eight rows — each with *YTD tahun lalu · YTD tahun ini · perubahan* and *Bulan sama tahun lalu ·
   * Bulan lalu · Bulan ini* with their changes — then the read-only *Target bulanan*: Active Agent and Rekrut the sums of
   * the AB groups' targets, APE the members' Goal Setting ÷ 12 (ADR-0270 §4–§6).
   *
   * **Through the forum's scorecard** (`compute`, every row month by month), once per month of the year to `month`, so
   * nothing is computed a second way; *Rekrut* is `RECRUITS_JOINED` (the New Hires definition), not the upload's.
   */
  async mapa(ctx: RequestContext, query: { month?: string }): Promise<MapaView> {
    reader(ctx);
    await this.section(ctx, 'MAPA');
    const office = await this.tenantDay.office(ctx);
    const month = this.monthOf(query.month, office.month);
    const earliestMonth = `${Number(office.month.slice(0, 4)) - 1}-01`;
    if (month < earliestMonth) throw new InvalidRequestException(SAY.VALIDATION_FAILED.monthShape, { field: 'month' });
    const year = month.slice(0, 4);
    const lastYear = String(Number(year) - 1);
    const months = Array.from({ length: Number(month.slice(5, 7)) }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
    const dayOf = (m: string) => (m === office.month ? office.today : endOfMonth(`${m}-01`));

    const [cards, recruits, totals] = await Promise.all([
      Promise.all(months.map((m) => this.scorecard.compute(
        { kpmId: ctx.kpmId!, timezone: office.timezone, meetingDate: dayOf(m) }, { everyMonth: true },
      ))),
      recruitsJoined(this.memberships, ctx, { from: `${lastYear}-01-01`, to: dayOf(month) }),
      this.targetTotals(ctx, month),
    ]);
    const card = cards[cards.length - 1];
    const joinedIn = new Map<string, number>();
    for (const r of recruits) joinedIn.set(r.joinDate.slice(0, 7), (joinedIn.get(r.joinDate.slice(0, 7)) ?? 0) + 1);
    const recruitsOf = (m: string) => joinedIn.get(m) ?? 0;

    const SCORECARD: Record<Exclude<MapaRowKey, 'rekrut'>, RowKey> = {
      ape: 'ape', manpower: 'manpower', active_agent: 'avg_monthly_aa', new_agent_3m: 'new_agent_3m',
      policies: 'case_submission', policies_per_active_agent: 'cases_per_producing_agent', average_case_size: 'average_case_size',
    };
    const cellOf = (c: ComputedScorecard, row: RowKey, column: ColumnKey): number | null => {
      const cell = c.rows.find((r) => r.key === row)?.cells[column];
      return cell?.kind === 'figure' ? cell.value : null;
    };

    const rows: MapaRowView[] = MAPA_ROW_KEYS.map((key) => {
      const { group, unit, ytd: ytdKind } = MAPA_ROWS[key];
      let figures: { ytdLastYear: number | null; ytd: number | null; sameMonthLastYear: number | null; lastMonth: number | null; thisMonth: number | null };
      if (key === 'rekrut') {
        figures = {
          ytd: monthlyMean(months.map(recruitsOf)),
          ytdLastYear: monthlyMean(months.map((m) => recruitsOf(plusMonths(m, -12)))),
          thisMonth: recruitsOf(month),
          sameMonthLastYear: recruitsOf(plusMonths(month, -12)),
          lastMonth: recruitsOf(plusMonths(month, -1)),
        };
      } else {
        const row = SCORECARD[key];
        figures = {
          ytd: ytdKind === 'mean' ? monthlyMean(cards.map((c) => cellOf(c, row, 'thisMonth'))) : cellOf(card, row, 'ytd'),
          ytdLastYear: ytdKind === 'mean' ? monthlyMean(cards.map((c) => cellOf(c, row, 'thisMonthLastYear'))) : cellOf(card, row, 'ytdLastYear'),
          thisMonth: cellOf(card, row, 'thisMonth'),
          sameMonthLastYear: cellOf(card, row, 'thisMonthLastYear'),
          lastMonth: cellOf(card, row, 'lastMonth'),
        };
      }
      return {
        key, group, unit, ...figures,
        ytdChange: changeOf(unit, figures.ytd, figures.ytdLastYear),
        changeVsSameMonth: changeOf(unit, figures.thisMonth, figures.sameMonthLastYear),
        changeVsLastMonth: changeOf(unit, figures.thisMonth, figures.lastMonth),
        target: key === 'ape' ? totals.ape : key === 'active_agent' ? totals.activeAgent : key === 'rekrut' ? totals.rekrut : null,
      };
    });
    const headline = (key: MapaRowKey): MapaHeadline => {
      const row = rows.find((r) => r.key === key)!;
      const pct = progressPct(row.thisMonth, row.target);
      return { value: row.thisMonth, target: row.target, pct, tone: progressTone(pct) };
    };
    const held = months.filter((_, i) => cellOf(cards[i], 'ape', 'thisMonth') !== null);
    return {
      month,
      currentMonth: office.month,
      earliestMonth,
      asOf: card.asOf,
      dataThrough: held[held.length - 1] ?? null,
      headline: { ape: headline('ape'), activeAgent: headline('active_agent'), rekrut: headline('rekrut') },
      rows,
    };
  }

  // ------------------------------------------------------------------------------------------------- Informal group

  /**
   * **`GET …/subgroup`** — *Informal group* for a month (P19.22-T5 AC-1 to AC-3; ADR-0275 §5): the navy **Total KPM**, one
   * card per informal group A to Z then *Tanpa group*, each with its AB groups — every scope with the four drivers. Each
   * person is in their AB's AB group (ADR-0270 §1); the targets are the AB groups' own, summed (*"Sama dengan Overview ›
   * Performa vs target"*).
   */
  async subgroup(ctx: RequestContext, query: { month?: string } = {}): Promise<SubgroupView> {
    reader(ctx);
    await this.section(ctx, 'SUBGROUP');
    const office = await this.tenantDay.office(ctx);
    const month = this.monthOf(query.month, office.month);
    const partition = await this.officeGroups.partition(ctx);
    const everyone = [...partition.members.keys()];
    const read = await this.driverReads(ctx, partition, everyone, month, office);
    const abIds = [...partition.abGroups.keys()];
    const leaderIds = partition.groups.flatMap((g) => g.leaderIds);
    const people = await this.names.pictured(ctx, [...abIds, ...leaderIds], [...abIds, ...leaderIds]);

    const abRow = (ab: string, groupLeaders: ReadonlySet<string>): InformalAbGroupRow => {
      const ids = partition.abGroups.get(ab)!.memberIds;
      const m = partition.members.get(ab)!;
      return {
        ab: {
          ...personRef(ab, 'ab', people.get(ab)), agentCode: m.agentCode, isGroupLeader: groupLeaders.has(ab), isCoreLeader: m.isCoreLeader,
        },
        people: ids.length,
        leaders: ids.filter((id) => isLeaderRole(partition.members.get(id)?.role)).length,
        drivers: read.drivers(ids, [ab]),
      };
    };
    const cardOf = (group: InformalGroupCard['group'], abs: readonly string[], leaders: readonly string[]): InformalGroupCard => {
      const ids = this.officeGroups.peopleOf(partition, abs);
      const set = new Set(leaders);
      return {
        group,
        leaders: leaders.map((id) => ({ membershipId: id, name: people.get(id)?.name ?? '', photoUrl: people.get(id)?.photoUrl ?? null }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        counts: { leaders: ids.filter((id) => isLeaderRole(partition.members.get(id)?.role)).length, people: ids.length, abGroups: abs.length },
        drivers: read.drivers(ids, abs),
        abGroups: abs.map((ab) => abRow(ab, set)).sort((a, b) => a.ab.name.localeCompare(b.ab.name)),
      };
    };
    const groups = partition.groups.map((g) => cardOf({ groupId: g.groupId, name: g.name }, g.abIds, g.leaderIds));
    if (partition.ungroupedAbIds.length > 0) groups.push(cardOf(null, partition.ungroupedAbIds, []));
    return {
      month,
      currentMonth: office.month,
      earliestMonth: AB_GROUP_TARGETS.EARLIEST_MONTH,
      total: {
        groups: partition.groups.length,
        leaders: everyone.filter((id) => isLeaderRole(partition.members.get(id)?.role)).length,
        people: everyone.length,
        drivers: read.drivers(everyone, abIds),
      },
      groups,
      canWrite: canWrite(ctx) && can(ctx, 'ab_group_target:write'),
    };
  }

  /**
   * **`GET …/subgroup/people?ab=&driver=&month=`** — the sheet a pill of an AB group's row opens (P19.22-T5 AC-4): the
   * people behind the number. An AB this office does not hold as an AB group's head is `404`.
   */
  async subgroupPeople(ctx: RequestContext, query: { ab: string; driver: SheetDriver; month?: string }): Promise<InformalSheetView> {
    reader(ctx);
    await this.section(ctx, 'SUBGROUP');
    const office = await this.tenantDay.office(ctx);
    const month = this.monthOf(query.month, office.month);
    const partition = await this.officeGroups.partition(ctx);
    const group = partition.abGroups.get(query.ab);
    if (!group) throw new NotFoundException('Membership');
    const ids = group.memberIds;
    const read = await this.driverReads(ctx, partition, ids, month, office);
    const people = await this.names.pictured(ctx, ids, ids, { phones: true });
    const person = (id: string): SheetPerson => ({
      ...personRef(id, partition.members.get(id)?.role ?? 'agent', people.get(id)), phone: people.get(id)?.phone ?? null,
    });
    const view: InformalSheetView = { driver: query.driver, month, ab: person(query.ab), drivers: read.drivers(ids, [query.ab]) };
    const byName = (a: { person: SheetPerson }, b: { person: SheetPerson }) => a.person.name.localeCompare(b.person.name);

    if (query.driver === 'maa') {
      const active = read.maa.people.filter((p) => ids.includes(p.membershipId));
      const activeIds = new Set(active.map((p) => p.membershipId));
      const notYet = ids.filter((id) => !activeIds.has(id));
      const bounds = this.clock.monthBounds(office.timezone, month);
      const [history, potensi] = await Promise.all([
        this.production.monthCellsFor(ctx, notYet, { from: plusMonths(month, -23), to: plusMonths(month, -1) }),
        this.leads ? this.leads.potensiOfMany(ctx, notYet, { month, ...bounds }) : Promise.resolve(new Map()),
      ]);
      const lastActive = (id: string) => [...(history.get(id) ?? new Map()).entries()]
        .filter(([, c]) => monthlyActiveAgent(c.apeMonthly, c.policyCountMonthly) === true)
        .map(([m]) => m).sort().pop() ?? null;
      view.maa = {
        active: active.map((p) => ({ person: person(p.membershipId), apeMinor: p.apeMinor, policies: p.policies })),
        notYet: notYet.map((id) => ({ person: person(id), potensi: potensi.get(id)?.sales.potensi ?? 0, lastActiveMonth: lastActive(id) }))
          .sort((a, b) => b.potensi - a.potensi || (b.lastActiveMonth ?? '').localeCompare(a.lastActiveMonth ?? '') || byName(a, b)),
      };
    } else if (query.driver === 'usage') {
      const rows = ids.map((id) => ({ id, u: read.usage.get(id) }));
      view.usage = {
        notUsed: rows.filter((r) => r.u?.usedInPeriod !== true)
          .map((r) => ({ person: person(r.id), lastLoggedOn: r.u?.lastLoggedOn ?? null, daysSince: r.u?.daysSinceLastLogged ?? null }))
          .sort((a, b) => (a.daysSince === null ? -1 : 0) - (b.daysSince === null ? -1 : 0) || (b.daysSince ?? 0) - (a.daysSince ?? 0) || byName(a, b)),
        used: rows.filter((r) => r.u?.usedInPeriod === true)
          .map((r) => ({ person: person(r.id), powerUser: r.u!.powerUser, daysLogged: r.u!.daysLoggedLast30, daysSince: r.u!.daysSinceLastLogged }))
          .sort((a, b) => Number(b.powerUser) - Number(a.powerUser) || b.daysLogged - a.daysLogged || byName(a, b)),
      };
    } else if (query.driver === 'coaching') {
      const status = await this.coaching.statusOf(ctx, ids, { today: read.end, timezone: office.timezone });
      const rank = { never: 0, lapsed: 1, recent: 2 } as const;
      view.coaching = ids.map((id) => {
        const s = status.get(id);
        return { person: person(id), status: s?.status ?? 'never', daysSince: s?.daysSinceLastCoaching ?? null };
      }).sort((a, b) => rank[a.status] - rank[b.status] || (b.daysSince ?? 0) - (a.daysSince ?? 0) || byName(a, b));
    } else {
      const joined = read.recruits.filter((r) => r.registeredByMembershipId !== null && ids.includes(r.registeredByMembershipId));
      const named = await this.names.pictured(ctx, [...joined.map((r) => r.membershipId), ...joined.map((r) => r.registeredByMembershipId!)], joined.map((r) => r.membershipId));
      const bounds = this.clock.monthBounds(office.timezone, month);
      const potensi = this.leads ? await this.leads.potensiOfMany(ctx, ids, { month, ...bounds }) : new Map();
      view.rekrut = {
        joined: joined.map((r) => ({
          person: { ...personRef(r.membershipId, 'agent', named.get(r.membershipId)), phone: null },
          joinDate: r.joinDate,
          recruiter: { membershipId: r.registeredByMembershipId!, name: named.get(r.registeredByMembershipId!)?.name ?? '' },
        })).sort((a, b) => b.joinDate.localeCompare(a.joinDate)),
        potential: ids.reduce((sum, id) => sum + (potensi.get(id)?.recruitment.potensi ?? 0), 0),
      };
    }
    return view;
  }

  // ------------------------------------------------------------------------------- the Super Admin's read

  /**
   * **A section over a named KPM, read-only, for the Super Admin** (ADR-0207 §4; ADR-0215 §9; P19.5-T3 AC-12): the KPM's
   * own function, through a platform read's context — refused any other context (`OfficePeople.requirePlatformRead`).
   */
  async advancedAnalyticsForOffice(
    ctx: RequestContext, section: string, query: { month?: string; ab?: string; periodEnd?: string },
  ): Promise<unknown> {
    OfficePeople.requirePlatformRead(ctx);
    switch (section) {
      case 'shell': return this.shell(ctx);
      case 'demographics': return this.demographics(ctx, query);
      case 'mapa': return this.mapa(ctx, query);
      case 'quant': return this.quantView(ctx, query);
      case 'subgroup': return this.subgroup(ctx, query);
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
    const heads = await this.memberships.find(ctx, { status: 'active', role: 'ab', ...NOT_A_TEST_ACCOUNT }, { projection: { _id: 1 } });
    const ids = heads.map((h) => String(h._id));
    const names = await this.names.byMembershipId(ctx, ids);
    const abs = ids.map((id) => ({ membershipId: id, name: names.get(id) ?? '' })).sort((a, b) => a.name.localeCompare(b.name));
    if (ab === undefined) return { abs, group: null, ab: null };
    const chosen = abs.find((a) => a.membershipId === ab);
    if (!chosen) throw new NotFoundException('Membership');
    const below = await this.memberships.find(ctx, { ancestorIds: ab, ...NOT_A_TEST_ACCOUNT }, { projection: { _id: 1 } });
    return { abs, group: new Set([ab, ...below.map((m) => String(m._id))]), ab: chosen };
  }

  /** The survey kinds with a run open today: their tabs stay while it runs (ADR-0216 §2). */
  private async openSurveyKinds(ctx: RequestContext, today: LocalDate): Promise<Set<'nps' | 'qual'>> {
    const runs = await this.surveyRuns.list(ctx);
    return new Set(runs.filter((r) => runState(r, today) === 'open').map((r) => r.kind));
  }

  /** The accounts' birth dates, by user id — global (invariant §2), from ids a scoped read produced. */
  private async birthDates(userIds: readonly unknown[]): Promise<Map<string, string | null>> {
    const ids = [...new Set(userIds.map(String))].filter((id) => isValidObjectId(id));
    if (ids.length === 0) return new Map();
    const rows = await this.users.find({ _id: { $in: ids } }, { dateOfBirth: 1 }).lean().exec() as { _id: unknown; dateOfBirth?: string | null }[];
    return new Map(rows.map((u) => [String(u._id), u.dateOfBirth ?? null]));
  }

  /**
   * **The month's consolidated targets** (ADR-0270 §4–§6; `AbGroupTargetsService`): Active Agent and Rekrut the sums of
   * every AB group's — `null` while none has one — and APE the members' Goal Setting ÷ 12 — `null` at 0. None for a
   * platform read, which reads no steward's targets, or a month before the targets begin.
   */
  private async targetTotals(ctx: RequestContext, month: string): Promise<{ ape: number | null; activeAgent: number | null; rekrut: number | null }> {
    if (!this.abGroupTargets || ctx.isPlatformRead || month < AB_GROUP_TARGETS.EARLIEST_MONTH) return { ape: null, activeAgent: null, rekrut: null };
    const { total } = await this.abGroupTargets.read(ctx, month);
    const none = total.abGroups === 0 || total.unset === total.abGroups;
    return {
      ape: total.apeTargetMinor > 0 ? total.apeTargetMinor : null,
      activeAgent: none ? null : total.activeAgentTarget,
      rekrut: none ? null : total.rekrutTarget,
    };
  }

  /**
   * **What the four drivers read, once for the people given** (P19.22-T5; ADR-0275 §5): the month's Active Agents
   * (`activeAgentsIn`), each person's use over the 30 days ending on the month's last day — today in the office's month
   * — (`usageOf`), the 1-on-1s of those days (`countedSince`), the recruits joined January to then (`RECRUITS_JOINED`),
   * and the AB groups' targets for the month. `drivers(ids, abs)` then folds them over any scope.
   */
  private async driverReads(
    ctx: RequestContext, partition: InformalPartition, ids: readonly string[], month: string,
    office: { today: LocalDate; month: string; timezone: string },
  ) {
    const end: LocalDate = month === office.month ? office.today : endOfMonth(`${month}-01`);
    const from = addDays(end, -(INFORMAL_GROUP.WINDOW_DAYS - 1));
    const abIds = [...partition.abGroups.keys()];
    const [maa, usage, sessions, recruits, targets] = await Promise.all([
      activeAgentsIn(this.production, ctx, ids, month),
      this.activity.usageOf(ctx, ids, end, { from, to: end }),
      this.coaching.countedSince(ctx, ids, from),
      recruitsJoined(this.memberships, ctx, { from: `${month.slice(0, 4)}-01-01`, to: end }),
      this.abGroupTargets && month >= AB_GROUP_TARGETS.EARLIEST_MONTH
        ? this.abGroupTargets.forAbs(ctx, abIds, month)
        : Promise.resolve(new Map<string, { activeAgentTarget: number | null; rekrutYtdTarget: number; source: string }>()),
    ]);
    const active = new Set(maa.people.map((p) => p.membershipId));
    const counted = sessions.filter((s) => s.date <= end);
    const drivers = (scope: readonly string[], abs: readonly string[]): InformalDrivers => {
      const set = new Set(scope);
      const own = abs.map((ab) => targets.get(ab)).filter((t) => t !== undefined && t.source !== 'none');
      const aaTarget = own.length === 0 ? null : own.reduce((s, t) => s + (t!.activeAgentTarget ?? 0), 0);
      const rekrutTarget = own.length === 0 ? null : own.reduce((s, t) => s + t!.rekrutYtdTarget, 0);
      const figure = (value: number | null, target: number | null): DriverFigure => {
        const pct = progressPct(value, target);
        return { value, target, pct, tone: progressTone(pct) };
      };
      const leaders = scope.filter((id) => isLeaderRole(partition.members.get(id)?.role));
      const downline = scope.filter((id) => !isLeaderRole(partition.members.get(id)?.role));
      const used = (id: string) => usage.get(id)?.usedInPeriod === true;
      const downlinePct = usagePct(downline.map(used));
      const leaderPct = usagePct(leaders.map(used));
      return {
        maa: figure(maa.held ? scope.filter((id) => active.has(id)).length : null, aaTarget),
        usage: { downlinePct, leaderPct, tone: progressTone(downlinePct ?? leaderPct) },
        oneOnOne: figure(oneOnOnesPerWeek(counted.filter((s) => set.has(s.coacheeMembershipId)).length), oneOnOneTarget(aaTarget)),
        rekrut: figure(recruits.filter((r) => r.registeredByMembershipId !== null && set.has(r.registeredByMembershipId)).length, rekrutTarget),
      };
    };
    return { end, maa, usage, recruits, drivers };
  }
}

/** A person as a row draws them, from a pictured read. */
function personRef(membershipId: string, role: string, person: PicturedPerson | undefined): PersonRef {
  return { membershipId, name: person?.name ?? '', photoUrl: person?.photoUrl ?? null, role };
}

const isLeaderRole = (role: string | undefined) => role === 'ab' || role === 'aab';

/**
 * **Who reads the page** (ADR-0215 §2 as ADR-0268 §1 and ADR-0275 §1 amend it): a steward of the KPM — the Super Admin
 * inside it, the Owner, an Admin or a core leader (`requireOfficeSteward`; OD-377) — any other member `404 NOT_FOUND`,
 * somebody in no KPM `TENANT_NO_MEMBERSHIP`; and a platform read, which the route's own guard and `requirePlatformRead`
 * have let through.
 */
function reader(ctx: RequestContext): void {
  if (ctx.isPlatformRead) return;
  requireOfficeSteward(ctx, 'Advanced analytics');
}

/** A context that may write: never a view-as session, never a platform read. */
function writable(ctx: RequestContext): boolean {
  return !ctx.isImpersonating && !ctx.isPlatformRead;
}

/** The targets and groups: `advanced_analytics:write`, never in a view-as session or a platform read. */
function canWrite(ctx: RequestContext): boolean {
  return can(ctx, 'advanced_analytics:write') && writable(ctx);
}
