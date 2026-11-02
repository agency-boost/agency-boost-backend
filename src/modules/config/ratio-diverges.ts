/**
 * **Whether a ratio's formula has moved from its standard** (ADR-0024), on its own so a reader can ask it without the
 * configuration service behind it: the activity module's ratio views, which the Unit Dashboard's *Activities* tab reads
 * (UI V1, Phase 18.99 T4) and which must reach nothing of training or events (P15-T1 AC-11). `ratio.service.ts`
 * re-exports it, unchanged.
 */

/** Two formula sides are the same set of codes. Order is display, never meaning. */
const sameCodes = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * The row's formula against the one its office was provisioned with (ADR-0024).
 *
 * `false` for a ratio the office created: there is no standard it could have moved away
 * from, which is not the same as agreeing with one.
 */
export function diverges(doc: {
  numerator: readonly string[];
  denominator: readonly string[];
  standardNumerator?: readonly string[] | null;
  standardDenominator?: readonly string[] | null;
}): boolean {
  if (!doc.standardNumerator || !doc.standardDenominator) return false;
  return !sameCodes(doc.numerator, doc.standardNumerator)
    || !sameCodes(doc.denominator, doc.standardDenominator);
}
