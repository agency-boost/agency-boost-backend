import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException } from '@/common/errors/domain.exception';
import { isLocalDate, type LocalDate } from '@/common/time/local-day';
import { refuseWith, type FieldSentence } from '@/common/validation/fields';
import { CoachingSessionService } from '@/modules/coaching/coaching-session.service';
import { LeadService } from '@/modules/leads/lead.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import type { ActivationProgressDocument } from './activation-progress.schema';
import {
  ActivationProgressService, recordRequired, type ItemChange, type ItemRecord, type ItemWritePlan,
} from './activation-progress.service';
import type { ActivationClosingsView, ActivationView } from './activation-progress.view';
import { ACTIVATION_REFUSALS } from './activation.messages';

const SAY = ACTIVATION_REFUSALS.VALIDATION_FAILED;

/** The record a hand tick of a data-backed item names, as the request sends it (P18.96-T4 AC-3). */
export interface ItemRecordInput {
  kind: 'closing' | 'one_on_one';
  leadId?: string;
  name?: string;
  date?: string;
  note?: string;
}

/** The tick, its note and date, and the record. */
export type ItemChangeWithRecord = ItemChange & { record?: ItemRecordInput };

/** A note's bound once trimmed: the coaching module's own for a session's text, the activation's for the hire's note. */
const NOTE_MAX = 500;

/**
 * **A hand tick, with its record** (P18.96-T4 AC-3; ADR-0171 §3): what `PUT /activation/me/items/:code` and
 * `PUT /new-hires/:membershipId/items/:code` write. Every item but the three data-backed ones is ticked exactly as
 * before (`ActivationProgressService.setItem`'s checks and write); a data-backed one is ticked **only with its
 * record, and the two are saved together**:
 *
 * 1. **every check first** (`planItemWrite`): the item, its link, the activation open — and then the record's own
 *    fields: its kind the item's form, its day from the hire's join date to the office's today;
 * 2. **the record** — through the module that owns it, so its own rules, reach and audit apply:
 *    - *Which case?* naming an **existing closing**: one of the member's sales leads at *Paid and issued*
 *      (`LeadService.closingsOf`, `lead:read`'s reach);
 *    - *Log a new closing*: `LeadService.logClosing` — a sales lead created at *Paid and issued* on that day, in the
 *      member's pipeline (`lead:create`'s reach);
 *    - *Log 1:1* by a **leader**: `CoachingSessionService.logOneOnOne` — a finalized session with the hire;
 *    - *Log 1:1* by the **hire**: their own date and note on the item — a coachee writes no session about themselves
 *      (ADR-0078), so theirs is a claim the coaching sessions confirm;
 * 3. **the tick**, naming the record (`commitItemWrite`).
 *
 * **If the record fails, the tick is not written.** A refusal at step 1 writes neither; a refusal of the record writes
 * nothing; and the tick is written only after the record is. The one gap is a write racing between steps 2 and 3 — a
 * graduation, landing in that moment — which answers `ACTIVATION_CLOSED` and leaves the record standing as the closing
 * or the 1:1 it is, in its own module.
 */
@Injectable()
export class ActivationItemRecords {
  constructor(
    private readonly activations: ActivationProgressService,
    private readonly leads: LeadService,
    private readonly coaching: CoachingSessionService,
    private readonly days: TenantDay,
  ) {}

  /** `PUT /activation/me/items/:code`: the reader's own item. */
  async tickMine(ctx: RequestContext, code: string, change: ItemChangeWithRecord): Promise<ActivationView> {
    return this.tick(ctx, await this.activations.ownActivation(ctx), code, change, 'hire');
  }

  /** `GET /activation/me/closings`: the reader's own closings. */
  async myClosings(ctx: RequestContext): Promise<ActivationClosingsView> {
    await this.activations.ownActivation(ctx);
    return { closings: (await this.leads.closingsOf(ctx)).map(({ leadId, name, date }) => ({ leadId, name, date })) };
  }

  /** `GET /new-hires/:membershipId/closings`: a hire's closings, for a leader who reads their leads. */
  async closingsOf(ctx: RequestContext, doc: ActivationProgressDocument): Promise<ActivationClosingsView> {
    const closings = await this.leads.closingsOf(ctx, doc.membershipId);
    return { closings: closings.map(({ leadId, name, date }) => ({ leadId, name, date })) };
  }

  /** One hand write, by the hire (`hire`) or by a leader who coaches them (`leader`). */
  async tick(
    ctx: RequestContext, doc: ActivationProgressDocument, code: string, change: ItemChangeWithRecord,
    source: 'hire' | 'leader',
  ): Promise<ActivationView> {
    const { record: input, ...rest } = change;
    const plan = await this.activations.planItemWrite(ctx, doc, code, rest);
    if (!plan.needsRecord) {
      if (input) refuseWith([SAY.recordNotTaken({ label: plan.label })]);
      return this.activations.commitItemWrite(ctx, plan, rest, source, null);
    }
    if (!input) throw recordRequired(code, plan.needsRecord);
    if (input.kind !== plan.needsRecord) refuseWith([SAY.recordKind({ kind: plan.needsRecord, label: plan.label })]);

    const today = (await this.days.for(ctx)).today;
    if (plan.needsRecord === 'closing') {
      const record = await this.closing(ctx, plan, input, source, today);
      return this.activations.commitItemWrite(ctx, plan, rest, source, record);
    }

    const { date, note } = oneOnOneOf(input, plan.startDate, today);
    if (source === 'hire') {
      // ADR-0078: a coachee writes no session about themselves. Their 1:1 is their own date and note on the item.
      return this.activations.commitItemWrite(ctx, plan, { ...rest, note, date }, source, null);
    }
    const logged = await this.coaching.logOneOnOne(ctx, doc.membershipId, { date, note });
    return this.activations.commitItemWrite(ctx, plan, rest, source, { collection: 'coachingSessions', id: logged.sessionId });
  }

  /** *Which case?*: an existing closing of the member's, or a new one logged in their pipeline. */
  private async closing(
    ctx: RequestContext, plan: ItemWritePlan, input: ItemRecordInput, source: 'hire' | 'leader', today: LocalDate,
  ): Promise<ItemRecord> {
    const owner = source === 'hire' ? undefined : plan.doc.membershipId;
    if (input.leadId !== undefined) {
      if (input.name !== undefined || input.date !== undefined) {
        refuseWith([SAY.closingEitherOr]);
      }
      const found = (await this.leads.closingsOf(ctx, owner)).find((c) => c.leadId === input.leadId);
      if (!found) throw new NotFoundException('Lead');
      return { collection: 'leads', id: found.leadId };
    }
    const name = input.name?.trim() ?? '';
    const violations: FieldSentence[] = [];
    if (name.length === 0) violations.push(SAY.closingName);
    const dateProblem = dayProblem(input.date, plan.startDate, today, 'closing');
    if (dateProblem) violations.push(dateProblem);
    if (violations.length > 0) refuseWith(violations);
    const logged = await this.leads.logClosing(ctx, { name, date: input.date! }, owner);
    return { collection: 'leads', id: logged.id };
  }
}

/** *Log 1:1*'s fields, checked: a day from the join date to today, and a note of 1 to 500 characters once trimmed. */
function oneOnOneOf(input: ItemRecordInput, startDate: LocalDate, today: LocalDate): { date: LocalDate; note: string } {
  const violations: FieldSentence[] = [];
  if (input.leadId !== undefined || input.name !== undefined) violations.push(SAY.oneOnOneFields);
  const dateProblem = dayProblem(input.date, startDate, today, 'oneOnOne');
  if (dateProblem) violations.push(dateProblem);
  const note = input.note?.trim() ?? '';
  if (note.length === 0 || note.length > NOTE_MAX) violations.push(SAY.oneOnOneNote({ max: NOTE_MAX }));
  if (violations.length > 0) refuseWith(violations);
  return { date: input.date!, note };
}

/**
 * What is wrong with a record's day, or `null`: a real day, no earlier than the join date and no later than today —
 * named as the closing's day or the 1:1's (`what`).
 */
function dayProblem(
  value: string | undefined, startDate: LocalDate, today: LocalDate, what: 'closing' | 'oneOnOne',
): FieldSentence | null {
  if (value === undefined || !isLocalDate(value)) return SAY.recordDayShape({ what });
  if (value < startDate || value > today) return SAY.recordDayRange({ what, from: startDate, to: today });
  return null;
}
