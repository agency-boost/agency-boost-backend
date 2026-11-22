import type { KpmOwner } from './kpm.schema';

/**
 * **A KPM's owners, read** (P19.27-T1 AC-1; [ADR-0285](../../../../docs/04-adr/0285-a-kpm-has-one-or-more-owners.md) §1;
 * F-2 (21 Nov)). The one place that answers *"is this person an owner"* and *"who are they, in order"* from a KPM row —
 * every check that read `kpms.ownerUserId`, the one owner, reads one of these now: **any owner** wherever it asked about
 * *the* owner.
 *
 * Pure: a KPM row, or anything carrying `owners`, in; nothing read, nothing written. A row written before migration
 * `0077` (no `owners`) reads as a KPM with no owner, never a crash.
 */

/** What these read of a KPM: its owners, possibly absent on a row projected without them. */
export interface WithOwners {
  owners?: readonly KpmOwner[] | null;
}

const time = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);

/** The owners in order of `since`, the earliest first; two owners since the same instant keep their stored order. */
export function ownersInOrder(kpm: WithOwners | null | undefined): KpmOwner[] {
  return [...(kpm?.owners ?? [])].map((o, i) => ({ o, i }))
    .sort((a, b) => time(a.o.since) - time(b.o.since) || a.i - b.i)
    .map(({ o }) => o);
}

/** **Is `userId` one of the KPM's owners?** `false` for no KPM, no person, or a KPM with no owner. */
export function isOwnerOf(kpm: WithOwners | null | undefined, userId: string | null | undefined): boolean {
  if (!userId) return false;
  return (kpm?.owners ?? []).some((o) => o.userId === userId);
}

/** **The owners' user ids**, in order of `since` (the first owner first). Empty for a KPM with none. */
export function ownerUserIdsOf(kpm: WithOwners | null | undefined): string[] {
  return ownersInOrder(kpm).map((o) => o.userId);
}

/**
 * **The first owner** — the earliest `since` — or `null`: who a screen names when it names one (*"♛ FIRST OWNER +n"*), and
 * the `ownerUserId` / `ownerName` responses keep for it (ADR-0285 §3).
 */
export function firstOwnerOf(kpm: WithOwners | null | undefined): KpmOwner | null {
  return ownersInOrder(kpm)[0] ?? null;
}

/** How many owners the KPM has. */
export function ownerCountOf(kpm: WithOwners | null | undefined): number {
  return (kpm?.owners ?? []).length;
}

/** **A Mongo filter: KPMs this person owns** — `owners.userId`, the index `owners_userId` (ADR-0285 §1). */
export function ownedBy(userId: string | { $in: readonly string[] }): { 'owners.userId': string | { $in: readonly string[] } } {
  return { 'owners.userId': userId };
}

/** **A Mongo filter: KPMs with at least one owner.** */
export const HAS_AN_OWNER = { 'owners.0': { $exists: true } } as const;

/** **A Mongo filter: KPMs with no owner yet** — `owners` empty or absent. */
export const HAS_NO_OWNER = { 'owners.0': { $exists: false } } as const;

/** The projection that reads the owners and nothing else of them. */
export const OWNERS_PROJECTION = { owners: 1 } as const;

/** One owner entry, as `KpmOwnersService` writes it and the seed and the specs build a row with. */
export function ownerEntry(userId: string, since: Date, addedByUserId: string | null = null): KpmOwner {
  return { userId, since, addedByUserId };
}
