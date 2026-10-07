import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  ACTIVATION_LINK_KINDS, ACTIVATION_TRAINING_LINK, ACTIVATION_TRAINING_LINK_PREFIX,
  type ActivationFeatureLink,
} from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { Kpm } from '@/modules/tenants/kpm.schema';
import { TrainingService } from '@/modules/training/training.service';
import { ActivationTemplateDocument } from './activation-template.schema';
import {
  checkActivationChecklist, trainingLinkModuleCode, type CheckedActivationAspect,
} from './activation-input';
import {
  activationSeedAspects, activationTrainingLinks, defaultActivationChecklist,
} from './activation-payload';
import { ActivationTemplateRepository } from './activation.repository';

/** What an item's link waits for, resolved — the one place Phase 13's *"Go to {label} →"* reads. */
export interface ActivationLinkView {
  kind: string;
  label: string;
  route: string;
  completesWhen: string;
  /**
   * Whether an evaluator exists yet. While it does not, a leader ticks the item by hand. **Whether,
   * never when**: the phase that makes it live is not served (P10.1-T2 AC-13, ADR-0062 §3).
   */
  live: boolean;
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
      return { published: null, draft: office.startedFrom ? null : this.startingPoint(), windowDays };
    }

    return {
      published: published ? await this.view(ctx, published) : null,
      draft: draft ? await this.view(ctx, draft) : null,
      windowDays,
    };
  }

  /** The seed, as an unsaved draft. Not written: saving it is the Owner's act, not a read's. */
  private startingPoint(): ActivationVersionView {
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
          link: this.linkView(item.autoLink, new Map()),
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
    return found ? this.view(ctx, found) : null;
  }

  /**
   * **The version a hire starting now is given** (P13-T1 AC-2): the office's newest published one, or
   * `null` before the first publish. Its id and number are what a new activation pins.
   */
  async publishedNow(ctx: RequestContext): Promise<ActivationVersionView | null> {
    const found = await this.newestPublished(ctx);
    return found ? this.view(ctx, found) : null;
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
    if (!draft) {
      throw new BadRequestException(
        'There is nothing to publish. Change something first — a published version is immutable, '
          + 'because every hire records which one they started on.',
      );
    }

    /*
     * **An unchanged draft is refused** (P13-T1 AC-2; `functional/activation.md`, *Publishing*): a version
     * number is what a hire's activation points at, and a version identical to the one before it means
     * nothing — noise in every audit that follows, and a pin that says the checklist moved when it did not.
     */
    const current = await this.newestPublished(ctx);
    if (current && sameChecklist(current.aspects, draft.aspects)) {
      throw new BadRequestException(
        `The draft is the same as version ${current.version}, so there is nothing to publish. Change `
          + 'something first — every hire records the version they started on.',
      );
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
      if (!module) return `${code} is not a training module in this office.`;
      if (module.status === 'archived') return `${code} is archived, so no agent is offered it.`;
      if (module.publishState !== 'published') {
        return `${code} is a draft, so no agent is offered it. Publish the module first.`;
      }
      return null;
    }).filter((problem): problem is string => problem !== null);

    if (problems.length > 0) {
      throw new BadRequestException(
        `A checklist item is linked to a training module it cannot wait for. ${problems.join(' ')}`,
      );
    }
  }

  private async view(
    ctx: RequestContext, doc: ActivationTemplateDocument,
  ): Promise<ActivationVersionView> {
    const aspects = doc.aspects as unknown as CheckedActivationAspect[];
    const titles = await this.moduleTitles(ctx, aspects);

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
            .map((item) => ({
              code: item.code,
              label: item.label,
              displayOrder: item.displayOrder,
              autoLink: item.autoLink,
              link: this.linkView(item.autoLink, titles),
            })),
        })),
    };
  }

  /** A training link reads as the module's own title, so the screen names what it is waiting for. */
  private async moduleTitles(
    ctx: RequestContext, aspects: readonly CheckedActivationAspect[],
  ): Promise<Map<string, string>> {
    const wanted = activationTrainingLinks(aspects);
    if (wanted.length === 0) return new Map();

    const tree = await this.training.list(ctx, true);
    return new Map(
      tree.flatMap((c) => c.skills.flatMap((s) => s.modules.map((m) => [m.code, m.title] as const))),
    );
  }

  private linkView(link: string | null, titles: Map<string, string>): ActivationLinkView | null {
    if (link === null) return null;

    const moduleCode = trainingLinkModuleCode(link);
    if (moduleCode !== null) {
      return {
        ...ACTIVATION_TRAINING_LINK,
        kind: link,
        // The module's own title, or its code where the module has since been removed from view.
        label: titles.get(moduleCode) ?? moduleCode,
      };
    }

    const kind = ACTIVATION_LINK_KINDS[link as ActivationFeatureLink];
    return kind ? { ...kind, kind: link } : null;
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
