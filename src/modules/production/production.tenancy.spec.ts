import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { MonthlyAgentData } from './monthly-agent-data.schema';
import { VALUE_COLUMNS } from './production-preview';
import { TEMPLATE_HEADER_V1 } from './production-template';

const NOW = new Date('2026-09-27T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';

const A1 = '66f000000000000000000101';
const A2 = '66f000000000000000000102';
const A_PENDING = '66f000000000000000000103';
const B1 = '66f000000000000000000201';

const owner = (kpmId: string) => new RequestContext('u-owner-' + kpmId.slice(-2), 'none', {
  membershipId: 'mem-owner-' + kpmId.slice(-2), kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);
const noOffice = () => new RequestContext('u9', 'none', null);

function person(id: string, kpmId: string, seq: number, status = 'active') {
  return {
    _id: new mongoose.Types.ObjectId(id),
    kpmId,
    userId: '66f000000000000000003' + id.slice(-3),
    agentCode: `PRU-${seq.toString().padStart(3, '0')}`,
    agentSeq: seq,
    leaderCode: `LC-${id.slice(-3)}`,
    orgLevelCode: 'AGENT',
    hierarchyRole: 'agent',
    leaderId: null,
    ancestorIds: [],
    status,
    deletedAt: null,
  };
}

const NAMES: Record<string, string> = {
  [A1]: 'Rina Wijaya', [A2]: 'Budi Santoso', [A_PENDING]: 'Calon Baru', [B1]: 'Hendra Wijaya',
};

/**
 * The month table (P9-T1).
 *
 * The rules by calling the service; what only a request can prove is in the int spec.
 */
describe('the office’s production, month by month (P9-T1)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await mongoose.model(MonthlyAgentData.name).syncIndexes();
    await mongoose.connection.db!.collection('kpms').insertMany([
      { _id: new mongoose.Types.ObjectId(KPM_A), code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: new mongoose.Types.ObjectId(KPM_B), code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ] as never);
    await mongoose.connection.db!.collection('memberships').insertMany([
      person(A2, KPM_A, 2),
      person(A1, KPM_A, 1),
      person(A_PENDING, KPM_A, 3, 'pending'),
      person(B1, KPM_B, 1),
    ] as never);
    await mongoose.connection.db!.collection('users').insertMany(
      Object.keys(NAMES).map((id) => ({
        _id: new mongoose.Types.ObjectId('66f000000000000000003' + id.slice(-3)),
        email: `${id}@kpm.test`, fullName: NAMES[id], deletedAt: null,
      })) as never,
    );
  });

  /** A row as an import would leave it — only what is given; the rest stays `null`. */
  const row = (kpmId: string, membershipId: string, month: string, cells: Record<string, number | null>) => ({
    kpmId, membershipId, month, agentCode: 'PRU-001', deletedAt: null,
    ...Object.fromEntries(Object.entries(cells).map(([k, v]) => [
      k, { value: v, provenance: v === null ? null : 'imported', sourceBatchId: v === null ? null : 'batch-1' },
    ])),
  });

  describe('AC-4 — every member is a row, and null is not zero', () => {
    it('lists every active member with twelve empty cells when nothing has been uploaded', async () => {
      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');

      expect(view.rows.map((r) => r.name)).toEqual(['Rina Wijaya', 'Budi Santoso']);
      expect(view.withData).toBe(0);
      for (const r of view.rows) {
        for (const metric of Object.values(r.metrics)) {
          expect(metric.monthly).toEqual({ value: null, provenance: null, correction: null });
          expect(metric.ytd).toEqual({ value: null, provenance: null, correction: null });
        }
      }
    });

    it('tells a reported zero from nothing reported', async () => {
      // The carrier said Rina wrote nothing. It said nothing at all about Budi.
      await mongoose.connection.db!.collection('monthlyAgentData').insertOne(
        row(KPM_A, A1, '2026-09', { apeMonthly: 0, policyCountMonthly: 0 }) as never,
      );

      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      const [rina, budi] = view.rows;
      expect(rina.metrics.ape.monthly).toEqual({ value: 0, provenance: 'imported', correction: null });
      expect(budi.metrics.ape.monthly).toEqual({ value: null, provenance: null, correction: null });
      expect(view.withData).toBe(1);
    });

    it('leaves a cell the file did not carry as nothing, beside one it did', async () => {
      await mongoose.connection.db!.collection('monthlyAgentData').insertOne(
        row(KPM_A, A1, '2026-09', { apeMonthly: 150_000_000, apeYtd: null }) as never,
      );

      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      expect(view.rows[0].metrics.ape.monthly.value).toBe(150_000_000);
      expect(view.rows[0].metrics.ape.ytd).toEqual({ value: null, provenance: null, correction: null });
    });

    it('keeps months apart', async () => {
      await mongoose.connection.db!.collection('monthlyAgentData').insertOne(
        row(KPM_A, A1, '2026-08', { apeMonthly: 1 }) as never,
      );
      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      expect(view.withData).toBe(0);
    });

    it('does not list somebody who is only pending — they have registered, nothing more', async () => {
      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      expect(view.rows.map((r) => r.membershipId)).not.toContain(A_PENDING);
    });

    it('orders the rows as the roster does, by sequence', async () => {
      // Inserted A2 before A1; the table still reads 001, 002.
      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      expect(view.rows.map((r) => r.agentCode)).toEqual(['PRU-001', 'PRU-002']);
    });

    it('carries the carrier-issued code on every row — the join key, never a name', async () => {
      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      expect(view.rows[0]).toMatchObject({ membershipId: A1, agentCode: 'PRU-001' });
    });

    it('counts a row that holds only a year-to-date figure', async () => {
      // A carrier can report the year and nothing for the month — the row still holds data.
      await mongoose.connection.db!.collection('monthlyAgentData').insertOne(
        row(KPM_A, A1, '2026-09', { apeYtd: 900_000_000_00 }) as never,
      );
      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      expect(view.rows[0].metrics.ape.monthly.value).toBeNull();
      expect(view.rows[0].metrics.ape.ytd.value).toBe(900_000_000_00);
      expect(view.withData).toBe(1);
    });

    it('still lists a member whose row carries no code, rather than failing the table', async () => {
      // Every member registers with a carrier-issued code (ADR-0017). A row without one is a
      // corrupt row, and the answer to a corrupt row is an empty cell, not an empty screen.
      await mongoose.connection.db!.collection('memberships').updateOne(
        { _id: new mongoose.Types.ObjectId(A2) }, { $unset: { agentCode: '' } },
      );
      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      expect(view.rows.find((r) => r.membershipId === A2)?.agentCode).toBe('');
    });

    it('still lists a member whose user row is missing, with no name rather than no row', async () => {
      await mongoose.connection.db!.collection('users').deleteOne({ fullName: 'Budi Santoso' });
      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      expect(view.rows.map((r) => r.name)).toEqual(['Rina Wijaya', '']);
    });
  });

  describe('OD-21 — the Monthly Active Agent, on every row (ADR-0054)', () => {
    const insert = (...docs: unknown[]) =>
      mongoose.connection.db!.collection('monthlyAgentData').insertMany(docs as never);
    const active = async () => Object.fromEntries(
      (await wired.production.readMonth(owner(KPM_A), '2026-09')).rows.map((r) => [r.name, r.monthlyActiveAgent]),
    );

    it('is true for APE above zero, false for two reported zeroes, and null for nothing reported', async () => {
      await insert(
        row(KPM_A, A1, '2026-09', { apeMonthly: 150_000_000_00, policyCountMonthly: 2 }),
        row(KPM_A, A2, '2026-09', { apeMonthly: 0, policyCountMonthly: 0 }),
      );
      expect(await active()).toEqual({ 'Rina Wijaya': true, 'Budi Santoso': false });

      await mongoose.connection.db!.collection('monthlyAgentData').deleteMany({});
      expect(await active()).toEqual({ 'Rina Wijaya': null, 'Budi Santoso': null });
    });

    it('counts a policy written with no APE — either figure is enough', async () => {
      await insert(row(KPM_A, A1, '2026-09', { apeMonthly: 0, policyCountMonthly: 1 }));
      expect((await active())['Rina Wijaya']).toBe(true);
    });

    it('is not known from a file that carried neither figure — persistency alone says nothing about selling', async () => {
      // The prototype would call this row *not active*: it holds a figure. ADR-0051 lets a file carry
      // only some columns, and ADR-0054 reads only the two this metric is about.
      await insert(row(KPM_A, A1, '2026-09', { persistencyMonthly: 92, apeYtd: 900_000_000_00 }));
      expect((await active())['Rina Wijaya']).toBeNull();
    });

    it('reads last month’s figures for last month, never this month’s', async () => {
      await insert(row(KPM_A, A1, '2026-08', { apeMonthly: 150_000_000_00, policyCountMonthly: 1 }));
      expect((await active())['Rina Wijaya']).toBeNull();
    });

    it('reads a figure corrected by hand as the figure — and one emptied by hand as not reported', async () => {
      const corrected = (value: number | null) => ({
        value, provenance: 'corrected', sourceBatchId: null, correctedBy: 'mem-owner-a1',
        correctedAt: NOW, reason: 'Carrier restated it', replacedValue: 0,
      });
      await insert(
        { ...row(KPM_A, A1, '2026-09', { policyCountMonthly: 0 }), apeMonthly: corrected(40_000_000_00) },
        { ...row(KPM_A, A2, '2026-09', { policyCountMonthly: 0 }), apeMonthly: corrected(null) },
      );
      expect(await active()).toEqual({ 'Rina Wijaya': true, 'Budi Santoso': null });
    });

    it('P11-T6 AC-4 conflict regression: an agent pacing to MAA who logged activity and sold nothing is compliant, and not active', async () => {
      /*
       * `metrics-and-definitions.md`, testing obligation 3: the definitions of *active* the prototypes
       * mixed up must give different answers on one fixture, on purpose. `ACTIVITY_COMPLIANCE_MONTH`
       * asks whether they reported; this asks whether they produced. `PACING_TO_MAA`, the third, joined
       * this fixture in P11-T6, the task that computes it (ADR-0054): a forward-looking signal, so an
       * agent can be pacing to MAA and still have produced nothing.
       */
      const agent = new RequestContext('u-agent-a1', 'none', {
        membershipId: A1, kpmId: KPM_A, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
        status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      } as never);
      // Sixteen on the cascade codes against September's 7 closings, 24 appointments and 80 leads — the
      // cascade on Rp 125 M, what is left of Rp 500 M over the four months left — projects 7 × 16 / 111 ≈ 1.01.
      await mongoose.connection.db!.collection('activityLogs').insertOne({
        kpmId: KPM_A, membershipId: A1, localDate: '2026-09-20', totalCount: 16, source: 'self', deletedAt: null,
        entries: [
          { activityTypeId: 't-leads', activityTypeCode: 'LEADS_CONTACTED', count: 10 },
          { activityTypeId: 't-pres', activityTypeCode: 'SELL_PRESENTATION', count: 6 },
        ],
      } as never);
      await mongoose.connection.db!.collection('goals').insertOne({
        kpmId: KPM_A, membershipId: A1, period: '2026', mode: 'direct', annualApeTargetMinor: 500_000_000_00,
        savingsTargetMinor: 0, commissionRatePct: 0, monthsLeftOverride: null, apeAchievedMinor: 0,
        caseSizeMinor: 18_000_000_00, leadsToApptPct: 30, closingRatePct: 30,
        cascadeMapping: { leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION' },
        savedAt: NOW, savedByMembershipId: A1, version: 1, deletedAt: null,
      } as never);
      await insert(row(KPM_A, A1, '2026-09', { apeMonthly: 0, policyCountMonthly: 0 }));

      const pace = (await wired.paceStatus.paceOf(agent, [A1], { today: '2026-09-27', month: '2026-09', onTrackRatio: 0.9 })).get(A1);
      expect(pace).toMatchObject({ pacingToMaa: true, monthlyTargetMinor: 125_000_000_00 });
      expect((await wired.activityLogs.compliance(agent, {})).compliantMonth).toBe(true);
      expect((await active())['Rina Wijaya']).toBe(false);
      // Pacing, and nothing produced: the triage says *Watch closely*, never *On track*.
      expect(pace?.status).toBe('watch_closely');
    });

    it('is never made true by another office’s row, even one filed against the same membership', async () => {
      await insert(row(KPM_B, A1, '2026-09', { apeMonthly: 150_000_000_00, policyCountMonthly: 5 }));
      expect((await active())['Rina Wijaya']).toBeNull();
    });
  });

  describe('AC-6 — one office cannot reach another’s', () => {
    it('shows an office only its own members and its own figures', async () => {
      await mongoose.connection.db!.collection('monthlyAgentData').insertMany([
        row(KPM_A, A1, '2026-09', { apeMonthly: 111 }),
        row(KPM_B, B1, '2026-09', { apeMonthly: 222 }),
      ] as never);

      const a = await wired.production.readMonth(owner(KPM_A), '2026-09');
      const b = await wired.production.readMonth(owner(KPM_B), '2026-09');
      expect(a.rows.map((r) => r.name)).toEqual(['Rina Wijaya', 'Budi Santoso']);
      expect(b.rows.map((r) => r.name)).toEqual(['Hendra Wijaya']);
      expect(b.rows[0].metrics.ape.monthly.value).toBe(222);
      expect(a.rows.flatMap((r) => [r.metrics.ape.monthly.value])).not.toContain(222);
    });

    it('does not let a row filed under one office surface in another, even for a matching id', async () => {
      // A row mis-keyed to B but naming A's member: B's read must not adopt it, and A's must not
      // reach it — the tenant filter is on the row, not on the id it happens to carry.
      await mongoose.connection.db!.collection('monthlyAgentData').insertOne(
        row(KPM_B, A1, '2026-09', { apeMonthly: 999 }) as never,
      );
      const a = await wired.production.readMonth(owner(KPM_A), '2026-09');
      expect(a.rows[0].metrics.ape.monthly.value).toBeNull();
    });

    it('refuses somebody with no office rather than reading everything', async () => {
      await expect(wired.production.readMonth(noOffice(), '2026-09'))
        .rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
    });
  });

  describe('the template (P9-T2)', () => {
    it('AC-4: lists every active member, in roster order, with twelve empty fields each', async () => {
      const t = await wired.production.template(owner(KPM_A), '2026-09');
      const lines = t.file.split('\n');

      expect(t.rowCount).toBe(2);
      expect(lines).toHaveLength(3);
      expect(lines[1]).toBe('PRU-001,"Rina Wijaya",,,,,,,,,,,,');
      expect(lines[2]).toBe('PRU-002,"Budi Santoso",,,,,,,,,,,,');
      // Not the pending one — they have registered and nothing more.
      expect(t.file).not.toContain('Calon Baru');
    });

    it('AC-1, AC-3: opens with the versioned header, monthly before YTD', async () => {
      const t = await wired.production.template(owner(KPM_A), '2026-09');
      expect(t.version).toBe(1);
      expect(t.file.split('\n')[0]).toBe(t.header.join(','));
      expect(t.header.indexOf('APE (Rp M) — This Month')).toBeLessThan(t.header.indexOf('APE (Rp M) — YTD'));
    });

    it('AC-5: names the file after the office, the month and the year', async () => {
      const t = await wired.production.template(owner(KPM_A), '2026-09');
      expect(t.filename).toBe('KPM0417-agent-data-Sep-2026.csv');
      expect((await wired.production.template(owner(KPM_B), '2026-01')).filename)
        .toBe('KPM0555-agent-data-Jan-2026.csv');
    });

    it('AC-2: quotes a name that would otherwise shift every later column', async () => {
      await mongoose.connection.db!.collection('users').updateOne(
        { fullName: 'Rina Wijaya' }, { $set: { fullName: 'Wijaya, Rina "Rin"' } },
      );
      const t = await wired.production.template(owner(KPM_A), '2026-09');
      expect(t.file.split('\n')[1]).toBe('PRU-001,"Wijaya, Rina ""Rin""",,,,,,,,,,,,');
    });

    it('AC-6: lists one office’s agents and nobody else’s', async () => {
      const a = await wired.production.template(owner(KPM_A), '2026-09');
      const b = await wired.production.template(owner(KPM_B), '2026-09');
      expect(a.file).toContain('Rina Wijaya');
      expect(a.file).not.toContain('Hendra Wijaya');
      expect(b.file).toContain('Hendra Wijaya');
      expect(b.file).not.toContain('Rina Wijaya');
    });

    it('refuses somebody with no office, and a month that is not one', async () => {
      await expect(wired.production.template(noOffice(), '2026-09'))
        .rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
      await expect(wired.production.template(owner(KPM_A), 'september'))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('answers not-found, not a file named for nothing, when the office row is gone', async () => {
      // The roster alone would still build a body; the filename needs the office's own code.
      await mongoose.connection.db!.collection('kpms').deleteOne(
        { _id: new mongoose.Types.ObjectId(KPM_A) } as never,
      );
      await expect(wired.production.template(owner(KPM_A), '2026-09'))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('is the header alone for an office with nobody active yet', async () => {
      await mongoose.connection.db!.collection('memberships').updateMany(
        { kpmId: KPM_A }, { $set: { status: 'pending' } },
      );
      const t = await wired.production.template(owner(KPM_A), '2026-09');
      expect(t.rowCount).toBe(0);
      expect(t.file.split('\n')).toHaveLength(1);
    });
  });

  describe('the preview (P9-T3)', () => {
    /** A filled template, as bytes: the header, then each row's code, name and cells by `metric.cadence`. */
    const file = (...rows: [string, string, Record<string, string>][]) => ({
      buffer: Buffer.from([
        TEMPLATE_HEADER_V1.join(','),
        ...rows.map(([code, name, cells]) =>
          [code, `"${name}"`, ...VALUE_COLUMNS.map((c) => cells[`${c.metric}.${c.cadence}`] ?? '')].join(',')),
      ].join('\n')),
      originalname: 'KPM0417-agent-data-Sep-2026.csv',
      size: 0,
    });

    it('AC-8: a diff against what is stored, for the uploader alone', async () => {
      await mongoose.model(MonthlyAgentData.name).create(row(KPM_A, A1, '2026-09', { apeMonthly: 100_000_000, fypMonthly: 5 }));
      const p = await wired.production.preview(owner(KPM_A), '2026-09', file(
        ['PRU-001', 'Rina Wijaya', { 'ape.monthly': '2', 'ape.ytd': '2' }],
      ));

      expect(p).toMatchObject({
        month: '2026-09', filename: 'KPM0417-agent-data-Sep-2026.csv', templateVersion: 1,
        encoding: 'utf-8', delimiter: ',',
        summary: { rows: 1, ready: 1, refused: 0, newCells: 1, changedCells: 1, notInFile: 1 },
      });
      const cells = p.rows[0].cells;
      expect(cells.find((c) => c.metric === 'ape' && c.cadence === 'monthly'))
        .toMatchObject({ status: 'changed', before: 100_000_000, after: 200_000_000 });
      // Not in the file, so not provided — the stored figure stays (ADR-0051).
      expect(cells.find((c) => c.metric === 'fyp' && c.cadence === 'monthly'))
        .toMatchObject({ status: 'not_provided', before: 5 });
    });

    it('writes nothing — the preview exists in the response and nowhere else', async () => {
      await wired.production.preview(owner(KPM_A), '2026-09', file(['PRU-001', 'Rina Wijaya', { 'ape.monthly': '2' }]));
      expect(await mongoose.connection.db!.collection('monthlyAgentData').countDocuments()).toBe(0);
    });

    it('reads the month it was asked for, and no other', async () => {
      await mongoose.model(MonthlyAgentData.name).create(row(KPM_A, A1, '2026-08', { apeMonthly: 100_000_000 }));
      const p = await wired.production.preview(owner(KPM_A), '2026-09', file(['PRU-001', 'Rina Wijaya', { 'ape.monthly': '1' }]));
      expect(p.rows[0].cells[0]).toMatchObject({ status: 'new', before: null });
    });

    it('AC-10: matches one office’s codes and nobody else’s', async () => {
      await mongoose.connection.db!.collection('memberships').insertOne(
        { ...person('66f000000000000000000299', KPM_B, 9), agentCode: 'PRU-900' } as never,
      );
      const p = await wired.production.preview(owner(KPM_A), '2026-09', file(
        ['PRU-900', 'Hendra Wijaya', { 'ape.monthly': '1' }],
        ['PRU-001', 'Rina Wijaya', { 'ape.monthly': '1' }],
      ));
      expect(p.rows[0]).toMatchObject({ status: 'refused', membershipId: null, issues: [{ code: 'UPLOAD_UNKNOWN_AGENT_CODE' }] });
      expect(p.rows[1]).toMatchObject({ status: 'ready', membershipId: A1 });
    });

    it('AC-10: B’s stored figures never reach A’s diff, though both offices have a PRU-001', async () => {
      await mongoose.model(MonthlyAgentData.name).create(row(KPM_B, B1, '2026-09', { apeMonthly: 900_000_000 }));
      const p = await wired.production.preview(owner(KPM_A), '2026-09', file(['PRU-001', 'Rina Wijaya', { 'ape.monthly': '1' }]));
      expect(p.rows[0]).toMatchObject({ membershipId: A1 });
      expect(p.rows[0].cells[0]).toMatchObject({ status: 'new', before: null });
    });

    it('does not match somebody who is only pending', async () => {
      const p = await wired.production.preview(owner(KPM_A), '2026-09', file(['PRU-003', 'Calon Baru', { 'ape.monthly': '1' }]));
      expect(p.rows[0]).toMatchObject({ status: 'refused', issues: [{ code: 'UPLOAD_UNKNOWN_AGENT_CODE' }] });
    });

    it('AC-6: matches on the code when the name in the file is somebody else’s', async () => {
      const p = await wired.production.preview(owner(KPM_A), '2026-09', file(['PRU-002', 'Rina Wijaya', { 'ape.monthly': '1' }]));
      expect(p.rows[0]).toMatchObject({ status: 'ready', membershipId: A2, name: 'Budi Santoso', nameDiffers: true });
    });

    it('refuses somebody with no office, a month that is not one, and no file', async () => {
      const f = file();
      await expect(wired.production.preview(noOffice(), '2026-09', f)).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
      await expect(wired.production.preview(owner(KPM_A), 'Sep-2026', f)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(wired.production.preview(owner(KPM_A), '2026-09', undefined))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'file' } });
    });
  });

  describe('the month is the path, and it has to be one', () => {
    it.each(['2026', '2026-13', '09-2026', 'now'])('refuses %s with a code a client can branch on', async (bad) => {
      await expect(wired.production.readMonth(owner(KPM_A), bad))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
    });
  });
});
