import type { Gender, WorkStatus } from '@/domain/constants';
import { memberAt, type CountedMembership } from './office-headcount';

/**
 * **`MANPOWER_BY_DIMENSION` — Demographics** (P19.5-T3 AC-2; ADR-0215 §3; OWN UI-024, OWN R6, OWN Cases 6 and 9;
 * `metrics-and-definitions.md` §A.15).
 *
 * The KPM's manpower at the period's end (D3, `OFFICE_HEADCOUNT`), split one dimension at a time: role (the company's
 * ladder), work status, gender, age band and tenure band. **Each member counts once in each dimension, so every
 * dimension sums to manpower**; a member missing a field counts under `unset` (*Belum diisi*) and is never dropped.
 *
 * - **Age** is whole years from the birth date to the period's last day: `≤ ageBandUpper[0]` Gen Z, `≤ ageBandUpper[1]`
 *   Gen Y, else Gen X.
 * - **Tenure** is whole years from joining this KPM (`memberships.joinDate`; OD-254 Q8) to the period's last day; each
 *   band includes its lower bound and excludes its upper one, so 7 years is *7–10*.
 *
 * Pure: the caller reads the members once.
 */

export interface DemographicsMember {
  counted: CountedMembership;
  orgLevelCode: string;
  workStatus: WorkStatus | null;
  gender: Gender | null;
  /** `YYYY-MM-DD`. */
  dateOfBirth: string | null;
  /** `YYYY-MM-DD` in the office's calendar. */
  joinDate: string | null;
}

export interface DimensionCount {
  key: string;
  count: number;
  /** A band's bounds in years, as drawn: *Gen Y 30–45*, *3–7*. `null` for an open end. */
  from?: number | null;
  to?: number | null;
  /** The rung's label on the ladder, for `role`. */
  label?: string;
}

export interface Demographics {
  manpower: number;
  role: DimensionCount[];
  workStatus: DimensionCount[];
  gender: DimensionCount[];
  ageBand: DimensionCount[];
  tenureBand: DimensionCount[];
}

/** Whole years from `from` to `to`, both `YYYY-MM-DD`; `null` when `from` is after `to`. */
export function wholeYears(from: string, to: string): number | null {
  if (from > to) return null;
  const years = Number(to.slice(0, 4)) - Number(from.slice(0, 4));
  return to.slice(5) >= from.slice(5) ? years : years - 1;
}

export const UNSET = 'unset';

/** The band an age falls in: `gen_z`, `gen_y` or `gen_x`. */
export function ageBandOf(age: number, upper: readonly [number, number]): 'gen_z' | 'gen_y' | 'gen_x' {
  if (age <= upper[0]) return 'gen_z';
  return age <= upper[1] ? 'gen_y' : 'gen_x';
}

/** The band a tenure falls in, by its lower bound: `0`, `3`, `7` or `10` for the defaults. */
export function tenureBandOf(years: number, bounds: readonly [number, number, number]): number {
  return [...bounds].reverse().find((b) => years >= b) ?? 0;
}

export function manpowerByDimension(
  members: readonly DemographicsMember[],
  at: { endOfDay: Date; lastDay: string },
  rungs: readonly { code: string; label: string }[],
  bands: { ageBandUpper: readonly [number, number]; ageLabelFloor: number; tenureBands: readonly [number, number, number] },
): Demographics {
  const here = members.filter((m) => memberAt(m.counted, at.endOfDay));
  const tally = (keys: readonly string[], keyOf: (m: DemographicsMember) => string): DimensionCount[] => {
    const counts = new Map<string, number>(keys.map((k) => [k, 0]));
    for (const m of here) {
      const key = keyOf(m);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].map(([key, count]) => ({ key, count }));
  };

  // The rungs as `rungsFor` gives them — the ladder's, senior first, and any code a member stands on that it does not
  // name — so the role counts add up to manpower whatever the ladder holds.
  const named = new Set(rungs.map((r) => r.code));
  const role: DimensionCount[] = [
    ...rungs.map((r) => ({ key: r.code, label: r.label, count: here.filter((m) => m.orgLevelCode === r.code).length })),
    ...[...new Set(here.map((m) => m.orgLevelCode))].filter((c) => !named.has(c)).sort()
      .map((c) => ({ key: c, label: c, count: here.filter((m) => m.orgLevelCode === c).length })),
  ];

  const [z, y] = bands.ageBandUpper;
  const ageBand = tally(['gen_z', 'gen_y', 'gen_x', UNSET], (m) => {
    const age = m.dateOfBirth ? wholeYears(m.dateOfBirth, at.lastDay) : null;
    return age === null ? UNSET : ageBandOf(age, bands.ageBandUpper);
  }).map((d) => ({
    ...d,
    ...(d.key === 'gen_z' ? { from: bands.ageLabelFloor, to: z } : d.key === 'gen_y' ? { from: z + 1, to: y } : d.key === 'gen_x' ? { from: y + 1, to: null } : {}),
  }));

  const [t1, t2, t3] = bands.tenureBands;
  const tenureKeys = ['0', String(t1), String(t2), String(t3)];
  const tenureBand = tally([...tenureKeys, UNSET], (m) => {
    const years = m.joinDate ? wholeYears(m.joinDate, at.lastDay) : null;
    return years === null ? UNSET : String(tenureBandOf(years, bands.tenureBands));
  }).map((d) => {
    const bounds: Record<string, { from: number | null; to: number | null }> = {
      '0': { from: null, to: t1 }, [String(t1)]: { from: t1, to: t2 }, [String(t2)]: { from: t2, to: t3 }, [String(t3)]: { from: t3, to: null },
    };
    return d.key === UNSET ? d : { ...d, ...bounds[d.key] };
  });

  return {
    manpower: here.length,
    role,
    workStatus: tally(['full_time', 'part_time', UNSET], (m) => m.workStatus ?? UNSET),
    gender: tally(['male', 'female', UNSET], (m) => m.gender ?? UNSET),
    ageBand,
    tenureBand,
  };
}
