import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { DataUploadBatch } from './data-upload-batch.schema';
import { MonthlyAgentData } from './monthly-agent-data.schema';
import { ProductionMonth } from './production-month.schema';
import { VALUE_COLUMNS } from './production-preview';
import { TEMPLATE_HEADER_V1 } from './production-template';

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
  /** The twelve figures of a row, and nothing about when it was last touched. */
  const figuresOf = async (membershipId: string) => {
    const row = await monthRow(membershipId);
    return VALUE_COLUMNS.map((c) => row?.[`${c.metric}${c.cadence === 'monthly' ? 'Monthly' : 'Ytd'}`]);
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
        rowCount: 2, writtenRowCount: 1, cellCount: 2, issueCount: 1,
        committedBy: 'Rina Wijaya', canRevert: true,
      });
      expect(state).toMatchObject({ revision: 1, locked: false, reason: 'open' });

      const row = await monthRow(A1);
      // An imported figure carries no correction: who, when and why are empty.
      expect(row!.apeMonthly).toEqual({
        value: 150_000_000, provenance: 'imported', sourceBatchId: batch.id,
        correctedBy: null, correctedAt: null, reason: null,
      });
      expect(row!.apeYtd).toMatchObject({ value: 600_000_000, provenance: 'imported', sourceBatchId: batch.id });
      expect(row!.fypMonthly.value ?? null).toBeNull();

      const view = await wired.production.readMonth(A, '2026-09');
      expect(view.rows.find((r) => r.membershipId === A1)!.metrics.ape.monthly)
        .toEqual({ value: 150_000_000, provenance: 'imported' });
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
        values: { apeMonthly: 150_000_000 },
        // No month row existed, so there was nothing to hold it.
        previousValues: { apeMonthly: null },
      });
      expect(rows[1]).toMatchObject({ line: 3, membershipId: null, status: 'refused', issues: [{ code: 'UPLOAD_UNKNOWN_AGENT_CODE' }] });
      // Wrote nothing — an empty object, which the store keeps as no field at all.
      expect(rows[1].values ?? {}).toEqual({});
    });

    it('leaves a figure already as stored alone — its provenance and its source with it', async () => {
      const first = await importFile(A, '2026-09', file('a.csv', ['PRU-001', { 'ape.monthly': '1', 'fyp.monthly': '1' }]));
      const second = await importFile(A, '2026-09', file('b.csv', ['PRU-001', { 'ape.monthly': '1', 'fyp.monthly': '2' }]));
      const row = await monthRow(A1);
      expect(row!.apeMonthly.sourceBatchId).toBe(first.batch.id);
      expect(row!.fypMonthly.sourceBatchId).toBe(second.batch.id);
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
      expect(row1!.apeMonthly.value).toBe(100_000_000);
      for (const c of VALUE_COLUMNS.slice(1)) {
        const field = `${c.metric}${c.cadence === 'monthly' ? 'Monthly' : 'Ytd'}`;
        expect(row1![field].value).not.toBeNull();
      }
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
      expect(row!.apeMonthly).toMatchObject({ value: 100_000_000, provenance: 'imported', sourceBatchId: first.batch.id });
      expect(row!.persistencyMonthly.value).toBe(90);
      expect(row!.fypMonthly).toMatchObject({ value: null, provenance: null, sourceBatchId: null });
    });

    it('keeps a figure something else has written since, and counts it', async () => {
      const { batch } = await importFile(A, '2026-09', file('a.csv', ['PRU-001', { 'ape.monthly': '1', 'fyp.monthly': '1' }]));
      // What a correction (P9-T5) will do: the figure is somebody else's now.
      await db().collection('monthlyAgentData').updateOne(
        { membershipId: A1 }, { $set: { fypMonthly: { value: 7, provenance: 'corrected', sourceBatchId: null } } },
      );

      const reverted = await wired.productionImport.revert(A, batch.id);

      expect(reverted.batch).toMatchObject({ restoredCellCount: 1, keptCellCount: 1 });
      const row = await monthRow(A1);
      expect(row!.apeMonthly.value).toBeNull();
      expect(row!.fypMonthly).toEqual({ value: 7, provenance: 'corrected', sourceBatchId: null });
    });

    it('takes only the latest standing import, then the one beneath it', async () => {
      const first = await importFile(A, '2026-09', file('a.csv', ['PRU-001', { 'ape.monthly': '1' }]));
      const second = await importFile(A, '2026-09', file('b.csv', ['PRU-001', { 'ape.monthly': '2' }]));

      await expect(wired.productionImport.revert(A, first.batch.id)).rejects.toMatchObject({
        code: 'UPLOAD_BATCH_NOT_LATEST', details: { latestBatchId: second.batch.id },
      });
      await wired.productionImport.revert(A, second.batch.id);
      await wired.productionImport.revert(A, first.batch.id);
      expect((await monthRow(A1))!.apeMonthly.value).toBeNull();
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
        code: 'UPLOAD_MONTH_LOCKED', details: { month: '2026-08', reason: 'schedule' },
      });

      const reopened = await wired.productionMonths.reopen(A, '2026-08');
      expect(reopened).toMatchObject({ locked: false, reason: 'reopened', changedBy: 'Rina Wijaya' });
      expect(await db().collection('auditLog').findOne({ action: 'upload.month_reopened' }))
        .toMatchObject({ targetId: '2026-08', before: { locked: true, reason: 'schedule' }, after: { locked: false } });

      await importFile(A, '2026-08', f);
      expect((await monthRow(A1, '2026-08'))!.apeMonthly.value).toBe(100_000_000);
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

    it('leaves a month already in the state asked for as it is, and audits nothing', async () => {
      await wired.productionMonths.lock(A, '2026-08');
      await wired.productionMonths.reopen(A, '2026-09');
      expect(await db().collection('auditLog').countDocuments()).toBe(0);
      expect(await db().collection('productionMonths').countDocuments()).toBe(0);
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

      expect((await monthRow(A1))!.apeMonthly.value).toBeNull();
      expect(await db().collection('dataUploadBatches').findOne({ _id: new mongoose.Types.ObjectId(batch.id) }))
        .toMatchObject({ status: 'failed' });
      expect(await db().collection('dataUploadBatches').findOne({ _id: inFlight.insertedId }))
        .toMatchObject({ status: 'pending' });

      // Previewed again, it goes through.
      await importFile(A, '2026-09', f);
      expect((await monthRow(A2))!.apeMonthly.value).toBe(100_000_000);
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
      expect((await monthRow(A1))!.apeMonthly.value).toBe(100_000_000);
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
});
