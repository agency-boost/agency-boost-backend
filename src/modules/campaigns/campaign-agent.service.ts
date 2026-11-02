import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Reader } from '@/common/i18n/reader';
import {
  metricByKey, isCampaignMetric,
  type CampaignKind, type CampaignPosterColor, type CampaignSubtype, type CampaignWindow, type MetricUnit,
} from '@/domain/constants';
import type { RequirementState } from '@/domain/metrics/campaign-qualification';
import { campaignPhase, durationWords, runsWords } from '@/domain/metrics/campaign-window';
import { AuditService } from '@/modules/audit/audit.service';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { can } from '@/modules/rbac/permissions';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { CampaignChaseReadings, type ChasedCampaign } from './campaign-chase-readings';
import { CampaignChaseRepository } from './campaign-chase.repository';
import { CampaignEvaluation, evaluationInput, isEligible } from './campaign-evaluation';
import type { CampaignDocument } from './campaign.schema';
import { CampaignRepository } from './campaign.repository';
import { campaignOrder } from './campaign-words';
import { CAMPAIGNS_REFUSALS } from './campaigns.messages';

export type CampaignPhase = 'upcoming' | 'running' | 'ended';

export interface AgentRequirementView {
  metricKey: string;
  metricName: string;
  comparator: string;
  value: number;
  unit: MetricUnit;
  /** `false`: a requirement outside the evaluable set, stored before it existed — *Not measured yet*. */
  measured: boolean;
}

export interface CampaignCardView {
  code: string;
  title: string;
  kind: CampaignKind;
  subtype: CampaignSubtype | null;
  window: CampaignWindow;
  phase: CampaignPhase;
  startsAt: string;
  endsAt: string | null;
  duration: string;
  poster: { emoji: string; color: CampaignPosterColor };
  blurb: string;
  reward: string;
  requirements: AgentRequirementView[];
  chasing: boolean;
  eligible: boolean;
  chaseBlocked: 'ended' | 'not_eligible' | null;
}

export interface CampaignListView {
  campaigns: CampaignCardView[];
  can: { chase: boolean };
}

export interface ProgressRowView {
  metricKey: string;
  current: number | null;
  target: number;
  unit: MetricUnit;
  state: RequirementState;
}

export interface CampaignDetailView extends CampaignCardView {
  description: string;
  can: { chase: boolean };
  progress: { windowLabel: string; final: boolean; rows: ProgressRowView[] } | null;
}

export interface ChasedCampaignView {
  code: string;
  title: string;
  kind: CampaignKind;
  subtype: CampaignSubtype | null;
  phase: 'upcoming' | 'running';
  duration: string;
  /**
   * The months it runs, the Personal Summary row's one line (P18.95-T7 AC-1, ADR-0167 §7): *Runs Jan – Des*, *Runs
   * Agu – Okt 2026*, *Runs over the last 12 months* (`runsWords`).
   */
  runs: string;
  poster: { emoji: string; color: CampaignPosterColor };
}

export interface ChasingView {
  membershipId: string;
  campaigns: ChasedCampaignView[];
}

/**
 * **The agent's campaigns** (P18.5-T7, T8, T9): the list, one campaign with the reader's progress, the chase, and
 * whose chases a reader may see.
 *
 * - **The office's active campaigns only** — an archived one, another office's or an unknown code is `404`, never
 *   `403` (invariant §1). The Owner and the Admin read and chase in their field view, by the rung they hold
 *   (ADR-0114); the Super Admin reads only inside a support session, as its member.
 * - **A chase is the member's own record** (`campaignChases`, keyed by the membership `_id` and the campaign's code),
 *   idempotent, audited with before and after, and refused once the campaign has ended (`409 CAMPAIGN_NOT_OPEN`,
 *   D-lists) or by a rung it does not apply to (`403 CAMPAIGN_NOT_ELIGIBLE`). An upcoming campaign is chaseable, as
 *   drawn. A read-only support session is refused by the guard (`campaign:chase` is a write).
 * - **Progress is the dialog's alone** (OD-157), computed for the reader through `CampaignEvaluation`.
 * - **The chases a person is chasing** come from the one named reader, `CampaignChaseReadings` — for the reader's own
 *   Summary and for a coachee's tab alike, so the two cannot differ (exit test 3). No §3.5 entry.
 */
@Injectable()
export class CampaignAgentService {
  constructor(
    private readonly campaigns: CampaignRepository,
    private readonly chases: CampaignChaseRepository,
    private readonly chaseReadings: CampaignChaseReadings,
    private readonly evaluation: CampaignEvaluation,
    private readonly coach: CoachResolver,
    private readonly memberships: MembershipRepository,
    private readonly audit: AuditService,
    private readonly days: TenantDay,
    private readonly clock: Clock,
  ) {}

  /** `GET /campaigns`: the office's active campaigns, in D-lists' order, each with the reader's chase. */
  async list(ctx: RequestContext): Promise<CampaignListView> {
    const me = requireMembership(ctx);
    const [rows, timezone] = await Promise.all([
      this.campaigns.find(ctx, { status: 'active' }),
      this.days.timezoneOf(ctx),
    ]);
    const chasing = await this.chasingCodes(ctx, me, rows.map((r) => r.code));
    const now = this.clock.now();
    const cards = rows
      .map((row) => ({ row, phase: campaignPhase(row.startsAt, row.endsAt, now) }))
      .sort((a, b) => campaignOrder(orderable(a.row, a.phase), orderable(b.row, b.phase)))
      .map(({ row, phase }) => this.card(ctx, row, phase, chasing.has(row.code), timezone));
    return { campaigns: cards, can: { chase: can(ctx, 'campaign:chase') } };
  }

  /** `GET /campaigns/:code`: one campaign, and — once it has begun — the reader's progress in each requirement row. */
  async detail(ctx: RequestContext, code: string): Promise<CampaignDetailView> {
    const me = requireMembership(ctx);
    const row = await this.find(ctx, code);
    const [timezone, chasing] = await Promise.all([this.days.timezoneOf(ctx), this.chasingCodes(ctx, me, [row.code])]);
    const phase = campaignPhase(row.startsAt, row.endsAt, this.clock.now());
    const card = this.card(ctx, row, phase, chasing.has(row.code), timezone);

    let progress: CampaignDetailView['progress'] = null;
    if (phase !== 'upcoming') {
      const evaluated = (await this.evaluation.evaluate(ctx, [evaluationInput(row)], [me])).get(row.code)!;
      const mine = evaluated.members.get(me)!;
      progress = {
        windowLabel: evaluated.window.label,
        final: evaluated.final,
        rows: mine.rows.map((r, i) => ({
          metricKey: r.metricKey,
          current: r.current,
          target: r.target,
          // A metric the registry no longer has keeps the unit it was stored with.
          unit: (metricByKey(r.metricKey)?.unit ?? row.requirements[i].unit) as MetricUnit,
          state: r.state,
        })),
      };
    }
    return { ...card, description: row.description, can: { chase: can(ctx, 'campaign:chase') }, progress };
  }

  /** `PUT /campaigns/:code/chase` — chase it. Idempotent: already chasing changes nothing and records nothing. */
  async chase(ctx: RequestContext, code: string): Promise<CampaignCardView> {
    return this.setChase(ctx, code, true);
  }

  /** `DELETE /campaigns/:code/chase` — stop chasing it. Idempotent likewise. */
  async unchase(ctx: RequestContext, code: string): Promise<CampaignCardView> {
    return this.setChase(ctx, code, false);
  }

  /**
   * `GET /campaigns/chasing?for=` — **whose chases**, of campaigns not ended: the reader's own, or a person the
   * reader's `campaign_qualification:read` reaches through `CoachResolver` — 404 beyond it, never 403.
   */
  async chasing(ctx: RequestContext, asked: string | undefined): Promise<ChasingView> {
    const subject = await this.coach.subject(ctx, asked, 'campaign_qualification:read');
    // A member who has left chases nothing here: 404, as for anybody else outside the reach (the review, item 11).
    if (!subject.self && !(await this.memberships.exists(ctx, { _id: subject.membershipId, status: 'active' }))) {
      throw new NotFoundException('Membership');
    }
    const [reading, timezone] = await Promise.all([
      this.chaseReadings.ofMany(ctx, [subject.membershipId]),
      this.days.timezoneOf(ctx),
    ]);
    return {
      membershipId: subject.membershipId,
      campaigns: reading.byMember.get(subject.membershipId)!.map((c) => chasedView(c, timezone, ctx.reader)),
    };
  }

  // -------------------------------------------------------------------- internals

  private async setChase(ctx: RequestContext, code: string, on: boolean): Promise<CampaignCardView> {
    const me = requireMembership(ctx);
    const row = await this.find(ctx, code);
    const now = this.clock.now();
    const phase = campaignPhase(row.startsAt, row.endsAt, now);
    if (phase === 'ended') {
      throw new DomainException(
        ErrorCode.CAMPAIGN_NOT_OPEN,
        CAMPAIGNS_REFUSALS.CAMPAIGN_NOT_OPEN.ended,
        HttpStatus.CONFLICT,
        { code: row.code },
      );
    }
    const eligible = isEligible(row.appliesToOrgLevelCodes, ctx.membership!.orgLevelCode);
    if (on && !eligible) {
      throw new DomainException(
        ErrorCode.CAMPAIGN_NOT_ELIGIBLE,
        CAMPAIGNS_REFUSALS.CAMPAIGN_NOT_ELIGIBLE.notYourRole,
        HttpStatus.FORBIDDEN,
        { code: row.code },
      );
    }

    const before = await this.chases.findOne(ctx, { membershipId: me, campaignCode: row.code });
    const was = before?.chasing === true;
    if (was !== on) {
      const update = on
        ? { $set: { chasing: true, chasedAt: now, closedBy: null } }
        : { $set: { chasing: false, unchasedAt: now, closedBy: 'member' as const } };
      // Two first chases at once — a double tap — both upsert; the unique index refuses the second (E11000), which is
      // retried once and finds the row the first made (`event.repository.ts`'s pattern; the review, item 6).
      const write = () => this.chases.upsertOne(ctx, { membershipId: me, campaignCode: row.code }, update);
      let saved;
      try {
        saved = await write();
      } catch (err) {
        if ((err as { code?: number } | null)?.code !== 11000) throw err;
        saved = await write();
      }
      await this.audit.record(ctx, {
        action: on ? 'campaign.chased' : 'campaign.unchased',
        targetCollection: 'campaignChases',
        targetId: String(saved._id),
        before: { campaignCode: row.code, chasing: was },
        after: { campaignCode: row.code, chasing: on },
      });
    }
    return this.card(ctx, row, phase, on, await this.days.timezoneOf(ctx));
  }

  /** An active campaign of this office by its code, or a 404 that cannot tell another office's from none. */
  private async find(ctx: RequestContext, code: string): Promise<CampaignDocument> {
    const row = await this.campaigns.findOne(ctx, { code: String(code).toUpperCase(), status: 'active' });
    if (!row) throw new NotFoundException('Campaign');
    return row;
  }

  private async chasingCodes(ctx: RequestContext, me: string, codes: readonly string[]): Promise<Set<string>> {
    if (codes.length === 0) return new Set();
    const rows = await this.chases.find(ctx, { membershipId: me, campaignCode: { $in: [...codes] }, chasing: true });
    return new Set(rows.map((r) => r.campaignCode));
  }

  private card(
    ctx: RequestContext, row: CampaignDocument, phase: CampaignPhase, chasing: boolean, timezone: string,
  ): CampaignCardView {
    const eligible = isEligible(row.appliesToOrgLevelCodes, ctx.membership!.orgLevelCode);
    return {
      code: row.code,
      title: row.title,
      kind: row.kind,
      subtype: row.subtype,
      window: row.window,
      phase,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt ? row.endsAt.toISOString() : null,
      duration: durationWords({ window: row.window, startsAt: row.startsAt, endsAt: row.endsAt }, timezone, ctx.reader),
      poster: posterOf(row),
      blurb: row.blurb,
      reward: row.reward,
      requirements: row.requirements.map((r) => ({
        metricKey: r.metricKey,
        metricName: metricByKey(r.metricKey)?.name ?? r.metricKey,
        comparator: r.comparator,
        value: r.value,
        unit: (metricByKey(r.metricKey)?.unit ?? r.unit) as MetricUnit,
        measured: isCampaignMetric(r.metricKey),
      })),
      chasing,
      eligible,
      chaseBlocked: phase === 'ended' ? 'ended' : eligible ? null : 'not_eligible',
    };
  }
}

function orderable(row: CampaignDocument, phase: CampaignPhase) {
  return { code: row.code, title: row.title, kind: row.kind, phase, startsAt: row.startsAt, endsAt: row.endsAt };
}

/** The poster as stored: every campaign has one, migration `0027` and the schema's default giving it to the old. */
function posterOf(row: { poster: { emoji: string; color: CampaignPosterColor } }) {
  return { emoji: row.poster.emoji, color: row.poster.color };
}

/** A chased campaign as its row draws it, its words for `reader` (P18.98-T5 AC-4). */
function chasedView(c: ChasedCampaign, timezone: string, reader: Reader): ChasedCampaignView {
  return {
    code: c.code,
    title: c.title,
    kind: c.kind,
    subtype: c.subtype,
    phase: c.phase,
    duration: durationWords({ window: c.window, startsAt: c.startsAt, endsAt: c.endsAt }, timezone, reader),
    runs: runsWords({ window: c.window, startsAt: c.startsAt, endsAt: c.endsAt }, timezone, reader),
    poster: c.poster,
  };
}

function requireMembership(ctx: RequestContext): string {
  const me = ctx.membershipId;
  if (!me) throw new NoMembershipException();
  return me;
}
