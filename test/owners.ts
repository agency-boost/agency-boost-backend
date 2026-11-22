import { ownerEntry } from '@/modules/tenants/kpm-owners';
import type { KpmOwner } from '@/modules/tenants/kpm.schema';

/** When a fixture's owners became owners, unless a spec says: a fixed instant, never the machine's clock. */
export const FIXTURE_OWNER_SINCE = new Date('2026-01-01T00:00:00Z');

/**
 * **A KPM row's `owners` for a fixture** (ADR-0285 §1): one owner — the fixture's *the Owner* — or none for `null`. What
 * every spec writes where it wrote `ownerUserId` before P19.27.
 */
export function ownersOf(userId: string | null | undefined, since: Date = FIXTURE_OWNER_SINCE): KpmOwner[] {
  return userId ? [ownerEntry(String(userId), since)] : [];
}
