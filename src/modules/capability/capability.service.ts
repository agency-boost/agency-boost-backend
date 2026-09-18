import { BadRequestException, Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException } from '@/common/errors/domain.exception';
import { capabilityStageFor, type CapabilityStage } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { CapabilityCatalogDocument } from './capability.schema';
import { CapabilityCatalogRepository } from './capability.repository';
import { capabilitySeedDocument, defaultCapabilityLadder } from './capability-payload';

export interface CapabilityEntryView {
  code: string;
  label: string;
  displayOrder: number;
  status: 'active' | 'archived';
}

export interface CapabilityStageView extends CapabilityEntryView {
  requiredMilestoneCodes: string[];
  /** How senior the stage is, which is **not** its position on screen. */
  stageOrder: number;
}

export interface CapabilityGridView extends CapabilityEntryView {
  requiresDownline: boolean;
  items: CapabilityEntryView[];
}

export interface CapabilityCatalogView {
  stages: CapabilityStageView[];
  milestones: CapabilityEntryView[];
  grids: CapabilityGridView[];
  version: number;
}

/** Where an item lives. Named rather than a path string, so a caller cannot invent one. */
export type CapabilityPart = 'stage' | 'milestone' | 'grid' | 'item';

/**
 * An office's capability catalog (P5-T8, ADR-0025, ADR-0036).
 *
 * **The Owner and the Admin edit it; leaders assess against it.** One catalog per office is what
 * makes two leaders' assessments comparable, and a grid each leader could extend is a grid nobody
 * can roll up.
 *
 * **Nothing is ever deleted and no code is ever reused.** A tick binds to a code, so a code that
 * came back as something else would silently re-point every assessment that used it.
 */
@Injectable()
export class CapabilityService {
  constructor(
    private readonly catalogs: CapabilityCatalogRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * The office's catalog.
   *
   * An office provisioned before this feature existed has none, so it reads as the defaults —
   * unsaved — the way the activation checklist does. Writing on a read is the Owner's act, not a
   * read's.
   */
  async read(ctx: RequestContext): Promise<CapabilityCatalogView> {
    const row = await this.catalogs.findOne(ctx, {});
    if (!row) return this.view(capabilitySeedDocument('', defaultCapabilityLadder()) as never);
    return this.view(row);
  }

  /** Rename anything. **The code never moves**, whatever the body carries (AC-4). */
  async rename(
    ctx: RequestContext, part: CapabilityPart, code: string, label: string, gridCode?: string,
  ): Promise<CapabilityCatalogView> {
    const trimmed = label.trim();
    if (!trimmed) throw new BadRequestException('A label cannot be empty.');

    const row = await this.require(ctx);
    const target = this.find(row, part, code, gridCode);
    target.label = trimmed;

    return this.save(ctx, row, 'capability.renamed', { part, code, label: trimmed });
  }

  /**
   * Archive or restore. **There is no delete** (AC-4).
   *
   * An archived item keeps rendering on assessments that already reference it and takes no new
   * ones — the rule every other configuration collection in this product follows.
   */
  async setStatus(
    ctx: RequestContext,
    part: CapabilityPart,
    code: string,
    status: 'active' | 'archived',
    gridCode?: string,
  ): Promise<CapabilityCatalogView> {
    const row = await this.require(ctx);
    const target = this.find(row, part, code, gridCode);

    if (part === 'milestone' && status === 'archived') {
      // A stage requiring an archived milestone is a stage nobody could reach again.
      const needed = row.stages.filter((s) => s.requiredMilestoneCodes.includes(code));
      if (needed.length > 0) {
        throw new BadRequestException(
          `${needed.map((s) => s.label).join(', ')} require this milestone, so archiving it would `
          + 'make those stages unreachable. Take it out of them first.',
        );
      }
    }

    target.status = status;
    return this.save(ctx, row, `capability.${status === 'archived' ? 'archived' : 'restored'}`, {
      part, code,
    });
  }

  /**
   * Add an item, with a code the office chooses once.
   *
   * Refused when the code is already used **anywhere in the catalog, archived rows included**: a
   * tick names a code, so a reused one would re-point every assessment that held it.
   */
  async add(
    ctx: RequestContext,
    part: 'milestone' | 'item',
    code: string,
    label: string,
    gridCode?: string,
  ): Promise<CapabilityCatalogView> {
    const normalised = code.trim().toUpperCase();
    if (!normalised) throw new BadRequestException('An item needs a code.');
    if (!label.trim()) throw new BadRequestException('An item needs a label.');

    const row = await this.require(ctx);
    if (this.codes(row).has(normalised)) {
      throw new BadRequestException(
        `${normalised} is already used in this catalog. A code is never reused — a tick names one, `
        + 'so the same code twice would be the same tick.',
      );
    }

    if (part === 'milestone') {
      row.milestones.push({
        code: normalised, label: label.trim(),
        displayOrder: row.milestones.length + 1, status: 'active',
      } as never);
    } else {
      const grid = row.grids.find((g) => g.code === gridCode);
      if (!grid) throw new NotFoundException('CapabilityGrid');
      grid.items.push({
        code: normalised, label: label.trim(),
        displayOrder: grid.items.length + 1, status: 'active',
      } as never);
    }

    return this.save(ctx, row, 'capability.added', { part, code: normalised });
  }

  /**
   * Reorder a list, **which never touches `stageOrder`** (AC-6).
   *
   * Position on screen and seniority are two facts. The prototype has only one — it works the stage
   * out from the array index — so tidying the ladder there would move everybody's stage.
   */
  async reorder(
    ctx: RequestContext, part: 'stage' | 'milestone' | 'grid', codes: string[],
  ): Promise<CapabilityCatalogView> {
    const row = await this.require(ctx);
    const list = part === 'stage' ? row.stages : (part === 'milestone' ? row.milestones : row.grids);

    const known = new Set(list.map((entry) => entry.code));
    if (codes.length !== list.length || new Set(codes).size !== codes.length
      || codes.some((code) => !known.has(code))) {
      throw new BadRequestException(
        `Send every ${part} once each — ${list.length} of them.`,
      );
    }
    codes.forEach((code, index) => {
      const entry = list.find((e) => e.code === code)!;
      entry.displayOrder = index + 1;
    });

    return this.save(ctx, row, 'capability.reordered', { part, count: codes.length });
  }

  /** The office's catalog at provisioning, from its company's preset or the defaults. */
  async seedForOffice(ctx: RequestContext): Promise<boolean> {
    if (await this.catalogs.exists(ctx, {})) return false;
    const seed = capabilitySeedDocument(ctx.kpmId ?? '', defaultCapabilityLadder());
    await this.catalogs.create(ctx, {
      stages: seed.stages, milestones: seed.milestones, grids: seed.grids, version: 1,
    } as never);
    return true;
  }

  /**
   * Which stage somebody is at, from what a leader has ticked (AC-6).
   *
   * No route reads it: Phase 13's Leader Notes calls it when it renders an assessment, and an
   * endpoint nothing calls is the defect `backend-then-frontend.md` exists to prevent.
   */
  async stageFor(ctx: RequestContext, ticked: string[]): Promise<CapabilityStageView | null> {
    const { stages } = await this.read(ctx);
    const reached = capabilityStageFor(stages as unknown as CapabilityStage[], ticked);
    return reached ? (reached as unknown as CapabilityStageView) : null;
  }

  // -------------------------------------------------------------------- internals

  private async require(ctx: RequestContext): Promise<CapabilityCatalogDocument> {
    const row = await this.catalogs.findOne(ctx, {});
    if (row) return row;
    // An office provisioned before this feature: its first edit saves the defaults it was reading.
    const seed = capabilitySeedDocument(ctx.kpmId ?? '', defaultCapabilityLadder());
    return this.catalogs.create(ctx, {
      stages: seed.stages, milestones: seed.milestones, grids: seed.grids, version: 1,
    } as never);
  }

  /** Every code in the catalog, archived rows included — a code is never reused. */
  private codes(row: CapabilityCatalogDocument): Set<string> {
    return new Set([
      ...row.stages.map((s) => s.code),
      ...row.milestones.map((m) => m.code),
      ...row.grids.flatMap((g) => [g.code, ...g.items.map((i) => i.code)]),
    ]);
  }

  private find(
    row: CapabilityCatalogDocument, part: CapabilityPart, code: string, gridCode?: string,
  ): { label: string; status: 'active' | 'archived' } {
    const found = part === 'stage' ? row.stages.find((s) => s.code === code)
      : part === 'milestone' ? row.milestones.find((m) => m.code === code)
        : part === 'grid' ? row.grids.find((g) => g.code === code)
          : row.grids.find((g) => g.code === gridCode)?.items.find((i) => i.code === code);
    if (!found) throw new NotFoundException('CapabilityItem');
    return found;
  }

  private async save(
    ctx: RequestContext,
    row: CapabilityCatalogDocument,
    action: string,
    after: Record<string, unknown>,
  ): Promise<CapabilityCatalogView> {
    row.version += 1;
    row.updatedBy = ctx.membershipId;
    await row.save();
    await this.audit.record(ctx, {
      action, targetCollection: 'capabilityCatalogs', targetId: String(row._id), after,
    });
    return this.view(row);
  }

  private view(row: CapabilityCatalogDocument): CapabilityCatalogView {
    const entry = (e: { code: string; label: string; displayOrder: number; status: string }) => ({
      code: e.code, label: e.label, displayOrder: e.displayOrder,
      status: e.status as 'active' | 'archived',
    });
    const ordered = <T extends { displayOrder: number }>(list: T[]) =>
      [...list].sort((a, b) => a.displayOrder - b.displayOrder);

    return {
      stages: ordered(row.stages).map((s) => ({
        ...entry(s),
        requiredMilestoneCodes: [...s.requiredMilestoneCodes],
        stageOrder: s.stageOrder,
      })),
      milestones: ordered(row.milestones).map(entry),
      grids: ordered(row.grids).map((g) => ({
        ...entry(g),
        requiresDownline: g.requiresDownline,
        items: ordered(g.items).map(entry),
      })),
      version: row.version,
    };
  }
}
