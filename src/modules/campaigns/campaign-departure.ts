import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import { MemberDeparture } from '@/modules/org/member-departure.port';
import { CampaignChaseRepository } from './campaign-chase.repository';

/**
 * **A leaver's chases close** (P18.5-T7 AC-5; ADR-0136): when a member leaves, every chase they had on is dropped,
 * `closedBy: 'departure'`, so no *chasing* list, ✓ or chip names somebody who is no longer in the office. **A window
 * that ended before they left still counts them**: its freeze reads the chase as it stood at the window's end, and
 * the close is after it (`campaign-evaluation.ts`, ADR-0143 §2) — so a leaver between a window's end and its freeze
 * keeps their standing. Their final standings stay the office's, untouched.
 *
 * **One write for all of them, and each close audited** (`campaign.unchased`, before and after, in one insert).
 * Called by `RemovalService` through the `MemberDeparture` port, with the remover's context.
 */
@Injectable()
export class CampaignChaseDeparture extends MemberDeparture {
  constructor(
    private readonly chases: CampaignChaseRepository,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {
    super();
  }

  async left(ctx: RequestContext, membershipId: string): Promise<void> {
    const open = await this.chases.find(ctx, { membershipId, chasing: true });
    if (open.length === 0) return;
    const at = this.clock.now();
    await this.chases.updateMany(
      ctx,
      { _id: { $in: open.map((c) => c._id) }, chasing: true },
      { $set: { chasing: false, unchasedAt: at, closedBy: 'departure' } },
    );
    await this.audit.recordMany(ctx, open.map((c) => ({
      action: 'campaign.unchased',
      targetCollection: 'campaignChases',
      targetId: String(c._id),
      targetMembershipId: membershipId,
      before: { campaignCode: c.campaignCode, chasing: true },
      after: { campaignCode: c.campaignCode, chasing: false, closedBy: 'departure' },
    })));
  }
}
