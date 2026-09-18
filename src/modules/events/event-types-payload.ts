import { SEED_EVENT_TYPES } from '@/domain/constants';

/** An `event_types` payload: the list an office's Event types screen starts as. */
export interface EventTypesPayload {
  types: {
    code: string; label: string; description?: string | null;
    emoji?: string | null; color?: string | null;
  }[];
}

/** The platform defaults as a payload — a template's starting point, and an office's seed. */
export function defaultEventTypes(): EventTypesPayload {
  return {
    types: SEED_EVENT_TYPES.map((t) => ({
      code: t.code, label: t.label, description: null, emoji: t.emoji, color: t.color,
    })),
  };
}

/**
 * What would make an `event_types` payload produce a broken office — one sentence each, empty
 * when there is nothing (P5-T9 AC-4).
 *
 * **An office with no event type cannot file an event at all**, so an empty list is refused here
 * rather than discovered by the first Owner who opens the screen. The rest is the invariant every
 * catalog carries: a stable code per row, and no two rows sharing one — an event stores the code
 * it was filed under, so two rows with one code is one type wearing two labels.
 */
export function eventTypesProblems(payload: unknown): string[] {
  const problems: string[] = [];
  const source = (payload ?? {}) as Record<string, unknown>;

  if (!Array.isArray(source.types)) {
    problems.push('types must be a list.');
    return problems;
  }
  const types = source.types as Record<string, unknown>[];
  if (types.length === 0) {
    problems.push(
      'An event type list with no types gives every new office nothing to file an event under.',
    );
  }

  const seen = new Set<string>();
  types.forEach((type, i) => {
    const where = `Event type ${i + 1}`;
    const code = String(type.code ?? '').trim().toUpperCase();
    if (!code) {
      problems.push(`${where} has no code. An event stores the code, so a rename never orphans one.`);
    } else if (seen.has(code)) {
      problems.push(`The code ${code} is used twice, so one type would wear two labels.`);
    } else if (!/^[A-Z][A-Z0-9_]*$/.test(code)) {
      problems.push(
        `${where}: ${code} is not a usable code. Letters, digits and underscores, starting with a letter.`,
      );
    }
    seen.add(code);

    if (!String(type.label ?? '').trim()) {
      problems.push(`${where} has no label, so it would render as a blank row on the Events screen.`);
    }
    const color = String(type.color ?? '').trim();
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
      // A colour the screen cannot parse renders as nothing, and a type with no visual mark is
      // one an Owner has to read every time to tell apart.
      problems.push(`${where}: ${color} is not a colour. Use a six-digit hex value such as #2D9CDB.`);
    }
  });

  return problems;
}

/** The rows an office starts with, from a payload `eventTypesProblems` passed. */
export function eventTypeSeedDocuments(kpmId: string, payload: EventTypesPayload) {
  return payload.types.map((type, index) => ({
    kpmId,
    code: type.code.trim().toUpperCase(),
    label: type.label.trim(),
    description: type.description?.trim() || null,
    emoji: type.emoji?.trim() || null,
    color: type.color?.trim() || null,
    displayOrder: index + 1,
    version: 1,
    status: 'active' as const,
    archivedAt: null,
    deletedAt: null,
    createdBy: null,
    updatedBy: null,
  }));
}
