import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, NoMembershipException, NotFoundException, VersionConflictException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { scopeFor, type Permission } from '@/modules/rbac/permissions';
import { LeadStatusRepository } from '@/modules/config/activity.repository';
import { TenantConfigService } from '@/modules/config/tenant-config.service';
import { TenantDay, type OfficeDay } from '@/modules/tenants/tenant-day.service';
import { leadFlags, type LeadFlag } from './lead-attention';
import { checkLead, requireLawfulBasis, type CheckedLead } from './lead-input';
import { isInMemorySort, ladderRanks, leadOrder, type LeadSortKey } from './lead-order';
import { LeadRepository } from './lead.repository';
import type { LeadDocument, LeadType } from './lead.schema';

/** What an agent may be told is asking for them. Derived, never stored. */
export type { LeadFlag } from './lead-attention';

/** How many rows a page of the Leads screen holds. Stated here, not chosen in a component. */
export const LEAD_PAGE_SIZE = 50;

/** The screen's search, filter and sort, as the service reads them. */
export interface LeadQuery {
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
  contact: { phone: string | null; email: string | null };
  lawfulBasis: string | null;
  consentAt: string | null;
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
 * **Writes take no subject.** A lead is created for the person creating it, exactly as an activity
 * day is logged for the person logging it (§3.5's shape, applied to a different record). A leader
 * may write a **downline's** lead — ADR-0044, built in P7-T7 — but only by naming the lead, never
 * by naming a subject on a *create*. A check can be forgotten; a parameter that does not exist
 * cannot be passed.
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
    private readonly memberships: MembershipRepository,
    private readonly names: MemberNames,
    private readonly config: TenantConfigService,
  ) {}

  /**
   * Whose leads this caller may touch, for the permission the **route** declares (P7-T7).
   *
   * **Their own, always — plus whoever the grant reaches.** A lead belongs to a membership, so a
   * leader reaches a lead exactly when they reach its owner. The grant is read from the matrix
   * rather than from the caller's rung, because those two have already drifted once: `summary` was
   * gated on one permission and resolved another, and the narrower of the pair would have gone on
   * enforcing the wider one's scope (found at the Phase 6 exit review).
   *
   * `null` means *the whole office* and is reachable only by `lead:read_aggregate_counts`. No
   * row-reading permission grants `own-kpm` to anybody: the Owner and the Admin get counts, never
   * rows, because these are third-party personal data typed by an agent about somebody who never
   * interacted with the platform, and minimisation applies inside the tenant too (§3.7).
   */
  private async ownersInScope(
    ctx: RequestContext, permission: Permission,
  ): Promise<string[] | null> {
    const me = this.me(ctx);
    const scope = scopeFor(ctx, permission);
    if (scope === 'own-kpm' || scope === 'all') return null;
    /*
     * **No grant reaches nobody's leads**, rather than falling through to the caller's own.
     *
     * The guard has already refused anybody holding none of these, so this is the second lock on
     * the same door — but the first version returned `[me]` here, which quietly *granted* on the
     * strength of an absent permission. Fail-closed costs one line and cannot be wrong.
     */
    if (scope === null) return [];
    if (scope !== 'own-unit' && scope !== 'own-downline') return [me];

    // Indexed both ways: `{kpmId, leaderId, status}` and `{kpmId, ancestorIds, status}`.
    const reports = await this.memberships.find(
      ctx,
      scope === 'own-unit' ? { leaderId: me } : { ancestorIds: me },
      { select: '_id' },
    );
    return [me, ...reports.map((r) => String(r._id))];
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
    ctx: RequestContext, id: string, permission: Permission, pinned?: number,
  ): Promise<LeadDocument> {
    const lead = await this.leads.findById(ctx, id);
    if (!lead) throw new NotFoundException('Lead');
    const owners = await this.ownersInScope(ctx, permission);
    if (owners !== null && !owners.includes(lead.ownerMembershipId)) {
      throw new NotFoundException('Lead');
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
     * Optional, and honoured whenever it is sent. The screen always sends it; a second writer
     * that forgets is unprotected, which is an argument for making it required once there is a
     * second writer — the coaching session, in Phase 13.
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

  async create(ctx: RequestContext, body: unknown): Promise<LeadView> {
    const membershipId = this.me(ctx);
    const day = await this.days.for(ctx);
    const input = checkLead(body);
    const contact = input.contact ?? { phone: null, email: null };

    // Against the lead as it will be, not as it arrived — see `requireLawfulBasis`.
    requireLawfulBasis({ contact, lawfulBasis: input.lawfulBasis ?? null });

    const now = this.clock.now();
    const created = await this.leads.create(ctx, {
      ownerMembershipId: membershipId,
      name: input.name!,
      type: input.type ?? null,
      contact,
      lawfulBasis: input.lawfulBasis ?? null,
      // Stamped when a basis is first recorded, not when the lead is: the date that matters is
      // when the ground was established.
      consentAt: input.lawfulBasis ? now : null,
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
      lawfulBasis: created.lawfulBasis,
    });
    return this.view(created, day, new Map());
  }

  async update(ctx: RequestContext, id: string, body: unknown): Promise<LeadView> {
    const membershipId = this.me(ctx);
    const input = checkLead(body, { partial: true });
    const lead = await this.reachable(ctx, id, 'lead:update', input.version);
    const next = this.merge(lead, input);
    requireLawfulBasis(next);

    const now = this.clock.now();
    const day = await this.days.for(ctx);
    const $set: Record<string, unknown> = {
      ...this.writable(input),
      contact: next.contact,
      lawfulBasis: next.lawfulBasis,
      updatedBy: membershipId,
    };
    // Stamped the first time a basis is recorded, and left alone afterwards: it says when the
    // ground was established, not when the row was last touched.
    if (next.lawfulBasis && !lead.lawfulBasis) $set.consentAt = now;
    if (!next.lawfulBasis) $set.consentAt = null;

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

    const updated = await this.leads.updateById(ctx, id, write);
    if (!updated) throw new NotFoundException('Lead');

    await this.record(ctx, 'lead.updated', id, {
      fields: Object.keys(this.writable(input)),
      hasContact: Boolean(next.contact.phone || next.contact.email),
      lawfulBasis: next.lawfulBasis,
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
    const lead = await this.reachable(ctx, id, 'lead:update', pinned);

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

    const status = await this.statuses.findOne(ctx, { code: wanted });
    if (!status) throw new NotFoundException('Lead status', { code: wanted });
    if (status.pipeline !== lead.type) {
      throw new DomainException(
        ErrorCode.LEAD_STATUS_WRONG_PIPELINE,
        `${wanted} belongs to the ${status.pipeline} ladder; this is a ${lead.type} lead.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { code: wanted, pipeline: status.pipeline, leadType: lead.type },
      );
    }
    if (status.status === 'archived') {
      // Invariant §3: archived configuration stays readable so history renders, not writable.
      throw new DomainException(
        ErrorCode.CONFIG_ARCHIVED,
        `${wanted} has been retired. Leads already on it keep it; new ones cannot be moved to it.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { code: wanted },
      );
    }

    const at = this.clock.now();
    const updated = await this.leads.updateById(ctx, id, {
      $set: { statusCode: wanted, statusId: String(status._id), updatedBy: membershipId },
      // Append-only. The lead's current status is the last row's destination, and this is what
      // makes a jump legible and a leader's edit attributable (ADR-0044, ADR-0045).
      $push: {
        transitions: {
          fromStatusCode: lead.statusCode ?? null, toStatusCode: wanted, at, byMembershipId: membershipId,
        },
      },
      $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Lead');

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
    const lead = await this.reachable(ctx, id, 'lead:mark_outcome', pinned);

    if (outcome && lead.outcome) {
      throw new DomainException(
        ErrorCode.LEAD_ALREADY_CLOSED,
        `This lead is already ${lead.outcome}. Reopen it before closing it again.`,
        HttpStatus.CONFLICT,
        { outcome: lead.outcome },
      );
    }

    if (outcome === 'won') {
      const status = lead.statusCode
        ? await this.statuses.findOne(ctx, { code: lead.statusCode })
        : null;
      if (!status?.isTerminal) {
        throw new DomainException(
          ErrorCode.LEAD_STATUS_NOT_FINAL,
          'A lead is won at the stage that closes its pipeline. Move it there first.',
          HttpStatus.UNPROCESSABLE_ENTITY,
          { statusCode: lead.statusCode ?? null },
        );
      }
    }

    const updated = await this.leads.updateById(ctx, id, {
      $set: {
        outcome,
        outcomeAt: outcome ? this.clock.now() : null,
        updatedBy: membershipId,
      },
      $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Lead');

    await this.record(ctx, outcome ? 'lead.closed' : 'lead.reopened', id, {
      outcome, from: lead.outcome ?? null, statusCode: lead.statusCode ?? null,
    });
    return this.view(updated, await this.days.for(ctx), await this.attribution(ctx, [updated]));
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

  /** One lead of this office. 404 for another office's, never 403. */
  async read(ctx: RequestContext, id: string): Promise<LeadView> {
    // Before the repository, so a caller with no office is refused by name rather than by a
    // `MissingTenantContextError` surfacing as 500 — which is what a Super Admin's `all` grant
    // would otherwise produce here (ADR-0044).
    const lead = await this.reachable(ctx, id, 'lead:read');
    return this.view(lead, await this.days.for(ctx), await this.attribution(ctx, [lead]));
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
    const owners = await this.ownersInScope(ctx, 'lead:read');

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
      // MongoDB promises no order among equal keys, and `/leads` reads 200 at a time.
      sort: { [query.sort ?? 'dateRegistered']: dir, _id: dir },
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

    return {
      rows: shown.map((row) => this.view(row, day, names)),
      total: attended.length,
      page,
      pageSize: size,
    };
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
    const terminal = stages.filter((s) => s.isTerminal).map((s) => s.code);
    const late = stages.filter((s) => s.isLateStage).map((s) => s.code);

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
          recruitmentPipelineNow: countWhen({
            $and: [
              { $eq: ['$type', 'recruitment'] },
              { $not: [{ $in: [{ $ifNull: ['$statusCode', ''] }, terminal] }] },
            ],
          }),
          recruitmentExpectedToClose: countWhen({
            $and: [
              { $eq: ['$type', 'recruitment'] },
              { $in: [{ $ifNull: ['$statusCode', ''] }, late] },
            ],
          }),
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

  /** The stored row with the patch applied, for a rule that has to see both. */
  private merge(lead: LeadDocument, input: CheckedLead) {
    return {
      contact: input.contact ?? {
        phone: lead.contact?.phone ?? null,
        email: lead.contact?.email ?? null,
      },
      lawfulBasis: input.lawfulBasis !== undefined ? input.lawfulBasis : (lead.lawfulBasis ?? null),
    };
  }

  /**
   * The fields a patch may set directly.
   *
   * `contact` and `lawfulBasis` are handled together above, and **`thisMonth` is not here at all**:
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
      lawfulBasis: doc.lawfulBasis,
      consentAt: doc.consentAt ? doc.consentAt.toISOString() : null,
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
