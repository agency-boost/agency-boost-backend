import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import type { TemplateKind } from './company-template.schema';
import { OfficeCounter, OfficeStanding, TemplateScope } from './office-counter.port';

/**
 * How many of a company's offices were built from something older than the current version
 * of **one** template kind, and how many cannot be told (P5-T12).
 *
 * **Per kind.** It compared one `seededFromVersion` — the activity taxonomy's — against
 * whichever kind's version it was handed, so every tab but Activity types counted against the
 * wrong template.
 *
 * **Per template** since 13.2 (ADR-0115 §3): an office counts against the template it was started
 * from (`startedFrom.templateId`), and an office created before 13.2 (`startedFrom: null`) against the
 * template migration `0023` made, which holds the rows it was built from. An office started from the
 * AgencyBoost defaults or *Empty* counts against none.
 *
 * **An office built from the platform defaults counts as behind.** Its record for the kind has
 * `version: null`: the company had published nothing of that kind when it was created, so it
 * runs something the company never chose — exactly the case a Super Admin wants to see. So does an
 * office whose template held none of the kind when it was made.
 *
 * **An office with no record for the kind is counted apart**, as unrecorded. It was created
 * before provisioning recorded that kind, and it may be entirely current.
 */
@Injectable()
export class KpmOfficeCounter extends OfficeCounter {
  constructor(@InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>) {
    super();
  }

  async standing(
    companyId: string, kind: TemplateKind, version: number, scope: TemplateScope,
  ): Promise<OfficeStanding> {
    // `kind` is the template service's own enum value, never request text, so building the
    // path from it cannot address a field anybody chose.
    const record = `seededFrom.${kind}`;
    const live = { companyId, deletedAt: null, ...this.answeredBy(scope) };

    const [behind, unrecorded] = await Promise.all([
      this.kpms.countDocuments({
        ...live,
        [record]: { $exists: true },
        $and: [{ $or: [{ [`${record}.version`]: null }, { [`${record}.version`]: { $lt: version } }] }],
      }).exec(),
      this.kpms.countDocuments({ ...live, [record]: { $exists: false } }).exec(),
    ]);
    return { behind, unrecorded };
  }

  async countsByTemplate(
    companyId: string, legacyTemplateId: string | null,
  ): Promise<Map<string, number>> {
    const rows = await this.kpms
      .find({ companyId, deletedAt: null }, { startedFrom: 1 })
      .lean()
      .exec();
    const counts = new Map<string, number>();
    for (const row of rows) {
      const started = (row as { startedFrom?: { templateId?: string | null } | null }).startedFrom;
      const templateId = started ? (started.templateId ?? null) : legacyTemplateId;
      if (templateId) counts.set(templateId, (counts.get(templateId) ?? 0) + 1);
    }
    return counts;
  }

  /** The offices a template answers for, as a filter. */
  private answeredBy(scope: TemplateScope): Record<string, unknown> {
    return scope.holdsLegacyOffices
      ? { $or: [{ 'startedFrom.templateId': scope.templateId }, { startedFrom: null }] }
      : { 'startedFrom.templateId': scope.templateId };
  }
}
