import mongoose from 'mongoose';

export interface LeadPositionResult {
  /** Leads given a place. */
  placed: number;
  /** Whose lists they were in. */
  owners: number;
}

/**
 * Give every lead a place in its owner's list (P18.8-T7, ADR-0161 §1).
 *
 * `GET /leads` without `sort` reads `leads.position` from the deploy that brings this. Before it, the
 * same screen opened on the newest registration first, so **that is the order filled in**: each owner's
 * leads by `dateRegistered`, newest first, place 0 at the top, the id breaking a tie as the list's own sort
 * does. Nobody's list moves on the day the field arrives; it moves when its owner drags it.
 *
 * **Per owner, and per office.** A place means something only beside the other leads of the same list.
 * Every lead is placed, a closed or soft-deleted one included: a closed lead reopened goes back among the
 * open ones by the place it had, and a field that is sometimes missing is a sort that is sometimes wrong.
 * A lead with no registration date sorts last, as `null` does in a descending sort.
 *
 * **Idempotent.** Only a lead with no place is touched, and the filter is repeated in the write. An owner
 * who already has placed leads — a lead added by the new code before this ran — keeps them, and the
 * older leads go below them, which is where leads registered earlier belong. A second run finds nothing.
 * On an empty database it reads nothing and writes nothing.
 */
export async function up(db: mongoose.mongo.Db): Promise<LeadPositionResult> {
  const leads = db.collection('leads');
  const unplaced = await leads
    .find({ position: null }, { projection: { kpmId: 1, ownerMembershipId: 1 } })
    .sort({ kpmId: 1, ownerMembershipId: 1, dateRegistered: -1, _id: -1 })
    .toArray();
  if (unplaced.length === 0) return { placed: 0, owners: 0 };

  const listOf = (row: Record<string, unknown>) => `${String(row.kpmId)}\n${String(row.ownerMembershipId)}`;

  // Where each list's placed leads end, so the unplaced ones go below them.
  const below = new Map<string, number>();
  const placedAlready = await leads.aggregate<{ _id: { kpmId: unknown; ownerMembershipId: unknown }; last: number }>([
    {
      $match: {
        position: { $ne: null },
        ownerMembershipId: { $in: [...new Set(unplaced.map((row) => row.ownerMembershipId))] },
      },
    },
    { $group: { _id: { kpmId: '$kpmId', ownerMembershipId: '$ownerMembershipId' }, last: { $max: '$position' } } },
  ]).toArray();
  for (const list of placedAlready) below.set(listOf(list._id), list.last + 1);

  const next = new Map<string, number>();
  const writes = unplaced.map((row) => {
    const list = listOf(row);
    const place = next.get(list) ?? below.get(list) ?? 0;
    next.set(list, place + 1);
    return { updateOne: { filter: { _id: row._id, position: null }, update: { $set: { position: place } } } };
  });
  await leads.bulkWrite(writes, { ordered: false });

  return { placed: writes.length, owners: next.size };
}
