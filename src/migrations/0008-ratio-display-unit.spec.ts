import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0008-ratio-display-unit';

/**
 * P4-T25. The schema default is `decimal`, which is right for three of the five and leaves
 * the two success rates reading `0.15` — the defect this task closes. The pairs worth
 * pinning are the ones a blanket default gets wrong.
 */
describe('0008 — ratio display unit', () => {
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
    benchmark: 1, comparison: 'gte', displayOrder: 1, version: 1, origin: 'platform',
    status: 'active', archivedAt: null, deletedAt: null, ...over,
  });

  const unitOf = async (code: string) =>
    (await ratios().findOne({ code }))!.displayUnit as string;

  it('gives each seeded ratio the unit the registry states', async () => {
    await ratios().insertMany([
      row({ code: 'SELLING_VS_RECRUITMENT', comparison: 'band', benchmark: 30 }),
      row({ code: 'SELLING_SUCCESS_RATE', benchmark: 0.15 }),
      row({ code: 'RECRUITMENT_SUCCESS_RATE', benchmark: 0.15 }),
      row({ code: 'LEADS_PER_ACTIVITY', benchmark: 0.3 }),
      row({ code: 'MEETING_PER_APPROACH', benchmark: 1.5 }),
    ]);

    expect(await up(db())).toEqual({ filled: 5 });

    expect(await unitOf('SELLING_VS_RECRUITMENT')).toBe('points');
    expect(await unitOf('SELLING_SUCCESS_RATE')).toBe('percent');
    expect(await unitOf('RECRUITMENT_SUCCESS_RATE')).toBe('percent');
    expect(await unitOf('LEADS_PER_ACTIVITY')).toBe('decimal');
    expect(await unitOf('MEETING_PER_APPROACH')).toBe('decimal');
  });

  it('lets a row’s rule outrank its seed', async () => {
    // An Owner turned a seeded ratio into a band. A band is judged in points.
    await ratios().insertOne(row({ code: 'LEADS_PER_ACTIVITY', comparison: 'band' }));
    await up(db());
    expect(await unitOf('LEADS_PER_ACTIVITY')).toBe('points');
  });

  it('gives an office’s own ratio the rule’s default', async () => {
    await ratios().insertMany([
      row({ code: 'REFERRAL_RATE', origin: 'office' }),
      row({ code: 'REFERRAL_LEAN', origin: 'office', comparison: 'band' }),
    ]);
    await up(db());
    expect(await unitOf('REFERRAL_RATE')).toBe('decimal');
    expect(await unitOf('REFERRAL_LEAN')).toBe('points');
  });

  it('never overwrites a unit a row already has', async () => {
    await ratios().insertOne(row({ code: 'LEADS_PER_ACTIVITY', displayUnit: 'percent' }));
    expect(await up(db())).toEqual({ filled: 0 });
    expect(await unitOf('LEADS_PER_ACTIVITY')).toBe('percent');
  });

  it('is idempotent', async () => {
    await ratios().insertOne(row({ code: 'SELLING_SUCCESS_RATE' }));
    await up(db());
    expect(await up(db())).toEqual({ filled: 0 });
  });
});
