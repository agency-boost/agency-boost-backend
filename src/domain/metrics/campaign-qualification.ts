import type { CampaignQualificationStatus, CampaignReading } from '@/domain/constants';
import type { MetricPeriod } from './registry';
import { combine, compare } from './criteria';

/**
 * `CAMPAIGN_QUALIFICATION_STATUS` — one member's standing against one campaign's requirements
 * (`metrics-and-definitions.md` §A.6; P18.5-T8 AC-3, AC-4, AC-6; OD-153, OD-154, OD-157). Pure: the requirements
 * and each one's reading in, a row per requirement and a status out.
 *
 * **A row per requirement, as the dialog prints it** (OD-157): *"{current} of {target}"* with ✓ when met; *Not
 * uploaded yet* where a month the window reads has ended and the file does not hold it, or nothing it reads is held
 * — **never ✕ on a month not held**; *Not measured yet* for a requirement naming a metric outside the evaluable set
 * (D-evaluable), stored before the set existed.
 *
 * **The status** (the registry's, as amended; ADR-0143): for a chaser, `qualified` — every requirement met;
 * `in_progress` — the window still open, or its last month not yet locked; `not_met` — final, and a requirement
 * missed; `unknown` — final with a requirement nothing could decide. **For a member who did not chase, `not_joined`**:
 * only a chaser qualifies (OD-153), chasing is enrolment, and the Phase 18.6 tree reads `not_joined` as *Not
 * achieved* — they did not take part. Their progress is still shown in the dialog all the same.
 *
 * The three-valued logic is `criteria.ts`'s, the one MOC is decided by (invariant §8).
 */

export interface CampaignRequirement {
  metricKey: string;
  comparator: string;
  value: number;
}

/**
 * What the owning module's function read for one member and one requirement over the window — `campaign-readings`
 * builds it through `ProductionReadings` and `ActivityReadings`, never a second copy of either.
 */
export interface RequirementReading {
  /** The figure over the window; `null` when nothing it reads is held (or a ratio with nothing to divide by). */
  current: number | null;
  /** A month the window reads has ended and the office does not hold it (ADR-0050: a file lands after its month). */
  missing: boolean;
  /** The window still runs, or reads a month not ended: the figure may move. */
  open: boolean;
  /**
   * Where the figure comes from. **`activity`'s `null` is nothing logged** — a ratio with nothing to divide — never a
   * month not held: it reads *Nothing logged yet* (`nothing_logged`), and once final is not met (the review, item 7).
   */
  source?: 'file' | 'activity';
  /** How it is read (`CampaignReading.aggregate`): a running `sum` only grows, a `latest` or a `ratio` can fall. */
  aggregate?: 'sum' | 'latest' | 'ratio';
}

export type RequirementState = 'met' | 'in_progress' | 'not_met' | 'not_uploaded' | 'nothing_logged' | 'not_measured';

export interface RequirementProgress {
  metricKey: string;
  comparator: string;
  current: number | null;
  target: number;
  /** For the status: `true` met, `false` missed for good, `null` not decided. */
  met: boolean | null;
  /**
   * **Met now, and could still fall before the window is final** (the review, item 21): a `latest` figure
   * (persistency, a unit's active agents), a ratio, or any figure compared `lte`, `lt` or `eq`. Only a running `sum`
   * compared `gte` or `gt` — APE booked, hires, touches — can only grow, so once met it stays met.
   */
  canFall: boolean;
  state: RequirementState;
}

export type QualificationStatus = CampaignQualificationStatus;

export interface Qualification {
  rows: RequirementProgress[];
  status: QualificationStatus;
  /** Every requirement met, whoever is asking — what a chaser's `qualified` rests on. */
  requirementsMet: boolean | null;
}

/** One requirement's row. `measured: false` is outside the evaluable set: nothing is read, and it decides nothing. */
export function requirementProgress(
  requirement: CampaignRequirement, reading: RequirementReading | undefined, measured: boolean,
): RequirementProgress {
  const base = { metricKey: requirement.metricKey, comparator: requirement.comparator, target: requirement.value, canFall: false };
  if (!measured || reading === undefined) return { ...base, current: null, met: null, state: 'not_measured' };
  if (reading.current === null) {
    if (reading.source === 'activity') return { ...base, current: null, met: reading.open ? null : false, state: 'nothing_logged' };
    return { ...base, current: null, met: null, state: 'not_uploaded' };
  }
  if (compare(reading.current, requirement.comparator, requirement.value)) {
    const grows = reading.aggregate === 'sum' && (requirement.comparator === 'gte' || requirement.comparator === 'gt');
    return { ...base, current: reading.current, met: true, canFall: reading.open && !grows, state: 'met' };
  }
  // A month not held is never ✕: the figure may still be short only because its file has not landed.
  if (reading.missing) return { ...base, current: reading.current, met: null, state: 'not_uploaded' };
  if (reading.open) return { ...base, current: reading.current, met: null, state: 'in_progress' };
  return { ...base, current: reading.current, met: false, state: 'not_met' };
}

/**
 * **The member's standing.** `final` is OD-154's: the last month the window reads has locked (or, for activity
 * alone, its last day's grace has passed) — decided by the caller, which reads the lock.
 */
export function qualify(
  rows: readonly RequirementProgress[], opts: { chasing: boolean; eligible: boolean; final: boolean },
): Qualification {
  // A campaign with no requirement asks nothing anybody can be measured against: nobody qualifies by it.
  const requirementsMet = rows.length === 0 ? null : combine(rows.map((r) => r.met), 'all');
  if (!opts.chasing) return { rows: [...rows], requirementsMet, status: 'not_joined' };
  // A chaser whose rung it no longer applies to — their rung changed after they chased — cannot qualify by it.
  if (!opts.eligible) return { rows: [...rows], requirementsMet, status: opts.final ? 'not_met' : 'in_progress' };
  // Every requirement met: qualified — unless the window is still open and one of them could still fall (item 21).
  if (requirementsMet === true && !(rows.some((r) => r.canFall) && !opts.final)) {
    return { rows: [...rows], requirementsMet, status: 'qualified' };
  }
  if (!opts.final) return { rows: [...rows], requirementsMet, status: 'in_progress' };
  return { rows: [...rows], requirementsMet, status: requirementsMet === false ? 'not_met' : 'unknown' };
}

/**
 * **The first reader of a metric's period** (D-period, P18.5-T8 AC-7): a campaign reading must agree with the period
 * the registry gives the metric — a sum over months or days for a monthly or yearly figure, the latest month held
 * for a rolling or point-in-time one (or a month's count, which summing would double), a ratio over a rolling
 * window. The evaluator refuses a reading that disagrees, so a metric cannot be added to the set read the wrong way.
 */
export function readingAgreesWithPeriod(reading: CampaignReading, period: MetricPeriod): boolean {
  if (reading.aggregate === 'sum') {
    return reading.source === 'file'
      ? period === 'CALENDAR_MONTH' || period === 'CALENDAR_YEAR'
      : period === 'CALENDAR_MONTH' || period === 'ROLLING_7D' || period === 'ROLLING_30D';
  }
  if (reading.aggregate === 'latest') {
    return reading.source === 'file'
      && (period === 'ROLLING_12M' || period === 'POINT_IN_TIME' || period === 'CALENDAR_MONTH');
  }
  return reading.source === 'activity' && (period === 'ROLLING_7D' || period === 'ROLLING_30D');
}
