import {
  CASCADE_ACTIVITY_CODES, SEED_ACTIVITY_CATEGORIES, SEED_ACTIVITY_TYPES, SEED_LEAD_STATUSES,
  SEED_RATIO_DEFINITIONS, type SeedActivityCategory, type SeedActivityType,
} from '@/domain/constants';
import { defaultTrainingTaxonomy } from '@/modules/training/training-payload';
import { defaultActivationChecklist } from '@/modules/activation/activation-payload';
import { defaultCapabilityLadder } from '@/modules/capability/capability-payload';
import { defaultEventTypes } from '@/modules/events/event-types-payload';
import { defaultCampaignKinds } from '@/modules/campaigns/campaign-kinds-payload';
import type { TemplateKind } from './company-template.schema';

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

/** Is this kind held by a named template, rather than by the company itself? */
export function isOfficeTemplateKind(kind: TemplateKind): kind is OfficeTemplateKind {
  return (OFFICE_TEMPLATE_KINDS as readonly string[]).includes(kind);
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
  }
}

/** The three codes the goal cascade and the summary count (ADR-0115 §2, `CASCADE_ACTIVITY_CODES`). */
export const RESERVED_ACTIVITY_CODES: readonly string[] = Object.values(CASCADE_ACTIVITY_CODES);

/**
 * **A taxonomy with the three cascade types in it, active** (ADR-0115 §2).
 *
 * The goal cascade and the summary count `LEADS_CONTACTED`, `SELL_PRESENTATION` and
 * `SELL_SUBMISSION` by code, and an Owner has no way to give a type a chosen code — so an office
 * without them would have a goal page and a summary that count nothing, for good. Each one the source
 * lacks is added with its platform label and description, in its platform category; that category is
 * added with its platform label when the source has none. A type the source already holds keeps the
 * source's label and category: renaming and moving are the source's to decide.
 *
 * Added last in display order — after what the source orders, so the source's own order stands. For
 * an empty source that is the platform's own order: *Leads Generation* then *Selling*.
 */
export function withCascadeTypes(
  categories: readonly SeedActivityCategory[],
  types: readonly SeedActivityType[],
): { categories: SeedActivityCategory[]; types: SeedActivityType[]; added: string[] } {
  const outCategories = [...categories];
  const outTypes = [...types];
  const added: string[] = [];

  for (const code of RESERVED_ACTIVITY_CODES) {
    if (outTypes.some((t) => t.code === code)) continue;
    const platform = SEED_ACTIVITY_TYPES.find((t) => t.code === code)!;

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
