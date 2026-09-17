import mongoose from 'mongoose';
import { defaultDisplayUnitFor } from '@/domain/constants';

/**
 * Backfill `displayUnit` on every ratio (P4-T25).
 *
 * The schema default is `decimal`, and for two of the five seeded ratios that default is
 * wrong in exactly the way this task exists to fix: the success rates would go on reading
 * `0.15` where the registry says `15.0%`. So the unit comes from `defaultDisplayUnitFor` —
 * the platform's unit for a seeded code, when it still fits the row's rule, and the rule's
 * default otherwise.
 *
 * The row's rule outranks its seed. An office that turned `LEADS_PER_ACTIVITY` into a band
 * gets `points`, because a band is judged in points whatever it was seeded as.
 *
 * **Not the company templates.** A published template version is immutable — an office
 * records the version it was seeded from — and provisioning already resolves a unit for a
 * ratio that has none. Rewriting them would make that record a lie to fix nothing.
 *
 * Idempotent: only rows without the key are touched.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ filled: number }> {
  const ratios = db.collection('ratioDefinitions');
  const rows = await ratios
    .find({ displayUnit: { $exists: false } }, { projection: { code: 1, comparison: 1 } })
    .toArray();

  let filled = 0;
  for (const row of rows) {
    const comparison = row.comparison === 'band' ? 'band' : 'gte';
    await ratios.updateOne(
      { _id: row._id, displayUnit: { $exists: false } },
      { $set: { displayUnit: defaultDisplayUnitFor(String(row.code), comparison) } },
    );
    filled += 1;
  }
  return { filled };
}
