import mongoose from 'mongoose';
import { startMongo, stopMongo } from '../../test/mongo';
import { GROUP_LEADER_ACTOR, up } from './0061-group-leader-is-a-member';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const NOW = new Date('2026-11-12T03:00:00Z');

/**
 * **ADR-0253 §2 for the groups that came before** (P19.13-T3 AC-2; UI-199, D2): an owner who is an active leader becomes
 * the ★ by being tagged into the group; anybody else is cleared; a leader owning several keeps the first by name; every
 * write is audited with what it replaced; a second run writes nothing.
 */
describe('0061 — a group’s owner is its ★, a leader who is a member (ADR-0253 §2)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const id = () => new mongoose.Types.ObjectId();
  const member = (kpmId: string, role: string, extra: Record<string, unknown> = {}) => ({
    _id: id(), kpmId, role, status: 'active', groupIds: [] as string[], isCoreLeader: false, deletedAt: null, ...extra,
  });
  const group = (kpmId: string, name: string, owner: mongoose.Types.ObjectId | null, extra: Record<string, unknown> = {}) => ({
    _id: id(), kpmId, name, ownerMembershipId: owner === null ? null : String(owner), status: 'active', archivedAt: null,
    deletedAt: null, ...extra,
  });

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) await db().collection(name).drop();
  });

  it('P19.13-T3 AC-2 tags an active leader owner in, clears every other owner, keeps a leader’s first group by name; run twice, the second writes nothing', async () => {
    const wilson = member(KPM_A, 'ab', { groupIds: ['elsewhere'], isCoreLeader: true });
    const sari = member(KPM_A, 'aab');
    const agent = member(KPM_A, 'agent');
    const leaver = member(KPM_A, 'ab', { status: 'removed' });
    const already = member(KPM_A, 'ab');
    const theirs = member(KPM_B, 'ab');
    await db().collection('memberships').insertMany([wilson, sari, agent, leaver, already, theirs]);

    const top = group(KPM_A, 'Top Producers 2026', wilson._id);
    const mentoringB = group(KPM_A, 'Mentoring B', sari._id);
    const mentoringA = group(KPM_A, 'Mentoring A', sari._id);
    const agents = group(KPM_A, 'Agents', agent._id);
    const gone = group(KPM_A, 'Gone', leaver._id);
    const erased = group(KPM_A, 'Erased', id());
    const kept = group(KPM_A, 'Kept', already._id);
    const none = group(KPM_A, 'None', null);
    const archived = group(KPM_A, 'Archived', agent._id, { status: 'archived' });
    // Another office's owner is never found from this one: the group is cleared, the membership untouched.
    const crossed = group(KPM_A, 'Crossed', theirs._id);
    await db().collection('memberships').updateOne({ _id: already._id }, { $set: { groupIds: [String(kept._id)] } });
    await db().collection('groups').insertMany([top, mentoringB, mentoringA, agents, gone, erased, kept, none, archived, crossed]);

    expect(await up(db(), NOW)).toEqual({ tagged: 2, cleared: 5, current: 1 });

    const owner = async (g: { _id: mongoose.Types.ObjectId }) => (await db().collection('groups').findOne({ _id: g._id }))!.ownerMembershipId;
    const tags = async (m: { _id: mongoose.Types.ObjectId }) => (await db().collection('memberships').findOne({ _id: m._id }))!.groupIds;
    expect(await owner(top)).toBe(String(wilson._id));
    expect(await tags(wilson)).toEqual(['elsewhere', String(top._id)]);
    // Sari owned two: *Mentoring A* first by name, *Mentoring B* cleared.
    expect(await owner(mentoringA)).toBe(String(sari._id));
    expect(await owner(mentoringB)).toBeNull();
    expect(await tags(sari)).toEqual([String(mentoringA._id)]);
    for (const g of [agents, gone, erased, crossed]) expect(await owner(g)).toBeNull();
    expect(await tags(agent)).toEqual([]);
    expect(await tags(theirs)).toEqual([]);
    expect(await owner(kept)).toBe(String(already._id));
    expect(await owner(none)).toBeNull();
    // An archived group is not touched.
    expect(await owner(archived)).toBe(String(agent._id));

    // Every write audited, named to the job, with what it replaced.
    const entries = await db().collection('auditLog').find({ actorUserId: GROUP_LEADER_ACTOR }).toArray();
    expect(entries).toHaveLength(7);
    expect(entries.find((e) => e.targetId === String(wilson._id))).toMatchObject({
      action: 'member.tagged', kpmId: KPM_A, targetMembershipId: String(wilson._id),
      before: { groupIds: ['elsewhere'], isCoreLeader: true }, after: { groupIds: ['elsewhere', String(top._id)], isCoreLeader: true },
    });
    expect(entries.find((e) => e.targetId === String(gone._id))).toMatchObject({
      action: 'group.updated', before: { name: 'Gone', ownerMembershipId: String(leaver._id) }, after: { ownerMembershipId: null },
    });

    const before = await db().collection('groups').find().sort({ _id: 1 }).toArray();
    expect(await up(db(), NOW)).toEqual({ tagged: 0, cleared: 0, current: 3 });
    expect(await db().collection('groups').find().sort({ _id: 1 }).toArray()).toEqual(before);
    expect(await db().collection('auditLog').countDocuments({ actorUserId: GROUP_LEADER_ACTOR })).toBe(7);
  });

  it('does nothing on a database with no groups', async () => {
    expect(await up(db(), NOW)).toEqual({ tagged: 0, cleared: 0, current: 0 });
  });
});
