import {
  ACTIVITY_TEXT, SEED_ACTIVITY_CATEGORIES, SEED_ACTIVITY_TYPES, SEED_LEAD_STATUSES,
  SEED_RATIO_DEFINITIONS, type SeedActivityCategory, type SeedActivityType,
} from '@/domain/constants';
import { defaultTrainingTaxonomy } from '@/modules/training/training-payload';
import { defaultActivationChecklist } from '@/modules/activation/activation-payload';
import { defaultCapabilityLadder } from '@/modules/capability/capability-payload';
import { defaultEventTypes } from '@/modules/events/event-types-payload';
import { defaultCampaignKinds } from '@/modules/campaigns/campaign-kinds-payload';
import { defaultPlaybookBody } from '@/modules/recruitment/recruitment-playbook-defaults';
import { platformAnalyticsConfig } from './analytics-config';
import type { TemplateKind } from './company-template.schema';
import { boundCodes, defaultBinding, type CascadeBinding } from './activity-binding';

/**
 * **The seven kinds a named template holds** (ADR-0115 §3): what is copied into an office.
 *
 * `campaign_kinds` is the eighth `companyTemplates` kind and is not here. It is applied to the
 * company's carrier rules when it is published and read live by every office (ADR-0026), so it is
 * the company's — one per company, shared by every template — and its rows carry `templateId: null`.
 */
export const OFFICE_TEMPLATE_KINDS = [
  'activity_taxonomy',
  'lead_pipeline',
  'ratio_set',
  'activation_checklist',
  'training_taxonomy',
  'capability_ladder',
  'event_types',
] as const satisfies readonly TemplateKind[];
export type OfficeTemplateKind = (typeof OFFICE_TEMPLATE_KINDS)[number];

/** Is this kind copied into an office — one of the seven, rather than the company's or the playbook? */
export function isOfficeTemplateKind(kind: TemplateKind): kind is OfficeTemplateKind {
  return (OFFICE_TEMPLATE_KINDS as readonly string[]).includes(kind);
}

/**
 * **Every kind a named template holds: its sections' kinds** (ADR-0210 §1). The seven office kinds and the recruitment
 * playbook, which a template holds, drafts, publishes and copies like them, but which **no office copies**: each KPM reads
 * its template's published playbook live (ADR-0210 §4). So a template's checklist, its copies and *Terbitkan semua* read
 * this list; provisioning, the push and the offices' standing read {@link OFFICE_TEMPLATE_KINDS}.
 */
export const NAMED_TEMPLATE_KINDS = [
  ...OFFICE_TEMPLATE_KINDS, 'recruitment_playbook',
  // P19.5-T1 (ADR-0214 §1): the eighth section, read live by every KPM on the template — never copied, never pushed.
  'advanced_analytics',
  // P19.6-T1 (ADR-0218 §3): the ninth, *Tampilan* — read live, never copied, never pushed, and no lock.
  'branding',
] as const satisfies readonly TemplateKind[];
export type NamedTemplateKind = (typeof NAMED_TEMPLATE_KINDS)[number];

/** Is this kind held by a named template, rather than by the company itself (`campaign_kinds`)? */
export function isNamedTemplateKind(kind: TemplateKind): kind is NamedTemplateKind {
  return (NAMED_TEMPLATE_KINDS as readonly string[]).includes(kind);
}

/**
 * **The AgencyBoost defaults**: the platform's own payload of each kind (ADR-0115 §4).
 *
 * One function for every reader — *New template from the AgencyBoost defaults*, provisioning's
 * *AgencyBoost defaults* source, migration `0023` and the `campaign_kinds` tab's starting point — so
 * the defaults a template is given and the defaults an office is given cannot drift. Each call is a
 * fresh copy: a caller may change what it is handed.
 */
export function platformDefaultPayload(kind: TemplateKind): Record<string, unknown> {
  switch (kind) {
    case 'activity_taxonomy':
      return {
        categories: SEED_ACTIVITY_CATEGORIES.map((c) => ({ ...c })),
        types: SEED_ACTIVITY_TYPES.map((t) => ({ ...t })),
        // Which types each cascade role counts (ADR-0163 §1): the platform's three, one per role.
        bindings: defaultBinding(),
      };
    case 'lead_pipeline':
      return { statuses: SEED_LEAD_STATUSES.map((s) => ({ ...s })) };
    case 'ratio_set':
      return {
        ratios: SEED_RATIO_DEFINITIONS.map((r) => ({
          ...r, numerator: [...r.numerator], denominator: [...r.denominator],
        })),
      };
    case 'training_taxonomy':
      return { ...defaultTrainingTaxonomy() };
    case 'activation_checklist':
      return { ...defaultActivationChecklist() };
    case 'capability_ladder':
      return { ...defaultCapabilityLadder() };
    case 'event_types':
      return { ...defaultEventTypes() };
    case 'campaign_kinds':
      return { ...defaultCampaignKinds() };
    case 'recruitment_playbook':
      // The AgencyBoost words (ADR-0125 §2), what *Mulai dari kata-kata AgencyBoost* starts a template's section from.
      return defaultPlaybookBody() as unknown as Record<string, unknown>;
    case 'advanced_analytics':
      // Version 1's seven columns with the first pattern (ADR-0214 §3, §9): what a KPM reads where nothing is published.
      return platformAnalyticsConfig() as unknown as Record<string, unknown>;
    case 'branding':
      // AgencyBoost's own (ADR-0218 §3): nothing set, so a KPM on the template shows AgencyBoost's logo, colours and Boost.
      return { logo: null, logoSquare: null, primary: null, secondary: null, mascot: null };
  }
}

/**
 * **A template type's *Nama singkat*, as an office is given it** (P19.8-T4, ADR-0229 §5).
 *
 * - **A payload that carries the key gives what it says** — a text, or `null` for none (the template's author cleared it).
 * - **A payload type with no such key** — every template published before the field, and an office's published settings
 *   saved as a template before it — **gives the platform's short name for its code** (`SEED_ACTIVITY_TYPES`), or `null`
 *   for a code of the office's own. So provisioning from an old template gives the approved words, and a push of one
 *   never wipes what migration `0060` wrote into an office.
 *
 * Provisioning and the push call this one rule, so the two cannot give an office different words.
 */
export function shortLabelOf(type: { code: string; shortLabel?: string | null }): string | null {
  if (Object.prototype.hasOwnProperty.call(type, 'shortLabel') && type.shortLabel !== undefined) {
    const own = typeof type.shortLabel === 'string' ? type.shortLabel.trim() : null;
    return own || null;
  }
  return SEED_ACTIVITY_TYPES.find((t) => t.code === type.code)?.shortLabel ?? null;
}

/**
 * **The codes of a template's types whose *Nama singkat* an office's own write would refuse** (P19.8-T4, ADR-0229 §5):
 * not text and not `null`, or longer than `ACTIVITY_TEXT.SHORT_LABEL_MAX` once trimmed. Absent is fine (`shortLabelOf`).
 */
export function typeShortLabelProblems(types: unknown): string[] {
  if (!Array.isArray(types)) return [];
  return types
    .filter((t): t is { code?: unknown; shortLabel?: unknown } => t !== null && typeof t === 'object')
    .filter((t) => {
      const value = t.shortLabel;
      if (value === undefined || value === null) return false;
      return typeof value !== 'string' || value.trim().length > ACTIVITY_TEXT.SHORT_LABEL_MAX;
    })
    .map((t) => String(t.code ?? '?'));
}

/**
 * **A taxonomy with every type its binding names in it** (ADR-0115 §2, amended by ADR-0163 §5).
 *
 * The goal cascade and the summary count the codes the office's activity binding names, and an Owner has no way
 * to give a type a chosen code — so an office without a bound type would have a goal page and a summary that
 * count nothing for that role. Each bound code the source lacks is added, active, **when it is one of the
 * platform's types**, with its platform label and description, in its platform category; that category is added
 * with its platform label when the source has none. A bound code that is neither the source's nor the platform's
 * cannot be added, and the template's publish and provisioning's whole-source check refuse it before this runs. A
 * type the source already holds keeps the source's label and category: renaming and moving are the source's.
 *
 * `binding` is the source's own, or the default binding when it holds none — the platform's three, which is what
 * this added before there were bindings. Added last in display order, after what the source orders, so the
 * source's own order stands. For an empty source that is the platform's own order: *Leads Generation* then
 * *Selling*.
 */
export function withCascadeTypes(
  categories: readonly SeedActivityCategory[],
  types: readonly SeedActivityType[],
  binding: CascadeBinding = defaultBinding(),
): { categories: SeedActivityCategory[]; types: SeedActivityType[]; added: string[] } {
  const outCategories = [...categories];
  const outTypes = [...types];
  const added: string[] = [];

  for (const code of boundCodes(binding)) {
    if (outTypes.some((t) => t.code === code)) continue;
    const platform = SEED_ACTIVITY_TYPES.find((t) => t.code === code);
    if (!platform) continue;

    if (!outCategories.some((c) => c.code === platform.categoryCode)) {
      const category = SEED_ACTIVITY_CATEGORIES.find((c) => c.code === platform.categoryCode)!;
      outCategories.push({
        ...category,
        displayOrder: Math.max(0, ...outCategories.map((c) => c.displayOrder)) + 1,
        // A tile of its own: a group code from the platform's grouping could collide with the source's.
        summaryGroupCode: null,
        summaryGroupLabel: null,
      });
    }
    outTypes.push({
      ...platform,
      displayOrder: Math.max(0, ...outTypes.map((t) => t.displayOrder)) + 1,
    });
    added.push(code);
  }
  return { categories: outCategories, types: outTypes, added };
}

/**
 * **A capability ladder, the platform's where the source has none** (ADR-0116).
 *
 * The ladder is structural, as the three cascade types are: *Leader Notes* places people on its stages,
 * and *Capability Mapping* can add milestones and grid items but never a stage or a grid, so an office
 * given no ladder could never build one. A source holding none — *Empty*, a template that never published
 * the kind, an office saved as a template after every stage was archived — or a payload with no stage
 * gives the four stages, five milestones and four grids of `platformDefaultPayload('capability_ladder')`,
 * and `supplied` says so. A source with a ladder keeps its own, whole: nothing is merged into it.
 */
export function withPlatformLadder(
  payload: Record<string, unknown> | null,
): { payload: Record<string, unknown>; supplied: boolean } {
  const stages = payload?.stages;
  const none = !payload || stages === undefined || (Array.isArray(stages) && stages.length === 0);
  return none
    ? { payload: platformDefaultPayload('capability_ladder'), supplied: true }
    : { payload, supplied: false };
}
