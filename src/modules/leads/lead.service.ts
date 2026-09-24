import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import { AuditService } from '@/modules/audit/audit.service';
import { checkLead, requireLawfulBasis, type CheckedLead } from './lead-input';
import { LeadRepository } from './lead.repository';
import type { LeadDocument, LeadType } from './lead.schema';

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
  thisMonth: boolean;
  remarks: string | null;
  nextActionDate: string | null;
  nextActionNote: string | null;
  outcome: 'won' | 'lost' | null;
  source: string | null;
  dateRegistered: string | null;
  version: number;
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
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** The caller's own membership, or a refusal that says what to do about it. */
  private me(ctx: RequestContext): string {
    const membershipId = ctx.membershipId;
    if (!membershipId) throw new NoMembershipException();
    return membershipId;
  }

  async create(ctx: RequestContext, body: unknown): Promise<LeadView> {
    const membershipId = this.me(ctx);
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
      thisMonth: input.thisMonth ?? false,
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
    return this.view(created);
  }

  async update(ctx: RequestContext, id: string, body: unknown): Promise<LeadView> {
    const membershipId = this.me(ctx);
    const lead = await this.leads.findById(ctx, id);
    if (!lead) throw new NotFoundException('Lead');

    const input = checkLead(body, { partial: true });
    const next = this.merge(lead, input);
    requireLawfulBasis(next);

    const now = this.clock.now();
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

    const updated = await this.leads.updateById(ctx, id, { $set, $inc: { version: 1 } });
    if (!updated) throw new NotFoundException('Lead');

    await this.record(ctx, 'lead.updated', id, {
      fields: Object.keys(this.writable(input)),
      hasContact: Boolean(next.contact.phone || next.contact.email),
      lawfulBasis: next.lawfulBasis,
    });
    return this.view(updated);
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
    const lead = await this.leads.findById(ctx, id);
    if (!lead) throw new NotFoundException('Lead');
    return this.view(lead);
  }

  /** The caller's own live leads, newest first — the read the agent's screen is built on. */
  async listMine(ctx: RequestContext): Promise<LeadView[]> {
    const membershipId = this.me(ctx);
    const rows = await this.leads.find(
      ctx,
      { ownerMembershipId: membershipId, deletedAt: null },
      { sort: { dateRegistered: -1 } },
    );
    return rows.map((row) => this.view(row));
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

  /** The fields a patch may set. `contact` and `lawfulBasis` are handled together, above. */
  private writable(input: CheckedLead): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of ['name', 'type', 'remarks', 'nextActionDate', 'nextActionNote', 'source', 'thisMonth'] as const) {
      if (input[key] !== undefined) out[key] = input[key];
    }
    return out;
  }

  private view(doc: LeadDocument): LeadView {
    return {
      id: String(doc._id),
      ownerMembershipId: doc.ownerMembershipId,
      type: doc.type,
      name: doc.name,
      contact: { phone: doc.contact?.phone ?? null, email: doc.contact?.email ?? null },
      lawfulBasis: doc.lawfulBasis,
      consentAt: doc.consentAt ? doc.consentAt.toISOString() : null,
      statusCode: doc.statusCode,
      thisMonth: doc.thisMonth,
      remarks: doc.remarks,
      nextActionDate: doc.nextActionDate,
      nextActionNote: doc.nextActionNote,
      outcome: doc.outcome,
      source: doc.source,
      dateRegistered: doc.dateRegistered ? doc.dateRegistered.toISOString() : null,
      version: doc.version,
    };
  }

  private async record(
    ctx: RequestContext, action: string, targetId: string, after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(ctx, { action, targetCollection: 'leads', targetId, after });
  }
}
