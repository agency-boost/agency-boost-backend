import mongoose from 'mongoose';

/** Who the audit rows name: a job, as `RequestContext.forJob` names one. */
export const INFORMAL_GROUPS_ACTOR = 'job:migration-0068-informal-groups-on-abs';

export interface InformalGroupsOnAbsResult {
  /** Groups whose ★ — an active AB who reads in the group — became their one Group Leader. */
  leadersCarried: number;
  /** Groups whose ★ was dropped: an AAB, an agent, somebody not active, or an AB who reads in another group. */
  leadersDropped: number;
  /** Groups given an empty list of Group Leaders, having had no ★. */
  noLeader: number;
  /** ABs tagged into several groups, or archived ones, left with one live group or none. */
  absNarrowed: number;
  /** AABs and agents whose tags were removed: they follow their AB. */
  othersUntagged: number;
}

const asId = (id: string): mongoose.Types.ObjectId | string =>
  (mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : id);

type Row = Record<string, unknown> & { _id: unknown };

/**
 * **Informal groups belong to ABs** (P19.17-T4;
 * [ADR-0270](../../../docs/04-adr/0270-informal-groups-belong-to-abs-and-targets-are-set-per-ab-group-per-month.md) §1,
 * §2, §7 — reversible). Until now a group had one ★ (`ownerMembershipId`, an AB or an AAB, ADR-0253 §2) and anybody could
 * carry tags (`memberships.groupIds`: a leader one, an agent several). Now **only an AB carries a group, one or none**;
 * their AABs and agents follow them; and a group has **any number of Group Leaders, ABs in it**
 * (`groups.leaderMembershipIds`).
 *
 * - **Every membership of every office** carrying tags: **an AB keeps one live group** — the one they were ★ of, else
 *   the first of their live groups by name, then id (the rule `placeLeaders` read them by) — and drops the rest, archived
 *   ones too; **an AAB or an agent keeps none**. What was removed is kept on the row as `migrated0068.groupIds`.
 * - **Every group** (any status) without `leaderMembershipIds`: **its ★, if an active AB who now reads in it, becomes its
 *   one Group Leader**; anybody else is dropped — an AAB, an agent, a leaver, an AB whose one group is another.
 *   `ownerMembershipId` is removed and kept as `migrated0068.ownerMembershipId`.
 * - **Logged**: one `member.tagged` audit row per membership changed and one `group.updated` per group, before and after,
 *   named to this job — what was dropped is in the KPM's own log — and the counts are printed by the run.
 *
 * Each write carries its `kpmId` (invariant §1). **Idempotent**: a second run finds every AB with one live group or none,
 * nobody else tagged, and every group with its list, and writes nothing. On an empty database it reads nothing and
 * creates no collection. `down` puts every kept value back.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<InformalGroupsOnAbsResult> {
  const groups = db.collection('groups');
  const memberships = db.collection('memberships');
  const audit = db.collection('auditLog');
  const result: InformalGroupsOnAbsResult = { leadersCarried: 0, leadersDropped: 0, noLeader: 0, absNarrowed: 0, othersUntagged: 0 };

  const entry = (kpmId: unknown, action: string, collection: string, targetId: string, before: unknown, after: unknown, member: string | null) => ({
    kpmId: kpmId ?? null, actorUserId: INFORMAL_GROUPS_ACTOR, effectiveUserId: INFORMAL_GROUPS_ACTOR, actorMembershipId: null,
    action, targetCollection: collection, targetId, targetMembershipId: member, before, after, onBehalfOf: false, ip: null,
    userAgent: null, createdAt: now, updatedAt: now,
  });

  // The groups as they stand: which are live, their names, and whose ★ each still names.
  const allGroups = await groups.find({}, { projection: { kpmId: 1, name: 1, status: 1, deletedAt: 1, ownerMembershipId: 1 } }).toArray() as Row[];
  const live = new Map(allGroups
    .filter((g) => g.status === 'active' && (g.deletedAt ?? null) === null)
    .map((g) => [String(g._id), { name: String(g.name ?? ''), kpmId: String(g.kpmId), owner: g.ownerMembershipId ? String(g.ownerMembershipId) : null }]));

  // 1. The tags: an AB keeps one live group, everybody else none.
  const tagged = await memberships.find({ 'groupIds.0': { $exists: true } }, { projection: { kpmId: 1, role: 1, groupIds: 1, isCoreLeader: 1 } }).toArray() as Row[];
  for (const m of tagged) {
    const id = String(m._id);
    const before = ((m.groupIds ?? []) as unknown[]).map(String);
    let after: string[] = [];
    if (m.role === 'ab') {
      const mine = before
        .filter((g) => live.get(g)?.kpmId === String(m.kpmId))
        .map((g) => ({ groupId: g, ...live.get(g)! }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.groupId.localeCompare(b.groupId));
      const kept = mine.find((g) => g.owner === id) ?? mine[0];
      after = kept ? [kept.groupId] : [];
    }
    if (after.length === before.length && after.every((g, i) => g === before[i])) continue;
    await memberships.updateOne(
      { _id: m._id as never, kpmId: m.kpmId },
      { $set: { groupIds: after, migrated0068: { groupIds: before }, updatedAt: now } },
    );
    const isCoreLeader = m.isCoreLeader === true;
    await audit.insertOne(entry(m.kpmId, 'member.tagged', 'memberships', id, { groupIds: before, isCoreLeader }, { groupIds: after, isCoreLeader }, id));
    if (m.role === 'ab') result.absNarrowed += 1;
    else result.othersUntagged += 1;
  }

  // 2. The ★: a Group Leader if an active AB who now reads in the group, else dropped.
  const listless = await groups.find({ leaderMembershipIds: { $exists: false } }, { projection: { kpmId: 1, name: 1, ownerMembershipId: 1 } }).toArray() as Row[];
  for (const g of listless) {
    const groupId = String(g._id);
    const owner = g.ownerMembershipId ? String(g.ownerMembershipId) : null;
    let leaders: string[] = [];
    if (owner !== null) {
      const ab = await memberships.findOne(
        { _id: asId(owner) as never, kpmId: g.kpmId, deletedAt: null }, { projection: { role: 1, status: 1, groupIds: 1 } },
      );
      const holds = ab !== null && ab.role === 'ab' && ab.status === 'active' && ((ab.groupIds ?? []) as unknown[]).map(String).includes(groupId);
      if (holds) {
        leaders = [owner];
        result.leadersCarried += 1;
      } else {
        result.leadersDropped += 1;
      }
    } else {
      result.noLeader += 1;
    }
    await groups.updateOne(
      { _id: g._id as never, kpmId: g.kpmId },
      { $set: { leaderMembershipIds: leaders, migrated0068: { ownerMembershipId: owner }, updatedAt: now }, $unset: { ownerMembershipId: '' } },
    );
    await audit.insertOne(entry(
      g.kpmId, 'group.updated', 'groups', groupId,
      { name: g.name, ownerMembershipId: owner }, { name: g.name, leaderMembershipIds: leaders }, null,
    ));
  }
  return result;
}

/** **Before ADR-0270**: every group's ★ and every membership's tags put back as they were, the kept values gone. */
export async function down(db: mongoose.mongo.Db): Promise<{ groups: number; memberships: number }> {
  const groups = db.collection('groups');
  const memberships = db.collection('memberships');
  let restoredGroups = 0;
  for (const g of await groups.find({ migrated0068: { $exists: true } }).toArray()) {
    const owner = (g.migrated0068 as { ownerMembershipId?: string | null }).ownerMembershipId ?? null;
    await groups.updateOne({ _id: g._id, kpmId: g.kpmId }, { $set: { ownerMembershipId: owner }, $unset: { leaderMembershipIds: '', migrated0068: '' } });
    restoredGroups += 1;
  }
  let restoredMembers = 0;
  for (const m of await memberships.find({ migrated0068: { $exists: true } }).toArray()) {
    const tags = (m.migrated0068 as { groupIds?: string[] }).groupIds ?? [];
    await memberships.updateOne({ _id: m._id, kpmId: m.kpmId }, { $set: { groupIds: tags }, $unset: { migrated0068: '' } });
    restoredMembers += 1;
  }
  return { groups: restoredGroups, memberships: restoredMembers };
}
