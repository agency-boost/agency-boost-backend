import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0036-company-kind';

/**
 * P18.9-T3 AC-1. Every company that predates `companies.kind` is an insurer; a company that has a kind keeps it —
 * the Template `0037` writes included — and a second run changes nothing.
 */
describe('0036 — every existing company is an insurer', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const companies = () => db().collection('companies');

  beforeEach(async () => {
    await clearCollections();
    await companies().deleteMany({});
  });

  it('P18.9-T3 AC-1 writes insurer on every company with no kind, deleted ones too, and leaves a kind as it is', async () => {
    await companies().insertMany([
      { name: 'Prudential', slug: 'prudential', deletedAt: null },
      { name: 'Allianz Life', slug: 'allianz-life', deletedAt: null },
      { name: 'Closed Insurer', slug: 'closed', deletedAt: new Date('2026-01-01T00:00:00Z') },
      { name: 'Template', slug: 'template', kind: 'template', deletedAt: null },
    ]);

    expect(await up(db())).toEqual({ updated: 3 });

    const kinds = (await companies().find({}).sort({ slug: 1 }).toArray()).map((c) => [c.slug, c.kind]);
    expect(kinds).toEqual([
      ['allianz-life', 'insurer'], ['closed', 'insurer'], ['prudential', 'insurer'], ['template', 'template'],
    ]);
  });

  it('P18.9-T3 AC-1 runs twice with the same result as running once', async () => {
    await companies().insertOne({ name: 'Prudential', slug: 'prudential', deletedAt: null });
    await up(db());
    const after = await companies().find({}).toArray();

    expect(await up(db())).toEqual({ updated: 0 });
    expect(await companies().find({}).toArray()).toEqual(after);
  });

  it('P18.9-T3 AC-1 finds nothing on an empty database', async () => {
    expect(await up(db())).toEqual({ updated: 0 });
  });
});
