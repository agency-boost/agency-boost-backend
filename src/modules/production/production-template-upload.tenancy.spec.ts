import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { readerIn } from '@/common/i18n/reader';
import { analyticsConfigV1, type AdvancedAnalyticsConfig, type UploadField } from '@/modules/config/analytics-config';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { MonthlyAgentData } from './monthly-agent-data.schema';
import { ProductionMonth } from './production-month.schema';
import { templateHeader } from './production-template';
import { UnregisteredAgentData } from './unregistered-agent-data.schema';

/*
 * **P19.5-T2 — the Data upload from the template, end to end through the services** (ADR-0214 §5, §8 to §12; the
 * Advanced analytics spec §4, R2, R4, R5, R6; D8; AA UI-010, UI-013, UI-016, UI-025; AT-1 to AT-4, AT-9, AT-13).
 *
 * Two KPMs of one company, both on the *Prudential template*, whose *Advanced analytics* section is published by
 * inserting its versions as the Super Admin's publish leaves them — what every KPM on it reads, live.
 */

// 09:00 on 15 December 2026 in Jakarta: December is running; November closes on 7 December.
const NOW = new Date('2026-12-15T02:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const TEMPLATE = '66f0000000000000000000d1';
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const A1 = '66f000000000000000000101';
const A2 = '66f000000000000000000102';
const L1 = '66f000000000000000000103';
const B1 = '66f000000000000000000201';
const M = 1_000_000 * 100;

const ctxFor = (kpmId: string, membershipId: string) => new RequestContext(`u-${membershipId.slice(-3)}`, 'none', {
  membershipId, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never).withReader(readerIn('id'));
const A = ctxFor(KPM_A, L1);
const B = ctxFor(KPM_B, B1);

/** Version 1: today's seven columns from Jan 2025, Prudential's eight-digit codes, unregistered codes held. */
const V1 = (): AdvancedAnalyticsConfig => {
  const config = analyticsConfigV1({ effectiveFrom: '2025-01', agentCodePattern: '^[0-9]{8}$', agentCodeExample: '70012345' });
  config.uploadRules.unknownAgent = 'flag';
  return config;
};
/** AT-1's column: *Komisi tahun pertama* `FYC`, Rp juta, YTD uploaded, required, from Dec 2026. */
const FYC: UploadField = {
  kode: 'FYC', system: false, label: { id: 'Komisi tahun pertama', en: 'First-year commission' }, labelAliases: [], unit: 'rp_million',
  ytd: 'upload', min: 0, max: null, required: true, rows: 'all', effectiveFrom: '2026-12', tip: { id: '', en: '' },
};
/** Version 2: FYC added; recruitment at most 5 a month (AA UI-025). */
const V2 = (): AdvancedAnalyticsConfig => {
  const config = V1();
  config.uploadFields = [
    ...config.uploadFields.map((f) => (f.kode === 'RECRUITMENT' ? { ...f, max: 5 } : f)),
    FYC,
  ];
  return config;
};

const person = (id: string, kpmId: string, code: string, role: 'ab' | 'agent' = 'agent') => ({
  _id: new mongoose.Types.ObjectId(id), kpmId, userId: `66f000000000000000003${id.slice(-3)}`, agentCode: code,
  agentSeq: Number(id.slice(-1)), leaderCode: `LC-${id.slice(-3)}`, orgLevelCode: role.toUpperCase(), role, leaderId: null,
  ancestorIds: [], status: 'active', joinedAt: new Date('2025-01-02T00:00:00Z'), joinDate: '2025-01-02', removedAt: null, deletedAt: null,
});
const full = (ape: number, extra: Record<string, number> = {}) => ({
  APE: ape * M, PERSISTENCY: 90, RECRUITMENT: 0, NEW_ACTIVE_AGENTS: 0, FYP: ape * 0.5 * M, POLICY_COUNT: 1, ...extra,
});

describe('P19.5-T2 the Data upload from the template', () => {
  let wired: ReturnType<typeof configModule>;
  const db = () => mongoose.connection.db!;
  const col = (name: string) => db().collection(name);

  /** Publish a version of the section, as the Super Admin's publish leaves it. */
  const publish = (version: number, payload: AdvancedAnalyticsConfig) => col('companyTemplates').insertOne({
    companyId: COMPANY, templateId: TEMPLATE, kind: 'advanced_analytics', version, revision: version, status: 'published',
    payload, publishedAt: NOW, migratedFrom: null, deletedAt: null, createdBy: null, updatedBy: null,
  });
  /** A month's rows by kode, as an import leaves them. */
  const rows = (kpmId: string, month: string, byMember: Record<string, Record<string, number>>, version = 1) =>
    col('monthlyAgentData').insertMany(Object.entries(byMember).map(([membershipId, values]) => ({
      kpmId, membershipId, month, agentCode: 'x', deletedAt: null, templateId: TEMPLATE, templateVersion: version, asOf: null,
      values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, provenance: 'imported', sourceBatchId: 'seed' }])),
      ytdValues: {},
    })));
  /** A filled file: the header given, then each row's code, name and cells in the header's order. */
  const file = (header: readonly string[], ...lines: string[][]) => ({
    buffer: Buffer.from([header.join(','), ...lines.map((l) => l.join(','))].join('\n')), originalname: 'f.csv', size: 0,
  });
  const importFile = async (ctx: RequestContext, month: string, f: ReturnType<typeof file>, asOf?: string) => {
    const p = await wired.production.preview(ctx, month, f);
    return wired.productionImport.commit(ctx, month, String(p.revision), f, undefined, asOf);
  };
  const header = (config: AdvancedAnalyticsConfig) => templateHeader(config, 'en');
  /** A line under `header(config)`: the code, a name, and each kode's figure as the file writes it. */
  const line = (config: AdvancedAnalyticsConfig, code: string, cells: Record<string, string>) =>
    [code, 'x', ...header(config).slice(2).map((h) => cells[/\[([A-Z0-9_]+)\]$/.exec(h)![1]] ?? '')];

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    for (const name of [MonthlyAgentData.name, ProductionMonth.name, UnregisteredAgentData.name]) await mongoose.model(name).syncIndexes();
    for (const name of ['templates', 'companyTemplates', 'unregisteredAgentData']) await col(name).deleteMany({});
    await col('templates').insertOne({
      _id: new mongoose.Types.ObjectId(TEMPLATE), companyId: COMPANY, name: 'Prudential template', isDefault: true, deletedAt: null,
    });
    await col('kpms').insertMany([
      // KPM A joined AgencyBoost in June 2026: its history runs from June 2025 (R5).
      {
        _id: new mongoose.Types.ObjectId(KPM_A), companyId: COMPANY, code: '0417', timezone: 'Asia/Jakarta',
        startedFrom: { source: 'template', templateId: TEMPLATE }, settings: { productionLockGraceDays: 7 },
        createdAt: new Date('2026-06-10T03:00:00Z'),
      },
      {
        _id: new mongoose.Types.ObjectId(KPM_B), companyId: COMPANY, code: '0555', timezone: 'Asia/Jakarta',
        startedFrom: { source: 'template', templateId: TEMPLATE }, settings: { productionLockGraceDays: 7 },
        createdAt: new Date('2026-06-10T03:00:00Z'),
      },
    ] as never);
    await col('memberships').insertMany([
      person(A1, KPM_A, '70012345'), person(A2, KPM_A, '70012346'), person(L1, KPM_A, '70012347', 'ab'), person(B1, KPM_B, '70019999', 'ab'),
    ] as never);
    await publish(1, V1());
  });

  describe('AC-1, AT-14 — the file is the template’s', () => {
    it('P19.5-T2 AC-1 AT-14 every KPM on the template downloads the same header, the new column and its YTD in it', async () => {
      await publish(2, V2());
      const a = await wired.production.template(A, '2026-12');
      const b = await wired.production.template(B, '2026-12');
      expect(a.header).toEqual(b.header);
      expect(a).toMatchObject({ version: 2, filename: '0417-agent-data-2026-12.csv' });
      expect(a.header.slice(-2)).toEqual(['Komisi tahun pertama (Rp juta) [FYC]', 'Komisi tahun pertama YTD [FYC_YTD]']);
    });
  });

  describe('AC-4, R2, AT-1, AT-2, AA UI-010 — a column counts from its start month', () => {
    it('AT-1 AA UI-010 after FYC is added from Dec 2026, November reads — for it and stays complete', async () => {
      await rows(KPM_A, '2026-11', { [A1]: full(10), [A2]: full(20), [L1]: full(30, { UNIT_PERSISTENCY: 85 }) });
      const before = (await wired.production.readMonth(A, '2026-11')).completeness;
      await publish(2, V2());
      const view = await wired.production.readMonth(A, '2026-11');
      expect(view.config.columns.find((c) => c.kode === 'FYC')).toMatchObject({ inForce: false, effectiveFrom: '2026-12' });
      expect(view.rows[0].values.FYC).toEqual({ value: null, provenance: null, correction: null, outOfBounds: null });
      expect(view.completeness).toEqual({ ...before, status: 'complete' });
      // December asks for it.
      expect((await wired.production.readMonth(A, '2026-12')).config.columns.find((c) => c.kode === 'FYC')!.inForce).toBe(true);
    });

    it('AT-2 re-uploading Jan 2025 from a file without FYC skips no row', async () => {
      await publish(2, V2());
      await wired.productionMonths.reopen(A, '2025-01');
      const v1 = V1();
      const { batch } = await importFile(A, '2025-01', file(header(v1),
        line(v1, '70012345', { APE: '1' }), line(v1, '70012346', { APE: '2' })));
      expect(batch).toMatchObject({ rowCount: 2, writtenRowCount: 2, issueCount: 0, templateVersion: 2 });
    });
  });

  describe('AC-3, AT-3, AA UI-013 — an older file', () => {
    it('AT-3 a v1 file after v2 imports with “Kolom Komisi tahun pertama kosong di file ini” and no row skipped — FYC required', async () => {
      await publish(2, V2());
      const v1 = V1();
      const f = file(header(v1), line(v1, '70012345', { APE: '1' }), line(v1, '70012346', { APE: '2' }));
      const p = await wired.production.preview(A, '2026-12', f);
      expect(p.notes.filter((n) => n.code === 'column_missing').map((n) => n.message)).toEqual([
        'Kolom Komisi tahun pertama kosong di file ini. Baris tetap diimpor.',
        'Kolom Komisi tahun pertama YTD kosong di file ini. Baris tetap diimpor.',
      ]);
      expect(p.summary).toMatchObject({ ready: 2, refused: 0 });
    });

    it('AC-5 R2 a file that carries FYC and leaves it blank on a row, from December, skips that row: “… wajib diisi”', async () => {
      await publish(2, V2());
      const v2 = V2();
      const p = await wired.production.preview(A, '2026-12', file(header(v2),
        line(v2, '70012345', { APE: '1', FYC: '0.5' }), line(v2, '70012346', { APE: '2' })));
      expect(p.rows.map((r) => [r.status, r.issues[0]?.code ?? null, r.issues[0]?.message ?? null])).toEqual([
        ['ready', null, null], ['refused', 'UPLOAD_REQUIRED_BLANK', 'Komisi tahun pertama wajib diisi'],
      ]);
    });
  });

  describe('AC-5, ADR-0214 §8 — Belum terdaftar', () => {
    const v1 = V1();
    const held = () => file(header(v1), line(v1, '70012345', { APE: '1' }), line(v1, '70088888', { APE: '7', POLICY_COUNT: '2' }));

    it('AC-5 a code no member holds is held apart, listed after the members, counted in nothing; reject skips it', async () => {
      const { batch } = await importFile(A, '2026-11', held());
      expect(batch).toMatchObject({ heldRowCount: 1, writtenRowCount: 2 });
      expect(await col('unregisteredAgentData').findOne({ agentCode: '70088888' })).toMatchObject({
        kpmId: KPM_A, month: '2026-11', status: 'held', sourceBatchId: batch.id, templateVersion: 1,
        values: { APE: { value: 7 * M, provenance: 'imported' }, POLICY_COUNT: { value: 2 } },
      });
      expect(await col('monthlyAgentData').countDocuments({ agentCode: '70088888' })).toBe(0);
      const view = await wired.production.readMonth(A, '2026-11');
      expect(view.unregistered).toEqual([expect.objectContaining({ agentCode: '70088888', values: expect.objectContaining({ APE: expect.objectContaining({ value: 7 * M }) }) })]);
      expect(view.rows).toHaveLength(3);
      expect(view.completeness.members).toBe(3);

      // Under reject, the same file skips it, with the reason.
      await publish(2, { ...V1(), uploadRules: { ...V1().uploadRules, unknownAgent: 'reject' } });
      const p = await wired.production.preview(A, '2026-12', held());
      expect(p.rows[1]).toMatchObject({ status: 'refused', issues: [{ code: 'UPLOAD_UNKNOWN_AGENT_CODE' }] });
    });

    it('AC-5 ADR-0214 §8 the held months move onto the membership that takes the code, filling only empty cells; audited', async () => {
      await importFile(A, '2026-11', held());
      const NEW = '66f000000000000000000109';
      await col('memberships').insertOne(person(NEW, KPM_A, '70088888') as never);
      await col('monthlyAgentData').insertOne({
        kpmId: KPM_A, membershipId: NEW, month: '2026-11', agentCode: '70088888', deletedAt: null,
        values: { POLICY_COUNT: { value: 5, provenance: 'corrected' } }, ytdValues: {},
      });
      await wired.heldRows.codeRegistered(A, NEW, '70088888');
      const row = (await col('monthlyAgentData').findOne({ membershipId: NEW, month: '2026-11' }))!;
      expect(row.values.APE).toMatchObject({ value: 7 * M, provenance: 'imported' });
      // A stored figure is never replaced by a held one.
      expect(row.values.POLICY_COUNT).toEqual({ value: 5, provenance: 'corrected' });
      expect(await col('unregisteredAgentData').findOne({ agentCode: '70088888' })).toMatchObject({ status: 'moved', movedToMembershipId: NEW });
      expect(await col('auditLog').findOne({ action: 'production.held_rows_moved' })).toMatchObject({
        targetMembershipId: NEW, after: { agentCode: '70088888', months: ['2026-11'] },
      });
      expect((await wired.production.readMonth(A, '2026-11')).unregistered).toEqual([]);
    });

    it('AC-5 a revert of the import that held a row soft-deletes it', async () => {
      const { batch } = await importFile(A, '2026-11', held());
      await wired.productionImport.revert(A, batch.id);
      expect(await col('unregisteredAgentData').findOne({ agentCode: '70088888' })).toMatchObject({ deletedAt: expect.any(Date) });
      expect((await wired.production.readMonth(A, '2026-11')).unregistered).toEqual([]);
    });

    it('AC-16 another KPM on the template never reads A’s held rows, and its own file holds its own', async () => {
      await importFile(A, '2026-11', held());
      expect((await wired.production.readMonth(B, '2026-11')).unregistered).toEqual([]);
      await importFile(B, '2026-11', file(header(v1), line(v1, '70012345', { APE: '3' })));
      // A's member's code is nobody in B: held there, never matched to A's member.
      expect(await col('unregisteredAgentData').findOne({ kpmId: KPM_B })).toMatchObject({ agentCode: '70012345', status: 'held' });
      expect(await col('monthlyAgentData').countDocuments({ kpmId: KPM_A, membershipId: A1, month: '2026-11' })).toBe(1);
      expect((await col('monthlyAgentData').findOne({ membershipId: A1, month: '2026-11' }))!.values.APE.value).toBe(1 * M);
      // A's Owner moves nothing of B's.
      await wired.heldRows.codeRegistered(A, A1, '70012345');
      expect(await col('unregisteredAgentData').findOne({ kpmId: KPM_B })).toMatchObject({ status: 'held' });
    });
  });

  describe('AC-7, R4 — the year to date is calculated', () => {
    beforeEach(async () => {
      // Every month of 2026 to November, but March: complete rows for all three members.
      for (const month of ['2026-01', '2026-02', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']) {
        await rows(KPM_A, month, { [A1]: full(10), [A2]: full(20), [L1]: full(30, { UNIT_PERSISTENCY: 85 }) });
      }
    });

    it('AC-7 AT-6 a missing month makes the year to date the partial sum, Belum lengkap naming it; the banner names it too', async () => {
      const view = await wired.production.readMonth(A, '2026-11');
      expect(view.rows.find((r) => r.membershipId === A1)!.ytd.APE).toMatchObject({ value: 100 * M, calculated: true, provenance: 'imported' });
      expect(view.config.columns.find((c) => c.kode === 'APE')!.ytdMissingMonths).toEqual(['2026-03']);
      expect(view.ytdMissingMonths).toEqual(['2026-03']);
      // Persistency has no year to date: nothing is missing of it.
      expect(view.config.columns.find((c) => c.kode === 'PERSISTENCY')!.ytdMissingMonths).toEqual([]);
      expect(view.rows[0].ytd.PERSISTENCY).toBeUndefined();
      // March uploaded: complete.
      await rows(KPM_A, '2026-03', { [A1]: full(10), [A2]: full(20), [L1]: full(30, { UNIT_PERSISTENCY: 85 }) });
      const whole = await wired.production.readMonth(A, '2026-11');
      expect(whole.ytdMissingMonths).toEqual([]);
      expect(whole.rows.find((r) => r.membershipId === A1)!.ytd.APE.value).toBe(110 * M);
    });

    it('AC-6 AC-7 a month uploaded below completePct is missing from the year to date too', async () => {
      await rows(KPM_A, '2026-03', { [A1]: full(10) });
      const view = await wired.production.readMonth(A, '2026-11');
      expect(view.months.find((m) => m.month === '2026-03')).toEqual({ month: '2026-03', status: 'incomplete', members: 3, filled: 1 });
      expect(view.ytdMissingMonths).toEqual(['2026-03']);
    });

    it('AC-7 every reader of APE year to date reads the sum: the Summary’s and Goals’ reading, the official APE', async () => {
      expect(await wired.productionReadings.apeYearToDate(A, A1, '2026')).toMatchObject({ minor: 100 * M, month: '2026-11' });
      expect(await wired.productionReadings.apeYearToDateThrough(A, A1, '2026-02')).toMatchObject({ minor: 20 * M });
    });

    it('AC-7 a ytd:upload column keeps its uploaded YTD, checked within ytdTolerancePct, and may be corrected', async () => {
      await publish(2, { ...V2(), uploadFields: V2().uploadFields.map((f) => (f.kode === 'FYC' ? { ...f, effectiveFrom: '2026-11', required: false } : f)) });
      const v2 = V2();
      await importFile(A, '2026-11', file(header(v2),
        line(v2, '70012345', { FYC: '2', FYC_YTD: '2' }), line(v2, '70012346', { FYC: '2', FYC_YTD: '2' })));
      const p = await wired.production.preview(A, '2026-12', file(header(v2),
        line(v2, '70012345', { APE: '1', FYC: '1', FYC_YTD: '3' }), line(v2, '70012346', { APE: '1', FYC: '1', FYC_YTD: '9' })));
      expect(p.rows.map((r) => r.issues.map((i) => i.code))).toEqual([[], ['UPLOAD_YTD_MISMATCH']]);
      const view = await wired.production.readMonth(A, '2026-11');
      expect(view.rows.find((r) => r.membershipId === A1)!.ytd.FYC).toMatchObject({ value: 2 * M, calculated: false });
      const state = await wired.productionMonths.reopen(A, '2026-11');
      const r = await wired.productionCorrections.correct(A, {
        month: '2026-11', membershipId: A1, kode: 'FYC', ytd: true, value: 3 * M, revision: state.revision, reason: 'Carrier restated',
      });
      expect(r).toMatchObject({ changed: true, kode: 'FYC', ytd: true });
    });
  });

  describe('AC-8, R5, AT-9, AA UI-016 — the required history', () => {
    it('AT-9 the month grid starts twelve months before the KPM joined; a never-written month of it takes an upload', async () => {
      const view = await wired.production.readMonth(A, '2026-12');
      expect(view.config).toMatchObject({ historyFrom: '2025-06', firstMonth: '2026-06', completePct: 90 });
      expect(view.months[0].month).toBe('2025-06');
      expect(view.months.at(-1)!.month).toBe('2026-12');
      // July 2025 was never written: open whatever its date (ADR-0214 §11). May 2025 is before the history.
      expect(await wired.productionMonths.state(A, '2025-07')).toMatchObject({ locked: false, reason: 'history', editableUntil: '2026-12-22' });
      expect(await wired.productionMonths.state(A, '2025-05')).toMatchObject({ locked: true, reason: 'schedule' });
      const v1 = V1();
      await importFile(A, '2025-07', file(header(v1), line(v1, '70012345', { APE: '1' })));
      // The first write opens a window of the grace days from its day, then the month locks as any month does.
      expect(await wired.productionMonths.state(A, '2025-07')).toMatchObject({ locked: false, reason: 'open', editableUntil: '2026-12-22' });
      expect(await col('productionMonths').findOne({ kpmId: KPM_A, month: '2025-07' })).toMatchObject({ firstWrittenOn: '2026-12-15' });
    });
  });

  describe('AC-9, D8 — the current month, as of a day', () => {
    it('AC-9 an upload into the running month carries its as-of day; a later one replaces it; an ended month carries none', async () => {
      const v1 = V1();
      const first = await importFile(A, '2026-12', file(header(v1), line(v1, '70012345', { APE: '1' })), '2026-12-10');
      expect(first.state.asOf).toBe('2026-12-10');
      expect((await col('monthlyAgentData').findOne({ membershipId: A1, month: '2026-12' }))!.asOf).toBe('2026-12-10');
      await importFile(A, '2026-12', file(header(v1), line(v1, '70012345', { APE: '2' })));
      expect((await wired.production.readMonth(A, '2026-12')).state.asOf).toBe('2026-12-15');
      // A day after today, or outside the month, is refused.
      const f = file(header(v1), line(v1, '70012345', { APE: '3' }));
      const p = await wired.production.preview(A, '2026-12', f);
      await expect(wired.productionImport.commit(A, '2026-12', String(p.revision), f, undefined, '2026-12-20'))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'asOf' } });
      await expect(wired.productionImport.commit(A, '2026-12', String(p.revision), f, undefined, '2026-11-30'))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'asOf' } });
      // November ended: its upload is final.
      const nov = await importFile(A, '2026-11', file(header(v1), line(v1, '70012345', { APE: '1' })), '2026-11-15');
      expect(nov.batch.asOf).toBeNull();
    });
  });

  describe('AC-11, AC-12, AC-13 — versions', () => {
    it('AC-11 AA UI-025 a value outside the limits a later version set is flagged “since v2”, never changed', async () => {
      await rows(KPM_A, '2026-11', { [A1]: full(10, { RECRUITMENT: 8 }) });
      await publish(2, V2());
      const view = await wired.production.readMonth(A, '2026-11');
      expect(view.rows.find((r) => r.membershipId === A1)!.values.RECRUITMENT).toMatchObject({ value: 8, outOfBounds: { sinceVersion: 2 } });
      expect(view.rows.find((r) => r.membershipId === A1)!.values.APE.outOfBounds).toBeNull();
    });

    it('AC-12 R6 each upload stores the version it was read against, and the history shows it', async () => {
      const v1 = V1();
      await importFile(A, '2026-11', file(header(v1), line(v1, '70012345', { APE: '1' })));
      await publish(2, V2());
      await importFile(A, '2026-11', file(header(v1), line(v1, '70012345', { APE: '2' })));
      expect((await wired.productionImport.history(A, '2026-11')).batches.map((b) => b.templateVersion)).toEqual([2, 1]);
      expect((await col('monthlyAgentData').findOne({ membershipId: A1, month: '2026-11' }))!.templateVersion).toBe(2);
    });

    it('AC-13 AT-13 FYP archived, then the kode FYP added again: its values come back in the table, unchanged', async () => {
      await rows(KPM_A, '2026-11', { [A1]: full(10) });
      const archived = V1();
      const fyp = archived.uploadFields.find((f) => f.kode === 'FYP')!;
      archived.uploadFields = archived.uploadFields.filter((f) => f.kode !== 'FYP');
      archived.archivedFields = [fyp];
      await publish(2, archived);
      const without = await wired.production.readMonth(A, '2026-11');
      expect(without.config.columns.map((c) => c.kode)).not.toContain('FYP');
      // A file with an archived [FYP] stores no FYP (AA UI-013).
      const p = await wired.production.preview(A, '2026-11', file(['Agent Code', 'APE (Rp M) [APE]', 'FYP (Rp M) [FYP]'], ['70012345', '1', '9']));
      expect(p.rows[0].cells.map((c) => c.kode)).toEqual(['APE']);
      expect(p.notes).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'column_retired', kode: 'FYP' })]));
      await publish(3, V1());
      const back = await wired.production.readMonth(A, '2026-11');
      expect(back.rows.find((r) => r.membershipId === A1)!.values.FYP).toMatchObject({ value: 5 * M, provenance: 'imported' });
    });
  });

  describe('AC-16 — one office never reaches another’s', () => {
    it('AC-16 a correction of another KPM’s member is 404, and its month read holds none of A’s figures', async () => {
      await rows(KPM_A, '2026-11', { [A1]: full(10) });
      await expect(wired.productionCorrections.correct(B, {
        month: '2026-12', membershipId: A1, kode: 'APE', ytd: false, value: 1, revision: 0, reason: 'x',
      })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const view = await wired.production.readMonth(B, '2026-11');
      expect(view.rows.map((r) => r.membershipId)).toEqual([B1]);
      expect(view.completeness).toMatchObject({ members: 1, status: 'missing' });
    });
  });
});
