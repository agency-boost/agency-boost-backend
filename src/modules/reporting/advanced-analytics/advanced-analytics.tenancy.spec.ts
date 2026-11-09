import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { PLATFORM_READ, QUANT_METRICS } from '@/domain/constants';
import { officeHeadcount } from '@/domain/metrics/office-headcount';
import { platformAnalyticsConfig, type AdvancedAnalyticsConfig } from '@/modules/config/analytics-config';
import { byKode } from '@/modules/production/upload-columns';
import { clearCollections, startMongo, stopMongo } from '../../../../test/mongo';
import { configModule } from '../../../../test/config-module';
import { buildReportingOffice, COMPANY, KPM_A, KPM_B, REPORTING_NOW, type ReportingOffice } from '../../../../test/reporting-office';
import type { Who } from '../../../../test/coaching-office';
import type { DemographicsView, MapaView } from './advanced-analytics.service';

const OTHER_COMPANY = '66f0000000000000000000c9';
const PEER = (n: number) => `66f00000000000000000ab0${n}`;
const M = 1_000_000 * 100;

/**
 * **The KPM's *Advanced analytics* page on real rows** (P19.5-T3; ADR-0215; `functional/advanced-analytics.md`): the
 * reporting office — 0417 (KPM A) beside 0555 (KPM B) of one company — and, for the peers, five more KPMs' Quant runs:
 * three of the company complete, one incomplete, one of another company. Every rule is held against the database: the
 * reader, the sections that are off, the peers' median and count and nothing else, the run that freezes, the targets
 * audited, the Super Admin's read audited and written nothing, and KPM B never reading or writing KPM A.
 */
describe('P19.5-T3 the KPM’s Advanced analytics page, on real rows', () => {
  let wired: ReturnType<typeof configModule>;
  let office: ReportingOffice;
  const db = () => mongoose.connection.db!;
  const clock = () => wired.clock as FixedClock;
  const at = (day: string) => clock().set(new Date(`${day}T03:00:00Z`));
  const page = () => wired.advancedAnalytics;
  const as = (who: Who) => office.as(who);
  const coreLeader = (who: Who) => {
    const c = as(who);
    return new RequestContext(c.userId, 'none', { ...c.membership!, isCoreLeader: true });
  };
  const viewAs = (who: Who) => {
    const c = as(who);
    return new RequestContext(c.userId, 'none', c.membership, 'u-super', null, false, true);
  };
  const SUPER = RequestContext.platform('u-root');
  const refusal = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (err) {
      const e = err as DomainException;
      return { status: e.getStatus(), code: e.code, details: e.details };
    }
    throw new Error('expected a refusal');
  };
  const imported = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });

  /** A complete Quant run for a peer KPM, every metric `value`. */
  const peerRun = (kpmId: string, periodEnd: string, value: number, complete = true) => ({
    kpmId, companyId: COMPANY, periodEnd, peers: null, computedAt: REPORTING_NOW, freezesAt: REPORTING_NOW,
    frozenAt: REPORTING_NOW, lateWriteAt: null, deletedAt: null,
    values: Object.fromEntries(QUANT_METRICS.map(({ metric }) => [metric, { value, complete, missingMonths: complete ? [] : ['2026-03'], reason: null }])),
  });

  /** Publish an *Advanced analytics* version for the company's default template. */
  async function publish(version: number, change: (c: AdvancedAnalyticsConfig) => void): Promise<void> {
    const templateId = '66f00000000000000000aa01';
    await db().collection('templates').updateOne(
      { _id: new mongoose.Types.ObjectId(templateId) },
      { $set: { companyId: COMPANY, name: 'Default', isDefault: true, deletedAt: null, status: 'active' } },
      { upsert: true },
    );
    const payload = platformAnalyticsConfig();
    change(payload);
    await db().collection('companyTemplates').insertOne({
      companyId: COMPANY, templateId, kind: 'advanced_analytics', status: 'published', version, payload, deletedAt: null,
    });
  }

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    wired = configModule(REPORTING_NOW);
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    office = await buildReportingOffice(wired);
    // 0417 started on AgencyBoost in January 2026: its required history is from January 2025 (R5).
    await db().collection('kpms').updateOne({ _id: new mongoose.Types.ObjectId(KPM_A) }, { $set: { createdAt: new Date('2026-01-15T03:00:00Z') } });
    // The member list's facts, for Demographics: Indah 27, female, full-time; Agus 50, male, part-time.
    const userOf = async (who: Who) => new mongoose.Types.ObjectId(await office.userIdOf(who));
    await db().collection('users').updateOne({ _id: await userOf('INDAH') }, { $set: { dateOfBirth: '1999-03-10', gender: 'female' } });
    await db().collection('users').updateOne({ _id: await userOf('AGUS') }, { $set: { dateOfBirth: '1976-01-02', gender: 'male' } });
    await db().collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(office.id.INDAH) }, { $set: { workStatus: 'full_time', joinDate: '2024-07-01' } });
    await db().collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(office.id.AGUS) }, { $set: { workStatus: 'part_time', joinDate: '2016-05-01' } });
    // The peers: three KPMs of the company with complete runs, one incomplete, one of another company. Each `active`,
    // as the schema's default writes every real row: a peer is a live KPM (ADR-0215 §5).
    await db().collection('kpms').insertMany([
      ...[1, 2, 3, 4].map((n) => ({ _id: PEER(n) as never, companyId: COMPANY, code: `09${n}0`, branchName: `P${n}`, timezone: 'Asia/Jakarta', status: 'active', deletedAt: null })),
      { _id: PEER(5) as never, companyId: OTHER_COMPANY, code: '0950', branchName: 'Other', timezone: 'Asia/Jakarta', status: 'active', deletedAt: null },
    ]);
    await db().collection('quantRuns').insertMany([
      peerRun(PEER(1), '2026-06', 2), peerRun(PEER(2), '2026-06', 4), peerRun(PEER(3), '2026-06', 9),
      peerRun(PEER(4), '2026-06', 100, false), { ...peerRun(PEER(5), '2026-06', 50), companyId: OTHER_COMPANY },
      // December 2025: two complete peers only.
      peerRun(PEER(1), '2025-12', 2), peerRun(PEER(2), '2025-12', 4),
    ]);
  }, 120_000);
  afterAll(stopMongo);

  // ------------------------------------------------------------------------------------------------ the shell

  describe('AC-1 the page and who reads it', () => {
    beforeAll(() => clock().set(REPORTING_NOW));

    it('P19.5-T3 AC-1 the Owner sees the template’s sections in its order, then Event; may type targets and upload', async () => {
      const shell = await page().shell(as('OWNER'));
      expect(shell.sections.map((s) => s.slug)).toEqual(['demographics', 'mapa', 'nps', 'quant', 'qual', 'subgroup', 'events']);
      expect(shell).toMatchObject({ canWrite: true, canUpload: true, version: 1 });
      expect((await page().shell(as('ADMIN'))).canWrite).toBe(true);
    });

    it('P19.5-T3 AC-1 a Core Leader reads the whole page read-only; an untagged leader is 404; nobody outside a session reads', async () => {
      expect(await page().shell(coreLeader('AGUS'))).toMatchObject({ canWrite: false, canUpload: false });
      expect(await refusal(page().shell(as('AGUS')))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(await refusal(page().demographics(as('SARI'), {}))).toMatchObject({ status: 404 });
      expect(await refusal(page().shell(SUPER))).toMatchObject({ status: 403, code: 'TENANT_NO_MEMBERSHIP' });
    });

    it('ADR-0215 §2 a view-as session reads the page and may write nothing', async () => {
      expect(await page().shell(viewAs('OWNER'))).toMatchObject({ canWrite: false, canUpload: false });
    });
  });

  // ------------------------------------------------------------------------------------------- Demographics

  describe('AC-2 Demographics', () => {
    it('P19.5-T3 AC-2 every dimension sums to manpower — the headcount on the month’s last day — with Belum diisi', async () => {
      const d = await page().demographics(as('OWNER'), { month: '2026-08' });
      const people = await wired.officePeople.everyone(as('OWNER'), null, 'Asia/Jakarta');
      expect(d.manpower).toBe(officeHeadcount(people, new Date('2026-08-31T17:00:00Z')));
      for (const dim of [d.role, d.workStatus, d.gender, d.ageBand, d.tenureBand]) {
        expect(dim.reduce((s, r) => s + r.count, 0)).toBe(d.manpower);
      }
      expect(d.gender.find((g) => g.key === 'female')!.count).toBeGreaterThanOrEqual(1);
      expect(d.gender.find((g) => g.key === 'unset')!.count).toBe(d.manpower - 2);
      expect(d.ageBand.find((g) => g.key === 'gen_z')!.count).toBe(1);
      expect(d.ageBand.find((g) => g.key === 'gen_x')!.count).toBe(1);
      expect(d.tenureBand.find((g) => g.key === '10')!.count).toBe(1);
      expect(d.workStatus.find((g) => g.key === 'part_time')!.count).toBe(1);
    });

    it('P19.5-T3 AC-2 the AB filter narrows every dimension to that AB’s Group; another KPM’s AB is 404', async () => {
      const all = await page().demographics(as('OWNER'), {});
      const agus = await page().demographics(as('OWNER'), { ab: office.id.AGUS });
      expect(agus.ab).toMatchObject({ membershipId: office.id.AGUS });
      expect(agus.manpower).toBeLessThan(all.manpower);
      expect(agus.abs.map((a) => a.membershipId)).toContain(office.id.PEER_AB);
      for (const dim of [agus.role, agus.gender]) expect(dim.reduce((s, r) => s + r.count, 0)).toBe(agus.manpower);
      expect(await refusal(page().demographics(as('OWNER'), { ab: office.id.B_AB }))).toMatchObject({ status: 404 });
      expect(await refusal(page().demographics(as('OWNER'), { ab: office.id.INDAH }))).toMatchObject({ status: 404 });
      expect(await refusal(page().demographics(as('OWNER'), { month: '2026-10' }))).toMatchObject({ status: 400 });
    });

    it('P19.5-T3 AC-13 cross-tenant: KPM B counts its own people only, and cannot filter by KPM A’s AB', async () => {
      const b = await page().demographics(office.ownerOfB(), {});
      expect(b.manpower).toBe(2);
      expect(await refusal(page().demographics(office.ownerOfB(), { ab: office.id.AGUS }))).toMatchObject({ status: 404 });
    });
  });

  // ------------------------------------------------------------------------------------------------- MAPA

  describe('AC-4 AC-5 MAPA driver', () => {
    beforeAll(async () => {
      clock().set(REPORTING_NOW);
      // D2: September's uploaded recruitment, 3, beside nobody who joined as a new hire in September.
      await db().collection('monthlyAgentData').updateOne(
        { membershipId: office.id.AGUS, month: '2026-09' }, { $set: { 'values.RECRUITMENT': imported(3) } },
      );
    });

    it('P19.5-T3 AC-4 the forum’s nine rows by month, against last year, the months not begun future', async () => {
      const mapa = await page().mapa(as('OWNER'), {});
      expect(mapa.year).toBe('2026');
      expect(mapa.rows.map((r) => r.row)).toEqual([
        'ape', 'manpower', 'flc', 'producing_agents', 'new_agent_3m', 'avg_monthly_aa', 'case_submission',
        'cases_per_producing_agent', 'average_case_size',
      ]);
      const ape = mapa.rows.find((r) => r.row === 'ape')!;
      expect(ape.months).toHaveLength(12);
      expect(ape.months.find((m) => m.month === '2026-01')!.value.kind).toBe('figure');
      expect(ape.months.find((m) => m.month === '2026-12')!.value.kind).toBe('future');
      expect(ape.targetable).toBe(true);
      expect(mapa.rows.find((r) => r.row === 'producing_agents')).toMatchObject({ monthly: false, targetable: false });
      expect(ape.ytd.kind).toBe('figure');
    });

    it('P19.5-T3 AC-5 AT-6 AA UI-012 with March not uploaded, YTD 2026 reads Belum lengkap and names March', async () => {
      const mapa = await page().mapa(as('OWNER'), {});
      expect(mapa.ytdMissingMonths).toContain('2026-03');
      expect(mapa.ytdMissingMonths).not.toContain('2026-09');
    });

    it('P19.5-T3 AC-4 D2’s ⓘ: September’s uploaded recruitment beside the members who joined as new hires', async () => {
      const flc = (await page().mapa(as('OWNER'), {})).rows.find((r) => r.row === 'flc')!;
      const sep = flc.months.find((m) => m.month === '2026-09')!;
      expect(sep.value).toEqual({ kind: 'figure', value: 3 });
      expect(sep.joined).toBe(0);
    });

    it('P19.5-T3 AC-4 the Owner types a target: TBD until filled, audited before and after; KPM B never sees it', async () => {
      expect((await page().mapa(as('OWNER'), {})).rows[0].months[8].target).toBeNull();
      await page().setMapaTarget(as('OWNER'), { month: '2026-09', row: 'ape', value: 150 * M });
      await page().setMapaTarget(as('ADMIN'), { month: '2026-09', row: 'ape', value: 160 * M });
      const ape = (await page().mapa(as('OWNER'), {})).rows[0];
      expect(ape.months[8].target).toBe(160 * M);
      const audits = await db().collection('auditLog').find({ action: 'advanced_analytics.target_set' }).sort({ _id: 1 }).toArray();
      expect(audits.map((a) => [a.before?.value ?? null, a.after.value])).toEqual([[null, 150 * M], [150 * M, 160 * M]]);
      expect((await page().mapa(office.ownerOfB(), {})).rows[0].months[8].target).toBeNull();
    });
  });

  // ------------------------------------------------------------------------------------------------ Quant

  describe('AC-6 to AC-9 Quant, its peers and its runs', () => {
    it('P19.5-T3 AC-9 a Super Admin’s platform read computes the run and writes nothing', async () => {
      at('2026-07-10');
      const view = await page().advancedAnalyticsForOffice(RequestContext.platformRead(SUPER, KPM_A), 'quant', {}) as { periodEnd: string };
      expect(view.periodEnd).toBe('2026-06');
      expect(await db().collection('quantRuns').countDocuments({ kpmId: KPM_A })).toBe(0);
    });

    it('P19.5-T3 AC-9 AA UI-023 the run recalculates until the 15th of July, then freezes; a June upload on 20 July changes nothing', async () => {
      at('2026-07-10');
      const live = await page().quantView(as('OWNER'), {});
      expect(live).toMatchObject({ periodEnd: '2026-06', frozenAt: null, lateWriteAt: null });
      expect(live.runs).toEqual(['2026-06', '2025-12', '2025-06']);
      const caseSize = () => db().collection('quantRuns').findOne({ kpmId: KPM_A, periodEnd: '2026-06' });
      const before = (await caseSize())!.values.AVERAGE_CASE_SIZE_REALISED.value;

      // A June figure written on 12 July: the live run recalculates.
      await db().collection('monthlyAgentData').insertOne({
        kpmId: KPM_A, membershipId: office.id.DIMAS, month: '2026-06', agentCode: 'DIMAS', deletedAt: null,
        ...byKode({ apeMonthly: imported(40 * M), policyCountMonthly: imported(1) }),
      });
      at('2026-07-12');
      await wired.quantRuns.afterWrite(as('OWNER'), '2026-06');
      const recalculated = (await caseSize())!.values.AVERAGE_CASE_SIZE_REALISED.value;
      expect(recalculated).not.toEqual(before);

      // 20 July: the write is about to happen — the run freezes first, as it stands — then the write marks it.
      at('2026-07-20');
      await wired.quantRuns.beforeWrite(as('OWNER'), '2026-06');
      await db().collection('monthlyAgentData').updateOne(
        { membershipId: office.id.DIMAS, month: '2026-06' }, { $set: { 'values.APE': imported(400 * M) } },
      );
      await wired.quantRuns.afterWrite(as('OWNER'), '2026-06');
      const frozen = await page().quantView(as('OWNER'), {});
      expect(frozen.frozenAt).toBe(new Date('2026-07-20T03:00:00Z').toISOString());
      expect(frozen.lateWriteAt).toBe(new Date('2026-07-20T03:00:00Z').toISOString());
      expect((await caseSize())!.values.AVERAGE_CASE_SIZE_REALISED.value).toEqual(recalculated);
      expect(frozen.metrics.find((m) => m.code === 'D1')!.value).toEqual(recalculated);
    });

    it('P19.5-T3 AC-7 AT-7 R3 the median of the company’s other KPMs with complete data — never another company’s, nor an incomplete one', async () => {
      at('2026-09-14');
      const view = await page().quantView(as('OWNER'), { periodEnd: '2026-06' });
      expect(view.metrics).toHaveLength(10);
      for (const m of view.metrics) expect([m.code, m.median, m.peers]).toEqual([m.code, 4, 3]);
      expect(view.needed).toBe(3);
    });

    it('P19.5-T3 AC-7 AT-7 AA Case 6 with two peers the median is null — Belum cukup KPM pembanding (2 dari 3) — and no chip', async () => {
      const view = await page().quantView(as('OWNER'), { periodEnd: '2025-12' });
      for (const m of view.metrics) expect([m.code, m.median, m.peers, m.status]).toEqual([m.code, null, 2, null]);
    });

    it('P19.5-T3 AC-5 AT-6 this KPM’s incomplete values carry their missing months and no chip, and stay out of the peers’ median', async () => {
      const view = await page().quantView(as('OWNER'), { periodEnd: '2026-06' });
      const a1 = view.metrics.find((m) => m.code === 'A1')!;
      expect(a1.complete).toBe(false);
      expect(a1.missingMonths).toContain('2026-03');
      expect(a1.status).toBeNull();
      // KPM B's peers: A's run is incomplete, so B counts P1, P2, P3 — the same median, A not among them.
      const b = await page().quantView(office.ownerOfB(), { periodEnd: '2026-06' });
      expect(b.metrics[0]).toMatchObject({ median: 4, peers: 3 });
    });

    it('P19.5-T3 AC-7 the read answers a median and a count only — no KPM’s id, code, name or single value', async () => {
      const peers = await wired.quantRunRows.peerMediansAcrossTenants(as('OWNER'), '2026-06');
      for (const value of Object.values(peers)) expect(Object.keys(value).sort()).toEqual(['median', 'peers']);
      const wire = JSON.stringify(await page().quantView(as('OWNER'), { periodEnd: '2026-06' }));
      for (const leak of [PEER(1), PEER(2), PEER(3), '0910', '0920', '0930', 'P1', OTHER_COMPANY, KPM_B, '"9"', ':9,', ':2,']) {
        expect([leak, wire.includes(leak)]).toEqual([leak, false]);
      }
    });

    it('P19.5-T3 AC-7 ADR-0215 §5 an archived or a suspended KPM of the company is no peer, though its run is complete', async () => {
      const gone = [PEER(6), PEER(7)];
      await db().collection('kpms').insertMany([
        { _id: PEER(6) as never, companyId: COMPANY, code: '0960', branchName: 'P6', timezone: 'Asia/Jakarta', status: 'archived', deletedAt: null },
        { _id: PEER(7) as never, companyId: COMPANY, code: '0970', branchName: 'P7', timezone: 'Asia/Jakarta', status: 'suspended', deletedAt: null },
      ]);
      await db().collection('quantRuns').insertMany([peerRun(PEER(6), '2026-06', 1000), peerRun(PEER(7), '2026-06', 1000)]);
      try {
        // P1, P2 and P3 alone: the median 4 of three.
        const peers = await wired.quantRunRows.peerMediansAcrossTenants(as('OWNER'), '2026-06');
        for (const value of Object.values(peers)) expect(value).toEqual({ median: 4, peers: 3 });
        // Live again, both count: 2, 4, 9, 1000, 1000 — the median 9 of five.
        await db().collection('kpms').updateMany({ _id: { $in: gone as never[] } }, { $set: { status: 'active' } });
        const live = await wired.quantRunRows.peerMediansAcrossTenants(as('OWNER'), '2026-06');
        for (const value of Object.values(live)) expect(value).toEqual({ median: 9, peers: 5 });
      } finally {
        await db().collection('kpms').deleteMany({ _id: { $in: gone as never[] } });
        await db().collection('quantRuns').deleteMany({ kpmId: { $in: gone } });
      }
    });

    it('P19.5-T3 AC-13 a period that is no run is refused; one older than the history is 404', async () => {
      expect(await refusal(page().quantView(as('OWNER'), { periodEnd: '2026-12' }))).toMatchObject({ status: 400 });
      expect(await refusal(page().quantView(as('OWNER'), { periodEnd: '2024-06' }))).toMatchObject({ status: 404 });
    });
  });

  // --------------------------------------------------------------------------------------------- Sub-group

  describe('AC-10 Sub-group', () => {
    beforeAll(() => clock().set(REPORTING_NOW));

    it('P19.5-T3 AC-10 one row per AB’s agency, the targets the template’s defaults until set', async () => {
      const view = await page().subgroup(as('OWNER'));
      const heads = view.rows.map((r) => r.head.membershipId).sort();
      expect(heads).toEqual([office.id.OWNER, office.id.ADMIN, office.id.AGUS, office.id.PEER_AB].sort());
      const agus = view.rows.find((r) => r.head.membershipId === office.id.AGUS)!;
      expect(agus).toMatchObject({ targets: { aa: 3, rec: 6, isDefault: true }, weeklyActivityTarget: 6 });
      expect(agus.manpower).toBeGreaterThan(agus.leaders);
      expect(agus.recruitment.ytd).toBe(3);
      expect(view.thresholds).toEqual({ okPct: 80, powerUserDays: 10, powerUserWindow: 30 });
      const total = (await wired.officePeople.read(as('OWNER'), null, 'Asia/Jakarta')).active.length;
      expect(view.rows.reduce((s, r) => s + r.manpower, 0)).toBe(total);
    });

    it('P19.5-T3 AC-10 the Owner sets a head’s targets, audited; a head who is no AB, or another KPM’s, is 404', async () => {
      await page().setSubgroupTarget(as('OWNER'), office.id.AGUS, { aaTarget: 4, recTarget: 1 });
      const agus = (await page().subgroup(as('OWNER'))).rows.find((r) => r.head.membershipId === office.id.AGUS)!;
      expect(agus.targets).toEqual({ aa: 4, rec: 1, isDefault: false });
      expect(agus.weeklyActivityTarget).toBe(8);
      expect(agus.attainment).toMatchObject({ recPct: 300, recOk: true });
      expect(await db().collection('auditLog').findOne({ action: 'advanced_analytics.target_set', targetMembershipId: office.id.AGUS }))
        .toMatchObject({ before: null, after: { kind: 'subgroup', aaTarget: 4, recTarget: 1 } });
      expect(await refusal(page().setSubgroupTarget(as('OWNER'), office.id.INDAH, { aaTarget: 1, recTarget: 1 }))).toMatchObject({ status: 404 });
      expect(await refusal(page().setSubgroupTarget(office.ownerOfB(), office.id.AGUS, { aaTarget: 1, recTarget: 1 }))).toMatchObject({ status: 404 });
      expect((await page().subgroup(office.ownerOfB())).rows.map((r) => r.head.membershipId)).toEqual([office.id.B_AB]);
    });
  });

  // ------------------------------------------------------------------------------------ the Super Admin's tab

  describe('AC-12 the Super Admin reads it read-only, audited per visit', () => {
    beforeAll(() => clock().set(REPORTING_NOW));

    it('P19.5-T3 AC-12 the shell as the Owner sees it, no control that writes; one audit entry in each scope', async () => {
      const shell = await wired.adminAdvancedAnalytics.read(SUPER, KPM_A, 'shell', {}) as { canWrite: boolean; canUpload: boolean; sections: unknown[] };
      expect(shell).toMatchObject({ canWrite: false, canUpload: false });
      expect(shell.sections).toHaveLength(7);
      const entries = await db().collection('auditLog').find({ action: PLATFORM_READ.ACTION.kpmAdvancedAnalytics }).toArray();
      expect(entries.map((e) => e.kpmId ?? null).sort()).toEqual([KPM_A, null].sort());
      expect(entries.find((e) => e.kpmId === KPM_A)!.after).toMatchObject({ purpose: PLATFORM_READ.PURPOSE.figures, section: 'shell' });
    });

    it('P19.5-T3 AC-12 A-R9 the survey sections are summaries; the sections answer as the Owner’s', async () => {
      const nps = await wired.adminAdvancedAnalytics.read(SUPER, KPM_A, 'nps', {}) as { audience: string; canWrite: boolean };
      expect(nps).toMatchObject({ audience: 'summary', canWrite: false });
      const subgroup = await wired.adminAdvancedAnalytics.read(SUPER, KPM_A, 'subgroup', {}) as { rows: unknown[]; canWrite: boolean };
      expect(subgroup.canWrite).toBe(false);
      expect(subgroup.rows).toHaveLength(4);
    });

    it('P19.5-T3 AC-12 an unknown KPM or section is 404; a tenant role or a view-as session is refused', async () => {
      expect(await refusal(wired.adminAdvancedAnalytics.read(SUPER, PEER(9), 'shell', {}))).toMatchObject({ status: 404 });
      expect(await refusal(wired.adminAdvancedAnalytics.read(SUPER, KPM_A, 'members', {}))).toMatchObject({ status: 404 });
      expect(await refusal(wired.adminAdvancedAnalytics.read(as('OWNER'), KPM_A, 'shell', {}))).toMatchObject({ status: 403 });
      expect(await refusal(page().advancedAnalyticsForOffice(as('OWNER'), 'shell', {}))).toMatchObject({ status: 403 });
    });
  });

  // ------------------------------------------------------------------------------- a section switched off

  describe('AC-11 a section turned off, and on again', () => {
    beforeAll(() => clock().set(REPORTING_NOW));

    it('P19.5-T3 AC-11 spec §5 Quant and MAPA off lose their tabs and their reads; on again, the earlier run is there', async () => {
      const before = await page().quantView(as('OWNER'), { periodEnd: '2026-06' });
      await publish(2, (c) => {
        for (const s of c.sections) if (s.kode === 'QUANT' || s.kode === 'MAPA') s.enabled = false;
      });
      expect((await page().shell(as('OWNER'))).sections.map((s) => s.slug)).toEqual(['demographics', 'nps', 'qual', 'subgroup', 'events']);
      expect(await refusal(page().quantView(as('OWNER'), {}))).toMatchObject({ status: 404 });
      expect(await refusal(page().mapa(as('OWNER'), {}))).toMatchObject({ status: 404 });
      expect(await refusal(page().setMapaTarget(as('OWNER'), { month: '2026-09', row: 'ape', value: 1 }))).toMatchObject({ status: 404 });
      // The template's order is the tabs' order (P19.5-T1 AC-4).
      await publish(3, (c) => {
        c.sections = [...c.sections].reverse();
      });
      expect((await page().shell(as('OWNER'))).sections.map((s) => s.slug))
        .toEqual(['subgroup', 'qual', 'quant', 'nps', 'mapa', 'demographics', 'events']);
      const again = await page().quantView(as('OWNER'), { periodEnd: '2026-06' });
      expect(again.metrics).toEqual(before.metrics);
      expect(again.frozenAt).toBe(before.frozenAt);
    });
  });

  // ------------------------------------------------------------------------------------------- at its edges

  /*
   * **The page at its edges**, after every case above, each change it makes to a row put back: the Super Admin's read of
   * each section, an office with nobody, a member with no join date, a past and a future year, the new hires beside the
   * uploaded recruitment, targets typed again, an account gone, last year's baseline, the peers' read outside a KPM, a
   * frozen run, a write that races, and the survey tabs a running survey keeps.
   */
  describe('P19.5-T3 the page at its edges', () => {
    const oid = (id: string) => new mongoose.Types.ObjectId(id);
    beforeAll(() => clock().set(REPORTING_NOW));

    it('P19.5-T3 AC-12 the Super Admin’s read of a section is the Owner’s read of it, never writable; an unknown section is 404', async () => {
      const platform = RequestContext.platformRead(SUPER, KPM_A);
      expect(await page().advancedAnalyticsForOffice(platform, 'demographics', { month: '2026-08' }))
        .toEqual(await page().demographics(as('OWNER'), { month: '2026-08' }));
      expect(await page().advancedAnalyticsForOffice(platform, 'events', {})).toEqual(await page().eventsNps(as('OWNER'), {}));
      const mapa = await page().advancedAnalyticsForOffice(platform, 'mapa', {}) as MapaView;
      expect(mapa.canWrite).toBe(false);
      expect({ ...mapa, canWrite: true }).toEqual(await page().mapa(as('OWNER'), {}));
      expect(await refusal(page().advancedAnalyticsForOffice(platform, 'members', {}))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(await refusal(wired.adminAdvancedAnalytics.read(SUPER, 'not-an-id', 'shell', {}))).toMatchObject({ status: 404 });
    });

    it('P19.5-T3 AC-2 an office with nobody in it: manpower 0, every dimension empty, no AB to filter by — never an error', async () => {
      const d = await page().advancedAnalyticsForOffice(RequestContext.platformRead(SUPER, PEER(1)), 'demographics', {}) as DemographicsView;
      expect(d).toMatchObject({ month: '2026-09', manpower: 0, ab: null, abs: [] });
      for (const dim of [d.role, d.workStatus, d.gender, d.ageBand, d.tenureBand]) expect(dim.reduce((s, r) => s + r.count, 0)).toBe(0);
    });

    it('P19.5-T3 AC-2 a row with no join date, and one older than the day the system let anyone in, are each counted — tenure Belum diisi for the first', async () => {
      const before = await page().demographics(office.ownerOfB(), {});
      const unsetTenure = (d: DemographicsView) => d.tenureBand.find((g) => g.key === 'unset')?.count ?? 0;
      const people = [
        // Joined the system in February; no join date on the row.
        { name: 'Tanpa Tanggal', over: { joinedAt: new Date('2026-02-02T03:00:00Z') } },
        // A join date and nothing else: a row written before `joinedAt` was.
        { name: 'Baris Lama', over: { joinDate: '2016-05-01' } },
      ].map((p, i) => ({ ...p, userId: new mongoose.Types.ObjectId(), id: new mongoose.Types.ObjectId(), seq: 901 + i }));
      for (const p of people) {
        await db().collection('users').insertOne({
          _id: p.userId, email: `edge${p.seq}@reporting.test`, passwordHash: 'x', fullName: p.name, status: 'active', deletedAt: null,
        });
        await db().collection('memberships').insertOne({
          _id: p.id, kpmId: KPM_B, userId: String(p.userId), agentCode: `EDGE-${p.seq}`, agentSeq: p.seq, leaderCode: `LEDGE${p.seq}`,
          orgLevelId: 'x', orgLevelCode: 'AGENT', role: 'agent', leaderId: office.id.B_AB, ancestorIds: [office.id.B_AB], depth: 1,
          status: 'active', deletedAt: null, ...p.over,
        });
      }
      try {
        const after = await page().demographics(office.ownerOfB(), {});
        expect(after.manpower).toBe(before.manpower + 2);
        expect(unsetTenure(after)).toBe(unsetTenure(before) + 1);
        expect(after.tenureBand.find((g) => g.key === '10')?.count).toBe((before.tenureBand.find((g) => g.key === '10')?.count ?? 0) + 1);
        for (const dim of [after.role, after.tenureBand]) expect(dim.reduce((s, r) => s + r.count, 0)).toBe(after.manpower);
      } finally {
        await db().collection('memberships').deleteMany({ _id: { $in: people.map((p) => p.id) } });
        await db().collection('users').deleteMany({ _id: { $in: people.map((p) => p.userId) } });
      }
    });

    it('P19.5-T3 AC-9 a run first read long after its freeze is computed then, frozen at that read, and stays as it was frozen', async () => {
      const first = await page().quantView(as('OWNER'), { periodEnd: '2025-06' });
      expect(first).toMatchObject({ periodEnd: '2025-06', frozenAt: REPORTING_NOW.toISOString(), lateWriteAt: null });
      expect(first.metrics).toHaveLength(10);
      at('2026-09-20');
      try {
        const again = await page().quantView(as('OWNER'), { periodEnd: '2025-06' });
        expect(again.frozenAt).toBe(first.frozenAt);
        expect(again.metrics).toEqual(first.metrics);
      } finally {
        clock().set(REPORTING_NOW);
      }
    });

    it('P19.5-T3 AC-4 a past year reads all twelve months against its own last year, none future; a year after this one is 400', async () => {
      const past = await page().mapa(as('OWNER'), { year: '2025' });
      expect(past).toMatchObject({ year: '2025', through: '2025-12' });
      for (const row of past.rows) expect([row.row, row.months.some((m) => m.value.kind === 'future')]).toEqual([row.row, false]);
      expect(await refusal(page().mapa(as('OWNER'), { year: '2027' }))).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    });

    it('P19.5-T3 AC-4 D2’s ⓘ counts every member who joined as a new hire in the month', async () => {
      const hires = [office.id.DIMAS, office.id.BUDI];
      const saved = await db().collection('memberships').find({ _id: { $in: hires.map(oid) } }).project({ joinedAs: 1, joinDate: 1 }).toArray();
      await db().collection('memberships').updateMany({ _id: { $in: hires.map(oid) } }, { $set: { joinedAs: 'new_hire', joinDate: '2026-09-03' } });
      try {
        const flc = (await page().mapa(as('OWNER'), {})).rows.find((r) => r.row === 'flc')!;
        expect(flc.months.find((m) => m.month === '2026-09')).toMatchObject({ value: { kind: 'figure', value: 3 }, joined: 2 });
      } finally {
        for (const row of saved) {
          const put = Object.fromEntries(['joinedAs', 'joinDate'].filter((k) => row[k] !== undefined).map((k) => [k, row[k]]));
          const unset = Object.fromEntries(['joinedAs', 'joinDate'].filter((k) => row[k] === undefined).map((k) => [k, '']));
          await db().collection('memberships').updateOne({ _id: row._id }, { $set: put, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
        }
      }
    });

    it('P19.5-T3 AC-10 the same targets again write nothing; a change to either is audited with what it replaced', async () => {
      const entries = () => db().collection('auditLog')
        .find({ action: 'advanced_analytics.target_set', targetMembershipId: office.id.AGUS }).sort({ _id: 1 }).toArray();
      const before = (await entries()).length;
      expect((await page().subgroup(as('OWNER'))).rows.find((r) => r.head.membershipId === office.id.AGUS)!.targets)
        .toEqual({ aa: 4, rec: 1, isDefault: false });
      await page().setSubgroupTarget(as('OWNER'), office.id.AGUS, { aaTarget: 4, recTarget: 1 });
      expect(await entries()).toHaveLength(before);
      await page().setSubgroupTarget(as('ADMIN'), office.id.AGUS, { aaTarget: 4, recTarget: 2 });
      await page().setSubgroupTarget(as('ADMIN'), office.id.AGUS, { aaTarget: 5, recTarget: 2 });
      expect((await entries()).slice(before).map((e) => [e.before, e.after])).toEqual([
        [{ kind: 'subgroup', aaTarget: 4, recTarget: 1 }, { kind: 'subgroup', aaTarget: 4, recTarget: 2 }],
        [{ kind: 'subgroup', aaTarget: 4, recTarget: 2 }, { kind: 'subgroup', aaTarget: 5, recTarget: 2 }],
      ]);
      expect(await db().collection('analyticsTargets').countDocuments({ kpmId: KPM_A, kind: 'subgroup', headMembershipId: office.id.AGUS })).toBe(1);
    });

    it('P19.5-T3 AC-13 nobody outside a session types a target: TENANT_NO_MEMBERSHIP', async () => {
      expect(await refusal(page().setMapaTarget(SUPER, { month: '2026-09', row: 'ape', value: 1 })))
        .toMatchObject({ status: 403, code: 'TENANT_NO_MEMBERSHIP' });
      expect(await refusal(page().setSubgroupTarget(SUPER, office.id.AGUS, { aaTarget: 1, recTarget: 1 })))
        .toMatchObject({ status: 403, code: 'TENANT_NO_MEMBERSHIP' });
    });

    it('P19.5-T3 AC-10 the MAA baseline is last year’s held months’ average: 1 for Agus’s agency, 0 — never blank — for one with nobody active', async () => {
      expect((await page().subgroup(as('OWNER'))).rows.map((r) => r.maa.baseline)).toEqual([null, null, null, null]);
      await db().collection('monthlyAgentData').insertOne({
        kpmId: KPM_A, membershipId: office.id.AGUS, month: '2025-03', agentCode: 'AGUS', deletedAt: null,
        ...byKode({ apeMonthly: imported(10 * M), policyCountMonthly: imported(1) }),
      });
      try {
        const rows = (await page().subgroup(as('OWNER'))).rows;
        expect(rows.map((r) => [r.head.membershipId, r.maa.baseline]).sort()).toEqual([
          [office.id.ADMIN, 0], [office.id.AGUS, 1], [office.id.OWNER, 0], [office.id.PEER_AB, 0],
        ].sort());
      } finally {
        await db().collection('monthlyAgentData').deleteOne({ kpmId: KPM_A, membershipId: office.id.AGUS, month: '2025-03' });
      }
    });

    it('P19.5-T3 AC-2 AC-10 an AB whose account is gone is still offered and still a row — with no name, first', async () => {
      const userId = new mongoose.Types.ObjectId(await office.userIdOf('PEER_AB'));
      const account = await db().collection('users').findOne({ _id: userId });
      await db().collection('users').deleteOne({ _id: userId });
      try {
        expect((await page().demographics(as('OWNER'), {})).abs[0]).toEqual({ membershipId: office.id.PEER_AB, name: '' });
        expect((await page().subgroup(as('OWNER'))).rows[0].head).toEqual({ membershipId: office.id.PEER_AB, name: '' });
      } finally {
        await db().collection('users').insertOne(account!);
      }
    });

    it('P19.5-T3 AC-7 invariant §1 the run’s company and the peers’ median are read from the caller’s own KPM: refused outside one', async () => {
      await expect(wired.quantRunRows.companyOf(SUPER)).rejects.toBeInstanceOf(MissingTenantContextError);
      await expect(wired.quantRunRows.peerMediansAcrossTenants(SUPER, '2026-06')).rejects.toBeInstanceOf(MissingTenantContextError);
    });

    it('P19.5-T3 AC-7 ADR-0215 §5 a KPM alone in its company, or one with no row, has no peers: every median null, none counted', async () => {
      const none = Object.fromEntries(QUANT_METRICS.map(({ metric }) => [metric, { median: null, peers: 0 }]));
      // 0990, its company's only KPM, with a complete run of its own for June: itself is never its peer.
      const lone = '66f00000000000000000ab0a';
      const loneCompany = '66f0000000000000000000ca';
      await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create({
        _id: lone, companyId: loneCompany, code: '0990', branchName: 'Lone', timezone: 'Asia/Jakarta',
      });
      await db().collection('quantRuns').insertOne({ ...peerRun(lone, '2026-06', 7), companyId: loneCompany });
      try {
        expect(await wired.quantRunRows.peerMediansAcrossTenants(RequestContext.platformRead(SUPER, lone), '2026-06')).toEqual(none);
      } finally {
        await db().collection('kpms').deleteOne({ _id: oid(lone) });
        await db().collection('quantRuns').deleteMany({ kpmId: lone });
      }
      // A context naming a KPM with no row: no company, so nobody to compare with.
      expect(await wired.quantRunRows.peerMediansAcrossTenants(RequestContext.platformRead(SUPER, PEER(9)), '2026-06')).toEqual(none);
      expect(await wired.quantRunRows.companyOf(RequestContext.platformRead(SUPER, PEER(9)))).toBe('');
    });

    it('P19.5-T3 AC-9 a frozen run never moves: a live write into it is refused and its values stay', async () => {
      const stored = await wired.quantRunRows.ofPeriod(as('OWNER'), '2026-06');
      expect(stored!.frozenAt).not.toBeNull();
      const write = await wired.quantRunRows.writeLive(as('OWNER'), '2026-06', {
        companyId: COMPANY, values: {} as never, computedAt: REPORTING_NOW, freezesAt: REPORTING_NOW,
      });
      expect(write).toBeNull();
      expect((await wired.quantRunRows.ofPeriod(as('OWNER'), '2026-06'))!.values).toEqual(stored!.values);
    });

    it('P19.5-T3 AC-4 a target’s write that races another to the unique index is retried once; another failure is not swallowed', async () => {
      const model = (wired.analyticsTargets as unknown as { model: mongoose.Model<unknown> }).model;
      const spy = jest.spyOn(model, 'findOneAndUpdate')
        .mockImplementationOnce((() => ({ exec: async () => { throw Object.assign(new Error('E11000'), { code: 11000 }); } })) as never);
      try {
        expect(await page().setMapaTarget(as('OWNER'), { month: '2026-10', row: 'ape', value: 170 * M }))
          .toEqual({ month: '2026-10', row: 'ape', value: 170 * M });
        expect(spy).toHaveBeenCalledTimes(2);
        spy.mockReset();
        spy.mockImplementationOnce((() => ({ exec: async () => { throw new Error('the database is gone'); } })) as never);
        await expect(page().setMapaTarget(as('OWNER'), { month: '2026-10', row: 'ape', value: 180 * M })).rejects.toThrow('the database is gone');
      } finally {
        spy.mockRestore();
      }
      expect(await db().collection('analyticsTargets').findOne({ kpmId: KPM_A, kind: 'mapa', month: '2026-10', row: 'ape' }))
        .toMatchObject({ value: 170 * M });
    });

    it('P19.5-T3 AC-1 ADR-0216 §2 NPS and Qual turned off keep their tabs while a run of theirs is open; one not running goes', async () => {
      await publish(4, (c) => {
        for (const s of c.sections) if (s.kode === 'NPS' || s.kode === 'QUAL') s.enabled = false;
      });
      await db().collection('surveyRuns').insertOne({
        kpmId: KPM_A, kind: 'nps', periodKey: '2026-Q3', opensOn: '2026-09-01', closesOn: '2026-09-30', invitedRoleClasses: ['agent'],
        anonymous: true, perPerson: false, remindHalfway: true, snapshot: null, openedAt: null, invitedCount: 0, deletedAt: null,
      });
      try {
        const slugs = (await page().shell(as('OWNER'))).sections.map((s) => s.slug);
        expect(slugs).toContain('nps');
        expect(slugs).not.toContain('qual');
      } finally {
        await db().collection('surveyRuns').deleteMany({ kpmId: KPM_A, periodKey: '2026-Q3' });
        await publish(5, () => undefined);
      }
    });
  });
});
