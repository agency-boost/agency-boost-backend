import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0010-kpm-seed-record-per-kind';

/**
 * P5-T12. The pair only ever described the taxonomy, so it moves there — and nothing is
 * invented for the kinds that were never recorded.
 */
describe('0010 — the seed record per template kind', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const kpms = () => db().collection('kpms');

  beforeEach(async () => {
    await clearCollections();
    await kpms().deleteMany({});
  });

  const office = (over: Record<string, unknown>) => ({
    companyId: 'co-1', code: '0417', branchName: 'A', timezone: 'Asia/Jakarta',
    status: 'active', deletedAt: null, ...over,
  });

  it('moves the pair to the taxonomy’s entry and removes it', async () => {
    await kpms().insertOne(office({ seededFromTemplateId: 'tpl-1', seededFromVersion: 3 }));

    expect(await up(db())).toEqual({ moved: 1 });

    const saved = (await kpms().findOne({}))!;
    expect(saved.seededFrom).toEqual({ activity_taxonomy: { templateId: 'tpl-1', version: 3 } });
    expect(saved).not.toHaveProperty('seededFromVersion');
    expect(saved).not.toHaveProperty('seededFromTemplateId');
  });

  it('keeps a null version, which means built from the platform defaults', async () => {
    await kpms().insertOne(office({ seededFromTemplateId: null, seededFromVersion: null }));
    await up(db());

    expect((await kpms().findOne({}))!.seededFrom)
      .toEqual({ activity_taxonomy: { templateId: null, version: null } });
  });

  it('invents nothing for the kinds that were never recorded', async () => {
    // Estimating from creation time against publishedAt would write a guess into a record.
    await kpms().insertOne(office({ seededFromTemplateId: 'tpl-1', seededFromVersion: 2 }));
    await up(db());

    const { seededFrom } = (await kpms().findOne({}))!;
    expect(seededFrom).not.toHaveProperty('lead_pipeline');
    expect(seededFrom).not.toHaveProperty('ratio_set');
  });

  it('leaves an office untouched that predates the pair altogether', async () => {
    await kpms().insertOne(office({}));

    expect(await up(db())).toEqual({ moved: 0 });
    expect((await kpms().findOne({}))!).not.toHaveProperty('seededFrom');
  });

  it('never overwrites a record provisioning already wrote, but still removes the pair', async () => {
    await kpms().insertOne(office({
      seededFromVersion: 1,
      seededFrom: { activity_taxonomy: { templateId: 'tpl-new', version: 4 } },
    }));

    expect(await up(db())).toEqual({ moved: 0 });
    const saved = (await kpms().findOne({}))!;
    expect(saved.seededFrom.activity_taxonomy).toEqual({ templateId: 'tpl-new', version: 4 });
    expect(saved).not.toHaveProperty('seededFromVersion');
  });

  it('is idempotent', async () => {
    await kpms().insertOne(office({ seededFromTemplateId: 'tpl-1', seededFromVersion: 3 }));
    await up(db());
    expect(await up(db())).toEqual({ moved: 0 });
  });
});
