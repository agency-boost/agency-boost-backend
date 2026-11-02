import { Injectable } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import type { ResourceName } from '@/common/errors/resources';
import { isReadLike, scopeFor, type Permission, type Scope } from '@/modules/rbac/permissions';
import { MembershipRepository } from './membership.repository';
import type { MembershipDocument } from './membership.schema';

/** Somebody a leader coaches, as the roster lists them. */
export interface Coachee {
  membershipId: string;
  /** Edges between the coach and them: 1 is a direct report, 2 a report's report, and so on. */
  depth: number;
  membership: MembershipDocument;
}

/** A leader's unit as a grant reaches it (`CoachResolver.unitOf`). */
export interface ReachedUnit {
  /** The grant is the office's own (`own-kpm`, `all`): a write may name any active member of it. */
  office: boolean;
  /** Everybody below the caller the grant lets them list — their coachees, or nobody. */
  below: Coachee[];
  /** The caller may name themselves: always on `own`, and on a wider grant only while they lead somebody. */
  self: boolean;
}

/** Whose data a subject read is about. */
export interface Subject {
  membershipId: string;
  /**
   * The **subject's** rung, not the reader's (ADR-0020): a leader opening an agent's day reads the
   * agent's screen, or the row a leader reads and the row the agent filled in are different shapes.
   */
  orgLevelCode: string;
  /** The caller named themselves, or nobody. A self-read is never audited. */
  self: boolean;
}

/** A leader note, as far as who may read it goes (ADR-0073). */
export interface LeaderNoteParties {
  authorMembershipId: string;
  subjectMembershipId: string;
}

/**
 * **`COACH(actor, subject)`, built once** (P11-T3, ADR-0074), and the reads of a member's data that
 * go through it.
 *
 * The actor coaches the subject when:
 *
 * - the subject's membership is **active**, in the office the request is scoped to (the tenant
 *   repository supplies the office, so another office's member is simply not found);
 * - the actor is among the subject's ancestors on the **current leader edges**, at any depth, and
 *   every membership on the way down — the actor's, and each one between — is active too;
 * - the actor is **not** the subject. A leader never coaches themselves; their own coaching is
 *   `/coaching/me` (ADR-0078).
 *
 * **Read off the membership cache, filtered to `status: 'active'`, as the org tree reads it.**
 * `leaderId` and `ancestorIds` follow the open edges in `membershipHistory`, kept in step by
 * `HierarchyService` and `RemovalService` alone — but a removed member keeps both, and removal leaves
 * a `removed` history row whose `validTo` is null as well (`removal.service.ts`). Without the status
 * a former leader would go on reaching a removed member's goal, leads and days, which is what the
 * three services this replaces did. Closing an edge ends the grant from that moment (AC-9): a
 * re-parent re-splices the cache, and a removal sets the status.
 *
 * **The caller's own status is read off the request context**, which `ContextResolver` loads from
 * the database on every request; anybody else's from the database.
 *
 * **One reach for a member's data.** `subject` and `reach` are what the goal, lead and activity
 * services read through, so an AAB's `own-unit` is their subtree there too, as roles §2 rule 2
 * says. The rules that open or close an edge — `member:remove_from_team`, `member:change_role`,
 * `leader_request:*` — keep `own-unit` one level and **never come through here**: a leader closes
 * only an edge they own.
 *
 * **Outside it the answer is 404**, `NOT_FOUND`, never 403: a 403 confirms that the person exists.
 */
@Injectable()
export class CoachResolver {
  constructor(private readonly memberships: MembershipRepository) {}

  /**
   * `COACH(actor, subject)`: the subject's membership when the actor coaches them, otherwise `null`.
   *
   * The actor is a membership id and need not be the caller — an Owner's reopen asks whether the
   * session's coach still coaches its coachee (ADR-0079). The office is always the caller's.
   */
  async coachee(
    ctx: RequestContext, actorMembershipId: string, subjectMembershipId: string,
  ): Promise<MembershipDocument | null> {
    if (actorMembershipId === subjectMembershipId) return null;
    if (!(await this.isActive(ctx, actorMembershipId))) return null;

    // A malformed id finds nothing rather than throwing — the repository's `findOne` says so.
    const member = await this.memberships.findOne(ctx, {
      _id: subjectMembershipId,
      ancestorIds: actorMembershipId,
      status: 'active',
    });
    if (!member) return null;

    /*
     * **Every link between them active, not only the two ends.** Removal re-parents a leader's
     * reports before it removes the leader, so the cache never holds a removed membership above an
     * active one; this is the second lock on that door, and the same test `coacheesOf` applies.
     */
    const between = linksBetween(actorMembershipId, member);
    if (between.length === 0) return member;
    const live = await this.memberships.count(ctx, {
      _id: { $in: between.filter((id) => isValidObjectId(id)) },
      ancestorIds: actorMembershipId,
      status: 'active',
    });
    return live === between.length ? member : null;
  }

  /** `COACH(actor, subject)` as a yes or a no. */
  async coaches(
    ctx: RequestContext, actorMembershipId: string, subjectMembershipId: string,
  ): Promise<boolean> {
    return (await this.coachee(ctx, actorMembershipId, subjectMembershipId)) !== null;
  }

  /**
   * Everybody the actor coaches, nearest first and then in join order — the coaching roster's list.
   *
   * **One query, the same rule as `coachee`**: every active member with the actor above them, kept
   * when every link between is one of those members too. Never the actor themselves, never a peer's
   * people, never a member who has left. The spec proves the two agree member by member.
   */
  async coacheesOf(ctx: RequestContext, actorMembershipId: string): Promise<Coachee[]> {
    return (await this.coached(ctx, actorMembershipId)).map((m) => ({
      membershipId: String(m._id),
      depth: m.ancestorIds.length - m.ancestorIds.indexOf(actorMembershipId),
      membership: m,
    }));
  }

  /**
   * The memberships the caller's grant on `permission` reaches, for a list: `null` is the whole
   * office, `[]` nobody.
   *
   * Their own, always, plus whoever the widest scope they hold reaches: `own` only themselves, a
   * hierarchy token (`own-unit`, `own-downline`) everybody they coach, `own-kpm` the office. **No
   * grant reaches nobody**, rather than falling back to the caller's own (fail-closed, the lesson
   * the leads module learned first).
   *
   * **Ids are all a list's filter needs**, so the members are read with `_id` and `ancestorIds`
   * alone, the two fields the rule tests: `/leads` asks on every list and count, and the root AB's
   * reach is the whole office.
   */
  async reach(ctx: RequestContext, permission: Permission): Promise<string[] | null> {
    const me = requireMembership(ctx);
    switch (scopeFor(ctx, permission)) {
      case 'all':
      case 'own-kpm':
        return null;
      case 'own-downline':
      case 'own-unit':
        return [me, ...(await this.coached(ctx, me, REACH_FIELDS)).map((m) => String(m._id))];
      case 'own':
        return [me];
      default:
        return [];
    }
  }

  /**
   * **A leader's unit, by the scope the caller's grant on `permission` actually holds** (Phase 15, the Unit
   * Dashboard; the branching `reach` makes, for a unit rather than a list of ids):
   *
   * - a hierarchy token (`own-unit`, `own-downline`) is `COACH`: everybody the caller coaches;
   * - the office's own (`own-kpm`, `all`) is the office for a write, and the caller's own downline for the
   *   unit they head, as an Owner who is also the root AB heads the whole office (roles §1.1);
   * - `own` alone is the caller and nobody below them — an empty unit, never a fallback to `COACH`;
   * - no grant is nobody at all.
   *
   * A unit of one is nobody's unit, so on a wider grant the caller names themselves only while somebody is
   * below them (ADR-0087: a leader is anyone with a direct report).
   */
  async unitOf(ctx: RequestContext, permission: Permission): Promise<ReachedUnit> {
    const me = requireMembership(ctx);
    const scope = scopeFor(ctx, permission);
    if (scope === null || scope === 'own') return { office: false, below: [], self: scope === 'own' };
    const below = await this.coacheesOf(ctx, me);
    const office = scope === 'own-kpm' || scope === 'all';
    return { office, below, self: office || below.length > 0 };
  }

  /**
   * The member a subject read names, or a 404 (`functional/coaching.md`, the Data contract's
   * preamble for the existing routes).
   *
   * **Absent, or the caller, is the caller's own read.** Anybody else is resolved by the widest
   * scope the caller holds on the route's permission: `own` reaches only the caller, so an Agent
   * naming somebody else is 404, not 403; a hierarchy token reaches `COACH`; `own-kpm` the office,
   * a member who has left included, because the history belongs to the office (§6.7).
   *
   * **A member who has left is history to read, never somebody to write for.** On a write permission
   * — anything not read-like by its verb (`isReadLike`): `goal:update`, `lead:create` — `own-kpm`
   * reaches only the office's **active** members, and a member who has left is 404, as `COACH` already
   * answers for a hierarchy token. A read keeps reaching them.
   *
   * **The membership is resolved even at `own-kpm`.** Without it an Owner could probe another
   * office's ids and tell a real one from an invented one by nothing at all — the tenancy specs
   * caught that once in the activity module and once in leads.
   */
  async subject(
    ctx: RequestContext,
    asked: string | undefined,
    permission: Permission,
    /** Named in the 404's message, in the reader's language (`resources.ts`). */
    resource: ResourceName = 'Membership',
  ): Promise<Subject> {
    const me = requireMembership(ctx);
    if (!asked || asked === me) {
      return { membershipId: me, orgLevelCode: ctx.membership!.orgLevelCode, self: true };
    }
    const member = await this.inReach(ctx, me, asked, scopeFor(ctx, permission), !isReadLike(permission));
    if (!member) throw new NotFoundException(resource);
    return { membershipId: asked, orgLevelCode: member.orgLevelCode, self: false };
  }

  /**
   * May the caller read this leader note (ADR-0073)? The predicate `GET …/leader-notes` calls per
   * note.
   *
   * Its author reads it, and so do the author's ancestors in the same office on the current edges —
   * `COACH(reader, author)` — and nobody else:
   *
   * - **never its subject, tested before anything else**: a subject who leads people of their own,
   *   or who has since come to stand above the author, is still the subject;
   * - never in a support session, read-only or elevated (§3.13); the guard refuses one first;
   * - never the Owner, the Admin or the Super Admin as such. Nothing here reads a tenant role: one
   *   who is also an AB above the author reads as that ancestor (§1.1), and that is the hierarchy.
   *
   * The rule follows the author, not the subject, so a subject who moves leaves the notes where they
   * are.
   */
  async readsLeaderNote(ctx: RequestContext, note: LeaderNoteParties): Promise<boolean> {
    const reader = ctx.membershipId;
    if (reader === note.subjectMembershipId) return false;
    if (ctx.isImpersonating || !reader || ctx.membership!.status !== 'active') return false;
    if (reader === note.authorMembershipId) return true;
    return this.coaches(ctx, reader, note.authorMembershipId);
  }

  private async inReach(
    ctx: RequestContext, me: string, asked: string, scope: Scope | null, write: boolean,
  ): Promise<MembershipDocument | null> {
    switch (scope) {
      case 'all':
      case 'own-kpm':
        // The office's history is read whole (§6.7); a write reaches only who is still in it.
        return write
          ? this.memberships.findOne(ctx, { _id: asked, status: 'active' })
          : this.memberships.findById(ctx, asked);
      case 'own-downline':
      case 'own-unit':
        return this.coachee(ctx, me, asked);
      default:
        return null;
    }
  }

  /**
   * The rule `coacheesOf` states, for it and for `reach` alike, so the roster and a list's filter
   * cannot disagree: the members read whole for the roster, or with only `fields` for a list's ids.
   */
  private async coached(
    ctx: RequestContext, actorMembershipId: string, fields?: Readonly<Record<string, 1>>,
  ): Promise<MembershipDocument[]> {
    if (!(await this.isActive(ctx, actorMembershipId))) return [];

    const below = await this.memberships.find(
      ctx,
      { ancestorIds: actorMembershipId, status: 'active' },
      fields ? { sort: COACHED_ORDER, projection: fields } : { sort: COACHED_ORDER },
    );
    const live = new Set(below.map((m) => String(m._id)));
    return below.filter((m) => linksBetween(actorMembershipId, m).every((id) => live.has(id)));
  }

  private async isActive(ctx: RequestContext, membershipId: string): Promise<boolean> {
    if (membershipId === ctx.membershipId) return ctx.membership!.status === 'active';
    return (await this.memberships.findOne(ctx, { _id: membershipId, status: 'active' })) !== null;
  }
}

/** Nearest first, then in join order: the roster's order. `{kpmId, ancestorIds, status}` serves the filter. */
const COACHED_ORDER = { depth: 1, agentSeq: 1 } as const;

/** What `reach` reads of each member: the id it answers, and the ancestry the rule tests. */
const REACH_FIELDS = { _id: 1, ancestorIds: 1 } as const;

/** The caller's own membership, or the refusal that says what to do about it. */
function requireMembership(ctx: RequestContext): string {
  const me = ctx.membershipId;
  if (!me) throw new NoMembershipException();
  return me;
}

/** The memberships strictly between the actor and somebody below them, top down. */
function linksBetween(actorMembershipId: string, member: MembershipDocument): string[] {
  const ancestors = member.ancestorIds;
  return ancestors.slice(ancestors.indexOf(actorMembershipId) + 1);
}
