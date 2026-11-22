import mongoose from 'mongoose';
import { startMongo, stopMongo } from '../../test/mongo';
import { down, up } from './0077-kpm-owners-list';

const NOW = new Date('2026-11-22T03:00:00Z');
const JOINED = new Date('2026-08-04T03:00:00Z');
const MADE = new Date('2026-06-01T03:00:00Z');

/**
 * **ADR-0285 for the KPMs that came before** (P19.27-T1 AC-1): every KPM's one owner becomes a one-owner list, `since`
 * the owner's join date there; a KPM with none an empty list; the old index dropped; a second run writes nothing; `down`
 * keeps the first owner.
 */
describe('0077 — a KPM’s one owner becomes a list (ADR-0285)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const oid = () => new mongoose.Types.ObjectId();

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) await db().collection(name).drop();
  });

  it('P19.27-T1 AC-1 moves ownerUserId into owners, since the owner’s join date there, and drops the old field and index', async () => {
    const owned = oid();
    const joinedNever = oid();
    const empty = oid();
    const deleted = oid();
    await db().collection('kpms').insertMany([
      { _id: owned, code: '0417', ownerUserId: 'u-wilson', createdAt: MADE, deletedAt: null },
      { _id: joinedNever, code: '0555', ownerUserId: 'u-hendra', createdAt: MADE, deletedAt: null },
      { _id: empty, code: '0418', ownerUserId: null, createdAt: MADE, deletedAt: null },
      { _id: deleted, code: '0900', ownerUserId: 'u-gone', createdAt: MADE, deletedAt: NOW },
    ]);
    await db().collection('kpms').createIndex({ ownerUserId: 1 }, { name: 'ownerUserId_1' });
    await db().collection('memberships').insertMany([
      { kpmId: String(owned), userId: 'u-wilson', joinedAt: JOINED, createdAt: MADE, deletedAt: null },
      // Another KPM's membership of the same person is not this KPM's join date.
      { kpmId: String(empty), userId: 'u-wilson', joinedAt: NOW, createdAt: NOW, deletedAt: null },
    ]);

    await expect(up(db(), NOW)).resolves.toEqual({ moved: 3, empty: 1, current: 0 });

    const row = (id: mongoose.Types.ObjectId) => db().collection('kpms').findOne({ _id: id });
    expect(await row(owned)).toMatchObject({ owners: [{ userId: 'u-wilson', since: JOINED, addedByUserId: null }] });
    // No membership: the KPM's own creation.
    expect(await row(joinedNever)).toMatchObject({ owners: [{ userId: 'u-hendra', since: MADE }] });
    expect(await row(empty)).toMatchObject({ owners: [] });
    // A soft-deleted KPM still names its owner.
    expect(await row(deleted)).toMatchObject({ owners: [{ userId: 'u-gone' }] });
    expect(await db().collection('kpms').countDocuments({ ownerUserId: { $exists: true } })).toBe(0);
    expect((await db().collection('kpms').indexes()).map((i) => i.name)).not.toContain('ownerUserId_1');
  });

  it('P19.27-T1 AC-1 is idempotent: a second run finds every KPM current', async () => {
    await db().collection('kpms').insertMany([
      { code: '0417', ownerUserId: 'u-wilson', createdAt: MADE, deletedAt: null },
      { code: '0418', ownerUserId: null, createdAt: MADE, deletedAt: null },
    ]);
    await up(db(), NOW);
    const before = await db().collection('kpms').find().toArray();
    await expect(up(db(), NOW)).resolves.toEqual({ moved: 0, empty: 0, current: 2 });
    expect(await db().collection('kpms').find().toArray()).toEqual(before);
  });

  it('P19.27-T1 AC-1 keeps a list written since, adding a stray ownerUserId beside it first', async () => {
    const id = oid();
    await db().collection('kpms').insertOne({
      _id: id, code: '0602', ownerUserId: 'u-sinta', owners: [{ userId: 'u-yohanes', since: MADE, addedByUserId: null }],
      createdAt: MADE, deletedAt: null,
    });
    await expect(up(db(), NOW)).resolves.toMatchObject({ moved: 1 });
    const row = await db().collection('kpms').findOne({ _id: id });
    expect(row!.owners.map((o: { userId: string }) => o.userId)).toEqual(['u-yohanes', 'u-sinta']);
    expect(row).not.toHaveProperty('ownerUserId');
  });

  it('P19.27-T1 AC-1 on an empty database reads nothing and creates no collection', async () => {
    await expect(up(db(), NOW)).resolves.toEqual({ moved: 0, empty: 0, current: 0 });
    expect(await db().listCollections({ name: 'kpms' }).toArray()).toHaveLength(0);
    await expect(down(db())).resolves.toEqual({ kpms: 0 });
  });

  it('ADR-0285 reversal: up then down on a KPM with one owner gives back the row it began as, index included', async () => {
    const id = oid();
    await db().collection('kpms').insertOne({ _id: id, code: '0417', ownerUserId: 'u-wilson', createdAt: MADE, deletedAt: null });
    await db().collection('kpms').createIndex({ ownerUserId: 1 }, { name: 'ownerUserId_1' });
    await db().collection('memberships').insertOne({ kpmId: String(id), userId: 'u-wilson', joinedAt: JOINED, deletedAt: null });
    const before = await db().collection('kpms').findOne({ _id: id });

    await expect(up(db(), NOW)).resolves.toEqual({ moved: 1, empty: 0, current: 0 });
    // The application builds this index from the schema; the migration only drops the old one.
    await db().collection('kpms').createIndex({ 'owners.userId': 1 }, { name: 'owners_userId' });
    expect(await db().collection('kpms').findOne({ _id: id }))
      .toMatchObject({ owners: [{ userId: 'u-wilson', since: JOINED, addedByUserId: null }] });

    await expect(down(db())).resolves.toEqual({ kpms: 1 });
    expect(await db().collection('kpms').findOne({ _id: id })).toEqual(before);
    const names = (await db().collection('kpms').indexes()).map((i) => i.name);
    expect(names).toContain('ownerUserId_1');
    expect(names).not.toContain('owners_userId');
    // The membership is untouched both ways.
    expect(await db().collection('memberships').countDocuments({ kpmId: String(id), userId: 'u-wilson' })).toBe(1);
  });

  it('P19.27-T1 AC-1 down keeps each KPM’s first owner — the earliest since — and builds the old index again', async () => {
    const two = oid();
    const none = oid();
    await db().collection('kpms').insertMany([
      { _id: two, code: '0602', owners: [
        { userId: 'u-sinta', since: NOW, addedByUserId: 'u-yohanes' },
        { userId: 'u-yohanes', since: MADE, addedByUserId: null },
      ], deletedAt: null },
      { _id: none, code: '0418', owners: [], deletedAt: null },
    ]);
    await db().collection('kpms').createIndex({ 'owners.userId': 1 }, { name: 'owners_userId' });
    await expect(down(db())).resolves.toEqual({ kpms: 2 });
    expect(await db().collection('kpms').findOne({ _id: two })).toMatchObject({ ownerUserId: 'u-yohanes' });
    expect(await db().collection('kpms').findOne({ _id: none })).toMatchObject({ ownerUserId: null });
    expect(await db().collection('kpms').countDocuments({ owners: { $exists: true } })).toBe(0);
    const names = (await db().collection('kpms').indexes()).map((i) => i.name);
    expect(names).toContain('ownerUserId_1');
    expect(names).not.toContain('owners_userId');
    // And up again: the round trip lands where it began, the first owner kept.
    await up(db(), NOW);
    expect(await db().collection('kpms').findOne({ _id: two })).toMatchObject({ owners: [{ userId: 'u-yohanes' }] });
  });
});
