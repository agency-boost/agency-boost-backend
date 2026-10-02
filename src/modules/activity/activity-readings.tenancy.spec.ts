import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

const NOW = new Date('2026-09-14T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const RINA = '66f000000000000000000101';
const BUDI = '66f000000000000000000102';
const DEWI = '66f000000000000000000103';

const leader = (kpmId = KPM_A) => new RequestContext('u-ab', 'none', {
  membershipId: '66f000000000000000000100', kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 3,
} as never);

const day = (kpmId: string, membershipId: string, localDate: string, counts: Record<string, number>, deletedAt: Date | null = null) => ({
  kpmId, membershipId, localDate, deletedAt, source: 'self', enteredByMembershipId: membershipId, version: 1,
  frozenAt: null, corrections: [],
  entries: Object.entries(counts).map(([code, count]) => ({ activityTypeId: `t-${code}`, activityTypeCode: code, count })),
  totalCount: Object.values(counts).reduce((sum, n) => sum + n, 0),
});

/**
 * **`ActivityReadings.countsOverMany`: `countsOver`, for many members at once** (P11-T6 AC-9). The roster
 * counts the month for everybody it lists in one aggregate; each member's answer is held to the
 * single-member reading.
 */
describe('activity readings, for many members at once (P11-T6)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    await mongoose.connection.db!.collection('activityLogs').insertMany([
      day(KPM_A, RINA, '2026-08-31', { LEADS_CONTACTED: 50 }),
      day(KPM_A, RINA, '2026-09-01', { LEADS_CONTACTED: 2, SELL_PRESENTATION: 1 }),
      day(KPM_A, RINA, '2026-09-14', { LEADS_CONTACTED: 3, RETIRED_TYPE: 4 }),
      day(KPM_A, BUDI, '2026-09-10', { SELL_SUBMISSION: 1 }),
      day(KPM_A, BUDI, '2026-09-11', { SELL_SUBMISSION: 9 }, NOW),
      // Another office's row against Rina's id: never hers here.
      day(KPM_B, RINA, '2026-09-05', { LEADS_CONTACTED: 100 }),
    ] as never);
  });

  const SEPTEMBER = { from: '2026-09-01', to: '2026-09-14' };

  it('P11-T6 AC-9 answers each member’s counts as countsOver does, archived codes included', async () => {
    const many = await wired.activityReadings.countsOverMany(leader(), [RINA, BUDI, DEWI], SEPTEMBER);

    expect(many.get(RINA)).toEqual(new Map([['LEADS_CONTACTED', 5], ['SELL_PRESENTATION', 1], ['RETIRED_TYPE', 4]]));
    for (const id of [RINA, BUDI]) {
      expect({ id, counts: many.get(id) })
        .toEqual({ id, counts: await wired.activityReadings.countsOver(leader(), id, SEPTEMBER) });
    }
    // A member with no day in the window is absent, as an empty `countsOver` is empty.
    expect(many.has(DEWI)).toBe(false);
  });

  it('P11-T6 AC-9 counts only the window, never a deleted day, and never another office’s', async () => {
    const many = await wired.activityReadings.countsOverMany(leader(), [RINA, BUDI], SEPTEMBER);
    expect(many.get(BUDI)).toEqual(new Map([['SELL_SUBMISSION', 1]]));
    expect(many.get(RINA)?.get('LEADS_CONTACTED')).toBe(5);

    const asB = await wired.activityReadings.countsOverMany(leader(KPM_B), [RINA], SEPTEMBER);
    expect(asB.get(RINA)).toEqual(new Map([['LEADS_CONTACTED', 100]]));
  });

  it('P11-T6 AC-9 asks nothing for an empty list', async () => {
    expect(await wired.activityReadings.countsOverMany(leader(), [], SEPTEMBER)).toEqual(new Map());
  });
});
