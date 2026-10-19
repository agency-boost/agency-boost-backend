import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { LocalDate } from '@/common/time/local-day';
import type { Office } from '@/modules/tenants/tenant-day.service';
import type { ActivationProgressDocument } from './activation-progress.schema';
import { ActivationProgressRepository } from './activation-progress.repository';
import { ActivationProgressService } from './activation-progress.service';
import { activationEndsOn, activationState, type ActivationState } from './activation-rules';

/** One member's activation as an office-wide read needs it: its state now, and the days that say so. */
export interface ActivationStanding {
  membershipId: string;
  /** Day 1, an office date (OD-118). */
  startDate: LocalDate;
  /** Open, graduated by the hire (OD-28), or past its six months (OD-120) — derived on the read. */
  state: ActivationState;
  /** The day it ends, or ended: six calendar months after its start (OD-120) — the detail's *"Ended on …"*. */
  endsOn: LocalDate;
  /** Open past the office's window below 100% — the roster's red day (`isOverdue`). Never for a closed one. */
  overdue: boolean;
  /** The office day the hire graduated; `null` unless graduated. */
  graduatedOn: LocalDate | null;
}

/**
 * **`ActivationReadings` — every activation of many members, in one read** (Phase 18.6, P18.6-T1 AC-7): the port the
 * Owner's compliance tree reads an office's activations through, so it never reads `activationProgress` itself and
 * never asks per member.
 *
 * - **Every state**: the newest activation of each member asked — open, graduated or expired — in **one query**
 *   within the office. A member with none is absent. (One per membership is the rule; the newest wins, as `latestOf`
 *   reads a member's own.)
 * - **The open ones through `resolve`**, the one computation every reader is served (P13-T2 AC-5): their links
 *   evaluated first — written when newly met, **unless the session is read-only**, which writes nothing (N3) — and
 *   `overdue` from the same `isOverdue` the roster and the detail read. So each standing equals what
 *   `GET /new-hires/:membershipId` says of that hire. Bounded as `resolve` is: one read per pinned version and per
 *   link kind still waiting, never per member.
 * - **A closed one is not resolved**: nothing on it changes (`activationClosed`), so its state, end and graduation
 *   day are read off the row.
 *
 * Read by `modules/reporting/compliance/activation.category.ts` alone (`activation-readings.imports.spec.ts`).
 */
@Injectable()
export class ActivationReadings {
  constructor(
    private readonly progress: ActivationProgressRepository,
    private readonly activations: ActivationProgressService,
    private readonly clock: Clock,
  ) {}

  async ofMembers(
    ctx: RequestContext, membershipIds: readonly string[], office: Office,
  ): Promise<Map<string, ActivationStanding>> {
    const out = new Map<string, ActivationStanding>();
    const ids = [...new Set(membershipIds)];
    if (ids.length === 0) return out;

    const rows = await this.progress.find(ctx, { membershipId: { $in: ids } }, { sort: { createdAt: -1, _id: -1 } });
    const newest = new Map<string, ActivationProgressDocument>();
    for (const doc of rows) if (!newest.has(doc.membershipId)) newest.set(doc.membershipId, doc);

    const docs = [...newest.values()];
    const ends = docs.map((doc) => activationEndsOn(office.timezone, doc.startDate));
    const states = docs.map((doc, i) => activationState(doc.graduatedAt, office.today, ends[i]));
    const open = docs.filter((_, i) => states[i] === 'open');
    const resolved = open.length === 0 ? [] : await this.activations.resolve(ctx, open, office);
    const overdue = new Map(resolved.map((r) => [r.doc.membershipId, r.overdue]));

    docs.forEach((doc, i) => {
      out.set(doc.membershipId, {
        membershipId: doc.membershipId,
        startDate: doc.startDate,
        state: states[i],
        endsOn: ends[i],
        overdue: overdue.get(doc.membershipId) ?? false,
        graduatedOn: doc.graduatedAt ? this.clock.localDateFor(office.timezone, doc.graduatedAt) : null,
      });
    });
    return out;
  }
}
