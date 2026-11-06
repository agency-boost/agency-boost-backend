import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { MonthlyAgentDataRepository } from './monthly-agent-data.repository';
import {
  cellAsHydrated, MonthlyAgentData, MonthlyAgentDataSchema,
} from './monthly-agent-data.schema';

const NOW = new Date('2026-09-14T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const OWNER = '66f000000000000000000100';
const M = 1_000_000 * 100;
const AT = new Date('2026-09-10T04:00:00Z');

const office = (kpmId = KPM_A) => RequestContext.tenantRead(kpmId, 'month-cells-spec');

/**
 * **Every shape a stored cell can take**, one member each, all in September, by kode (P19.5-T2): a row written by the
 * import holds each cell whole; the rest are rows written around it — by a migration, or a fixture.
 */
const SHAPES: Record<string, Record<string, unknown>> = {
  // No `values` on the row at all.
  absent: {},
  // A kode the row lacks.
  missing: { values: {} },
  // Stored `null`: read as `null`, as hydration left a `null` subdocument.
  null: { values: { APE: null } },
  empty: { values: { APE: {} } },
  // A figure and nothing else, as a fixture writes one.
  partial: { values: { APE: { value: 140 * M } } },
  imported: { values: { APE: { value: 240 * M, provenance: 'imported', sourceBatchId: 'b-1' } } },
  corrected: {
    values: {
      APE: {
        value: 250 * M, provenance: 'corrected', sourceBatchId: 'b-1', correctedBy: OWNER, correctedAt: AT,
        reason: 'Carrier restated', replacedValue: 240 * M,
      },
    },
  },
  // Emptied by hand: nothing held, and somebody decided so.
  emptied: { values: { APE: { value: null, provenance: 'corrected', correctedBy: OWNER, correctedAt: AT, reason: 'Wrong agent' } } },
  // The year to date a file used to carry, kept as a check (`ytdValues`).
  ytd: { ytdValues: { APE: { value: 900 * M, provenance: 'imported' } } },
};
const memberOf = (shape: string) => `66f0000000000000000002${String(Object.keys(SHAPES).indexOf(shape)).padStart(2, '0')}`;
const EMPTY = { value: null, provenance: null, sourceBatchId: null, correctedBy: null, correctedAt: null, reason: null, replacedValue: null };

/**
 * **`MonthlyAgentDataRepository.findByKode`: month rows read lean, by kode** (the forum's scorecard at 500 members,
 * 2026-10-28; by kode since P19.5-T2, ADR-0214 §9). For every shape a cell can be stored in, the cell it returns is the
 * stored cell with every field `cellAsHydrated` applies — a kode the row lacks is `null`, no figure held — and like
 * every scoped read, it reads one office's rows and none deleted, and refuses to read without an office.
 */
describe('month rows read lean, by kode (MonthlyAgentDataRepository.findByKode)', () => {
  let rows: MonthlyAgentDataRepository;

  beforeAll(async () => {
    await startMongo();
    configModule(NOW);
    rows = new MonthlyAgentDataRepository(mongoose.model(MonthlyAgentData.name, MonthlyAgentDataSchema) as never);
    await clearCollections();
    const base = (kpmId: string, membershipId: string, month = '2026-09') => ({ kpmId, membershipId, month, agentCode: 'X', deletedAt: null });
    await mongoose.connection.db!.collection('monthlyAgentData').insertMany([
      ...Object.entries(SHAPES).map(([shape, cells]) => ({ ...base(KPM_A, memberOf(shape)), ...cells })),
      // Another office's row under the imported member's id, and a row of that member's deleted.
      { ...base(KPM_B, memberOf('imported')), values: { APE: { value: 999 * M, provenance: 'imported' } } },
      { ...base(KPM_A, memberOf('imported'), '2026-08'), values: { APE: { value: 777 * M, provenance: 'imported' } }, deletedAt: AT },
    ] as never);
  });
  afterAll(stopMongo);

  it('P19.5-T2 AC-15 answers every cell by kode, whatever shape it was stored in', async () => {
    const ids = Object.keys(SHAPES).map(memberOf);
    const lean = await rows.findByKode(office(), { membershipId: { $in: ids } }, ['APE'], ['APE']);
    const of = (shape: string) => lean.find((row) => row.membershipId === memberOf(shape))!;
    expect(lean).toHaveLength(Object.keys(SHAPES).length);
    expect(of('absent').values.APE).toBeNull();
    expect(of('missing').values.APE).toBeNull();
    expect(of('null').values.APE).toBeNull();
    expect(of('empty').values.APE).toEqual(EMPTY);
    expect(of('partial').values.APE).toEqual({ ...EMPTY, value: 140 * M });
    expect(of('imported').values.APE).toEqual({ ...EMPTY, value: 240 * M, provenance: 'imported', sourceBatchId: 'b-1' });
    expect(of('corrected').values.APE).toMatchObject({ value: 250 * M, provenance: 'corrected', correctedBy: OWNER, replacedValue: 240 * M });
    expect(of('emptied').values.APE).toEqual({ ...EMPTY, provenance: 'corrected', correctedBy: OWNER, correctedAt: AT, reason: 'Wrong agent' });
    expect(of('ytd')).toMatchObject({ values: { APE: null }, ytdValues: { APE: { value: 900 * M, provenance: 'imported' } } });
  });

  it('answers the member, the month, its as-of day and the kodes asked for — nothing else of the row', async () => {
    const [row] = await rows.findByKode(office(), { membershipId: memberOf('corrected') }, ['APE']);
    expect(Object.keys(row).sort()).toEqual(['asOf', 'membershipId', 'month', 'values', 'ytdValues']);
    expect(Object.keys(row.values)).toEqual(['APE']);
    expect(row.ytdValues).toEqual({});
  });

  it('reads one office’s rows and none deleted: another office’s row under the same member is never read', async () => {
    const mine = await rows.findByKode(office(), { membershipId: memberOf('imported') }, ['APE']);
    expect(mine.map((row) => [row.month, row.values.APE!.value])).toEqual([['2026-09', 240 * M]]);
    const theirs = await rows.findByKode(office(KPM_B), { membershipId: memberOf('imported') }, ['APE']);
    expect(theirs.map((row) => [row.month, row.values.APE!.value])).toEqual([['2026-09', 999 * M]]);
  });

  it('refuses to read without an office, whatever the filter names', async () => {
    await expect(rows.findByKode(RequestContext.platform('root'), { kpmId: KPM_A }, ['APE'])).rejects.toThrow(MissingTenantContextError);
  });

  it('cellAsHydrated: a cell nobody stored is every field null, one stored null stays null', () => {
    expect(cellAsHydrated(undefined)).toEqual(cellAsHydrated({}));
    expect(cellAsHydrated(undefined)?.value).toBeNull();
    expect(cellAsHydrated(null)).toBeNull();
  });

  /**
   * **`kodesHeldInOfficesAcrossTenants`** (P19.5-T1 AC-7; extended by P19.5-T2, ADR-0214 §2, §8): which kodes hold a figure
   * in the offices named, and the earliest month — reading the rows by kode, the legacy cells a row not yet migrated
   * holds, and the *Belum terdaftar* rows of `unregisteredAgentData`.
   */
  it('P19.5-T2 AC-5 kodesHeldInOfficesAcrossTenants reads the held rows too, and only the offices named', async () => {
    const db = mongoose.connection.db!;
    await db.collection('unregisteredAgentData').insertMany([
      { kpmId: KPM_A, agentCode: '70019999', month: '2025-02', values: { KOMISI: { value: 5, provenance: 'imported' } }, status: 'held', deletedAt: null },
      { kpmId: KPM_B, agentCode: '70019998', month: '2024-01', values: { BONUS: { value: 1, provenance: 'imported' } }, status: 'held', deletedAt: null },
      { kpmId: KPM_A, agentCode: '70019997', month: '2023-01', values: { GONE: { value: 1, provenance: 'imported' } }, status: 'held', deletedAt: AT },
    ]);
    await db.collection('monthlyAgentData').insertOne({
      kpmId: KPM_A, membershipId: memberOf('absent'), agentCode: 'X', month: '2026-01', apeMonthly: { value: 5 * M, provenance: 'imported' }, deletedAt: null,
    });
    const held = await rows.kodesHeldInOfficesAcrossTenants(RequestContext.platform('root'), [KPM_A], { apeMonthly: 'APE' });
    expect(Object.fromEntries(held)).toEqual({ APE: '2026-01', KOMISI: '2025-02' });
    await expect(rows.kodesHeldInOfficesAcrossTenants(office(), [KPM_A], {})).rejects.toThrow(MissingTenantContextError);
  });
});
