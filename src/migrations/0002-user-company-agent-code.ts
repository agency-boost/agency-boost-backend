import mongoose from 'mongoose';

/**
 * Move the agent code onto the account (ADR-0017, P3.6-T3).
 *
 * The code used to be minted per office — `KPM0417-001`, from `kpms.counters` — and it
 * now belongs to the person, issued by the insurer they sell for. Rows written before
 * that have a code on the membership and nothing on the account.
 *
 * **Nothing is invented.** Each user takes the company of the office they belong to and
 * the code that office already gave them, so every historical attribution stays where it
 * was and `memberships.agentCode` never changes. Old codes are legitimate company codes
 * from here on: they are unique inside their office, and in v1 there is one company per
 * office set — see the collision guard below for the case where that stops being true.
 *
 * A Super Admin sells for nobody and is left alone, which is the `(null, null)` pair the
 * unique index deliberately excludes.
 *
 * Idempotent: it touches only accounts with no code yet, and skips a user whose oldest
 * membership it cannot resolve.
 */
export async function up(
  db: mongoose.mongo.Db,
  now: Date,
): Promise<{ users: number; skipped: number; collisions: string[]; droppedIndex: boolean }> {
  /*
   * **Drop the old unique index, because Mongoose will not.**
   *
   * `memberships { kpmId, agentCode }` was `unique` and is not any more: the code belongs
   * to the person, so somebody who rejoins an office brings it back while their removed
   * row is still there. Changing the schema does not change an index the server has
   * already built — `syncIndexes` matches by name, and the name is unchanged. Without
   * this, the first re-join in a deployed database is an `E11000`.
   *
   * The test suite could not have caught it: `mongodb-memory-server` starts empty and
   * builds indexes from the current schema every run. Seeding a real database found it
   * in seconds.
   */
  let droppedIndex = false;
  const indexes = await db.collection('memberships').indexes();
  if (indexes.some((i) => i.name === 'kpmId_1_agentCode_1' && i.unique)) {
    await db.collection('memberships').dropIndex('kpmId_1_agentCode_1');
    await db.collection('memberships').createIndex({ kpmId: 1, agentCode: 1 });
    droppedIndex = true;
  }

  const kpms = await db.collection('kpms').find({}, { projection: { companyId: 1 } }).toArray();
  const companyOf = new Map(kpms.map((k) => [String(k._id), String(k.companyId)]));

  const users = await db
    .collection('users')
    .find({ deletedAt: null, platformRole: { $ne: 'super_admin' } })
    .toArray();

  // Every `(companyId, agentCode)` already claimed, so a second claim is reported rather
  // than left for the unique index to reject at some later write.
  const claimed = new Set<string>();
  const collisions: string[] = [];
  let migrated = 0;
  let skipped = 0;

  for (const user of users) {
    if (typeof user.agentCode === 'string' && user.agentCode) continue;

    // The oldest membership: a person who left and rejoined has more than one, and the
    // code they were first given is the one their earliest production rows carry.
    const membership = await db
      .collection('memberships')
      .find({ userId: String(user._id) })
      .sort({ createdAt: 1 })
      .limit(1)
      .toArray();
    const first = membership[0];
    if (!first?.agentCode || !companyOf.has(String(first.kpmId))) {
      // A registered person who never joined an office has no code to inherit. They keep
      // `null` and will be asked for one the next time the product needs it, rather than
      // being handed a made-up value here.
      skipped += 1;
      continue;
    }

    const companyId = companyOf.get(String(first.kpmId)) as string;
    const agentCode = String(first.agentCode).toUpperCase();
    const key = `${companyId}::${agentCode}`;
    if (claimed.has(key)) {
      collisions.push(`${user.email as string} → ${agentCode}`);
      skipped += 1;
      continue;
    }
    claimed.add(key);

    await db
      .collection('users')
      .updateOne({ _id: user._id }, { $set: { companyId, agentCode, updatedAt: now } });
    migrated += 1;
  }

  return { users: migrated, skipped, collisions, droppedIndex };
}
