import { Injectable, Logger } from '@nestjs/common';
import { FilterQuery } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { MemberDeparture } from '@/modules/org/member-departure.port';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { CalendarEventRepository } from './calendar-event.repository';
import type { CalendarEventDocument } from './calendar-event.schema';
import { CalendarNotices } from './calendar-notices';
import { officeDateOf } from './calendar-time';

/**
 * **What leaving does to a member's calendar** (D-leave, confirmed 2026-10-03; P12-T4 AC-8;
 * `functional/calendar.md`, *The entry's life*).
 *
 * - **Past entries are untouched**, theirs and those they were on, and keep their name: history stays
 *   with the office (invariant §2).
 * - **The future entries they organised are deleted**, softly, and each attendee who had not declined is
 *   told — the change template's `cancelled` wording, as the organiser's own delete tells them. *Future*
 *   is an entry that has not ended when they leave.
 * - **They leave every future entry's attendee list**, placed or invited, by a targeted pull.
 *
 * Every write carries the actor of the removal, whose context `RemovalService` passes; and nobody is
 * told about their own action. **Each organised entry is settled on its own**, so one that fails is a
 * log line and the rest are still deleted; **the pull runs whatever happened before it**, so a leaver is
 * never left on a future entry because one of their own could not be deleted.
 *
 * **A closed leader edge needs nothing here**: `COACH` is read on the current edges at each request, so
 * compare and *Block time* end the moment an edge closes, and a block already placed stays the leader's.
 */
@Injectable()
export class CalendarLeave extends MemberDeparture {
  private readonly logger = new Logger(CalendarLeave.name);

  constructor(
    private readonly entries: CalendarEventRepository,
    private readonly notices: CalendarNotices,
    private readonly days: TenantDay,
    private readonly clock: Clock,
  ) {
    super();
  }

  async left(ctx: RequestContext, membershipId: string): Promise<void> {
    const now = this.clock.now();
    try {
      const organised = await this.entries.find(ctx, {
        organiserMembershipId: membershipId, endsAt: { $gt: now },
      } as FilterQuery<CalendarEventDocument>);
      const { timezone } = organised.length ? await this.days.office(ctx) : { timezone: '' };
      for (const entry of organised) await this.cancel(ctx, entry, timezone, now);
    } finally {
      // Whatever became of the entries they organised, they leave every future one they were on.
      await this.entries.pullFromFuture(ctx, membershipId, now);
    }
  }

  /**
   * One future entry the leaver organised, deleted and announced — **on its own**: a failure is logged
   * at error level, its attendees are told nothing of a cancellation that did not happen, and the next
   * entry is still settled.
   */
  private async cancel(ctx: RequestContext, entry: CalendarEventDocument, timezone: string, now: Date): Promise<void> {
    const entryId = String(entry._id);
    try {
      await this.entries.softDeleteById(ctx, entryId, now);
      const told = entry.attendees
        .filter((a) => a.answer !== 'declined' && a.membershipId !== ctx.membershipId)
        .map((a) => a.membershipId);
      await this.notices.changed(ctx, entryId, officeDateOf(entry, timezone), 'cancelled', told);
    } catch (err) {
      this.logger.error(
        { err, entryId, organiserMembershipId: entry.organiserMembershipId },
        'failed to cancel a departing member’s future calendar entry',
      );
    }
  }
}
