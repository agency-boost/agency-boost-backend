import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { LeaderMeetingShareLink, type LeaderMeetingShareLinkDocument } from './leader-meeting-share-link.schema';

/**
 * **The office's shared links, behind the chokepoint** (invariant §1; ADR-0131 §7): a link is looked up inside the
 * reader's own office, so another office's token is simply not found — the same answer as an unknown one.
 */
@Injectable()
export class LeaderMeetingShareLinkRepository extends TenantScopedRepository<LeaderMeetingShareLinkDocument> {
  constructor(@InjectModel(LeaderMeetingShareLink.name) model: Model<LeaderMeetingShareLinkDocument>) {
    super(model, 'leaderMeetingShareLinks');
  }

  /** The live link with this token's hash — not revoked, and `now` strictly before it expires — or `null`. */
  async findLive(ctx: RequestContext, tokenHash: string, now: Date): Promise<LeaderMeetingShareLinkDocument | null> {
    return this.findOne(ctx, { tokenHash, revokedAt: null, expiresAt: { $gt: now } });
  }

  /** A meeting's live links: what *Stop sharing* revokes. */
  async liveFor(ctx: RequestContext, meetingId: string, now: Date): Promise<LeaderMeetingShareLinkDocument[]> {
    return this.find(ctx, { meetingId, revokedAt: null, expiresAt: { $gt: now } });
  }

  /** Revoke one link, only if nobody has yet; `null` when somebody did first. */
  async revoke(ctx: RequestContext, id: string, at: Date): Promise<LeaderMeetingShareLinkDocument | null> {
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'revoke', { _id: id, revokedAt: null } as FilterQuery<LeaderMeetingShareLinkDocument>),
      { $set: { revokedAt: at, revokedBy: ctx.membershipId, updatedBy: ctx.membershipId } },
      { new: true },
    ).exec();
  }
}
