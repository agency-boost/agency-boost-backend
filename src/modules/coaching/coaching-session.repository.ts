import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, UpdateQuery } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { CoachingSession, CoachingSessionDocument, type CoachingSessionStatus } from './coaching-session.schema';

/**
 * Every coaching session, through the chokepoint (invariant §1; P11-T5).
 *
 * **No unscoped method, and none is wanted.** A session is a record about a member of one office, and
 * the Super Admin's `all` on `coaching_session:read` is not access: the routes resolve the office from
 * the caller's membership, and a Super Admin reaches a session only by impersonation, scoped like
 * anybody else (`functional/coaching.md`, *The permissions*).
 */
@Injectable()
export class CoachingSessionRepository extends TenantScopedRepository<CoachingSessionDocument> {
  constructor(@InjectModel(CoachingSession.name) model: Model<CoachingSessionDocument>) {
    super(model, 'coachingSessions');
  }

  /**
   * **A pinned write** (ADR-0042, P11-T5 AC-3): the update lands only while the session is still at the
   * `version` the writer read and in one of `statuses`, and moves `version` on — one conditional write,
   * so of two devices saving the same version one wins and the other gets `null`, which the service
   * answers `VERSION_CONFLICT` or `COACHING_SESSION_FINALIZED` after reading why. Scoped and soft-delete
   * aware like every other write here.
   */
  async updateIfAt(
    ctx: RequestContext,
    id: string,
    at: { version: number; statuses: readonly CoachingSessionStatus[] },
    update: { $set: Record<string, unknown> } & UpdateQuery<CoachingSessionDocument>,
  ): Promise<CoachingSessionDocument | null> {
    const filter = this.scope(ctx, 'updateIfAt', {
      _id: id, version: at.version, status: { $in: [...at.statuses] },
    } as FilterQuery<CoachingSessionDocument>);
    return this.model
      .findOneAndUpdate(
        filter,
        { ...update, $set: { ...update.$set, updatedBy: ctx.membershipId }, $inc: { version: 1 } },
        { new: true },
      )
      .exec();
  }
}
