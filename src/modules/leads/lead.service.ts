import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, NoMembershipException, NotFoundException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { LeadStatusRepository } from '@/modules/config/activity.repository';
import { TenantDay, type OfficeDay } from '@/modules/tenants/tenant-day.service';
import { checkLead, requireLawfulBasis, type CheckedLead } from './lead-input';
import { LeadRepository } from './lead.repository';
import type { LeadDocument, LeadType } from './lead.schema';

/** What an agent may be told is asking for them. Derived, never stored. */
export type LeadFlag = 'overdue' | 'no-next-action' | 'no-remarks';

/** How many rows a page of the Leads screen holds. Stated here, not chosen in a component. */
export const LEAD_PAGE_SIZE = 50;

/** The screen's search, filter and sort, as the service reads them. */
export interface LeadQuery {
  search?: string;
  type?: 'sales' | 'recruitment' | 'unassigned';
  statusCode?: string;
  outcome?: 'won' | 'lost' | 'open';
  attention?: LeadFlag;
  sort?: 'dateRegistered' | 'name' | 'nextActionDate';
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
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
 * may later write a **downline's** lead — ADR-0044 — but that is P7-T7, and it arrives as a route
 * that names whose lead it is rather than as a parameter smuggled into this one. A check can be
 * forgotten; a parameter that does not exist cannot be passed.
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
  ) {}

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
    return this.view(created, day);
  }

  async update(ctx: RequestContext, id: string, body: unknown): Promise<LeadView> {
    const membershipId = this.me(ctx);
    const lead = await this.leads.findById(ctx, id);
    if (!lead) throw new NotFoundException('Lead');

    const input = checkLead(body, { partial: true });
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
    return this.view(updated, day);
  }

  /**
   * Move a lead to a stage (P7-T3).
   *
   * **Any active stage of its own pipeline, at any time** (ADR-0045). What refuses is about the
   * lead's identity and its outcome, never its path — `rank` is presentation and reorderable, so a
   * forward-only rule would let a drag on the Owner's settings screen change which moves their
   * agents may make.
   */
  async setStatus(ctx: RequestContext, id: string, statusCode: string): Promise<LeadView> {
    const membershipId = this.me(ctx);
    const lead = await this.leads.findById(ctx, id);
    if (!lead) throw new NotFoundException('Lead');

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
    if (wanted === lead.statusCode) return this.view(lead, await this.days.for(ctx));

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
    return this.view(updated, await this.days.for(ctx));
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
    ctx: RequestContext, id: string, outcome: 'won' | 'lost' | null,
  ): Promise<LeadView> {
    const membershipId = this.me(ctx);
    const lead = await this.leads.findById(ctx, id);
    if (!lead) throw new NotFoundException('Lead');

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
    return this.view(updated, await this.days.for(ctx));
  }

  /**
   * Soft, and the owner's alone (§3.7).
   *
   * Nothing is removed. Erasure under PDP is a deliberate, audited, cascading operation and not
   * this button (invariant §6).
   */
  async remove(ctx: RequestContext, id: string): Promise<{ id: string; deletedAt: string }> {
    this.me(ctx);
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
    this.me(ctx);
    const lead = await this.leads.findById(ctx, id);
    if (!lead) throw new NotFoundException('Lead');
    return this.view(lead, await this.days.for(ctx));
  }

  /**
   * The caller's own live leads (P7-T2).
   *
   * **Search and filter exist because the prototype's busiest screen has neither.** It renders
   * every row, unpaged and unsearchable, and an agent with two hundred leads scrolls. Registered
   * as a Fill.
   *
   * **Sorting is single-key.** The prototype's own footnote promises *"Sales leads first, then
   * Recruitment"* and its code does no such thing; the code wins and the footnote is not
   * reproduced.
   *
   * `own` for now: resolving a downline is P7-T7's, and until then a leader sees their own leads
   * rather than a wider set the service cannot yet scope correctly.
   */
  async list(ctx: RequestContext, query: LeadQuery = {}): Promise<LeadPage> {
    const membershipId = this.me(ctx);

    const filter: Record<string, unknown> = {
      ownerMembershipId: membershipId,
      deletedAt: null,
    };
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

    const rows = await this.leads.find(ctx, filter, {
      sort: { [query.sort ?? 'dateRegistered']: query.dir === 'asc' ? 1 : -1 },
    });

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

    return {
      rows: attended.slice(start, start + size).map((row) => this.view(row, day)),
      total: attended.length,
      page,
      pageSize: size,
    };
  }

  /**
   * What is asking to be picked up. **Derived on read, never stored** — a stored flag is one that
   * is wrong at midnight.
   *
   * `thisMonth` does **not** suppress them, which is where the prototype and this part company:
   * it shows only the green *Closes this month* chip on a lead that is also two weeks overdue,
   * hiding exactly the leads most needing attention (P7-T4 AC-2).
   */
  private flagsFor(lead: LeadDocument, day: OfficeDay): LeadFlag[] {
    if (lead.outcome) return [];
    const flags: LeadFlag[] = [];
    /*
     * **Two flags, not one** (AC-4). Forgetting to set a date and missing one are different
     * failures with different answers: the first wants a decision, the second wants a call. The
     * `else` is precedence rather than suppression — a lead with no date cannot also be late for
     * one — and it is the prototype's own order (`leads-management.md` §4).
     */
    if (!lead.nextActionDate) flags.push('no-next-action');
    // `YYYY-MM-DD` sorts lexicographically in calendar order, which is the reason the field is
    // stored in this shape. `today` is the **office's** day (invariant §9, AC-3).
    else if (lead.nextActionDate < day.today) flags.push('overdue');
    if (!lead.remarks) flags.push('no-remarks');
    return flags;
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

  private view(doc: LeadDocument, day: OfficeDay): LeadView {
    const flags = this.flagsFor(doc, day);
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
