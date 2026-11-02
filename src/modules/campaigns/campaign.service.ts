import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import {
  DEFAULT_CAMPAIGN_POSTER, DEFAULT_TENANT_TIMEZONE, SEED_MOC_RULES, SEED_PRODUCTION_CLUB_TIERS, isCampaignMetric,
  metricByKey, type CampaignKind, type CampaignPosterColor, type CampaignSubtype, type CampaignWindow,
} from '@/domain/constants';
import { campaignPhase, inclusiveEnd } from '@/domain/metrics/campaign-window';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { AuditService } from '@/modules/audit/audit.service';
import { Kpm } from '@/modules/tenants/kpm.schema';
import { CampaignDocument, QualificationRule, QualificationRuleDocument } from './campaign.schema';
import { CampaignRepository } from './campaign.repository';
import { checkCampaign, checkCampaignShape, type CheckedRequirement } from './campaign-input';
import { CAMPAIGNS_REFUSALS } from './campaigns.messages';

export interface RequirementView {
  metricKey: string;
  /** The registry's own name, so a screen never has to hold a second copy of the vocabulary. */
  metricName: string;
  comparator: string;
  value: number;
  unit: string;
}

/** A campaign's requirement as the Owner's list reads it: and whether a campaign can measure it (D-evaluable). */
export interface CampaignRequirementView extends RequirementView {
  /** `false` for a requirement stored before the evaluable set existed: the screen badges it *Not measured yet*. */
  measured: boolean;
}

export interface CampaignView {
  id: string;
  code: string;
  title: string;
  description: string;
  startsAt: string;
  /** `null` for a structural campaign with no end (P18.5-T7, D-fields). */
  endsAt: string | null;
  /** Derived on every read (AC-3), never stored. */
  phase: 'upcoming' | 'running' | 'ended';
  requirements: CampaignRequirementView[];
  reward: string;
  status: 'active' | 'archived';
  version: number;
  kind: CampaignKind;
  subtype: CampaignSubtype | null;
  window: CampaignWindow;
  appliesToOrgLevelCodes: string[];
  poster: { emoji: string; color: CampaignPosterColor };
  blurb: string;
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
    /** P18.5-T7: the company's ladder, which a campaign's rungs are checked against. */
    @Optional() private readonly orgLevels: OrgLevelService | null = null,
  ) {}

  async list(ctx: RequestContext, includeArchived = false): Promise<CampaignView[]> {
    requireOffice(ctx);
    const rows = await this.campaigns.find(
      ctx, includeArchived ? {} : { status: 'active' }, { sort: { startsAt: -1 } },
    );
    return rows.map((row) => this.view(row));
  }

  async create(ctx: RequestContext, body: unknown): Promise<CampaignView> {
    const input = checkCampaign(body);
    const timezone = await this.timezoneOf(ctx);
    // P18.5-T7, D-fields: a campaign written without the new fields is a seasonal one over its own dates.
    const whole = {
      kind: 'seasonal' as const, subtype: null, window: 'campaign_dates' as const, appliesToOrgLevelCodes: [],
      poster: { ...DEFAULT_CAMPAIGN_POSTER }, blurb: '', endsAt: null, requirements: [], ...input,
    };
    // The last instant inclusive: an end typed to the minute keeps its last minute (the review, item 8).
    if (whole.endsAt) whole.endsAt = inclusiveEnd(whole.endsAt, timezone);
    await this.checkShape(ctx, { ...whole, startsAt: whole.startsAt as Date }, 'all', timezone);
    if (await this.campaigns.exists(ctx, { code: input.code })) {
      const code = input.code!;
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED, CAMPAIGNS_REFUSALS.VALIDATION_FAILED.codeTaken({ code }),
        HttpStatus.BAD_REQUEST, { field: 'code', violations: [CAMPAIGNS_REFUSALS.VALIDATION_FAILED.codeTakenField({ code })] },
      );
    }
    const created = await this.campaigns.create(ctx, {
      ...whole, version: 1, status: 'active',
    } as never);
    // Before and after (the audit rule): nothing before a create, every field it was written with after.
    await this.record(ctx, 'campaign.created', created, null, auditFields(created, Object.keys(whole)));
    return this.view(created);
  }

  async update(ctx: RequestContext, id: string, body: unknown): Promise<CampaignView> {
    const stored = await this.campaigns.findById(ctx, id);
    if (!stored) throw new NotFoundException('Campaign');
    // A stored requirement sent back unchanged stays, whatever today's rules say of it (the review, item 10).
    const input = checkCampaign(body, {
      partial: true,
      keep: stored.requirements.map((r) => ({
        metricKey: r.metricKey, comparator: r.comparator as CheckedRequirement['comparator'], value: r.value, unit: r.unit,
      })),
    });
    // The code is the identity: a standing that already names it must keep resolving.
    delete (input as { code?: string }).code;
    const timezone = await this.timezoneOf(ctx);
    if (input.endsAt) input.endsAt = inclusiveEnd(input.endsAt, timezone);
    // P18.5-T7: the rules across fields, over the campaign as it will be stored — the whole-month rule and the rungs
    // only where this edit touches them (item 10).
    await this.checkShape(ctx, {
      kind: input.kind ?? stored.kind,
      subtype: input.subtype !== undefined ? input.subtype : stored.subtype,
      window: input.window ?? stored.window,
      startsAt: input.startsAt ?? stored.startsAt,
      endsAt: input.endsAt !== undefined ? input.endsAt : stored.endsAt,
      requirements: input.requirements ?? stored.requirements,
      appliesToOrgLevelCodes: input.appliesToOrgLevelCodes ?? stored.appliesToOrgLevelCodes,
    }, changedFields(input as Record<string, unknown>, stored), timezone);
    const updated = await this.campaigns.updateById(ctx, id, {
      $set: input as never, $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Campaign');
    // Before and after of the fields this edit sent (the audit rule).
    const changed = Object.keys(input);
    await this.record(ctx, 'campaign.updated', updated, auditFields(stored, changed), auditFields(updated, changed));
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
    requireOffice(ctx);
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

  /**
   * **A new company's carrier rules, copied from another company's** (ADR-0164 §4): every live rule of the
   * Template library — its kind, code, name, rungs, criteria, reward, rank and dates — as the new company's own.
   * A copy, never a link: a later change to either company's rules is that company's alone. A company that
   * already has rules is left alone, as `seedForCompany` leaves it.
   */
  async copyRulesFromCompany(sourceCompanyId: string, companyId: string): Promise<number> {
    if (await this.rules.exists({ companyId, deletedAt: null })) return 0;
    const source = await this.rules.find({ companyId: sourceCompanyId, deletedAt: null }).lean().exec();
    if (source.length === 0) return 0;
    await this.rules.insertMany(source.map((rule) => ({
      companyId,
      scope: rule.scope,
      kind: rule.kind,
      code: rule.code,
      name: rule.name,
      appliesToOrgLevelCodes: [...(rule.appliesToOrgLevelCodes ?? [])],
      criteriaGroups: (rule.criteriaGroups ?? []).map((group) => ({
        mode: group.mode,
        criteria: group.criteria.map((c) => ({
          metricKey: c.metricKey, comparator: c.comparator, value: c.value, unit: c.unit,
        })),
      })),
      groupMode: rule.groupMode,
      reward: rule.reward ?? '',
      rank: rule.rank,
      waitingOnMetrics: [...(rule.waitingOnMetrics ?? [])],
      effectiveFrom: rule.effectiveFrom ?? null,
      effectiveTo: rule.effectiveTo ?? null,
      deletedAt: null,
    })));
    return source.length;
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
    await this.record(
      ctx, `campaign.${status === 'archived' ? 'archived' : 'restored'}`, updated,
      { code: updated.code, status: status === 'archived' ? 'active' : 'archived' }, { code: updated.code, status },
    );
    return this.view(updated);
  }

  /** `checkCampaignShape` against the office's calendar and its company's ladder. */
  private async checkShape(
    ctx: RequestContext, shape: Parameters<typeof checkCampaignShape>[0], changed: readonly string[] | 'all', timezone: string,
  ): Promise<void> {
    const office = await this.kpms.findById(ctx.kpmId).select('companyId').lean().exec();
    const o = office as { companyId?: string } | null;
    const ladder = this.orgLevels && o?.companyId ? await this.orgLevels.list(ctx, o.companyId) : null;
    checkCampaignShape(shape, {
      timezone,
      changed,
      // Without the ladder service the rungs named are taken as they are; the API's own wiring always has it.
      rungCodes: ladder ? ladder.map((level) => level.code) : shape.appliesToOrgLevelCodes,
    });
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
      // Company-wide campaigns are deferred beyond v1 (OD-156, ADR-0146): a field this product does not take, so a
      // validation refusal, never a 403 (the review, item 15).
      const said = CAMPAIGNS_REFUSALS.VALIDATION_FAILED.companyWide;
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED, said, HttpStatus.BAD_REQUEST, { field: 'scope', violations: [said] },
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
    return {
      id: String(row._id),
      code: row.code,
      title: row.title,
      description: row.description,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt ? row.endsAt.toISOString() : null,
      phase: campaignPhase(row.startsAt, row.endsAt, this.clock.now()),
      requirements: row.requirements.map((r) => ({
        ...this.requirementView(r), measured: isCampaignMetric(String(r.metricKey)),
      })),
      reward: row.reward,
      status: row.status,
      version: row.version,
      kind: row.kind,
      subtype: row.subtype,
      window: row.window,
      appliesToOrgLevelCodes: [...row.appliesToOrgLevelCodes],
      poster: { emoji: row.poster.emoji, color: row.poster.color },
      blurb: row.blurb,
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
    ctx: RequestContext, action: string, row: CampaignDocument,
    before: Record<string, unknown> | null, after: Record<string, unknown>,
  ) {
    return this.audit.record(ctx, {
      action, targetCollection: 'campaigns', targetId: String(row._id), before, after,
    });
  }

  /** The office's zone, or the platform's when its row names none. */
  private async timezoneOf(ctx: RequestContext): Promise<string> {
    const office = await this.kpms.findById(ctx.kpmId).select('timezone').lean().exec();
    return (office as { timezone?: string } | null)?.timezone ?? DEFAULT_TENANT_TIMEZONE;
  }
}

/** The settings reads are an office's: a Super Admin outside a support session has none (the review, item 20). */
function requireOffice(ctx: RequestContext): void {
  if (!ctx.kpmId) throw new NoMembershipException();
}

/**
 * **What a PATCH actually changes** (the review, item 10): the fields it sends whose values differ from the stored
 * ones — a field sent back as it was is no change, so a requirement list returned unchanged does not hold the stored
 * dates to a rule written after them.
 */
function changedFields(input: Record<string, unknown>, stored: CampaignDocument): string[] {
  const plain = stored.toObject() as unknown as Record<string, unknown>;
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const comparable = (key: string, value: unknown) => (key === 'requirements' && Array.isArray(value)
    ? value.map((r: { metricKey: string; comparator: string; value: number }) => [r.metricKey, r.comparator, r.value])
    : key === 'poster' ? [(value as { emoji: string }).emoji, (value as { color: string }).color] : value);
  return Object.keys(input).filter((key) => !same(comparable(key, input[key]), comparable(key, plain[key])));
}

/** The audited fields of a campaign, as stored: what an edit changed, before and after. */
function auditFields(row: CampaignDocument, keys: readonly string[]): Record<string, unknown> {
  const plain = row.toObject() as unknown as Record<string, unknown>;
  return Object.fromEntries(keys.map((k) => [k, plain[k] ?? null]));
}
