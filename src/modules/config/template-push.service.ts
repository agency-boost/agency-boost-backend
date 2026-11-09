import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Document, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, InvalidRequestException, NotFoundException, PermissionDeniedException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import {
  defaultDisplayUnitFor, resolveDisplayUnit,
  type SeedActivityCategory, type SeedActivityType, type SeedLeadStatus, type SeedRatioDefinition,
} from '@/domain/constants';
import { activationSeedAspects, activationTrainingLinks } from '@/modules/activation/activation-payload';
import { ActivationTemplateRepository } from '@/modules/activation/activation.repository';
import { AssetService } from '@/modules/assets/asset.service';
import { AuditService } from '@/modules/audit/audit.service';
import { capabilitySeedDocument, type CapabilityLadderPayload } from '@/modules/capability/capability-payload';
import { CapabilityCatalogRepository } from '@/modules/capability/capability.repository';
import { eventTypeSeedDocuments, type EventTypesPayload } from '@/modules/events/event-types-payload';
import { EventTypeRepository } from '@/modules/events/event.repository';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { can } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { asContent } from '@/modules/training/training.service';
import { storageKeysOf } from '@/modules/training/training-content';
import { trainingSeedDocuments, type TrainingTaxonomyPayload } from '@/modules/training/training-payload';
import {
  TrainingCategoryRepository, TrainingModuleRepository, TrainingSkillRepository,
} from '@/modules/training/training.repository';
import {
  ActivityBindingRepository, ActivityCategoryRepository, ActivityTypeRepository, LeadStatusRepository,
  RatioDefinitionRepository,
} from './activity.repository';
import { bindingOfPayload, defaultBinding } from './activity-binding';
import { CompanyTemplate, CompanyTemplateDocument } from './company-template.schema';
import { NamedTemplateService, type TemplateOfficeView } from './named-template.service';
import type { NamedTemplateDocument } from './named-template.schema';
import { OfficeCounter, type OfficeSeeds } from './office-counter.port';
import { isOfficeTemplateKind, shortLabelOf, withCascadeTypes, type OfficeTemplateKind } from './template-defaults';
import {
  differencesOf, itemsOfOffice, itemsOfPayload, kindsInOrder, mergeDifferences, ownMaterialDifferences, pushStateOf,
  type OfficeRows, type PushDifference, type PushState,
} from './template-push';
import { TEMPLATE_PUSH_REFUSALS } from './template-push.messages';
import { ANALYTICS_TEMPLATE_REFUSALS } from './analytics-template.messages';
import { TenantConfigService } from './tenant-config.service';
import { PUBLISH_ORDER } from './template.service';
import { TEMPLATE_REFUSALS } from './template.messages';
import { render } from '@/common/i18n/sentence';

const SAY = TEMPLATE_PUSH_REFUSALS.VALIDATION_FAILED;

type Row = Record<string, unknown>;

/**
 * What `syncRows` needs of a configuration kind's tenant repository: its scoped read, create and update. Every one of
 * them injects the KPM from the context — none takes a `kpmId` from here (invariant §1).
 */
interface RowRepository {
  find(ctx: RequestContext, filter: Row): Promise<{ _id: unknown; toObject(): unknown }[]>;
  create(ctx: RequestContext, doc: Row): Promise<unknown>;
  updateById(ctx: RequestContext, id: string, update: Row): Promise<unknown>;
}

/** **Where one KPM stands on one kind**, as the publish dialog lists it (ADR-0208 §4). */
export interface KindStanding {
  kind: OfficeTemplateKind;
  state: PushState;
  /** The version of this template the KPM was last given, `null` where it holds no record of one. */
  givenVersion: number | null;
  newestVersion: number;
  /** `changed` only: what the KPM added, removed or changed, by code. */
  differences: PushDifference[];
  /** `training_taxonomy` only: how many modules show the KPM's own material — *"31 modul memakai materi sendiri"*. */
  ownMaterialModules?: number;
}

/** **One KPM the template answers for, with where it stands on the kinds asked about** (ADR-0208 §4). */
export interface TemplateOfficeStandingView extends TemplateOfficeView {
  /** `changed` when any kind is; `current` when every kind is; else `unchanged`. */
  state: PushState;
  kinds: KindStanding[];
}

/** What a push did for one KPM and one kind (ADR-0208 §4). */
export type ApplyKindOutcome =
  | { kind: OfficeTemplateKind; outcome: 'applied'; version: number; replaced: boolean }
  | { kind: OfficeTemplateKind; outcome: 'skipped'; reason: 'current' }
  | { kind: OfficeTemplateKind; outcome: 'refused'; error: { code: string; message: string } };

export interface ApplyOfficeResult {
  id: string;
  code: string;
  branchName: string;
  results: ApplyKindOutcome[];
  /**
   * The KPM had changes of its own waiting to be published, so what was applied waits with them: it reaches agents when
   * the KPM publishes. `false` where nothing waited, and the push published a version of its own.
   */
  awaitingPublish: boolean;
}

export interface ApplyView {
  templateId: string;
  offices: ApplyOfficeResult[];
}

/** One kind's newest published version of the template. */
interface Newest {
  version: number;
  payload: Record<string, unknown>;
}

/**
 * **A template's newest published sections, applied to the KPMs that already exist when the Super Admin asks**
 * (ADR-0208 §4 to §8; SA R3, SA UI-012).
 *
 * - **Only KPMs made from this template, of its own company** (§6): the offices `OfficeCounter` lists for it. A
 *   built-in template (the Template library's) reaches nobody.
 * - ***Changed by the KPM*** is computed here, by code, on the fields an Owner edits, against the version the KPM was
 *   last given (`kpms.seededFrom[kind]`) — and **computed again when the push applies**, so a KPM that changed since
 *   the dialog was read is not overwritten on the strength of a stale list. A changed KPM not listed in
 *   `replaceChanged` is refused `TEMPLATE_APPLY_UNCONFIRMED` and nothing is written for it.
 * - **What a push writes** (§5): each kind's rows matched by code — written as the template has them, an item only the
 *   KPM has archived (invariant §3), an item new to it added — so codes, and agents' progress by code, are kept
 *   (invariant §4). A training module's `companyContent` becomes the template's material; its `officeContent` is
 *   kept unless the KPM was confirmed, when it moves to the module's history. Then a new configuration version, its
 *   `origin` the push — unless the KPM had changes of its own waiting, which this never publishes for it.
 * - **Audited** in each KPM's scope per kind, and once in the platform's; the Owner and the Admins are told in-app.
 *
 * Every read and write of a KPM's rows goes through its tenant repository, scoped by a Super Admin context *in* that
 * KPM (`RequestContext.superAdminInTenant`) — the push is the Super Admin's own write on the template's company, not a
 * view-as session (ADR-0206 §1).
 */
@Injectable()
export class TemplatePushService {
  constructor(
    private readonly named: NamedTemplateService,
    @InjectModel(CompanyTemplate.name) private readonly templateRows: Model<CompanyTemplateDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    private readonly officesOf: OfficeCounter,
    private readonly activityCategories: ActivityCategoryRepository,
    private readonly activityTypes: ActivityTypeRepository,
    private readonly bindings: ActivityBindingRepository,
    private readonly ratios: RatioDefinitionRepository,
    private readonly leadStatuses: LeadStatusRepository,
    private readonly trainingCategories: TrainingCategoryRepository,
    private readonly trainingSkills: TrainingSkillRepository,
    private readonly trainingModules: TrainingModuleRepository,
    private readonly checklists: ActivationTemplateRepository,
    private readonly capability: CapabilityCatalogRepository,
    private readonly eventTypes: EventTypeRepository,
    private readonly config: TenantConfigService,
    private readonly members: MembershipRepository,
    private readonly assets: AssetService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------- the list (GET …/offices?kind=)

  /**
   * **The KPMs made from the template, each with where it stands on the kinds asked about** (ADR-0208 §4): `unchanged`,
   * `changed` with what differs, or `current`. Kinds the template has published nothing of are left out of `kinds`.
   * `company_template:read`, asked here as well as on the route; `404` for a company or a template that is not the
   * company's; `400` for a kind that is not one.
   */
  async standings(
    ctx: RequestContext, companyId: string, templateId: string, kindNames: readonly string[],
  ): Promise<TemplateOfficeStandingView[]> {
    if (!can(ctx, 'company_template:read')) throw new PermissionDeniedException('company_template:read');
    /*
     * **Advanced analytics is read live, so every KPM is current on it** (P19.5-T1; ADR-0214 §1): it is never pushed,
     * and asking about it alone answers each KPM `current`, with no kind to list.
     */
    const live = splitLive(kindNames);
    const kinds = live.rest.length || !live.analytics ? this.parseKinds(live.rest) : [];
    const base = await this.named.offices(ctx, companyId, templateId);
    const template = await this.named.findOf(companyId, templateId);
    const newest = await this.newestOf(companyId, String(template._id));
    const offices = await this.officesOf.officesOf(companyId, this.named.scopeOf(template));
    const seeds = new Map(offices.map((o) => [o.id, o]));

    const out: TemplateOfficeStandingView[] = [];
    for (const office of base) {
      const standing = await this.standingOf(
        ctx, String(template._id), companyId, seeds.get(office.id)!, kinds.filter((k) => newest[k]), newest,
      );
      // Only Advanced analytics asked about: read live, so current on it (ADR-0214 §1).
      out.push({ ...office, state: kinds.length === 0 ? 'current' : overall(standing), kinds: standing });
    }
    return out;
  }

  // ------------------------------------------------------------------- the push (POST …/apply)

  /**
   * **Apply the template's newest published `kinds` to `kpmIds`** (ADR-0208 §4, §5). Refused whole before anything is
   * written: `403` without `company_template:write`; `404` for a company, a template that is not the company's, or a KPM
   * that is not one of the template's; `400` for an archived or built-in template, no kind or no KPM, a kind that is not
   * one, or one the template has published nothing of. Then each KPM by itself: `applied`, `skipped` (already current)
   * or `refused` per kind — a changed KPM not in `replaceChanged` refused whole. `409 TEMPLATE_APPLY_UNCONFIRMED` when
   * every KPM asked about was refused that way, and nothing was written.
   */
  async apply(
    ctx: RequestContext,
    companyId: string,
    templateId: string,
    body: { kinds: readonly string[]; kpmIds: readonly string[]; replaceChanged?: readonly string[] },
  ): Promise<ApplyView> {
    if (!can(ctx, 'company_template:write')) throw new PermissionDeniedException('company_template:write');
    const template = await this.named.findOf(companyId, templateId);
    const id = String(template._id);
    if (template.status === 'archived') {
      throw new InvalidRequestException(TEMPLATE_REFUSALS.VALIDATION_FAILED.editArchived({ name: template.name }));
    }
    if (await this.isLibrary(companyId)) throw new InvalidRequestException(SAY.builtInReachesNobody);

    // Advanced analytics reaches every KPM when it is published, and is never applied to one (ADR-0214 §1).
    if (splitLive(body.kinds ?? []).analytics) {
      throw new InvalidRequestException(ANALYTICS_TEMPLATE_REFUSALS.VALIDATION_FAILED.neverPushed);
    }
    const kinds = this.parseKinds(body.kinds);
    const kpmIds = [...new Set(body.kpmIds ?? [])];
    if (kinds.length === 0 || kpmIds.length === 0) throw new InvalidRequestException(SAY.nothingToApply);
    const newest = await this.newestOf(companyId, id);
    const unpublished = kinds.filter((k) => !newest[k]);
    if (unpublished.length) throw new InvalidRequestException(SAY.notPublished({ kinds: unpublished }));

    const offices = new Map((await this.officesOf.officesOf(companyId, this.named.scopeOf(template)))
      .map((o) => [o.id, o]));
    // Every KPM is one of the template's, or nothing is written: another company's office is a 404 like any stranger.
    for (const kpmId of kpmIds) if (!offices.has(kpmId)) throw new NotFoundException('Kpm');
    const confirmed = new Set(body.replaceChanged ?? []);

    const results: ApplyOfficeResult[] = [];
    for (const kpmId of kpmIds) {
      results.push(await this.applyTo(ctx, template, offices.get(kpmId)!, kinds, newest, confirmed.has(kpmId)));
    }

    const unconfirmed = results.filter((r) => r.results.some(
      (k) => k.outcome === 'refused' && k.error.code === ErrorCode.TEMPLATE_APPLY_UNCONFIRMED,
    ));
    const anyDone = results.some((r) => r.results.some((k) => k.outcome !== 'refused'));
    if (!anyDone && unconfirmed.length === results.length) {
      throw new DomainException(
        ErrorCode.TEMPLATE_APPLY_UNCONFIRMED,
        TEMPLATE_PUSH_REFUSALS.TEMPLATE_APPLY_UNCONFIRMED.unconfirmed({ codes: unconfirmed.map((r) => r.code) }),
        HttpStatus.CONFLICT,
        { kpmIds: unconfirmed.map((r) => r.id), codes: unconfirmed.map((r) => r.code) },
      );
    }

    // One entry in the platform's scope, naming every KPM and what it was given.
    await this.audit.record(ctx, {
      action: 'company_template.applied',
      targetCollection: 'templates',
      targetId: id,
      after: {
        companyId,
        name: template.name,
        kinds,
        versions: Object.fromEntries(kinds.map((k) => [k, newest[k]!.version])),
        offices: results.map((r) => ({
          kpmId: r.id, code: r.code, results: r.results.map((k) => ({ kind: k.kind, outcome: k.outcome })),
        })),
      },
    });
    return { templateId: id, offices: results };
  }

  // -------------------------------------------------------------------------- internals

  private parseKinds(names: readonly string[]): OfficeTemplateKind[] {
    const split = names.flatMap((n) => String(n).split(',')).map((n) => n.trim()).filter(Boolean);
    const { kinds, unknown } = kindsInOrder(split, PUBLISH_ORDER);
    if (unknown.length) throw new InvalidRequestException(SAY.unknownKind({ kinds: unknown }));
    return kinds;
  }

  private async isLibrary(companyId: string): Promise<boolean> {
    return (await this.companies.exists({ _id: companyId, kind: 'template', deletedAt: null }).exec()) !== null;
  }

  /** The template's newest published version of each kind, where it has one. */
  private async newestOf(companyId: string, templateId: string): Promise<Partial<Record<OfficeTemplateKind, Newest>>> {
    const { kinds, versions } = await this.named.publishedKindsOf(companyId, templateId);
    const out: Partial<Record<OfficeTemplateKind, Newest>> = {};
    // The playbook is read live, never pushed (ADR-0210 §4): only the kinds an office copies.
    for (const kind of (Object.keys(versions) as OfficeTemplateKind[]).filter(isOfficeTemplateKind)) {
      out[kind] = { version: versions[kind]!, payload: kinds[kind]! };
    }
    return out;
  }

  /**
   * **What the KPM was last given of one kind** (ADR-0208 §4): the version its record names, when the record is this
   * template's; nothing, when the template held none of the kind then; and — for a KPM whose record is missing or
   * another's — the template's **previous** published version, which is R3's rule as written (the newest, where there
   * is only one).
   */
  private async givenOf(
    companyId: string, templateId: string, kind: OfficeTemplateKind, office: OfficeSeeds, newestVersion: number,
  ): Promise<{ version: number | null; payload: Record<string, unknown> | null }> {
    const record = office.seededFrom[kind] as { templateId?: string | null; version: number | null } | undefined;
    const ours = record && record.templateId === templateId;
    if (ours && record.version === null) return { version: null, payload: null };
    const version = ours ? record.version! : Math.max(newestVersion - 1, 1);
    const row = await this.templateRows
      .findOne({ companyId, templateId, kind, version, status: 'published', deletedAt: null })
      .exec();
    return { version: ours ? record.version : null, payload: row ? (row.payload as Record<string, unknown>) : null };
  }

  /** Each kind's standing for one KPM, read from its rows now. */
  private async standingOf(
    ctx: RequestContext,
    templateId: string,
    companyId: string,
    office: OfficeSeeds,
    kinds: readonly OfficeTemplateKind[],
    newest: Partial<Record<OfficeTemplateKind, Newest>>,
  ): Promise<KindStanding[]> {
    if (kinds.length === 0) return [];
    const kctx = RequestContext.superAdminInTenant(ctx.userId, office.id);
    const rows = await this.rowsOf(kctx, kinds);
    const out: KindStanding[] = [];
    for (const kind of kinds) {
      const { version: newestVersion } = newest[kind]!;
      const given = await this.givenOf(companyId, templateId, kind, office, newestVersion);
      let differences = differencesOf(kind, itemsOfPayload(kind, given.payload), itemsOfOffice(kind, rows));
      let own: number | undefined;
      if (kind === 'training_taxonomy') {
        const mine = ownMaterialDifferences(rows.trainingModules);
        own = mine.length;
        differences = mergeDifferences(differences, mine);
      }
      const state = pushStateOf(given.version, newestVersion, differences);
      out.push({
        kind,
        state,
        givenVersion: given.version,
        newestVersion,
        differences: state === 'changed' ? differences : [],
        ...(own !== undefined ? { ownMaterialModules: own } : {}),
      });
    }
    return out;
  }

  /** The KPM's live rows of the kinds asked about — every collection read only when a kind needs it. */
  private async rowsOf(kctx: RequestContext, kinds: readonly OfficeTemplateKind[]): Promise<OfficeRows> {
    const need = new Set(kinds);
    const plain = (docs: Document[]) => docs.map((d) => d.toObject() as Row);
    const rows: OfficeRows = {
      activityCategories: [], activityTypes: [], binding: null, ratios: [], leadStatuses: [],
      trainingCategories: [], trainingSkills: [], trainingModules: [], checklist: null, capability: null, eventTypes: [],
    };
    if (need.has('activity_taxonomy') || need.has('ratio_set')) {
      rows.activityCategories = plain(await this.activityCategories.find(kctx, {}));
      rows.activityTypes = plain(await this.activityTypes.find(kctx, {}));
      const binding = await this.bindings.findOne(kctx, { status: 'active' });
      rows.binding = binding ? (binding.toObject() as unknown as Row) : null;
    }
    if (need.has('ratio_set')) rows.ratios = plain(await this.ratios.find(kctx, {}));
    if (need.has('lead_pipeline')) rows.leadStatuses = plain(await this.leadStatuses.find(kctx, {}));
    if (need.has('training_taxonomy') || need.has('activation_checklist')) {
      rows.trainingCategories = plain(await this.trainingCategories.find(kctx, {}));
      rows.trainingSkills = plain(await this.trainingSkills.find(kctx, {}));
      rows.trainingModules = plain(await this.trainingModules.find(kctx, {}));
    }
    if (need.has('activation_checklist')) {
      const [published] = await this.checklists.find(kctx, { status: 'published' }, { sort: { version: -1 }, limit: 1 });
      rows.checklist = published ? ((published.toObject() as unknown as Row).aspects as Row[]) : null;
    }
    if (need.has('capability_ladder')) {
      const catalog = await this.capability.findOne(kctx, {});
      rows.capability = catalog ? (catalog.toObject() as unknown as OfficeRows['capability']) : null;
    }
    if (need.has('event_types')) rows.eventTypes = plain(await this.eventTypes.find(kctx, {}));
    return rows;
  }

  /** One KPM: its standing computed again, then each kind applied in order, or the KPM refused whole. */
  private async applyTo(
    ctx: RequestContext,
    template: NamedTemplateDocument,
    office: OfficeSeeds,
    kinds: readonly OfficeTemplateKind[],
    newest: Partial<Record<OfficeTemplateKind, Newest>>,
    replace: boolean,
  ): Promise<ApplyOfficeResult> {
    const templateId = String(template._id);
    const kctx = RequestContext.superAdminInTenant(ctx.userId, office.id);
    const head = { id: office.id, code: office.code, branchName: office.branchName };
    const standing = await this.standingOf(ctx, templateId, template.companyId, office, kinds, newest);
    const changed = standing.filter((s) => s.state === 'changed');

    if (changed.length && !replace) {
      const error = new DomainException(
        ErrorCode.TEMPLATE_APPLY_UNCONFIRMED,
        TEMPLATE_PUSH_REFUSALS.TEMPLATE_APPLY_UNCONFIRMED.unconfirmed({ codes: [office.code] }),
        HttpStatus.CONFLICT,
      );
      return {
        ...head,
        awaitingPublish: false,
        results: kinds.map((kind) => ({
          kind, outcome: 'refused', error: { code: error.code, message: error.messageFor(ctx.reader) },
        })),
      };
    }

    const waiting = (await this.config.state(kctx)).hasUnpublishedChanges;
    const results: ApplyKindOutcome[] = [];
    let stopped = false;
    for (const kind of kinds) {
      const mine = standing.find((s) => s.kind === kind)!;
      if (stopped) {
        results.push({ kind, outcome: 'refused', error: refusal(SAY.earlierKindRefused, ctx) });
        continue;
      }
      if (mine.state === 'current') {
        results.push({ kind, outcome: 'skipped', reason: 'current' });
        continue;
      }
      try {
        const replaced = await this.write(kctx, kind, newest[kind]!.payload, templateId, replace);
        await this.kpms.updateOne(
          { _id: office.id, companyId: template.companyId, deletedAt: null },
          { $set: { [`seededFrom.${kind}`]: { templateId, version: newest[kind]!.version } } },
        ).exec();
        await this.audit.record(kctx, {
          action: 'company_template.applied',
          targetCollection: 'kpms',
          targetId: office.id,
          before: { version: mine.givenVersion },
          after: {
            templateId, templateName: template.name, kind, version: newest[kind]!.version,
            previousVersion: mine.givenVersion, differences: mine.differences, replacedOwnChanges: replaced,
          },
        });
        results.push({ kind, outcome: 'applied', version: newest[kind]!.version, replaced });
      } catch (err) {
        if (!(err instanceof DomainException)) throw err;
        results.push({ kind, outcome: 'refused', error: { code: err.code, message: err.messageFor(ctx.reader) } });
        // A kind refused leaves the KPM's later kinds unapplied (ADR-0208 §5, *Order*).
        stopped = true;
      }
    }

    const applied = results.filter((r): r is Extract<ApplyKindOutcome, { outcome: 'applied' }> => r.outcome === 'applied');
    if (applied.length) {
      if (!waiting) {
        await this.config.publish(kctx, {
          source: 'template_push',
          templateId,
          templateVersions: Object.fromEntries(applied.map((r) => [r.kind, r.version])),
          pushedBy: ctx.userId,
          pushedAt: this.clock.now(),
        });
      }
      await this.tell(kctx, office.id, template.name, applied.map((r) => r.kind), waiting);
    }
    return { ...head, results, awaitingPublish: applied.length > 0 && waiting };
  }

  /** **The Owner and the Admins, told in-app** (ADR-0208 §7; OD-260): the template, the sections, and whether they wait. */
  private async tell(
    kctx: RequestContext, kpmId: string, templateName: string, kinds: OfficeTemplateKind[], waiting: boolean,
  ): Promise<void> {
    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }, { ownerUserId: 1 }).lean().exec() as
      { ownerUserId?: string | null } | null;
    const admins = await this.members.find(kctx, { status: 'active', 'adminAccess.isKpmAdmin': true });
    const told = new Set([...(kpm?.ownerUserId ? [kpm.ownerUserId] : []), ...admins.map((m) => m.userId)]);
    for (const userId of told) {
      await this.notifications.send({
        userId,
        kpmId,
        templateId: NotificationTemplate.TEMPLATE_APPLIED,
        payload: { templateName, kinds, awaitingPublish: waiting },
      });
    }
  }

  /** Write one kind into the KPM. `true` when the KPM's own training material was replaced. */
  private async write(
    kctx: RequestContext,
    kind: OfficeTemplateKind,
    payload: Record<string, unknown>,
    templateId: string,
    replace: boolean,
  ): Promise<boolean> {
    switch (kind) {
      case 'activity_taxonomy': await this.writeActivity(kctx, payload); return false;
      case 'ratio_set': await this.writeRatios(kctx, payload); return false;
      case 'lead_pipeline': await this.writeStatuses(kctx, payload); return false;
      case 'training_taxonomy': return this.writeTraining(kctx, payload, templateId, replace);
      case 'activation_checklist': await this.writeChecklist(kctx, payload); return false;
      case 'capability_ladder': await this.writeLadder(kctx, payload); return false;
      case 'event_types': await this.writeEventTypes(kctx, payload); return false;
    }
  }

  /**
   * **One kind's rows, matched by code** (ADR-0208 §5): a row the template has is written as the template has it — its
   * version moved only where a field an Owner edits changed, never for a reorder; a row only the KPM has is archived; a
   * row new to the KPM is created, and one it had archived is brought back. `quiet` fields (a module's company
   * material) are written without counting as a change, as a content save moves no version.
   */
  private async syncRows(
    kctx: RequestContext,
    scoped: unknown,
    wanted: Row[],
    fields: readonly string[],
    quiet: readonly string[] = [],
  ): Promise<void> {
    const repository = scoped as RowRepository;
    const now = this.clock.now();
    const existing = await repository.find(kctx, {});
    const byCode = new Map(existing.map((doc) => [String((doc as unknown as Row).code), doc]));
    const keep = new Set(wanted.map((w) => String(w.code)));

    for (const row of wanted) {
      const doc = byCode.get(String(row.code));
      if (!doc) {
        await repository.create(kctx, { ...row, version: 1, status: 'active', archivedAt: null });
        continue;
      }
      const held = doc.toObject() as unknown as Row;
      const set: Row = {};
      for (const field of fields) if (!sameValue(held[field], row[field])) set[field] = row[field];
      const archived = held.status === 'archived';
      const reorder = row.displayOrder !== undefined && held.displayOrder !== row.displayOrder;
      const quietSet: Row = {};
      for (const field of quiet) if (!sameValue(held[field], row[field])) quietSet[field] = row[field];
      if (Object.keys(set).length === 0 && !archived && !reorder && Object.keys(quietSet).length === 0) continue;
      const versioned = Object.keys(set).length > 0 || archived;
      await repository.updateById(kctx, String(doc._id), {
        $set: {
          ...set, ...quietSet,
          ...(reorder ? { displayOrder: row.displayOrder } : {}),
          ...(archived ? { status: 'active', archivedAt: null } : {}),
        },
        ...(versioned ? { $inc: { version: 1 } } : {}),
      });
    }
    for (const doc of existing) {
      const held = doc.toObject() as unknown as Row;
      if (keep.has(String(held.code)) || held.status === 'archived') continue;
      await repository.updateById(kctx, String(doc._id), {
        $set: { status: 'archived', archivedAt: now }, $inc: { version: 1 },
      });
    }
  }

  private async writeActivity(kctx: RequestContext, payload: Record<string, unknown>): Promise<void> {
    const source = payload as { categories?: SeedActivityCategory[]; types?: SeedActivityType[] };
    const binding = bindingOfPayload(payload) ?? defaultBinding();
    const { categories, types } = withCascadeTypes(source.categories ?? [], source.types ?? [], binding);
    const known = new Set(categories.map((c) => c.code));
    const categoryRows = categories.map((c, i) => {
      const extra = c as SeedActivityCategory & { description?: string | null; appliesToOrgLevelCodes?: string[] };
      return {
        code: c.code, label: c.label, description: extra.description ?? null,
        appliesToOrgLevelCodes: [...(extra.appliesToOrgLevelCodes ?? [])],
        summaryGroupCode: c.summaryGroupCode ?? null, summaryGroupLabel: c.summaryGroupLabel ?? null,
        displayOrder: c.displayOrder ?? i + 1,
      };
    });
    const typeRows = types.filter((t) => known.has(t.categoryCode)).map((t, i) => ({
      code: t.code, categoryCode: t.categoryCode, label: t.label,
      // P19.8-T4 (ADR-0229 §5): the template's *Nama singkat*, or the platform's by code for a payload made before it.
      shortLabel: shortLabelOf(t), description: t.description ?? null,
      displayOrder: t.displayOrder ?? i + 1,
    }));
    await this.syncRows(kctx, this.activityCategories, categoryRows,
      ['label', 'description', 'appliesToOrgLevelCodes', 'summaryGroupCode', 'summaryGroupLabel']);
    await this.syncRows(kctx, this.activityTypes, typeRows, ['categoryCode', 'label', 'shortLabel', 'description']);

    const held = await this.bindings.findOne(kctx, { status: 'active' });
    const next = { leads: [...binding.leads], appointments: [...binding.appointments], closings: [...binding.closings] };
    if (!held) {
      await this.bindings.create(kctx, { ...next, version: 1, status: 'active', archivedAt: null } as never);
    } else if (!sameValue(
      { leads: held.leads, appointments: held.appointments, closings: held.closings }, next,
    )) {
      await this.bindings.updateById(kctx, String(held._id), { $set: next, $inc: { version: 1 } } as never);
    }
  }

  /** The ratios, each counting only activity types the KPM has, active — after the taxonomy, when both are pushed. */
  private async writeRatios(kctx: RequestContext, payload: Record<string, unknown>): Promise<void> {
    const ratios = ((payload.ratios ?? []) as SeedRatioDefinition[]);
    const types = new Set((await this.activityTypes.find(kctx, { status: 'active' })).map((t) => t.code));
    const missing = [...new Set(ratios.flatMap((r) => [...r.numerator, ...r.denominator]))].filter((c) => !types.has(c));
    if (missing.length) throw new InvalidRequestException(SAY.ratioTypesMissing({ codes: missing }));
    const rows = ratios.map((r, i) => {
      const resolved = resolveDisplayUnit(
        r.comparison, (r as { displayUnit?: string }).displayUnit ?? defaultDisplayUnitFor(r.code, r.comparison),
      );
      return {
        code: r.code, label: r.label, numerator: [...r.numerator], denominator: [...r.denominator],
        benchmark: r.benchmark, comparison: r.comparison,
        displayUnit: resolved.refusal === undefined ? resolved.unit : (r as { displayUnit?: string }).displayUnit,
        displayOrder: r.displayOrder ?? i + 1,
        // The template's, as provisioning writes every ratio it copies (ADR-0021, ADR-0024).
        origin: 'platform',
        standardNumerator: [...r.numerator], standardDenominator: [...r.denominator],
        appliesToOrgLevelCodes: [...(r.appliesToOrgLevelCodes ?? [])],
      };
    });
    await this.syncRows(kctx, this.ratios, rows, [
      'label', 'numerator', 'denominator', 'benchmark', 'comparison', 'displayUnit', 'appliesToOrgLevelCodes',
      'origin', 'standardNumerator', 'standardDenominator',
    ]);
  }

  private async writeStatuses(kctx: RequestContext, payload: Record<string, unknown>): Promise<void> {
    const statuses = ((payload.statuses ?? []) as SeedLeadStatus[]).map((s) => ({
      pipeline: s.pipeline, code: s.code, label: s.label, rank: s.rank,
      isTerminal: s.isTerminal, isLateStage: s.isLateStage ?? false,
    }));
    await this.syncRows(kctx, this.leadStatuses, statuses, ['pipeline', 'label', 'rank', 'isTerminal', 'isLateStage']);
  }

  /**
   * **Training, by code** (ADR-0208 §5): categories, skills and modules matched by code, so a module keeps its identity
   * and agents' progress by module stays. Each module's `companyContent` becomes the template's material. Its
   * `officeContent` is kept — unless the KPM was confirmed, when the KPM's own material moves to the module's history,
   * kept and never hard-deleted, its uploads released, and the template's shows. `true` when it replaced any.
   */
  private async writeTraining(
    kctx: RequestContext, payload: Record<string, unknown>, templateId: string, replace: boolean,
  ): Promise<boolean> {
    const rows = trainingSeedDocuments(kctx.kpmId!, payload as unknown as TrainingTaxonomyPayload);
    const strip = (r: Row) => {
      const { kpmId: _k, version: _v, status: _s, archivedAt: _a, deletedAt: _d, createdBy: _c, updatedBy: _u, officeContent: _o, ...rest } = r;
      return rest;
    };
    await this.syncRows(kctx, this.trainingCategories, rows.categories.map(strip), ['label', 'description']);
    // The descriptions travel with the names (P19.6-T4, ADR-0220 §6).
    await this.syncRows(kctx, this.trainingSkills, rows.skills.map(strip), ['categoryCode', 'label', 'description']);
    await this.syncRows(
      kctx, this.trainingModules, rows.modules.map(strip), ['skillCode', 'title', 'description', 'publishState'],
      ['companyContent'],
    );
    if (!replace) return false;

    let replaced = false;
    const now = this.clock.now();
    for (const module of await this.trainingModules.find(kctx, { status: 'active', officeContent: { $ne: null } })) {
      const own = asContent(module.officeContent);
      for (const key of storageKeysOf(own)) await this.assets.release(kctx, key);
      await this.trainingModules.updateById(kctx, String(module._id), {
        $set: { officeContent: null },
        $push: { contentHistory: { content: own, reason: 'template_push', at: now, by: kctx.userId, templateId } },
      });
      replaced = true;
    }
    return replaced;
  }

  /**
   * **The checklist, as a new published version** — after the training, whose modules its links must name, offered and
   * published in the KPM. A draft the Owner holds keeps waiting, one version further on. Nothing is written when the KPM
   * already publishes these aspects.
   */
  private async writeChecklist(kctx: RequestContext, payload: Record<string, unknown>): Promise<void> {
    const aspects = activationSeedAspects(payload);
    const offered = new Set((await this.trainingModules.find(kctx, { status: 'active', publishState: 'published' }))
      .map((m) => m.code));
    const missing = activationTrainingLinks(aspects).filter((code) => !offered.has(code));
    if (missing.length) throw new InvalidRequestException(SAY.checklistModulesMissing({ codes: missing }));

    const [published] = await this.checklists.find(kctx, { status: 'published' }, { sort: { version: -1 }, limit: 1 });
    if (published && sameValue((published.toObject() as unknown as Row).aspects, aspects)) return;
    const draft = await this.checklists.findOne(kctx, { status: 'draft' });
    const version = draft ? draft.version : (published?.version ?? 0) + 1;
    if (draft) await this.checklists.updateById(kctx, String(draft._id), { $set: { version: version + 1 } });
    await this.checklists.create(kctx, {
      version, status: 'published', publishedAt: this.clock.now(), aspects,
      origin: { source: 'template_push' }, createdBy: kctx.userId, updatedBy: kctx.userId,
    } as never);
  }

  /** The capability catalog, one document: stages, milestones, grids and their items matched by code. */
  private async writeLadder(kctx: RequestContext, payload: Record<string, unknown>): Promise<void> {
    const wanted = capabilitySeedDocument(kctx.kpmId!, payload as unknown as CapabilityLadderPayload);
    const held = await this.capability.findOne(kctx, {});
    if (!held) {
      await this.capability.create(kctx, wanted as never);
      return;
    }
    const current = held.toObject() as unknown as {
      stages: Row[]; milestones: Row[]; grids: (Row & { items: Row[] })[];
    };
    const merge = (have: Row[], want: Row[], fields: string[], nested?: (h: Row, w: Row) => Row) => {
      const wantedCodes = new Set(want.map((w) => String(w.code)));
      const byCode = new Map(have.map((h) => [String(h.code), h]));
      const out = want.map((w) => {
        const h = byCode.get(String(w.code));
        if (!h) return { ...w };
        const next: Row = { ...h, status: 'active', displayOrder: w.displayOrder };
        for (const field of fields) next[field] = w[field];
        return nested ? nested(next, w) : next;
      });
      for (const h of have) if (!wantedCodes.has(String(h.code))) out.push({ ...h, status: 'archived' });
      return out;
    };
    const next = {
      stages: merge(current.stages, wanted.stages as unknown as Row[], ['label', 'requiredMilestoneCodes', 'stageOrder']),
      milestones: merge(current.milestones, wanted.milestones as unknown as Row[], ['label']),
      grids: merge(current.grids, wanted.grids as unknown as Row[], ['label', 'requiresDownline'], (h, w) => ({
        ...h, items: merge((h.items ?? []) as Row[], (w.items ?? []) as Row[], ['label']),
      })),
    };
    if (sameValue(
      { stages: current.stages, milestones: current.milestones, grids: current.grids }, next,
    )) return;
    await this.capability.updateById(kctx, String(held._id), { $set: next, $inc: { version: 1 } } as never);
  }

  private async writeEventTypes(kctx: RequestContext, payload: Record<string, unknown>): Promise<void> {
    const rows = eventTypeSeedDocuments(kctx.kpmId!, payload as unknown as EventTypesPayload).map((r) => ({
      code: r.code, label: r.label, description: r.description, emoji: r.emoji, color: r.color,
      displayOrder: r.displayOrder,
    }));
    await this.syncRows(kctx, this.eventTypes, rows, ['label', 'description', 'emoji', 'color']);
  }
}

/** `changed` when any kind is; `current` when every kind is; `unchanged` otherwise — and for no kind at all. */
function overall(kinds: readonly KindStanding[]): PushState {
  if (kinds.some((k) => k.state === 'changed')) return 'changed';
  if (kinds.length > 0 && kinds.every((k) => k.state === 'current')) return 'current';
  return 'unchanged';
}

/** Two stored values the same, by their JSON with keys sorted — arrays in order, a Mongoose subdocument as plain. */
function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (v && typeof (v as { toObject?: unknown }).toObject === 'function') v = (v as { toObject: () => unknown }).toObject();
    if (Array.isArray(v)) return v.map(norm);
    if (v instanceof Date) return v.toISOString();
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Row).filter((k) => k !== '_id').sort().map((k) => [k, norm((v as Row)[k])]));
    }
    return v === undefined ? null : v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** A refusal of ours, as a result row carries it: its code and its words for the reader. */
function refusal(sentence: Parameters<typeof render>[0], ctx: RequestContext): { code: string; message: string } {
  return { code: ErrorCode.VALIDATION_FAILED, message: render(sentence, ctx.reader) };
}

/**
 * The kinds asked about, the ones a KPM reads live set apart — `advanced_analytics` (ADR-0214 §1) and, since P19.6-T1,
 * `branding` (ADR-0218 §3) — which no push carries.
 */
const LIVE_KINDS: readonly string[] = ['advanced_analytics', 'branding'];
function splitLive(names: readonly string[]): { analytics: boolean; rest: string[] } {
  const split = names.flatMap((n) => String(n).split(',')).map((n) => n.trim()).filter(Boolean);
  return { analytics: split.some((n) => LIVE_KINDS.includes(n)), rest: split.filter((n) => !LIVE_KINDS.includes(n)) };
}
