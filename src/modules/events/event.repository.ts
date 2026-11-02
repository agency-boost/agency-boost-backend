import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type FilterQuery } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { Event, EventDocument, EventType, EventTypeDocument } from './event.schema';
import { EventRsvp, EventRsvpDocument } from './event-rsvp.schema';
import { EventFeedback, EventFeedbackDocument } from './event-feedback.schema';

/** An office's event types. Through the chokepoint, like every other taxonomy (invariant §1). */
@Injectable()
export class EventTypeRepository extends TenantScopedRepository<EventTypeDocument> {
  constructor(@InjectModel(EventType.name) model: Model<EventTypeDocument>) {
    super(model, 'eventTypes');
  }
}

/** An office's events. */
@Injectable()
export class EventRepository extends TenantScopedRepository<EventDocument> {
  constructor(@InjectModel(Event.name) model: Model<EventDocument>) {
    super(model, 'events');
  }
}

/** Members' RSVPs, claims and confirmations (P18.5-T5), one row per (event, membership). */
@Injectable()
export class EventRsvpRepository extends TenantScopedRepository<EventRsvpDocument> {
  constructor(@InjectModel(EventRsvp.name) model: Model<EventRsvpDocument>) {
    super(model, 'eventRsvps');
  }

  /**
   * **A member's write to their row, only where the row is still as the write expects** — the RSVP not yet *going*,
   * the claim not yet made, the RSVP still *going* to cancel. Two taps change the row once: the first changes it, the
   * second finds it changed and **answers `null`, nothing done** — the caller audits only a write that happened.
   *
   * 1. An atomic conditional update of the row that is there (`new: false`, so the row comes back **as it was**).
   * 2. No match, and no `upsert`, or a row that is there in another state: nothing to do.
   * 3. No row at all: create it. Two first writes at once both reach this; the partial unique index on
   *    `(kpmId, eventId, membershipId)` refuses the second (`E11000`), which is the same answer, `null`.
   *
   * Without `upsert` only step 1 writes, so a write that happened always has the row as it was.
   */
  async writeWhen(
    ctx: RequestContext, eventId: string, membershipId: string,
    condition: FilterQuery<EventRsvpDocument>, set: Record<string, unknown>, upsert: false,
  ): Promise<{ id: string; before: EventRsvpDocument } | null>;
  async writeWhen(
    ctx: RequestContext, eventId: string, membershipId: string,
    condition: FilterQuery<EventRsvpDocument>, set: Record<string, unknown>, upsert: boolean,
  ): Promise<{ id: string; before: EventRsvpDocument | null } | null>;
  async writeWhen(
    ctx: RequestContext,
    eventId: string,
    membershipId: string,
    condition: FilterQuery<EventRsvpDocument>,
    set: Record<string, unknown>,
    upsert: boolean,
  ): Promise<{ id: string; before: EventRsvpDocument | null } | null> {
    const filter = this.scope(ctx, 'writeWhen', { eventId, membershipId, ...condition });
    const change = { $set: { ...set, updatedBy: ctx.membershipId } };
    const before = await this.model.findOneAndUpdate(filter, change, { new: false }).exec();
    if (before) return { id: String(before._id), before };
    if (!upsert || await this.exists(ctx, { eventId, membershipId })) return null;
    try {
      const created = await this.model.findOneAndUpdate(
        filter,
        { ...change, $setOnInsert: { kpmId: ctx.kpmId, deletedAt: null, createdBy: ctx.membershipId } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      ).exec();
      return { id: String(created!._id), before: null };
    } catch (err) {
      if ((err as { code?: number } | null)?.code === 11000) return null;
      throw err;
    }
  }

  /**
   * **The roll call's save, in one round trip** (the exit review): an upsert per member, unordered, so one row
   * failing does not stop the others. **Never throws**: it answers which rows were written — the ids it created by
   * position — and the error, so the caller audits exactly what was written before passing the error on.
   */
  async setMany(
    ctx: RequestContext,
    eventId: string,
    rows: readonly { membershipId: string; set: Record<string, unknown> }[],
  ): Promise<{ created: Record<number, string>; failed: number[]; error: unknown }> {
    const ops = rows.map((row) => ({
      updateOne: {
        filter: this.scope(ctx, 'setMany', { eventId, membershipId: row.membershipId }),
        update: {
          $set: { ...row.set, updatedBy: ctx.membershipId },
          $setOnInsert: { createdBy: ctx.membershipId },
        },
        upsert: true,
        setDefaultsOnInsert: true,
      },
    }));
    try {
      const result = await this.model.bulkWrite(ops as never, { ordered: false });
      return { created: idsOf(result.upsertedIds), failed: [], error: null };
    } catch (err) {
      const failure = err as { writeErrors?: { index: number } | { index: number }[]; result?: { upsertedIds?: unknown } };
      const failed = ([] as { index: number }[]).concat(failure.writeErrors ?? []).map((e) => e.index);
      return { created: idsOf(failure.result?.upsertedIds), failed, error: err };
    }
  }
}

/** Members' answers about events (P18.5-T6), one per (event, membership), never edited. */
@Injectable()
export class EventFeedbackRepository extends TenantScopedRepository<EventFeedbackDocument> {
  constructor(@InjectModel(EventFeedback.name) model: Model<EventFeedbackDocument>) {
    super(model, 'eventFeedback');
  }
}

/** `{ index: ObjectId }` as `{ index: string }`; nothing for a result that names none. */
function idsOf(ids: unknown): Record<number, string> {
  return Object.fromEntries(Object.entries((ids ?? {}) as Record<string, unknown>).map(([i, id]) => [Number(i), String(id)]));
}
