import { PRODUCTION_METRICS } from '@/modules/production/monthly-agent-data.schema';
import { MINOR_UNITS_PER_RP_MILLION } from '@/modules/production/production-units';

/** A month row's field for a metric and a cadence: `apeMonthly`, `apeYtd`. */
export const monthField = (metric: string, cadence: 'monthly' | 'ytd') => `${metric}${cadence === 'monthly' ? 'Monthly' : 'Ytd'}`;

/**
 * **A member's month on the seeded files** (P9-T4; moved here from `demo.ts` in Phase 18 so the reporting fixture's
 * history months read the same function as this month's and last month's files): believable, different per person
 * and per month, and YTD never below the month.
 *
 * **One member in six had a quiet month**: no APE, no policy. That is the *not active* ✕ of the Monthly Active
 * Agent column (ADR-0054) — without it every row the seed imports is ✓ and the column's middle answer cannot be
 * seen. Their year to date still holds the months before.
 *
 * `i` is the member's place among the members the seed had before the coaching cast, by agent sequence.
 */
export function seedMonthFigures(
  i: number, month: string, scale = 1,
  /** A quiet month whatever `i` says (P18.96-T5): a new hire's first weeks, before a first sale. */
  options: { quiet?: boolean } = {},
): Record<string, number> {
  const m = Number(month.slice(5));
  const apeM = (8 + ((i * 13 + m * 5) % 55)) * scale;
  const usual: Record<string, number> = {
    ape: Math.round(apeM * MINOR_UNITS_PER_RP_MILLION),
    persistency: 80 + ((i * 7 + m) % 20),
    recruitment: (i + m) % 3,
    newActiveAgents: (i + m) % 2,
    fyp: Math.round(apeM * 0.6 * MINOR_UNITS_PER_RP_MILLION),
    policyCount: 1 + ((i * 3 + m) % 5),
  };
  const quiet = options.quiet === true || i % 6 === 3;
  const sold = ['ape', 'fyp', 'policyCount'];
  const monthly = quiet ? { ...usual, ape: 0, fyp: 0, policyCount: 0 } : usual;
  const ytd = (metric: string) => {
    if (metric === 'persistency') return monthly[metric] - 2;
    return quiet && sold.includes(metric) ? usual[metric] * (m - 1) : monthly[metric] * m;
  };
  return Object.fromEntries(PRODUCTION_METRICS.flatMap((metric) => [
    [monthField(metric, 'monthly'), monthly[metric]],
    [monthField(metric, 'ytd'), ytd(metric)],
  ]));
}
