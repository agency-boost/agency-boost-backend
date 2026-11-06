import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import {
  ActivityCategoryRepository, ConfigSnapshotRepository, RatioDefinitionRepository,
} from '@/modules/config/activity.repository';
import { CompanyTemplate, CompanyTemplateDocument } from '@/modules/config/company-template.schema';
import { CampaignRepository } from '@/modules/campaigns/campaign.repository';
import { QualificationRule, QualificationRuleDocument } from '@/modules/campaigns/campaign.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { LeaderLimitRequestRepository, MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { Kpm, KpmDocument } from './kpm.schema';
import {
  ORG_LEVEL_REFERENCE_KINDS, OrgLevelReferenceSearch, type OrgLevelReference, type OrgLevelReferenceKind,
} from './org-level-references.port';

/**
 * **Whether anything in a company still names one of its rungs** (ADR-0213 §2): before `DELETE /admin/org-levels/:id`,
 * every record that holds a rung's id or code, in that company and nowhere else — its KPMs' memberships with their role
 * history, leader-limit requests, live configuration, published configuration and campaigns, and the company's own
 * carrier rules and template versions and drafts.
 *
 * **Counts, never a row**, by the Super Admin who is in no office. Office records are counted through each repository's
 * named `countInOfficesAcrossTenants`, the company's KPMs named — every one of them, a deleted or archived one too,
 * since what it holds stays (`named-cross-tenant-reads.tenancy.spec.ts`). The company's own records are
 * company-partitioned, as products are, and filtered by its id.
 *
 * *Unused* grows with every new record that names a rung (ADR-0213, *Harder*): one more kind here, and one more case in
 * `org-level-delete.int.spec.ts`. Provided as `OrgLevelReferenceSearch`, the port the ladder asks, so nothing that reads
 * the ladder reaches the repositories this one reads.
 */
@Injectable()
export class OrgLevelReferences extends OrgLevelReferenceSearch {
  constructor(
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(CompanyTemplate.name) private readonly templates: Model<CompanyTemplateDocument>,
    @InjectModel(QualificationRule.name) private readonly rules: Model<QualificationRuleDocument>,
    private readonly memberships: MembershipRepository,
    private readonly history: MembershipHistoryRepository,
    private readonly limits: LeaderLimitRequestRepository,
    private readonly categories: ActivityCategoryRepository,
    private readonly ratios: RatioDefinitionRepository,
    private readonly snapshots: ConfigSnapshotRepository,
    private readonly campaigns: CampaignRepository,
  ) {
    super();
  }

  /** Every kind of record in `companyId` that names the rung, with its count; empty when nothing does. */
  async of(
    ctx: RequestContext, rung: { orgLevelId: string; companyId: string; code: string },
  ): Promise<OrgLevelReference[]> {
    const { orgLevelId, companyId, code } = rung;
    const offices = (await this.kpms.find({ companyId }, { _id: 1 }).lean().exec()).map((k) => String(k._id));
    const named = { appliesToOrgLevelCodes: code };

    const counts: Record<OrgLevelReferenceKind, Promise<number>> = {
      memberships: this.memberships.countInOfficesAcrossTenants(ctx, offices, { orgLevelId }),
      membershipHistory: this.history.countInOfficesAcrossTenants(ctx, offices, {
        $or: [{ fromOrgLevelId: orgLevelId }, { toOrgLevelId: orgLevelId }],
      }),
      leaderLimitRequests: this.limits.countInOfficesAcrossTenants(ctx, offices, {
        $or: [{ fromOrgLevelCode: code }, { toOrgLevelCode: code }],
      }),
      activityCategories: this.categories.countInOfficesAcrossTenants(ctx, offices, named),
      ratioDefinitions: this.ratios.countInOfficesAcrossTenants(ctx, offices, named),
      configSnapshots: this.snapshots.countInOfficesAcrossTenants(ctx, offices, {
        $or: [{ 'payload.activity.appliesToOrgLevelCodes': code }, { 'payload.ratios.appliesToOrgLevelCodes': code }],
      }),
      campaigns: this.campaigns.countInOfficesAcrossTenants(ctx, offices, named),
      qualificationRules: this.rules.countDocuments({ companyId, deletedAt: null, ...named }).exec(),
      companyTemplates: this.templates.countDocuments({
        companyId,
        deletedAt: null,
        $or: [
          { 'payload.categories.appliesToOrgLevelCodes': code },
          { 'payload.ratios.appliesToOrgLevelCodes': code },
          { 'payload.rules.appliesToOrgLevelCodes': code },
        ],
      }).exec(),
    };

    const found = await Promise.all(ORG_LEVEL_REFERENCE_KINDS.map(async (kind) => ({ kind, count: await counts[kind] })));
    return found.filter((r) => r.count > 0);
  }
}
