import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import type { HeldFigure } from './production-readings';

const NOW = new Date('2026-09-14T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const OWNER = '66f000000000000000000100';
const RINA = '66f000000000000000000101';
const BUDI = '66f000000000000000000102';
const DEWI = '66f000000000000000000103';
const TARI = '66f000000000000000000104';
const NOBODY = '66f000000000000000000105';
const IDS = [RINA, BUDI, DEWI, TARI, NOBODY];
const M = 1_000_000 * 100;
const AT = new Date('2026-05-20T04:00:00Z');
/** January last year to this September: what the forum's scorecard reads for a meeting this month. */
const RANGE = { from: '2025-01', to: '2026-09' };
const MONTHS = Array.from({ length: 21 }, (_, i) => new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 7));

const office = (kpmId = KPM_A) => RequestContext.tenantRead(kpmId, 'year-to-date-spec');
const imported = (value: number | null) => ({ value, provenance: value === null ? null : 'imported', sourceBatchId: null });
const row = (membershipId: string, month: string, cells: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  kpmId: KPM_A, membershipId, month, agentCode: membershipId.slice(-3), deletedAt: null, ...cells, ...more,
});
/** A month's own APE and policies beside its year to date, as the file carries them. */
const filed = (ytd: number, ape: number, policies: number) => ({
  apeYtd: imported(ytd * M), apeMonthly: imported(ape * M), policyCountMonthly: imported(policies),
});
const held = (minor: number, month: string, corrected = false): HeldFigure => ({
  minor, provenance: corrected ? 'corrected' : 'imported', month, correctedBy: corrected ? OWNER : null, correctedAt: corrected ? AT : null,
});
const next = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 7);

/**
 * **`ProductionReadings.monthCellsAndYearToDateFor`: the month table's cells and each member's year to date, from one
 * read** (the forum's scorecard at 500 members, 2026-10-28). The scorecard read its members' year to date three times
 * beside their cells; now it reads them once. Held here to the readings it replaces — `monthCellsFor`'s cells, and for
 * **every month of the range** the figure `ledgersFor` gives (December's `yearToDate`, any other month's next month's
 * `throughLastMonth`) and the single-member `apeYearToDateThrough` — over January, months with no figure held (no row, a
 * cell never given, a cell emptied by hand), a correction, a leaver, a deleted row and another office's row.
 */
describe('the month cells and the year to date, from one read (ProductionReadings.monthCellsAndYearToDateFor)', () => {
  let wired: ReturnType<typeof configModule>;
  const readings = () => wired.productionReadings;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await clearCollections();
    await mongoose.connection.db!.collection('monthlyAgentData').insertMany([
      // Rina: last year in three months; this year with a month missing (February, August), a cell never given (April),
      // a correction (May), a figure emptied by hand (June) — and October's, after the range.
      row(RINA, '2025-01', filed(10, 10, 1)), row(RINA, '2025-06', filed(60, 50, 2)), row(RINA, '2025-12', filed(120, 60, 3)),
      row(RINA, '2026-01', { ...filed(15, 15, 1), persistencyMonthly: imported(92) }), row(RINA, '2026-03', filed(45, 30, 2)),
      row(RINA, '2026-04', { apeYtd: imported(null), apeMonthly: imported(0), policyCountMonthly: imported(0) }),
      row(RINA, '2026-05', { ...filed(75, 30, 1), apeYtd: { value: 75 * M, provenance: 'corrected', sourceBatchId: null, correctedBy: OWNER, correctedAt: AT, reason: 'Restated' } }),
      row(RINA, '2026-06', { apeYtd: { value: null, provenance: 'corrected', correctedBy: OWNER, correctedAt: AT, reason: 'Wrong agent' } }),
      row(RINA, '2026-07', filed(105, 30, 1)), row(RINA, '2026-09', filed(135, 30, 2)), row(RINA, '2026-10', filed(150, 15, 1)),
      // Budi left in April: his file stops there.
      row(BUDI, '2026-01', filed(20, 20, 1)), row(BUDI, '2026-02', filed(40, 20, 1)), row(BUDI, '2026-03', filed(60, 20, 1)),
      row(BUDI, '2026-04', filed(80, 20, 1)),
      // Dewi: last year's December, then nothing until March — no row carries a year to date of hers in January.
      row(DEWI, '2025-12', filed(300, 30, 3)), row(DEWI, '2026-03', filed(30, 30, 3)),
      // Tari: February's figure, and May's row deleted.
      row(TARI, '2026-02', filed(25, 25, 1)), row(TARI, '2026-05', filed(999, 999, 9), { deletedAt: AT }),
      // Another office's row, filed against Rina's membership id: never hers here.
      { ...row(RINA, '2026-08', filed(999, 999, 9)), kpmId: KPM_B },
    ] as never);
    // Nothing in flight when a read's queries are counted: the log is the connection's, and a model's automatic index
    // build still running lands in whichever capture it overlaps (`scorecard.performance.spec.ts`'s note).
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  }, 120_000);
  afterAll(async () => {
    mongoose.set('debug', false);
    await stopMongo();
  });

  /** A read, with every query it sends counted. */
  const counted = async <T>(read: () => Promise<T>): Promise<{ result: T; queries: string[] }> => {
    const queries: string[] = [];
    mongoose.set('debug', (collection: string, method: string) => { queries.push(`${collection}.${method}`); });
    try {
      return { result: await read(), queries };
    } finally {
      mongoose.set('debug', false);
    }
  };

  it('answers monthCellsFor’s cells, in one query for the whole list', async () => {
    const { result, queries } = await counted(() => readings().monthCellsAndYearToDateFor(office(), IDS, RANGE));
    expect(queries).toEqual(['monthlyAgentData.find']);
    expect(result.cells).toEqual(await readings().monthCellsFor(office(), IDS, RANGE));
    // Spelled out for two: a leaver's file stops with him, and nobody's row is no month at all.
    expect([...result.cells.get(BUDI)!.keys()].sort()).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    expect(result.cells.get(RINA)!.get('2026-01')).toEqual({ apeMonthly: 15 * M, policyCountMonthly: 1, persistencyMonthly: 92 });
    expect(result.cells.get(NOBODY)).toEqual(new Map());
  });

  it('answers through every month of the range what ledgersFor and apeYearToDateThrough answer, for every member', async () => {
    const read = await readings().monthCellsAndYearToDateFor(office(), IDS, RANGE);
    for (const month of MONTHS) {
      const mine = read.apeYearToDateThrough(IDS, month);
      // `ledgersFor`'s reading of the year to date at the end of a month, as the scorecard took it until 2026-10-28.
      const december = month.endsWith('-12');
      const ledgers = await readings().ledgersFor(office(), IDS, december ? month : next(month));
      for (const id of IDS) {
        const standing = ledgers.get(id)!.standing;
        const single = await readings().apeYearToDateThrough(office(), id, month);
        expect({ id, month, figure: mine.get(id) })
          .toEqual({ id, month, figure: december ? standing.yearToDate : standing.throughLastMonth });
        expect({ id, month, figure: mine.get(id) }).toEqual({ id, month, figure: single });
      }
    }
  });

  it('January is its own figure, never last December’s; a month with no figure held reads the latest before it', async () => {
    const read = await readings().monthCellsAndYearToDateFor(office(), IDS, RANGE);
    const through = (month: string) => read.apeYearToDateThrough(IDS, month);
    // December: the year's latest.
    expect(through('2025-12').get(RINA)).toEqual(held(120 * M, '2025-12'));
    // January: Rina's own; Dewi has none, whatever last December held.
    expect(through('2026-01').get(RINA)).toEqual(held(15 * M, '2026-01'));
    expect(through('2026-01').get(DEWI)).toBeNull();
    // No February row: January's. April's cell never given: March's. June's emptied by hand: May's correction, whose.
    expect(through('2026-02').get(RINA)).toEqual(held(15 * M, '2026-01'));
    expect(through('2026-04').get(RINA)).toEqual(held(45 * M, '2026-03'));
    expect(through('2026-06').get(RINA)).toEqual(held(75 * M, '2026-05', true));
    // No August row here — another office's is not hers; September's own, and October's after it never read.
    expect(through('2026-08').get(RINA)).toEqual(held(105 * M, '2026-07'));
    expect(through('2026-09').get(RINA)).toEqual(held(135 * M, '2026-09'));
  });

  it('a leaver’s year to date stays the last one their file gave; a deleted row is never read; nobody is null', async () => {
    const read = await readings().monthCellsAndYearToDateFor(office(), IDS, RANGE);
    const september = read.apeYearToDateThrough(IDS, '2026-09');
    expect(september.get(BUDI)).toEqual(held(80 * M, '2026-04'));
    expect(read.apeYearToDateThrough([TARI], '2026-05').get(TARI)).toEqual(held(25 * M, '2026-02'));
    expect(september.get(NOBODY)).toBeNull();
    // The members asked about, each once, in the order asked.
    expect([...read.apeYearToDateThrough([DEWI, RINA], '2026-03').keys()]).toEqual([DEWI, RINA]);
  });

  it('reads one office: another office reads its own row under the same membership, and none of this one’s', async () => {
    const read = await readings().monthCellsAndYearToDateFor(office(KPM_B), [RINA], RANGE);
    expect([...read.cells.get(RINA)!.keys()]).toEqual(['2026-08']);
    expect(read.apeYearToDateThrough([RINA], '2026-09').get(RINA)).toEqual(held(999 * M, '2026-08'));
  });

  it('refuses a month whose January was not read, a month past the range, a month that is none, and a member not read', async () => {
    const read = await readings().monthCellsAndYearToDateFor(office(), [RINA], { from: '2025-06', to: '2026-09' });
    expect(read.apeYearToDateThrough([RINA], '2026-03').get(RINA)).toEqual(held(45 * M, '2026-03'));
    // 2025's January is before what was read: its figure would miss months.
    expect(() => read.apeYearToDateThrough([RINA], '2025-08')).toThrow(/2025-01 to 2025-08; 2025-06 to 2026-09 was read/);
    expect(() => read.apeYearToDateThrough([RINA], '2026-10')).toThrow(/2026-01 to 2026-10/);
    expect(() => read.apeYearToDateThrough([RINA], 'soon')).toThrow(/through soon/);
    expect(() => read.apeYearToDateThrough([RINA, BUDI], '2026-09')).toThrow(`The year to date of ${BUDI}, whose months were not read.`);
  });

  it('asks nothing for an empty list, and answers nobody', async () => {
    const { result, queries } = await counted(() => readings().monthCellsAndYearToDateFor(office(), [], RANGE));
    expect(queries).toEqual([]);
    expect(result.cells).toEqual(new Map());
    expect(result.apeYearToDateThrough([], '2026-09')).toEqual(new Map());
  });
});
