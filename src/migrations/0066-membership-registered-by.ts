import mongoose from 'mongoose';

export interface MembershipRegisteredByResult {
  /** Memberships an accepted *+ Tambah agent* invitation made: credited to the member who sent it. */
  fromInvite: number;
  /** Memberships placed under a leader any other way: credited to that leader (`recruitedByMembershipId`). */
  fromLeader: number;
  /** Memberships nobody placed — an Owner, a roster row, a pending person: given `null`. */
  none: number;
}

/**
 * **Who registered each person, for the memberships that came before the field** (P19.17-T1 AC-3; ADR-0267 §3;
 * `revisions/2026-11-19/DATA-DEFINITIONS.md`, *Recruitment / Rekrut*: *"credited to the person who registered them"*).
 *
 * `memberships.registeredByMembershipId` is written by every path that places somebody since this change. For every
 * membership **without the field** — written before it — the best record there is:
 *
 * 1. **an accepted invitation** that made it (`memberInvites.acceptedMembershipId`): **the member who sent it**
 *    (`invitedByMembershipId`) — the leader, or the Owner or an Admin who added somebody for one;
 * 2. **else the leader it was placed under** (`recruitedByMembershipId`): a leader's code or link, an approved request, a
 *    tag — the same leader the new paths credit;
 * 3. **else `null`**: an Owner, a roster import (an existing agent, never a recruit), a pending person — whose placement,
 *    when it comes, writes it.
 *
 * Every office's memberships, removed and soft-deleted ones too — a report about the past reads them — each write
 * carrying its `kpmId` (invariant §1). **Only a row without the field**, so a value written since is never replaced, and
 * the next deploy (no ledger: every migration runs every time) finds nothing to do. On an empty database it reads nothing
 * and creates no collection.
 */
export async function up(db: mongoose.mongo.Db): Promise<MembershipRegisteredByResult> {
  const memberships = db.collection('memberships');
  const result: MembershipRegisteredByResult = { fromInvite: 0, fromLeader: 0, none: 0 };

  const rows = await memberships
    .find({ registeredByMembershipId: { $exists: false } }, { projection: { kpmId: 1, recruitedByMembershipId: 1 } })
    .toArray();
  if (rows.length === 0) return result;

  // The invitations that made them: one read for every office's, by the membership they made.
  const invites = await db.collection('memberInvites')
    .find(
      { acceptedMembershipId: { $in: rows.map((r) => String(r._id)) }, invitedByMembershipId: { $type: 'string' } },
      { projection: { kpmId: 1, acceptedMembershipId: 1, invitedByMembershipId: 1 } },
    )
    .toArray();
  const inviter = new Map(invites.map((i) => [`${String(i.kpmId)}|${String(i.acceptedMembershipId)}`, String(i.invitedByMembershipId)]));

  for (const row of rows) {
    const sent = inviter.get(`${String(row.kpmId)}|${String(row._id)}`);
    const leader = typeof row.recruitedByMembershipId === 'string' && row.recruitedByMembershipId !== ''
      ? row.recruitedByMembershipId
      : null;
    const registeredBy = sent ?? leader;
    await memberships.updateOne(
      { _id: row._id, kpmId: row.kpmId, registeredByMembershipId: { $exists: false } },
      { $set: { registeredByMembershipId: registeredBy } },
    );
    if (sent) result.fromInvite += 1;
    else if (leader) result.fromLeader += 1;
    else result.none += 1;
  }
  return result;
}
