import { HttpStatus, Injectable } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { Fields } from '@/common/validation/fields';
import { AuditService } from '@/modules/audit/audit.service';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { CampaignEvaluation, evaluationInput, fromFrozen } from './campaign-evaluation';
import { CampaignStandingRepository } from './campaign-standing.repository';
import type { CampaignStanding, StandingOverride } from './campaign-standing.schema';
import { CampaignRepository } from './campaign.repository';

/** What a stored final standing can read: the two an override sets, and the one nothing could decide. */
type FrozenStatus = StandingOverride['previousStatus'];

/** The status a stored standing reads — `fromFrozen`'s, the one place an override is applied, never a second copy. */
const reads = (row: CampaignStanding): FrozenStatus => fromFrozen(row).status as FrozenStatus;

/** The two results an override may set (D-override): *Achieved* and *Not achieved*. */
export const OVERRIDE_STATUSES = ['qualified', 'not_met'] as const;
export type OverrideStatus = (typeof OVERRIDE_STATUSES)[number];

/** A reason, trimmed: required to set and to clear, as long as the house's other reasons (`REASON_MAX`). */
export const OVERRIDE_REASON = { min: 1, max: 500 } as const;

/**
 * **How long a write waits for a standing another request is freezing**: a read every `ms`, at most `reads` of
 * them, two seconds in all. Of two first reads of a window at once, the one that loses `markFrozen` answers *final*
 * before the winner's insert has landed (`CampaignEvaluation`), so a chaser's row can be a moment away rather than
 * missing. Only a chaser at the window's end is waited for: anybody else has no row to wait for.
 */
export const FREEZE_WAIT = { ms: 25, reads: 80 } as const;

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** The override as the tree's cell names it: who set what, when and why. */
export interface StandingOverrideView {
  status: OverrideStatus;
  reason: string;
  by: { membershipId: string; name: string };
  /** ISO instant. */
  at: string;
}

/** What a set or a clear answers: the standing's status as now read, and its override. */
export interface StandingOverrideResult {
  campaignCode: string;
  membershipId: string;
  /** The effective status: the override's, or the frozen one. */
  status: FrozenStatus;
  override: StandingOverrideView | null;
}

/** `PUT …/override`'s body: `{ status, reason }`, nothing else. */
export function checkStandingOverride(body: unknown): { status: OverrideStatus; reason: string } {
  const fields = new Fields(body, ['status', 'reason']);
  const status = fields.oneOf('status', OVERRIDE_STATUSES, true);
  const reason = fields.text('reason', OVERRIDE_REASON, true);
  return fields.done({ status, reason }) as { status: OverrideStatus; reason: string };
}

/** `DELETE …/override`'s body: `{ reason }`, nothing else. */
export function checkStandingOverrideClear(body: unknown): { reason: string } {
  const fields = new Fields(body ?? {}, ['reason']);
  const reason = fields.text('reason', OVERRIDE_REASON, true);
  return fields.done({ reason }) as { reason: string };
}

/**
 * **The override of a final campaign standing** (P18.6-T2 AC-5; ADR-0144 §4, D-override): the Owner's or an Admin's
 * correction of a result the evaluator could not see — set to `qualified` or `not_met` with a required reason, and
 * cleared with one. Its only control is the compliance tree's *Achieved* cell.
 *
 * - **Only a stored final standing**: the campaign's window must be final (`409 CAMPAIGN_STANDING_NOT_FINAL`
 *   before), and the member must have a stored standing — a chaser at the window's end (ADR-0143 §4); a non-chaser
 *   has none and is `404`. The write evaluates the campaign first, through the one evaluation every reader uses, so
 *   it may be the first read after the window locked and freeze it — once, audited.
 * - **The frozen `status` is never rewritten**: the override sits beside it (`campaignStandings.override`), so
 *   clearing restores it; it is applied in one place, `fromFrozen`, so every reader of the standing reads it. The
 *   member's dialog shows requirement rows only (ADR-0147) and does not change.
 * - **One write per reading**: conditional on the row's `version`; a write that lost a race re-reads and re-checks
 *   once (so a second identical set answers *"already reads"*, as it would in sequence), then `409 VERSION_CONFLICT`.
 *   A write that froze nothing itself, because another request was freezing the window at the same moment, waits
 *   for a chaser's row rather than calling it missing (`FREEZE_WAIT`; found by a coverage run, 2026-10-23).
 *   Each write audited once, `campaign_standing.overridden` or `campaign_standing.override_cleared`, with before,
 *   after, the reason and the previous status; both actors in a support session (the audit's own).
 * - **Nobody overrides their own result** (the exit review, round 1; ADR-0138's rule): the caller's own membership is
 *   refused `400 CAMPAIGN_OVERRIDE_SELF`, set or clear, nothing written — an Admin corrects the Owner's, the Owner an
 *   Admin's. A support session acts as its member, so an elevated session as the Owner is refused on the Owner's.
 * - **404, never 403, outside the office**: another office's or an archived campaign, a membership not this
 *   office's. Who may call it is `campaign_qualification:override`'s, at the guard — a read-only support session is
 *   refused there by the permission's verb.
 */
@Injectable()
export class CampaignStandingOverrides {
  constructor(
    private readonly campaigns: CampaignRepository,
    private readonly memberships: MembershipRepository,
    private readonly standings: CampaignStandingRepository,
    private readonly evaluation: CampaignEvaluation,
    private readonly names: MemberNames,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** `PUT /kpm/settings/campaigns/:code/standings/:membershipId/override`. */
  async override(ctx: RequestContext, code: string, membershipId: string, body: unknown): Promise<StandingOverrideResult> {
    const input = checkStandingOverride(body);
    return this.write(ctx, code, membershipId, input.reason, input.status);
  }

  /** `DELETE /kpm/settings/campaigns/:code/standings/:membershipId/override`. */
  async clear(ctx: RequestContext, code: string, membershipId: string, body: unknown): Promise<StandingOverrideResult> {
    const input = checkStandingOverrideClear(body);
    return this.write(ctx, code, membershipId, input.reason, null);
  }

  /** Set (`status`) or clear (`null`) the override, once, from what the row reads now. */
  private async write(
    ctx: RequestContext, code: string, membershipId: string, reason: string, status: OverrideStatus | null,
  ): Promise<StandingOverrideResult> {
    const me = ctx.membershipId;
    if (!me || !ctx.kpmId) throw new NoMembershipException();
    const campaign = await this.campaigns.findOne(ctx, { code: String(code).toUpperCase(), status: 'active' });
    if (!campaign) throw new NotFoundException('Campaign');
    if (membershipId === me) {
      throw new DomainException(
        ErrorCode.CAMPAIGN_OVERRIDE_SELF,
        'You can’t override your own result.',
        HttpStatus.BAD_REQUEST,
        { membershipId: me },
      );
    }
    if (!isValidObjectId(membershipId) || !(await this.memberships.exists(ctx, { _id: membershipId }))) {
      throw new NotFoundException('Membership');
    }
    const evaluated = (await this.evaluation.evaluate(ctx, [evaluationInput(campaign)], [membershipId])).get(campaign.code)!;
    if (!evaluated.final) {
      throw new DomainException(
        ErrorCode.CAMPAIGN_STANDING_NOT_FINAL,
        'This campaign’s result is not final yet. It can be overridden once the last month it reads has locked.',
        HttpStatus.CONFLICT,
        { code: campaign.code },
      );
    }
    const where = { campaignCode: campaign.code, windowKey: evaluated.window.key, membershipId };
    // A chaser at the window's end has a stored standing, or is about to (FREEZE_WAIT).
    const chaser = evaluated.members.get(membershipId)?.chasing === true;

    for (let attempt = 0; ; attempt += 1) {
      let row = await this.standings.findOne(ctx, where);
      for (let read = 1; !row && chaser && read < FREEZE_WAIT.reads; read += 1) {
        await pause(FREEZE_WAIT.ms);
        row = await this.standings.findOne(ctx, where);
      }
      // A member who was not chasing at the window's end has no stored standing (ADR-0143 §4): nothing to correct.
      if (!row) throw new NotFoundException('Standing');
      // Hydrated with the schema's default: a row frozen before the field existed reads `null`.
      const current = row.override;
      const before = reads(row);
      if (status !== null && before === status) {
        throw new DomainException(
          ErrorCode.VALIDATION_FAILED,
          `The result already reads ${status}.`,
          HttpStatus.BAD_REQUEST,
          { violations: [`status already reads ${status}.`], status },
        );
      }
      if (status === null && current === null) throw new NotFoundException('Override');

      const at = this.clock.now();
      const next: StandingOverride | null = status === null
        ? null
        : { status, reason, byMembershipId: me, at, previousStatus: before };
      const version = (row.get('version') as number | undefined) ?? null;
      if (await this.standings.setOverride(ctx, String(row._id), version, next, at)) {
        const after = reads({ ...row.toObject(), override: next } as CampaignStanding);
        await this.audit.record(ctx, {
          action: status === null ? 'campaign_standing.override_cleared' : 'campaign_standing.overridden',
          targetCollection: 'campaignStandings',
          targetId: String(row._id),
          targetMembershipId: membershipId,
          before: { campaignCode: campaign.code, windowKey: where.windowKey, status: before, override: plain(current) },
          after: {
            campaignCode: campaign.code, windowKey: where.windowKey, status: after, override: plain(next),
            reason, previousStatus: before,
          },
        });
        const name = next === null ? '' : (await this.names.byMembershipId(ctx, [me])).get(me) ?? '';
        return {
          campaignCode: campaign.code,
          membershipId,
          status: after,
          override: next === null ? null : {
            status: next.status, reason: next.reason, by: { membershipId: me, name }, at: next.at.toISOString(),
          },
        };
      }
      // Somebody changed the row since it was read: read it again and decide again, once.
      if (attempt >= 1) {
        throw new DomainException(
          ErrorCode.VERSION_CONFLICT,
          'This result changed while it was being corrected. Reload and try again.',
          HttpStatus.CONFLICT,
        );
      }
    }
  }
}

/** A stored override as the audit records it: its fields, never the subdocument. */
function plain(override: StandingOverride | null): Record<string, unknown> | null {
  if (override === null) return null;
  return {
    status: override.status, reason: override.reason, byMembershipId: override.byMembershipId, at: override.at,
    previousStatus: override.previousStatus,
  };
}
