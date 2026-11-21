import { HttpStatus, Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, VersionConflictException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { localDayOf } from '@/common/time/local-day';
import { refuseWith } from '@/common/validation/fields';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { carriedItems, startingAgenda } from './leader-meeting-agenda';
import { LEADER_MEETINGS_REFUSALS } from './leader-meetings.messages';
import { LeaderMeetingPeople, meetingNotFound, type ForumOffice } from './leader-meeting-people';
import { LeaderMeetingRepository } from './leader-meeting.repository';
import type { LeaderMeetingDocument } from './leader-meeting.schema';
import {
  actionItemsInOrder, agendaItemOf, cardOf, FORUM_LIMITS, meetingState, newestFirst, nextForumOf,
  type MeetingCard, type MeetingListView, type MeetingView,
} from './leader-meeting.view';

/** The audit trail's name for the collection (`targetCollection`). */
export const MEETINGS = 'leaderMeetings';

/** A new item's id: its own, never its position — two leaders adding at once never collide. */
export const newItemId = (): string => new Types.ObjectId().toHexString();

/** E11000: the number index refused a second forum given the same number at once. */
const isDuplicateKey = (err: unknown) => (err as { code?: number }).code === 11000;

/** How many times a new forum is numbered again when another took its number a moment before. */
const NUMBER_ATTEMPTS = 3;

/**
 * **The office's forums: the list, a forum, and making, moving and removing one** (P19.22-T8; ADR-0276, amending
 * ADR-0129 and ADR-0130; `functional/leader-forum.md`). The agenda's and the action items' writes are
 * `LeaderMeetingMinutes`'; the links, `LeaderMeetingSharing`'s, which serves a forum opened by a link through `view`.
 *
 * **No scorecard any more** (ADR-0276): a forum's *MAPA driver* and *Informal group* tabs are Advanced analytics' own,
 * read from its endpoints, so nothing here computes, freezes or serves a figure. Nothing here notifies anybody, and
 * nothing writes a §3.5 entry: the agenda and the action items are the leaders' own words.
 */
@Injectable()
export class LeaderMeetingsService {
  constructor(
    private readonly meetings: LeaderMeetingRepository,
    private readonly people: LeaderMeetingPeople,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** `GET /leader-meetings`: every forum of the office, newest first, and *Forum berikutnya* (AC-1). */
  async list(ctx: RequestContext): Promise<MeetingListView> {
    await this.people.editor(ctx);
    const office = await this.people.office(ctx);
    const today = this.today(office);
    const cards = newestFirst((await this.meetings.list(ctx)).map((m) => cardOf(m, today)));
    const editors = await this.people.liveEditors(ctx, office);
    const { coreLeaders } = await this.people.people(ctx, office, editors);
    return {
      today,
      meetings: cards,
      nextId: nextForumOf(cards)?.id ?? null,
      coreLeaders,
      can: { create: can(ctx, 'leader_meeting:create') },
      limits: { ...FORUM_LIMITS },
    };
  }

  /** `GET /leader-meetings/:meetingId`: a forum by its address. */
  async read(ctx: RequestContext, meetingId: string): Promise<MeetingView> {
    await this.people.editor(ctx);
    const office = await this.people.office(ctx);
    const meeting = await this.meetings.findById(ctx, meetingId);
    if (!meeting) throw meetingNotFound();
    return this.view(ctx, office, meeting, 'address');
  }

  /**
   * **`POST /leader-meetings`** — *+ Forum baru* (AC-1; ADR-0130 §2, ADR-0276): numbered one past the office's highest
   * not deleted, at its date and time; **its agenda the previous forum's, unticked** — or the first agenda in an office
   * with none — and **the previous forum's action items not *Selesai*, carried** (*dari forum #n*). Two made at once
   * cannot share a number: the second is refused by the index and numbered again.
   */
  async create(ctx: RequestContext, input: { date: string; time: string }): Promise<MeetingCard> {
    await this.people.editor(ctx);
    let created: LeaderMeetingDocument | null = null;
    let carried = 0;
    for (let attempt = 1; created === null; attempt += 1) {
      const number = (await this.meetings.highestNumber(ctx)) + 1;
      const previous = await this.meetings.before(ctx, number);
      const actionItems = carriedItems(previous, newItemId);
      try {
        created = await this.meetings.create(ctx, {
          number, title: '', date: input.date, time: input.time,
          // The first agenda in the maker's language, stored as text (ADR-0179 §7); a copied one as stored.
          agendaItems: startingAgenda(previous ? previous.agendaItems ?? [] : null, newItemId, ctx.reader),
          actionItems, writtenAt: null, version: 1,
        } as never);
        carried = actionItems.length;
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        if (attempt >= NUMBER_ATTEMPTS) {
          throw new DomainException(
            ErrorCode.VERSION_CONFLICT,
            LEADER_MEETINGS_REFUSALS.VERSION_CONFLICT.madeAtSameMoment,
            HttpStatus.CONFLICT,
            { number },
          );
        }
      }
    }
    await this.audit.record(ctx, {
      action: 'leader_meeting.created', targetCollection: MEETINGS, targetId: String(created._id),
      before: null, after: { number: created.number, date: created.date, time: created.time, carriedActionItems: carried },
    });
    return cardOf(created, this.today(await this.people.office(ctx)));
  }

  /**
   * **`PATCH /leader-meetings/:meetingId`** (ADR-0130 §4): the date, the time or both, **while the forum is upcoming**
   * — whether or not anybody has written in it. Once *Selesai* its date stays: `409 LEADER_MEETING_COMPLETED`.
   */
  async reschedule(
    ctx: RequestContext, meetingId: string, input: { date?: string; time?: string; version: number },
  ): Promise<MeetingCard> {
    await this.people.editor(ctx);
    const office = await this.people.office(ctx);
    const meeting = await this.meetings.findById(ctx, meetingId);
    if (!meeting) throw meetingNotFound();
    if (input.date === undefined && input.time === undefined) {
      refuseWith([LEADER_MEETINGS_REFUSALS.VALIDATION_FAILED.dateOrTime]);
    }
    if (meetingState(meeting.date, this.today(office)) === 'completed') {
      throw new DomainException(
        ErrorCode.LEADER_MEETING_COMPLETED,
        LEADER_MEETINGS_REFUSALS.LEADER_MEETING_COMPLETED.dateStays,
        HttpStatus.CONFLICT,
        { date: meeting.date },
      );
    }
    const set = {
      ...(input.date !== undefined ? { date: input.date } : {}),
      ...(input.time !== undefined ? { time: input.time } : {}),
    };
    const moved = await this.meetings.updateHead(ctx, meetingId, input.version, set);
    if (!moved) throw await this.headConflict(ctx, meetingId, input.version);
    await this.audit.record(ctx, {
      action: 'leader_meeting.rescheduled', targetCollection: MEETINGS, targetId: meetingId,
      before: { date: meeting.date, time: meeting.time ?? null }, after: { date: moved.date, time: moved.time ?? null },
    });
    return cardOf(moved, this.today(office));
  }

  /**
   * **`DELETE /leader-meetings/:meetingId?version=`** (ADR-0130 §5): only a forum nobody has written in — one with
   * writing in it is never removed, `409 LEADER_MEETING_HAS_MINUTES`. Removing writes `deletedAt`: its address
   * answers *not found* and its number may be given again. The copies it was carried are not written in it.
   */
  async remove(ctx: RequestContext, meetingId: string, version: number): Promise<void> {
    await this.people.editor(ctx);
    const meeting = await this.meetings.findById(ctx, meetingId);
    if (!meeting) throw meetingNotFound();
    const at = this.clock.now();
    const removed = meeting.writtenAt ? null : await this.meetings.deleteUnwritten(ctx, meetingId, version, at);
    if (!removed) {
      const now = await this.meetings.findById(ctx, meetingId);
      if (!now) throw meetingNotFound();
      if (now.writtenAt) {
        throw new DomainException(
          ErrorCode.LEADER_MEETING_HAS_MINUTES,
          LEADER_MEETINGS_REFUSALS.LEADER_MEETING_HAS_MINUTES.writtenIn,
          HttpStatus.CONFLICT,
        );
      }
      throw new VersionConflictException(version, now.version);
    }
    await this.audit.record(ctx, {
      action: 'leader_meeting.deleted', targetCollection: MEETINGS, targetId: meetingId,
      before: { number: meeting.number, date: meeting.date, time: meeting.time ?? null },
      after: { deletedAt: at.toISOString() },
    });
  }

  /**
   * **A forum as its reader reads it** — by its address, or by a link (`LeaderMeetingSharing.open`): the head, the
   * office's core leaders, the people it names, the agenda, the action items in their order, and what this reader may
   * do. **By a link every `can` is false but `print`**: a link reads, whoever holds it.
   */
  async view(
    ctx: RequestContext, office: ForumOffice, meeting: LeaderMeetingDocument, via: 'address' | 'link',
  ): Promise<MeetingView> {
    const today = this.today(office);
    const state = meetingState(meeting.date, today);
    const editors = await this.people.liveEditors(ctx, office);
    const named = [
      ...(meeting.agendaItems ?? []).map((i) => i.picMembershipId),
      ...(meeting.actionItems ?? []).map((i) => i.picMembershipId),
    ].filter((id): id is string => typeof id === 'string');
    const { people, coreLeaders } = await this.people.people(ctx, office, editors, named);
    const byAddress = via === 'address';
    const writtenIn = meeting.writtenAt !== null && meeting.writtenAt !== undefined;
    return {
      ...cardOf(meeting, today),
      version: meeting.version,
      coreLeaders,
      people,
      agenda: (meeting.agendaItems ?? []).map(agendaItemOf),
      actionItems: actionItemsInOrder(meeting.actionItems ?? []),
      writtenIn,
      via,
      can: {
        edit: byAddress && can(ctx, 'leader_meeting:edit'),
        share: byAddress && can(ctx, 'leader_meeting:share_link'),
        reschedule: byAddress && can(ctx, 'leader_meeting:reschedule') && state === 'upcoming',
        delete: byAddress && can(ctx, 'leader_meeting:delete') && !writtenIn,
        // `export_pdf` inherits both reads (roles §3.14): whoever reads the forum may print it.
        print: true,
      },
      limits: { ...FORUM_LIMITS },
    };
  }

  /** Why a head write did not land: the forum gone (404), or moved on since it was read (409). */
  private async headConflict(ctx: RequestContext, meetingId: string, version: number): Promise<Error> {
    const now = await this.meetings.findById(ctx, meetingId);
    return now ? new VersionConflictException(version, now.version) : meetingNotFound();
  }

  /** The office's today: the boundary *Akan datang* and *Selesai* turn on (invariant §9). */
  private today(office: ForumOffice): string {
    return localDayOf(this.clock.now(), office.timezone);
  }
}
