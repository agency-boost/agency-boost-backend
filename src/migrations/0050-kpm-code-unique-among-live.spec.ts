import mongoose from 'mongoose';
import { startMongo, stopMongo } from '../../test/mongo';
import { up } from './0050-kpm-code-unique-among-live';

const COMPANY = '66f00000000000000000c001';

/**
 * **A KPM code is unique among an insurer's live offices** (P19-T3, ADR-0191 §3, §5): the old index — every office,
 * deleted ones included — is dropped, the new one keeps two live offices from sharing a code and lets a deleted one give
 * its code back, and a second run, or a run on a database with no offices, does nothing.
 */
describe('0050 — a KPM code is unique among live offices (P19-T3)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    for (const { name } of await db().listCollections({ name: 'kpms' }, { nameOnly: true }).toArray()) {
      await db().collection(name).drop();
    }
  });

  const office = (code: string, deletedAt: Date | null = null) => ({
    _id: new mongoose.Types.ObjectId(), companyId: COMPANY, code, branchName: `Branch ${code}`, deletedAt,
  });

  it('P19-T3 AC-7 replaces the old index, frees a deleted office’s code, still refuses two live ones, and runs twice', async () => {
    const kpms = db().collection('kpms');
    await kpms.createIndex({ companyId: 1, code: 1 }, { unique: true });
    await kpms.insertOne(office('2001', new Date('2026-11-04T02:00:00Z')));

    expect(await up(db())).toEqual({ dropped: true, created: true });
    const names = (await kpms.indexes()).map((i) => i.name);
    expect(names).toContain('one_live_code_per_company');
    expect(names).not.toContain('companyId_1_code_1');

    // The deleted 2001 holds nothing now: a live one may take the code.
    await expect(kpms.insertOne(office('2001'))).resolves.toBeTruthy();
    // And two live offices still may not share it.
    await expect(kpms.insertOne(office('2001'))).rejects.toMatchObject({ code: 11000 });

    expect(await up(db())).toEqual({ dropped: false, created: false });
  });

  it('P19-T3 writes nothing on a database with no offices, twice', async () => {
    expect(await up(db())).toEqual({ dropped: false, created: false });
    expect(await up(db())).toEqual({ dropped: false, created: false });
    expect(await db().listCollections({ name: 'kpms' }).toArray()).toEqual([]);
  });
});
