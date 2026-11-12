import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, NoMembershipException, NotFoundException, PermissionDeniedException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Sentence } from '@/common/i18n/sentence';
import { localDayOf, rollingWindow, type LocalDate } from '@/common/time/local-day';
import {
  MDRT_CAMPAIGN_CODE, PERIOD, UNIT_DASHBOARD, type UnitDashboardPeriod, type UnitView,
} from '@/domain/constants';
import { UNIT_DASHBOARD_MESSAGES } from '@/domain/constants/unit-dashboard.messages';
import { oneOnOneOverdue } from '@/domain/metrics/coaching-recency';
import { newHireBeforeFirstSale, type ProductionStanding } from '@/domain/metrics/counts-for-production';
import type { GoalPaceStatus } from '@/domain/metrics/goal-pace-status';
import { subPeriodActivityTarget } from '@/domain/metrics/sub-period-activity-target';
import {
  activeAgentSplit, cascadeActivityTouches, rollUpCounts, rollUpLeadCounts, rollUpProduction,
  type CountAgainst, type LeadCountsRow, type PairedGoal,
} from '@/domain/metrics/unit-rollup';
import {
  absNotInInformalGroup, directGroup, informalGroup, placeView, viewChosen, viewsOffered,
  type ViewMember, type ViewPlacement, type ViewReader, type ViewsOffered,
} from '@/domain/metrics/unit-view';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { CampaignChaseReadings, type ChaseReading } from '@/modules/campaigns/campaign-chase-readings';
import { CoachingReadings } from '@/modules/coaching/coaching-readings';
import type { FollowUp } from '@/modules/coaching/follow-up';
import { knowsTheLeads, leadsReached } from '@/modules/coaching/lead-visibility';
import { PaceStatusReadings } from '@/modules/coaching/pace-status';
import { GoalService } from '@/modules/goals/goal.service';
import { LeadReadings } from '@/modules/leads/lead-readings';
import { ProposalReadings } from '@/modules/proposals/proposal-readings';
import { CoachResolver, type Coachee } from '@/modules/org/coach-resolver';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { GroupRepository } from '@/modules/org/org.repositories';
import type { Provenance } from '@/modules/production/monthly-agent-data.schema';
import { DataUploadBatchRepository } from '@/modules/production/data-upload-batch.repository';
import { ProductionCorrections } from '@/modules/production/production-correction.service';
import { type MonthState, ProductionMonths } from '@/modules/production/production-months.service';
import { OfficialApe } from '@/modules/production/official-ape';
import type { MonthLedger, ReadCell } from '@/modules/production/production-readings';
import { can, scopeFor, type Scope } from '@/modules/rbac/permissions';
import { activityTargets, officialGoalFigures, type FigureSource } from '@/modules/summary/summary-figures';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { defaultBinding } from '@/modules/config/activity-binding';
import { ActivityBindingService } from '@/modules/config/activity-binding.service';
import { TenantDay, type Office } from '@/modules/tenants/tenant-day.service';
import { UNIT_DASHBOARD_REFUSALS } from './unit-dashboard.messages';
import { closingsIn, rosterScopes } from './unit-figures';

/** A member, by the membership that identifies them (invariant §2). */
export interface UnitPerson {
  membershipId: string;
  name: string;
}

/** One cell of the office's month table, this office month (P15-T3). `null` is *Not uploaded yet*, never 0. */
export interface ProductionCell {
  valueMinor: number | null;
  provenance: Provenance | null;
  /** Who corrected it, for a correction; `null` otherwise, or when their membership can no longer be named. */
  correctedBy: UnitPerson | null;
  correctedAt: string | null;
}

/** The Summary's figures for the period — the month's under *Last 7 days* (D-period). */
export interface GoalCell {
  /** A goal saved for the year; without one the row reads *No goal set* (ADR-0080). */
  set: boolean;
  period: 'month' | 'year';
  targetMinor: number | null;
  actualMinor: number | null;
  attainmentPct: number | null;
  gapMinor: number | null;
  overMinor: number | null;
  policiesNeeded: number | null;
  caseSizeMinor: number;
  targetMet: boolean;
  /** The Summary's `FigureSource` — who corrected it and when included; `null` until the month's file arrives. */
  source: FigureSource | null;
}

/** `DAYS_SINCE_LAST_COACHING`, as the coaching roster serves it. */
export interface UnitLastOneOnOne {
  days: number;
  date: LocalDate;
  overdue: boolean;
  coach: UnitPerson | null;
}

/** One person on the roster: the reader, the unit's head, or somebody below them. */
export interface UnitRow extends UnitPerson {
  /** Their profile photo as a signed link (UI V1, UI-111); `null` for none: the row draws initials. */
  photoUrl: string | null;
  /**
   * ***WhatsApp*** (P19.9-T4 AC-1; ADR-0235, OD-291): the number on their account, for the roster's WhatsApp button at
   * every period and size. `null` without one — the button then offers *Isi nomor WhatsApp* to a reader who may save one
   * (`member:update_phone`) — and always on the reader's own row, for an inactive membership, and in the office's
   * read-only view of another leader's unit, which draws no button.
   */
  phone: string | null;
  /** The reader's own row: *You ({first name})*, no *Last 1:1*, and it drills to the reader's own screens. */
  isReader: boolean;
  /**
   * The reader, or somebody they coach (`CoachResolver.coacheesOf(reader)`) whose coaching tabs their grants
   * open (`personal_summary:read` wider than `own`): the row may drill into coaching's pages. `false` for an
   * Owner or an Admin reading a unit outside their own downline, where coaching would answer *not found*. An
   * Agent-rung leader's coachees are `true` since P19.9-T6 (ADR-0234): every upline coaches.
   */
  coached: boolean;
  rung: { code: string; label: string };
  /** Edges from the unit's head: the head is 0. */
  depth: number;
  /** Leads somebody: a unit head, whose own row is tagged *Personal*. */
  leads: boolean;
  goal: GoalCell;
  production: { monthly: ProductionCell; ytd: ProductionCell };
  leadsCounts: LeadCountsRow;
  /**
   * ***Closing*** (UI V1, UI-028; O-4): their sales leads that reached *Paid and issued* within the period's `window` —
   * the roster's *Closing* column, beside *Leads penjualan*, *Leads rekrut* and *Potensi rekrut* (`leadsCounts`).
   */
  closings: number;
  /**
   * ***Proposal*** (P19.7-T2 AC-13; ADR-0221 §7): `PROPOSALS_MADE` — their live proposals first saved as a PDF within the
   * period's `window`. A count, and nothing about any client, product or premium (decision 4).
   */
  proposalsMade: number;
  activity: { leads: CountAgainst; appointments: CountAgainst; closings: CountAgainst; touches: CountAgainst };
  /** Coaching's; `null` on the reader's own row, and before a first finalized session (*No 1:1 yet*). */
  lastOneOnOne: UnitLastOneOnOne | null;
  status: GoalPaceStatus;
  /** `PACING_TO_MAA`; `null` without a target. */
  pacingToMaa: boolean | null;
  /**
   * ***New hire*** (ADR-0172 §2–3, P18.8-T5 AC-3): a new hire with no first sale by the office's today —
   * `!COUNTS_FOR_PRODUCTION`. The row is in the team and tagged; every total above it leaves it out of the production
   * and of *On pace to be active*. `false` from the first sale's day.
   */
  newHireBeforeFirstSale: boolean;
  /** The next open action item of their latest finalized session (OD-140). */
  followUp: FollowUp | null;
  /**
   * ***Chasing MDRT*** (P18.2-T7 AC-7, ADR-0122): chasing the office's `MDRT_QUALIFICATION`, not ended. `null` for a
   * row beyond the reader's `campaign_qualification:read`, drawn as — (an Agent-rung leader's coachees were, until
   * P19.9-T6 gave the Agent `own-downline` there; ADR-0234).
   */
  chasingMdrt: boolean | null;
  /** ***Campaigns they're chasing*** (AC-8): their chases of campaigns not ended, by title; `null` as above. */
  campaigns: { code: string; title: string }[] | null;
}

/**
 * A total row: the rows' figures by the rollup rule (`unit-rollup.ts`), its goal paired (ADR-0165 §1) — the goal and
 * *on pace* over the people who count for production (ADR-0172 §2), the leads and the goal activities over everybody.
 */
export interface UnitTotal {
  goal: PairedGoal;
  leadsCounts: LeadCountsRow;
  /** The rows' *Closing* summed (UI-028). */
  closings: number;
  /** The rows' *Proposal* summed (P19.7-T2 AC-13). */
  proposalsMade: number;
  touches: CountAgainst;
  potentialActive: { count: number; of: number };
  /** The new hires before a first sale the goal and *on pace* leave out — named in their ⓘ (P18.8-T5 AC-4). */
  newHires: number;
}

/** A unit below the reader: its head, the head's members who lead nobody, and the units of those who do. */
export interface UnitGroup {
  head: UnitRow;
  members: UnitRow[];
  units: UnitGroup[];
  /** The head and everybody below them. */
  total: UnitTotal;
}

export interface UnitDashboardView {
  today: LocalDate;
  month: string;
  year: string;
  period: UnitDashboardPeriod;
  /** The activity window for the period, in the office's calendar. */
  window: { from: LocalDate; to: LocalDate };
  overdueAfterDays: number;
  /** Whose unit it is. */
  head: UnitPerson & { isReader: boolean };
  /** The head leads nobody: no rows, and the screen draws its empty state. */
  empty: boolean;
  /**
   * **Drawn as that leader sees it, with no write** (P19.3-T3 AC-3; UI-152's Appendix D row): the Owner or an Admin reading
   * another leader's unit (`for`) through the office's own grant — from KPM Analytics' leader sheet, the member page or the
   * org tree. `production.canUpdate` is then false, and a save that names this unit (`PATCH … { for }`) is refused 403.
   * A leader reading a unit below their own keeps their writes.
   */
  readOnly: boolean;
  tiles: {
    /**
     * Everybody on the roster, a new hire from their join date (ADR-0172 §1); `newHires` of them before a first sale,
     * whom *Direct Group production* leaves out (§2) — and *Active Agent*'s count, never its `of` (UI-013).
     */
    team: {
      total: number; direct: number; units: number; underUnits: number;
      /**
       * ***Tim Anda*'s chips** (ADR-0249 §3): *{direct} langsung · {aab} AAB*, and *{ab} AB* while somebody outside
       * `DIRECT_GROUP` is on the roster — the three add up to `total`. `aab` is every row of `DIRECT_GROUP` outside *Your
       * Unit*; `ab` every row outside `DIRECT_GROUP`: an AB below the head and their people, a tagged one's included, and
       * office-wide the other roots' trees and *Belum punya leader*. **An AB is never counted as an AAB.**
       */
      aab: number; ab: number;
      newHires: number;
    };
    directGroupProduction: PairedGoal & { period: 'month' | 'year' };
    /**
     * ***Active Agent*** (UI V1, UI-013; D-16): `POTENTIAL_MAA_COUNT_IN_UNIT` out of **manpower** — every row, the head and
     * the new hires included, the same number as `team.total` — with its *Unit* (the head and their direct agents) and
     * *AAB* (every unit below) split, the two adding up to it.
     */
    potentialActive: {
      count: number; of: number; unit: { count: number; of: number }; aab: { count: number; of: number };
      /** *AB* (ADR-0249 §3): the rows outside `DIRECT_GROUP` — `{0, 0}` in *Grup langsung*. */
      ab: { count: number; of: number };
    };
    potentialRecruits: { yourUnit: number; aabs: number; abs: number };
  };
  yourUnit: { rows: UnitRow[]; total: UnitTotal };
  units: UnitGroup[];
  /**
   * ***Belum punya leader*** (ADR-0249 §2): office-wide *Semua downline* only — the office's people with no leader in the
   * view who lead nobody in it, A to Z, and their total. `null` in every other view, and with nobody such.
   */
  unled: { rows: UnitRow[]; total: UnitTotal } | null;
  /** The view this answer is over (ADR-0249 §1): the one asked for while it is offered, else `scopes.default`. */
  scope: UnitView;
  /** The views this head is offered, in the order drawn, and the reader's default — the picker hides with one or none. */
  scopes: ViewsOffered;
  /** *Grup informal*'s line and its sheet (ADR-0249 §4); `null` in any other view. */
  informal: UnitInformal | null;
  production: { month: string; revision: number; locked: boolean; canUpdate: boolean };
  /**
   * *Chasing MDRT*'s header (P18.2-T7 AC-7, OD-152): whether the office runs an `MDRT_QUALIFICATION` campaign not
   * ended, and the tooltip composed from its requirement — or saying none is running.
   */
  mdrt: { running: boolean; tooltip: string };
  /**
   * ***Last updated*** (UI V1, UI-028; UI-054): **the office's day its latest production file was imported** — the newest
   * import standing (`committed`), of any month, on the office's calendar — or `null` while it has none. The roster's
   * *⟳ Last updated 28 Okt 26*, and the Personal Summary's date header.
   */
  lastUpload: LocalDate | null;
}

/**
 * ***Grup informal*'s line** (the client's message of 11 November 2026, item 7; ADR-0249 §4): *"{n} AB di bawah Anda belum
 * masuk grup"* — `ABS_NOT_IN_INFORMAL_GROUP` — and what *+ Tambah ke grup* needs.
 */
export interface UnitInformal {
  /** The live groups the head owns, A to Z: where a tag puts somebody. Empty: the sheet offers to make one. */
  groups: { groupId: string; name: string }[];
  /** `ABS_NOT_IN_INFORMAL_GROUP(H)`. */
  absNotInGroup: number;
  /** Those ABs, A to Z — only to a reader holding `member:tag_group`, whose sheet lists them; `null` to anybody else. */
  abs: UnitPerson[] | null;
  /** The reader holds `member:tag_group` (the Owner and an Admin): *+ Tambah ke grup* is drawn. The API refuses it too. */
  canTag: boolean;
}

/** Whose unit a read is, and who is in it, by the roster's scopes (UI-001's *Unit | Group*; `rosterScopes`). */
export interface UnitPeople {
  head: { membershipId: string; orgLevelCode: string; isReader: boolean };
  /** The head and their direct agents who lead nobody, in the roster's order. */
  unit: string[];
  /**
   * Everybody in the view, the head first, in the roster's order; only the head when they lead nobody. **`DIRECT_GROUP`**
   * unless a view was asked for (ADR-0249 §5: *Group* is *Grup langsung* on Activities and Home).
   */
  group: string[];
  /** Each member's parent in the view, the head left out (`placeView`): `null` under *Belum punya leader*. */
  parentOf: ReadonlyMap<string, string | null>;
  /** Hung from the head though the head is not their leader: a unit of their own (`placeView`). */
  attached: ReadonlySet<string>;
  /** `DIRECT_GROUP(H)`: the split's *Unit* and *AAB* against *AB* (ADR-0249 §3). */
  direct: ReadonlySet<string>;
  /** The view read, the views offered and *Grup informal*'s line — `direct`, and `informal: null`, without `views`. */
  scope: UnitView;
  scopes: ViewsOffered;
  informal: UnitInformal | null;
  names: ReadonlyMap<string, string>;
  /**
   * Each person's rung (`orgLevelCode`), the head's included (P19.8-T4 AC-7): a person's own ratios apply the definitions
   * of their own rung, as the Ratio page does for them (ADR-0020).
   */
  rungs: ReadonlyMap<string, string>;
  /** The head leads nobody. */
  empty: boolean;
}

/** What *Save all* answers: how many rows changed, and the month as it now stands. */
export interface ProductionUpdated {
  updated: number;
  state: MonthState;
}

/** Whose unit a read is: the head, their rung, and everybody below them. */
interface Head {
  membershipId: string;
  orgLevelCode: string;
  isReader: boolean;
  coachees: Coachee[];
  /** Everybody the reader coaches (`COACH`): all of a leader's own unit, and of one below them; not always the Owner's. */
  coachedByReader: ReadonlySet<string>;
  /** Another leader's unit read through the office's own grant (P19.3-T3 AC-3): the view writes nothing. */
  readOnly: boolean;
  /** The reader's grant on `unit_dashboard:read` is the office's own (`own-kpm`, `all`). */
  office: boolean;
}

/**
 * **A head, and the view's people on their roster** (ADR-0249): `members` are the view's but the head, each with the
 * view's depth; `placement` hangs them together.
 */
interface Roster {
  head: Head;
  members: Coachee[];
  placement: ViewPlacement;
  direct: ReadonlySet<string>;
  scope: UnitView;
  scopes: ViewsOffered;
  /** *Grup informal*'s facts, names not yet read; `null` in any other view. */
  informal: { groups: { groupId: string; name: string }[]; abs: string[]; canTag: boolean } | null;
}

/**
 * **The Unit Dashboard** (Phase 15; `functional/unit-dashboard.md`): `GET /unit/dashboard` and *Update
 * production*.
 *
 * **One roster, read once** (D-api). The unit is its head — the reader, or `for` — and everybody
 * `CoachResolver.coacheesOf` answers for them, grouped by the coaching roster's model (D-groups). **Every
 * figure comes from the function the person's own screens use** (D-figures), computed in bulk: the
 * Summary's goal figures (`goalFigures`, over `GoalService.plansOf` and `ProductionReadings.ledgersFor`),
 * coaching's status, pacing and last 1:1 (`PaceStatusReadings`, `CoachingReadings`), the month table's
 * cells (`readCell`), the leads module's counts (`LeadReadings.countsOfMany`) and the activity readings'.
 * A total is the rollup rule over its rows. **A fixed number of queries whatever the roster's size** —
 * none per person (`unit-dashboard.performance.spec.ts`).
 *
 * **Reach** (D-reach): a leader reads their own unit and any unit below them that somebody heads; the
 * Owner and the Admin any leader's unit in the office; outside it is 404, never 403. A member who leads
 * nobody is answered an empty unit.
 *
 * **The read is recorded** (D-audit): one §3.5 entry per member other than the reader whose figures it
 * carries, in one insert, the period's window as the range; it fails open.
 *
 * **Nothing here reads training or events, and of campaigns only the chases** (P18.2-T7 AC-8): *Chasing MDRT* and
 * *Campaigns they're chasing* through the campaigns module's one named reader, `CampaignChaseReadings`, in the same
 * read — two queries for any roster — and nothing else of that module, which a test says.
 */
@Injectable()
export class UnitDashboardService {
  constructor(
    private readonly coach: CoachResolver,
    private readonly names: MemberNames,
    private readonly orgLevels: OrgLevelService,
    private readonly days: TenantDay,
    private readonly sessions: CoachingReadings,
    private readonly paces: PaceStatusReadings,
    private readonly goals: GoalService,
    private readonly production: OfficialApe,
    private readonly months: ProductionMonths,
    private readonly corrections: ProductionCorrections,
    private readonly activity: ActivityReadings,
    private readonly leads: LeadReadings,
    private readonly subjectReads: SubjectReadAudit,
    /** P18.2-T7 AC-8: the campaigns module's one named reader of chases, and nothing else of it. */
    private readonly chaseReadings: CampaignChaseReadings,
    /** P18.8-T5: the head's own membership, for whether they count for production yet — coachees carry theirs. */
    private readonly memberships: MembershipRepository,
    /** UI V1 (UI-028): the office's imports, for the day of the latest standing one — *Last updated*. */
    private readonly batches: DataUploadBatchRepository,
    /*
     * ADR-0163 §4: which activity types each cascade role counts — the office's binding, the one reader. The
     * application always provides it; optional, the token named (a `X | null` parameter is emitted as `Object`),
     * and without it the default binding.
     */
    @Optional() @Inject(ActivityBindingService) private readonly bindings: ActivityBindingService | null = null,
    /*
     * P19.7-T2 AC-13 (ADR-0221 §7): `PROPOSALS_MADE` per row, through the proposals module's one named reader — a count,
     * nothing else of a proposal. Optional, the token named; without it every row reads 0.
     */
    @Optional() @Inject(ProposalReadings) private readonly proposals: ProposalReadings | null = null,
    /*
     * ADR-0249 §4: the live groups the head owns, for *Grup informal* — one read per view, whatever the size. Optional, the
     * token named; without it the head owns none, and *Grup informal* is offered only for an AB below them.
     */
    @Optional() @Inject(GroupRepository) private readonly groups: GroupRepository | null = null,
  ) {}

  async read(
    ctx: RequestContext, query: { period?: UnitDashboardPeriod; for?: string; scope?: UnitView } = {},
  ): Promise<UnitDashboardView> {
    const me = requireMembership(ctx);
    const period = query.period ?? UNIT_DASHBOARD.DEFAULT_PERIOD;
    const office = await this.days.office(ctx);
    const roster = await this.rosterOf(ctx, me, query.for, query.scope, true);
    const { head } = roster;
    const window = windowOf(period, office.today);
    const informal = await this.informalOf(ctx, roster);
    if (roster.members.length === 0) return this.empty(ctx, office, period, window, roster, informal);
    const goalPeriod: 'month' | 'year' = period === 'year' ? 'year' : 'month';

    const ids = [head.membershipId, ...roster.members.map((c) => c.membershipId)];
    // Coaching's *Last 1:1* is about somebody coached: the reader's own row has none (P15-T4 AC-1).
    const coached = ids.filter((id) => id !== me);

    /*
     * **Chases only inside `campaign_qualification:read`'s reach** (P18.2-T7 AC-8): the reader's own row always; the
     * office's own grant every row; a hierarchy token the people the reader coaches — an Agent-rung leader's included
     * since P19.9-T6 (ADR-0234); `own` nobody else. The dashboard's reach is unchanged.
     */
    const campaignScope = scopeFor(ctx, 'campaign_qualification:read');
    const chaseReach = new Set(ids.filter((id) => id === me || campaignScope === 'own-kpm' || campaignScope === 'all'
      || ((campaignScope === 'own-downline' || campaignScope === 'own-unit') && head.coachedByReader.has(id))));
    const [recency, paces, ledgers, counts, leadCounts, ladder, state, chases, binding, headMembership, closed, lastUpload] = await Promise.all([
      this.sessions.recencyOf(ctx, coached, office),
      this.paces.paceOf(ctx, ids, { today: office.today, month: office.month, onTrackRatio: office.settings.onTrackPaceThreshold }),
      this.production.ledgersFor(ctx, ids, office.month),
      this.activity.countsOverMany(ctx, ids, window),
      this.leads.countsOfMany(ctx, ids, office),
      office.companyId ? this.orgLevels.list(ctx, office.companyId) : Promise.resolve([]),
      this.months.state(ctx, office.month),
      this.chaseReadings.ofMany(ctx, [...chaseReach]),
      // The office's binding, once for every row: a role bound to `[A, B]` counts both (ADR-0163 §4).
      this.bindings ? this.bindings.resolveCascadeBinding(ctx) : Promise.resolve(defaultBinding()),
      // The head's own classification and first sale (ADR-0172 §2): a coachee's arrive on their membership.
      this.memberships.findById(ctx, head.membershipId),
      // UI-028 (O-4): each person's sales leads that reached *Paid and issued*, and when — counted in the window below.
      this.leads.closingsOfMany(ctx, ids),
      this.lastUploadDay(ctx, office),
    ]);
    // P19.7-T2 AC-13: each person's proposals first finished within the window — one query for the roster.
    const made = this.proposals
      ? await this.proposals.madeByMany(ctx, ids, window, office.timezone)
      : new Map<string, number>();
    /*
     * **Who counts for production on the office's today** (ADR-0172 §2, P18.8-T5 AC-2): `COUNTS_FOR_PRODUCTION`, decided
     * once per row here and read by every total and tile below (`rollUpProduction`). A new hire before their first sale
     * is in the team and tagged, and in no production total and no *on pace* count — its `of` is everybody (UI-013).
     */
    const standings = new Map<string, ProductionStanding>([
      [head.membershipId, standingOf(headMembership)],
      ...roster.members.map((c): [string, ProductionStanding] => [c.membershipId, standingOf(c.membership)]),
    ]);
    // Every row's id is the head's or a coachee's, so each has its standing.
    const newHire = (id: string) => newHireBeforeFirstSale(standings.get(id)!, office.today);
    const latest = [...recency.values()].flatMap((r) => (r.last ? [r.last] : []));
    /*
     * **Lead text only to a reader who may read the person's leads** (roles §3.7; the exit review's B1): the
     * follow-up may be a lead's next action, or a typed item carried from one. The session's own rule
     * (`lead-visibility.ts`): the person themselves, whoever led that 1:1, or a leader who coaches them now —
     * else the reader's `lead:read`, read once and only when some row needs it.
     */
    const standing = (id: string) => ({
      isCoach: recency.get(id)?.last?.coachMembershipId === me,
      coachesNow: head.coachedByReader.has(id),
      isCoachee: id === me,
    });
    const leadReach = ids.every((id) => knowsTheLeads(standing(id))) ? [] : await this.coach.reach(ctx, 'lead:read');
    const leadsShown = (id: string) => knowsTheLeads(standing(id)) || leadsReached(leadReach, id);
    const correctors = [...ledgers.values()].flatMap((ledger) => [
      ledger.thisMonthCells.monthly.correctedBy, ledger.thisMonthCells.ytd.correctedBy, ledger.standing.yearToDate?.correctedBy ?? null,
    ]).filter((id): id is string => id !== null);
    const [plans, followUps, people] = await Promise.all([
      this.goals.plansOf(ctx, office.today.slice(0, 4), ids, new Map(
        [...ledgers].map(([id, ledger]) => [id, ledger.standing.yearToDate]),
      )),
      this.sessions.followUpsOf(ctx, latest.map((l) => l.sessionId), office, leadsShown),
      // The rows' photos signed with their names (UI V1, UI-111); a coach or a corrector is only named. The rows' numbers
      // in the same user read (P19.9-T4 AC-1): no query more.
      this.names.pictured(ctx, [...ids, ...latest.map((l) => l.coachMembershipId), ...correctors], ids, { phones: true }),
    ]);
    const names = new Map([...people].map(([id, p]) => [id, p.name]));

    /*
     * **Which rows open the person's coaching pages** (`coached`): the coaching person shell answers somebody
     * the reader coaches (`COACH`, `GET /coaching/coachees/:id`), and its tabs read the person's Summary on
     * `personal_summary:read` — reaching them only by a grant wider than `own` (`CoachResolver.subject`). An
     * Agent-rung leader holds `own-downline` there since P19.9-T6 (ADR-0234), so their coachees' rows open as an AB's
     * do; an Owner or an Admin opening a unit outside their own downline coaches none of it.
     */
    const opensCoaching = OPENS_A_SUBJECT.includes(scopeFor(ctx, 'personal_summary:read'));
    const labels = new Map(ladder.map((level) => [level.code, level.label]));
    const person = (id: string | null): UnitPerson | null => {
      const name = id === null ? undefined : names.get(id);
      return name === undefined ? null : { membershipId: id as string, name };
    };
    const nameOf = (id: string) => names.get(id) ?? '';

    const row = (id: string, orgLevelCode: string, depth: number, leads: boolean): UnitRow => {
      const ledger = ledgers.get(id) as MonthLedger;
      const plan = plans.get(id)!;
      /*
       * The Summary's own computation, the source naming who corrected the figure, as `GET /summary` does — **over the
       * office's figures alone** (ADR-0195, UI-157 item 5): a member's own estimate is *Belum diunggah* here, and fixes no
       * month's target.
       */
      const figures = officialGoalFigures({
        goal: plan, month: office.month, ...ledger.standing, names,
      });
      const { source, ...measured } = goalPeriod === 'year' ? figures.yearly : figures.monthly;

      const targets = period === '7d'
        ? subPeriodActivityTarget(figures.plan.monthlyCounts)
        : period === 'month' ? figures.plan.monthlyCounts : figures.plan.yearlyCounts;
      const [leadsChip, appointmentsChip, closingsChip] = activityTargets(
        targets, binding, counts.get(id) ?? new Map(),
      ).map((chip): CountAgainst => ({ logged: chip.logged, target: chip.target }));

      const recent = recency.get(id);
      const last = recent?.last ?? null;
      const days = recent?.daysSinceLastCoaching as number;
      const pace = paces.get(id)!;
      return {
        membershipId: id,
        name: nameOf(id),
        photoUrl: people.get(id)?.photoUrl ?? null,
        // Nobody WhatsApps themselves, and the office's read-only view draws no button (P19.9-T4 AC-1).
        phone: id === me || head.readOnly ? null : people.get(id)?.phone ?? null,
        isReader: id === me,
        coached: id === me || (opensCoaching && head.coachedByReader.has(id)),
        rung: { code: orgLevelCode, label: labels.get(orgLevelCode) ?? orgLevelCode },
        depth,
        leads,
        goal: {
          set: figures.set,
          period: goalPeriod,
          ...measured,
          caseSizeMinor: figures.caseSizeMinor,
          source,
        },
        production: {
          monthly: productionCell(ledger.thisMonthCells.monthly, person),
          ytd: productionCell(ledger.thisMonthCells.ytd, person),
        },
        leadsCounts: leadCounts.get(id)!,
        closings: closingsIn(closed.get(id)!, window, office.timezone),
        proposalsMade: made.get(id) ?? 0,
        activity: {
          leads: leadsChip, appointments: appointmentsChip, closings: closingsChip,
          touches: cascadeActivityTouches([leadsChip, appointmentsChip, closingsChip]),
        },
        lastOneOnOne: last === null ? null : {
          days,
          date: last.date,
          overdue: oneOnOneOverdue(days, office.settings.coachingOverdueDays),
          coach: person(last.coachMembershipId),
        },
        status: pace.status,
        pacingToMaa: pace.pacingToMaa,
        newHireBeforeFirstSale: newHire(id),
        followUp: followUps.get(id) ?? null,
        ...chaseCells(chases, chaseReach, id),
      };
    };

    /*
     * **The tree below the head, in the view** (ADR-0249 §2; `placeView`), each level A to Z — the coaching roster's order
     * (`coaching-roster.service.ts`). A member whose leader is outside the view hangs from the head as a unit of their own
     * (`attached`: a tagged AB under an untagged one, another root of the office), after the head's own units; office-wide,
     * somebody with no leader in it who leads nobody is under *Belum punya leader* (`unled`).
     */
    const below = new Map<string, Coachee[]>();
    const unledPeople: Coachee[] = [];
    for (const c of roster.members) {
      const parent = roster.placement.parentOf.get(c.membershipId) ?? null;
      if (parent === null) unledPeople.push(c);
      else below.set(parent, [...(below.get(parent) ?? []), c]);
    }
    const aToZ = (a: Coachee, b: Coachee) =>
      nameOf(a.membershipId).localeCompare(nameOf(b.membershipId)) || a.membershipId.localeCompare(b.membershipId);
    for (const level of below.values()) level.sort(aToZ);
    unledPeople.sort(aToZ);
    const leadsSomebody = (c: Coachee) => below.has(c.membershipId);
    const attached = (c: Coachee) => roster.placement.attached.has(c.membershipId);
    const rowOf = (c: Coachee) => row(c.membershipId, c.membership.orgLevelCode, c.depth, leadsSomebody(c));

    const group = (c: Coachee): UnitGroup => {
      const children = below.get(c.membershipId) ?? [];
      const headRow = rowOf(c);
      const members = children.filter((child) => !leadsSomebody(child)).map(rowOf);
      const units = children.filter(leadsSomebody).map(group);
      return { head: headRow, members, units, total: totalOf([headRow, ...members, ...units.flatMap(rowsOf)]) };
    };

    const direct = below.get(head.membershipId) ?? [];
    const headRow = row(head.membershipId, head.orgLevelCode, 0, direct.length > 0);
    const inYourUnit = (c: Coachee) => !attached(c) && c.membership.role === 'agent' && !leadsSomebody(c);
    const yourUnitRows = [headRow, ...direct.filter(inYourUnit).map(rowOf)];
    const units = [
      ...direct.filter((c) => !inYourUnit(c) && !attached(c)),
      ...direct.filter(attached),
    ].map(group);
    const unledRows = unledPeople.map(rowOf);
    const everyRow = [...yourUnitRows, ...units.flatMap(rowsOf), ...unledRows];
    // The tiles' production and *on pace*, over the people who count for production (ADR-0172 §2).
    const rolled = rollUpProduction(everyRow);
    // ADR-0249 §3: *AAB* is `DIRECT_GROUP` outside *Your Unit*; *AB* everybody outside `DIRECT_GROUP` — never an AAB.
    const yourUnitIds = new Set(yourUnitRows.map((r) => r.membershipId));
    const aabRows = everyRow.filter((r) => !yourUnitIds.has(r.membershipId) && roster.direct.has(r.membershipId));
    const abRows = everyRow.filter((r) => !roster.direct.has(r.membershipId));
    const recruits = (rows: readonly UnitRow[]) => rollUpLeadCounts(rows.map((r) => r.leadsCounts)).recruitNominated;

    const view: UnitDashboardView = {
      ...this.frame(ctx, office, period, window, roster, nameOf(head.membershipId), state, informal),
      empty: false,
      tiles: {
        // Everybody, a new hire included from their join date (ADR-0172 §1).
        team: {
          total: everyRow.length,
          direct: yourUnitRows.length,
          units: units.length,
          underUnits: everyRow.length - yourUnitRows.length - units.length,
          aab: aabRows.length,
          ab: abRows.length,
          newHires: rolled.newHires,
        },
        // Paired, as a unit's total is (ADR-0165 §1): a target counts only beside the production it measures.
        directGroupProduction: { ...rolled.goal, period: goalPeriod },
        // UI-013: out of manpower, as *Your team* counts it, split Unit / AAB / AB (ADR-0249 §3).
        potentialActive: activeAgentSplit(yourUnitRows, aabRows, abRows),
        potentialRecruits: { yourUnit: recruits(yourUnitRows), aabs: recruits(aabRows), abs: recruits(abRows) },
      },
      yourUnit: { rows: yourUnitRows, total: totalOf(yourUnitRows) },
      units,
      unled: unledRows.length > 0 ? { rows: unledRows, total: totalOf(unledRows) } : null,
      mdrt: chases.mdrt,
      lastUpload,
    };

    // Last, once the answer exists: one entry per member shown other than the reader, in one insert.
    await this.subjectReads.recordMany(ctx, everyRow, 'unit_dashboard', window);
    return view;
  }

  /**
   * ***Update production*** (P15-T3; OD-137 option 2, ADR-0121): each changed cell a correction of the
   * office's figure, under the reader's name and the fixed reason, through the month table's own function
   * (`ProductionCorrections.correctApe`).
   *
   * Everything is checked before anything is written: the office's current month (400), one row per member
   * (400), each member in the reader's reach — the reader when they lead somebody, and everybody they coach;
   * for the Owner and the Admin any active member of the office — or 404; then the month's lock (409), every
   * row's resulting pair (422) and the revision (409), in `correctApe`.
   */
  async updateProduction(
    ctx: RequestContext,
    body: {
      month: string; revision: number; for?: string;
      rows: { membershipId: string; apeMonthlyMinor?: number; apeYtdMinor?: number }[];
    },
  ): Promise<ProductionUpdated> {
    const me = requireMembership(ctx);
    /*
     * **The office's read-only view writes nothing** (P19.3-T3 AC-3; UI-152's Appendix D row): a save naming another
     * leader's unit (`for`) from the Owner or an Admin — the unit KPM Analytics, the member page and the org tree open
     * read-only — is refused before anything is read, whatever its rows. Their own dashboard, and the Data upload,
     * keep the office's corrections.
     */
    if (body.for !== undefined && body.for !== me && (await this.coach.unitOf(ctx, 'unit_dashboard:update_production')).office) {
      throw new PermissionDeniedException('unit_dashboard:update_production', { readOnly: true, for: body.for });
    }
    const office = await this.days.office(ctx);
    if (body.month !== office.month) {
      throw invalid(UNIT_DASHBOARD_REFUSALS.VALIDATION_FAILED.currentMonthOnly({ month: office.month }), {
        field: 'month', month: office.month,
      });
    }
    const seen = new Set<string>();
    body.rows.forEach((row, index) => {
      if (row.apeMonthlyMinor === undefined && row.apeYtdMinor === undefined) {
        throw invalid(UNIT_DASHBOARD_REFUSALS.VALIDATION_FAILED.rowNeedsFigure, { field: `rows[${index}]` });
      }
      if (seen.has(row.membershipId)) {
        throw invalid(UNIT_DASHBOARD_REFUSALS.VALIDATION_FAILED.personOnce, {
          field: `rows[${index}].membershipId`, membershipId: row.membershipId,
        });
      }
      seen.add(row.membershipId);
    });

    // By the scope the write's grant holds (`CoachResolver.unitOf`): the office's own reaches any active member,
    // which `correctApe` checks; a hierarchy token the reader's unit; `own` alone the reader.
    const unit = await this.coach.unitOf(ctx, 'unit_dashboard:update_production');
    if (!unit.office) {
      const reach = new Set(unit.below.map((c) => c.membershipId));
      if (unit.self) reach.add(me);
      if ([...seen].some((id) => !reach.has(id))) throw new NotFoundException('Member');
    }

    return this.corrections.correctApe(ctx, {
      month: body.month,
      revision: body.revision,
      rows: body.rows,
      // AC-6 (P18.10-T5): the API's own reason, stored in the saving leader's language and shown as stored.
      reason: UNIT_DASHBOARD_MESSAGES.correctionReason,
      surface: 'unit_dashboard',
    });
  }

  /**
   * **Whose unit**, or a 404 (D-reach) — **by the scope the reader's grant actually holds**, as
   * `CoachResolver.reach` branches (`CoachResolver.unitOf`, `CoachResolver.subject`):
   *
   * - **without `for`**, the reader's own: their coachees on a hierarchy token or the office's own grant, and
   *   nobody on `own` alone — an empty unit, never a fallback to `COACH`;
   * - **with `for`**, the member the grant reaches, as every subject read resolves one: `COACH` on a hierarchy
   *   token, the office on `own-kpm`; `own` reaches nobody but the reader. Then that member must lead
   *   somebody. Naming yourself, somebody who leads nobody, somebody outside the reach, another office's member
   *   or somebody who left is not found, and they are indistinguishable.
   */
  private async headOf(ctx: RequestContext, me: string, asked: string | undefined): Promise<Head> {
    const unit = await this.coach.unitOf(ctx, 'unit_dashboard:read');
    const coachedByReader = new Set(unit.below.map((c) => c.membershipId));
    if (asked === undefined) {
      return {
        membershipId: me, orgLevelCode: ctx.membership!.orgLevelCode, isReader: true, coachees: unit.below, coachedByReader,
        readOnly: false, office: unit.office,
      };
    }
    const subject = await this.coach.subject(ctx, asked, 'unit_dashboard:read', 'Unit');
    // `for` naming the reader — or nobody — is not a unit below them.
    if (subject.self) throw new NotFoundException('Unit');
    const coachees = await this.coach.coacheesOf(ctx, asked);
    if (coachees.length === 0) throw new NotFoundException('Unit');
    // The office's own grant reading another leader's unit: as that leader sees it, read-only (P19.3-T3 AC-3).
    return {
      membershipId: asked, orgLevelCode: subject.orgLevelCode, isReader: false, coachees, coachedByReader, readOnly: unit.office,
      office: unit.office,
    };
  }

  /**
   * **The head, and the view's people** (ADR-0249; `metrics-and-definitions.md`, *The views*): the head as `headOf`
   * answers it — the same reach and the same 404s — then `DOWNLINE(H)`: the head's coachees, or **every active member of
   * the office** for the Owner or an Admin on their own dashboard (one read more). Of it the view asked for while it is
   * offered (`viewsOffered`), else the reader's default; and **without `views`** — Activities and Home, whose *Group* is
   * *Grup langsung* (§5) — `DIRECT_GROUP` and no read more.
   *
   * *Grup informal* reads the live groups the head owns once (`GroupRepository`), and the tags off the members already
   * read (`memberships.groupIds`): **a tag reaches nobody outside `DOWNLINE(H)`** (P3-T9 AC-1).
   */
  private async rosterOf(
    ctx: RequestContext, me: string, asked: string | undefined, wanted: UnitView | undefined, views: boolean,
  ): Promise<Roster> {
    const head = await this.headOf(ctx, me, asked);
    const reader: ViewReader = asked !== undefined || !head.office ? 'leader'
      : ctx.membership?.isKpmOwner ? 'owner' : ctx.membership?.isKpmAdmin ? 'admin' : 'leader';
    const officeWide = views && reader !== 'leader';
    const pool = officeWide ? await this.officeMembers(ctx, head.membershipId) : head.coachees;
    const members = pool.map(viewMemberOf);
    const direct = directGroup(head.membershipId, members);
    const leadsSomebody = head.coachees.some((c) => c.membership.leaderId === head.membershipId);

    if (!views) {
      const scopes = viewsOffered({ reader, leadsSomebody, ownsLiveGroup: false, abBelow: 0 });
      return this.placed(head, pool, members, direct, 'direct', scopes, null, false);
    }

    const owned = this.groups
      ? await this.groups.find(
        ctx, { ownerMembershipId: head.membershipId, status: 'active' }, { sort: { name: 1 }, projection: { name: 1 } },
      )
      : [];
    const live = new Set(owned.map((g) => String(g._id)));
    const tagged = new Set(pool
      .filter((c) => c.membership.groupIds.some((id) => live.has(id)))
      .map((c) => c.membershipId));
    const scopes = viewsOffered({
      reader,
      leadsSomebody,
      ownsLiveGroup: owned.length > 0,
      abBelow: members.filter((m) => m.role === 'ab').length,
    });
    const scope = viewChosen(wanted, scopes);
    const ids = scope === 'direct' ? direct
      : scope === 'informal' ? informalGroup(head.membershipId, members, tagged)
        : [head.membershipId, ...members.map((m) => m.membershipId)];
    const informal = scope !== 'informal' ? null : {
      groups: owned.map((g) => ({ groupId: String(g._id), name: g.name })),
      abs: absNotInInformalGroup(head.membershipId, members, tagged),
      canTag: can(ctx, 'member:tag_group'),
    };
    return this.placed(head, pool, members, ids, scope, scopes, informal, scope === 'downline' && officeWide);
  }

  /** A roster from a view's ids: its members placed, each with the view's depth (`placeView`). */
  private placed(
    head: Head, pool: readonly Coachee[], members: readonly ViewMember[], ids: readonly string[], scope: UnitView,
    scopes: ViewsOffered, informal: Roster['informal'], unled: boolean,
  ): Roster {
    const placement = placeView(head.membershipId, members, ids, { unled });
    const inView = new Set(ids);
    return {
      head,
      // `placeView` gives everybody in the view but the head a depth, and the pool never holds the head.
      members: pool
        .filter((c) => inView.has(c.membershipId))
        .map((c) => ({ ...c, depth: placement.depth.get(c.membershipId)! })),
      placement,
      direct: new Set(directGroup(head.membershipId, members)),
      scope,
      scopes,
      informal,
    };
  }

  /**
   * **The office, for its Owner or an Admin on their own dashboard** (ADR-0249 §1, *Semua downline*): every active member
   * but the head, nearest the root first and then in join order — one read on `{kpmId, status, agentSeq}`.
   */
  private async officeMembers(ctx: RequestContext, headId: string): Promise<Coachee[]> {
    const everybody = await this.memberships.find(
      ctx, { status: 'active', _id: { $ne: headId } }, { sort: { depth: 1, agentSeq: 1 } },
    );
    return everybody.map((m) => ({ membershipId: String(m._id), depth: m.ancestorIds.length + 1, membership: m }));
  }

  /**
   * ***Grup informal*'s line, named** (ADR-0249 §4): the ABs not yet tagged, A to Z, for a reader who may tag them — one
   * read of their names, only then; their number to anybody.
   */
  private async informalOf(ctx: RequestContext, roster: Roster): Promise<UnitInformal | null> {
    const facts = roster.informal;
    if (!facts) return null;
    const names = facts.canTag && facts.abs.length > 0 ? await this.names.byMembershipId(ctx, facts.abs) : new Map<string, string>();
    return {
      groups: facts.groups,
      absNotInGroup: facts.abs.length,
      abs: facts.canTag
        ? facts.abs
          .map((id) => ({ membershipId: id, name: names.get(id) ?? '' }))
          .sort((a, b) => a.name.localeCompare(b.name) || a.membershipId.localeCompare(b.membershipId))
        : null,
      canTag: facts.canTag,
    };
  }

  /** What every answer carries, rows or none. */
  private frame(
    ctx: RequestContext, office: Office, period: UnitDashboardPeriod, window: { from: LocalDate; to: LocalDate },
    roster: Roster, headName: string, state: MonthState, informal: UnitInformal | null,
  ): Pick<
    UnitDashboardView,
    'today' | 'month' | 'year' | 'period' | 'window' | 'overdueAfterDays' | 'head' | 'production' | 'readOnly' | 'scope' | 'scopes' | 'informal'
  > {
    const { head } = roster;
    return {
      scope: roster.scope,
      scopes: roster.scopes,
      informal,
      today: office.today,
      month: office.month,
      year: office.today.slice(0, 4),
      period,
      window,
      overdueAfterDays: office.settings.coachingOverdueDays,
      head: { membershipId: head.membershipId, name: headName, isReader: head.isReader },
      readOnly: head.readOnly,
      production: {
        month: office.month,
        revision: state.revision,
        locked: state.locked,
        // The write's own grant, which a read-only support session never holds (`can`), over a unit with rows — and
        // never in the office's read-only view of another leader's unit (P19.3-T3 AC-3).
        canUpdate: roster.members.length > 0 && can(ctx, 'unit_dashboard:update_production') && !head.readOnly,
      },
    };
  }

  /**
   * **A reader who leads nobody** — an Agent, an AAB with no reports, an Owner or Admin below nobody — is
   * answered an empty unit: the read is theirs, there is simply nobody on it (D-reach). No row, so no
   * figure is read and no entry is written.
   */
  private async empty(
    ctx: RequestContext, office: Office, period: UnitDashboardPeriod, window: { from: LocalDate; to: LocalDate }, roster: Roster,
    informal: UnitInformal | null,
  ): Promise<UnitDashboardView> {
    const { head } = roster;
    const [state, names, chases, lastUpload] = await Promise.all([
      this.months.state(ctx, office.month),
      this.names.byMembershipId(ctx, [head.membershipId]),
      this.chaseReadings.ofMany(ctx, []),
      this.lastUploadDay(ctx, office),
    ]);
    const nothing = totalOf([]);
    return {
      ...this.frame(ctx, office, period, window, roster, names.get(head.membershipId) ?? '', state, informal),
      empty: true,
      tiles: {
        team: { total: 0, direct: 0, units: 0, underUnits: 0, aab: 0, ab: 0, newHires: 0 },
        directGroupProduction: { ...nothing.goal, period: period === 'year' ? 'year' : 'month' },
        potentialActive: activeAgentSplit([], [], []),
        potentialRecruits: { yourUnit: 0, aabs: 0, abs: 0 },
      },
      yourUnit: { rows: [], total: nothing },
      units: [],
      unled: null,
      mdrt: chases.mdrt,
      lastUpload,
    };
  }

  /**
   * **Whose unit, and who is in it** (UI V1, UI-001: the Activities tab's *Unit | Group*): the head the read would answer
   * — the reader, or `for`, by the same reach and the same 404s (`headOf`) — and the roster's two scopes, in its order
   * (`rosterScopes`), with everybody's name. Reads no figure and writes no entry: the caller reads and records its own.
   */
  async people(
    ctx: RequestContext, asked?: string, options: { views?: boolean; scope?: UnitView } = {},
  ): Promise<UnitPeople> {
    const me = requireMembership(ctx);
    const roster = await this.rosterOf(ctx, me, asked, options.scope, options.views ?? false);
    const { head } = roster;
    const ids = [head.membershipId, ...roster.members.map((c) => c.membershipId)];
    const [names, informal] = await Promise.all([this.names.byMembershipId(ctx, ids), this.informalOf(ctx, roster)]);
    const scopes = rosterScopes(
      head.membershipId,
      roster.members.map((c) => ({
        membershipId: c.membershipId,
        leaderId: roster.placement.parentOf.get(c.membershipId) ?? null,
        role: c.membership.role,
        attached: roster.placement.attached.has(c.membershipId),
      })),
      (id) => names.get(id) ?? '',
    );
    return {
      head: { membershipId: head.membershipId, orgLevelCode: head.orgLevelCode, isReader: head.isReader },
      unit: scopes.unit,
      group: scopes.group,
      names,
      rungs: new Map([
        [head.membershipId, head.orgLevelCode],
        ...roster.members.map((c): [string, string] => [c.membershipId, c.membership.orgLevelCode]),
      ]),
      empty: roster.members.length === 0,
      parentOf: roster.placement.parentOf,
      attached: roster.placement.attached,
      direct: roster.direct,
      scope: roster.scope,
      scopes: roster.scopes,
      informal,
    };
  }

  /**
   * ***Last updated*** (UI-028): the office's day of its newest standing import, of any month, by the moment the read is
   * made — the Leader Forum scorecard's *AS OF* rule (`scorecard.service.ts`), over every month. One read on the batches'
   * `kpmId` index, the newest first.
   */
  private async lastUploadDay(ctx: RequestContext, office: Office): Promise<LocalDate | null> {
    const [latest] = await this.batches.find(
      ctx,
      { status: 'committed', committedAt: { $ne: null } },
      { sort: { committedAt: -1 }, limit: 1, projection: { committedAt: 1 } },
    );
    return latest?.committedAt ? localDayOf(latest.committedAt, office.timezone) : null;
  }
}

/** What the views read of a member (`unit-view.ts`): the edge, the cached path and the class. */
function viewMemberOf(c: Coachee): ViewMember {
  return {
    membershipId: c.membershipId,
    leaderId: c.membership.leaderId ?? null,
    role: c.membership.role,
    ancestorIds: c.membership.ancestorIds,
  };
}

/** The grants on `personal_summary:read` that reach somebody else: the ones the coaching tabs read through. */
const OPENS_A_SUBJECT: readonly (Scope | null)[] = ['own-unit', 'own-downline', 'own-kpm', 'all'];

/** A row's two campaign cells: from the chases read, or `null` beyond the reader's reach. Chips by title, A to Z. */
function chaseCells(
  chases: ChaseReading, reach: ReadonlySet<string>, id: string,
): Pick<UnitRow, 'chasingMdrt' | 'campaigns'> {
  if (!reach.has(id)) return { chasingMdrt: null, campaigns: null };
  // The chases were read for exactly the reach, and `ofMany` answers every id it is asked about.
  const mine = chases.byMember.get(id)!;
  return {
    chasingMdrt: mine.some((c) => c.code === MDRT_CAMPAIGN_CODE),
    campaigns: mine.map((c) => ({ code: c.code, title: c.title }))
      .sort((a, b) => a.title.localeCompare(b.title) || a.code.localeCompare(b.code)),
  };
}

/** Every row of a group, in the order drawn: its head, its members, then its units'. */
function rowsOf(group: UnitGroup): UnitRow[] {
  return [group.head, ...group.members, ...group.units.flatMap(rowsOf)];
}

/**
 * A total row over some rows, by the rollup rule — its goal **paired** (ADR-0165 §1, P18.5-T15 AC-6): a member's target
 * counts only when their production is held, so a late file is named in the tooltip rather than counted as 0. **The
 * goal reads the people who count for production** (`rollUpProduction`, ADR-0172 §2): a new hire before their first
 * sale is not in it, and counted in `newHires`; ***on pace*** counts only them too and is **out of everybody** (UI-013);
 * the leads and the goal activities are everybody's.
 */
function totalOf(rows: readonly UnitRow[]): UnitTotal {
  const production = rollUpProduction(rows);
  return {
    goal: production.goal,
    leadsCounts: rollUpLeadCounts(rows.map((r) => r.leadsCounts)),
    closings: rows.reduce((sum, r) => sum + r.closings, 0),
    proposalsMade: rows.reduce((sum, r) => sum + r.proposalsMade, 0),
    touches: rollUpCounts(rows.map((r) => r.activity.touches)),
    potentialActive: production.potentialActive,
    newHires: production.newHires,
  };
}

/** What `COUNTS_FOR_PRODUCTION` reads of a membership; nobody's new hire when there is none to read. */
function standingOf(m: { joinedAs?: ProductionStanding['joinedAs']; firstSaleDate?: string | null } | null): ProductionStanding {
  return { joinedAs: m?.joinedAs ?? null, firstSaleDate: m?.firstSaleDate ?? null };
}

/** The activity window a period counts over, in the office's calendar (D-period). */
export function windowOf(period: UnitDashboardPeriod, today: LocalDate): { from: LocalDate; to: LocalDate } {
  if (period === '7d') return rollingWindow(today, PERIOD.ROLLING_7D_DAYS);
  if (period === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  return { from: `${today.slice(0, 4)}-01-01`, to: today };
}

/** A month-table cell, with its corrector named. */
function productionCell(cell: ReadCell, person: (id: string | null) => UnitPerson | null): ProductionCell {
  return {
    valueMinor: cell.value,
    provenance: cell.provenance,
    correctedBy: person(cell.correctedBy),
    correctedAt: cell.correctedAt ? cell.correctedAt.toISOString() : null,
  };
}

function requireMembership(ctx: RequestContext): string {
  const me = ctx.membershipId;
  if (!me) throw new NoMembershipException();
  return me;
}

/** `400 VALIDATION_FAILED` with the field it names, its sentence in both languages (P18.10-T5 AC-2). */
function invalid(message: Sentence<'VALIDATION_FAILED'>, details: Record<string, unknown>): DomainException {
  return new DomainException(ErrorCode.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, details);
}
