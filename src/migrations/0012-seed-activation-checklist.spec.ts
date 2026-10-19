import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { defaultActivationChecklist } from '@/modules/activation/activation-payload';
import { up } from './0012-seed-activation-checklist';

const NOW = new Date('2026-09-18T02:00:00Z');

/**
 * P5-T3. Offices that already exist get the activation checklist a new one would — from their
 * company's published template or the seed — as version 1, published, recorded the same way, and
 * only once.
 */
describe('0012 — the activation checklist for offices that already exist', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const kpms = () => db().collection('kpms');
  const col = (name: string) => db().collection(name);

  beforeEach(async () => {
    await clearCollections();
    for (const name of ['kpms', 'companyTemplates', 'activationTemplates', 'trainingModules']) {
      await col(name).deleteMany({});
    }
  });

  const office = (over: Record<string, unknown> = {}) => ({
    companyId: 'co-1', code: '0417', branchName: 'A', timezone: 'Asia/Jakarta',
    status: 'active', deletedAt: null, ...over,
  });

  const publishedTemplate = (payload: unknown, over: Record<string, unknown> = {}) => ({
    companyId: 'co-1', kind: 'activation_checklist', version: 3, status: 'published',
    payload, publishedAt: NOW, deletedAt: null, ...over,
  });

  it('seeds the checklist into an office whose company published none, recording a null version', async () => {
    const { insertedId } = await kpms().insertOne(office());

    expect(await up(db(), NOW)).toEqual({ seeded: 1, skipped: 0, fellBackToDefaults: 0 });

    const kpmId = String(insertedId);
    const checklist = await col('activationTemplates').findOne({ kpmId });
    expect(checklist).toMatchObject({
      version: 1, status: 'published', publishedAt: NOW, deletedAt: null, createdAt: NOW,
    });
    expect((checklist!.aspects as unknown[]).length).toBe(5);
    expect((checklist!.aspects as { items: unknown[] }[]).flatMap((a) => a.items)).toHaveLength(16);

    expect(await kpms().findOne({ _id: insertedId })).toMatchObject({
      seededFrom: { activation_checklist: { templateId: null, version: null } },
    });
  });

  it('prefers the company’s newest published template, and records which one', async () => {
    const { insertedId } = await kpms().insertOne(office());
    const payload = {
      aspects: [{ code: 'ONBOARDING', label: 'Onboarding', items: [{ code: 'MEET_TEAM', label: 'Meet the team' }] }],
    };
    await col('companyTemplates').insertOne(publishedTemplate(defaultActivationChecklist(), { version: 2 }));
    const newest = await col('companyTemplates').insertOne(publishedTemplate(payload, { version: 3 }));

    expect(await up(db(), NOW)).toEqual({ seeded: 1, skipped: 0, fellBackToDefaults: 0 });

    const kpmId = String(insertedId);
    const checklist = await col('activationTemplates').findOne({ kpmId });
    expect((checklist!.aspects as { code: string }[]).map((a) => a.code)).toEqual(['ONBOARDING']);
    expect(await kpms().findOne({ _id: insertedId })).toMatchObject({
      seededFrom: { activation_checklist: { templateId: String(newest.insertedId), version: 3 } },
    });
  });

  /*
   * A template may name a training module by code, and an office may have archived it. Refusing
   * the whole run would leave every office after this one unseeded, so that office takes the
   * defaults — which link to no module — and the run says it happened.
   */
  it('falls back to the defaults when the template links to a module the office does not offer', async () => {
    const { insertedId } = await kpms().insertOne(office());
    const payload = {
      aspects: [{
        code: 'TRAINING_AND_CERTIFICATION',
        label: '3. Training & Certification',
        items: [{ code: 'MANDATORY_TRAINING', label: 'Mandatory training', autoLink: 'training:PROSPECT_LIST' }],
      }],
    };
    await col('companyTemplates').insertOne(publishedTemplate(payload));

    expect(await up(db(), NOW)).toEqual({ seeded: 1, skipped: 0, fellBackToDefaults: 1 });

    const checklist = await col('activationTemplates').findOne({ kpmId: String(insertedId) });
    expect((checklist!.aspects as { items: unknown[] }[]).flatMap((a) => a.items)).toHaveLength(16);
    expect(await kpms().findOne({ _id: insertedId })).toMatchObject({
      seededFrom: { activation_checklist: { templateId: null, version: null } },
    });
  });

  it('keeps the template’s link when the office does offer that module', async () => {
    const { insertedId } = await kpms().insertOne(office());
    const kpmId = String(insertedId);
    await col('trainingModules').insertOne({
      kpmId, code: 'PROSPECT_LIST', skillCode: 'PROSPECTING', title: 'Building Your Prospect List',
      publishState: 'published', status: 'active', displayOrder: 1, version: 1, deletedAt: null,
    });
    await col('companyTemplates').insertOne(publishedTemplate({
      aspects: [{
        code: 'TRAINING_AND_CERTIFICATION',
        label: '3. Training & Certification',
        items: [{ code: 'MANDATORY_TRAINING', label: 'Mandatory training', autoLink: 'training:PROSPECT_LIST' }],
      }],
    }));

    expect(await up(db(), NOW)).toEqual({ seeded: 1, skipped: 0, fellBackToDefaults: 0 });

    const checklist = await col('activationTemplates').findOne({ kpmId });
    expect((checklist!.aspects as { items: { autoLink: string }[] }[])[0].items[0].autoLink)
      .toBe('training:PROSPECT_LIST');
  });

  it('leaves an office that already has a checklist alone, and never overwrites a record', async () => {
    const { insertedId } = await kpms().insertOne(office({
      seededFrom: { activation_checklist: { templateId: 'tpl-old', version: 7 } },
    }));
    await col('activationTemplates').insertOne({
      kpmId: String(insertedId), version: 4, status: 'published', aspects: [], deletedAt: null,
    });

    expect(await up(db(), NOW)).toEqual({ seeded: 0, skipped: 1, fellBackToDefaults: 0 });

    expect(await col('activationTemplates').countDocuments({ kpmId: String(insertedId) })).toBe(1);
    expect(await kpms().findOne({ _id: insertedId })).toMatchObject({
      seededFrom: { activation_checklist: { templateId: 'tpl-old', version: 7 } },
    });
  });

  it('runs twice with the same result, which is what forward-only means', async () => {
    await kpms().insertOne(office());
    await kpms().insertOne(office({ code: '0418' }));

    expect(await up(db(), NOW)).toEqual({ seeded: 2, skipped: 0, fellBackToDefaults: 0 });
    expect(await up(db(), NOW)).toEqual({ seeded: 0, skipped: 2, fellBackToDefaults: 0 });
    expect(await col('activationTemplates').countDocuments({})).toBe(2);
  });

  it('skips a deleted office', async () => {
    await kpms().insertOne(office({ deletedAt: NOW }));

    expect(await up(db(), NOW)).toEqual({ seeded: 0, skipped: 0, fellBackToDefaults: 0 });
    expect(await col('activationTemplates').countDocuments({})).toBe(0);
  });
});
