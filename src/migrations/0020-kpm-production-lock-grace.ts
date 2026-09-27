import mongoose from 'mongoose';
import { PRODUCTION } from '@/domain/constants';

/**
 * Give every existing office the production lock window (P9-T4, ADR-0050).
 *
 * `settings` is seeded from `DEFAULT_KPM_SETTINGS` at provisioning, so offices created before this
 * setting existed carry every other knob and not this one — the same gap `0015` closed for the
 * activity window, closed the same way: the value written into the office's own row, rather than a
 * default applied invisibly on every read.
 *
 * Idempotent: only offices actually missing the field are touched, so a re-run writes nothing.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ updated: number }> {
  const { modifiedCount } = await db.collection('kpms').updateMany(
    { 'settings.productionLockGraceDays': { $exists: false } },
    { $set: { 'settings.productionLockGraceDays': PRODUCTION.LOCK_GRACE_DAYS } },
  );
  return { updated: modifiedCount };
}
