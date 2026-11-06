import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Document, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, InvalidRequestException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { CapabilityCatalogRepository } from '@/modules/capability/capability.repository';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import {
  TrainingCategoryRepository, TrainingModuleRepository, TrainingSkillRepository,
} from '@/modules/training/training.repository';
import { CompanyTemplate, CompanyTemplateDocument } from './company-template.schema';
import { NamedTemplate, type NamedTemplateDocument } from './named-template.schema';
import { TenantConfigService } from './tenant-config.service';
import {
  templateSyncDifferences, trainingRevision, type SyncOfficeRows, type TemplateSyncDifference,
} from './template-sync';
import { TEMPLATE_SYNC_REFUSALS } from './template-sync.messages';

type Row = Record<string, unknown>;

/** The two kinds a sync reads, each the version of the template's newest published one, or `null` for none. */
export interface TemplateSyncVersions {
  training_taxonomy: number | null;
  capability_ladder: number | null;
}

/** `GET /kpm/settings/training/template-sync` (ADR-0220 §4, *The read*). */
export interface TemplateSyncView {
  /** The template the KPM was made from, or `null` for none (made from the defaults, *Empty*, or before 13.2). */
  template: { id: string; name: string | null } | null;
  templateVersions: TemplateSyncVersions;
  /** What an apply is pinned to: `expectedRevision`. */
  revision: string;
  /** Empty when nothing differs, and then *Sinkron dari template* is not shown. */
  differences: TemplateSyncDifference[];
}

/** `POST /kpm/settings/training/template-sync` (ADR-0220 §4, *The apply*). */
export interface TemplateSyncResult {
  /**
   * `published` — the KPM had nothing waiting, so the sync published a new version (origin `template_sync`);
   * `awaiting_publish` — it had changes of its own waiting, and the names wait with them for *Terbitkan ke agent*;
   * `unchanged` — nothing differed, and nothing was written.
   */
  outcome: 'published' | 'awaiting_publish' | 'unchanged';
  /** What was written, old beside new. */
  differences: TemplateSyncDifference[];
  revision: string;
}

/** One template kind's newest published row, as a sync reads it. */
interface Newest {
  version: number;
  payload: Row;
}

/**
 * ***Sinkron dari template*** (P19.6-T4, ADR-0220 §4; OD-270, UI-161): a KPM that holds its own Training copy takes its
 * template's names and descriptions — categories, skills and modules by code, capability items by grid and item code —
 * **when its Owner or an Admin chooses to**, after seeing every change.
 *
 * - **The template is `kpms.startedFrom.templateId`**, of `startedFrom.companyId` where the KPM was started from another
 *   company's (the Template library's *Default template*), else its own company's; for a KPM made before templates were
 *   named, its company's migration-made default. A KPM made from no template (*defaults*, *Empty*), or whose template
 *   has published neither kind, answers no differences.
 * - **The apply is pinned** to the template versions and the KPM revision its preview read; either moved, `409
 *   VERSION_CONFLICT` and nothing is written.
 * - **Names and descriptions only.** No code, file, material, order, archived state, publish state, progress or tick
 *   changes; an item only one side has is left alone. Each row it renames takes a new `version`, as an Owner's edit
 *   would, so the publish bar sees it.
 * - **It publishes as ADR-0208 §5's push does**: a KPM with nothing waiting gets a new configuration version, origin
 *   `{ source: 'template_sync', … }`; one with its own changes waiting keeps them waiting, the names with them.
 *   `kpms.seededFrom` does not move: the KPM took names, not the section.
 * - **Audited** as `training.template_synced`, every change `from → to`.
 *
 * Every row is read and written through the tenant repositories, scoped by the caller's own KPM (invariant §1). The
 * write is the Owner's or an Admin's (`tenant_config:write`); a view-as session is refused before it reaches here
 * (`ViewOnlySessionGuard`, ADR-0206 §1), so the Super Admin never syncs for a KPM.
 */
@Injectable()
export class TemplateSyncService {
  constructor(
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(CompanyTemplate.name) private readonly templateRows: Model<CompanyTemplateDocument>,
    @InjectModel(NamedTemplate.name) private readonly named: Model<NamedTemplateDocument>,
    private readonly categories: TrainingCategoryRepository,
    private readonly skills: TrainingSkillRepository,
    private readonly modules: TrainingModuleRepository,
    private readonly capability: CapabilityCatalogRepository,
    private readonly config: TenantConfigService,
    private readonly audit: AuditService,
  ) {}

  /** The differences, by code, against the template's newest published versions (ADR-0220 §4, *The read*). */
  async read(ctx: RequestContext): Promise<TemplateSyncView> {
    const source = await this.sourceOf(ctx);
    const office = await this.officeOf(ctx);
    const newest = source ? await this.newestOf(source.companyId, source.templateId) : NONE;
    return {
      template: source ? { id: source.templateId, name: source.templateName } : null,
      templateVersions: versionsOf(newest),
      revision: office.revision,
      differences: templateSyncDifferences(
        { training: newest.training_taxonomy?.payload ?? null, capability: newest.capability_ladder?.payload ?? null },
        office.rows,
      ),
    };
  }

  /** Take the template's names and descriptions, as previewed (ADR-0220 §4, *The apply*). */
  async apply(
    ctx: RequestContext,
    body: { templateVersions: Partial<TemplateSyncVersions>; expectedRevision: string },
  ): Promise<TemplateSyncResult> {
    const source = await this.sourceOf(ctx);
    if (!source) throw new InvalidRequestException(TEMPLATE_SYNC_REFUSALS.VALIDATION_FAILED.noTemplate);
    const newest = await this.newestOf(source.companyId, source.templateId);
    const versions = versionsOf(newest);
    if (versions.training_taxonomy === null && versions.capability_ladder === null) {
      throw new InvalidRequestException(TEMPLATE_SYNC_REFUSALS.VALIDATION_FAILED.noTemplate);
    }
    const asked = {
      training_taxonomy: body.templateVersions?.training_taxonomy ?? null,
      capability_ladder: body.templateVersions?.capability_ladder ?? null,
    };
    if (asked.training_taxonomy !== versions.training_taxonomy || asked.capability_ladder !== versions.capability_ladder) {
      throw new DomainException(
        ErrorCode.VERSION_CONFLICT, TEMPLATE_SYNC_REFUSALS.VERSION_CONFLICT.templateMoved, HttpStatus.CONFLICT,
        { expected: asked, actual: versions },
      );
    }
    const office = await this.officeOf(ctx);
    if (body.expectedRevision !== office.revision) {
      throw new DomainException(
        ErrorCode.VERSION_CONFLICT, TEMPLATE_SYNC_REFUSALS.VERSION_CONFLICT.trainingMoved, HttpStatus.CONFLICT,
        { expectedRevision: body.expectedRevision, actualRevision: office.revision },
      );
    }

    const differences = templateSyncDifferences(
      { training: newest.training_taxonomy?.payload ?? null, capability: newest.capability_ladder?.payload ?? null },
      office.rows,
    );
    if (differences.length === 0) return { outcome: 'unchanged', differences, revision: office.revision };

    // Read before anything is written: what waited is the KPM's own, and the sync never publishes it for them.
    const waiting = (await this.config.state(ctx)).hasUnpublishedChanges;
    await this.writeTraining(ctx, office.rows, differences);
    await this.writeCapability(ctx, differences);

    if (!waiting) {
      await this.config.publish(ctx, {
        source: 'template_sync', templateId: source.templateId, templateVersions: { ...versions },
      });
    }
    const outcome = waiting ? 'awaiting_publish' : 'published';
    await this.audit.record(ctx, {
      action: 'training.template_synced',
      targetCollection: 'kpms',
      targetId: ctx.kpmId ?? '',
      after: {
        templateId: source.templateId,
        templateName: source.templateName,
        templateVersions: versions,
        outcome,
        changes: differences.map((d) => ({ level: d.level, code: d.code, field: d.field, from: d.from, to: d.to })),
      },
    });
    return { outcome, differences, revision: (await this.officeOf(ctx)).revision };
  }

  // -------------------------------------------------------------------------- internals

  /** Each renamed training row once, its fields together, its version moved as an Owner's edit moves it. */
  private async writeTraining(
    ctx: RequestContext, rows: SyncOfficeRows, differences: readonly TemplateSyncDifference[],
  ): Promise<void> {
    const plan: Record<'category' | 'skill' | 'module', Map<string, Row>> = {
      category: new Map(), skill: new Map(), module: new Map(),
    };
    for (const d of differences) {
      if (d.level === 'capability_item') continue;
      const field = d.field === 'description' ? 'description' : d.level === 'module' ? 'title' : 'label';
      const set = plan[d.level].get(d.code) ?? {};
      set[field] = d.to;
      plan[d.level].set(d.code, set);
    }
    const levels = [
      ['category', rows.categories, this.categories],
      ['skill', rows.skills, this.skills],
      ['module', rows.modules, this.modules],
    ] as const;
    for (const [level, held, repository] of levels) {
      for (const [code, set] of plan[level]) {
        const row = held.find((r) => String(r.code) === code && (r.status ?? 'active') === 'active');
        if (!row) continue;
        await (repository as TrainingCategoryRepository).updateById(ctx, String(row._id), {
          $set: { ...set, updatedBy: ctx.userId ?? null }, $inc: { version: 1 },
        });
      }
    }
  }

  /** The catalogue's items renamed by `<GRID>:<ITEM>`, in one write that moves its version. Ids and ticks stay. */
  private async writeCapability(ctx: RequestContext, differences: readonly TemplateSyncDifference[]): Promise<void> {
    const names = new Map(differences.filter((d) => d.level === 'capability_item').map((d) => [d.code, d.to]));
    if (names.size === 0) return;
    const catalog = await this.capability.findOne(ctx, {});
    if (!catalog) return;
    const plain = catalog.toObject() as unknown as { grids: (Row & { items: Row[] })[] };
    const grids = plain.grids.map((grid) => ({
      ...grid,
      items: (grid.items ?? []).map((item) => {
        const to = names.get(`${String(grid.code).toUpperCase()}:${String(item.code).toUpperCase()}`);
        return to ? { ...item, label: to } : item;
      }),
    }));
    await this.capability.updateById(ctx, String(catalog._id), {
      $set: { grids, updatedBy: ctx.userId ?? null }, $inc: { version: 1 },
    } as never);
  }

  /**
   * The template this KPM was made from: its id, its name then, and the company that holds it. **A KPM made before
   * templates were named** (`startedFrom: null`) is its company's default template's, where that template is the one
   * migration `0023` made for such offices (`origin.kind: 'migration'`) — the rule `OfficeCounter` and the push answer
   * them by (ADR-0115 §4, ADR-0208 §6).
   */
  private async sourceOf(
    ctx: RequestContext,
  ): Promise<{ templateId: string; templateName: string | null; companyId: string } | null> {
    const kpm = await this.kpms.findOne({ _id: ctx.kpmId, deletedAt: null }, { companyId: 1, startedFrom: 1 })
      .lean().exec() as { companyId?: string; startedFrom?: Kpm['startedFrom'] } | null;
    if (!kpm) return null;
    const started = kpm.startedFrom;
    if (started === null || started === undefined) {
      if (!kpm.companyId) return null;
      const legacy = await this.named.findOne(
        { companyId: kpm.companyId, isDefault: true, 'origin.kind': 'migration', deletedAt: null }, { name: 1 },
      ).lean().exec() as { _id: unknown; name?: string } | null;
      return legacy ? { templateId: String(legacy._id), templateName: legacy.name ?? null, companyId: kpm.companyId } : null;
    }
    if (started.source !== 'template' || !started.templateId) return null;
    const companyId = started.companyId ?? kpm.companyId;
    if (!companyId) return null;
    return { templateId: started.templateId, templateName: started.templateName ?? null, companyId };
  }

  /** The template's newest published `training_taxonomy` and `capability_ladder`, where it has them. */
  private async newestOf(companyId: string, templateId: string): Promise<Partial<Record<SyncKind, Newest>>> {
    const out: Partial<Record<SyncKind, Newest>> = {};
    for (const kind of SYNC_KINDS) {
      const row = await this.templateRows
        .findOne({ companyId, templateId, kind, status: 'published', deletedAt: null })
        .sort({ version: -1 })
        .lean()
        .exec() as { version: number; payload: Row } | null;
      if (row) out[kind] = { version: row.version, payload: row.payload ?? {} };
    }
    return out;
  }

  /** The KPM's rows and its revision — every row, archived ones too, read through its repositories. */
  private async officeOf(ctx: RequestContext): Promise<{ rows: SyncOfficeRows; revision: string }> {
    const plain = (docs: Document[]) => docs.map((d) => d.toObject() as Row);
    const [categories, skills, modules, catalog] = await Promise.all([
      this.categories.find(ctx, {}).then(plain),
      this.skills.find(ctx, {}).then(plain),
      this.modules.find(ctx, {}, { projection: { companyContent: 0, officeContent: 0, contentHistory: 0 } }).then(plain),
      this.capability.findOne(ctx, {}),
    ]);
    const held = catalog ? (catalog.toObject() as unknown as Row) : null;
    return {
      rows: { categories, skills, modules, grids: (held?.grids as SyncOfficeRows['grids'] | undefined) ?? [] },
      revision: trainingRevision({ categories, skills, modules, catalog: held }),
    };
  }
}

const SYNC_KINDS = ['training_taxonomy', 'capability_ladder'] as const;
type SyncKind = (typeof SYNC_KINDS)[number];
const NONE: Partial<Record<SyncKind, Newest>> = {};

const versionsOf = (newest: Partial<Record<SyncKind, Newest>>): TemplateSyncVersions => ({
  training_taxonomy: newest.training_taxonomy?.version ?? null,
  capability_ladder: newest.capability_ladder?.version ?? null,
});
