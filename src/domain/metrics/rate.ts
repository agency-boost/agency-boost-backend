/**
 * **A share of a group, as every Owner's figure draws it** (Phase 18): *"{count} / {of} · {pct}%"*
 * (`KPM_Owner.html:973-985`, `:1013-1021`, `:3341`).
 *
 * A whole percent, rounded half up as the prototype means to round (`Math.round`), and **`null` over nobody** — never
 * 0% and never a division by zero (roles §6.11), where the prototype divides unguarded. Not capped: a share
 * of a group cannot pass 100.
 */
export interface Rate {
  count: number;
  of: number;
  /** `count / of` as a whole percent; `null` when `of` is 0. */
  pct: number | null;
}

export function rateOver(count: number, of: number): Rate {
  return { count, of, pct: of === 0 ? null : wholePercent(count, of) };
}

/**
 * **`part / of` as a whole percent, rounded half up in integers** — the one rounding every whole percentage of whole
 * numbers takes (P18.2 exit review; parity F-253, P18.9-T3, the client's UI-018 *"correctly rounded"*): a share of
 * counts through `rateOver`, and an attainment of two sums — the APE achieved over its target in sen, the activities
 * logged over theirs — which may pass 100 and whose caller keeps its own cap and its own `null`. `of` is above 0.
 *
 * `Math.round(part / of * 100)` rounds the binary approximation of the quotient, and `23 / 40 * 100` is
 * `57.49999999999999` — so a share that is exactly 57.5% read 57. `floor((200·part + of) / (2·of))` is
 * `part·100/of + ½` floored, **exact for whole numbers** while the arithmetic stays inside 2⁵³: a correctly rounded
 * division of two integers below it cannot land on an integer it is not. A sum of sen past it — hundreds of *miliar*
 * — takes the same arithmetic in `BigInt`, floored, so no figure an office can hold is rounded on a float's guess.
 * Half up is toward +∞, as `Math.round` is: −57.5 is −57.
 */
export function wholePercent(part: number, of: number): number {
  const numerator = 200 * part + of;
  const denominator = 2 * of;
  if (Number.isSafeInteger(Math.abs(numerator) + denominator)) return Math.floor(numerator / denominator);
  const n = 200n * BigInt(Math.round(part)) + BigInt(Math.round(of));
  const d = 2n * BigInt(Math.round(of));
  // `BigInt` division truncates toward zero; a negative quotient with a remainder floors one lower.
  const q = n / d;
  return Number(n % d !== 0n && n < 0n ? q - 1n : q);
}
