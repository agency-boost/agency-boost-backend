import { RequestContext } from '@/common/context/request-context';
import { maaCountInUnit } from '@/domain/metrics/maa-count-in-unit';
import { monthlyActiveAgent } from '@/domain/metrics/monthly-active-agent';
import type { MonthCells, ProductionReadings } from './production-readings';

/** One person behind *Active Agent* for a month: who, and the month's two figures that made them active. */
export interface ActiveAgentRow {
  membershipId: string;
  /** The month's APE as the office holds it (imported or corrected), integer minor units; `null` with none held. */
  apeMinor: number | null;
  /** The month's policy count as held; `null` with none. */
  policies: number | null;
}

/** *Active Agent* over a set of people for one month, and the people behind it. */
export interface ActiveAgentsReading {
  /** `YYYY-MM`. */
  month: string;
  /** The office holds a file for the month (`OfficeMonth.held`). Without one the count is `null`: *Belum diunggah*. */
  held: boolean;
  /** `MAA_COUNT_IN_UNIT` over the people asked about: `null` when the month is not held, never 0. */
  count: number | null;
  /** Each person who is a `MONTHLY_ACTIVE_AGENT` that month, APE first then policies, both descending. Empty when not held. */
  people: ActiveAgentRow[];
}

/**
 * **Active Agent, and who is behind the number** (P19.17-T1 AC-2; ADR-0267 §2; `revisions/2026-11-19/DATA-DEFINITIONS.md`,
 * *Production*): of the people given, those whose month in the office's uploaded production shows **APE > 0 or a policy**
 * — `MONTHLY_ACTIVE_AGENT` (ADR-0054), counted by `MAA_COUNT_IN_UNIT` — each with the month's APE and policies, for the
 * sheet a tile opens. **No definition of its own** (invariant §8): the rule is `monthlyActiveAgent`, the figures are the
 * month table's (`ProductionReadings.monthCellsFor`, `readCell`), and the month is held when the office holds a file for
 * it (`officeMonths`).
 *
 * - **The people are the caller's scope**: a unit, a group, the office — with test accounts already left out
 *   (`NOT_A_TEST_ACCOUNT`, ADR-0267 §1), as every list of members leaves them out.
 * - **Two reads**, whatever the number of people: their month's cells and the office's month.
 * - Plain, taking its reader, so a service that already holds `ProductionReadings` needs nothing new injected.
 */
export async function activeAgentsIn(
  production: Pick<ProductionReadings, 'monthCellsFor' | 'officeMonths'>,
  ctx: RequestContext,
  membershipIds: readonly string[],
  month: string,
): Promise<ActiveAgentsReading> {
  const ids = [...new Set(membershipIds)];
  const [cells, office] = await Promise.all([
    production.monthCellsFor(ctx, ids, { from: month, to: month }),
    production.officeMonths(ctx, { from: month, to: month }),
  ]);
  return activeAgentsOver(cells, ids, month, office.get(month)?.held ?? false);
}

/**
 * **The count itself, over cells already read** — what `activeAgentsIn` answers after its two reads, and what the forum's
 * scorecard reads for MAPA's *Active Agent* and *Polis per Active Agent* over the cells it holds (ADR-0267 §2; the
 * integration review of 20 November 2026, invariant §8): one function, so the two cannot count it two ways.
 */
export function activeAgentsOver(
  cells: ReadonlyMap<string, ReadonlyMap<string, Pick<MonthCells, 'apeMonthly' | 'policyCountMonthly'>>>,
  membershipIds: readonly string[],
  month: string,
  held: boolean,
): ActiveAgentsReading {
  const ids = [...new Set(membershipIds)];
  const people: ActiveAgentRow[] = [];
  const flags: (boolean | null)[] = [];
  for (const id of ids) {
    const cell = cells.get(id)?.get(month);
    const ape = cell?.apeMonthly ?? null;
    const policies = cell?.policyCountMonthly ?? null;
    const active = monthlyActiveAgent(ape, policies);
    flags.push(active);
    if (held && active === true) people.push({ membershipId: id, apeMinor: ape, policies });
  }
  people.sort((a, b) => (b.apeMinor ?? 0) - (a.apeMinor ?? 0) || (b.policies ?? 0) - (a.policies ?? 0));
  return { month, held, count: maaCountInUnit(flags, held), people };
}
