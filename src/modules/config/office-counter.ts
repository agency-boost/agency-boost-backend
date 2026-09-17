import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import type { TemplateKind } from './company-template.schema';
import { OfficeCounter, OfficeStanding } from './office-counter.port';

/**
 * How many of a company's offices were built from something older than the current version
 * of **one** template kind, and how many cannot be told (P5-T12).
 *
 * **Per kind.** It compared one `seededFromVersion` — the activity taxonomy's — against
 * whichever kind's version it was handed, so every tab but Activity types counted against the
 * wrong template.
 *
 * **An office built from the platform defaults counts as behind.** Its record for the kind has
 * `version: null`: the company had published nothing of that kind when it was created, so it
 * runs something the company never chose — exactly the case a Super Admin wants to see.
 *
 * **An office with no record for the kind is counted apart**, as unrecorded. It was created
 * before provisioning recorded that kind, and it may be entirely current.
 */
@Injectable()
export class KpmOfficeCounter extends OfficeCounter {
  constructor(@InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>) {
    super();
  }

  async standing(companyId: string, kind: TemplateKind, version: number): Promise<OfficeStanding> {
    // `kind` is the template service's own enum value, never request text, so building the
    // path from it cannot address a field anybody chose.
    const record = `seededFrom.${kind}`;
    const live = { companyId, deletedAt: null };

    const [behind, unrecorded] = await Promise.all([
      this.kpms.countDocuments({
        ...live,
        [record]: { $exists: true },
        $or: [{ [`${record}.version`]: null }, { [`${record}.version`]: { $lt: version } }],
      }).exec(),
      this.kpms.countDocuments({ ...live, [record]: { $exists: false } }).exec(),
    ]);
    return { behind, unrecorded };
  }
}
