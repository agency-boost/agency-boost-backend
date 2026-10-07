import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { SeedRecord } from './company-template.schema';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  type SeedActivityCategory, type SeedActivityType, type SeedLeadStatus, type SeedRatioDefinition,
  defaultDisplayUnitFor, resolveDisplayUnit,
} from '@/domain/constants';
import { NotFoundException } from '@/common/errors/domain.exception';
import type { KpmStartedFrom } from '@/modules/tenants/kpm.schema';
import { NamedTemplate, NamedTemplateDocument } from './named-template.schema';
import {
  OFFICE_TEMPLATE_KINDS, platformDefaultPayload, withCascadeTypes, type OfficeTemplateKind,
} from './template-defaults';
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
  capabilityLadderProblems, capabilitySeedDocument, type CapabilityLadderPayload,
} from '@/modules/capability/capability-payload';
import {
  eventTypeSeedDocuments, eventTypesProblems, type EventTypesPayload,
} from '@/modules/events/event-types-payload';
import {
  qualificationRuleSeedDocuments, type CampaignKindsPayload,
} from '@/modules/campaigns/campaign-kinds-payload';
import {
  QualificationRule, QualificationRuleDocument,
} from '@/modules/campaigns/campaign.schema';
import {
  activationChecklistProblems, activationSeedAspects, activationTrainingLinks,
  type ActivationChecklistPayload,
} from '@/modules/activation/activation-payload';
import { TenantConfigService } from './tenant-config.service';
import { summaryGroupCodeTaken, summaryGroupConflict } from './summary-group';
import {
  TrainingCategory, TrainingCategoryDocument,
} from '@/modules/training/training-category.schema';
import { TrainingSkill, TrainingSkillDocument } from '@/modules/training/training-skill.schema';
import { TrainingModule, TrainingModuleDocument } from '@/modules/training/training-module.schema';
import {
  trainingSeedDocuments, trainingTaxonomyProblems, type TrainingTaxonomyPayload,
} from '@/modules/training/training-payload';

export interface ProvisionedTaxonomy {
  categories: number;
  types: number;
  /** What was actually copied — what the ratios must be checkable against. */
  typeCodes: string[];
  /** The template it came from, or a `null` version when the source held none of it. */
  seededFrom: SeedRecord;
  /** The cascade codes the source lacked, added with their platform label (ADR-0115 §2). */
  cascadeAdded: string[];
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
 * **Where an office is started from** (ADR-0115 §4): one of its company's named templates, the
 * AgencyBoost defaults, or *Empty*. Absent, the company's default template — what approving a KPM
 * request uses.
 */
export interface StartFrom {
  kind: 'template' | 'defaults' | 'empty';
  /** The template, when `kind` is `template`. */
  templateId?: string | null;
}

/**
 * **One kind's source**: the payload to copy, or `null` when the source holds none of it — an
 * unpublished kind of a template, or *Empty* — and the record of where it came from.
 *
 * Resolved once, before the office row exists, and handed to the seed that writes it: a second read
 * could land on a version published in between, and then the record would describe something the
 * office was never built from.
 */
export interface KindSource {
  payload: Record<string, unknown> | null;
  seededFrom: SeedRecord;
}

/** Everything an office is about to be built from, checked whole before anything is written. */
export interface ProvisioningPlan {
  startedFrom: KpmStartedFrom;
  kinds: Record<OfficeTemplateKind, KindSource>;
}

/** What `provision` wrote: the per-kind record for `kpms.seededFrom`, and the audit's counts. */
export interface Provisioned {
  seededFrom: Record<OfficeTemplateKind, SeedRecord>;
  activityTypes: number;
  cascadeAdded: string[];
}

const NO_RECORD: SeedRecord = { templateId: null, version: null };

/** The AgencyBoost defaults of one kind, as a source. Its record has no template and no version. */
export function defaultSource(kind: OfficeTemplateKind): KindSource {
  return { payload: platformDefaultPayload(kind), seededFrom: { ...NO_RECORD } };
}

/** Nothing of a kind, as a source. */
export function emptySource(templateId: string | null = null): KindSource {
  return { payload: null, seededFrom: { templateId, version: null } };
}

interface ActivityTaxonomyPayload {
  categories?: SeedActivityCategory[];
  types?: SeedActivityType[];
}

/** A section as a template may hold it: the seed's fields, and two an office's own carries (P13.2-T7). */
type TemplateCategory = SeedActivityCategory & {
  description?: string | null;
  appliesToOrgLevelCodes?: string[];
};

/** What would make a lead pipeline payload produce a broken office — one sentence each. */
export function leadPipelineProblems(statuses: readonly SeedLeadStatus[]): string[] {
  const problems: string[] = [];
  // A closed lead is not expected to close. A template saying both would make the Overview's
  // *Expected to close* double-count against *Last month* (ADR-0043).
  const contradictory = statuses.filter((s) => s.isTerminal && s.isLateStage);
  if (contradictory.length) {
    problems.push(
      `${contradictory.map((s) => s.code).join(', ')} is flagged as both the stage that closes its `
        + 'pipeline and a stage still expected to close. A lead can only be one.',
    );
  }
  for (const pipeline of ['sales', 'recruitment'] as const) {
    const terminals = statuses.filter((s) => s.pipeline === pipeline && s.isTerminal);
    if (terminals.length !== 1) {
      problems.push(
        `The ${pipeline} pipeline has ${terminals.length} terminal stages. It needs exactly one: it is `
          + 'what gates marking a lead successful.',
      );
    }
  }
  return problems;
}

/**
 * Filling a brand-new office with a taxonomy to work against (P4-T1, ADR-0018).
 *
 * **Copied, not referenced.** `multi-tenancy-and-scoping.md` has said "copy-on-provision,
 * not reference" since Phase 0: the office owns its copy from this moment and may rename,
 * reorder, add and archive freely, and publishing a new template later does not reach back
 * into it.
 *
 * **From the chosen source and nothing else** (ADR-0115 §1): one of the company's named
 * templates, the AgencyBoost defaults, or *Empty*. **There is no fallback.** It fell back to the
 * platform defaults whenever a company had published nothing of a kind, which made a blank
 * company's offices anything but blank; a kind the source holds none of is now empty in the office,
 * and the AgencyBoost defaults are a source a Super Admin chooses. The one exception is structural:
 * every office has the three cascade activity types (ADR-0115 §2, {@link withCascadeTypes}).
 * Which source was used is recorded on the office, so "who is on a stale taxonomy" stays answerable.
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
    @InjectModel(NamedTemplate.name) private readonly named: Model<NamedTemplateDocument>,
  ) {}

  /**
   * **Resolve and check the whole source** an office will be built from (ADR-0115 §4), before the
   * office row is written — so a refusal leaves no half-made office.
   *
   * `startFrom` absent means the company's default template: what approving a KPM request uses. A
   * template must be the company's and active (an archived one is kept to be read, not offered).
   * Each of its seven kinds is its newest **published** version, or nothing: a draft is somebody's
   * work in progress, and a kind never published is empty in the office (ADR-0115 §3).
   */
  async planFor(companyId: string, startFrom?: StartFrom): Promise<ProvisioningPlan> {
    let plan: ProvisioningPlan;
    if (startFrom?.kind === 'defaults') {
      plan = {
        startedFrom: { source: 'defaults', templateId: null, templateName: null },
        kinds: this.each((kind) => defaultSource(kind)),
      };
    } else if (startFrom?.kind === 'empty') {
      plan = {
        startedFrom: { source: 'empty', templateId: null, templateName: null },
        kinds: this.each(() => emptySource()),
      };
    } else {
      if (startFrom?.kind === 'template' && !startFrom.templateId) {
        throw new BadRequestException('Choose the template the office starts from.');
      }
      const template = await this.templateFor(companyId, startFrom?.templateId ?? null);
      const templateId = String(template._id);
      const rows = await Promise.all(OFFICE_TEMPLATE_KINDS.map((kind) => this.templates
        .findOne({ companyId, templateId, kind, status: 'published', deletedAt: null })
        .sort({ version: -1 })
        .exec()));
      plan = {
        startedFrom: { source: 'template', templateId, templateName: template.name },
        kinds: this.each((_kind, i) => {
          const row = rows[i];
          return row
            ? { payload: row.payload, seededFrom: { templateId, version: row.version } }
            : emptySource(templateId);
        }),
      };
    }
    this.refuseBrokenPlan(plan);
    return plan;
  }

  /**
   * **The whole-source check, over payloads no template publish has seen** (P13.2-T7 AC-5): a
   * template saved from an office's published settings is checked as `planFor` checks a template,
   * before anything is written, so it can never hold what an office made from it would be refused.
   * `sourceName` begins the refusal — *"KPM 0417's published settings would produce a broken
   * office, so nothing was created."* — and a kind absent from `payloads` is a kind held empty.
   */
  checkSource(
    sourceName: string,
    payloads: Partial<Record<OfficeTemplateKind, Record<string, unknown>>>,
  ): void {
    this.refuseBrokenPlan({
      startedFrom: { source: 'template', templateId: null, templateName: sourceName },
      kinds: this.each((kind) => ({ payload: payloads[kind] ?? null, seededFrom: { ...NO_RECORD } })),
    });
  }

  /**
   * **Write an office's configuration from a checked plan**, in the order each kind's checks need:
   * the taxonomy before the ratios that name its codes, the training before the checklist that links
   * to its modules. The snapshot is published afterwards by the caller, from what was written.
   */
  async provision(kpmId: string, plan: ProvisioningPlan): Promise<Provisioned> {
    const { kinds } = plan;
    const taxonomy = await this.seedActivityTaxonomy(kpmId, kinds.activity_taxonomy);
    const leads = await this.seedLeadPipelines(kpmId, kinds.lead_pipeline);
    const ratios = await this.seedRatioDefinitions(kpmId, taxonomy.typeCodes, kinds.ratio_set);
    const training = await this.seedTrainingTaxonomy(kpmId, kinds.training_taxonomy);
    const activation = await this.seedActivationChecklist(
      kpmId, training.publishedModuleCodes, kinds.activation_checklist,
    );
    const events = await this.seedEventTypes(kpmId, kinds.event_types);
    const capability = await this.seedCapabilityCatalog(kpmId, kinds.capability_ladder);
    return {
      seededFrom: {
        activity_taxonomy: taxonomy.seededFrom,
        lead_pipeline: leads.seededFrom,
        ratio_set: ratios.seededFrom,
        training_taxonomy: training.seededFrom,
        activation_checklist: activation.seededFrom,
        event_types: events.seededFrom,
        capability_ladder: capability,
      },
      activityTypes: taxonomy.types,
      cascadeAdded: taxonomy.cascadeAdded,
    };
  }

  private each(make: (kind: OfficeTemplateKind, index: number) => KindSource): Record<OfficeTemplateKind, KindSource> {
    return Object.fromEntries(OFFICE_TEMPLATE_KINDS.map((kind, i) => [kind, make(kind, i)])) as Record<
      OfficeTemplateKind, KindSource
    >;
  }

  /** The named template a plan reads: the one chosen, or the company's default. */
  private async templateFor(companyId: string, templateId: string | null): Promise<NamedTemplateDocument> {
    const template = await this.named
      .findOne(templateId
        ? { _id: templateId, companyId, deletedAt: null }
        : { companyId, isDefault: true, deletedAt: null })
      .exec()
      .catch(() => null);
    if (!template) throw new NotFoundException('Template');
    if (template.status === 'archived') {
      throw new BadRequestException(
        `${template.name} is archived and is not offered. Start the office from an active template.`,
      );
    }
    return template;
  }

  /**
   * **Every check each kind's seed makes, over the whole plan, before anything is written**
   * (ADR-0115 §4). The checklist's training links are checked against the plan's own modules, and the
   * ratios against the plan's taxonomy with the three cascade types in it — what the office will have.
   */
  private refuseBrokenPlan(plan: ProvisioningPlan): void {
    const { kinds } = plan;
    const problems: string[] = [];
    const say = (what: string, found: string[]) => problems.push(...found.map((p) => `${what}: ${p}`));

    const taxonomy = (kinds.activity_taxonomy.payload ?? {}) as ActivityTaxonomyPayload;
    const { categories, types } = withCascadeTypes(taxonomy.categories ?? [], taxonomy.types ?? []);
    const conflict = summaryGroupConflict(categories);
    if (conflict) {
      say('Activity types', [`the summary tile ${conflict.summaryGroupCode} is labelled `
        + `${conflict.labels.join(' and ')}. One tile has one label.`]);
    }
    const taken = summaryGroupCodeTaken(categories);
    if (taken) {
      say('Activity types', [`the summary tile ${taken.summaryGroupCode} has the code of a section `
        + 'outside it. One code is one tile.']);
    }
    const known = new Set(categories.map((c) => c.code));
    const typeCodes = new Set(types.filter((t) => known.has(t.categoryCode)).map((t) => t.code));

    const statuses = (kinds.lead_pipeline.payload as { statuses?: SeedLeadStatus[] } | null)?.statuses;
    if (statuses) say('Lead statuses', leadPipelineProblems(statuses));

    const ratios = (kinds.ratio_set.payload as { ratios?: SeedRatioDefinition[] } | null)?.ratios ?? [];
    for (const ratio of ratios) {
      const resolved = resolveDisplayUnit(
        ratio.comparison,
        (ratio as { displayUnit?: string }).displayUnit ?? defaultDisplayUnitFor(ratio.code, ratio.comparison),
      );
      if (resolved.refusal !== undefined) say('Ratio benchmarks', [`${ratio.code}: ${resolved.refusal}`]);
      const missing = [...ratio.numerator, ...ratio.denominator].filter((c) => !typeCodes.has(c));
      if (missing.length) {
        say('Ratio benchmarks', [`${ratio.code} names ${missing.join(', ')}, which the activity types `
          + 'it would be given do not contain.']);
      }
    }

    let moduleCodes: string[] = [];
    if (kinds.training_taxonomy.payload) {
      const found = trainingTaxonomyProblems(kinds.training_taxonomy.payload);
      say('Training', found);
      if (!found.length) {
        moduleCodes = trainingSeedDocuments('', kinds.training_taxonomy.payload as unknown as TrainingTaxonomyPayload)
          .modules.filter((m) => m.publishState === 'published').map((m) => m.code);
      }
    }
    if (kinds.activation_checklist.payload) {
      const found = activationChecklistProblems(kinds.activation_checklist.payload);
      say('Activation checklist', found);
      if (!found.length) {
        const offered = new Set(moduleCodes);
        const missing = activationTrainingLinks(activationSeedAspects(kinds.activation_checklist.payload))
          .filter((code) => !offered.has(code));
        if (missing.length) {
          say('Activation checklist', [`it links to training modules the office would not be given: `
            + `${missing.join(', ')}.`]);
        }
      }
    }
    if (kinds.event_types.payload) say('Events', eventTypesProblems(kinds.event_types.payload));
    if (kinds.capability_ladder.payload) {
      say('Capability mapping', capabilityLadderProblems(kinds.capability_ladder.payload));
    }

    if (problems.length) {
      const from = plan.startedFrom.templateName ?? (plan.startedFrom.source === 'defaults'
        ? 'The AgencyBoost defaults' : 'The source');
      throw new BadRequestException(
        `${from} would produce a broken office, so nothing was created. ${problems.join(' ')}`,
      );
    }
  }

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
   * The two lead pipelines (P4-T3).
   *
   * From the source, or nothing when it holds none (ADR-0115 §1) — the Owner then builds both, the
   * closing stage of each included. A pipeline with no terminal stage is refused rather than copied
   * — *mark successful* is gated on it, and an office whose leads can never be closed would look
   * like a leads bug for weeks before anybody traced it to a template.
   *
   * The source defaults to the AgencyBoost defaults; `createKpm` always names one.
   */
  async seedLeadPipelines(
    kpmId: string, source: KindSource = defaultSource('lead_pipeline'),
  ): Promise<ProvisionedKind> {
    const statuses = (source.payload as { statuses?: SeedLeadStatus[] } | null)?.statuses ?? [];
    if (statuses.length === 0) return { rows: 0, seededFrom: source.seededFrom };

    const problems = leadPipelineProblems(statuses);
    if (problems.length) {
      throw new Error(`The lead pipeline for office ${kpmId} would be broken: ${problems.join(' ')}`);
    }

    await this.leadStatuses.insertMany(statuses.map((s) => ({
      kpmId,
      pipeline: s.pipeline,
      code: s.code,
      label: s.label,
      rank: s.rank,
      isTerminal: s.isTerminal,
      isLateStage: s.isLateStage ?? false,
      version: 1,
      status: 'active',
      archivedAt: null,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
    })));
    return { rows: statuses.length, seededFrom: source.seededFrom };
  }

  /**
   * The activity taxonomy (P4-T1): the source's categories and types, **and the three cascade types
   * whatever the source** (ADR-0115 §2) — added with their platform label in their platform category
   * where the source lacks them. An *Empty* office has those three and nothing else.
   *
   * The source defaults to the AgencyBoost defaults; `createKpm` always names one.
   */
  async seedActivityTaxonomy(
    kpmId: string, source: KindSource = defaultSource('activity_taxonomy'),
  ): Promise<ProvisionedTaxonomy> {
    const payload = (source.payload ?? {}) as ActivityTaxonomyPayload;
    const { categories, types, added } = withCascadeTypes(payload.categories ?? [], payload.types ?? []);
    if (added.length) {
      this.logger.log(`Office ${kpmId} was given the cascade activity types ${added.join(', ')} (ADR-0115 §2).`);
    }

    /*
     * One tile, one label, one code (ADR-0064). Publishing refuses a template that breaks either,
     * so this is a template older than that check — and an office built from it would refuse its
     * Owner's first edit to the section for a disagreement they never made.
     */
    const conflict = summaryGroupConflict(categories);
    if (conflict) {
      throw new Error(
        `The activity taxonomy for office ${kpmId} labels the summary tile `
          + `${conflict.summaryGroupCode} as ${conflict.labels.join(' and ')}. One tile has one label.`,
      );
    }
    const taken = summaryGroupCodeTaken(categories);
    if (taken) {
      throw new Error(
        `The activity taxonomy for office ${kpmId} gives the summary tile `
          + `${taken.summaryGroupCode} the code of a section outside it. One code is one tile.`,
      );
    }

    await this.categories.insertMany(categories.map((c) => ({
      kpmId,
      code: c.code,
      label: c.label,
      /*
       * What a template saved from an office carries (P13.2-T7, ADR-0115 §5): the section's
       * description and the rungs it is shown to. A template authored on the console carries
       * neither, and reads as today — no description, every rung.
       */
      description: (c as TemplateCategory).description ?? null,
      appliesToOrgLevelCodes: [...((c as TemplateCategory).appliesToOrgLevelCodes ?? [])],
      displayOrder: c.displayOrder,
      // The tile it counts toward, as the template says; none is a tile of its own (ADR-0064).
      summaryGroupCode: c.summaryGroupCode ?? null,
      summaryGroupLabel: c.summaryGroupLabel ?? null,
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
        `The taxonomy for office ${kpmId} names ${types.length - usable.length} activity `
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
      seededFrom: source.seededFrom,
      cascadeAdded: added,
    };
  }

  /**
   * The capability catalog a new office starts with (P5-T8, ADR-0025).
   *
   * From the source — and **refused when that payload would produce a broken office** (AC-5). A
   * catalog with no stages, or two items sharing a code, reaches every office created afterwards and
   * nothing says so until a leader opens an assessment and finds it cannot be scored.
   *
   * **A source holding none gives the office an empty catalog** (ADR-0115 §1), not none: an office
   * with no catalog row reads as the platform's ladder (`CapabilityService.read`, for offices made
   * before catalogs existed), which is exactly the fallback an *Empty* office must not have.
   *
   * Two offices seeded from the same version hold **identical item codes** (AC-3), because the
   * codes come from the payload rather than being minted per office.
   */
  async seedCapabilityCatalog(
    kpmId: string, source: KindSource = defaultSource('capability_ladder'),
  ): Promise<SeedRecord> {
    const payload = (source.payload ?? { stages: [], milestones: [], grids: [] }) as unknown as CapabilityLadderPayload;
    const problems = source.payload ? capabilityLadderProblems(source.payload) : [];
    if (problems.length) {
      throw new Error(
        `The capability catalog for office ${kpmId} would be broken: ${problems.join(' ')}`,
      );
    }
    await this.capabilityCatalogs.create(capabilitySeedDocument(kpmId, payload));
    return source.seededFrom;
  }

  /**
   * The event types a new office starts with (P5-T6, P5-T9 AC-4).
   *
   * From the source — ADR-0034 puts them on the Company template's Events tab, because an insurer
   * that runs *Product launch* and not *Community* should not hand every office a type it never
   * uses. A source holding none gives none (ADR-0115 §1): the office's Events screen says so, and
   * the Owner adds the first.
   */
  async seedEventTypes(
    kpmId: string, source: KindSource = defaultSource('event_types'),
  ): Promise<ProvisionedKind> {
    if (!source.payload) return { rows: 0, seededFrom: source.seededFrom };
    const problems = eventTypesProblems(source.payload);
    if (problems.length) {
      throw new Error(`The event types for office ${kpmId} would be broken: ${problems.join(' ')}`);
    }
    const rows = eventTypeSeedDocuments(kpmId, source.payload as unknown as EventTypesPayload);
    if (rows.length) await this.eventTypes.insertMany(rows);
    return { rows: rows.length, seededFrom: source.seededFrom };
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

  /**
   * The training taxonomy (P5-T1, ADR-0029): categories, skills and modules.
   *
   * **From the source exactly as it holds it**, or nothing. A company may publish a category with
   * nothing in it yet, and that is a choice to copy, not a gap to fill.
   *
   * A payload that would produce a broken tree is refused rather than copied. Publish already
   * refuses one (`TemplateService`), so this can only be a template older than that check — and a
   * skill under a category that does not exist would render on no screen.
   */
  async seedTrainingTaxonomy(
    kpmId: string, source: KindSource = defaultSource('training_taxonomy'),
  ): Promise<ProvisionedTraining> {
    if (!source.payload) return { rows: 0, seededFrom: source.seededFrom, publishedModuleCodes: [] };
    const problems = trainingTaxonomyProblems(source.payload);
    if (problems.length) {
      throw new Error(`The training taxonomy for office ${kpmId} would be broken: ${problems.join(' ')}`);
    }
    const rows = trainingSeedDocuments(kpmId, source.payload as unknown as TrainingTaxonomyPayload);
    if (rows.categories.length) await this.trainingCategories.insertMany(rows.categories);
    if (rows.skills.length) await this.trainingSkills.insertMany(rows.skills);
    if (rows.modules.length) await this.trainingModules.insertMany(rows.modules);
    return {
      rows: rows.categories.length + rows.skills.length + rows.modules.length,
      seededFrom: source.seededFrom,
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
   *
   * **A source holding none gives the office no checklist** (ADR-0115 §8), and an office with no
   * published checklist creates no activation: the Owner's first publish starts them.
   */
  async seedActivationChecklist(
    kpmId: string,
    publishedModuleCodes: readonly string[],
    source: KindSource = defaultSource('activation_checklist'),
  ): Promise<ProvisionedKind> {
    if (!source.payload) return { rows: 0, seededFrom: source.seededFrom };
    const payload = source.payload as unknown as ActivationChecklistPayload;

    const problems = activationChecklistProblems(source.payload);
    if (problems.length) {
      throw new Error(`The activation checklist for office ${kpmId} would be broken: ${problems.join(' ')}`);
    }

    const aspects = activationSeedAspects(payload);
    const offered = new Set(publishedModuleCodes);
    const missing = activationTrainingLinks(aspects).filter((code) => !offered.has(code));
    if (missing.length) {
      throw new Error(
        `The activation checklist for office ${kpmId} links to training modules it is not given: `
          + `${missing.join(', ')}.`,
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
      seededFrom: source.seededFrom,
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
    availableCodes: readonly string[],
    source: KindSource = defaultSource('ratio_set'),
  ): Promise<ProvisionedKind> {
    const ratios = (source.payload as { ratios?: SeedRatioDefinition[] } | null)?.ratios ?? [];
    if (ratios.length === 0) return { rows: 0, seededFrom: source.seededFrom };

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
    return { rows: ratios.length, seededFrom: source.seededFrom };
  }
}
