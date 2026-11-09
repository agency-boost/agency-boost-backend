import mongoose from 'mongoose';
import { SEED_ACTIVITY_TYPES } from '@/domain/constants/activity-taxonomy';

/** A row with no *Nama singkat* yet: the key missing, `null`, or blank. */
const NONE = { $in: [null, ''] };

/**
 * **Every existing office's activity types get their *Nama singkat*, by code** (P19.8-T4; ADR-0229 §5, MOB UI-180).
 *
 * A new office is given the twelve short names by the seed (`SEED_ACTIVITY_TYPES`); this gives an office that already
 * exists the same — **only where a type of one of those codes holds none**. An office that wrote its own keeps it, and a
 * type of the office's own code is left alone (the seed has no words for it).
 *
 * - **The working copy** (`activityTypes`), every row of the code — archived ones too, so a restored type comes back
 *   named — but never a deleted one;
 * - **each office's newest published snapshot** (`configSnapshots`, `payload.activity[].types[]`), which agents read, so
 *   the field is the same in both and no publish bar speaks for it.
 *
 * **Templates are not written**: a template type without the key gives an office the platform's words by code when it is
 * provisioned or pushed (`shortLabelOf`, `template-defaults.ts`), so a published version never changes.
 *
 * **Codes, never positions** (invariant §4). **No version moves**: words, not anything an agent counted, as `0032`.
 * **Idempotent**: only a row holding none is written, and a second run finds none.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ types: number; snapshots: number }> {
  let types = 0;
  for (const seed of SEED_ACTIVITY_TYPES) {
    if (!seed.shortLabel) continue;
    const written = await db.collection('activityTypes').updateMany(
      { code: seed.code, deletedAt: null, shortLabel: NONE },
      { $set: { shortLabel: seed.shortLabel } },
    );
    types += written.modifiedCount;
  }

  const snapshots = db.collection('configSnapshots');
  let snapshotsWritten = 0;
  for (const kpmId of await snapshots.distinct('kpmId', { deletedAt: null })) {
    const [newest] = await snapshots.find({ kpmId, deletedAt: null }).sort({ version: -1 }).limit(1).toArray();
    if (!newest) continue;
    let touched = false;
    for (const seed of SEED_ACTIVITY_TYPES) {
      if (!seed.shortLabel) continue;
      const element = { code: seed.code, shortLabel: NONE };
      const written = await snapshots.updateOne(
        // Guarded on the element, so a snapshot without `payload.activity` is never given an array path.
        { _id: newest._id, 'payload.activity.types': { $elemMatch: element } },
        { $set: { 'payload.activity.$[].types.$[t].shortLabel': seed.shortLabel } },
        { arrayFilters: [{ 't.code': seed.code, 't.shortLabel': NONE }] },
      );
      if (written.modifiedCount > 0) touched = true;
    }
    if (touched) snapshotsWritten += 1;
  }

  return { types, snapshots: snapshotsWritten };
}
