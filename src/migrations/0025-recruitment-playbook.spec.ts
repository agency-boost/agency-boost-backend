import mongoose from 'mongoose';
import { SEED_RECRUITMENT_PLAYBOOK } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0025-recruitment-playbook';

const NOW = new Date('2026-10-09T02:00:00Z');

/**
 * P17-T2 AC-3. Every existing company started from the defaults is given version 1 of the AgencyBoost words —
 * a company whose `usesPlatformDefaults` is absent counts as one, as `0017` decided — and a blank company
 * nothing; a company that already has a playbook is skipped whole, never overwritten. Run twice, the second
 * run changes nothing. (Twice over the demo seed: `recruitment-seed.spec.ts`.)
 */
describe('0025 — the recruitment playbook, for the companies that predate it', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const col = (name: string) => db().collection(name);

  beforeEach(async () => {
    await clearCollections();
    for (const name of ['companies', 'recruitmentPlaybooks', 'kpmRecruitmentPitchDocuments']) await col(name).deleteMany({});
  });

  async function companies() {
    const { insertedIds } = await col('companies').insertMany([
      { name: 'Prudential', slug: 'prudential', deletedAt: null },
      { name: 'Allianz Life', slug: 'allianz-life', usesPlatformDefaults: true, deletedAt: null },
      { name: 'Sejahtera Baru Life', slug: 'sejahtera-baru-life', usesPlatformDefaults: false, deletedAt: null },
      { name: 'Closed Insurer', slug: 'closed', usesPlatformDefaults: true, deletedAt: NOW },
    ]);
    return Object.values(insertedIds).map(String);
  }

  it('P17-T2 AC-3 gives every company started from the defaults version 1 of the words, and a blank one none', async () => {
    const [prudential, allianz, blank, closed] = await companies();

    expect(await up(db(), NOW)).toEqual({ given: 2, current: 0, blank: 1 });

    const rows = await col('recruitmentPlaybooks').find({}).sort({ companyId: 1 }).toArray();
    expect(rows.map((r) => r.companyId).sort()).toEqual([prudential, allianz].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        body: SEED_RECRUITMENT_PLAYBOOK, version: 1, updatedBy: null, createdBy: null, deletedAt: null,
        createdAt: NOW, updatedAt: NOW,
      });
    }
    expect(await col('recruitmentPlaybooks').countDocuments({ companyId: { $in: [blank, closed] } })).toBe(0);
  });

  it('P17-T2 AC-3 runs twice with the same result as running once', async () => {
    await companies();
    await up(db(), NOW);
    const after = await col('recruitmentPlaybooks').find({}).sort({ _id: 1 }).toArray();

    expect(await up(db(), new Date('2026-10-10T02:00:00Z'))).toEqual({ given: 0, current: 2, blank: 1 });
    expect(await col('recruitmentPlaybooks').find({}).sort({ _id: 1 }).toArray()).toEqual(after);
  });

  it('P17-T2 AC-3 leaves a playbook a Super Admin already saved as they saved it', async () => {
    const [prudential] = await companies();
    await col('recruitmentPlaybooks').insertOne({
      companyId: prudential, body: { nextAction: 'Their own.' }, version: 4, updatedBy: 'sa', deletedAt: null,
    });

    expect(await up(db(), NOW)).toEqual({ given: 1, current: 1, blank: 1 });
    expect(await col('recruitmentPlaybooks').findOne({ companyId: prudential }))
      .toMatchObject({ body: { nextAction: 'Their own.' }, version: 4 });
  });

  it('touches no office: the pitch documents are not opened', async () => {
    await companies();
    await col('kpmRecruitmentPitchDocuments').insertOne({ kpmId: 'k', slot: 'faq', version: 3, deletedAt: null });
    await up(db(), NOW);
    expect(await col('kpmRecruitmentPitchDocuments').find({}).toArray()).toMatchObject([{ kpmId: 'k', slot: 'faq', version: 3 }]);
  });
});
