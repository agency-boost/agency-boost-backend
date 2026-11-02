import mongoose from 'mongoose';
import { localDayOf } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { activation3MLastDay } from '@/domain/metrics/activation-3m';

export interface LeavingDecidesNo3MResult {
  /** New hires whose 3M result a leaving had kept, given back to their sale and their join date. */
  cleared: number;
  /** Left new hires whose kept result was kept after day 90, as any result is: left as they are. */
  kept: number;
}

/**
 * **A leaving decides no 3M result** (UI V1, 2026-10-30; the owner's D-24, UI-023, UI-025; `metrics-and-definitions.md`,
 * *3M activation*). Until now *Mark left* decided a new hire's 3M activation on the day they left, inside their 90
 * days, and kept it on the membership (`activation3M`, `activation3MLockedAt`). Since UI V1 there is no *Keluar*: a hire
 * marked left reads from their first sale and their join date like anybody else, and a result is kept only once day 90
 * of the join date is over. So a result a leaving kept — **one kept on or before the hire's day 90**, which nothing but a
 * leaving ever kept — is cleared, and the next read computes it again from the sale and the join date (and keeps it
 * from day 91, as every read does). `leftAt` itself is kept: it is data, not a status.
 *
 * A result kept after day 90 stays, left or not: it is what the records gave at the end of day 90, as for anybody.
 * Office by office, in each office's own timezone (invariant §9), every write carrying its `kpmId` (§1).
 *
 * **Idempotent and forward-only.** The write is conditional on the lock still being the one read; a second run finds
 * none kept before day 91 and writes nothing. On an empty database there are no offices and it writes nothing.
 */
export async function up(db: mongoose.mongo.Db): Promise<LeavingDecidesNo3MResult> {
  const result: LeavingDecidesNo3MResult = { cleared: 0, kept: 0 };
  const offices = await db.collection('kpms').find({}, { projection: { timezone: 1 } }).toArray();

  for (const office of offices) {
    const kpmId = String(office._id);
    const timezone = (office.timezone as string | undefined) ?? DEFAULT_TENANT_TIMEZONE;
    const members = await db.collection('memberships').find(
      { kpmId, joinedAs: 'new_hire', leftAt: { $ne: null }, activation3M: { $ne: null }, deletedAt: null },
      { projection: { joinDate: 1, activation3M: 1, activation3MLockedAt: 1 } },
    ).toArray();
    for (const member of members) {
      const joinDate = member.joinDate as string | null | undefined;
      const lockedAt = member.activation3MLockedAt as Date | null | undefined;
      if (!joinDate || !lockedAt || localDayOf(lockedAt, timezone) > activation3MLastDay(joinDate)) {
        result.kept += 1;
        continue;
      }
      const written = await db.collection('memberships').updateOne(
        { _id: member._id, kpmId, activation3M: member.activation3M, activation3MLockedAt: lockedAt },
        { $set: { activation3M: null, activation3MLockedAt: null } },
      );
      result.cleared += written.modifiedCount;
    }
  }
  return result;
}
