import { Injectable, Logger } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import type { LocalDate } from '@/common/time/local-day';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate, type NotificationTemplateId } from '@/modules/notifications/notification.types';
import { MembershipRepository } from '@/modules/org/membership.repository';

/** A change to a future entry: its date or time moved, or it is gone (ADR-0095). */
export type CalendarChange = 'moved' | 'cancelled';

/**
 * **The calendar's three notices** (ADR-0095; P12-T4 AC-7, P12-T5 AC-7; `functional/calendar.md`,
 * *Notifications*).
 *
 * - **Who** is the caller's to decide — never the actor, never an invitee who declined, never an
 *   invitation or a change for a past entry, though a block always tells its member (exit criterion 3) —
 *   and this sends to exactly the members it is handed, each the active member of the office it is
 *   addressed by.
 * - **The payload is ids and the entry's office date, and nothing anybody typed**: no title, no notes, no
 *   name. A title can name a client (ADR-0093), and a notice outlives its entry.
 * - **An invitation and a block are one row per write** (`send`). **A change coalesces**: one row per
 *   entry, member and kind of change (`coalesceKey` `calendar:{entryId}:{membershipId}:{change}`). The
 *   first change writes the row and holds its email, which `releaseHeld` then sends once; each later move
 *   refreshes the row and marks it unread, and finds nothing held to send. A cancellation has its own key,
 *   so it is always a row and an email of its own.
 * - **A send never fails the write** that caused it: each is caught and logged at error level. The held
 *   email is released without being awaited, as coaching's is, so a slow mail server never holds the
 *   organiser's save.
 */
@Injectable()
export class CalendarNotices {
  private readonly logger = new Logger(CalendarNotices.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly memberships: MembershipRepository,
  ) {}

  /** `CALENDAR_INVITATION`, to each member newly invited. */
  async invited(ctx: RequestContext, entryId: string, date: LocalDate, to: readonly string[]): Promise<void> {
    await this.each(ctx, to, (person) => this.notifications.send({
      ...person, kpmId: ctx.kpmId, templateId: NotificationTemplate.CALENDAR_INVITATION, payload: { entryId, date },
    }), NotificationTemplate.CALENDAR_INVITATION, entryId);
  }

  /** `CALENDAR_BLOCK_PLACED`, to the member a block was placed on, once. Nothing to the leader. */
  async placed(ctx: RequestContext, entryId: string, date: LocalDate, memberId: string): Promise<void> {
    await this.each(ctx, [memberId], (person) => this.notifications.send({
      ...person, kpmId: ctx.kpmId, templateId: NotificationTemplate.CALENDAR_BLOCK_PLACED, payload: { entryId, date },
    }), NotificationTemplate.CALENDAR_BLOCK_PLACED, entryId);
  }

  /** `CALENDAR_ENTRY_CHANGED`, `moved` or `cancelled`, to each attendee the caller names. */
  async changed(
    ctx: RequestContext, entryId: string, date: LocalDate, change: CalendarChange, to: readonly string[],
  ): Promise<void> {
    const templateId = NotificationTemplate.CALENDAR_ENTRY_CHANGED;
    await this.each(ctx, to, async (person) => {
      const coalesceKey = `calendar:${entryId}:${person.membershipId}:${change}`;
      await this.notifications.sendCoalesced({
        ...person, kpmId: ctx.kpmId as string, coalesceKey, templateId, payload: { entryId, date, change },
      });
      this.release(ctx.kpmId as string, coalesceKey, entryId);
    }, templateId, entryId);
  }

  /**
   * Resolve each member's account, then send to each — every send on its own, so one failing reaches
   * nobody else's. A member who is not an active member of the office any more is sent nothing.
   */
  private async each(
    ctx: RequestContext,
    to: readonly string[],
    send: (person: { userId: string; membershipId: string }) => Promise<void>,
    templateId: NotificationTemplateId,
    entryId: string,
  ): Promise<void> {
    if (to.length === 0) return;
    try {
      const ids = [...new Set(to)].filter((id) => isValidObjectId(id));
      const members = await this.memberships.find(ctx, { _id: { $in: ids }, status: 'active' });
      await Promise.all(members.map(async (member) => {
        try {
          await send({ userId: String(member.userId), membershipId: String(member._id) });
        } catch (err) {
          this.logger.error({ err, templateId, entryId }, 'failed to send a calendar notice');
        }
      }));
    } catch (err) {
      this.logger.error({ err, templateId, entryId }, 'failed to address calendar notices');
    }
  }

  /** The held email, released and never awaited; a failure is a log line, never the request's. */
  private release(kpmId: string, coalesceKey: string, entryId: string): void {
    const failed = (err: unknown) =>
      this.logger.error({ err, coalesceKey, entryId }, 'failed to send a calendar notice’s email');
    try {
      void Promise.resolve(this.notifications.releaseHeld(kpmId, coalesceKey, NotificationTemplate.CALENDAR_ENTRY_CHANGED))
        .catch(failed);
    } catch (err) {
      failed(err);
    }
  }
}
