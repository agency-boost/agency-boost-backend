import { DateTime } from 'luxon';
import { DEFAULT_LANGUAGE, type Language, MINOR_UNITS_PER_MAJOR } from '@/domain/constants';

/**
 * **How the API writes a date, a sum or a percentage in a sentence** (ADR-0167 §1, OD-196): *26 Okt 2026*,
 * *Rp 500 Jt*, *96%*. **Percentages and money since ADR-0174** (OD-226, OD-227; P18.9-T3): a percentage whole,
 * rounded half up, with no *,0*, and a threshold with the places it was set with; a sum compact in *miliar*, *juta*
 * and *ribu*.
 *
 * **In the reader's language since P18.10-T3** (ADR-0174 §6, ADR-0179 §6; the approved glossary's §E): every function
 * takes the `language` as its **last parameter**, and a caller that passes none gets **Indonesian**
 * (`DEFAULT_LANGUAGE`), the forms every sentence had before — so nothing changes until a caller passes the request's
 * language (P18.10-T5). English: *26 Oct 2026*, *Monday, 26 Oct 2026*, *13:05*, *1,250*, *17.6*, *IDR 5.8B*,
 * *IDR 150M*, *IDR 750K*, *IDR 45,000,000*. **One rounding** (ADR-0174 §1): the figure is computed once, in digits,
 * and the language changes only its characters — the marks, a month's or a weekday's name, the currency's and a
 * unit's — never the figure. The words around a figure are the sentence's, and follow the language with it (T5).
 *
 * **It shares `frontend/src/lib/format.ts`'s forms — not every rule.** A refusal the server composes and a label the
 * screen composes sit side by side, so where both write a date, a whole percentage, a compact or a full sum, or a
 * `lossless` threshold, they write the same characters in the same language; each function here has its namesake
 * there, and the spec beside each pins the same cases. What is the screen's alone stays there: a ratio's tenth beside
 * its benchmark (`decimals`, `maxDecimals`), and `lossless`' cap of `PERCENT_LOSSLESS_MAX_DECIMALS` places — here
 * `lossless` keeps exactly the places the value has (`metrics-and-definitions.md` §B.25).
 *
 * **Built from static tables, never `toLocale*`.** ICU's `id-ID` data differs between runtimes (*Agu* or *Agt*, a
 * narrow no-break space or none), and a refusal pinned by a test must read the same on the CI runner, the server and
 * a reader's browser. `Intl` is not used here at all; luxon only places an instant on the office's wall clock.
 *
 * **Dates.** An office calendar day `YYYY-MM-DD` is built from its three numbers, never parsed as an instant — that
 * is the one-day slip invariant §9 exists to prevent. An instant is placed in the **tenant's** timezone, which every
 * function taking one requires as an argument: the server's zone is never read (v1 is `Asia/Jakarta`, ADR-0016).
 * Input that is not a day or a month is returned as given — a sentence that echoes it is still true, and none of
 * these throws on a refusal's path.
 *
 * **Money** is integer minor units (IDR sen, invariant §9): whole rupiah is `|minor| / 100` rounded half up, the
 * sign kept apart and written before the currency — `-Rp 500.000`, `-IDR 500,000`. **Compact** in sentences,
 * tooltips, notifications and summaries; **full** where the sentence states an input's bound (the reader types full
 * digits into that field) and in any file, export or template; **compact, lossless** for a threshold stated as a rule,
 * where rounding would misstate it. Every step is integer arithmetic: `1.150` is *Rp 1,2 rb*, which a float's `1.15`
 * would round down.
 */

/** The months, abbreviated, January first: Indonesian's, and English's (§E). */
const MONTHS = {
  id: ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
} as const satisfies Record<Language, readonly string[]>;

/** The weekdays in full, Sunday first — the order `getUTCDay` counts in. */
const WEEKDAYS = {
  id: ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
} as const satisfies Record<Language, readonly string[]>;

/**
 * Each language's marks (§E): the thousands mark, the decimal mark, the one between an hour and its minutes (24-hour
 * in both), and the currency's before a sum.
 */
const MARKS = {
  id: { group: '.', decimal: ',', clock: '.', currency: 'Rp' },
  en: { group: ',', decimal: '.', clock: ':', currency: 'IDR' },
} as const satisfies Record<Language, { group: string; decimal: string; clock: string; currency: string }>;

/** An en dash with a space either side: what every range is joined with. */
const RANGE = ' – ';

/**
 * The compact units, largest first: *miliar*, *juta*, *ribu*, and each one's mark in each language. `M` is
 * **miliar** (10⁹) in Indonesian — the prototype's `M` for a million is `jt` here — and English's *B*; English's *M*
 * is a *juta*.
 */
const COMPACT_UNITS = [
  { value: 1_000_000_000, suffix: { id: 'M', en: 'B' } },
  { value: 1_000_000, suffix: { id: 'Jt', en: 'M' } },
  { value: 1_000, suffix: { id: 'rb', en: 'K' } },
] as const satisfies readonly { value: number; suffix: Record<Language, string> }[];

/** Between a compact figure and its unit: a space in Indonesian, *Rp 5,8 M*; none in English, *IDR 5.8B* (§E). */
const UNIT_GAP = { id: ' ', en: '' } as const satisfies Record<Language, string>;

/** The tenths a compact figure carries at most: one decimal. */
const COMPACT_TENTHS = 10;

/** A compact figure that rounds to a thousand of its unit is written in the next one: *Rp 1 Jt*, not *Rp 1.000 rb*. */
const COMPACT_CARRY = 1_000 * COMPACT_TENTHS;

// ── calendar days and months ────────────────────────────────────────────────────────────────────

interface Day { y: number; m: number; d: number; year: string }

/** `YYYY-MM-DD` as its numbers, when it is a real day; `null` otherwise. Never read as an instant. */
function dayOf(day: string): Day | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Calendar arithmetic, not a conversion: `setUTCFullYear` because `Date.UTC` reads years 0–99 as 1900–1999.
  const at = new Date(0);
  at.setUTCFullYear(y, m - 1, d);
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  return { y, m, d, year: match[1] };
}

/** `YYYY-MM` as its numbers, when it is a real month; `null` otherwise. */
function monthOf(month: string): { m: number; year: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const m = Number(match[2]);
  return m >= 1 && m <= 12 ? { m, year: match[1] } : null;
}

/** An office calendar day: `2026-10-26` is *26 Okt 2026*, the day unpadded — *26 Oct 2026* in English. */
export function formatDate(day: string, language: Language = DEFAULT_LANGUAGE): string {
  const at = dayOf(day);
  return at ? `${at.d} ${MONTHS[language][at.m - 1]} ${at.year}` : day;
}

/** An office calendar day with its weekday: *Senin, 26 Okt 2026* — *Monday, 26 Oct 2026*. */
export function formatDateWithWeekday(day: string, language: Language = DEFAULT_LANGUAGE): string {
  const at = dayOf(day);
  if (!at) return day;
  const weekday = new Date(0);
  weekday.setUTCFullYear(at.y, at.m - 1, at.d);
  return `${WEEKDAYS[language][weekday.getUTCDay()]}, ${formatDate(day, language)}`;
}

/** A day and its month, no year — the first half of a range in one year: *26 Okt*. */
export function formatDayMonth(day: string, language: Language = DEFAULT_LANGUAGE): string {
  const at = dayOf(day);
  return at ? `${at.d} ${MONTHS[language][at.m - 1]}` : day;
}

/** An office calendar month: `2026-10` is *Okt 2026* — *Oct 2026*. */
export function formatMonth(month: string, language: Language = DEFAULT_LANGUAGE): string {
  const at = monthOf(month);
  return at ? `${MONTHS[language][at.m - 1]} ${at.year}` : month;
}

/** A month's name alone: `2026-10` is *Okt* — *Oct*. */
export function formatMonthName(month: string, language: Language = DEFAULT_LANGUAGE): string {
  const at = monthOf(month);
  return at ? MONTHS[language][at.m - 1] : month;
}

/**
 * Two office days and the days between: *28 Sep – 4 Okt 2026* in one year, *28 Des 2026 – 3 Jan 2027* across two,
 * and one day as that day, *4 Okt 2026*. *28 Sep – 4 Oct 2026* in English.
 */
export function formatDateRange(from: string, to: string, language: Language = DEFAULT_LANGUAGE): string {
  if (from === to) return formatDate(from, language);
  const [a, b] = [dayOf(from), dayOf(to)];
  if (a && b && a.year === b.year) return `${formatDayMonth(from, language)}${RANGE}${formatDate(to, language)}`;
  return `${formatDate(from, language)}${RANGE}${formatDate(to, language)}`;
}

/** Two office months and the months between: *Jul – Sep 2026*, *Nov 2026 – Jan 2027*, and one as *Sep 2026*. */
export function formatMonthRange(from: string, to: string, language: Language = DEFAULT_LANGUAGE): string {
  if (from === to) return formatMonth(from, language);
  const [a, b] = [monthOf(from), monthOf(to)];
  if (a && b && a.year === b.year) return `${formatMonthName(from, language)}${RANGE}${formatMonth(to, language)}`;
  return `${formatMonth(from, language)}${RANGE}${formatMonth(to, language)}`;
}

// ── instants, on the office's wall clock ────────────────────────────────────────────────────────

/** An instant's wall clock in `timezone`, or `null` for an instant that is not one, or a zone that is not one. */
function wallClock(instant: Date | string, timezone: string): DateTime | null {
  const at = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(at.getTime())) return null;
  const local = DateTime.fromJSDate(at, { zone: 'utc' }).setZone(timezone);
  return local.isValid ? local : null;
}

const two = (n: number) => String(n).padStart(2, '0');

/** The office's calendar day an instant fell on, in **its** timezone: 18:05 UTC on 30 Sep is *1 Okt 2026* in Jakarta. */
export function formatInstantDate(instant: Date | string, timezone: string, language: Language = DEFAULT_LANGUAGE): string {
  const at = wallClock(instant, timezone);
  return at ? formatDate(`${String(at.year).padStart(4, '0')}-${two(at.month)}-${two(at.day)}`, language) : '';
}

/**
 * An instant's time on the office's clock: *13.05* — 24-hour, both parts two digits, a dot between; *13:05* in
 * English.
 */
export function formatTime(instant: Date | string, timezone: string, language: Language = DEFAULT_LANGUAGE): string {
  const at = wallClock(instant, timezone);
  return at ? `${two(at.hour)}${MARKS[language].clock}${two(at.minute)}` : '';
}

/** An instant's day and time on the office's clock: *26 Okt 2026, 13.05* — *26 Oct 2026, 13:05*. */
export function formatDateTime(instant: Date | string, timezone: string, language: Language = DEFAULT_LANGUAGE): string {
  const at = wallClock(instant, timezone);
  return at ? `${formatInstantDate(instant, timezone, language)}, ${formatTime(instant, timezone, language)}` : '';
}

// ── numbers ──────────────────────────────────────────────────────────────────────────────────────

/**
 * `1250000` as *1.250.000*, or *1,250,000* in English: the language's mark every three digits. Takes the digits as a
 * string, so no size loses precision.
 */
function grouped(digits: string, language: Language): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, MARKS[language].group);
}

/** A non-negative finite number's decimal digits, as written — `1e-7` too — split at the point. */
function digitsOf(abs: number): [string, string] {
  const written = String(abs);
  const exponent = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(written);
  if (!exponent) {
    const [whole, fraction = ''] = written.split('.');
    return [whole, fraction];
  }
  const digits = exponent[1] + (exponent[2] ?? '');
  const point = exponent[1].length + Number(exponent[3]);
  if (point <= 0) return ['0', '0'.repeat(-point) + digits];
  // JavaScript writes an exponent only below 1e-6 or from 1e21, so a positive one always puts the point past the digits.
  return [digits.padEnd(point, '0'), ''];
}

/**
 * `abs` to `decimals` places, **half up on the digit as written** — `1.005` to two places is `1.01`, which binary
 * arithmetic (`1.005 * 100 = 100.4999…`) would round down. In decimal digits throughout, so nothing drifts.
 */
function roundedDigits(abs: number, decimals: number): [string, string] {
  const [whole, fraction] = digitsOf(abs);
  if (fraction.length <= decimals) return [whole, fraction.padEnd(decimals, '0')];
  const kept = BigInt(whole + fraction.slice(0, decimals));
  const rounded = (fraction.charCodeAt(decimals) >= '5'.charCodeAt(0) ? kept + 1n : kept).toString()
    .padStart(decimals + 1, '0');
  return [rounded.slice(0, rounded.length - decimals), rounded.slice(rounded.length - decimals)];
}

/**
 * A number the `id-ID` way: thousands with a dot, decimals after a comma — *1.250*, *2,13*; the English way, *1,250*,
 * *2.13*: the same digits, rounded once, in the language's marks. With `decimals`, rounded half up (away from zero)
 * to exactly that many places, *1,0*; without, every digit the number has. A negative is `-1.250`, and one that
 * rounds to zero is `0`. Not for a year: *2026* is a name, and grouping it would read *2.026*.
 */
export function formatNumber(n: number, decimals?: number, language: Language = DEFAULT_LANGUAGE): string {
  if (!Number.isFinite(n)) return '';
  const [whole, fraction] = decimals === undefined ? digitsOf(Math.abs(n)) : roundedDigits(Math.abs(n), decimals);
  const zero = /^0*$/.test(whole + fraction);
  return `${n < 0 && !zero ? '-' : ''}${grouped(whole, language)}${fraction ? `${MARKS[language].decimal}${fraction}` : ''}`;
}

/**
 * A percentage, from its percent value (`15` for 15%): **whole, rounded half up, with no *,0*** (ADR-0174 §1) —
 * *15%*, *96%* for 96,4, *13%* for 12,5, *-3%* for -3,45 (half up away from zero). The server rounds a share once,
 * in integers (`rateOver`), and this writes what it is given: no percentage is rounded twice — and the same figure in
 * either language (*1.250%*, *1,250%*).
 *
 * **`lossless`**, as `formatRupiahCompact`'s: a figure stated as a rule keeps every decimal it has and none it has
 * not (ADR-0174 §3) — *75,55%*, *75,5%*, *75%* (*75.55%* in English) — for a threshold, which a rounded figure would
 * misstate.
 */
export function formatPercent(
  pct: number,
  { lossless = false }: { lossless?: boolean } = {},
  language: Language = DEFAULT_LANGUAGE,
): string {
  if (!Number.isFinite(pct)) return '';
  return `${formatNumber(pct, lossless ? digitsOf(Math.abs(pct))[1].length : 0, language)}%`;
}

// ── money ────────────────────────────────────────────────────────────────────────────────────────

/** Whole rupiah from minor units, half up, in integers: `|minor| % 100` decides, so no float rounds it. */
function wholeRupiah(minor: number): number {
  const sen = Math.round(Math.abs(minor));
  const rest = sen % MINOR_UNITS_PER_MAJOR;
  return (sen - rest) / MINOR_UNITS_PER_MAJOR + (2 * rest >= MINOR_UNITS_PER_MAJOR ? 1 : 0);
}

/** `-` before the currency for a sum below zero that is still a rupiah or more once rounded; *Rp 0* carries no sign. */
const signOf = (minor: number, rupiah: number) => (minor < 0 && rupiah > 0 ? '-' : '');

/** Rupiah in full, from minor units: *Rp 500.000.000*, *-Rp 500.000*, *Rp 0* — *IDR 500,000,000* in English. */
export function formatRupiah(minor: number, language: Language = DEFAULT_LANGUAGE): string {
  if (!Number.isFinite(minor)) return '';
  const rupiah = wholeRupiah(minor);
  return `${signOf(minor, rupiah)}${MARKS[language].currency} ${grouped(String(rupiah), language)}`;
}

/**
 * Rupiah compact, from minor units: *Rp 750 rb*, *Rp 357,5 Jt*, *Rp 1,2 M*, and below a thousand in full, *Rp 999*
 * (ADR-0174 §4: compact wherever a sum is written but a price and an input's bound; `metrics-and-definitions.md`
 * §B.25). In English, at the same thresholds and to the same figure: *IDR 750K*, *IDR 357.5M*, *IDR 1.2B*, *IDR 999*.
 *
 * The largest unit the sum reaches, to one decimal at most, half up on that decimal, a trailing *,0* dropped. A
 * figure that rounds to a thousand of its unit moves up one: 999.950 is *Rp 1 Jt*. Above a thousand *miliar* it stays
 * in *M* — there is no *triliun* — *Rp 1.500 M* (*IDR 1,500B*).
 *
 * **`lossless`**: where the compact form would round — *Rp 1,2 rb* for 1.150 — the full one instead, *Rp 1.150*. For
 * a threshold stated as a rule (a campaign's requirement, an MOC criterion), where a rounded figure misstates it.
 */
export function formatRupiahCompact(
  minor: number,
  { lossless = false }: { lossless?: boolean } = {},
  language: Language = DEFAULT_LANGUAGE,
): string {
  if (!Number.isFinite(minor)) return '';
  const rupiah = wholeRupiah(minor);
  let unit = COMPACT_UNITS.findIndex((u) => rupiah >= u.value);
  if (unit === -1) return formatRupiah(minor, language);

  let step = 0;
  let tenths = 0;
  for (;;) {
    step = COMPACT_UNITS[unit].value / COMPACT_TENTHS;
    const rest = rupiah % step;
    tenths = (rupiah - rest) / step + (2 * rest >= step ? 1 : 0);
    if (tenths < COMPACT_CARRY || unit === 0) break;
    unit -= 1;
  }
  if (lossless && tenths * step !== rupiah) return formatRupiah(minor, language);

  const tenth = tenths % COMPACT_TENTHS;
  const whole = (tenths - tenth) / COMPACT_TENTHS;
  const marks = MARKS[language];
  const figure = `${grouped(String(whole), language)}${tenth ? `${marks.decimal}${tenth}` : ''}`;
  return `${signOf(minor, rupiah)}${marks.currency} ${figure}${UNIT_GAP[language]}${COMPACT_UNITS[unit].suffix[language]}`;
}
