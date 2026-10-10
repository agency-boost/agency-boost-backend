import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { CampaignKind, CampaignSubtype, CampaignWindow } from '@/domain/constants';
import type { QualificationStatus } from '@/domain/metrics/campaign-qualification';
import { campaignPhase } from '@/domain/metrics/campaign-window';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { CampaignEvaluation, evaluationInput } from './campaign-evaluation';
import { CampaignRepository } from './campaign.repository';

/** One campaign as Phase 18.6's tree lists it. */
export interface OfficeCampaign {
  code: string;
  title: string;
  kind: CampaignKind;
  subtype: CampaignSubtype | null;
  phase: 'upcoming' | 'running' | 'ended';
  window: CampaignWindow;
  startsAt: string;
  endsAt: string | null;
  /** Who it applies to, by rung code; empty is everybody. */
  appliesToOrgLevelCodes: string[];
  /** The window as read today: its key, its words, and whether its result is final (OD-154). */
  windowKey: string;
  windowLabel: string;
  final: boolean;
}

/** One member in one campaign: the tree's *Chasing* / *Not chasing* and *Achieved* / *Not achieved* / —. */
export interface OfficeStanding {
  campaignCode: string;
  membershipId: string;
  chasing: boolean;
  eligible: boolean;
  /** `CAMPAIGN_QUALIFICATION_STATUS`: only a chaser is `qualified` (OD-153). */
  status: QualificationStatus;
  final: boolean;
}

export interface OfficeStandings {
  campaigns: OfficeCampaign[];
  standings: OfficeStanding[];
}

/**
 * **The bulk reader Phase 18.6 builds the compliance tree's *Campaigns* chip on** (P18.5-T8 AC-8; D-tasks) — a
 * service port, **no route**: an API ships with its screen, and the screen is 18.6's.
 *
 * `ofOffice(ctx, { codes? })`: the office's active campaigns — every one, or those codes — and for every active member
 * of the office and every campaign, the chase, the eligibility, the status and its finality, through the one
 * evaluation the agent's dialog reads (`CampaignEvaluation`), so the tree and the dialog cannot disagree. Final
 * standings come from `campaignStandings` as frozen. **A fixed number of queries for any office** (AC-9). The caller
 * owns the permission (`kpm_analytics:read`, whose reach is the office): this reads the context's office and no other.
 * The override is 18.6's and lands on the stored standing.
 */
@Injectable()
export class CampaignStandingsReader {
  constructor(
    private readonly campaigns: CampaignRepository,
    private readonly memberships: MembershipRepository,
    private readonly evaluation: CampaignEvaluation,
    private readonly clock: Clock,
  ) {}

  async ofOffice(ctx: RequestContext, opts: { codes?: readonly string[] } = {}): Promise<OfficeStandings> {
    const filter = opts.codes ? { status: 'active', code: { $in: [...opts.codes] } } : { status: 'active' };
    const [rows, members] = await Promise.all([
      this.campaigns.find(ctx, filter, { sort: { code: 1 } }),
      this.memberships.find(ctx, { status: 'active' }, { projection: { _id: 1 } }),
    ]);
    const ids = members.map((m) => String(m._id));
    const evaluated = await this.evaluation.evaluate(ctx, rows.map(evaluationInput), ids);
    const now = this.clock.now();

    const campaigns: OfficeCampaign[] = rows.map((row) => {
      const e = evaluated.get(row.code)!;
      return {
        code: row.code,
        title: row.title,
        kind: row.kind,
        subtype: row.subtype,
        phase: campaignPhase(row.startsAt, row.endsAt, now),
        window: row.window,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt ? row.endsAt.toISOString() : null,
        appliesToOrgLevelCodes: [...row.appliesToOrgLevelCodes],
        windowKey: e.window.key,
        windowLabel: e.window.label,
        final: e.final,
      };
    });
    const standings = rows.flatMap((row) => [...evaluated.get(row.code)!.members.values()].map((m): OfficeStanding => ({
      campaignCode: row.code,
      membershipId: m.membershipId,
      chasing: m.chasing,
      eligible: m.eligible,
      status: m.status,
      final: m.final,
    })));
    return { campaigns, standings };
  }
}
