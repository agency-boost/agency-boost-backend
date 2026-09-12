import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0005-ratio-origin-and-applicability';

/**
 * P4-T15. Both new fields carry a schema default, and for the rows that already exist the
 * default is wrong in the way that matters: `origin` defaults to `office`, which would
 * leave all five formulas editable in exactly the offices provisioned before ADR-0021.
 *
 * The pair worth pinning is the pair that is easy to get wrong — a seeded code becomes
 * `platform`, and a ratio the office genuinely created stays `office`.
 */
describe('0005 — ratio origin and applicability', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const ratios = () => db().collection('ratioDefinitions');

  beforeEach(async () => {
    await clearCollections();
    await ratios().deleteMany({});
  });

  const row = (over: Record<string, unknown>) => ({
    kpmId: 'kpm-a', label: 'x', numerator: ['A'], denominator: ['B'],
    benchmark: 1, comparison: 'gte', displayOrder: 1, version: 1,
    status: 'active', archivedAt: null, deletedAt: null, ...over,
  });

  it('marks a seeded code `platform` and an office’s own `office`', async () => {
    await ratios().insertMany([
      row({ code: 'SELLING_SUCCESS_RATE' }),
      row({ code: 'OUR_OWN_THING', displayOrder: 6 }),
    ]);

    const result = await up(db());

    expect(result).toMatchObject({ platform: 1, office: 1 });
    const byCode = new Map(
      (await ratios().find({}).toArray()).map((r) => [String(r.code), r]),
    );
    expect(byCode.get('SELLING_SUCCESS_RATE')!.origin).toBe('platform');
    expect(byCode.get('OUR_OWN_THING')!.origin).toBe('office');
  });

  it('gives the two recruitment ratios the rungs that recruit', async () => {
    await ratios().insertMany([
      row({ code: 'SELLING_VS_RECRUITMENT' }),
      row({ code: 'RECRUITMENT_SUCCESS_RATE', displayOrder: 3 }),
      row({ code: 'SELLING_SUCCESS_RATE', displayOrder: 2 }),
    ]);

    await up(db());

    const byCode = new Map(
      (await ratios().find({}).toArray()).map((r) => [String(r.code), r]),
    );
    expect(byCode.get('SELLING_VS_RECRUITMENT')!.appliesToOrgLevelCodes).toEqual(['AB', 'AAB']);
    expect(byCode.get('RECRUITMENT_SUCCESS_RATE')!.appliesToOrgLevelCodes).toEqual(['AB', 'AAB']);
    // Everything else keeps the empty list, which means every rung.
    expect(byCode.get('SELLING_SUCCESS_RATE')!.appliesToOrgLevelCodes).toBeUndefined();
  });

  it('never overwrites an applicability an Owner has already narrowed', async () => {
    // The one that would be silent: a seed default landing on top of a deliberate choice.
    await ratios().insertOne(
      row({ code: 'SELLING_VS_RECRUITMENT', appliesToOrgLevelCodes: ['AGENT'] }),
    );

    const result = await up(db());

    expect(result.scoped).toBe(0);
    const [saved] = await ratios().find({}).toArray();
    expect(saved.appliesToOrgLevelCodes).toEqual(['AGENT']);
    // The origin still moves — that is a different question from applicability.
    expect(saved.origin).toBe('platform');
  });

  it('is idempotent', async () => {
    await ratios().insertMany([
      row({ code: 'SELLING_VS_RECRUITMENT' }),
      row({ code: 'OUR_OWN_THING', displayOrder: 6 }),
    ]);

    await up(db());
    const second = await up(db());

    expect(second).toEqual({ platform: 0, office: 0, scoped: 0 });
  });

  it('does nothing to an empty collection', async () => {
    expect(await up(db())).toEqual({ platform: 0, office: 0, scoped: 0 });
  });
});
