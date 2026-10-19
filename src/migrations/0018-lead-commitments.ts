import mongoose from 'mongoose';
import { localDayOf } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';

/**
 * Turn `leads.thisMonth` into `leads.commitments[]` (P7-T5).
 *
 * The boolean said *this lead is promised for the current month* and named no month, so something
 * had to clear it every month or it would quietly go on meaning *this* month forever. Holding the
 * month makes the flag derived — *is there an entry for the office's current month?* — and there is
 * then nothing to run, nothing to miss, and nothing to be wrong on the first of the month.
 *
 * **Which month did the promise belong to?** The row does not say — that is the defect. `updatedAt`
 * is the last moment anybody touched the lead, so it is the latest month the promise can have been
 * made in and the closest thing to an answer the data holds. A lead promised in March and untouched
 * since reads as March; one promised in March and edited in May reads as May, which is wrong and
 * unknowable, and wrong in the direction of *still promised* rather than *silently forgotten*.
 *
 * **The office's zone, not the server's** (invariant §9). Every office runs on Asia/Jakarta in v1
 * (ADR-0016) and the zone is read from the row all the same: a lead updated at 23:30 Jakarta on the
 * 31st belongs to that month, and UTC would file it in the next one.
 *
 * Idempotent twice over: only leads that still carry the field are touched, and the `$unset` that
 * follows means a second run matches nothing.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ migrated: number; promised: number }> {
  const leads = db.collection('leads');
  const zones = new Map<string, string>(
    (await db.collection('kpms').find({}, { projection: { timezone: 1 } }).toArray())
      .map((k) => [String(k._id), (k.timezone as string) ?? DEFAULT_TENANT_TIMEZONE]),
  );

  const rows = await leads.find(
    { thisMonth: { $exists: true } },
    { projection: { thisMonth: 1, kpmId: 1, updatedAt: 1, ownerMembershipId: 1 } },
  ).toArray();

  let promised = 0;
  for (const row of rows) {
    const at = (row.updatedAt as Date) ?? new Date(0);
    const month = row.thisMonth === true
      ? localDayOf(at, zones.get(String(row.kpmId)) ?? DEFAULT_TENANT_TIMEZONE).slice(0, 7)
      : null;
    if (month) promised += 1;
    await leads.updateOne({ _id: row._id }, {
      $set: {
        commitments: month
          ? [{ month, at, byMembershipId: String(row.ownerMembershipId) }]
          : [],
      },
      $unset: { thisMonth: '' },
    });
  }

  return { migrated: rows.length, promised };
}
