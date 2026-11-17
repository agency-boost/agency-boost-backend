/**
 * **A number exactly as a file writes it** (P19.15-T3 AC-3; ADR-0259 §3, the hard rules for sensitive numbers).
 *
 * Premiums, rates, sums assured and limits are **never** taken from the model's arithmetic. The model hands back the text
 * it read (`asWritten`) and which reading of it it means (`value`, plain digits); this file works out **every exact
 * reading the text allows** — `1.320` is one thousand three hundred and twenty in Indonesian and one point three two in
 * English, `Rp100 jt` is one hundred million — and keeps the model's value **only when it is one of them**. A value that
 * is no reading of the text (rounded, recalculated, copied from another row, invented) is refused, and the card asks a
 * person to type it.
 *
 * Exact throughout: a reading is a pair of big integers, `units / 10^scale`; nothing passes through a float until the
 * caller asks for minor units or a rate.
 */

/** An exact decimal: `units / 10^scale`. */
export interface Exact { units: bigint; scale: number }

const UNIT_WORDS: readonly [RegExp, number][] = [
  [/^(triliun|t)$/i, 12],
  [/^(miliar|milyar|m|bn|billion)$/i, 9],
  [/^(juta|jt|million|mio)$/i, 6],
  [/^(ribu|rb|k|thousand)$/i, 3],
];

/** Text around a figure that says nothing about its size: a currency, *per*, a percent sign, a trailing full stop. */
const NOISE = /^(rp\.?|idr|usd|us\$|\$)\s*/i;

function exactOf(digits: string, decimals: string, power: number): Exact {
  const units = BigInt(`${digits}${decimals}` || '0');
  const scale = decimals.length - power;
  return scale >= 0 ? normalised({ units, scale }) : normalised({ units: units * 10n ** BigInt(-scale), scale: 0 });
}

/** The same value with no trailing zero after the point: `1500 / 10^3` is `15 / 10^1`. */
function normalised(e: Exact): Exact {
  let { units, scale } = e;
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  return { units, scale };
}

export const sameExact = (a: Exact, b: Exact): boolean => {
  const x = normalised(a);
  const y = normalised(b);
  return x.units === y.units && x.scale === y.scale;
};

/** `"1234.5"`, `"-12"`, `"0.123"`: the plain form the model is asked to give its `value` in. */
export function plainExact(text: string): Exact | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const e = exactOf(m[2], m[3] ?? '', 0);
  return m[1] === '-' ? { units: -e.units, scale: e.scale } : e;
}

/**
 * **Every exact reading of a figure as written** — `Rp 1.250.000`, `0,123`, `1,5 M`, `100 jt`, `12.5%` — or none for a
 * text that is not one figure. Grouping marks are read both ways where the text allows both; a unit word multiplies
 * exactly. A text with two figures, letters other than a unit word, or digits split by spaces is not a figure.
 */
export function readingsOf(asWritten: string): Exact[] {
  let text = asWritten.replace(/ /g, ' ').trim().replace(NOISE, '').replace(/%$/, '').trim();
  let negative = false;
  if (/^[-−]/.test(text)) {
    negative = true;
    text = text.slice(1).trim();
  }
  let power = 0;
  const word = /^([\d.,]+)\s*([a-z]+)\.?$/i.exec(text);
  if (word) {
    const unit = UNIT_WORDS.find(([pattern]) => pattern.test(word[2]));
    if (!unit) return [];
    power = unit[1];
    text = word[1];
  }
  if (!/^\d[\d.,]*$/.test(text) || /[.,]$/.test(text)) return [];

  const out: Exact[] = [];
  const push = (e: Exact | null) => {
    if (e && !out.some((o) => sameExact(o, e))) out.push(negative ? { units: -e.units, scale: e.scale } : e);
  };
  const dots = (text.match(/\./g) ?? []).length;
  const commas = (text.match(/,/g) ?? []).length;
  const grouped = (body: string, mark: string) => body.split(mark).every((part, i) => (i === 0 ? /^[1-9]\d{0,2}$/.test(part) : /^\d{3}$/.test(part)));

  if (dots === 0 && commas === 0) push(exactOf(text, '', power));
  for (const [decimal, group] of [[',', '.'], ['.', ',']] as const) {
    const decimalCount = decimal === ',' ? commas : dots;
    const groupCount = decimal === ',' ? dots : commas;
    if (decimalCount > 1) continue;
    const [whole, fraction = ''] = decimalCount === 1 ? text.split(decimal) : [text, ''];
    if (decimalCount === 1 && !/^\d+$/.test(fraction)) continue;
    if (groupCount > 0 && !grouped(whole, group)) continue;
    push(exactOf(whole.split(group).join(''), fraction, power));
  }
  return out;
}

/**
 * **The model's value, when it is a reading of the text** — else `null`, and the card asks a person (ADR-0259 §3).
 * `value` is the plain form (`1320`, `0.123`); `asWritten` what the file shows.
 */
export function exactAsWritten(asWritten: string, value: string | null | undefined): Exact | null {
  const claimed = value === null || value === undefined ? null : plainExact(value);
  const readings = readingsOf(asWritten);
  if (claimed) return readings.find((r) => sameExact(r, claimed)) ?? null;
  // No value given: the text alone decides only when it allows one reading.
  return readings.length === 1 ? readings[0] : null;
}

/** An amount in minor units (two decimals: sen, cents), or `null` where it is not a whole number of them. */
export function minorUnitsOf(e: Exact): number | null {
  if (e.scale > 2) return null;
  const minor = e.units * 10n ** BigInt(2 - e.scale);
  const n = Number(minor);
  return Number.isSafeInteger(n) ? n : null;
}

/** A whole number (an age, a year), or `null`. */
export function wholeOf(e: Exact): number | null {
  if (e.scale !== 0) return null;
  const n = Number(e.units);
  return Number.isSafeInteger(n) ? n : null;
}

/** A rate as the table writes it (per Rp1.000 UP), to be stored as a number: exact to its own digits. */
export function rateOf(e: Exact): number {
  return Number(e.units) / 10 ** e.scale;
}

/** The text of an exact value, plain: `1320`, `0.123`. */
export function plainText(e: Exact): string {
  const negative = e.units < 0n;
  const digits = (negative ? -e.units : e.units).toString().padStart(e.scale + 1, '0');
  const body = e.scale === 0 ? digits : `${digits.slice(0, digits.length - e.scale)}.${digits.slice(digits.length - e.scale)}`;
  return negative ? `-${body}` : body;
}

/** **A percentage change's factor** (*naik 5%* → 105/100; *turun 2,5%* → 97,5/100), exact, from the text as written. */
export function factorOf(percentAsWritten: string, direction: 'up' | 'down'): { numerator: bigint; denominator: bigint } | null {
  const readings = readingsOf(percentAsWritten);
  if (readings.length !== 1) return null;
  const p = readings[0];
  if (p.units <= 0n) return null;
  const denominator = 100n * 10n ** BigInt(p.scale);
  const delta = direction === 'up' ? p.units : -p.units;
  const numerator = denominator + delta;
  return numerator > 0n ? { numerator, denominator } : null;
}

/** The factor as the rule states it: `1,05`, `0,975`. */
export function factorText(f: { numerator: bigint; denominator: bigint }): string {
  // denominator is 100 × 10^k: the factor has at most 2 + k decimals.
  let scale = 0;
  let d = f.denominator;
  while (d % 10n === 0n) {
    d /= 10n;
    scale += 1;
  }
  return plainText(normalised({ units: f.numerator * (10n ** BigInt(scale)) / f.denominator, scale })).replace('.', ',');
}

/**
 * **A premium in minor units × the factor, rounded half up to a whole rupiah** (100 minor units) — the rule the approval
 * card states, worked by this code and only after the Super Admin approved it.
 */
export function scaledToRupiah(minor: number, f: { numerator: bigint; denominator: bigint }): number {
  const scaled = BigInt(minor) * f.numerator;
  const per = f.denominator * 100n;
  return Number(((scaled * 2n + per) / (per * 2n)) * 100n);
}

/** **A rate × the factor, rounded half up to the rate's own decimals** (`decimals` as the source table writes them). */
export function scaledRate(rate: Exact, f: { numerator: bigint; denominator: bigint }, decimals: number): Exact {
  // rate = u / 10^s; result = u·n / (10^s·d), kept to `decimals` places, half up.
  const target = 10n ** BigInt(decimals);
  const num = rate.units * f.numerator * target;
  const den = 10n ** BigInt(rate.scale) * f.denominator;
  const rounded = num >= 0n ? (num * 2n + den) / (den * 2n) : -((-num * 2n + den) / (den * 2n));
  return normalised({ units: rounded, scale: decimals });
}
