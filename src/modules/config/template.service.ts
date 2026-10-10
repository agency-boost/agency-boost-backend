import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { activationLinkKinds, resolveDisplayUnit } from '@/domain/constants';
import {
  CompanyTemplate, CompanyTemplateDocument, TemplateKind,
} from './company-template.schema';
import { OfficeCounter, type OfficeStanding, type TemplateScope } from './office-counter.port';
import { NamedTemplateService } from './named-template.service';
import type { NamedTemplateDocument } from './named-template.schema';
import {
  RESERVED_ACTIVITY_CODES, isOfficeTemplateKind, platformDefaultPayload,
} from './template-defaults';
import {
  checkTemplateSummaryGroups, refuseSummaryGroupConflict, type SummaryGrouped,
} from './summary-group';
import { CampaignKindsApplier } from './campaign-kinds.port';
import { trainingTaxonomyProblems } from '@/modules/training/training-payload';
import { activationChecklistProblems } from '@/modules/activation/activation-payload';
import { capabilityLadderProblems } from '@/modules/capability/capability-payload';
import { eventTypesProblems } from '@/modules/events/event-types-payload';
import {
  campaignKindsProblems, type CampaignKindsPayload,
} from '@/modules/campaigns/campaign-kinds-payload';

/** No version to stand against — nothing published, or a history row that is not current. */
const NO_STANDING: OfficeStanding = { behind: 0, unrecorded: 0 };

export interface TemplateView {
  id: string;
  companyId: string;
  /**
   * The named template this kind belongs to (ADR-0115 §3). `null` for `campaign_kinds`, which is the
   * company's, shared by every template.
   */
  templateId: string | null;
  kind: TemplateKind;
  version: number;
  status: 'draft' | 'published' | 'archived';
  payload: Record<string, unknown>;
  publishedAt: string | null;
  /** The version offices are currently seeded from, or `null` if nothing is published. */
  publishedVersion: number | null;
  /**
   * How many of the template's offices were built from an older version of **this kind**, or hold a
   * record of it with no version — which since 13.2 means the template held none of the kind when the
   * office was made, and before 13.2 that the office was built from the platform defaults because the
   * company had published nothing of it (`KpmOfficeCounter`).
   */
  officesBehind: number;
  /**
   * How many were created before provisioning recorded this kind, so whether they are current
   * is not known (P5-T12). Counted apart from `officesBehind` rather than folded into it.
   */
  officesUnrecorded: number;
  /**
   * **`activation_checklist` only: what each link kind does, and whether it completes on its own** (P18.5-T3
   * AC-6, I-80) — the registry, served, so the tab's *Auto* badge reads `live` from the server as the office's
   * screen does, and never re-declares it. `training` answers for every `training:<moduleCode>` link. Absent for
   * every other kind.
   */
  linkKinds?: ReturnType<typeof activationLinkKinds>;
}

/**
 * Which rows one kind of one template is: its named template's, or — for `campaign_kinds`, the
 * company's own — the company's with `templateId: null`.
 */
interface KindAddress {
  companyId: string;
  templateId: string | null;
  kind: TemplateKind;
  /** The named template, for an office kind; `null` for `campaign_kinds`. */
  template: NamedTemplateDocument | null;
}

/**
 * The preset every new office of one company is built from (P4-T8, ADR-0018).
 *
 * **A draft and a published history, not one editable row.** A published version is
 * immutable because an office records the version it was seeded from
 * (`kpms.seededFromVersion`), and a version whose content could change afterwards would
 * make that record a lie. So editing after publishing starts a new draft, and publishing
 * turns that draft into the next version.
 *
 * **Publishing reaches nothing that already exists.** Copy-on-provision means copy *once*:
 * an office that has diverged keeps its divergence, which is the whole point of Phase 4.
 * What publishing changes is what the *next* office starts from — and `officesBehind`
 * says how many are not on it, which is the number the Superadmin prototype puts on its
 * front page (*"6 of 8 existing KPMs haven't reviewed the new default activation
 * checklist"*).
 *
 * **A different collection from an office's own configuration, deliberately.** The tenant
 * screens write `activityTypes` and its peers; this writes a payload that is *copied* into
 * them. The same shape, edited by two people who mean different things by it.
 */
@Injectable()
export class TemplateService {
  constructor(
    @InjectModel(CompanyTemplate.name)
    private readonly templates: Model<CompanyTemplateDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly officesOf: OfficeCounter,
    /** Publishing `campaign_kinds` applies it; every other kind is read at provisioning. */
    private readonly campaignKinds: CampaignKindsApplier,
    /** Which named template a kind route means: the one named, or the company's default (ADR-0115 §3). */
    private readonly named: NamedTemplateService,
  ) {}

  /**
   * What a Super Admin is looking at: the draft if there is one, else the newest published, else
   * **nothing** — `{}`, version 0.
   *
   * *Nothing* is what an office made from this template would get of the kind (ADR-0115 §1, §3): a
   * kind a template never published is empty, and the screen says so rather than showing the
   * platform's presets as if the template held them. *New template from the AgencyBoost defaults*
   * publishes them as version 1 of each kind; a company created with the defaults has its first
   * template made that way.
   *
   * **`campaign_kinds` is the company's** and keeps its own starting point: the carrier rules a company
   * created with the defaults was given, or nothing for a company that declined them.
   *
   * `templateId` names the template; absent, the company's default.
   */
  async read(companyId: string, kind: TemplateKind, templateId?: string | null): Promise<TemplateView> {
    const company = await this.requireCompany(companyId);
    const at = await this.address(companyId, kind, templateId);

    const draft = await this.templates
      .findOne({ ...this.rowsOf(at), status: 'draft', deletedAt: null }).exec();
    const published = await this.newestPublished(at);

    const standing = await this.standing(at, published?.version ?? null);

    if (draft) return this.view(draft, published?.version ?? null, standing);
    if (published) return this.view(published, published.version, standing);

    return {
      id: '',
      companyId,
      templateId: at.templateId,
      kind,
      version: 0,
      status: 'draft',
      /*
       * **A company that declined the defaults gets nothing** (`usesPlatformDefaults`) — on the one
       * kind that is still the company's. Every other kind is a template's, and an unpublished one is
       * empty whoever the company is.
       */
      payload: kind === 'campaign_kinds' && company.usesPlatformDefaults
        ? platformDefaultPayload(kind)
        : {},
      publishedAt: null,
      publishedVersion: null,
      officesBehind: standing.behind,
      officesUnrecorded: standing.unrecorded,
      ...linkKindsOf(kind),
    };
  }

  /**
   * Save the working copy. Creates the draft if this is the first edit since publishing.
   *
   * **An `activity_taxonomy` draft has its summary tiles checked here, not only at publish**
   * (ADR-0064): both fields or neither on each section, and one label per tile. The office's own
   * settings refuse the same body at save, and a Super Admin should not meet a rule an Owner
   * meets earlier.
   */
  async saveDraft(
    ctx: RequestContext,
    companyId: string,
    kind: TemplateKind,
    payload: Record<string, unknown>,
    templateId?: string | null,
  ): Promise<TemplateView> {
    await this.requireCompany(companyId);
    const at = await this.writable(companyId, kind, templateId);
    if (kind === 'activity_taxonomy') payload = this.checkedTaxonomy(payload);

    const existing = await this.templates
      .findOne({ ...this.rowsOf(at), status: 'draft', deletedAt: null }).exec();

    const saved = existing
      ? await this.templates.findOneAndUpdate(
        { _id: existing._id },
        { $set: { payload, updatedBy: ctx.userId } },
        { new: true },
      ).exec()
      : await this.templates.create({
        companyId,
        templateId: at.templateId,
        kind,
        // A draft carries the version it *will* be, so the screen can say so.
        version: ((await this.newestPublished(at))?.version ?? 0) + 1,
        status: 'draft',
        payload,
        publishedAt: null,
        deletedAt: null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });

    await this.audit.record(ctx, {
      action: 'company_template.draft_saved',
      targetCollection: 'companyTemplates',
      targetId: String(saved!._id),
      after: { companyId, templateId: at.templateId, kind },
    });

    const published = await this.newestPublished(at);
    return this.view(
      saved!,
      published?.version ?? null,
      await this.standing(at, published?.version ?? null),
    );
  }

  /**
   * Publish the draft, making it the version new offices are seeded from.
   *
   * The draft row **becomes** the published row rather than being copied into one: the id
   * a Super Admin has been editing is the id offices will record, and two rows where one
   * will do is a second place for them to disagree.
   */
  async publish(
    ctx: RequestContext, companyId: string, kind: TemplateKind, templateId?: string | null,
  ): Promise<TemplateView> {
    await this.requireCompany(companyId);
    const at = await this.writable(companyId, kind, templateId);

    const draft = await this.templates
      .findOne({ ...this.rowsOf(at), status: 'draft', deletedAt: null }).exec();
    if (!draft) {
      throw new BadRequestException(
        'There is nothing to publish. Change something first — the published version is '
          + 'immutable, because offices record which one they were built from.',
      );
    }
    await this.refuseBroken(at, draft.payload);

    const published = await this.newestPublished(at);
    draft.version = (published?.version ?? 0) + 1;
    draft.status = 'published';
    draft.publishedAt = this.clock.now();
    draft.updatedBy = ctx.userId;
    await draft.save();

    /*
     * `campaign_kinds` is applied here rather than at provisioning (P5-T9 AC-4).
     *
     * Every other kind is copied into a new office because the rows live in the office. Carrier
     * rules do not — they are company-partitioned and read live by every office (ADR-0026), so
     * there is nothing to copy and nowhere to copy it to. Publishing **is** the act, which also
     * makes it reach the company's existing offices rather than only its future ones.
     */
    if (kind === 'campaign_kinds') {
      await this.campaignKinds.applyCampaignKinds(
        companyId, draft.payload as unknown as CampaignKindsPayload,
      );
    }

    await this.audit.record(ctx, {
      action: 'company_template.published',
      targetCollection: 'companyTemplates',
      targetId: String(draft._id),
      after: { companyId, templateId: at.templateId, kind, version: draft.version },
    });

    return this.view(draft, draft.version, await this.standing(at, draft.version));
  }

  /** Every version of one kind of one template, newest first. The history panel. */
  async history(
    companyId: string, kind: TemplateKind, templateId?: string | null,
  ): Promise<TemplateView[]> {
    await this.requireCompany(companyId);
    const at = await this.address(companyId, kind, templateId);
    const rows = await this.templates
      .find({ ...this.rowsOf(at), deletedAt: null })
      .sort({ version: -1 })
      .exec();
    const published = rows.find((r) => r.status === 'published');
    return rows.map((r) => this.view(r, published?.version ?? null, NO_STANDING));
  }

  // -------------------------------------------------------------- internals

  /**
   * Which rows a kind route means. An office kind is a named template's — the one named, or the
   * company's default; `campaign_kinds` is the company's own, under no template.
   */
  private async address(
    companyId: string, kind: TemplateKind, templateId?: string | null,
  ): Promise<KindAddress> {
    if (!isOfficeTemplateKind(kind)) return { companyId, templateId: null, kind, template: null };
    const template = await this.named.resolve(companyId, templateId);
    return { companyId, templateId: String(template._id), kind, template };
  }

  /** As {@link address}, refusing a write to an archived template: it is kept to be read, not edited. */
  private async writable(
    companyId: string, kind: TemplateKind, templateId?: string | null,
  ): Promise<KindAddress> {
    const at = await this.address(companyId, kind, templateId);
    if (at.template?.status === 'archived') {
      throw new BadRequestException(
        `${at.template.name} is archived, so it is kept as it is. Edit an active template instead.`,
      );
    }
    return at;
  }

  /** The filter for one kind of one template's rows. */
  private rowsOf(at: KindAddress): Record<string, unknown> {
    return { companyId: at.companyId, templateId: at.templateId, kind: at.kind };
  }

  private async newestPublished(at: KindAddress) {
    return this.templates
      .findOne({ ...this.rowsOf(at), status: 'published', deletedAt: null })
      .sort({ version: -1 })
      .exec();
  }

  private async requireCompany(companyId: string): Promise<CompanyDocument> {
    const company = await this.companies
      .findOne({ _id: companyId, deletedAt: null }).exec()
      // A malformed id arrives from a URL; an uncaught CastError is a 500 and a log line
      // about an unhandled error, which is the wrong story about a typo.
      .catch(() => null);
    if (!company) throw new NotFoundException('Company');
    return company;
  }

  /**
   * Where one template's offices stand against the published version of one kind (ADR-0115 §3: per
   * template). `campaign_kinds` is applied to every office's live carrier rules when it is published,
   * so no office is ever behind it.
   */
  private async standing(at: KindAddress, publishedVersion: number | null): Promise<OfficeStanding> {
    // Nothing published of this kind: there is no version to be behind, or unrecorded against.
    if (publishedVersion === null || !at.template) return NO_STANDING;
    const scope: TemplateScope = this.named.scopeOf(at.template);
    return this.officesOf.standing(at.companyId, at.kind, publishedVersion, scope);
  }

  /**
   * Refuse to publish a template that would produce a broken office.
   *
   * The alternative is discovering it at provisioning, which is the worst possible moment:
   * a Super Admin creating an office for a real branch, and a failure naming a template
   * they published three weeks ago.
   */
  /**
   * Refuse a payload that would produce a broken office.
   *
   * The promise `super-admin/08` makes is that this happens **here**, not at office
   * creation — the alternative is a Super Admin discovering it midway through setting up a
   * real branch, naming a template they published three weeks ago.
   *
   * `ratio_set` had no branch at all until P4-T20, so a ratio naming a code the taxonomy
   * did not declare published cleanly and then threw at provisioning: exactly the failure
   * the promise rules out.
   */
  private async refuseBroken(at: KindAddress, payload: Record<string, unknown>): Promise<void> {
    const { kind } = at;
    this.refuseEmpty(kind, payload);

    /*
     * The training taxonomy (P5-T1): every row by the checker an office's own write meets
     * (ADR-0030), then the references only a whole payload can break. An empty level is fine.
     */
    /*
      * The activation checklist (P5-T3): the same checker an office's own save meets (ADR-0030).
      * A training link is **not** checked here — a template has no office whose modules it could
      * name, so provisioning checks it against the modules it has just copied.
      */
    if (kind === 'activation_checklist') {
      const problems = activationChecklistProblems(payload);
      if (problems.length) throw new BadRequestException(problems.join(' '));
      return;
    }

    if (kind === 'training_taxonomy') {
      const problems = trainingTaxonomyProblems(payload);
      if (problems.length) throw new BadRequestException(problems.join(' '));
      return;
    }

    /*
     * The three kinds P5-T9 finished (AC-4), each by the same checker its provisioning step runs.
     *
     * One checker, two callers, on purpose: publishing and provisioning disagreeing about what is
     * valid is how a template passes here and throws at a Super Admin creating a real branch.
     */
    const checker: Partial<Record<TemplateKind, (p: unknown) => string[]>> = {
      capability_ladder: capabilityLadderProblems,
      event_types: eventTypesProblems,
      campaign_kinds: campaignKindsProblems,
    };
    const check = checker[kind];
    if (check) {
      const problems = check(payload);
      if (problems.length) throw new BadRequestException(problems.join(' '));
      return;
    }

    if (kind !== 'ratio_set') return;

    const { ratios } = payload as {
      ratios?: {
        code: string; numerator: string[]; denominator: string[];
        comparison?: string; displayUnit?: string;
      }[];
    };
    if (!ratios?.length) {
      throw new BadRequestException('A ratio set with no ratios gives every new office nothing to measure.');
    }

    /*
     * Against **this template's published** taxonomy, and the three cascade types every office is
     * given whatever its source (ADR-0115 §2) — because that is what provisioning copies. Checking
     * the taxonomy *draft* would pass here and still break the office, which is the defect wearing a
     * different hat. There is no platform fallback any more: a template with no taxonomy published
     * gives its offices the three and nothing else (ADR-0115 §1).
     */
    const taxonomy = await this.newestPublished({ ...at, kind: 'activity_taxonomy' });
    const source = (taxonomy?.payload ?? {}) as { types?: { code: string }[] };
    const known = new Set([...(source.types ?? []).map((t) => t.code), ...RESERVED_ACTIVITY_CODES]);

    const missing = [...new Set(
      ratios.flatMap((r) => [...(r.numerator ?? []), ...(r.denominator ?? [])]),
    )].filter((code) => !known.has(code));

    if (missing.length) {
      throw new BadRequestException(
        `${missing.join(', ')} is named by a ratio and declared by no activity type in this `
          + `template\u2019s published taxonomy${taxonomy ? ` (version ${taxonomy.version})` : ''}. `
          + 'Publish the taxonomy first, or point the ratio at a code it has.',
      );
    }

    for (const ratio of ratios) {
      /*
       * A unit its rule cannot have (P4-T25) — refused here for the same reason as a
       * missing code: provisioning would otherwise throw it at a Super Admin creating a real
       * branch. An omitted unit is fine; provisioning resolves one.
       */
      if (ratio.displayUnit !== undefined) {
        const resolved = resolveDisplayUnit(
          ratio.comparison === 'band' ? 'band' : 'gte', ratio.displayUnit,
        );
        if (resolved.refusal !== undefined) {
          throw new BadRequestException(`${ratio.code}: ${resolved.refusal}`);
        }
      }
      if (!ratio.denominator?.length) {
        throw new BadRequestException(
          `${ratio.code} has nothing in its denominator. That is a division by zero dressed `
            + 'up as configuration, and it renders as ∞ on every agent\u2019s screen.',
        );
      }
    }
  }

  /**
   * A taxonomy payload with its summary tiles checked and normalised (ADR-0064), and the rest of
   * it untouched. Refuses `VALIDATION_FAILED` for a malformed pair, and
   * `CONFIG_SUMMARY_GROUP_LABEL_MISMATCH` for one tile carrying two labels.
   */
  private checkedTaxonomy(payload: Record<string, unknown>): Record<string, unknown> {
    if (!Array.isArray(payload.categories)) return payload;
    const categories = checkTemplateSummaryGroups(payload.categories);
    refuseSummaryGroupConflict(categories as SummaryGrouped[]);
    return { ...payload, categories };
  }

  private refuseEmpty(kind: TemplateKind, payload: Record<string, unknown>): void {
    if (kind === 'activity_taxonomy') {
      const { categories, types } = payload as { categories?: unknown[]; types?: unknown[] };
      if (!categories?.length || !types?.length) {
        throw new BadRequestException(
          'A taxonomy with no categories or no types would give every new office an empty '
            + 'Log Activity screen.',
        );
      }
      // Again at publish: a draft saved before the rule existed is what would reach offices.
      this.checkedTaxonomy(payload);
    }
    if (kind === 'lead_pipeline') {
      const { statuses } = payload as { statuses?: { pipeline: string; isTerminal: boolean }[] };
      for (const pipeline of ['sales', 'recruitment']) {
        const mine = (statuses ?? []).filter((s) => s.pipeline === pipeline);
        if (mine.length === 0) {
          throw new BadRequestException(`The ${pipeline} pipeline has no stages.`);
        }
        if (mine.filter((s) => s.isTerminal).length !== 1) {
          throw new BadRequestException(
            `The ${pipeline} pipeline needs exactly one stage that closes it. It is what `
              + 'gates marking a lead successful.',
          );
        }
      }
    }
  }

  private view(
    doc: CompanyTemplateDocument,
    publishedVersion: number | null,
    standing: OfficeStanding,
  ): TemplateView {
    return {
      id: String(doc._id),
      companyId: doc.companyId,
      templateId: doc.templateId ?? null,
      kind: doc.kind,
      version: doc.version,
      status: doc.status,
      payload: doc.payload,
      publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
      publishedVersion,
      officesBehind: standing.behind,
      officesUnrecorded: standing.unrecorded,
      ...linkKindsOf(doc.kind),
    };
  }
}

/** The link registry an `activation_checklist` read carries (P18.5-T3 AC-6); nothing for any other kind. */
function linkKindsOf(kind: TemplateKind): Pick<TemplateView, 'linkKinds'> {
  return kind === 'activation_checklist' ? { linkKinds: activationLinkKinds() } : {};
}
