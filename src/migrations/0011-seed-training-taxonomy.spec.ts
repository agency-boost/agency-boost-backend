import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { SEED_TRAINING_CATEGORIES, SEED_TRAINING_MODULES } from '@/domain/constants';
import { up } from './0011-seed-training-taxonomy';

const NOW = new Date('2026-09-17T02:00:00Z');

/**
 * P5-T1. Offices that already exist get the training taxonomy a new one would — from their
 * company's published template or the defaults — recorded the same way, and only once.
 */
describe('0011 — the training taxonomy for offices that already exist', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const kpms = () => db().collection('kpms');
  const col = (name: string) => db().collection(name);

  beforeEach(async () => {
    await clearCollections();
    for (const name of ['kpms', 'companyTemplates', 'trainingCategories', 'trainingSkills', 'trainingModules']) {
      await col(name).deleteMany({});
    }
  });

  const office = (over: Record<string, unknown> = {}) => ({
    companyId: 'co-1', code: '0417', branchName: 'A', timezone: 'Asia/Jakarta',
    status: 'active', deletedAt: null, ...over,
  });

  it('seeds the defaults into an office whose company published none, and records a null version', async () => {
    const { insertedId } = await kpms().insertOne(office());

    expect(await up(db(), NOW)).toEqual({ seeded: 1, skipped: 0 });

    const kpmId = String(insertedId);
    expect(await col('trainingCategories').countDocuments({ kpmId })).toBe(SEED_TRAINING_CATEGORIES.length);
    expect(await col('trainingSkills').countDocuments({ kpmId })).toBe(6);
    expect(await col('trainingModules').countDocuments({ kpmId })).toBe(SEED_TRAINING_MODULES.length);
    const module = await col('trainingModules').findOne({ kpmId, code: 'PROSPECT_LIST' });
    expect(module).toMatchObject({
      skillCode: 'PROSPECTING', publishState: 'published', status: 'active', version: 1,
      deletedAt: null, createdAt: NOW,
    });
    expect((await kpms().findOne({ _id: insertedId }))!.seededFrom).toEqual({
      training_taxonomy: { templateId: null, version: null },
    });
  });

  it('copies the company’s newest published template, and records which one', async () => {
    const { insertedId } = await kpms().insertOne(office());
    const payload = (title: string) => ({
      categories: [{ code: 'ONBOARDING', label: 'Onboarding' }],
      skills: [{ code: 'FIRST_WEEK', categoryCode: 'ONBOARDING', label: 'First week' }],
      modules: [{ code: 'WELCOME', skillCode: 'FIRST_WEEK', title, publishState: 'published' }],
    });
    await col('companyTemplates').insertMany([
      { companyId: 'co-1', kind: 'training_taxonomy', status: 'published', version: 1, deletedAt: null, payload: payload('Old') },
      { companyId: 'co-1', kind: 'training_taxonomy', status: 'published', version: 2, deletedAt: null, payload: payload('Welcome') },
      { companyId: 'co-1', kind: 'training_taxonomy', status: 'draft', version: 3, deletedAt: null, payload: payload('Draft') },
    ]);

    await up(db(), NOW);

    const kpmId = String(insertedId);
    expect(await col('trainingModules').find({ kpmId }).map((m) => m.title).toArray()).toEqual(['Welcome']);
    const record = (await kpms().findOne({ _id: insertedId }))!.seededFrom.training_taxonomy;
    expect(record.version).toBe(2);
    expect(record.templateId).toEqual(expect.any(String));
  });

  it('leaves an office that already has training alone, and runs twice to the same result', async () => {
    const { insertedId } = await kpms().insertOne(office());
    await up(db(), NOW);

    expect(await up(db(), NOW)).toEqual({ seeded: 0, skipped: 1 });
    expect(await col('trainingCategories').countDocuments({ kpmId: String(insertedId) })).toBe(SEED_TRAINING_CATEGORIES.length);
  });

  it('counts an office with only a skill or only a module as already seeded', async () => {
    const one = await kpms().insertOne(office({ code: '0001' }));
    const two = await kpms().insertOne(office({ code: '0002' }));
    await col('trainingSkills').insertOne({ kpmId: String(one.insertedId), code: 'X_Y_Z' });
    await col('trainingModules').insertOne({ kpmId: String(two.insertedId), code: 'X_Y_Z' });

    expect(await up(db(), NOW)).toEqual({ seeded: 0, skipped: 2 });
  });

  it('seeds an empty published taxonomy as empty, and never overwrites an existing record', async () => {
    const { insertedId } = await kpms().insertOne(office({
      seededFrom: { training_taxonomy: { templateId: 'kept', version: 9 } },
    }));
    await col('companyTemplates').insertOne({
      companyId: 'co-1', kind: 'training_taxonomy', status: 'published', version: 1, deletedAt: null,
      payload: { categories: [], skills: [], modules: [] },
    });

    expect(await up(db(), NOW)).toEqual({ seeded: 1, skipped: 0 });
    expect(await col('trainingCategories').countDocuments({ kpmId: String(insertedId) })).toBe(0);
    expect((await kpms().findOne({ _id: insertedId }))!.seededFrom.training_taxonomy)
      .toEqual({ templateId: 'kept', version: 9 });
  });

  it('skips a deleted office', async () => {
    await kpms().insertOne(office({ deletedAt: NOW }));
    expect(await up(db(), NOW)).toEqual({ seeded: 0, skipped: 0 });
  });
});
