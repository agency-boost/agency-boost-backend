import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import {
  LeaderMeeting, type LeaderMeetingActionItem, type LeaderMeetingAgendaItem, type LeaderMeetingDocument,
} from './leader-meeting.schema';

type Filter = FilterQuery<LeaderMeetingDocument>;

/** `{ text: 'x' }` under `actionItems.$[item].`: the fields of one array element, for one `$set`. */
const under = (prefix: string, fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fields).map(([key, value]) => [`${prefix}${key}`, value]));

/** The fields of an action item a single write changes — and the forward sync passes on (ADR-0276). */
export type ActionItemField = Partial<Pick<LeaderMeetingActionItem, 'text' | 'picMembershipId' | 'dueOn' | 'status'>>;

/** The fields of an agenda line a single write changes. */
export type AgendaItemField = Partial<Pick<LeaderMeetingAgendaItem, 'text' | 'picMembershipId' | 'picAll' | 'done'>>;

/**
 * **The office's forums, behind the chokepoint** (invariant §1): every read and write carries the reader's own
 * `kpmId` and skips the deleted, so an office never reads or writes another's forum.
 *
 * **Every write to one forum is one conditional update** (D-forum-model): it lands only while the thing written is
 * still at the version the writer read — the head, one agenda line, one action item — and answers `null` otherwise,
 * which the service turns into `VERSION_CONFLICT` after reading why. **The forward sync** (ADR-0276) writes the copies of
 * one lineage in later forums without a version: they follow the forum they were carried from.
 */
@Injectable()
export class LeaderMeetingRepository extends TenantScopedRepository<LeaderMeetingDocument> {
  constructor(@InjectModel(LeaderMeeting.name) model: Model<LeaderMeetingDocument>) {
    super(model, 'leaderMeetings');
  }

  /** The office's forums (`(kpmId, date)`); the service orders them by date and time. */
  async list(ctx: RequestContext): Promise<LeaderMeetingDocument[]> {
    return this.find(ctx, {}, { sort: { date: -1, number: -1 } });
  }

  /** The highest number among the office's forums not deleted, or 0 (`(kpmId, number)`). */
  async highestNumber(ctx: RequestContext): Promise<number> {
    const [row] = await this.find(ctx, {}, { sort: { number: -1 }, limit: 1, projection: { number: 1 } });
    return row?.number ?? 0;
  }

  /** **The forum before `number`**: the live forum with the highest number below it, or `null`. */
  async before(ctx: RequestContext, number: number): Promise<LeaderMeetingDocument | null> {
    const [row] = await this.find(ctx, { number: { $lt: number } } as Filter, { sort: { number: -1 }, limit: 1 });
    return row ?? null;
  }

  /** **The forums after `number`**: every live forum numbered above it, lowest first. */
  async after(ctx: RequestContext, number: number): Promise<LeaderMeetingDocument[]> {
    return this.find(ctx, { number: { $gt: number } } as Filter, { sort: { number: 1 } });
  }

  /** The date or the time, only while the head is at `version`; bumps it. */
  async updateHead(
    ctx: RequestContext, id: string, version: number, set: { date?: string; time?: string },
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

  /** The first write in the forum: `writtenAt`, set once. A later write leaves it. */
  async markWritten(ctx: RequestContext, id: string, at: Date): Promise<void> {
    await this.model.updateOne(
      this.scope(ctx, 'markWritten', { _id: id, writtenAt: null } as Filter),
      { $set: { writtenAt: at } },
    ).exec();
  }

  async pushAgendaItem(ctx: RequestContext, id: string, item: LeaderMeetingAgendaItem): Promise<LeaderMeetingDocument | null> {
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'pushAgendaItem', { _id: id } as Filter),
      { $push: { agendaItems: item }, $set: { updatedBy: ctx.membershipId } },
      { new: true },
    ).exec();
  }

  /** One agenda line's fields, only while that line is at `version`; bumps the line's version alone. */
  async updateAgendaItem(
    ctx: RequestContext, id: string, itemId: string, version: number, set: AgendaItemField,
  ): Promise<LeaderMeetingDocument | null> {
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'updateAgendaItem', { _id: id, agendaItems: { $elemMatch: { itemId, version } } } as Filter),
      {
        $set: { ...under('agendaItems.$[item].', set), updatedBy: ctx.membershipId },
        $inc: { 'agendaItems.$[item].version': 1 },
      },
      { new: true, runValidators: true, arrayFilters: [{ 'item.itemId': itemId }] },
    ).exec();
  }

  /** An agenda line removed, only while it is at `version`. */
  async pullAgendaItem(ctx: RequestContext, id: string, itemId: string, version: number): Promise<LeaderMeetingDocument | null> {
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'pullAgendaItem', { _id: id, agendaItems: { $elemMatch: { itemId, version } } } as Filter),
      { $pull: { agendaItems: { itemId } }, $set: { updatedBy: ctx.membershipId } },
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

  /** One action item's field, only while that item is at `version`; bumps the item's version alone. */
  async updateActionItem(
    ctx: RequestContext, id: string, itemId: string, version: number, set: ActionItemField,
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
   * **The forward sync of one field** (ADR-0276): the copies of `lineageId` in the forums `ids` — the later ones —
   * take `set`, each bumping its own version. A forum holding no copy is untouched. Answers how many forums changed.
   */
  async syncLineage(ctx: RequestContext, ids: readonly string[], lineageId: string, set: ActionItemField): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.model.updateMany(
      this.scope(ctx, 'syncLineage', { _id: { $in: [...ids] }, 'actionItems.lineageId': lineageId } as Filter),
      {
        $set: { ...under('actionItems.$[copy].', set), updatedBy: ctx.membershipId },
        $inc: { 'actionItems.$[copy].version': 1 },
      },
      { runValidators: true, arrayFilters: [{ 'copy.lineageId': lineageId }] },
    ).exec();
    return result.modifiedCount;
  }

  /** **A carried copy appended to one later forum** — only while it holds no copy of the lineage. */
  async pushCarried(ctx: RequestContext, id: string, item: LeaderMeetingActionItem): Promise<boolean> {
    const result = await this.model.updateOne(
      this.scope(ctx, 'pushCarried', { _id: id, 'actionItems.lineageId': { $ne: item.lineageId } } as Filter),
      { $push: { actionItems: item }, $set: { updatedBy: ctx.membershipId } },
    ).exec();
    return result.modifiedCount === 1;
  }

  /** **A deleted item's copies in later forums**, removed (ADR-0276): answers how many forums changed. */
  async pullLineage(ctx: RequestContext, ids: readonly string[], lineageId: string): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.model.updateMany(
      this.scope(ctx, 'pullLineage', { _id: { $in: [...ids] }, 'actionItems.lineageId': lineageId } as Filter),
      { $pull: { actionItems: { lineageId } }, $set: { updatedBy: ctx.membershipId } },
    ).exec();
    return result.modifiedCount;
  }
}
