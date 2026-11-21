import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { seedCompanyConsoleFixture } from '../company-console-fixture';

const PRUDENTIAL = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';
const TEMPLATE = new mongoose.Types.ObjectId('66f0000000000000000000a9');
const KPM_0555 = '66f0000000000000000005a5';

/**
 * ***Perusahaan & template*'s demo data** (P19.23-T4; `company-console-fixture.ts`): the Default template (the Template
 * library), Prudential's *Lead statuses* draft and *PRUWell Medical*, Allianz Life's *AZ SmartHealth* — both released to
 * nobody — and Kelapa Gading's own first sales stage; a second run writes nothing.
 */
describe('the company console seed (P19.23-T4)', () => {
  const clock = new FixedClock(new Date('2026-11-20T03:00:00Z'));
  const db = () => mongoose.connection.db as mongoose.mongo.Db;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await db().collection('companies').insertMany([
      { _id: new mongoose.Types.ObjectId(PRUDENTIAL), name: 'Prudential', slug: 'prudential', kind: 'insurer', deletedAt: null },
      { _id: new mongoose.Types.ObjectId(ALLIANZ), name: 'Allianz Life', slug: 'allianz-life', kind: 'insurer', deletedAt: null },
    ]);
    await db().collection('templates').insertOne({
      _id: TEMPLATE, companyId: PRUDENTIAL, name: 'Prudential template', isDefault: true, status: 'active', deletedAt: null,
    });
    await db().collection('companyTemplates').insertOne({
      companyId: PRUDENTIAL, templateId: String(TEMPLATE), kind: 'lead_pipeline', version: 1, status: 'published',
      payload: { statuses: [{ code: 'NEW', label: 'Prospek', pipeline: 'sales' }, { code: 'CALLED', label: 'Dihubungi', pipeline: 'sales' }] },
      deletedAt: null,
    });
    await db().collection('leadStatuses').insertOne({ kpmId: KPM_0555, code: 'NEW', label: 'Prospek', pipeline: 'sales' });
  }, 120_000);

  afterAll(async () => {
    await stopMongo();
  });

  it('P19.23-T4 seeds the Default template, two companies’ unpublished changes and a KPM’s own setting, once', async () => {
    const { guide } = await seedCompanyConsoleFixture({
      clock, prudentialId: PRUDENTIAL, allianzId: ALLIANZ, kpmChangedId: KPM_0555,
    });
    expect(guide).toMatch(/Terbitkan ke KPM/);
    expect(await db().collection('companies').findOne({ kind: 'template' })).not.toBeNull();
    const draft = await db().collection('companyTemplates').findOne({ companyId: PRUDENTIAL, kind: 'lead_pipeline', status: 'draft' });
    expect(draft).toMatchObject({ version: 2, payload: { statuses: [{ code: 'NEW', label: 'Prospek baru masuk' }, { code: 'CALLED' }] } });
    expect(await db().collection('leadStatuses').findOne({ kpmId: KPM_0555, code: 'NEW' })).toMatchObject({ label: 'Prospek (Kelapa Gading)' });
    expect(await db().collection('products').find({}, { projection: { _id: 0, companyId: 1, code: 1, releasedTo: 1, firstPublishedAt: 1 } }).toArray())
      .toEqual(expect.arrayContaining([
        { companyId: PRUDENTIAL, code: 'PRUWELL_MEDICAL', releasedTo: [], firstPublishedAt: null },
        { companyId: ALLIANZ, code: 'AZ_SMARTHEALTH', releasedTo: [], firstPublishedAt: null },
      ]));

    const count = async () => Object.fromEntries(await Promise.all(
      ['companies', 'templates', 'companyTemplates', 'products'].map(async (c) => [c, await db().collection(c).countDocuments()]),
    ));
    const first = await count();
    await seedCompanyConsoleFixture({ clock, prudentialId: PRUDENTIAL, allianzId: ALLIANZ, kpmChangedId: KPM_0555 });
    expect(await count()).toEqual(first);
  });
});
