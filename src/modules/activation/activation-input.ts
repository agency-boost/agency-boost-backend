import {
  CODE_MESSAGE, CODE_PATTERN, Fields, refuseWith, type Bounds,
} from '@/common/validation/fields';
import {
  ACTIVATION_FEATURE_LINKS, ACTIVATION_TRAINING_LINK_PREFIX, activationLinkKind, isActivationDataLink,
} from '@/domain/constants';

/**
 * What a write to an office's activation checklist may contain (P5-T3, ADR-0030).
 *
 * One checker, run by the service before it saves a draft, by publishing before it mints a version,
 * and by the Company template's publish over its payload — so a template cannot publish a checklist
 * an office could not have saved.
 *
 * **The whole document, every time.** A checklist is one document with an ordered shape; a patch
 * would need the server to merge two versions of an ordered list, and "merge" there has no answer
 * anybody would predict. Display order is taken from array position, which is what makes a reorder
 * an ordinary save.
 */
export const ACTIVATION_BOUNDS = {
  aspectLabel: { min: 1, max: 80 } as Bounds,
  itemLabel: { min: 1, max: 200 } as Bounds,
  /** A checklist with no aspects gives a hire a screen with nothing on it. */
  aspects: { min: 1, max: 20 } as Bounds,
  /** Per aspect. The prototype's largest holds four. */
  items: { min: 1, max: 50 } as Bounds,
} as const;

export interface CheckedActivationItem {
  code: string;
  label: string;
  displayOrder: number;
  autoLink: string | null;
}

export interface CheckedActivationAspect {
  code: string;
  label: string;
  displayOrder: number;
  items: CheckedActivationItem[];
}

export interface CheckedActivationChecklist {
  aspects: CheckedActivationAspect[];
}

/** `training:PROSPECT_LIST` → `PROSPECT_LIST`, for the caller that resolves it against the office. */
export function trainingLinkModuleCode(link: string | null): string | null {
  return link?.startsWith(ACTIVATION_TRAINING_LINK_PREFIX)
    ? link.slice(ACTIVATION_TRAINING_LINK_PREFIX.length)
    : null;
}

function checkLink(raw: unknown, where: string, violations: string[]): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    violations.push(`${where}: autoLink must be text, or null for a manual item.`);
    return null;
  }

  const link = raw.trim();
  const moduleCode = trainingLinkModuleCode(link);
  if (moduleCode !== null) {
    // Structural only. Whether the office has that module, published and active, is the
    // service's — it needs the database, and a template has no office to ask.
    if (!CODE_PATTERN.test(moduleCode)) {
      violations.push(`${where}: a training link names a module code. ${CODE_MESSAGE}`);
      return null;
    }
    return `${ACTIVATION_TRAINING_LINK_PREFIX}${moduleCode.toUpperCase()}`;
  }

  // P18.96-T4: a data kind is bound by an item's code (`ACTIVATION_CODE_BOUND_LINKS`), never stored on one.
  if (isActivationDataLink(link)) {
    violations.push(
      `${where}: ${link} is not chosen for an item. It belongs to the item whose code it is bound to, `
        + 'which reads it on its own.',
    );
    return null;
  }

  if (activationLinkKind(link) === undefined) {
    violations.push(
      `${where}: ${link} is not a link this product has. Use one of `
        + `${ACTIVATION_FEATURE_LINKS.join(', ')}, ${ACTIVATION_TRAINING_LINK_PREFIX}<module code>, `
        + 'or nothing at all for a manual item.',
    );
    return null;
  }
  return link;
}

/**
 * The checklist as it will be stored, or the refusal naming every problem at once.
 *
 * Codes are upper-cased and labels trimmed, exactly as the row-shaped settings do it, and
 * `displayOrder` is the position in the list the caller sent.
 */
export function checkActivationChecklist(body: unknown): CheckedActivationChecklist {
  const violations: string[] = [];
  const source = (body ?? {}) as Record<string, unknown>;

  const outer = new Fields(source, ['aspects']);
  violations.push(...outer.violations);

  const rawAspects = source.aspects;
  if (!Array.isArray(rawAspects)) {
    refuseWith([...violations, 'aspects must be a list.']);
  }
  if (rawAspects.length < ACTIVATION_BOUNDS.aspects.min
    || rawAspects.length > ACTIVATION_BOUNDS.aspects.max) {
    violations.push(
      `A checklist has ${ACTIVATION_BOUNDS.aspects.min}–${ACTIVATION_BOUNDS.aspects.max} aspects; `
        + `this one has ${rawAspects.length}.`,
    );
  }

  const aspectCodes = new Set<string>();
  const itemCodes = new Set<string>();
  const aspects: CheckedActivationAspect[] = [];

  rawAspects.forEach((raw, index) => {
    const where = `Aspect ${index + 1}`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      violations.push(`${where} must be an object of fields.`);
      return;
    }

    const row = raw as Record<string, unknown>;
    const f = new Fields(row, ['code', 'label', 'items']);
    const code = f.code('code', true);
    const label = f.text('label', ACTIVATION_BOUNDS.aspectLabel, true);
    violations.push(...f.violations.map((v) => `${where}: ${v}`));

    if (code !== undefined) {
      if (aspectCodes.has(code)) violations.push(`The aspect code ${code} is used twice.`);
      aspectCodes.add(code);
    }

    const rawItems = row.items;
    if (!Array.isArray(rawItems)) {
      violations.push(`${where}: items must be a list.`);
      return;
    }
    if (rawItems.length < ACTIVATION_BOUNDS.items.min
      || rawItems.length > ACTIVATION_BOUNDS.items.max) {
      violations.push(
        `${where} has ${rawItems.length} items; an aspect holds `
          + `${ACTIVATION_BOUNDS.items.min}–${ACTIVATION_BOUNDS.items.max}.`,
      );
    }

    const items: CheckedActivationItem[] = [];
    rawItems.forEach((rawItem, at) => {
      const itemWhere = `${where}, item ${at + 1}`;
      if (rawItem === null || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        violations.push(`${itemWhere} must be an object of fields.`);
        return;
      }

      const item = rawItem as Record<string, unknown>;
      const g = new Fields(item, ['code', 'label', 'autoLink']);
      const itemCode = g.code('code', true);
      const itemLabel = g.text('label', ACTIVATION_BOUNDS.itemLabel, true);
      violations.push(...g.violations.map((v) => `${itemWhere}: ${v}`));

      const autoLink = checkLink(item.autoLink, itemWhere, violations);

      if (itemCode !== undefined) {
        if (itemCodes.has(itemCode)) violations.push(`The item code ${itemCode} is used twice.`);
        itemCodes.add(itemCode);
      }
      if (itemCode === undefined || itemLabel === undefined) return;

      items.push({ code: itemCode, label: itemLabel, displayOrder: at + 1, autoLink });
    });

    if (code === undefined || label === undefined) return;
    aspects.push({ code, label, displayOrder: index + 1, items });
  });

  if (violations.length > 0) refuseWith(violations);
  return { aspects };
}
