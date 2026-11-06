import {
  defaultDisplayUnitFor, resolveDisplayUnit,
  type SeedActivityCategory, type SeedActivityType, type SeedLeadStatus, type SeedRatioDefinition,
} from '@/domain/constants';
import { activationSeedAspects } from '@/modules/activation/activation-payload';
import { capabilitySeedDocument, type CapabilityLadderPayload } from '@/modules/capability/capability-payload';
import { eventTypeSeedDocuments, type EventTypesPayload } from '@/modules/events/event-types-payload';
import { namedAs, trainingSeedDocuments, type TrainingTaxonomyPayload } from '@/modules/training/training-payload';
import { bindingOfPayload, defaultBinding, type CascadeBinding } from './activity-binding';
import {
  OFFICE_TEMPLATE_KINDS, withCascadeTypes, withPlatformLadder, type OfficeTemplateKind,
} from './template-defaults';

/**
 * **A template's sections, compared with a KPM's by code, and what a push writes** (ADR-0208 §4, §5).
 *
 * Pure: `TemplatePushService` reads the rows and writes them; this decides what each kind's *items* are — the rows an
 * Owner edits, each by its code and **the fields an Owner edits**, never an id, a version, an author or a timestamp — and
 * which of them a KPM added, removed or changed against the version it was last given. One function per kind, with its
 * own unit spec, so *"changed by the KPM"* is one rule that both the dialog's list and the push's second check read.
 */

/** One item's fields, as compared: plain values, arrays of codes kept in their order. */
export type ItemFields = Record<string, unknown>;

/** One kind's items: each level (`categories`, `types`, …) its items by key. */
export type KindItems = Record<string, Map<string, ItemFields>>;

/** **One thing a KPM did to a section**, against the template version it was last given (ADR-0208 §4). */
export interface PushDifference {
  /** The level: `categories`, `types`, `binding`, `ratios`, `statuses`, `skills`, `modules`, … */
  level: string;
  /** The item's code (a checklist item and a grid item: `<parent>:<code>`). */
  code: string;
  change: 'added' | 'removed' | 'changed';
  /** `changed` only: the fields that differ — and `material` for a training module with the KPM's own. */
  fields?: string[];
}

/** The levels of each kind, in the order a difference is listed. */
export const KIND_LEVELS: Record<OfficeTemplateKind, readonly string[]> = {
  activity_taxonomy: ['categories', 'types', 'binding'],
  ratio_set: ['ratios'],
  lead_pipeline: ['statuses'],
  training_taxonomy: ['categories', 'skills', 'modules'],
  activation_checklist: ['aspects', 'items'],
  capability_ladder: ['stages', 'milestones', 'grids', 'gridItems'],
  event_types: ['types'],
};

type Row = Record<string, unknown>;

const sorted = (list: unknown): string[] => [...((Array.isArray(list) ? list : []) as string[])].map(String).sort();
const text = (value: unknown): string | null => {
  const s = typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value);
  return s === '' ? null : s;
};
const levels = (kind: OfficeTemplateKind): KindItems =>
  Object.fromEntries(KIND_LEVELS[kind].map((level) => [level, new Map<string, ItemFields>()]));

/** The binding as compared: each role's codes, sorted. */
const bindingFields = (binding: CascadeBinding): ItemFields => ({
  leads: sorted(binding.leads), appointments: sorted(binding.appointments), closings: sorted(binding.closings),
});

/** A ratio's unit, as provisioning resolves one (`seedRatioDefinitions`): its own, or the code's default. */
function ratioUnit(r: Row): unknown {
  const comparison = r.comparison as SeedRatioDefinition['comparison'];
  const resolved = resolveDisplayUnit(
    comparison, (r.displayUnit as string | undefined) ?? defaultDisplayUnitFor(String(r.code), comparison),
  );
  return resolved.refusal === undefined ? resolved.unit : r.displayUnit ?? null;
}

const ratioFields = (r: Row): ItemFields => ({
  label: text(r.label),
  numerator: [...((r.numerator as string[] | undefined) ?? [])],
  denominator: [...((r.denominator as string[] | undefined) ?? [])],
  benchmark: r.benchmark ?? null,
  comparison: r.comparison ?? null,
  displayUnit: ratioUnit(r),
  appliesToOrgLevelCodes: sorted(r.appliesToOrgLevelCodes),
});

const categoryFields = (c: Row): ItemFields => ({
  label: text(c.label),
  description: text(c.description),
  summaryGroupCode: text(c.summaryGroupCode),
  summaryGroupLabel: text(c.summaryGroupLabel),
  appliesToOrgLevelCodes: sorted(c.appliesToOrgLevelCodes),
});

const typeFields = (t: Row): ItemFields => ({
  categoryCode: text(t.categoryCode), label: text(t.label), description: text(t.description),
});

const statusFields = (s: Row): ItemFields => ({
  pipeline: s.pipeline ?? null,
  label: text(s.label),
  rank: s.rank ?? null,
  isTerminal: Boolean(s.isTerminal),
  isLateStage: Boolean(s.isLateStage),
});

const eventTypeFields = (t: Row): ItemFields => ({
  label: text(t.label), description: text(t.description), emoji: text(t.emoji), color: text(t.color),
});

/**
 * **The rows a template version gives an office**, as items (ADR-0208 §4): what provisioning would write from the
 * payload — the three cascade types whatever the source (ADR-0115 §2), the platform ladder where the source has none
 * (ADR-0116), codes normalised as the seeds normalise them. `null` (the template held none of the kind) gives nothing.
 */
export function itemsOfPayload(kind: OfficeTemplateKind, payload: Record<string, unknown> | null): KindItems {
  const items = levels(kind);
  switch (kind) {
    case 'activity_taxonomy': {
      const source = (payload ?? {}) as { categories?: SeedActivityCategory[]; types?: SeedActivityType[] };
      const binding = bindingOfPayload(payload) ?? defaultBinding();
      const { categories, types } = withCascadeTypes(source.categories ?? [], source.types ?? [], binding);
      const known = new Set(categories.map((c) => c.code));
      for (const c of categories) items.categories.set(c.code, categoryFields(c as unknown as Row));
      for (const t of types.filter((type) => known.has(type.categoryCode))) {
        items.types.set(t.code, typeFields(t as unknown as Row));
      }
      items.binding.set('binding', bindingFields(binding));
      return items;
    }
    case 'ratio_set':
      for (const r of ((payload?.ratios ?? []) as Row[])) items.ratios.set(String(r.code), ratioFields(r));
      return items;
    case 'lead_pipeline':
      for (const s of ((payload?.statuses ?? []) as SeedLeadStatus[])) {
        items.statuses.set(s.code, statusFields(s as unknown as Row));
      }
      return items;
    case 'training_taxonomy': {
      if (!payload) return items;
      const rows = trainingSeedDocuments('', payload as unknown as TrainingTaxonomyPayload);
      for (const c of rows.categories) items.categories.set(c.code, { label: c.label, description: c.description });
      // The descriptions too since P19.6-T4 (ADR-0220 §6): a push carries them, so a KPM that wrote its own is changed.
      for (const s of rows.skills) {
        items.skills.set(s.code, { categoryCode: s.categoryCode, label: s.label, description: s.description });
      }
      for (const m of rows.modules) {
        items.modules.set(m.code, {
          skillCode: m.skillCode, title: m.title, description: m.description, publishState: m.publishState,
        });
      }
      return items;
    }
    case 'activation_checklist':
      if (!payload) return items;
      for (const aspect of activationSeedAspects(payload)) {
        items.aspects.set(aspect.code, { label: aspect.label });
        for (const item of aspect.items) {
          items.items.set(`${aspect.code}:${item.code}`, { label: item.label, autoLink: item.autoLink ?? null });
        }
      }
      return items;
    case 'capability_ladder': {
      const ladder = capabilitySeedDocument('', withPlatformLadder(payload).payload as unknown as CapabilityLadderPayload);
      fillLadder(items, ladder);
      return items;
    }
    case 'event_types':
      if (!payload) return items;
      for (const t of eventTypeSeedDocuments('', payload as unknown as EventTypesPayload)) {
        items.types.set(t.code, eventTypeFields(t as unknown as Row));
      }
      return items;
  }
}

/** A capability catalog — a template's, as seeded, or an office's — as items, active rows only. */
function fillLadder(items: KindItems, ladder: {
  stages: Row[]; milestones: Row[]; grids: (Row & { items?: Row[] })[];
}): void {
  const live = (row: Row) => (row.status ?? 'active') === 'active';
  for (const s of ladder.stages.filter(live)) {
    items.stages.set(String(s.code), {
      label: text(s.label), requiredMilestoneCodes: sorted(s.requiredMilestoneCodes), stageOrder: s.stageOrder ?? null,
    });
  }
  for (const m of ladder.milestones.filter(live)) items.milestones.set(String(m.code), { label: text(m.label) });
  for (const g of ladder.grids.filter(live)) {
    items.grids.set(String(g.code), { label: text(g.label), requiresDownline: Boolean(g.requiresDownline) });
    for (const i of (g.items ?? []).filter(live)) items.gridItems.set(`${g.code}:${i.code}`, { label: text(i.label) });
  }
}

/** **What one office holds now**, each kind's live rows as `TemplatePushService` reads them. Active rows only. */
export interface OfficeRows {
  activityCategories: Row[];
  activityTypes: Row[];
  /** The office's activity binding, or `null`: it counts the default binding. */
  binding: Row | null;
  ratios: Row[];
  leadStatuses: Row[];
  trainingCategories: Row[];
  trainingSkills: Row[];
  trainingModules: Row[];
  /** The newest published checklist's aspects, or none. */
  checklist: Row[] | null;
  capability: { stages: Row[]; milestones: Row[]; grids: Row[] } | null;
  eventTypes: Row[];
}

/** **The items an office holds of one kind** (ADR-0208 §4): its active rows, on the fields an Owner edits. */
export function itemsOfOffice(kind: OfficeTemplateKind, office: OfficeRows): KindItems {
  const items = levels(kind);
  const active = (rows: Row[]) => rows.filter((r) => (r.status ?? 'active') === 'active');
  switch (kind) {
    case 'activity_taxonomy': {
      for (const c of active(office.activityCategories)) items.categories.set(String(c.code), categoryFields(c));
      for (const t of active(office.activityTypes)) items.types.set(String(t.code), typeFields(t));
      const binding = office.binding
        ? { leads: office.binding.leads, appointments: office.binding.appointments, closings: office.binding.closings }
        : defaultBinding();
      items.binding.set('binding', bindingFields(binding as CascadeBinding));
      return items;
    }
    case 'ratio_set':
      for (const r of active(office.ratios)) items.ratios.set(String(r.code), ratioFields(r));
      return items;
    case 'lead_pipeline':
      for (const s of active(office.leadStatuses)) items.statuses.set(String(s.code), statusFields(s));
      return items;
    case 'training_taxonomy':
      for (const c of active(office.trainingCategories)) {
        items.categories.set(String(c.code), { label: text(c.label), description: text(c.description) });
      }
      // A row the split migration has not reached (no `description`) reads split, as a payload's does (`namedAs`).
      for (const s of active(office.trainingSkills)) {
        const named = namedAs(s.label, s.description);
        items.skills.set(String(s.code), {
          categoryCode: s.categoryCode, label: text(named.name), description: named.description,
        });
      }
      for (const m of active(office.trainingModules)) {
        const named = namedAs(m.title, m.description);
        items.modules.set(String(m.code), {
          skillCode: m.skillCode, title: text(named.name), description: named.description, publishState: m.publishState,
        });
      }
      return items;
    case 'activation_checklist':
      for (const aspect of office.checklist ?? []) {
        items.aspects.set(String(aspect.code), { label: text(aspect.label) });
        for (const item of ((aspect.items ?? []) as Row[])) {
          items.items.set(`${aspect.code}:${item.code}`, { label: text(item.label), autoLink: item.autoLink ?? null });
        }
      }
      return items;
    case 'capability_ladder':
      if (office.capability) fillLadder(items, office.capability as never);
      return items;
    case 'event_types':
      for (const t of active(office.eventTypes)) items.types.set(String(t.code), eventTypeFields(t));
      return items;
  }
}

/** A value as compared: arrays and objects by their JSON, keys sorted. */
function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      return Object.fromEntries(Object.keys(v as Row).sort().map((k) => [k, norm((v as Row)[k])]));
    }
    return v === undefined ? null : v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * **What the KPM added, removed or changed**, item by item, against what it was given (ADR-0208 §4): `added` — it holds
 * an item the version did not give it; `removed` — it no longer holds one the version gave it (archived counts); and
 * `changed` — it holds the item with other values, naming the fields. Ids, versions, authors, timestamps and display
 * order are never compared: a reorder is presentation, and the push writes the template's order anyway.
 */
export function differencesOf(kind: OfficeTemplateKind, given: KindItems, live: KindItems): PushDifference[] {
  const found: PushDifference[] = [];
  for (const level of KIND_LEVELS[kind]) {
    const before = given[level] ?? new Map();
    const now = live[level] ?? new Map();
    for (const [code, fields] of now) {
      const was = before.get(code);
      if (!was) {
        found.push({ level, code, change: 'added' });
        continue;
      }
      const differ = [...new Set([...Object.keys(fields), ...Object.keys(was)])]
        .filter((field) => !same(fields[field], was[field]))
        .sort();
      if (differ.length) found.push({ level, code, change: 'changed', fields: differ });
    }
    for (const code of before.keys()) {
      if (!now.has(code)) found.push({ level, code, change: 'removed' });
    }
  }
  return found;
}

/**
 * **The training section's own material**, counted (ADR-0208 §4): any module with `officeContent` makes the section
 * changed, and each is listed as a `changed` module with `material` — *"31 modul memakai materi sendiri"*.
 */
export function ownMaterialDifferences(modules: Row[]): PushDifference[] {
  return modules
    .filter((m) => (m.status ?? 'active') === 'active' && m.officeContent)
    .map((m) => ({ level: 'modules', code: String(m.code), change: 'changed' as const, fields: ['material'] }));
}

/** Two lists of differences, one item each: a module both retitled and given its own material says both fields. */
export function mergeDifferences(a: PushDifference[], b: PushDifference[]): PushDifference[] {
  const out = a.map((d) => ({ ...d, ...(d.fields ? { fields: [...d.fields] } : {}) }));
  for (const d of b) {
    const hit = out.find((x) => x.level === d.level && x.code === d.code);
    if (!hit) out.push({ ...d });
    else if (hit.change === 'changed' && d.fields) hit.fields = [...new Set([...(hit.fields ?? []), ...d.fields])].sort();
  }
  return out;
}

/**
 * **Where a KPM stands on one kind** (ADR-0208 §4): `current` — it was last given the newest version, so a push skips it;
 * otherwise `changed` when it differs from the version it was last given, else `unchanged` — however old that version.
 */
export type PushState = 'unchanged' | 'changed' | 'current';

export function pushStateOf(
  givenVersion: number | null | undefined, newestVersion: number, differences: readonly PushDifference[],
): PushState {
  if (givenVersion !== null && givenVersion !== undefined && givenVersion >= newestVersion) return 'current';
  return differences.length > 0 ? 'changed' : 'unchanged';
}

/**
 * The kinds a request names, in *Terbitkan semua*'s order, each once; and every name that is no kind a push writes.
 *
 * **The recruitment playbook is one of those** (ADR-0210 §4): a template section, but read live by every KPM made from
 * the template, so publishing it reaches them all and there is nothing to push — named among the unknown, as
 * `campaign_kinds` is.
 */
export function kindsInOrder(
  names: readonly string[], order: readonly string[],
): { kinds: OfficeTemplateKind[]; unknown: string[] } {
  const known = new Set<string>(OFFICE_TEMPLATE_KINDS);
  const unknown = [...new Set(names.filter((n) => !known.has(n)))];
  const wanted = new Set(names);
  return { kinds: order.filter((kind): kind is OfficeTemplateKind => wanted.has(kind) && known.has(kind)), unknown };
}
