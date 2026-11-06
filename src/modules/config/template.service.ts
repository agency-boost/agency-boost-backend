import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, InvalidRequestException, NotFoundException, PermissionDeniedException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { readerOf, type Reader } from '@/common/i18n/reader';
import { joinSentences, prefixed, refiled, render } from '@/common/i18n/sentence';
import type { FieldSentence } from '@/common/validation/fields';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import {
  ACTIVATION_TRAINING_LINK_PREFIX, activationLinkKinds, RECRUITMENT, resolveDisplayUnit, SEED_ACTIVITY_TYPES,
  type RecruitmentPlaybookBody, type SeedActivityCategory, type SeedActivityType,
} from '@/domain/constants';
import {
  CompanyTemplate, CompanyTemplateDocument, TemplateKind,
} from './company-template.schema';
import { OfficeCounter, type OfficeStanding, type TemplateScope } from './office-counter.port';
import { NamedTemplateService, type NamedTemplateView } from './named-template.service';
import type { NamedTemplateDocument } from './named-template.schema';
import {
  isNamedTemplateKind, isOfficeTemplateKind, platformDefaultPayload, withCascadeTypes, type NamedTemplateKind,
} from './template-defaults';
import { checkPlaybookBody } from '@/modules/recruitment/recruitment-playbook-input';
import { defaultPlaybookBody } from '@/modules/recruitment/recruitment-playbook-defaults';
import { recruitmentVocabulary, type RecruitmentVocabulary } from '@/modules/recruitment/recruitment-plan';
import {
  checkTemplateSummaryGroups, refuseSummaryGroupConflict, type SummaryGrouped,
} from './summary-group';
import { bindingOfPayload, bindingProblems, defaultBinding } from './activity-binding';
import { CampaignKindsApplier } from './campaign-kinds.port';
import { trainingTaxonomyProblems } from '@/modules/training/training-payload';
import { activationChecklistProblems } from '@/modules/activation/activation-payload';
import { completesWhenOf } from '@/modules/activation/activation.messages';
import { capabilityLadderProblems } from '@/modules/capability/capability-payload';
import { eventTypesProblems } from '@/modules/events/event-types-payload';
import {
  campaignKindsProblems, type CampaignKindsPayload,
} from '@/modules/campaigns/campaign-kinds-payload';
import { TEMPLATE_REFUSALS } from './template.messages';
import { AnalyticsTemplateService, type AnalyticsEditorView } from './analytics-template.service';
import { platformAnalyticsConfig, type AdvancedAnalyticsConfig } from './analytics-config';
import { checkedTemplatePayload } from '@/modules/branding/branding.service';

/** A publish's refusals, in both languages (P18.10-T5 AC-3). */
const SAY = TEMPLATE_REFUSALS.VALIDATION_FAILED;

/** A payload's problems, refused whole: every sentence, one after another, as `join(' ')` said them. */
const refuseProblems = (problems: readonly FieldSentence[]): void => {
  if (problems.length) throw new InvalidRequestException(joinSentences(problems, ' '));
};

/** No version to stand against — nothing published, or a history row that is not current. */
const NO_STANDING: OfficeStanding = { behind: 0, unrecorded: 0 };

/** The newest published version of one kind, as the read carries it beside a draft (P19-T6 AC-3). */
export interface PublishedKindView {
  id: string;
  version: number;
  revision: number;
  payload: Record<string, unknown>;
  publishedAt: string | null;
}

/**
 * **A row at one revision, as a write's filter** (P19-T6). A row written before `revision` existed has no field and
 * reads as `0`, so revision `0` matches it by the field's absence too.
 */
const atRevision = (revision: number): Record<string, unknown> => (revision === 0
  ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
  : { revision });

/** Mongo's duplicate key: the one-version-per-kind index refusing a second draft made at the same moment. */
const isDuplicate = (err: unknown) => (err as { code?: number } | null)?.code === 11000;

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
  /**
   * **How many times the kind's working copy has been written** (P19-T6 AC-2): what a draft save sends back as
   * `expectedRevision`. `0` for nothing saved. `version` is the number a draft will be published as, and does not move
   * when it is saved.
   */
  revision: number;
  status: 'draft' | 'published' | 'archived';
  payload: Record<string, unknown>;
  publishedAt: string | null;
  /** The version offices are currently seeded from, or `null` if nothing is published. */
  publishedVersion: number | null;
  /**
   * **The live version, beside the draft** (P19-T6 AC-3; the 11-03 handover's B1-10): the newest published row of the
   * kind — its version, its payload and when it was published — or `null` where nothing is. On the read only. Where a
   * draft waits, the read answers the draft, and a reader asking what offices are made from today found nothing but
   * the draft.
   */
  published?: PublishedKindView | null;
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
   * **`activation_checklist` only: what each link kind does, and whether it completes on its own** (P18.2-T3
   * AC-6, I-80) — the registry, served, so the tab's *Auto* badge reads `live` from the server as the office's
   * screen does, and never re-declares it. `training` answers for every `training:<moduleCode>` link. Absent for
   * every other kind.
   */
  linkKinds?: ReturnType<typeof activationLinkKinds>;
  /**
   * **`recruitment_playbook` only: what its editor needs beside the words** (ADR-0210 §1) — the AgencyBoost words to
   * start from (*Mulai dari kata-kata AgencyBoost*), the brief's vocabulary the words are keyed by, its chips in the
   * reader's language, and the bounds a publish holds each text to (invariant §7: served, never re-declared). What the
   * retired `GET …/recruitment-playbook` served. Absent for every other kind.
   */
  playbook?: PlaybookEditorView;
  /**
   * **`advanced_analytics` only: what its editor needs beside the payload** (P19.5-T1; ADR-0214 §1): the KPMs that read
   * the template, the kodes they hold data for (the locks), *Dipakai di*, the next month and the bounds. On the read, a
   * draft save and a publish, for a Super Admin's request. Absent for every other kind.
   */
  analytics?: AnalyticsEditorView;
}

/** What a playbook section's editor reads beside its payload (ADR-0210 §1). */
export interface PlaybookEditorView {
  defaults: RecruitmentPlaybookBody;
  vocabulary: RecruitmentVocabulary;
  limits: { textMax: number; benefitsMax: number };
}

/**
 * **The order *Terbitkan semua* publishes in** (ADR-0185 §3): the activity taxonomy before the ratio set, because a
 * ratio is checked against the template's *published* taxonomy — so a draft type and the ratio built on it go out
 * together, as a reader who edited both in one sitting expects; the training taxonomy before the checklist that links
 * its modules. Every one of a template's kinds, once: the seven an office copies, then the recruitment playbook, after
 * `event_types` (ADR-0210 §1).
 */
export const PUBLISH_ORDER = [
  'activity_taxonomy',
  'ratio_set',
  'lead_pipeline',
  'training_taxonomy',
  'activation_checklist',
  'capability_ladder',
  'event_types',
  'recruitment_playbook',
  // P19.6-T1 (ADR-0218 §3): *Tampilan* reads no other kind.
  'branding',
  // P19.5-T1 (ADR-0214 §1): last, since it reads no other kind.
  'advanced_analytics',
] as const satisfies readonly NamedTemplateKind[];

/** What *Terbitkan semua* did with one kind (ADR-0185 §3). */
export type PublishAllOutcome =
  /** Its draft is now this version. */
  | { kind: NamedTemplateKind; outcome: 'published'; version: number }
  /** No draft waited: nothing to publish. */
  | { kind: NamedTemplateKind; outcome: 'skipped'; reason: 'no_changes' }
  /** Its draft was refused, as `…/template/:kind/publish` would refuse it — in the reader's language. Still a draft. */
  | { kind: NamedTemplateKind; outcome: 'refused'; error: { code: string; message: string } };

/** *Terbitkan semua*'s answer: the template as it now stands, and what happened to each kind, in publishing order. */
export interface PublishAllView {
  template: NamedTemplateView;
  results: PublishAllOutcome[];
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
    /**
     * The *Advanced analytics* section's own rules (P19.5-T1; ADR-0214 §2, §4, §7). `@Optional` because the specs that
     * build this by hand for another kind need none; a write of the kind without it is refused as a server fault.
     */
    @Optional() private readonly analytics?: AnalyticsTemplateService,
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
  async read(
    companyId: string, kind: TemplateKind, templateId?: string | null, reader: Reader = readerOf(),
    /** The Super Admin's request, for the *Advanced analytics* editor's view (P19.5-T1); absent, the view is left out. */
    ctx?: RequestContext,
  ): Promise<TemplateView> {
    const company = await this.requireCompany(companyId);
    const at = await this.address(companyId, kind, templateId);
    const view = await this.readAt(company, at, reader);
    return ctx ? this.withAnalytics(ctx, at, view) : view;
  }

  private async readAt(company: CompanyDocument, at: KindAddress, reader: Reader): Promise<TemplateView> {
    const { companyId, kind } = at;

    const draft = await this.templates
      .findOne({ ...this.rowsOf(at), status: 'draft', deletedAt: null }).exec();
    const published = await this.newestPublished(at);

    const standing = await this.standing(at, published?.version ?? null);
    // The live version beside whatever is shown (P19-T6 AC-3): a draft no longer hides it.
    const live = { published: published ? publishedOf(published) : null };

    if (draft) return { ...this.view(draft, published?.version ?? null, standing, reader), ...live };
    if (published) return { ...this.view(published, published.version, standing, reader), ...live };

    return {
      id: '',
      companyId,
      templateId: at.templateId,
      kind,
      version: 0,
      revision: 0,
      status: 'draft',
      /*
       * **A company that declined the defaults gets nothing** (`usesPlatformDefaults`) — on the one
       * kind that is still the company's. Every other kind is a template's, and an unpublished one is
       * empty whoever the company is.
       */
      /*
       * The *Advanced analytics* section is never empty (ADR-0214 §3, §9): a template with nothing published of it reads
       * the platform's, as its KPMs do — so the editor opens on the four system columns.
       */
      payload: (kind === 'campaign_kinds' && company.usesPlatformDefaults) || kind === 'advanced_analytics'
        ? platformDefaultPayload(kind)
        : {},
      publishedAt: null,
      publishedVersion: null,
      published: null,
      officesBehind: standing.behind,
      officesUnrecorded: standing.unrecorded,
      ...linkKindsOf(kind, reader),
      ...playbookOf(kind, reader),
    };
  }

  /**
   * Save the working copy. Creates the draft if this is the first edit since publishing.
   *
   * **An `activity_taxonomy` draft has its summary tiles checked here, not only at publish**
   * (ADR-0064): both fields or neither on each section, and one label per tile. The office's own
   * settings refuse the same body at save, and a Super Admin should not meet a rule an Owner
   * meets earlier.
   *
   * **Pinned to the revision the editor read, when it sends one** (P19-T6 AC-2; the 11-03 handover's B1-10):
   * `expectedRevision` is the `revision` of what the editor opened — the draft, else the newest published, else `0`.
   * Somebody else's save or publish since moved it, and this save is refused `409 VERSION_CONFLICT` with nothing
   * written, where the last save used to win. The write is conditional on the revision it read, so of two saves
   * racing on one draft exactly one lands; two first drafts made at once collide on the one-version index, and the
   * second is the same `409` rather than a `500`. Absent, the save lands as it always did.
   */
  async saveDraft(
    ctx: RequestContext,
    companyId: string,
    kind: TemplateKind,
    payload: Record<string, unknown>,
    templateId?: string | null,
    expectedRevision?: number,
  ): Promise<TemplateView> {
    await this.requireCompany(companyId);
    const at = await this.writable(companyId, kind, templateId);
    if (kind === 'activity_taxonomy') payload = this.checkedTaxonomy(payload);
    // P19.5-T1 (ADR-0214 §2): the section's type, its system columns and locks, the aliases a rename leaves.
    if (kind === 'advanced_analytics') payload = await this.requireAnalytics().checkDraft(ctx, companyId, at.templateId!, payload);
    // P19.6-T1 (ADR-0218 §3): *Tampilan*'s groups whole, its colours readable, its images the company's own.
    if (kind === 'branding') payload = checkedTemplatePayload(companyId, payload);

    const existing = await this.templates
      .findOne({ ...this.rowsOf(at), status: 'draft', deletedAt: null }).exec();
    const newest = await this.newestPublished(at);
    const revision = (existing ?? newest)?.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      throw draftMoved(expectedRevision, revision);
    }

    const saved = existing
      ? await this.templates.findOneAndUpdate(
        { _id: existing._id, status: 'draft', deletedAt: null, ...atRevision(revision) },
        { $set: { payload, updatedBy: ctx.userId }, $inc: { revision: 1 } },
        { new: true },
      ).exec()
      : await this.templates.create({
        companyId,
        templateId: at.templateId,
        kind,
        // A draft carries the version it *will* be, so the screen can say so.
        version: (newest?.version ?? 0) + 1,
        revision: revision + 1,
        status: 'draft',
        payload,
        publishedAt: null,
        deletedAt: null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      }).catch((err: unknown) => {
        if (isDuplicate(err)) return null;
        throw err;
      });
    if (!saved) {
      // Published or saved past between the read and the write: the same refusal as a stale pin.
      throw draftMoved(expectedRevision ?? revision, await this.headRevision(at));
    }

    await this.audit.record(ctx, {
      action: 'company_template.draft_saved',
      targetCollection: 'companyTemplates',
      targetId: String(saved._id),
      // P19.5-T1 AC-20: who, when — the entry's own — and the version the draft will be published as.
      after: { companyId, templateId: at.templateId, kind, revision: saved.revision, version: saved.version },
    });

    const published = await this.newestPublished(at);
    return this.withAnalytics(ctx, at, this.view(
      saved,
      published?.version ?? null,
      await this.standing(at, published?.version ?? null),
      ctx.reader,
    ));
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
      throw new InvalidRequestException(SAY.nothingToPublish);
    }
    if (kind === 'recruitment_playbook') {
      /*
       * **Whole before it is published** (ADR-0210 §1; ADR-0125 §2): every profile and hesitation answered, each text
       * within its bounds, by the check the retired company route made at every save. A draft saves as it is typed; the
       * version every KPM made from the template reads is the one that must be whole — stored as the check answers it,
       * every text trimmed.
       */
      draft.payload = checkPlaybookBody(draft.payload) as unknown as Record<string, unknown>;
    } else if (kind === 'advanced_analytics') {
      // P19.5-T1 AC-11 (ADR-0214 §7): whole, and its agent-code pattern tested over every registered code first.
      await this.requireAnalytics().checkPublish(ctx, companyId, at.templateId!, draft.payload);
    } else if (kind === 'branding') {
      // P19.6-T1 (ADR-0218 §3, §5): the version every KPM on the template reads must carry readable colours.
      draft.payload = checkedTemplatePayload(companyId, draft.payload);
    } else {
      await this.refuseBroken(at, draft.payload);
    }

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

    /*
     * P19.5-T1 AC-17 (ADR-0214 §4): live at once for every KPM on the template, existing ones included — so their Owners
     * and Admins are told, when the columns, the archive or the upload rules changed.
     */
    if (kind === 'advanced_analytics' && at.template) {
      await this.requireAnalytics().announce(
        ctx,
        { companyId, id: at.templateId!, name: at.template.name },
        (published?.payload as unknown as AdvancedAnalyticsConfig | undefined) ?? platformAnalyticsConfig(),
        draft.payload as unknown as AdvancedAnalyticsConfig,
        draft.version,
      );
    }

    return this.withAnalytics(ctx, at, this.view(draft, draft.version, await this.standing(at, draft.version), ctx.reader));
  }

  /**
   * **Terbitkan semua** (ADR-0185 §3): every kind of one template that holds a draft, published in
   * {@link PUBLISH_ORDER}, each exactly as its own *Terbitkan* would publish it — the same checks, the same audit row.
   *
   * **A refusal stops only its own kind.** The others go out, and the answer says which were published, which had
   * nothing waiting and which were refused, and why, in the reader's language: the reader fixes the one and publishes
   * it, rather than finding that one empty list held back six good sections. **Reaches nothing that already exists**,
   * as every publish (copy-on-provision). Refused whole before anything is written: `403` without
   * `company_template:write`, `404` for a company or a template that is not the company's, `400` for an archived one.
   */
  async publishAll(ctx: RequestContext, companyId: string, templateId: string): Promise<PublishAllView> {
    if (!can(ctx, 'company_template:write')) throw new PermissionDeniedException('company_template:write');
    await this.requireCompany(companyId);
    const template = await this.named.findOf(companyId, templateId);
    if (template.status === 'archived') throw new InvalidRequestException(SAY.editArchived({ name: template.name }));
    const id = String(template._id);

    const results: PublishAllOutcome[] = [];
    for (const kind of PUBLISH_ORDER) {
      const waiting = await this.templates
        .exists({ companyId, templateId: id, kind, status: 'draft', deletedAt: null }).exec();
      if (!waiting) {
        results.push({ kind, outcome: 'skipped', reason: 'no_changes' });
        continue;
      }
      try {
        const published = await this.publish(ctx, companyId, kind, id);
        results.push({ kind, outcome: 'published', version: published.version });
      } catch (err) {
        // A refusal is the kind's, said; anything else is a fault, and stops the rest.
        if (!(err instanceof DomainException)) throw err;
        results.push({ kind, outcome: 'refused', error: { code: err.code, message: err.messageFor(ctx.reader) } });
      }
    }
    return { template: await this.named.viewOf(companyId, template), results };
  }

  /** Every version of one kind of one template, newest first. The history panel. */
  async history(
    companyId: string, kind: TemplateKind, templateId?: string | null, reader: Reader = readerOf(),
  ): Promise<TemplateView[]> {
    await this.requireCompany(companyId);
    const at = await this.address(companyId, kind, templateId);
    const rows = await this.templates
      .find({ ...this.rowsOf(at), deletedAt: null })
      .sort({ version: -1 })
      .exec();
    const published = rows.find((r) => r.status === 'published');
    return rows.map((r) => this.view(r, published?.version ?? null, NO_STANDING, reader));
  }

  // -------------------------------------------------------------- internals

  /**
   * Which rows a kind route means. An office kind is a named template's — the one named, or the
   * company's default; `campaign_kinds` is the company's own, under no template.
   */
  private async address(
    companyId: string, kind: TemplateKind, templateId?: string | null,
  ): Promise<KindAddress> {
    if (!isNamedTemplateKind(kind)) return { companyId, templateId: null, kind, template: null };
    const template = await this.named.resolve(companyId, templateId);
    return { companyId, templateId: String(template._id), kind, template };
  }

  /** As {@link address}, refusing a write to an archived template: it is kept to be read, not edited. */
  private async writable(
    companyId: string, kind: TemplateKind, templateId?: string | null,
  ): Promise<KindAddress> {
    const at = await this.address(companyId, kind, templateId);
    if (at.template?.status === 'archived') {
      throw new InvalidRequestException(SAY.editArchived({ name: at.template.name }));
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

  /** The revision of what a reader would open now: the draft, else the newest published, else `0`. */
  private async headRevision(at: KindAddress): Promise<number> {
    const draft = await this.templates.findOne({ ...this.rowsOf(at), status: 'draft', deletedAt: null }).exec();
    return (draft ?? await this.newestPublished(at))?.revision ?? 0;
  }

  /** The section's own rules, or a server fault: the kind is never written without them. */
  private requireAnalytics(): AnalyticsTemplateService {
    if (!this.analytics) throw new Error('TemplateService was built without AnalyticsTemplateService.');
    return this.analytics;
  }

  /** An `advanced_analytics` answer with its editor's view (P19.5-T1); any other kind's as it is. */
  private async withAnalytics(ctx: RequestContext, at: KindAddress, view: TemplateView): Promise<TemplateView> {
    if (at.kind !== 'advanced_analytics' || !this.analytics || !at.templateId || !ctx.isSuperAdmin) return view;
    return { ...view, analytics: await this.analytics.editorOf(ctx, at.companyId, at.templateId) };
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
    // The playbook is read live by every KPM made from the template (ADR-0210 §4): none is ever behind it.
    if (!isOfficeTemplateKind(at.kind)) return NO_STANDING;
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

    if (kind === 'activity_taxonomy') {
      this.refuseBrokenBinding(payload);
      return;
    }

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
      refuseProblems(activationChecklistProblems(payload));
      return;
    }

    if (kind === 'training_taxonomy') {
      refuseProblems(trainingTaxonomyProblems(payload));
      return;
    }

    /*
     * The three kinds P5-T9 finished (AC-4), each by the same checker its provisioning step runs.
     *
     * One checker, two callers, on purpose: publishing and provisioning disagreeing about what is
     * valid is how a template passes here and throws at a Super Admin creating a real branch.
     */
    const checker: Partial<Record<TemplateKind, (p: unknown) => FieldSentence[]>> = {
      capability_ladder: capabilityLadderProblems,
      event_types: eventTypesProblems,
      campaign_kinds: campaignKindsProblems,
    };
    const check = checker[kind];
    if (check) {
      refuseProblems(check(payload));
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
      throw new InvalidRequestException(SAY.noRatios);
    }

    /*
     * Against **this template's published** taxonomy, and the bound types every office is given whatever
     * its source (ADR-0115 §2, ADR-0163 §5; `withCascadeTypes`) — because that is what provisioning
     * copies. Checking the taxonomy *draft* would pass here and still break the office, which is the
     * defect wearing a different hat. There is no platform fallback any more: a template with no taxonomy
     * published gives its offices the default binding's three and nothing else (ADR-0115 §1).
     */
    const taxonomy = await this.newestPublished({ ...at, kind: 'activity_taxonomy' });
    const source = (taxonomy?.payload ?? {}) as { categories?: SeedActivityCategory[]; types?: SeedActivityType[] };
    const given = withCascadeTypes(
      source.categories ?? [], source.types ?? [], bindingOfPayload(taxonomy?.payload) ?? defaultBinding(),
    );
    const known = new Set(given.types.map((t) => t.code));

    const missing = [...new Set(
      ratios.flatMap((r) => [...(r.numerator ?? []), ...(r.denominator ?? [])]),
    )].filter((code) => !known.has(code));

    if (missing.length) {
      throw new InvalidRequestException(
        SAY.ratioCodesUndeclared({ codes: missing, version: taxonomy ? taxonomy.version : null }),
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
          // The rule's own words (`resolveDisplayUnit`), after the ratio's code, refused as the publish refuses.
          throw new InvalidRequestException(
            prefixed(`${ratio.code}: `, refiled(resolved.refusal, ErrorCode.VALIDATION_FAILED)),
          );
        }
      }
      if (!ratio.denominator?.length) {
        throw new InvalidRequestException(SAY.noDenominator({ code: ratio.code }));
      }
    }
  }

  /**
   * **The template's activity binding** (ADR-0163 §1, §3): which of its types each cascade role counts, refused
   * `400` by the checker the office's own binding meets (`bindingProblems`). A code must be one of this
   * template's activity types, or one of the platform's, which an office made from it is given with it
   * (`withCascadeTypes`) — the taxonomy provisioning would write. A payload carrying none gives its offices the
   * default binding, and needs no check.
   */
  private refuseBrokenBinding(payload: Record<string, unknown>): void {
    if (payload.bindings === undefined) return;
    const own = ((payload.types ?? []) as { code: string }[]).map((t) => t.code);
    const known = new Set([...own, ...SEED_ACTIVITY_TYPES.map((t) => t.code)]);
    const problems = bindingProblems(payload.bindings, known);
    if (problems.length) {
      throw new InvalidRequestException(SAY.inSection({ section: 'activityBinding', inner: joinSentences(problems, ' ') }));
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
        throw new InvalidRequestException(SAY.taxonomyEmpty);
      }
      // Again at publish: a draft saved before the rule existed is what would reach offices.
      this.checkedTaxonomy(payload);
    }
    if (kind === 'lead_pipeline') {
      const { statuses } = payload as { statuses?: { pipeline: string; isTerminal: boolean }[] };
      for (const pipeline of ['sales', 'recruitment']) {
        const mine = (statuses ?? []).filter((s) => s.pipeline === pipeline);
        if (mine.length === 0) {
          throw new InvalidRequestException(SAY.pipelineNoStages({ pipeline }));
        }
        if (mine.filter((s) => s.isTerminal).length !== 1) {
          throw new InvalidRequestException(SAY.pipelineOneTerminal({ pipeline }));
        }
      }
    }
  }

  private view(
    doc: CompanyTemplateDocument,
    publishedVersion: number | null,
    standing: OfficeStanding,
    reader: Reader,
  ): TemplateView {
    return {
      id: String(doc._id),
      companyId: doc.companyId,
      templateId: doc.templateId ?? null,
      kind: doc.kind,
      version: doc.version,
      revision: doc.revision ?? 0,
      status: doc.status,
      payload: doc.payload,
      publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
      publishedVersion,
      officesBehind: standing.behind,
      officesUnrecorded: standing.unrecorded,
      ...linkKindsOf(doc.kind, reader),
      ...playbookOf(doc.kind, reader),
    };
  }
}

/** The newest published row of a kind, as the read carries it beside the draft (P19-T6 AC-3). */
function publishedOf(doc: CompanyTemplateDocument): PublishedKindView {
  return {
    id: String(doc._id),
    version: doc.version,
    revision: doc.revision ?? 0,
    payload: doc.payload,
    publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
  };
}

/**
 * **A draft save that somebody else's save or publish has moved past** (P19-T6 AC-2): `409 VERSION_CONFLICT`, the
 * revisions in `details` — the one the editor read and the one stored now.
 */
function draftMoved(expectedRevision: number, actualRevision: number): DomainException {
  return new DomainException(
    ErrorCode.VERSION_CONFLICT,
    TEMPLATE_REFUSALS.VERSION_CONFLICT.draftMoved,
    HttpStatus.CONFLICT,
    { expectedRevision, actualRevision },
  );
}

/**
 * The link registry an `activation_checklist` read carries (P18.2-T3 AC-6); nothing for any other kind. **What
 * completes each kind is written for the reader** (P18.10-T7; ADR-0179 §7), the activation module's own sentence
 * (`completesWhenOf`) — the same words the office's checklist serves. A feature kind's label is a page's name, and
 * *Training module* the kind's, the same in both (§A.1, §A.2).
 */
function linkKindsOf(kind: TemplateKind, reader: Reader): Pick<TemplateView, 'linkKinds'> {
  if (kind !== 'activation_checklist') return {};
  const kinds = activationLinkKinds();
  const written = Object.fromEntries(Object.entries(kinds).map(([key, linkKind]) => [key, {
    ...linkKind,
    completesWhen: render(completesWhenOf(key === 'training' ? ACTIVATION_TRAINING_LINK_PREFIX : key), reader),
  }])) as unknown as typeof kinds;
  return { linkKinds: written };
}

/**
 * What a `recruitment_playbook` read carries beside its words (ADR-0210 §1): the AgencyBoost words, the brief's
 * vocabulary in the reader's language and the bounds a publish holds a text to — nothing for any other kind.
 */
function playbookOf(kind: TemplateKind, reader: Reader): Pick<TemplateView, 'playbook'> {
  if (kind !== 'recruitment_playbook') return {};
  return {
    playbook: {
      defaults: defaultPlaybookBody(),
      vocabulary: recruitmentVocabulary(reader),
      limits: { textMax: RECRUITMENT.TEXT_MAX_LENGTH, benefitsMax: RECRUITMENT.BENEFITS_MAX },
    },
  };
}
