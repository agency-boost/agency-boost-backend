import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  ACTIVATION_3M_LOCKS, activation3MDecided, activation3MOf, type Activation3MInput, type Activation3MLock,
  type Activation3MResult,
} from '@/domain/metrics/activation-3m';
import { MembershipRepository } from '@/modules/org/membership.repository';
import type { Membership } from '@/modules/org/membership.schema';
import { TenantDay, type OfficeDay } from '@/modules/tenants/tenant-day.service';

/**
 * What a membership's 3M result is read from: who they are, and its inputs. `leftAt` is read with them and decides
 * nothing (UI V1, D-24): kept as data since *Mark left* was retired (UI-025).
 */
export type Activation3MMember = Pick<Membership, 'joinedAs' | 'joinDate' | 'firstSaleDate' | 'leftAt' | 'activation3M'> & {
  _id: unknown;
};

/** The fields `Activation3MMember` names, for a projection. */
export const ACTIVATION_3M_FIELDS = { joinedAs: 1, joinDate: 1, firstSaleDate: 1, leftAt: 1, activation3M: 1 } as const;

/**
 * **3M activation, kept once decided** (ADR-0171 §2, ADR-0173 §3; P18.96-T6 AC-1, AC-4; `metrics-and-definitions.md`,
 * *3M activation*). The result is `activation3MOf`'s (`domain/metrics/activation-3m.ts`); this keeps it.
 *
 * **The lock.** The result the records give once day 90 of the join date is over — *activated* or *not activated* — is
 * written to `memberships.activation3M` in a conditional write on `null`, so nothing replaces one kept. **Inside the 90
 * days nothing is kept** (UI V1): a first sale reads *activated* at once (rule A) but is kept from day 91, so a wrong
 * production file put right inside the 90 days still takes its sale back; and **a leaving keeps nothing** — it decides
 * nothing since there is no *Keluar* (D-24). It is kept:
 *
 * 1. **before any write that would change one of its inputs** (`keepBeforeChange`): a first sale recorded, the join
 *    date corrected — from the records as they stood (*Mark left*, which also kept it, was retired with UI-025);
 * 2. **by the reads that show it** (`settle`): `GET /new-hires` keeps each decided row it shows — **never in a
 *    read-only support session**, which writes nothing and computes the same answer.
 *
 * A decided result changes only when an input does, and every such write keeps it first, so **the kept result is
 * always what the records gave at the end of day 90**, whichever read or write kept it. A sale recorded after that
 * reads *Teraktivasi* in amber (`activated_late`) and stays out of the share; it never turns a kept *not activated*
 * into *activated*.
 */
@Injectable()
export class Activation3MService {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly days: TenantDay,
    private readonly clock: Clock,
  ) {}

  /**
   * A new hire's inputs, office dates; `null` for anybody with no join date or not new. **Their leaving is not one**
   * (UI V1, D-24): a hire marked left reads from their sale and their join date alone.
   */
  inputOf(member: Activation3MMember): Activation3MInput | null {
    if (member.joinedAs !== 'new_hire' || !member.joinDate) return null;
    return { joinDate: member.joinDate, firstSaleDate: member.firstSaleDate ?? null, locked: member.activation3M ?? null };
  }

  /**
   * **Each new hire's result on the office's today** (`activation3MOf`: a first sale by day 90 *activated* at once), the
   * decided ones nothing has kept yet — past day 90 — kept now, in two conditional writes at most, whatever the number,
   * **unless the session is read-only**. Anybody who is not a new hire is absent from the answer.
   */
  async settle(
    ctx: RequestContext, members: readonly Activation3MMember[], office: OfficeDay,
  ): Promise<Map<string, Activation3MResult>> {
    const results = new Map<string, Activation3MResult>();
    const toKeep: Record<Activation3MLock, string[]> = { activated: [], not_activated: [] };
    for (const member of members) {
      const input = this.inputOf(member);
      if (!input) continue;
      results.set(String(member._id), activation3MOf(input, office.today));
      const decided = activation3MDecided(input, office.today);
      if (decided !== null && input.locked === null) toKeep[decided].push(String(member._id));
    }
    if (!ctx.impersonationReadOnly) await this.keep(ctx, toKeep);
    return results;
  }

  /**
   * **Before a write changes a new hire's join date or first sale** (the lock's rule 1): keep the result the records
   * give now, if day 90 is over. A no-op for anybody inside their 90 days, already kept, or who is no new hire — so a
   * write inside the 90 days changes what will be decided, and one after it changes nothing.
   */
  async keepBeforeChange(ctx: RequestContext, membershipIds: readonly string[]): Promise<void> {
    const ids = [...new Set(membershipIds)];
    if (ids.length === 0) return;
    const [members, office] = await Promise.all([
      this.memberships.find(
        ctx, { _id: { $in: ids }, joinedAs: 'new_hire', activation3M: null }, { projection: ACTIVATION_3M_FIELDS },
      ),
      this.days.for(ctx),
    ]);
    if (members.length > 0) await this.settle(ctx, members, office);
  }

  /** The decided results nothing has kept, kept: one conditional write per value, never over one already kept. */
  private async keep(ctx: RequestContext, toKeep: Record<Activation3MLock, string[]>): Promise<void> {
    const at = this.clock.now();
    for (const lock of ACTIVATION_3M_LOCKS) {
      if (toKeep[lock].length === 0) continue;
      await this.memberships.updateMany(
        ctx,
        { _id: { $in: toKeep[lock] }, joinedAs: 'new_hire', activation3M: null },
        { $set: { activation3M: lock, activation3MLockedAt: at } },
      );
    }
  }
}
