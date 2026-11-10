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
  /**
   * **Among them, the finished ones** (P19.11-T3 AC-1; UX-9; UXQ3): `status: 'done'` — its PDF saved and not changed
   * since. The card draws its proposal icon only when this is 1 or more. Drafts never count.
   */
  done: number;
  /** The finished one saved last, by `doneAt` — what the card's icon opens. `null` when none is finished. */
  latestDone: { id: string } | null;
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
      {
        sort: { updatedAt: -1, _id: -1 },
        projection: { leadId: 1, channel: 1, items: 1, updatedAt: 1, status: 1, doneAt: 1 },
      },
    );
    /** The `doneAt` of each lead's `latestDone`, to compare the next finished one against. */
    const doneAtOf = new Map<string, number>();
    for (const row of rows) {
      const names = (row.items ?? []).map((item: StoredItem) => itemName(item.snapshot, row.channel));
      let held = out.get(row.leadId);
      if (!held) {
        held = { count: 0, latest: { products: names }, done: 0, latestDone: null };
        out.set(row.leadId, held);
      }
      held.count += 1;
      // Newest first: the first with a product is the latest that has one.
      if (held.latest.products.length === 0 && names.length > 0) held.latest = { products: names };
      if (row.status === 'done') {
        held.done += 1;
        // By `doneAt`, not by the list's order: the last *Simpan PDF* is what "latest" means (UXQ3).
        const at = row.doneAt ? row.doneAt.getTime() : 0;
        if (held.latestDone === null || at > (doneAtOf.get(row.leadId) ?? 0)) {
          held.latestDone = { id: String(row._id) };
          doneAtOf.set(row.leadId, at);
        }
      }
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
