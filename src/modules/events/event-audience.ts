import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { SELECT_AUDIENCE_SCOPES, type EventAudienceScope } from '@/domain/constants';
import { memberAt, type CountedMembership } from '@/domain/metrics/office-headcount';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import type { EdgeEvent } from '@/modules/org/membership-history.schema';

/**
 * **An event's audience, as at its start** (P18.5-T5 AC-3; ADR-0039, ADR-0135, invariant §5).
 *
 * The audience is three structured facts (Phase 5): a scope and, for a *select* scope, a list of memberships. Who
 * they hold is resolved **as the office stood when the event began**, so a member who joined later never sees,
 * claims or counts in an earlier event, and a past rate does not move when somebody joins:
 *
 * - *All agents* — every membership that was a member at `startsAt` (`memberAt`, OD-24's one reading);
 * - *Leaders* — those of them leading somebody who was a member then, **by the leader edges valid then**
 *   (the graph, never the job title: OD-50, F-45);
 * - *Chosen people* / *Chosen leaders* — the list, as far as it held members then.
 *
 * **An event that has not started yet** reads the office as it is now — nobody can know who will be here — which is
 * the risk register's fallback (*the current graph for an upcoming event only*).
 *
 * **By `joinedAt`, the system's stamp — not the join date** (P18.96-T5 AC-1, kept deliberately): every count of people
 * reads the join date (ADR-0172 §1), but an audience is who the office could invite when the event began, which is who
 * was *in the system* then. Read by a join date a leader typed later, an existing agent added today with a join date
 * years back would join every past event's audience, and a past attendance rate would move — the thing this reading
 * exists to prevent. So `joinDateStart` is left out of the people below, and `memberAt` falls back to `joinedAt`.
 *
 * Pure below; `EventAudienceReader` reads the rows once per request.
 */

/** A membership as the audience reads it. */
export interface AudiencePerson extends CountedMembership {
  membershipId: string;
  /** The rung they stand on now, which the roll call names. */
  orgLevelCode?: string;
  /** The current leader, for an upcoming event and for a row older than the history. */
  leaderId: string | null;
}

/** A leader-setting edge: who the member reported to from `validFrom`, and who before it. */
export interface LeaderEdge {
  membershipId: string;
  /** The leader the event moved the member away from — what they reported to before their first recorded edge. */
  fromLeaderId: string | null;
  toLeaderId: string | null;
  validFrom: Date;
  /** The row's `_id`: two events in one instant are told apart by the order they were written in. */
  order: string;
}

/** The edge events that set who the member reports to — `HierarchyService.leaderAsOf`'s. A role change keeps the leader. */
export const LEADER_EDGE_EVENTS: readonly EdgeEvent[] = ['joined', 're_parented', 'removed', 'reinstated'];

export interface AudienceQuestion {
  scope: EventAudienceScope;
  inviteeMembershipIds: readonly string[];
  startsAt: Date;
  /** `now < startsAt`: the office as it is now. */
  upcoming: boolean;
}

/** The office's people and its leader edges, read once and asked about many events. */
export class OfficeAudience {
  private readonly edgesByMember = new Map<string, LeaderEdge[]>();

  constructor(readonly people: readonly AudiencePerson[], edges: readonly LeaderEdge[]) {
    for (const edge of edges) {
      const list = this.edgesByMember.get(edge.membershipId) ?? [];
      list.push(edge);
      this.edgesByMember.set(edge.membershipId, list);
    }
  }

  /** The membership ids the event's audience holds, in the order `people` lists them. */
  audienceOf(event: AudienceQuestion): string[] {
    const present = event.upcoming
      ? this.people.filter((p) => p.status === 'active')
      : this.people.filter((p) => memberAt(p, event.startsAt));
    if (SELECT_AUDIENCE_SCOPES.includes(event.scope)) {
      const chosen = new Set(event.inviteeMembershipIds);
      return present.filter((p) => chosen.has(p.membershipId)).map((p) => p.membershipId);
    }
    if (event.scope === 'leaders') {
      const leading = new Set<string>();
      for (const person of present) {
        const leader = event.upcoming ? person.leaderId : this.leaderAt(person, event.startsAt);
        if (leader !== null && leader !== person.membershipId) leading.add(leader);
      }
      return present.filter((p) => leading.has(p.membershipId)).map((p) => p.membershipId);
    }
    return present.map((p) => p.membershipId);
  }

  /** Does the event's audience hold this membership? */
  holds(event: AudienceQuestion, membershipId: string): boolean {
    return this.audienceOf(event).includes(membershipId);
  }

  /**
   * Who `person` reported to at `at`, from **every** leader-setting edge of theirs (no cut-off, so one event read alone
   * and the same event read in a list answer alike):
   *
   * - the latest edge by then, and its `toLeaderId`;
   * - **every edge after `at`** — a row older than the history, re-parented since: the earliest edge's
   *   `fromLeaderId`, the leader it moved them away from;
   * - **no edge at all** — a row older than the history (invariant §5 was written from the first commit, but a row
   *   can predate it) — its current leader rather than nobody.
   *
   * Two edges in one instant are told apart by the order they were written in (`order`, the row's `_id`).
   */
  private leaderAt(person: AudiencePerson, at: Date): string | null {
    const edges = [...(this.edgesByMember.get(person.membershipId) ?? [])].sort(
      (a, b) => a.validFrom.getTime() - b.validFrom.getTime() || a.order.localeCompare(b.order),
    );
    if (edges.length === 0) return person.leaderId;
    const until = edges.filter((edge) => edge.validFrom.getTime() <= at.getTime());
    return until.length === 0 ? edges[0].fromLeaderId : until[until.length - 1].toLeaderId;
  }
}

/**
 * **Reads the office's people and, when an event needs them, its leader edges** — through the tenant repositories,
 * in two queries whatever the number of events.
 */
@Injectable()
export class EventAudienceReader {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly history: MembershipHistoryRepository,
  ) {}

  async read(ctx: RequestContext, events: readonly AudienceQuestion[]): Promise<OfficeAudience> {
    const rows = await this.memberships.find(
      ctx,
      // A pending membership has registered and nothing more: never in an audience (OD-24).
      { status: { $in: ['active', 'removed'] } },
      { projection: { status: 1, joinedAt: 1, removedAt: 1, leaderId: 1, orgLevelCode: 1 }, sort: { agentSeq: 1 } },
    );
    // Hydrated with the schema's defaults: a missing date or leader reads `null`, never `undefined`.
    const people = rows.map((row): AudiencePerson => ({
      membershipId: String(row._id),
      orgLevelCode: row.orgLevelCode,
      status: row.status,
      joinedAt: row.joinedAt,
      removedAt: row.removedAt,
      leaderId: row.leaderId,
    }));

    // The edges only for an event that has started with a *Leaders* audience: every other question is answered by
    // the memberships alone. **Every** leader edge when they are read — never cut off at a start — so an event's
    // audience does not depend on which other events were asked about in the same read.
    const needsEdges = events.some((e) => !e.upcoming && e.scope === 'leaders');
    const history = needsEdges
      ? await this.history.find(
        ctx,
        { eventType: { $in: [...LEADER_EDGE_EVENTS] } },
        { projection: { membershipId: 1, fromLeaderId: 1, toLeaderId: 1, validFrom: 1 } },
      )
      : [];
    const edges = history.map((row): LeaderEdge => ({
      membershipId: row.membershipId,
      fromLeaderId: row.fromLeaderId,
      toLeaderId: row.toLeaderId,
      validFrom: row.validFrom,
      order: String(row._id),
    }));
    return new OfficeAudience(people, edges);
  }
}
