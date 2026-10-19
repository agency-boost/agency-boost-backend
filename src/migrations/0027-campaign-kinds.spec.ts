import mongoose from 'mongoose';
import { CAMPAIGN_POSTER_COLORS, DEFAULT_CAMPAIGN_POSTER } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0027-campaign-kinds';

const NOW = new Date('2026-10-10T02:00:00Z');

/** A campaign as Phase 5 wrote it: dates, requirements, a reward — none of the card's fields. */
const phase5 = (kpmId: string, code: string) => ({
  kpmId, code, title: code, description: '', startsAt: new Date('2026-09-01T00:00:00Z'),
  endsAt: new Date('2026-11-30T16:59:00Z'), requirements: [], reward: '', version: 1, status: 'active',
  archivedAt: null, deletedAt: null,
});

/**
 * P18.5-T7 AC-9 (D-fields). Every campaign written before the agent's card becomes what it was — seasonal, over its
 * own dates, open to everybody, the default poster, no blurb — and nothing else of it changes. Recorded (its counts)
 * and idempotent: a second run changes nothing, and a field an Owner set is never overwritten.
 */
describe('0027 — the campaign card’s fields, for the campaigns that predate them', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const campaigns = () => db().collection('campaigns');

  beforeEach(async () => {
    await clearCollections();
    await campaigns().deleteMany({});
  });

  it('P18.5-T7 AC-9 gives every old campaign the seasonal defaults, and touches nothing else', async () => {
    await campaigns().insertMany([phase5('kpm-a', 'YEAR_END_DRIVE'), phase5('kpm-b', 'GADING_PUSH')]);
    const before = await campaigns().findOne({ code: 'YEAR_END_DRIVE' });

    expect(await up(db(), NOW)).toEqual({ updated: 2, current: 0 });

    const after = await campaigns().findOne({ code: 'YEAR_END_DRIVE' });
    expect(after).toMatchObject({
      kind: 'seasonal', subtype: null, window: 'campaign_dates', appliesToOrgLevelCodes: [],
      poster: { emoji: DEFAULT_CAMPAIGN_POSTER.emoji, color: DEFAULT_CAMPAIGN_POSTER.color }, blurb: '', updatedAt: NOW,
    });
    // Its dates, requirements and reward as they were: snapping to whole months is the Owner's call.
    expect(after!.startsAt).toEqual(before!.startsAt);
    expect(after!.endsAt).toEqual(before!.endsAt);
    expect(after!.version).toBe(1);
    // The default it writes is the constant's, and a colour of the palette.
    expect(CAMPAIGN_POSTER_COLORS).toContain(after!.poster.color);
  });

  it('P18.5-T7 AC-9 is idempotent: a second run changes nothing', async () => {
    await campaigns().insertOne(phase5('kpm-a', 'YEAR_END_DRIVE'));
    await up(db(), NOW);
    const once = await campaigns().findOne({ code: 'YEAR_END_DRIVE' });

    expect(await up(db(), new Date('2026-10-11T02:00:00Z'))).toEqual({ updated: 0, current: 1 });
    expect(await campaigns().findOne({ code: 'YEAR_END_DRIVE' })).toEqual(once);
  });

  it('P18.5-T7 AC-9 never overwrites a field already set, and fills only what is missing', async () => {
    await campaigns().insertOne({
      ...phase5('kpm-a', 'MDRT_QUALIFICATION'), kind: 'structural', subtype: 'ongoing', window: 'calendar_year',
      poster: { emoji: '🏆', color: 'gold' }, endsAt: null,
    });

    expect(await up(db(), NOW)).toEqual({ updated: 1, current: 0 });
    expect(await campaigns().findOne({ code: 'MDRT_QUALIFICATION' })).toMatchObject({
      kind: 'structural', subtype: 'ongoing', window: 'calendar_year', poster: { emoji: '🏆', color: 'gold' },
      appliesToOrgLevelCodes: [], blurb: '', endsAt: null,
    });
  });
});
