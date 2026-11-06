import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { LEGACY_CELLS } from '@/modules/production/upload-columns';
import { up } from './0058-upload-values-by-kode';

const NOW = new Date('2026-11-06T02:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';
const PRU_DEFAULT = '66f0000000000000000000d1';
const PRU_JAKARTA = '66f0000000000000000000d2';
const KPM_A = '66f0000000000000000000a1'; // made from Jakarta
const KPM_B = '66f0000000000000000000a2'; // made from the library: reads the default
const KPM_C = '66f0000000000000000000a3'; // no company at all
const M = 1_000_000 * 100;

const imported = (value: number | null, batch = 'b-1') => ({ value, provenance: value === null ? null : 'imported', sourceBatchId: batch });
const corrected = (value: number | null) => ({
  value, provenance: 'corrected', sourceBatchId: null, correctedBy: 'mem-owner', correctedAt: new Date('2026-09-10T04:00:00Z'),
  reason: 'Carrier restated', replacedValue: 70 * M,
});

/**
 * **Every cell a row can hold**, on one legacy row: the six metrics' month and year to date, and the leader rows' unit
 * persistency — a figure, a zero, a correction, a figure emptied by hand, and a cell never written.
 */
const LEGACY_ROW = {
  apeMonthly: corrected(80 * M), apeYtd: imported(240 * M),
  persistencyMonthly: imported(91.5), persistencyYtd: imported(89),
  recruitmentMonthly: imported(0), recruitmentYtd: imported(3),
  newActiveAgentsMonthly: imported(1), newActiveAgentsYtd: imported(2),
  fypMonthly: corrected(null), fypYtd: { value: null, provenance: null, sourceBatchId: null },
  policyCountMonthly: imported(2), policyCountYtd: imported(9),
  unitPersistencyMonthly: imported(82.5),
};

/**
 * **`0058-upload-values-by-kode`** (P19.5-T2 AC-15; ADR-0214 §9): today's rows by kode, every cell moved whole, every row
 * stamped `templateVersion: 1` and its KPM's template; the batches' rows re-keyed and the batches given version 1; the
 * old cells left where they were; idempotent.
 */
describe('0058-upload-values-by-kode (ADR-0214 §9)', () => {
  const col = (name: string) => mongoose.connection.db!.collection(name);
  const oid = (id: string) => new mongoose.Types.ObjectId(id);

  beforeAll(startMongo, 120_000);
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    for (const name of ['templates', 'kpms', 'monthlyAgentData', 'dataUploadRows', 'dataUploadBatches']) await col(name).deleteMany({});
    await col('templates').insertMany([
      { _id: oid(PRU_DEFAULT), companyId: PRUDENTIAL, name: 'Prudential template', isDefault: true, deletedAt: null },
      { _id: oid(PRU_JAKARTA), companyId: PRUDENTIAL, name: 'Jakarta', isDefault: false, deletedAt: null },
    ]);
    await col('kpms').insertMany([
      { _id: oid(KPM_A), companyId: PRUDENTIAL, code: '0417', startedFrom: { source: 'template', templateId: PRU_JAKARTA }, deletedAt: null },
      { _id: oid(KPM_B), companyId: PRUDENTIAL, code: '0555', startedFrom: { source: 'library' }, deletedAt: null },
      { _id: oid(KPM_C), code: '0999', deletedAt: null },
    ]);
    await col('monthlyAgentData').insertMany([
      { kpmId: KPM_A, membershipId: 'm1', agentCode: '80777', month: '2026-09', ...LEGACY_ROW, deletedAt: null },
      { kpmId: KPM_B, membershipId: 'm2', agentCode: '80555', month: '2026-08', apeMonthly: imported(10 * M), deletedAt: null },
      { kpmId: KPM_C, membershipId: 'm3', agentCode: '80999', month: '2026-07', policyCountMonthly: imported(1), deletedAt: null },
    ]);
    await col('dataUploadBatches').insertMany([
      { kpmId: KPM_A, month: '2026-09', status: 'committed', templateVersion: 2, deletedAt: null },
      { kpmId: KPM_C, month: '2026-07', status: 'reverted', templateVersion: 1, deletedAt: null },
    ]);
    await col('dataUploadRows').insertMany([
      {
        kpmId: KPM_A, batchId: 'b-1', month: '2026-09', line: 2, status: 'ready',
        values: { apeMonthly: 80 * M, apeYtd: 240 * M, unitPersistencyMonthly: 82.5 },
        previousValues: { apeMonthly: imported(70 * M, 'b-0'), apeYtd: null, unitPersistencyMonthly: null },
        deletedAt: null,
      },
      { kpmId: KPM_A, batchId: 'b-1', month: '2026-09', line: 3, status: 'refused', values: {}, previousValues: {}, deletedAt: null },
    ]);
  });

  it('P19.5-T2 AC-15 moves every cell whole to its kode — a correction’s who and why included — and changes no figure', async () => {
    const before = await col('monthlyAgentData').findOne({ membershipId: 'm1' });
    await up(mongoose.connection.db!, NOW);
    const after = (await col('monthlyAgentData').findOne({ membershipId: 'm1' }))!;
    // Every legacy cell that holds a figure or a provenance is at its kode, deep-equal: no stored figure changes.
    for (const [name, { kode, ytd }] of Object.entries(LEGACY_CELLS)) {
      const cell = before![name] as { value: unknown; provenance: unknown };
      const moved = (ytd ? after.ytdValues : after.values)?.[kode];
      if (cell.value === null && cell.provenance === null) expect({ name, moved }).toEqual({ name, moved: undefined });
      else expect({ name, moved }).toEqual({ name, moved: cell });
    }
    expect(Object.keys(after.values).sort()).toEqual(['APE', 'FYP', 'NEW_ACTIVE_AGENTS', 'PERSISTENCY', 'POLICY_COUNT', 'RECRUITMENT', 'UNIT_PERSISTENCY']);
    expect(Object.keys(after.ytdValues).sort()).toEqual(['APE', 'NEW_ACTIVE_AGENTS', 'PERSISTENCY', 'POLICY_COUNT', 'RECRUITMENT']);
    // The old cells stay on the document, read by nothing, until a later migration removes them (T5).
    for (const name of Object.keys(LEGACY_CELLS)) expect(after[name]).toEqual(before![name]);
  });

  it('P19.5-T2 AC-12 R6 stamps each row version 1 and its KPM’s template: its own, its company’s default, or none', async () => {
    const result = await up(mongoose.connection.db!, NOW);
    const stamp = async (membershipId: string) => {
      const row = (await col('monthlyAgentData').findOne({ membershipId }))!;
      return [row.templateId, row.templateVersion, row.asOf];
    };
    expect(await stamp('m1')).toEqual([PRU_JAKARTA, 1, null]);
    expect(await stamp('m2')).toEqual([PRU_DEFAULT, 1, null]);
    expect(await stamp('m3')).toEqual([null, 1, null]);
    expect(result).toMatchObject({ rows: 3, cells: 12 + 1 + 1, uploadRows: 1, batches: 2 });
    expect(result.offices).toEqual([
      { kpmId: KPM_A, templateId: PRU_JAKARTA, rows: 1, cells: 12 },
      { kpmId: KPM_B, templateId: PRU_DEFAULT, rows: 1, cells: 1 },
      { kpmId: KPM_C, templateId: null, rows: 1, cells: 1 },
    ]);
  });

  it('P19.5-T2 AC-15 re-keys an import’s undo log by kode, and gives every batch version 1', async () => {
    await up(mongoose.connection.db!, NOW);
    const [ready, refused] = await col('dataUploadRows').find({}).sort({ line: 1 }).toArray();
    expect(ready.values).toEqual({ APE: 80 * M, APE_YTD: 240 * M, UNIT_PERSISTENCY: 82.5 });
    expect(ready.previousValues).toEqual({ APE: imported(70 * M, 'b-0'), APE_YTD: null, UNIT_PERSISTENCY: null });
    expect(refused.values).toEqual({});
    const batches = await col('dataUploadBatches').find({}).sort({ month: -1 }).toArray();
    expect(batches.map((b) => [b.analyticsConfig, b.templateVersion])).toEqual([
      [{ templateId: PRU_JAKARTA, version: 1 }, 2], [{ templateId: null, version: 1 }, 1],
    ]);
  });

  it('P19.5-T2 AC-15 is idempotent: a second run moves nothing and changes nothing', async () => {
    await up(mongoose.connection.db!, NOW);
    const once = await Promise.all(['monthlyAgentData', 'dataUploadRows', 'dataUploadBatches'].map((n) => col(n).find({}).sort({ _id: 1 }).toArray()));
    const again = await up(mongoose.connection.db!, NOW);
    expect(again).toEqual({ rows: 0, cells: 0, uploadRows: 0, batches: 0, offices: [] });
    const twice = await Promise.all(['monthlyAgentData', 'dataUploadRows', 'dataUploadBatches'].map((n) => col(n).find({}).sort({ _id: 1 }).toArray()));
    expect(twice).toEqual(once);
  });

  it('never overwrites a kode a row already holds — a row written by kode is not a legacy row', async () => {
    await col('monthlyAgentData').insertOne({
      kpmId: KPM_A, membershipId: 'm9', agentCode: '1', month: '2026-10', values: { APE: imported(5 * M) }, templateVersion: 1, deletedAt: null,
    });
    await up(mongoose.connection.db!, NOW);
    expect((await col('monthlyAgentData').findOne({ membershipId: 'm9' }))!.values).toEqual({ APE: imported(5 * M) });
  });
});
