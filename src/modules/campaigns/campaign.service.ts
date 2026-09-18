import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException } from '@/common/errors/domain.exception';
import {
  SEED_MOC_RULES, SEED_PRODUCTION_CLUB_TIERS, metricByKey,
} from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { Kpm } from '@/modules/tenants/kpm.schema';
import { CampaignDocument, QualificationRule, QualificationRuleDocument } from './campaign.schema';
import { CampaignRepository } from './campaign.repository';
import { checkCampaign, type CheckedRequirement } from './campaign-input';

export interface RequirementView {
  metricKey: string;
  /** The registry's own name, so a screen never has to hold a second copy of the vocabulary. */
  metricName: string;
  comparator: string;
  value: number;
  unit: string;
}

export interface CampaignView {
  id: string;
  code: string;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  /** Derived on every read (AC-3), never stored. */
  phase: 'upcoming' | 'running' | 'ended';
  requirements: RequirementView[];
  reward: string;
  status: 'active' | 'archived';
  version: number;
}

export interface QualificationRuleView {
  id: string;
  kind: string;
  code: string;
  name: string;
  appliesToOrgLevelCodes: string[];
  criteriaGroups: { mode: string; criteria: RequirementView[] }[];
  groupMode: string;
  reward: string;
  rank: number;
  /** Metric keys the registry does not define yet. A rule with any can never pass. */
  waitingOnMetrics: string[];
}

/**
 * An office's campaigns, and the carrier rules it is measured against (P5-T7).
 *
 * **Two things that look alike on one screen and behave differently** (ADR-0026). *Year-End Star
 * Club Drive* is the office's own campaign and fully editable; *Star Club* is the insurer's
 * recognition tier and editable by nobody in any office. The screen has to make that visible, and
 * the API has to enforce it rather than trusting the screen to.
 */
@Injectable()
export class CampaignService {
  constructor(
    private readonly campaigns: CampaignRepository,
    @InjectModel(QualificationRule.name)
    private readonly rules: Model<QualificationRuleDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<Kpm>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(ctx: RequestContext, includeArchived = false): Promise<CampaignView[]> {
    const rows = await this.campaigns.find(
      ctx, includeArchived ? {} : { status: 'active' }, { sort: { startsAt: -1 } },
    );
    return rows.map((row) => this.view(row));
  }

  async create(ctx: RequestContext, body: unknown): Promise<CampaignView> {
    const input = checkCampaign(body);
    if (await this.campaigns.exists(ctx, { code: input.code })) {
      throw new BadRequestException(`This office already has a campaign with the code ${input.code}.`);
    }
    const created = await this.campaigns.create(ctx, {
      ...input, version: 1, status: 'active',
    } as never);
    await this.record(ctx, 'campaign.created', created, { code: input.code });
    return this.view(created);
  }

  async update(ctx: RequestContext, id: string, body: unknown): Promise<CampaignView> {
    const input = checkCampaign(body, { partial: true });
    // The code is the identity: a standing that already names it must keep resolving.
    delete (input as { code?: string }).code;
    const updated = await this.campaigns.updateById(ctx, id, {
      $set: input as never, $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Campaign');
    await this.record(ctx, 'campaign.updated', updated, { code: updated.code });
    return this.view(updated);
  }

  async archive(ctx: RequestContext, id: string): Promise<CampaignView> {
    return this.setStatus(ctx, id, 'archived');
  }

  async restore(ctx: RequestContext, id: string): Promise<CampaignView> {
    return this.setStatus(ctx, id, 'active');
  }

  /**
   * The carrier rules this office is measured against — **read only, for everybody here** (AC-7).
   *
   * There is no create, update or delete on this service at all. An office cannot edit the
   * insurer's recognition tiers, and the absence of the method is the enforcement: a permission
   * check can be bypassed by a new caller, a method that does not exist cannot.
   */
  async listRules(ctx: RequestContext, kind?: string): Promise<QualificationRuleView[]> {
    const companyId = await this.companyOf(ctx);
    const rows = await this.rules
      .find({ companyId, deletedAt: null, ...(kind ? { kind } : {}) })
      .sort({ kind: 1, rank: 1 })
      .exec();
    return rows.map((row) => this.ruleView(row));
  }

  /**
   * The company's carrier rules (AC-5, AC-6).
   *
   * Seeded per company and idempotent: a company that already has rules of a kind is left alone,
   * so a redeployment cannot put back a tier somebody removed.
   */
  async seedForCompany(companyId: string): Promise<number> {
    if (await this.rules.exists({ companyId, deletedAt: null })) return 0;

    const tiers = SEED_PRODUCTION_CLUB_TIERS.map((tier) => ({
      companyId,
      scope: 'company' as const,
      kind: 'production_club' as const,
      code: tier.code,
      name: tier.name,
      appliesToOrgLevelCodes: [],
      criteriaGroups: [{
        mode: 'all' as const,
        criteria: [{
          metricKey: 'APE_ACHIEVED',
          comparator: 'gte' as const,
          value: tier.minAnnualApe,
          unit: 'idr_minor',
        }],
      }],
      groupMode: 'all' as const,
      reward: tier.reward,
      rank: tier.rank,
      waitingOnMetrics: [],
      effectiveFrom: null,
      effectiveTo: null,
      deletedAt: null,
    }));

    const moc = SEED_MOC_RULES.map((rule, index) => {
      const criteriaGroups = rule.criteriaGroups.map((group) => ({
        mode: group.mode,
        criteria: group.criteria.map((c) => ({
          metricKey: c.metricKey,
          comparator: c.comparator,
          value: c.value,
          // Where the registry does not define it yet, the unit is the one the carrier states.
          unit: metricByKey(c.metricKey)?.unit ?? (c.value > 1_000_000 ? 'idr_minor' : 'count'),
        })),
      }));
      return {
        companyId,
        scope: 'company' as const,
        kind: 'moc' as const,
        code: rule.code,
        name: rule.name,
        appliesToOrgLevelCodes: [...rule.appliesToOrgLevelCodes],
        criteriaGroups,
        groupMode: rule.groupMode,
        reward: '',
        rank: index + 1,
        // Recorded rather than hidden: a rule whose inputs do not exist can never pass, and a
        // screen showing it as an ordinary rule would tell somebody they had failed something
        // this product cannot measure. The prototype's answer was to fabricate the inputs.
        waitingOnMetrics: [...new Set(
          criteriaGroups.flatMap((g) => g.criteria)
            .map((c) => c.metricKey)
            .filter((key) => metricByKey(key) === undefined),
        )],
        effectiveFrom: null,
        effectiveTo: null,
        deletedAt: null,
      };
    });

    await this.rules.insertMany([...tiers, ...moc]);
    return tiers.length + moc.length;
  }

  // -------------------------------------------------------------------- internals

  private async setStatus(
    ctx: RequestContext, id: string, status: 'active' | 'archived',
  ): Promise<CampaignView> {
    const updated = await this.campaigns.updateById(ctx, id, {
      $set: { status, archivedAt: status === 'archived' ? this.clock.now() : null },
      $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Campaign');
    await this.record(ctx, `campaign.${status === 'archived' ? 'archived' : 'restored'}`, updated, {
      code: updated.code,
    });
    return this.view(updated);
  }

  private async companyOf(ctx: RequestContext): Promise<string> {
    const kpm = await this.kpms.findById(ctx.kpmId).select('companyId').lean().exec();
    const companyId = (kpm as { companyId?: string } | null)?.companyId;
    if (!companyId) throw new NotFoundException('Kpm');
    return companyId;
  }

  /** Every office role is refused a company-scoped campaign by the API, not just by the screen. */
  refuseCompanyScope(scope: unknown): void {
    if (scope === 'company') {
      throw new ForbiddenException(
        'A company campaign belongs to your insurer. Your office runs its own campaigns; it does '
        + 'not create or edit theirs.',
      );
    }
  }

  private requirementView(r: CheckedRequirement | Record<string, unknown>): RequirementView {
    const metricKey = String((r as CheckedRequirement).metricKey);
    return {
      metricKey,
      metricName: metricByKey(metricKey)?.name ?? metricKey,
      comparator: String((r as CheckedRequirement).comparator),
      value: Number((r as CheckedRequirement).value),
      unit: String((r as CheckedRequirement).unit),
    };
  }

  private view(row: CampaignDocument): CampaignView {
    const now = this.clock.now().getTime();
    const phase = now < row.startsAt.getTime()
      ? 'upcoming' as const
      : (now <= row.endsAt.getTime() ? 'running' as const : 'ended' as const);

    return {
      id: String(row._id),
      code: row.code,
      title: row.title,
      description: row.description,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      phase,
      requirements: row.requirements.map((r) => this.requirementView(r)),
      reward: row.reward,
      status: row.status,
      version: row.version,
    };
  }

  private ruleView(row: QualificationRuleDocument): QualificationRuleView {
    return {
      id: String(row._id),
      kind: row.kind,
      code: row.code,
      name: row.name,
      appliesToOrgLevelCodes: [...row.appliesToOrgLevelCodes],
      criteriaGroups: row.criteriaGroups.map((g) => ({
        mode: g.mode,
        criteria: g.criteria.map((c) => this.requirementView(c)),
      })),
      groupMode: row.groupMode,
      reward: row.reward,
      rank: row.rank,
      waitingOnMetrics: [...row.waitingOnMetrics],
    };
  }

  private record(
    ctx: RequestContext, action: string, row: CampaignDocument, after: Record<string, unknown>,
  ) {
    return this.audit.record(ctx, {
      action, targetCollection: 'campaigns', targetId: String(row._id), after,
    });
  }
}
