import mongoose from 'mongoose';
import { LEADER_CLASSES } from '@/domain/constants';

/** Who the audit rows name: a job, as `RequestContext.forJob` names one. */
export const GROUP_LEADER_ACTOR = 'job:migration-0061-group-leader-is-a-member';

export interface GroupLeaderIsAMemberResult {
  /** Groups whose owner — an active leader — was tagged into the group, so they read as its ★. */
  tagged: number;
  /** Groups whose owner was cleared: gone, not active, no leader, or the ★ of another group they read in first. */
  cleared: number;
  /** Groups whose owner was already a member: nothing to do. */
  current: number;
}

const asId = (id: string): mongoose.Types.ObjectId | string =>
  (mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : id);

/**
 * **A group's owner becomes its ★ group leader, who is a member of it** (P19.13-T3; ADR-0253 §2; UI-199, D2 — additive and
 * reversible). Until now a group's `ownerMembershipId` was required and need not belong to the group (P3-T9); it is now
 * the group's ★, nullable, and **a leader (AB or AAB) tagged into it**. For every live group (`status: 'active'`, not
 * deleted) with an owner:
 *
 * - **An active leader of the office is tagged into the group** (`$addToSet`), so they read as its ★ — the person the
 *   office named stays its head, and the Unit Dashboard's *Grup informal*, which reads the groups a head owns (ADR-0249),
 *   reads the same group as before. Their other tags stay: a leader in several groups reads as the one they lead
 *   (`placeLeaders`), and the office's next save makes it one.
 * - **Anybody else is cleared** — `ownerMembershipId: null`, *Belum ada group leader* — an owner who left, is pending, is
 *   on an Agent's rung, or was erased: a ★ is a leader of the office, and a star on somebody the page does not list
 *   would be a star on nobody.
 * - **A leader who owns several groups keeps the first by name** (then id), and the others are cleared: a leader has one
 *   group, so they can lead only one.
 *
 * **Reversible**: every write has its audit row — `member.tagged` with the tags before and after, `group.updated` with
 * the owner before — named to this job, so each can be put back from the log. **Idempotent**: a second run finds every
 * owner a member or none, and writes nothing. On an empty database there is nothing to read.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<GroupLeaderIsAMemberResult> {
  const groups = db.collection('groups');
  const memberships = db.collection('memberships');
  const audit = db.collection('auditLog');
  const result: GroupLeaderIsAMemberResult = { tagged: 0, cleared: 0, current: 0 };

  const owned = await groups
    .find({ status: 'active', deletedAt: null, ownerMembershipId: { $nin: [null, ''] } })
    .sort({ kpmId: 1, name: 1, _id: 1 })
    .toArray();

  const row = (kpmId: unknown, action: string, collection: string, targetId: string, before: unknown, after: unknown, member: string | null) => ({
    kpmId: kpmId ?? null, actorUserId: GROUP_LEADER_ACTOR, effectiveUserId: GROUP_LEADER_ACTOR, actorMembershipId: null,
    action, targetCollection: collection, targetId, targetMembershipId: member, before, after, onBehalfOf: false, ip: null,
    userAgent: null, createdAt: now, updatedAt: now,
  });
  const clear = async (group: (typeof owned)[number]) => {
    await groups.updateOne({ _id: group._id }, { $set: { ownerMembershipId: null, updatedAt: now } });
    await audit.insertOne(row(
      group.kpmId, 'group.updated', 'groups', String(group._id),
      { name: group.name, ownerMembershipId: group.ownerMembershipId }, { name: group.name, ownerMembershipId: null }, null,
    ));
    result.cleared += 1;
  };

  const leading = new Set<string>();
  for (const group of owned) {
    const ownerId = String(group.ownerMembershipId);
    const owner = await memberships.findOne({ _id: asId(ownerId) as never, kpmId: group.kpmId, deletedAt: null });
    const isLeader = owner !== null && owner.status === 'active'
      && (LEADER_CLASSES as readonly string[]).includes(String(owner.role));
    if (!isLeader || leading.has(`${String(group.kpmId)}|${ownerId}`)) {
      await clear(group);
      continue;
    }
    leading.add(`${String(group.kpmId)}|${ownerId}`);
    const groupId = String(group._id);
    const before = ((owner.groupIds ?? []) as unknown[]).map(String);
    if (before.includes(groupId)) {
      result.current += 1;
      continue;
    }
    await memberships.updateOne({ _id: owner._id }, { $addToSet: { groupIds: groupId }, $set: { updatedAt: now } });
    const isCoreLeader = owner.isCoreLeader === true;
    await audit.insertOne(row(
      group.kpmId, 'member.tagged', 'memberships', ownerId,
      { groupIds: before, isCoreLeader }, { groupIds: [...before, groupId], isCoreLeader }, ownerId,
    ));
    result.tagged += 1;
  }
  return result;
}
