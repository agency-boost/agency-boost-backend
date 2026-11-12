import { UNIT_DASHBOARD, type UnitView } from '@/domain/constants';

/*
 * **The Unit Dashboard's three views** (`metrics-and-definitions.md`, *The views*; ADR-0249; `functional/unit-dashboard.md`,
 * *Views*): who a leader's figures are over, defined once and pure, so every reader that says *Group* reads the same
 * people (invariant §8).
 *
 * The client's message of 11 November 2026, items 5 and 7: *"AB di bawah gw harusnya ga masuk grup gw, cuma muncul di
 * Group Tree"* — an AB below a leader is not that leader's AAB.
 *
 * With H the head:
 *
 * - **`DIRECT_GROUP(H)`** (*Grup langsung*): H and everybody below H, **never descending into a member of the `ab` class**
 *   (ADR-0156 §4: a rung marked *Senior Leader*). An AB below H, and everybody under that AB, is out. For an AB this is
 *   the agency `partitionAgencies` computes (`reporting/agency-partition.ts`), which a test says. Only an **active**
 *   member stops the descent, as only an active AB heads an agency there.
 * - **`INFORMAL_GROUP(H)`** (*Grup informal*): `DIRECT_GROUP(H)`, plus each active member of `DOWNLINE(H)` tagged into a
 *   live group H owns (*People › Groups*) — a tagged AB bringing their own `DIRECT_GROUP`. **Always inside
 *   `DOWNLINE(H)`**: a tag never widens anybody's reach (P3-T9 AC-1).
 * - **`DOWNLINE(H)`** (*Semua downline*): H's coachees (`CoachResolver.coacheesOf`) — and for the Owner or an Admin reading
 *   their own dashboard, every active member of the office, other roots and people with no leader included.
 *
 * `DIRECT_GROUP(H) ⊆ INFORMAL_GROUP(H) ⊆ DOWNLINE(H)`.
 */

export type { UnitView };

/** One member as the views read them: the current leader edge and its cached path. */
export interface ViewMember {
  membershipId: string;
  /** Their leader on the current edge; `null` for a root. */
  leaderId: string | null;
  /** The class (ADR-0156): `ab`, `aab` or `agent`. */
  role: string;
  /** Root first, excluding self: the cache the org module writes with every edge. */
  ancestorIds: readonly string[];
  /** Here now (default). A leaver never stops a descent: they head nothing (`partitionAgencies`). */
  active?: boolean;
}

/** The class a descent stops at: a rung marked *Senior Leader*. */
const AB_CLASS = 'ab';

const isActive = (m: ViewMember) => m.active !== false;

/**
 * **`DIRECT_GROUP(H)`**: the head first, then every member below them in the order given, kept when neither they nor any
 * member between H and them is an active member of the `ab` class. A member between who is not in `members` stops
 * nothing (the caller's set is the people it reads).
 */
export function directGroup(headId: string, members: readonly ViewMember[]): string[] {
  const byId = new Map(members.map((m) => [m.membershipId, m]));
  const stops = (id: string) => {
    const m = byId.get(id);
    return m !== undefined && isActive(m) && m.role === AB_CLASS;
  };
  const out = [headId];
  for (const m of members) {
    if (m.membershipId === headId) continue;
    const at = m.ancestorIds.indexOf(headId);
    if (at === -1) continue;
    const path = [...m.ancestorIds.slice(at + 1), m.membershipId];
    if (!path.some(stops)) out.push(m.membershipId);
  }
  return out;
}

/**
 * **`DOWNLINE(H)`**: the head first, then — office-wide (the Owner or an Admin on their own dashboard) — every active
 * member; otherwise every active member H stands above on the current edges, every member between them active too
 * (`COACH`, ADR-0074; the service reads it from `CoachResolver.coacheesOf`, which this agrees with).
 */
export function downline(headId: string, members: readonly ViewMember[], officeWide: boolean): string[] {
  const live = new Set(members.filter(isActive).map((m) => m.membershipId));
  const below = members.filter((m) => {
    if (m.membershipId === headId || !isActive(m)) return false;
    if (officeWide) return true;
    const at = m.ancestorIds.indexOf(headId);
    return at !== -1 && m.ancestorIds.slice(at + 1).every((id) => live.has(id));
  });
  return [headId, ...below.map((m) => m.membershipId)];
}

/**
 * **`INFORMAL_GROUP(H)`** over `DOWNLINE(H)` (`members`, the head among them or not): `DIRECT_GROUP(H)`, then each tagged
 * member in the order given — an AB with their own `DIRECT_GROUP` — every id once. `tagged` is the members tagged into a
 * live group H owns; a tag on anybody outside `members` reaches nobody.
 */
export function informalGroup(headId: string, members: readonly ViewMember[], tagged: ReadonlySet<string>): string[] {
  const out = new Set(directGroup(headId, members));
  for (const m of members) {
    if (m.membershipId === headId || !isActive(m) || !tagged.has(m.membershipId)) continue;
    const brings = m.role === AB_CLASS ? directGroup(m.membershipId, members) : [m.membershipId];
    for (const id of brings) out.add(id);
  }
  return [...out];
}

/**
 * **`ABS_NOT_IN_INFORMAL_GROUP(H)`**: the active members of the `ab` class in `DOWNLINE(H)` but H, tagged into no live
 * group H owns — *"{n} AB di bawah Anda belum masuk grup"*. Their ids, in the order given; the figure is their number.
 */
export function absNotInInformalGroup(headId: string, members: readonly ViewMember[], tagged: ReadonlySet<string>): string[] {
  return members
    .filter((m) => m.membershipId !== headId && isActive(m) && m.role === AB_CLASS && !tagged.has(m.membershipId))
    .map((m) => m.membershipId);
}

/** Whose dashboard, for the views a reader is offered: the office's own, read by its Owner or an Admin, or a leader's. */
export type ViewReader = 'owner' | 'admin' | 'leader';

/** What decides the views offered for a head. */
export interface ViewFacts {
  reader: ViewReader;
  /** H has at least one active direct report. */
  leadsSomebody: boolean;
  /** H owns a live group (*People › Groups*). */
  ownsLiveGroup: boolean;
  /** Active members of the `ab` class in `DOWNLINE(H)` but H. */
  abBelow: number;
}

export interface ViewsOffered {
  /** In the order drawn: *Grup langsung · Grup informal · Semua downline*. */
  offered: UnitView[];
  default: UnitView;
}

/**
 * **The views offered, and the default** (the client's item 7: *"Pilihan yang ga relevan disembunyiin"*):
 *
 * - *Grup langsung* while H leads somebody;
 * - *Grup informal* while H owns a live group or has an AB below them;
 * - *Semua downline* while an AB is below H — without one it is *Grup langsung* again — and always for the Owner or an
 *   Admin on their own dashboard, where it is the whole office.
 *
 * **The default**: the Owner's own dashboard *Semua downline*; an Admin's *Grup langsung* while they lead somebody, else
 * *Semua downline*; every leader's — and any `for` view's, a `leader` here — *Grup langsung*. A default not offered gives
 * way to the first view that is; with none offered (a head who leads nobody) it stands, and the unit is empty.
 */
export function viewsOffered(facts: ViewFacts): ViewsOffered {
  const office = facts.reader !== 'leader';
  const offered = UNIT_DASHBOARD.VIEWS.filter((view) => {
    if (view === 'direct') return facts.leadsSomebody;
    if (view === 'informal') return facts.ownsLiveGroup || facts.abBelow > 0;
    return office || facts.abBelow > 0;
  });
  const preferred: UnitView = facts.reader === 'owner' || (facts.reader === 'admin' && !facts.leadsSomebody)
    ? 'downline'
    : 'direct';
  return { offered, default: offered.includes(preferred) ? preferred : offered[0] ?? preferred };
}

/** The view a read answers: the one asked for while it is offered, else the default. */
export function viewChosen(asked: UnitView | undefined, views: ViewsOffered): UnitView {
  return asked !== undefined && views.offered.includes(asked) ? asked : views.default;
}

/** How a view's people hang together on the roster. */
export interface ViewPlacement {
  /**
   * Each member's parent within the view, the head left out: their leader when the leader is in the view; **the head**
   * when not — a tagged AB under an untagged one, another root of the office — and they are a unit of their own under it
   * (`attached`); or **`null`**: in nobody's tree — office-wide, somebody whose leader is not in the view and who leads
   * nobody in it, drawn under *Belum punya leader*.
   */
  parentOf: Map<string, string | null>;
  /** Hung from the head though the head is not their leader: always a unit, never *Your Unit*. */
  attached: Set<string>;
  /** Edges from the head in the view; 1 under *Belum punya leader*. */
  depth: Map<string, number>;
}

/**
 * **Place a view's members** (`ids`, the head among them) on its roster. `unled` is true for the office-wide *Semua
 * downline* alone, where people with no leader in the view and nobody under them are listed apart.
 */
export function placeView(
  headId: string, members: readonly ViewMember[], ids: readonly string[], { unled }: { unled: boolean },
): ViewPlacement {
  const inView = new Set(ids);
  const byId = new Map(members.map((m) => [m.membershipId, m]));
  const below = new Set<string>();
  for (const id of ids) {
    const leader = byId.get(id)?.leaderId;
    if (id !== headId && leader && inView.has(leader)) below.add(leader);
  }
  const parentOf = new Map<string, string | null>();
  const attached = new Set<string>();
  for (const id of ids) {
    if (id === headId) continue;
    const leader = byId.get(id)?.leaderId ?? null;
    if (leader !== null && inView.has(leader) && leader !== id) {
      parentOf.set(id, leader);
    } else if (unled && !below.has(id)) {
      parentOf.set(id, null);
    } else {
      parentOf.set(id, headId);
      attached.add(id);
    }
  }
  // Edges from the head, by the parents; a chain that never reaches it (it cannot, on the cached edges) hangs from it.
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const parent = parentOf.get(id);
    let d: number;
    if (parent === null || parent === undefined || parent === headId) d = 1;
    else if (seen.has(parent)) d = 1;
    else d = depthOf(parent, new Set([...seen, id])) + 1;
    depth.set(id, d);
    return d;
  };
  for (const id of ids) if (id !== headId) depthOf(id, new Set([id]));
  return { parentOf, attached, depth };
}
