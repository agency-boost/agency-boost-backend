import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { QualificationRule, QualificationRuleDocument } from './campaign.schema';

/** A carrier rule as a reader evaluates it: its identity, the rungs it applies to, and its criteria. */
export interface CarrierRule {
  kind: 'moc' | 'production_club';
  code: string;
  name: string;
  appliesToOrgLevelCodes: string[];
  criteriaGroups: { mode: string; criteria: { metricKey: string; comparator: string; value: number }[] }[];
  groupMode: string;
  rank: number;
}

/**
 * **The company's carrier rules, and nothing else of this module** (Phase 18, D-moc, D-clubs).
 *
 * MOC thresholds and the production club tiers are `qualificationRules` of kind `moc` and `production_club`:
 * the company's since Phase 5 (ADR-0026, ADR-0035), kept beside campaigns and **not campaigns**. The Owner's
 * reporting reads them through this one named reader, so the reporting module touches no campaign, chase or
 * standing — the module imports nothing else of this one, and a test says so.
 *
 * **The office's own company, never one a caller names** (the Phase 18 exit review): the reader takes the request
 * context and resolves the company from the office's own row, by `_id: ctx.kpmId` — so no caller can hand it
 * another company's id, by mistake or otherwise. No office in the context, or an office whose row names no
 * company, reads no rule. Read-only; deleted rules are not rules.
 */
@Injectable()
export class CarrierRules {
  constructor(
    @InjectModel(QualificationRule.name) private readonly rules: Model<QualificationRuleDocument>,
    /** The office's own row, by `_id` from the context: the scope is the id (`repositories.tenancy.spec.ts`). */
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
  ) {}

  async ofOffice(ctx: RequestContext): Promise<CarrierRule[]> {
    if (!ctx.kpmId) return [];
    const office = await this.kpms.findOne({ _id: ctx.kpmId, deletedAt: null }).select('companyId').lean().exec();
    const companyId = office?.companyId;
    if (!companyId) return [];
    const rows = await this.rules
      .find({ companyId, deletedAt: null, kind: { $in: ['moc', 'production_club'] } })
      .sort({ kind: 1, rank: 1 })
      .lean()
      .exec();
    return (rows as unknown as CarrierRule[]).map((row) => ({
      kind: row.kind,
      code: row.code,
      name: row.name,
      appliesToOrgLevelCodes: [...(row.appliesToOrgLevelCodes ?? [])],
      criteriaGroups: (row.criteriaGroups ?? []).map((group) => ({
        mode: group.mode,
        criteria: (group.criteria ?? []).map((c) => ({ metricKey: c.metricKey, comparator: c.comparator, value: c.value })),
      })),
      groupMode: row.groupMode,
      rank: row.rank,
    }));
  }
}
