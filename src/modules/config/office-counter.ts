import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { OfficeCounter } from './office-counter.port';

/**
 * How many of a company's offices were built from something older than the current
 * template.
 *
 * **An office that was seeded from the platform defaults counts as behind.** Its
 * `seededFromVersion` is `null`, which means the company had published nothing when it was
 * created — so it is on a taxonomy the company never chose, which is exactly the case a
 * Super Admin wants to see.
 */
@Injectable()
export class KpmOfficeCounter extends OfficeCounter {
  constructor(@InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>) {
    super();
  }

  async countBehind(companyId: string, version: number): Promise<number> {
    return this.kpms.countDocuments({
      companyId,
      deletedAt: null,
      $or: [
        { seededFromVersion: null },
        { seededFromVersion: { $exists: false } },
        { seededFromVersion: { $lt: version } },
      ],
    }).exec();
  }
}
