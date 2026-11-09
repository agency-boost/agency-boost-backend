import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import type { DomainException } from '@/common/errors/domain.exception';
import { readerIn } from '@/common/i18n/reader';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { DataUploadBatch } from './data-upload-batch.schema';
import { MonthlyAgentData } from './monthly-agent-data.schema';
import { ProductionMonth } from './production-month.schema';
import { TEMPLATE_HEADER_V1, TEMPLATE_HEADER_V2 } from './production-template';

/** The twelve value columns of a version 1 file, keyed `metric.cadence` as these specs name them. */
const VALUE_COLUMNS = (['monthly', 'ytd'] as const).flatMap((cadence) =>
  (['ape', 'persistency', 'recruitment', 'newActiveAgents', 'fyp', 'policyCount'] as const).map((metric) => ({ metric, cadence })));
/** The seven kodes version 1 reads (ADR-0214 §9). */
const KODES = ['APE', 'PERSISTENCY', 'RECRUITMENT', 'NEW_ACTIVE_AGENTS', 'FYP', 'POLICY_COUNT', 'UNIT_PERSISTENCY'];

// 09:00 on 27 September in Jakarta: September is open until 7 October; August closed on 7 September.
const NOW = new Date('2026-09-27T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const A1 = '66f000000000000000000101';
const A2 = '66f000000000000000000102';
const B1 = '66f000000000000000000201';

const ctxFor = (kpmId: string, membershipId: string) => new RequestContext('u-' + membershipId.slice(-3), 'none', {
  membershipId, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);
/** The Owner is Rina herself, so a name comes back for whoever committed. */
const A = ctxFor(KPM_A, A1);
const B = ctxFor(KPM_B, B1);
const noOffice = () => new RequestContext('u9', 'none', null);

function person(id: string, kpmId: string, code: string) {
  return {
    _id: new mongoose.Types.ObjectId(id), kpmId, userId: '66f000000000000000003' + id.slice(-3),
    agentCode: code, agentSeq: Number(id.slice(-1)), leaderCode: `LC-${id.slice(-3)}`, orgLevelCode: 'AGENT',
    hierarchyRole: 'agent', leaderId: null, ancestorIds: [], status: 'active', deletedAt: null,
  };
}
const NAMES: Record<string, string> = { [A1]: 'Rina Wijaya', [A2]: 'Budi Santoso', [B1]: 'Hendra Wijaya' };

type Cells = Record<string, string>;
/** A filled template: each row's code and its cells by `metric.cadence`. */
const file = (name: string, ...rows: [string, Cells][]) => ({
  buffer: Buffer.from([
    TEMPLATE_HEADER_V1.join(','),
    ...rows.map(([code, cells]) => [code, '"x"', ...VALUE_COLUMNS.map((c) => cells[`${c.metric}.${c.cadence}`] ?? '')].join(',')),
  ].join('\n')),
  originalname: name,
  size: 0,
});

describe('confirm import, revert and the month lock (P9-T4)', () => {
  let wired: ReturnType<typeof configModule>;
  const db = () => mongoose.connection.db!;
  const monthRow = async (membershipId: string, month = '2026-09') =>
    db().collection('monthlyAgentData').findOne({ membershipId, month });
  /** A row's figures by kode, and nothing about when it was last touched. */
  const figuresOf = async (membershipId: string) => {
    const row = await monthRow(membershipId);
    return KODES.map((k) => row?.values?.[k]);
  };

  /** Preview, then confirm with the revision the preview answered — what the screen does. */
  const importFile = async (ctx: RequestContext, month: string, f: ReturnType<typeof file>) => {
    const p = await wired.production.preview(ctx, month, f);
    return wired.productionImport.commit(ctx, month, String(p.revision), f);
  };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    jest.restoreAllMocks();
    await clearCollections();
    for (const name of [MonthlyAgentData.name, ProductionMonth.name, DataUploadBatch.name]) {
      await mongoose.model(name).syncIndexes();
    }
    await db().collection('kpms').insertMany([
      { _id: new mongoose.Types.ObjectId(KPM_A), code: '0417', timezone: 'Asia/Jakarta', settings: { productionLockGraceDays: 7 } },
      { _id: new mongoose.Types.ObjectId(KPM_B), code: '0555', timezone: 'Asia/Jakarta', settings: { productionLockGraceDays: 7 } },
    ] as never);
    await db().collection('memberships').insertMany([
      person(A1, KPM_A, 'PRU-001'), person(A2, KPM_A, 'PRU-002'), person(B1, KPM_B, 'PRU-900'),
    ] as never);
    await db().collection('users').insertMany(Object.keys(NAMES).map((id) => ({
      _id: new mongoose.Types.ObjectId('66f000000000000000003' + id.slice(-3)),
      email: `${id}@kpm.test`, fullName: NAMES[id], deletedAt: null,
    })) as never);
  });

  describe('AC-1, AC-6 — confirm import writes the figures, and the batch that can undo them', () => {
    it('writes each new and changed figure as imported, with the batch as its source', async () => {
      const { batch, state } = await importFile(A, '2026-09', file('sep.csv',
        ['PRU-001', { 'ape.monthly': '1.5', 'ape.ytd': '6' }],
        ['PRU-999', { 'ape.monthly': '1' }],
      ));

      expect(batch).toMatchObject({
        month: '2026-09', filename: 'sep.csv', status: 'committed', templateVersion: 1,
        rowCount: 2, writtenRowCount: 1, cellCount: 1, issueCount: 1,
        committedBy: 'Rina Wijaya', canRevert: true,
      });
      expect(state).toMatchObject({ revision: 1, locked: false, reason: 'open' });

      const row = await monthRow(A1);
      // An imported figure carries no correction: who, when and why are empty.
      expect(row!.values.APE).toEqual({
        value: 150_000_000, provenance: 'imported', sourceBatchId: batch.id,
        correctedBy: null, correctedAt: null, reason: null, replacedValue: null,
      });
      // P19.5-T2 (R4): the file's APE YTD is calculated now — noted in the preview, never stored.
      expect(row!.ytdValues?.APE).toBeUndefined();
      expect(row!.values.FYP).toBeUndefined();
      // Stamped with the configuration it was written against (R6).
      // D8: an upload into the running month stands at today, its *as of* day (ADR-0214 §11).
      expect(row).toMatchObject({ templateId: null, templateVersion: 1, asOf: '2026-09-27' });

      const view = await wired.production.readMonth(A, '2026-09');
      expect(view.rows.find((r) => r.membershipId === A1)!.values.APE)
        .toEqual({ value: 150_000_000, provenance: 'imported', correction: null, outOfBounds: null });
    });

    it('records the file, and every row with what it wrote and what that held before — refused rows too', async () => {
      const { batch } = await importFile(A, '2026-09', file('sep.csv',
        ['PRU-001', { 'ape.monthly': '1.5' }], ['PRU-999', { 'ape.monthly': '1' }],
      ));
      const stored = await db().collection('dataUploadBatches').findOne({ _id: new mongoose.Types.ObjectId(batch.id) });
      expect(stored).toMatchObject({ kpmId: KPM_A, basedOnRevision: 0, encoding: 'utf-8', delimiter: ',', committedBy: A1 });
      expect(stored!.fileSha256).toMatch(/^[0-9a-f]{64}$/);

      const rows = await db().collection('dataUploadRows').find({ batchId: batch.id }).sort({ line: 1 }).toArray();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        line: 2, membershipId: A1, status: 'ready',
        // Keyed by kode since P19.5-T2 (ADR-0214 §9).
        values: { APE: 150_000_000 },
        // No month row existed, so there was nothing to hold it.
        previousValues: { APE: null },
      });
      expect(rows[1]).toMatchObject({ line: 3, membershipId: null, status: 'refused', issues: [{ code: expect.stringMatching(/^UPLOAD_(UNKNOWN_AGENT_CODE|AGENT_CODE_PATTERN)$/) }] });
      expect(stored).toMatchObject({ analyticsConfig: { templateId: null, version: 1 }, asOf: '2026-09-27', heldRowCount: 0 });
      // Wrote nothing — an empty object, which the store keeps as no field at all.
      expect(rows[1].values ?? {}).toEqual({});
    });

    it('leaves a figure already as stored alone — its provenance and its source with it', async () => {
      const first = await importFile(A, '2026-09', file('a.csv', ['PRU-001', { 'ape.monthly': '1', 'fyp.monthly': '1' }]));
      const second = await importFile(A, '2026-09', file('b.csv', ['PRU-001', { 'ape.monthly': '1', 'fyp.monthly': '2' }]));
      const row = await monthRow(A1);
      expect(row!.values.APE.sourceBatchId).toBe(first.batch.id);
      expect(row!.values.FYP.sourceBatchId).toBe(second.batch.id);
      expect(second.batch.cellCount).toBe(1);
    });

    it('audits the import', async () => {
      const { batch } = await importFile(A, '2026-09', file('sep.csv', ['PRU-001', { 'ape.monthly': '1' }]));
      expect(await db().collection('auditLog').findOne({ action: 'upload.commit' }))
        .toMatchObject({ kpmId: KPM_A, targetId: batch.id, actorMembershipId: A1 });
    });
  });

  describe('AC-4 — a partly-filled file over a full month loses nothing', () => {
    it('changes only what the file gives; blanks and absent members keep what they had', async () => {
      const full = Object.fromEntries(VALUE_COLUMNS.map((c) => [`${c.metric}.${c.cadence}`, '5']));
      await importFile(A, '2026-09', file('full.csv', ['PRU-001', full], ['PRU-002', full]));
      const before2 = await monthRow(A2);

      await importFile(A, '2026-09', file('partial.csv', ['PRU-001', { 'ape.monthly': '1' }]));

      const row1 = await monthRow(A1);
      expect(row1!.values.APE.value).toBe(100_000_000);
      for (const kode of KODES.slice(1, 6)) expect(row1!.values[kode].value).not.toBeNull();
      expect(await monthRow(A2)).toEqual(before2);
    });
  });

  describe('AC-2 — revert puts back exactly what was there', () => {
    it('restores earlier figures — not zeroes, not nulls — and empties what was empty', async () => {
      const first = await importFile(A, '2026-09', file('first.csv', ['PRU-001', { 'ape.monthly': '1', 'persistency.monthly': '90' }]));
      await importFile(A, '2026-09', file('second.csv', ['PRU-001', { 'ape.monthly': '3', 'fyp.monthly': '2' }]));
      const [latest] = (await wired.productionImport.history(A, '2026-09')).batches;

      const { batch } = await wired.productionImport.revert(A, latest.id);

      expect(batch).toMatchObject({ status: 'reverted', revertedBy: 'Rina Wijaya', restoredCellCount: 2, keptCellCount: 0 });
      const row = await monthRow(A1);
      expect(row!.values.APE).toMatchObject({ value: 100_000_000, provenance: 'imported', sourceBatchId: first.batch.id });
      expect(row!.values.PERSISTENCY.value).toBe(90);
      expect(row!.values.FYP ?? null).toMatchObject({ value: null, provenance: null, sourceBatchId: null });
    });

    it('keeps a figure something else has written since, and counts it', async () => {
      const { batch } = await importFile(A, '2026-09', file('a.csv', ['PRU-001', { 'ape.monthly': '1', 'fyp.monthly': '1' }]));
      // What a correction (P9-T5) will do: the figure is somebody else's now.
      await db().collection('monthlyAgentData').updateOne(
        { membershipId: A1 }, { $set: { 'values.FYP': { value: 7, provenance: 'corrected', sourceBatchId: null } } },
      );

      const reverted = await wired.productionImport.revert(A, batch.id);

      expect(reverted.batch).toMatchObject({ restoredCellCount: 1, keptCellCount: 1 });
      const row = await monthRow(A1);
      expect(row!.values.APE.value).toBeNull();
      expect(row!.values.FYP).toEqual({ value: 7, provenance: 'corrected', sourceBatchId: null });
    });

    it('takes only the latest standing import, then the one beneath it', async () => {
      const first = await importFile(A, '2026-09', file('a.csv', ['PRU-001', { 'ape.monthly': '1' }]));
      const second = await importFile(A, '2026-09', file('b.csv', ['PRU-001', { 'ape.monthly': '2' }]));

      await expect(wired.productionImport.revert(A, first.batch.id)).rejects.toMatchObject({
        code: 'UPLOAD_BATCH_NOT_LATEST', details: { latestBatchId: second.batch.id },
      });
      await wired.productionImport.revert(A, second.batch.id);
      await wired.productionImport.revert(A, first.batch.id);
      expect((await monthRow(A1))!.values.APE.value).toBeNull();
    });

    it('audits the revert', async () => {
      const { batch } = await importFile(A, '2026-09', file('a.csv', ['PRU-001', { 'ape.monthly': '1' }]));
      await wired.productionImport.revert(A, batch.id);
      expect(await db().collection('auditLog').findOne({ action: 'upload.revert' }))
        .toMatchObject({ targetId: batch.id, after: { status: 'reverted', restoredCellCount: 1 } });
    });
  });

  describe('AC-3 — twice is refused, by name', () => {
    it('refuses reverting an import twice', async () => {
      const { batch } = await importFile(A, '2026-09', file('a.csv', ['PRU-001', { 'ape.monthly': '1' }]));
      await wired.productionImport.revert(A, batch.id);
      await expect(wired.productionImport.revert(A, batch.id)).rejects.toMatchObject({ code: 'UPLOAD_NOTHING_TO_REVERT' });
    });

    it('refuses reverting an import that never completed, saying so', async () => {
      const { batch } = await importFile(A, '2026-09', file('a.csv', ['PRU-001', { 'ape.monthly': '1' }]));
      await db().collection('dataUploadBatches').updateOne(
        { _id: new mongoose.Types.ObjectId(batch.id) }, { $set: { status: 'failed' } },
      );
      await expect(wired.productionImport.revert(A, batch.id)).rejects.toMatchObject({
        code: 'UPLOAD_NOTHING_TO_REVERT', details: { status: 'failed' },
        message: expect.stringContaining('never completed'),
      });
    });

    it('refuses committing the same preview twice', async () => {
      const f = file('a.csv', ['PRU-001', { 'ape.monthly': '1' }]);
      const p = await wired.production.preview(A, '2026-09', f);
      await wired.productionImport.commit(A, '2026-09', String(p.revision), f);
      await expect(wired.productionImport.commit(A, '2026-09', String(p.revision), f))
        .rejects.toMatchObject({ code: 'UPLOAD_BATCH_ALREADY_COMMITTED' });
    });

    it('refuses a preview the month has moved on from — its figures are not the ones it saw', async () => {
      const f = file('a.csv', ['PRU-001', { 'ape.monthly': '1' }]);
      const stale = await wired.production.preview(A, '2026-09', f);
      await importFile(A, '2026-09', file('b.csv', ['PRU-002', { 'ape.monthly': '1' }]));
      await expect(wired.productionImport.commit(A, '2026-09', String(stale.revision), f)).rejects.toMatchObject({
        code: 'VERSION_CONFLICT', details: { expectedVersion: 0, actualVersion: 1 },
      });
      expect((await monthRow(A1))).toBeNull();
    });

    it('refuses a file that would change nothing', async () => {
      await expect(importFile(A, '2026-09', file('blank.csv', ['PRU-001', {}], ['PRU-999', { 'ape.monthly': '1' }])))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('AC-5, AC-10 — the month lock (ADR-0050)', () => {
    /*
     * August was written once already, on its last day: since P19.5-T2 a month of the history never written is open
     * until its first upload (ADR-0214 §11; `production-history.tenancy.spec.ts`), and these are about the schedule.
     */
    beforeEach(async () => {
      await db().collection('productionMonths').insertOne({
        kpmId: KPM_A, month: '2026-08', revision: 1, firstWrittenOn: '2026-08-31', lockOverride: null, deletedAt: null,
      });
    });

    it('reads a month past its window as locked by the schedule, and one inside it as open', async () => {
      expect(await wired.productionMonths.state(A, '2026-08'))
        .toMatchObject({ locked: true, reason: 'schedule', editableUntil: '2026-09-07' });
      expect(await wired.productionMonths.state(A, '2026-09'))
        .toMatchObject({ locked: false, reason: 'open', editableUntil: '2026-10-07' });
    });

    it('reads the window from the office’s own setting', async () => {
      await db().collection('kpms').updateOne(
        { _id: new mongoose.Types.ObjectId(KPM_A) } as never, { $set: { 'settings.productionLockGraceDays': 30 } },
      );
      expect(await wired.productionMonths.state(A, '2026-08')).toMatchObject({ locked: false, editableUntil: '2026-09-30' });
    });

    it('refuses an import into a locked month, until it is reopened — and audits the reopening', async () => {
      const f = file('aug.csv', ['PRU-001', { 'ape.monthly': '1' }]);
      await expect(importFile(A, '2026-08', f)).rejects.toMatchObject({
        code: 'UPLOAD_MONTH_LOCKED', details: { month: '2026-08', reason: 'schedule', editableUntil: '2026-09-07' },
        message: 'Agu 2026 locked after 7 Sep 2026, when its window closed. Reopen the month to change its figures.',
      });

      const reopened = await wired.productionMonths.reopen(A, '2026-08');
      expect(reopened).toMatchObject({ locked: false, reason: 'reopened', changedBy: 'Rina Wijaya' });
      expect(await db().collection('auditLog').findOne({ action: 'upload.month_reopened' }))
        .toMatchObject({ targetId: '2026-08', before: { locked: true, reason: 'schedule' }, after: { locked: false } });

      await importFile(A, '2026-08', f);
      expect((await monthRow(A1, '2026-08'))!.values.APE.value).toBe(100_000_000);
    });

    it('refuses a revert into a month locked by hand, and says who locked it', async () => {
      const { batch } = await importFile(A, '2026-09', file('a.csv', ['PRU-001', { 'ape.monthly': '1' }]));
      const locked = await wired.productionMonths.lock(A, '2026-09');
      expect(locked).toMatchObject({ locked: true, reason: 'locked_by_hand', changedBy: 'Rina Wijaya' });
      expect(await db().collection('auditLog').findOne({ action: 'upload.month_locked' })).toBeTruthy();

      await expect(wired.productionImport.revert(A, batch.id)).rejects.toMatchObject({
        code: 'UPLOAD_MONTH_LOCKED', message: expect.stringContaining('locked by Rina Wijaya'),
      });
    });

    it('P18.10-T5 AC-2 says who locked it, and what to revert first, in Indonesian', async () => {
      const inIndonesian = async (call: Promise<unknown>) =>
        ((await call.catch((err: unknown) => err)) as DomainException).messageFor(readerIn('id'));
      const first = await importFile(A, '2026-09', file('a.csv', ['PRU-001', { 'ape.monthly': '1' }]));
      const second = await importFile(A, '2026-09', file('b.csv', ['PRU-001', { 'ape.monthly': '2' }]));
      expect(await inIndonesian(wired.productionImport.revert(A, first.batch.id)))
        .toBe('“b.csv” diimpor ke bulan ini setelahnya. Batalkan impor itu dulu.');
      await wired.productionMonths.lock(A, '2026-09');
      expect(await inIndonesian(wired.productionImport.revert(A, second.batch.id)))
        .toBe('Sep 2026 dikunci oleh Rina Wijaya. Buka kembali bulan ini untuk mengubah angkanya.');
      await wired.productionMonths.reopen(A, '2026-09');
      const twice = await importFile(A, '2026-09', file('c.csv', ['PRU-001', { 'ape.monthly': '3' }]));
      await wired.productionImport.revert(A, twice.batch.id);
      expect(await inIndonesian(wired.productionImport.revert(A, twice.batch.id))).toBe('Impor ini sudah dibatalkan.');
      await db().collection('dataUploadBatches').updateOne(
        { _id: new mongoose.Types.ObjectId(twice.batch.id) }, { $set: { status: 'failed' } },
      );
      expect(await inIndonesian(wired.productionImport.revert(A, twice.batch.id)))
        .toBe('Impor ini tidak pernah selesai, jadi tidak ada yang perlu dibatalkan.');
    });

    it('leaves a month already in the state asked for as it is, and audits nothing', async () => {
      await wired.productionMonths.lock(A, '2026-08');
      await wired.productionMonths.reopen(A, '2026-09');
      expect(await db().collection('auditLog').countDocuments()).toBe(0);
      // August's row as written above, and none for September.
      expect(await db().collection('productionMonths').countDocuments()).toBe(1);
      expect(await db().collection('productionMonths').findOne({ month: '2026-08' })).toMatchObject({ revision: 1, lockOverride: null });
    });
  });

  describe('AC-7 — a failure part-way leaves the month as it was', () => {
    it('puts back what it wrote before it answers, and marks the import failed', async () => {
      await importFile(A, '2026-09', file('base.csv', ['PRU-001', { 'ape.monthly': '1' }], ['PRU-002', { 'ape.monthly': '1' }]));
      const before = [await figuresOf(A1), await figuresOf(A2)];

      const model = mongoose.model(MonthlyAgentData.name);
      const real = model.findOneAndUpdate.bind(model);
      let calls = 0;
      jest.spyOn(model, 'findOneAndUpdate').mockImplementation(((...args: Parameters<typeof real>) => {
        calls += 1;
        if (calls === 2) throw new Error('the disk is full');
        return real(...args);
      }) as never);

      await expect(importFile(A, '2026-09', file('bad.csv', ['PRU-001', { 'ape.monthly': '8' }], ['PRU-002', { 'ape.monthly': '9' }])))
        .rejects.toThrow('the disk is full');
      jest.restoreAllMocks();

      expect([await figuresOf(A1), await figuresOf(A2)]).toEqual(before);
      expect(await db().collection('dataUploadBatches').findOne({ filename: 'bad.csv' })).toMatchObject({ status: 'failed' });
      expect((await wired.productionImport.history(A, '2026-09')).batches.map((b) => b.filename)).toEqual(['base.csv']);
    });

    it('finishes off an import a dead process left half-written, and leaves one still in flight alone', async () => {
      const { batch } = await importFile(A, '2026-09', file('a.csv', ['PRU-001', { 'ape.monthly': '1' }]));
      // As if the process had died before marking it committed — eleven minutes ago.
      await db().collection('dataUploadBatches').updateOne(
        { _id: new mongoose.Types.ObjectId(batch.id) },
        { $set: { status: 'pending', startedAt: new Date(NOW.getTime() - 11 * 60_000) } },
      );
      const inFlight = await db().collection('dataUploadBatches').insertOne({
        kpmId: KPM_A, month: '2026-09', status: 'pending', startedAt: new Date(NOW.getTime() - 60_000), deletedAt: null,
      } as never);

      // The next write finishes it off. The preview it carries was taken of the half-written month,
      // so it is refused — the figures that preview compared against are not there any more.
      const f = file('b.csv', ['PRU-002', { 'ape.monthly': '1' }]);
      const stale = await wired.production.preview(A, '2026-09', f);
      await expect(wired.productionImport.commit(A, '2026-09', String(stale.revision), f))
        .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

      expect((await monthRow(A1))!.values.APE.value).toBeNull();
      expect(await db().collection('dataUploadBatches').findOne({ _id: new mongoose.Types.ObjectId(batch.id) }))
        .toMatchObject({ status: 'failed' });
      expect(await db().collection('dataUploadBatches').findOne({ _id: inFlight.insertedId }))
        .toMatchObject({ status: 'pending' });

      // Previewed again, it goes through.
      await importFile(A, '2026-09', f);
      expect((await monthRow(A2))!.values.APE.value).toBe(100_000_000);
    });
  });

  describe('the month’s revision is its mutex', () => {
    it('lets one of two racing first writers through, and refuses the other', async () => {
      const results = await Promise.allSettled([
        wired.productionMonths.claim(A, '2026-09', 0),
        wired.productionMonths.claim(A, '2026-09', 0),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'VERSION_CONFLICT' } });
    });
  });

  describe('the history', () => {
    it('lists what went through, newest first, and offers revert on the latest standing one only', async () => {
      const a = await importFile(A, '2026-09', file('a.csv', ['PRU-001', { 'ape.monthly': '1' }]));
      await importFile(A, '2026-09', file('b.csv', ['PRU-001', { 'ape.monthly': '2' }]));
      const c = await importFile(A, '2026-09', file('c.csv', ['PRU-001', { 'ape.monthly': '3' }]));
      await wired.productionImport.revert(A, c.batch.id);

      const { batches } = await wired.productionImport.history(A, '2026-09');
      expect(batches.map((b) => [b.filename, b.status, b.canRevert])).toEqual([
        ['c.csv', 'reverted', false], ['b.csv', 'committed', true], ['a.csv', 'committed', false],
      ]);
      expect(batches[2].id).toBe(a.batch.id);
    });
  });

  describe('AC-9 — one office’s imports are nobody else’s', () => {
    it('does not let another office revert, see, or write over an import', async () => {
      const { batch } = await importFile(A, '2026-09', file('a.csv', ['PRU-001', { 'ape.monthly': '1' }]));

      await expect(wired.productionImport.revert(B, batch.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await wired.productionImport.history(B, '2026-09')).batches).toEqual([]);
      // B's file names A's agent: the code is unknown in B, and nothing of A's is touched.
      await expect(importFile(B, '2026-09', file('b.csv', ['PRU-001', { 'ape.monthly': '9' }])))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await monthRow(A1))!.values.APE.value).toBe(100_000_000);
    });

    it('locks one office’s month and not another’s', async () => {
      await wired.productionMonths.lock(B, '2026-09');
      expect(await wired.productionMonths.state(A, '2026-09')).toMatchObject({ locked: false, revision: 0 });
      await importFile(A, '2026-09', file('a.csv', ['PRU-001', { 'ape.monthly': '1' }]));
    });
  });

  describe('refusals before anything is read', () => {
    it('refuses somebody with no office, a month that is not one, and a revision that is not a number', async () => {
      const f = file('a.csv', ['PRU-001', { 'ape.monthly': '1' }]);
      await expect(wired.productionImport.commit(noOffice(), '2026-09', '0', f)).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
      await expect(wired.productionImport.revert(noOffice(), 'x')).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
      await expect(wired.productionImport.history(noOffice(), '2026-09')).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
      await expect(wired.productionImport.commit(A, 'Sep', '0', f)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      for (const revision of [undefined, '', '-1', 'one', '1.5']) {
        await expect(wired.productionImport.commit(A, '2026-09', revision, f))
          .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'revision' } });
      }
    });

    it('answers not-found for an id that is no import', async () => {
      await expect(wired.productionImport.revert(A, 'not-an-id')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.productionImport.revert(A, '66f0000000000000000000ff')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  /*
   * The P18.8 exit review, M4 (ADR-0171 §1 as noted 2026-10-27): a first sale only moves earlier — but one read from the
   * file, whose month a revert takes back, is recomputed from what remains, while no 3M result is kept.
   */
  describe('P18.8-T8 M4 — a reverted file takes back the first sale it gave', () => {
    const member = (membershipId: string) => db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(membershipId) });
    const sale = async (membershipId: string) => {
      const m = (await member(membershipId))!;
      return [m.firstSaleDate ?? null, m.firstSaleSource ?? null, m.firstSaleRecordCollection ?? null];
    };

    it('P18.8-T8 M4 revert recomputes a first sale read from the reverted month: gone, with nothing else to read', async () => {
      const { batch } = await importFile(A, '2026-09', file('sep.csv', ['PRU-001', { 'policyCount.monthly': '1' }]));
      expect(await sale(A1)).toEqual(['2026-09-01', 'monthly_file', 'monthlyAgentData']);
      await wired.productionImport.revert(A, batch.id);
      expect(await sale(A1)).toEqual([null, null, null]);
    });

    it('P18.8-T8 M4 what remains after a revert is the first sale: the month of the file still standing', async () => {
      await wired.productionMonths.reopen(A, '2026-08'); // closed on 7 September
      const august = await importFile(A, '2026-08', file('aug.csv', ['PRU-001', { 'policyCount.monthly': '2' }]));
      const september = await importFile(A, '2026-09', file('sep.csv', ['PRU-001', { 'policyCount.monthly': '1' }]));
      expect(await sale(A1)).toEqual(['2026-08-01', 'monthly_file', 'monthlyAgentData']);
      // August's was the wrong file: the first sale is September's now — later, because the earlier one was never true.
      await wired.productionImport.revert(A, august.batch.id);
      expect(await sale(A1)).toEqual(['2026-09-01', 'monthly_file', 'monthlyAgentData']);
      await wired.productionImport.revert(A, september.batch.id);
      expect(await sale(A1)).toEqual([null, null, null]);
    });

    it('P18.8-T8 M4 a kept 3M result stays through a revert, and so does the first sale it was decided by', async () => {
      const { batch } = await importFile(A, '2026-09', file('sep.csv', ['PRU-001', { 'policyCount.monthly': '1' }]));
      await db().collection('memberships').updateOne(
        { _id: new mongoose.Types.ObjectId(A1) }, { $set: { joinedAs: 'new_hire', activation3M: 'activated' } },
      );
      await wired.productionImport.revert(A, batch.id);
      expect(await sale(A1)).toEqual(['2026-09-01', 'monthly_file', 'monthlyAgentData']);
      expect((await member(A1))!.activation3M).toBe('activated');
    });

    it('P18.8-T8 M4 another office’s revert moves nobody here', async () => {
      await importFile(A, '2026-09', file('sep.csv', ['PRU-001', { 'policyCount.monthly': '1' }]));
      const { batch } = await importFile(B, '2026-09', file('sep.csv', ['PRU-900', { 'policyCount.monthly': '1' }]));
      await wired.productionImport.revert(B, batch.id);
      expect(await sale(A1)).toEqual(['2026-09-01', 'monthly_file', 'monthlyAgentData']);
      expect(await sale(B1)).toEqual([null, null, null]);
    });
  });

  /**
   * **P19.3-T1 AC-6 — the leader rows' column, committed** (ADR-0201 §2; D6). A version 2 file's *Unit Persistency (%)*
   * is written on an AB's or an AAB's row as `unitPersistencyMonthly`, imported, with the batch as its source — and is
   * not written on an agent's row, whose other figures still import. A version 1 file never touches it, and a revert
   * gives back what it held.
   */
  describe('P19.3-T1 AC-6 — Unit Persistency (%), committed on leader rows only', () => {
    /** A version 2 file: each row's code, its twelve cells by `metric.cadence`, then its unit persistency. */
    const file2 = (name: string, ...rows: [string, Cells, string][]) => ({
      buffer: Buffer.from([
        TEMPLATE_HEADER_V2.join(','),
        ...rows.map(([code, cells, unit]) => [
          code, '"x"', ...VALUE_COLUMNS.map((c) => cells[`${c.metric}.${c.cadence}`] ?? ''), unit,
        ].join(',')),
      ].join('\n')),
      originalname: name,
      size: 0,
    });

    beforeEach(async () => {
      // Budi leads: an AB, by class (ADR-0156). Rina is an agent.
      await db().collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(A2) }, { $set: { role: 'ab' } });
      await db().collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(A1) }, { $set: { role: 'agent' } });
    });

    it('P19.3-T1 AC-6 writes a leader row’s unit persistency as imported; an agent row’s is an issue, never stored', async () => {
      const { batch } = await importFile(A, '2026-09', file2('sep.csv',
        ['PRU-001', { 'ape.monthly': '1.5' }, '85'],
        ['PRU-002', { 'ape.monthly': '2' }, '82.5'],
      ));
      // `templateVersion` is the template's version the file was read against since P19.5-T2 (R6), not the header's.
      expect(batch).toMatchObject({ templateVersion: 1, writtenRowCount: 2, cellCount: 3, issueCount: 1 });

      const budi = await monthRow(A2);
      expect(budi!.values.UNIT_PERSISTENCY).toEqual({
        value: 82.5, provenance: 'imported', sourceBatchId: batch.id,
        correctedBy: null, correctedAt: null, reason: null, replacedValue: null,
      });
      const rina = await monthRow(A1);
      expect(rina!.values.APE).toMatchObject({ value: 150_000_000, provenance: 'imported' });
      expect(rina!.values.UNIT_PERSISTENCY?.value ?? null).toBeNull();

      // The batch keeps the issue, in the importer's words.
      const rows = await db().collection('dataUploadRows').find({ batchId: batch.id }).sort({ line: 1 }).toArray();
      expect(rows[0].issues).toEqual([expect.objectContaining({ code: 'UPLOAD_LEADER_ONLY_VALUE', kode: 'UNIT_PERSISTENCY' })]);
      expect(rows[0].values).toEqual({ APE: 150_000_000 });
      expect(rows[1].values).toEqual({ APE: 200_000_000, UNIT_PERSISTENCY: 82.5 });

      // The month table shows it, on the leader's row, and says whose rows are leaders'.
      const view = await wired.production.readMonth(A, '2026-09');
      const row = (id: string) => view.rows.find((r) => r.membershipId === id)!;
      expect(row(A2)).toMatchObject({ leader: true, values: { UNIT_PERSISTENCY: { value: 82.5, provenance: 'imported', correction: null } } });
      expect(row(A1)).toMatchObject({ leader: false, values: { UNIT_PERSISTENCY: { value: null, provenance: null } } });
    });

    it('P19.3-T1 AC-6 a file without the column imports exactly as before, and never clears a unit persistency held', async () => {
      await importFile(A, '2026-09', file2('first.csv', ['PRU-002', {}, '80']));
      const { batch } = await importFile(A, '2026-09', file('v1.csv', ['PRU-002', { 'ape.monthly': '3' }]));
      expect(batch).toMatchObject({ templateVersion: 1, cellCount: 1, issueCount: 0 });
      const budi = await monthRow(A2);
      expect(budi!.values.APE).toMatchObject({ value: 300_000_000, sourceBatchId: batch.id });
      expect(budi!.values.UNIT_PERSISTENCY).toMatchObject({ value: 80, provenance: 'imported' });
      // And a version 2 file with the column blank keeps it too (ADR-0051).
      await importFile(A, '2026-09', file2('blank.csv', ['PRU-002', { 'ape.monthly': '4' }, '']));
      expect((await monthRow(A2))!.values.UNIT_PERSISTENCY).toMatchObject({ value: 80 });
    });

    it('P19.3-T1 AC-6 a revert gives back the unit persistency the file replaced — empty, or the figure before it', async () => {
      const first = await importFile(A, '2026-09', file2('first.csv', ['PRU-002', {}, '80']));
      const second = await importFile(A, '2026-09', file2('second.csv', ['PRU-002', {}, '88']));
      expect((await monthRow(A2))!.values.UNIT_PERSISTENCY).toMatchObject({ value: 88, sourceBatchId: second.batch.id });
      await wired.productionImport.revert(A, second.batch.id);
      expect((await monthRow(A2))!.values.UNIT_PERSISTENCY).toMatchObject({ value: 80, sourceBatchId: first.batch.id });
      await wired.productionImport.revert(A, first.batch.id);
      expect((await monthRow(A2))!.values.UNIT_PERSISTENCY?.value ?? null).toBeNull();
    });

    it('P19.3-T1 AC-6 one office’s file reaches none of another’s leaders (invariant §1)', async () => {
      await db().collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(B1) }, { $set: { role: 'ab' } });
      // Office B's file naming A's leader: an unknown code there, and A's row untouched.
      const p = await wired.production.preview(B, '2026-09', file2('b.csv', ['PRU-002', {}, '80'], ['PRU-900', {}, '70']));
      expect(p.rows[0].issues.map((i) => i.code)).toEqual([expect.stringMatching(/^UPLOAD_(UNKNOWN_AGENT_CODE|AGENT_CODE_PATTERN)$/)]);
      await wired.productionImport.commit(B, '2026-09', String(p.revision),
        file2('b.csv', ['PRU-002', {}, '80'], ['PRU-900', {}, '70']));
      expect(await monthRow(A2)).toBeNull();
      expect((await db().collection('monthlyAgentData').findOne({ membershipId: B1 }))!.values.UNIT_PERSISTENCY)
        .toMatchObject({ value: 70, provenance: 'imported' });
      // And A's month table holds nothing of B's.
      expect((await wired.production.readMonth(A, '2026-09')).rows.every((r) => r.values.UNIT_PERSISTENCY.value === null)).toBe(true);
    });
  });
});
