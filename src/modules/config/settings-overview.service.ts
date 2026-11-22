import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { requireOfficeSteward } from '@/common/auth/office-steward';
import { RequestContext } from '@/common/context/request-context';
import { ActivationService } from '@/modules/activation/activation.service';
import { BrandingReader } from '@/modules/branding/branding-reader';
import { CapabilityService } from '@/modules/capability/capability.service';
import { KpmProductService } from '@/modules/products/kpm-product.service';
import { can } from '@/modules/rbac/permissions';
import { RecruitmentPitchService } from '@/modules/recruitment/recruitment-pitch.service';
import { Kpm } from '@/modules/tenants/kpm.schema';
import { TrainingService } from '@/modules/training/training.service';
import { ActivityConfigService } from './activity.service';
import { PUBLISHED_SETTINGS, type PublishedSetting } from './publish-settings';
import { TenantConfigService } from './tenant-config.service';

/**
 * **The eleven settings behind one *Pengaturan* item** (P19.21-T2 AC-1, AC-2; ADR-0274 §6), in the hub's order: the
 * six with a draft, then the five saved live.
 */
export const HUB_SETTINGS = [
  ...PUBLISHED_SETTINGS, 'campaigns', 'products', 'recruitment_pitch', 'branch_info', 'branding',
] as const;

export type HubSetting = (typeof HUB_SETTINGS)[number];

/**
 * **A status only when the owner must act** (AC-2): *Belum diterbitkan* (`unpublished`), *n menunggu* (`waiting`: script
 * overrides waiting for the reader's approval), *n belum ada* (`missing`: pitch materials not uploaded), *Logo belum ada*
 * (`no_logo`). A setting that is fine has none — no *Draf*, no *Siap*.
 */
export type HubStatus =
  | { kind: 'unpublished' }
  | { kind: 'waiting'; count: number }
  | { kind: 'missing'; count: number }
  | { kind: 'no_logo' };

/** What a row's one-line description counts — each field only on the setting that shows it, else `null`. */
export interface HubCounts {
  /** Activity types: active activities and categories. Training: categories, skills, modules. */
  activities: number | null;
  categories: number | null;
  skills: number | null;
  modules: number | null;
  /** Activation checklist: the window, and the version new hires are given (`null` before the first publish). */
  windowDays: number | null;
  version: number | null;
  /** Capability Mapping: the ladder's active stages and the skill tracker's active groups. */
  stages: number | null;
  skillGroups: number | null;
  /** Products: base products on the shelf, and those agents sell. */
  products: number | null;
  sold: number | null;
  /** Recruitment pitch: the materials agents see. */
  materials: number | null;
  /** Branch info: the KPM's code and the month its book year starts (1–12). */
  kpmCode: string | null;
  fiscalYearStartMonth: number | null;
}

export interface HubSettingView {
  setting: HubSetting;
  status: HubStatus | null;
  counts: HubCounts;
}

export interface SettingsOverview {
  settings: HubSettingView[];
  /** The settings with changes agents do not see, in the hub's order — the orange bar's (AC-1). */
  unpublished: PublishedSetting[];
}

const NO_COUNTS: HubCounts = {
  activities: null, categories: null, skills: null, modules: null, windowDays: null, version: null, stages: null,
  skillGroups: null, products: null, sold: null, materials: null, kpmCode: null, fiscalYearStartMonth: null,
};

/**
 * **`GET /kpm/settings/overview`** — the hub's one read (P19.21-T2).
 *
 * A steward's (ADR-0268): the Owner, an Admin, a core leader, the Super Admin inside the KPM, and a support session as
 * one of them. Anybody else in the KPM is answered **404** (`requireOfficeSteward`), as KPM analytics answers: a refusal
 * never says there is a page they are kept from. Every figure is read through the service that owns it, tenant-scoped,
 * from the reader's own KPM — there is no id to name another's.
 */
@Injectable()
export class SettingsOverviewService {
  constructor(
    private readonly config: TenantConfigService,
    private readonly activity: ActivityConfigService,
    private readonly training: TrainingService,
    private readonly capability: CapabilityService,
    private readonly activation: ActivationService,
    private readonly products: KpmProductService,
    private readonly pitch: RecruitmentPitchService,
    private readonly branding: BrandingReader,
    /** The office's own row — the one document a scoped service may read by the context's id (`ProductionService`). */
    @InjectModel(Kpm.name) private readonly kpms: Model<Kpm>,
  ) {}

  async read(ctx: RequestContext): Promise<SettingsOverview> {
    const kpmId = requireOfficeSteward(ctx);
    const [state, categories, training, capability, checklist, shelf, pitch, shown, office] = await Promise.all([
      this.config.state(ctx),
      this.activity.list(ctx),
      this.training.list(ctx),
      this.capability.own(ctx),
      this.activation.read(ctx),
      this.products.list(ctx),
      this.pitch.read(ctx),
      this.branding.shownFor(kpmId),
      this.kpms.findById(kpmId).select('code fiscalYearStartMonth').lean().exec() as Promise<
        { code?: string; fiscalYearStartMonth?: number } | null
      >,
    ]);

    const unpublished = state.settings.filter((s) => s.hasUnpublishedChanges).map((s) => s.setting);
    const active = <T extends { status?: string }>(rows: readonly T[]) => rows.filter((r) => (r.status ?? 'active') === 'active');
    const bases = shelf.filter((p) => p.kind !== 'rider');
    const waiting = can(ctx, 'sales_script:approve') ? shelf.filter((p) => p.reviewState === 'pending').length : 0;
    const missing = pitch.slots.filter((slot) => slot.state === 'missing').length;

    const counted = (setting: HubSetting): Partial<HubCounts> => {
      switch (setting) {
        case 'activity_types':
          return { activities: categories.reduce((n, c) => n + c.types.length, 0), categories: categories.length };
        case 'training': {
          const cats = active(training);
          const skills = cats.flatMap((c) => active(c.skills));
          return { categories: cats.length, skills: skills.length, modules: skills.flatMap((s) => active(s.modules)).length };
        }
        case 'activation_checklist':
          return { windowDays: checklist.windowDays, version: checklist.published?.version ?? null };
        case 'capability_mapping':
          return {
            stages: capability ? active(capability.stages).length : 0,
            skillGroups: capability ? active(capability.grids).length : 0,
          };
        case 'products':
          return { products: bases.length, sold: bases.filter((p) => p.sellable && p.active.value).length };
        case 'recruitment_pitch':
          return { materials: pitch.slots.length };
        case 'branch_info':
          return { kpmCode: office?.code ?? null, fiscalYearStartMonth: office?.fiscalYearStartMonth ?? null };
        default:
          return {};
      }
    };

    const statusOf = (setting: HubSetting): HubStatus | null => {
      if ((unpublished as readonly string[]).includes(setting)) return { kind: 'unpublished' };
      if (setting === 'products' && waiting > 0) return { kind: 'waiting', count: waiting };
      if (setting === 'recruitment_pitch' && missing > 0) return { kind: 'missing', count: missing };
      if (setting === 'branding' && !shown?.logo) return { kind: 'no_logo' };
      return null;
    };

    return {
      settings: HUB_SETTINGS.map((setting) => ({
        setting, status: statusOf(setting), counts: { ...NO_COUNTS, ...counted(setting) },
      })),
      unpublished,
    };
  }
}
