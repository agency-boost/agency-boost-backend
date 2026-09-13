import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0006-company-templates';

/**
 * ADR-0023. A rename with no field changes, so what is worth pinning is not the data —
 * it is the three states the migration can meet: not yet moved, already moved, and the
 * ambiguous half-state that must refuse rather than guess.
 */
describe('0006 — platformTemplates becomes companyTemplates', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;

  beforeEach(async () => {
    await clearCollections();
    for (const name of ['platformTemplates', 'companyTemplates']) {
      const exists = (await db().listCollections().toArray()).some((c) => c.name === name);
      if (exists) await db().collection(name).drop();
    }
  });

  const template = (kind: string) => ({
    companyId: 'co-1', kind, version: 1, status: 'published',
    payload: { categories: [], types: [] }, publishedAt: new Date(), deletedAt: null,
  });

  it('moves every row under the new name', async () => {
    await db().collection('platformTemplates')
      .insertMany([template('activity_taxonomy'), template('lead_pipeline')]);

    const result = await up(db());

    expect(result.moved).toBe(2);
    expect(await db().collection('companyTemplates').countDocuments({})).toBe(2);
    const names = (await db().listCollections().toArray()).map((c) => c.name);
    expect(names).not.toContain('platformTemplates');
  });

  it('is a no-op on a database that has already moved', async () => {
    await db().collection('companyTemplates').insertOne(template('ratio_set'));
    expect(await up(db())).toEqual({ moved: 0, how: 'none' });
    expect(await db().collection('companyTemplates').countDocuments({})).toBe(1);
  });

  it('does nothing to a database that has neither', async () => {
    expect(await up(db())).toEqual({ moved: 0, how: 'none' });
  });

  it('is not fooled by the empty collection Mongoose leaves behind', async () => {
    /*
     * Registering the renamed model creates `companyTemplates` immediately, so every
     * machine that ran the API after the rename landed has one sitting empty beside the
     * real data. Refusing on mere existence made this migration unrunnable on the machine
     * it was written on, which is how the case was found.
     */
    await db().collection('platformTemplates').insertOne(template('activity_taxonomy'));
    await db().createCollection('companyTemplates');

    const result = await up(db());

    expect(result.moved).toBe(1);
    expect(await db().collection('companyTemplates').countDocuments({})).toBe(1);
    const names = (await db().listCollections().toArray()).map((c) => c.name);
    expect(names).not.toContain('platformTemplates');
  });

  it('refuses a half-moved database rather than merging it', async () => {
    /*
     * The state a killed run leaves behind. Merging would mean choosing which copy is
     * real, and nothing in the rows says — both carry the same `(companyId, kind,
     * version)`. Refusing names what to look at.
     */
    await db().collection('platformTemplates').insertOne(template('activity_taxonomy'));
    await db().collection('companyTemplates').insertOne(template('activity_taxonomy'));

    await expect(up(db())).rejects.toThrow(/stopped\s+halfway/);
    // And it left both alone.
    expect(await db().collection('platformTemplates').countDocuments({})).toBe(1);
    expect(await db().collection('companyTemplates').countDocuments({})).toBe(1);
  });

  it('does not touch the audit log', async () => {
    // ADR-0023: an append-only evidence log is not rewritten for a rename. The audit
    // screen aliases the old strings at render time instead.
    await db().collection('platformTemplates').insertOne(template('activity_taxonomy'));
    await db().collection('auditLog').insertOne({
      action: 'platform_template.published', targetCollection: 'platformTemplates',
      createdAt: new Date(),
    });

    await up(db());

    const [row] = await db().collection('auditLog').find({}).toArray();
    expect(row.action).toBe('platform_template.published');
    expect(row.targetCollection).toBe('platformTemplates');
  });
});
