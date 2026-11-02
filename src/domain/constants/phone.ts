/**
 * **A person's WhatsApp number** (UI V1, 2026-10-30; UI-081, the owner's D-22): what *Isi nomor WhatsApp* saves on a
 * person — their own, from *Profil saya*, or an agent's, from their leader's screen.
 *
 * Documented once in `docs/00-product/metrics-and-definitions.md` and pinned by `phone.spec.ts`. The frontend mirrors
 * the two bounds for its inline error, beside a comment naming this file, as `LEAD_NAME_MIN` mirrors the leads'; the
 * server's answer is the one that counts.
 *
 * Indonesia only (`+62`): every office is Indonesian (ADR-0016), and the sheet's `+62` is fixed, not a choice.
 */
export const PHONE_NATIONAL_DIGITS = {
  /** The shortest national number kept, after `+62`: `812 345 678`. */
  min: 9,
  /** The longest, after `+62`: thirteen digits. */
  max: 13,
} as const;

/** What `+62` is written as once a number is stored. */
export const PHONE_COUNTRY_PREFIX = '+62';

/**
 * **A number as typed → `+62` and its national digits, or `null` when it is not one** (UI-081): spaces, dashes, dots
 * and brackets go; then a leading `+62`, `0062`, `62` or trunk `0` goes; what is left must be 9 to 13 digits and
 * nothing else. `0812-1100-2200`, `+62 812 1100 2200` and `812 1100 2200` are all `+6281211002200`.
 *
 * `62` is read as the country code only at the very start, and only once — a national number never begins with it
 * (an Indonesian mobile begins with `8`), so `62812…` is `+62812…`, not `+62 62812…`.
 */
export function normalisePhone(typed: string | null | undefined): string | null {
  if (typeof typed !== 'string') return null;
  const compact = typed.replace(/[\s\-.()]/g, '');
  const national = compact
    .replace(/^\+62/, '')
    .replace(/^0062/, '')
    .replace(/^62/, '')
    .replace(/^0/, '');
  if (!/^\d+$/.test(national)) return null;
  if (national.length < PHONE_NATIONAL_DIGITS.min || national.length > PHONE_NATIONAL_DIGITS.max) return null;
  return `${PHONE_COUNTRY_PREFIX}${national}`;
}
