import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { MonthlyAgentDataRepository } from './monthly-agent-data.repository';
import {
  cellAsHydrated, MonthlyAgentData, MonthlyAgentDataSchema, type MonthlyAgentDataDocument,
} from './monthly-agent-data.schema';

const NOW = new Date('2026-09-14T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const OWNER = '66f000000000000000000100';
const M = 1_000_000 * 100;
const AT = new Date('2026-09-10T04:00:00Z');

const office = (kpmId = KPM_A) => RequestContext.tenantRead(kpmId, 'month-cells-spec');

/**
 * **Every shape a stored cell can take**, one member each, all in September: written through the schema a row holds
 * every cell whole, so the rest are rows written around it — by the import's raw driver, a migration, or a fixture.
 */
const SHAPES: Record<string, Record<string, unknown>> = {
  // No `apeYtd` on the row at all: hydration gives `cell()`'s `{}`, every field `null`.
  absent: {},
  // Stored `null`: hydration leaves it `null`.
  null: { apeYtd: null },
  empty: { apeYtd: {} },
  // A figure and nothing else, as a fixture writes one.
  partial: { apeYtd: { value: 140 * M } },
  imported: { apeYtd: { value: 240 * M, provenance: 'imported', sourceBatchId: 'b-1' } },
  corrected: {
    apeYtd: {
      value: 250 * M, provenance: 'corrected', sourceBatchId: 'b-1', correctedBy: OWNER, correctedAt: AT,
      reason: 'Carrier restated', replacedValue: 240 * M,
    },
  },
  // Emptied by hand: nothing held, and somebody decided so.
  emptied: { apeYtd: { value: null, provenance: 'corrected', correctedBy: OWNER, correctedAt: AT, reason: 'Wrong agent' } },
  // The agent's own figure, kept apart from the file's (ADR-0008).
  selfReported: { apeYtd: { value: 0, provenance: 'self_reported' } },
};
const memberOf = (shape: string) => `66f0000000000000000002${String(Object.keys(SHAPES).indexOf(shape)).padStart(2, '0')}`;

/**
 * **`MonthlyAgentDataRepository.findCells`: month rows read lean, each cell as a hydrated row holds it** (the forum's
 * scorecard at 500 members, 2026-10-28). The read skips Mongoose's hydration for its cost, so what it must keep is the
 * answer: for every shape a cell can be stored in, the cell it returns equals the hydrated row's — the schema's defaults
 * applied by `cellAsHydrated` — and like every scoped read, it reads one office's rows and none deleted, and refuses to
 * read without an office.
 */
describe('month rows read lean (MonthlyAgentDataRepository.findCells)', () => {
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
      { ...base(KPM_B, memberOf('imported')), apeYtd: { value: 999 * M, provenance: 'imported' } },
      { ...base(KPM_A, memberOf('imported'), '2026-08'), apeYtd: { value: 777 * M, provenance: 'imported' }, deletedAt: AT },
    ] as never);
  });
  afterAll(stopMongo);

  it('answers every cell as the hydrated row holds it, whatever shape it was stored in', async () => {
    const ids = Object.keys(SHAPES).map(memberOf);
    const lean = await rows.findCells(office(), { membershipId: { $in: ids } }, ['apeYtd', 'apeMonthly']);
    const hydrated = await rows.find(office(), { membershipId: { $in: ids } }, { projection: { membershipId: 1, month: 1, apeYtd: 1, apeMonthly: 1 } });
    const asHydrated = (doc: MonthlyAgentDataDocument, name: 'apeYtd' | 'apeMonthly') => {
      const cell = doc.get(name) as unknown as { toObject(): unknown } | null;
      return cell === null ? null : cell.toObject();
    };

    expect(lean).toHaveLength(Object.keys(SHAPES).length);
    for (const shape of Object.keys(SHAPES)) {
      const mine = lean.find((row) => row.membershipId === memberOf(shape))!;
      const theirs = hydrated.find((row) => row.membershipId === memberOf(shape))!;
      expect({ shape, apeYtd: mine.apeYtd, apeMonthly: mine.apeMonthly })
        .toEqual({ shape, apeYtd: asHydrated(theirs, 'apeYtd'), apeMonthly: asHydrated(theirs, 'apeMonthly') });
    }
    // Spelled out for two of them: a cell the row lacks, every field `null`; a cell stored `null`, `null`.
    const empty = { value: null, provenance: null, sourceBatchId: null, correctedBy: null, correctedAt: null, reason: null, replacedValue: null };
    expect(lean.find((row) => row.membershipId === memberOf('absent'))!.apeYtd).toEqual(empty);
    expect(lean.find((row) => row.membershipId === memberOf('null'))!.apeYtd).toBeNull();
    expect(lean.find((row) => row.membershipId === memberOf('emptied'))!.apeYtd)
      .toEqual({ ...empty, provenance: 'corrected', correctedBy: OWNER, correctedAt: AT, reason: 'Wrong agent' });
  });

  it('answers the member, the month and the cells asked for — nothing else of the row', async () => {
    const [row] = await rows.findCells(office(), { membershipId: memberOf('corrected') }, ['apeYtd']);
    expect(Object.keys(row).sort()).toEqual(['apeYtd', 'membershipId', 'month']);
    expect(row).toMatchObject({ membershipId: memberOf('corrected'), month: '2026-09', apeYtd: { value: 250 * M, replacedValue: 240 * M } });
  });

  it('reads one office’s rows and none deleted: another office’s row under the same member is never read', async () => {
    const mine = await rows.findCells(office(), { membershipId: memberOf('imported') }, ['apeYtd']);
    expect(mine.map((row) => [row.month, row.apeYtd!.value])).toEqual([['2026-09', 240 * M]]);
    const theirs = await rows.findCells(office(KPM_B), { membershipId: memberOf('imported') }, ['apeYtd']);
    expect(theirs.map((row) => [row.month, row.apeYtd!.value])).toEqual([['2026-09', 999 * M]]);
  });

  it('refuses to read without an office, whatever the filter names', async () => {
    await expect(rows.findCells(RequestContext.platform('root'), { kpmId: KPM_A }, ['apeYtd'])).rejects.toThrow(MissingTenantContextError);
  });

  it('cellAsHydrated: a cell nobody stored is every field null, one stored null stays null', () => {
    expect(cellAsHydrated(undefined)).toEqual(cellAsHydrated({}));
    expect(cellAsHydrated(undefined)?.value).toBeNull();
    expect(cellAsHydrated(null)).toBeNull();
  });
});
