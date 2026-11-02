import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import type { DomainException } from '@/common/errors/domain.exception';
import { readerIn } from '@/common/i18n/reader';
import { UNIT_DASHBOARD_MESSAGES } from '@/domain/constants/unit-dashboard.messages';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { MonthlyAgentData } from './monthly-agent-data.schema';
import { ProductionMonth } from './production-month.schema';
import { VALUE_COLUMNS } from './production-preview';
import { TEMPLATE_HEADER_V1 } from './production-template';

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
    month: '2026-09', membershipId: A1, metric: 'ape', cadence: 'monthly', value: 200_000_000,
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
      expect(row!.apeMonthly).toEqual({
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
        before: { month: '2026-09', field: 'apeMonthly', value: 150_000_000, provenance: 'imported', sourceBatchId: batch.id },
        after: { month: '2026-09', field: 'apeMonthly', value: 200_000_000, provenance: 'corrected', reason: 'The carrier restated it by email' },
      });
      expect(entry!.createdAt).toBeInstanceOf(Date);
    });

    it('trims the reason, and refuses a correction without one', async () => {
      await expect(correct({ reason: '   ' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'reason' } });
      await expect(correct({ reason: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await correct({ reason: '  typo in the carrier file  ' });
      expect((await monthRow(A1))!.apeMonthly.reason).toBe('typo in the carrier file');
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
      [{ metric: 'persistency', value: 140 }, 'Rolling persistency this month is above 100 — persistency is a percentage.'],
      [{ metric: 'policyCount', cadence: 'ytd', value: 2.5 }, '# of policy year to date is not a whole number — it counts policies.'],
      [{ value: 1.5 }, 'APE this month is a fraction of a sen.'],
    ] as [Record<string, unknown>, string][])('refuses %j', async (over, message) => {
      await expect(correct(over)).rejects.toMatchObject({
        code: 'UPLOAD_VALUE_OUT_OF_RANGE', message, details: { metric: (over as { metric?: string }).metric ?? 'ape' },
      });
      expect(await monthRow(A1)).toBeNull();
      expect(await revisionOf()).toBe(0);
    });

    it('keeps the year to date at least the month, and says which to correct first', async () => {
      await importFile(file(['PRU-001', { 'ape.monthly': '1', 'ape.ytd': '5' }]));

      await expect(correct({ value: 600_000_000 })).rejects.toMatchObject({
        code: 'UPLOAD_VALUE_OUT_OF_RANGE', message: expect.stringContaining('Correct the year to date first.'),
      });
      await expect(correct({ cadence: 'ytd', value: 50_000_000 })).rejects.toMatchObject({
        message: expect.stringContaining('Correct this month first.'),
      });

      // In the order it says, both go through.
      await correct({ cadence: 'ytd', value: 900_000_000 });
      await correct({ value: 600_000_000 });
      expect((await monthRow(A1))!.apeMonthly.value).toBe(600_000_000);
    });

    it('does not hold persistency’s year to the month — it is a rate', async () => {
      await importFile(file(['PRU-001', { 'persistency.monthly': '95' }]));
      await correct({ metric: 'persistency', cadence: 'ytd', value: 80 });
      expect((await monthRow(A1))!.persistencyYtd.value).toBe(80);
    });
  });

  describe('AC-4 — clearing is possible here, and audited', () => {
    it('empties a figure as corrected, with the reason', async () => {
      await importFile(file(['PRU-001', { 'ape.monthly': '1.5' }]));
      const r = await correct({ value: null, reason: 'Belongs to August, not September' });

      expect(r.after).toEqual({ value: null, provenance: 'corrected' });
      expect((await monthRow(A1))!.apeMonthly).toMatchObject({ value: null, provenance: 'corrected', reason: 'Belongs to August, not September' });
      expect(await db().collection('auditLog').findOne({ action: 'upload.cell_corrected' }))
        .toMatchObject({ before: { value: 150_000_000 }, after: { value: null } });
      const view = await wired.production.readMonth(A, '2026-09');
      expect(view.withData).toBe(0);
    });
  });

  describe('AC-6 — a locked month refuses a correction', () => {
    it('refuses one after the window, and takes it once the month is reopened', async () => {
      await expect(correct({ month: '2026-08' })).rejects.toMatchObject({ code: 'UPLOAD_MONTH_LOCKED', details: { month: '2026-08' } });
      await wired.productionMonths.reopen(A, '2026-08');
      await correct({ month: '2026-08' });
      expect((await monthRow(A1, '2026-08'))!.apeMonthly.provenance).toBe('corrected');
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
      await correct({ metric: 'fyp', value: 70_000_000 });

      const reverted = await wired.productionImport.revert(A, batch.id);

      expect(reverted.batch).toMatchObject({ restoredCellCount: 1, keptCellCount: 1 });
      const row = await monthRow(A1);
      expect(row!.apeMonthly.value).toBeNull();
      expect(row!.fypMonthly).toMatchObject({ value: 70_000_000, provenance: 'corrected' });
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
      expect((await monthRow(A1))!.apeMonthly.replacedValue).toBe(150_000_000);
    });

    it('lists a corrected figure the file would change, with who, when, why and what it replaced', async () => {
      await importFile(file(['PRU-001', { 'ape.monthly': '1.5' }]));
      await correct({ value: 200_000_000 });

      const p = await wired.production.preview(A, '2026-09', file(['PRU-001', { 'ape.monthly': '1.5', 'fyp.monthly': '1' }]));

      const ape = p.rows[0].cells.find((c) => c.metric === 'ape' && c.cadence === 'monthly')!;
      expect(ape).toMatchObject({
        status: 'changed', before: 200_000_000, after: 150_000_000,
        correction: {
          by: null, at: NOW.toISOString(), reason: 'The carrier restated it by email',
          // The file carries the very figure the correction replaced: the old file, uploaded again.
          replacedValue: 150_000_000,
        },
      });
      expect(p.rows[0].cells.find((c) => c.metric === 'fyp' && c.cadence === 'monthly')!.correction).toBeNull();
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
      expect(row!.apeMonthly).toMatchObject({ value: 200_000_000, provenance: 'corrected', reason: 'The carrier restated it by email' });
      expect(row!.fypMonthly).toMatchObject({ value: 100_000_000, provenance: 'imported' });
      expect(await db().collection('auditLog').findOne({ action: 'upload.commit', 'after.keptCorrectionCount': 1 })).toBeTruthy();
    });

    it('replaces a ticked one with the file’s figure — and a revert of that import brings the correction back whole', async () => {
      await importFile(file(['PRU-001', { 'ape.monthly': '1.5' }]));
      await correct({ value: 200_000_000 });
      const corrected = (await monthRow(A1))!.apeMonthly;

      const { batch } = await importWith(file(['PRU-001', { 'ape.monthly': '1.7' }]), `${A1}:apeMonthly`);

      expect(batch).toMatchObject({ keptCorrectionCount: 0, replacedCorrectionCount: 1 });
      expect((await monthRow(A1))!.apeMonthly).toMatchObject({
        value: 170_000_000, provenance: 'imported', sourceBatchId: batch.id, reason: null, replacedValue: null,
      });

      await wired.productionImport.revert(A, batch.id);
      expect((await monthRow(A1))!.apeMonthly).toEqual(corrected);
    });

    it('refuses a correction named to be replaced that the file would not change', async () => {
      await correct({ value: 200_000_000 });
      await expect(importWith(file(['PRU-001', { 'fyp.monthly': '1' }]), `${A1}:apeMonthly`)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED', details: { field: 'replace', key: `${A1}:apeMonthly` },
      });
    });

    it('refuses a file whose only change is a correction left unticked — it would change nothing', async () => {
      await correct({ value: 200_000_000 });
      await expect(importWith(file(['PRU-001', { 'ape.monthly': '1.5' }]))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await monthRow(A1))!.apeMonthly.value).toBe(200_000_000);
    });
  });

  /*
   * **P18.98-T5 AC-6 — a stored sentence.** A reason a person typed is stored as typed, whatever language they read in;
   * a reason the API writes for them — the Unit Dashboard's *Update production* — is written in the language of the
   * leader saving, stored as text, and read back as stored by every later reader, in either language.
   */
  describe('P18.98-T5 AC-6 — the reason, stored in the words it was written in', () => {
    const IN_ID = ctxFor(KPM_A, A1).withReader(readerIn('id'));
    /** A leader reading English, named: nobody's choice is Bahasa Indonesia since P18.98-T4's exit. */
    const IN_EN = A.withReader(readerIn('en'));
    const saveApe = async (
      ctx: RequestContext, row: { apeMonthlyMinor?: number; apeYtdMinor?: number }, reason: Parameters<typeof wired.productionCorrections.correctApe>[1]['reason'],
    ) => wired.productionCorrections.correctApe(ctx, {
      month: '2026-09', revision: await revisionOf(), rows: [{ membershipId: A1, ...row }], reason, surface: 'unit_dashboard',
    });
    const cellOf = async (ctx: RequestContext) => (await wired.production.readMonth(ctx, '2026-09')).rows
      .find((row) => row.membershipId === A1)!.metrics.ape;

    it('writes the API’s own reason in the saving leader’s language, as text, and reads it as stored in either', async () => {
      await saveApe(IN_ID, { apeMonthlyMinor: 200_000_000 }, UNIT_DASHBOARD_MESSAGES.correctionReason);
      await saveApe(IN_EN, { apeYtdMinor: 900_000_000 }, UNIT_DASHBOARD_MESSAGES.correctionReason);
      const row = (await monthRow(A1))!;
      expect([row.apeMonthly.reason, row.apeYtd.reason]).toEqual([
        'Diperbarui di Unit Dashboard dari laporan perusahaan.', 'Updated on the Unit Dashboard from the company report.',
      ]);
      // The audit keeps the words that were written, beside the figure.
      const audited = await db().collection('auditLog').find({ action: 'upload.cell_corrected' }).sort({ _id: 1 }).toArray();
      expect(audited.map((entry) => entry.after.reason)).toEqual([
        'Diperbarui di Unit Dashboard dari laporan perusahaan.', 'Updated on the Unit Dashboard from the company report.',
      ]);
      // Stored as text: an English reader reads the Indonesian a leader saved, and the other way about — never re-written.
      for (const ctx of [IN_EN, IN_ID]) {
        const cell = await cellOf(ctx);
        expect([cell.monthly.correction!.reason, cell.ytd.correction!.reason]).toEqual([
          'Diperbarui di Unit Dashboard dari laporan perusahaan.', 'Updated on the Unit Dashboard from the company report.',
        ]);
      }
    });

    it('stores a reason a person typed as typed, whatever language they read the product in', async () => {
      await correct({ reason: 'Carrier mengoreksi lewat email' });
      await saveApe(IN_ID, { apeYtdMinor: 900_000_000 }, 'The carrier restated the year');
      const row = (await monthRow(A1))!;
      expect([row.apeMonthly.reason, row.apeYtd.reason]).toEqual(['Carrier mengoreksi lewat email', 'The carrier restated the year']);
      expect((await cellOf(IN_ID)).monthly.correction!.reason).toBe('Carrier mengoreksi lewat email');
    });

    it('P18.98-T5 AC-2 refuses a correction in the reader’s language: the reason, the figure, the order to correct in', async () => {
      const said = async (call: Promise<unknown>) => {
        const refusal = (await call.catch((err: unknown) => err)) as DomainException;
        return [refusal.code, refusal.message, refusal.messageFor(readerIn('id'))];
      };
      expect(await said(correct({ reason: 'x'.repeat(501) }))).toEqual([
        'VALIDATION_FAILED', 'Keep the reason under 500 characters.', 'Alasan tidak boleh lebih dari 500 karakter.',
      ]);
      expect(await said(correct({ metric: 'policyCount', cadence: 'ytd', value: 2.5 }))).toEqual([
        'UPLOAD_VALUE_OUT_OF_RANGE', '# of policy year to date is not a whole number — it counts policies.',
        '# of policy YTD bukan bilangan bulat — angka ini menghitung polis.',
      ]);
      await importFile(file(['PRU-001', { 'ape.monthly': '1', 'ape.ytd': '5' }]));
      expect((await said(correct({ value: 600_000_000 })))[2])
        .toBe('APE bulan ini akan lebih besar dari YTD yang sudah tersimpan. Koreksi YTD dulu.');
      expect((await said(correct({ cadence: 'ytd', value: 50_000_000 })))[2])
        .toBe('APE YTD akan lebih kecil dari angka bulan ini. Koreksi bulan ini dulu.');
      // A leader's save: the same rules, its own two sentences.
      expect(await said(saveApe(A, { apeMonthlyMinor: 600_000_000 }, 'x'))).toEqual([
        'UPLOAD_VALUE_OUT_OF_RANGE',
        'APE this month would be more than the year to date already held. Correct the year to date too.',
        'APE bulan ini akan lebih besar dari YTD yang sudah tersimpan. Koreksi juga YTD-nya.',
      ]);
      expect(await said(saveApe(A, { apeYtdMinor: 50_000_000 }, 'x'))).toEqual([
        'UPLOAD_VALUE_OUT_OF_RANGE', 'APE year to date would be less than this month\'s figure.',
        'APE YTD akan lebih kecil dari angka bulan ini.',
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
      expect((await monthRow(A1))!.apeMonthly.value).toBe(100_000_000);
    });

    it('refuses somebody with no office, and a month that is not one', async () => {
      const none = new RequestContext('u9', 'none', null);
      await expect(wired.productionCorrections.correct(none, {
        month: '2026-09', membershipId: A1, metric: 'ape', cadence: 'monthly', value: 1, revision: 0, reason: 'x',
      })).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
      await expect(correct({ month: 'Sep' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });
});
