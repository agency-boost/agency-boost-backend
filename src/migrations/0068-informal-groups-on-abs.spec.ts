import mongoose from 'mongoose';
import { startMongo, stopMongo } from '../../test/mongo';
import { down, INFORMAL_GROUPS_ACTOR, up } from './0068-informal-groups-on-abs';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const NOW = new Date('2026-11-20T03:00:00Z');

/**
 * **ADR-0270 §1, §2 for the groups and tags that came before** (P19.17-T4 AC-1): an AB keeps one live group, an AAB or an
 * agent none; a group's ★ becomes its Group Leader while an active AB in it, and is dropped otherwise; every change
 * logged; a second run writes nothing; `down` puts it all back.
 */
describe('0068 — informal groups belong to ABs (ADR-0270)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const oid = () => new mongoose.Types.ObjectId();
  const group = (kpmId: string, name: string, ownerMembershipId: string | null, over: Record<string, unknown> = {}) => ({
    _id: oid(), kpmId, name, ownerMembershipId, status: 'active', archivedAt: null, deletedAt: null, ...over,
  });
  const member = (kpmId: string, role: string, groupIds: string[], over: Record<string, unknown> = {}) => ({
    _id: oid(), kpmId, role, groupIds, status: 'active', isCoreLeader: false, deletedAt: null, ...over,
  });
  const read = (collection: string, id: mongoose.Types.ObjectId) => db().collection(collection).findOne({ _id: id });

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) await db().collection(name).drop();
  });

  it('P19.17-T4 AC-1 narrows the tags to one live group per AB, none for anybody else; the ★ becomes a Group Leader only while it holds', async () => {
    const ids = { ab: oid(), aab: oid(), mover: oid(), left: oid() };
    const top = group(KPM_A, 'TOP', String(ids.ab));
    const alpha = group(KPM_A, 'ALPHA', String(ids.mover));
    const zeta = group(KPM_A, 'ZETA', String(ids.mover));
    const aabs = group(KPM_A, 'AAB CIRCLE', String(ids.aab));
    const gone = group(KPM_A, 'GONE', String(ids.left));
    const none = group(KPM_A, 'NONE', null);
    const old = group(KPM_A, 'OLD', null, { status: 'archived', archivedAt: NOW });
    const theirs = group(KPM_B, 'THEIRS', null);
    await db().collection('groups').insertMany([top, alpha, zeta, aabs, gone, none, old, theirs]);
    const g = (x: { _id: mongoose.Types.ObjectId }) => String(x._id);
    const rows = {
      ab: member(KPM_A, 'ab', [g(top), g(old)], { _id: ids.ab, isCoreLeader: true }),
      // ★ of ZETA and ALPHA, in both: keeps ALPHA, the first by name — and leads only it.
      mover: member(KPM_A, 'ab', [g(zeta), g(alpha)], { _id: ids.mover }),
      aab: member(KPM_A, 'aab', [g(aabs)], { _id: ids.aab }),
      agent: member(KPM_A, 'agent', [g(top), g(none)]),
      left: member(KPM_A, 'ab', [g(gone)], { _id: ids.left, status: 'removed' }),
      // A tag on another office's group places nobody.
      stray: member(KPM_A, 'ab', [g(theirs)]),
      untouched: member(KPM_A, 'ab', [g(none)]),
    };
    await db().collection('memberships').insertMany(Object.values(rows));

    expect(await up(db(), NOW)).toEqual({ leadersCarried: 2, leadersDropped: 3, noLeader: 3, absNarrowed: 3, othersUntagged: 2 });

    const tags = async (m: { _id: mongoose.Types.ObjectId }) => (await read('memberships', m._id))!.groupIds;
    expect(await tags(rows.ab)).toEqual([g(top)]);
    expect(await tags(rows.mover)).toEqual([g(alpha)]);
    expect(await tags(rows.aab)).toEqual([]);
    expect(await tags(rows.agent)).toEqual([]);
    // A leaver's tag is never read; it is left as it was.
    expect(await tags(rows.left)).toEqual([g(gone)]);
    expect(await tags(rows.stray)).toEqual([]);
    expect(await tags(rows.untouched)).toEqual([g(none)]);
    expect((await read('memberships', rows.agent._id))!.migrated0068).toEqual({ groupIds: [g(top), g(none)] });
    expect((await read('memberships', rows.untouched._id))!.migrated0068).toBeUndefined();

    const leaders = async (x: { _id: mongoose.Types.ObjectId }) => {
      const row = (await read('groups', x._id))!;
      expect(row.ownerMembershipId).toBeUndefined();
      return row.leaderMembershipIds;
    };
    expect(await leaders(top)).toEqual([String(ids.ab)]);
    expect(await leaders(alpha)).toEqual([String(ids.mover)]);
    expect(await leaders(zeta)).toEqual([]);
    expect(await leaders(aabs)).toEqual([]);
    expect(await leaders(gone)).toEqual([]);
    expect(await leaders(none)).toEqual([]);
    expect(await leaders(old)).toEqual([]);
    expect((await read('groups', aabs._id))!.migrated0068).toEqual({ ownerMembershipId: String(ids.aab) });

    // Logged in each office's own log, named to the job.
    const log = await db().collection('auditLog').find({ actorUserId: INFORMAL_GROUPS_ACTOR }).toArray();
    expect(log.filter((e) => e.action === 'member.tagged')).toHaveLength(5);
    expect(log.filter((e) => e.action === 'group.updated')).toHaveLength(8);
    expect(log.find((e) => e.targetId === String(rows.agent._id))).toMatchObject({
      kpmId: KPM_A, before: { groupIds: [g(top), g(none)], isCoreLeader: false }, after: { groupIds: [], isCoreLeader: false },
    });
    expect(log.find((e) => e.targetId === g(aabs))).toMatchObject({
      before: { name: 'AAB CIRCLE', ownerMembershipId: String(ids.aab) }, after: { name: 'AAB CIRCLE', leaderMembershipIds: [] },
    });

    // Idempotent: a second run writes nothing.
    expect(await up(db(), NOW)).toEqual({ leadersCarried: 0, leadersDropped: 0, noLeader: 0, absNarrowed: 0, othersUntagged: 0 });
    expect(await db().collection('auditLog').countDocuments()).toBe(log.length);

    // Reversible.
    expect(await down(db())).toEqual({ groups: 8, memberships: 5 });
    expect((await read('groups', zeta._id))).toMatchObject({ ownerMembershipId: String(ids.mover) });
    expect((await read('groups', zeta._id))!.leaderMembershipIds).toBeUndefined();
    expect((await read('groups', none._id))!.ownerMembershipId).toBeNull();
    expect(await tags(rows.mover)).toEqual([g(zeta), g(alpha)]);
    expect(await tags(rows.agent)).toEqual([g(top), g(none)]);
    expect((await read('memberships', rows.agent._id))!.migrated0068).toBeUndefined();
  });

  it('reads nothing and creates nothing on an empty database', async () => {
    expect(await up(db(), NOW)).toEqual({ leadersCarried: 0, leadersDropped: 0, noLeader: 0, absNarrowed: 0, othersUntagged: 0 });
    expect(await db().listCollections({ name: 'auditLog' }).toArray()).toEqual([]);
    expect(await down(db())).toEqual({ groups: 0, memberships: 0 });
  });
});
