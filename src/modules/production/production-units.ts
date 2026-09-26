/**
 * The one place the carrier's unit meets the product's.
 *
 * The file is denominated in **millions of rupiah** — *"APE (Rp M)"* (`KPM_Owner.html:4681`) — for
 * the person filling it in; the product stores **integer minor units** (invariant §9). The two meet
 * here and nowhere else, so no reader can hold a second opinion about which unit a number is in.
 *
 * `metrics-and-definitions.md`: *"parse the upload column as millions and multiply."* The multiply is
 * a million rupiah times a hundred sen, and the round is because `1.5` in a spreadsheet is a decimal
 * somebody typed, not an exact binary fraction.
 */
export const MINOR_UNITS_PER_RP_MILLION = 1_000_000 * 100;

/** `1.5` in the file → `150_000_000_00` sen. */
export const rpMillionsToMinor = (millions: number): number =>
  Math.round(millions * MINOR_UNITS_PER_RP_MILLION);

/** The reverse, for a template that echoes what is stored. Not for display — `formatRupiah` is. */
export const minorToRpMillions = (minor: number): number => minor / MINOR_UNITS_PER_RP_MILLION;

/** `YYYY-MM`, and a real month. */
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
