import mongoose from 'mongoose';
import { isTestAccountName } from '@/domain/constants/test-accounts';

export interface TestAccountsResult {
  /** Accounts written before the flag whose full name begins *FMT* or *TES IMPOR*: flagged `true`. */
  flagged: number;
  /** Accounts written before the flag with any other name: given `false`, a real person. */
  cleared: number;
  /** Memberships of a flagged account given its flag (`memberships.testAccount`). */
  memberships: number;
}

/**
 * **Test accounts are known by a stored flag** (P19.17-T1 AC-1; ADR-0267 §1; `revisions/2026-11-19/DATA-DEFINITIONS.md`,
 * *Who is counted*; OD-370 by its default).
 *
 * 1. **Every account written before `users.testAccount` is decided once**, by its name (`isTestAccountName`): a full
 *    name beginning ***FMT*** or ***TES IMPOR*** — trimmed, any case, whole words — is a test account, every other one is
 *    not. **Only an account with no value is read**: an account the API wrote since holds `false` by default, and one
 *    somebody flagged or cleared by hand keeps it, so the next deploy — there is no ledger, every migration runs every
 *    time — never undoes a decision a person made. The `.test` email is not a rule (every demo login has one) and nor is
 *    a one-word name (*Hilmy* may be real in production): those are flagged by hand.
 * 2. **Every membership of a flagged account carries the flag** (`memberships.testAccount`), which the reads of a KPM's
 *    members filter on — every office, removed and soft-deleted rows too, each write keeping its `kpmId` (invariant §1).
 *    Only `true` is copied: an account cleared by hand clears its memberships in the same write that clears it.
 *
 * `users` is global (ADR-0002). **Idempotent**: a second run finds no account without a value and no flagged account's
 * membership without the flag. On an empty database it reads nothing and creates no collection.
 */
export async function up(db: mongoose.mongo.Db): Promise<TestAccountsResult> {
  const users = db.collection('users');
  const memberships = db.collection('memberships');
  const result: TestAccountsResult = { flagged: 0, cleared: 0, memberships: 0 };

  const undecided = await users.find({ testAccount: { $exists: false } }, { projection: { fullName: 1 } }).toArray();
  const flag = undecided.filter((u) => isTestAccountName(u.fullName as string | undefined)).map((u) => u._id);
  const clear = undecided.filter((u) => !isTestAccountName(u.fullName as string | undefined)).map((u) => u._id);
  if (flag.length > 0) {
    result.flagged = (await users.updateMany(
      { _id: { $in: flag }, testAccount: { $exists: false } }, { $set: { testAccount: true } },
    )).modifiedCount;
  }
  if (clear.length > 0) {
    result.cleared = (await users.updateMany(
      { _id: { $in: clear }, testAccount: { $exists: false } }, { $set: { testAccount: false } },
    )).modifiedCount;
  }

  // Every flagged account's memberships, by its id as the membership stores it (a string, ADR-0002).
  const flagged = await users.find({ testAccount: true }, { projection: { _id: 1 } }).toArray();
  if (flagged.length > 0) {
    const ids = flagged.map((u) => String(u._id));
    const rows = await memberships
      .find({ userId: { $in: ids }, testAccount: { $ne: true } }, { projection: { kpmId: 1 } })
      .toArray();
    for (const row of rows) {
      const written = await memberships.updateOne(
        { _id: row._id, kpmId: row.kpmId, testAccount: { $ne: true } }, { $set: { testAccount: true } },
      );
      result.memberships += written.modifiedCount;
    }
  }
  return result;
}
