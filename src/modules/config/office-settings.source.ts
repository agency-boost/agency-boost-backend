import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { ActivationTemplateRepository } from '@/modules/activation/activation.repository';
import { AssetRepository } from '@/modules/assets/asset.repository';
import type { AssetDocument } from '@/modules/assets/asset.schema';
import { TrainingModuleRepository } from '@/modules/training/training.repository';
import { ConfigSnapshotRepository } from './activity.repository';
import type { OfficeSettings } from './office-template';

/**
 * **One office's published settings, read by the Super Admin** (P13.2-T7, ADR-0115 §5, §6) — the
 * named cross-tenant read behind *Save as template*.
 *
 * The Super Admin is in no office, so there is no tenant to read within. Every read here goes
 * through `findInOfficeAcrossTenants` on a **configuration** repository, which names the office
 * (never an absent filter) and refuses anybody but a Super Admin. Nothing here can reach business
 * data: it is constructed with configuration repositories and the asset registry, and
 * `named-cross-tenant-reads.tenancy.spec.ts` fails if it is given anything else, or if anything
 * else calls the method.
 *
 * What it reads is what the office's agents read (`multi-tenancy-and-scoping.md`, *Phase 13.2's named
 * cross-tenant reads*): the newest snapshot — the taxonomy, ratios, pipelines, training, event types
 * and capability catalog agents are on — the newest **published** checklist, and the content of the
 * modules that snapshot offers, by code. **Not the live training, event-type or capability rows**
 * (exit review of P13.2, finding 1): the Owner's staged batch writes those before Publish, so they may
 * hold the Owner's unpublished edits. Content is read live because no snapshot carries it (P5-T2).
 */
@Injectable()
export class OfficeSettingsSource {
  constructor(
    private readonly snapshots: ConfigSnapshotRepository,
    private readonly checklists: ActivationTemplateRepository,
    private readonly trainingModules: TrainingModuleRepository,
    private readonly assets: AssetRepository,
  ) {}

  /** What the office's agents read, for `templateKindsFromOffice`. */
  async publishedSettingsOf(ctx: RequestContext, kpmId: string): Promise<OfficeSettings> {
    const newest = { sort: { version: -1 as const }, limit: 1 };
    const [[snapshot], [checklist]] = await Promise.all([
      this.snapshots.findInOfficeAcrossTenants(ctx, kpmId, {}, newest),
      this.checklists.findInOfficeAcrossTenants(ctx, kpmId, { status: 'published' }, newest),
    ]);
    const payload = (snapshot?.payload as Record<string, unknown> | undefined) ?? null;
    const codes = offeredModuleCodes(payload);
    const modules = codes.length
      ? await this.trainingModules.findInOfficeAcrossTenants(ctx, kpmId, { code: { $in: codes } })
      : [];

    return {
      snapshot: payload,
      checklist: checklist ? checklist.toObject() as unknown as OfficeSettings['checklist'] : null,
      moduleContent: modules.map((m) => {
        const row = m.toObject() as unknown as OfficeSettings['moduleContent'][number];
        return { code: row.code, companyContent: row.companyContent ?? null, officeContent: row.officeContent ?? null };
      }),
    };
  }

  /**
   * The office's **own** files a template is about to duplicate (ADR-0032): its uploads, by key, so
   * each is known to be the office's and to have arrived before any byte is copied.
   */
  async officeFiles(ctx: RequestContext, kpmId: string, storageKeys: string[]): Promise<AssetDocument[]> {
    if (storageKeys.length === 0) return [];
    return this.assets.findInOfficeAcrossTenants(ctx, kpmId, { storageKey: { $in: storageKeys } });
  }
}

/** Every module code the snapshot's training names: the only modules whose content is asked for. */
function offeredModuleCodes(payload: Record<string, unknown> | null): string[] {
  const categories = (payload?.training ?? []) as { skills?: { modules?: { code: string }[] }[] }[];
  return [...new Set(categories.flatMap((c) => (c.skills ?? []).flatMap((s) => (s.modules ?? []).map((m) => m.code))))];
}
