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
import { startingAgenda } from './leader-meeting-agenda';
import { LeaderMeetingPeople, meetingNotFound, type ForumOffice } from './leader-meeting-people';
import { LeaderMeetingRepository } from './leader-meeting.repository';
import type { FrozenEditor, LeaderMeetingDocument } from './leader-meeting.schema';
import {
  actionItemsInOrder, agendaOf, FORUM_LIMITS, meetingState, openItemsOf, scorecardOf,
  type MeetingCard, type MeetingEditors, type MeetingListView, type MeetingView,
} from './leader-meeting.view';
import { LeaderScorecardService } from './scorecard/scorecard.service';
import type { ComputedScorecard } from './scorecard/scorecard.types';

/** The audit trail's name for the collection (`targetCollection`). */
export const MEETINGS = 'leaderMeetings';

/** A new item's id: its own, never its position — two leaders adding at once never collide. */
export const newItemId = (): string => new Types.ObjectId().toHexString();

/** E11000: the number index refused a second meeting given the same number at once. */
const isDuplicateKey = (err: unknown) => (err as { code?: number }).code === 11000;

/** How many times a new meeting is numbered again when another took its number a moment before. */
const NUMBER_ATTEMPTS = 3;

/**
 * **The office's meetings: the list, a meeting, and making, moving and removing one** (D-forum-model,
 * ADR-0129, ADR-0130; `functional/leader-forum.md`). The minutes' writes are `LeaderMeetingMinutes`'; the links,
 * `LeaderMeetingSharing`'s, which serves a meeting opened by a link through `view` here.
 *
 * **Live, then frozen** (ADR-0129): while a meeting is upcoming every read computes its scorecard through
 * `LeaderScorecardService` and reads its editors from the tag; **the first read once it is *Completed*** — 00:00 the
 * day after its date in the office's calendar — writes both onto it in one conditional update, and nothing
 * recomputes them after. A read-only support session's read computes them as the freeze would and writes nothing
 * (roles §3.13). Nothing here notifies anybody, and nothing writes a §3.5 entry: the scorecard is figures over the
 * office, and the minutes are the leaders' own words.
 */
@Injectable()
export class LeaderMeetingsService {
  constructor(
    private readonly meetings: LeaderMeetingRepository,
    private readonly people: LeaderMeetingPeople,
    private readonly scorecards: LeaderScorecardService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** `GET /leader-meetings`: every meeting of the office, newest first by date. */
  async list(ctx: RequestContext): Promise<MeetingListView> {
    await this.people.editor(ctx);
    const office = await this.people.office(ctx);
    const meetings = await this.meetings.list(ctx);
    const live = await this.people.liveEditors(ctx, office);
    const describe = await this.people.describer(ctx, office, [live, ...meetings.map((m) => m.frozenCoeditors ?? [])]);
    const today = this.today(office);
    return {
      meetings: meetings.map((meeting) => this.cardOf(meeting, today, live, describe.editors)),
      can: { create: can(ctx, 'leader_meeting:create') },
      limits: { ...FORUM_LIMITS },
    };
  }

  /** `GET /leader-meetings/:meetingId`: a meeting by its address. The first read after its date may freeze it. */
  async read(ctx: RequestContext, meetingId: string): Promise<MeetingView> {
    await this.people.editor(ctx);
    const office = await this.people.office(ctx);
    const meeting = await this.meetings.findById(ctx, meetingId);
    if (!meeting) throw meetingNotFound();
    return this.view(ctx, office, meeting, 'address');
  }

  /**
   * **`POST /leader-meetings`** (ADR-0130 §2, §3): numbered one past the office's highest not deleted, its agenda
   * the latest meeting's unticked — or the prototype's ten in an office with none — and no rows. Two made at once
   * cannot share a number: the second is refused by the index and numbered again.
   */
  async create(ctx: RequestContext, input: { title: string; date: string }): Promise<MeetingCard> {
    await this.people.editor(ctx);
    const previous = await this.meetings.latest(ctx);
    let created: LeaderMeetingDocument | null = null;
    for (let attempt = 1; created === null; attempt += 1) {
      const number = (await this.meetings.highestNumber(ctx)) + 1;
      try {
        created = await this.meetings.create(ctx, {
          number, title: input.title, date: input.date,
          agenda: startingAgenda(input.date, previous?.agenda ?? null, newItemId),
          actionItems: [], monthlyTargets: {}, writtenAt: null,
          frozenScorecard: null, frozenAt: null, frozenCoeditors: null, version: 1,
        } as never);
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        // Other meetings kept taking the number: the dialog's line asks for another try, as any write a newer one
        // met does (the Phase 18.1 code review — a raw duplicate key was a 500).
        if (attempt >= NUMBER_ATTEMPTS) {
          throw new DomainException(
            ErrorCode.VERSION_CONFLICT,
            'Another meeting was made at the same moment. Try again.',
            HttpStatus.CONFLICT,
            { number },
          );
        }
      }
    }
    await this.audit.record(ctx, {
      action: 'leader_meeting.created', targetCollection: MEETINGS, targetId: String(created._id),
      before: null, after: { title: created.title, date: created.date, number: created.number },
    });
    return this.card(ctx, created);
  }

  /**
   * **`PATCH /leader-meetings/:meetingId`** (ADR-0130 §4): the title, the date or both, **while the meeting is
   * upcoming** — whether or not anybody has written in it. Once *Completed* its date is the day its scorecard was
   * frozen for: `409 LEADER_MEETING_COMPLETED`.
   */
  async reschedule(
    ctx: RequestContext, meetingId: string, input: { title?: string; date?: string; version: number },
  ): Promise<MeetingCard> {
    await this.people.editor(ctx);
    const office = await this.people.office(ctx);
    const meeting = await this.meetings.findById(ctx, meetingId);
    if (!meeting) throw meetingNotFound();
    if (input.title === undefined && input.date === undefined) refuseWith(['Send a title, a date, or both.']);
    if (meetingState(meeting.date, this.today(office)) === 'completed') {
      throw new DomainException(
        ErrorCode.LEADER_MEETING_COMPLETED,
        'This meeting has already taken place, so its date stays.',
        HttpStatus.CONFLICT,
        { date: meeting.date },
      );
    }
    const set = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.date !== undefined ? { date: input.date } : {}),
    };
    const moved = await this.meetings.updateHead(ctx, meetingId, input.version, set);
    if (!moved) throw await this.headConflict(ctx, meetingId, input.version);
    await this.audit.record(ctx, {
      action: 'leader_meeting.rescheduled', targetCollection: MEETINGS, targetId: meetingId,
      before: { title: meeting.title, date: meeting.date }, after: { title: moved.title, date: moved.date },
    });
    return this.card(ctx, moved);
  }

  /**
   * **`DELETE /leader-meetings/:meetingId?version=`** (ADR-0130 §5): only a meeting nobody has written in — a
   * meeting with minutes is never removed, `409 LEADER_MEETING_HAS_MINUTES`. Removing writes `deletedAt`: its
   * address answers *not found* and its number may be given again.
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
          'Something has been written in this meeting, so it can’t be deleted.',
          HttpStatus.CONFLICT,
        );
      }
      throw new VersionConflictException(version, now.version);
    }
    await this.audit.record(ctx, {
      action: 'leader_meeting.deleted', targetCollection: MEETINGS, targetId: meetingId,
      before: { number: meeting.number, title: meeting.title, date: meeting.date },
      after: { deletedAt: at.toISOString() },
    });
  }

  /**
   * **A meeting as its reader reads it** — by its address, or by a link (`LeaderMeetingSharing.open`): the head,
   * the editors (live, or as frozen), the scorecard (live, or as frozen, the typed targets over it), the agenda, the
   * tracker in its order, who may edit now, and what this reader may do. **By a link every `can` is false but
   * `print`**: a link reads, whoever holds it, and an editor edits at the meeting's own address.
   */
  async view(
    ctx: RequestContext, office: ForumOffice, meeting: LeaderMeetingDocument, via: 'address' | 'link',
  ): Promise<MeetingView> {
    const today = this.today(office);
    const state = meetingState(meeting.date, today);
    const live = await this.people.liveEditors(ctx, office);
    const record = await this.recordOf(ctx, office, meeting, state, live);
    const describe = await this.people.describer(ctx, office, [live, record.editors]);
    const now = describe.editors(live, false);
    const byAddress = via === 'address';
    const writtenIn = record.meeting.writtenAt !== null;
    return {
      ...this.cardOf(record.meeting, today, live, describe.editors),
      editors: describe.editors(record.editors, record.frozenAt !== null),
      version: record.meeting.version,
      branch: office.branch,
      scorecard: scorecardOf(record.scorecard, record.meeting.monthlyTargets, record.frozenAt),
      agenda: agendaOf(record.meeting.agenda),
      actionItems: actionItemsInOrder(record.meeting.actionItems),
      writtenIn,
      via,
      accessNote: { ownerName: now.owner?.name ?? null, adminNames: now.admins.map((p) => p.name) },
      can: {
        edit: byAddress && can(ctx, 'leader_meeting:edit'),
        share: byAddress && can(ctx, 'leader_meeting:share_link'),
        reschedule: byAddress && can(ctx, 'leader_meeting:reschedule') && state === 'upcoming',
        delete: byAddress && can(ctx, 'leader_meeting:delete') && !writtenIn,
        manageTags: byAddress && can(ctx, 'member:tag_core_leader'),
        // `export_pdf` inherits both reads (roles §3.14): whoever reads the meeting may print it.
        print: true,
      },
      limits: { ...FORUM_LIMITS },
    };
  }

  /**
   * **The scorecard and the editors this read serves** (ADR-0129 §6, §7): the frozen ones once written; the live
   * ones while the meeting is upcoming; and on the first read once it is *Completed*, the live ones **written onto
   * it** — unless this is a read-only support session, which is answered them and writes nothing. Of two first
   * reads at once one writes; the other reads what it wrote.
   */
  private async recordOf(
    ctx: RequestContext, office: ForumOffice, meeting: LeaderMeetingDocument, state: 'upcoming' | 'completed',
    live: FrozenEditor[],
  ): Promise<{ meeting: LeaderMeetingDocument; scorecard: ComputedScorecard; editors: FrozenEditor[]; frozenAt: Date | null }> {
    if (meeting.frozenAt) return this.frozen(meeting);
    const scorecard = await this.scorecards.compute({ kpmId: ctx.kpmId!, timezone: office.timezone, meetingDate: meeting.date });
    if (state === 'upcoming' || ctx.impersonationReadOnly) return { meeting, scorecard, editors: live, frozenAt: null };
    const frozenAt = this.clock.now();
    const written = await this.meetings.freeze(ctx, String(meeting._id), {
      frozenScorecard: scorecard as unknown as Record<string, unknown>, frozenAt, frozenCoeditors: live,
    });
    if (written) {
      await this.audit.record(ctx, {
        action: 'leader_meeting.frozen', targetCollection: MEETINGS, targetId: String(meeting._id),
        before: null, after: { frozenAt: frozenAt.toISOString(), editors: live.map((e) => e.membershipId) },
      });
      return this.frozen(written);
    }
    const first = await this.meetings.findById(ctx, String(meeting._id));
    if (!first) throw meetingNotFound();
    return this.frozen(first);
  }

  /**
   * A frozen meeting's record. `frozenScorecard`, `frozenAt` and `frozenCoeditors` are written in one update
   * (`LeaderMeetingRepository.freeze`), so a meeting with the one has the others.
   */
  private frozen(meeting: LeaderMeetingDocument) {
    return {
      meeting,
      scorecard: meeting.frozenScorecard as unknown as ComputedScorecard,
      editors: meeting.frozenCoeditors!,
      frozenAt: meeting.frozenAt,
    };
  }

  /** A meeting's card, as the list draws it: the frozen editors once written, the live ones until then. */
  private cardOf(
    meeting: LeaderMeetingDocument, today: string, live: readonly FrozenEditor[],
    editors: (list: readonly FrozenEditor[], frozen: boolean) => MeetingEditors,
  ): MeetingCard {
    return {
      id: String(meeting._id),
      number: meeting.number,
      title: meeting.title,
      date: meeting.date,
      state: meetingState(meeting.date, today),
      editors: meeting.frozenAt ? editors(meeting.frozenCoeditors!, true) : editors(live, false),
      openItems: openItemsOf(meeting.actionItems),
    };
  }

  /** One meeting's card on its own, for the dialog's answers. */
  private async card(ctx: RequestContext, meeting: LeaderMeetingDocument): Promise<MeetingCard> {
    const office = await this.people.office(ctx);
    const live = await this.people.liveEditors(ctx, office);
    const describe = await this.people.describer(ctx, office, [live, meeting.frozenCoeditors ?? []]);
    return this.cardOf(meeting, this.today(office), live, describe.editors);
  }

  /** Why a head write did not land: the meeting gone (404), or moved on since it was read (409). */
  private async headConflict(ctx: RequestContext, meetingId: string, version: number): Promise<Error> {
    const now = await this.meetings.findById(ctx, meetingId);
    return now ? new VersionConflictException(version, now.version) : meetingNotFound();
  }

  /** The office's today: the boundary *Upcoming* and *Completed* turn on (invariant §9). */
  private today(office: ForumOffice): string {
    return localDayOf(this.clock.now(), office.timezone);
  }
}
