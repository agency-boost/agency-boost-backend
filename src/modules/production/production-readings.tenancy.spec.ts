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
const NOBODY = '66f000000000000000000104';
const M = 1_000_000 * 100;

const owner = (kpmId = KPM_A) => new RequestContext('u-owner', 'none', {
  membershipId: '66f000000000000000000100', kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 3,
} as never);

const cell = (value: number | null, provenance: 'imported' | 'corrected' | null = value === null ? null : 'imported') =>
  ({ value, provenance, sourceBatchId: null });
/** A row by kode (P19.5-T2): the month's own APE — corrected or not — and the YTD the file carried, kept as a check. */
const row = (kpmId: string, membershipId: string, month: string, ytd: number | null, monthly: number | null, corrected = false) => ({
  kpmId, membershipId, month, agentCode: membershipId.slice(-3), deletedAt: null, templateVersion: 1,
  values: { APE: cell(monthly === null ? null : monthly * M, monthly === null ? null : corrected ? 'corrected' : 'imported') },
  ytdValues: { APE: cell(ytd === null ? null : ytd * M) },
});

/**
 * **`ProductionReadings.standingsFor`: the three single-member figures, for many members at once** (P11-T6
 * AC-9). The roster reads it for everybody it lists in one query; each answer here is held to the
 * single-member reading it batches, so the two can never disagree about whose figure is whose.
 */
describe('production readings, for many members at once (P11-T6)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    await mongoose.connection.db!.collection('monthlyAgentData').insertMany([
      // Rina: July and August on file, September's own APE with its year to date.
      row(KPM_A, RINA, '2026-07', 140, 20), row(KPM_A, RINA, '2026-08', 160, 20), row(KPM_A, RINA, '2026-09', 240, 80),
      // Budi: August's own APE corrected by hand; September's; last year's December.
      row(KPM_A, BUDI, '2025-12', 300, 30), row(KPM_A, BUDI, '2026-08', 90, 10, true), row(KPM_A, BUDI, '2026-09', null, 15),
      // Dewi: a September row with a year to date the file carried and no monthly figure — a check, summed by nothing.
      row(KPM_A, DEWI, '2026-09', 50, null),
      // Another office, filed against Rina's membership id: never hers here.
      row(KPM_B, RINA, '2026-09', 999, 999),
    ] as never);
  });

  /** What the three single-member readings say, for comparison. */
  const single = async (membershipId: string, month: string) => {
    const previous = month.endsWith('-01') ? null : `${month.slice(0, 4)}-${String(Number(month.slice(5)) - 1).padStart(2, '0')}`;
    return {
      yearToDate: await wired.productionReadings.apeYearToDate(owner(), membershipId, month.slice(0, 4)),
      throughLastMonth: previous === null ? null
        : await wired.productionReadings.apeYearToDateThrough(owner(), membershipId, previous),
      thisMonth: await wired.productionReadings.apeForMonth(owner(), membershipId, month),
    };
  };

  it('P11-T6 AC-9 answers each member what the single-member readings answer, in one read', async () => {
    const ids = [RINA, BUDI, DEWI, NOBODY];
    const batch = await wired.productionReadings.standingsFor(owner(), ids, '2026-09');

    for (const id of ids) expect({ id, standing: batch.get(id) }).toEqual({ id, standing: await single(id, '2026-09') });
    // P19.5-T2 AC-7 (R4): the year to date is the months' sum — July, August and September — never the file's 240.
    expect(batch.get(RINA)).toEqual({
      yearToDate: { minor: 120 * M, provenance: 'imported', month: '2026-09', correctedBy: null, correctedAt: null },
      throughLastMonth: { minor: 40 * M, provenance: 'imported', month: '2026-08', correctedBy: null, correctedAt: null },
      thisMonth: { minor: 80 * M, provenance: 'imported', month: '2026-09', correctedBy: null, correctedAt: null },
    });
  });

  it('P19.5-T2 AC-7 a sum with a corrected month keeps the correction’s provenance; last year is not this year', async () => {
    const budi = (await wired.productionReadings.standingsFor(owner(), [BUDI], '2026-09')).get(BUDI);
    expect(budi).toEqual({
      yearToDate: { minor: 25 * M, provenance: 'corrected', month: '2026-09', correctedBy: null, correctedAt: null },
      throughLastMonth: { minor: 10 * M, provenance: 'corrected', month: '2026-08', correctedBy: null, correctedAt: null },
      thisMonth: { minor: 15 * M, provenance: 'imported', month: '2026-09', correctedBy: null, correctedAt: null },
    });
  });

  it('P11-T6 AC-9 January has nothing through last month, and last year is not this year', async () => {
    const january = await wired.productionReadings.standingsFor(owner(), [BUDI, RINA], '2026-01');
    for (const id of [BUDI, RINA]) expect({ id, standing: january.get(id) }).toEqual({ id, standing: await single(id, '2026-01') });
    expect(january.get(BUDI)?.throughLastMonth).toBeNull();
  });

  it('P19.5-T2 AC-15 a year to date the file carried with no month of its own is summed by nothing — nothing held', async () => {
    const august = await wired.productionReadings.standingsFor(owner(), [RINA, DEWI], '2026-08');
    expect(august.get(RINA)).toEqual(await single(RINA, '2026-08'));
    expect(august.get(DEWI)).toEqual({ yearToDate: null, throughLastMonth: null, thisMonth: null });
  });

  it('Phase 15 ledgersFor: the same standing from the same read, the month’s two cells, and who corrected each figure', async () => {
    const at = new Date('2026-09-10T04:00:00Z');
    await mongoose.connection.db!.collection('monthlyAgentData').updateOne(
      { kpmId: KPM_A, membershipId: RINA, month: '2026-09' },
      { $set: { 'values.APE.provenance': 'corrected', 'values.APE.correctedBy': BUDI, 'values.APE.correctedAt': at, 'values.APE.reason': 'Report' } },
    );
    const ledgers = await wired.productionReadings.ledgersFor(owner(), [RINA, NOBODY], '2026-09');
    const standings = await wired.productionReadings.standingsFor(owner(), [RINA, NOBODY], '2026-09');

    expect(ledgers.get(RINA)!.standing).toEqual(standings.get(RINA));
    expect(ledgers.get(RINA)!.standing.thisMonth).toEqual({
      minor: 80 * M, provenance: 'corrected', month: '2026-09', correctedBy: BUDI, correctedAt: at,
    });
    // The year to date cell is the sum through the month, corrected because a month in it was (R4).
    expect(ledgers.get(RINA)!.thisMonthCells).toEqual({
      monthly: { value: 80 * M, provenance: 'corrected', correctedBy: BUDI, correctedAt: at, reason: 'Report' },
      ytd: { value: 120 * M, provenance: 'corrected', correctedBy: BUDI, correctedAt: at, reason: 'Report' },
    });
    // The single reading names the corrector too.
    expect(await wired.productionReadings.apeForMonth(owner(), RINA, '2026-09')).toEqual(ledgers.get(RINA)!.standing.thisMonth);
    // Nobody's row: nothing held, which is not zero.
    expect(ledgers.get(NOBODY)).toEqual({
      standing: { yearToDate: null, throughLastMonth: null, thisMonth: null },
      thisMonthCells: {
        monthly: { value: null, provenance: null, correctedBy: null, correctedAt: null, reason: null },
        ytd: { value: null, provenance: null, correctedBy: null, correctedAt: null, reason: null },
      },
    });
    expect(await wired.productionReadings.ledgersFor(owner(), [], '2026-09')).toEqual(new Map());
    expect((await wired.productionReadings.ledgersFor(owner(), [RINA], 'soon')).get(RINA)!.standing.thisMonth).toBeNull();
  });

  it('P11-T6 AC-9 never reads another office’s figures, filed against the same membership', async () => {
    const asB = await wired.productionReadings.standingsFor(owner(KPM_B), [RINA], '2026-09');
    expect(asB.get(RINA)?.thisMonth).toEqual({ minor: 999 * M, provenance: 'imported', month: '2026-09', correctedBy: null, correctedAt: null });
    const asA = await wired.productionReadings.standingsFor(owner(), [RINA], '2026-09');
    expect(asA.get(RINA)?.thisMonth?.minor).toBe(80 * M);
  });

  it('P11-T6 AC-9 answers nobody for an empty list, and nothing held for a month that is not one', async () => {
    expect(await wired.productionReadings.standingsFor(owner(), [], '2026-09')).toEqual(new Map());
    expect((await wired.productionReadings.standingsFor(owner(), [RINA], 'soon')).get(RINA))
      .toEqual({ yearToDate: null, throughLastMonth: null, thisMonth: null });
  });
});
