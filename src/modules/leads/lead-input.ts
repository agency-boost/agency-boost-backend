import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { Fields, refuseWith } from '@/common/validation/fields';
import { LAWFUL_BASES, LEAD_TYPES, type LawfulBasis, type LeadType } from './lead.schema';

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
  lawfulBasis?: LawfulBasis | null;
  remarks?: string | null;
  nextActionDate?: string | null;
  nextActionNote?: string | null;
  source?: string | null;
  thisMonth?: boolean;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One lead, read field by field (P7-T1).
 *
 * **The rule this exists for is AC-3**: contact details may not be stored without a recorded ground
 * for holding them (UU 27/2022). Everything else here is ordinary shape-checking.
 *
 * Pure, and separate from the service, so the rule can be exercised without a database — the same
 * shape `campaign-input.ts` and `activation-input.ts` take, and the reason ADR-0030 gives for it.
 */
export function checkLead(body: unknown, opts: { partial?: boolean } = {}): CheckedLead {
  const required = !opts.partial;
  const f = new Fields(body, [
    'name', 'type', 'contact', 'lawfulBasis', 'remarks',
    'nextActionDate', 'nextActionNote', 'source', 'thisMonth',
  ]);

  const out: CheckedLead = {};

  const name = f.text('name', LEAD_BOUNDS.name, required);
  if (name !== undefined) out.name = name;

  /*
   * **`null` is a value here, not an absence**, for both of these: a lead may be saved before the
   * agent picks a ladder, and a ground may be withdrawn. `oneOf` reads null as *not one of these*
   * and records a violation, so the null is taken first and the enum never sees it.
   */
  readNullable(f, body, 'type', LEAD_TYPES, (v) => { out.type = v; });
  readNullable(f, body, 'lawfulBasis', LAWFUL_BASES, (v) => { out.lawfulBasis = v; });

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

  const contact = raw(body, 'contact');
  if (contact !== undefined) out.contact = readContact(contact, f);

  if (f.violations.length) refuseWith(f.violations);
  return out;
}

/** Both optional, both clearable. Shape only — whether they may be *stored* is the next rule. */
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

/**
 * **A phone number or an email needs a recorded ground for holding it** (UU 27/2022; AC-3).
 *
 * Checked against the lead as it **will be**, not as it arrived: clearing the basis on a lead that
 * already has a phone number is the same act as adding the number without one, and a rule that
 * only read the incoming patch would let the second happen in two steps.
 *
 * Its own function rather than a branch inside `checkLead`, because it needs the stored row and
 * `checkLead` deliberately does not.
 */
export function requireLawfulBasis(next: {
  contact: { phone: string | null; email: string | null };
  lawfulBasis: string | null;
}): void {
  const holdsContact = Boolean(next.contact.phone) || Boolean(next.contact.email);
  if (!holdsContact || next.lawfulBasis) return;

  throw new DomainException(
    ErrorCode.LEAD_CONSENT_REQUIRED,
    'Record why this person’s details may be held before storing a phone number or an email.',
    HttpStatus.UNPROCESSABLE_ENTITY,
    { allowed: [...LAWFUL_BASES] },
  );
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
