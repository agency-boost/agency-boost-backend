import mongoose from 'mongoose';
import { localDayOf } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';

export interface MembershipJoinDateResult {
  /** Memberships with an activation: `new_hire`, from that activation's start date. */
  newHires: number;
  /** Memberships with none: `existing_agent`, from `joinedAt` as an office date. */
  existingAgents: number;
  /** Memberships nobody has let in yet — pending, no `joinedAt` — left unset until they are. */
  waiting: number;
}

/**
 * **Every membership's join date, and who it makes them** (ADR-0169 §6, P18.8-T2 AC-2).
 *
 * From the deploy that brings it, every membership made active is written `joinDate` (an office date) and
 * `joinedAs` (`new_hire` or `existing_agent`, decided once). This gives the memberships made before it theirs:
 *
 * - **one with an activation record**, in any state, is a `new_hire`, and its join date is that activation's
 *   **start date** — the date a leader may already have corrected (ADR-0102), which is the join date from now on;
 * - **every other** is an `existing_agent`, and its join date is its `joinedAt` as an **office date** in its
 *   office's own timezone (invariant §9): a join at 23:30 UTC is the next day in Jakarta. A roster import's
 *   long-tenured agents are existing agents for exactly this reason — they have no activation;
 * - **one with neither** — pending, nobody has let them in — is left unset; the approval writes both.
 *
 * Office by office, each read and write carrying its `kpmId` (invariant §1), and the activation looked up by
 * `(kpmId, membershipId)`. Removed and soft-deleted memberships are classified too: their history stays, and a
 * report about the past reads them.
 *
 * **Idempotent and forward-only.** It reads only rows with no `joinedAs`, and writes it, so a second run finds
 * nothing it can change — the pending ones it skips stay skipped. On an empty database there are no offices and it
 * writes nothing, creating no collection.
 */
export async function up(db: mongoose.mongo.Db): Promise<MembershipJoinDateResult> {
  const kpms = db.collection('kpms');
  const memberships = db.collection('memberships');
  const progress = db.collection('activationProgress');
  const result: MembershipJoinDateResult = { newHires: 0, existingAgents: 0, waiting: 0 };

  // Soft-deleted offices too: a membership of one is still a record somebody may read about the past.
  const offices = await kpms.find({}, { projection: { timezone: 1 } }).toArray();
  for (const office of offices) {
    const kpmId = String(office._id);
    const timezone = (office.timezone as string | undefined) ?? DEFAULT_TENANT_TIMEZONE;
    const rows = await memberships
      .find({ kpmId, $or: [{ joinedAs: { $exists: false } }, { joinedAs: null }] }, { projection: { joinedAt: 1 } })
      .toArray();

    for (const row of rows) {
      const membershipId = String(row._id);
      // The newest, though nothing makes two: one live activation per membership (ADR-0103).
      const [activation] = await progress
        .find({ kpmId, membershipId }, { projection: { startDate: 1 } })
        .sort({ createdAt: -1 })
        .limit(1)
        .toArray();

      if (activation?.startDate) {
        await memberships.updateOne(
          { _id: row._id, kpmId },
          { $set: { joinedAs: 'new_hire', joinDate: activation.startDate as string } },
        );
        result.newHires += 1;
      } else if (row.joinedAt) {
        await memberships.updateOne(
          { _id: row._id, kpmId },
          { $set: { joinedAs: 'existing_agent', joinDate: localDayOf(row.joinedAt as Date, timezone) } },
        );
        result.existingAgents += 1;
      } else {
        result.waiting += 1;
      }
    }
  }
  return result;
}
