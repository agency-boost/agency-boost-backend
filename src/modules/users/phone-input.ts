import { normalisePhone, PHONE_COUNTRY_PREFIX, PHONE_NATIONAL_DIGITS } from '@/domain/constants';

/**
 * **A WhatsApp number as a body carries it** (UI V1, 2026-10-30; UI-081, D-22) — `PATCH /auth/me`'s `phone` and
 * `PUT /members/:membershipId/phone`'s, read one way.
 *
 * The body's value is normalised before it is validated (`@Transform` runs first): a number that reads as one becomes
 * `+62…`, which `PHONE_FIELD_SHAPE` then passes; anything else is left as it was typed, so the shape refuses it with
 * the field's own sentence. Empty or blank is `null`, the cleared number, where a route allows clearing.
 */
export function phoneFromBody(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.trim() === '') return null;
  return normalisePhone(value) ?? value;
}

/** What a stored number looks like: `+62` and the national digits, the bounds from `PHONE_NATIONAL_DIGITS`. */
export const PHONE_FIELD_SHAPE = new RegExp(
  `^\\${PHONE_COUNTRY_PREFIX}\\d{${PHONE_NATIONAL_DIGITS.min},${PHONE_NATIONAL_DIGITS.max}}$`,
);
