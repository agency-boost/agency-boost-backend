import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import { AuditService } from '@/modules/audit/audit.service';
import { CoachingSessionRepository } from './coaching-session.repository';
import { latestFinalized } from './coaching-session.rules';

/** What `PUT /coaching/sessions/:sessionId/action-items/:itemId/done` answers: the item, and where it stands now. */
export interface CoachingItemDoneView {
  sessionId: string;
  itemId: string;
  done: boolean;
}

/** The record a tick or its undo leaves: ids and a yes or a no, never the item's words. */
export const COACHING_ITEM_DONE_AUDIT_ACTION = 'coaching_session.action_item_done';

/**
 * **A coachee ticks one of their action items done, from Calendar** (UI V1, 2026-10-30, UI-104 point 4; ADR-0180 §11;
 * `functional/coaching.md`, *UI V1*): *Selesai*, and *Urungkan* to take it back.
 *
 * - **Who**: the session's coachee, and nobody else — not its coach, not a leader above (*no checkboxes on other
 *   people's tasks*). Anybody else, a draft, another office's session, an item the session's finalized version does
 *   not hold, or nobody's id: `404`, one answer for all, so it confirms nothing.
 * - **What**: a row beside what was agreed (`actionItemsDone`), never the agreed lists — so no `version` moves and no
 *   edit conflicts with it, as a calendar answer conflicts with none. Sending what is stored already writes and records
 *   nothing.
 * - **Then**: the item leaves the coachee's Calendar and Home's count, and the next *Start* with them ticks it in its
 *   review (`reviewedItems`).
 */
@Injectable()
export class CoachingActionDone {
  constructor(
    private readonly sessions: CoachingSessionRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async set(ctx: RequestContext, sessionId: string, itemId: string, done: boolean): Promise<CoachingItemDoneView> {
    const me = ctx.membershipId;
    if (!me) throw new NoMembershipException();
    const session = await this.sessions.findOne(ctx, {
      _id: sessionId, coacheeMembershipId: me, status: { $in: ['finalized', 'reopened'] },
    });
    const agreed = session ? latestFinalized(session) : null;
    if (!session || !agreed?.actionItems.some((item) => item.itemId === itemId)) {
      throw new NotFoundException('Coaching session');
    }
    const before = (session.actionItemsDone ?? []).some((d) => d.itemId === itemId);
    if (before === done) return { sessionId, itemId, done };

    const written = await this.sessions.setItemDone(
      ctx, sessionId, me, done ? { itemId, done: true, at: this.clock.now() } : { itemId, done: false },
    );
    if (!written) throw new NotFoundException('Coaching session');
    await this.audit.record(ctx, {
      action: COACHING_ITEM_DONE_AUDIT_ACTION,
      targetCollection: 'coachingSessions',
      targetId: sessionId,
      targetMembershipId: me,
      before: { itemId, done: before },
      after: { itemId, done },
    });
    return { sessionId, itemId, done };
  }
}
