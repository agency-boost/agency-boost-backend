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
  return { count, of, pct: of === 0 ? null : halfUpPercent(count, of) };
}

/**
 * `count / of` as a whole percent, rounded half up **in integers** (P18.5 exit review): `Math.round(count / of * 100)`
 * rounds the binary approximation of the quotient, and `23 / 40 * 100` is `57.49999999999999` — so a share that is
 * exactly 57.5% read 57. `floor((200·count + of) / (2·of))` is `count·100/of + ½` floored, exact for the whole-number
 * counts every caller passes.
 */
function halfUpPercent(count: number, of: number): number {
  return Math.floor((200 * count + of) / (2 * of));
}
