import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, VersionConflictException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { refuseWith } from '@/common/validation/fields';
import { AuditService } from '@/modules/audit/audit.service';
import { NEW_ACTION_ITEM, NEW_AGENDA_ITEM_TEXT } from './leader-meeting-agenda';
import { LeaderMeetingPeople, meetingNotFound } from './leader-meeting-people';
import { LeaderMeetingRepository } from './leader-meeting.repository';
import {
  AGENDA_SECTIONS, type ActionStatus, type AgendaSection, type LeaderMeetingActionItem, type LeaderMeetingAgendaItem,
  type LeaderMeetingDocument,
} from './leader-meeting.schema';
import {
  actionItemOf, actionItemsInOrder, agendaItemOf, type ActionItem, type AgendaItem,
} from './leader-meeting.view';
import { MEETINGS, newItemId } from './leader-meetings.service';
import { TARGET_ROW_KEYS } from './scorecard/scorecard.types';

type ActionField = 'initiative' | 'metric' | 'action' | 'pic' | 'remarks' | 'status';
const ACTION_FIELDS: readonly ActionField[] = ['initiative', 'metric', 'action', 'pic', 'remarks', 'status'];
const AGENDA_FIELDS = ['text', 'pic', 'done'] as const;

/** One field per write (D-forum-model): the name of the one sent, or the refusal. */
function oneField<K extends string>(input: Partial<Record<K, unknown>>, fields: readonly K[]): K {
  const sent = fields.filter((field) => input[field] !== undefined);
  if (sent.length !== 1) refuseWith([`Send exactly one of ${fields.join(', ')}, with the version you read.`]);
  return sent[0];
}

/** Where an agenda item sits, by its id. */
function findAgendaItem(meeting: LeaderMeetingDocument, itemId: string): { section: AgendaSection; item: LeaderMeetingAgendaItem } | null {
  for (const section of AGENDA_SECTIONS) {
    const item = meeting.agenda[section].find((i) => i.itemId === itemId);
    if (item) return { section, item };
  }
  return null;
}

const findActionItem = (meeting: LeaderMeetingDocument, itemId: string) =>
  meeting.actionItems.find((row) => row.itemId === itemId) ?? null;

/**
 * **The minutes, written field by field** (D-forum-model, ADR-0132; `functional/leader-forum.md`, *Agenda*, *Action
 * Items*, *Saving*): an agenda item, a row of the tracker, the tracker's order and a *Monthly Target* cell.
 *
 * - **One field per write**, each with the version of the item it changes, refused `409 VERSION_CONFLICT` **only
 *   when that same item changed since** — so two leaders writing two rows both land. An item somebody removed
 *   meanwhile is a conflict too: the page reads the meeting again and it is gone.
 * - **No lock** (ADR-0132): a past meeting is written as an upcoming one is.
 * - **Every write is one audit row** with what it was and what it became; `writtenAt` is set as the first one begins.
 * - Written by the Owner, an Admin or a member tagged *Core Leader* by the meeting's address; anybody else of the
 *   office is answered 404, and nothing is ever written through a link.
 */
@Injectable()
export class LeaderMeetingMinutes {
  constructor(
    private readonly meetings: LeaderMeetingRepository,
    private readonly people: LeaderMeetingPeople,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** *+ Add item* (`:2863`): *"New agenda item"*, no PIC, unticked, last in its section. */
  async addAgendaItem(ctx: RequestContext, meetingId: string, section: AgendaSection): Promise<AgendaItem> {
    const meeting = await this.writable(ctx, meetingId);
    const item: LeaderMeetingAgendaItem = { itemId: newItemId(), text: NEW_AGENDA_ITEM_TEXT, pic: '', done: false, version: 1 };
    await this.writing(ctx, meeting);
    if (!(await this.meetings.pushAgendaItem(ctx, meetingId, section, item))) throw meetingNotFound();
    await this.audited(ctx, meeting, 'leader_meeting.agenda_item_added', null, { section, item: agendaItemOf(item) });
    return agendaItemOf(item);
  }

  /**
   * **One agenda field**: its text, its PIC, or — on *During* only, where the prototype draws the boxes — its box.
   * **A text that trims to nothing removes the item** (the prototype draws no remove), answered `{ removed: true }`.
   */
  async saveAgendaItem(
    ctx: RequestContext, meetingId: string, itemId: string,
    input: { text?: string; pic?: string; done?: boolean; version: number },
  ): Promise<AgendaItem | { removed: true }> {
    const meeting = await this.writable(ctx, meetingId);
    const field = oneField(input, AGENDA_FIELDS);
    const found = findAgendaItem(meeting, itemId);
    if (field === 'done' && found && found.section !== 'during') refuseWith(['done is ticked on During items only.']);
    if (!found) throw await this.itemConflict(ctx, meetingId, itemId, input.version);
    const { section, item: before } = found;

    await this.writing(ctx, meeting);
    if (field === 'text' && input.text!.trim() === '') {
      const removed = await this.meetings.pullAgendaItem(ctx, meetingId, section, itemId, input.version);
      if (!removed) throw await this.itemConflict(ctx, meetingId, itemId, input.version);
      await this.audited(ctx, meeting, 'leader_meeting.agenda_item_removed', { section, item: agendaItemOf(before) }, null);
      return { removed: true };
    }

    const value = field === 'done' ? input.done! : input[field]!.trim();
    const saved = await this.meetings.updateAgendaItem(ctx, meetingId, section, itemId, input.version, { [field]: value });
    if (!saved) throw await this.itemConflict(ctx, meetingId, itemId, input.version);
    const after = agendaItemOf(findAgendaItem(saved, itemId)!.item);
    await this.audited(ctx, meeting, 'leader_meeting.agenda_item_saved', { section, item: agendaItemOf(before) }, { section, item: after });
    return after;
  }

  /** *+ Add action item* (`:2869`): the prototype's new row, *Not yet planned*, last. */
  async addActionItem(ctx: RequestContext, meetingId: string): Promise<ActionItem> {
    const meeting = await this.writable(ctx, meetingId);
    const last = Math.max(-1, ...meeting.actionItems.map((row) => row.order));
    const row: LeaderMeetingActionItem = { itemId: newItemId(), ...NEW_ACTION_ITEM, order: last + 1, version: 1 };
    await this.writing(ctx, meeting);
    if (!(await this.meetings.pushActionItem(ctx, meetingId, row))) throw meetingNotFound();
    await this.audited(ctx, meeting, 'leader_meeting.action_item_added', null, { item: actionItemOf(row) });
    return actionItemOf(row);
  }

  /** **One cell of a row**, or its status — the button cycling *Not yet planned* → *Planned* → *Implemented*. */
  async saveActionItem(
    ctx: RequestContext, meetingId: string, itemId: string,
    input: Partial<Record<ActionField, string>> & { status?: ActionStatus; version: number },
  ): Promise<ActionItem> {
    const meeting = await this.writable(ctx, meetingId);
    const field = oneField(input, ACTION_FIELDS);
    const before = findActionItem(meeting, itemId);
    if (!before) throw await this.itemConflict(ctx, meetingId, itemId, input.version);
    const value = field === 'status' ? input.status! : input[field]!.trim();
    await this.writing(ctx, meeting);
    const saved = await this.meetings.updateActionItem(ctx, meetingId, itemId, input.version, { [field]: value });
    if (!saved) throw await this.itemConflict(ctx, meetingId, itemId, input.version);
    const after = actionItemOf(findActionItem(saved, itemId)!);
    await this.audited(ctx, meeting, 'leader_meeting.action_item_saved', { item: actionItemOf(before) }, { item: after });
    return after;
  }

  /** **×** (`:2867`): the row removed at once, as drawn, pinned to the version read. */
  async removeActionItem(ctx: RequestContext, meetingId: string, itemId: string, version: number): Promise<void> {
    const meeting = await this.writable(ctx, meetingId);
    const before = findActionItem(meeting, itemId);
    if (!before) throw await this.itemConflict(ctx, meetingId, itemId, version);
    await this.writing(ctx, meeting);
    const removed = await this.meetings.pullActionItem(ctx, meetingId, itemId, version);
    if (!removed) throw await this.itemConflict(ctx, meetingId, itemId, version);
    await this.audited(ctx, meeting, 'leader_meeting.action_item_removed', { item: actionItemOf(before) }, null);
  }

  /**
   * **The order, written whole** — by drag or by the keyboard: every row's id in its new place. Refused `409
   * VERSION_CONFLICT` when the meeting's rows are not exactly those — one added or removed since they were read.
   */
  async reorderActionItems(ctx: RequestContext, meetingId: string, itemIds: readonly string[]): Promise<ActionItem[]> {
    const meeting = await this.writable(ctx, meetingId);
    const before = actionItemsInOrder(meeting.actionItems).map((row) => row.id);
    const same = this.sameRows(before, itemIds);
    if (same) await this.writing(ctx, meeting);
    const reordered = same ? await this.meetings.reorderActionItems(ctx, meetingId, itemIds) : null;
    if (!reordered) {
      if (!(await this.meetings.findById(ctx, meetingId))) throw meetingNotFound();
      throw new DomainException(
        ErrorCode.VERSION_CONFLICT,
        'The tracker’s rows changed since you loaded them. Reload and try again.',
        HttpStatus.CONFLICT,
        { itemIds: before },
      );
    }
    await this.audited(ctx, meeting, 'leader_meeting.action_items_reordered', { itemIds: before }, { itemIds: [...itemIds] });
    return actionItemsInOrder(reordered.actionItems);
  }

  /**
   * **One *Monthly Target* cell** (ADR-0129 §5): the six rows the prototype leaves unblocked, short text, *TBD* a
   * value. A blocked or unknown row is refused 400. Never frozen: a past meeting's targets stay editable.
   */
  async saveMonthlyTarget(
    ctx: RequestContext, meetingId: string, row: string, input: { value: string; version: number },
  ): Promise<{ value: string; version: number }> {
    const meeting = await this.writable(ctx, meetingId);
    if (!(TARGET_ROW_KEYS as readonly string[]).includes(row)) {
      refuseWith([`row must be one of ${TARGET_ROW_KEYS.join(', ')}: the others take no Monthly Target.`]);
    }
    const before = meeting.monthlyTargets?.[row] ?? { value: '', version: 0 };
    const value = input.value.trim();
    await this.writing(ctx, meeting);
    const saved = await this.meetings.setMonthlyTarget(ctx, meetingId, row, input.version, value);
    if (!saved) {
      const now = await this.meetings.findById(ctx, meetingId);
      if (!now) throw meetingNotFound();
      throw new VersionConflictException(input.version, now.monthlyTargets?.[row]?.version ?? 0);
    }
    const after = { value, version: input.version + 1 };
    await this.audited(ctx, meeting, 'leader_meeting.monthly_target_saved', { row, ...before }, { row, ...after });
    return after;
  }

  /** A meeting the reader may write, by its address: an editor's, in their office, not deleted. */
  private async writable(ctx: RequestContext, meetingId: string): Promise<LeaderMeetingDocument> {
    await this.people.editor(ctx);
    const meeting = await this.meetings.findById(ctx, meetingId);
    if (!meeting) throw meetingNotFound();
    return meeting;
  }

  /**
   * **`writtenAt`, set before the write it stands for** (ADR-0130 §5; the Phase 18.1 code review): once a write is
   * about to land, *Delete meeting* is refused. Set after it, a delete landing between the two removed a meeting with
   * minutes. A write that then meets a newer one leaves it set — which only keeps a delete from removing a meeting
   * somebody was writing in.
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

  /** The same rows, each once: the order may differ, the set may not. */
  private sameRows(current: readonly string[], sent: readonly string[]): boolean {
    const set = new Set(current);
    return current.length === sent.length && sent.every((id) => set.has(id));
  }

  /**
   * Why an item's write did not land: the meeting gone (404), the item moved on since it was read, or the item
   * gone — removed meanwhile, which is a change since it was read too (409, `actualVersion: null`).
   */
  private async itemConflict(ctx: RequestContext, meetingId: string, itemId: string, version: number): Promise<Error> {
    const now = await this.meetings.findById(ctx, meetingId);
    if (!now) return meetingNotFound();
    const item = findAgendaItem(now, itemId)?.item ?? findActionItem(now, itemId);
    if (item) return new VersionConflictException(version, item.version);
    return new DomainException(
      ErrorCode.VERSION_CONFLICT,
      'This item is no longer in the meeting. Reload to see what is there now.',
      HttpStatus.CONFLICT,
      { expectedVersion: version, actualVersion: null },
    );
  }
}
