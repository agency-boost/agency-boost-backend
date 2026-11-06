import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import {
  KpmSetupMark, KpmSetupMarkDocument, type SetupMark, type SetupMarkVia,
} from './kpm-setup-mark.schema';

/** A mark as it stands: how it was first set, and when. */
export interface HeldMark {
  via: SetupMarkVia;
  at: Date;
}

/**
 * **A KPM's setup marks, behind the chokepoint** (invariant §1): every read and write carries the reader's own `kpmId`,
 * so an office never reads or sets another's — *Sudah sesuai* on KPM A leaves KPM B's card as it was.
 */
@Injectable()
export class KpmSetupMarkRepository extends TenantScopedRepository<KpmSetupMarkDocument> {
  constructor(@InjectModel(KpmSetupMark.name) model: Model<KpmSetupMarkDocument>) {
    super(model, 'kpmSetupMarks');
  }

  /**
   * **Set a mark once, in one atomic write**: an upserting `findOneAndUpdate` whose fields are all `$setOnInsert`, so a
   * mark already held is left exactly as it was. `created` says whether this write made it — what decides whether
   * *Sudah sesuai* writes its audit entry — and `at` is the mark's first time either way.
   *
   * Two first writes can both find nothing and both insert; the unique partial index refuses the second (E11000),
   * which is retried once and then finds the row the first made.
   */
  async setOnce(
    ctx: RequestContext, mark: SetupMark, via: SetupMarkVia, at: Date,
  ): Promise<{ id: string; created: boolean; at: Date; via: SetupMarkVia }> {
    const write = async () => {
      const result = await this.model.findOneAndUpdate(
        this.scope(ctx, 'setOnce', { mark }),
        {
          $setOnInsert: {
            kpmId: ctx.kpmId, mark, via, at, by: ctx.membershipId ?? null,
            deletedAt: null, createdBy: ctx.membershipId ?? null, updatedBy: ctx.membershipId ?? null,
          },
        },
        { new: false, upsert: true, includeResultMetadata: true, setDefaultsOnInsert: true },
      ).exec();
      const before = result.value;
      return before
        ? { id: String(before._id), created: false, at: before.at, via: before.via }
        : { id: String(result.lastErrorObject!.upserted), created: true, at, via };
    };
    try {
      return await write();
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      return write();
    }
  }

  /** Every live mark of the office, by mark: at most five rows. */
  async marksOf(ctx: RequestContext): Promise<Map<SetupMark, HeldMark>> {
    const rows = await this.find(ctx, {}, { projection: { mark: 1, via: 1, at: 1 } });
    return new Map(rows.map((row) => [row.mark, { via: row.via, at: row.at }]));
  }
}
