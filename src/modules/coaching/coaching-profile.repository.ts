import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, UpdateQuery } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { CoachingProfile, CoachingProfileDocument } from './coaching-profile.schema';

/**
 * Every coaching profile, through the chokepoint (invariant §1; P11-T9).
 *
 * **No unscoped method, and none is wanted**: a profile is an assessment of one member of one office,
 * read and ticked only by that person's current coaches.
 */
@Injectable()
export class CoachingProfileRepository extends TenantScopedRepository<CoachingProfileDocument> {
  constructor(@InjectModel(CoachingProfile.name) model: Model<CoachingProfileDocument>) {
    super(model, 'coachingProfiles');
  }

  /**
   * **A pinned write** (ADR-0042): the update lands only while the profile is still at the `version` the
   * writer read, and moves `version` on — one conditional write, so of two coaches saving the same
   * version one wins and the other gets `null`, which the service answers `VERSION_CONFLICT`.
   *
   * **`updatedAt` is the caller's**, from the office's clock, so a revision's `at` and the answer's
   * `updatedAt` are the instant the service reasoned about; Mongoose's own stamp is off for this write.
   */
  async updateIfAt(
    ctx: RequestContext,
    id: string,
    version: number,
    update: { $set: Record<string, unknown> } & UpdateQuery<CoachingProfileDocument>,
  ): Promise<CoachingProfileDocument | null> {
    const filter = this.scope(ctx, 'updateIfAt', { _id: id, version } as FilterQuery<CoachingProfileDocument>);
    return this.model
      .findOneAndUpdate(
        filter,
        { ...update, $set: { ...update.$set, updatedBy: ctx.membershipId }, $inc: { version: 1 } },
        { new: true, timestamps: false },
      )
      .exec();
  }
}
