import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { KPM_COMPARISON_SORTS, PLATFORM_READ, type KpmComparisonSort } from '@/domain/constants';
import { MemberNames } from '@/modules/org/member-names.service';
import { DataUploadBatch, DataUploadBatchSchema } from '@/modules/production/data-upload-batch.schema';
import { DataUploadBatchRepository } from '@/modules/production/data-upload-batch.repository';
import { COMPANY } from '../../../../test/coaching-office';
import {
  KPM_A, KPM_B, startComplianceHarness, stopComplianceHarness, type ComplianceHarness,
} from '../../../../test/compliance-office';
import { declaredPermissions, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../../test/http-permissions';
import { listenOnLoopback } from '../../../../test/listen';
import { ComplianceController } from '../compliance/compliance.controller';
import { ComplianceService } from '../compliance/compliance.service';
import { KpmAnalyticsService } from '../kpm-analytics.service';
import { KpmOverviewService } from '../kpm-overview.service';
import { KpmAnalyticsController, KpmOverviewController } from '../reporting.controller';
import { PlatformReadsController } from './platform-reads.controller';
import { PlatformReads } from './platform-reads.service';

/** A second company, its KPM, and a person in a KPM of each company (SA case 3). */
const MANULIFE = '66f0000000000000000000c2';
const KPM_C = '66f0000000000000000000d1';

/** Every field a row of *All members* carries (ADR-0207 §2), and nothing else. */
const MEMBER_FIELDS = [
  'agentCode', 'company', 'fullName', 'invitation', 'joinedOn', 'kpm', 'lastActiveOn', 'leader', 'membershipId', 'role',
  'status',
].sort();

/**
 * **The Super Admin's reads across KPMs, over HTTP** (P19.4-T3 AC-1 to AC-4, AC-9, AC-15, AC-16; ADR-0207): the real
 * `PermissionsGuard` and pipe, the real services over the compliance office — 0417 and 0555 of Prudential — and a second
 * company's KPM. Each read: the Super Admin alone; the listed fields field by field; the audit entries in the platform's
 * log and each KPM's; and the per-KPM figures equal to what the KPM's own Owner reads.
 */
describe('P19.4-T3 the Super Admin’s reads across KPMs (ADR-0207)', () => {
  let h: ComplianceHarness;
  let app: INestApplication;
  let reads: PlatformReads;
  const http = () => request(app.getHttpServer());
  const db = () => mongoose.connection.db!;
  const oid = (id: string) => new mongoose.Types.ObjectId(id);
  const asSuperAdmin = () => { session.current = SUPER_ADMIN; };
  /** The audit rows written since `mark`. */
  const mark = async (): Promise<mongoose.mongo.ObjectId | null> =>
    ((await db().collection('auditLog').find({}).sort({ _id: -1 }).limit(1).next())?._id as mongoose.mongo.ObjectId) ?? null;
  const since = async (at: mongoose.mongo.ObjectId | null, action?: string) => db().collection('auditLog').find({
    ...(at ? { _id: { $gt: at } } : {}), ...(action ? { action } : {}),
  }).toArray();
  /** Every collection's document count but the audit log's: a read that only looks moves none. */
  const counts = async () => Object.fromEntries(await Promise.all((await db().listCollections().toArray())
    .map((c) => c.name).filter((n) => n !== 'auditLog').sort()
    .map(async (n) => [n, await db().collection(n).countDocuments()] as const)));
  let crossUserId: string;

  beforeAll(async () => {
    h = await startComplianceHarness();
    const owner = await h.office.userIdOf('OWNER');
    await db().collection('kpms').updateOne({ _id: oid(KPM_A) }, { $set: { ownerUserId: owner } });
    await db().collection('users').updateOne({ _id: oid(await h.office.userIdOf('INDAH')) }, { $set: { phone: '+6281234500001' } });
    await db().collection('memberships').updateOne({ _id: oid(h.id('DIMAS')) }, { $set: { invitedAt: new Date('2026-09-01T03:00:00Z') } });
    await db().collection('memberships').updateOne({ _id: oid(h.id('ADMIN')) }, { $set: { 'adminAccess.isKpmAdmin': true } });
    await db().collection('users').updateOne({ _id: oid(await h.office.userIdOf('DIMAS')) }, { $set: { lastLoginAt: null } });

    // Manulife, its KPM M01, and Bayu Saputra of 0555 — removed there — active in M01 (SA case 3).
    await db().collection('companies').insertOne({ _id: oid(MANULIFE), name: 'Manulife', slug: 'manulife-platform-reads', deletedAt: null });
    await (h.wired.kpms as unknown as { create: (d: unknown) => Promise<unknown> }).create({
      _id: KPM_C, companyId: MANULIFE, code: 'M01', branchName: 'Medan', timezone: 'Asia/Jakarta',
    });
    const bayu = await db().collection('memberships').findOne({ _id: oid(h.id('B_AGENT')) });
    crossUserId = bayu!.userId as string;
    const m01 = new mongoose.Types.ObjectId();
    await db().collection('memberships').insertOne({
      _id: m01, kpmId: KPM_C, userId: crossUserId, agentCode: 'MLI-0001', agentSeq: 1, leaderCode: 'LMLI0001',
      orgLevelId: new mongoose.Types.ObjectId().toString(), orgLevelCode: 'AGENT', role: 'agent', leaderId: null,
      ancestorIds: [], depth: 0, directCounts: { total: 0 }, subtreeCount: 0, status: 'active',
      joinedAt: new Date('2026-06-01T03:00:00Z'), deletedAt: null,
    });
    await db().collection('memberships').updateOne({ _id: oid(h.id('B_AGENT')) }, {
      $set: { status: 'removed', removedAt: new Date('2026-05-31T03:00:00Z') },
    });
    // M01's September in its file — APE and recruitment by kode — so its month is held.
    const figure = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });
    await db().collection('monthlyAgentData').insertOne({
      kpmId: KPM_C, membershipId: String(m01), month: '2026-09', agentCode: 'MLI-0001', deletedAt: null,
      values: { APE: figure(12 * 100 * 1_000_000), RECRUITMENT: figure(2) },
    });
    // One upload of 0417's September, by its Owner, for *Data bulanan*'s history.
    await db().collection('dataUploadBatches').insertOne({
      kpmId: KPM_A, month: '2026-09', status: 'committed', filename: 'sep.csv', fileSha256: 'x', encoding: 'utf-8',
      delimiter: ',', basedOnRevision: 0, monthRevision: 1, rowCount: 5, writtenRowCount: 5, cellCount: 10, issueCount: 0,
      startedAt: new Date('2026-09-05T03:00:00Z'), committedAt: new Date('2026-09-05T03:01:00Z'), committedBy: h.id('OWNER'),
      asOf: null, deletedAt: null,
    });

    const batchModel = mongoose.models[DataUploadBatch.name] ?? mongoose.model(DataUploadBatch.name, DataUploadBatchSchema);
    reads = new PlatformReads(
      h.wired.kpms as never, h.wired.companies as never, h.wired.users as never, h.wired.memberships,
      h.wired.orgLevels, h.wired.activityReadings, h.wired.kpmOverview, h.wired.kpmAnalytics, h.compliance,
      h.wired.productionReadings, new DataUploadBatchRepository(batchModel as never),
      new MemberNames(h.wired.memberships, h.wired.users as never), h.wired.officePeople, h.wired.audit, h.wired.clock,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformReadsController, KpmOverviewController, KpmAnalyticsController, ComplianceController],
      providers: [
        { provide: PlatformReads, useValue: reads },
        { provide: KpmOverviewService, useValue: h.wired.kpmOverview },
        { provide: KpmAnalyticsService, useValue: h.wired.kpmAnalytics },
        { provide: ComplianceService, useValue: h.compliance },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stopComplianceHarness(h);
  });

  it('P19.4-T3 AC-16 declares the platform grants on every route', () => {
    expect(declaredPermissions(PlatformReadsController)).toEqual({
      members: 'platform_members:read',
      // P19.12-T2 AC-1 (ADR-0245 §1): *Akun terdaftar*, under the same grant (`platform-accounts.int.spec.ts`).
      accounts: 'platform_members:read',
      comparison: 'platform_kpm_figures:read',
      analytics: 'platform_kpm_figures:read',
      compliance: 'platform_kpm_figures:read',
      data: 'platform_kpm_figures:read',
      companyKpms: 'platform_kpm_figures:read',
    });
  });

  const ROUTES = [
    `/admin/members`, `/admin/analytics/kpms`, `/admin/tenants/${KPM_A}/analytics`,
    `/admin/tenants/${KPM_A}/analytics/compliance`, `/admin/tenants/${KPM_A}/data`, `/admin/companies/${COMPANY}/kpms`,
  ];

  describe('P19.4-T3 AC-16 the Super Admin’s alone', () => {
    it.each(['OWNER', 'ADMIN', 'AGUS', 'SARI', 'INDAH'] as const)(
      'P19.4-T3 AC-16 negative: %s is refused every read, 403, and nothing is recorded',
      async (who) => {
        h.as(who);
        const at = await mark();
        for (const path of ROUTES) await http().get(path).expect(403);
        expect(await since(at)).toEqual([]);
      },
    );

    it('P19.4-T3 AC-16 negative: a view-as session — the Owner, viewed by a Super Admin — is refused every read', async () => {
      session.current = h.supporting('OWNER');
      for (const path of ROUTES) await http().get(path).expect(403);
    });

    it('P19.4-T3 AC-16 negative: a context that is no platform read cannot reach the `…ForOffice` reads', async () => {
      await expect(h.wired.kpmOverview.figuresForOffice(h.office.as('OWNER'))).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
      await expect(h.wired.kpmAnalytics.analyticsForOffice(RequestContext.superAdminInTenant('root', KPM_A)))
        .rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
      await expect(h.compliance.complianceForOffice(h.supporting('OWNER'))).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
    });

    it('P19.4-T3 AC-16 positive: the Super Admin reads each, and an unknown or malformed KPM is 404', async () => {
      asSuperAdmin();
      for (const path of ROUTES) await http().get(path).expect(200);
      await http().get(`/admin/tenants/${new mongoose.Types.ObjectId()}/analytics`).expect(404);
      await http().get('/admin/tenants/not-an-id/data').expect(404);
      await http().get(`/admin/companies/${new mongoose.Types.ObjectId()}/kpms`).expect(404);
    });
  });

  describe('P19.4-T3 AC-1, AC-2 — All members', () => {
    it('P19.4-T3 AC-1 one row per membership, the listed fields alone — never an email or a phone', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/members').expect(200);
      expect(res.body).toMatchObject({ page: 1, pageSize: PLATFORM_READ.PAGE_SIZE });
      expect(res.body.total).toBe(res.body.rows.length);
      for (const row of res.body.rows) {
        expect(Object.keys(row).sort()).toEqual(MEMBER_FIELDS);
        expect(Object.keys(row.company).sort()).toEqual(['id', 'name']);
        expect(Object.keys(row.kpm).sort()).toEqual(['branch', 'code', 'id']);
        expect(Object.keys(row.role).sort()).toEqual(['code', 'isAdmin', 'isOwner', 'label']);
        if (row.leader !== null) expect(Object.keys(row.leader)).toEqual(['fullName']);
      }
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/@coaching\.test|@compliance\.test|6281234500001|"email"|"phone"/);
    });

    it('P19.4-T3 AC-2 (SA case 1) a name finds the row with every field', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/members').query({ q: 'indah perm' }).expect(200);
      expect(res.body.rows).toEqual([{
        membershipId: h.id('INDAH'), fullName: 'Indah Permatasari', agentCode: expect.any(String),
        company: { id: COMPANY, name: 'Prudential' }, kpm: { id: KPM_A, code: '0417', branch: 'A' },
        role: { code: 'AGENT', label: expect.any(String), isOwner: false, isAdmin: false },
        leader: { fullName: 'Agus Salim' }, status: 'active', invitation: 'signed_in', joinedOn: '2026-01-02',
        lastActiveOn: '2026-09-10',
      }]);
    });

    it('P19.4-T3 AC-1 a phone number finds its person however it is typed, and an email too — neither returned', async () => {
      asSuperAdmin();
      for (const q of ['0812 3450 0001', '+62 812-3450-0001', '81234500001']) {
        const res = await http().get('/admin/members').query({ q }).expect(200);
        expect(res.body.rows.map((r: { membershipId: string }) => r.membershipId)).toEqual([h.id('INDAH')]);
      }
      const byEmail = await http().get('/admin/members').query({ q: 'dimas@coaching' }).expect(200);
      expect(byEmail.body.rows.map((r: { fullName: string }) => r.fullName)).toEqual(['Dimas Pratama']);
      expect(byEmail.body.rows[0].invitation).toBe('invited');
    });

    it('P19.4-T3 AC-2 (SA case 2) Company = Prudential with Role = AB gives only Prudential’s ABs, the Owner badged', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/members').query({ companyId: COMPANY, role: 'AB' }).expect(200);
      const names = res.body.rows.map((r: { fullName: string }) => r.fullName);
      expect(names).toEqual(['Agus Salim', 'Hendra Gunawan', 'Lina Marlina', 'Maya Kusuma', 'Wilson Tanoto']);
      for (const row of res.body.rows) expect(row.company.name).toBe('Prudential');
      const owner = res.body.rows.find((r: { fullName: string }) => r.fullName === 'Wilson Tanoto');
      expect(owner.role).toMatchObject({ isOwner: true });
      expect(res.body.rows.find((r: { fullName: string }) => r.fullName === 'Maya Kusuma').role).toMatchObject({ isAdmin: true });
    });

    it('P19.4-T3 AC-2 (SA case 3) a person in two KPMs of two companies is two rows, one Removed', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/members').query({ q: 'Bayu Saputra' }).expect(200);
      expect(res.body.rows.map((r: { kpm: { code: string }; company: { name: string }; status: string }) =>
        [r.company.name, r.kpm.code, r.status])).toEqual([['Prudential', '0555', 'removed'], ['Manulife', 'M01', 'active']]);
    });

    it('P19.4-T3 AC-1 one KPM (the *Anggota* tab), one status, and a page past the last', async () => {
      asSuperAdmin();
      const kpm = await http().get('/admin/members').query({ kpmId: KPM_B }).expect(200);
      expect(new Set(kpm.body.rows.map((r: { kpm: { id: string } }) => r.kpm.id))).toEqual(new Set([KPM_B]));
      const removed = await http().get('/admin/members').query({ status: 'removed' }).expect(200);
      expect(removed.body.rows.map((r: { fullName: string }) => r.fullName).sort()).toEqual(['Bayu Saputra', 'Fajar Nugroho']);
      const past = await http().get('/admin/members').query({ page: 9 }).expect(200);
      expect(past.body).toMatchObject({ rows: [], page: 9 });
      expect(past.body.total).toBeGreaterThan(0);
    });

    it('P19.4-T3 AC-1 refuses a search under two characters, an unknown role, status or page, and an operator — recording nothing', async () => {
      asSuperAdmin();
      const at = await mark();
      for (const query of [{ q: 'a' }, { role: 'owner' }, { status: 'gone' }, { page: '0' }, { kpmId: 'x' }, { 'q[$ne]': 'x' }, { extra: '1' }]) {
        const res = await http().get('/admin/members').query(query).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
      expect(await since(at)).toEqual([]);
    });

    it('P19.4-T3 AC-16 audited: one entry in the platform’s log naming every row, one in each KPM’s naming its own', async () => {
      asSuperAdmin();
      const at = await mark();
      const res = await http().get('/admin/members').query({ q: 'Bayu Saputra' }).expect(200);
      const rows = await since(at, PLATFORM_READ.ACTION.members);
      expect(rows).toHaveLength(3);
      const platform = rows.find((r) => r.kpmId === null)!;
      expect(platform).toMatchObject({
        actorUserId: 'root', targetCollection: 'kpms', targetId: null,
        after: {
          purpose: PLATFORM_READ.PURPOSE.members, page: 1, rows: 2,
          filters: { companyId: null, kpmId: null, role: null, status: null, q: 'Bayu Saputra' },
          membershipIds: res.body.rows.map((r: { membershipId: string }) => r.membershipId),
        },
      });
      for (const row of res.body.rows) {
        const own = rows.find((r) => r.kpmId === row.kpm.id)!;
        expect(own).toMatchObject({
          targetCollection: 'kpms', targetId: row.kpm.id,
          after: { purpose: PLATFORM_READ.PURPOSE.members, rows: 1, membershipIds: [row.membershipId] },
        });
      }
    });

    it('P19.4-T3 AC-16 an entry that cannot be written fails the read, 500, and nothing is served', async () => {
      asSuperAdmin();
      const spy = jest.spyOn(h.wired.audit, 'recordInScopesOrFail').mockRejectedValueOnce(new Error('audit down'));
      const res = await http().get('/admin/members').expect(500);
      expect(res.body.rows).toBeUndefined();
      spy.mockRestore();
    });
  });

  describe('P19.4-T3 AC-3 — the KPM comparison', () => {
    it('P19.4-T3 AC-3 each cell equals the same figure on that KPM’s /kpm/overview, field by field', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/analytics/kpms').expect(200);
      expect(res.body).toMatchObject({ page: 1, pageSize: PLATFORM_READ.PAGE_SIZE, total: 3, sort: 'kpm' });
      expect(res.body.rows.map((r: { code: string }) => r.code)).toEqual(['0417', '0555', 'M01']);
      for (const [kpmId, owner] of [[KPM_A, h.office.as('OWNER')], [KPM_B, h.ownerOfB()]] as const) {
        session.current = owner;
        const overview = (await http().get('/kpm/overview').expect(200)).body;
        const row = res.body.rows.find((r: { kpmId: string }) => r.kpmId === kpmId);
        expect(Object.keys(row).sort()).toEqual(
          ['activeThisMonth', 'activeUsers', 'branch', 'coached', 'code', 'company', 'kpmId', 'members', 'production', 'recruitment'],
        );
        expect(row.members).toBe(overview.composition.total);
        const { asOf: _asOf, ...active } = overview.engagement.activeThisMonth;
        expect(row.activeThisMonth).toEqual(active);
        expect(row.activeUsers).toEqual(overview.engagement.loggedThisWeek);
        expect(row.coached).toEqual({ d7: overview.coaching.coverage7d, d30: overview.coaching.coverage30d });
        expect(row.production).toEqual({
          achievedMinor: overview.production.ytd.achievedMinor, targetMinor: overview.production.ytd.targetMinor,
          pct: overview.production.ytd.pct,
        });
        expect(row.recruitment).toEqual({ pipeline: overview.recruitment.pipelineNow, target: overview.recruitment.target });
      }
    });

    it('P19.4-T3 AC-3 filters by company and sorts by a column, a KPM with no figure last', async () => {
      asSuperAdmin();
      const manulife = await http().get('/admin/analytics/kpms').query({ companyId: MANULIFE }).expect(200);
      expect(manulife.body.rows.map((r: { code: string }) => r.code)).toEqual(['M01']);
      const desc = await http().get('/admin/analytics/kpms').query({ sort: '-members' }).expect(200);
      const members = desc.body.rows.map((r: { members: number }) => r.members);
      expect(members).toEqual([...members].sort((a, b) => b - a));
      await http().get('/admin/analytics/kpms').query({ sort: 'rank' }).expect(400);
    });

    it('P19.4-T3 AC-3 audited once in the platform’s log and once in each KPM’s; nothing in any KPM is written', async () => {
      asSuperAdmin();
      const before = await counts();
      const at = await mark();
      await http().get('/admin/analytics/kpms').expect(200);
      const rows = await since(at);
      expect(rows.map((r) => [r.action, r.kpmId]).sort()).toEqual([
        [PLATFORM_READ.ACTION.kpmComparison, KPM_A], [PLATFORM_READ.ACTION.kpmComparison, KPM_B],
        [PLATFORM_READ.ACTION.kpmComparison, KPM_C], [PLATFORM_READ.ACTION.kpmComparison, null],
      ].sort());
      expect(rows.find((r) => r.kpmId === null)!.after).toMatchObject({ purpose: PLATFORM_READ.PURPOSE.figures, rows: 3 });
      expect(await counts()).toEqual(before);
    });
  });

  describe('P19.4-T3 AC-4 — Lihat sebagai KPM (and P19.4-T2 AC-6)', () => {
    /** The reader's own flags aside — the Owner is a reader of the page, the Super Admin nobody in it. */
    const asOffice = (view: { leaders: { head: { isReader: boolean } }[]; agencies: unknown[] }) => JSON.parse(
      JSON.stringify(view).replace(/"isReader":true/g, '"isReader":false'),
    );

    it('P19.4-T3 AC-4 *Overview* is exactly what the KPM’s Owner reads, for each period', async () => {
      for (const period of ['this_month', 'previous_month']) {
        session.current = h.office.as('OWNER');
        const owner = (await http().get('/kpm/analytics').query({ period }).expect(200)).body;
        asSuperAdmin();
        const platform = (await http().get(`/admin/tenants/${KPM_A}/analytics`).query({ period }).expect(200)).body;
        expect(asOffice(platform)).toEqual(asOffice(owner));
      }
    });

    it('P19.4-T3 AC-4 *Compliance* is exactly what the Owner reads, but `can.override`, which writes', async () => {
      for (const category of ['training', 'activity', 'goals']) {
        session.current = h.office.as('OWNER');
        const owner = (await http().get('/kpm/analytics/compliance').query({ category }).expect(200)).body;
        asSuperAdmin();
        const platform = (await http().get(`/admin/tenants/${KPM_A}/analytics/compliance`).query({ category }).expect(200)).body;
        expect(platform.can).toEqual({ override: false });
        expect({ ...platform, can: null }).toEqual({ ...owner, can: null });
      }
    });

    it('P19.4-T3 AC-4 (A-R8, P19.4-T2 AC-6) each visit writes its entries, and nothing else changes', async () => {
      asSuperAdmin();
      const before = await counts();
      const at = await mark();
      await http().get(`/admin/tenants/${KPM_A}/analytics`).expect(200);
      await http().get(`/admin/tenants/${KPM_A}/analytics/compliance`).query({ category: 'campaigns' }).expect(200);
      const visits = await since(at, PLATFORM_READ.ACTION.kpmAnalytics);
      expect(visits.map((r) => [r.kpmId, r.after.filters?.tab ?? r.after.tab]).sort()).toEqual([
        [KPM_A, 'compliance'], [KPM_A, 'overview'], [null, 'compliance'], [null, 'overview'],
      ].sort());
      for (const row of visits) expect(row).toMatchObject({ actorUserId: 'root', targetCollection: 'kpms', targetId: KPM_A });
      expect(await counts()).toEqual(before);
    });
  });

  describe('P19.4-T3 AC-9 — Data bulanan', () => {
    it('P19.4-T3 AC-9 twelve months — Lengkap, Belum, — — and the uploads, by name, read-only', async () => {
      asSuperAdmin();
      const res = await http().get(`/admin/tenants/${KPM_A}/data`).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['kpmId', 'months', 'uploads']);
      expect(res.body.months).toHaveLength(PLATFORM_READ.DATA_MONTHS);
      expect(res.body.months.map((m: { month: string }) => m.month)).toEqual([
        '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07',
        '2026-08', '2026-09',
      ]);
      expect(res.body.uploads).toEqual([{
        month: '2026-09', by: 'Wilson Tanoto', at: '2026-09-05T03:01:00.000Z', agents: 5, note: { status: 'committed', asOf: null },
      }]);
      // M01, made today: its September is held, every month before it is *—*.
      const m01 = await http().get(`/admin/tenants/${KPM_C}/data`).expect(200);
      expect(m01.body.months[11]).toEqual({ month: '2026-09', status: 'complete' });
      expect(new Set(m01.body.months.slice(0, 11).map((m: { status: string }) => m.status))).toEqual(new Set(['none']));
      expect(m01.body.uploads).toEqual([]);
    });

    it('P19.4-T3 AC-9 a month the KPM existed in and did not upload is *Belum*', async () => {
      asSuperAdmin();
      await db().collection('kpms').updateOne({ _id: oid(KPM_B) }, { $set: { createdAt: new Date('2025-01-02T03:00:00Z') } });
      const res = await http().get(`/admin/tenants/${KPM_B}/data`).expect(200);
      // 0555 was made before the window: every month is its own, so a month not held is *Belum*, never *—*.
      for (const m of res.body.months) expect(['missing', 'complete']).toContain(m.status);
      expect(res.body.months.some((m: { status: string }) => m.status === 'missing')).toBe(true);
    });
  });

  describe('P19.4-T3 AC-8 — the offices list’s data status', () => {
    it('P19.4-T3 AC-8 the latest month held, and the last ended month when it is missing and the KPM existed in it', async () => {
      const offices = await db().collection('kpms').find({ _id: { $in: [oid(KPM_B), oid(KPM_C)] } }).toArray();
      const status = await reads.dataStatusAcrossTenants(SUPER_ADMIN, offices.map((k) => ({
        _id: String(k._id), timezone: k.timezone as string, createdAt: k._id.equals(oid(KPM_B)) ? new Date('2025-01-02T03:00:00Z') : null,
      })));
      // M01 made today: September held, August before it — nothing to ask for.
      expect(status.get(KPM_C)).toEqual({ latestMonth: '2026-09', missingMonth: null });
      // 0555, a year old: August ended and is not in its file.
      expect(status.get(KPM_B)!.missingMonth).toBe('2026-08');
    });

    it('P19.4-T3 AC-8 negative: anybody but a Super Admin outside a session is refused', async () => {
      await expect(reads.dataStatusAcrossTenants(h.office.as('OWNER'), [])).rejects.toMatchObject({ code: 'PERM_DENIED' });
      await expect(reads.dataStatusAcrossTenants(h.supporting('OWNER'), [])).rejects.toMatchObject({ code: 'PERM_DENIED' });
    });
  });

  describe('P19.4-T3 AC-15 — KPM & data', () => {
    it('P19.4-T3 AC-15 three tiles and the company’s KPMs for the latest month, with the D4 peer status', async () => {
      asSuperAdmin();
      const res = await http().get(`/admin/companies/${COMPANY}/kpms`).expect(200);
      expect(res.body).toMatchObject({ company: { id: COMPANY, name: 'Prudential' }, month: '2026-09' });
      expect(Object.keys(res.body.tiles).sort()).toEqual(['activeOwners', 'complete', 'kpms', 'members', 'needed', 'notSignedIn']);
      expect(res.body.tiles).toMatchObject({ kpms: 2, needed: 3 });
      expect(res.body.rows.map((r: { code: string }) => r.code)).toEqual(['0417', '0555']);
      const [a] = res.body.rows;
      expect(Object.keys(a).sort()).toEqual(
        ['apeYtdMinor', 'branch', 'code', 'data', 'kpmId', 'maa', 'manpower', 'peers', 'recruitmentYtd'],
      );
      for (const row of res.body.rows) {
        expect(row.peers).toEqual(row.data === 'complete'
          ? { status: 'not_enough', count: res.body.tiles.complete - 1, needed: 3 }
          : { status: 'not_counted', count: 0, needed: 3 });
      }
      // The month's headcount and MAA are the Overview's for the current month, through the same functions.
      session.current = h.office.as('OWNER');
      const overview = (await http().get('/kpm/overview').expect(200)).body;
      expect(a.manpower).toBe(overview.composition.total);
      expect(a.maa).toBe(overview.engagement.activeThisMonth.count);
    });

    it('P19.4-T3 AC-15 a KPM with its month complete and no peer: *Belum cukup KPM pembanding (0 dari 3)*', async () => {
      asSuperAdmin();
      const res = await http().get(`/admin/companies/${MANULIFE}/kpms`).expect(200);
      expect(res.body.tiles).toMatchObject({ kpms: 1, complete: 1, members: 1, needed: 3 });
      expect(res.body.rows).toEqual([{
        kpmId: KPM_C, code: 'M01', branch: 'Medan', manpower: 1, maa: expect.any(Number), apeYtdMinor: 12 * 100 * 1_000_000,
        recruitmentYtd: 2, data: 'complete', peers: { status: 'not_enough', count: 0, needed: 3 },
      }]);
    });

    it('P19.4-T3 AC-15 another month, a month that is none, the Template library or another company’s id', async () => {
      asSuperAdmin();
      const aug = await http().get(`/admin/companies/${COMPANY}/kpms`).query({ month: '2026-08' }).expect(200);
      expect(aug.body.month).toBe('2026-08');
      await http().get(`/admin/companies/${COMPANY}/kpms`).query({ month: '2026-13' }).expect(400);
      await http().get(`/admin/companies/not-an-id/kpms`).expect(404);
    });
  });

  /*
   * **The reads at their edges**, on offices added for them alone and after every case above, so none of those moves: an
   * office whose company is gone, holding two invitations whose accounts are gone and a member under the first of them; a
   * company with one KPM and nothing uploaded; a company with no KPM; and a company of four KPMs complete for September.
   */
  describe('P19.4-T3 the reads at their edges (ADR-0207 §2)', () => {
    const GONE_COMPANY = '66f0000000000000000009c1';
    const KPM_D = '66f0000000000000000009d1';
    const AXA = '66f0000000000000000009c2';
    const KPM_E = '66f0000000000000000009d2';
    const AIA = '66f0000000000000000009c3';
    const ALLIANZ = '66f0000000000000000009c4';
    const ALLIANZ_KPMS = ['66f0000000000000000009d3', '66f0000000000000000009d4', '66f0000000000000000009d5', '66f0000000000000000009d6'];
    /** Two invitations whose accounts are gone — their `userId` names nobody — the lower id first. */
    const GHOSTS = ['66f0000000000000000009e1', '66f0000000000000000009e2'];
    /** Kurnia Putra, active in D01 under the first of them. */
    const KID = '66f0000000000000000009e3';

    type ComparisonRow = {
      code: string; company: { name: string }; members: number; activeThisMonth: { pct: number | null };
      activeUsers: { pct: number | null }; coached: { d7: { pct: number | null }; d30: { pct: number | null } };
      production: { pct: number | null }; recruitment: { pipeline: number };
    };
    /** The figure each column of the comparison sorts by (ADR-0207 §7). */
    const COLUMN: Record<KpmComparisonSort, (r: ComparisonRow) => string | number | null> = {
      kpm: (r) => r.code, company: (r) => r.company.name, members: (r) => r.members,
      activeThisMonth: (r) => r.activeThisMonth.pct, activeUsers: (r) => r.activeUsers.pct,
      coached7d: (r) => r.coached.d7.pct, coached30d: (r) => r.coached.d30.pct,
      production: (r) => r.production.pct, recruitment: (r) => r.recruitment.pipeline,
    };

    const member = (id: string, kpmId: string, userId: string, over: Record<string, unknown> = {}) => ({
      _id: oid(id), kpmId, userId, agentCode: `EDGE-${id.slice(-3)}`, agentSeq: Number.parseInt(id.slice(-3), 16),
      leaderCode: `LEDGE${id.slice(-3)}`, orgLevelId: new mongoose.Types.ObjectId().toString(), orgLevelCode: 'AGENT',
      role: 'agent', leaderId: null, ancestorIds: [], depth: 0, directCounts: { total: 0 }, subtreeCount: 0,
      status: 'pending', deletedAt: null, ...over,
    });
    const batch = (month: string, over: Record<string, unknown>) => ({
      kpmId: KPM_D, month, status: 'committed', filename: `${month}.csv`, fileSha256: 'x', encoding: 'utf-8', delimiter: ',',
      basedOnRevision: 0, monthRevision: 1, rowCount: 2, writtenRowCount: 2, cellCount: 4, issueCount: 0,
      startedAt: new Date(`${month}-03T02:00:00Z`), asOf: null, deletedAt: null, ...over,
    });
    const createKpm = (doc: Record<string, unknown>) =>
      (h.wired.kpms as unknown as { create: (d: unknown) => Promise<unknown> }).create(doc);

    beforeAll(async () => {
      await db().collection('companies').insertMany([
        { _id: oid(AXA), name: 'AXA', slug: 'axa-platform-reads', deletedAt: null },
        { _id: oid(AIA), name: 'AIA', slug: 'aia-platform-reads', deletedAt: null },
        { _id: oid(ALLIANZ), name: 'Allianz', slug: 'allianz-platform-reads', deletedAt: null },
      ]);
      await createKpm({ _id: KPM_D, companyId: GONE_COMPANY, code: 'D01', branchName: 'Gone', timezone: 'Asia/Jakarta' });
      await createKpm({ _id: KPM_E, companyId: AXA, code: 'X01', branchName: 'Bandung', timezone: 'Asia/Jakarta' });
      for (const [i, kpmId] of ALLIANZ_KPMS.entries()) {
        await createKpm({ _id: kpmId, companyId: ALLIANZ, code: `Z0${i + 1}`, branchName: `Z${i + 1}`, timezone: 'Asia/Jakarta' });
      }
      // Each Allianz KPM's September in its file: all four complete for the month.
      await db().collection('monthlyAgentData').insertMany(ALLIANZ_KPMS.map((kpmId, i) => ({
        kpmId, membershipId: new mongoose.Types.ObjectId().toString(), month: '2026-09', agentCode: `Z-${i}`, deletedAt: null,
        values: { APE: { value: (i + 1) * 100 * 1_000_000, provenance: 'imported', sourceBatchId: null } },
      })));

      const kurnia = new mongoose.Types.ObjectId();
      await db().collection('users').insertOne({
        _id: kurnia, email: 'kurnia@platform-reads.test', passwordHash: 'x', fullName: 'Kurnia Putra', status: 'active', deletedAt: null,
      });
      // The second ghost first, so the order below is the read's and not the insert's.
      await db().collection('memberships').insertMany([
        member(GHOSTS[1], KPM_D, new mongoose.Types.ObjectId().toString()),
        member(GHOSTS[0], KPM_D, new mongoose.Types.ObjectId().toString()),
        member(KID, KPM_D, String(kurnia), {
          status: 'active', leaderId: GHOSTS[0], joinDate: '2026-03-02', joinedAt: new Date('2026-03-02T03:00:00Z'),
        }),
      ]);
      // D01's uploads: one whose committer names nobody, and one with neither its committer nor its time recorded.
      await db().collection('dataUploadBatches').insertMany([
        batch('2026-09', {
          status: 'reverting', committedAt: new Date('2026-09-03T03:00:00Z'), committedBy: new mongoose.Types.ObjectId().toString(),
          asOf: '2026-09-02',
        }),
        batch('2026-08', { status: 'reverted', committedAt: null, committedBy: null, writtenRowCount: 0 }),
      ]);
    });

    it('P19.4-T3 AC-16 the service is the second wall: called directly, an Owner or a view-as session is refused', async () => {
      for (const ctx of [h.office.as('OWNER'), h.supporting('OWNER')]) {
        await expect(reads.members(ctx, {})).rejects.toMatchObject({ code: 'PERM_DENIED' });
        await expect(reads.kpmComparisonAcrossTenants(ctx, {})).rejects.toMatchObject({ code: 'PERM_DENIED' });
        await expect(reads.kpmData(ctx, KPM_A)).rejects.toMatchObject({ code: 'PERM_DENIED' });
        await expect(reads.companyKpmsAcrossTenants(ctx, COMPANY)).rejects.toMatchObject({ code: 'PERM_DENIED' });
      }
    });

    it('P19.4-T3 AC-1 members whose accounts are gone are listed nameless, first and by id; no join day, no leader’s name, no company name', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/members').query({ kpmId: KPM_D }).expect(200);
      const ghost = (id: string) => ({
        membershipId: id, fullName: '', agentCode: `EDGE-${id.slice(-3)}`, company: { id: GONE_COMPANY, name: '' },
        kpm: { id: KPM_D, code: 'D01', branch: 'Gone' }, role: { code: 'AGENT', label: 'AGENT', isOwner: false, isAdmin: false },
        leader: null, status: 'pending', invitation: 'not_invited', joinedOn: null, lastActiveOn: null,
      });
      expect(res.body.rows).toEqual([
        ghost(GHOSTS[0]),
        ghost(GHOSTS[1]),
        // Under a leader whose account is gone: a leader, but no name to give, so none.
        { ...ghost(KID), fullName: 'Kurnia Putra', status: 'active', joinedOn: '2026-03-02' },
      ]);
    });

    it('P19.4-T3 AC-1 a member under nobody has no leader', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/members').query({ q: 'Oscar Yatim' }).expect(200);
      expect(res.body.rows).toEqual([
        expect.objectContaining({ fullName: 'Oscar Yatim', kpm: { id: KPM_A, code: '0417', branch: 'A' }, leader: null }),
      ]);
    });

    it('P19.4-T3 AC-1 a malformed KPM id that reaches the service finds nobody — never a cast error', async () => {
      expect(await reads.members(SUPER_ADMIN, { kpmId: 'not-an-id' })).toEqual({
        rows: [], page: 1, pageSize: PLATFORM_READ.PAGE_SIZE, total: 0,
      });
    });

    it('P19.4-T3 AC-1 one role at a time: two is refused by name', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/members?role=ab&role=agent').expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P19.4-T3 AC-3 a KPM whose company is gone is compared with no company name, never dropped', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/analytics/kpms').expect(200);
      expect(res.body.rows.find((r: { kpmId: string }) => r.kpmId === KPM_D))
        .toMatchObject({ code: 'D01', company: { id: GONE_COMPANY, name: '' } });
    });

    it('P19.4-T3 AC-3 ADR-0207 §7 every column sorts both ways — by its figure, a KPM with none last either way, a tie by code', async () => {
      asSuperAdmin();
      const violations: string[] = [];
      let figureThenNone = 0;
      let noneThenNone = 0;
      for (const key of KPM_COMPARISON_SORTS) {
        for (const descending of [false, true]) {
          const sort = `${descending ? '-' : ''}${key}`;
          const res = await http().get('/admin/analytics/kpms').query({ sort }).expect(200);
          expect([sort, res.body.sort, res.body.rows.length]).toEqual([sort, sort, res.body.total]);
          const rows = res.body.rows as ComparisonRow[];
          for (let i = 1; i < rows.length; i += 1) {
            const [a, b] = [rows[i - 1], rows[i]];
            const [x, y] = [COLUMN[key](a), COLUMN[key](b)];
            const byCode = a.code.localeCompare(b.code) < 0;
            let ok: boolean;
            if (x === null && y === null) {
              noneThenNone += 1;
              ok = byCode;
            } else if (x === null) {
              ok = false;
            } else if (y === null) {
              figureThenNone += 1;
              ok = true;
            } else {
              const order = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number);
              ok = order === 0 ? byCode : descending ? order > 0 : order < 0;
            }
            if (!ok) violations.push(`${sort}: ${a.code} (${x}) before ${b.code} (${y})`);
          }
        }
      }
      expect(violations).toEqual([]);
      // The cases the rule is about were met: a KPM with no figure after one with, and two with none.
      expect(figureThenNone).toBeGreaterThan(0);
      expect(noneThenNone).toBeGreaterThan(0);
    });

    it('P19.4-T3 AC-9 an upload whose committer names nobody reads by nobody; one with no time recorded has none', async () => {
      asSuperAdmin();
      const res = await http().get(`/admin/tenants/${KPM_D}/data`).expect(200);
      expect(res.body.uploads).toEqual([
        { month: '2026-09', by: null, at: '2026-09-03T03:00:00.000Z', agents: 2, note: { status: 'reverting', asOf: '2026-09-02' } },
        { month: '2026-08', by: null, at: null, agents: 0, note: { status: 'reverted', asOf: null } },
      ]);
    });

    it('P19.4-T3 AC-15 (D4) four KPMs complete for the month: each has three peers, enough', async () => {
      asSuperAdmin();
      const res = await http().get(`/admin/companies/${ALLIANZ}/kpms`).expect(200);
      expect(res.body).toMatchObject({ company: { id: ALLIANZ, name: 'Allianz' }, month: '2026-09' });
      expect(res.body.tiles).toMatchObject({ kpms: 4, complete: 4, needed: 3 });
      expect(res.body.rows.map((r: { code: string; data: string; peers: unknown }) => [r.code, r.data, r.peers])).toEqual(
        ['Z01', 'Z02', 'Z03', 'Z04'].map((code) => [code, 'complete', { status: 'enough', count: 3, needed: 3 }]),
      );
    });

    it('P19.4-T3 AC-15 with nothing uploaded the month is the KPM’s current one; with no KPM at all, today’s', async () => {
      asSuperAdmin();
      const axa = await http().get(`/admin/companies/${AXA}/kpms`).expect(200);
      expect(axa.body).toMatchObject({ month: '2026-09', tiles: { kpms: 1, complete: 0, members: 0 } });
      expect(axa.body.rows).toEqual([expect.objectContaining({
        kpmId: KPM_E, code: 'X01', data: 'missing', apeYtdMinor: null, recruitmentYtd: null,
        peers: { status: 'not_counted', count: 0, needed: 3 },
      })]);
      const aia = await http().get(`/admin/companies/${AIA}/kpms`).expect(200);
      expect(aia.body).toEqual({
        company: { id: AIA, name: 'AIA' }, month: '2026-09',
        tiles: { kpms: 0, activeOwners: 0, members: 0, notSignedIn: 0, complete: 0, needed: 3 }, rows: [],
      });
    });
  });
});
