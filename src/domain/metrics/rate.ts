/**
 * **A share of a group, as every Owner's figure draws it** (Phase 18): *"{count} / {of} · {pct}%"*
 * (`KPM_Owner.html:973-985`, `:1013-1021`, `:3341`).
 *
 * A whole percent, rounded half up as the prototype rounds (`Math.round`), and **`null` over nobody** — never
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
  return { count, of, pct: of === 0 ? null : Math.round((count / of) * 100) };
}
