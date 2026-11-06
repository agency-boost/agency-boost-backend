import { createHash } from 'node:crypto';
import { namedAs } from '@/modules/training/training-payload';

/**
 * ***Sinkron dari template*, the pure half** (P19.6-T4, ADR-0220 §4; OD-270, UI-161): what a KPM's names and
 * descriptions would take from its template, **by code** — categories, skills and modules against the template's newest
 * published `training_taxonomy`, and capability items against its newest published `capability_ladder` — and the
 * revision an apply is pinned to.
 *
 * **Names and descriptions only, on items found in both.** An item only the template has is a push's to add (ADR-0208);
 * an item only the KPM has is left alone; an archived row of the KPM's is not compared, since the screen does not show
 * it and the sync changes no archived state. Capability items have no description (ADR-0220 §1).
 */

export const TEMPLATE_SYNC_LEVELS = ['category', 'skill', 'module', 'capability_item'] as const;
export type TemplateSyncLevel = (typeof TEMPLATE_SYNC_LEVELS)[number];

/** One name or description that would change, old beside new — what the dialog lists (ADR-0220 §4, *The preview*). */
export interface TemplateSyncDifference {
  level: TemplateSyncLevel;
  /** The item's code; a capability item's is `<GRID>:<ITEM>`, its grid's code and its own. */
  code: string;
  field: 'name' | 'description';
  from: string | null;
  to: string | null;
}

type Row = Record<string, unknown>;

/** The KPM's rows, as its repositories hold them. Archived rows may be among them; they are skipped. */
export interface SyncOfficeRows {
  categories: Row[];
  skills: Row[];
  modules: Row[];
  /** The capability catalogue's grids, each with its items, or none. */
  grids: (Row & { items?: Row[] })[];
}

/** The template's two payloads, each `null` where the template has published none of it. */
export interface SyncTemplatePayloads {
  training: Row | null;
  capability: Row | null;
}

/** A stored text as compared: trimmed, and nothing (absent, blank) as `null`. */
const text = (value: unknown): string | null => {
  const s = typeof value === 'string' ? value.trim() : '';
  return s === '' ? null : s;
};
const code = (value: unknown) => String(value ?? '').trim().toUpperCase();
const live = (row: Row) => (row.status ?? 'active') === 'active';
const list = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

/**
 * One level's names (and descriptions) by code: the template's whole list, or the KPM's active rows. A skill or a module
 * written before P19.6-T4 (no `description`) reads split, as the migration splits it (`namedAs`); a category never does.
 */
function byCode(
  rows: Row[], nameField: string, read: 'category' | 'split',
): Map<string, { name: string | null; description: string | null }> {
  return new Map(rows.map((r) => {
    if (read === 'category') return [code(r.code), { name: text(r[nameField]), description: text(r.description) }];
    const named = namedAs(r[nameField], r.description);
    return [code(r.code), { name: text(named.name), description: named.description }];
  }));
}

/**
 * **The differences, in the dialog's order**: categories, skills, modules, then capability items — each level in the
 * KPM's own order, a name before its description.
 */
export function templateSyncDifferences(template: SyncTemplatePayloads, office: SyncOfficeRows): TemplateSyncDifference[] {
  const out: TemplateSyncDifference[] = [];
  const compare = (
    level: TemplateSyncLevel,
    theirs: Map<string, { name: string | null; description: string | null }>,
    ours: Map<string, { name: string | null; description: string | null }>,
    withDescription: boolean,
  ) => {
    for (const [key, mine] of ours) {
      const given = theirs.get(key);
      if (!given) continue;
      if (given.name !== null && given.name !== mine.name) {
        out.push({ level, code: key, field: 'name', from: mine.name, to: given.name });
      }
      if (withDescription && given.description !== mine.description) {
        out.push({ level, code: key, field: 'description', from: mine.description, to: given.description });
      }
    }
  };

  if (template.training) {
    const t = template.training;
    compare('category', byCode(list(t.categories), 'label', 'category'), byCode(office.categories.filter(live), 'label', 'category'), true);
    compare('skill', byCode(list(t.skills), 'label', 'split'), byCode(office.skills.filter(live), 'label', 'split'), true);
    compare('module', byCode(list(t.modules), 'title', 'split'), byCode(office.modules.filter(live), 'title', 'split'), true);
  }
  if (template.capability) {
    const theirs = new Map<string, { name: string | null; description: null }>();
    for (const grid of list(template.capability.grids)) {
      for (const item of list(grid.items)) theirs.set(`${code(grid.code)}:${code(item.code)}`, { name: text(item.label), description: null });
    }
    const ours = new Map<string, { name: string | null; description: null }>();
    for (const grid of office.grids.filter(live)) {
      for (const item of list(grid.items).filter(live)) ours.set(`${code(grid.code)}:${code(item.code)}`, { name: text(item.label), description: null });
    }
    compare('capability_item', theirs, ours, false);
  }
  return out;
}

/**
 * **The KPM's revision** (ADR-0220 §4): a short digest over every training row — archived ones too — by id, version and
 * status, and the capability catalogue's id and version. Any write to either moves it, so an apply pinned to the
 * revision its preview read is refused `409 VERSION_CONFLICT` if anything changed in between. Order-free: a reorder
 * moves no version and is not a change.
 */
export function trainingRevision(office: {
  categories: Row[]; skills: Row[]; modules: Row[]; catalog: Row | null;
}): string {
  const keys = [
    ...office.categories.map((r) => `c:${String(r._id ?? r.id)}:${String(r.version)}:${String(r.status)}`),
    ...office.skills.map((r) => `s:${String(r._id ?? r.id)}:${String(r.version)}:${String(r.status)}`),
    ...office.modules.map((r) => `m:${String(r._id ?? r.id)}:${String(r.version)}:${String(r.status)}`),
    ...(office.catalog ? [`cap:${String(office.catalog._id ?? office.catalog.id)}:${String(office.catalog.version)}`] : []),
  ].sort();
  return createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 16);
}
