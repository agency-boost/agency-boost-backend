import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { earlierFirstSale, fileSaleWithdrawn, firstSaleOf, type FirstSale } from '@/domain/metrics/first-sale';
import { LeadReadings } from '@/modules/leads/lead-readings';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { ProductionReadings } from '@/modules/production/production-readings';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { Activation3MService } from './activation-3m.service';
import { ActivationProgressService } from './activation-progress.service';
import { SalesEvents } from './sales-events.port';

/**
 * **Each person's `firstSaleDate`, kept** (ADR-0171 §1, P18.96-T4 AC-1): `SalesEvents`, which the leads and the
 * production modules signal, answered here.
 *
 * For every member named: their closings and the production file's policy months are read — one query each for all
 * of them, through `LeadReadings` and `ProductionReadings` — `firstSaleOf` computes the first sale, and the membership
 * is written **only when that is earlier than what it holds** (`earlierFirstSale`), in one conditional write that a
 * racing write with an earlier day cannot be overtaken by. Then their open activations are evaluated (`recordedMany`),
 * so a data-backed item ticks from the same write.
 *
 * **One exception moves it later, or clears it: a first sale read from the file that the file no longer shows**
 * (the P18.96 exit review, M4; ADR-0171 §1 as noted). An import reverted, or a month's policies corrected to none or
 * cleared, takes away the month a `monthly_file` first sale named — a wrong file, put right. That one is recomputed
 * from what remains (closings, other months of the file) and written, or cleared when nothing does — **while the
 * member's 3M result is not kept**. A kept result stays, and so does the first sale it was decided by: a decided 3M
 * result never changes (ADR-0171 §2). The write is conditional on the first sale still being the one read, so a
 * racing write wins over it. The result is not kept first, as an earlier move keeps it: it would be kept from the
 * wrong file.
 *
 * A member with no join date counts every closing they have; one who has none keeps `null`.
 */
@Injectable()
export class FirstSaleService extends SalesEvents {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly leads: LeadReadings,
    private readonly production: ProductionReadings,
    private readonly days: TenantDay,
    private readonly clock: Clock,
    private readonly activations: ActivationProgressService,
    // P18.96-T6 AC-1: a 3M result already decided is kept before the first sale it was decided by moves.
    private readonly results: Activation3MService,
  ) {
    super();
  }

  /** A sale may have happened for these members: their first sales, then their open activations. */
  async salesRecorded(ctx: RequestContext, membershipIds: readonly string[]): Promise<void> {
    await this.refresh(ctx, membershipIds);
    await this.activations.recordedMany(ctx, membershipIds);
  }

  /**
   * **Recompute and keep each member's first sale**, earlier only — but for one the file gave and no longer shows (M4).
   * Answers how many memberships moved.
   */
  async refresh(ctx: RequestContext, membershipIds: readonly string[]): Promise<number> {
    const ids = [...new Set(membershipIds)];
    if (ids.length === 0) return 0;
    const [members, closings, months, day] = await Promise.all([
      this.memberships.find(
        ctx, { _id: { $in: ids } },
        {
          projection: {
            joinDate: 1, firstSaleDate: 1, firstSaleSource: 1, firstSaleRecordCollection: 1, firstSaleRecordId: 1,
            activation3M: 1,
          },
        },
      ),
      this.leads.closingsOfMany(ctx, ids),
      this.production.policyMonthsOfMany(ctx, ids),
      this.days.for(ctx),
    ]);
    const moves: { membershipId: string; next: FirstSale }[] = [];
    const withdrawn: { membershipId: string; stored: FirstSale; next: FirstSale | null }[] = [];
    for (const member of members) {
      const membershipId = String(member._id);
      const fileMonths = months.get(membershipId) ?? [];
      const computed = firstSaleOf({
        joinDate: member.joinDate ?? null,
        closings: (closings.get(membershipId) ?? []).map((c) => ({
          date: this.clock.localDateFor(day.timezone, c.at), recordId: c.leadId, logged: c.logged,
        })),
        fileMonths: fileMonths.map((m) => ({ month: m.month, recordId: m.id, policies: m.policies })),
      });
      const stored: FirstSale | null = member.firstSaleDate && member.firstSaleSource && member.firstSaleRecordCollection
        ? {
          date: member.firstSaleDate, source: member.firstSaleSource,
          recordCollection: member.firstSaleRecordCollection, recordId: member.firstSaleRecordId ?? '',
        }
        : null;
      // M4: the file's month this first sale was read from shows no policy now — reverted, or corrected to none.
      if (fileSaleWithdrawn(stored, fileMonths) && !(computed !== null && computed.date < stored!.date)) {
        if ((member.activation3M ?? null) === null) withdrawn.push({ membershipId, stored: stored!, next: computed });
        continue;
      }
      const next = earlierFirstSale(stored, computed);
      if (next === null || next === stored) continue;
      moves.push({ membershipId, next });
    }
    /*
     * P18.96-T6 AC-1 (ADR-0171 §2): a new hire whose 3M activation is decided — past day 90, or gone — keeps the result
     * the records gave before this sale lands, so a closing logged with an earlier day or a late production file
     * activates nobody after the fact. One read and at most two writes for every member here, before any of the writes.
     */
    await this.results.keepBeforeChange(ctx, moves.map((m) => m.membershipId));
    let moved = 0;
    for (const { membershipId, next } of moves) {
      moved += await this.memberships.updateMany(
        ctx,
        // Earlier only, held by the write itself: a racing write that kept an earlier day is not overtaken.
        { _id: membershipId, $or: [{ firstSaleDate: null }, { firstSaleDate: { $gt: next.date } }] },
        {
          $set: {
            firstSaleDate: next.date, firstSaleSource: next.source,
            firstSaleRecordCollection: next.recordCollection, firstSaleRecordId: next.recordId,
          },
        },
      );
    }
    for (const { membershipId, stored, next } of withdrawn) {
      moved += await this.memberships.updateMany(
        ctx,
        // Still the first sale read, and still no 3M result kept: a racing write, or a lock, wins over this one.
        {
          _id: membershipId, activation3M: null, firstSaleDate: stored.date, firstSaleSource: 'monthly_file',
          firstSaleRecordId: stored.recordId,
        },
        {
          $set: {
            firstSaleDate: next?.date ?? null, firstSaleSource: next?.source ?? null,
            firstSaleRecordCollection: next?.recordCollection ?? null, firstSaleRecordId: next?.recordId ?? null,
          },
        },
      );
    }
    return moved;
  }
}
