/**
 * One ratio, computed (P10-T2). Pure: the office's definition and the member's summed counts in, a
 * value and a status out — so every rule the five cards follow is a unit test.
 *
 * **A zero denominator is `null`**, and `null` is *not enough data*: never `0`, never a division error,
 * never a failure (`metrics-and-definitions.md` §A.5, the phase's exit criterion).
 */

export type RatioStatus = 'success' | 'alert' | 'neutral';

export interface RatioFormula {
  comparison: 'gte' | 'band';
  benchmark: number;
  numerator: readonly string[];
  denominator: readonly string[];
}

export interface RatioOutcome {
  /**
   * `gte`: the proportion — `0.15`, written `15.0%` or `0.15` by the screen's formatter.
   * `band`: the lean in percentage points, **positive toward the numerator's side** — `+30` is thirty
   * points toward Selling on the seeded balance.
   */
  value: number | null;
  numeratorCount: number;
  denominatorCount: number;
  /** `band` only: the numerator side's share of both, in percent — where the marker sits on the track. */
  share: number | null;
  status: RatioStatus;
}

export function computeRatio(formula: RatioFormula, sums: ReadonlyMap<string, number>): RatioOutcome {
  const count = (codes: readonly string[]) => codes.reduce((t, code) => t + (sums.get(code) ?? 0), 0);
  const n = count(formula.numerator);
  const d = count(formula.denominator);
  const none = { value: null, share: null, numeratorCount: n, denominatorCount: d, status: 'neutral' as const };

  if (formula.comparison === 'band') {
    if (n + d === 0) return none;
    /*
     * `(share − 50) × 2`, written as `(n − d) / (n + d) × 100` and multiplied before it divides: the
     * same number, but an even thirteen-to-seven split is exactly 30 rather than 30.000000000000004,
     * and the band's edge is where a status turns.
     */
    const lean = ((n - d) * 100) / (n + d);
    return {
      value: lean,
      share: (n * 100) / (n + d),
      numeratorCount: n,
      denominatorCount: d,
      status: Math.abs(lean) <= formula.benchmark ? 'success' : 'alert',
    };
  }

  if (d === 0) return none;
  // Division is correctly rounded, so 3 ÷ 20 is exactly the benchmark 0.15 and reads as on track.
  const value = n / d;
  return {
    value, share: null, numeratorCount: n, denominatorCount: d,
    status: value >= formula.benchmark ? 'success' : 'alert',
  };
}

/** Whether a ratio is a question about this rung (ADR-0020). An empty list is every rung. */
export function appliesTo(appliesToOrgLevelCodes: readonly string[] | undefined, rung: string): boolean {
  const rungs = appliesToOrgLevelCodes ?? [];
  return rungs.length === 0 || rungs.includes(rung);
}
