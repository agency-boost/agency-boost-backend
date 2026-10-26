import { HttpStatus, Injectable, Optional, Inject } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, NoMembershipException, NotFoundException, VersionConflictException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { MemberNames } from '@/modules/org/member-names.service';
import { CoachResolver } from '@/modules/org/coach-resolver';
import type { Permission } from '@/modules/rbac/permissions';
import { LeadStatusRepository } from '@/modules/config/activity.repository';
import type { LeadStatusView } from '@/modules/config/lead-status.service';
import { TenantConfigService } from '@/modules/config/tenant-config.service';
import { TenantDay, type OfficeDay } from '@/modules/tenants/tenant-day.service';
import { ActivationEvents, signalActivation } from '@/modules/activation/activation-events.port';
import { leadFlags, type LeadFlag } from './lead-attention';
import { checkLead, type CheckedLead } from './lead-input';
import { isInMemorySort, ladderRanks, leadOrder, SAVED_ORDER, type LeadSortKey } from './lead-order';
import { recruitmentPipelineFacets } from './lead-readings';
import { LeadRepository } from './lead.repository';
import type { LeadDocument, LeadType } from './lead.schema';

/** What an agent may be told is asking for them. Derived, never stored. */
export type { LeadFlag } from './lead-attention';

/** How many rows a page of the Leads screen holds. Stated here, not chosen in a component. */
export const LEAD_PAGE_SIZE = 50;

/** The screen's search, filter and sort, as the service reads them. */
export interface LeadQuery {
  /** One member's leads: the caller's own, or a coachee's (P11-T4 AC-3). */
  owner?: string;
  search?: string;
  type?: 'sales' | 'recruitment' | 'unassigned';
  statusCode?: string;
  outcome?: 'won' | 'lost' | 'open';
  attention?: LeadFlag;
  sort?: LeadSortKey;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

/**
 * The rollups that read leads, computed once (P7-T6).
 *
 * **Every number here is something already defined somewhere else.** Two are the metric registry's
 * (invariant §8); the other four are this module's own rules — the commitment T5 defines and the
 * attention flags T4 does — and nothing in this shape is a figure invented for a screen.
 *
 * **No route serves it since P10.1-T4.** Its one reader was the counts strip on `/leads`, which went
 * back to the prototype. `RECRUITMENT_PIPELINE_NOW` and `RECRUITMENT_EXPECTED_TO_CLOSE` are
 * registered as computed from Phase 7, and this is the only place that computes them. The route was
 * retired and the computation kept, for the next screen that reads them.
 */
export interface LeadSummary {
  /** Open leads in scope: `outcome` null, not deleted. */
  open: number;
  /** Open leads promised for the office's **current** month — the glossary's *Commitment*. */
  committedThisMonth: number;
  /** `RECRUITMENT_PIPELINE_NOW`: open recruitment candidates not on the stage that closes it. */
  recruitmentPipelineNow: number;
  /** `RECRUITMENT_EXPECTED_TO_CLOSE`: open recruitment candidates on a late stage (ADR-0043). */
  recruitmentExpectedToClose: number;
  /** How many open leads carry each attention flag. A lead may carry two, so these overlap. */
  attention: Record<LeadFlag, number>;
}

/** One page of them, and how many there are to page through. */
export interface LeadPage {
  rows: LeadView[];
  total: number;
  page: number;
  pageSize: number;
}

/** One lead, as a caller reads it. */
export interface LeadView {
  id: string;
  ownerMembershipId: string;
  type: LeadType | null;
  name: string;
  /**
   * Phone and email, as the agent typed them. **No lawful basis beside them since 2026-10-07**
   * (ADR-0108 §1): `lawfulBasis` and `consentAt` left this shape with the field that asked for them.
   * The stored columns stay, unread, so nothing written before that day is erased.
   */
  contact: { phone: string | null; email: string | null };
  statusCode: string | null;
  /**
   * **Derived, not stored** (P7-T5): is there a commitment for the office's current month?
   *
   * The field an API caller reads is unchanged — what changed is that nothing has to clear it.
   */
  thisMonth: boolean;
  /** Every month this lead was promised for, oldest first. The archive, and it is the record. */
  committedMonths: string[];
  /**
   * Who last changed it, when that was not the agent whose lead it is (ADR-0044).
   *
   * `null` when the owner made the last change themselves — which is the ordinary case, and the
   * reason this is a name rather than a flag: *two columns, so no flag is needed*. An id that
   * resolves to nobody leaves `name` null and keeps the membership, because a blank reads as
   * *nothing happened* rather than as *this is all we know*.
   *
   * **Kept narrower than ADR-0063 §1's wording, on `GET /leads?owner=` too** (decided by P11-T4, under
   * its phase-file note): a leader is not told that an agent changed their own lead last. The ✎ exists
   * to tell the *owner* whose hand moved their record; a leader reading a coachee's card already sees
   * every field as it stands, and widening the field would also change what `/leads` shows on every row
   * the owner touched.
   */
  lastEditedBy: { membershipId: string; name: string | null } | null;
  remarks: string | null;
  nextActionDate: string | null;
  nextActionNote: string | null;
  outcome: 'won' | 'lost' | null;
  source: string | null;
  dateRegistered: string | null;
  version: number;
  /** Computed on read, so the screen and the service cannot disagree about what is overdue. */
  flags: LeadFlag[];
  /**
   * How late, in the office's own days. `null` unless `flags` carries `overdue`.
   *
   * *Overdue 14 days* and *Overdue 1 day* are different conversations, and the prototype says
   * which (`leads-management.md` §4). Kept **beside** `flags` rather than folded into it: `flags`
   * is what the screen filters on, and a filter key carrying a number is a filter key nobody can
   * match against.
   */
  overdueDays: number | null;
}

/**
 * The lead record (P7-T1).
 *
 * **Whose lead a write is.** Without `owner`, a create is the caller's own lead, as an activity day is
 * logged for the person logging it. **With `owner`, `POST /leads?owner=` creates in a coachee's
 * pipeline** (ADR-0076, P11-T4): a leader's *+ Add lead* in a coaching session. The owner is resolved by
 * `CoachResolver.subject` on `lead:create` — `COACH(caller, owner)` and nothing wider — so a peer AAB's
 * agent, another office's member, a member who has left and the caller naming themselves are each a 404,
 * and nothing is written (`coachedOwner`). The lead is the owner's and the act is the leader's:
 * `createdBy`, a commitment's `byMembershipId`, the `lead.created` entry and `lastEditedBy` name the leader
 * (ADR-0044). A leader's write to an **existing** lead of a downline's — ADR-0044, built in P7-T7 —
 * names the lead, and reaches it exactly when the leader reaches its owner (`reachable`).
 *
 * **No status is written here, and that is the line between this task and P7-T3.** Setting a lead's
 * first status is a *move* — `{ fromStatusCode: null, toStatusCode, at, byMembershipId }` — and
 * every move belongs to the task that owns the ladder's rules (ADR-0045).
 */
@Injectable()
export class LeadService {
  constructor(
    private readonly leads: LeadRepository,
    private readonly statuses: LeadStatusRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly days: TenantDay,
    private readonly coach: CoachResolver,
    private readonly names: MemberNames,
    private readonly config: TenantConfigService,
    // OD-107: a leader's list of their downline's leads leaves the §3.5 record, per owner shown.
    private readonly subjectReads: SubjectReadAudit,
    /*
     * P13-T3 AC-5: a lead in a hire's pipeline completes their activation's `feature:leads` item. A port
     * the activation module answers, so leads does not depend on it; optional, failing open.
     */
    @Optional() @Inject(ActivationEvents) private readonly activation: ActivationEvents | null = null,
  ) {}

  /**
   * Whose leads this caller may touch, for the permission the **route** declares (P7-T7, P11-T3).
   *
   * **Their own, always — plus whoever the grant reaches**, which is `CoachResolver.reach`: the one
   * answer to *whose data does this grant reach* that goals and activity read too. A lead belongs to
   * a membership, so a leader reaches a lead exactly when they reach its owner — everybody they
   * coach, an AAB's nested units included (ADR-0074), and nobody who has left their unit or the
   * office (§6.1, §6.7). The grant is read from the matrix rather than from the caller's rung,
   * because those two have already drifted once: `summary` was gated on one permission and resolved
   * another, and the narrower of the pair would have gone on enforcing the wider one's scope (found
   * at the Phase 6 exit review).
   *
   * `null` means *the whole office* and is reachable only by `lead:read_aggregate_counts`. No
   * row-reading permission grants `own-kpm` to anybody: the Owner and the Admin get counts, never
   * rows, because these are third-party personal data typed by an agent about somebody who never
   * interacted with the platform, and minimisation applies inside the tenant too (§3.7). **No grant
   * reaches nobody's leads**, rather than falling through to the caller's own.
   */
  private async ownersInScope(
    ctx: RequestContext, permission: Permission,
  ): Promise<string[] | null> {
    return this.coach.reach(ctx, permission);
  }

  /**
   * The lead this caller may act on, or a 404.
   *
   * **404 and never 403**, exactly as a cross-tenant read is: a leader asking after somebody
   * outside their downline should not learn from the shape of the refusal that the lead exists.
   * The same sentence has been true of `kpmId` since Phase 2; ownership inside one office is the
   * same question one level down, and it was **not enforced at all** until this task — any agent
   * could read, edit or delete a colleague's lead, which no test asked about because the tenancy
   * spec only ever crossed offices.
   */
  private async reachable(
    ctx: RequestContext, id: string, permission: Permission, pinned?: number, writing = false,
  ): Promise<LeadDocument> {
    const lead = await this.leads.findById(ctx, id);
    if (!lead) throw new NotFoundException('Lead');
    const owners = await this.ownersInScope(ctx, permission);
    if (owners !== null && !owners.includes(lead.ownerMembershipId)) {
      throw new NotFoundException('Lead');
    }
    /*
     * **A writer who is not the lead's owner must pin** (P11-T4 AC-3; `functional/coaching.md`, *The
     * Leads card*). There is a second writer now — the leader in the coaching session, editing the
     * coachee's lead while the coachee may be editing it on their phone — and a write that forgets the
     * pin is a write that can silently discard the other's. The owner's own writes keep it optional, as
     * P7-T7 built them. After the scope check, so it confirms nothing about a lead out of reach.
     */
    if (writing && pinned === undefined && lead.ownerMembershipId !== ctx.membershipId) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Send the version you read this lead at. A change to somebody else’s lead has to say which '
        + 'version it was written against.',
        HttpStatus.BAD_REQUEST,
        { violations: ['version is required when the lead is not yours'] },
      );
    }
    /*
     * **The version the writer read, checked before anything is written** (P7-T7 AC-3).
     *
     * Two people in one 1-on-1 on two devices is the realistic case rather than the edge one: the
     * leader opens the lead, the agent edits a remark, the leader saves, and last-write-wins
     * silently discards what the agent typed in front of them.
     *
     * **After the scope check, deliberately.** A stale version on a lead the caller may not reach
     * would otherwise answer 409 where the answer is 404 — and 409 confirms the lead exists.
     *
     * Optional for the owner, and honoured whenever it is sent; required of anybody else, above. The
     * check here is the early answer, and `writeAt` repeats it atomically in the write itself.
     */
    if (pinned !== undefined && pinned !== lead.version) {
      throw new VersionConflictException(pinned, lead.version);
    }
    return lead;
  }

  /** The caller's own membership, or a refusal that says what to do about it. */
  private me(ctx: RequestContext): string {
    const membershipId = ctx.membershipId;
    if (!membershipId) throw new NoMembershipException();
    return membershipId;
  }

  /**
   * **Write the lead only if it is still the version that was read** (P11-T4 AC-3): the version check
   * and the write in one operation (`LeadRepository.updateAtVersion`).
   *
   * `reachable` compares the pin with the row it read; between that read and this write a second
   * writer can land, and a write filtered on the id alone would overwrite them. Filtered on the version
   * too, it finds nothing instead — and that is a conflict, `VERSION_CONFLICT`, or a 404 when the lead
   * has gone. Every write here is computed from the row it read — a commitment pushed or pulled, a
   * basis stamped — so an owner's unpinned write is held to the version it read as well.
   */
  private async writeAt(
    ctx: RequestContext, lead: LeadDocument, update: Record<string, unknown>,
  ): Promise<LeadDocument> {
    const id = String(lead._id);
    const written = await this.leads.updateAtVersion(ctx, id, lead.version, update);
    if (written) return written;
    const now = await this.leads.findById(ctx, id);
    if (!now) throw new NotFoundException('Lead');
    throw new VersionConflictException(lead.version, now.version);
  }

  /**
   * **Whose pipeline a leader's *+ Add lead* writes to** (P11-T4; `functional/coaching.md`, *The Leads
   * card*): somebody the caller coaches, resolved on `lead:create` as every subject is — `own` reaches
   * nobody else, a hierarchy token reaches `COACH`. **Naming yourself, or nobody, is a 404** like anybody
   * outside it: your own lead is `POST /leads` without `owner`, and a leader never coaches themselves
   * (ADR-0074).
   */
  private async coachedOwner(ctx: RequestContext, owner: string): Promise<string> {
    if (!owner || owner === ctx.membershipId) throw new NotFoundException('Membership');
    return (await this.coach.subject(ctx, owner, 'lead:create', 'Membership')).membershipId;
  }

  /**
   * Add a lead: the caller's own, or — with `owner` (P11-T4) — in the pipeline of somebody the caller
   * coaches. **The lead is the owner's and the act is the caller's** (ADR-0044): `createdBy`, a
   * commitment's `byMembershipId`, the `lead.created` entry and `lastEditedBy` name the caller, so the
   * owner's ✎ says who added it. A lead starts on no stage, so its first transition names whoever first
   * moves it. **No notification**: the coachee is in the 1-on-1 where it was added.
   */
  async create(ctx: RequestContext, body: unknown, owner?: string): Promise<LeadView> {
    const membershipId = this.me(ctx);
    // The body first, then whose it is: a refusal of the shape (400) comes before one of reach (404).
    const input = checkLead(body);
    const ownerMembershipId = owner === undefined ? membershipId : await this.coachedOwner(ctx, owner);
    const day = await this.days.for(ctx);
    const contact = input.contact ?? { phone: null, email: null };

    const now = this.clock.now();
    const created = await this.leads.create(ctx, {
      ownerMembershipId,
      // The top of the owner's list (ADR-0161 §1), a coachee's included when a leader adds it.
      position: await this.firstPlace(ctx, ownerMembershipId),
      name: input.name!,
      type: input.type ?? null,
      // **No `lawfulBasis` and no `consentAt`** (ADR-0108 §1): the schema's nulls, never a ground
      // nobody chose.
      contact,
      remarks: input.remarks ?? null,
      nextActionDate: input.nextActionDate ?? null,
      nextActionNote: input.nextActionNote ?? null,
      source: input.source ?? null,
      // A promise is a row with the month on it, so nothing has to clear it later (P7-T5).
      commitments: input.thisMonth
        ? [{ month: day.month, at: now, byMembershipId: membershipId }]
        : [],
      // A move, and moves are P7-T3. A lead starts on no rung.
      statusCode: null,
      statusId: null,
      dateRegistered: now,
      version: 1,
      transitions: [],
      createdBy: membershipId,
      updatedBy: membershipId,
    } as Partial<LeadDocument>);

    await this.record(ctx, 'lead.created', String(created._id), {
      type: created.type,
      // **Never the name, never the contact.** An audit row is read by an administrator who has no
      // right to the lead's rows (§3.7); recording them here would route around that.
      hasContact: Boolean(contact.phone || contact.email),
      // Whose pipeline, when it is not the caller's: the entry's actor is the leader who added it.
      ...(ownerMembershipId !== membershipId ? { ownerMembershipId } : {}),
    });
    // P13-T3 AC-3: a lead of either type, added by the hire or by a leader in a session.
    await signalActivation(this.activation, ctx, ownerMembershipId, 'feature:leads');
    return this.view(
      created, day, ownerMembershipId === membershipId ? new Map() : await this.attribution(ctx, [created]),
    );
  }

  async update(ctx: RequestContext, id: string, body: unknown): Promise<LeadView> {
    const membershipId = this.me(ctx);
    const input = checkLead(body, { partial: true });
    const lead = await this.reachable(ctx, id, 'lead:update', input.version, true);
    const next = this.merge(lead, input);

    const now = this.clock.now();
    const day = await this.days.for(ctx);
    /*
     * **`lawfulBasis` and `consentAt` are left as they are** (ADR-0108 §1). A value stored before
     * 2026-10-07 is kept, unread; nothing writes it, and nothing clears it either — a deploy is not
     * an erasure.
     */
    const $set: Record<string, unknown> = {
      ...this.writable(input),
      contact: next.contact,
      updatedBy: membershipId,
    };

    /*
     * **Changing the ladder clears the rung, and the commitment with it.**
     *
     * The two pipelines have no stage in common, so a sales lead reclassified as recruitment
     * would otherwise go on holding `FOLLOW_UP` — a code from a ladder it is no longer on.
     * `setStatus` would refuse to move it there, and `setOutcome('won')` would look up its
     * `isTerminal` on the wrong pipeline's stage and let it close from nowhere.
     *
     * The prototype does the same (`leads-management.md` §4), including the commitment: *close
     * this month* and *recruit this month* are different promises, and one does not survive
     * becoming the other. **No transition is appended** — the lead has not moved to a stage, it
     * has left one, and a history row that named a destination would invent one. The
     * `lead.updated` audit row carries the field change.
     */
    const dropCommitment = input.type !== undefined && input.type !== lead.type;
    if (dropCommitment) {
      $set.statusCode = null;
      $set.statusId = null;
    }

    /*
     * **The promise for *this* month, and no other.**
     *
     * A patch can only add or drop the current month's entry: a promise about September stops
     * being editable when September ends, because by then it is something that was said rather
     * than something being decided. Which is what makes the archive worth keeping — and it is why
     * the only write here is scoped to `day.month`.
     *
     * Dropping is a `$pull` rather than a tombstone: un-ticking the box inside the month is
     * correcting today's promise, not erasing a past one. Nothing before this month can be
     * reached from here at all.
     */
    const commit = dropCommitment ? false : input.thisMonth;
    const alreadyCommitted = (lead.commitments ?? []).some((c) => c.month === day.month);
    const write: Record<string, unknown> = { $set, $inc: { version: 1 } };
    if (commit === true && !alreadyCommitted) {
      write.$push = { commitments: { month: day.month, at: now, byMembershipId: membershipId } };
    } else if (commit === false && alreadyCommitted) {
      write.$pull = { commitments: { month: day.month } };
    }

    const updated = await this.writeAt(ctx, lead, write);

    await this.record(ctx, 'lead.updated', id, {
      fields: Object.keys(this.writable(input)),
      hasContact: Boolean(next.contact.phone || next.contact.email),
    });
    return this.view(updated, day, await this.attribution(ctx, [updated]));
  }

  /**
   * Move a lead to a stage (P7-T3).
   *
   * **Any active stage of its own pipeline, at any time** (ADR-0045). What refuses is about the
   * lead's identity and its outcome, never its path — `rank` is presentation and reorderable, so a
   * forward-only rule would let a drag on the Owner's settings screen change which moves their
   * agents may make.
   */
  async setStatus(
    ctx: RequestContext, id: string, statusCode: string, pinned?: number,
  ): Promise<LeadView> {
    const membershipId = this.me(ctx);
    const lead = await this.reachable(ctx, id, 'lead:update', pinned, true);

    if (lead.outcome) {
      throw new DomainException(
        ErrorCode.LEAD_ALREADY_CLOSED,
        'This lead is closed. Reopen it before moving it again.',
        HttpStatus.CONFLICT,
        { outcome: lead.outcome },
      );
    }
    if (!lead.type) {
      // The prototype disables the status select until a ladder is chosen, and it is right to:
      // a stage means nothing until we know which of the two vocabularies it belongs to.
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Choose whether this is a sales or a recruitment lead before setting a stage.',
        HttpStatus.BAD_REQUEST,
        { violations: ['type is required before a stage'] },
      );
    }

    const wanted = statusCode.trim().toUpperCase();
    if (wanted === lead.statusCode) {
      return this.view(lead, await this.days.for(ctx), await this.attribution(ctx, [lead]));
    }

    const status = await this.publishedStage(ctx, wanted);
    if (!status) {
      // Not on any ladder the office has published. A stage it has since retired keeps its own
      // refusal, so the reader is told why rather than that the stage does not exist.
      const live = await this.statuses.findOne(ctx, { code: wanted });
      if (live?.status === 'archived') throw this.retired(wanted);
      throw new NotFoundException('Lead status', { code: wanted });
    }
    if (status.pipeline !== lead.type) {
      throw new DomainException(
        ErrorCode.LEAD_STATUS_WRONG_PIPELINE,
        `${wanted} belongs to the ${status.pipeline} ladder; this is a ${lead.type} lead.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { code: wanted, pipeline: status.pipeline, leadType: lead.type },
      );
    }
    // A snapshot carries active stages only; an older one that carried a retired stage still refuses it.
    if (status.status === 'archived') throw this.retired(wanted);

    const at = this.clock.now();
    const updated = await this.writeAt(ctx, lead, {
      $set: { statusCode: wanted, statusId: status.id, updatedBy: membershipId },
      // Append-only. The lead's current status is the last row's destination, and this is what
      // makes a jump legible and a leader's edit attributable (ADR-0044, ADR-0045).
      $push: {
        transitions: {
          fromStatusCode: lead.statusCode ?? null, toStatusCode: wanted, at, byMembershipId: membershipId,
        },
      },
      $inc: { version: 1 },
    });

    await this.record(ctx, 'lead.status_changed', id, {
      from: lead.statusCode ?? null, to: wanted, byMembershipId: membershipId,
    });
    return this.view(updated, await this.days.for(ctx), await this.attribution(ctx, [updated]));
  }

  /**
   * Close a lead, or reopen one (P7-T3).
   *
   * **Won needs the stage that closes the pipeline; lost needs nothing** (§3.7). The two prototype
   * screens disagree — the agent screen allows Lost anywhere and gates Won, the coaching screen
   * gates both — and the stricter reading of each half is taken.
   *
   * Reopening appends no transition: the lead has not moved, and a history that recorded it as a
   * move would be a stage nobody worked.
   */
  async setOutcome(
    ctx: RequestContext, id: string, outcome: 'won' | 'lost' | null, pinned?: number,
  ): Promise<LeadView> {
    const membershipId = this.me(ctx);
    const lead = await this.reachable(ctx, id, 'lead:mark_outcome', pinned, true);

    if (outcome && lead.outcome) {
      throw new DomainException(
        ErrorCode.LEAD_ALREADY_CLOSED,
        `This lead is already ${lead.outcome}. Reopen it before closing it again.`,
        HttpStatus.CONFLICT,
        { outcome: lead.outcome },
      );
    }

    if (outcome === 'won') {
      // The terminal flag the screen's ✓ read: the published ladder's (P13.1-T4 AC-10).
      const status = lead.statusCode ? await this.publishedStage(ctx, lead.statusCode) : null;
      if (!status?.isTerminal) {
        throw new DomainException(
          ErrorCode.LEAD_STATUS_NOT_FINAL,
          'A lead is won at the stage that closes its pipeline. Move it there first.',
          HttpStatus.UNPROCESSABLE_ENTITY,
          { statusCode: lead.statusCode ?? null },
        );
      }
    }

    const updated = await this.writeAt(ctx, lead, {
      $set: {
        outcome,
        outcomeAt: outcome ? this.clock.now() : null,
        updatedBy: membershipId,
      },
      $inc: { version: 1 },
    });

    await this.record(ctx, outcome ? 'lead.closed' : 'lead.reopened', id, {
      outcome, from: lead.outcome ?? null, statusCode: lead.statusCode ?? null,
    });
    return this.view(updated, await this.days.for(ctx), await this.attribution(ctx, [updated]));
  }

  /**
   * **A stage as the office has published it** — the ladder `GET /kpm/config` gives the screen — or
   * `null` when no published ladder holds it (P13.1-T4 AC-10).
   *
   * The table's *Status* select and its ✓ gate read the published snapshot, so the move and the close
   * read it too. Validating against the live rows let the two disagree in both directions, which is
   * the defect P13.1-T2 fixed for the activity log: a stage the Owner retired in the draft after
   * publishing was still offered on every agent's screen and refused with `CONFIG_ARCHIVED` when
   * chosen, and a stage created in the draft was accepted though no agent could see it. Now a retired
   * stage stays selectable until the Owner publishes again, and a new one is refused until they do.
   * `readPublished` falls back to the working copy for an office that has never published, as the
   * screen's own read does.
   */
  private async publishedStage(ctx: RequestContext, code: string): Promise<LeadStatusView | null> {
    const { leadPipelines } = await this.config.readPublished(ctx);
    for (const pipeline of leadPipelines) {
      const found = pipeline.statuses.find((s) => s.code === code);
      if (found) return found;
    }
    return null;
  }

  /** Invariant §3: archived configuration stays readable so history renders, not writable. */
  private retired(code: string): DomainException {
    return new DomainException(
      ErrorCode.CONFIG_ARCHIVED,
      `${code} has been retired. Leads already on it keep it; new ones cannot be moved to it.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      { code },
    );
  }

  /**
   * Soft, and the owner's alone (§3.7).
   *
   * Nothing is removed. Erasure under PDP is a deliberate, audited, cascading operation and not
   * this button (invariant §6).
   */
  async remove(ctx: RequestContext, id: string): Promise<{ id: string; deletedAt: string }> {
    // `lead:delete` is `own` for the agent and granted to nobody else (§3.7), so this resolves to
    // their own leads and a leader's 🗑 on a downline's row is a 404. The coaching leads table has
    // no delete at all, which is the prototype agreeing.
    await this.reachable(ctx, id, 'lead:delete');
    const removed = await this.leads.softDeleteById(ctx, id, this.clock.now());
    if (!removed) throw new NotFoundException('Lead');
    await this.record(ctx, 'lead.deleted', id, { type: removed.type });
    return { id, deletedAt: removed.deletedAt!.toISOString() };
  }

  /**
   * **The caller's open leads, in the order they dragged them into** (P18.8-T7, ADR-0161 §1).
   *
   * **Every one of them, once each, and nothing else** — the contract every reorder in this product
   * has (`ActivityService.reorderTypes`, `LeadStatusService.reorder`): a single *move this one to place 4*
   * would leave the server to infer what happened to the rest, and two tabs dragging at once would
   * interleave into an order neither asked for. An id that is not one of the caller's open, live leads —
   * a closed one, a deleted one, a colleague's, a downline's, another office's, or one that never
   * existed — and a lead left out are each `400 VALIDATION_FAILED`, and nothing is written. The answer is
   * the same for all of them, so it confirms nothing about an id that is not the caller's.
   *
   * **The caller's own, whatever their grant reaches.** `lead:update` lets a leader write a downline's
   * lead (ADR-0044); the order of a list is its owner's, and a leader dragging on their own `/leads` is
   * ordering their own leads among their agents'. A coaching session's card has no handles at all.
   *
   * One `bulkWrite` (`LeadRepository.reposition`), and one `lead.reordered` entry carrying how many — no
   * names, as no lead entry carries one.
   */
  async reorder(ctx: RequestContext, ids: readonly string[]): Promise<{ ids: string[] }> {
    const membershipId = this.me(ctx);
    const open = await this.leads.find(
      ctx, { ownerMembershipId: membershipId, outcome: null }, { projection: { _id: 1 } },
    );
    const mine = new Set(open.map((lead) => String(lead._id)));
    const sent = new Set(ids);

    const violations: string[] = [];
    const strangers = ids.filter((id) => !mine.has(id)).length;
    if (strangers > 0) violations.push(`${strangers} of the ids sent ${strangers === 1 ? 'is' : 'are'} not one of your open leads`);
    if (sent.size !== ids.length) violations.push('ids names a lead more than once');
    const missing = [...mine].filter((id) => !sent.has(id)).length;
    if (missing > 0) violations.push(`${missing} of your open leads ${missing === 1 ? 'is' : 'are'} missing from ids`);
    if (violations.length > 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Send every one of your open leads, once each, in the order you want them. Your list may have '
        + 'changed since you opened it: reload it and try again.',
        HttpStatus.BAD_REQUEST,
        { violations },
      );
    }

    await this.leads.reposition(ctx, membershipId, ids);
    await this.record(ctx, 'lead.reordered', membershipId, { count: ids.length });
    return { ids: [...ids] };
  }

  /**
   * **The place a new lead takes: one before the owner's first** (ADR-0161 §1), so it is the top of their
   * list. `0` for an owner with no placed lead yet. A lead nothing has placed holds `null` and sorts
   * before it — there is none once migration 0031 has run.
   */
  private async firstPlace(ctx: RequestContext, ownerMembershipId: string): Promise<number> {
    const [first] = await this.leads.find(
      ctx,
      { ownerMembershipId, position: { $ne: null } },
      { sort: { position: 1 }, limit: 1, projection: { position: 1 } },
    );
    return typeof first?.position === 'number' ? first.position - 1 : 0;
  }

  /**
   * One lead of this office. 404 for another office's, never 403.
   *
   * **A lead the caller does not own is another member's data**, read through the leader's reach, so the
   * read writes the §3.5 entry (roles §3.5, obligation 1): surface `leads`, the lead's owner as the
   * subject, from no date to the office's today — what `GET /leads?owner=` writes for the same rows. Once,
   * after the answer exists; the owner's own read writes none (`SubjectReadAudit`).
   */
  async read(ctx: RequestContext, id: string): Promise<LeadView> {
    // Before the repository, so a caller with no office is refused by name rather than by a
    // `MissingTenantContextError` surfacing as 500 — which is what a Super Admin's `all` grant
    // would otherwise produce here (ADR-0044).
    const lead = await this.reachable(ctx, id, 'lead:read');
    const day = await this.days.for(ctx);
    const view = this.view(lead, day, await this.attribution(ctx, [lead]));
    await this.subjectReads.record(
      ctx, { membershipId: String(lead.ownerMembershipId) }, 'leads', { from: null, to: day.today },
    );
    return view;
  }

  /**
   * The caller's own live leads (P7-T2).
   *
   * **`/leads` sends no search and no filter since P10.1-T4**, because the prototype's table has
   * neither. The parameters stay for coaching's *Leads* card, which has the prototype's own search
   * box and type filter (`Overall.html:4258-4266`, ADR-0063).
   *
   * **Sorting is single-key.** The prototype's own footnote promises *"Sales leads first, then
   * Recruitment"* and its code does no such thing; the code wins and the footnote is not
   * reproduced. *Lead name*, *Type* and *Status* are ordered here, in memory (`lead-order.ts`
   * says why). The other two keys are the database's. **Every order ends on the id**, so a tie
   * cannot fall differently on two requests and repeat or skip a lead across the page boundary.
   *
   * **Scoped to what the caller's grant reaches** (P7-T7): their own, plus their unit or their
   * downline. `ownersInScope` is the one place that decides, and `summary` asks it the same
   * question.
   */
  async list(ctx: RequestContext, query: LeadQuery = {}): Promise<LeadPage> {
    /*
     * **`owner`: one member's leads** (P11-T4 AC-3), the coaching session's Leads card. Resolved by
     * `CoachResolver.subject` on `lead:read` — the caller, or somebody they coach; a 404 outside it,
     * never a 403 — and the list is then that owner's alone, with every other filter beside it.
     */
    const named = query.owner === undefined
      ? null
      : await this.coach.subject(ctx, query.owner, 'lead:read', 'Membership');
    const owners = named ? [named.membershipId] : await this.ownersInScope(ctx, 'lead:read');

    const filter: Record<string, unknown> = { deletedAt: null };
    // `null` is the whole office, which no row-reading grant produces — see `ownersInScope`.
    if (owners !== null) filter.ownerMembershipId = { $in: owners };
    if (query.type) filter.type = query.type === 'unassigned' ? null : query.type;
    if (query.statusCode) filter.statusCode = query.statusCode;
    if (query.outcome) filter.outcome = query.outcome === 'open' ? null : query.outcome;
    if (query.search) {
      /*
       * Over the name and the remarks, which is where an agent looks for somebody. Escaped,
       * because a lead's name is user input and `(` in a regular expression is not a bracket.
       */
      const escaped = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const needle = new RegExp(escaped, 'i');
      filter.$or = [{ name: needle }, { remarks: needle }];
    }

    const inMemory = isInMemorySort(query.sort) ? query.sort : null;
    const dir = query.dir === 'asc' ? 1 : -1;
    const found = await this.leads.find(ctx, filter, inMemory ? {} : {
      /*
       * MongoDB promises no order among equal keys, and `/leads` reads 200 at a time. **No `sort` is the
       * owner's own order** (P18.8-T7 AC-3), `SAVED_ORDER`; a key asked for orders as it always did.
       */
      sort: query.sort ? { [query.sort]: dir, _id: dir } : SAVED_ORDER,
    });
    /*
     * **Over the whole filtered set, before the page is cut**, so page 2 of a status sort carries on
     * where page 1 stopped. `/leads` asks for every page in turn (ADR-0063 §3), and a set ordered
     * page by page would interleave.
     *
     * **The ranks are the published ladders, the ones `/kpm/config` gives the screen**, so the
     * sort follows the order the *Status* dropdown lists and the tint it draws, and an Owner's
     * reorder moves both when it is published. Read only when a rank is needed.
     */
    const ranks = ladderRanks(
      inMemory === 'status' ? (await this.config.readPublished(ctx)).leadPipelines : [],
    );
    const rows = inMemory ? found.sort(leadOrder(inMemory, query.dir, ranks)) : found;

    // Once for the page. `flagsFor` runs for every row here and again for every row rendered,
    // and the office's day does not change between two rows of one response.
    const day = await this.days.for(ctx);
    const attended = query.attention
      ? rows.filter((row) => this.flagsFor(row, day).includes(query.attention!))
      : rows;

    /*
     * **Paged in the service, not in the screen.** The whole set is read to filter on the derived
     * attention flags — which is honest about what this costs today and is the thing P7-T4 and
     * P7-T6 will revisit with an office's real volume in front of them. The page is what the
     * screen renders either way.
     */
    const page = Math.max(1, query.page ?? 1);
    const size = Math.min(Math.max(1, query.pageSize ?? LEAD_PAGE_SIZE), 200);
    const start = (page - 1) * size;
    const shown = attended.slice(start, start + size);
    // Names for this page only: the rows nobody is looking at cost nothing to attribute.
    const names = await this.attribution(ctx, shown);

    const answer = {
      rows: shown.map((row) => this.view(row, day, names)),
      total: attended.length,
      page,
      pageSize: size,
    };

    /*
     * **OD-107, option 1 (decided 2026-10-02): the list is a subject read too.** One §3.5 entry,
     * surface `leads`, for each owner other than the caller whose rows this answer holds — the page
     * shown, not the set filtered — and none for the caller's own rows. Written last, once the answer
     * exists, so a refused read records nothing; `from: null`, because a lead list discloses rows of
     * any age. Without it the same rows were audited through `owner=` and not through the list, and a
     * record one route can step round records nothing reliable.
     */
    if (named) {
      /*
       * **One entry for `owner=`, whatever the page holds** (P11-T4 AC-5): the answer is about that
       * member even when it is empty — *no leads*, and how many match, are disclosures too. None for the
       * caller's own (`SubjectReadAudit`).
       */
      await this.subjectReads.record(ctx, named, 'leads', { from: null, to: day.today });
      return answer;
    }
    const others = [...new Set(shown.map((row) => String(row.ownerMembershipId)))]
      .filter((owner) => owner !== ctx.membershipId);
    await Promise.all(others.map((owner) => this.subjectReads.record(
      ctx, { membershipId: owner }, 'leads', { from: null, to: day.today },
    )));
    return answer;
  }

  /**
   * The rollups, in one indexed pass (P7-T6). No route calls it since P10.1-T4 — see `LeadSummary`.
   *
   * **Scoped exactly as the list is**, from `lead:read_aggregate_counts` rather than from
   * `lead:read` — an Owner and an Admin hold this one and hold no row-reading grant at all, which
   * is §3.7 in the permission matrix rather than in a check somebody has to remember. A count
   * of somebody's leads has to count the leads their list shows, and for everybody who has both
   * grants, it does.
   *
   * **One aggregation with `$facet`, not six round trips.** The `$match` is the same
   * `{kpmId, ownerMembershipId, deletedAt}` prefix the list uses, so it is served by the index
   * that already exists; `performance-and-scale.md` asks for no `COLLSCAN` on a tenant-scoped
   * collection and `lead.performance.spec.ts` asserts it.
   *
   * **The attention counts are evaluated in the database and defined in `flagsFor`.** Two
   * evaluations of one rule is exactly what invariant §8 forbids, so they are pinned together by a
   * test that counts a seeded office both ways and fails if they ever disagree.
   */
  async summary(ctx: RequestContext): Promise<LeadSummary> {
    const owners = await this.ownersInScope(ctx, 'lead:read_aggregate_counts');
    const day = await this.days.for(ctx);

    // The office's own recruitment ladder decides which stages mean *still running* and *nearly
    // there*. Reading the codes rather than hardcoding them is invariant §4.
    const stages = await this.statuses.find(ctx, { pipeline: 'recruitment' });

    // `kpmId` and `deletedAt` are the repository's to add — see `aggregate`.
    const match: Record<string, unknown> = {};
    if (owners !== null) match.ownerMembershipId = { $in: owners };

    const openOnly = { $eq: ['$outcome', null] };
    const countWhen = (when: unknown) => [
      { $match: { $expr: { $and: [openOnly, when] } } },
      { $count: 'n' },
    ];

    const [facets] = await this.leads.aggregate(ctx, [
      { $match: match },
      {
        $facet: {
          open: [{ $match: { outcome: null } }, { $count: 'n' }],
          committedThisMonth: countWhen({ $in: [day.month, { $ifNull: ['$commitments.month', []] }] }),
          // One definition, which the Owner's Overview reads too (Phase 18, D-recruit).
          ...recruitmentPipelineFacets(stages),
          // The three rules `flagsFor` applies, in the order it applies them: a lead with no date
          // is *no next action* and cannot also be *overdue*.
          overdue: countWhen({
            $and: [
              { $ne: [{ $ifNull: ['$nextActionDate', null] }, null] },
              { $lt: ['$nextActionDate', day.today] },
            ],
          }),
          noNextAction: countWhen({ $eq: [{ $ifNull: ['$nextActionDate', null] }, null] }),
          noRemarks: countWhen({ $eq: [{ $ifNull: ['$remarks', null] }, null] }),
        },
      },
    ]);

    const n = (key: string) => (facets?.[key] as { n?: number }[] | undefined)?.[0]?.n ?? 0;
    return {
      open: n('open'),
      committedThisMonth: n('committedThisMonth'),
      recruitmentPipelineNow: n('recruitmentPipelineNow'),
      recruitmentExpectedToClose: n('recruitmentExpectedToClose'),
      attention: {
        overdue: n('overdue'),
        'no-next-action': n('noNextAction'),
        'no-remarks': n('noRemarks'),
      },
    };
  }

  /**
   * What is asking to be picked up. **Derived on read, never stored** — a stored flag is one that
   * is wrong at midnight. The rule is `leadFlags` (`lead-attention.ts`), which the Personal Summary
   * reads too (P10-T6), so two screens cannot disagree about what is overdue.
   */
  private flagsFor(lead: LeadDocument, day: OfficeDay): LeadFlag[] {
    return leadFlags(lead, day.today);
  }

  /**
   * The names behind a page's proxy edits, in one read rather than one per row.
   *
   * Only the rows a leader actually touched cost anything: a lead whose last change was its own
   * owner's contributes no id at all, so an agent working alone resolves nothing.
   */
  private async attribution(
    ctx: RequestContext, rows: readonly LeadDocument[],
  ): Promise<Map<string, string>> {
    const editors = rows
      .filter((r) => r.updatedBy && r.updatedBy !== r.ownerMembershipId)
      .map((r) => r.updatedBy as string);
    return this.names.byMembershipId(ctx, editors);
  }

  /** The stored row with the patch applied: the pair travels together, so one never erases the other. */
  private merge(lead: LeadDocument, input: CheckedLead) {
    return {
      contact: input.contact ?? {
        phone: lead.contact?.phone ?? null,
        email: lead.contact?.email ?? null,
      },
    };
  }

  /**
   * The fields a patch may set directly.
   *
   * `contact` is handled as a pair above, and **`thisMonth` is not here at all**:
   * it is derived from `commitments`, so a patch carrying it adds or removes this month's promise
   * rather than writing a column.
   */
  private writable(input: CheckedLead): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of ['name', 'type', 'remarks', 'nextActionDate', 'nextActionNote', 'source'] as const) {
      if (input[key] !== undefined) out[key] = input[key];
    }
    return out;
  }

  private view(doc: LeadDocument, day: OfficeDay, names: Map<string, string>): LeadView {
    const flags = this.flagsFor(doc, day);
    const editor = doc.updatedBy && doc.updatedBy !== doc.ownerMembershipId ? doc.updatedBy : null;
    return {
      id: String(doc._id),
      ownerMembershipId: doc.ownerMembershipId,
      type: doc.type,
      name: doc.name,
      contact: { phone: doc.contact?.phone ?? null, email: doc.contact?.email ?? null },
      statusCode: doc.statusCode,
      thisMonth: (doc.commitments ?? []).some((c) => c.month === day.month),
      committedMonths: (doc.commitments ?? []).map((c) => c.month),
      remarks: doc.remarks,
      nextActionDate: doc.nextActionDate,
      nextActionNote: doc.nextActionNote,
      outcome: doc.outcome,
      source: doc.source,
      dateRegistered: doc.dateRegistered ? doc.dateRegistered.toISOString() : null,
      version: doc.version,
      flags: flags,
      /*
       * Whole calendar days, in the office's zone — `Clock.daysBetween` rather than a subtraction
       * of epoch milliseconds, which is what the prototype does and is off by one across a DST
       * boundary. Jakarta has none; the next company's offices are not promised to.
       */
      lastEditedBy: editor ? { membershipId: editor, name: names.get(editor) ?? null } : null,
      overdueDays: flags.includes('overdue') && doc.nextActionDate
        ? this.clock.daysBetween(day.timezone, doc.nextActionDate, day.today)
        : null,
    };
  }

  private async record(
    ctx: RequestContext, action: string, targetId: string, after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(ctx, { action, targetCollection: 'leads', targetId, after });
  }
}
