import mongoose from 'mongoose';
import { ACTIVITY } from '@/domain/constants';

/**
 * Give every existing office the activity correction window (P6-T1, ADR-0042).
 *
 * `settings` is seeded from `DEFAULT_KPM_SETTINGS` at provisioning, so offices created before
 * this setting existed carry every other knob and not this one. Reading it with a `??` fallback
 * would work and is deliberately not what happens: a setting the office cannot see on its own
 * Branch info screen is one nobody can change, and "the default is applied invisibly" is how a
 * knob becomes a constant again.
 *
 * Idempotent: only offices actually missing the field are touched, so a re-run writes nothing.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ updated: number }> {
  const { modifiedCount } = await db.collection('kpms').updateMany(
    { 'settings.activityBackdateGraceDays': { $exists: false } },
    { $set: { 'settings.activityBackdateGraceDays': ACTIVITY.BACKDATE_GRACE_DAYS } },
  );
  return { updated: modifiedCount };
}
