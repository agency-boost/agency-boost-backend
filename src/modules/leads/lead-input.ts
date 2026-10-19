import { Fields, refuseWith } from '@/common/validation/fields';
import { LEAD_TYPES, type LeadType } from './lead.schema';

/** What a lead's own fields may be. Bounds in one place, so a screen and a service agree. */
export const LEAD_BOUNDS = {
  name: { min: 2, max: 120 },
  remarks: { max: 2000 },
  nextActionNote: { max: 500 },
  source: { max: 80 },
  phone: { max: 32 },
  email: { max: 254 },
} as const;

export interface CheckedLead {
  name?: string;
  type?: LeadType | null;
  contact?: { phone: string | null; email: string | null };
  remarks?: string | null;
  nextActionDate?: string | null;
  nextActionNote?: string | null;
  source?: string | null;
  thisMonth?: boolean;
  /**
   * The version the writer read, pinned so a stale write is refused rather than applied (P7-T7).
   *
   * Not a field of the lead — it is a claim *about* the lead the patch was written against, which
   * is why it is read here and never reaches `writable`.
   */
  version?: number;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One lead, read field by field (P7-T1).
 *
 * Ordinary shape-checking, and nothing more since 2026-10-07. It was here for P7-T1's AC-3 — no
 * contact details without a recorded lawful basis (UU 27/2022) — and the product owner set that aside
 * with the field that asked for it (ADR-0108 §1). **`lawfulBasis` is now a field nobody defined**, so a
 * body that still carries it is refused by name, as any other unknown field is, rather than silently
 * dropped: a client that thinks it is recording a ground should be told it is not.
 *
 * Pure, and separate from the service, so it can be exercised without a database — the same shape
 * `campaign-input.ts` and `activation-input.ts` take, and the reason ADR-0030 gives for it.
 */
export function checkLead(body: unknown, opts: { partial?: boolean } = {}): CheckedLead {
  const required = !opts.partial;
  const f = new Fields(body, [
    'name', 'type', 'contact', 'remarks',
    'nextActionDate', 'nextActionNote', 'source', 'thisMonth', 'version',
  ]);

  const out: CheckedLead = {};

  const name = f.text('name', LEAD_BOUNDS.name, required);
  if (name !== undefined) out.name = name;

  /*
   * **`null` is a value here, not an absence**: a lead may be saved before the agent picks a ladder.
   * `oneOf` reads null as *not one of these* and records a violation, so the null is taken first and
   * the enum never sees it.
   */
  readNullable(f, body, 'type', LEAD_TYPES, (v) => { out.type = v; });

  const remarks = f.note('remarks', LEAD_BOUNDS.remarks);
  if (remarks !== undefined) out.remarks = remarks;

  const note = f.note('nextActionNote', LEAD_BOUNDS.nextActionNote);
  if (note !== undefined) out.nextActionNote = note;

  const source = f.note('source', LEAD_BOUNDS.source);
  if (source !== undefined) out.source = source;

  const day = raw(body, 'nextActionDate');
  if (day === null) out.nextActionDate = null;
  else if (day !== undefined) {
    if (typeof day !== 'string' || !ISO_DAY.test(day)) {
      f.violations.push('nextActionDate must be a day, written YYYY-MM-DD.');
    } else out.nextActionDate = day;
  }

  const committed = raw(body, 'thisMonth');
  if (committed !== undefined) {
    if (typeof committed !== 'boolean') f.violations.push('thisMonth must be true or false.');
    else out.thisMonth = committed;
  }

  const pinned = raw(body, 'version');
  if (pinned !== undefined) {
    if (typeof pinned !== 'number' || !Number.isInteger(pinned) || pinned < 1) {
      f.violations.push('version must be the whole number the record was read at.');
    } else out.version = pinned;
  }

  const contact = raw(body, 'contact');
  if (contact !== undefined) out.contact = readContact(contact, f);

  if (f.violations.length) refuseWith(f.violations);
  return out;
}

/** Both optional, both clearable, and shape only. No ground is asked for either (ADR-0108 §1). */
function readContact(value: unknown, f: Fields): { phone: string | null; email: string | null } {
  if (value === null) return { phone: null, email: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    f.violations.push('contact must be an object of phone and email.');
    return { phone: null, email: null };
  }
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!['phone', 'email'].includes(key)) f.violations.push(`property contact.${key} should not exist`);
  }

  const read = (key: 'phone' | 'email'): string | null => {
    const held = source[key];
    if (held === undefined || held === null) return null;
    if (typeof held !== 'string') {
      f.violations.push(`contact.${key} must be text.`);
      return null;
    }
    const trimmed = key === 'email' ? held.trim().toLowerCase() : held.trim();
    if (!trimmed) return null;
    if (trimmed.length > LEAD_BOUNDS[key].max) {
      f.violations.push(`contact.${key} must be at most ${LEAD_BOUNDS[key].max} characters.`);
    }
    if (key === 'email' && !trimmed.includes('@')) {
      f.violations.push('contact.email must be an email address.');
    }
    return trimmed;
  };

  return { phone: read('phone'), email: read('email') };
}

/** An enum that may also be explicitly cleared. */
function readNullable<T extends string>(
  f: Fields,
  body: unknown,
  field: string,
  values: readonly T[],
  set: (value: T | null) => void,
): void {
  const held = raw(body, field);
  if (held === undefined) return;
  if (held === null) { set(null); return; }
  const value = f.oneOf(field, values, false);
  if (value !== undefined) set(value);
}

/** `Fields` collects its own; this reaches the raw value for the cases it does not cover. */
function raw(body: unknown, key: string): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[key];
}
