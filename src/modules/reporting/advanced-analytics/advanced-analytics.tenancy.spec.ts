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
    kpmId, companyId: COMPANY, periodEnd, fromMonth: periodEnd.endsWith('-06') ? `${periodEnd.slice(0, 4)}-01` : `${periodEnd.slice(0, 4)}-07`,
    peers: null, computedAt: REPORTING_NOW, freezesAt: REPORTING_NOW,
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

    it('P19.22-T1 AC-1 the Owner sees the seven tabs in the fixed order, then Event; may change targets and upload', async () => {
      const shell = await page().shell(as('OWNER'));
      expect(shell.sections.map((s) => s.slug)).toEqual(['demographics', 'mapa', 'nps', 'quant', 'qual', 'subgroup', 'events']);
      expect(shell).toMatchObject({ canWrite: true, canUpload: true, version: 1 });
      expect((await page().shell(as('ADMIN'))).canWrite).toBe(true);
    });

    // *Changed 2026-11-20 (ADR-0268 §1):* a Core Leader holds the Owner's rights here, the targets and the upload included.
    it('P19.5-T3 AC-1 a Core Leader reads the whole page and writes it; an untagged leader is 404; nobody outside a session reads', async () => {
      expect(await page().shell(coreLeader('AGUS'))).toMatchObject({ canWrite: true, canUpload: true });
      expect(await refusal(page().shell(as('AGUS')))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(await refusal(page().demographics(as('SARI'), {}))).toMatchObject({ status: 404 });
      expect(await refusal(page().shell(SUPER))).toMatchObject({ status: 403, code: 'TENANT_NO_MEMBERSHIP' });
    });

    // P19.22-T1 (ADR-0268 §3; OD-377): the Super Admin inside a KPM is its Owner here — reads every section, writes.
    it('P19.22-T1 AC-1 OD-377 the Super Admin inside the KPM reads and writes the page as its Owner', async () => {
      const inside = RequestContext.superAdminInKpm(SUPER, KPM_A);
      expect(await page().shell(inside)).toMatchObject({ canWrite: true });
      expect((await page().demographics(inside, {})).manpower).toBe((await page().demographics(as('OWNER'), {})).manpower);
      expect((await page().subgroup(inside, {})).canWrite).toBe(true);
      // Agents and leaders who are not core leaders: 404 on every read.
      for (const who of ['INDAH', 'SARI'] as const) {
        expect(await refusal(page().mapa(as(who), {}))).toMatchObject({ status: 404 });
        expect(await refusal(page().subgroup(as(who), {}))).toMatchObject({ status: 404 });
        expect(await refusal(page().subgroupPeople(as(who), { ab: office.id.AGUS, driver: 'maa' }))).toMatchObject({ status: 404 });
      }
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
      expect(b.members.map((m) => m.membershipId).sort()).toEqual([office.id.B_AB, office.id.B_AGENT].sort());
      expect(await refusal(page().demographics(office.ownerOfB(), { ab: office.id.AGUS }))).toMatchObject({ status: 404 });
    });

    it('P19.22-T2 AC-1 the summary, Kelengkapan data per field Leader vs Agent, and Data anggota the incomplete first', async () => {
      const d = await page().demographics(as('OWNER'), {});
      expect(d.summary.manpower).toBe(d.manpower);
      expect(d.summary.complete + d.summary.incomplete).toBe(d.manpower);
      // Indah and Agus have all three on file (work status, birth date, join date): the rest do not.
      expect(d.summary.complete).toBe(2);
      expect(d.completeness.map((c) => c.field)).toEqual(['workStatus', 'dateOfBirth', 'joinDate']);
      const work = d.completeness[0];
      expect(work).toMatchObject({ filled: 2, of: d.manpower });
      expect(work.leaderPct).not.toBeNull();
      expect(work.agentPct).not.toBeNull();
      expect(d.members).toHaveLength(d.manpower);
      expect(d.members[0].missing.length).toBeGreaterThan(0);
      expect(d.members[d.members.length - 1].missing).toEqual([]);
      const indah = d.members.find((m) => m.membershipId === office.id.INDAH)!;
      // The band, never the birth date.
      expect(indah).toMatchObject({ role: 'agent', workStatus: 'full_time', ageBand: 'gen_z', missing: [] });
      expect(JSON.stringify(d)).not.toContain('1999-03-10');
      expect(d.canUpload).toBe(true);
      expect(d.asOf).toBe('2026-09-14');
    });

    it('P19.22-T2 AC-1 Unduh daftar: one row per member, the agent code the key; KPM B lists only its own', async () => {
      const file = await page().demographicsFile(as('OWNER'));
      expect(file.filename).toMatch(/-demografi-2026-09-14\.csv$/);
      const lines = file.file.trim().split('\r\n');
      expect(lines[0]).toBe('Kode agen,Nama,Peran,Upline,Status kerja,Tanggal lahir,Tanggal bergabung');
      const indah = lines.find((l) => l.includes('10/03/1999'))!;
      expect(indah).toContain('Full-time,10/03/1999,01/07/2024');
      const b = await page().demographicsFile(office.ownerOfB());
      expect(b.file.trim().split('\r\n')).toHaveLength(3);
      expect(await refusal(page().demographicsFile(as('SARI')))).toMatchObject({ status: 404 });
    });

    it('P19.22-T2 AC-1 n berhenti: who left from January to the month’s end — never last year, never after the month', async () => {
      const fajar = { _id: new mongoose.Types.ObjectId(office.id.LEFT) };
      const leftOn = (removedAt: string) => db().collection('memberships').updateOne(fajar, { $set: { removedAt: new Date(removedAt) } });
      const before = (await db().collection('memberships').findOne(fajar))!.removedAt ?? null;
      try {
        // Fajar left on 10 May 2026: counted in September's and May's, not in April's.
        await leftOn('2026-05-10T03:00:00Z');
        expect((await page().demographics(as('OWNER'), {})).left).toBe(1);
        expect((await page().demographics(as('OWNER'), { month: '2026-05' })).left).toBe(1);
        expect((await page().demographics(as('OWNER'), { month: '2026-04' })).left).toBe(0);
        // Leaving on 20 December 2025 is last year's.
        await leftOn('2025-12-20T03:00:00Z');
        expect((await page().demographics(as('OWNER'), {})).left).toBe(0);
      } finally {
        await db().collection('memberships').updateOne(fajar, { $set: { removedAt: before } });
      }
    });

    it('P19.22-T2 AC-1 a member with no agent code, one whose account is gone and an office with no code still make the list and the file', async () => {
      const sari = { _id: new mongoose.Types.ObjectId(office.id.SARI) };
      const dodi = { _id: new mongoose.Types.ObjectId(office.id.DODI) };
      const kpm = { _id: new mongoose.Types.ObjectId(KPM_A) };
      const [sariRow, dodiRow, kpmRow] = await Promise.all([
        db().collection('memberships').findOne(sari), db().collection('memberships').findOne(dodi), db().collection('kpms').findOne(kpm),
      ]);
      await db().collection('memberships').updateOne(sari, { $set: { userId: '66f00000000000000000ffff' } });
      await db().collection('memberships').updateOne(dodi, { $unset: { agentCode: '' } });
      await db().collection('kpms').updateOne(kpm, { $set: { code: '' } });
      try {
        const d = await page().demographics(as('OWNER'), {});
        expect(d.members.find((m) => m.membershipId === office.id.SARI)).toMatchObject({ name: '' });
        const file = await page().demographicsFile(as('OWNER'));
        expect(file.filename).toBe('kpm-demografi-2026-09-14.csv');
        const lines = file.file.trim().split('\r\n');
        // Rina's upline is Sari, whose account is gone: an empty cell, and Sari's own row has no name.
        expect(lines.find((l) => l.includes('Rina Wijaya'))!.split(',')[3]).toBe('');
        expect(lines.find((l) => l.startsWith(`${sariRow!.agentCode},`))!.split(',')[1]).toBe('');
        expect(lines.find((l) => l.includes('Dodi'))!.split(',')[0]).toBe('');
        // The upload still finds Sari by her code, and names nobody for her.
        const result = await page().uploadDemographics(as('OWNER'), { file: `Kode agen,Status kerja\n${sariRow!.agentCode},Full-time\n` });
        expect(result.rows[0]).toMatchObject({ name: null, status: 'updated' });
      } finally {
        await db().collection('memberships').updateOne(sari, { $set: { userId: sariRow!.userId, workStatus: sariRow!.workStatus ?? null } });
        await db().collection('memberships').updateOne(dodi, { $set: { agentCode: dodiRow!.agentCode } });
        await db().collection('kpms').updateOne(kpm, { $set: { code: kpmRow!.code } });
      }
    });

    it('P19.22-T2 AC-1 Upload fills what the file holds, leaves an empty cell alone, audits each member; another KPM’s code is not found', async () => {
      const code = (await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.DIMAS) }))!.agentCode as string;
      const bCode = (await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.B_AGENT) }))!.agentCode as string;
      const csv = [
        'Kode agen;Status kerja;Tanggal lahir;Tanggal bergabung',
        `${code};Part-time;02/01/1990;`,
        `${bCode};Full-time;;`,
        'NOPE;Full-time;;',
        `${code};Full-time;;`,
      ].join('\n');
      const result = await page().uploadDemographics(as('OWNER'), { file: csv });
      expect(result).toMatchObject({ updated: 1, skipped: 3 });
      expect(result.rows.map((r) => r.status)).toEqual(['updated', 'not_found', 'not_found', 'not_found']);
      expect(result.rows[0].fields.sort()).toEqual(['dateOfBirth', 'workStatus']);
      const dimas = await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.DIMAS) });
      expect(dimas!.workStatus).toBe('part_time');
      expect(dimas!.joinDate ?? null).not.toBe('');
      const audit = await db().collection('auditLog').findOne({ action: 'member.personal_completed', targetMembershipId: office.id.DIMAS });
      expect(audit!.after).toMatchObject({ workStatus: 'part_time', dateOfBirth: '1990-01-02', via: 'advanced_analytics.demographics_upload' });
      // KPM B's agent untouched.
      expect((await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.B_AGENT) }))!.workStatus ?? null).toBeNull();
      // Again, the same values: nothing changes, nothing audited.
      const again = await page().uploadDemographics(as('OWNER'), { file: `Kode agen,Status kerja\n${code},Part-time\n` });
      expect(again).toMatchObject({ updated: 0, unchanged: 1 });
    });

    it('P19.22-T2 AC-1 a cell that is no date or status is named, and nothing of it is written; a file with no Kode agen is 400', async () => {
      const code = (await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.BUDI) }))!.agentCode as string;
      const result = await page().uploadDemographics(as('OWNER'), { file: `Kode agen,Status kerja,Tanggal lahir\n${code},sometimes,31/02/1990\n` });
      expect(result.rows[0]).toMatchObject({ status: 'invalid', problems: [{ field: 'workStatus', value: 'sometimes' }, { field: 'dateOfBirth', value: '31/02/1990' }] });
      expect(await refusal(page().uploadDemographics(as('OWNER'), { file: 'Nama,Status kerja\nX,Full-time\n' })))
        .toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    });

    it('P19.22-T2 AC-1 a join date after today, or none at all, is named and not written; rows with no code are not found', async () => {
      const budi = (await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.BUDI) }))!;
      const audits = await db().collection('auditLog').countDocuments({ action: 'member.personal_completed', targetMembershipId: office.id.BUDI });
      // Today is 14 September 2026 in the office's zone: the 15th is tomorrow.
      for (const joinDate of ['15/09/2026', 'kemarin']) {
        const result = await page().uploadDemographics(as('OWNER'), { file: `Kode agen,Tanggal bergabung\n${budi.agentCode},${joinDate}\n` });
        expect(result).toMatchObject({ updated: 0, skipped: 1 });
        expect(result.rows[0]).toMatchObject({ status: 'invalid', problems: [{ field: 'joinDate', value: joinDate }] });
      }
      expect((await db().collection('memberships').findOne({ _id: budi._id }))!.joinDate ?? null).toBe(budi.joinDate ?? null);
      expect(await db().collection('auditLog').countDocuments({ action: 'member.personal_completed', targetMembershipId: office.id.BUDI }))
        .toBe(audits);
      // A filled file whose code column is empty names nobody: every row not found, and no member is read for it.
      const find = jest.spyOn(wired.memberships, 'find');
      try {
        const blank = await page().uploadDemographics(as('OWNER'), { file: 'Kode agen,Status kerja\n,Full-time\n ,Part-time\n' });
        expect(blank).toMatchObject({ updated: 0, unchanged: 0, skipped: 2 });
        expect(blank.rows.map((r) => r.status)).toEqual(['not_found', 'not_found']);
        expect(find.mock.calls.some(([, filter]) => JSON.stringify(filter).includes('agentCode'))).toBe(false);
      } finally {
        find.mockRestore();
      }
    });

    it('P19.22-T2 AC-1 a file larger than the limit is 400 before any row of it is read', async () => {
      const big = `Kode agen,Status kerja\n${'X,Full-time\n'.repeat(Math.ceil(90_000 / 12) + 1)}`;
      expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(90_000);
      expect(await refusal(page().uploadDemographics(as('OWNER'), { file: big })))
        .toMatchObject({ status: 400, code: 'VALIDATION_FAILED', details: { field: 'file' } });
    });

    it('P19.22-T2 AC-1 ADR-0268 §1 a core leader fills their own downline only; a member they do not lead is not_yours', async () => {
      const code = (id: string) => db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(id) }).then((m) => m!.agentCode as string);
      const csv = `Kode agen,Tanggal bergabung\n${await code(office.id.NINA)},01/02/2020\n${await code(office.id.PEER_AB)},01/02/2020\n`;
      const result = await page().uploadDemographics(coreLeader('AGUS'), { file: csv });
      expect(result.rows.map((r) => r.status)).toEqual(['updated', 'not_yours']);
      expect(await refusal(page().uploadDemographics(as('AGUS'), { file: csv }))).toMatchObject({ status: 404 });
      expect(await refusal(page().uploadDemographics(viewAs('OWNER'), { file: csv }))).toMatchObject({ status: 403, code: 'IMPERSONATION_READ_ONLY' });
    });
  });

  // ------------------------------------------------------------------------------------------------- MAPA

  describe('P19.22-T3 MAPA driver', () => {
    beforeAll(() => clock().set(REPORTING_NOW));

    it('P19.22-T3 AC-2 eight rows: APE alone, then M · A · P · A, each with its YTD pair and its month trio', async () => {
      const mapa = await page().mapa(as('OWNER'), {});
      expect(mapa).toMatchObject({ month: '2026-09', currentMonth: '2026-09', earliestMonth: '2025-01' });
      expect(mapa.rows.map((r) => [r.key, r.group])).toEqual([
        ['ape', 'ape'], ['manpower', 'manpower'], ['rekrut', 'manpower'], ['active_agent', 'activation'],
        ['new_agent_3m', 'activation'], ['policies', 'productivity'], ['policies_per_active_agent', 'productivity'],
        ['average_case_size', 'case_size'],
      ]);
      const ape = mapa.rows[0];
      // APE's YTD is the year's total so far — the Overview's year to date; its month the office's file's.
      expect(ape.ytd).toBeGreaterThan(ape.thisMonth!);
      expect(ape.ytdChange.kind).toBe('pct');
      expect(mapa.rows.find((r) => r.key === 'new_agent_3m')!.changeVsSameMonth.kind).toBe('points');
      expect(mapa.dataThrough).toBe('2026-09');
      // Every row month by month (the scorecard's `everyMonth`): the ratios the forum's table left *Not tracked*.
      const size = mapa.rows.find((r) => r.key === 'average_case_size')!;
      expect(size.thisMonth).not.toBeNull();
      expect(mapa.rows.find((r) => r.key === 'policies_per_active_agent')!.thisMonth).not.toBeNull();
    });

    it('P19.22-T3 AC-2 every other row’s YTD is the average per month: Manpower the mean of the month-end headcounts', async () => {
      const mapa = await page().mapa(as('OWNER'), {});
      const manpower = mapa.rows.find((r) => r.key === 'manpower')!;
      const months = await Promise.all(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']
        .map((m) => page().mapa(as('OWNER'), { month: m }).then((v) => v.rows.find((r) => r.key === 'manpower')!.thisMonth)));
      const mean = Math.round((months.reduce((a, b) => a! + b!, 0)! / months.length) * 10) / 10;
      expect(manpower.ytd).toBe(mean);
    });

    it('P19.22-T3 AC-2 Rekrut is the New Hires definition: the members who joined as new hires in the month, test accounts never', async () => {
      const hires = [office.id.DIMAS, office.id.BUDI];
      const saved = await db().collection('memberships').find({ _id: { $in: hires.map((id) => new mongoose.Types.ObjectId(id)) } })
        .project({ joinedAs: 1, joinDate: 1, testAccount: 1 }).toArray();
      await db().collection('memberships').updateMany(
        { _id: { $in: hires.map((id) => new mongoose.Types.ObjectId(id)) } }, { $set: { joinedAs: 'new_hire', joinDate: '2026-09-03' } },
      );
      await db().collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(office.id.BUDI) }, { $set: { testAccount: true } });
      try {
        const rekrut = (await page().mapa(as('OWNER'), {})).rows.find((r) => r.key === 'rekrut')!;
        expect(rekrut.thisMonth).toBe(1);
        expect(rekrut.sameMonthLastYear).toBe(0);
      } finally {
        for (const row of saved) {
          const put = Object.fromEntries(['joinedAs', 'joinDate', 'testAccount'].filter((k) => row[k] !== undefined).map((k) => [k, row[k]]));
          const unset = Object.fromEntries(['joinedAs', 'joinDate', 'testAccount'].filter((k) => row[k] === undefined).map((k) => [k, '']));
          await db().collection('memberships').updateOne({ _id: row._id }, { $set: put, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
        }
      }
    });

    /*
     * **One definition per number** (ADR-0267 §1, §2; invariant §8; the integration review of 20 November 2026): MAPA read 23
     * for the demo office's October where the Overview's *Performa vs target* read 24 — the scorecard counted the members
     * on the month's last day, the Overview the office's counted members, and the Admin's join date fell after October.
     * Both count through `activeAgentsOver` now, over the same people.
     */
    it('integration review: Active Agent is the KPM Overview’s for the same month — a member joined since, and a test account, alike', async () => {
      const activeOf = async (month: string) => [
        (await page().mapa(as('OWNER'), { month })).rows.find((r) => r.key === 'active_agent')!.thisMonth,
        (await wired.kpmOverview.performance(as('OWNER'), { month })).total.actual.activeAgents,
      ];
      // A producer of August whose join date is after it: a file row kept before they registered (*Belum jadi anggota*).
      const producer = await db().collection('monthlyAgentData').findOne({ kpmId: KPM_A, month: '2026-08', 'values.APE.value': { $gt: 0 } });
      const id = new mongoose.Types.ObjectId(producer!.membershipId as string);
      const saved = (await db().collection('memberships').findOne({ _id: id }))!;
      await db().collection('memberships').updateOne({ _id: id }, { $set: { joinDate: '2026-09-05' } });
      try {
        const [mapa, overview] = await activeOf('2026-08');
        expect(mapa).not.toBeNull();
        expect(mapa).toBe(overview);
        const [september, overviewSeptember] = await activeOf('2026-09');
        expect(september).toBe(overviewSeptember);
        // A test account is in neither (ADR-0267 §1): both one fewer.
        await db().collection('memberships').updateOne({ _id: id }, { $set: { testAccount: true } });
        expect(await activeOf('2026-08')).toEqual([mapa! - 1, overview! - 1]);
      } finally {
        await db().collection('memberships').updateOne(
          { _id: id }, saved.testAccount === undefined
            ? { $set: { joinDate: saved.joinDate ?? null }, $unset: { testAccount: '' } }
            : { $set: { joinDate: saved.joinDate ?? null, testAccount: saved.testAccount } },
        );
      }
    });

    it('P19.22-T3 AC-3 Target bulanan is read-only and consolidated: AA and Rekrut the AB groups’ sums; none set reads null', async () => {
      const none = await page().mapa(as('OWNER'), {});
      expect(none.rows.find((r) => r.key === 'active_agent')!.target).toBeNull();
      expect(none.rows.find((r) => r.key === 'manpower')!.target).toBeNull();
      await wired.abGroupTargets.set(as('OWNER'), office.id.AGUS, { month: '2026-09', activeAgentTarget: 4, rekrutTarget: 2 });
      await wired.abGroupTargets.set(as('OWNER'), office.id.PEER_AB, { month: '2026-09', activeAgentTarget: 3, rekrutTarget: 1 });
      const mapa = await page().mapa(as('OWNER'), {});
      expect(mapa.rows.find((r) => r.key === 'active_agent')!.target).toBe(7);
      expect(mapa.rows.find((r) => r.key === 'rekrut')!.target).toBe(3);
      expect(mapa.headline.activeAgent.target).toBe(7);
      expect(mapa.headline.activeAgent.tone).not.toBeNull();
      // KPM B reads none of A's targets.
      expect((await page().mapa(office.ownerOfB(), {})).rows.find((r) => r.key === 'active_agent')!.target).toBeNull();
    });

    it('P19.22-T3 AC-3 the month picker moves everything; a month after this one, or before January of last year, is 400', async () => {
      const aug = await page().mapa(as('OWNER'), { month: '2026-08' });
      expect(aug.month).toBe('2026-08');
      expect(aug.rows[0].thisMonth).toBe((await page().mapa(as('OWNER'), {})).rows[0].lastMonth);
      expect(await refusal(page().mapa(as('OWNER'), { month: '2026-10' }))).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
      expect(await refusal(page().mapa(as('OWNER'), { month: '2024-12' }))).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
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
      expect(live.runs).toEqual([
        { periodEnd: '2026-06', fromMonth: '2026-01' }, { periodEnd: '2025-12', fromMonth: '2025-07' }, { periodEnd: '2025-06', fromMonth: '2025-01' },
      ]);
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
      // P19.22-T4: the KPM's own leaders' values and counts are on the wire now, so a bare `:2,` may be one of theirs; the
      // peers' figures are 2, 4 and 9 — 9 is none of 0417's.
      for (const leak of [PEER(1), PEER(2), PEER(3), '0910', '0920', '0930', 'P1', OTHER_COMPANY, KPM_B, '"9"', ':9,']) {
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

    it('P19.22-T4 ADR-0275 §4 a December run frozen before the half-years held the whole year: from January, and a whole year’s peer only', async () => {
      at('2026-09-14');
      // 0417's own December 2025, frozen with no `fromMonth`, as every run was before the half-years.
      const december = { kpmId: KPM_A, periodEnd: '2025-12' };
      const stored = await db().collection('quantRuns').findOne(december);
      const run = {
        companyId: COMPANY, peers: null, computedAt: REPORTING_NOW, freezesAt: REPORTING_NOW, frozenAt: REPORTING_NOW, lateWriteAt: null,
        deletedAt: null,
        values: Object.fromEntries(QUANT_METRICS.map(({ metric }) => [metric, { value: 6, complete: true, missingMonths: [], reason: null }])),
      };
      await db().collection('quantRuns').updateOne(december, { $set: run, $unset: { fromMonth: '' } }, { upsert: true });
      try {
        const view = await page().quantView(as('OWNER'), { periodEnd: '2026-06' });
        expect(view.runs.find((r) => r.periodEnd === '2025-12')).toEqual({ periodEnd: '2025-12', fromMonth: '2025-01' });
        // KPM B's peers for December: a run over July to December reads P1 and P2 only; one over the whole year reads 0417's.
        const halfYear = await wired.quantRunRows.peerMediansAcrossTenants(office.ownerOfB(), '2025-12', '2025-07');
        for (const value of Object.values(halfYear)) expect(value.peers).toBe(2);
        const wholeYear = await wired.quantRunRows.peerMediansAcrossTenants(office.ownerOfB(), '2025-12', '2025-01');
        for (const value of Object.values(wholeYear)) expect(value).toEqual({ median: null, peers: 1 });
      } finally {
        await db().collection('quantRuns').deleteOne(december);
        if (stored) await db().collection('quantRuns').insertOne(stored);
      }
    });

    it('P19.5-T3 AC-9 a live run’s write that fails for any reason but a racing insert is not retried, and fails', async () => {
      at('2026-07-10');
      const findOne = jest.spyOn(wired.quantRunRows, 'findOne').mockRejectedValueOnce(new Error('the database went away'));
      try {
        await expect(wired.quantRunRows.writeLive(as('OWNER'), '2026-06', {
          companyId: COMPANY, values: {} as never, computedAt: REPORTING_NOW, freezesAt: REPORTING_NOW, fromMonth: '2026-01',
        })).rejects.toThrow('the database went away');
        expect(findOne).toHaveBeenCalledTimes(1);
      } finally {
        findOne.mockRestore();
      }
    });

    it('P19.5-T3 AC-13 a period that is no run is refused; one older than the history is 404', async () => {
      expect(await refusal(page().quantView(as('OWNER'), { periodEnd: '2026-12' }))).toMatchObject({ status: 400 });
      expect(await refusal(page().quantView(as('OWNER'), { periodEnd: '2024-06' }))).toMatchObject({ status: 404 });
    });
  });

  // --------------------------------------------------------------------------------------------- Sub-group

  describe('P19.22-T5 Informal group', () => {
    beforeAll(() => clock().set(REPORTING_NOW));
    const activeTotal = async () => (await wired.officePeople.read(as('OWNER'), null, 'Asia/Jakarta')).active.length;

    it('P19.22-T5 AC-2 with no group: Total KPM is the whole office; one card, Tanpa group, holding every AB group', async () => {
      const view = await page().subgroup(as('OWNER'), {});
      expect(view).toMatchObject({ month: '2026-09', currentMonth: '2026-09', canWrite: true });
      // No month asked is the office's own.
      expect((await page().subgroup(as('OWNER'))).month).toBe('2026-09');
      expect(view.total).toMatchObject({ groups: 0, people: await activeTotal() });
      expect(view.groups).toHaveLength(1);
      expect(view.groups[0].group).toBeNull();
      // 0417's four ABs: the Owner, the Admin, Agus and Hendra — each an AB group.
      expect(view.groups[0].abGroups.map((r) => r.ab.membershipId).sort())
        .toEqual([office.id.OWNER, office.id.ADMIN, office.id.AGUS, office.id.PEER_AB].sort());
      const agus = view.groups[0].abGroups.find((r) => r.ab.membershipId === office.id.AGUS)!;
      expect(agus).toMatchObject({ ab: { role: 'ab', name: 'Agus Salim' } });
      expect(agus.people).toBeGreaterThan(agus.leaders);
    });

    it('P19.22-T5 AC-2 the four drivers: MAA vs target, Pemakaian downline and leader, 1-on-1 ÷ 4,35 vs 2 × target, Rekrut YTD', async () => {
      const view = await page().subgroup(as('OWNER'), {});
      const agus = view.groups[0].abGroups.find((r) => r.ab.membershipId === office.id.AGUS)!.drivers;
      // Targets set in MAPA's case: Agus 4 Active Agent and Rekrut 2 for September; carried none earlier.
      expect(agus.maa.target).toBe(4);
      expect(agus.oneOnOne.target).toBe(8);
      expect(agus.rekrut.target).toBe(2);
      expect(agus.maa.value).not.toBeNull();
      expect(agus.maa.pct).toBe(Math.floor((200 * agus.maa.value! + 4) / 8));
      expect(['green', 'yellow', 'red']).toContain(agus.maa.tone);
      expect(agus.usage.downlinePct).not.toBeNull();
      expect(agus.usage.leaderPct).not.toBeNull();
      // Total KPM's targets are the sums of its AB groups': Agus 4 + Hendra 3.
      expect(view.total.drivers.maa.target).toBe(7);
      expect(view.total.drivers.oneOnOne.target).toBe(14);
    });

    it('P19.22-T5 AC-3 one card per informal group, A to Z, with its Group Leaders and AB groups; the cards sum to the office', async () => {
      const groups = [['AGUS', 'AGUS'], ['HENDRA', 'PEER_AB'], ['MAYA', 'ADMIN'], ['WILSON', 'OWNER']] as const;
      for (const [name, who] of groups) {
        const { insertedId } = await db().collection('groups').insertOne({
          kpmId: KPM_A, name, leaderMembershipIds: [office.id[who]], status: 'active', archivedAt: null, deletedAt: null,
        });
        await db().collection('memberships').updateOne(
          { _id: new mongoose.Types.ObjectId(office.id[who]) }, { $set: { groupIds: [String(insertedId)] } },
        );
      }
      const view = await page().subgroup(as('OWNER'), {});
      expect(view.groups.map((g) => [g.group?.name, g.leaders.map((l) => l.membershipId)])).toEqual(
        groups.map(([name, who]) => [name, [office.id[who]]]),
      );
      expect(view.total.groups).toBe(4);
      expect(view.groups.reduce((sum, g) => sum + g.counts.people, 0)).toBe(await activeTotal());
      const agus = view.groups.find((g) => g.group?.name === 'AGUS')!;
      expect(agus.counts).toMatchObject({ abGroups: 1, leaders: 4 });
      expect(agus.abGroups[0].ab.isGroupLeader).toBe(true);
      // P19.13-T3 AC-9: 0555 has no group of its own and reads none of 0417's.
      const b = await page().subgroup(office.ownerOfB(), {});
      expect(b.groups.map((g) => [g.group, g.counts.people])).toEqual([[null, 2]]);
    });

    it('P19.22-T5 AC-1 the month moves everything; a month after this one is 400', async () => {
      const aug = await page().subgroup(as('OWNER'), { month: '2026-08' });
      expect(aug.month).toBe('2026-08');
      // No target for August: September's are not carried backwards.
      expect(aug.total.drivers.maa.target).toBeNull();
      expect(await refusal(page().subgroup(as('OWNER'), { month: '2026-10' }))).toMatchObject({ status: 400 });
    });

    it('P19.22-T5 AC-4 MAA’s sheet: who is active with APE and polis, then who is not yet — everyone of the AB group once', async () => {
      const people = (await page().subgroup(as('OWNER'), {})).groups.flatMap((g) => g.abGroups)
        .find((r) => r.ab.membershipId === office.id.AGUS)!.people;
      const sheet = await page().subgroupPeople(as('OWNER'), { ab: office.id.AGUS, driver: 'maa' });
      expect(sheet.ab).toMatchObject({ membershipId: office.id.AGUS, name: 'Agus Salim' });
      const active = sheet.maa!.active.map((r) => r.person.membershipId);
      const notYet = sheet.maa!.notYet.map((r) => r.person.membershipId);
      expect(new Set([...active, ...notYet]).size).toBe(people);
      expect(active).toContain(office.id.AGUS);
      expect(sheet.maa!.active.find((r) => r.person.membershipId === office.id.AGUS)!.apeMinor).toBe(30 * M);
    });

    it('P19.22-T5 AC-4 the Pemakaian, 1-on-1 and Rekrut sheets each list the AB group’s people', async () => {
      const people = (await page().subgroup(as('OWNER'), {})).groups.flatMap((g) => g.abGroups)
        .find((r) => r.ab.membershipId === office.id.AGUS)!.people;
      const usage = await page().subgroupPeople(as('OWNER'), { ab: office.id.AGUS, driver: 'usage' });
      expect(usage.usage!.notUsed.length + usage.usage!.used.length).toBe(people);
      const stars = usage.usage!.used.map((r) => r.powerUser);
      expect(stars).toEqual([...stars].sort((a, b) => Number(b) - Number(a)));
      const coaching = await page().subgroupPeople(as('OWNER'), { ab: office.id.AGUS, driver: 'coaching' });
      expect(coaching.coaching).toHaveLength(people);
      const ranks = coaching.coaching!.map((r) => ({ never: 0, lapsed: 1, recent: 2 })[r.status]);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      const rekrut = await page().subgroupPeople(as('OWNER'), { ab: office.id.AGUS, driver: 'rekrut' });
      expect(rekrut.rekrut).toMatchObject({ potential: expect.any(Number) });
      for (const r of rekrut.rekrut!.joined) expect(r.joinDate >= '2026-01-01').toBe(true);
    });

    it('P19.22-T5 AC-4 Rekrut’s sheet: each new hire an AB group’s member brought in this year, their day and who brought them', async () => {
      const sari = (await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.SARI) }))!;
      const hire = (fullName: string, joinDate: string, registeredBy: string | null) => {
        const userId = new mongoose.Types.ObjectId();
        return {
          user: { _id: userId, email: `${fullName.split(' ')[0].toLowerCase()}@rekrut.test`, passwordHash: 'x', fullName, status: 'active', platformRole: 'none', deletedAt: null },
          membership: {
            _id: new mongoose.Types.ObjectId(), kpmId: KPM_A, userId: String(userId), agentCode: `RK-${joinDate}`, agentSeq: 900,
            leaderCode: `RK${joinDate.slice(5)}`, orgLevelId: 'x', orgLevelCode: 'AGENT', role: 'agent', leaderId: office.id.SARI,
            ancestorIds: [...(sari.ancestorIds as string[]), office.id.SARI], depth: 3, status: 'active', joinedAs: 'new_hire',
            joinDate, joinedAt: new Date(`${joinDate}T02:00:00Z`), registeredByMembershipId: registeredBy, testAccount: false, deletedAt: null,
          },
        };
      };
      // Sari brought Fikri in on 3 September and Gita on 2 March; Hana came by the import, brought in by nobody.
      const hires = [hire('Fikri Hidayat', '2026-09-03', office.id.SARI), hire('Gita Maharani', '2026-03-02', office.id.SARI), hire('Hana Putri', '2026-09-05', null)];
      await db().collection('users').insertMany(hires.map((h) => h.user));
      await db().collection('memberships').insertMany(hires.map((h) => h.membership));
      try {
        const sheet = await page().subgroupPeople(as('OWNER'), { ab: office.id.AGUS, driver: 'rekrut' });
        // The latest first; Hana is credited to nobody, so to no AB group.
        expect(sheet.rekrut!.joined.map((r) => [r.person.name, r.joinDate, r.recruiter])).toEqual([
          ['Fikri Hidayat', '2026-09-03', { membershipId: office.id.SARI, name: 'Sari Puspita' }],
          ['Gita Maharani', '2026-03-02', { membershipId: office.id.SARI, name: 'Sari Puspita' }],
        ]);
        expect(sheet.drivers.rekrut.value).toBe(2);
        const view = await page().subgroup(as('OWNER'), {});
        expect(view.groups.flatMap((g) => g.abGroups).find((r) => r.ab.membershipId === office.id.AGUS)!.drivers.rekrut.value).toBe(2);
        expect(view.total.drivers.rekrut.value).toBe(2);
      } finally {
        await db().collection('memberships').deleteMany({ _id: { $in: hires.map((h) => h.membership._id) } });
        await db().collection('users').deleteMany({ _id: { $in: hires.map((h) => h.user._id) } });
      }
    });

    it('P19.22-T5 AC-4 Pemakaian’s sheet: of those who have not used it in 30 days, never first, then the longest since', async () => {
      // Budi last logged on 20 July and Nina on 10 August: both outside the 30 days ending today, 14 September.
      const day = (who: Who, localDate: string) => ({
        kpmId: KPM_A, membershipId: office.id[who], localDate, entries: [], deletedAt: null, createdAt: REPORTING_NOW, updatedAt: REPORTING_NOW,
      });
      const { insertedIds } = await db().collection('activityLogs').insertMany([day('BUDI', '2026-07-20'), day('NINA', '2026-08-10')]);
      try {
        const { usage } = await page().subgroupPeople(as('OWNER'), { ab: office.id.AGUS, driver: 'usage' });
        const since = usage!.notUsed.map((r) => r.daysSince);
        // Nobody who never logged comes after somebody who did; among those who did, the longest since first.
        expect(since.findIndex((d) => d !== null)).toBeGreaterThanOrEqual(since.lastIndexOf(null));
        const seen = usage!.notUsed.filter((r) => r.daysSince !== null);
        expect(seen.map((r) => [r.person.membershipId, r.lastLoggedOn, r.daysSince]).slice(-2)).toEqual([
          [office.id.BUDI, '2026-07-20', 56], [office.id.NINA, '2026-08-10', 35],
        ]);
      } finally {
        await db().collection('activityLogs').deleteMany({ _id: { $in: Object.values(insertedIds) } });
      }
    });

    it('P19.22-T5 AC-4 MAA’s sheet: who is not yet active this month carries the last month they were', async () => {
      // Budi, in Agus's AB group, had an active July and nothing since.
      const { insertedId } = await db().collection('monthlyAgentData').insertOne({
        kpmId: KPM_A, membershipId: office.id.BUDI, month: '2026-07', agentCode: 'BUDI', deletedAt: null,
        ...byKode({ apeMonthly: imported(12 * M), policyCountMonthly: imported(1) }),
      });
      try {
        const sheet = await page().subgroupPeople(as('OWNER'), { ab: office.id.AGUS, driver: 'maa' });
        const budi = sheet.maa!.notYet.find((r) => r.person.membershipId === office.id.BUDI)!;
        expect(budi).toMatchObject({ lastActiveMonth: '2026-07', potensi: expect.any(Number) });
        expect(sheet.maa!.notYet.find((r) => r.person.membershipId === office.id.NINA)!.lastActiveMonth).toBeNull();
      } finally {
        await db().collection('monthlyAgentData').deleteOne({ _id: insertedId });
      }
    });

    it('P19.22-T5 AC-4 an AAB heads no AB group, and another KPM’s AB is not found: 404', async () => {
      expect(await refusal(page().subgroupPeople(as('OWNER'), { ab: office.id.SARI, driver: 'maa' }))).toMatchObject({ status: 404 });
      expect(await refusal(page().subgroupPeople(office.ownerOfB(), { ab: office.id.AGUS, driver: 'maa' }))).toMatchObject({ status: 404 });
      expect(await refusal(page().subgroupPeople(as('OWNER'), { ab: office.id.B_AB, driver: 'maa' }))).toMatchObject({ status: 404 });
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
      const subgroup = await wired.adminAdvancedAnalytics.read(SUPER, KPM_A, 'subgroup', {}) as { groups: unknown[]; canWrite: boolean };
      expect(subgroup.canWrite).toBe(false);
      expect(subgroup.groups).toHaveLength(4);
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
      // P19.22-T1 AC-1 (ADR-0275 §1): the order is fixed — a template that reorders its sections moves no tab.
      await publish(3, (c) => {
        c.sections = [...c.sections].reverse();
      });
      expect((await page().shell(as('OWNER'))).sections.map((s) => s.slug))
        .toEqual(['demographics', 'mapa', 'nps', 'quant', 'qual', 'subgroup', 'events']);
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
      // The same figures; the upload is the Owner's alone (`canUpload`).
      expect(await page().advancedAnalyticsForOffice(platform, 'demographics', { month: '2026-08' }))
        .toEqual({ ...await page().demographics(as('OWNER'), { month: '2026-08' }), canUpload: false });
      expect(await page().advancedAnalyticsForOffice(platform, 'events', {})).toEqual(await page().eventsNps(as('OWNER'), {}));
      // A platform read reads no steward's targets (ADR-0275 §3): the figures are the Owner's, the targets none.
      const mapa = await page().advancedAnalyticsForOffice(platform, 'mapa', {}) as MapaView;
      const own = await page().mapa(as('OWNER'), {});
      expect(mapa.rows.map((r) => [r.key, r.thisMonth, r.ytd])).toEqual(own.rows.map((r) => [r.key, r.thisMonth, r.ytd]));
      expect(mapa.rows.every((r) => r.target === null)).toBe(true);
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

    it('P19.5-T3 AC-13 nobody outside a KPM reads the page or sets a target: TENANT_NO_MEMBERSHIP', async () => {
      expect(await refusal(page().subgroup(SUPER, {}))).toMatchObject({ status: 403, code: 'TENANT_NO_MEMBERSHIP' });
      expect(await refusal(page().uploadDemographics(SUPER, { file: 'Kode agen\n' }))).toMatchObject({ status: 403, code: 'TENANT_NO_MEMBERSHIP' });
      expect(await refusal(wired.abGroupTargets.set(SUPER, office.id.AGUS, { month: '2026-09', activeAgentTarget: 1, rekrutTarget: 1 })))
        .toMatchObject({ status: 403, code: 'TENANT_NO_MEMBERSHIP' });
    });

    it('P19.5-T3 AC-2 AC-10 an AB whose account is gone is still offered and still a row’s ★ — with no name', async () => {
      const userId = new mongoose.Types.ObjectId(await office.userIdOf('PEER_AB'));
      const account = await db().collection('users').findOne({ _id: userId });
      await db().collection('users').deleteOne({ _id: userId });
      try {
        expect((await page().demographics(as('OWNER'), {})).abs[0]).toEqual({ membershipId: office.id.PEER_AB, name: '' });
        const card = (await page().subgroup(as('OWNER'), {})).groups.find((g) => g.leaders.some((l) => l.membershipId === office.id.PEER_AB))!;
        expect(card.leaders).toEqual([{ membershipId: office.id.PEER_AB, name: '', photoUrl: null }]);
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
        companyId: COMPANY, values: {} as never, computedAt: REPORTING_NOW, freezesAt: REPORTING_NOW, fromMonth: '2026-01',
      });
      expect(write).toBeNull();
      expect((await wired.quantRunRows.ofPeriod(as('OWNER'), '2026-06'))!.values).toEqual(stored!.values);
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
