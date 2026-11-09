import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { MonthlyAgentData } from './monthly-agent-data.schema';
import { TEMPLATE_HEADER_V1 } from './production-template';
import { byKode } from './upload-columns';

/** The twelve value columns of a version 1 file, keyed `metric.cadence` as the specs name them. */
const V1_KEYS = (['monthly', 'ytd'] as const).flatMap((cadence) =>
  ['ape', 'persistency', 'recruitment', 'newActiveAgents', 'fyp', 'policyCount'].map((metric) => `${metric}.${cadence}`));

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

function person(
  id: string, kpmId: string, seq: number, status = 'active',
  place: { role?: 'ab' | 'aab' | 'agent'; leaderId?: string | null } = {},
) {
  const role = place.role ?? 'agent';
  return {
    _id: new mongoose.Types.ObjectId(id),
    kpmId,
    userId: '66f000000000000000003' + id.slice(-3),
    agentCode: `PRU-${seq.toString().padStart(3, '0')}`,
    agentSeq: seq,
    leaderCode: `LC-${id.slice(-3)}`,
    orgLevelCode: role.toUpperCase(),
    role,
    leaderId: place.leaderId ?? null,
    ancestorIds: place.leaderId ? [place.leaderId] : [],
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
      // Rina leads the office and Budi reports to her: the org tree reads Rina, then Budi (P13.1-T7).
      person(A2, KPM_A, 2, 'active', { leaderId: A1 }),
      person(A1, KPM_A, 1, 'active', { role: 'ab' }),
      person(A_PENDING, KPM_A, 3, 'pending', { leaderId: A1 }),
      person(B1, KPM_B, 1, 'active', { role: 'ab' }),
    ] as never);
    await mongoose.connection.db!.collection('users').insertMany(
      Object.keys(NAMES).map((id) => ({
        _id: new mongoose.Types.ObjectId('66f000000000000000003' + id.slice(-3)),
        email: `${id}@kpm.test`, fullName: NAMES[id], deletedAt: null,
      })) as never,
    );
  });

  /** A row as an import would leave it, by kode (P19.5-T2) — only what is given, named by the legacy cells. */
  const row = (kpmId: string, membershipId: string, month: string, cells: Record<string, number | null>) => ({
    kpmId, membershipId, month, agentCode: 'PRU-001', deletedAt: null, templateVersion: 1,
    ...byKode(Object.fromEntries(Object.entries(cells).map(([k, v]) => [
      k, { value: v, provenance: v === null ? null : 'imported', sourceBatchId: v === null ? null : 'batch-1' },
    ]))),
  });
  const EMPTY = { value: null, provenance: null, correction: null, outOfBounds: null };

  describe('AC-4 — every member is a row, and null is not zero', () => {
    it('lists every active member with every column empty when nothing has been uploaded — the template’s seven, by kode', async () => {
      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');

      expect(view.rows.map((r) => r.name)).toEqual(['Rina Wijaya', 'Budi Santoso']);
      expect(view.withData).toBe(0);
      expect(view.config.columns.map((c) => c.kode)).toEqual([
        'APE', 'PERSISTENCY', 'RECRUITMENT', 'NEW_ACTIVE_AGENTS', 'FYP', 'POLICY_COUNT', 'UNIT_PERSISTENCY',
      ]);
      for (const r of view.rows) {
        for (const cell of Object.values(r.values)) expect(cell).toEqual(EMPTY);
        for (const cell of Object.values(r.ytd)) expect(cell).toMatchObject({ value: null, provenance: null });
      }
    });

    it('tells a reported zero from nothing reported', async () => {
      // The carrier said Rina wrote nothing. It said nothing at all about Budi.
      await mongoose.connection.db!.collection('monthlyAgentData').insertOne(
        row(KPM_A, A1, '2026-09', { apeMonthly: 0, policyCountMonthly: 0 }) as never,
      );

      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      const [rina, budi] = view.rows;
      expect(rina.values.APE).toEqual({ ...EMPTY, value: 0, provenance: 'imported' });
      expect(budi.values.APE).toEqual(EMPTY);
      expect(view.withData).toBe(1);
    });

    it('leaves a cell the file did not carry as nothing, beside one it did', async () => {
      await mongoose.connection.db!.collection('monthlyAgentData').insertOne(
        row(KPM_A, A1, '2026-09', { apeMonthly: 150_000_000, apeYtd: null }) as never,
      );

      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      expect(view.rows[0].values.APE.value).toBe(150_000_000);
      expect(view.rows[0].values.FYP).toEqual(EMPTY);
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

    it('carries the carrier-issued code on every row — the join key, never a name', async () => {
      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      expect(view.rows[0]).toMatchObject({ membershipId: A1, agentCode: 'PRU-001' });
    });

    it('P19.5-T2 AC-7, AC-15 a year to date the file carried is a check, read by no figure: the cell is the months’ sum', async () => {
      // Migrated from a file that reported the year and nothing for the month: kept in `ytdValues`, summed by nothing.
      await mongoose.connection.db!.collection('monthlyAgentData').insertMany([
        row(KPM_A, A1, '2026-09', { apeYtd: 900_000_000_00 }),
        row(KPM_A, A1, '2026-08', { apeMonthly: 30_000_000_00 }),
      ] as never);
      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      expect(view.rows[0].values.APE.value).toBeNull();
      expect(view.rows[0].ytd.APE).toMatchObject({ value: 30_000_000_00, provenance: 'imported', calculated: true });
      expect(view.withData).toBe(0);
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
      await insert(row(KPM_A, A1, '2026-09', { persistencyMonthly: 92 }));
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
        { ...row(KPM_A, A1, '2026-09', {}), values: { POLICY_COUNT: { value: 0, provenance: 'imported' }, APE: corrected(40_000_000_00) } },
        { ...row(KPM_A, A2, '2026-09', {}), values: { POLICY_COUNT: { value: 0, provenance: 'imported' }, APE: corrected(null) } },
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
      expect(b.rows[0].values.APE.value).toBe(222);
      expect(a.rows.flatMap((r) => [r.values.APE.value])).not.toContain(222);
    });

    it('does not let a row filed under one office surface in another, even for a matching id', async () => {
      // A row mis-keyed to B but naming A's member: B's read must not adopt it, and A's must not
      // reach it — the tenant filter is on the row, not on the id it happens to carry.
      await mongoose.connection.db!.collection('monthlyAgentData').insertOne(
        row(KPM_B, A1, '2026-09', { apeMonthly: 999 }) as never,
      );
      const a = await wired.production.readMonth(owner(KPM_A), '2026-09');
      expect(a.rows[0].values.APE.value).toBeNull();
    });

    it('refuses somebody with no office rather than reading everything', async () => {
      await expect(wired.production.readMonth(noOffice(), '2026-09'))
        .rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
    });
  });

  describe('P13.1-T7 — the rows in the order the org tree reads', () => {
    const WATI = '66f000000000000000000104';
    const YOGA = '66f000000000000000000105';
    const AGUS = '66f000000000000000000106';
    const ANDI = '66f000000000000000000107';
    const CITRA = '66f000000000000000000108';
    const B_AGENT = '66f000000000000000000202';
    const MORE: Record<string, string> = {
      [WATI]: 'Wati Lestari', [YOGA]: 'Yoga Pratama', [AGUS]: 'Agus Prasetyo', [ANDI]: 'Andi Kurniawan',
      [CITRA]: 'Citra Ayu', [B_AGENT]: 'Bayu Anggara',
    };

    beforeEach(async () => {
      // Joined in an order that is not the tree's: sequence and tree disagree on purpose.
      await mongoose.connection.db!.collection('memberships').insertMany([
        person(WATI, KPM_A, 4, 'active', { role: 'ab' }),
        person(ANDI, KPM_A, 5, 'active', { leaderId: A1 }),
        person(AGUS, KPM_A, 6, 'active', { leaderId: YOGA }),
        person(YOGA, KPM_A, 7, 'active', { role: 'aab', leaderId: A1 }),
        person(CITRA, KPM_A, 8),
        person(B_AGENT, KPM_B, 2, 'active', { leaderId: B1 }),
      ] as never);
      await mongoose.connection.db!.collection('users').insertMany(
        Object.keys(MORE).map((id) => ({
          _id: new mongoose.Types.ObjectId('66f000000000000000003' + id.slice(-3)),
          email: `${id}@kpm.test`, fullName: MORE[id], deletedAt: null,
        })) as never,
      );
    });

    const TREE = [
      'Rina Wijaya', 'Yoga Pratama', 'Agus Prasetyo', 'Andi Kurniawan', 'Budi Santoso', 'Wati Lestari', 'Citra Ayu',
    ];

    it('AC-2: each AB, their AABs each with their agents, then their own agents — anybody with no leader last', async () => {
      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      expect(view.rows.map((r) => r.name)).toEqual(TREE);
      // Not the order they joined in.
      expect(view.rows.map((r) => r.agentCode)).toEqual(
        ['PRU-001', 'PRU-007', 'PRU-006', 'PRU-005', 'PRU-002', 'PRU-004', 'PRU-008'],
      );
    });

    it('AC-3: the template lists the same people in the same order as the table', async () => {
      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      const t = await wired.production.template(owner(KPM_A), '2026-09');
      const filed = t.file.split('\n').slice(1).map((line) => line.split(',')[0]);
      expect(filed).toEqual(view.rows.map((r) => r.agentCode));
      expect(t.rowCount).toBe(TREE.length);
    });

    it('AC-2: reads the current edge — somebody moved under another leader moves with them', async () => {
      await mongoose.connection.db!.collection('memberships').updateOne(
        { _id: new mongoose.Types.ObjectId(A2) }, { $set: { leaderId: YOGA, ancestorIds: [A1, YOGA] } },
      );
      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      // Budi now follows Yoga's other agent, ahead of Rina's own Andi.
      expect(view.rows.map((r) => r.name)).toEqual([
        'Rina Wijaya', 'Yoga Pratama', 'Agus Prasetyo', 'Budi Santoso', 'Andi Kurniawan', 'Wati Lestari', 'Citra Ayu',
      ]);
    });

    it('AC-2: leaves out a leader who is pending, and places their reports as having none here', async () => {
      await mongoose.connection.db!.collection('memberships').updateOne(
        { _id: new mongoose.Types.ObjectId(YOGA) }, { $set: { status: 'pending' } },
      );
      const view = await wired.production.readMonth(owner(KPM_A), '2026-09');
      expect(view.rows.map((r) => r.name)).toEqual([
        'Rina Wijaya', 'Andi Kurniawan', 'Budi Santoso', 'Wati Lestari', 'Agus Prasetyo', 'Citra Ayu',
      ]);
    });

    it('AC-2: never places a member under another office’s, and never lists another office’s in the tree', async () => {
      // An edge that names a membership of KPM B — which nothing writes — is not followed across.
      await mongoose.connection.db!.collection('memberships').updateOne(
        { _id: new mongoose.Types.ObjectId(CITRA) }, { $set: { leaderId: B1 } },
      );
      await mongoose.connection.db!.collection('memberships').updateOne(
        { _id: new mongoose.Types.ObjectId(B_AGENT) }, { $set: { leaderId: A1 } },
      );
      const a = await wired.production.readMonth(owner(KPM_A), '2026-09');
      const b = await wired.production.readMonth(owner(KPM_B), '2026-09');
      expect(a.rows.map((r) => r.name)).toEqual(TREE);
      expect(b.rows.map((r) => r.name)).toEqual(['Hendra Wijaya', 'Bayu Anggara']);
      const tb = await wired.production.template(owner(KPM_B), '2026-09');
      expect(tb.file).not.toContain('Rina Wijaya');
      expect(tb.file).not.toContain('Citra Ayu');
    });
  });

  describe('the template (P9-T2)', () => {
    it('AC-4: lists every active member, in the table’s order, with an empty field per column of the template', async () => {
      const t = await wired.production.template(owner(KPM_A), '2026-09');
      const lines = t.file.split('\n');

      expect(t.rowCount).toBe(2);
      expect(lines).toHaveLength(3);
      expect(lines[1]).toBe('PRU-001,"Rina Wijaya",,,,,,,');
      expect(lines[2]).toBe('PRU-002,"Budi Santoso",,,,,,,');
      // Not the pending one — they have registered and nothing more.
      expect(t.file).not.toContain('Calon Baru');
    });

    it('P19.5-T2 AC-1: opens with the template’s header — <label> (<unit>) [KODE] — and names its version', async () => {
      const t = await wired.production.template(owner(KPM_A), '2026-09');
      expect(t.version).toBe(1);
      expect(t.file.split('\n')[0]).toBe(t.header.join(','));
      // In the reader's language: Indonesian, the default.
      expect(t.header.slice(0, 3)).toEqual(['Agent Code', 'Agent Name', 'APE (Rp juta) [APE]']);
      expect(t.header.at(-1)).toBe('Unit persistency (%) [UNIT_PERSISTENCY]');
    });

    it('P19.5-T2 AC-1: names the file <kpmCode>-agent-data-<YYYY-MM>.csv', async () => {
      const t = await wired.production.template(owner(KPM_A), '2026-09');
      expect(t.filename).toBe('0417-agent-data-2026-09.csv');
      expect((await wired.production.template(owner(KPM_B), '2026-01')).filename).toBe('0555-agent-data-2026-01.csv');
    });

    it('AC-2: quotes a name that would otherwise shift every later column', async () => {
      await mongoose.connection.db!.collection('users').updateOne(
        { fullName: 'Rina Wijaya' }, { $set: { fullName: 'Wijaya, Rina "Rin"' } },
      );
      const t = await wired.production.template(owner(KPM_A), '2026-09');
      expect(t.file.split('\n')[1]).toBe('PRU-001,"Wijaya, Rina ""Rin""",,,,,,,');
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
          [code, `"${name}"`, ...V1_KEYS.map((k) => cells[k] ?? '')].join(',')),
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
        analyticsConfig: { templateId: null, version: 1 }, encoding: 'utf-8', delimiter: ',',
        summary: { rows: 1, ready: 1, refused: 0, newCells: 0, changedCells: 1, notInFile: 1 },
      });
      const cells = p.rows[0].cells;
      expect(cells.find((c) => c.kode === 'APE' && !c.ytd))
        .toMatchObject({ status: 'changed', before: 100_000_000, after: 200_000_000 });
      // Not in the file, so not provided — the stored figure stays (ADR-0051).
      expect(cells.find((c) => c.kode === 'FYP' && !c.ytd))
        .toMatchObject({ status: 'not_provided', before: 5 });
      // The file's APE YTD is calculated now (R4): noted, never stored.
      expect(p.notes.map((n) => n.code)).toContain('column_retired');
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
      // No member of A holds it — and since P19.5-T2 it is not in the format of A's codes either (ADR-0214 §5, §7).
      expect(p.rows[0]).toMatchObject({ status: 'refused', membershipId: null, issues: [{ code: expect.stringMatching(/^UPLOAD_(UNKNOWN_AGENT_CODE|AGENT_CODE_PATTERN)$/) }] });
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
      expect(p.rows[0]).toMatchObject({ status: 'refused', issues: [{ code: expect.stringMatching(/^UPLOAD_(UNKNOWN_AGENT_CODE|AGENT_CODE_PATTERN)$/) }] });
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
