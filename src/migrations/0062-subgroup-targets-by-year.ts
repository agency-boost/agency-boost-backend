import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { SUBGROUP_TARGET_INDEX } from '@/modules/reporting/advanced-analytics/analytics-target.schema';

/** The index Mongoose named for `{ kpmId: 1, kind: 1, headMembershipId: 1 }` before P19.13-T3: one row per head. */
const OLD = 'kpmId_1_kind_1_headMembershipId_1';

export interface SubgroupTargetsByYearResult {
  /** Sub-group target rows given the year they were written for. */
  dated: number;
  /** Whether the new index — one row per leader and year — was built by this run. */
  created: boolean;
  /** Whether the old one — one row per head — was there and was dropped. */
  dropped: boolean;
}

/**
 * **Sub-group targets are per leader per year** (P19.13-T3; ADR-0253 §4; UI-199, D2 — additive and reversible). Until now
 * `analyticsTargets` held one `subgroup` row per head of group and no year (P19.5-T3); a leader's *Target 2026* is now
 * one row per `(kpmId, headMembershipId, year)`.
 *
 * - **Every `subgroup` row with no year is given the current year on its office's clock** (`kpms.timezone`, else
 *   `Asia/Jakarta`): the targets an office typed are this year's, which is what the page meant by them.
 * - **`one_subgroup_target_per_leader_and_year` is built first, then `kpmId_1_kind_1_headMembershipId_1` dropped**, so
 *   there is never a moment without a uniqueness rule. The new one is the old one with `year` added, so no row breaks it.
 *
 * **Reversible**: only a field is added; dropping `year` and the new index and rebuilding the old one restores P19.5's
 * shape, and no row was deleted. **Idempotent**: a second run finds every row dated and the indexes in place, and does
 * nothing. On a database with no `analyticsTargets` it does nothing — the API builds the index with the collection.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<SubgroupTargetsByYearResult> {
  const exists = (await db.listCollections({ name: 'analyticsTargets' }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) return { dated: 0, created: false, dropped: false };
  const targets = db.collection('analyticsTargets');
  const kpms = db.collection('kpms');

  let dated = 0;
  for (const kpmId of await targets.distinct('kpmId', { kind: 'subgroup', year: null })) {
    const kpm = await kpms.findOne(
      { _id: (mongoose.isValidObjectId(kpmId) ? new mongoose.Types.ObjectId(String(kpmId)) : kpmId) as never },
      { projection: { timezone: 1 } },
    );
    const zone = (kpm?.timezone as string | undefined) ?? DEFAULT_TENANT_TIMEZONE;
    const year = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(zone).toFormat('yyyy');
    const written = await targets.updateMany({ kpmId, kind: 'subgroup', year: null }, { $set: { year } });
    dated += written.modifiedCount;
  }

  const names = (await targets.indexes()).map((index) => String(index.name));
  let created = false;
  if (!names.includes(SUBGROUP_TARGET_INDEX)) {
    await targets.createIndex(
      { kpmId: 1, kind: 1, headMembershipId: 1, year: 1 },
      { unique: true, name: SUBGROUP_TARGET_INDEX, partialFilterExpression: { deletedAt: null, kind: 'subgroup' } },
    );
    created = true;
  }
  let dropped = false;
  if (names.includes(OLD)) {
    await targets.dropIndex(OLD);
    dropped = true;
  }
  return { dated, created, dropped };
}
