import { HttpStatus, Injectable } from '@nestjs/common';
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
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { scopeFor, type Permission } from '@/modules/rbac/permissions';
import { CASCADE_ACTIVITY_CODES, GOAL_DEFAULTS } from '@/domain/constants';
import { computeCascade, defaultMonthsLeft, type CascadeResult } from './goal-cascade';
import { checkGoal } from './goal-input';
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
 * One plan that was agreed, current or replaced (P8-T6).
 *
 * **Whole states, newest first.** What changed between two of them is derived by whoever renders
 * it; storing a diff would only be readable against a base the reader still has, and the point of
 * keeping these is that a leader who coached against January's plan can read January's plan.
 */
export interface GoalHistoryEntry extends GoalRevisionInputs {
  version: number;
  at: string | null;
  byMembershipId: string | null;
  /** `null` when the membership resolves to nobody — a person who has since left the office. */
  byName: string | null;
  snapshot: GoalSnapshotView;
}

/** One goal, as a caller reads it. */
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
  apeAchievedMinor: number;
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
  /** The three activity **codes** the cascade counts against — never the prototype's #3, #4, #6. */
  cascadeMapping: { leadsCode: string; appointmentsCode: string; closingsCode: string };
  savedAt: string | null;
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
  constructor(
    private readonly goals: GoalRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly days: TenantDay,
    private readonly memberships: MembershipRepository,
    private readonly names: MemberNames,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Whose goal this caller may touch, for the permission the **route** declares (P8-T4).
   *
   * **Their own, always — plus whoever the grant reaches.** §3.6 is wider than §3.7's leads: an
   * office's Owner and Admin hold `own-kpm` here, because a goal carries an agent's own intentions
   * about their own production rather than a third party's personal data.
   *
   * `null` means *anybody in the office*. A leader gets the set of memberships below them; an agent
   * gets themselves; somebody holding neither grant gets **nobody**, which is fail-closed and is
   * what the first version of the equivalent for leads got wrong.
   */
  private async subjectsInScope(
    ctx: RequestContext, permission: Permission,
  ): Promise<string[] | null> {
    const me = this.me(ctx);
    const scope = scopeFor(ctx, permission);
    if (scope === 'own-kpm' || scope === 'all') return null;
    if (scope === null) return [];
    if (scope !== 'own-unit' && scope !== 'own-downline') return [me];

    const reports = await this.memberships.find(
      ctx,
      scope === 'own-unit' ? { leaderId: me } : { ancestorIds: me },
      { select: '_id' },
    );
    return [me, ...reports.map((r) => String(r._id))];
  }

  /**
   * The membership this request is about, or a 404.
   *
   * **404 and never 403** (AC-3), the same sentence that has been true of another office's data
   * since Phase 2: a leader asking after somebody outside their downline should not learn from the
   * shape of the refusal that the person exists.
   */
  private async subject(
    ctx: RequestContext, asked: string | undefined, permission: Permission,
  ): Promise<string> {
    const me = this.me(ctx);
    if (!asked || asked === me) return me;

    const reach = await this.subjectsInScope(ctx, permission);
    if (reach !== null && !reach.includes(asked)) throw new NotFoundException('Goal');
    // Resolve the membership even at `own-kpm`: without it an Owner could probe another office's
    // ids and tell a real one from an invented one by nothing at all. The leads module learned
    // this the same way, one phase earlier.
    if (!(await this.memberships.findById(ctx, asked))) throw new NotFoundException('Goal');
    return asked;
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
  async save(ctx: RequestContext, body: unknown, forMembershipId?: string): Promise<GoalView> {
    const savedBy = this.me(ctx);
    const membershipId = await this.subject(ctx, forMembershipId, 'goal:update');
    const input = checkGoal(body);
    const now = this.clock.now();
    const day = await this.days.for(ctx);
    this.requireOpenPeriod(input.period!, day);
    // The figure in force at the moment of agreement: the agent's own, or the office's calendar.
    const monthsLeft = input.monthsLeft
      ?? defaultMonthsLeft(input.period!, this.clock.now(), day.timezone);
    // Refuses an unusable assumption before anything is written (AC-7).
    const agreed = computeCascade({ ...input, monthsLeft } as never);

    /*
     * The plan this one replaces, kept whole (ADR-0042). Read before the write rather than derived
     * after it: once the upsert lands, the previous state is gone from the row it lived on.
     */
    const previous = await this.goals.findOne(ctx, { membershipId, period: input.period! });

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
          apeAchievedMinor: input.apeAchievedMinor!,
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
          cascadeMapping: { ...CASCADE_ACTIVITY_CODES },
        },
        /*
         * **Bumped on every save, including the first.** `version` starts at 0 on insert and this
         * takes it to 1, so there is no branch deciding which — and re-planning is a new version
         * rather than an overwrite (ADR-0042). What keeping the prior versions readable looks like
         * is P8-T6's; the number they will be keyed on is here.
         */
        $inc: { version: 1 },
        ...(previous ? { $push: { revisions: revisionOf(previous, now) } } : {}),
      },
    );

    await this.record(
      ctx,
      saved.version === 1 ? 'goal.created' : 'goal.updated',
      String(saved._id),
      { period: saved.period, version: saved.version, savedByMembershipId: savedBy },
    );
    // §3.6 (AC-7): an agent finding their target changed should not have to notice it.
    if (membershipId !== savedBy) await this.announce(ctx, membershipId, savedBy, saved.period);
    return this.view(saved, day);
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
    const membershipId = await this.subject(ctx, forMembershipId, 'goal:read');
    const goal = await this.goals.findOne(ctx, { membershipId, period });
    if (!goal) return this.defaults(ctx, period);
    return this.view(goal, await this.days.for(ctx));
  }

  /** The caller's own goal for a period. 404 for another office's, never 403. */
  async read(ctx: RequestContext, period: string, forMembershipId?: string): Promise<GoalView> {
    const membershipId = await this.subject(ctx, forMembershipId, 'goal:read');
    const goal = await this.goals.findOne(ctx, { membershipId, period });
    if (!goal) throw new NotFoundException('Goal');
    return this.view(goal, await this.days.for(ctx));
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
      `${period} has ended. Its plan is what was agreed at the time and stays as it was; `
      + `set a plan for ${thisYear} instead.`,
      HttpStatus.CONFLICT,
      { period, currentPeriod: thisYear },
    );
  }

  /**
   * Every plan agreed for a period, newest first (AC-3).
   *
   * **Whole states, not a diff.** What changed is derived by whoever renders it, from two states
   * it holds — and a reader who wants only *what did we agree in January* gets it without
   * reconstructing anything.
   */
  async history(
    ctx: RequestContext, period: string, forMembershipId?: string,
  ): Promise<GoalHistoryEntry[]> {
    const membershipId = await this.subject(ctx, forMembershipId, 'goal:read');
    const goal = await this.goals.findOne(ctx, { membershipId, period });
    if (!goal) return [];

    const names = await this.names.byMembershipId(ctx, [
      ...goal.revisions.map((r) => r.byMembershipId),
      goal.savedByMembershipId ?? '',
    ]);
    const entry = (
      version: number, at: Date | null, by: string | null, inputs: GoalRevisionInputs,
      snapshot: GoalSnapshotView,
    ): GoalHistoryEntry => ({
      version,
      at: at ? at.toISOString() : null,
      byMembershipId: by,
      byName: by ? names.get(by) ?? null : null,
      ...inputs,
      snapshot,
    });

    return [
      entry(goal.version, goal.savedAt, goal.savedByMembershipId, inputsOf(goal), {
        monthlyApeTargetMinor: goal.snapshot.monthlyApeTargetMinor,
        policiesPerMonth: goal.snapshot.policiesPerMonth,
        appointmentsPerMonth: goal.snapshot.appointmentsPerMonth,
        leadsPerMonth: goal.snapshot.leadsPerMonth,
      }),
      ...[...goal.revisions].reverse().map((r) => entry(r.version, r.at, r.byMembershipId, inputsOf(r), {
        monthlyApeTargetMinor: r.snapshot.monthlyApeTargetMinor,
        policiesPerMonth: r.snapshot.policiesPerMonth,
        appointmentsPerMonth: r.snapshot.appointmentsPerMonth,
        leadsPerMonth: r.snapshot.leadsPerMonth,
      })),
    ];
  }

  /** The caller's own goals, newest period first. What a history screen reads (P8-T6). */
  async list(ctx: RequestContext): Promise<GoalView[]> {
    const membershipId = this.me(ctx);
    const day = await this.days.for(ctx);
    const rows = await this.goals.find(ctx, { membershipId }, { sort: { period: -1 } });
    return rows.map((row) => this.view(row, day));
  }

  /**
   * What an office starts somebody on, before they have agreed anything.
   *
   * Not a stored goal — nothing is written. It is the defaults the screen opens with, from
   * `GOAL_DEFAULTS`, so the constants have exactly one home (invariant §7) and the screen does not
   * carry a second copy of them.
   */
  async defaults(ctx: RequestContext, period: string): Promise<Omit<GoalView, 'id' | 'membershipId' | 'version'>> {
    const day = await this.days.for(ctx);
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
      leadsToApptPct: GOAL_DEFAULTS.LEADS_TO_APPOINTMENT_PCT,
      closingRatePct: GOAL_DEFAULTS.CLOSING_RATE_PCT,
    };

    return {
      period,
      ...inputs,
      // Nothing has been agreed, so there is nothing to snapshot — but the cascade still runs, or
      // the screen would open on five empty cards.
      snapshot: { ...EMPTY_SNAPSHOT },
      projected: computeCascade(inputs),
      cascadeMapping: { ...CASCADE_ACTIVITY_CODES },
      savedAt: null,
      savedByMembershipId: null,
    };
  }

  private view(doc: GoalDocument, day: OfficeDay): GoalView {
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
    const projected = projectionOf({ ...doc.toObject(), monthsLeft });

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
      savedAt: doc.savedAt ? doc.savedAt.toISOString() : null,
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
   * A failure here does not fail the save. The goal is agreed either way, and losing a plan because
   * an SMTP host was slow would be the worse outcome — the notification service logs its own
   * failures.
   */
  private async announce(
    ctx: RequestContext, subjectMembershipId: string, byMembershipId: string, period: string,
  ): Promise<void> {
    const member = await this.memberships.findById(ctx, subjectMembershipId);
    if (!member) return;
    const named = await this.names.byMembershipId(ctx, [byMembershipId]);

    await this.notifications.send({
      userId: String(member.userId),
      kpmId: ctx.kpmId,
      membershipId: subjectMembershipId,
      templateId: NotificationTemplate.GOAL_SET_BY_LEADER,
      payload: { byName: named.get(byMembershipId) ?? null, period },
    });
  }

  private async record(
    ctx: RequestContext, action: string, targetId: string, after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(ctx, { action, targetCollection: 'goals', targetId, after });
  }
}
