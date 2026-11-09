/**
 * **A rung's leader tier, and the role class it gives whoever stands on it** (ADR-0156, P18.5-T1).
 *
 * A company's ladder is configuration (ADR-0012): Prudential's is `Agent → AAB → AB`, the next insurer's may be
 * `Agent → UM → SM`. What decides **who leads** is not the rung's code but its tier, set on `/admin/org-levels`:
 *
 * - `senior` — *Senior Leader*, what AB is: the head of an agency;
 * - `associate` — *Associate Leader*, what AAB is: the head of a unit inside an agency;
 * - `null` — *Not a leader*.
 *
 * A membership's `role` (`ab | aab | agent`) is the **class**, derived from its rung's tier wherever a member is
 * placed on a rung, and RBAC, *Leaders used* and the Owner's agency and unit partitions read the class. The class
 * keeps the names it had, because the permission matrix and seven `modules/org` sites are written in them (OD-50);
 * what changed is that it always follows the rung, whatever the rung is called.
 *
 * Documented once in `docs/00-product/metrics-and-definitions.md` and pinned by `leader-tier.spec.ts`.
 */
export const LEADER_TIERS = ['senior', 'associate'] as const;
export type LeaderTier = (typeof LEADER_TIERS)[number];

/** The class a membership carries: the hierarchy role's three values, as the matrix's columns name them. */
export type RoleClass = 'ab' | 'aab' | 'agent';

/** Each tier's class. A rung with no tier makes its members `agent`. */
export const ROLE_CLASS_BY_TIER: Readonly<Record<LeaderTier, RoleClass>> = { senior: 'ab', associate: 'aab' };

/**
 * **What a leader is, for the leader limit** (ADR-0113 §1 as ADR-0156 §4 amends it): the classes whose active
 * members count towards *Leaders used* — whatever rung they stand on. It replaced `LEADER_RUNG_CODES`
 * (`['AB', 'AAB']`), which counted by code and so never counted a leader on a rung a company named itself.
 *
 * Not ADR-0087's *leader* — anybody with direct reports — which governs coaching, the landing and the nav.
 */
export const LEADER_CLASSES = ['ab', 'aab'] as const satisfies readonly RoleClass[];

/**
 * **The tier a rung written before the field existed reads as** — the default ladder's: `AB` senior, `AAB`
 * associate, anything else none. Exactly what migration 0030 writes, so a row the migration has not reached yet
 * (a fixture that writes the collection directly, a deploy between the code and its migration) re-classes nobody.
 */
export const LEGACY_TIER_BY_CODE: Readonly<Record<string, LeaderTier>> = { AB: 'senior', AAB: 'associate' };

/** The class a rung of this tier gives its members: `senior` → `ab`, `associate` → `aab`, none → `agent`. */
export function roleClassOf(tier: LeaderTier | null | undefined): RoleClass {
  return tier ? ROLE_CLASS_BY_TIER[tier] : 'agent';
}

/**
 * A rung's tier: the stored one, or — **only when the field is absent** — what the migration would write. `null`
 * stored is *Not a leader*, and is never second-guessed by the code.
 */
export function tierOfRung(rung: { code: string; leaderTier?: LeaderTier | null }): LeaderTier | null {
  if (rung.leaderTier !== undefined) return rung.leaderTier;
  return LEGACY_TIER_BY_CODE[String(rung.code).toUpperCase()] ?? null;
}

/** The longest rung code that reads as its own short name, as an acronym does: `AB`, `AAB`, `SM`. */
export const RUNG_SHORT_CODE_MAX_LENGTH = 4;

/**
 * **What a rung is called wherever a person's role is named in a sentence** (ADR-0167 §10, OD-205; P18.7-T9
 * AC-1: one name per role). A code that reads as an acronym is already the short form — `AB`, `AAB`; a longer one
 * would be shouted, so the ladder's label is used instead — `AGENT` is *Agent*. The rung's long label, whole, is
 * for where the ladder itself is listed and edited.
 *
 * **It mirrors `shortOfRung` in `frontend/src/components/ui/role-badge.tsx`**, so a refusal the server words and a
 * badge the screen draws call a rung by the same name.
 */
export function shortOfRung(rung: { code: string; label: string }): string {
  return rung.code.length <= RUNG_SHORT_CODE_MAX_LENGTH ? rung.code : rung.label;
}

/** Does this class count as a leader for the leader limit? */
export function isLeaderClass(role: string | null | undefined): boolean {
  return (LEADER_CLASSES as readonly string[]).includes(String(role ?? ''));
}
