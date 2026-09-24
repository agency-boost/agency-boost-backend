import mongoose from 'mongoose';
import { SEED_LEAD_STATUSES } from '@/domain/constants';

/**
 * Give every existing office the *expected to close* flag (ADR-0043, OD-12).
 *
 * `isLateStage` is required on the schema, so rows written before it existed have no value at
 * all — and a missing boolean is not `false`, it is a field the Owner's settings screen cannot
 * render a checkbox for.
 *
 * **Seeded codes get the platform's answer; an office's own stages get `false`.** That asymmetry
 * is the point. We know what `POLICY_SUBMITTED` means because we shipped it; we know nothing
 * about a stage an office invented, and guessing from its rank would be exactly the
 * position-derived semantics ADR-0043 refused. An office that wants its own stage counted ticks
 * one box, and until then *Expected to close* undercounts rather than inventing a number.
 *
 * Idempotent: only rows actually missing the field are touched.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ updated: number; flagged: number }> {
  const statuses = db.collection('leadStatuses');
  const lateCodes = SEED_LEAD_STATUSES.filter((s) => s.isLateStage).map((s) => s.code);

  const { modifiedCount: flagged } = await statuses.updateMany(
    { isLateStage: { $exists: false }, code: { $in: lateCodes }, isTerminal: { $ne: true } },
    { $set: { isLateStage: true } },
  );
  const { modifiedCount: rest } = await statuses.updateMany(
    { isLateStage: { $exists: false } },
    { $set: { isLateStage: false } },
  );

  return { updated: flagged + rest, flagged };
}
