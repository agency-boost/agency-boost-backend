import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException } from '@/common/errors/domain.exception';
import { localDayOf } from '@/common/time/local-day';
import type { CampaignKind, CampaignSubtype, CampaignWindow } from '@/domain/constants';
import type { QualificationStatus } from '@/domain/metrics/campaign-qualification';
import { campaignPhase, lastLocalDay } from '@/domain/metrics/campaign-window';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { CampaignEvaluation, evaluationInput } from './campaign-evaluation';
import { CampaignRepository } from './campaign.repository';

/** One campaign as Phase 18.3's tree lists it. */
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

/** A final standing's override, as the tree's *Achieved* cell names it (P18.3-T2 AC-7). */
export interface OfficeStandingOverride {
  status: 'qualified' | 'not_met';
  reason: string;
  byMembershipId: string;
  /** ISO instant. */
  at: string;
}

/** One member in one campaign: the tree's *Chasing* / *Not chasing* and *Achieved* / *Not achieved* / —. */
export interface OfficeStanding {
  campaignCode: string;
  membershipId: string;
  chasing: boolean;
  eligible: boolean;
  /** `CAMPAIGN_QUALIFICATION_STATUS`: only a chaser is `qualified` (OD-153); a final standing's override applied. */
  status: QualificationStatus;
  final: boolean;
  /** The override on the stored final standing — who, when and why — or `null` (P18.3-T2 AC-7). */
  overridden: OfficeStandingOverride | null;
}

/** What `ofOffice` is asked for. Every field optional: `ofOffice(ctx)` is every active campaign and member. */
export interface OfficeStandingsQuery {
  /** Only these campaigns, by code. */
  codes?: readonly string[];
  /** These memberships instead of every active one — the compliance tree's members (P18.3-T2). */
  memberIds?: readonly string[];
  /**
   * D-window, `[start, end)` (P18.3-T1, T2): seasonal campaigns whose dates overlap it — ended ones included — or
   * whose window's last month is the month just before it (last December, for a calendar year: it becomes final
   * inside this one; the exit review's M1), or not started yet whatever their year (round 2), and structural ones
   * running now. Archived campaigns are never read.
   */
  window?: { start: Date; end: Date };
  /**
   * A campaign code the caller is about to read (the compliance tree's `item`): when the list — `codes` and `window`
   * applied — does not hold it, `404` **before anything is evaluated**, so a refused read freezes nothing and audits
   * nothing (the exit review, round 1, item 7). No extra query: it is checked against the `find` already made.
   */
  requireListed?: string;
}

export interface OfficeStandings {
  campaigns: OfficeCampaign[];
  standings: OfficeStanding[];
}

/**
 * **The bulk reader the compliance tree's *Campaigns* category reads** (P18.2-T8 AC-8; P18.3-T2 AC-6, AC-7) — a
 * service port, **no route**.
 *
 * `ofOffice(ctx, { codes?, memberIds?, window? })`: the office's active campaigns — every one, those codes, or
 * D-window's — and for every member asked about (every active member by default) and every campaign, the chase, the
 * eligibility, the status, its finality and **its override**, through the one evaluation the agent's dialog reads
 * (`CampaignEvaluation`), so the tree and the dialog cannot disagree. Final standings come from `campaignStandings`
 * as frozen, the override applied there (`fromFrozen`). The first read after a window locks freezes it, once,
 * audited — never in a read-only support session. **A fixed number of queries for any office** (AC-9). The caller
 * owns the permission (`kpm_analytics:read`, whose reach is the office): this reads the context's office and no other.
 */
@Injectable()
export class CampaignStandingsReader {
  constructor(
    private readonly campaigns: CampaignRepository,
    private readonly memberships: MembershipRepository,
    private readonly evaluation: CampaignEvaluation,
    private readonly days: TenantDay,
    private readonly clock: Clock,
  ) {}

  async ofOffice(ctx: RequestContext, opts: OfficeStandingsQuery = {}): Promise<OfficeStandings> {
    const filter = opts.codes ? { status: 'active', code: { $in: [...opts.codes] } } : { status: 'active' };
    // The office once, here — its zone decides the window's months — and handed to the evaluation, which reads it no
    // second time: the same queries as before.
    const [stored, members, office] = await Promise.all([
      this.campaigns.find(ctx, filter, { sort: { code: 1 } }),
      opts.memberIds
        ? Promise.resolve(null)
        : this.memberships.find(ctx, { status: 'active' }, { projection: { _id: 1 } }),
      this.days.office(ctx),
    ]);
    const now = this.clock.now();
    const rows = opts.window ? stored.filter((row) => inWindow(row, opts.window!, now, office.timezone)) : stored;
    if (opts.requireListed !== undefined && !rows.some((row) => row.code === opts.requireListed)) {
      throw new NotFoundException('Campaign');
    }
    const ids = opts.memberIds ? [...opts.memberIds] : members!.map((m) => String(m._id));
    const evaluated = await this.evaluation.evaluate(ctx, rows.map(evaluationInput), ids, office);

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
      overridden: m.override === null ? null : {
        status: m.override.status, reason: m.override.reason, byMembershipId: m.override.byMembershipId,
        at: m.override.at.toISOString(),
      },
    })));
    return { campaigns, standings };
  }
}

/**
 * **D-window** (P18.3-T1, T2), in the office's zone:
 *
 * - a **seasonal** campaign whose dates overlap `[start, end)` — upcoming, running or ended — **or whose window's last
 *   month is the month just before `start`** (last December, for a calendar year). Such a window becomes final inside
 *   this one, once that month locks (ADR-0144), so its result is listed — under *Seasonal — Past* — and can still be
 *   corrected (the exit review's M1). One that ended any earlier is not. **And every seasonal campaign not started
 *   yet, whatever its year** (`startsAt > now`; the exit review, round 2): members chase one before it starts, so the
 *   Owner sees it from then — under *Seasonal — Ongoing*, tagged *Upcoming*.
 * - a **structural** one running now (it has no season to overlap; one not started or ended is not listed). A
 *   calendar-year structural campaign's last year stays unlisted (D-25).
 */
export function inWindow(
  row: { kind: string; startsAt: Date; endsAt: Date | null }, window: { start: Date; end: Date }, now: Date, timezone: string,
): boolean {
  if (row.kind === 'structural') return campaignPhase(row.startsAt, row.endsAt, now) === 'running';
  if (campaignPhase(row.startsAt, row.endsAt, now) === 'upcoming') return true;
  if (row.startsAt.getTime() >= window.end.getTime()) return false;
  if (row.endsAt === null || row.endsAt.getTime() >= window.start.getTime()) return true;
  const monthBefore = localDayOf(new Date(window.start.getTime() - 1), timezone).slice(0, 7);
  return lastLocalDay(row.endsAt, timezone).slice(0, 7) === monthBefore;
}
