import mongoose from 'mongoose';

/**
 * Every company that already exists took the platform's defaults (client feedback, 2026-09-24).
 *
 * `usesPlatformDefaults` decides three things at once: whether the eight Company template kinds
 * hand back the platform's presets or `{}`, and whether a new company is seeded a product catalog
 * and the carrier's rules. Companies created before the field existed were all seeded, so `true`
 * is not a guess — it is what happened to them.
 *
 * **Written rather than left to the schema default.** Mongoose fills a missing path on hydration,
 * so reads would have looked right; the console reads this field to badge a company **Started
 * blank**, and a `lean()` query or a raw driver read anywhere would have badged every existing
 * company that way. A field the product branches on belongs in the document.
 *
 * Idempotent: only companies actually missing it are touched.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ updated: number }> {
  const { modifiedCount } = await db.collection('companies').updateMany(
    { usesPlatformDefaults: { $exists: false } },
    { $set: { usesPlatformDefaults: true } },
  );
  return { updated: modifiedCount };
}
