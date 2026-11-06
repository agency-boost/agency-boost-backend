import mongoose from 'mongoose';
import { emptyIfMissing } from './missing-collection';

/** What one run did. Printed by `run.ts`, so the deploy log is the record of it. */
export interface KpmSetupRunningOfficesResult {
  /** Offices found running — a member besides the Owner and a production upload — whose four pages were marked this run. */
  marked: number;
  /** Running offices whose four pages were all marked already: a second run, or written since. */
  current: number;
  /** Offices not running yet: left for their Owner's *Siapkan KPM*. */
  setup: number;
}

/** The setup card's four settings pages, written out so this says the same thing on every run (`REVIEWED_PAGES`). */
const PAGES = ['branch-info', 'activity-types', 'activation-checklist', 'products'] as const;

/**
 * **An office already running when the KPM setup card arrived has its four settings pages marked** (P19.3-T2; UI-149,
 * Overview R2, *Done when*: *"Staging KPM 0417 (members, upload, target present) shows no card"*).
 *
 * Steps 1 to 4 of *Siapkan KPM* tick when the Owner saves a settings page or taps *Sudah sesuai* on it, and the marks
 * that say so start with this phase: an office whose people have used its settings for months would otherwise be asked
 * to confirm them all again. So an office is **running** when it holds an active member besides its Owner **and** a
 * committed production upload, and each of its four pages gets a mark `via: 'migration'`. Steps 5 to 7 stay derived:
 * a running office with no recruitment target still sees step 7, as the card's rule says.
 *
 * - **An office not running yet is left alone** — KaiZen Family's case: its Owner sets it up.
 * - **A mark already there is kept** (`$setOnInsert`), whatever made it.
 * - **Touches no page's data**: the marks are beside the settings, never in them. A soft-deleted office is skipped.
 *
 * **Idempotent**: a running office with its four marks is `current`. Timestamps by hand: no Mongoose in between.
 * Prints `{ marked, current, setup }`.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<KpmSetupRunningOfficesResult> {
  const result: KpmSetupRunningOfficesResult = { marked: 0, current: 0, setup: 0 };
  const offices = await emptyIfMissing(db.collection('kpms')
    .find({ deletedAt: null }, { projection: { ownerUserId: 1 } })
    .sort({ _id: 1 })
    .toArray());
  const marks = db.collection('kpmSetupMarks');

  for (const office of offices) {
    const kpmId = String(office._id);
    const owner = (office as { ownerUserId?: string | null }).ownerUserId ?? null;
    const [member, upload] = await Promise.all([
      db.collection('memberships').findOne(
        { kpmId, status: 'active', deletedAt: null, ...(owner ? { userId: { $ne: owner } } : {}) },
        { projection: { _id: 1 } },
      ),
      db.collection('dataUploadBatches').findOne({ kpmId, status: 'committed', deletedAt: null }, { projection: { _id: 1 } }),
    ]);
    if (!member || !upload) {
      result.setup += 1;
      continue;
    }
    let wrote = false;
    for (const mark of PAGES) {
      const res = await marks.updateOne(
        { kpmId, mark, deletedAt: null },
        {
          $setOnInsert: {
            kpmId, mark, via: 'migration', at: now, by: null, deletedAt: null, createdBy: null, updatedBy: null,
            createdAt: now, updatedAt: now, version: 0,
          },
        },
        { upsert: true },
      );
      if (res.upsertedCount > 0) wrote = true;
    }
    if (wrote) result.marked += 1;
    else result.current += 1;
  }
  return result;
}
