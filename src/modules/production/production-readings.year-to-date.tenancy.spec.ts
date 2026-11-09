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
  kpmId: KPM_A, membershipId, month, agentCode: membershipId.slice(-3), deletedAt: null, templateVersion: 1, ...cells, ...more,
});
/**
 * A month's own APE and policies, by kode (P19.5-T2), beside the year to date the file carried — kept as a check in
 * `ytdValues` and summed by nothing: every year to date below is the months' APE added (R4).
 */
const filed = (ytd: number, ape: number, policies: number, extra: Record<string, unknown> = {}) => ({
  values: { APE: imported(ape * M), POLICY_COUNT: imported(policies), ...extra }, ytdValues: { APE: imported(ytd * M) },
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
      // Rina: last year in three months; this year with a month missing (February, August), a zero (April), a month
      // corrected (May), one emptied by hand (June) — and October's, after the range.
      row(RINA, '2025-01', filed(10, 10, 1)), row(RINA, '2025-06', filed(60, 50, 2)), row(RINA, '2025-12', filed(120, 60, 3)),
      row(RINA, '2026-01', filed(15, 15, 1, { PERSISTENCY: imported(92) })), row(RINA, '2026-03', filed(45, 30, 2)),
      row(RINA, '2026-04', { values: { APE: imported(0), POLICY_COUNT: imported(0) } }),
      row(RINA, '2026-05', { values: { APE: { value: 30 * M, provenance: 'corrected', sourceBatchId: null, correctedBy: OWNER, correctedAt: AT, reason: 'Restated' }, POLICY_COUNT: imported(1) } }),
      row(RINA, '2026-06', { values: { APE: { value: null, provenance: 'corrected', correctedBy: OWNER, correctedAt: AT, reason: 'Wrong agent' } } }),
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
    // One read of the rows; beside it, since P19.5-T2, the KPM's own configuration, read live for the custom kodes
    // (ADR-0214 §3, §6) — an office row, and its template's when it has one.
    expect(queries.filter((q) => q.startsWith('monthlyAgentData'))).toEqual(['monthlyAgentData.find']);
    expect(queries.filter((q) => !q.startsWith('monthlyAgentData')).every((q) => /^(kpms|templates|companyTemplates)\./.test(q))).toBe(true);
    expect(result.cells).toEqual(await readings().monthCellsFor(office(), IDS, RANGE));
    // Spelled out for two: a leaver's file stops with him, and nobody's row is no month at all.
    expect([...result.cells.get(BUDI)!.keys()].sort()).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    // P19.3-T1: and a leader row's unit persistency, none on this row (ADR-0201 §2).
    expect(result.cells.get(RINA)!.get('2026-01')).toEqual({
      apeMonthly: 15 * M, policyCountMonthly: 1, persistencyMonthly: 92, unitPersistencyMonthly: null,
    });
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

  it('P19.5-T2 AC-7 the year to date is the months held, added: January is its own, never last December’s', async () => {
    const read = await readings().monthCellsAndYearToDateFor(office(), IDS, RANGE);
    const through = (month: string) => read.apeYearToDateThrough(IDS, month);
    // December: 10 + 50 + 60, the year's months — the figure the file's own YTD said, too.
    expect(through('2025-12').get(RINA)).toEqual(held(120 * M, '2025-12'));
    // January: Rina's own; Dewi has none, whatever last December held.
    expect(through('2026-01').get(RINA)).toEqual(held(15 * M, '2026-01'));
    expect(through('2026-01').get(DEWI)).toBeNull();
    // No February row: January's sum. April's zero is a month held. June's emptied by hand adds nothing; May's
    // correction makes the sum corrected, and names it.
    expect(through('2026-02').get(RINA)).toEqual(held(15 * M, '2026-01'));
    expect(through('2026-04').get(RINA)).toEqual(held(45 * M, '2026-04'));
    expect(through('2026-06').get(RINA)).toEqual(held(75 * M, '2026-05', true));
    // No August row here — another office's is not hers; September's own, and October's after it never read.
    expect(through('2026-08').get(RINA)).toEqual(held(105 * M, '2026-07', true));
    expect(through('2026-09').get(RINA)).toEqual(held(135 * M, '2026-09', true));
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
    expect(result.standingsFor([], '2025-06')).toEqual(new Map());
  });

  /*
   * **`standingsFor`: `ledgersFor`'s standing from the same read** (the analytics at 500 members, 2026-10-29) — the
   * read it replaces there, `ledgersFor` once or twice beside `monthCellsFor`, held to the hydrated readings over every
   * month of two whole years: the year's latest year to date, the year to date through last month, the month's own APE.
   */
  describe('standingsFor', () => {
    /** Two whole years, as the analytics reads them: last year's January to this year's December. */
    const YEARS = { from: '2025-01', to: '2026-12' };
    const EVERY_MONTH = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 7));

    it('answers for every month of the years read what standingsFor answers from ledgersFor, for every member', async () => {
      const { result: read, queries } = await counted(() => readings().monthCellsAndYearToDateFor(office(), IDS, YEARS));
      expect(queries.filter((q) => q.startsWith('monthlyAgentData'))).toEqual(['monthlyAgentData.find']);
      for (const month of EVERY_MONTH) {
        const mine = read.standingsFor(IDS, month);
        const hydrated = await readings().standingsFor(office(), IDS, month);
        for (const id of IDS) expect({ id, month, standing: mine.get(id) }).toEqual({ id, month, standing: hydrated.get(id) });
      }
    });

    it('the year’s latest is the whole year’s, a month after the one asked included; January has nothing through last month', async () => {
      const read = await readings().monthCellsAndYearToDateFor(office(), IDS, YEARS);
      // September, asked in September: October's year to date is the year's latest, as `ledgersFor` reads the year.
      expect(read.standingsFor([RINA], '2026-09').get(RINA)).toEqual({
        yearToDate: held(150 * M, '2026-10', true), throughLastMonth: held(105 * M, '2026-07', true), thisMonth: held(30 * M, '2026-09'),
      });
      // January: its own month and the year's latest; nothing before it, whatever last December held.
      expect(read.standingsFor([RINA, DEWI], '2026-01')).toEqual(new Map([
        [RINA, { yearToDate: held(150 * M, '2026-10', true), throughLastMonth: null, thisMonth: held(15 * M, '2026-01') }],
        [DEWI, { yearToDate: held(30 * M, '2026-03'), throughLastMonth: null, thisMonth: null }],
      ]));
      // June's emptied by hand holds no month of its own.
      expect(read.standingsFor([RINA], '2026-06').get(RINA)).toEqual({
        yearToDate: held(150 * M, '2026-10', true), throughLastMonth: held(75 * M, '2026-05', true), thisMonth: null,
      });
      // A leaver's year stops with his file; a deleted row is never read; nobody is nothing at all.
      expect(read.standingsFor([BUDI, TARI, NOBODY], '2026-05')).toEqual(new Map([
        [BUDI, { yearToDate: held(80 * M, '2026-04'), throughLastMonth: held(80 * M, '2026-04'), thisMonth: null }],
        [TARI, { yearToDate: held(25 * M, '2026-02'), throughLastMonth: held(25 * M, '2026-02'), thisMonth: null }],
        [NOBODY, { yearToDate: null, throughLastMonth: null, thisMonth: null }],
      ]));
    });

    it('reads one office: another office’s row under the same membership is that office’s standing alone', async () => {
      const mine = await readings().monthCellsAndYearToDateFor(office(), [RINA], YEARS);
      expect(mine.standingsFor([RINA], '2026-08').get(RINA)!.thisMonth).toBeNull();
      const theirs = await readings().monthCellsAndYearToDateFor(office(KPM_B), [RINA], YEARS);
      expect(theirs.standingsFor([RINA], '2026-08').get(RINA)).toEqual({
        yearToDate: held(999 * M, '2026-08'), throughLastMonth: null, thisMonth: held(999 * M, '2026-08'),
      });
    });

    it('refuses a month whose year was not read whole, a month that is none, and a member not read', async () => {
      const read = await readings().monthCellsAndYearToDateFor(office(), [RINA], RANGE);
      // RANGE ends in September: this year's December was not read, so the year's latest would miss October.
      expect(() => read.standingsFor([RINA], '2026-09')).toThrow(/A standing at 2026-09 reads 2026-01 to 2026-12; 2025-01 to 2026-09 was read/);
      expect(read.standingsFor([RINA], '2025-12').get(RINA)!.yearToDate).toEqual(held(120 * M, '2025-12'));
      const late = await readings().monthCellsAndYearToDateFor(office(), [RINA], { from: '2025-06', to: '2026-12' });
      expect(() => late.standingsFor([RINA], '2025-12')).toThrow(/2025-01 to 2025-12; 2025-06 to 2026-12 was read/);
      expect(() => late.standingsFor([RINA], 'soon')).toThrow(/A standing at soon/);
      expect(() => late.standingsFor([RINA, BUDI], '2026-09')).toThrow(`The year to date of ${BUDI}, whose months were not read.`);
    });
  });
});
