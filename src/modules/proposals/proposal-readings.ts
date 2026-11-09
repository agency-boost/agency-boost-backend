import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { LocalDate } from '@/common/time/local-day';
import { proposalsMade } from '@/domain/metrics/proposals-made';
import { itemName, type StoredItem } from './proposal-items';
import { ProposalRepository } from './proposal.repository';
import type { ProposalDocument } from './proposal.schema';

/** A lead's proposals, as the lead list's row carries them (ADR-0221 §6). */
export interface LeadProposals {
  /** The lead's live proposals, drafts included. */
  count: number;
  /** Among them, the one updated last that has a product: its item names, as the proposal shows them, in order. */
  latest: { products: string[] };
}

/** One *"Proposal dibuat · …"* note in a lead's *Riwayat*: derived, never written to the lead (ADR-0221 §6). */
export interface LeadProposalNote {
  kind: 'proposal';
  at: string;
  /** `null` once the proposal is deleted: the note stays, its link goes. */
  proposalId: string | null;
  products: string[];
}

/**
 * **What other modules read of proposals, and nothing else** (P19.7-T2; ADR-0221 §6, §7): the lead list's pill and its
 * filter, the lead's *Riwayat* notes, and the leaders' counts. Every read is the tenant's, through the repository, and
 * **every one but the count is the owner's alone** — the caller passes its own membership, never a leader's reach.
 *
 * One query per call, never one per lead or per person.
 */
@Injectable()
export class ProposalReadings {
  constructor(private readonly proposals: ProposalRepository, private readonly clock: Clock) {}

  /**
   * **The pill for a page of the owner's own leads**, by lead id (Acc. 4). One query over the `(kpmId, leadId, …)`
   * index; a lead with none is absent from the map.
   */
  async ofLeads(ctx: RequestContext, ownerMembershipId: string, leadIds: readonly string[]): Promise<Map<string, LeadProposals>> {
    const out = new Map<string, LeadProposals>();
    if (leadIds.length === 0) return out;
    const rows = await this.proposals.find(
      ctx,
      { ownerMembershipId, leadId: { $in: [...leadIds] } },
      { sort: { updatedAt: -1, _id: -1 }, projection: { leadId: 1, channel: 1, items: 1, updatedAt: 1 } },
    );
    for (const row of rows) {
      const names = (row.items ?? []).map((item: StoredItem) => itemName(item.snapshot, row.channel));
      const held = out.get(row.leadId);
      if (!held) {
        out.set(row.leadId, { count: 1, latest: { products: names } });
        continue;
      }
      held.count += 1;
      // Newest first: the first with a product is the latest that has one.
      if (held.latest.products.length === 0 && names.length > 0) held.latest = { products: names };
    }
    return out;
  }

  /** **The owner's leads that hold a live proposal** — *Sudah ada proposal* and, by its complement, *Belum ada*. */
  async leadIdsWithProposals(ctx: RequestContext, ownerMembershipId: string): Promise<Set<string>> {
    const rows = await this.proposals.find(ctx, { ownerMembershipId }, { projection: { leadId: 1 } });
    return new Set(rows.map((row) => row.leadId));
  }

  /** **The owner's *"Proposal dibuat"* notes on one lead**, oldest first: each proposal ever finished, deleted ones unlinked. */
  async notesOfLead(ctx: RequestContext, ownerMembershipId: string, leadId: string): Promise<LeadProposalNote[]> {
    const rows = await this.proposals.finishedOfLead(ctx, ownerMembershipId, leadId);
    return rows.map((row: ProposalDocument) => ({
      kind: 'proposal' as const,
      at: (row.firstDoneAt as Date).toISOString(),
      proposalId: row.deletedAt ? null : String(row._id),
      products: [...(row.firstDoneProducts ?? [])],
    }));
  }

  /**
   * **`PROPOSALS_MADE` for each member of a roster** (§A.16): their live proposals first finished within `window`, on the
   * office's calendar. One query over `(kpmId, ownerMembershipId, firstDoneAt)`, bounded by the window's own instants;
   * the count is the metric's one definition (`domain/metrics/proposals-made.ts`). Everybody asked for is in the map.
   */
  async madeByMany(
    ctx: RequestContext, ids: readonly string[], window: { from: LocalDate; to: LocalDate }, timezone: string,
  ): Promise<Map<string, number>> {
    const out = new Map(ids.map((id) => [id, 0]));
    if (ids.length === 0) return out;
    const rows = await this.proposals.find(
      ctx,
      {
        ownerMembershipId: { $in: [...ids] },
        firstDoneAt: {
          $gte: this.clock.startOfLocalDay(timezone, window.from),
          // Exclusive: the instant the day after `to` begins, in the office's zone.
          $lt: this.clock.endOfLocalDay(timezone, window.to),
        },
      },
      { projection: { ownerMembershipId: 1, firstDoneAt: 1 } },
    );
    const byOwner = new Map<string, Date[]>();
    for (const row of rows) byOwner.set(row.ownerMembershipId, [...(byOwner.get(row.ownerMembershipId) ?? []), row.firstDoneAt as Date]);
    for (const id of ids) out.set(id, proposalsMade(byOwner.get(id) ?? [], window, timezone));
    return out;
  }
}
