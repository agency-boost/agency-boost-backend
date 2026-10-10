import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { editableUntil, endOfMonth } from '@/common/time/local-day';
import {
  CASCADE_ACTIVITY_CODES, metricByKey, type CampaignReading, type CampaignWindow,
} from '@/domain/constants';
import {
  qualify, readingAgreesWithPeriod, requirementProgress,
  type QualificationStatus, type RequirementProgress, type RequirementReading,
} from '@/domain/metrics/campaign-qualification';
import { addMonths, resolveWindow, type ResolvedWindow } from '@/domain/metrics/campaign-window';
import { maaCountInUnit } from '@/domain/metrics/maa-count-in-unit';
import { memberAt, type CountedMembership } from '@/domain/metrics/office-headcount';
import { monthlyActiveAgent } from '@/domain/metrics/monthly-active-agent';
import { metric } from '@/domain/metrics/registry';
import { computeRatio } from '@/modules/activity/activity-ratios';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { RatioDefinitionRepository } from '@/modules/config/activity.repository';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { ProductionMonths } from '@/modules/production/production-months.service';
import { ProductionReadings, type CampaignMonthFigures, type OfficeMonth } from '@/modules/production/production-readings';
import { AuditService } from '@/modules/audit/audit.service';
import { TenantDay, type Office } from '@/modules/tenants/tenant-day.service';
import { CampaignChaseRepository } from './campaign-chase.repository';
import { CampaignStandingRepository } from './campaign-standing.repository';
import { CampaignRepository } from './campaign.repository';
import type { CampaignStanding } from './campaign-standing.schema';

/** A campaign as the evaluation reads it — the fields of `campaigns` it needs, and nothing of the screen's. */
export interface EvaluatedCampaignInput {
  code: string;
  version: number;
  window: CampaignWindow;
  startsAt: Date;
  endsAt: Date | null;
  appliesToOrgLevelCodes: readonly string[];
  requirements: readonly { metricKey: string; comparator: string; value: number }[];
  /** The windows already frozen (`campaigns.frozenWindows`), by key — a window with no chaser included. */
  frozenWindows: readonly string[];
}

/** One member's standing in one campaign, as of now — live, or as frozen. */
export interface MemberStanding {
  membershipId: string;
  chasing: boolean;
  eligible: boolean;
  status: QualificationStatus;
  final: boolean;
  rows: RequirementProgress[];
}

/** One campaign, evaluated for the members asked about. */
export interface CampaignEvaluated {
  code: string;
  window: ResolvedWindow;
  /** The window is final (OD-154): its last month has locked, or for activity alone its grace has passed. */
  final: boolean;
  members: Map<string, MemberStanding>;
}

/** The Agent rung, whose direct members are a leader's Direct Unit (the client PRD's scope, Phase 18). */
const AGENT_RUNG = 'AGENT';

/** What is read of each member: whose they are, and on which rung. */
interface Person { id: string; orgLevelCode: string | null }

/** What is read of a membership: its rung, and the dates the headcount rule reads. */
const PERSON_FIELDS = { _id: 1, orgLevelCode: 1, status: 1, joinedAt: 1, removedAt: 1 } as const;

function countedOf(m: { status: string; joinedAt?: Date | null; removedAt?: Date | null }): CountedMembership {
  return { status: m.status as CountedMembership['status'], joinedAt: m.joinedAt ?? null, removedAt: m.removedAt ?? null };
}

/**
 * **A campaign's requirements, read for many members at once** (P18.5-T8; D-evaluable, D-windows, OD-153, OD-154).
 *
 * **Through the owning modules' functions, never a second copy** (AC-3): the file's cells as the month table reads
 * them (`ProductionReadings.campaignFiguresFor`, `readCell`), which months the office holds
 * (`ProductionReadings.officeMonths`), a month's lock (`ProductionMonths.state`), the log's counts
 * (`ActivityReadings.countsOverMany`), the office's own ratio definitions computed by the ratio engine
 * (`computeRatio`), and *active* by its one definition (`monthlyActiveAgent`, `maaCountInUnit`). So an import, a
 * correction by the Owner, a leader's *Update production* and a revert each show on the next read, with no trigger.
 *
 * **Final, and frozen once** (OD-154, AC-5): a window is final when the last month it reads has locked (ADR-0050) —
 * or, for activity alone, when its last day's backdating grace has passed — and on the first read after that its
 * chasers' standings are written, in one insert (only a chaser's is stored, ADR-0143 §4; a member who did not chase
 * is `not_joined`); every later read answers from them, so a reopen and a correction afterwards change nothing. A
 * running standing is never stored; the freeze is audited once (`campaign_standing.finalised`).
 * `rolling_12m` is never final. A calendar year's standing is frozen in the January after it, once December locks.
 *
 * **A fixed number of queries, whatever the office's size** (AC-9): the office, the months held, one lock per
 * window's last month, the stored standings, the memberships, the chases, the file's cells, the ratio definitions,
 * and the log once per distinct window — none per member.
 */
@Injectable()
export class CampaignEvaluation {
  constructor(
    private readonly production: ProductionReadings,
    private readonly months: ProductionMonths,
    private readonly activity: ActivityReadings,
    private readonly ratios: RatioDefinitionRepository,
    private readonly memberships: MembershipRepository,
    private readonly chases: CampaignChaseRepository,
    private readonly standings: CampaignStandingRepository,
    private readonly campaigns: CampaignRepository,
    private readonly days: TenantDay,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /**
   * Every campaign, for every member asked about. A campaign whose window is final and not yet frozen has its
   * chasers' standings frozen here, first — unless this is a read-only support session, which is answered them and
   * writes nothing (`leader-meetings.service.ts`'s precedent).
   */
  async evaluate(
    ctx: RequestContext,
    campaigns: readonly EvaluatedCampaignInput[],
    memberIds: readonly string[],
    given?: Office,
  ): Promise<Map<string, CampaignEvaluated>> {
    const out = new Map<string, CampaignEvaluated>();
    if (campaigns.length === 0) return out;
    for (const campaign of campaigns) assertReadings(campaign);
    const office = given ?? await this.days.office(ctx);
    const thisMonth = office.month;
    const lastYear = String(Number(office.today.slice(0, 4)) - 1);

    // ---- Which months the office holds — far enough back for a stale file's twelve months: one aggregate.
    const heldFrom = [
      addMonths(thisMonth, -36), `${lastYear}-01`, ...campaigns.map((c) => monthOf(c.startsAt, office.timezone)),
    ].sort()[0];
    const heldTo = [thisMonth, ...campaigns.map((c) => (c.endsAt ? monthOf(c.endsAt, office.timezone) : thisMonth))]
      .sort().slice(-1)[0];
    const held = await this.production.officeMonths(ctx, { from: heldFrom, to: heldTo });
    const heldMonths = [...held].filter(([, m]) => m.held).map(([m]) => m).filter((m) => m <= thisMonth).sort();
    const latestHeldMonth = heldMonths.length > 0 ? heldMonths[heldMonths.length - 1] : null;
    const where = { today: office.today, timezone: office.timezone, latestHeldMonth };

    // ---- The windows: each campaign's current one, and a calendar year's last one, to freeze once December locks.
    interface Job { campaign: EvaluatedCampaignInput; window: ResolvedWindow; final: boolean; current: boolean; end: Date }
    const jobs: Job[] = [];
    const job = (campaign: EvaluatedCampaignInput, window: ResolvedWindow, current: boolean): Job => ({
      campaign, window, current, final: false,
      // The window's last instant (exclusive): what a chase must have stood at to count once final (ADR-0143 §2).
      end: this.clock.endOfLocalDay(office.timezone, window.lastDay),
    });
    for (const campaign of campaigns) {
      jobs.push(job(campaign, resolveWindow(campaign, where), true));
      if (campaign.window === 'calendar_year' && monthOf(campaign.startsAt, office.timezone) <= `${lastYear}-12`) {
        jobs.push(job(campaign, resolveWindow(campaign, where, lastYear), false));
      }
    }
    const locks = new Map<string, Promise<boolean>>();
    const locked = (month: string) => {
      if (!locks.has(month)) locks.set(month, this.months.state(ctx, month).then((s) => s.locked));
      return locks.get(month) as Promise<boolean>;
    };
    for (const j of jobs) j.final = await this.isFinal(j.campaign, j.window, office, locked);
    const keyOf = (j: Job) => `${j.campaign.code}|${j.window.key}`;

    // ---- What is frozen already — the campaign records each window it froze, even one with no chaser — one read.
    const finalJobs = jobs.filter((j) => j.final);
    const frozenJobs = finalJobs.filter((j) => j.campaign.frozenWindows.includes(j.window.key));
    const toFreeze = finalJobs.filter((j) => !j.campaign.frozenWindows.includes(j.window.key));
    const stored = frozenJobs.length === 0 ? [] : await this.standings.find(ctx, {
      $or: frozenJobs.map((j) => ({ campaignCode: j.campaign.code, windowKey: j.window.key })),
    });
    const storedBy = new Map<string, Map<string, CampaignStanding>>(frozenJobs.map((j) => [keyOf(j), new Map()]));
    for (const row of stored) storedBy.get(`${row.campaignCode}|${row.windowKey}`)?.set(row.membershipId, row);

    // ---- The chases: the members asked about, and — for a window being frozen — every chase of it, on or off.
    const asked = [...new Set(memberIds)];
    const codes = [...new Set(campaigns.map((c) => c.code))];
    const freezeCodes = [...new Set(toFreeze.map((j) => j.campaign.code))];
    const chaseRows = await this.chases.find(ctx, {
      campaignCode: { $in: codes },
      $or: [{ membershipId: { $in: asked } }, { campaignCode: { $in: freezeCodes } }],
    });
    const chaseOf = new Map(chaseRows.map((c) => [`${c.campaignCode}|${c.membershipId}`, c]));
    /**
     * **Chasing, for a window** (ADR-0143 §2): while it is not final, the chase as it stands now; once final, the chase
     * as it stood at the window's last instant — made by then, and still on or dropped after it. A chase made after the
     * end never enters it; one dropped or closed by a departure after the end still counts.
     */
    const chasingIn = (j: Job, membershipId: string): boolean => {
      const row = chaseOf.get(`${j.campaign.code}|${membershipId}`);
      if (!row) return false;
      if (!j.final) return row.chasing;
      const madeBy = row.chasedAt === null || row.chasedAt.getTime() < j.end.getTime();
      return madeBy && (row.chasing || (row.unchasedAt !== null && row.unchasedAt.getTime() >= j.end.getTime()));
    };
    const chasersAtEnd = (j: Job) => [...new Set(chaseRows
      .filter((c) => c.campaignCode === j.campaign.code && chasingIn(j, c.membershipId)).map((c) => c.membershipId))];

    // ---- Who is computed: the members asked about and the chasers being frozen, with their rungs and their dates.
    const everyone = [...new Set([...asked, ...toFreeze.flatMap(chasersAtEnd)])];
    const rows = everyone.length === 0 ? [] : await this.memberships.find(
      ctx, { _id: { $in: everyone } }, { projection: PERSON_FIELDS },
    );
    const people = new Map<string, Person>(everyone.map((id) => [id, { id, orgLevelCode: null }]));
    const dated = new Map<string, CountedMembership>();
    for (const m of rows) {
      people.set(String(m._id), { id: String(m._id), orgLevelCode: m.orgLevelCode });
      dated.set(String(m._id), countedOf(m));
    }
    const computed = [...people.keys()];

    // A Direct Unit for every member computed, when a requirement reads one: their reports on the Agent rung, leavers
    // included — who was a member at the month's end is `memberAt`'s, Phase 18's one headcount rule (OD-24, ADR-0136).
    const readsUnit = campaigns.some((c) => c.requirements.some((r) => readingOf(r.metricKey)?.subject === 'unit'));
    const unitRows = readsUnit && computed.length > 0 ? await this.memberships.find(
      ctx, { leaderId: { $in: computed }, orgLevelCode: AGENT_RUNG, status: { $in: ['active', 'removed'] } },
      { projection: { ...PERSON_FIELDS, leaderId: 1 } },
    ) : [];
    const unitOf = new Map<string, string[]>();
    for (const row of unitRows) {
      const leader = String(row.leaderId);
      unitOf.set(leader, [...(unitOf.get(leader) ?? []), String(row._id)]);
      dated.set(String(row._id), countedOf(row));
    }
    const memberAtEndOf = (id: string, month: string) => {
      const m = dated.get(id);
      return m !== undefined && memberAt(m, this.clock.endOfLocalDay(office.timezone, endOfMonth(`${month}-01`)));
    };

    // ---- The file, once: every member computed and their units, over the months the resolved windows read.
    const fileJobs = jobs.filter((j) => j.campaign.requirements.some((r) => readingOf(r.metricKey)?.source === 'file'));
    const fileMonths = fileJobs.flatMap((j) => j.window.months).sort();
    const fileIds = [...new Set([...computed, ...[...unitOf.values()].flat()])];
    const figures = fileMonths.length > 0
      ? await this.production.campaignFiguresFor(ctx, fileIds, { from: fileMonths[0], to: fileMonths[fileMonths.length - 1] })
      : new Map<string, Map<string, CampaignMonthFigures>>();

    // ---- The log, once per distinct window of days; the office's ratios, once.
    const counts = new Map<string, Map<string, Map<string, number>>>();
    for (const j of jobs) {
      const days = j.window.days;
      if (days === null || !j.campaign.requirements.some((r) => readingOf(r.metricKey)?.source === 'activity')) continue;
      const key = `${days.from}..${days.to}`;
      if (!counts.has(key)) counts.set(key, await this.activity.countsOverMany(ctx, computed, days));
    }
    const readsRatio = campaigns.some((c) => c.requirements.some((r) => readingOf(r.metricKey)?.aggregate === 'ratio'));
    const ratioRows = readsRatio ? await this.ratios.find(ctx, { status: 'active' }) : [];
    const ratioOf = new Map(ratioRows.map((r) => [r.code, r]));

    // ---- Each job, each member.
    const read = (j: Job, membershipId: string, key: string): RequirementReading | undefined => {
      const how = readingOf(key);
      if (!how) return undefined;
      const open = !j.final;
      const base = { missing: false, open, source: how.source, aggregate: how.aggregate };
      if (how.source === 'activity') {
        const days = j.window.days;
        if (days === null) return { ...base, current: null };
        const sums = counts.get(`${days.from}..${days.to}`)?.get(membershipId) ?? new Map<string, number>();
        if (how.aggregate === 'ratio') {
          const definition = ratioOf.get(key);
          return { ...base, current: definition ? computeRatio(definition, sums).value : null };
        }
        return { ...base, current: Object.values(CASCADE_ACTIVITY_CODES).reduce((sum, code) => sum + (sums.get(code) ?? 0), 0) };
      }
      return {
        ...fileReading(key, how, j.campaign.window, j.window.months, membershipId, {
          held, thisMonth, figures, open,
          unitAt: (month) => [membershipId, ...(unitOf.get(membershipId) ?? [])].filter((id) => memberAtEndOf(id, month)),
        }),
        source: 'file', aggregate: how.aggregate,
      };
    };
    const standingOf = (j: Job, person: Person): MemberStanding => {
      const reqRows = j.campaign.requirements.map((r) =>
        requirementProgress(r, read(j, person.id, r.metricKey), readingOf(r.metricKey) !== undefined));
      const isChasing = chasingIn(j, person.id);
      const eligible = isEligible(j.campaign.appliesToOrgLevelCodes, person.orgLevelCode);
      const q = qualify(reqRows, { chasing: isChasing, eligible, final: j.final });
      return { membershipId: person.id, chasing: isChasing, eligible, status: q.status, final: j.final, rows: q.rows };
    };

    // ---- Freeze what became final: its chasers' standings at the window's end, in one insert (ADR-0143 §4, OD-154).
    const now = this.clock.now();
    for (const j of toFreeze) {
      const frozen = chasersAtEnd(j).map((id) => standingOf(j, people.get(id) as Person));
      storedBy.set(keyOf(j), new Map(frozen.map((s) => [s.membershipId, frozenRow(s)])));
      // A read-only support session is answered the frozen view and writes nothing.
      if (ctx.impersonationReadOnly) continue;
      // The window is marked frozen first, atomically: of two first reads at once, one writes and audits, once.
      if (!(await this.campaigns.markFrozen(ctx, j.campaign.code, j.window.key, now))) continue;
      await this.standings.insertFinal(ctx, frozen.map((s) => ({
        campaignCode: j.campaign.code,
        campaignVersion: j.campaign.version,
        windowKey: j.window.key,
        membershipId: s.membershipId,
        status: s.status as 'qualified' | 'not_met' | 'unknown',
        chasing: s.chasing,
        eligible: s.eligible,
        requirements: s.rows.map((r) => ({
          metricKey: r.metricKey, comparator: r.comparator, target: r.target, current: r.current, met: r.met,
        })),
        finalisedAt: now,
      })), now);
      await this.audit.record(ctx, {
        action: 'campaign_standing.finalised',
        targetCollection: 'campaignStandings',
        targetId: keyOf(j),
        before: null,
        after: { campaignCode: j.campaign.code, windowKey: j.window.key, standings: frozen.length },
      });
    }

    for (const j of jobs.filter((x) => x.current)) {
      const frozen = j.final ? storedBy.get(keyOf(j)) : undefined;
      const members = new Map<string, MemberStanding>();
      for (const id of asked) {
        const row = frozen?.get(id);
        members.set(id, row ? fromFrozen(row) : standingOf(j, people.get(id) as Person));
      }
      out.set(j.campaign.code, { code: j.campaign.code, window: j.window, final: j.final, members });
    }
    return out;
  }

  /**
   * **Final** (OD-154): the window has ended, and the last month it reads from the file has locked — on schedule or
   * by hand (ADR-0050) — and, where it counts activity, its last day is past the backdating grace. A reopened month
   * is not locked, so a window is not final while somebody is correcting it.
   */
  private async isFinal(
    campaign: EvaluatedCampaignInput, window: ResolvedWindow, office: Office, locked: (month: string) => Promise<boolean>,
  ): Promise<boolean> {
    if (!window.finalisable || window.lastDay >= office.today) return false;
    const sources = new Set(campaign.requirements.map((r) => readingOf(r.metricKey)?.source));
    if (sources.has('activity')
      && office.today <= editableUntil(window.lastDay, office.settings.activityBackdateGraceDays)) {
      return false;
    }
    if (sources.has('file') && !(await locked(window.months[window.months.length - 1]))) return false;
    return true;
  }
}

/** A requirement's reading, or none outside the evaluable set (D-evaluable). */
function readingOf(metricKey: string): CampaignReading | undefined {
  return metricByKey(metricKey)?.campaign;
}

/**
 * **The evaluator is the first reader of a metric's period** (D-period, AC-7): every evaluable requirement's reading
 * must agree with its registered period, or the campaign is refused here rather than read the wrong way.
 */
function assertReadings(campaign: EvaluatedCampaignInput): void {
  for (const r of campaign.requirements) {
    const how = readingOf(r.metricKey);
    if (how && !readingAgreesWithPeriod(how, metric(r.metricKey).period)) {
      throw new Error(`${r.metricKey} is read as ${how.aggregate} of ${how.source}, which its period ${metric(r.metricKey).period} does not allow.`);
    }
  }
}

/** The campaign's fields the evaluation reads, from its stored row. */
export function evaluationInput(row: {
  code: string; version: number; window: CampaignWindow; startsAt: Date; endsAt: Date | null;
  appliesToOrgLevelCodes: readonly string[]; requirements: readonly { metricKey: string; comparator: string; value: number }[];
  frozenWindows: readonly { key: string }[];
}): EvaluatedCampaignInput {
  return {
    code: row.code,
    version: row.version,
    window: row.window,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    appliesToOrgLevelCodes: [...row.appliesToOrgLevelCodes],
    requirements: row.requirements.map((r) => ({ metricKey: r.metricKey, comparator: r.comparator, value: r.value })),
    frozenWindows: row.frozenWindows.map((w) => w.key),
  };
}

/** Empty means everybody (ADR-0035's shape); a member whose rung is unknown is nobody's. */
export function isEligible(appliesTo: readonly string[], orgLevelCode: string | null): boolean {
  if (appliesTo.length === 0) return true;
  return orgLevelCode !== null && appliesTo.includes(orgLevelCode);
}

function monthOf(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' })
    .format(instant).slice(0, 7);
}

/** The cells a file metric sums or takes the latest of, by key. */
const FILE_CELLS: Readonly<Record<string, { monthly: keyof CampaignMonthFigures; ytd?: keyof CampaignMonthFigures }>> = {
  APE_ACHIEVED: { monthly: 'apeMonthly', ytd: 'apeYtd' },
  NEW_ACTIVE_AGENTS: { monthly: 'newActiveAgentsMonthly', ytd: 'newActiveAgentsYtd' },
  NEW_HIRES: { monthly: 'recruitmentMonthly', ytd: 'recruitmentYtd' },
  ROLLING_PERSISTENCY: { monthly: 'persistencyMonthly' },
};

/**
 * **A file metric over the window's months**, as the month table holds them. A month the office holds is the
 * member's figure in it — no row of theirs is nothing produced, `0` (*not uploaded* is a month the file does not
 * hold, never a member's figure inside one it does: the Phase 18 exit review, item 2). A month that has ended and is
 * not held is `missing`, so a short figure reads *Not uploaded yet*, never ✕.
 *
 * - `sum` over the campaign's months is the months' own figures added — the month table's for the same months; over
 *   a calendar year it is the file's own year to date, the latest one held — the Summary's figure (exit test 1).
 * - `latest` is the latest month held in the window: a member's persistency, or their Direct Unit's active agents
 *   by `MONTHLY_ACTIVE_AGENT`'s one definition.
 */
function fileReading(
  key: string, how: CampaignReading, window: CampaignWindow, months: readonly string[], membershipId: string,
  data: {
    held: ReadonlyMap<string, OfficeMonth>;
    thisMonth: string;
    figures: ReadonlyMap<string, ReadonlyMap<string, CampaignMonthFigures>>;
    /** The member and their Direct Unit who were members at the month's end (`memberAt`). */
    unitAt: (month: string) => readonly string[];
    open: boolean;
  },
): RequirementReading {
  const heldIn = months.filter((m) => data.held.get(m)?.held === true && m <= data.thisMonth);
  const missing = months.some((m) => m < data.thisMonth && data.held.get(m)?.held !== true);
  // Every member computed is fetched (`fileIds`), so every one has a map, empty when the file holds nothing of theirs.
  const mine = data.figures.get(membershipId)!;
  if (heldIn.length === 0) return { current: null, missing, open: data.open };
  const latest = heldIn[heldIn.length - 1];

  if (key === 'MAA_COUNT_IN_UNIT') {
    const flags = data.unitAt(latest).map((id) => {
      const cells = data.figures.get(id)?.get(latest);
      return monthlyActiveAgent(cells?.apeMonthly ?? null, cells?.policyCountMonthly ?? null);
    });
    return { current: maaCountInUnit(flags, true), missing, open: data.open };
  }
  const cells = FILE_CELLS[key];
  if (how.aggregate === 'latest') {
    return { current: mine.get(latest)?.[cells.monthly] ?? null, missing, open: data.open };
  }
  if (window === 'calendar_year' && cells.ytd) {
    const withYtd = [...heldIn].reverse().find((m) => mine.get(m)?.[cells.ytd!] != null);
    return { current: withYtd ? (mine.get(withYtd)![cells.ytd] as number) : 0, missing, open: data.open };
  }
  const sum = heldIn.reduce((total, m) => total + (mine.get(m)?.[cells.monthly] ?? 0), 0);
  return { current: sum, missing, open: data.open };
}

/** A frozen row, as the answer reads it. */
function frozenRow(s: MemberStanding): CampaignStanding {
  return {
    membershipId: s.membershipId, status: s.status as CampaignStanding['status'], chasing: s.chasing, eligible: s.eligible,
    requirements: s.rows.map((r) => ({ metricKey: r.metricKey, comparator: r.comparator, target: r.target, current: r.current, met: r.met })),
  } as CampaignStanding;
}

/** A standing read back as frozen: each row's state from its verdict, a requirement outside the set as it was. */
function fromFrozen(row: CampaignStanding): MemberStanding {
  return {
    membershipId: row.membershipId,
    chasing: row.chasing,
    eligible: row.eligible,
    status: row.status,
    final: true,
    rows: row.requirements.map((r): RequirementProgress => ({
      metricKey: r.metricKey,
      comparator: r.comparator,
      target: r.target,
      current: r.current ?? null,
      met: r.met ?? null,
      canFall: false,
      state: readingOf(r.metricKey) === undefined ? 'not_measured'
        : r.met === true ? 'met'
          : readingOf(r.metricKey)!.source === 'activity' && r.current === null ? 'nothing_logged'
            : r.met === false ? 'not_met' : 'not_uploaded',
    })),
  };
}

