import { LEADER_CLASSES } from '@/domain/constants';
import { peerMedian } from './quant';

/**
 * ***Analisa kuantitatif*'s distribution per leader** (P19.22-T4 AC-2; ADR-0275 §4; `DATA-DEFINITIONS.md`, *Analisa
 * kuantitatif*: *"Distribution per leader shows each leader against the KPM median"*; `metrics-and-definitions.md`
 * §A.15). Pure. Pinned by `quant-leaders.spec.ts`.
 *
 * - **A leader's unit** is the leader and every member whose nearest leader they are — themselves when they lead (an AB or
 *   an AAB), else the nearest leader up their line — so the units partition the people who stand under a leader, and an
 *   AAB's team is the AAB's, not their AB's. Each metric is then computed over the unit by its own definition, the unit's
 *   one leader its *per leader* divisor.
 * - **`QUANT_LEADER_MEDIAN` — *Median KPM*** is the median of the leaders' values (`peerMedian`'s rule from one value),
 *   and *"x dari y leader di atau di atas median"* counts the leaders whose value is at least it.
 */

export interface UnitPerson {
  membershipId: string;
  role: string;
  leaderId: string | null;
}

const isLeader = (role: string) => (LEADER_CLASSES as readonly string[]).includes(role);

/**
 * **Each person's nearest leader**: themselves when they are an AB or an AAB; else the first AB or AAB up their line,
 * walking `leaderId`; `null` with none (somebody under no leader, or a line that leaves the people given).
 */
export function nearestLeaderOf(people: readonly UnitPerson[]): Map<string, string | null> {
  const byId = new Map(people.map((p) => [p.membershipId, p]));
  const out = new Map<string, string | null>();
  for (const person of people) {
    let at: UnitPerson | undefined = person;
    const seen = new Set<string>();
    while (at && !isLeader(at.role) && at.leaderId !== null && !seen.has(at.membershipId)) {
      seen.add(at.membershipId);
      at = byId.get(at.leaderId);
    }
    out.set(person.membershipId, at && isLeader(at.role) ? at.membershipId : null);
  }
  return out;
}

/** The units: each leader → the people whose nearest leader they are, the leader first. */
export function leaderUnits(people: readonly UnitPerson[]): Map<string, string[]> {
  const nearest = nearestLeaderOf(people);
  const units = new Map<string, string[]>();
  for (const p of people) if (isLeader(p.role)) units.set(p.membershipId, [p.membershipId]);
  for (const p of people) {
    const leader = nearest.get(p.membershipId);
    if (leader && leader !== p.membershipId) units.get(leader)?.push(p.membershipId);
  }
  return units;
}

export interface LeaderValue {
  membershipId: string;
  value: number;
}

export interface LeaderDistribution {
  /** High to low; a tie by id, so two reads agree. */
  leaders: LeaderValue[];
  /** `QUANT_LEADER_MEDIAN`: the leaders' median; `null` with no leader holding a value. */
  median: number | null;
  /** Leaders at or above the median. */
  atOrAbove: number;
}

/** **The distribution**: the leaders with a value, high to low, their median, and how many stand at or above it. */
export function leaderDistribution(values: readonly LeaderValue[]): LeaderDistribution {
  const leaders = [...values].sort((a, b) => b.value - a.value || a.membershipId.localeCompare(b.membershipId));
  const median = peerMedian(leaders.map((l) => l.value), 1);
  return { leaders, median, atOrAbove: median === null ? 0 : leaders.filter((l) => l.value >= median).length };
}
