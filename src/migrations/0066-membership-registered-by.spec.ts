import mongoose from 'mongoose';
import { startMongo, stopMongo } from '../../test/mongo';
import { up } from './0066-membership-registered-by';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const AGUS = '66f00000000000000000ab01';
const OWNER = '66f00000000000000000ab00';
const B_OWNER = '66f00000000000000000bb00';

/**
 * **Who registered each person, for the memberships before the field** (P19.17-T1 AC-3; ADR-0267 §3): the invitation's
 * sender where one made it, else the leader they were placed under, else nobody — only a row without the field, so a
 * value written since is never replaced and a second run writes nothing.
 */
describe('0066 — who registered each person, backfilled (ADR-0267 §3)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const id = () => new mongoose.Types.ObjectId();
  const membership = (kpmId: string, extra: Record<string, unknown> = {}) => ({
    _id: id(), kpmId, userId: String(id()), status: 'active', recruitedByMembershipId: null, deletedAt: null, ...extra,
  });
  const registrarOf = async (m: { _id: mongoose.Types.ObjectId }) => {
    const row = await db().collection('memberships').findOne({ _id: m._id });
    return row && 'registeredByMembershipId' in row ? row.registeredByMembershipId : 'absent';
  };

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) await db().collection(name).drop();
  });

  it('P19.17-T1 AC-3 credits the invitation’s sender, else the placement leader, else nobody — and runs once', async () => {
    const rows = {
      // The Owner added Hendra for Agus: the Owner registered him.
      invited: membership(KPM_A, { recruitedByMembershipId: AGUS }),
      // Joined on Agus's code, or tagged by him: Agus.
      onCode: membership(KPM_A, { recruitedByMembershipId: AGUS }),
      left: membership(KPM_A, { recruitedByMembershipId: AGUS, status: 'removed' }),
      deleted: membership(KPM_A, { recruitedByMembershipId: AGUS, deletedAt: new Date('2026-11-01T00:00:00Z') }),
      // The Owner, a roster row, a pending person: nobody.
      owner: membership(KPM_A),
      pending: membership(KPM_A, { status: 'pending', recruitedByMembershipId: undefined }),
      // Written since the field: never replaced.
      current: membership(KPM_A, { recruitedByMembershipId: AGUS, registeredByMembershipId: OWNER }),
      currentNull: membership(KPM_A, { recruitedByMembershipId: AGUS, registeredByMembershipId: null }),
      officeB: membership(KPM_B, { recruitedByMembershipId: B_OWNER }),
    };
    await db().collection('memberships').insertMany(Object.values(rows));
    await db().collection('memberInvites').insertMany([
      { _id: id(), kpmId: KPM_A, leaderMembershipId: AGUS, invitedByMembershipId: OWNER, status: 'accepted', acceptedMembershipId: String(rows.invited._id) },
      // An invitation still waiting, or one another office holds against the same id, credits nobody.
      { _id: id(), kpmId: KPM_A, leaderMembershipId: AGUS, invitedByMembershipId: OWNER, status: 'pending', acceptedMembershipId: null },
      { _id: id(), kpmId: KPM_B, leaderMembershipId: B_OWNER, invitedByMembershipId: B_OWNER, status: 'accepted', acceptedMembershipId: String(rows.onCode._id) },
    ]);

    expect(await up(db())).toEqual({ fromInvite: 1, fromLeader: 4, none: 2 });

    expect(await registrarOf(rows.invited)).toBe(OWNER);
    for (const key of ['onCode', 'left', 'deleted'] as const) {
      expect({ key, by: await registrarOf(rows[key]) }).toEqual({ key, by: AGUS });
    }
    expect(await registrarOf(rows.officeB)).toBe(B_OWNER);
    expect(await registrarOf(rows.owner)).toBeNull();
    expect(await registrarOf(rows.pending)).toBeNull();
    expect(await registrarOf(rows.current)).toBe(OWNER);
    expect(await registrarOf(rows.currentNull)).toBeNull();

    expect(await up(db())).toEqual({ fromInvite: 0, fromLeader: 0, none: 0 });
  });

  it('P19.17-T1 AC-3 on an empty database it reads nothing and creates no collection', async () => {
    expect(await up(db())).toEqual({ fromInvite: 0, fromLeader: 0, none: 0 });
    expect(await db().listCollections({}, { nameOnly: true }).toArray()).toEqual([]);
  });
});
