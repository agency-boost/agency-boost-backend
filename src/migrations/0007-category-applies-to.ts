import mongoose from 'mongoose';

/**
 * Backfill `description` and `appliesToOrgLevelCodes` on every activity category (P4-T18).
 *
 * Both have schema defaults, and unlike migration `0005` the defaults here are **right**:
 * an empty applicability means every rung, which is what every existing category already
 * is, and a null description is what every existing category already has.
 *
 * So why run anything at all? Because a default only applies to documents Mongoose writes.
 * A row read straight from a collection written before the field existed has the key
 * absent, not empty — and `appliesToOrgLevelCodes.length` on `undefined` throws where
 * `[].length` does not. The cascade in `ActivityConfigService.list` reads that array for
 * every category on every settings load, so this turns a latent crash into a no-op.
 *
 * Idempotent: a row that already has both keys is skipped.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ filled: number }> {
  const categories = db.collection('activityCategories');
  const { modifiedCount } = await categories.updateMany(
    { appliesToOrgLevelCodes: { $exists: false } },
    { $set: { appliesToOrgLevelCodes: [] } },
  );
  await categories.updateMany(
    { description: { $exists: false } },
    { $set: { description: null } },
  );
  return { filled: modifiedCount };
}
