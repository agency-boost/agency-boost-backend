import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { CampaignStanding, CampaignStandingDocument, type StandingOverride } from './campaign-standing.schema';

/** The final standings (P18.2-T8 AC-5). Through the chokepoint; written in one insert when a window becomes final. */
@Injectable()
export class CampaignStandingRepository extends TenantScopedRepository<CampaignStandingDocument> {
  constructor(@InjectModel(CampaignStanding.name) model: Model<CampaignStandingDocument>) {
    super(model, 'campaignStandings');
  }

  /**
   * **Freeze a window's standings in one write** — never one insert per member (T8 AC-9). The office is the
   * context's, stamped on every row as `create` stamps it. Unordered, and a row a concurrent first read already
   * wrote meets the unique index and is skipped: the first freeze stands, and nothing in it changes (OD-154).
   */
  async insertFinal(ctx: RequestContext, rows: readonly Partial<CampaignStanding>[], at: Date): Promise<void> {
    if (rows.length === 0) return;
    const kpmId = this.scope(ctx, 'insertFinal').kpmId as string;
    try {
      await this.model.insertMany(
        // The clock port's instant, never the wall clock's (the review, item 22).
        rows.map((row) => ({ ...row, kpmId, deletedAt: null, createdAt: at, updatedAt: at })),
        { ordered: false, throwOnValidationError: true },
      );
    } catch (err) {
      // Every failure a duplicate: another read froze those rows first, which is the same answer.
      const errors = (err as { writeErrors?: { code?: number; err?: { code?: number } }[]; code?: number });
      const codes = errors.writeErrors?.map((e) => e.code ?? e.err?.code) ?? [errors.code];
      if (codes.length === 0 || codes.some((code) => code !== 11000)) throw err;
    }
  }

  /**
   * **Set or clear a final standing's override, only where the row is still as it was read** (P18.3-T2 AC-5): one
   * conditional update on the row's own `version`, which it moves — so of two writes from one reading only the first
   * lands, and the caller audits exactly the write that happened (`false`: somebody changed it first). Scoped like
   * every write here; the frozen `status` is not touched. Stamped with the clock port's instant.
   */
  async setOverride(
    ctx: RequestContext, id: string, version: number | null, override: StandingOverride | null, at: Date,
  ): Promise<boolean> {
    const result = await this.model.updateOne(
      this.scope(ctx, 'setOverride', { _id: id, version }),
      { $set: { override, updatedAt: at }, $inc: { version: 1 } },
      { timestamps: false },
    ).exec();
    return result.modifiedCount === 1;
  }
}
