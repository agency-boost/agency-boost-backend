import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { LocalDate } from '@/common/time/local-day';
import { AuditService } from '@/modules/audit/audit.service';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MemberNames } from '@/modules/org/member-names.service';
import { CoachingSessionRepository } from './coaching-session.repository';
import { latestFinalized } from './coaching-session.rules';
import type { CoachingSessionDocument, SnapshotPeriodFigures } from './coaching-session.schema';
import { COACHING_REFUSALS } from './coaching.messages';
import {
  COUNTED, historyCounts, NEWEST, notFound, readsFinalized, requireMe, reviewedCounts, shownActionItems, shownLastWeekItems,
  showsLeadsTo, standingOf, type SessionHistoryRow, type SessionPerson,
} from './coaching-session.service';

/** One period of the printed goal: the target and the APE produced, as the 1:1 saw them. */
export interface PrintPeriod {
  targetMinor: number | null;
  actualMinor: number | null;
}

/**
 * **A finalized session, as printed** (`Overall.html:11145-11187`; ADR-0077; the Data contract's
 * `GET /coaching/sessions/:sessionId/print`). What the prototype's export holds — last week's items with
 * their ticks, the goal, the tips and the next actions with their lead names — read from the latest
 * finalized version and the snapshot frozen at the first finalize. **No ratios, no activity, no leads
 * table, no membership id, and no note**: nothing here is a field a leader note could be in.
 */
export interface SessionPrintView {
  sessionId: string;
  /** The finalized version printed. */
  version: number;
  /** The session's day — the office's day of its first finalize — never today's (a Fix of the prototype). */
  date: string;
  coachee: { name: string };
  coach: { name: string };
  lastWeekItems: { text: string; done: boolean }[];
  /**
   * The goal the 1:1 looked at, from the snapshot: its targets `null` for a coachee with no goal, the APE
   * produced `null` where nothing was held yet. `null` whole for a session that holds no snapshot.
   */
  goal: { currency: string; monthly: PrintPeriod; yearly: PrintPeriod } | null;
  tips: { text: string }[];
  leadActions: { dueDate: string; text: string; leadName: string }[];
  actionItems: { dueDate: string | null; text: string }[];
}

/** One of the sessions a former coach led with somebody they no longer coach (ADR-0088). */
export interface LedSessionRow {
  sessionId: string;
  date: string;
  /** Who it was about: the archive's address is `/coaching/{coachee.membershipId}/archive/{sessionId}`. */
  coachee: SessionPerson;
  actionItemCount: number;
  completedCount: number;
}

/** `GET /coaching/me/sessions`: the reader's own coaching, and what they led for people they no longer coach. */
export interface MySessionsView {
  sessions: SessionHistoryRow[];
  ledFormerly: LedSessionRow[];
}

/** Each period's two printed figures: the target and the APE produced. */
function printed(period: SnapshotPeriodFigures): PrintPeriod {
  return { targetMinor: period.targetMinor, actualMinor: period.actualMinor };
}

const never = () => false;

/**
 * **The record after the meeting** (P11-T10; `functional/coaching.md`, *Archive*, *`/coaching/me`*,
 * *Exports*): the print of a finalized session, and the reader's own sessions.
 *
 * **The print is its own read** (ADR-0077), not the archive's: it checks `coaching_session:export_pdf`,
 * answers *Who reads a session*'s readers through the same rule the session read uses (`standingOf`,
 * `readsFinalized`), and prints **finalized versions only** — the latest, so a session under correction
 * prints the version the correction will replace. A reader admitted only office-wide prints it without its
 * lead names and lead-note text, as they read it (`showsLeadsTo`, roles §3.7). A session never finalized
 * is its coach's alone: they are told it is not finalized (409), and anybody else is answered as though it
 * did not exist (404). Every print writes `coaching_session.exported`, the coachee's own included, and a
 * print by anybody but the coachee writes the §3.5 entry, surface `coaching_session_print`. Both are
 * written last, once the answer exists, and both fail open (D-failopen).
 *
 * **`/coaching/me`'s list is a self-read** (ADR-0078) and writes nothing: the finalized sessions in which
 * the reader is the coachee, each *Coached by {leader}*. Beside it, **the sessions the reader led with
 * somebody they no longer coach** (ADR-0088, OD-106): ADR-0082 keeps a former coach's read of what they
 * led, and this is the one list a screen reaches it from. Dates, names and counts, as a coachee's history
 * is, so it writes no entry either; each row opens the archive, whose read writes its own.
 */
@Injectable()
export class CoachingRecordService {
  private readonly logger = new Logger(CoachingRecordService.name);

  constructor(
    private readonly sessions: CoachingSessionRepository,
    private readonly coach: CoachResolver,
    private readonly names: MemberNames,
    private readonly audit: AuditService,
    private readonly subjectReads: SubjectReadAudit,
  ) {}

  /** **`GET /coaching/sessions/:sessionId/print`** — the latest finalized version, as printed. */
  async print(ctx: RequestContext, sessionId: string): Promise<SessionPrintView> {
    const session = await this.sessions.findById(ctx, sessionId);
    if (!session) throw notFound();
    const standing = await standingOf(this.coach, ctx, session, 'coaching_session:export_pdf');
    const shown = latestFinalized(session);
    if (!shown) {
      // Never finalized: its coach's working copy. Only they learn that it exists.
      if (!standing.live) throw notFound();
      throw new DomainException(
        ErrorCode.COACHING_SESSION_NOT_FINALIZED,
        COACHING_REFUSALS.COACHING_SESSION_NOT_FINALIZED.printFinalizedOnly,
        HttpStatus.CONFLICT,
        { status: session.status },
      );
    }
    if (!readsFinalized(standing)) throw notFound();
    // Roles §3.7, as the session read: no lead name and no lead-note text to a reader admitted only office-wide.
    const leadsShown = await showsLeadsTo(this.coach, ctx, session, standing);

    const people = await this.names.byMembershipId(ctx, [session.coachMembershipId, session.coacheeMembershipId]);
    const goal = session.snapshot?.goal ?? null;
    const view: SessionPrintView = {
      sessionId: String(session._id),
      version: shown.version,
      date: session.date as string,
      coachee: { name: people.get(session.coacheeMembershipId) ?? '' },
      coach: { name: people.get(session.coachMembershipId) ?? '' },
      lastWeekItems: shownLastWeekItems(shown.lastWeekItems, leadsShown).map((item) => ({ text: item.text, done: item.done })),
      goal: goal ? { currency: goal.currency, monthly: printed(goal.monthly), yearly: printed(goal.yearly) } : null,
      tips: shown.tips.map((tip) => ({ text: tip.text })),
      leadActions: leadsShown ? shown.leadActions.map((a) => ({ dueDate: a.dueDate, text: a.text, leadName: a.leadName })) : [],
      actionItems: shownActionItems(shown.actionItems, leadsShown).map((item) => ({ dueDate: item.dueDate, text: item.text })),
    };

    await this.recordExport(ctx, session, shown.version);
    await this.subjectReads.record(
      ctx, { membershipId: session.coacheeMembershipId }, 'coaching_session_print',
      { from: null, to: session.date as LocalDate },
    );
    return view;
  }

  /**
   * **`GET /coaching/me/sessions`** — the finalized sessions about the reader, newest first, and the ones
   * they led with somebody they no longer coach. Each row counts its latest finalized version's items and
   * how many the next session ticked done — a finalized one: a draft is somebody's working copy and reviews
   * nothing the reader may count. A former coach's counts read only the sessions they led, as their read of
   * that coachee's history does.
   */
  async mine(ctx: RequestContext): Promise<MySessionsView> {
    const me = requireMe(ctx);
    const counted = { status: { $in: [...COUNTED] } };
    const [about, led] = await Promise.all([
      this.sessions.find(ctx, { coacheeMembershipId: me, ...counted }, { sort: NEWEST }),
      this.sessions.find(ctx, { coachMembershipId: me, ...counted }, { sort: NEWEST }),
    ]);
    // Whom the reader coaches now: a session with any of them is the roster's, not this list's.
    const coachesNow = led.length === 0
      ? new Set<string>()
      : new Set((await this.coach.coacheesOf(ctx, me)).map((c) => c.membershipId));
    const formerly = led.filter((session) => !coachesNow.has(session.coacheeMembershipId));

    const [reviewedAbout, reviewedLed, people] = await Promise.all([
      this.reviewed(ctx, about, { coacheeMembershipId: me }),
      this.reviewed(ctx, formerly, { coachMembershipId: me }),
      this.names.byMembershipId(ctx, [
        ...about.map((s) => s.coachMembershipId), ...formerly.map((s) => s.coacheeMembershipId),
      ]),
    ]);
    const person = (membershipId: string): SessionPerson => ({ membershipId, name: people.get(membershipId) ?? '' });

    return {
      sessions: about.map((session) => {
        const { sessionId, date, actionItemCount, completedCount } = historyCounts(session, reviewedAbout);
        return { sessionId, date, coach: person(session.coachMembershipId), actionItemCount, completedCount };
      }),
      ledFormerly: formerly.map((session) => {
        const { sessionId, date, actionItemCount, completedCount } = historyCounts(session, reviewedLed);
        return { sessionId, date, coachee: person(session.coacheeMembershipId), actionItemCount, completedCount };
      }),
    };
  }

  /** How many of each session's items a later finalized session — among those `within` holds — ticked done. */
  private async reviewed(
    ctx: RequestContext, listed: readonly CoachingSessionDocument[], within: Record<string, string>,
  ): Promise<Map<string, number>> {
    if (listed.length === 0) return new Map();
    const reviewers = await this.sessions.find(
      ctx, { ...within, 'lastWeek.sessionId': { $in: listed.map((s) => String(s._id)) } }, { sort: NEWEST },
    );
    return reviewedCounts(reviewers, never);
  }

  /**
   * **Every export is audited** (roles §7.4, ADR-0077): the actor, the session and the version printed,
   * the coachee, and one row. Written whoever prints it, the coachee included, and **failing open** —
   * `AuditService.record` catches its own write, and this catches anything else, so the guarantee belongs
   * to the print rather than to how the service under it happens to be written.
   */
  private async recordExport(ctx: RequestContext, session: CoachingSessionDocument, version: number): Promise<void> {
    try {
      await this.audit.record(ctx, {
        action: 'coaching_session.exported',
        targetCollection: 'coachingSessions',
        targetId: String(session._id),
        targetMembershipId: session.coacheeMembershipId,
        after: { version, date: session.date, rowCount: 1 },
      });
    } catch (err) {
      this.logger.error({ err, action: 'coaching_session.exported' }, 'failed to write audit entry');
    }
  }
}
