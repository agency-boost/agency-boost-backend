import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0035-blank-preferred-name';

/**
 * P18.8-T15 AC-1 (UI-005). An empty or blank preferred name saved before the API stored `null` for one
 * becomes `null`, so the full name stands in for it again.
 */
describe('0035 — a blank preferred name is no name', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const users = () => db().collection('users');

  beforeEach(async () => {
    await clearCollections();
    await users().deleteMany({});
  });

  const account = (email: string, preferredName: unknown) => ({
    email, fullName: `Person ${email}`, preferredName, passwordHash: 'x', status: 'active', platformRole: 'none',
    deletedAt: null,
  });

  const preferredOf = async (email: string) => (await users().findOne({ email }))?.preferredName;

  it('P18.8-T15 AC-1 clears an empty and a blank preferred name, and leaves real ones and nulls alone', async () => {
    await users().insertMany([
      account('empty@kpm.test', ''),
      account('blank@kpm.test', '   '),
      account('tab@kpm.test', '\t'),
      account('real@kpm.test', 'Rina'),
      account('padded@kpm.test', ' Budi '),
      account('none@kpm.test', null),
    ] as never);

    expect(await up(db())).toEqual({ cleared: 3 });

    expect(await preferredOf('empty@kpm.test')).toBeNull();
    expect(await preferredOf('blank@kpm.test')).toBeNull();
    expect(await preferredOf('tab@kpm.test')).toBeNull();
    expect(await preferredOf('real@kpm.test')).toBe('Rina');
    expect(await preferredOf('padded@kpm.test')).toBe(' Budi ');
    expect(await preferredOf('none@kpm.test')).toBeNull();
  });

  it('P18.8-T15 AC-1 a second run clears nothing', async () => {
    await users().insertMany([account('empty@kpm.test', '')] as never);
    await up(db());
    expect(await up(db())).toEqual({ cleared: 0 });
  });
});
