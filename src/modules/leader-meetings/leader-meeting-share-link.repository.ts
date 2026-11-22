import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { LeaderMeetingShareLink, type LeaderMeetingShareLinkDocument } from './leader-meeting-share-link.schema';

/**
 * **The office's shared links, behind the chokepoint** (invariant §1; ADR-0131 §7): a link is looked up inside the
 * reader's own office, so another office's token is simply not found — the same answer as an unknown one. A link is
 * never revoked by hand since *Stop sharing* went (ADR-0276); `revokedAt` stays, for the links revoked before.
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
}
