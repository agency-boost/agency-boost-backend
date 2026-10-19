import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, isValidObjectId } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { CALENDAR } from '@/domain/constants';
import {
  CalendarAttendee, CalendarEvent, CalendarEventDocument, type CalendarAnswer,
} from './calendar-event.schema';

const DAY_MS = 86_400_000;

/** The fields an edit replaces, as the service has validated them. */
export interface CalendarEntryFields {
  type: CalendarEvent['type'];
  title: string;
  notes: string;
  startsAt: Date;
  endsAt: Date;
  startsOn: string | null;
  endsOn: string | null;
}

/**
 * Every calendar entry, through the chokepoint (invariant §1; P12-T2).
 *
 * **No unscoped method, and none is wanted.** The Owner, the Admin and the Super Admin read no
 * calendar (ADR-0094); a support session reads its member's through that member's office, scoped like
 * anybody else (roles §3.13). P19-T1's erasure cascade will add its own, named.
 */
@Injectable()
export class CalendarEventRepository extends TenantScopedRepository<CalendarEventDocument> {
  constructor(@InjectModel(CalendarEvent.name) model: Model<CalendarEventDocument>) {
    super(model, 'calendarEvents');
  }

  /**
   * **The entries of one filter that overlap a period**, by `startsAt` then `_id`
   * (`functional/calendar.md`, *Time*): `startsAt` before the period's end and `endsAt` after its
   * start, the ends being the office's midnights.
   *
   * The lower bound on `startsAt` is the period's start less the longest an entry lasts
   * (`CALENDAR.TRAVEL_DAYS_MAX`), so both indexes — the organiser's and the attendee's, each
   * `kpmId`-led and ending on `startsAt` — serve the read as a range rather than a scan.
   */
  async overlapping(
    ctx: RequestContext, filter: FilterQuery<CalendarEventDocument>, start: Date, endExclusive: Date,
  ): Promise<CalendarEventDocument[]> {
    const earliest = new Date(start.getTime() - CALENDAR.TRAVEL_DAYS_MAX * DAY_MS);
    return this.find(
      ctx,
      { ...filter, startsAt: { $gte: earliest, $lt: endExclusive }, endsAt: { $gt: start } },
      { sort: { startsAt: 1, _id: 1 } },
    );
  }

  /**
   * **A pinned edit by its organiser** (D-write; P12-T2 AC-8): the fields replaced, the invitation list
   * changed by **targeted** additions and removals, and `version` moved on — in one conditional write,
   * which lands only while the entry is still at the `version` the organiser read.
   *
   * **An edit never rewrites an answer** (`functional/calendar.md`, *The entry's life*). The new list is
   * computed on the server from the list as stored at the moment of the write — every attendee kept as
   * they are, the dropped invitees filtered out, the new ones appended — so an answer given between the
   * organiser's read and their save survives, and so does the member a block was placed on, whom no
   * invitation list names. It is an update pipeline, so every value the organiser typed is wrapped in
   * `$literal`: a title reading `$notes` stays a title.
   *
   * `null` when nothing matched: the entry moved on, was deleted, or is not theirs. The service reads
   * which.
   */
  async editIfAt(
    ctx: RequestContext,
    id: string,
    at: { organiserMembershipId: string; version: number },
    fields: CalendarEntryFields,
    invitees: { removed: readonly string[]; added: readonly CalendarAttendee[] },
    now: Date,
  ): Promise<CalendarEventDocument | null> {
    if (!isValidObjectId(id)) return null;
    const filter = this.scope(ctx, 'editIfAt', {
      _id: id, organiserMembershipId: at.organiserMembershipId, version: at.version,
    } as FilterQuery<CalendarEventDocument>);
    const literal = (value: unknown) => ({ $literal: value });
    const set: Record<string, unknown> = {
      updatedBy: literal(ctx.membershipId),
      updatedAt: literal(now),
      version: { $add: ['$version', 1] },
    };
    for (const [key, value] of Object.entries(fields)) set[key] = literal(value);
    set.attendees = {
      $concatArrays: [
        {
          $filter: {
            input: '$attendees',
            as: 'a',
            cond: {
              $or: [
                '$$a.placed',
                { $not: [{ $in: ['$$a.membershipId', literal([...invitees.removed])] }] },
              ],
            },
          },
        },
        literal(invitees.added.map((a) => ({ ...a }))),
      ],
    };
    return this.model
      .findOneAndUpdate(filter, [{ $set: set }], { new: true, timestamps: false })
      .exec();
  }

  /** **A pinned soft delete by its organiser** (P12-T2 AC-9). `null` when nothing matched, as `editIfAt`. */
  async deleteIfAt(
    ctx: RequestContext,
    id: string,
    at: { organiserMembershipId: string; version: number },
    now: Date,
  ): Promise<CalendarEventDocument | null> {
    if (!isValidObjectId(id)) return null;
    return this.model
      .findOneAndUpdate(
        this.scope(ctx, 'deleteIfAt', {
          _id: id, organiserMembershipId: at.organiserMembershipId, version: at.version,
        } as FilterQuery<CalendarEventDocument>),
        { $set: { deletedAt: now, updatedBy: ctx.membershipId } },
        { new: true },
      )
      .exec();
  }

  /**
   * **An invitee's own answer** (ADR-0097; P12-T4 AC-5): their attendance and nothing else — no
   * `version`, no `updatedBy`, no `updatedAt` — so it never conflicts with an edit. Matched on their
   * membership as an invitee, never as the member a block was placed on.
   */
  async answer(
    ctx: RequestContext, id: string, membershipId: string, answer: CalendarAnswer, at: Date,
  ): Promise<CalendarEventDocument | null> {
    if (!isValidObjectId(id)) return null;
    return this.model
      .findOneAndUpdate(
        this.scope(ctx, 'answer', {
          _id: id, attendees: { $elemMatch: { membershipId, placed: false } },
        } as FilterQuery<CalendarEventDocument>),
        { $set: { 'attendees.$.answer': answer, 'attendees.$.answeredAt': at } },
        { new: true, timestamps: false },
      )
      .exec();
  }

  /**
   * **A member who left is taken off every entry that has not ended** (D-leave): placed or invited,
   * by a targeted pull, which moves no `version` — attendance is not the organiser's content, as an
   * answer is not. The write carries the actor of the removal. Past entries keep them.
   */
  async pullFromFuture(ctx: RequestContext, membershipId: string, now: Date): Promise<number> {
    return this.updateMany(
      ctx,
      { 'attendees.membershipId': membershipId, endsAt: { $gt: now } } as FilterQuery<CalendarEventDocument>,
      { $pull: { attendees: { membershipId } } },
    );
  }
}
