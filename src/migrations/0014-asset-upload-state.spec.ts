import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0014-asset-upload-state';

/**
 * ADR-0040. The registry stops claiming a file was scanned, and says instead whether anybody has
 * checked that it arrived.
 */
describe('0014 — scanStatus becomes uploadState', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const assets = () => db().collection('assets');

  beforeEach(async () => {
    await clearCollections();
    await assets().deleteMany({});
  });

  const row = (over: Record<string, unknown>) => ({
    kpmId: 'kpm-a', storageKey: `dev/kpm-a/x/${Math.random()}`, mimeType: 'application/pdf',
    bytes: 10, uploadedByMembershipId: 'mem-1', refCount: 0, deletedAt: null, ...over,
  });

  it('moves every old state onto pending, and drops the field that lied', async () => {
    await assets().insertMany([
      row({ scanStatus: 'pending' }),
      row({ scanStatus: 'clean' }),
      row({ scanStatus: 'infected' }),
    ]);

    expect(await up(db())).toEqual({ migrated: 3, alreadyMigrated: 0 });

    const after = await assets().find({}).toArray();
    expect(after.every((a) => a.uploadState === 'pending')).toBe(true);
    expect(after.every((a) => !('scanStatus' in a))).toBe(true);
  });

  it('does not inherit a "clean" nobody ever wrote', async () => {
    // Nothing in the product has ever set `clean`. A row holding it was not made clean by a
    // check that ran, so confirming it against storage is the honest path, not trusting it.
    await assets().insertOne(row({ scanStatus: 'clean' }));

    await up(db());

    expect((await assets().findOne({}))!.uploadState).toBe('pending');
  });

  it('leaves a row that has already been migrated alone', async () => {
    await assets().insertOne(row({ uploadState: 'confirmed' }));

    expect(await up(db())).toEqual({ migrated: 0, alreadyMigrated: 1 });
    expect((await assets().findOne({}))!.uploadState).toBe('confirmed');
  });

  it('runs twice with the same result as running once', async () => {
    await assets().insertMany([row({ scanStatus: 'pending' }), row({ scanStatus: 'clean' })]);

    await up(db());
    expect(await up(db())).toEqual({ migrated: 0, alreadyMigrated: 2 });
  });
});
