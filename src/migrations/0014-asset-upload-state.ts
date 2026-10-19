import mongoose from 'mongoose';

/**
 * `assets.scanStatus` becomes `assets.uploadState` (ADR-0040).
 *
 * v1 does not scan uploads for malware, and the field stops saying it does. What replaces it says
 * only what is actually known: whether storage has been asked and the object is there.
 *
 * | Was | Becomes | Why |
 * |---|---|---|
 * | `pending` | `pending` | Nothing was ever known about it, and still is not |
 * | `clean` | `pending` | **Nothing ever wrote this value**, so no row can hold it — and if one
 *   somehow did, it was not written by a check that ran. Confirming it against storage is cheap
 *   and honest; inheriting a claim nobody made is neither |
 * | `infected` | `pending` | The state is gone with the scanner that never existed |
 *
 * Every row therefore lands on `pending` and becomes deliverable again the first time its owner
 * confirms it. Nothing was deliverable before this migration either — that is the defect ADR-0040
 * closes — so no office loses access to a file it had.
 */
export async function up(
  db: mongoose.mongo.Db,
): Promise<{ migrated: number; alreadyMigrated: number }> {
  const assets = db.collection('assets');

  const alreadyMigrated = await assets.countDocuments({ uploadState: { $exists: true } });
  const { modifiedCount } = await assets.updateMany(
    { uploadState: { $exists: false } },
    { $set: { uploadState: 'pending' }, $unset: { scanStatus: '' } },
  );

  return { migrated: modifiedCount, alreadyMigrated };
}
