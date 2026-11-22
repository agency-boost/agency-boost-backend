import { Injectable } from '@nestjs/common';
import { leadsManaged } from '@/domain/metrics/leads-managed';
import { LeadReadings } from '@/modules/leads/lead-readings';
import type {
  ComplianceCategory, ComplianceCategoryRead, ComplianceCell, ComplianceScope,
} from './compliance-category';

/**
 * **Leads Mgmt** in the KPM Overview's compliance (P19.19-T3 AC-2; ADR-0272 §6; OD-395): one item, the members' open
 * leads today.
 *
 * - **A member is done** when they hold at least one open lead and every one carries a next action that is not overdue
 *   (`leadsManaged`, `MANAGED_LEADS_RATE`) — the two flags *Leads that need you* raises, read the other way round.
 *   *Sudah selesai* carries nothing; *Belum selesai* says why: `no_leads` or `needs_next_action`.
 * - **One read** for every member (`LeadReadings.openNextActionsOfMany`): days, never a lead — the stewards hold counts of
 *   a member's leads, not the leads (roles §3.6).
 * - **The card** is the count over the scope's members (*"x dari y anggota"*). No §3.5 entry: no lead is disclosed.
 */
@Injectable()
export class LeadsComplianceCategory implements ComplianceCategory<null> {
  constructor(private readonly leads: LeadReadings) {}

  async read(
    scope: ComplianceScope, selection: { selected: boolean; item: string | null },
  ): Promise<ComplianceCategoryRead<null>> {
    const { ctx, memberIds, today } = scope;
    const open = await this.leads.openNextActionsOfMany(ctx, memberIds);
    const managed = (id: string) => leadsManaged(open.get(id) ?? [], today);
    const chip = { count: memberIds.filter(managed).length, of: memberIds.length };
    if (!selection.selected) return { catalog: null, chip, item: null, cells: null };

    const cells = new Map<string, ComplianceCell>(memberIds.map((id): [string, ComplianceCell] => {
      if (managed(id)) return [id, { status: 'managed', done: true, on: null }];
      return [id, { status: (open.get(id) ?? []).length === 0 ? 'no_leads' : 'needs_next_action', done: false, on: null }];
    }));
    return { catalog: null, chip, item: null, cells };
  }
}
