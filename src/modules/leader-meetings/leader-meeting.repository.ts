import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import {
  LeaderMeeting, type AgendaSection, type FrozenEditor, type LeaderMeetingActionItem, type LeaderMeetingAgendaItem,
  type LeaderMeetingDocument, type MonthlyTargetCell,
} from './leader-meeting.schema';

type Filter = FilterQuery<LeaderMeetingDocument>;

/** `{ text: 'x' }` under `agenda.during.$[item].`: the fields of one array element, for one `$set`. */
const under = (prefix: string, fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fields).map(([key, value]) => [`${prefix}${key}`, value]));

/**
 * **The office's meetings, behind the chokepoint** (invariant §1): every read and write carries the reader's own
 * `kpmId` and skips the deleted, so an office never reads or writes another's meeting.
 *
 * **Every write here is one conditional update** (D-forum-model): it lands only while the thing written is still
 * at the version the writer read — the head, one agenda item, one action item, one target cell — and answers
 * `null` otherwise, which the service turns into `VERSION_CONFLICT` after reading why. So two leaders writing two
 * different rows both land, and of two writing the same row one wins.
 */
@Injectable()
export class LeaderMeetingRepository extends TenantScopedRepository<LeaderMeetingDocument> {
  constructor(@InjectModel(LeaderMeeting.name) model: Model<LeaderMeetingDocument>) {
    super(model, 'leaderMeetings');
  }

  /** The office's meetings, newest first by date (`(kpmId, date)`). */
  async list(ctx: RequestContext): Promise<LeaderMeetingDocument[]> {
    return this.find(ctx, {}, { sort: { date: -1, number: -1 } });
  }

  /** The meeting a new one copies its agenda from: the office's latest by date, or `null` in an office with none. */
  async latest(ctx: RequestContext): Promise<LeaderMeetingDocument | null> {
    const [row] = await this.find(ctx, {}, { sort: { date: -1, number: -1 }, limit: 1 });
    return row ?? null;
  }

  /** The highest number among the office's meetings not deleted, or 0 (`(kpmId, number)`). */
  async highestNumber(ctx: RequestContext): Promise<number> {
    const [row] = await this.find(ctx, {}, { sort: { number: -1 }, limit: 1, projection: { number: 1 } });
    return row?.number ?? 0;
  }

  /** The title or the date, only while the head is at `version`; bumps it. */
  async updateHead(
    ctx: RequestContext, id: string, version: number, set: { title?: string; date?: string },
  ): Promise<LeaderMeetingDocument | null> {
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'updateHead', { _id: id, version } as Filter),
      { $set: { ...set, updatedBy: ctx.membershipId }, $inc: { version: 1 } },
      { new: true, runValidators: true },
    ).exec();
  }

  /** A soft delete, only while the head is at `version` **and nobody has written in it** (ADR-0130 §5). */
  async deleteUnwritten(ctx: RequestContext, id: string, version: number, at: Date): Promise<LeaderMeetingDocument | null> {
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'deleteUnwritten', { _id: id, version, writtenAt: null } as Filter),
      { $set: { deletedAt: at, updatedBy: ctx.membershipId } },
      { new: true },
    ).exec();
  }

  /** The first write in the minutes: `writtenAt`, set once. A later write leaves it. */
  async markWritten(ctx: RequestContext, id: string, at: Date): Promise<void> {
    await this.model.updateOne(
      this.scope(ctx, 'markWritten', { _id: id, writtenAt: null } as Filter),
      { $set: { writtenAt: at } },
    ).exec();
  }

  async pushAgendaItem(
    ctx: RequestContext, id: string, section: AgendaSection, item: LeaderMeetingAgendaItem,
  ): Promise<LeaderMeetingDocument | null> {
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'pushAgendaItem', { _id: id } as Filter),
      { $push: { [`agenda.${section}`]: item }, $set: { updatedBy: ctx.membershipId } },
      { new: true },
    ).exec();
  }

  /** One agenda item's fields, only while that item is at `version`; bumps the item's version alone. */
  async updateAgendaItem(
    ctx: RequestContext, id: string, section: AgendaSection, itemId: string, version: number,
    set: Partial<Pick<LeaderMeetingAgendaItem, 'text' | 'pic' | 'done'>>,
  ): Promise<LeaderMeetingDocument | null> {
    const path = `agenda.${section}`;
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'updateAgendaItem', { _id: id, [path]: { $elemMatch: { itemId, version } } } as Filter),
      {
        $set: { ...under(`${path}.$[item].`, set), updatedBy: ctx.membershipId },
        $inc: { [`${path}.$[item].version`]: 1 },
      },
      { new: true, runValidators: true, arrayFilters: [{ 'item.itemId': itemId }] },
    ).exec();
  }

  /** An agenda item removed, only while it is at `version`. */
  async pullAgendaItem(
    ctx: RequestContext, id: string, section: AgendaSection, itemId: string, version: number,
  ): Promise<LeaderMeetingDocument | null> {
    const path = `agenda.${section}`;
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'pullAgendaItem', { _id: id, [path]: { $elemMatch: { itemId, version } } } as Filter),
      { $pull: { [path]: { itemId } }, $set: { updatedBy: ctx.membershipId } },
      { new: true },
    ).exec();
  }

  async pushActionItem(ctx: RequestContext, id: string, item: LeaderMeetingActionItem): Promise<LeaderMeetingDocument | null> {
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'pushActionItem', { _id: id } as Filter),
      { $push: { actionItems: item }, $set: { updatedBy: ctx.membershipId } },
      { new: true },
    ).exec();
  }

  /** One action item's field, only while that row is at `version`; bumps the row's version alone. */
  async updateActionItem(
    ctx: RequestContext, id: string, itemId: string, version: number,
    set: Partial<Pick<LeaderMeetingActionItem, 'initiative' | 'metric' | 'action' | 'pic' | 'remarks' | 'status'>>,
  ): Promise<LeaderMeetingDocument | null> {
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'updateActionItem', { _id: id, actionItems: { $elemMatch: { itemId, version } } } as Filter),
      {
        $set: { ...under('actionItems.$[item].', set), updatedBy: ctx.membershipId },
        $inc: { 'actionItems.$[item].version': 1 },
      },
      { new: true, runValidators: true, arrayFilters: [{ 'item.itemId': itemId }] },
    ).exec();
  }

  /** An action item removed, only while it is at `version`. */
  async pullActionItem(ctx: RequestContext, id: string, itemId: string, version: number): Promise<LeaderMeetingDocument | null> {
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'pullActionItem', { _id: id, actionItems: { $elemMatch: { itemId, version } } } as Filter),
      { $pull: { actionItems: { itemId } }, $set: { updatedBy: ctx.membershipId } },
      { new: true },
    ).exec();
  }

  /**
   * **The order, written whole** — each row's `order` its place in `itemIds` — only while the meeting holds
   * exactly those rows: one added or removed since the writer read them, and nothing is written. A row's fields
   * and its version are not touched, so a reorder never conflicts with a cell being typed.
   */
  async reorderActionItems(ctx: RequestContext, id: string, itemIds: readonly string[]): Promise<LeaderMeetingDocument | null> {
    const filter = itemIds.length === 0
      ? { _id: id, actionItems: { $size: 0 } }
      : { _id: id, actionItems: { $size: itemIds.length }, 'actionItems.itemId': { $all: [...itemIds] } };
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'reorderActionItems', filter as Filter),
      { $set: { ...Object.fromEntries(itemIds.map((_, i) => [`actionItems.$[r${i}].order`, i])), updatedBy: ctx.membershipId } },
      { new: true, arrayFilters: itemIds.map((itemId, i) => ({ [`r${i}.itemId`]: itemId })) },
    ).exec();
  }

  /**
   * **One *Monthly Target* cell's rate** (ADR-0175 §4), only while the cell is at `version` — 0 for a cell never typed,
   * which this write creates at 1. The cell is written whole: a rate entered replaces whatever text it was typed as
   * before rates (`typed`), which the audit row keeps as its `before`.
   */
  async setMonthlyTarget(
    ctx: RequestContext, id: string, row: string, version: number, rate: number | null,
  ): Promise<LeaderMeetingDocument | null> {
    const path = `monthlyTargets.${row}`;
    const at = version === 0 ? { [path]: { $exists: false } } : { [`${path}.version`]: version };
    const cell: MonthlyTargetCell = { rate, typed: null, version: version + 1 };
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'setMonthlyTarget', { _id: id, ...at } as Filter),
      { $set: { [path]: cell, updatedBy: ctx.membershipId } },
      { new: true },
    ).exec();
  }

  /**
   * **The freeze** (ADR-0129 §7): the scorecard and the editors written onto the meeting **in one write that lands
   * only where none has** — of two first reads at once, one writes and the other gets `null` and reads what the
   * first wrote. Not an edit: `updatedAt` and `updatedBy` stay the last edit's.
   */
  async freeze(
    ctx: RequestContext, id: string,
    frozen: { frozenScorecard: Record<string, unknown>; frozenAt: Date; frozenCoeditors: FrozenEditor[] },
  ): Promise<LeaderMeetingDocument | null> {
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'freeze', { _id: id, frozenAt: null } as Filter),
      { $set: frozen },
      { new: true, timestamps: false },
    ).exec();
  }
}
