import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, UpdateQuery } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { LeaderNote, LeaderNoteDocument } from './leader-note.schema';

/**
 * Every leader note, through the chokepoint (invariant §1; P11-T9, ADR-0073).
 *
 * **No unscoped method, and none is wanted.** The Super Admin reads no note, not even by impersonation
 * (`BLOCKED_WHILE_IMPERSONATING`), and the Owner and the Admin read none as such.
 */
@Injectable()
export class LeaderNoteRepository extends TenantScopedRepository<LeaderNoteDocument> {
  constructor(@InjectModel(LeaderNote.name) model: Model<LeaderNoteDocument>) {
    super(model, 'leaderNotes');
  }

  /**
   * **A pinned write** (ADR-0042): the text lands only while the note is still at the `version` its
   * author read, and moves `version` on — so of the same note saved from two devices one wins and the
   * other gets `null`, which the service answers `VERSION_CONFLICT`.
   *
   * **`updatedAt` is the caller's**, from the office's clock, as the profile's is.
   */
  async updateIfAt(
    ctx: RequestContext,
    id: string,
    version: number,
    update: { $set: Record<string, unknown> } & UpdateQuery<LeaderNoteDocument>,
  ): Promise<LeaderNoteDocument | null> {
    const filter = this.scope(ctx, 'updateIfAt', { _id: id, version } as FilterQuery<LeaderNoteDocument>);
    return this.model
      .findOneAndUpdate(
        filter,
        { ...update, $set: { ...update.$set, updatedBy: ctx.membershipId }, $inc: { version: 1 } },
        { new: true, timestamps: false },
      )
      .exec();
  }
}
