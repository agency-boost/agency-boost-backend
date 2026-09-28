import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
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
}
