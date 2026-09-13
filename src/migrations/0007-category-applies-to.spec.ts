import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0007-category-applies-to';

/**
 * The point is not the value — an empty list is the right default — it is the difference
 * between a key that is **empty** and a key that is **absent**. `list()` reads
 * `category.appliesToOrgLevelCodes` on every settings load, and `undefined.length` throws.
 */
describe('0007 — applies-to on every activity category', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const categories = () => db().collection('activityCategories');

  beforeEach(async () => {
    await clearCollections();
    await categories().deleteMany({});
  });

  it('fills the absent keys and leaves an existing choice alone', async () => {
    await categories().insertMany([
      { kpmId: 'k1', code: 'SELLING', label: 'Selling', displayOrder: 1 },
      {
        kpmId: 'k1', code: 'RECRUITMENT', label: 'Recruitment', displayOrder: 2,
        appliesToOrgLevelCodes: ['AB'], description: 'Theirs',
      },
    ]);

    expect(await up(db())).toEqual({ filled: 1 });

    const rows = await categories().find({}).sort({ displayOrder: 1 }).toArray();
    expect(rows[0].appliesToOrgLevelCodes).toEqual([]);
    expect(rows[0].description).toBeNull();
    // The one that had already been narrowed keeps its answer.
    expect(rows[1].appliesToOrgLevelCodes).toEqual(['AB']);
    expect(rows[1].description).toBe('Theirs');
  });

  it('is idempotent', async () => {
    await categories().insertOne({ kpmId: 'k1', code: 'SELLING', label: 'S', displayOrder: 1 });
    await up(db());
    expect(await up(db())).toEqual({ filled: 0 });
  });

  it('does nothing to an empty collection', async () => {
    expect(await up(db())).toEqual({ filled: 0 });
  });
});
