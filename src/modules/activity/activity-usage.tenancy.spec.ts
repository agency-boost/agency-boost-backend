import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { addDays } from '@/common/time/local-day';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

/** 10:00 on Friday 20 November 2026 in Jakarta. */
const NOW = new Date('2026-11-20T03:00:00Z');
const TODAY = '2026-11-20';
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const RINA = '66f000000000000000000101';
const BUDI = '66f000000000000000000102';
const DEWI = '66f000000000000000000103';
const SITI = '66f000000000000000000104';

const leader = (kpmId = KPM_A) => new RequestContext('u-ab', 'none', {
  membershipId: '66f000000000000000000100', kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 4,
} as never);

const day = (kpmId: string, membershipId: string, localDate: string, total: number, deletedAt: Date | null = null) => ({
  kpmId, membershipId, localDate, deletedAt, source: 'self', enteredByMembershipId: membershipId, version: 1,
  frozenAt: null, corrections: [],
  entries: total === 0 ? [] : [{ activityTypeId: 't-LEADS_CONTACTED', activityTypeCode: 'LEADS_CONTACTED', count: total }],
  totalCount: total,
});

/**
 * **`ActivityReadings.usageOf`: each person's use of the app** (P19.17-T1 AC-4; ADR-0267 §4): *Pakai* in a period,
 * *Pernah pakai*, *Pakai 14 hari terakhir*, the days of the last 30 and *Power user ★* — a saved day, an all-zero one
 * included (ADR-0042), office days throughout, within the office.
 */
describe('usage per person, read (P19.17-T1 AC-4)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    const rows = [
      // Rina: ten days of the last thirty, every third day back from today — a power user, today the latest.
      ...Array.from({ length: 10 }, (_, i) => day(KPM_A, RINA, addDays(TODAY, -3 * i), 1)),
      // Budi: an all-zero day 14 days back (it counts), and an older one in October.
      day(KPM_A, BUDI, '2026-11-06', 0),
      day(KPM_A, BUDI, '2026-10-02', 4),
      // Dewi: last in August, so > 14 hari; a deleted day yesterday never reads.
      day(KPM_A, DEWI, '2026-08-15', 2),
      day(KPM_A, DEWI, '2026-11-19', 5, NOW),
      // Another office's days against Siti's id: never hers here.
      ...Array.from({ length: 12 }, (_, i) => day(KPM_B, SITI, addDays(TODAY, -i), 1)),
    ];
    await mongoose.connection.db!.collection('activityLogs').insertMany(rows as never);
  });

  const NOVEMBER = { from: '2026-11-01', to: '2026-11-30' };

  it('P19.17-T1 AC-4 reads each person’s usage, every one asked about answered', async () => {
    const usage = await wired.activityReadings.usageOf(leader(), [RINA, BUDI, DEWI, SITI], TODAY, NOVEMBER);

    expect(usage.get(RINA)).toEqual({
      lastLoggedOn: TODAY, everLogged: true, daysSinceLastLogged: 0, usedLast14Days: true,
      daysLoggedLast30: 10, powerUser: true, status: 'recent', usedInPeriod: true,
    });
    expect(usage.get(BUDI)).toEqual({
      lastLoggedOn: '2026-11-06', everLogged: true, daysSinceLastLogged: 14, usedLast14Days: true,
      daysLoggedLast30: 1, powerUser: false, status: 'recent', usedInPeriod: true,
    });
    expect(usage.get(DEWI)).toMatchObject({
      lastLoggedOn: '2026-08-15', daysSinceLastLogged: 97, usedLast14Days: false, daysLoggedLast30: 0,
      status: 'lapsed', usedInPeriod: false,
    });
    // Siti logged only in another office: nothing here, Belum pernah.
    expect(usage.get(SITI)).toMatchObject({ everLogged: false, status: 'never', daysLoggedLast30: 0, usedInPeriod: false });
  });

  it('P19.17-T1 AC-4 reads a period outside the last 30 days with its own read: Pakai in October', async () => {
    const usage = await wired.activityReadings.usageOf(leader(), [BUDI, DEWI], TODAY, { from: '2026-10-01', to: '2026-10-31' });
    expect(usage.get(BUDI)?.usedInPeriod).toBe(true);
    expect(usage.get(DEWI)?.usedInPeriod).toBe(false);
  });

  it('P19.17-T1 AC-4 answers Pakai only for a period asked about, and nothing for an empty list', async () => {
    expect((await wired.activityReadings.usageOf(leader(), [RINA], TODAY)).get(RINA)?.usedInPeriod).toBeNull();
    expect(await wired.activityReadings.usageOf(leader(), [], TODAY)).toEqual(new Map());
  });

  it('P19.17-T1 AC-4 reads the other office’s own days there, and never this office’s (cross-tenant)', async () => {
    const asB = await wired.activityReadings.usageOf(leader(KPM_B), [SITI, RINA], TODAY, NOVEMBER);
    expect(asB.get(SITI)).toMatchObject({ daysLoggedLast30: 12, powerUser: true, status: 'recent' });
    expect(asB.get(RINA)).toMatchObject({ everLogged: false, status: 'never' });
  });
});
