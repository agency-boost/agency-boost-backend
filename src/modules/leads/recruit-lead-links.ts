import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException } from '@/common/errors/domain.exception';
import { AuditService } from '@/modules/audit/audit.service';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { LeadRepository } from './lead.repository';

/**
 * **A recruitment lead's link to the membership it became** (P19.1-T6 AC-7, AC-12; UI-155; ADR-0193 §3): *Tambahkan ke
 * unit ›* on the Unit Dashboard's *Potensi* tab opens *+ Add agent* with the kandidat's name, and the form carries the
 * lead's id. The org module's `InvitesService` asks here, so the leads module keeps its own rows:
 *
 * - **`check`, before anything is written**: the lead is a recruitment lead marked *Berhasil* in the caller's office,
 *   one the caller reads (`lead:read` — their own, or somebody's they coach), and not yet linked. Anything else —
 *   another office's lead, a sales lead, an open one, a colleague's outside the reach, one linked already — is `404
 *   NOT_FOUND`, answered alike, so the refusal tells nobody which lead exists.
 * - **`link`, once the membership exists**: at once when the code links an account already in the office, or when the
 *   invite the form made is accepted. Written only while the lead holds no link, so a second form names nobody twice.
 *   Audited `lead.recruit_linked`, never with a name.
 *
 * The link decides which button the row offers — *New Hires ›* or *Tambahkan ke unit ›* — and never whether the lead
 * counts as a rekrut, which its outcome alone decides.
 */
@Injectable()
export class RecruitLeadLinks {
  constructor(
    private readonly leads: LeadRepository,
    private readonly coach: CoachResolver,
    private readonly audit: AuditService,
  ) {}

  async check(ctx: RequestContext, leadId: string): Promise<void> {
    const lead = await this.leads.findById(ctx, leadId);
    if (!lead || lead.type !== 'recruitment' || lead.outcome !== 'won' || lead.joinedMembershipId) {
      throw new NotFoundException('Lead');
    }
    const owners = await this.coach.reach(ctx, 'lead:read');
    if (owners !== null && !owners.includes(lead.ownerMembershipId)) throw new NotFoundException('Lead');
  }

  async link(ctx: RequestContext, leadId: string, membershipId: string): Promise<void> {
    const written = await this.leads.updateMany(
      ctx,
      { _id: leadId, type: 'recruitment', outcome: 'won', joinedMembershipId: null },
      { $set: { joinedMembershipId: membershipId } },
    );
    if (written === 0) return;
    await this.audit.record(ctx, {
      action: 'lead.recruit_linked',
      targetCollection: 'leads',
      targetId: leadId,
      targetMembershipId: membershipId,
      after: { joinedMembershipId: membershipId },
    });
  }
}
