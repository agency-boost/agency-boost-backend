import mongoose from 'mongoose';
import { emptyIfMissing } from './missing-collection';

/** What one run did. Printed by `run.ts`, so the deploy log is the record of it. */
export interface KpmOwnersListResult {
  /** KPMs whose `ownerUserId` became a one-owner list. */
  moved: number;
  /** KPMs with no owner: `owners: []`, the empty `ownerUserId` dropped. */
  empty: number;
  /** KPMs that had their list already: a second run, or a row written since. */
  current: number;
}

/** The index `ownerUserId` carried, by Mongoose's own name for it. */
const OLD_INDEX = 'ownerUserId_1';

type Office = { _id: mongoose.Types.ObjectId; ownerUserId?: string | null; owners?: { userId: string; since: Date; addedByUserId: string | null }[]; createdAt?: Date };

/**
 * **A KPM's one owner becomes a list of owners** (P19.27-T1 AC-1; [ADR-0285](../../../docs/04-adr/0285-a-kpm-has-one-or-more-owners.md)
 * §1; F-2 (21 Nov) *"Existing KPMs migrate with their current owner as the single owner"* — reversible, `down` keeping the
 * first owner).
 *
 * For every KPM, a soft-deleted one included (its history must still name its owner):
 *
 * - **With `ownerUserId`**: `owners` becomes `[{ userId, since, addedByUserId: null }]` — `since` the owner's membership in
 *   that KPM's join date (`joinedAt`), else its creation, else the KPM's creation, else this run's `now` — and
 *   `ownerUserId` is removed.
 * - **With none** (`null` or absent): `owners: []`, the empty field removed.
 * - **With `owners` already** (a second run, or a row written since): kept; a stray `ownerUserId` beside it is removed,
 *   added to the list first if it was not on it.
 *
 * The index `ownerUserId_1` is dropped; the application builds `owners_userId`. **Idempotent**: a second run finds every
 * KPM `current`. On an empty database it reads nothing and creates no collection. Nothing else is touched: the owners'
 * memberships, rungs and every record stay as they were.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<KpmOwnersListResult> {
  const result: KpmOwnersListResult = { moved: 0, empty: 0, current: 0 };
  const existing = await db.listCollections({ name: 'kpms' }, { nameOnly: true }).toArray();
  if (existing.length === 0) return result;
  const kpms = db.collection('kpms');
  const offices = await kpms.find({}, { projection: { ownerUserId: 1, owners: 1, createdAt: 1 } }).sort({ _id: 1 }).toArray() as Office[];

  for (const office of offices) {
    const owner = typeof office.ownerUserId === 'string' && office.ownerUserId !== '' ? office.ownerUserId : null;
    const hasList = Array.isArray(office.owners);
    if (hasList && (owner === null || office.owners!.some((o) => o.userId === owner))) {
      if ('ownerUserId' in office) await kpms.updateOne({ _id: office._id }, { $unset: { ownerUserId: '' } });
      result.current += 1;
      continue;
    }
    if (owner === null) {
      await kpms.updateOne({ _id: office._id }, { $set: { owners: [] }, $unset: { ownerUserId: '' } });
      result.empty += 1;
      continue;
    }
    const membership = await db.collection('memberships').findOne(
      { kpmId: String(office._id), userId: owner },
      { projection: { joinedAt: 1, createdAt: 1 }, sort: { deletedAt: 1, createdAt: 1 } },
    ) as { joinedAt?: Date | null; createdAt?: Date | null } | null;
    const since = membership?.joinedAt ?? membership?.createdAt ?? office.createdAt ?? now;
    const owners = [...(office.owners ?? []), { userId: owner, since, addedByUserId: null }];
    await kpms.updateOne({ _id: office._id }, { $set: { owners }, $unset: { ownerUserId: '' } });
    result.moved += 1;
  }

  const indexes = await emptyIfMissing(kpms.indexes());
  if (indexes.some((i) => i.name === OLD_INDEX)) await kpms.dropIndex(OLD_INDEX);
  return result;
}

/**
 * **Back to one owner** (call it by hand): each KPM's `ownerUserId` is its first owner — the earliest `since` — or `null`,
 * and `owners` is removed; the old index is built again. **Lossy by design**: a KPM's second and later owners are not kept,
 * since the one-owner model has nowhere to put them (ADR-0285, *Reversal cost*).
 */
export async function down(db: mongoose.mongo.Db): Promise<{ kpms: number }> {
  const existing = await db.listCollections({ name: 'kpms' }, { nameOnly: true }).toArray();
  if (existing.length === 0) return { kpms: 0 };
  const kpms = db.collection('kpms');
  let count = 0;
  for (const office of await kpms.find({ owners: { $exists: true } }, { projection: { owners: 1 } }).toArray() as Office[]) {
    const first = [...(office.owners ?? [])]
      .sort((a, b) => new Date(a.since).getTime() - new Date(b.since).getTime())[0];
    await kpms.updateOne({ _id: office._id }, { $set: { ownerUserId: first?.userId ?? null }, $unset: { owners: '' } });
    count += 1;
  }
  const indexes = await emptyIfMissing(kpms.indexes());
  if (indexes.some((i) => i.name === 'owners_userId')) await kpms.dropIndex('owners_userId');
  if (!indexes.some((i) => i.name === OLD_INDEX)) await kpms.createIndex({ ownerUserId: 1 }, { name: OLD_INDEX });
  return { kpms: count };
}
