import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0020-kpm-production-lock-grace';

/** P9-T4. The office's own row gets the window ADR-0050 set, and an office that chose one keeps it. */
describe('0020 — every office gets a production lock window', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const kpms = () => (mongoose.connection.db as mongoose.mongo.Db).collection('kpms');

  beforeEach(async () => {
    await clearCollections();
    await kpms().deleteMany({});
  });

  it('writes the platform default into an office that predates the setting', async () => {
    await kpms().insertOne({ code: '0417', settings: { activityBackdateGraceDays: 7 } } as never);
    expect(await up(mongoose.connection.db as mongoose.mongo.Db)).toEqual({ updated: 1 });
    expect((await kpms().findOne({ code: '0417' }))!.settings).toEqual({
      activityBackdateGraceDays: 7, productionLockGraceDays: 7,
    });
  });

  it('leaves an office that already has one alone, and writes nothing the second time', async () => {
    await kpms().insertOne({ code: '0555', settings: { productionLockGraceDays: 12 } } as never);
    expect(await up(mongoose.connection.db as mongoose.mongo.Db)).toEqual({ updated: 0 });
    expect((await kpms().findOne({ code: '0555' }))!.settings.productionLockGraceDays).toBe(12);
  });
});
