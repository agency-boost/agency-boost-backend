import mongoose from 'mongoose';
import { startMongo, stopMongo } from '../../test/mongo';
import { emptyIfMissing, isNamespaceNotFound } from './missing-collection';

/** P18.7-T1 (the review's L4): a missing collection is empty; nothing else is. */
describe('a read of a collection that may not exist yet (P18.7-T1)', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);
  const db = () => mongoose.connection.db as mongoose.mongo.Db;

  it('P18.7-T1 reads the server\'s own NamespaceNotFound, from a collection nobody created, as empty', async () => {
    const name = 'never_created_here';
    await db().collection(name).drop().catch(() => undefined);
    const thrown = await db().collection(name).indexes().then(() => null, (err: unknown) => err);
    expect(isNamespaceNotFound(thrown)).toBe(true);
    await expect(emptyIfMissing(db().collection(name).indexes())).resolves.toEqual([]);
  });

  it('P18.7-T1 passes a read that works through untouched', async () => {
    await db().collection('present_here').insertOne({ a: 1 });
    const indexes = await emptyIfMissing(db().collection('present_here').indexes());
    expect(indexes.map((i) => i.name)).toEqual(['_id_']);
  });

  it.each([
    [{ code: 26 }],
    [{ codeName: 'NamespaceNotFound' }],
  ])('P18.7-T1 recognises %j', async (err) => {
    expect(isNamespaceNotFound(err)).toBe(true);
    await expect(emptyIfMissing(Promise.reject(err))).resolves.toEqual([]);
  });

  it.each([
    ['a lost connection', Object.assign(new Error('connection closed'), { name: 'MongoNetworkError' })],
    ['a missing privilege', Object.assign(new Error('not authorized'), { code: 13, codeName: 'Unauthorized' })],
    ['a rejection with no error in it', undefined],
  ])('P18.7-T1 throws %s rather than reading it as an empty collection', async (_what, err) => {
    expect(isNamespaceNotFound(err)).toBe(false);
    await expect(emptyIfMissing(Promise.reject(err))).rejects.toBe(err);
  });
});
