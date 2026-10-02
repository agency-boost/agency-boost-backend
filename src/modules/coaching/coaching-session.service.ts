import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, NoMembershipException, NotFoundException, VersionConflictException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { isLocalDate, type LocalDate } from '@/common/time/local-day';
import { COACHING } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { LeadRepository } from '@/modules/leads/lead.repository';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { CoachResolver } from '@/modules/org/coach-resolver';
import type { MembershipDocument } from '@/modules/org/membership.schema';
import { MemberNames } from '@/modules/org/member-names.service';
import { scopeFor, type Permission } from '@/modules/rbac/permissions';
import { TenantDay, type OfficeDay } from '@/modules/tenants/tenant-day.service';
import { sessionFinalized } from './coaching-session.gate';
import { CoachingSessionRepository } from './coaching-session.repository';
import {
  carryForward, coalesceKeyOf, finalizeRefusal, finalizeSentence, latestFinalized, leadActionsOf,
  reopenableUntil, reopenWindowOpen, reviewedItems, type FinalizedVersion, type SessionLead,
} from './coaching-session.rules';
import type {
  CoachingActionItem, CoachingLastWeekItem, CoachingLeadAction, CoachingSessionCorrection,
  CoachingSessionDocument, CoachingSessionStatus, CoachingSnapshot, CoachingTip,
} from './coaching-session.schema';
import { CoachingSnapshotBuilder } from './coaching-snapshot';

/** A member, by the membership that identifies them. `name` is empty when it can no longer be named. */
export interface SessionPerson {
  membershipId: string;
  name: string;
}

export interface LastWeekItemView {
  itemId: string;
  text: string;
  dueDate: string | null;
  /** The *Leads · {name}* tag, as it read that day; `null` for a typed item. */
  lead: { leadId: string; name: string } | null;
  done: boolean;
}

export interface LeadActionView {
  leadId: string;
  leadName: string;
  dueDate: string;
  text: string;
}

export interface ActionItemView {
  itemId: string;
  text: string;
  dueDate: string | null;
}

export interface TipView {
  tipId: string;
  text: string;
}

/** A finalized version a reopen replaced, kept whole (ADR-0042), with who reopened it, when and why. */
export interface EarlierVersionView {
  finalizedAt: string;
  finalizedBy: SessionPerson;
  reopenedAt: string;
  reopenedBy: SessionPerson;
  reason: string;
  lastWeekItems: LastWeekItemView[];
  leadActions: LeadActionView[];
  actionItems: ActionItemView[];
  tips: TipView[];
}

/** One session, as this reader may see it (`functional/coaching.md`, *Who reads a session*). */
export interface CoachingSessionView {
  sessionId: string;
  coachee: SessionPerson;
  coach: SessionPerson;
  status: CoachingSessionStatus;
  version: number;
  date: string | null;
  startedAt: string;
  finalizedAt: string | null;
  finalizedBy: SessionPerson | null;
  reopenableUntil: string | null;
  lastWeek: { sessionId: string; date: string } | null;
  lastWeekItems: LastWeekItemView[];
  leadActions: LeadActionView[];
  actionItems: ActionItemView[];
  tips: TipView[];
  snapshot: (Omit<CoachingSnapshot, 'takenAt'> & { takenAt: string }) | null;
  earlier: EarlierVersionView[];
}

/** One row of a coachee's history. */
export interface SessionHistoryRow {
  sessionId: string;
  date: string;
  coach: SessionPerson;
  actionItemCount: number;
  completedCount: number;
}

export interface SessionHistoryView {
  today: LocalDate;
  current: { sessionId: string; status: CoachingSessionStatus } | null;
  sessions: SessionHistoryRow[];
}

/** What a draft save answers: only what the coach wrote, with the ids new rows were given. */
export interface SessionDraftSaved {
  sessionId: string;
  version: number;
  actionItems: ActionItemView[];
  tips: TipView[];
}

/** A draft save's body, as the DTO has validated its shape. */
export interface SaveSessionInput {
  version: number;
  lastWeekItems: { itemId: string; done: boolean; dueDate?: string | null }[];
  actionItems: { itemId?: string; text: string; dueDate?: string | null }[];
  tips: { tipId?: string; text: string }[];
}

/** A session still being edited: a draft, or a correction (ADR-0079). */
const OPEN: readonly CoachingSessionStatus[] = ['draft', 'reopened'];
/** Finalized at least once: what every reader but the coach reads, and what the metrics count. */
export const COUNTED: readonly CoachingSessionStatus[] = ['finalized', 'reopened'];
/** Newest first, the history index's order. */
export const NEWEST = { date: -1, frozenAt: -1 } as const;
const DUPLICATE_KEY = 11000;

/** How the reader stands to one session. */
export interface Standing {
  me: string;
  /** Its coach, who still coaches the coachee: the working copy, the draft included, and every write. */
  live: boolean;
  isCoach: boolean;
  coachesNow: boolean;
  isCoachee: boolean;
  /** `own-kpm` on the permission asked about: the Owner and the Admin. */
  officeWide: boolean;
}

export const notFound = () => new NotFoundException('Coaching session');

function officeWide(ctx: RequestContext, permission: Permission): boolean {
  const scope = scopeFor(ctx, permission);
  return scope === 'own-kpm' || scope === 'all';
}

/**
 * **How the caller stands to a session**, on the permission the route checks: `COACH` is asked once, for
 * the session's coachee. Shared by the session read and the print (P11-T10), so the two can never answer
 * a different reader.
 */
export async function standingOf(
  coach: CoachResolver, ctx: RequestContext, session: CoachingSessionDocument, permission: Permission,
): Promise<Standing> {
  const me = requireMe(ctx);
  const isCoach = session.coachMembershipId === me;
  const coachesNow = await coach.coaches(ctx, me, session.coacheeMembershipId);
  return {
    me,
    isCoach,
    coachesNow,
    live: isCoach && coachesNow,
    isCoachee: session.coacheeMembershipId === me,
    officeWide: officeWide(ctx, permission),
  };
}

/**
 * **Who reads a session's finalized versions** (`functional/coaching.md`, *Who reads a session*;
 * ADR-0078, ADR-0082): its coach — while they coach the coachee, and after their edge closes, the sessions
 * they led — any current coach of the coachee, the Owner and the Admin (`own-kpm`), and the coachee.
 * Anybody else is 404. A draft is a separate question: it is its coach's alone, while they coach.
 */
export function readsFinalized(standing: Standing): boolean {
  return standing.isCoach || standing.coachesNow || standing.officeWide || standing.isCoachee;
}

/**
 * **Lead rows only to a reader who may read the coachee's leads** (roles §3.7: lead records are not
 * admin-readable, "never the lead rows" — the rule `GET /summary?for=` applies). Its coach — while they
 * coach the coachee, and after, in the sessions they led — any current coach and the coachee read a
 * session's lead names and the agent's lead-note text. A reader admitted **only office-wide** (the Owner
 * or the Admin who is not above the coachee) reads them only where their own `lead:read` reaches the
 * coachee: `coaching_session:read` reaches the office for them, `lead:read` does not.
 *
 * Such a reader reads the rest of the session — and the counts, which name no lead — but no lead action
 * and no item of last week's that came from a lead, its *Leads · {name}* tag with it.
 */
export async function showsLeadsTo(
  coach: CoachResolver, ctx: RequestContext, session: CoachingSessionDocument, standing: Standing,
): Promise<boolean> {
  if (standing.isCoach || standing.coachesNow || standing.isCoachee) return true;
  const reach = await coach.reach(ctx, 'lead:read');
  return reach === null || reach.includes(session.coacheeMembershipId);
}

/** Last week's items as this reader reads them: every one, or — without the coachee's leads — the typed ones. */
export function shownLastWeekItems<T extends { leadId: string | null }>(items: readonly T[], leadsShown: boolean): T[] {
  return leadsShown ? [...items] : items.filter((item) => !item.leadId);
}

/**
 * The typed items as this reader reads them. An item *Start* carried forward from a lead-derived item of
 * last week keeps that lead's note as its text (`carriedFromItemId: 'lead-…'`), so a reader without the
 * coachee's leads reads every typed item but those (roles §3.7, the exit review's B1 residue).
 */
export function shownActionItems<T extends { carriedFromItemId: string | null }>(items: readonly T[], leadsShown: boolean): T[] {
  return leadsShown ? [...items] : items.filter((item) => !item.carriedFromItemId?.startsWith('lead-'));
}

/**
 * **How many of each session's items were ticked done**: by the newest session that reviewed it — the
 * reader's own open session first (`ownOpen`), then the newest finalized one, whose latest finalized
 * version is what counts. A draft somebody else holds reviews nothing a reader may count. `reviewers`
 * come newest first.
 */
export function reviewedCounts(
  reviewers: readonly CoachingSessionDocument[], ownOpen: (session: CoachingSessionDocument) => boolean,
): Map<string, number> {
  const reviewed = new Map<string, number>();
  for (const reviewer of [...reviewers.filter(ownOpen), ...reviewers.filter((s) => !ownOpen(s))]) {
    const reviewing = reviewer.lastWeek!.sessionId;
    if (reviewed.has(reviewing)) continue;
    const items = ownOpen(reviewer) ? reviewer.lastWeekItems : latestFinalized(reviewer)?.lastWeekItems;
    if (items) reviewed.set(reviewing, items.filter((item) => item.done).length);
  }
  return reviewed;
}

/**
 * **One row of a history**, from a session finalized at least once: its day, its latest finalized
 * version's action items — from leads and typed — and how many of them were ticked done. Who it names
 * beside the dates is the caller's: the coach on a coachee's history, the coachee on a former coach's.
 */
export function historyCounts(
  session: CoachingSessionDocument, reviewed: ReadonlyMap<string, number>,
): { sessionId: string; date: string; actionItemCount: number; completedCount: number } {
  const shown = latestFinalized(session)!;
  return {
    sessionId: String(session._id),
    date: session.date as string,
    actionItemCount: shown.actionItems.length + shown.leadActions.length,
    completedCount: reviewed.get(String(session._id)) ?? 0,
  };
}

/**
 * **The coaching session's lifecycle** (P11-T5; `functional/coaching.md`, *The session*, *The snapshot*,
 * *Who reads a session*, and the Data contract): start, the draft, finalize, reopen, and the reads.
 *
 * **A session is its coach's working copy until it is finalized, and a record of the office after that.**
 *
 * - **Its coach, while they coach the coachee** (`COACH`, ADR-0074), reads all of it and is the only
 *   writer: a save, a finalize, a goal save through it. After their edge closes they read the finalized
 *   versions of the sessions they led, and nothing else (ADR-0082); a draft they left is 404.
 * - **Any current coach** reads every finalized session about the coachee, read-only; **the Owner and
 *   the Admin** (`own-kpm`) every finalized one in the office — without its lead names and lead-note text
 *   where they do not coach the coachee (`showsLeadsTo`, roles §3.7); **the coachee** their own. Anybody
 *   else, another office included, is **404**, never 403.
 * - **A session under correction reads as its latest finalized version** to everyone but its coach
 *   while they coach the coachee — the correction is not shown until it is finalized — and its *From
 *   leads (automatic)* is derived from the coachee's leads only for that reader, on an open session;
 *   everyone else reads the list the last finalize took.
 *
 * **Every write is pinned to the version it read**, in one conditional write (`updateIfAt`), and the
 * refusals come in the contract's order: reach (404), state (409), the version (409), the domain rules
 * (422). A read of a session writes the §3.5 entry, surface `coaching_session`, unless the reader is the
 * coachee; so does the answer of *Start*, finalize and reopen, which is the session as `GET` answers it.
 */
@Injectable()
export class CoachingSessionService {
  private readonly logger = new Logger(CoachingSessionService.name);

  constructor(
    private readonly sessions: CoachingSessionRepository,
    private readonly coach: CoachResolver,
    private readonly names: MemberNames,
    private readonly days: TenantDay,
    private readonly leads: LeadRepository,
    private readonly snapshots: CoachingSnapshotBuilder,
    private readonly audit: AuditService,
    private readonly subjectReads: SubjectReadAudit,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------ reading

  /**
   * **`GET /coaching/coachees/:membershipId/sessions` — a coachee's history, and what the workspace opens
   * on.** A current coach, and the Owner and the Admin, read every session about the coachee finalized
   * at least once; a former coach the ones they led, and no other. `current` is the reader's own: their
   * open draft with the coachee, else the session they are correcting, else the one they finalized on
   * the office's today. Dates, coaches and counts — no figure of the coachee's — so no audit entry.
   */
  async history(ctx: RequestContext, coacheeId: string): Promise<SessionHistoryView> {
    const me = requireMe(ctx);
    const day = await this.days.for(ctx);
    const coachesNow = await this.coach.coaches(ctx, me, coacheeId);
    let reach: 'all' | 'led' = 'all';
    if (!coachesNow) {
      if (officeWide(ctx, 'coaching_session:read')) {
        // The membership is resolved even at `own-kpm`, so another office's id is 404 like any other.
        await this.coach.subject(ctx, coacheeId, 'coaching_session:read');
      } else {
        reach = 'led';
      }
    }

    const about = { coacheeMembershipId: coacheeId, ...(reach === 'led' ? { coachMembershipId: me } : {}) };
    const counted = await this.sessions.find(ctx, { ...about, status: { $in: [...COUNTED] } }, { sort: NEWEST });
    // A former coach with nothing they led reaches nothing here: the coachee is not theirs to look up.
    if (reach === 'led' && counted.length === 0) throw new NotFoundException('Membership');

    const ids = counted.map((s) => String(s._id));
    const reviewers = ids.length === 0 ? [] : await this.sessions.find(
      ctx, { ...about, 'lastWeek.sessionId': { $in: ids } }, { sort: NEWEST },
    );
    const ownOpen = (s: CoachingSessionDocument) =>
      coachesNow && s.coachMembershipId === me && OPEN.includes(s.status);
    // The reader's own open session first, then the newest finalized one: the first to review it wins.
    const reviewed = reviewedCounts(reviewers, ownOpen);

    const coachNames = await this.names.byMembershipId(ctx, counted.map((s) => s.coachMembershipId));
    return {
      today: day.today,
      current: coachesNow ? await this.current(ctx, me, coacheeId, day) : null,
      sessions: counted.map((session) => {
        const { sessionId, date, actionItemCount, completedCount } = historyCounts(session, reviewed);
        return {
          sessionId,
          date,
          coach: { membershipId: session.coachMembershipId, name: coachNames.get(session.coachMembershipId) ?? '' },
          actionItemCount,
          completedCount,
        };
      }),
    };
  }

  /** **`GET /coaching/sessions/:sessionId`** — one session, as this reader may see it. */
  async read(ctx: RequestContext, sessionId: string): Promise<CoachingSessionView> {
    const session = await this.sessions.findById(ctx, sessionId);
    if (!session) throw notFound();
    const standing = await this.standing(ctx, session);
    if (!standing.live) {
      // A draft is its coach's alone, while they coach the coachee.
      if (session.status === 'draft') throw notFound();
      if (!readsFinalized(standing)) throw notFound();
    }
    return this.answer(ctx, session, standing, await this.days.for(ctx));
  }

  // ------------------------------------------------------------------ writing

  /**
   * **`POST /coaching/coachees/:membershipId/sessions` — *Start*** (ADR-0081, P11-T5 AC-1). The pair's
   * open draft when there is one — a second *Start* resumes it, from any device — else a new draft that
   * fixes *last week*, copies its items untouched into *Last week's action items*, and carries forward
   * every item not done with its date cleared, except one whose lead has a next action date now, and
   * every tip. Two racing *Start*s write one draft: the partial unique index refuses the second, which
   * resumes the first.
   */
  async start(ctx: RequestContext, coacheeId: string): Promise<{ created: boolean; session: CoachingSessionView }> {
    const me = requireMe(ctx);
    const coachee = await this.coach.coachee(ctx, me, coacheeId);
    if (!coachee) throw new NotFoundException('Membership');
    const day = await this.days.for(ctx);
    const live: Standing = {
      me, live: true, isCoach: true, coachesNow: true, isCoachee: false, officeWide: false,
    };

    const open = await this.openDraft(ctx, me, coacheeId);
    if (open) return { created: false, session: await this.answer(ctx, open, live, day) };

    const [last] = await this.sessions.find(
      ctx, { coacheeMembershipId: coacheeId, status: { $in: [...COUNTED] } }, { sort: NEWEST, limit: 1 },
    );
    const carried = last ? latestFinalized(last)! : null;
    const leads = await this.leadsOf(ctx, coacheeId, day);
    const lastWeekItems = carried ? reviewedItems(carried) : [];
    const forward = carryForward(lastWeekItems, carried?.tips ?? [], leads, newId);

    let created: CoachingSessionDocument;
    try {
      created = await this.sessions.create(ctx, {
        coachMembershipId: me,
        coacheeMembershipId: coacheeId,
        status: 'draft',
        date: null,
        lastWeek: last ? { sessionId: String(last._id), version: carried!.version, date: last.date as string } : null,
        lastWeekItems,
        actionItems: forward.actionItems,
        tips: forward.tips,
        leadActions: [],
        snapshot: null,
        finalizedAt: null,
        finalizedByMembershipId: null,
        version: 1,
        frozenAt: null,
        corrections: [],
      } as never);
    } catch (err) {
      if ((err as { code?: unknown }).code !== DUPLICATE_KEY) throw err;
      // Another *Start* for the pair got there first: this one resumes what it wrote.
      const raced = await this.openDraft(ctx, me, coacheeId);
      if (!raced) throw err;
      return { created: false, session: await this.answer(ctx, raced, live, day, leads) };
    }
    return { created: true, session: await this.answer(ctx, created, live, day, leads) };
  }

  /**
   * **`PUT /coaching/sessions/:sessionId` — a draft save** (P11-T5 AC-2, AC-3): the whole editable
   * state, pinned to the version it read. A tick on one of last week's items is written **here**; the
   * session it came from is frozen. A blank row may be saved while editing; finalize refuses it.
   *
   * **The answer's lists are in the request's order**, and the browser relies on it: a row it sent
   * without an id learns its new id **by position**. Guaranteed by construction — each list is rebuilt
   * from the body row by row (`replaceRows` maps it, in order), written whole by `$set`, and answered from
   * the document the write returns, an array MongoDB stores and returns in the order written. Nothing
   * here sorts, merges or regroups either list.
   */
  async save(ctx: RequestContext, sessionId: string, input: SaveSessionInput): Promise<SessionDraftSaved> {
    const { session } = await this.writable(ctx, sessionId);

    const lastWeekItems = applyTicks(session.lastWeekItems.map(plainLastWeekItem), input.lastWeekItems);
    const actionItems = replaceRows(
      session.actionItems.map(plainActionItem), (item) => item.itemId, input.actionItems, (row) => row.itemId,
      'actionItems',
      (row, prior): CoachingActionItem => ({
        itemId: prior?.itemId ?? newId(), text: row.text, dueDate: checkDate(row.dueDate ?? null, 'actionItems'),
        carriedFromItemId: prior?.carriedFromItemId ?? null,
      }),
    );
    const tips = replaceRows(
      session.tips.map(plainTip), (tip) => tip.tipId, input.tips, (row) => row.tipId, 'tips',
      (row, prior): CoachingTip => ({
        tipId: prior?.tipId ?? newId(), text: row.text, carriedFromTipId: prior?.carriedFromTipId ?? null,
      }),
    );

    this.requireOpen(session, input.version);
    const saved = await this.sessions.updateIfAt(
      ctx, sessionId, { version: input.version, statuses: OPEN }, { $set: { lastWeekItems, actionItems, tips } },
    );
    if (!saved) throw await this.whyNot(ctx, sessionId, input.version);
    return {
      sessionId,
      version: saved.version,
      actionItems: saved.actionItems.map(actionItemView),
      tips: saved.tips.map(tipView),
    };
  }

  /**
   * **`POST /coaching/sessions/:sessionId/finalize`** (P11-T5 AC-4, AC-5, AC-7). The prototype's five
   * checks, the first failure answering `COACHING_SESSION_INCOMPLETE` with `details.rule`. On success, in
   * one write: `finalized`, who and when, the lead-derived actions taken from the coachee's leads as they
   * stand, and — **the first time only** — `date` (the office's today), `frozenAt` and the snapshot. Then
   * the audit entry, the coachee's notice (`{ sessionId }` and nothing a leader typed), and the round's
   * held goal email, released without being awaited (`announceFinalized`). Neither notice ever fails the
   * finalize, and the email never delays it.
   */
  async finalize(ctx: RequestContext, sessionId: string, version: number): Promise<CoachingSessionView> {
    const { session, standing, coachee } = await this.writable(ctx, sessionId);
    this.requireOpen(session, version);

    const day = await this.days.for(ctx);
    const leads = await this.leadsOf(ctx, session.coacheeMembershipId, day);
    const leadActions = leadActionsOf(leads);
    const refusal = finalizeRefusal({ leadActions, actionItems: session.actionItems, tips: session.tips, leads });
    if (refusal) {
      throw new DomainException(
        ErrorCode.COACHING_SESSION_INCOMPLETE, finalizeSentence(refusal), HttpStatus.UNPROCESSABLE_ENTITY, { ...refusal },
      );
    }

    const now = this.clock.now();
    const first = session.frozenAt === null;
    const snapshot = first
      ? await this.snapshots.build(ctx, { membershipId: session.coacheeMembershipId, orgLevelCode: coachee.orgLevelCode, self: false })
      : null;
    const saved = await this.sessions.updateIfAt(ctx, sessionId, { version, statuses: OPEN }, {
      $set: {
        status: 'finalized',
        finalizedAt: now,
        finalizedByMembershipId: standing.me,
        leadActions,
        ...(first ? { date: day.today, frozenAt: now, snapshot } : {}),
      },
    });
    if (!saved) throw await this.whyNot(ctx, sessionId, version);

    await this.audit.record(ctx, {
      action: 'coaching_session.finalized',
      targetCollection: 'coachingSessions',
      targetId: sessionId,
      targetMembershipId: saved.coacheeMembershipId,
      after: { version: saved.version, date: saved.date, correction: saved.corrections.length > 0 },
    });
    await this.announceFinalized(ctx, saved, coachee);
    return this.answer(ctx, saved, standing, day, leads);
  }

  /**
   * **`POST /coaching/sessions/:sessionId/reopen`** (ADR-0079, P11-T5 AC-6). Accepted, in the order the
   * checks run, from its coach while they coach the coachee or from `own-kpm` (else 404); for a
   * `finalized` session (else `COACHING_SESSION_NOT_FINALIZED`); while the office's today is no later than
   * `date` plus `COACHING_REOPEN_WINDOW_DAYS` (else `COACHING_REOPEN_WINDOW_CLOSED`); for the Owner and the
   * Admin, while the session's coach still coaches the coachee (else `COACHING_REOPEN_COACH_NOT_CURRENT`:
   * only the coach finalizes a correction); at the version read (else `VERSION_CONFLICT`). The reason's
   * blankness is the DTO's, before any of these. The finalized state goes, whole, onto `corrections[]`
   * with who, when and why; `date`, `frozenAt` and the snapshot never move.
   */
  async reopen(
    ctx: RequestContext, sessionId: string, input: { version: number; reason: string },
  ): Promise<CoachingSessionView> {
    const session = await this.sessions.findById(ctx, sessionId);
    if (!session) throw notFound();
    const standing = await this.standing(ctx, session, 'coaching_session:reopen');
    // The coachee never writes a session about them (ADR-0078), an Owner or an Admin who is one included.
    if (standing.isCoachee || (!standing.live && (!standing.officeWide || session.status === 'draft'))) throw notFound();
    if (session.status !== 'finalized') {
      throw new DomainException(
        ErrorCode.COACHING_SESSION_NOT_FINALIZED,
        'Only a finalized session can be reopened.',
        HttpStatus.CONFLICT,
        { status: session.status },
      );
    }
    const day = await this.days.for(ctx);
    const date = session.date as LocalDate;
    if (!reopenWindowOpen(date, day.today)) {
      throw new DomainException(
        ErrorCode.COACHING_REOPEN_WINDOW_CLOSED,
        `This session could be reopened until ${reopenableUntil(date)}, ${COACHING.REOPEN_WINDOW_DAYS} days after it was held.`,
        HttpStatus.CONFLICT,
        { date, reopenableUntil: reopenableUntil(date), windowDays: COACHING.REOPEN_WINDOW_DAYS },
      );
    }
    if (!standing.live && !(await this.coach.coaches(ctx, session.coachMembershipId, session.coacheeMembershipId))) {
      throw new DomainException(
        ErrorCode.COACHING_REOPEN_COACH_NOT_CURRENT,
        'Only the session’s coach can finalize a correction, and they no longer coach this person.',
        HttpStatus.CONFLICT,
      );
    }
    if (input.version !== session.version) throw new VersionConflictException(input.version, session.version);

    const replaced = latestFinalized(session)!;
    const correction: CoachingSessionCorrection = {
      ...plainVersion(replaced),
      at: this.clock.now(),
      byMembershipId: standing.me,
      reason: input.reason.trim(),
    };
    const saved = await this.sessions.updateIfAt(ctx, sessionId, { version: input.version, statuses: ['finalized'] }, {
      $set: { status: 'reopened', leadActions: [] },
      $push: { corrections: correction },
    });
    if (!saved) throw await this.whyNot(ctx, sessionId, input.version);

    await this.audit.record(ctx, {
      action: 'coaching_session.reopened',
      targetCollection: 'coachingSessions',
      targetId: sessionId,
      targetMembershipId: saved.coacheeMembershipId,
      after: { version: saved.version, date: saved.date, reason: correction.reason },
    });
    return this.answer(ctx, saved, standing, day);
  }

  // ------------------------------------------------------------------ internals

  /** How the caller stands to a session. `COACH` is asked once, for the session's coachee. */
  private async standing(
    ctx: RequestContext, session: CoachingSessionDocument, permission: Permission = 'coaching_session:read',
  ): Promise<Standing> {
    return standingOf(this.coach, ctx, session, permission);
  }

  /**
   * **Writes are its coach's, while they still coach the coachee**: anybody else — a former coach, a new
   * leader, the Owner — is 404 on a save or a finalize, as they are on a session they cannot reach.
   */
  private async writable(ctx: RequestContext, sessionId: string): Promise<{
    session: CoachingSessionDocument; standing: Standing; coachee: MembershipDocument;
  }> {
    const me = requireMe(ctx);
    const session = await this.sessions.findById(ctx, sessionId);
    const coachee = session && session.coachMembershipId === me
      ? await this.coach.coachee(ctx, me, session.coacheeMembershipId)
      : null;
    if (!session || !coachee) throw notFound();
    return {
      session,
      coachee,
      standing: { me, live: true, isCoach: true, coachesNow: true, isCoachee: false, officeWide: false },
    };
  }

  /** The state and the version a write needs: still open, and unchanged since it was read. */
  private requireOpen(session: CoachingSessionDocument, version: number): void {
    if (session.status === 'finalized') throw sessionFinalized(String(session._id));
    if (version !== session.version) throw new VersionConflictException(version, session.version);
  }

  /** Why a pinned write matched nothing: the session moved on, or was finalized meanwhile. */
  private async whyNot(ctx: RequestContext, sessionId: string, version: number): Promise<DomainException> {
    const now = await this.sessions.findById(ctx, sessionId);
    if (!now) return notFound();
    if (now.status === 'finalized') return sessionFinalized(sessionId);
    return new VersionConflictException(version, now.version);
  }

  private async openDraft(ctx: RequestContext, coachId: string, coacheeId: string) {
    return this.sessions.findOne(ctx, { coachMembershipId: coachId, coacheeMembershipId: coacheeId, status: 'draft' });
  }

  /** The reader's open draft with the coachee; else the session they are correcting; else today's. */
  private async current(
    ctx: RequestContext, me: string, coacheeId: string, day: OfficeDay,
  ): Promise<SessionHistoryView['current']> {
    const mine = { coachMembershipId: me, coacheeMembershipId: coacheeId };
    const [found] = [
      await this.openDraft(ctx, me, coacheeId),
      ...(await this.sessions.find(ctx, { ...mine, status: 'reopened' }, { sort: NEWEST, limit: 1 })),
      ...(await this.sessions.find(ctx, {
        ...mine, status: 'finalized', finalizedAt: { $gte: this.clock.startOfLocalDay(day.timezone, day.today) },
      }, { sort: { finalizedAt: -1 }, limit: 1 })),
    ].filter((s): s is CoachingSessionDocument => s !== null);
    return found ? { sessionId: String(found._id), status: found.status } : null;
  }

  /** The coachee's leads, as the session's rules read them: every one not deleted, closed ones included. */
  private async leadsOf(ctx: RequestContext, coacheeId: string, day: OfficeDay): Promise<SessionLead[]> {
    const rows = await this.leads.find(ctx, { ownerMembershipId: coacheeId });
    return rows.map((row) => ({
      id: String(row._id),
      name: row.name,
      nextActionDate: row.nextActionDate,
      nextActionNote: row.nextActionNote,
      thisMonth: (row.commitments ?? []).some((c) => c.month === day.month),
      registeredAt: row.dateRegistered?.getTime() ?? 0,
    }));
  }

  /**
   * The session, as `GET` answers it to this reader, and the §3.5 entry the answer writes: surface
   * `coaching_session`, to the session's date — or today, while it is open — and none for the coachee.
   */
  private async answer(
    ctx: RequestContext, session: CoachingSessionDocument, standing: Standing, day: OfficeDay,
    leads?: SessionLead[],
  ): Promise<CoachingSessionView> {
    const live = standing.live;
    const open = live && OPEN.includes(session.status);
    const shown: FinalizedVersion | null = live ? null : latestFinalized(session);
    // Roles §3.7: no lead name and no lead-note text to a reader admitted only office-wide.
    const leadsShown = await showsLeadsTo(this.coach, ctx, session, standing);
    const lastWeekItems = shownLastWeekItems(shown ? shown.lastWeekItems : session.lastWeekItems, leadsShown);
    const actionItems = shownActionItems(shown ? shown.actionItems : session.actionItems, leadsShown);
    const tips = shown ? shown.tips : session.tips;
    let leadActions: CoachingLeadAction[] = [];
    if (leadsShown) {
      leadActions = open
        ? leadActionsOf(leads ?? await this.leadsOf(ctx, session.coacheeMembershipId, day))
        : (shown ?? session).leadActions;
    }
    const finalizedAt = shown ? shown.finalizedAt : session.finalizedAt;
    const finalizedBy = shown ? shown.finalizedByMembershipId : session.finalizedByMembershipId;
    // The correction in progress is not shown to anybody but its coach, its reason included.
    const earlier = live || session.status === 'finalized' ? session.corrections : session.corrections.slice(0, -1);

    const people = await this.names.byMembershipId(ctx, [
      session.coachMembershipId, session.coacheeMembershipId, ...(finalizedBy ? [finalizedBy] : []),
      ...earlier.flatMap((c) => [c.finalizedByMembershipId, c.byMembershipId]),
    ]);
    const person = (membershipId: string): SessionPerson => ({ membershipId, name: people.get(membershipId) ?? '' });

    const view: CoachingSessionView = {
      sessionId: String(session._id),
      coachee: person(session.coacheeMembershipId),
      coach: person(session.coachMembershipId),
      status: live ? session.status : 'finalized',
      version: shown ? shown.version : session.version,
      date: session.date,
      startedAt: session.createdAt.toISOString(),
      finalizedAt: finalizedAt ? finalizedAt.toISOString() : null,
      finalizedBy: finalizedBy ? person(finalizedBy) : null,
      reopenableUntil: await this.reopenableFor(ctx, session, standing),
      lastWeek: session.lastWeek ? { sessionId: session.lastWeek.sessionId, date: session.lastWeek.date } : null,
      lastWeekItems: lastWeekItems.map(lastWeekItemView),
      leadActions: leadActions.map(leadActionView),
      actionItems: actionItems.map(actionItemView),
      tips: tips.map(tipView),
      snapshot: session.snapshot ? snapshotView(session.snapshot) : null,
      earlier: earlier.map((c) => ({
        finalizedAt: c.finalizedAt.toISOString(),
        finalizedBy: person(c.finalizedByMembershipId),
        reopenedAt: c.at.toISOString(),
        reopenedBy: person(c.byMembershipId),
        reason: c.reason,
        lastWeekItems: shownLastWeekItems(c.lastWeekItems, leadsShown).map(lastWeekItemView),
        leadActions: leadsShown ? c.leadActions.map(leadActionView) : [],
        actionItems: shownActionItems(c.actionItems, leadsShown).map(actionItemView),
        tips: c.tips.map(tipView),
      })),
    };

    await this.subjectReads.record(
      ctx, { membershipId: session.coacheeMembershipId }, 'coaching_session',
      { from: null, to: open ? day.today : (session.date as LocalDate) },
    );
    return view;
  }

  /**
   * **The last day the reader may reopen it**, for a reader who may (ADR-0079): its coach while they coach
   * the coachee, or `own-kpm` while the coach still does — and only while it is `finalized`, and never to
   * its coachee, an Owner or an Admin who is one included (ADR-0078). Given past the window too, so *Edit
   * again* can say until when it could have been.
   */
  private async reopenableFor(
    ctx: RequestContext, session: CoachingSessionDocument, standing: Standing,
  ): Promise<string | null> {
    if (session.status !== 'finalized' || standing.isCoachee) return null;
    const may = standing.live || (
      officeWide(ctx, 'coaching_session:reopen')
      && await this.coach.coaches(ctx, session.coachMembershipId, session.coacheeMembershipId)
    );
    return may ? reopenableUntil(session.date as LocalDate) : null;
  }

  /**
   * **The coachee is told, and the round's held goal email goes out** (P11-T5 AC-7, P11-T8 AC-4). The
   * notice's payload is `{ sessionId }`: no note, no tip, no item, nothing a leader typed, because an
   * in-app payload is stored. Neither failure fails the finalize, which has already been written: each
   * is logged at error level.
   *
   * **The finalize does not wait for the email** (found on the browser walk: an SMTP adapter that timed
   * out held the coach's *Finalize* for ten seconds). The in-app notice is awaited — the database's work,
   * not a mail server's — so the coachee's inbox holds it by the time the coach sees *finalized*. The
   * held email is **released without being awaited**, after the session's write and the notice:
   * `releaseHeld` claims it (`held` → `pending`, one conditional write, so it is still sent once), sends
   * it through the adapter and records `sent` or `failed` on the delivery map, after the answer has gone.
   * Anything it throws is logged here at error level, and never reaches the request.
   *
   * *A host that freezes a function once its response is sent* (Vercel, ADR-0041) may pause that work
   * until its next invocation, or end it. The email then stays `held` or `pending` on its notice: visible
   * on the delivery map, rather than lost silently.
   */
  private async announceFinalized(
    ctx: RequestContext, session: CoachingSessionDocument, coachee: MembershipDocument,
  ): Promise<void> {
    const sessionId = String(session._id);
    try {
      await this.notifications.send({
        userId: String(coachee.userId),
        kpmId: ctx.kpmId,
        membershipId: session.coacheeMembershipId,
        templateId: NotificationTemplate.COACHING_SESSION_FINALIZED,
        payload: { sessionId },
      });
    } catch (err) {
      this.logger.error({ err, sessionId }, 'failed to notify the coachee of a finalized session');
    }
    this.releaseHeldEmail(ctx.kpmId as string, coalesceKeyOf(session), sessionId);
  }

  /**
   * **Fire and forget, safely**: called synchronously so the claim starts now, and caught whole — a
   * rejection and a synchronous throw alike — so a failed release is a log line, never an unhandled
   * rejection and never the request's failure.
   */
  private releaseHeldEmail(kpmId: string, coalesceKey: string, sessionId: string): void {
    const failed = (err: unknown) =>
      this.logger.error({ err, sessionId, coalesceKey }, 'failed to send the session’s held goal email');
    try {
      void Promise.resolve(this.notifications.releaseHeld(kpmId, coalesceKey, NotificationTemplate.GOAL_SET_BY_LEADER))
        .catch(failed);
    } catch (err) {
      failed(err);
    }
  }
}

// ------------------------------------------------------------------ the draft's lists

export function requireMe(ctx: RequestContext): string {
  const me = ctx.membershipId;
  if (!me) throw new NoMembershipException();
  return me;
}

function newId(): string {
  return new Types.ObjectId().toHexString();
}

function invalid(message: string, details: Record<string, unknown>): DomainException {
  return new DomainException(ErrorCode.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, details);
}

/** A date the body sent: `YYYY-MM-DD` that is a day, or `null`. `2026-02-31` is refused. */
function checkDate(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (!isLocalDate(value)) throw invalid(`${value} is not a date. Dates are written YYYY-MM-DD.`, { field, value });
  return value;
}

/** Last week's ticks and dates, written on this session. An item it does not hold is refused by id. */
function applyTicks(
  items: CoachingLastWeekItem[], changes: SaveSessionInput['lastWeekItems'],
): CoachingLastWeekItem[] {
  const byId = new Map(items.map((item) => [item.itemId, item]));
  for (const change of changes) {
    const item = byId.get(change.itemId);
    if (!item) throw invalid('One of last week’s items is not on this session.', { field: 'lastWeekItems', itemId: change.itemId });
    item.done = change.done;
    if (change.dueDate !== undefined) item.dueDate = checkDate(change.dueDate, 'lastWeekItems');
  }
  return items;
}

/**
 * The whole list as the coach left it: a row naming an id the session holds keeps that row's identity,
 * a row with none is new, and a row not sent is removed. An id the session does not hold, or one sent
 * twice, is refused by id.
 */
function replaceRows<Row, Kept>(
  existing: readonly Kept[], idOf: (row: Kept) => string,
  rows: readonly Row[], sentId: (row: Row) => string | undefined,
  field: string, build: (row: Row, prior: Kept | undefined) => Kept,
): Kept[] {
  const byId = new Map(existing.map((row) => [idOf(row), row]));
  const seen = new Set<string>();
  return rows.map((row) => {
    const id = sentId(row);
    if (id === undefined) return build(row, undefined);
    const prior = byId.get(id);
    if (!prior || seen.has(id)) throw invalid(`An id in ${field} is not on this session, or is sent twice.`, { field, id });
    seen.add(id);
    return build(row, prior);
  });
}

function plainLastWeekItem(item: CoachingLastWeekItem): CoachingLastWeekItem {
  return {
    itemId: item.itemId, text: item.text, dueDate: item.dueDate, leadId: item.leadId, leadName: item.leadName, done: item.done,
  };
}

function plainActionItem(item: CoachingActionItem): CoachingActionItem {
  return { itemId: item.itemId, text: item.text, dueDate: item.dueDate, carriedFromItemId: item.carriedFromItemId };
}

function plainTip(tip: CoachingTip): CoachingTip {
  return { tipId: tip.tipId, text: tip.text, carriedFromTipId: tip.carriedFromTipId };
}

function plainLeadAction(action: CoachingLeadAction): CoachingLeadAction {
  return { leadId: action.leadId, leadName: action.leadName, dueDate: action.dueDate, text: action.text };
}

/** A finalized version as plain data, ready to be kept whole in `corrections[]`. */
function plainVersion(version: FinalizedVersion): Omit<CoachingSessionCorrection, 'at' | 'byMembershipId' | 'reason'> {
  return {
    version: version.version,
    lastWeekItems: version.lastWeekItems.map(plainLastWeekItem),
    actionItems: version.actionItems.map(plainActionItem),
    tips: version.tips.map(plainTip),
    leadActions: version.leadActions.map(plainLeadAction),
    finalizedAt: version.finalizedAt,
    finalizedByMembershipId: version.finalizedByMembershipId,
  };
}

// ------------------------------------------------------------------ the wire

function lastWeekItemView(item: CoachingLastWeekItem): LastWeekItemView {
  return {
    itemId: item.itemId,
    text: item.text,
    dueDate: item.dueDate,
    lead: item.leadId ? { leadId: item.leadId, name: item.leadName ?? '' } : null,
    done: item.done,
  };
}

function leadActionView(action: CoachingLeadAction): LeadActionView {
  return { leadId: action.leadId, leadName: action.leadName, dueDate: action.dueDate, text: action.text };
}

function actionItemView(item: CoachingActionItem): ActionItemView {
  return { itemId: item.itemId, text: item.text, dueDate: item.dueDate };
}

function tipView(tip: CoachingTip): TipView {
  return { tipId: tip.tipId, text: tip.text };
}

function snapshotView(snapshot: CoachingSnapshot): CoachingSessionView['snapshot'] {
  return {
    takenAt: snapshot.takenAt.toISOString(),
    goal: snapshot.goal,
    ratios: snapshot.ratios,
    activity: snapshot.activity,
  };
}
