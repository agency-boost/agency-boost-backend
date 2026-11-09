/**
 * **A criterion against a threshold, in three values** — the one rule MOC and a campaign's requirements are both
 * decided by (P18.2-T8 AC-4, invariant §8). Extracted from `moc-status.ts`, which re-exports it unchanged, so
 * `moc-status.spec.ts` still pins it there.
 *
 * `null` is *not known yet* — the file does not hold a month the figure is read over — and never ✕ on a guess.
 * Logic is Kleene's: in an `all`, one ✕ fails it whatever else is unknown; in an `any`, one ✓ is enough.
 */

/** A figure against a threshold, by one of the five comparators (`REQUIREMENT_COMPARATORS`). */
export function compare(value: number, comparator: string, threshold: number): boolean {
  switch (comparator) {
    case 'gte': return value >= threshold;
    case 'gt': return value > threshold;
    case 'lte': return value <= threshold;
    case 'lt': return value < threshold;
    default: return value === threshold;
  }
}

/** One criterion: decided over its input, or `null` while the input is not uploaded — never ✕ on a guess. */
export function criterionMet(
  input: { current: number | null } | undefined, comparator: string, threshold: number,
): boolean | null {
  if (input === undefined || input.current === null) return null;
  return compare(input.current, comparator, threshold);
}

/** Three-valued AND (`all`) or OR (`any`) — Kleene's. */
export function combine(values: readonly (boolean | null)[], mode: string): boolean | null {
  if (mode === 'any') {
    if (values.includes(true)) return true;
    return values.includes(null) ? null : false;
  }
  if (values.includes(false)) return false;
  return values.includes(null) ? null : true;
}
