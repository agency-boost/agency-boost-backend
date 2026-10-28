import mongoose from 'mongoose';

/**
 * **The seed's new hires: whoever it gave an activation** (ADR-0169, P18.96-T2).
 *
 * `place()` writes every membership it makes active with a join date — the day it backdates the join to — and as an
 * **existing agent**. The fixtures that write an activation then call this for the memberships they wrote one for:
 * each becomes a **new hire**, joined on the activation's stored start date, which is the join date (ADR-0169 §2) —
 * Wahyu's, which Arief corrected a week back, included. That is the rule migration 0040 applies to a database written
 * before the fields, so a fresh seed and a migrated one say the same thing, and the migration run after the seed
 * finds nothing to do.
 *
 * The stored row is read rather than the fixture's own value, so a re-seed after a walk that corrected somebody's
 * date keeps the two agreeing. Office by office: each read and write carries the activation's `kpmId`.
 */
export async function markNewHires(membershipIds: readonly string[]): Promise<number> {
  if (membershipIds.length === 0) return 0;
  const db = mongoose.connection.db!;
  const activations = await db.collection('activationProgress')
    .find({ membershipId: { $in: [...membershipIds] }, deletedAt: null }, { projection: { kpmId: 1, membershipId: 1, startDate: 1 } })
    .toArray();
  let marked = 0;
  for (const row of activations) {
    const result = await db.collection('memberships').updateOne(
      { _id: new mongoose.Types.ObjectId(String(row.membershipId)), kpmId: row.kpmId },
      { $set: { joinedAs: 'new_hire', joinDate: row.startDate as string } },
    );
    marked += result.modifiedCount;
  }
  return marked;
}
