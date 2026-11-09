import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { InvalidRequestException } from '@/common/errors/domain.exception';
import type { Reader } from '@/common/i18n/reader';
import { joinSentences, render } from '@/common/i18n/sentence';
import {
  ACTIVATION_DATA_LINK_KINDS, ACTIVATION_LINK_KINDS, ACTIVATION_TRAINING_LINK, ACTIVATION_TRAINING_LINK_PREFIX,
  effectiveAutoLink, isActivationDataLink, type ActivationFeatureLink, type ActivationRecordForm,
} from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { Kpm } from '@/modules/tenants/kpm.schema';
import { TrainingService, type TrainingCategoryView } from '@/modules/training/training.service';
import { OfferedTraining } from '@/modules/training/offered-training';
import { ActivationTemplateDocument } from './activation-template.schema';
import {
  checkActivationChecklist, trainingLinkModuleCode, type CheckedActivationAspect,
} from './activation-input';
import {
  activationSeedAspects, activationTrainingLinks, defaultActivationChecklist,
} from './activation-payload';
import { ActivationTemplateRepository } from './activation.repository';
import { ACTIVATION_REFUSALS, completesWhenOf, dataLinkLabelOf } from './activation.messages';

const SAY = ACTIVATION_REFUSALS.VALIDATION_FAILED;

/** A module a training link names: its title, the category its page is under, and whether that page answers. */
interface LinkedModule {
  title: string;
  categoryCode: string;
  /** Offered to the reader of this view, so its page answers; `false` for one named only for its title. */
  routable: boolean;
}

/**
 * **Where a training link's title is read from, by who reads it** (the Phase 18.2 exit review, B2):
 *
 * - `settings` — the office's working taxonomy, drafts included: the Owner's and the Admins' settings read
 *   (`activation_settings:read`), which names what they are editing;
 * - `snapshot` — the modules the office's **next** snapshot will carry (`TrainingService.offered`: live, active,
 *   published): the checklist `GET /kpm/config` publishes to every member;
 * - `offered` — the office's **published** snapshot (`OfferedTraining`): a hire's activation and a leader's view of
 *   it, so a field reader is never told a draft module's title.
 *
 * For `snapshot` and `offered`, **a module not offered** (withdrawn since, or published only in the working copy) is
 * named by the working copy's title **only when that module is published** — archived since or not, a title once
 * offered — **never a draft's** (an archived draft included), which reads as its code; and it has **no route** (`null`), so no *Go to* is drawn to a page
 * that would not answer (the exit review, training review: *"Completed from CLOSING_TECHNIQUES"*).
 */
export type LinkTitleSource = 'settings' | 'snapshot' | 'offered';

/** What an item's link waits for, resolved — the one place Phase 13's *"Go to {label} →"* reads. */
export interface ActivationLinkView {
  kind: string;
  label: string;
  /**
   * Where *"Go to {label} →"* sends a reader, or `null` for a training link to a module the reader is not offered —
   * withdrawn, or not yet published — whose page would be a 404: draw no *Go to* (the Phase 18.2 exit review).
   */
  route: string | null;
  completesWhen: string;
  /**
   * Whether an evaluator exists yet. While it does not, a leader ticks the item by hand. **Whether,
   * never when**: the phase that makes it live is not served (P10.1-T2 AC-13, ADR-0062 §3).
   */
  live: boolean;
  /**
   * **The form a hand tick opens** (P18.8-T4 AC-3): `closing` — *Which case?* — or `one_on_one` — *Log 1:1* — for
   * a data-backed item, which is ticked by hand only with its record; `null` for every other link.
   */
  form: ActivationRecordForm | null;
}

export interface ActivationItemView {
  code: string;
  label: string;
  displayOrder: number;
  autoLink: string | null;
  link: ActivationLinkView | null;
}

export interface ActivationAspectView {
  code: string;
  label: string;
  displayOrder: number;
  items: ActivationItemView[];
}

export interface ActivationVersionView {
  id: string;
  version: number;
  status: 'draft' | 'published';
  publishedAt: string | null;
  aspects: ActivationAspectView[];
}

export interface ActivationChecklistView {
  /** The version hires starting now are given, or `null` before the first publish. */
  published: ActivationVersionView | null;
  /** The office's working copy, or `null` when nothing has been edited since publishing. */
  draft: ActivationVersionView | null;
  /**
   * `kpms.settings.activationWindowDays`, as provisioning seeded it. Shown beside the checklist.
   * No route writes it: Branch info has no such field, although this once said it did (X-45).
   */
  windowDays: number;
}

/**
 * An office's 90-day activation checklist (P5-T3).
 *
 * **A document with immutable versions, not rows.** A hire's `activationProgress` pins
 * `(templateId, templateVersion)` at creation (Phase 13), so the checklist somebody is working
 * through cannot change under them. Editing writes a draft; publishing turns that draft into the
 * next version, which reaches hires who start after it and nobody else.
 *
 * **It is not in the office's snapshot.** `GET /kpm/config` carries what every member of an office
 * reads identically (ADR-0039); a hire reads the version their own instance names. So this screen's
 * publish is the checklist's own, and the office-wide *Publish to agents* says nothing about it.
 */
@Injectable()
export class ActivationService {
  constructor(
    private readonly templates: ActivationTemplateRepository,
    private readonly training: TrainingService,
    @InjectModel(Kpm.name) private readonly kpms: Model<Kpm>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    // The Phase 18.2 exit review (B2): a field reader's link titles come from what the office offers.
    private readonly offered: OfferedTraining,
  ) {}

  /** The office's published version, its draft, and the window both are read against. */
  async read(ctx: RequestContext): Promise<ActivationChecklistView> {
    const [published, draft, office] = await Promise.all([
      this.newestPublished(ctx),
      this.draftOf(ctx),
      this.office(ctx),
    ]);
    const { windowDays } = office;

    /*
     * **An office with neither opens on the standard checklist**, unsaved, the way the Company
     * template screen opens on its starting payload. Provisioning gives a new office version 1
     * and migration `0012` gives one to every office that already existed — but an office
     * between those two, on a database the migration has not reached, would otherwise answer
     * with nothing at all, and its Owner would have no way to start.
     *
     * `id: ''` is what says it is not saved: nothing to publish until it has been.
     *
     * **An office started from a source since 13.2 opens on nothing** (ADR-0115 §1, §8): its source
     * held no checklist, the Owner asked for exactly that, and offering the platform's sixteen items
     * would be the fallback the client reported. Its Owner authors the first aspect from nothing.
     */
    if (!published && !draft) {
      return { published: null, draft: office.startedFrom ? null : this.startingPoint(ctx.reader), windowDays };
    }

    return {
      published: published ? await this.view(ctx, published, 'settings') : null,
      draft: draft ? await this.view(ctx, draft, 'settings') : null,
      windowDays,
    };
  }

  /**
   * **The published version as `GET /kpm/config` carries it to every member** (the Phase 18.2 exit review, B2): its
   * training links named from the modules that snapshot will offer, never from a draft. `null` before the first
   * publish.
   */
  async publishedForSnapshot(ctx: RequestContext): Promise<ActivationVersionView | null> {
    const found = await this.newestPublished(ctx);
    return found ? this.view(ctx, found, 'snapshot') : null;
  }

  /** The seed, as an unsaved draft. Not written: saving it is the Owner's act, not a read's. */
  private startingPoint(reader: Reader): ActivationVersionView {
    return {
      id: '',
      version: 1,
      status: 'draft',
      publishedAt: null,
      aspects: activationSeedAspects(defaultActivationChecklist()).map((aspect) => ({
        code: aspect.code,
        label: aspect.label,
        displayOrder: aspect.displayOrder,
        items: aspect.items.map((item) => ({
          code: item.code,
          label: item.label,
          displayOrder: item.displayOrder,
          autoLink: item.autoLink,
          // The seed carries no training link, so no module title has to be resolved.
          link: this.linkView(item.autoLink, new Map(), reader),
        })),
      })),
    };
  }

  /**
   * One published version, by number — what a hire's activation pins and every read of it renders
   * (D-version). No route of its own: the activation's reads call it.
   */
  async findVersion(ctx: RequestContext, version: number): Promise<ActivationVersionView | null> {
    const found = await this.templates.findOne(ctx, { version, status: 'published' });
    // A hire's or a leader's read: titles from what the office offers (B2).
    return found ? this.view(ctx, found, 'offered') : null;
  }

  /**
   * **The version a hire starting now is given** (P13-T1 AC-2): the office's newest published one, or
   * `null` before the first publish. Its id and number are what a new activation pins.
   */
  async publishedNow(ctx: RequestContext): Promise<ActivationVersionView | null> {
    const found = await this.newestPublished(ctx);
    return found ? this.view(ctx, found, 'offered') : null;
  }

  /**
   * Save the working copy — the whole document, not a patch.
   *
   * Creates the draft on the first edit since publishing, carrying the version it **will** be, so
   * the screen can say *Publish version 3* before anything is published.
   */
  async saveDraft(ctx: RequestContext, body: unknown): Promise<ActivationChecklistView> {
    const { aspects } = checkActivationChecklist(body);
    await this.requireLinkedModules(ctx, aspects);

    const existing = await this.draftOf(ctx);
    const saved = existing
      ? await this.templates.updateById(ctx, String(existing._id), {
        $set: { aspects, updatedBy: ctx.userId },
      })
      : await this.templates.create(ctx, {
        version: ((await this.newestPublished(ctx))?.version ?? 0) + 1,
        status: 'draft',
        publishedAt: null,
        aspects,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      } as never);

    await this.audit.record(ctx, {
      action: 'activation_checklist.draft_saved',
      targetCollection: 'activationTemplates',
      targetId: String(saved!._id),
      after: { version: saved!.version, aspects: aspects.length },
    });

    return this.read(ctx);
  }

  /**
   * Publish the draft, making it the version new hires are given.
   *
   * The draft row **becomes** the published row rather than being copied into one: the id the Owner
   * has been editing is the id hires will record.
   */
  async publish(ctx: RequestContext): Promise<ActivationChecklistView> {
    const draft = await this.draftOf(ctx);
    if (!draft) throw new InvalidRequestException(SAY.nothingToPublish);

    /*
     * **An unchanged draft is refused** (P13-T1 AC-2; `functional/activation.md`, *Publishing*): a version
     * number is what a hire's activation points at, and a version identical to the one before it means
     * nothing — noise in every audit that follows, and a pin that says the checklist moved when it did not.
     */
    const current = await this.newestPublished(ctx);
    if (current && sameChecklist(current.aspects, draft.aspects)) {
      throw new InvalidRequestException(SAY.sameAsPublished({ version: current.version }));
    }

    // Again at publish, not only at save: a module can be archived or unpublished between the two,
    // and a link to something no agent is offered can never fire.
    await this.requireLinkedModules(ctx, draft.aspects as unknown as CheckedActivationAspect[]);

    const at = this.clock.now();
    const published = await this.templates.updateById(ctx, String(draft._id), {
      $set: { status: 'published', publishedAt: at, updatedBy: ctx.userId },
    });

    await this.audit.record(ctx, {
      action: 'activation_checklist.published',
      targetCollection: 'activationTemplates',
      targetId: String(draft._id),
      after: { version: published!.version },
    });

    return this.read(ctx);
  }

  // -------------------------------------------------------------------- internals

  private async newestPublished(ctx: RequestContext) {
    const rows = await this.templates.find(ctx, { status: 'published' }, { sort: { version: -1 } });
    return rows[0];
  }

  private draftOf(ctx: RequestContext) {
    return this.templates.findOne(ctx, { status: 'draft' });
  }

  /** The office's window, and what it was started from (`null` before 13.2). */
  private async office(ctx: RequestContext): Promise<{ windowDays: number; startedFrom: unknown }> {
    const kpm = await this.kpms.findById(ctx.kpmId).select('settings startedFrom').lean().exec() as
      { settings?: { activationWindowDays?: number }; startedFrom?: unknown } | null;
    return { windowDays: kpm?.settings?.activationWindowDays ?? 0, startedFrom: kpm?.startedFrom ?? null };
  }

  /**
   * Every training link names a module this office **offers**: it exists, it is active, and it is
   * published. A link to anything else can never complete, and the refusal says which of the three
   * it is rather than making an Owner guess.
   */
  private async requireLinkedModules(
    ctx: RequestContext, aspects: readonly CheckedActivationAspect[],
  ): Promise<void> {
    const wanted = activationTrainingLinks(aspects);
    if (wanted.length === 0) return;

    const tree = await this.training.list(ctx, true);
    const modules = new Map(
      tree.flatMap((c) => c.skills.flatMap((s) => s.modules.map((m) => [m.code, m] as const))),
    );

    const problems = wanted.map((code) => {
      const module = modules.get(code);
      if (!module) return SAY.moduleMissing({ code });
      if (module.status === 'archived') return SAY.moduleArchived({ code });
      if (module.publishState !== 'published') return SAY.moduleDraft({ code });
      return null;
    }).filter((problem) => problem !== null);

    if (problems.length > 0) {
      throw new InvalidRequestException(joinSentences([SAY.unwaitableModule, ...problems], ' '));
    }
  }

  private async view(
    ctx: RequestContext, doc: ActivationTemplateDocument, source: LinkTitleSource,
  ): Promise<ActivationVersionView> {
    const aspects = doc.aspects as unknown as CheckedActivationAspect[];
    const titles = await this.moduleTitles(ctx, aspects, source);

    return {
      id: String(doc._id),
      version: doc.version,
      status: doc.status,
      publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
      aspects: [...aspects]
        .sort((a, b) => a.displayOrder - b.displayOrder)
        .map((aspect) => ({
          code: aspect.code,
          label: aspect.label,
          displayOrder: aspect.displayOrder,
          items: [...aspect.items]
            .sort((a, b) => a.displayOrder - b.displayOrder)
            .map((item) => {
              /*
               * P18.8-T4 AC-2 (ADR-0171 §3): a field reader's item reads the kind its code is bound to where it
               * stores none — *Close first case independently* and its two siblings complete from the office's
               * sales and coaching records, and no published version is edited for it. The settings read keeps
               * what is stored in `autoLink`: it is what the Owner edits and saves back.
               *
               * P18.8-T7 G2: **its `link` is what completes the item, in every read** — the settings' too, so the
               * Owner's screen draws the three as data-backed (*From Sales data*) rather than *No link (manual)*,
               * while the stored `autoLink` it saves back stays `null`.
               */
              const bound = effectiveAutoLink(item.code, item.autoLink);
              return {
                code: item.code,
                label: item.label,
                displayOrder: item.displayOrder,
                autoLink: source === 'settings' ? item.autoLink : bound,
                link: this.linkView(bound, titles, ctx.reader),
              };
            }),
        })),
    };
  }

  /**
   * A training link reads as the module's own title, so the screen names what it is waiting for, and goes to the
   * module's own page — under its category, which is its skill's (ADR-0029), so the address is resolved here.
   */
  private async moduleTitles(
    ctx: RequestContext, aspects: readonly CheckedActivationAspect[], source: LinkTitleSource,
  ): Promise<Map<string, LinkedModule>> {
    const wanted = activationTrainingLinks(aspects);
    if (wanted.length === 0) return new Map();

    const entries = (tree: TrainingCategoryView[], routable: boolean, keep: (m: TrainingCategoryView['skills'][number]['modules'][number]) => boolean = () => true) =>
      tree.flatMap((c) => c.skills.flatMap((s) => s.modules.filter(keep).map(
        (m) => [m.code, { title: m.title, categoryCode: c.code, routable }] as const,
      )));
    if (source === 'settings') return new Map(entries(await this.training.list(ctx, true), true));

    const offered = new Map(entries(
      source === 'snapshot' ? await this.training.offered(ctx) : await this.offered.tree(ctx), true,
    ));
    if (wanted.every((code) => offered.has(code))) return offered;
    // A module not offered: its working title only if it is published (archived since or not), never a draft's.
    const named = new Map(entries(
      await this.training.list(ctx, true), false, (m) => m.publishState === 'published',
    ));
    for (const code of wanted) {
      if (!offered.has(code) && named.has(code)) offered.set(code, named.get(code)!);
    }
    return offered;
  }

  /**
   * A link, resolved — **its words written for the reader** (P18.10-T5 AC-4): what completes it, and a data kind's
   * source-line label. A feature link's label is a page's name and a training link's the module's own title, the same
   * in both languages.
   */
  private linkView(link: string | null, titles: Map<string, LinkedModule>, reader: Reader): ActivationLinkView | null {
    if (link === null) return null;

    const moduleCode = trainingLinkModuleCode(link);
    if (moduleCode !== null) {
      const module = titles.get(moduleCode);
      return {
        ...ACTIVATION_TRAINING_LINK,
        completesWhen: render(completesWhenOf(link), reader),
        form: null,
        kind: link,
        // The module's own title, or its code where the module has since been removed from view.
        label: module?.title ?? moduleCode,
        // *Go to {module} →* lands on the module's page (P18.2-T3 AC-5); nowhere for a module the reader is not offered.
        route: module?.routable
          ? `/training/${encodeURIComponent(module.categoryCode)}/${encodeURIComponent(moduleCode)}`
          : null,
      };
    }

    // P18.8-T4: a data kind resolves from its own registry, with no route — its way in is its own form.
    if (isActivationDataLink(link)) {
      return {
        ...ACTIVATION_DATA_LINK_KINDS[link],
        label: render(dataLinkLabelOf(link), reader),
        completesWhen: render(completesWhenOf(link), reader),
        kind: link,
      };
    }
    const kind = ACTIVATION_LINK_KINDS[link as ActivationFeatureLink];
    return kind ? { ...kind, completesWhen: render(completesWhenOf(link), reader), form: null, kind: link } : null;
  }
}

/**
 * Whether two versions say the same thing: the same aspects and items, by code, label, order and link.
 * Read through the stored shape, so a field Mongoose adds to a subdocument cannot make two equal
 * checklists differ.
 */
function sameChecklist(a: readonly unknown[], b: readonly unknown[]): boolean {
  const shape = (aspects: readonly unknown[]) => JSON.stringify(
    (aspects as CheckedActivationAspect[]).map((aspect) => ({
      code: aspect.code,
      label: aspect.label,
      displayOrder: aspect.displayOrder,
      items: aspect.items.map((item) => ({
        code: item.code, label: item.label, displayOrder: item.displayOrder, autoLink: item.autoLink ?? null,
      })),
    })),
  );
  return shape(a) === shape(b);
}

export { ACTIVATION_TRAINING_LINK_PREFIX };
