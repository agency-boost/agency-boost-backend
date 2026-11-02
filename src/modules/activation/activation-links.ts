import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { LocalDate } from '@/common/time/local-day';
import {
  ACTIVATION_INDEPENDENT_CLOSINGS, ACTIVATION_LINK_KINDS, ACTIVATION_TRAINING_LINK, ACTIVATION_WEEKLY_CHECK_INS,
  isActivationDataLink, type ActivationFeatureLink, type ActivationNamedLink,
} from '@/domain/constants';
import { firstSaleOf, nthClosingOf, type SaleEvidence } from '@/domain/metrics/first-sale';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { CoachingReadings } from '@/modules/coaching/coaching-readings';
import { GoalRepository } from '@/modules/goals/goal.repository';
import { LeadReadings, type LeadClosing } from '@/modules/leads/lead-readings';
import { ProductionReadings } from '@/modules/production/production-readings';
import { TrainingProgressReadings } from '@/modules/training/training-progress-readings';
import { trainingLinkModuleCode } from './activation-input';
import { activityWeeksCompletedOn, freshItemState, nthOneOnOne, officeMondayOf } from './activation-rules';
import type {
  ActivationProgressDocument, ActivationRecordCollection,
} from './activation-progress.schema';
import { ActivationProgressRepository } from './activation-progress.repository';

/** One open activation to evaluate, with the pinned version's items and their links. */
export interface EvaluationTarget {
  doc: ActivationProgressDocument;
  items: readonly { code: string; autoLink: string | null }[];
}

/** What completed an item: when, by whom — nobody, for the production file's month — and the record. */
interface Completion {
  at: Date;
  byMembershipId: string | null;
  recordCollection: ActivationRecordCollection;
  recordId: string;
}

/**
 * **The links met, on a copy that is never written** (N3): each item done as the write would set it, a row
 * added in memory where the activation has none. The stored row is not touched.
 */
function withCompletions(
  doc: ActivationProgressDocument, met: readonly { code: string; completion: Completion }[],
): ActivationProgressDocument {
  const copy = doc.$clone();
  for (const { code, completion } of met) {
    if (!copy.items.some((i) => i.code === code)) copy.items.push(freshItemState(code));
    Object.assign(copy.items.find((i) => i.code === code)!, {
      done: true,
      doneAt: completion.at,
      source: 'link',
      doneByMembershipId: completion.byMembershipId,
      recordCollection: completion.recordCollection,
      recordId: completion.recordId,
    });
  }
  return copy;
}

/** A feature link whose evaluator exists (P13-T3 AC-1). */
export function isLiveFeatureLink(link: string | null): link is ActivationFeatureLink {
  return link !== null
    && Object.prototype.hasOwnProperty.call(ACTIVATION_LINK_KINDS, link)
    && ACTIVATION_LINK_KINDS[link as ActivationFeatureLink].live;
}

/** The module a live training link binds, or `null` for anything else (P18.5-T3 AC-1). */
export function liveTrainingModule(link: string | null): string | null {
  const code = trainingLinkModuleCode(link);
  return code && ACTIVATION_TRAINING_LINK.live ? code : null;
}

/** A link this engine completes: a live feature link, a live training link, or — since P18.96-T4 — a data kind. */
function isEvaluated(link: string | null): boolean {
  return isLiveFeatureLink(link) || liveTrainingModule(link) !== null || isActivationDataLink(link);
}

/**
 * **What an item still waits on its link for** (P18.96-T4 AC-4): an item not done — and **a data-backed item ticked by
 * hand**, whose tick reads *waiting for data* until its data confirms it; the evaluation then attributes it to the
 * link and the tick is replaced, as a link's completion is never replaced. Any other done item is the engine's no more.
 */
function stillWaits(state: { done: boolean; source: string | null } | undefined, link: string | null): boolean {
  if (!state?.done) return true;
  return isActivationDataLink(link) && state.source !== 'link';
}

/**
 * **The auto-completion engine** (P13-T3; ADR-0031, D-links): the three feature links and — since P18.5-T3 —
 * every training link, evaluated against the records the hire's office holds.
 *
 * - **`feature:goals`** — any goal saved on the hire's membership, by them or by a leader with `?for=`
 *   (ADR-0046), attributed to whoever saved it.
 * - **`feature:leads`** — any lead in the hire's pipeline, of either type, created by them or by a leader
 *   in a session (ADR-0076), attributed to whoever added it.
 * - **`feature:activity`** — `ACTIVATION_ACTIVITY_WEEKS` consecutive Monday-to-Sunday office weeks from
 *   the start date, each with a day logged above zero; an all-zero day counts for none, a corrected day
 *   as corrected (ADR-0042).
 * - **`training:<moduleCode>`** (P18.5-T3 AC-2) — the hire's `trainingProgress` row for that module is `done`,
 *   attributed to the hire (only they write it), at its `completedAt`. Whether the module is still offered
 *   does not matter here: a `done` record made earlier still completes it (D-orphan); being offered decides
 *   only whether the item may also be ticked by hand (`mayTickByHand`).
 *
 * - **`sales:first`, `sales:closings:3`, `coaching:weekly:4`** (P18.96-T4 AC-2, ADR-0171 §3) — the platform's three
 *   data-backed items, bound by their codes (`effectiveAutoLink`): the hire's first sale since joining, from the data
 *   (`firstSaleOf` with `dataOnly` — a sales lead the leads flow took to *Paid and issued*, else the production file's
 *   first month with a policy); the `ACTIVATION_INDEPENDENT_CLOSINGS`th sales lead the leads flow took to *Paid and
 *   issued* since joining (`nthClosingOf`, leads only); and the `ACTIVATION_WEEKLY_CHECK_INS`th 1:1 with the hire
 *   finalized since joining (`nthOneOnOne`), attributed to its coach. **A hand tick of one is waiting for data**
 *   (`stillWaits`) and is replaced by the link the read its data appears on (AC-4).
 *
 * **By code, never by position** (invariant §4): whichever items of the pinned version bind a kind are the
 * items it completes, so an office that moves `feature:goals` to another item sees that one complete.
 * **Sticky**: an item done stays done when its goal is replaced, its lead deleted or its week corrected to
 * zero — the write only ever sets `done` on an item that is not. **Open activations only**: the caller
 * passes nothing else.
 *
 * **Bounded reads** (AC-7): one query per kind for every target at once, through the seams that exist —
 * `LeadReadings`, `ActivityReadings`, `TrainingProgressReadings`, the goals repository and, since P18.96-T4,
 * `ProductionReadings` and `CoachingReadings` — within the office,
 * and none at all for a kind no target is still waiting on (P18.5-T3 AC-7: one progress query for every
 * training item waiting, skipped when none is).
 *
 * **A read-only support session writes nothing** (the Phase 13 exit review, N3): it is answered the links
 * met, applied to a copy of the stored row in memory, so its page shows what its member's would; the row
 * itself waits for the member's own next read, or the next write that signals the engine.
 */
@Injectable()
export class ActivationLinkEngine {
  constructor(
    private readonly progress: ActivationProgressRepository,
    private readonly goals: GoalRepository,
    private readonly leads: LeadReadings,
    private readonly activity: ActivityReadings,
    private readonly clock: Clock,
    // P18.5-T3: the training kind's records, through training's own port.
    private readonly training: TrainingProgressReadings,
    // P18.96-T4: the data kinds' records — the production file's policies and the coaching sessions.
    private readonly production: ProductionReadings,
    private readonly coaching: CoachingReadings,
  ) {}

  /** Each target, as it stands after its newly met links are written — the same order, and the same document when nothing changed. */
  async evaluate(
    ctx: RequestContext, targets: readonly EvaluationTarget[], timezone: string,
  ): Promise<ActivationProgressDocument[]> {
    const waiting = targets.map(({ doc, items }) => {
      const states = new Map(doc.items.map((i) => [i.code, i] as const));
      return items.filter((item) => isEvaluated(item.autoLink) && stillWaits(states.get(item.code), item.autoLink));
    });
    const whoWaitsOn = (...kinds: ActivationNamedLink[]) => targets
      .filter((_, i) => waiting[i].some((item) => (kinds as (string | null)[]).includes(item.autoLink)))
      .map((t) => t.doc);

    const onGoals = whoWaitsOn('feature:goals');
    const onLeads = whoWaitsOn('feature:leads');
    const onActivity = whoWaitsOn('feature:activity');
    // P18.96-T4: one read of closings and one of the file for every target still waiting on a sale, one of sessions.
    const onSales = whoWaitsOn('sales:first', 'sales:closings:3');
    const onCoaching = whoWaitsOn('coaching:weekly:4');
    // Every training item still waiting, across every target: one query for their modules' `done` rows.
    const trainingWaits = waiting.flatMap((items, i) => items
      .map((item) => liveTrainingModule(item.autoLink))
      .filter((code): code is string => code !== null)
      .map((code) => ({ membershipId: targets[i].doc.membershipId, code })));
    const [goals, leads, days, trainingDone, closings, fileMonths, oneOnOnes] = await Promise.all([
      this.latestGoals(ctx, onGoals.map((d) => d.membershipId)),
      this.leads.latestOfMany(ctx, onLeads.map((d) => d.membershipId)),
      onActivity.length === 0
        ? new Map<string, { date: LocalDate; id: string; byMembershipId: string }[]>()
        : this.activity.activeDaysOfMany(
          ctx, onActivity.map((d) => d.membershipId), onActivity.map((d) => d.startDate).sort()[0],
        ),
      trainingWaits.length === 0
        ? []
        : this.training.rowsOf(
          ctx, trainingWaits.map((w) => w.membershipId),
          { moduleCodes: trainingWaits.map((w) => w.code), status: 'done' },
        ),
      onSales.length === 0 ? new Map<string, LeadClosing[]>() : this.leads.closingsOfMany(ctx, onSales.map((d) => d.membershipId)),
      onSales.length === 0
        ? new Map<string, { month: string; id: string; policies: number }[]>()
        : this.production.policyMonthsOfMany(ctx, onSales.map((d) => d.membershipId)),
      onCoaching.length === 0
        ? []
        : this.coaching.countedSince(ctx, onCoaching.map((d) => d.membershipId), onCoaching.map((d) => d.startDate).sort()[0]),
    ]);
    const doneModule = new Map(trainingDone.map((row) => [`${row.membershipId}|${row.moduleCode}`, row]));

    const mondayOf = officeMondayOf(this.clock, timezone);
    const now = this.clock.now();
    /** The start of an office day, as the instant a completion read from a day is stamped with — never after now. */
    const dayStart = (date: LocalDate): Date => {
      const start = this.clock.startOfLocalDay(timezone, date);
      return start < now ? start : now;
    };
    /** A target's sales, as `firstSaleOf` reads them: its closings in the office's calendar, and its file months. */
    const salesOf = (doc: ActivationProgressDocument): { evidence: SaleEvidence; byLead: Map<string, LeadClosing> } => {
      const own = closings.get(doc.membershipId) ?? [];
      return {
        evidence: {
          joinDate: doc.startDate,
          closings: own.map((c) => ({ date: this.clock.localDateFor(timezone, c.at), recordId: c.leadId, logged: c.logged })),
          fileMonths: (fileMonths.get(doc.membershipId) ?? []).map((m) => ({ month: m.month, recordId: m.id, policies: m.policies })),
        },
        byLead: new Map(own.map((c) => [c.leadId, c])),
      };
    };
    /** A sale read from the data: a closing, at the instant it reached *Paid and issued*, or the file's month. */
    const saleCompletion = (
      found: { recordCollection: 'leads' | 'monthlyAgentData'; recordId: string; date: LocalDate } | null,
      byLead: Map<string, LeadClosing>,
    ): Completion | null => {
      if (!found) return null;
      const lead = found.recordCollection === 'leads' ? byLead.get(found.recordId) : undefined;
      return lead
        ? { at: lead.at, byMembershipId: lead.byMembershipId, recordCollection: 'leads', recordId: lead.leadId }
        : { at: dayStart(found.date), byMembershipId: null, recordCollection: 'monthlyAgentData', recordId: found.recordId };
    };
    const completionOf = (link: string, doc: ActivationProgressDocument): Completion | null => {
      const moduleCode = liveTrainingModule(link);
      if (moduleCode !== null) {
        const row = doneModule.get(`${doc.membershipId}|${moduleCode}`);
        // Only the hire writes their own progress (no route takes a subject), so the hire is who completed it.
        return row
          ? { at: row.completedAt ?? now, byMembershipId: doc.membershipId, recordCollection: 'trainingProgress', recordId: row.id }
          : null;
      }
      switch (link as ActivationNamedLink) {
        /*
         * P18.96-T4 AC-2 (ADR-0171 §3): the data kinds, **from the data** — a closing logged by a hand tick is that
         * tick's record, and not what confirms it (`firstSaleOf`'s `dataOnly`). Since the join date, the start.
         */
        case 'sales:first': {
          const { evidence, byLead } = salesOf(doc);
          return saleCompletion(firstSaleOf(evidence, { dataOnly: true }), byLead);
        }
        case 'sales:closings:3': {
          const { evidence, byLead } = salesOf(doc);
          return saleCompletion(nthClosingOf(evidence, ACTIVATION_INDEPENDENT_CLOSINGS), byLead);
        }
        case 'coaching:weekly:4': {
          const fourth = nthOneOnOne(
            oneOnOnes.filter((s) => s.coacheeMembershipId === doc.membershipId), doc.startDate, ACTIVATION_WEEKLY_CHECK_INS,
          );
          return fourth
            ? { at: dayStart(fourth.date), byMembershipId: fourth.coachMembershipId, recordCollection: 'coachingSessions', recordId: fourth.sessionId }
            : null;
        }
        case 'feature:goals': {
          const goal = goals.get(doc.membershipId);
          return goal ? { at: goal.at, byMembershipId: goal.byMembershipId, recordCollection: 'goals', recordId: goal.id } : null;
        }
        case 'feature:leads': {
          const lead = leads.get(doc.membershipId);
          return lead ? { at: lead.at, byMembershipId: lead.byMembershipId, recordCollection: 'leads', recordId: lead.id } : null;
        }
        case 'feature:activity': {
          const since = (days.get(doc.membershipId) ?? []).filter((d) => d.date >= doc.startDate);
          const day = activityWeeksCompletedOn(since, mondayOf);
          return day ? { at: now, byMembershipId: day.byMembershipId, recordCollection: 'activityLogs', recordId: day.id } : null;
        }
      }
    };

    return Promise.all(targets.map(async ({ doc }, i) => {
      const met = waiting[i]
        .map((item) => ({ code: item.code, data: isActivationDataLink(item.autoLink), completion: completionOf(item.autoLink!, doc) }))
        .filter((m): m is { code: string; data: boolean; completion: Completion } => m.completion !== null);
      if (met.length === 0) return doc;
      if (ctx.impersonationReadOnly) return withCompletions(doc, met);

      await this.ensureRows(ctx, doc, met.map((m) => m.code));
      const set: Record<string, unknown> = {};
      const arrayFilters: Record<string, unknown>[] = [];
      met.forEach(({ code, data, completion }, n) => {
        const at = `items.$[i${n}]`;
        set[`${at}.done`] = true;
        set[`${at}.doneAt`] = completion.at;
        set[`${at}.source`] = 'link';
        set[`${at}.doneByMembershipId`] = completion.byMembershipId;
        set[`${at}.recordCollection`] = completion.recordCollection;
        set[`${at}.recordId`] = completion.recordId;
        /*
         * Never over a link already met, by a write racing this one: `done: false` — or, for a data-backed item ticked
         * by hand and *waiting for data* (P18.96-T4 AC-4), any source but the link's, which this replaces.
         */
        arrayFilters.push(data
          ? { [`i${n}.code`]: code, [`i${n}.source`]: { $ne: 'link' } }
          : { [`i${n}.code`]: code, [`i${n}.done`]: false });
      });
      const updated = await this.progress.updateItems(
        ctx, { _id: doc._id, graduatedAt: null }, { $set: set }, arrayFilters,
      );
      return updated ?? doc;
    }));
  }

  /**
   * **A row for each named item**, added where the activation has none — an activation is written with
   * every item of its version, so this is a backstop for a row written before that, never the rule. A
   * write to an item addresses its row by code, and a row that is not there cannot be addressed.
   */
  async ensureRows(ctx: RequestContext, doc: ActivationProgressDocument, codes: readonly string[]): Promise<void> {
    const held = new Set(doc.items.map((i) => i.code));
    const missing = codes.filter((code) => !held.has(code));
    if (missing.length === 0) return;
    await this.progress.updateItems(
      ctx,
      { _id: doc._id, 'items.code': { $nin: missing } },
      { $push: { items: { $each: missing.map(freshItemState) } } },
    );
  }

  /** Each member's most recently saved goal, any period: what completed `feature:goals`, and who saved it. */
  private async latestGoals(
    ctx: RequestContext, membershipIds: readonly string[],
  ): Promise<Map<string, { id: string; at: Date; byMembershipId: string }>> {
    const out = new Map<string, { id: string; at: Date; byMembershipId: string }>();
    if (membershipIds.length === 0) return out;
    const rows = await this.goals.aggregate(ctx, [
      { $match: { membershipId: { $in: [...new Set(membershipIds)] } } },
      { $sort: { savedAt: -1, _id: -1 } },
      {
        $group: {
          _id: '$membershipId',
          id: { $first: '$_id' },
          at: { $first: { $ifNull: ['$savedAt', '$createdAt'] } },
          by: { $first: { $ifNull: ['$savedByMembershipId', '$membershipId'] } },
        },
      },
    ]);
    for (const row of rows) {
      out.set(String(row._id), { id: String(row.id), at: row.at as Date, byMembershipId: String(row.by) });
    }
    return out;
  }
}
