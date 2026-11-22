import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, VersionConflictException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { refuseWith } from '@/common/validation/fields';
import { AuditService } from '@/modules/audit/audit.service';
import { carriedCopy } from './leader-meeting-agenda';
import { PIC_ALL } from './leader-meetings.dto';
import { LEADER_MEETINGS_REFUSALS } from './leader-meetings.messages';
import { LeaderMeetingPeople, meetingNotFound } from './leader-meeting-people';
import { LeaderMeetingRepository, type ActionItemField, type AgendaItemField } from './leader-meeting.repository';
import type {
  ActionStatus, LeaderMeetingActionItem, LeaderMeetingAgendaItem, LeaderMeetingDocument,
} from './leader-meeting.schema';
import { actionItemOf, agendaItemOf, type ActionItem, type AgendaItem } from './leader-meeting.view';
import { MEETINGS, newItemId } from './leader-meetings.service';

const AGENDA_FIELDS = ['text', 'pic', 'done'] as const;
const ACTION_FIELDS = ['text', 'pic', 'dueOn', 'status'] as const;

/** One field per write (D-forum-model): the name of the one sent, or the refusal. */
function oneField<K extends string>(input: Partial<Record<K, unknown>>, fields: readonly K[]): K {
  const sent = fields.filter((field) => input[field] !== undefined);
  if (sent.length !== 1) refuseWith([LEADER_MEETINGS_REFUSALS.VALIDATION_FAILED.exactlyOne({ fields })]);
  return sent[0];
}

const findAgendaItem = (meeting: LeaderMeetingDocument, itemId: string) =>
  (meeting.agendaItems ?? []).find((i) => i.itemId === itemId) ?? null;

const findActionItem = (meeting: LeaderMeetingDocument, itemId: string) =>
  (meeting.actionItems ?? []).find((row) => row.itemId === itemId) ?? null;

/** The next place at the end of a forum's action items. */
const nextOrder = (meeting: Pick<LeaderMeetingDocument, 'actionItems'>) =>
  Math.max(-1, ...(meeting.actionItems ?? []).map((row) => row.order)) + 1;

/**
 * **The agenda and the action items, written field by field** (P19.22-T8 AC-3, AC-4; ADR-0276, amending ADR-0132;
 * `functional/leader-forum.md`, *Agenda*, *Action items*, *Saving*).
 *
 * - **One field per write**, each with the version of the item it changes, refused `409 VERSION_CONFLICT` **only when
 *   that same item changed since** — so two leaders writing two lines both land.
 * - **A PIC is one of the forum's editors** (OD-418): the Owner, an Admin or a core leader, by membership id; an
 *   agenda line may say *Semua* instead. Anybody else is `400 VALIDATION_FAILED`.
 * - **The forward sync** (ADR-0276): an action item's write is passed, that field alone, to the copies of the same
 *   lineage in every **later** forum; an item added, or set back from *Selesai*, is carried into a later forum that
 *   holds no copy of it; a delete removes the later copies too. **Never backwards**: a later forum's write leaves the
 *   earlier forums as their leaders left them.
 * - **Every write is one audit row** with what it was and what it became, and how many later forums it reached;
 *   `writtenAt` is set as the first one begins. A copy arriving in a later forum writes no `writtenAt` there.
 */
@Injectable()
export class LeaderMeetingMinutes {
  constructor(
    private readonly meetings: LeaderMeetingRepository,
    private readonly people: LeaderMeetingPeople,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------------------------------- the agenda

  /** *+ Tambah agenda* (AC-3): the line typed, its PIC if chosen, unticked, last. */
  async addAgendaItem(ctx: RequestContext, meetingId: string, input: { text: string; pic?: string | null }): Promise<AgendaItem> {
    const meeting = await this.writable(ctx, meetingId);
    const pic = await this.agendaPic(ctx, input.pic ?? null);
    const item: LeaderMeetingAgendaItem = { itemId: newItemId(), text: input.text, ...pic, done: false, version: 1 };
    await this.writing(ctx, meeting);
    if (!(await this.meetings.pushAgendaItem(ctx, meetingId, item))) throw meetingNotFound();
    await this.audited(ctx, meeting, 'leader_meeting.agenda_item_added', null, { item: agendaItemOf(item) });
    return agendaItemOf(item);
  }

  /**
   * **One agenda field**: its text, its PIC (*Semua*, a member, or none) or its box. **A text that trims to nothing
   * removes the line**, answered `{ removed: true }`.
   */
  async saveAgendaItem(
    ctx: RequestContext, meetingId: string, itemId: string,
    input: { text?: string; pic?: string | null; done?: boolean; version: number },
  ): Promise<AgendaItem | { removed: true }> {
    const meeting = await this.writable(ctx, meetingId);
    const field = oneField(input, AGENDA_FIELDS);
    const before = findAgendaItem(meeting, itemId);
    if (!before) throw await this.itemConflict(ctx, meetingId, itemId, input.version);

    if (field === 'text' && input.text!.trim() === '') {
      await this.writing(ctx, meeting);
      const removed = await this.meetings.pullAgendaItem(ctx, meetingId, itemId, input.version);
      if (!removed) throw await this.itemConflict(ctx, meetingId, itemId, input.version);
      await this.audited(ctx, meeting, 'leader_meeting.agenda_item_removed', { item: agendaItemOf(before) }, null);
      return { removed: true };
    }

    const set: AgendaItemField = field === 'done' ? { done: input.done! }
      : field === 'text' ? { text: input.text!.trim() }
        : await this.agendaPic(ctx, input.pic ?? null);
    await this.writing(ctx, meeting);
    const saved = await this.meetings.updateAgendaItem(ctx, meetingId, itemId, input.version, set);
    if (!saved) throw await this.itemConflict(ctx, meetingId, itemId, input.version);
    const after = agendaItemOf(findAgendaItem(saved, itemId)!);
    await this.audited(ctx, meeting, 'leader_meeting.agenda_item_saved', { item: agendaItemOf(before) }, { item: after });
    return after;
  }

  // ------------------------------------------------------------------------------------------- the action items

  /**
   * *+ Tambah action item* (AC-4): what is to be done, its PIC and *tenggat* if chosen, *Belum*, last — **its own
   * lineage**, and carried at once into every later forum (*dari forum #n*, n this forum's).
   */
  async addActionItem(
    ctx: RequestContext, meetingId: string, input: { text: string; pic?: string | null; dueOn?: string | null },
  ): Promise<ActionItem> {
    const meeting = await this.writable(ctx, meetingId);
    const picMembershipId = await this.actionPic(ctx, input.pic ?? null);
    const itemId = newItemId();
    const row: LeaderMeetingActionItem = {
      itemId, lineageId: itemId, text: input.text, picMembershipId, dueOn: input.dueOn ?? null, status: 'todo',
      fromNumber: null, order: nextOrder(meeting), version: 1,
    };
    await this.writing(ctx, meeting);
    if (!(await this.meetings.pushActionItem(ctx, meetingId, row))) throw meetingNotFound();
    const carriedTo = await this.carryForward(ctx, meeting, row);
    await this.audited(ctx, meeting, 'leader_meeting.action_item_added', null, { item: actionItemOf(row), carriedTo });
    return actionItemOf(row);
  }

  /**
   * **One field of an action item** — its text, PIC, *tenggat* or state (*Belum · Proses · Selesai*, AC-4) — then that
   * field passed to the copies of its lineage in every later forum; a state set back from *Selesai* carries it into a
   * later forum that holds no copy.
   */
  async saveActionItem(
    ctx: RequestContext, meetingId: string, itemId: string,
    input: { text?: string; pic?: string | null; dueOn?: string | null; status?: ActionStatus; version: number },
  ): Promise<ActionItem> {
    const meeting = await this.writable(ctx, meetingId);
    const field = oneField(input, ACTION_FIELDS);
    const before = findActionItem(meeting, itemId);
    if (!before) throw await this.itemConflict(ctx, meetingId, itemId, input.version);
    const set: ActionItemField = field === 'text' ? { text: input.text!.trim() }
      : field === 'status' ? { status: input.status! }
        : field === 'dueOn' ? { dueOn: input.dueOn ?? null }
          : { picMembershipId: await this.actionPic(ctx, input.pic ?? null) };
    await this.writing(ctx, meeting);
    const saved = await this.meetings.updateActionItem(ctx, meetingId, itemId, input.version, set);
    if (!saved) throw await this.itemConflict(ctx, meetingId, itemId, input.version);
    const row = findActionItem(saved, itemId)!;
    const later = await this.meetings.after(ctx, meeting.number);
    const synced = await this.meetings.syncLineage(ctx, later.map((m) => String(m._id)), row.lineageId, set);
    const carriedTo = field === 'status' && row.status !== 'done' ? await this.carryForward(ctx, meeting, row, later) : 0;
    const after = actionItemOf(row);
    await this.audited(ctx, meeting, 'leader_meeting.action_item_saved', { item: actionItemOf(before) }, {
      item: after, syncedForums: synced, carriedTo,
    });
    return after;
  }

  /**
   * **The trash** (AC-4): *Hapus action item?* answered *Hapus* — the item removed, pinned to the version read, **and
   * its copies in every later forum** (*"Juga hilang dari forum berikutnya"*). An earlier forum keeps its own.
   */
  async removeActionItem(ctx: RequestContext, meetingId: string, itemId: string, version: number): Promise<void> {
    const meeting = await this.writable(ctx, meetingId);
    const before = findActionItem(meeting, itemId);
    if (!before) throw await this.itemConflict(ctx, meetingId, itemId, version);
    await this.writing(ctx, meeting);
    const removed = await this.meetings.pullActionItem(ctx, meetingId, itemId, version);
    if (!removed) throw await this.itemConflict(ctx, meetingId, itemId, version);
    const later = await this.meetings.after(ctx, meeting.number);
    const removedFrom = await this.meetings.pullLineage(ctx, later.map((m) => String(m._id)), before.lineageId);
    await this.audited(ctx, meeting, 'leader_meeting.action_item_removed', { item: actionItemOf(before) }, {
      removedFromLaterForums: removedFrom,
    });
  }

  // --------------------------------------------------------------------------------------------------- parts

  /**
   * **A not-*Selesai* item carried into every later forum that holds no copy of its lineage** (ADR-0276): a copy
   * there, last, *dari forum #n* — the number its lineage began in. Answers how many forums it reached.
   */
  private async carryForward(
    ctx: RequestContext, from: LeaderMeetingDocument, row: LeaderMeetingActionItem, known?: LeaderMeetingDocument[],
  ): Promise<number> {
    if (row.status === 'done') return 0;
    const later = known ?? await this.meetings.after(ctx, from.number);
    let reached = 0;
    for (const forum of later) {
      if ((forum.actionItems ?? []).some((r) => r.lineageId === row.lineageId)) continue;
      const copy = carriedCopy(row, from.number, newItemId(), nextOrder(forum));
      if (await this.meetings.pushCarried(ctx, String(forum._id), copy)) reached += 1;
    }
    return reached;
  }

  /** An agenda line's PIC: *Semua*, an editor, or none. */
  private async agendaPic(ctx: RequestContext, pic: string | null): Promise<{ picMembershipId: string | null; picAll: boolean }> {
    if (pic === PIC_ALL) return { picMembershipId: null, picAll: true };
    return { picMembershipId: await this.actionPic(ctx, pic), picAll: false };
  }

  /** An action item's PIC: one of the forum's editors now (OD-418), or none; `"all"` is an agenda line's alone. */
  private async actionPic(ctx: RequestContext, pic: string | null): Promise<string | null> {
    if (pic === null) return null;
    const office = await this.people.office(ctx);
    const editors = await this.people.liveEditors(ctx, office);
    if (!editors.some((e) => e.membershipId === pic)) refuseWith([LEADER_MEETINGS_REFUSALS.VALIDATION_FAILED.picNotEditor]);
    return pic;
  }

  /** A forum the reader may write, by its address: a steward's, in their office, not deleted. */
  private async writable(ctx: RequestContext, meetingId: string): Promise<LeaderMeetingDocument> {
    await this.people.editor(ctx);
    const meeting = await this.meetings.findById(ctx, meetingId);
    if (!meeting) throw meetingNotFound();
    return meeting;
  }

  /**
   * **`writtenAt`, set before the write it stands for** (ADR-0130 §5): once a write is about to land, deleting the
   * forum is refused. Set after it, a delete landing between the two removed a forum with writing in it.
   */
  private async writing(ctx: RequestContext, meeting: LeaderMeetingDocument): Promise<void> {
    if (!meeting.writtenAt) await this.meetings.markWritten(ctx, String(meeting._id), this.clock.now());
  }

  /** A landed write's one audit row, with before and after (ADR-0132 §2). */
  private async audited(
    ctx: RequestContext, meeting: LeaderMeetingDocument, action: string,
    before: Record<string, unknown> | null, after: Record<string, unknown> | null,
  ): Promise<void> {
    await this.audit.record(ctx, { action, targetCollection: MEETINGS, targetId: String(meeting._id), before, after });
  }

  /**
   * Why an item's write did not land: the forum gone (404), the item moved on since it was read, or the item gone —
   * removed meanwhile, which is a change since it was read too (409, `actualVersion: null`).
   */
  private async itemConflict(ctx: RequestContext, meetingId: string, itemId: string, version: number): Promise<Error> {
    const now = await this.meetings.findById(ctx, meetingId);
    if (!now) return meetingNotFound();
    const item = findAgendaItem(now, itemId) ?? findActionItem(now, itemId);
    if (item) return new VersionConflictException(version, item.version);
    return new DomainException(
      ErrorCode.VERSION_CONFLICT,
      LEADER_MEETINGS_REFUSALS.VERSION_CONFLICT.itemGone,
      HttpStatus.CONFLICT,
      { expectedVersion: version, actualVersion: null },
    );
  }
}
