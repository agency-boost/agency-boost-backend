import { HttpStatus, Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, NoMembershipException, NotFoundException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { TenantDay, type OfficeDay } from '@/modules/tenants/tenant-day.service';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { CoachingSessionGate } from '@/modules/coaching/coaching-session.gate';
import { ActivationEvents, signalActivation } from '@/modules/activation/activation-events.port';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import type { Permission } from '@/modules/rbac/permissions';
import { GOAL_DEFAULT_RATIOS, GOAL_DEFAULTS, PERIOD } from '@/domain/constants';
import { defaultBinding, type CascadeBinding } from '@/modules/config/activity-binding';
import { ActivityBindingService } from '@/modules/config/activity-binding.service';
import { RatioDefinitionRepository } from '@/modules/config/activity.repository';
import { OfficialApe } from '@/modules/production/official-ape';
import { DataUploadBatchRepository } from '@/modules/production/data-upload-batch.repository';
import type { HeldFigure } from '@/modules/production/production-readings';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { measuredRates, type MeasuredRates } from '@/domain/metrics/measured-rates';
import { rollingWindow, type LocalDate } from '@/common/time/local-day';
import { computeCascade, defaultMonthsLeft, defaultRates, type CascadeInputs, type CascadeResult } from './goal-cascade';
import { summaryPeriod } from '@/modules/summary/summary-period';
import { checkEstimate, checkGoal, checkMonthApe, officialWrittenAt, typedApeOf, typedByAfter, typedInForce } from './goal-input';
import { GOAL_REFUSALS } from './goals.messages';
import { GoalRepository } from './goal.repository';
import type { GoalDocument, GoalMode } from './goal.schema';

/** What the cascade produced, at the moment it was agreed. */
export interface GoalSnapshotView {
  monthlyApeTargetMinor: number;
  policiesPerMonth: number;
  appointmentsPerMonth: number;
  leadsPerMonth: number;
}

/**
 * The cascade over a stored goal, or `null` when its inputs cannot make one.
 *
 * Outside the class because it is a pure question about a document, and because the alternative —
 * a try/catch inline in `view` — reads as though throwing were expected there.
 */
function projectionOf(inputs: Record<string, unknown>): CascadeResult | null {
  try {
    return computeCascade(inputs as never);
  } catch {
    return null;
  }
}

/**
 * **Which APE a plan is measured against on a leader's and the office's screens** (P9-T6 AC-3; ADR-0195 §4, kept by
 * ADR-0230 §7): the office's year to date when it holds one, else the typed figure — which `officialGoalFigures` then
 * reads as nothing held. `plansOf`'s rule, the Unit Dashboard's, the KPM Overview's and Analytics'. The member's own
 * screens read `memberAchievedOf`, where a figure typed after the office's may win.
 */
function achievedOf(
  held: { minor: number; provenance: 'imported' | 'corrected'; month: string } | null, typed: number,
  typedBy: GoalTypist | null = null,
): GoalAchieved {
  if (held) return { minor: held.minor, provenance: held.provenance, month: held.month };
  // Who typed it, only when it was not the member (S2): the member's own figure says nothing more than it did.
  return { minor: typed, provenance: 'self_reported', month: null, ...(typedBy ? { typedBy } : {}) };
}

/**
 * **Which APE the member's own screens measure against** (P19.8-T5; ADR-0230 §6, OD-279's default): **the newer of the
 * typed figure and the office's** (`typedInForce`) — Goal Settings, the Summary, and their coach's view of the member's
 * plan. With no office figure it is `achievedOf`'s answer; with one, the typed figure only when it was typed after the
 * office last wrote the year. The typed figure is never overwritten either way: it stays in `apeAchievedMinor`.
 */
function memberAchievedOf(input: {
  held: { minor: number; provenance: 'imported' | 'corrected'; month: string } | null;
  typed: number;
  typedAt: Date | null;
  officialAt: Date | null;
  typedBy: GoalTypist | null;
}): GoalAchieved {
  const { held, typed } = input;
  const typedWins = typedInForce({ typedMinor: typed, typedAt: input.typedAt, held: held !== null, officialAt: input.officialAt });
  return achievedOf(typedWins ? null : held, typed, input.typedBy);
}

/** The figure in force, and the office's own beside it (`GoalView`'s `achieved` and `official`). */
interface Achieved {
  achieved: GoalAchieved;
  official: GoalOfficial | null;
}

/** The office's own figure for the year, whichever wins (ADR-0230 §4): what *Pakai otomatis* puts back. */
function officialOf(held: { minor: number; provenance: 'imported' | 'corrected'; month: string } | null): GoalOfficial | null {
  return held ? { minor: held.minor, provenance: held.provenance, month: held.month } : null;
}

/**
 * **Who typed a plan's figure, when it was not the member** (S2 of the T17–T20 permission review): `null` for the
 * member — `apeAchievedTypedBy` empty, as on every row from before the field, or their own membership.
 */
function typistIdOf(goal: Pick<GoalDocument, 'membershipId' | 'apeAchievedTypedBy'> | null): string | null {
  const by = goal?.apeAchievedTypedBy ?? null;
  return by === null || by === goal!.membershipId ? null : by;
}

/**
 * **The record a plan's first save keeps** (`goals.cascadeMapping`, ADR-0163 §4): the first code of each role in the
 * office's binding at that moment. A record and never a reader — every count reads the binding.
 */
function mappingOf(binding: CascadeBinding): GoalView['cascadeMapping'] {
  return { leadsCode: binding.leads[0], appointmentsCode: binding.appointments[0], closingsCode: binding.closings[0] };
}

/** A binding the caller may change without reaching anybody else's copy. */
function copyOf(binding: CascadeBinding): CascadeBinding {
  return { leads: [...binding.leads], appointments: [...binding.appointments], closings: [...binding.closings] };
}

/** The inputs of a plan, current or replaced. One reader, so the two shapes cannot drift. */
function inputsOf(plan: GoalRevisionInputs): GoalRevisionInputs {
  return {
    mode: plan.mode,
    annualApeTargetMinor: plan.annualApeTargetMinor,
    savingsTargetMinor: plan.savingsTargetMinor,
    commissionRatePct: plan.commissionRatePct,
    monthsLeftOverride: plan.monthsLeftOverride,
    apeAchievedMinor: plan.apeAchievedMinor,
    caseSizeMinor: plan.caseSizeMinor,
    leadsToApptPct: plan.leadsToApptPct,
    closingRatePct: plan.closingRatePct,
  };
}

/** The plan as it stood, ready to be pushed onto the list it is being replaced on. */
function revisionOf(doc: GoalDocument, at: Date): Record<string, unknown> {
  return {
    version: doc.version,
    ...inputsOf(doc),
    snapshot: {
      monthlyApeTargetMinor: doc.snapshot.monthlyApeTargetMinor,
      policiesPerMonth: doc.snapshot.policiesPerMonth,
      appointmentsPerMonth: doc.snapshot.appointmentsPerMonth,
      leadsPerMonth: doc.snapshot.leadsPerMonth,
    },
    // The moment it **stopped** being the plan, which is when the next one was agreed.
    at: doc.savedAt ?? at,
    byMembershipId: doc.savedByMembershipId ?? doc.membershipId,
  };
}

/** A plan nobody has agreed figures for yet. Also what a row written before the field reads as. */
const EMPTY_SNAPSHOT: GoalSnapshotView = {
  monthlyApeTargetMinor: 0, policiesPerMonth: 0, appointmentsPerMonth: 0, leadsPerMonth: 0,
};

/** The six inputs a plan is made of, shared by the current row and every version it replaced. */
export interface GoalRevisionInputs {
  mode: GoalMode;
  annualApeTargetMinor: number;
  savingsTargetMinor: number;
  commissionRatePct: number;
  monthsLeftOverride: number | null;
  apeAchievedMinor: number;
  caseSizeMinor: number;
  leadsToApptPct: number;
  closingRatePct: number;
}

/**
 * **The APE the plan is measured against, and whose figure it is** (P9-T6, ADR-0008).
 *
 * The carrier's year-to-date figure for the latest month the office holds one — imported, or
 * corrected by hand — and only when there is none, the agent's own typed figure. The typed figure is
 * never overwritten: it stays in `apeAchievedMinor`, labelled, for the months before a file arrives.
 */
export interface GoalAchieved {
  minor: number;
  /**
   * `self_reported` is **typed in the app, not uploaded** — by the member, or by whoever coaches them (ADR-0183); which
   * of the two is `typedBy`.
   */
  provenance: 'imported' | 'corrected' | 'self_reported';
  /** The month whose year-to-date figure it is; `null` for the agent's own. */
  month: string | null;
  /**
   * **Who typed a `self_reported` figure, when it was not the member** (S2): a coach, by membership and by name — `name`
   * `null` when they can no longer be named. Absent when the member typed it, and on the office's own figure.
   */
  typedBy?: GoalTypist;
}

/** Somebody who typed a member's figure for them (S2): the membership, and the name the office knows them by. */
export interface GoalTypist {
  membershipId: string;
  name: string | null;
}

/**
 * **The office's year to date for the member's year, whichever figure is in force** (P19.8-T5; ADR-0230 §1, §4): the
 * automatic figure Goal Settings prefills, marks *⚡ Otomatis · per {month}* and puts back with *Pakai otomatis*.
 * `null` while the office holds none. The official figure, so nothing a leader may not read.
 */
export interface GoalOfficial {
  minor: number;
  provenance: 'imported' | 'corrected';
  /** The latest month the year to date reads, `YYYY-MM`. */
  month: string;
}

/**
 * **A plan worked out and not saved** (`GoalService.preview`, P18.11-T5): what the inputs a screen holds would mean,
 * by the formula a save uses. `monthsLeft` is the figure in force — the typed one, or the office's calendar.
 */
export interface GoalPreview {
  period: string;
  monthsLeft: number;
  monthsLeftIsOverride: boolean;
  achieved: GoalAchieved;
  /** `null` when the inputs cannot make a plan, as a read answers it. */
  projected: CascadeResult | null;
}

/**
 * **`PUT /goals/:period/ape-month`'s answer** (P19.11-T4; UX-12): the month, and the APE the member typed for it — now in
 * force over any upload on their own Summary — or `null` once cleared.
 */
export interface GoalMonthApeView {
  period: string;
  /** `YYYY-MM`. */
  month: string;
  /** IDR sen, and when it was typed (ISO); `null` when the month holds none. */
  manual: { minor: number; typedAt: string } | null;
}

/** One goal, as a caller reads it. */
/**
 * The two conversion assumptions as the subject actually logged them (ADR-0055, P10-T9): printed under
 * the fields they measure, over the goal's own cascade codes, for the last 30 days.
 */
export interface GoalMeasured extends MeasuredRates {
  from: LocalDate;
  to: LocalDate;
  days: number;
}

/** A member's counts over the measuring window, fetched once and read against each goal's own codes. */
interface ActivityWindow {
  from: LocalDate;
  to: LocalDate;
  counts: ReadonlyMap<string, number>;
}

export interface GoalView {
  id: string;
  membershipId: string;
  period: string;
  mode: GoalMode;
  annualApeTargetMinor: number;
  savingsTargetMinor: number;
  commissionRatePct: number;
  /**
   * The divisor **in force**, derived on every read unless the agent overrode it (client PRD §17).
   *
   * Never served from storage. A plan saved in January with 11.9 months left, read back in
   * October, would otherwise still claim 11.9 — and a monthly target a fifth of the truth.
   */
  monthsLeft: number;
  /** Whether the number above is the agent's own choice or the office's calendar. */
  monthsLeftIsOverride: boolean;
  /** **The agent's own figure**, as they typed it — kept, and used only until production arrives. */
  apeAchievedMinor: number;
  /** The figure `projected` is computed from, and which writer it came from (P9-T6). */
  achieved: GoalAchieved;
  /** The office's own figure for the year, whichever is in force — `null` while it holds none (ADR-0230 §4). */
  official: GoalOfficial | null;
  caseSizeMinor: number;
  leadsToApptPct: number;
  closingRatePct: number;
  /**
   * **What was agreed, frozen.** Not what the screen shows: every read recomputes from the inputs,
   * because `monthsLeft` shrinks every day and a plan saved in January would otherwise claim a year
   * that no longer has eleven months in it (client PRD §17). The recomputation is **P8-T2's**, with
   * the formula; this task stores the agreement and proves the two are independent.
   */
  snapshot: GoalSnapshotView;
  /**
   * **What the inputs mean today** — recomputed on every read, never served from storage (P8-T2).
   *
   * `monthsLeft` shrinks every day, so a plan saved in January and shown in June would otherwise
   * claim a year that no longer has eleven months left in it (client PRD §17). This is what every
   * screen renders; `snapshot` is what was agreed.
   *
   * **`null` when the stored inputs cannot produce a plan.** A *write* refuses an unusable
   * assumption by name (AC-7); a *read* must not, or a goal saved before the rule existed — or
   * seeded wrong — would lock its agent out of the one screen that could fix it. The inputs still
   * come back, and the screen says which of them it cannot work from.
   */
  projected: CascadeResult | null;
  /**
   * **What a saved plan was first counted against** — the first code of each role in the office's binding at the
   * plan's first save — kept as its record (ADR-0163 §4) and never rewritten by a rebind. Not what anything
   * counts: that is `cascadeBinding`. For a plan nobody has saved, the binding's first codes today.
   */
  cascadeMapping: { leadsCode: string; appointmentsCode: string; closingsCode: string };
  /**
   * **What the plan's three columns count against today**: the office's activity binding (ADR-0163), each role a
   * list of codes, summed — read through `resolveCascadeBinding`, the one reader. The goal screen's *Activity #n*
   * chips are drawn from it, never from a constant.
   */
  cascadeBinding: CascadeBinding;
  /**
   * The subject's own rates over the last 30 days, beside the assumptions they measure (ADR-0055) —
   * **for the subject's own read only.** `null` whenever the caller is not the goal's member (the
   * phase file's D-rates, P11-T7 AC-10): a leader's, an Owner's or an Admin's read of somebody else's
   * plan, and the answer to their save of it. Two rates from another member's log, served by a read
   * that writes no §3.5 entry, are retired from it; if they return to a subject read, they return
   * audited.
   */
  measured: GoalMeasured | null;
  savedAt: string | null;
  /**
   * **When the APE produced last changed** (P19.1-T4 AC-11, ADR-0195 §3): the Summary says the office's figure replaced
   * an estimate only when it was written after this. `null` on a row from before the field, and on the defaults.
   */
  apeAchievedTypedAt: string | null;
  savedByMembershipId: string | null;
  version: number;
}

/**
 * The goal record (P8-T1).
 *
 * **No cascade here, and that is the line between this task and P8-T2.** This owns what a goal *is*
 * — whose it is, which period, what was typed, what was agreed, and the fact that only one exists
 * per person per period. What those numbers *mean together* is the calculation engine's, and it
 * arrives with the constants and the five steps rather than leaking into the record a field at a
 * time.
 *
 * **No route, either.** `.claude/rules/backend-then-frontend.md` refuses an endpoint no screen
 * calls, so the honest way to respect it is to add none: the routes land in P8-T3 with the screen
 * that calls them. The same shape P7-T1 took.
 */
@Injectable()
export class GoalService {
  private readonly logger = new Logger(GoalService.name);

  constructor(
    private readonly goals: GoalRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly days: TenantDay,
    private readonly memberships: MembershipRepository,
    private readonly names: MemberNames,
    private readonly notifications: NotificationService,
    private readonly production: OfficialApe,
    private readonly activity: ActivityReadings,
    private readonly coach: CoachResolver,
    /*
     * `PUT /goals/:period?for=&session=` (P11-T8): whether the session is the caller's own open one with
     * the subject, and the key its notice coalesces under. The coaching module's, which reads only
     * sessions and `COACH`, so nothing it depends on depends on goals.
     */
    private readonly sessions: CoachingSessionGate,
    /*
     * P13-T3 AC-5: a goal saved on a hire's membership completes their activation's `feature:goals` item.
     * A port the activation module answers, so goals does not depend on it; optional, failing open.
     */
    @Optional() @Inject(ActivationEvents) private readonly activation: ActivationEvents | null = null,
    /*
     * P18.5-T10 AC-1 (ADR-0160 §3): the office's two benchmarks a new plan's percentages open on — the working
     * copy `/activity/ratio` reads. The application always provides it; optional, with the token named as
     * `ActivityService`'s `published` explains, so a hand-built instance that offers no defaults need not, and
     * without it the defaults are `GOAL_DEFAULTS`.
     */
    @Optional() @Inject(RatioDefinitionRepository) private readonly ratios: RatioDefinitionRepository | null = null,
    /*
     * ADR-0163 §4: which activity types each cascade role counts — the office's binding, the one reader. Optional,
     * the token named as above, and without it the default binding.
     */
    @Optional() @Inject(ActivityBindingService) private readonly bindings: ActivityBindingService | null = null,
    /*
     * P19.8-T5 (ADR-0230 §6): the office's production imports, for the moment it last wrote a member's year — the newer
     * of that and a typed figure wins on the member's own screens. The application always provides it; optional, the
     * token named as above, and without it only a correction dates the office's figure.
     */
    @Optional() @Inject(DataUploadBatchRepository) private readonly batches: DataUploadBatchRepository | null = null,
  ) {}

  /** The office's activity binding (ADR-0163 §4), or the default binding on a hand-built instance. */
  private async binding(ctx: RequestContext): Promise<CascadeBinding> {
    return this.bindings ? this.bindings.resolveCascadeBinding(ctx) : defaultBinding();
  }

  /**
   * **The percentages a plan nobody has saved opens on** (ADR-0160 §3): the office's *Selling success rate* and
   * *Set appointment to meeting* benchmarks, active ones only, or `GOAL_DEFAULTS` (`defaultRates`). One read.
   */
  private async officeRates(ctx: RequestContext): Promise<Pick<CascadeInputs, 'leadsToApptPct' | 'closingRatePct'>> {
    const rows = this.ratios
      ? await this.ratios.find(ctx, { code: { $in: Object.values(GOAL_DEFAULT_RATIOS) }, status: 'active' })
      : [];
    return defaultRates(rows);
  }

  /**
   * **The subject's counts over the last 30 days** (ADR-0055) — `ROLLING_30D`, the ratio window, ending
   * today in the office's timezone. Fetched once per request and read against each goal's own codes,
   * so `list`, over every period, costs one query.
   */
  private async activityFor(ctx: RequestContext, membershipId: string, day: OfficeDay): Promise<ActivityWindow> {
    const window = rollingWindow(day.today, PERIOD.ROLLING_30D_DAYS);
    return { ...window, counts: await this.activity.countsOver(ctx, membershipId, window) };
  }

  /**
   * **The window `measured` is read from, for the member's own read, and nothing for anybody else's**
   * (D-rates, P11-T7 AC-10). A subject's log is not read at all, so no rate of theirs can reach a
   * reader who is not them by this route — and the read costs one query less.
   */
  private async measuring(ctx: RequestContext, membershipId: string, day: OfficeDay): Promise<ActivityWindow | null> {
    return membershipId === ctx.membershipId ? this.activityFor(ctx, membershipId, day) : null;
  }

  private measured(window: ActivityWindow | null, binding: CascadeBinding): GoalMeasured | null {
    if (!window) return null;
    return {
      from: window.from, to: window.to, days: PERIOD.ROLLING_30D_DAYS, ...measuredRates(window.counts, binding),
    };
  }

  /**
   * **Which APE the plan is measured against** (P9-T6 AC-3). The promise Phase 8 made: the typed
   * figure is the agent's until the carrier's file says otherwise, and then the file's is used —
   * the screen says which. Nothing is overwritten: the typed figure is still the agent's, stored.
   */
  private async achievedFor(
    ctx: RequestContext, membershipId: string, period: string, goal: GoalDocument | null,
  ): Promise<Achieved> {
    const held = await this.production.apeYearToDate(ctx, membershipId, period);
    return this.inForce(ctx, period, held, {
      minor: goal?.apeAchievedMinor ?? 0, at: goal?.apeAchievedTypedAt ?? null, by: typistIdOf(goal),
    });
  }

  /**
   * **The figure in force on the member's own screens, and the office's beside it** (P19.8-T5; ADR-0230 §6): the newer
   * of the typed figure and the office's year to date (`memberAchievedOf`). The office's write moment is read only where
   * it can decide the answer — a typed figure above 0 beside an office figure — and who typed it only where the typed
   * figure is the answer.
   */
  private async inForce(
    ctx: RequestContext, period: string, held: HeldFigure | null,
    typed: { minor: number; at: Date | null; by: string | null },
  ): Promise<Achieved> {
    const officialAt = held && typed.minor > 0 ? await this.officialAt(ctx, period, held) : null;
    const official = officialOf(held);
    const achieved = memberAchievedOf({ held, typed: typed.minor, typedAt: typed.at, officialAt, typedBy: null });
    if (achieved.provenance !== 'self_reported' || typed.by === null) return { achieved, official };
    const typedBy = await this.typistOf(ctx, typed.by);
    return { achieved: typedBy ? { ...achieved, typedBy } : achieved, official };
  }

  /**
   * **When the office last wrote the member's year** (ADR-0230 §6, `officialWrittenAt`): its newest correction among the
   * year's months, or the year's latest import standing — whichever is later. The office's own: through the
   * tenant-scoped repository, on the batches' `(kpmId, month, status, …)` index, as the Summary's date reads it.
   */
  private async officialAt(ctx: RequestContext, period: string, held: HeldFigure): Promise<Date | null> {
    if (!this.batches) return officialWrittenAt(held.correctedAt, null);
    const [latest] = await this.batches.find(
      ctx,
      { month: { $gte: `${period}-01`, $lte: `${period}-12` }, status: 'committed', committedAt: { $ne: null } },
      { sort: { committedAt: -1 }, limit: 1, projection: { committedAt: 1 } },
    );
    return officialWrittenAt(held.correctedAt, latest?.committedAt ?? null);
  }

  /** A coach who typed the figure, named (S2) — `null` for the member, and a name `null` for nobody the office holds. */
  private async typistOf(ctx: RequestContext, membershipId: string | null): Promise<GoalTypist | null> {
    if (membershipId === null) return null;
    const names = await this.names.byMembershipId(ctx, [membershipId]);
    return { membershipId, name: names.get(membershipId) ?? null };
  }

  /**
   * The membership this request is about, or a 404 (P8-T4 AC-3, P11-T3).
   *
   * **Their own, always — plus whoever the grant on the route's permission reaches**, resolved by
   * `CoachResolver.subject`, the one answer every subject read in the product gives. §3.6 is wider
   * than §3.7's leads: an office's Owner and Admin hold `own-kpm` here, because a goal carries an
   * agent's own intentions about their own production rather than a third party's personal data. A
   * leader reaches everybody they coach, an AAB's nested units included (ADR-0074) — and nobody who
   * has left, nobody beside them and nobody in another office.
   *
   * **404 and never 403**, the same sentence that has been true of another office's data since
   * Phase 2: a leader asking after somebody outside their downline should not learn from the shape
   * of the refusal that the person exists.
   */
  private async subject(
    ctx: RequestContext, asked: string | undefined, permission: Permission,
  ): Promise<string> {
    return (await this.coach.subject(ctx, asked, permission, 'Goal')).membershipId;
  }

  /** The caller's own membership, or a refusal that says what to do about it. */
  private me(ctx: RequestContext): string {
    const membershipId = ctx.membershipId;
    if (!membershipId) throw new NoMembershipException();
    return membershipId;
  }

  /**
   * Save the caller's own goal for a period, creating it or replacing what it held.
   *
   * **One document per `(membership, period)`, and the database is what enforces it.** A genuine
   * upsert rather than a read-then-write, because two saves genuinely race: the agent on a phone
   * and their leader on a laptop, in the same 1-on-1, both reading *no goal yet* and both
   * inserting. Read-then-write hands whoever is second a duplicate-key error; this hands them what
   * they meant.
   *
   * **Writes take no subject.** A goal is saved for the person saving it, exactly as an activity
   * day is logged for the person logging it. A leader saving a downline's goal is ADR-0046 and
   * P8-T4's, and it arrives as a route that names whose goal it is rather than as a parameter
   * smuggled into this one — a check can be forgotten, a parameter that does not exist cannot be
   * passed.
   */
  async save(
    ctx: RequestContext, body: unknown, forMembershipId?: string, sessionId?: string,
  ): Promise<GoalView> {
    const savedBy = this.me(ctx);
    const membershipId = await this.subject(ctx, forMembershipId, 'goal:update');
    const input = checkGoal(body);
    /*
     * **Through a coaching session** (P11-T8, ADR-0075): the caller's own open session with this member,
     * or 404; a finalized one, 409. Checked before anything is written, so a refused save saves nothing.
     */
    const session = sessionId === undefined ? null : await this.sessions.openFor(ctx, sessionId, membershipId);
    const now = this.clock.now();
    const day = await this.days.for(ctx);
    this.requireOpenPeriod(input.period!, day);
    // The figure in force at the moment of agreement: the agent's own, or the office's calendar.
    const monthsLeft = input.monthsLeft
      ?? defaultMonthsLeft(input.period!, this.clock.now(), day.timezone);
    /*
     * The plan this one replaces, kept whole (ADR-0042). Read before the write rather than derived
     * after it: once the upsert lands, the previous state is gone from the row it lived on.
     */
    const previous = await this.goals.findOne(ctx, { membershipId, period: input.period! });
    /*
     * **The APE achieved so far** (ADR-0075, partly reversed by ADR-0183; `typedApeOf`). The member types
     * their own, always — over the office's figure too since ADR-0230. Somebody else saving the plan — a leader who coaches them, through a session or
     * from Goal Settings, or the office's Owner or Admin — **types it too while the office holds no figure
     * for the year**; once the carrier's file (or a correction) is held, their typing is ignored and the
     * member's stored figure kept. A body that leaves the figure out keeps the stored one, whoever saves (S1). The
     * save names who typed it: `apeAchievedTypedBy` (S2), `savedByMembershipId`, the revision it replaces, and the
     * audit entry's `apeAchievedChanged`.
     */
    const held = await this.production.apeYearToDate(ctx, membershipId, input.period!);
    const own = membershipId === savedBy;
    const typed = typedApeOf({ own, held, asked: input.apeAchievedMinor, stored: previous?.apeAchievedMinor ?? 0 });
    const changed = typed !== (previous?.apeAchievedMinor ?? 0);
    /*
     * **The member typing over the office's figure is a typing now** (P19.8-T5; ADR-0230 §6): the newer of the two wins,
     * so a figure they type again — the same one an upload has since replaced — is newer than that upload. Only the
     * member's own, only over an office figure, only a figure the body carries.
     */
    const retyped = own && held !== null && input.apeAchievedMinor !== undefined && typed > 0;
    /*
     * **Who typed the figure the plan now stores** (S2): the saver when this save changed it, else whoever did before.
     * A screen leaves the figure out unless its reader changed it (S1), so a coach saving the target leaves the
     * member's own figure — and its attribution — as they were.
     */
    const typedBy = retyped && !changed ? savedBy : typedByAfter({
      before: previous?.apeAchievedMinor ?? 0, after: typed, savedBy, typedBefore: previous?.apeAchievedTypedBy,
    });
    // When the figure was typed (P19.1-T4 AC-11): now when this save typed it, else as it was.
    const typedAt = changed || retyped ? now : (previous?.apeAchievedTypedAt ?? null);
    /*
     * What is agreed is measured against the figure the member's screen showed — the newer of the typed figure and the
     * office's (ADR-0230 §6) — and the typed figure is stored either way (P9-T6).
     */
    const { achieved, official } = await this.inForce(ctx, input.period!, held, {
      minor: typed, at: typedAt, by: typedBy === membershipId ? null : typedBy,
    });
    // Refuses an unusable assumption before anything is written (AC-7).
    const agreed = computeCascade({ ...input, monthsLeft, apeAchievedMinor: achieved.minor } as never);
    const binding = await this.binding(ctx);

    const saved = await this.goals.upsertOne(
      ctx,
      { membershipId, period: input.period! },
      {
        $set: {
          mode: input.mode!,
          annualApeTargetMinor: input.annualApeTargetMinor!,
          savingsTargetMinor: input.savingsTargetMinor!,
          commissionRatePct: input.commissionRatePct!,
          // `null` means *use the office's calendar*, and is what the screen sends unless the
          // agent typed over the figure.
          monthsLeftOverride: input.monthsLeft ?? null,
          apeAchievedMinor: typed,
          apeAchievedTypedBy: typedBy,
          // When the figure was typed (P19.1-T4 AC-11, ADR-0230 §6): kept as it was when this save leaves it alone.
          apeAchievedTypedAt: typedAt,
          caseSizeMinor: input.caseSizeMinor!,
          leadsToApptPct: input.leadsToApptPct!,
          closingRatePct: input.closingRatePct!,
          savedAt: now,
          savedByMembershipId: savedBy,
          /*
           * **The snapshot is written at save time and never again.** It is what was agreed, which
           * is a different question from what the inputs mean today — and the only moment the two
           * are the same is this one.
           */
          snapshot: {
            monthlyApeTargetMinor: agreed.monthlyApeTargetMinor,
            policiesPerMonth: agreed.policiesPerMonth,
            appointmentsPerMonth: agreed.appointmentsPerMonth,
            leadsPerMonth: agreed.leadsPerMonth,
          },
        },
        $setOnInsert: {
          membershipId,
          period: input.period!,
          // The record of what the plan was first counted against: the office's binding then (ADR-0163 §4).
          cascadeMapping: mappingOf(binding),
        },
        /*
         * **Bumped on every save, including the first.** `version` starts at 0 on insert and this
         * takes it to 1, so there is no branch deciding which — and re-planning is a new version
         * rather than an overwrite (ADR-0042). The prior versions are kept, whole, with who saved
         * each; no screen reads them since P10.1-T6 retired `GET /goals/:period/history`, and the
         * prototype draws no goal history for one to.
         */
        $inc: { version: 1 },
        ...(previous ? { $push: { revisions: revisionOf(previous, now) } } : {}),
      },
    );

    await this.record(
      ctx,
      saved.version === 1 ? 'goal.created' : 'goal.updated',
      String(saved._id),
      {
        period: saved.period, version: saved.version, savedByMembershipId: savedBy,
        // Who typed the APE produced, when this save changed it (ADR-0183): the saver, named above. No figure.
        ...(changed || retyped ? { apeAchievedChanged: true } : {}),
      },
    );
    // §3.6 (AC-7): an agent finding their target changed should not have to notice it.
    if (membershipId !== savedBy) {
      await this.announce(ctx, membershipId, savedBy, saved, session?.coalesceKey ?? null);
    }
    // P13-T3 AC-2: the hire's goal, saved by them or by a leader with `?for=`, attributed to whoever saved it.
    await signalActivation(this.activation, ctx, membershipId, 'feature:goals');
    return this.view(saved, day, { achieved, official }, await this.measuring(ctx, membershipId, day), binding);
  }

  /**
   * **The member's own estimate of the APE produced so far this year** (P19.1-T4 AC-10, AC-13; the 6 November handover's
   * UI-157 item 4, *Isi produksi sementara*; OD-250's default, ADR-0195): `PUT /goals/:period/ape-estimate`, from the
   * Summary's goal card. **One value with Goal Settings' *APE yang sudah dicapai tahun ini***: the plan's
   * `apeAchievedMinor`, provenance `self_reported`, which either screen writes and both read as *perkiraan Anda*.
   *
   * - **The caller's own plan only**: no `for`. A coach types a member's figure on their *Goal Setting* tab, through the
   *   plan's save (ADR-0183); this route is the member's.
   * - **A saved plan only** (`404 Goal` without one): the Summary offers it under a goal it measures, and an estimate
   *   with no target to measure it against would only be stored.
   * - **The member's own save's rule, for one field** (ADR-0195 §2): the figure, who typed it (the member) and when
   *   change; the plan as it stood is kept in `revisions[]` and the version moves on, as a save's does. Not a re-plan:
   *   the other inputs, the agreed snapshot and `savedAt` stay. The audit entry is `goal.estimate_set` or
   *   `goal.estimate_cleared` — no amount, as ADR-0183's `apeAchievedChanged` carries none.
   * - **The same figure again writes nothing** — unless the office has written the year since it was typed, so the
   *   office's figure is the one in force: then sending it again is a typing now, newer than that upload, and it is
   *   re-stamped and wins, as the plan's save does (ADR-0230 §6).
   * - **`null` or 0 clears it** (*Hapus*): nothing typed is 0, as on every plan saved before there was an estimate.
   * - **Apart from the office's production** (AC-13): stored on the plan, never in `monthlyAgentData`. **The newer of it
   *   and the office's year-to-date figure is the one the member's screens read** (ADR-0230 §6, amending ADR-0195 §3):
   *   an import or a correction written after it replaces it (`memberAchievedOf`; the Summary's `estimateReplaced`).
   *   No leader's or office's screen reads it at all (`officialGoalFigures`).
   */
  async saveEstimate(ctx: RequestContext, period: string, body: unknown): Promise<GoalView> {
    const membershipId = this.me(ctx);
    const minor = checkEstimate(body);
    const goal = await this.goals.findOne(ctx, { membershipId, period });
    if (!goal) throw new NotFoundException('Goal');
    const day = await this.days.for(ctx);
    this.requireOpenPeriod(period, day);
    /*
     * Unchanged — the same figure, typed by the member, and still the one in force — writes nothing and records nothing.
     * The same figure over an office figure written since it was typed is a typing now (ADR-0230 §6): the newer wins.
     */
    const same = minor === goal.apeAchievedMinor && (goal.apeAchievedTypedBy ?? null) === null;
    const replaced = same && minor > 0
      && (await this.achievedFor(ctx, membershipId, period, goal)).achieved.provenance !== 'self_reported';
    const unchanged = same && !replaced;
    const now = this.clock.now();
    const current = unchanged
      ? goal
      : (await this.goals.updateById(ctx, String(goal._id), {
        $set: { apeAchievedMinor: minor, apeAchievedTypedBy: null, apeAchievedTypedAt: now },
        // The plan as it stood, whole, as a save keeps it (ADR-0042, ADR-0183): an estimate is one of its inputs.
        $inc: { version: 1 },
        $push: { revisions: revisionOf(goal, now) },
      })) ?? goal;
    if (!unchanged) {
      await this.record(ctx, minor === 0 ? 'goal.estimate_cleared' : 'goal.estimate_set', String(goal._id), { period });
    }
    return this.view(
      current, day, await this.achievedFor(ctx, membershipId, period, current),
      await this.measuring(ctx, membershipId, day), await this.binding(ctx),
    );
  }

  /**
   * **A month's APE, typed by the member over the office's upload** (P19.11-T4; UX-12, UXQ2's default):
   * `PUT /goals/:period/ape-month`, from the headline of the Summary's *Target vs. realisasi (APE)* on *Bulanan*.
   *
   * - **The caller's own plan only**, and only a saved one (`404 Goal` without it): no `for`. A coach reads the figure on
   *   the member's Summary tab and cannot change it.
   * - **A month of the plan's year** (400 otherwise, `checkMonthApe`), **one the office's Summary can show** — not after
   *   its current month, not before the month it opened (`summaryPeriod`'s refusals, 400) — **of a plan not locked**
   *   (`GOAL_PERIOD_LOCKED`, 409).
   * - **Stored on the plan, per month** (`apeByMonth`, keyed `YYYY-MM`), **never in `monthlyAgentData`**: the upload is
   *   never written. The member's own Summary reads it over the upload — an upload arriving later does not replace it —
   *   and no leader's or office's figure reads it at all.
   * - **`null` clears it** — *Kembalikan ke data unggahan*, or back to *Belum diunggah* where nothing is uploaded.
   * - **Not a plan input**: no revision, no version, `savedAt` and the snapshot untouched. Audited `goal.month_ape_set` or
   *   `goal.month_ape_cleared`, `{ period, month }`, never the amount. The same figure again, or clearing a month that
   *   holds none, writes and records nothing.
   */
  async saveMonthApe(ctx: RequestContext, period: string, body: unknown): Promise<GoalMonthApeView> {
    const membershipId = this.me(ctx);
    const { month, minor } = checkMonthApe(body, period);
    const goal = await this.goals.findOne(ctx, { membershipId, period });
    if (!goal) throw new NotFoundException('Goal');
    const calendar = await this.days.calendar(ctx);
    this.requireOpenPeriod(period, calendar);
    // The months the Summary's selector offers, and their refusals: not begun yet, or before the office opened.
    summaryPeriod(calendar, { month });

    const held = goal.apeByMonth?.get(month) ?? null;
    const path = `apeByMonth.${month}`;
    if (minor === null ? held === null : held?.minor === minor) {
      return { period, month, manual: held ? { minor: held.minor, typedAt: held.typedAt.toISOString() } : null };
    }
    const typedAt = this.clock.now();
    await this.goals.updateById(ctx, String(goal._id), minor === null
      ? { $unset: { [path]: '' } }
      : { $set: { [path]: { minor, typedAt } } });
    await this.record(ctx, minor === null ? 'goal.month_ape_cleared' : 'goal.month_ape_set', String(goal._id), { period, month });
    return { period, month, manual: minor === null ? null : { minor, typedAt: typedAt.toISOString() } };
  }

  /**
   * **The month's APE the member typed, if any** (P19.11-T4): what `GET /summary` reads over the office's upload on the
   * member's own Summary — and their coach's view of it. Read from the member's plan for the month's year; `null` without
   * a plan or a figure. **No leader's or office's figure asks here** (`officialGoalFigures` never reads it). It checks
   * nobody's reach: the caller resolved the member first, as `planOf`'s callers do.
   */
  async monthApeOf(ctx: RequestContext, membershipId: string, month: string): Promise<{ minor: number; typedAt: Date } | null> {
    const goal = await this.goals.findOne(ctx, { membershipId, period: month.slice(0, 4) });
    const held = goal?.apeByMonth?.get(month) ?? null;
    return held ? { minor: held.minor, typedAt: held.typedAt } : null;
  }

  /**
   * The goal for a period, or **the office's defaults** when there is none (P8-T3).
   *
   * A first-time reader opens on five filled cards rather than five empty ones, which is what the
   * prototype does and is right to: a cascade with nothing in it teaches nobody what the screen is
   * for. Nothing is written — the defaults are offered, not saved.
   */
  async readOrDefaults(
    ctx: RequestContext, period: string, forMembershipId?: string,
  ): Promise<Omit<GoalView, 'id' | 'membershipId' | 'version'>> {
    return this.planOf(ctx, period, await this.subject(ctx, forMembershipId, 'goal:read'));
  }

  /**
   * **What a plan would mean, before anybody saves it** (P18.11-T5, UI V1 UI-014, UI-016, UI-017): the cascade over
   * the inputs a screen holds, worked out by the one formula a save uses and **written nowhere**.
   *
   * Goal Settings' result card and its commitment move as a slider moves. The screen holds no copy of the cascade
   * (P8-T3 AC-2: the prototype's three surfaces disagree, and a second implementation is how that happens), so it asks
   * here instead, and a save then stores exactly what the reader watched.
   *
   * **The same figures a save would store**, by the same rules: the months left from the office's calendar unless
   * typed over; the APE produced the newer of the typed figure and the office's year to date (ADR-0230 §6) — what the
   * member types on their own plan is typed now, so it wins; on anybody else's the reader's while the office holds
   * none, and the member's stored figure once it holds one (`typedApeOf`, ADR-0183).
   * Whose plan is `goal:read`'s reach, 404 beyond it, never 403. **An assumption that cannot make a plan is
   * `projected: null`**, as a read answers one, not the save's 422: the screen is mid-edit, and the save still refuses
   * it by name. A field that is not a number at all is the save's own 400 (`checkGoal`).
   */
  async preview(
    ctx: RequestContext, period: string, body: unknown, forMembershipId?: string,
  ): Promise<GoalPreview> {
    const membershipId = await this.subject(ctx, forMembershipId, 'goal:read');
    const input = checkGoal(body);
    const day = await this.days.for(ctx);
    const monthsLeft = input.monthsLeft ?? defaultMonthsLeft(period, this.clock.now(), day.timezone);
    const own = membershipId === ctx.membershipId;
    const held = await this.production.apeYearToDate(ctx, membershipId, period);
    // The stored plan is read only where it can decide the answer: the member typing their own needs none.
    const stored = own && input.apeAchievedMinor !== undefined
      ? null
      : await this.goals.findOne(ctx, { membershipId, period });
    const before = stored?.apeAchievedMinor ?? 0;
    const typed = typedApeOf({ own, held, asked: input.apeAchievedMinor, stored: before });
    // Who typed it, as a save would record it (S2): the reader when the figure moved, else whoever typed it.
    const typedBy = typedByAfter({ before, after: typed, savedBy: this.me(ctx), typedBefore: stored?.apeAchievedTypedBy });
    // A figure the body carries and a save would take is typed now (ADR-0230 §6): the newer of it and the office's wins.
    const taken = input.apeAchievedMinor !== undefined && (own || held === null);
    const { achieved } = await this.inForce(ctx, period, held, {
      minor: typed,
      at: taken ? this.clock.now() : (stored?.apeAchievedTypedAt ?? null),
      by: typedBy === membershipId ? null : typedBy,
    });
    return {
      period,
      monthsLeft,
      monthsLeftIsOverride: input.monthsLeft !== null && input.monthsLeft !== undefined,
      achieved,
      projected: projectionOf({ ...input, monthsLeft, apeAchievedMinor: achieved.minor }),
    };
  }

  /**
   * **`readOrDefaults` for a member the caller has already been resolved to** — the subject-taking
   * internal a read with its own permission composes (P11-T4 AC-1): `GET /summary?for=` resolves its
   * subject on `personal_summary:read`, and reads the plan through here rather than resolving the same
   * person a second time on `goal:read`. It checks nobody's reach, so it is never handed an id a
   * request named before that request's own resolver has answered for it.
   */
  async planOf(
    ctx: RequestContext, period: string, membershipId: string,
  ): Promise<Omit<GoalView, 'id' | 'membershipId' | 'version'>> {
    const goal = await this.goals.findOne(ctx, { membershipId, period });
    if (!goal) return this.defaults(ctx, period, membershipId);
    const day = await this.days.for(ctx);
    return this.view(
      goal, day, await this.achievedFor(ctx, membershipId, period, goal),
      await this.measuring(ctx, membershipId, day), await this.binding(ctx),
    );
  }

  /**
   * **`planOf` for many members at once** (Phase 15, D-figures): what the Unit Dashboard's goal cells read
   * for every row of a unit — each member's plan, or the office's defaults where they hold none, measured
   * against the year to date the office holds for them — **by the same `view` and the same defaults** as
   * `planOf`, from one read of the goals.
   *
   * `yearToDate` is each member's latest year-to-date figure for `period`, as `ProductionReadings` answers
   * it in bulk (`ledgersFor`), so the caller reads production once for every figure it needs. Like `planOf`
   * it checks nobody's reach: the caller resolved the members first. `measured` is `null` on every plan —
   * it is the member's own read's alone (D-rates).
   */
  async plansOf(
    ctx: RequestContext,
    period: string,
    membershipIds: readonly string[],
    yearToDate: ReadonlyMap<string, { minor: number; provenance: 'imported' | 'corrected'; month: string } | null>,
  ): Promise<Map<string, Omit<GoalView, 'id' | 'membershipId' | 'version'>>> {
    const ids = [...new Set(membershipIds)];
    if (ids.length === 0) return new Map();
    // The office's benchmarks, once, beside the plans — read whether or not somebody here has none, so a batch
    // costs the same queries whoever it holds (P15-T1 AC-8).
    const [day, goals, binding, rates] = await Promise.all([
      this.days.for(ctx),
      this.goals.find(ctx, { membershipId: { $in: ids }, period }),
      this.binding(ctx),
      this.officeRates(ctx),
    ]);
    const byMember = new Map(goals.map((goal) => [goal.membershipId, goal]));
    // Who typed each figure a coach typed (S2), named in one read — only where the typed figure is the answer.
    const typists = [...new Set(goals
      .filter((goal) => !yearToDate.get(goal.membershipId))
      .map(typistIdOf)
      .filter((id): id is string => id !== null))];
    const named = typists.length ? await this.names.byMembershipId(ctx, typists) : new Map<string, string>();
    const typistOfGoal = (goal: GoalDocument): GoalTypist | null => {
      const by = typistIdOf(goal);
      return by === null ? null : { membershipId: by, name: named.get(by) ?? null };
    };
    return new Map(ids.map((id) => {
      const goal = byMember.get(id);
      const held = yearToDate.get(id) ?? null;
      /*
       * **The office's figure wins here, whenever it holds one** (ADR-0195 §4, kept by ADR-0230 §7): these are the leaders'
       * and the office's reads, which never read a typed figure over it — `achievedOf`, not `memberAchievedOf`.
       */
      const official = officialOf(held);
      return [id, goal
        ? this.view(goal, day, { achieved: achievedOf(held, goal.apeAchievedMinor, held ? null : typistOfGoal(goal)), official }, null, binding)
        : this.defaultsView(period, day, { achieved: achievedOf(held, 0), official }, null, rates, binding)];
    }));
  }

  /** The caller's own goal for a period. 404 for another office's, never 403. */
  async read(ctx: RequestContext, period: string, forMembershipId?: string): Promise<GoalView> {
    const membershipId = await this.subject(ctx, forMembershipId, 'goal:read');
    const goal = await this.goals.findOne(ctx, { membershipId, period });
    if (!goal) throw new NotFoundException('Goal');
    const day = await this.days.for(ctx);
    return this.view(
      goal, day, await this.achievedFor(ctx, membershipId, period, goal),
      await this.measuring(ctx, membershipId, day), await this.binding(ctx),
    );
  }

  /**
   * A period that has ended is not the agent's to rewrite (AC-1, ADR-0042).
   *
   * **Past only.** Last year's plan is what a leader coached against and what a promotion case
   * cites; rewriting it would make both of those claims about a target that never existed.
   * Re-planning the **current** period is ordinary, and a **future** one is somebody planning
   * ahead — refusing that would be a rule about tidiness rather than about evidence.
   *
   * The boundary is the office's year, not the server's (invariant §9).
   */
  private requireOpenPeriod(period: string, day: OfficeDay): void {
    const thisYear = day.today.slice(0, 4);
    if (period >= thisYear) return;
    throw new DomainException(
      ErrorCode.GOAL_PERIOD_LOCKED,
      GOAL_REFUSALS.GOAL_PERIOD_LOCKED.ended({ period, thisYear }),
      HttpStatus.CONFLICT,
      { period, currentPeriod: thisYear },
    );
  }

  /**
   * The caller's own goals, newest period first. **No route serves it, and none has:** the history
   * card read its own endpoint, and both went in P10.1-T6. The specs read every period through it,
   * which is how they pin that a list recomputes exactly as a read does.
   */
  async list(ctx: RequestContext): Promise<GoalView[]> {
    const membershipId = this.me(ctx);
    const day = await this.days.for(ctx);
    const rows = await this.goals.find(ctx, { membershipId }, { sort: { period: -1 } });
    const [activity, binding] = await Promise.all([this.activityFor(ctx, membershipId, day), this.binding(ctx)]);
    return Promise.all(rows.map(async (row) => this.view(
      row, day, await this.achievedFor(ctx, membershipId, row.period, row), activity, binding,
    )));
  }

  /**
   * What an office starts somebody on, before they have agreed anything.
   *
   * Not a stored goal — nothing is written. It is the defaults the screen opens with, from
   * `GOAL_DEFAULTS`, so the constants have exactly one home (invariant §7) and the screen does not
   * carry a second copy of them — but for the two conversion percentages, which are the office's own
   * benchmarks where it has them (ADR-0160 §3, `officeRates`).
   */
  async defaults(
    ctx: RequestContext, period: string, membershipId: string = this.me(ctx),
  ): Promise<Omit<GoalView, 'id' | 'membershipId' | 'version'>> {
    const day = await this.days.for(ctx);
    // Nobody has typed anything yet, so the carrier's figure, if there is one, is the whole answer.
    const [achieved, rates, activity, binding] = await Promise.all([
      this.achievedFor(ctx, membershipId, period, null),
      this.officeRates(ctx),
      this.measuring(ctx, membershipId, day),
      this.binding(ctx),
    ]);
    return this.defaultsView(period, day, achieved, activity, rates, binding);
  }

  /** The defaults as a view, from what `defaults` read — and what `plansOf` read in bulk. */
  private defaultsView(
    period: string, day: OfficeDay, { achieved, official }: Achieved, activity: ActivityWindow | null,
    rates: Pick<CascadeInputs, 'leadsToApptPct' | 'closingRatePct'>, binding: CascadeBinding,
  ): Omit<GoalView, 'id' | 'membershipId' | 'version'> {
    const inputs = {
      mode: 'direct' as const,
      annualApeTargetMinor: GOAL_DEFAULTS.ANNUAL_APE_TARGET_MINOR,
      savingsTargetMinor: GOAL_DEFAULTS.ANNUAL_SAVINGS_TARGET_MINOR,
      commissionRatePct: GOAL_DEFAULTS.COMMISSION_RATE_PCT,
      // Derived in the **office's** timezone (AC-5, invariant §9), and overridable the moment the
      // agent types over it: somebody starting in November knows something the calendar does not.
      monthsLeft: defaultMonthsLeft(period, this.clock.now(), day.timezone),
      monthsLeftIsOverride: false,
      apeAchievedMinor: 0,
      caseSizeMinor: GOAL_DEFAULTS.CASE_SIZE_MINOR,
      // The office's benchmarks, or `GOAL_DEFAULTS` (ADR-0160 §3): the agent's to change from here (ADR-0048).
      ...rates,
    };

    return {
      period,
      ...inputs,
      achieved,
      official,
      // Nothing has been agreed, so there is nothing to snapshot — but the cascade still runs, or
      // the screen would open on five empty cards.
      snapshot: { ...EMPTY_SNAPSHOT },
      projected: computeCascade({ ...inputs, apeAchievedMinor: achieved.minor }),
      // Nothing saved, so nothing recorded: the binding's first codes today, and the binding itself.
      cascadeMapping: mappingOf(binding),
      cascadeBinding: copyOf(binding),
      measured: this.measured(activity, binding),
      savedAt: null,
      apeAchievedTypedAt: null,
      savedByMembershipId: null,
    };
  }

  private view(
    doc: GoalDocument, day: OfficeDay, { achieved, official }: Achieved, activity: ActivityWindow | null,
    binding: CascadeBinding,
  ): GoalView {
    /*
     * **Every read recomputes** (AC-1b). The stored snapshot is the agreement; this is what it
     * means today, and it is what every screen renders.
     *
     * **A read never throws on a stored assumption.** The write refuses one by name, so the only
     * way a bad one reaches here is a row older than the rule — and a read that threw would lock
     * its agent out of the screen they would fix it on. `null`, and the inputs come back regardless.
     */
    const monthsLeft = doc.monthsLeftOverride
      ?? defaultMonthsLeft(doc.period, this.clock.now(), day.timezone);
    const projected = projectionOf({ ...doc.toObject(), monthsLeft, apeAchievedMinor: achieved.minor });

    return {
      id: String(doc._id),
      membershipId: doc.membershipId,
      period: doc.period,
      mode: doc.mode,
      annualApeTargetMinor: doc.annualApeTargetMinor,
      savingsTargetMinor: doc.savingsTargetMinor,
      commissionRatePct: doc.commissionRatePct,
      monthsLeft,
      monthsLeftIsOverride: doc.monthsLeftOverride !== null,
      apeAchievedMinor: doc.apeAchievedMinor,
      achieved,
      official,
      caseSizeMinor: doc.caseSizeMinor,
      leadsToApptPct: doc.leadsToApptPct,
      closingRatePct: doc.closingRatePct,
      /*
       * **No fallback here, because the schema is the fallback.** Both subdocuments are `required`
       * with a default, and Mongoose applies that on **hydration** — so even a row written before
       * the field existed reads with it filled in. A `?? 0` per field, or a ternary per
       * subdocument, would be branches nothing can take: declared twice, reachable once.
       *
       * Read field by field rather than spread: these are Mongoose subdocuments, and spreading one
       * yields its internals rather than its values — quietly, as zeroes.
       */
      snapshot: {
        monthlyApeTargetMinor: doc.snapshot.monthlyApeTargetMinor,
        policiesPerMonth: doc.snapshot.policiesPerMonth,
        appointmentsPerMonth: doc.snapshot.appointmentsPerMonth,
        leadsPerMonth: doc.snapshot.leadsPerMonth,
      },
      projected,
      cascadeMapping: {
        leadsCode: doc.cascadeMapping.leadsCode,
        appointmentsCode: doc.cascadeMapping.appointmentsCode,
        closingsCode: doc.cascadeMapping.closingsCode,
      },
      // What the columns count today: the office's binding, not the record above (ADR-0163 §4).
      cascadeBinding: copyOf(binding),
      measured: this.measured(activity, binding),
      savedAt: doc.savedAt ? doc.savedAt.toISOString() : null,
      apeAchievedTypedAt: doc.apeAchievedTypedAt ? doc.apeAchievedTypedAt.toISOString() : null,
      savedByMembershipId: doc.savedByMembershipId,
      version: doc.version,
    };
  }

  /**
   * Tell the agent their goal was set for them (AC-7, §3.6).
   *
   * **The attribution says who; this says that it happened.** A banner only reaches somebody who
   * opens the screen, and the person most likely not to open it is the one who did not know there
   * was anything new on it.
   *
   * **One notice per save, or one per coaching session** (P11-T8; `functional/coaching.md`, *One notice
   * per session*). A save from Goal Settings is its own notice, on both channels at once: a whole plan
   * saved deliberately is news each time. A save through a session coalesces under the session's key —
   * the first in the round is delivered in-app with its email held, each later one updates that notice to
   * the last value and marks it unread again, and finalize sends the email once.
   *
   * **A failure here never fails the save** (P11-T8 AC-4). The goal is agreed either way, and losing a
   * plan because the preferences read, the notifications write or an SMTP host failed would be the worse
   * outcome — so anything thrown is logged at error level and the save answers 200.
   */
  private async announce(
    ctx: RequestContext, subjectMembershipId: string, byMembershipId: string, saved: GoalDocument,
    coalesceKey: string | null,
  ): Promise<void> {
    try {
      const member = await this.memberships.findById(ctx, subjectMembershipId);
      if (!member) return;
      const named = await this.names.byMembershipId(ctx, [byMembershipId]);
      const byName = named.get(byMembershipId) ?? null;

      if (coalesceKey === null) {
        await this.notifications.send({
          userId: String(member.userId),
          kpmId: ctx.kpmId,
          membershipId: subjectMembershipId,
          templateId: NotificationTemplate.GOAL_SET_BY_LEADER,
          payload: { byName, period: saved.period },
        });
        return;
      }
      await this.notifications.sendCoalesced({
        userId: String(member.userId),
        kpmId: ctx.kpmId as string,
        membershipId: subjectMembershipId,
        templateId: NotificationTemplate.GOAL_SET_BY_LEADER,
        coalesceKey,
        // The last value: what the notice — and the email finalize sends — says.
        payload: { byName, period: saved.period, annualApeTargetMinor: saved.annualApeTargetMinor },
      });
    } catch (err) {
      this.logger.error({ err, goalId: String(saved._id), coalesceKey }, 'failed to notify the member of a goal set for them');
    }
  }

  private async record(
    ctx: RequestContext, action: string, targetId: string, after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(ctx, { action, targetCollection: 'goals', targetId, after });
  }
}
