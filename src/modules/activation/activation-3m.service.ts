import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import {
  ACTIVATION_3M_LOCKS, activation3MDecided, newHiresWindow, type Activation3MInput, type Activation3MLock,
  type Activation3MResult,
} from '@/domain/metrics/activation-3m';
import { AuditService } from '@/modules/audit/audit.service';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { RemovalService } from '@/modules/org/removal.service';
import { scopeFor } from '@/modules/rbac/permissions';
import type { Membership } from '@/modules/org/membership.schema';
import { TenantDay, type OfficeDay } from '@/modules/tenants/tenant-day.service';
import type { NewHireMarkedLeftView } from './activation-progress.view';

/** What a membership's 3M result is read from: who they are, and its four inputs. */
export type Activation3MMember = Pick<Membership, 'joinedAs' | 'joinDate' | 'firstSaleDate' | 'leftAt' | 'activation3M'> & {
  _id: unknown;
};

/** The fields `Activation3MMember` names, for a projection. */
export const ACTIVATION_3M_FIELDS = { joinedAs: 1, joinDate: 1, firstSaleDate: 1, leftAt: 1, activation3M: 1 } as const;

/**
 * **3M activation, kept once decided** (ADR-0171 §2, ADR-0173 §3; P18.96-T6 AC-1, AC-4; `metrics-and-definitions.md`,
 * *3M activation*). The result is `activation3MOf`'s (`domain/metrics/activation-3m.ts`); this keeps it.
 *
 * **The lock.** A decided result — *activated* or *not activated*, after day 90 of the join date or on the day a new
 * hire left within it — is written to `memberships.activation3M` in a conditional write on `null`, so nothing
 * replaces one kept. It is kept:
 *
 * 1. **before any write that would change one of its inputs** (`keepBeforeChange`): a first sale recorded, the join
 *    date corrected, *Mark left* — from the records as they stood;
 * 2. **by the reads that show it** (`settle`): `GET /new-hires` keeps each decided row it shows — **never in a
 *    read-only support session**, which writes nothing and computes the same answer.
 *
 * A decided result changes only when an input does, and every such write keeps it first, so **the kept result is
 * always what the records gave at the end of day 90** (or on the day they left), whichever read or write kept it.
 */
@Injectable()
export class Activation3MService {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly days: TenantDay,
    private readonly clock: Clock,
    private readonly coach: CoachResolver,
    private readonly audit: AuditService,
    // *Mark left* removes them from the office through the removal's own path (ADR-0173 §3, as amended 2026-10-27).
    private readonly removal: RemovalService,
  ) {}

  /** A new hire's inputs, their days in the office's calendar; `null` for anybody with no join date or not new. */
  inputOf(member: Activation3MMember, timezone: string): Activation3MInput | null {
    if (member.joinedAs !== 'new_hire' || !member.joinDate) return null;
    return {
      joinDate: member.joinDate,
      firstSaleDate: member.firstSaleDate ?? null,
      leftOn: member.leftAt ? this.clock.localDateFor(timezone, member.leftAt) : null,
      locked: member.activation3M ?? null,
    };
  }

  /**
   * **Each new hire's result on the office's today**, the decided ones nothing has kept yet kept now — in two
   * conditional writes at most, whatever the number — **unless the session is read-only**. Anybody who is not a new
   * hire is absent from the answer.
   */
  async settle(
    ctx: RequestContext, members: readonly Activation3MMember[], office: OfficeDay,
  ): Promise<Map<string, Activation3MResult>> {
    const results = new Map<string, Activation3MResult>();
    const toKeep: Record<Activation3MLock, string[]> = { activated: [], not_activated: [] };
    for (const member of members) {
      const input = this.inputOf(member, office.timezone);
      if (!input) continue;
      const decided = activation3MDecided(input, office.today);
      results.set(String(member._id), decided ?? 'in_progress');
      if (decided !== null && input.locked === null) toKeep[decided].push(String(member._id));
    }
    if (!ctx.impersonationReadOnly) await this.keep(ctx, toKeep);
    return results;
  }

  /**
   * **Before a write changes a new hire's join date, first sale or leaving** (the lock's rule 1): keep the result the
   * records give now, if it is decided. A no-op for anybody whose result is in progress, already kept, or who is no new
   * hire — so a write inside the 90 days changes what will be decided, and one after it changes nothing.
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

  /**
   * **`POST /new-hires/:membershipId/left`** (ADR-0173 §3, ADR-0169 §4 as amended 2026-10-27): a new hire has left.
   * `leftAt` is now, their 3M result is decided and kept — first from the records as they stood when it was already
   * decided (after day 90), then from the leaving itself (within it) — and **they leave the office through the
   * removal's own path** (`RemovalService.depart`): `status: removed` and `removedAt` the same instant, the open edge
   * closed and a `removed` event opened, their leader's counts, their notice, `member.removed` and the departure hook. So
   * they leave every count of people as any leaver does (ADR-0136), and `/new-hires` still lists them for the year, by
   * their result. Audited `new_hire.marked_left` beside the removal's own row.
   *
   * Reach is the grant's (`new_hire:mark_left`): `COACH` for a leader, the office's active members for the Owner and an
   * Admin — never the reader themselves. Outside it, another office's member included, **404**. Refused **409**
   * `NOT_A_NEW_HIRE` for an existing agent, **409** `NEW_HIRE_HAS_REPORTS` for one who leads somebody (a removal says
   * where reports go; leaving does not), and **409** `NEW_HIRE_ALREADY_LEFT` for one already marked — to a reader who
   * reached them when they left.
   *
   * **No wider than the removal it ends in** (the P18.96 exit review, M1, M2). `depart` carries none of `remove`'s
   * rules, so they are made here:
   *
   * - **the office's root or its owner** is refused as `remove` refuses them, `403 ORG_REMOVAL_NOT_PERMITTED`
   *   (`RemovalService.refuseTheOffice`);
   * - **only a hire `/new-hires` lists** (ADR-0173 §1, §3): a join date inside the page's year (`newHiresWindow`,
   *   `ACTIVATION_3M.WINDOW_MONTHS` back from the office's today). Inside it every result is accepted — in progress,
   *   not activated, and activated with an overdue checklist, which the page offers it on too. Outside it,
   *   `409 NEW_HIRE_NOT_MARKABLE`: `joinedAs` never expires, and without the bound a leader above could remove somebody
   *   two levels down who joined years ago, which `remove` keeps for their direct leader and the office.
   *
   * **The writes are ordered so a failed removal leaves nothing half-done** (L5): `leftAt` is claimed in one conditional
   * write — of two at once, one goes on — then the removal; if it throws while they are still active, `leftAt` is put
   * back. The result the leaving decides is kept, and audited, only once they are out.
   */
  async markLeft(ctx: RequestContext, membershipId: string): Promise<NewHireMarkedLeftView> {
    const office = await this.days.for(ctx);
    try {
      const subject = await this.coach.subject(ctx, membershipId, 'new_hire:mark_left', 'New hire');
      if (subject.self) throw new NotFoundException('New hire');
    } catch (err) {
      // Marked already, and so removed: answered as such to whoever reached them, as a 404 to anybody else.
      const gone = err instanceof NotFoundException ? await this.leftWithinReach(ctx, membershipId) : null;
      if (gone?.leftAt) throw alreadyLeft(this.clock.localDateFor(office.timezone, gone.leftAt));
      throw err;
    }
    const member = await this.memberships.findById(ctx, membershipId);
    if (!member) throw new NotFoundException('New hire');
    if (member.joinedAs !== 'new_hire') {
      throw new DomainException(
        ErrorCode.NOT_A_NEW_HIRE,
        'They joined as an existing agent, so they have no 3M activation to end. Only a new hire is marked as left.',
        HttpStatus.CONFLICT,
      );
    }
    if (member.leftAt) throw alreadyLeft(this.clock.localDateFor(office.timezone, member.leftAt));
    // M1: never the office's root or its owner, whom `remove` refuses to everybody.
    await this.removal.refuseTheOffice(ctx, member);
    // M2: only a hire the page lists.
    this.refuseOutsideTheYear(member, office);
    const reports = await this.memberships.count(ctx, { leaderId: membershipId, status: { $ne: 'removed' } });
    if (reports > 0) {
      throw new DomainException(
        ErrorCode.NEW_HIRE_HAS_REPORTS,
        `${reports} ${reports === 1 ? 'person reports' : 'people report'} to them. Move ${reports === 1 ? 'them' : 'those people'} `
          + 'to another leader before marking them as left.',
        HttpStatus.CONFLICT,
        { directCount: reports },
      );
    }

    // Rule 1: past day 90 the result is decided already, by the records as they stand — kept before the leaving lands.
    await this.settle(ctx, [member], office);
    const at = this.clock.now();
    const written = await this.memberships.updateMany(
      ctx, { _id: membershipId, joinedAs: 'new_hire', leftAt: null, status: 'active' }, { $set: { leftAt: at } },
    );
    if (written === 0) {
      const now = await this.memberships.findById(ctx, membershipId);
      throw alreadyLeft(now?.leftAt ? this.clock.localDateFor(office.timezone, now.leftAt) : office.today);
    }
    // Out of the office, as every leaver is — the same instant, so a count by day reads them gone from it.
    try {
      await this.removal.depart(ctx, member, { at, reason: 'Left the office as a new hire.' });
    } catch (err) {
      // L5: a removal that failed before it removed them leaves an active member, so their leaving is put back with it.
      await this.memberships.updateMany(ctx, { _id: membershipId, leftAt: at, status: 'active' }, { $set: { leftAt: null } });
      throw err;
    }
    // Within the 90 days the leaving decides it: kept now, from the day they left.
    const left = await this.memberships.findById(ctx, membershipId);
    const result = (await this.settle(ctx, [left!], office)).get(membershipId) as Activation3MLock;
    await this.audit.record(ctx, {
      action: 'new_hire.marked_left',
      targetCollection: 'memberships',
      targetId: membershipId,
      targetMembershipId: membershipId,
      before: { leftAt: null, activation3M: member.activation3M ?? null },
      after: { leftAt: at.toISOString(), activation3M: result },
    });
    return { membershipId, leftAt: at.toISOString(), leftOn: this.clock.localDateFor(office.timezone, at), activation3M: result };
  }

  /**
   * **M2: whether `/new-hires` lists them** (ADR-0173 §1): a join date inside the page's year (`newHiresWindow`). Any
   * result inside it is accepted; outside it, `409 NEW_HIRE_NOT_MARKABLE`.
   */
  private refuseOutsideTheYear(member: Activation3MMember, office: OfficeDay): void {
    const year = newHiresWindow(office.today);
    const joinDate = member.joinDate ?? null;
    if (joinDate === null || joinDate < year.from || joinDate > year.to) {
      throw new DomainException(
        ErrorCode.NEW_HIRE_NOT_MARKABLE,
        'They joined more than a year ago, so they are no longer on New Hires and there is no 3M result to decide. '
          + 'To take them out of the team, remove them.',
        HttpStatus.CONFLICT,
        { reason: 'past_the_year', joinDate },
      );
    }
  }

  /**
   * A new hire this reader reached when they left: a removed membership with `leftAt`, below the reader on the edges
   * it was removed with — or anywhere in the office for an `own-kpm` grant. `null` for anybody else.
   */
  private async leftWithinReach(ctx: RequestContext, membershipId: string): Promise<Activation3MMember | null> {
    const scope = scopeFor(ctx, 'new_hire:mark_left');
    const filter: Record<string, unknown> = { _id: membershipId, status: 'removed', leftAt: { $ne: null } };
    if (scope !== 'own-kpm' && scope !== 'all') filter.ancestorIds = ctx.membershipId;
    return this.memberships.findOne(ctx, filter);
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

/** Refused: they were marked left already, on that day. */
function alreadyLeft(leftOn: string): DomainException {
  return new DomainException(
    ErrorCode.NEW_HIRE_ALREADY_LEFT,
    'They are marked as left already.',
    HttpStatus.CONFLICT,
    { leftOn },
  );
}
