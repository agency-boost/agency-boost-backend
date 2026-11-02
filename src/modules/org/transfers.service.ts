import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { render } from '@/common/i18n/sentence';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { HierarchyService } from './hierarchy.service';
import { MemberNames } from './member-names.service';
import { MembershipRepository } from './membership.repository';
import { MembershipDocument } from './membership.schema';
import { ORG_MESSAGES, ORG_REFUSALS } from './org.messages';
import { TransferRequestRepository } from './org.repositories';
import { TransferRequestDocument, type TransferRequestStatus } from './transfer-request.schema';

/** A person a transfer names: their membership and their name, never a user id (invariant §2). */
export interface TransferPerson {
  membershipId: string;
  name: string;
}

/** One transfer request as the office's deciders draw it: *All Members* › *Pending* › *Transfer requests*. */
export interface TransferView {
  transferId: string;
  member: TransferPerson & { agentCode: string };
  /** Who they report to now; `null` only if they were leaderless when it was asked, which the form never does. */
  from: TransferPerson | null;
  to: TransferPerson;
  requestedBy: TransferPerson;
  requestedAt: string;
  /**
   * The name whoever asked typed, so a decider can see a code typed for somebody else; `null` on a request made before
   * it was kept.
   */
  requestedName: string | null;
}

/**
 * **One transfer request as whoever asked for it sees it** (the P18.96 exit review, M3): *+ Add agent*'s answer and
 * *Transfer requested* on `/new-hires`. Only what they typed and what they asked for — **never the account's own name
 * nor the leader they report to**, which a code typed into the form would otherwise reveal about a peer's unit.
 */
export interface RequestedTransferView {
  transferId: string;
  /** The name they typed; `null` on a request made before it was kept, which the screen shows by its code. */
  requestedName: string | null;
  /** The agent code they typed — the one the account holds, which is how it was found. */
  agentCode: string;
  /** The unit they asked for: its leader. */
  to: TransferPerson;
  status: TransferRequestStatus;
  requestedAt: string;
}

/**
 * **Moving a member to another leader** (ADR-0170 §4, P18.96-T3 AC-3): *+ Add agent* for somebody who already reports
 * to another leader in the office asks for it; the Owner and an Admin decide it. **No leader moves a member directly**
 * — the leader who asked waits, and sees *Transfer requested* on `/new-hires`.
 *
 * - **A loop is refused when it is asked** and again when it is approved: the new leader may not be the member or
 *   anybody in their unit (`HierarchyService.assertCanMoveUnder`), `409 ORG_CYCLE_DETECTED`.
 * - **One waiting per member** (`409 ORG_TRANSFER_PENDING`), so two cannot both be approved.
 * - **Approving moves them through `HierarchyService.reparent`**: their subtree with them, both leaders' counts
 *   refreshed, the open edge closed and a `re_parented` one opened (invariant §5). The member, the leader they left
 *   and whoever asked are told; declining tells whoever asked, with the reason.
 *
 * Every read and write is the office's own, through the scoped repository: another office's request is 404.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly transfers: TransferRequestRepository,
    private readonly members: MembershipRepository,
    private readonly hierarchy: HierarchyService,
    private readonly names: MemberNames,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  /**
   * **Ask for `member` to move under `leader`** — `InvitesService.addAgent`'s third outcome, with the name the form was
   * given. Refused, before anything is written, when they own the office (`403 ORG_NOT_PERMITTED_TO_TAG`, as *+ Add
   * agent* refuses the office's root: nobody adds them to a unit), when it would make a loop, or when one is already
   * waiting for them. The office's Owner and Admins are told; whoever asked is answered what they typed, and nothing
   * of the account (M3).
   */
  async request(
    ctx: RequestContext, member: MembershipDocument, leader: MembershipDocument, requestedName: string,
  ): Promise<RequestedTransferView> {
    const membershipId = String(member._id);
    const toLeaderId = String(leader._id);
    await this.refuseTheOwner(ctx, member);
    await this.hierarchy.assertCanMoveUnder(ctx, membershipId, toLeaderId);

    const open = await this.transfers.findOne(ctx, { membershipId, status: 'pending' });
    if (open) throw transferPending(String(open._id));

    let row: TransferRequestDocument;
    try {
      row = await this.transfers.create(ctx, {
        membershipId,
        fromLeaderId: member.leaderId,
        toLeaderId,
        requestedByMembershipId: ctx.membershipId!,
        requestedName: requestedName.trim(),
        status: 'pending',
      });
    } catch (err) {
      // Two forms submitted at once: the partial unique index lets one through.
      if ((err as { code?: number }).code === 11000) throw transferPending(null);
      throw err;
    }

    const [view] = await this.views(ctx, [row]);
    await this.audit.record(ctx, {
      action: 'transfer_request.created',
      targetCollection: 'transferRequests',
      targetId: String(row._id),
      targetMembershipId: membershipId,
      after: { fromLeaderId: member.leaderId, toLeaderId },
    });

    for (const userId of await this.deciders(ctx)) {
      await this.notifications.send({
        userId,
        kpmId: ctx.kpmId,
        templateId: NotificationTemplate.TRANSFER_REQUEST_RECEIVED,
        payload: { transferId: String(row._id), requesterName: view.requestedBy.name, memberName: view.member.name },
      });
    }
    return requested(view, row);
  }

  /**
   * **The transfers the reader asked for, still waiting** — *Transfer requested* on `/new-hires` — as they asked for
   * them: the name they typed, the code, the unit. Never the account's name or its leader (M3).
   */
  async mine(ctx: RequestContext): Promise<RequestedTransferView[]> {
    const rows = await this.transfers.find(
      ctx, { requestedByMembershipId: ctx.membershipId, status: 'pending' }, { sort: { createdAt: -1 } },
    );
    const views = await this.views(ctx, rows);
    return views.map((view, i) => requested(view, rows[i]));
  }

  /** **The office's queue**, oldest first: every transfer waiting on the Owner and the Admins. */
  async queue(ctx: RequestContext): Promise<TransferView[]> {
    const rows = await this.transfers.find(ctx, { status: 'pending' }, { sort: { createdAt: 1 } });
    return this.views(ctx, rows);
  }

  /**
   * **Approve: the member moves.** Re-checked at the decision — they are still an active member (else the request is
   * closed, `409 ORG_ALREADY_REMOVED`), **still under the leader it was asked from** (else closed, `409
   * ORG_TRANSFER_STALE`: somebody moved them since; L4), not the office's owner, the new leader is still in the office,
   * and the move is no loop — then claimed, so of two admins deciding at once one moves them and the other is told it
   * was decided, and moved. **A move that fails puts the request back to pending** (L4), so it is never *approved* with
   * nobody moved.
   */
  async approve(ctx: RequestContext, transferId: string): Promise<TransferView[]> {
    const row = await this.openRequest(ctx, transferId);
    const member = await this.members.findById(ctx, row.membershipId);
    if (!member || member.status !== 'active') {
      await this.close(ctx, transferId);
      throw new DomainException(
        ErrorCode.ORG_ALREADY_REMOVED,
        ORG_REFUSALS.ORG_ALREADY_REMOVED.nobodyToMove,
        HttpStatus.CONFLICT,
        { transferId },
      );
    }
    if (member.leaderId !== row.fromLeaderId) {
      await this.close(ctx, transferId);
      throw new DomainException(
        ErrorCode.ORG_TRANSFER_STALE,
        ORG_REFUSALS.ORG_TRANSFER_STALE.movedSince,
        HttpStatus.CONFLICT,
        { transferId },
      );
    }
    await this.refuseTheOwner(ctx, member);
    await this.hierarchy.assertCanMoveUnder(ctx, row.membershipId, row.toLeaderId);

    const [view] = await this.views(ctx, [row]);
    const claimed = await this.transfers.decide(ctx, transferId, {
      status: 'approved', decidedAt: this.clock.now(), decidedByMembershipId: ctx.membershipId,
    });
    if (!claimed) throw await this.decided(ctx, transferId);

    const previousLeaderId = member.leaderId;
    try {
      // The edge's reason is stored, so it is written in the decider's language (P18.98-T5 AC-6).
      await this.hierarchy.reparent(
        ctx, row.membershipId, row.toLeaderId, render(ORG_MESSAGES.transferApproved, ctx.reader),
      );
    } catch (err) {
      // Nobody moved, so nothing is approved: the request waits again, for this decider or another.
      await this.transfers.updateMany(
        ctx,
        { _id: transferId, status: 'approved', decidedByMembershipId: ctx.membershipId },
        { $set: { status: 'pending', decidedAt: null, decidedByMembershipId: null } },
      );
      throw err;
    }

    await this.audit.record(ctx, {
      action: 'transfer_request.approved',
      targetCollection: 'transferRequests',
      targetId: transferId,
      targetMembershipId: row.membershipId,
      before: { leaderId: previousLeaderId },
      after: { leaderId: row.toLeaderId },
    });

    const payload = { transferId, decision: 'approved', memberName: view.member.name, toLeaderName: view.to.name };
    const told = new Set<string>();
    const tell = async (membershipId: string | null, audience: 'member' | 'from_leader' | 'requester') => {
      if (!membershipId || told.has(membershipId)) return;
      told.add(membershipId);
      const person = await this.members.findById(ctx, membershipId);
      if (!person) return;
      await this.notifications.send({
        userId: person.userId,
        kpmId: ctx.kpmId,
        templateId: NotificationTemplate.TRANSFER_REQUEST_DECIDED,
        payload: { ...payload, audience },
      });
    };
    await tell(row.membershipId, 'member');
    if (previousLeaderId !== row.toLeaderId) await tell(previousLeaderId, 'from_leader');
    // Whoever asked is told in their own words: the name they typed (M3).
    payload.memberName = askedFor(view);
    await tell(row.requestedByMembershipId, 'requester');
    return this.queue(ctx);
  }

  /** **Decline: nothing about the member changes.** Whoever asked is told, with the reason when one is given. */
  async decline(ctx: RequestContext, transferId: string, reason?: string): Promise<TransferView[]> {
    const row = await this.openRequest(ctx, transferId);
    const why = reason?.trim() || null;
    const [view] = await this.views(ctx, [row]);
    const claimed = await this.transfers.decide(ctx, transferId, {
      status: 'declined', decidedAt: this.clock.now(), decidedByMembershipId: ctx.membershipId, reason: why,
    });
    if (!claimed) throw await this.decided(ctx, transferId);

    await this.audit.record(ctx, {
      action: 'transfer_request.declined',
      targetCollection: 'transferRequests',
      targetId: transferId,
      targetMembershipId: row.membershipId,
      after: { reason: why },
    });
    const requester = await this.members.findById(ctx, row.requestedByMembershipId);
    if (requester) {
      await this.notifications.send({
        userId: requester.userId,
        kpmId: ctx.kpmId,
        templateId: NotificationTemplate.TRANSFER_REQUEST_DECIDED,
        payload: { transferId, decision: 'declined', audience: 'requester', memberName: askedFor(view), reason: why },
      });
    }
    return this.queue(ctx);
  }

  /** A pending request of this office, or 404 — and 409 naming the decision for one already decided. */
  private async openRequest(ctx: RequestContext, transferId: string): Promise<TransferRequestDocument> {
    const row = await this.transfers.findById(ctx, transferId);
    if (!row) throw new NotFoundException('Transfer request');
    if (row.status !== 'pending') throw alreadyDecided(row);
    return row;
  }

  /** Close a request that can no longer be carried out, if it still waits. */
  private async close(ctx: RequestContext, transferId: string): Promise<void> {
    await this.transfers.decide(ctx, transferId, {
      status: 'cancelled', decidedAt: this.clock.now(), decidedByMembershipId: ctx.membershipId,
    });
  }

  /**
   * **The office's owner is never moved by a request** (M3): *+ Add agent* refuses the office's root, who has no
   * leader, and an owner who has one — ownership moved to a member — is refused the same, when asked and when
   * approved. Moving the office's owner is the platform's.
   */
  private async refuseTheOwner(ctx: RequestContext, member: MembershipDocument): Promise<void> {
    if (await this.hierarchy.ownsTheOffice(ctx, member)) {
      throw new DomainException(
        ErrorCode.ORG_NOT_PERMITTED_TO_TAG,
        ORG_REFUSALS.ORG_NOT_PERMITTED_TO_TAG.ownerNotAdded,
        HttpStatus.FORBIDDEN,
        { membershipId: String(member._id) },
      );
    }
  }

  private async decided(ctx: RequestContext, transferId: string): Promise<DomainException> {
    const row = await this.transfers.findById(ctx, transferId);
    return row ? alreadyDecided(row) : new NotFoundException('Transfer request');
  }

  /** Who decides a transfer: the office's Owner and every active Admin, as accounts — never the one who asked. */
  private async deciders(ctx: RequestContext): Promise<string[]> {
    const kpm = await this.kpms.findOne({ _id: ctx.kpmId, deletedAt: null }).exec();
    const admins = await this.members.find(ctx, { status: 'active', 'adminAccess.isKpmAdmin': true });
    const ids = new Set([...(kpm?.ownerUserId ? [kpm.ownerUserId] : []), ...admins.map((m) => m.userId)]);
    ids.delete(ctx.userId);
    return [...ids];
  }

  private async views(ctx: RequestContext, rows: TransferRequestDocument[]): Promise<TransferView[]> {
    if (rows.length === 0) return [];
    const ids = rows.flatMap((r) => [r.membershipId, r.toLeaderId, r.requestedByMembershipId, ...(r.fromLeaderId ? [r.fromLeaderId] : [])]);
    const [names, people] = await Promise.all([
      this.names.byMembershipId(ctx, ids),
      this.members.find(ctx, { _id: { $in: [...new Set(rows.map((r) => r.membershipId))] } }),
    ]);
    const codeOf = new Map(people.map((m) => [String(m._id), m.agentCode]));
    const person = (membershipId: string): TransferPerson => ({ membershipId, name: names.get(membershipId) ?? '' });
    return rows.map((r) => ({
      transferId: String(r._id),
      member: { ...person(r.membershipId), agentCode: codeOf.get(r.membershipId) ?? '' },
      from: r.fromLeaderId ? person(r.fromLeaderId) : null,
      to: person(r.toLeaderId),
      requestedBy: person(r.requestedByMembershipId),
      requestedAt: (r.get('createdAt') as Date | undefined)?.toISOString() ?? '',
      requestedName: r.requestedName ?? null,
    }));
  }
}

/** A request as whoever asked sees it: what they typed and asked for, from the full view, and nothing else of it. */
function requested(view: TransferView, row: TransferRequestDocument): RequestedTransferView {
  return {
    transferId: view.transferId,
    requestedName: view.requestedName,
    agentCode: view.member.agentCode,
    to: view.to,
    status: row.status,
    requestedAt: view.requestedAt,
  };
}

/** The person as whoever asked named them: the name they typed, or the code on a request made before it was kept. */
function askedFor(view: TransferView): string {
  return view.requestedName || view.member.agentCode;
}

function transferPending(transferId: string | null): DomainException {
  return new DomainException(
    ErrorCode.ORG_TRANSFER_PENDING,
    ORG_REFUSALS.ORG_TRANSFER_PENDING.waiting,
    HttpStatus.CONFLICT,
    { transferId },
  );
}

function alreadyDecided(row: TransferRequestDocument): DomainException {
  return new DomainException(
    ErrorCode.ORG_REQUEST_ALREADY_DECIDED,
    ORG_REFUSALS.ORG_REQUEST_ALREADY_DECIDED.transfer({ status: row.status }),
    HttpStatus.CONFLICT,
    { status: row.status, decidedAt: row.decidedAt },
  );
}
