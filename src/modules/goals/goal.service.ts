import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import { AuditService } from '@/modules/audit/audit.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
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
function projectionOf(doc: GoalDocument): CascadeResult | null {
  try {
    return computeCascade(doc as never);
  } catch {
    return null;
  }
}

/** A plan nobody has agreed figures for yet. Also what a row written before the field reads as. */
const EMPTY_SNAPSHOT: GoalSnapshotView = {
  monthlyApeTargetMinor: 0, policiesPerMonth: 0, appointmentsPerMonth: 0, leadsPerMonth: 0,
};

/** One goal, as a caller reads it. */
export interface GoalView {
  id: string;
  membershipId: string;
  period: string;
  mode: GoalMode;
  annualApeTargetMinor: number;
  savingsTargetMinor: number;
  commissionRatePct: number;
  monthsLeft: number;
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
  ) {}

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
  async save(ctx: RequestContext, body: unknown): Promise<GoalView> {
    const membershipId = this.me(ctx);
    const input = checkGoal(body);
    const now = this.clock.now();
    // Refuses an unusable assumption before anything is written (AC-7).
    const agreed = computeCascade(input as never);

    const saved = await this.goals.upsertOne(
      ctx,
      { membershipId, period: input.period! },
      {
        $set: {
          mode: input.mode!,
          annualApeTargetMinor: input.annualApeTargetMinor!,
          savingsTargetMinor: input.savingsTargetMinor!,
          commissionRatePct: input.commissionRatePct!,
          monthsLeft: input.monthsLeft!,
          apeAchievedMinor: input.apeAchievedMinor!,
          caseSizeMinor: input.caseSizeMinor!,
          leadsToApptPct: input.leadsToApptPct!,
          closingRatePct: input.closingRatePct!,
          savedAt: now,
          savedByMembershipId: membershipId,
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
      },
    );

    await this.record(
      ctx,
      saved.version === 1 ? 'goal.created' : 'goal.updated',
      String(saved._id),
      { period: saved.period, version: saved.version, savedByMembershipId: membershipId },
    );
    return this.view(saved);
  }

  /**
   * The goal for a period, or **the office's defaults** when there is none (P8-T3).
   *
   * A first-time reader opens on five filled cards rather than five empty ones, which is what the
   * prototype does and is right to: a cascade with nothing in it teaches nobody what the screen is
   * for. Nothing is written — the defaults are offered, not saved.
   */
  async readOrDefaults(
    ctx: RequestContext, period: string,
  ): Promise<Omit<GoalView, 'id' | 'membershipId' | 'version'>> {
    const membershipId = this.me(ctx);
    const goal = await this.goals.findOne(ctx, { membershipId, period });
    return goal ? this.view(goal) : this.defaults(ctx, period);
  }

  /** The caller's own goal for a period. 404 for another office's, never 403. */
  async read(ctx: RequestContext, period: string): Promise<GoalView> {
    const membershipId = this.me(ctx);
    const goal = await this.goals.findOne(ctx, { membershipId, period });
    if (!goal) throw new NotFoundException('Goal');
    return this.view(goal);
  }

  /** The caller's own goals, newest period first. What a history screen reads (P8-T6). */
  async list(ctx: RequestContext): Promise<GoalView[]> {
    const membershipId = this.me(ctx);
    const rows = await this.goals.find(ctx, { membershipId }, { sort: { period: -1 } });
    return rows.map((row) => this.view(row));
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

  private view(doc: GoalDocument): GoalView {
    /*
     * **Every read recomputes** (AC-1b). The stored snapshot is the agreement; this is what it
     * means today, and it is what every screen renders.
     *
     * **A read never throws on a stored assumption.** The write refuses one by name, so the only
     * way a bad one reaches here is a row older than the rule — and a read that threw would lock
     * its agent out of the screen they would fix it on. `null`, and the inputs come back regardless.
     */
    const projected = projectionOf(doc);

    return {
      id: String(doc._id),
      membershipId: doc.membershipId,
      period: doc.period,
      mode: doc.mode,
      annualApeTargetMinor: doc.annualApeTargetMinor,
      savingsTargetMinor: doc.savingsTargetMinor,
      commissionRatePct: doc.commissionRatePct,
      monthsLeft: doc.monthsLeft,
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

  private async record(
    ctx: RequestContext, action: string, targetId: string, after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(ctx, { action, targetCollection: 'goals', targetId, after });
  }
}
