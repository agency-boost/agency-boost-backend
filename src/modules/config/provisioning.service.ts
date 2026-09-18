import { Injectable, Logger } from '@nestjs/common';
import type { SeedRecord } from './company-template.schema';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  SEED_ACTIVITY_CATEGORIES, SEED_ACTIVITY_TYPES, SEED_LEAD_STATUSES,
  SEED_RATIO_DEFINITIONS,
  type SeedActivityCategory, type SeedActivityType, type SeedLeadStatus, type SeedRatioDefinition,
  defaultDisplayUnitFor, resolveDisplayUnit,
} from '@/domain/constants';
import { ActivityCategory, ActivityCategoryDocument } from './activity-category.schema';
import { ActivityType, ActivityTypeDocument } from './activity-type.schema';
import { LeadStatus, LeadStatusDocument } from './lead-status.schema';
import { RatioDefinition, RatioDefinitionDocument } from './ratio-definition.schema';
import { ConfigSnapshot, ConfigSnapshotDocument } from './config-snapshot.schema';
import { CompanyTemplate, CompanyTemplateDocument } from './company-template.schema';
import {
  ActivationTemplate, ActivationTemplateDocument,
} from '@/modules/activation/activation-template.schema';
import { EventType, EventTypeDocument } from '@/modules/events/event.schema';
import {
  CapabilityCatalog, CapabilityCatalogDocument,
} from '@/modules/capability/capability.schema';
import {
  capabilityLadderProblems, capabilitySeedDocument, defaultCapabilityLadder,
  type CapabilityLadderPayload,
} from '@/modules/capability/capability-payload';
import {
  defaultEventTypes, eventTypeSeedDocuments, eventTypesProblems, type EventTypesPayload,
} from '@/modules/events/event-types-payload';
import {
  qualificationRuleSeedDocuments, type CampaignKindsPayload,
} from '@/modules/campaigns/campaign-kinds-payload';
import {
  QualificationRule, QualificationRuleDocument,
} from '@/modules/campaigns/campaign.schema';
import {
  activationChecklistProblems, activationSeedAspects, activationTrainingLinks,
  defaultActivationChecklist, type ActivationChecklistPayload,
} from '@/modules/activation/activation-payload';
import { TenantConfigService } from './tenant-config.service';
import {
  TrainingCategory, TrainingCategoryDocument,
} from '@/modules/training/training-category.schema';
import { TrainingSkill, TrainingSkillDocument } from '@/modules/training/training-skill.schema';
import { TrainingModule, TrainingModuleDocument } from '@/modules/training/training-module.schema';
import {
  defaultTrainingTaxonomy, trainingSeedDocuments, trainingTaxonomyProblems,
  type TrainingTaxonomyPayload,
} from '@/modules/training/training-payload';

export interface ProvisionedTaxonomy {
  categories: number;
  types: number;
  /** What was actually copied — what the ratios must be checkable against. */
  typeCodes: string[];
  /** The template it came from, or a `null` version when the platform defaults were used. */
  seededFrom: SeedRecord;
}

/** What one kind's seed copied, and from which published version (P5-T12). */
export interface ProvisionedKind {
  rows: number;
  seededFrom: SeedRecord;
}

/** The training seed also hands back what it copied, so the checklist's links are checkable. */
export interface ProvisionedTraining extends ProvisionedKind {
  /** The codes of the modules agents are offered — published and active. */
  publishedModuleCodes: string[];
}

/**
 * The record of what a seed read, taken from the **same** template document it copied.
 *
 * Returned by each seed rather than looked up afterwards: a second query could land on a
 * version published in between, and then the record would describe something the office was
 * never built from.
 */
const recordOf = (template: { _id: unknown; version: number } | null): SeedRecord => ({
  templateId: template ? String(template._id) : null,
  version: template ? template.version : null,
});

interface ActivityTaxonomyPayload {
  categories?: SeedActivityCategory[];
  types?: SeedActivityType[];
}

/**
 * Filling a brand-new office with a taxonomy to work against (P4-T1, ADR-0018).
 *
 * **Copied, not referenced.** `multi-tenancy-and-scoping.md` has said "copy-on-provision,
 * not reference" since Phase 0: the office owns its copy from this moment and may rename,
 * reorder, add and archive freely, and publishing a new template later does not reach back
 * into it.
 *
 * **From its own company's template, falling back to the platform defaults.** A company
 * that has published nothing must still be able to have an office — the alternative makes
 * the first office of every new company unreachable, gated behind somebody remembering to
 * publish a preset first. So the fallback is not a convenience: without it, ADR-0018 would
 * have made the product unusable for every new insurer on day one. Which source was used is
 * recorded on the office, so "who is on a stale taxonomy" stays answerable.
 *
 * **Written on the models, not through the tenant repository, and deliberately.** The
 * office is being created — there is no request context scoped to it yet, and the caller
 * is a Super Admin who is in no tenant at all. `kpmId` is supplied explicitly on every
 * document here, which is what `raw-writes.tenancy.spec.ts` requires of a raw write.
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);

  constructor(
    @InjectModel(ActivityCategory.name)
    private readonly categories: Model<ActivityCategoryDocument>,
    @InjectModel(ActivityType.name) private readonly types: Model<ActivityTypeDocument>,
    @InjectModel(LeadStatus.name) private readonly leadStatuses: Model<LeadStatusDocument>,
    @InjectModel(RatioDefinition.name) private readonly ratios: Model<RatioDefinitionDocument>,
    @InjectModel(ConfigSnapshot.name)
    private readonly snapshots: Model<ConfigSnapshotDocument>,
    @InjectModel(CompanyTemplate.name)
    private readonly templates: Model<CompanyTemplateDocument>,
    @InjectModel(TrainingCategory.name)
    private readonly trainingCategories: Model<TrainingCategoryDocument>,
    @InjectModel(TrainingSkill.name) private readonly trainingSkills: Model<TrainingSkillDocument>,
    @InjectModel(TrainingModule.name) private readonly trainingModules: Model<TrainingModuleDocument>,
    @InjectModel(ActivationTemplate.name)
    private readonly activationTemplates: Model<ActivationTemplateDocument>,
    @InjectModel(EventType.name) private readonly eventTypes: Model<EventTypeDocument>,
    @InjectModel(CapabilityCatalog.name)
    private readonly capabilityCatalogs: Model<CapabilityCatalogDocument>,
    @InjectModel(QualificationRule.name)
    private readonly rules: Model<QualificationRuleDocument>,
    private readonly clock: Clock,
    // Reads the rows this service has just written, and renders them the way agents will
    // read them — one renderer, so the snapshot and the live read cannot disagree.
    private readonly renderer: TenantConfigService,
  ) {}

  /**
   * Publish the copy a brand-new office starts on (P4-T6).
   *
   * Written at provisioning rather than waiting for an Owner to press Publish: an office
   * whose agents see nothing until somebody notices a button is a worse first day than one
   * that simply works. The payload is rendered here from what was just copied, so it is
   * consistent by construction.
   */
  async publishInitialSnapshotFor(kpmId: string, ctx: RequestContext): Promise<void> {
    const payload = await this.renderer.read(ctx);
    await this.snapshots.create({
      kpmId,
      version: 1,
      sourceVersion: payload.version,
      payload: payload as unknown as Record<string, unknown>,
      publishedAt: this.clock.now(),
      // Nobody pressed anything. Attributing it to the Super Admin who created the office
      // would say they reviewed a taxonomy they have not seen.
      publishedBy: null,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
    });
  }

  /**
   * The newest **published** template of a kind for a company, or nothing.
   *
   * Published, not newest: a draft is somebody's work in progress, and seeding an office
   * from one would ship an unfinished taxonomy to real agents.
   */
  private async publishedTemplate(companyId: string, kind: string) {
    return this.templates
      .findOne({ companyId, kind, status: 'published', deletedAt: null })
      .sort({ version: -1 })
      .exec();
  }

  /**
   * The two lead pipelines (P4-T3).
   *
   * Same rule as the taxonomy: from the company's published template, or the platform
   * defaults. A pipeline with no terminal stage is refused rather than copied — *mark
   * successful* is gated on it, and an office whose leads can never be closed would look
   * like a leads bug for weeks before anybody traced it to a template.
   */
  async seedLeadPipelines(kpmId: string, companyId: string): Promise<ProvisionedKind> {
    const template = await this.publishedTemplate(companyId, 'lead_pipeline');
    const fromTemplate = (template?.payload as { statuses?: SeedLeadStatus[] })?.statuses;
    const statuses = fromTemplate?.length ? fromTemplate : SEED_LEAD_STATUSES;

    for (const pipeline of ['sales', 'recruitment'] as const) {
      const terminals = statuses.filter((s) => s.pipeline === pipeline && s.isTerminal);
      if (terminals.length !== 1) {
        throw new Error(
          `The published lead pipeline template for company ${companyId} gives the `
            + `${pipeline} pipeline `
            + `${terminals.length} terminal stages. It needs exactly one: it is what gates `
            + 'marking a lead successful.',
        );
      }
    }

    await this.leadStatuses.insertMany(statuses.map((s) => ({
      kpmId,
      pipeline: s.pipeline,
      code: s.code,
      label: s.label,
      rank: s.rank,
      isTerminal: s.isTerminal,
      version: 1,
      status: 'active',
      archivedAt: null,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
    })));
    return { rows: statuses.length, seededFrom: recordOf(template) };
  }

  async seedActivityTaxonomy(kpmId: string, companyId: string): Promise<ProvisionedTaxonomy> {
    const template = await this.publishedTemplate(companyId, 'activity_taxonomy');

    const payload = (template?.payload ?? {}) as ActivityTaxonomyPayload;
    const categories = payload.categories?.length ? payload.categories : SEED_ACTIVITY_CATEGORIES;
    const types = payload.types?.length ? payload.types : SEED_ACTIVITY_TYPES;

    if (!template) {
      // Worth a line in the log rather than silence: it is the normal state of a brand-new
      // company, and the wrong thing to discover from an office's taxonomy looking odd.
      this.logger.log(
        `Company ${companyId} has published no activity taxonomy; seeding office ${kpmId} `
          + 'from the platform defaults.',
      );
    }

    await this.categories.insertMany(categories.map((c) => ({
      kpmId,
      code: c.code,
      label: c.label,
      displayOrder: c.displayOrder,
      version: 1,
      status: 'active',
      archivedAt: null,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
    })));

    // Only types whose category actually arrived. A template naming a category it does not
    // define would otherwise create a type nothing can group, and it would surface as a
    // blank heading on the capture screen rather than as the bad template it is.
    const known = new Set(categories.map((c) => c.code));
    const usable = types.filter((t) => known.has(t.categoryCode));
    if (usable.length !== types.length) {
      this.logger.warn(
        `Template for company ${companyId} names ${types.length - usable.length} activity `
          + 'type(s) in categories it does not define. They were not copied.',
      );
    }

    await this.types.insertMany(usable.map((t) => ({
      kpmId,
      code: t.code,
      categoryCode: t.categoryCode,
      label: t.label,
      description: t.description ?? null,
      displayOrder: t.displayOrder,
      version: 1,
      status: 'active',
      archivedAt: null,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
    })));

    return {
      categories: categories.length,
      types: usable.length,
      typeCodes: usable.map((t) => t.code),
      seededFrom: recordOf(template),
    };
  }

  /**
   * The training taxonomy (P5-T1, ADR-0029): categories, skills and modules.
   *
   * **From the company's published template exactly as published**, or from the domain
   * defaults when it has published none. Not "defaults when a list is empty", as the activity
   * taxonomy reads it: a company may publish a category with nothing in it yet, and that is a
   * choice to copy, not a gap to fill.
   *
   * A published template that would produce a broken tree is refused rather than copied. Publish
   * already refuses one (`TemplateService`), so this can only be a template older than that
   * check — and a skill under a category that does not exist would render on no screen.
   */
  /**
   * The capability catalog a new office starts with (P5-T8, ADR-0025).
   *
   * From the company's published `capability_ladder` where there is one, else the defaults — and
   * **refused when that payload would produce a broken office** (AC-5). A catalog with no stages,
   * or two items sharing a code, reaches every office created afterwards and nothing says so until
   * a leader opens an assessment and finds it cannot be scored.
   *
   * Two offices seeded from the same version hold **identical item codes** (AC-3), because the
   * codes come from the payload rather than being minted per office.
   */
  async seedCapabilityCatalog(kpmId: string, companyId: string): Promise<SeedRecord> {
    const template = await this.publishedTemplate(companyId, 'capability_ladder');
    const problems = template ? capabilityLadderProblems(template.payload) : [];
    if (problems.length) {
      throw new Error(
        `The published capability catalog for company ${companyId} would produce a broken office: `
          + problems.join(' '),
      );
    }
    const payload = template
      ? (template.payload as unknown as CapabilityLadderPayload)
      : defaultCapabilityLadder();

    await this.capabilityCatalogs.create(capabilitySeedDocument(kpmId, payload));
    return recordOf(template);
  }

  /**
   * The event types a new office starts with (P5-T6, P5-T9 AC-4).
   *
   * From the company's published `event_types` where there is one, else the platform defaults —
   * ADR-0034 puts them on the Company template's Events tab, because an insurer that runs
   * *Product launch* and not *Community* should not hand every office a type it never uses.
   *
   * Seeded rather than left empty, because an office with no event type has nothing to file an
   * event under, and its Events screen would say so on day one for a reason nobody chose.
   */
  async seedEventTypes(kpmId: string, companyId: string): Promise<ProvisionedKind> {
    const template = await this.publishedTemplate(companyId, 'event_types');
    const problems = template ? eventTypesProblems(template.payload) : [];
    if (problems.length) {
      throw new Error(
        `The published event types for company ${companyId} would produce a broken office: `
          + problems.join(' '),
      );
    }
    const payload = template
      ? (template.payload as unknown as EventTypesPayload)
      : defaultEventTypes();

    const rows = eventTypeSeedDocuments(kpmId, payload);
    await this.eventTypes.insertMany(rows);
    return { rows: rows.length, seededFrom: recordOf(template) };
  }

  /**
   * Apply a published `campaign_kinds` template to the company's rules (P5-T9 AC-4).
   *
   * **Applied at publish, not at provisioning, and that is not an inconsistency.** Every other kind
   * is copied into a new office because the rows live in the office. Carrier rules do not: they are
   * company-partitioned and read live by every office (ADR-0026), so there is nothing to copy and
   * nowhere to copy it to. Seeding them at company creation would also be too early to be useful —
   * a template belongs to a company, so no company can have one published before it exists.
   *
   * **A rule the payload no longer names is soft-deleted, never removed** (invariant 6): a standing
   * that qualified under it is still a standing, and the row has to stay readable to render it.
   */
  async applyCampaignKinds(
    companyId: string, payload: CampaignKindsPayload,
  ): Promise<{ written: number; retired: number }> {
    const wanted = qualificationRuleSeedDocuments(companyId, payload);
    const keep = new Set(wanted.map((r) => `${r.kind}:${r.code}`));

    await Promise.all(wanted.map((rule) => this.rules.updateOne(
      { companyId, kind: rule.kind, code: rule.code },
      // `deletedAt: null` is in the `$set` on purpose: publishing a rule that had been retired
      // brings it back, which is what a Super Admin putting it in the payload means.
      { $set: { ...rule, deletedAt: null } },
      { upsert: true },
    ).exec()));

    const live = await this.rules.find({ companyId, deletedAt: null }).exec();
    const retired = live.filter((row) => !keep.has(`${row.kind}:${row.code}`));
    await Promise.all(retired.map((row) => this.rules.updateOne(
      { _id: row._id }, { $set: { deletedAt: this.clock.now() } },
    ).exec()));

    return { written: wanted.length, retired: retired.length };
  }

  async seedTrainingTaxonomy(kpmId: string, companyId: string): Promise<ProvisionedTraining> {
    const template = await this.publishedTemplate(companyId, 'training_taxonomy');
    const problems = template ? trainingTaxonomyProblems(template.payload) : [];
    if (problems.length) {
      throw new Error(
        `The published training taxonomy for company ${companyId} would produce a broken office: `
          + problems.join(' '),
      );
    }
    const payload = template
      ? (template.payload as unknown as TrainingTaxonomyPayload)
      : defaultTrainingTaxonomy();

    const rows = trainingSeedDocuments(kpmId, payload);
    await this.trainingCategories.insertMany(rows.categories);
    await this.trainingSkills.insertMany(rows.skills);
    await this.trainingModules.insertMany(rows.modules);
    return {
      rows: rows.categories.length + rows.skills.length + rows.modules.length,
      seededFrom: recordOf(template),
      publishedModuleCodes: rows.modules
        .filter((m) => m.publishState === 'published')
        .map((m) => m.code),
    };
  }

  /**
   * The 90-day activation checklist (P5-T3), as the office's **version 1, published**.
   *
   * Seeded **after** the training taxonomy and checked against it, for the reason the ratios are
   * seeded after the activity types: an item linked to a module this office does not offer can never
   * complete, and the hire it stalls has no way to know why. Refusing here puts the failure where
   * the bad template is still the obvious suspect.
   */
  async seedActivationChecklist(
    kpmId: string,
    companyId: string,
    publishedModuleCodes: readonly string[],
  ): Promise<ProvisionedKind> {
    const template = await this.publishedTemplate(companyId, 'activation_checklist');
    const payload = template
      ? (template.payload as unknown as ActivationChecklistPayload)
      : defaultActivationChecklist();

    const problems = template ? activationChecklistProblems(template.payload) : [];
    if (problems.length) {
      throw new Error(
        `The published activation checklist for company ${companyId} would produce a broken office: `
          + problems.join(' '),
      );
    }

    const aspects = activationSeedAspects(payload);
    const offered = new Set(publishedModuleCodes);
    const missing = activationTrainingLinks(aspects).filter((code) => !offered.has(code));
    if (missing.length) {
      throw new Error(
        `The published activation checklist for company ${companyId} links to training modules this `
          + `office is not given: ${missing.join(', ')}.`,
      );
    }

    const now = this.clock.now();
    await this.activationTemplates.create({
      kpmId,
      version: 1,
      status: 'published',
      publishedAt: now,
      aspects,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
      createdAt: now,
      updatedAt: now,
    } as never);

    return {
      rows: aspects.reduce((total, aspect) => total + aspect.items.length, 0),
      seededFrom: recordOf(template),
    };
  }

  /**
   * The five ratios (P4-T2).
   *
   * Seeded **after** the taxonomy and checked against it: a formula naming a code the
   * office does not have would render as `0.0%` on every agent's screen and read as an
   * agent problem rather than a template one. Refusing here puts the failure where the
   * bad template is still the obvious suspect.
   */
  async seedRatioDefinitions(
    kpmId: string,
    companyId: string,
    availableCodes: readonly string[],
  ): Promise<ProvisionedKind> {
    const template = await this.publishedTemplate(companyId, 'ratio_set');
    const fromTemplate = (template?.payload as { ratios?: SeedRatioDefinition[] })?.ratios;
    const ratios = fromTemplate?.length ? fromTemplate : SEED_RATIO_DEFINITIONS;

    /*
     * The unit each ratio is written in (P4-T25). A template published before units existed
     * has none on its ratios, and a published version is immutable, so it is not rewritten
     * — the platform's unit for a seeded code stands in, and the rule's default otherwise.
     * Publishing refuses a unit that does not fit its rule, so a refusal here means a
     * template older than that check.
     */
    const unitOf = (r: SeedRatioDefinition) => {
      const resolved = resolveDisplayUnit(
        r.comparison,
        (r as { displayUnit?: string }).displayUnit ?? defaultDisplayUnitFor(r.code, r.comparison),
      );
      if (resolved.refusal !== undefined) {
        throw new Error(`The ratio ${r.code} for office ${kpmId}: ${resolved.refusal}`);
      }
      return resolved.unit;
    };

    const known = new Set(availableCodes);
    for (const ratio of ratios) {
      unitOf(ratio);
      const missing = [...ratio.numerator, ...ratio.denominator].filter((c) => !known.has(c));
      if (missing.length) {
        throw new Error(
          `The ratio ${ratio.code} names ${missing.join(', ')}, which the activity taxonomy `
            + `copied into office ${kpmId} does not contain. The two templates disagree.`,
        );
      }
    }

    await this.ratios.insertMany(ratios.map((r) => ({
      kpmId,
      code: r.code,
      label: r.label,
      numerator: [...r.numerator],
      denominator: [...r.denominator],
      benchmark: r.benchmark,
      comparison: r.comparison,
      displayUnit: unitOf(r),
      displayOrder: r.displayOrder,
      /*
       * Everything provisioning writes is the platform's, including a company's own
       * published `ratio_set` (ADR-0021). From the office's point of view both are
       * vocabulary handed down, like the company ladder and the KPM template — and both
       * are what a comparison across offices would want in one column. Only an Owner
       * creating a ratio afterwards produces an `office` row.
       */
      origin: 'platform',
      /*
       * What this office was seeded from (ADR-0024). An Owner may change the formula now;
       * this is what a divergence is measured against, and it stays as it was even if the
       * company publishes a new `ratio_set` afterwards (ADR-0018).
       */
      standardNumerator: [...r.numerator],
      standardDenominator: [...r.denominator],
      appliesToOrgLevelCodes: [...(r.appliesToOrgLevelCodes ?? [])],
      version: 1,
      status: 'active',
      archivedAt: null,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
    })));
    return { rows: ratios.length, seededFrom: recordOf(template) };
  }
}
