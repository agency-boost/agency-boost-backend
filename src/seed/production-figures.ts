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
  /** A quiet month whatever `i` says (P18.8-T5): a new hire's first weeks, before a first sale. */
  options: {
    quiet?: boolean;
    /**
     * **A history month** (P19.5-T2; R4): the months before last month, which the reporting fixture files. A member's
     * quiet months are this month and last month's; the months before them sold — so the year to date, now the months'
     * sum, still holds them, as the file's own year to date always said.
     */
    history?: boolean;
  } = {},
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
  const quiet = options.quiet === true || (options.history !== true && i % 6 === 3);
  const sold = ['ape', 'fyp', 'policyCount'];
  /*
   * A quiet member's history months hold their APE without a policy count: their year to date — the months' sum since
   * P19.5-T2 — is what the file's YTD always said, and no first sale is read from a file month (ADR-0171 §1), so an
   * existing agent with none keeps none.
   */
  const monthly = quiet ? { ...usual, ape: 0, fyp: 0, policyCount: 0 }
    : options.history === true && i % 6 === 3 ? { ...usual, policyCount: 0 } : usual;
  const ytd = (metric: string) => {
    if (metric === 'persistency') return monthly[metric] - 2;
    return quiet && sold.includes(metric) ? usual[metric] * (m - 1) : monthly[metric] * m;
  };
  return Object.fromEntries(PRODUCTION_METRICS.flatMap((metric) => [
    [monthField(metric, 'monthly'), monthly[metric]],
    [monthField(metric, 'ytd'), ytd(metric)],
  ]));
}

/**
 * **A leader row's unit persistency on a seeded file** (P19.3-T1; ADR-0201 §2, the data sources' D6): the insurer's
 * persistency for an AB's or an AAB's unit, `UNIT_PERSISTENCY`, written as `unitPersistencyMonthly` beside their own
 * figures — so MOC's persistency criterion and the Unit comparison have a figure to read on a fresh seed. Believable,
 * different per leader and per month, with one decimal place, as an insurer writes it: 76.0 to 94.9. Never derived from
 * the leader's agents (the column is the insurer's figure, not ours).
 *
 * `i` is the leader's place on the office's roster, as `seedMonthFigures`' is.
 */
export function seedUnitPersistency(i: number, month: string): number {
  const m = Number(month.slice(5));
  return (760 + ((i * 37 + m * 11) % 190)) / 10;
}
