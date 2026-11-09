import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  MDRT_CAMPAIGN_CODE, type CampaignKind, type CampaignPosterColor, type CampaignSubtype, type CampaignWindow,
} from '@/domain/constants';
import { campaignPhase } from '@/domain/metrics/campaign-window';
import { CampaignChaseRepository } from './campaign-chase.repository';
import { CampaignRepository } from './campaign.repository';
import { campaignOrder, mdrtTooltip } from './campaign-words';

/** A campaign somebody is chasing, as every *chasing* list draws it. Never an ended one (D-lists). */
export interface ChasedCampaign {
  code: string;
  title: string;
  kind: CampaignKind;
  subtype: CampaignSubtype | null;
  window: CampaignWindow;
  phase: 'upcoming' | 'running';
  startsAt: Date;
  endsAt: Date | null;
  poster: { emoji: string; color: CampaignPosterColor };
}

/** The chases of many members, and the office's MDRT campaign the roster's ✓ binds to. */
export interface ChaseReading {
  /** Each member asked about, with their chases of campaigns not ended, in D-lists' order — `[]` for none. */
  byMember: Map<string, ChasedCampaign[]>;
  /** Whether the office's `MDRT_QUALIFICATION` is running — and the header tooltip composed from it (OD-152), for the reader. */
  mdrt: { running: boolean; tooltip: string };
}

/**
 * **The one named reader of chases** (P18.2-T7 AC-8, P18.2-T9 AC-2): the Personal Summary's *Campaigns you're
 * chasing*, the coachee's *Campaigns she's chasing*, and the Unit Dashboard's *Chasing MDRT* ✓ and *Campaigns
 * they're chasing* all read here — so the chips, the ✓ and the rows cannot disagree (exit test 3, ADR-0122).
 *
 * **Two queries for any number of members**: their chases, and the office's active campaigns. A chase counts while
 * it is on, of a campaign that is active and has not ended (D-lists); an archived campaign's chases are nobody's.
 * Reach is the caller's: this reads whoever it is asked about, and every caller has resolved them through
 * `CoachResolver` first. No §3.5 entry — a chase is not an activity row.
 *
 * The Unit Dashboard may import this file and nothing else of the module (`unit-dashboard.imports.spec.ts`).
 */
@Injectable()
export class CampaignChaseReadings {
  constructor(
    private readonly campaigns: CampaignRepository,
    private readonly chases: CampaignChaseRepository,
    private readonly clock: Clock,
  ) {}

  async ofMany(ctx: RequestContext, membershipIds: readonly string[]): Promise<ChaseReading> {
    const ids = [...new Set(membershipIds)];
    const now = this.clock.now();
    const [rows, campaigns] = await Promise.all([
      ids.length === 0 ? Promise.resolve([]) : this.chases.find(ctx, { membershipId: { $in: ids }, chasing: true }),
      this.campaigns.find(ctx, { status: 'active' }),
    ]);
    const live = new Map<string, ChasedCampaign>();
    let mdrt: (typeof campaigns)[number] | null = null;
    for (const c of campaigns) {
      const phase = campaignPhase(c.startsAt, c.endsAt, now);
      if (phase === 'ended') continue;
      // The header speaks of an MDRT campaign that is running — an upcoming one is not yet (the review, item 13).
      if (c.code === MDRT_CAMPAIGN_CODE && phase === 'running') mdrt = c;
      live.set(c.code, {
        code: c.code,
        title: c.title,
        kind: c.kind,
        subtype: c.subtype,
        window: c.window,
        phase,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        poster: { emoji: c.poster.emoji, color: c.poster.color },
      });
    }
    const byMember = new Map<string, ChasedCampaign[]>(ids.map((id) => [id, []]));
    for (const chase of rows) {
      const campaign = live.get(chase.campaignCode);
      if (campaign) byMember.get(chase.membershipId)?.push(campaign);
    }
    for (const list of byMember.values()) list.sort(campaignOrder);
    return {
      byMember,
      mdrt: {
        running: mdrt !== null,
        // Written for the reader who asked (P18.10-T5 AC-4): the Unit Dashboard's header answers it as it is.
        tooltip: mdrtTooltip(mdrt === null ? null : { requirements: mdrt.requirements }, ctx.reader),
      },
    };
  }
}
