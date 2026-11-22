/**
 * ***MAPA driver*'s comparisons** (P19.22-T3; ADR-0275 §3; `revisions/2026-11-19/DATA-DEFINITIONS.md`, *MAPA driver*;
 * `metrics-and-definitions.md` §A.21). Pure: the figures in, the table's numbers out. Pinned by `mapa.spec.ts`.
 *
 * - **The rows**, in the brief's order: **APE** alone, then **M** Manpower (*Manpower*, *Rekrut*), **A** Activation
 *   (*Active Agent*, *% agent baru aktif dalam 3 bulan*), **P** Productivity (*Polis terbit*, *Polis per Active Agent*),
 *   **A** Average case size (*Nilai rata-rata polis*).
 * - **YTD**: APE's is the year's **total** so far; every other row's is **the average per month** — a count's is the mean
 *   of its months (`monthlyMean`), a ratio's or a percentage's is the metric's own figure over the year's months, which
 *   its definition already takes per month (`CASES_PER_PRODUCING_AGENT`, `AVERAGE_CASE_SIZE_REALISED`,
 *   `NEW_AGENT_ACTIVATION_3M_PCT`, `MAA_MONTHLY_AVG`).
 * - **The change** between two figures is **in %** of the earlier one (`changePct`), and **in points** for a row that is
 *   itself a percentage (`changePoints`).
 */

/** The rows' keys, in the table's order. */
export const MAPA_ROW_KEYS = [
  'ape', 'manpower', 'rekrut', 'active_agent', 'new_agent_3m', 'policies', 'policies_per_active_agent', 'average_case_size',
] as const;
export type MapaRowKey = (typeof MAPA_ROW_KEYS)[number];

/** The MAPA letters the rows are grouped under: APE alone, then M · A · P · A. */
export type MapaGroup = 'ape' | 'manpower' | 'activation' | 'productivity' | 'case_size';

/** A row's unit: money in minor units, a count (whole, or a mean to a tenth), a percentage, a ratio to a tenth. */
export type MapaUnit = 'idr_minor' | 'count' | 'percentage' | 'ratio';

/** How a row's YTD is taken: APE's total; a count's mean of its months; a ratio's own figure over the year's months. */
export type MapaYtd = 'total' | 'mean' | 'metric';

export const MAPA_ROWS: Readonly<Record<MapaRowKey, { group: MapaGroup; unit: MapaUnit; ytd: MapaYtd }>> = {
  ape: { group: 'ape', unit: 'idr_minor', ytd: 'total' },
  manpower: { group: 'manpower', unit: 'count', ytd: 'mean' },
  rekrut: { group: 'manpower', unit: 'count', ytd: 'mean' },
  active_agent: { group: 'activation', unit: 'count', ytd: 'metric' },
  new_agent_3m: { group: 'activation', unit: 'percentage', ytd: 'metric' },
  policies: { group: 'productivity', unit: 'count', ytd: 'mean' },
  policies_per_active_agent: { group: 'productivity', unit: 'ratio', ytd: 'metric' },
  average_case_size: { group: 'case_size', unit: 'idr_minor', ytd: 'metric' },
};

/** **The average per month of a count**: the mean of the months that hold a figure, to a tenth; `null` with none. */
export function monthlyMean(values: readonly (number | null)[]): number | null {
  const held = values.filter((v): v is number => v !== null);
  if (held.length === 0) return null;
  return Math.round((held.reduce((a, b) => a + b, 0) / held.length) * 10) / 10;
}

/**
 * **The change in %** from `before` to `now`, whole, half away from zero — `null` (*—*) when either is missing or
 * `before` is 0, which no percentage of can be taken.
 */
export function changePct(now: number | null, before: number | null): number | null {
  if (now === null || before === null || before === 0) return null;
  const pct = ((now - before) / Math.abs(before)) * 100;
  return Math.sign(pct) * Math.round(Math.abs(pct));
}

/** **The change in points** of a percentage row: `now − before`, whole; `null` when either is missing. */
export function changePoints(now: number | null, before: number | null): number | null {
  if (now === null || before === null) return null;
  const d = now - before;
  return Math.sign(d) * Math.round(Math.abs(d));
}

/** The change a row shows: points for a percentage, % for anything else. */
export function changeOf(unit: MapaUnit, now: number | null, before: number | null): { value: number | null; kind: 'pct' | 'points' } {
  return unit === 'percentage' ? { value: changePoints(now, before), kind: 'points' } : { value: changePct(now, before), kind: 'pct' };
}
