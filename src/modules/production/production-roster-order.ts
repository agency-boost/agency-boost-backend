import type { HierarchyRole } from '@/modules/org/membership.schema';

/** A member as the walk needs them: who they are, where they stand, and whom they report to now. */
export interface TreeMember {
  membershipId: string;
  name: string;
  /** The rung, as the membership carries it. `null` reads as an agent. */
  role: HierarchyRole | null;
  /** The current edge's leader — the membership's `leaderId`. `null` for nobody. */
  leaderId: string | null;
  /** The office's sequence. Breaks the last tie, so two people of one name never swap places. */
  agentSeq: number;
}

/** Higher rungs first among siblings: an AB's AABs, each with their agents, then its own agents. */
const RUNG: Record<HierarchyRole, number> = { ab: 0, aab: 1, agent: 2 };
const rung = (m: TreeMember) => RUNG[m.role ?? 'agent'] ?? RUNG.agent;

/**
 * **Case and accents do not count**, as on every other list of names here (`lead-order.ts`). Pinned to
 * a locale, so the order does not depend on the server's.
 */
const NAMES = new Intl.Collator('id', { sensitivity: 'base' });

const byName = (a: TreeMember, b: TreeMember) =>
  NAMES.compare(a.name, b.name) || a.agentSeq - b.agentSeq || a.membershipId.localeCompare(b.membershipId);
const siblings = (a: TreeMember, b: TreeMember) => rung(a) - rung(b) || byName(a, b);

/**
 * **The office in the order its org tree reads** (P13.1-T7) — the month table's rows and the template's.
 *
 * The prototype lists its rows from `AGENT_CODE_ORDER` (`KPM_Owner.html:4662-4677`), a walk of
 * `ORG_FOREST` (`:2095-2124`): each AB, then each of its AABs followed by that AAB's agents, then the
 * AB's own agents. Its order *within* a level is the order the array was typed in, which is no rule
 * at all, so ours is by name. The walk itself is the prototype's, applied at every depth:
 *
 * 1. **Each AB at the top of a tree**, by name. A top is anybody whose leader is not among `members`.
 * 2. Under anybody, **their reports by rung, then by name** — an AB under an AB, then the AABs, then
 *    the agents — **each followed by everybody under them**, before the next.
 * 3. **Anybody else with no leader here, last**, by name, each with whoever hangs under them: somebody
 *    orphaned by a removal, or registered and never placed.
 *
 * **Everybody once.** A leader edge that loops — which the org module never writes — would leave its
 * members with no top; they come after everybody else, by name, rather than being dropped from a list
 * whose whole point is that nobody is missing.
 */
export function orgTreeOrder<T extends TreeMember>(members: readonly T[]): T[] {
  const byId = new Map(members.map((m) => [m.membershipId, m]));
  const reports = new Map<string, T[]>();
  const tops: T[] = [];
  const loose: T[] = [];

  for (const m of members) {
    const leader = m.leaderId && m.leaderId !== m.membershipId ? byId.get(m.leaderId) : undefined;
    if (leader) {
      const under = reports.get(leader.membershipId) ?? [];
      under.push(m);
      reports.set(leader.membershipId, under);
    } else if (m.role === 'ab') {
      tops.push(m);
    } else {
      loose.push(m);
    }
  }

  const out: T[] = [];
  const seen = new Set<string>();
  const walk = (m: T) => {
    if (seen.has(m.membershipId)) return;
    seen.add(m.membershipId);
    out.push(m);
    for (const r of [...(reports.get(m.membershipId) ?? [])].sort(siblings)) walk(r);
  };

  for (const m of [...tops].sort(byName)) walk(m);
  for (const m of [...loose].sort(byName)) walk(m);
  for (const m of members.filter((x) => !seen.has(x.membershipId)).sort(byName)) walk(m);
  return out;
}
