import { SEED_RATIO_DEFINITIONS } from './activity-taxonomy';

/**
 * How a ratio's benchmark is written for a reader (P4-T25).
 *
 * **The stored number and the written number are different, and neither can be derived
 * from the other.** A success rate is stored as the proportion `0.15` and written `15.0%`;
 * leads per activity is stored `0.30` and written `0.30`. The domain is right to store the
 * proportion — `activity-taxonomy.spec.ts` pins that — but until this existed the settings
 * screens printed the stored value, so an Owner read `0.15` where the prototype and the
 * metric registry both say `15.0%`. Nothing in the value says which of the two a ratio is.
 *
 * - `percent` — the proportion × 100, to one decimal: `15.0%`.
 * - `decimal` — the number itself, to two decimals: `0.30`, `1.50`.
 * - `points` — percentage points either side of an even split: `±30 points`.
 *
 * The decimal places belong to the one formatter that writes them
 * (`frontend/src/lib/ratio-format.ts`); the backend never formats a benchmark, so it holds
 * the unit and not a second copy of the precision.
 */
export const RATIO_DISPLAY_UNITS = ['percent', 'decimal', 'points'] as const;
export type RatioDisplayUnit = (typeof RATIO_DISPLAY_UNITS)[number];

export type DisplayUnitResolution =
  | { unit: RatioDisplayUnit; refusal?: undefined }
  | { unit?: undefined; refusal: string };

/**
 * The unit a ratio ends up with, or why it cannot have the one asked for.
 *
 * **The unit follows the rule.** A `band` ratio — the balance — is judged in percentage
 * points either side of an even split, so it is `points` and nothing else; a `gte` ratio is
 * a percentage or a number, and never points. Stating it as one pure function is what lets
 * the service, the staged batch, template publishing, provisioning and the backfill all
 * give one answer, rather than five that agree until somebody edits one.
 *
 * `current` is what the row already holds, so that changing only the rule keeps a unit that
 * still fits: a `gte` ratio shown as a percentage stays a percentage. Moving off `band`
 * drops `points`, which no longer means anything, and falls back to `decimal` — the unit
 * that writes the stored value unchanged, so nothing is multiplied without being asked.
 *
 * Returns a refusal rather than throwing, because the callers refuse in different
 * vocabularies — a domain exception, a batch failure naming its op, a publish error.
 */
export function resolveDisplayUnit(
  comparison: 'gte' | 'band',
  requested?: string | null,
  current?: RatioDisplayUnit | null,
): DisplayUnitResolution {
  if (requested != null && !(RATIO_DISPLAY_UNITS as readonly string[]).includes(requested)) {
    return { refusal: `${requested} is not a way to show a benchmark. Use percent, decimal or points.` };
  }

  if (comparison === 'band') {
    if (requested != null && requested !== 'points') {
      return {
        refusal: 'A balance ratio is judged in percentage points either side of an even split, '
          + 'so its benchmark is shown in points.',
      };
    }
    return { unit: 'points' };
  }

  if (requested === 'points') {
    return {
      refusal: 'Points are for the balance rule, which is judged either side of an even split. '
        + 'A ratio judged at or above its benchmark is shown as a percentage or as a number.',
    };
  }
  return {
    unit: (requested as RatioDisplayUnit | undefined)
      ?? (current && current !== 'points' ? current : 'decimal'),
  };
}

/**
 * The unit for a row that was written before it had one.
 *
 * The platform's own unit when the code is one of the five **and** that unit still fits the
 * row's rule — an Owner may have turned `LEADS_PER_ACTIVITY` into a band since provisioning,
 * and a row's rule outranks its seed. Anything else takes the rule's default.
 *
 * Used by the backfill, by provisioning from a template published before units existed, and
 * by the read path for a row nothing has migrated yet. Never by a write: a write says what
 * it wants and goes through {@link resolveDisplayUnit}.
 */
export function defaultDisplayUnitFor(code: string, comparison: 'gte' | 'band'): RatioDisplayUnit {
  const seeded = SEED_RATIO_DEFINITIONS.find((r) => r.code === code)?.displayUnit;
  return resolveDisplayUnit(comparison, seeded).unit ?? resolveDisplayUnit(comparison).unit!;
}
