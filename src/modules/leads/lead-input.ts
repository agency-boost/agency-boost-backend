import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { Fields, refuseWith } from '@/common/validation/fields';
import { LEAD_AGE, LEAD_GENDERS, normalisePhone, type LeadGender } from '@/domain/constants';
import { isLeadAge } from './lead-age';
import { LEAD_TYPES, type LeadType } from './lead.schema';
import { LEAD_REFUSALS } from './leads.messages';

/** A lead's own field sentences, in both languages (P18.10-T5 AC-3). */
const SAY = LEAD_REFUSALS.VALIDATION_FAILED;

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
   * **The client's age at the next birthday** (P19.7-T1 AC-1; ADR-0224 §3): a whole number from `LEAD_AGE.MIN` to
   * `LEAD_AGE.MAX`, or `null` to clear it and its day. Never `ageRecordedOn`, which only the server writes.
   */
  age?: number | null;
  /** `male`, `female`, or `null` to clear it (ADR-0224 §1). */
  gender?: LeadGender | null;
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
    // P19.7-T1 (ADR-0224): the client's age and gender. **No `birthDate`**, and no `ageRecordedOn`: either in a body
    // is an unknown field, `400` (minimisation, §6; the day is the server's, §1).
    'age', 'gender',
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
      f.violations.push(SAY.nextActionDateShape);
    } else out.nextActionDate = day;
  }

  const committed = raw(body, 'thisMonth');
  if (committed !== undefined) {
    if (typeof committed !== 'boolean') f.violations.push(SAY.thisMonthShape);
    else out.thisMonth = committed;
  }

  const pinned = raw(body, 'version');
  if (pinned !== undefined) {
    if (typeof pinned !== 'number' || !Number.isInteger(pinned) || pinned < 1) {
      f.violations.push(SAY.versionShape);
    } else out.version = pinned;
  }

  const contact = raw(body, 'contact');
  if (contact !== undefined) out.contact = readContact(contact, f);

  const age = raw(body, 'age');
  if (age === null) out.age = null;
  else if (age !== undefined) {
    if (typeof age !== 'number' || !Number.isInteger(age)) f.violations.push(SAY.ageShape);
    else out.age = age;
  }

  const gender = raw(body, 'gender');
  if (gender === null) out.gender = null;
  else if (gender !== undefined) {
    if (!(LEAD_GENDERS as readonly unknown[]).includes(gender)) f.violations.push(SAY.genderShape);
    else out.gender = gender as LeadGender;
  }

  if (f.violations.length) refuseWith(f.violations);
  /*
   * **The bounds, after the shape** (ADR-0224 §3): a whole number outside 1 to 100 is `422 LEAD_AGE_OUT_OF_RANGE`,
   * `details: { min, max }` — the screen's *"Umur harus 1–100."* — and nothing is written. A body that is also wrong
   * elsewhere hears about that first, as `400`.
   */
  if (typeof out.age === 'number' && !isLeadAge(out.age)) {
    throw new DomainException(
      ErrorCode.LEAD_AGE_OUT_OF_RANGE,
      LEAD_REFUSALS.LEAD_AGE_OUT_OF_RANGE.between({ min: LEAD_AGE.MIN, max: LEAD_AGE.MAX }),
      HttpStatus.UNPROCESSABLE_ENTITY,
      { min: LEAD_AGE.MIN, max: LEAD_AGE.MAX },
    );
  }
  return out;
}

/**
 * Both optional, both clearable, and no ground is asked for either (ADR-0108 §1).
 *
 * **The phone is normalised where it reads as an Indonesian number** (P19.11-T3 AC-6; UX-10; `normalisePhone`, the same
 * reading as *Isi nomor WhatsApp*'s): `0812-1100-2200`, `62812…` and `+62 812…` all come back `+6281211002200`. One that
 * does not read as one comes back trimmed, as typed — whether it may be stored depends on what the lead holds, which this
 * pure reader cannot see: `checkContactPhone` decides, with the stored row beside it.
 */
function readContact(value: unknown, f: Fields): { phone: string | null; email: string | null } {
  if (value === null) return { phone: null, email: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    f.violations.push(SAY.contactShape);
    return { phone: null, email: null };
  }
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!['phone', 'email'].includes(key)) f.violations.push(SAY.contactUnknownField({ key }));
  }

  const read = (key: 'phone' | 'email'): string | null => {
    const held = source[key];
    if (held === undefined || held === null) return null;
    if (typeof held !== 'string') {
      f.violations.push(SAY.contactNotText({ key }));
      return null;
    }
    const trimmed = key === 'email' ? held.trim().toLowerCase() : held.trim();
    if (!trimmed) return null;
    if (trimmed.length > LEAD_BOUNDS[key].max) {
      f.violations.push(SAY.contactTooLong({ key, max: LEAD_BOUNDS[key].max }));
    }
    if (key === 'email' && !trimmed.includes('@')) {
      f.violations.push(SAY.contactEmail);
    }
    return key === 'phone' ? normalisePhone(trimmed) ?? trimmed : trimmed;
  };

  return { phone: read('phone'), email: read('email') };
}

/**
 * **A lead's phone, refused only when it changes to something that is not an Indonesian number** (P19.11-T3 AC-6; UX-10):
 * `400 VALIDATION_FAILED` with `contact.phone`'s sentence — the field's own words for the rule `PATCH /auth/me` and
 * `PUT /members/:membershipId/phone` already hold a person's number to.
 *
 * `next` is what `checkLead` read (normalised where it could be); `stored` the lead's number now, `null` for a new lead.
 * A number stored before the rule — *"0812"* typed in 2026 — **passes untouched while it is sent back unchanged**, as
 * the sheet does when only the email moves (the pair travels together): saving a lead never fails over a field the
 * reader did not touch. Clearing it (`null`) is always allowed.
 */
export function checkContactPhone(next: string | null, stored: string | null): void {
  if (next === null || normalisePhone(next) === next || next === stored) return;
  refuseWith([SAY.contactPhone]);
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
