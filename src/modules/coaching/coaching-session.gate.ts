import { HttpStatus, Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { CoachingSessionRepository } from './coaching-session.repository';
import { coalesceKeyOf } from './coaching-session.rules';

/** The refusal of a write to a finalized session, wherever it is made (`functional/coaching.md`, *Errors*). */
export function sessionFinalized(sessionId: string): DomainException {
  return new DomainException(
    ErrorCode.COACHING_SESSION_FINALIZED,
    'This session is finalized and locked to view-only. Reopen it to change what was agreed.',
    HttpStatus.CONFLICT,
    { sessionId },
  );
}

/**
 * **`PUT /goals/:period?for=&session=`'s question: is this the caller's own open session with that
 * coachee?** (P11-T8, ADR-0075; `functional/coaching.md`, *The Goal card*.)
 *
 * The goals module asks here rather than reading sessions itself, and this reads no further than the
 * session and `COACH`: it depends on nothing that depends on goals.
 *
 * - **Its coach's, while they still coach the coachee, and about that coachee** — a draft, or one
 *   reopened. Anything else is **404**: somebody else's session, one about another person, one in
 *   another office, one whose coach's edge has closed (ADR-0082), an id that is nobody's.
 * - **Finalized** is `COACHING_SESSION_FINALIZED` (409), and only to its coach: the 404s come first, so a
 *   refusal never tells somebody else that the session exists.
 *
 * It answers the key the save's notice coalesces under (`coalesceKeyOf`).
 */
@Injectable()
export class CoachingSessionGate {
  constructor(
    private readonly sessions: CoachingSessionRepository,
    private readonly coach: CoachResolver,
  ) {}

  async openFor(
    ctx: RequestContext, sessionId: string, coacheeMembershipId: string,
  ): Promise<{ sessionId: string; coalesceKey: string }> {
    const me = ctx.membershipId;
    const session = await this.sessions.findById(ctx, sessionId);
    if (
      !session || session.coachMembershipId !== me || session.coacheeMembershipId !== coacheeMembershipId
      || !(await this.coach.coaches(ctx, me as string, coacheeMembershipId))
    ) {
      throw new NotFoundException('Coaching session');
    }
    if (session.status === 'finalized') throw sessionFinalized(sessionId);
    return { sessionId, coalesceKey: coalesceKeyOf(session) };
  }
}
