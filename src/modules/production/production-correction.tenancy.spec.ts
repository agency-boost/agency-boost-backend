import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import type { DomainException } from '@/common/errors/domain.exception';
import { readerIn } from '@/common/i18n/reader';
import { UNIT_DASHBOARD_MESSAGES } from '@/domain/constants/unit-dashboard.messages';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { MonthlyAgentData } from './monthly-agent-data.schema';
import { ProductionMonth } from './production-month.schema';
import { TEMPLATE_HEADER_V1 } from './production-template';

/** The twelve value columns of a version 1 file, keyed `metric.cadence` as these specs name them. */
const VALUE_COLUMNS = (['monthly', 'ytd'] as const).flatMap((cadence) =>
  (['ape', 'persistency', 'recruitment', 'newActiveAgents', 'fyp', 'policyCount'] as const).map((metric) => ({ metric, cadence })));

// 09:00 on 27 September in Jakarta: September is open; August locked on 7 September.
const NOW = new Date('2026-09-27T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const A1 = '66f000000000000000000101';
const A2 = '66f000000000000000000102';
const A_PENDING = '66f000000000000000000103';
const B1 = '66f000000000000000000201';

const ctxFor = (kpmId: string, membershipId: string) => new RequestContext('u-' + membershipId.slice(-3), 'none', {
  membershipId, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);
const A = ctxFor(KPM_A, A1);
const B = ctxFor(KPM_B, B1);

function person(id: string, kpmId: string, code: string, status = 'active') {
  return {
    _id: new mongoose.Types.ObjectId(id), kpmId, userId: '66f000000000000000003' + id.slice(-3),
    agentCode: code, agentSeq: Number(id.slice(-1)), leaderCode: `LC-${id.slice(-3)}`, orgLevelCode: 'AGENT',
    hierarchyRole: 'agent', leaderId: null, ancestorIds: [], status, deletedAt: null,
  };
}

const file = (...rows: [string, Record<string, string>][]) => ({
  buffer: Buffer.from([
    TEMPLATE_HEADER_V1.join(','),
    ...rows.map(([code, cells]) => [code, '"x"', ...VALUE_COLUMNS.map((c) => cells[`${c.metric}.${c.cadence}`] ?? '')].join(',')),
  ].join('\n')),
  originalname: 'f.csv',
  size: 0,
});

describe('correcting one figure by hand (P9-T5)', () => {
  let wired: ReturnType<typeof configModule>;
  const db = () => mongoose.connection.db!;
  const monthRow = (membershipId: string, month = '2026-09') => db().collection('monthlyAgentData').findOne({ membershipId, month });
  const revisionOf = async (month = '2026-09') => (await wired.productionMonths.state(A, month)).revision;

  /** What the screen sends: the figure, the month's revision it read, and a reason. */
  const correct = async (over: Record<string, unknown> = {}, ctx = A) => wired.productionCorrections.correct(ctx, {
    month: '2026-09', membershipId: A1, kode: 'APE', ytd: false, value: 200_000_000,
    revision: await revisionOf((over.month as string) ?? '2026-09'), reason: 'The carrier restated it by email', ...over,
  } as never);

  const importFile = async (f: ReturnType<typeof file>, month = '2026-09') => {
    const p = await wired.production.preview(A, month, f);
    return wired.productionImport.commit(A, month, String(p.revision), f);
  };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    for (const name of [MonthlyAgentData.name, ProductionMonth.name]) await mongoose.model(name).syncIndexes();
    await db().collection('kpms').insertMany([
      { _id: new mongoose.Types.ObjectId(KPM_A), code: '0417', timezone: 'Asia/Jakarta', settings: { productionLockGraceDays: 7 } },
      { _id: new mongoose.Types.ObjectId(KPM_B), code: '0555', timezone: 'Asia/Jakarta', settings: { productionLockGraceDays: 7 } },
    ] as never);
    await db().collection('memberships').insertMany([
      person(A1, KPM_A, 'PRU-001'), person(A2, KPM_A, 'PRU-002'), person(A_PENDING, KPM_A, 'PRU-003', 'pending'),
      person(B1, KPM_B, 'PRU-900'),
    ] as never);
  });

  describe('AC-2 — an accepted correction is corrected, attributed and audited', () => {
    it('writes the figure as corrected, with who, when and why — creating the month row when there was none', async () => {
      const r = await correct();

      expect(r).toMatchObject({
        changed: true, before: { value: null, provenance: null }, after: { value: 200_000_000, provenance: 'corrected' },
        state: { revision: 1 },
      });
      const row = await monthRow(A1);
      expect(row).toMatchObject({ kpmId: KPM_A, agentCode: 'PRU-001' });
      expect(row!.values.APE).toEqual({
        value: 200_000_000, provenance: 'corrected', sourceBatchId: null,
        correctedBy: A1, correctedAt: NOW, reason: 'The carrier restated it by email',
        // Nothing was there: the correction replaced no figure.
        replacedValue: null,
      });
    });

    it('audits the figure before and after, who, and the reason', async () => {
      const { batch } = await importFile(file(['PRU-001', { 'ape.monthly': '1.5' }]));
      await correct();

      const entry = await db().collection('auditLog').findOne({ action: 'upload.cell_corrected' });
      expect(entry).toMatchObject({
        kpmId: KPM_A, actorMembershipId: A1, targetMembershipId: A1, targetCollection: 'monthlyAgentData',
        // The cell by its key since P19.5-T2: the kode (`cellKey`).
        before: { month: '2026-09', field: 'APE', value: 150_000_000, provenance: 'imported', sourceBatchId: batch.id },
        after: { month: '2026-09', field: 'APE', value: 200_000_000, provenance: 'corrected', reason: 'The carrier restated it by email' },
      });
      expect(entry!.createdAt).toBeInstanceOf(Date);
    });

    it('trims the reason, and refuses a correction without one', async () => {
      await expect(correct({ reason: '   ' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'reason' } });
      await expect(correct({ reason: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await correct({ reason: '  typo in the carrier file  ' });
      expect((await monthRow(A1))!.values.APE.reason).toBe('typo in the carrier file');
    });

    it('writes nothing, audits nothing and advances nothing for a figure already holding that value', async () => {
      await correct();
      const r = await correct();
      expect(r).toMatchObject({ changed: false, state: { revision: 1 } });
      expect(await db().collection('auditLog').countDocuments({ action: 'upload.cell_corrected' })).toBe(1);
    });
  });

  describe('AC-1, AC-5 — an invalid figure is refused with the reason, and nothing changes', () => {
    it.each([
      [{ value: -1 }, 'APE this month is negative.'],
      [{ kode: 'PERSISTENCY', value: 140 }, 'Persistensi rolling this month is above 100 — persistency is a percentage.'],
      [{ kode: 'POLICY_COUNT', value: 2.5 }, 'Jumlah polis (case issued) this month is not a whole number — this column counts.'],
      [{ value: 1.5 }, 'APE this month is a fraction of a sen.'],
    ] as [Record<string, unknown>, string][])('refuses %j — the column named by its label (P19.5-T2)', async (over, message) => {
      await expect(correct(over)).rejects.toMatchObject({
        code: 'UPLOAD_VALUE_OUT_OF_RANGE', message, details: { kode: (over as { kode?: string }).kode ?? 'APE', ytd: false },
      });
      expect(await monthRow(A1)).toBeNull();
      expect(await revisionOf()).toBe(0);
    });

    it('P19.5-T2 AC-7 refuses a year to date that is calculated — APE’s is the sum of its months; the month is corrected', async () => {
      await importFile(file(['PRU-001', { 'ape.monthly': '1' }]));
      await expect(correct({ ytd: true, value: 900_000_000 })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED', details: { field: 'ytd', kode: 'APE' },
        message: 'APE year to date is calculated from the months. Correct the month instead.',
      });
      // A column with no year to date at all is refused the same way.
      await expect(correct({ kode: 'PERSISTENCY', ytd: true, value: 80 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      // And the month goes through.
      await correct({ value: 600_000_000 });
      expect((await monthRow(A1))!.values.APE.value).toBe(600_000_000);
      expect(await revisionOf()).toBe(2);
    });

    it('P19.5-T2 refuses a kode the template holds no column for', async () => {
      await expect(correct({ kode: 'BONUS' })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED', details: { field: 'kode', kode: 'BONUS' },
      });
    });
  });

  describe('AC-4 — clearing is possible here, and audited', () => {
    it('empties a figure as corrected, with the reason', async () => {
      await importFile(file(['PRU-001', { 'ape.monthly': '1.5' }]));
      const r = await correct({ value: null, reason: 'Belongs to August, not September' });

      expect(r.after).toEqual({ value: null, provenance: 'corrected' });
      expect((await monthRow(A1))!.values.APE).toMatchObject({ value: null, provenance: 'corrected', reason: 'Belongs to August, not September' });
      expect(await db().collection('auditLog').findOne({ action: 'upload.cell_corrected' }))
        .toMatchObject({ before: { value: 150_000_000 }, after: { value: null } });
      const view = await wired.production.readMonth(A, '2026-09');
      expect(view.withData).toBe(0);
    });
  });

  describe('AC-6 — a locked month refuses a correction', () => {
    it('refuses one after the window, and takes it once the month is reopened', async () => {
      // August was written on its last day: a written month keeps its schedule (ADR-0214 §11).
      await db().collection('productionMonths').insertOne({ kpmId: KPM_A, month: '2026-08', revision: 1, firstWrittenOn: '2026-08-31', deletedAt: null });
      await expect(correct({ month: '2026-08' })).rejects.toMatchObject({ code: 'UPLOAD_MONTH_LOCKED', details: { month: '2026-08' } });
      await wired.productionMonths.reopen(A, '2026-08');
      await correct({ month: '2026-08' });
      expect((await monthRow(A1, '2026-08'))!.values.APE.provenance).toBe('corrected');
    });

    it('refuses one into a month locked by hand', async () => {
      await wired.productionMonths.lock(A, '2026-09');
      await expect(correct()).rejects.toMatchObject({ code: 'UPLOAD_MONTH_LOCKED' });
    });
  });

  describe('the month’s revision', () => {
    it('refuses a correction of a month that moved while it was read', async () => {
      const seen = await revisionOf();
      await importFile(file(['PRU-002', { 'ape.monthly': '1' }]));
      await expect(correct({ revision: seen })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await monthRow(A1)).toBeNull();
    });
  });

  describe('with the import’s revert', () => {
    it('is kept by a revert of the import it corrected, which counts it', async () => {
      const { batch } = await importFile(file(['PRU-001', { 'ape.monthly': '1', 'fyp.monthly': '1' }]));
      await correct({ kode: 'FYP', value: 70_000_000 });

      const reverted = await wired.productionImport.revert(A, batch.id);

      expect(reverted.batch).toMatchObject({ restoredCellCount: 1, keptCellCount: 1 });
      const row = await monthRow(A1);
      expect(row!.values.APE.value).toBeNull();
      expect(row!.values.FYP).toMatchObject({ value: 70_000_000, provenance: 'corrected' });
    });
  });

  describe('AC-3 — a later import keeps a correction unless it is ticked (ADR-0053)', () => {
    const importWith = async (f: ReturnType<typeof file>, replace?: string) => {
      const p = await wired.production.preview(A, '2026-09', f);
      return wired.productionImport.commit(A, '2026-09', String(p.revision), f, replace);
    };

    it('remembers the figure a chain of corrections replaced — the first, not the last hand’s', async () => {
      await importFile(file(['PRU-001', { 'ape.monthly': '1.5' }]));
      await correct({ value: 200_000_000 });
      await correct({ value: 300_000_000 });
      expect((await monthRow(A1))!.values.APE.replacedValue).toBe(150_000_000);
    });

    it('lists a corrected figure the file would change, with who, when, why and what it replaced', async () => {
      await importFile(file(['PRU-001', { 'ape.monthly': '1.5' }]));
      await correct({ value: 200_000_000 });

      const p = await wired.production.preview(A, '2026-09', file(['PRU-001', { 'ape.monthly': '1.5', 'fyp.monthly': '1' }]));

      const ape = p.rows[0].cells.find((c) => c.kode === 'APE' && !c.ytd)!;
      expect(ape).toMatchObject({
        status: 'changed', before: 200_000_000, after: 150_000_000,
        correction: {
          by: null, at: NOW.toISOString(), reason: 'The carrier restated it by email',
          // The file carries the very figure the correction replaced: the old file, uploaded again.
          replacedValue: 150_000_000,
        },
      });
      expect(p.rows[0].cells.find((c) => c.kode === 'FYP' && !c.ytd)!.correction).toBeNull();
      expect(p.summary.correctionCells).toBe(1);
    });

    it('names who corrected it', async () => {
      await db().collection('users').insertOne({
        _id: new mongoose.Types.ObjectId('66f000000000000000003101'), email: 'r@k.test', fullName: 'Rina Wijaya', deletedAt: null,
      } as never);
      await correct();
      const p = await wired.production.preview(A, '2026-09', file(['PRU-001', { 'ape.monthly': '9' }]));
      expect(p.rows[0].cells[0].correction!.by).toBe('Rina Wijaya');
    });

    it('does not list a correction the file agrees with, or leaves blank', async () => {
      await correct({ value: 200_000_000 });
      const same = await wired.production.preview(A, '2026-09', file(['PRU-001', { 'ape.monthly': '2' }]));
      const blank = await wired.production.preview(A, '2026-09', file(['PRU-001', { 'fyp.monthly': '1' }]));
      expect(same.summary.correctionCells).toBe(0);
      expect(same.rows[0].cells[0].status).toBe('unchanged');
      expect(blank.summary.correctionCells).toBe(0);
    });

    it('lists a figure somebody cleared by hand, which the file would fill again', async () => {
      await importFile(file(['PRU-001', { 'ape.monthly': '1.5' }]));
      await correct({ value: null, reason: 'Belongs to August' });
      const p = await wired.production.preview(A, '2026-09', file(['PRU-001', { 'ape.monthly': '1.5' }]));
      expect(p.rows[0].cells[0]).toMatchObject({ status: 'new', correction: { reason: 'Belongs to August', replacedValue: 150_000_000 } });
    });

    it('keeps an unticked correction and writes the rest of the file', async () => {
      await importFile(file(['PRU-001', { 'ape.monthly': '1.5' }]));
      await correct({ value: 200_000_000 });

      const { batch } = await importWith(file(['PRU-001', { 'ape.monthly': '1.5', 'fyp.monthly': '1' }]));

      expect(batch).toMatchObject({ cellCount: 1, keptCorrectionCount: 1, replacedCorrectionCount: 0 });
      const row = await monthRow(A1);
      expect(row!.values.APE).toMatchObject({ value: 200_000_000, provenance: 'corrected', reason: 'The carrier restated it by email' });
      expect(row!.values.FYP).toMatchObject({ value: 100_000_000, provenance: 'imported' });
      expect(await db().collection('auditLog').findOne({ action: 'upload.commit', 'after.keptCorrectionCount': 1 })).toBeTruthy();
    });

    it('replaces a ticked one with the file’s figure — and a revert of that import brings the correction back whole', async () => {
      await importFile(file(['PRU-001', { 'ape.monthly': '1.5' }]));
      await correct({ value: 200_000_000 });
      const corrected = (await monthRow(A1))!.values.APE;

      const { batch } = await importWith(file(['PRU-001', { 'ape.monthly': '1.7' }]), `${A1}:APE`);

      expect(batch).toMatchObject({ keptCorrectionCount: 0, replacedCorrectionCount: 1 });
      expect((await monthRow(A1))!.values.APE).toMatchObject({
        value: 170_000_000, provenance: 'imported', sourceBatchId: batch.id, reason: null, replacedValue: null,
      });

      await wired.productionImport.revert(A, batch.id);
      expect((await monthRow(A1))!.values.APE).toEqual(corrected);
    });

    it('refuses a correction named to be replaced that the file would not change', async () => {
      await correct({ value: 200_000_000 });
      await expect(importWith(file(['PRU-001', { 'fyp.monthly': '1' }]), `${A1}:APE`)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED', details: { field: 'replace', key: `${A1}:APE` },
      });
    });

    it('refuses a file whose only change is a correction left unticked — it would change nothing', async () => {
      await correct({ value: 200_000_000 });
      await expect(importWith(file(['PRU-001', { 'ape.monthly': '1.5' }]))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await monthRow(A1))!.values.APE.value).toBe(200_000_000);
    });
  });

  /*
   * **P18.10-T5 AC-6 — a stored sentence.** A reason a person typed is stored as typed, whatever language they read in;
   * a reason the API writes for them — the Unit Dashboard's *Update production* — is written in the language of the
   * leader saving, stored as text, and read back as stored by every later reader, in either language.
   */
  describe('P18.10-T5 AC-6 — the reason, stored in the words it was written in', () => {
    const IN_ID = ctxFor(KPM_A, A1).withReader(readerIn('id'));
    /** A leader reading English, named: nobody's choice is Bahasa Indonesia since P18.10-T4's exit. */
    const IN_EN = A.withReader(readerIn('en'));
    const saveApe = async (
      ctx: RequestContext, row: { apeMonthlyMinor?: number; apeYtdMinor?: number }, reason: Parameters<typeof wired.productionCorrections.correctApe>[1]['reason'],
    ) => wired.productionCorrections.correctApe(ctx, {
      month: '2026-09', revision: await revisionOf(), rows: [{ membershipId: A1, ...row }], reason, surface: 'unit_dashboard',
    });
    const cellOf = async (ctx: RequestContext) => (await wired.production.readMonth(ctx, '2026-09')).rows
      .find((row) => row.membershipId === A1)!.values.APE;

    it('writes the API’s own reason in the saving leader’s language, as text, and reads it as stored in either', async () => {
      await saveApe(IN_ID, { apeMonthlyMinor: 200_000_000 }, UNIT_DASHBOARD_MESSAGES.correctionReason);
      expect((await monthRow(A1))!.values.APE.reason).toBe('Diperbarui di Unit Dashboard dari laporan perusahaan.');
      await saveApe(IN_EN, { apeMonthlyMinor: 300_000_000 }, UNIT_DASHBOARD_MESSAGES.correctionReason);
      expect((await monthRow(A1))!.values.APE.reason).toBe('Updated on the Unit Dashboard from the company report.');
      // The audit keeps the words that were written, beside the figure.
      const audited = await db().collection('auditLog').find({ action: 'upload.cell_corrected' }).sort({ _id: 1 }).toArray();
      expect(audited.map((entry) => entry.after.reason)).toEqual([
        'Diperbarui di Unit Dashboard dari laporan perusahaan.', 'Updated on the Unit Dashboard from the company report.',
      ]);
      // Stored as text: an Indonesian reader reads the English a leader saved — never re-written.
      for (const ctx of [IN_EN, IN_ID]) {
        expect((await cellOf(ctx)).correction!.reason).toBe('Updated on the Unit Dashboard from the company report.');
      }
    });

    it('stores a reason a person typed as typed, whatever language they read the product in', async () => {
      await correct({ reason: 'Carrier mengoreksi lewat email' });
      expect((await monthRow(A1))!.values.APE.reason).toBe('Carrier mengoreksi lewat email');
      expect((await cellOf(IN_ID)).correction!.reason).toBe('Carrier mengoreksi lewat email');
    });

    it('P19.5-T2 AC-7 a leader’s save of APE’s year to date is refused: it is the sum of the months (R4)', async () => {
      await expect(saveApe(IN_ID, { apeYtdMinor: 900_000_000 }, 'x')).rejects.toMatchObject({
        code: 'VALIDATION_FAILED', details: { field: 'apeYtdMinor', membershipId: A1 },
      });
      expect(await monthRow(A1)).toBeNull();
    });

    it('P18.10-T5 AC-2 refuses a correction in the reader’s language: the reason, the figure, the order to correct in', async () => {
      const said = async (call: Promise<unknown>) => {
        const refusal = (await call.catch((err: unknown) => err)) as DomainException;
        return [refusal.code, refusal.message, refusal.messageFor(readerIn('id'))];
      };
      expect(await said(correct({ reason: 'x'.repeat(501) }))).toEqual([
        'VALIDATION_FAILED', 'Keep the reason under 500 characters.', 'Alasan tidak boleh lebih dari 500 karakter.',
      ]);
      expect(await said(correct({ kode: 'POLICY_COUNT', value: 2.5 }))).toEqual([
        'UPLOAD_VALUE_OUT_OF_RANGE', 'Jumlah polis (case issued) this month is not a whole number — this column counts.',
        'Jumlah polis (case issued) bulan ini bukan bilangan bulat — kolom ini menghitung.',
      ]);
      expect(await said(correct({ ytd: true, value: 50_000_000 }))).toEqual([
        'VALIDATION_FAILED', 'APE year to date is calculated from the months. Correct the month instead.',
        'YTD APE dihitung dari bulan-bulannya. Koreksi angka bulannya.',
      ]);
      // A leader's save: the same rules.
      expect(await said(saveApe(A, { apeYtdMinor: 50_000_000 }, 'x'))).toEqual([
        'VALIDATION_FAILED', 'APE year to date is calculated from the months. Correct the month instead.',
        'YTD APE dihitung dari bulan-bulannya. Koreksi angka bulannya.',
      ]);
      expect(await said(saveApe(A, { apeMonthlyMinor: 1.5 }, 'x'))).toEqual([
        'UPLOAD_VALUE_OUT_OF_RANGE', 'APE this month is a fraction of a sen.', 'APE bulan ini berupa pecahan sen.',
      ]);
    });
  });

  describe('AC-7 — only an active member of this office', () => {
    it('does not reach another office’s member, or a pending one', async () => {
      await expect(correct({ membershipId: B1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(correct({ membershipId: A_PENDING })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(correct({ membershipId: 'not-an-id' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await db().collection('monthlyAgentData').countDocuments()).toBe(0);
    });

    it('does not let another office correct this one’s figures', async () => {
      await importFile(file(['PRU-001', { 'ape.monthly': '1' }]));
      await expect(correct({}, B)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await monthRow(A1))!.values.APE.value).toBe(100_000_000);
    });

    it('refuses somebody with no office, and a month that is not one', async () => {
      const none = new RequestContext('u9', 'none', null);
      await expect(wired.productionCorrections.correct(none, {
        month: '2026-09', membershipId: A1, kode: 'APE', ytd: false, value: 1, revision: 0, reason: 'x',
      })).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
      await expect(correct({ month: 'Sep' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });
});
