import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { personLeadCounts, type CountedLead } from '@/domain/metrics/lead-counts';
import type { LeadCountsRow } from '@/domain/metrics/unit-rollup';
import { LeadStatusRepository } from '@/modules/config/activity.repository';
import type { OfficeDay } from '@/modules/tenants/tenant-day.service';
import { leadFlags, type LeadFlag } from './lead-attention';
import { LeadRepository } from './lead.repository';
import type { LeadType } from './lead.schema';

/** One open lead, as another module reads it — the Personal Summary's *Leads that need you* (P10-T6). */
export interface OpenLead {
  id: string;
  name: string;
  type: LeadType | null;
  statusCode: string | null;
  /** The office's name for the stage, archived stages included; `null` before a first status. */
  statusLabel: string | null;
  /** Promised for the office's current month — the glossary's *Commitment*. */
  thisMonth: boolean;
  flags: LeadFlag[];
  overdueDays: number | null;
  nextActionDate: string | null;
  nextActionNote: string | null;
}

/**
 * **Nearest next action first, undated last** (`Overall.html:6182-6187`). An overdue date is the
 * nearest of all, so the leads most late lead the list. Ties keep the order leads were registered in —
 * the prototype's array order, oldest first — and then the id, so two reads never shuffle.
 */
export function byNextAction(
  a: { nextActionDate: string | null; registeredAt: number; id: string },
  b: { nextActionDate: string | null; registeredAt: number; id: string },
): number {
  if (a.nextActionDate !== b.nextActionDate) {
    if (a.nextActionDate === null) return 1;
    if (b.nextActionDate === null) return -1;
    return a.nextActionDate < b.nextActionDate ? -1 : 1;
  }
  if (a.registeredAt !== b.registeredAt) return a.registeredAt - b.registeredAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * **Leads, as the rest of the product reads them** (P10-T6) — the seam `ActivityReadings` and
 * `ProductionReadings` are for their modules. A module that needs a member's leads asks here, and gets
 * the flags `leadFlags` defines rather than a second reading of the rule.
 */
@Injectable()
export class LeadReadings {
  constructor(
    private readonly leads: LeadRepository,
    private readonly statuses: LeadStatusRepository,
    private readonly clock: Clock,
  ) {}

  /**
   * **A member's own open leads**, nearest next action first. Their own only — a leader's `lead:read`
   * reaches their downline's too, and *Leads that need you* is about the reader (P10-T6 AC-1).
   */
  async openOf(ctx: RequestContext, membershipId: string, day: OfficeDay): Promise<OpenLead[]> {
    const [rows, stages] = await Promise.all([
      this.leads.find(ctx, { ownerMembershipId: membershipId, outcome: null, deletedAt: null }),
      this.statuses.find(ctx, {}),
    ]);
    const labels = new Map(stages.map((s) => [s.code, s.label] as [string, string]));

    return rows
      .map((row) => ({ row, id: String(row._id), registeredAt: row.dateRegistered?.getTime() ?? 0, nextActionDate: row.nextActionDate }))
      .sort(byNextAction)
      .map(({ row, id }) => {
        const flags = leadFlags(row, day.today);
        return {
          id,
          name: row.name,
          type: row.type,
          statusCode: row.statusCode,
          statusLabel: row.statusCode ? labels.get(row.statusCode) ?? null : null,
          thisMonth: (row.commitments ?? []).some((c) => c.month === day.month),
          flags,
          // Whole calendar days in the office's zone, exactly as the Leads screen counts them.
          overdueDays: flags.includes('overdue') && row.nextActionDate
            ? this.clock.daysBetween(day.timezone, row.nextActionDate, day.today)
            : null,
          nextActionDate: row.nextActionDate,
          nextActionNote: row.nextActionNote,
        };
      });
  }

  /**
   * **Each member's four lead counts, for many members at once** (Phase 15, D-leads): the Unit Dashboard's
   * *Leads* column — open sales leads, those promised for the office's month, `RECRUITMENT_PIPELINE_NOW`
   * and the recruitment leads promised for the month — by **`LeadService.summary`'s rules** over one owner
   * each (`personLeadCounts`). The office's own recruitment ladder decides what *still running* is, as the
   * summary's does.
   *
   * **Two reads for the whole list**, whatever its length: the office's recruitment stages, and the open
   * leads of every member asked about — the four fields the counts read, over the `{kpmId,
   * ownerMembershipId, deletedAt}` index the list uses. Counts, never rows: nothing about a lead leaves
   * here. Every member asked about gets an entry, all zeros where they hold none.
   */
  async countsOfMany(
    ctx: RequestContext, membershipIds: readonly string[], day: { month: string },
  ): Promise<Map<string, LeadCountsRow>> {
    const ids = [...new Set(membershipIds)];
    if (ids.length === 0) return new Map();
    const [stages, rows] = await Promise.all([
      this.statuses.find(ctx, { pipeline: 'recruitment' }),
      this.leads.find(
        ctx,
        { ownerMembershipId: { $in: ids }, outcome: null },
        { projection: { ownerMembershipId: 1, type: 1, outcome: 1, statusCode: 1, commitments: 1 } },
      ),
    ]);
    const terminalRecruitmentCodes = stages.filter((stage) => stage.isTerminal).map((stage) => stage.code);
    const byOwner = new Map<string, CountedLead[]>(ids.map((id) => [id, []]));
    for (const row of rows) byOwner.get(row.ownerMembershipId)!.push(row);
    return new Map(ids.map((id) => [id, personLeadCounts(byOwner.get(id)!, { month: day.month, terminalRecruitmentCodes })]));
  }

  /**
   * **Each member's newest lead, of either type, for many members at once** (P13-T3 AC-3, AC-7): what
   * completes an activation's `feature:leads` item, and who added it — the owner, or a leader in a session
   * (ADR-0076). One aggregate for the whole list, within the office; a deleted lead is not among them.
   */
  async latestOfMany(
    ctx: RequestContext, membershipIds: readonly string[],
  ): Promise<Map<string, { id: string; at: Date; byMembershipId: string }>> {
    const out = new Map<string, { id: string; at: Date; byMembershipId: string }>();
    if (membershipIds.length === 0) return out;
    const rows = await this.leads.aggregate(ctx, [
      { $match: { ownerMembershipId: { $in: [...new Set(membershipIds)] } } },
      { $sort: { dateRegistered: -1, _id: -1 } },
      {
        $group: {
          _id: '$ownerMembershipId',
          id: { $first: '$_id' },
          at: { $first: { $ifNull: ['$dateRegistered', '$createdAt'] } },
          by: { $first: { $ifNull: ['$createdBy', '$ownerMembershipId'] } },
        },
      },
    ]);
    for (const row of rows) {
      out.set(String(row._id), { id: String(row.id), at: row.at as Date, byMembershipId: String(row.by) });
    }
    return out;
  }
}
