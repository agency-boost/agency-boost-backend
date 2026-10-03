import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { LocalDate } from '@/common/time/local-day';
import {
  ACTIVATION_LINK_KINDS, type ActivationFeatureLink,
} from '@/domain/constants';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { GoalRepository } from '@/modules/goals/goal.repository';
import { LeadReadings } from '@/modules/leads/lead-readings';
import { activityWeeksCompletedOn, freshItemState, officeMondayOf } from './activation-rules';
import type {
  ActivationProgressDocument, ActivationRecordCollection,
} from './activation-progress.schema';
import { ActivationProgressRepository } from './activation-progress.repository';

/** One open activation to evaluate, with the pinned version's items and their links. */
export interface EvaluationTarget {
  doc: ActivationProgressDocument;
  items: readonly { code: string; autoLink: string | null }[];
}

/** What completed an item: when, by whom, and the record. */
interface Completion {
  at: Date;
  byMembershipId: string;
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

/** A feature link whose evaluator exists: the only kinds this engine completes (P13-T3 AC-1). */
export function isLiveFeatureLink(link: string | null): link is ActivationFeatureLink {
  return link !== null
    && Object.prototype.hasOwnProperty.call(ACTIVATION_LINK_KINDS, link)
    && ACTIVATION_LINK_KINDS[link as ActivationFeatureLink].live;
}

/**
 * **The auto-completion engine** (P13-T3; ADR-0031, D-links): the three feature links, evaluated against
 * the records the hire's office holds.
 *
 * - **`feature:goals`** — any goal saved on the hire's membership, by them or by a leader with `?for=`
 *   (ADR-0046), attributed to whoever saved it.
 * - **`feature:leads`** — any lead in the hire's pipeline, of either type, created by them or by a leader
 *   in a session (ADR-0076), attributed to whoever added it.
 * - **`feature:activity`** — `ACTIVATION_ACTIVITY_WEEKS` consecutive Monday-to-Sunday office weeks from
 *   the start date, each with a day logged above zero; an all-zero day counts for none, a corrected day
 *   as corrected (ADR-0042).
 *
 * **By code, never by position** (invariant §4): whichever items of the pinned version bind a kind are the
 * items it completes, so an office that moves `feature:goals` to another item sees that one complete.
 * **Sticky**: an item done stays done when its goal is replaced, its lead deleted or its week corrected to
 * zero — the write only ever sets `done` on an item that is not. **Open activations only**: the caller
 * passes nothing else.
 *
 * **Bounded reads** (AC-7): one query per kind for every target at once, through the seams that exist —
 * `LeadReadings`, `ActivityReadings`, and the goals repository — within the office, and none at all for a
 * kind no target is still waiting on.
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
  ) {}

  /** Each target, as it stands after its newly met links are written — the same order, and the same document when nothing changed. */
  async evaluate(
    ctx: RequestContext, targets: readonly EvaluationTarget[], timezone: string,
  ): Promise<ActivationProgressDocument[]> {
    const waiting = targets.map(({ doc, items }) => {
      const done = new Set(doc.items.filter((i) => i.done).map((i) => i.code));
      return items.filter((item) => isLiveFeatureLink(item.autoLink) && !done.has(item.code));
    });
    const whoWaitsOn = (kind: ActivationFeatureLink) => targets
      .filter((_, i) => waiting[i].some((item) => item.autoLink === kind))
      .map((t) => t.doc);

    const onGoals = whoWaitsOn('feature:goals');
    const onLeads = whoWaitsOn('feature:leads');
    const onActivity = whoWaitsOn('feature:activity');
    const [goals, leads, days] = await Promise.all([
      this.latestGoals(ctx, onGoals.map((d) => d.membershipId)),
      this.leads.latestOfMany(ctx, onLeads.map((d) => d.membershipId)),
      onActivity.length === 0
        ? new Map<string, { date: LocalDate; id: string; byMembershipId: string }[]>()
        : this.activity.activeDaysOfMany(
          ctx, onActivity.map((d) => d.membershipId), onActivity.map((d) => d.startDate).sort()[0],
        ),
    ]);

    const mondayOf = officeMondayOf(this.clock, timezone);
    const now = this.clock.now();
    const completionOf = (kind: ActivationFeatureLink, doc: ActivationProgressDocument): Completion | null => {
      switch (kind) {
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
        .map((item) => ({ code: item.code, completion: completionOf(item.autoLink as ActivationFeatureLink, doc) }))
        .filter((m): m is { code: string; completion: Completion } => m.completion !== null);
      if (met.length === 0) return doc;
      if (ctx.impersonationReadOnly) return withCompletions(doc, met);

      await this.ensureRows(ctx, doc, met.map((m) => m.code));
      const set: Record<string, unknown> = {};
      const arrayFilters: Record<string, unknown>[] = [];
      met.forEach(({ code, completion }, n) => {
        const at = `items.$[i${n}]`;
        set[`${at}.done`] = true;
        set[`${at}.doneAt`] = completion.at;
        set[`${at}.source`] = 'link';
        set[`${at}.doneByMembershipId`] = completion.byMembershipId;
        set[`${at}.recordCollection`] = completion.recordCollection;
        set[`${at}.recordId`] = completion.recordId;
        // `done: false` in the filter: a link already met, by a write racing this one, is never rewritten.
        arrayFilters.push({ [`i${n}.code`]: code, [`i${n}.done`]: false });
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
