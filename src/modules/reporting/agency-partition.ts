/**
 * **AB agencies** (Phase 18, D-units → option 1): what a row of the unit comparison is, and of *Units furthest
 * behind target*, when an AB sits under an AB — which ADR-0014 makes the normal result of a promotion.
 *
 * - **One agency per member on the `AB` rung**, over their own people: themselves and everybody below them down
 *   to, and not including, the next AB, whose agency is its own. So the agencies **partition** the office's
 *   members, and a total is the sum of its rows. The Owner is an agency like any AB (roles §1.1).
 * - **Inside an agency, one unit per AAB who leads somebody**, over their people within the agency: the AAB and
 *   everybody below them down to the next such AAB (or AB). Everybody else is the agency's *(Direct)* part —
 *   the AB, and the members in no AAB's unit.
 * - **Who stands where is the current leader edges** — the materialised `ancestorIds` the org module writes with
 *   the open edge (`validTo: null`), walked from the nearest ancestor up. A member who has **left** is placed by
 *   the edges they left with (OD-74: their production stays where it was made), and heads nothing and leads
 *   nobody: only active members are heads.
 * - **A member under no active AB** — orphaned by a removal, say — is in no agency, and is listed as such, so a
 *   reader of the office's own figures can say what the rows leave out.
 *
 * Pure: memberships in, the partition out, no rule but these. Pinned at 100% branch (`jest.config.ts`).
 */
export interface PlacedMembership {
  membershipId: string;
  orgLevelCode: string;
  leaderId: string | null;
  /** Root first, excluding self: the cache the org module writes with every edge. */
  ancestorIds: readonly string[];
  /** Here now. A leaver is placed, never a head, and leads nobody. */
  active: boolean;
}

export interface AgencyUnit {
  /** The AAB who leads it. */
  headId: string;
  /** The AAB and their people within the agency, the AAB first. */
  memberIds: string[];
}

export interface Agency {
  /** The AB whose agency it is. */
  headId: string;
  /** The AB and the members in no AAB's unit, the AB first: the *(Direct)* row. */
  directIds: string[];
  units: AgencyUnit[];
  /** Everybody in the agency, the AB first. */
  memberIds: string[];
}

export interface AgencyPartition {
  agencies: Agency[];
  /** Placed under no active AB: in the office's own figures, in no row. */
  unplacedIds: string[];
}

export const AGENCY_RUNG = 'AB';
export const UNIT_RUNG = 'AAB';

export function partitionAgencies(memberships: readonly PlacedMembership[]): AgencyPartition {
  const active = memberships.filter((m) => m.active);
  const activeIds = new Set(active.map((m) => m.membershipId));
  const leads = new Set(active.flatMap((m) => (m.leaderId !== null && activeIds.has(m.leaderId) ? [m.leaderId] : [])));
  const isHead = new Set(active.filter((m) => m.orgLevelCode === AGENCY_RUNG).map((m) => m.membershipId));
  const isUnitHead = new Set(active
    .filter((m) => m.orgLevelCode === UNIT_RUNG && leads.has(m.membershipId))
    .map((m) => m.membershipId));

  const agencies = new Map<string, { direct: string[]; units: Map<string, string[]> }>();
  for (const id of isHead) agencies.set(id, { direct: [id], units: new Map() });
  const unplacedIds: string[] = [];

  for (const m of memberships) {
    if (m.active && isHead.has(m.membershipId)) continue;
    // Self first when it can head a unit, then the nearest ancestor up.
    const chain = [...m.ancestorIds].reverse();
    const headIndex = chain.findIndex((id) => isHead.has(id));
    if (headIndex === -1) {
      unplacedIds.push(m.membershipId);
      continue;
    }
    const agency = agencies.get(chain[headIndex])!;
    const between = chain.slice(0, headIndex);
    const unitHead = m.active && isUnitHead.has(m.membershipId)
      ? m.membershipId
      : between.find((id) => isUnitHead.has(id));
    if (unitHead === undefined) {
      agency.direct.push(m.membershipId);
      continue;
    }
    const unit = agency.units.get(unitHead) ?? [unitHead];
    if (unitHead !== m.membershipId) unit.push(m.membershipId);
    agency.units.set(unitHead, unit);
  }

  return {
    agencies: [...agencies].map(([headId, { direct, units }]) => {
      const unitRows = [...units].map(([unitHeadId, memberIds]) => ({ headId: unitHeadId, memberIds }));
      return {
        headId,
        directIds: direct,
        units: unitRows,
        memberIds: [...direct, ...unitRows.flatMap((unit) => unit.memberIds)],
      };
    }),
    unplacedIds,
  };
}
