import 'reflect-metadata';
import { INestApplication, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import { lastValueFrom, of, throwError } from 'rxjs';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { SOURCE_READER } from '@/common/i18n/reader';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { ActivationController } from '@/modules/activation/activation.controller';
import { TenantConfigController } from '@/modules/config/config.controller';
import { KpmProductController } from '@/modules/products/kpm-product.controller';
import { TEMPLATE_HEADER_V1 } from '@/modules/production/production-template';
import { byKode } from '@/modules/production/upload-columns';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import { declaredPermissions, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { KpmSetupController } from './kpm-setup.controller';
import { KpmSetup, SETUP_STEPS } from './kpm-setup.service';
import { KpmOverviewController } from './reporting.controller';
import { KpmOverviewService } from './kpm-overview.service';
import { KpmAnalyticsService } from './kpm-analytics.service';
import { PlatformAnalyticsService } from './platform-analytics.service';
import { SETUP_STEP_SAVED, touchesActivityTypes, type SetupStepSaved } from './setup-step-saved';
import { SetupStepSavedInterceptor } from './setup-step-saved.interceptor';

const M = 1_000_000 * 100;
const COMPANY = '66f0000000000000000000d1';
/** KaiZen Family: made on 1 November, its Owner alone, nothing uploaded, no target (Overview case 1; UI-149). */
const KAIZEN = '66f0000000000000000000d2';
/** 0417: running since 2025, September uploaded, October missed and still open until 7 November (Overview case 8). */
const RUNNING = '66f0000000000000000000d3';
/** Another office, for the cross-tenant tests. */
const OTHER = '66f0000000000000000000d4';
/** 3 November 2026, 10:00 in Jakarta. */
const NOW = new Date('2026-11-03T03:00:00Z');
/** The twelve value columns of a version 1 file, keyed `metric.cadence` as these specs name them (P19.5-T2). */
const VALUE_COLUMNS = (['monthly', 'ytd'] as const).flatMap((cadence) =>
  (['ape', 'persistency', 'recruitment', 'newActiveAgents', 'fyp', 'policyCount'] as const).map((metric) => ({ metric, cadence })));

/**
 * **The KPM Overview's setup card, what waits on the settings pages, and the months still open** (P19.3-T2; UI-148,
 * UI-149, UI-150 and their Appendix D rows; Overview R1b, R2, R3; the Overview flow report's cases 0b, 1 to 4 and 8).
 * The services are the real ones over `test/config-module.ts`; the reviewed flag's route runs over HTTP with the real
 * `PermissionsGuard` and the production pipe.
 */
describe('P19.3-T2 the KPM setup card and the months still open', () => {
  let wired: ReturnType<typeof configModule>;
  let app: INestApplication;
  const db = () => mongoose.connection.db!;
  const http = () => request(app.getHttpServer());
  const ids: Record<string, { membershipId: string; userId: string }> = {};
  let seq = 0;

  /** A person in an office: their account, and a membership on a rung. */
  const place = async (kpmId: string, who: string, over: {
    role?: 'ab' | 'aab' | 'agent'; leader?: string | null; owner?: boolean; admin?: boolean; phone?: string;
  } = {}) => {
    seq += 1;
    const userId = new mongoose.Types.ObjectId();
    const membershipId = new mongoose.Types.ObjectId();
    const role = over.role ?? 'ab';
    const leader = over.leader ? ids[over.leader].membershipId : null;
    await db().collection('users').insertOne({
      _id: userId, email: `${who.toLowerCase()}@setup.test`, passwordHash: 'x', fullName: who, status: 'active',
      platformRole: 'none', phone: over.phone ?? null, deletedAt: null,
    });
    await db().collection('memberships').insertOne({
      _id: membershipId, kpmId, userId: String(userId), agentCode: `S${String(seq).padStart(7, '0')}`, agentSeq: seq,
      leaderCode: `LS${String(seq).padStart(6, '0')}`, orgLevelId: 'x', orgLevelCode: role.toUpperCase(), role,
      leaderId: leader, ancestorIds: leader ? [leader] : [], depth: leader ? 1 : 0, status: 'active',
      joinedAt: new Date('2026-11-01T03:00:00Z'), deletedAt: null,
    });
    if (over.owner) await db().collection('kpms').updateOne({ _id: new mongoose.Types.ObjectId(kpmId) }, { $set: { ownerUserId: String(userId) } });
    ids[who] = { membershipId: String(membershipId), userId: String(userId) };
    return ids[who];
  };
  /** A context as the guard would build it for `who`, in `kpmId`. */
  const as = (kpmId: string, who: string, over: { role?: string; owner?: boolean; admin?: boolean } = {}) =>
    new RequestContext(ids[who].userId, 'none', {
      membershipId: ids[who].membershipId, kpmId, orgLevelCode: (over.role ?? 'ab').toUpperCase(), hierarchyRole: over.role ?? 'ab',
      status: 'active', isKpmOwner: over.owner === true, isKpmAdmin: over.admin === true, directCount: 0,
    } as never).withReader(SOURCE_READER);
  const kaizenOwner = () => as(KAIZEN, 'VICTOR', { owner: true });
  const runningOwner = () => as(RUNNING, 'WILSON', { owner: true });
  const otherOwner = () => as(OTHER, 'OLGA', { owner: true });
  const overviewOf = (ctx: RequestContext) => wired.kpmOverview.read(ctx);
  const put = (page: string) => http().put(`/kpm/settings/${page}/reviewed`);

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await clearCollections();
    await db().collection('companies').insertOne({ _id: new mongoose.Types.ObjectId(COMPANY), name: 'Prudential', slug: 'setup', deletedAt: null });
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KAIZEN, companyId: COMPANY, code: '00001', branchName: 'KaiZen Family', timezone: 'Asia/Jakarta' },
      { _id: RUNNING, companyId: COMPANY, code: '0417', branchName: 'BSD City Branch', timezone: 'Asia/Jakarta', address: 'Jl. BSD', contactPhone: '021' },
      { _id: OTHER, companyId: COMPANY, code: '0555', branchName: 'Other', timezone: 'Asia/Jakarta' },
    ]);
    // When each began (UI-150: the KPM's creation month, *"exists on the KPM"*).
    const began = { [KAIZEN]: '2026-11-01T02:00:00Z', [RUNNING]: '2025-03-01T02:00:00Z', [OTHER]: '2026-11-01T02:00:00Z' };
    for (const [kpmId, at] of Object.entries(began)) {
      await db().collection('kpms').updateOne({ _id: new mongoose.Types.ObjectId(kpmId) }, { $set: { createdAt: new Date(at) } });
    }
    await wired.orgLevels.seedDefaultLadder(COMPANY);
    for (const kpmId of [KAIZEN, RUNNING, OTHER]) await provisionOffice(wired, kpmId, COMPANY);

    await place(KAIZEN, 'VICTOR', { owner: true });
    await place(OTHER, 'OLGA', { owner: true });
    await place(RUNNING, 'WILSON', { owner: true });
    await place(RUNNING, 'AGUS', { leader: 'WILSON' });
    await place(RUNNING, 'SARI', { role: 'aab', leader: 'AGUS' });
    await place(RUNNING, 'INDAH', { role: 'agent', leader: 'SARI', phone: '+6281211112222' });
    await place(RUNNING, 'ADMIN', { role: 'agent', leader: 'WILSON', admin: true });

    // 0417's file: September uploaded for Agus and Indah; October not (Overview case 8).
    await db().collection('monthlyAgentData').insertMany(['AGUS', 'INDAH'].map((who) => ({
      kpmId: RUNNING, membershipId: ids[who].membershipId, month: '2026-09', agentCode: who, deletedAt: null,
      ...byKode({ apeMonthly: { value: 20 * M, provenance: 'imported' }, apeYtd: { value: 300 * M, provenance: 'imported' } }),
    })));
    await db().collection('dataUploadBatches').insertOne({
      kpmId: RUNNING, month: '2026-09', status: 'committed', deletedAt: null, startedAt: NOW, committedAt: NOW,
    });
    await db().collection('kpmRecruitTargets').insertOne({ kpmId: RUNNING, month: '2026-09', target: 15, deletedAt: null });
    // What waits for 0417's Owner (UI-148, Appendix D): two products' scripts, and a checklist draft of version 2.
    await db().collection('kpmProductConfigs').insertMany(['p-1', 'p-2', 'p-3'].map((productId, i) => ({
      kpmId: RUNNING, productId, reviewState: i < 2 ? 'pending' : 'approved', deletedAt: null,
    })));
    await db().collection('activationTemplates').insertOne({
      kpmId: RUNNING, version: 2, status: 'draft', publishedAt: null, aspects: [], deletedAt: null,
    });
    // 0417 was running before the card: its four pages already marked, as `0052-kpm-setup-running-offices` marks them.
    for (const page of ['branch-info', 'activity-types', 'activation-checklist', 'products'] as const) {
      await wired.setupMarks.setOnce(runningOwner(), page, 'migration', NOW);
    }

    const moduleRef = await Test.createTestingModule({
      controllers: [KpmSetupController, KpmOverviewController],
      providers: [
        { provide: KpmSetup, useValue: wired.kpmSetup },
        { provide: KpmOverviewService, useValue: wired.kpmOverview },
        { provide: KpmAnalyticsService, useValue: {} },
        { provide: PlatformAnalyticsService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  it('declares its permission: tenant_config:mark_reviewed', () => {
    expect(declaredPermissions(KpmSetupController)).toEqual({ markReviewed: 'tenant_config:mark_reviewed' });
  });

  describe('a brand-new KPM (Overview case 1; UI-149, UI-150)', () => {
    it('P19.3-T2 AC-4 Overview case 1: KaiZen reads Siapkan KPM 0 dari 7 — the four settings first, then import, upload, target', async () => {
      const view = await overviewOf(kaizenOwner());
      expect(view.setup).toEqual({
        done: 0,
        steps: SETUP_STEPS.map((key) => ({ key, done: false })),
        branchFilled: false,
        members: 1,
        // Step 6: Nov 2026, *"Terbuka sampai 7 Des 2026"*.
        openMonth: { month: '2026-11', closesOn: '2026-12-07' },
        target: null,
      });
      expect(SETUP_STEPS).toEqual([
        'branch-info', 'activity-types', 'activation-checklist', 'products', 'import', 'upload', 'recruit-target',
      ]);
    });

    it('P19.3-T2 AC-7 UI-150: KaiZen names only Nov 2026 — January to October appear nowhere, and "this year" starts in November', async () => {
      const view = await overviewOf(kaizenOwner());
      expect(view.production.ytd).toMatchObject({ achievedMinor: null, missingMonths: ['2026-11'], from: '2026-11' });
      expect(JSON.stringify(view.production)).not.toMatch(/2026-(0\d|10)/);
    });

    it('P19.3-T2 AC-6 Overview case 1: nobody to rank — the Owner leads nobody and no unit has a target', async () => {
      const view = await overviewOf(kaizenOwner());
      expect(view.coaching.leaderboard.every((row) => !row.leads)).toBe(true);
      expect(view.production.agencies.every((a) => a.targetMinor === null)).toBe(true);
    });
  });

  describe('Sudah sesuai over HTTP (AC-5, AC-10)', () => {
    it('P19.3-T2 AC-5 Overview case 0b: Sudah sesuai on the activation checklist ticks step 3, checklist unchanged, 1 dari 7', async () => {
      const before = await wired.activation.read(kaizenOwner());
      session.current = kaizenOwner();
      const res = await put('activation-checklist').expect(200);
      expect(res.body).toMatchObject({ page: 'activation-checklist', reviewed: true, via: 'reviewed' });
      // The tap leaves the page's data as it is: the same published version, no draft made.
      const after = await wired.activation.read(kaizenOwner());
      expect(after.published?.version).toBe(before.published?.version);
      expect(after.draft).toEqual(before.draft);
      const view = await overviewOf(kaizenOwner());
      expect(view.setup).toMatchObject({ done: 1 });
      expect(view.setup!.steps.find((s) => s.key === 'activation-checklist')).toEqual({ key: 'activation-checklist', done: true });
    });

    it('P19.3-T2 AC-5 the first tap is audited once; a second answers as it stands and writes nothing', async () => {
      session.current = kaizenOwner();
      const audited = () => db().collection('auditLog').countDocuments({ action: 'kpm_setup.page_reviewed', kpmId: KAIZEN });
      const count = await audited();
      const first = (await put('activation-checklist').expect(200)).body;
      expect(await audited()).toBe(count);
      expect(await db().collection('kpmSetupMarks').countDocuments({ kpmId: KAIZEN, mark: 'activation-checklist' })).toBe(1);
      expect(first.via).toBe('reviewed');
      const entry = await db().collection('auditLog').findOne({ action: 'kpm_setup.page_reviewed', kpmId: KAIZEN });
      expect(entry).toMatchObject({ targetCollection: 'kpmSetupMarks', after: { page: 'activation-checklist', via: 'reviewed' } });
    });

    it('P19.3-T2 AC-10 positive: the Admin marks a page of their own office', async () => {
      session.current = as(RUNNING, 'ADMIN', { role: 'agent', admin: true });
      expect((await put('products').expect(200)).body).toMatchObject({ page: 'products', reviewed: true, via: 'migration' });
    });

    it.each([
      ['an AB', { role: 'ab' }],
      ['an AAB', { role: 'aab' }],
      ['an Agent', { role: 'agent' }],
    ] as const)('P19.3-T2 AC-10 negative: %s is refused 403', async (_who, over) => {
      session.current = as(RUNNING, over.role === 'aab' ? 'SARI' : over.role === 'agent' ? 'INDAH' : 'AGUS', over);
      const res = await put('branch-info').expect(403);
      expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'tenant_config:mark_reviewed' } });
    });

    it('P19.3-T2 AC-10 negative: a Super Admin outside a session is refused 403', async () => {
      session.current = SUPER_ADMIN;
      expect((await put('branch-info').expect(403)).body.error.code).toBe('PERM_DENIED');
    });

    it.each([['a read-only', true], ['an elevated', false]] as const)(
      'P19.3-T2 AC-10 negative: %s support session as the Owner is refused 403, and nothing is marked',
      async (_kind, readOnly) => {
        const owner = kaizenOwner();
        session.current = new RequestContext(owner.userId, 'none', owner.membership, 'u-support', null, false, readOnly);
        expect((await put('branch-info').expect(403)).body.error.code).toBe('PERM_DENIED');
        expect(await db().collection('kpmSetupMarks').countDocuments({ kpmId: KAIZEN, mark: 'branch-info' })).toBe(0);
      },
    );

    it('P19.3-T2 AC-10 a page that is not one of the four is 404, and marks nothing', async () => {
      session.current = kaizenOwner();
      for (const page of ['lead-statuses', 'training', 'setup-complete', 'nothing']) {
        expect((await put(page).expect(404)).body.error.code).toBe('NOT_FOUND');
      }
      expect(await db().collection('kpmSetupMarks').countDocuments({ kpmId: KAIZEN, mark: 'setup-complete' })).toBe(0);
    });

    it('P19.3-T2 AC-10 cross-tenant: KPM B’s Owner marks KPM B’s page only — KaiZen’s card is as it was', async () => {
      const before = (await overviewOf(kaizenOwner())).setup;
      session.current = otherOwner();
      await put('branch-info').expect(200);
      expect(await db().collection('kpmSetupMarks').countDocuments({ kpmId: OTHER, mark: 'branch-info' })).toBe(1);
      expect(await db().collection('kpmSetupMarks').countDocuments({ kpmId: KAIZEN, mark: 'branch-info' })).toBe(0);
      expect((await overviewOf(kaizenOwner())).setup).toEqual(before);
      // And through the repository: KaiZen's marks hold none of KPM B's.
      expect([...(await wired.setupMarks.marksOf(kaizenOwner())).keys()]).toEqual(['activation-checklist']);
    });

    it('P19.3-T2 AC-5 a mark whose write fails for any reason but a race is not retried: the tap fails, and nothing is marked', async () => {
      session.current = otherOwner();
      const model = (wired.setupMarks as unknown as { model: mongoose.Model<unknown> }).model;
      const spy = jest.spyOn(model, 'findOneAndUpdate')
        .mockImplementationOnce((() => ({ exec: async () => { throw new Error('the database is gone'); } })) as never);
      try {
        await put('products').expect(500);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
      expect(await db().collection('kpmSetupMarks').countDocuments({ kpmId: OTHER, mark: 'products' })).toBe(0);
    });
  });

  describe('steps 5 to 7 are derived, and seven done is for good (Overview cases 2 to 4)', () => {
    /** Nov 2026's file holding the new agent's figures, imported as the Owner would (Overview case 3). */
    const importNovember = async (who: string) => {
      const agentCode = (await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(ids[who].membershipId) }))!.agentCode;
      const cells: Record<string, string> = { 'ape.monthly': '12', 'ape.ytd': '12', 'policyCount.monthly': '1', 'policyCount.ytd': '1' };
      const buffer = Buffer.from([
        TEMPLATE_HEADER_V1.join(','),
        [agentCode, `"${who}"`, ...VALUE_COLUMNS.map((c) => cells[`${c.metric}.${c.cadence}`] ?? '')].join(','),
      ].join('\n'));
      const file = { buffer, originalname: 'november.csv', size: buffer.length };
      const preview = await wired.production.preview(kaizenOwner(), '2026-11', file as never);
      await wired.productionImport.commit(kaizenOwner(), '2026-11', String(preview.revision), file as never);
    };

    it('P19.3-T2 AC-5 Overview case 2: a member besides the Owner ticks step 5; Total members reads 2', async () => {
      await place(KAIZEN, 'BUDI', { role: 'agent', leader: 'VICTOR' });
      const view = await overviewOf(kaizenOwner());
      expect(view.setup!.steps.find((s) => s.key === 'import')!.done).toBe(true);
      expect(view.setup!.members).toBe(2);
      expect(view.composition.total).toBe(2);
    });

    it('P19.3-T2 AC-5 AC-7 Overview case 3: uploading Nov ticks step 6, production shows Nov, and no month is missing', async () => {
      await importNovember('BUDI');
      const view = await overviewOf(kaizenOwner());
      expect(view.setup!.steps.find((s) => s.key === 'upload')!.done).toBe(true);
      expect(view.production.ytd).toMatchObject({ achievedMinor: 12 * M, missingMonths: [] });
    });

    it('P19.3-T2 AC-5 a recruitment target ticks step 7', async () => {
      await wired.kpmOverview.setRecruitTarget(kaizenOwner(), { month: '2026-11', target: 3 });
      const view = await overviewOf(kaizenOwner());
      expect(view.setup).toMatchObject({ target: 3 });
      expect(view.setup!.steps.find((s) => s.key === 'recruit-target')!.done).toBe(true);
    });

    it('P19.3-T2 AC-5 Overview case 4: all seven done — no card, stored once — and it never comes back', async () => {
      for (const page of ['branch-info', 'activity-types', 'products']) {
        await wired.kpmSetup.markReviewed(kaizenOwner(), page);
      }
      expect((await overviewOf(kaizenOwner())).setup).toBeNull();
      const done = await db().collection('kpmSetupMarks').findOne({ kpmId: KAIZEN, mark: 'setup-complete' });
      expect(done).toMatchObject({ via: 'derived' });
      // Budi leaves: step 5 would be open again, and the card stays gone.
      await db().collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(ids.BUDI.membershipId) }, { $set: { status: 'removed', removedAt: NOW } });
      expect((await overviewOf(kaizenOwner())).setup).toBeNull();
      expect(await db().collection('kpmSetupMarks').countDocuments({ kpmId: KAIZEN, mark: 'setup-complete' })).toBe(1);
    });
  });

  describe('a running KPM (UI-148, UI-150; Overview cases 4 and 8)', () => {
    it('P19.3-T2 AC-4 UI-149: 0417 — members, an upload, a target — shows no card', async () => {
      expect((await overviewOf(runningOwner())).setup).toBeNull();
    });

    it('P19.3-T2 AC-3 Pengaturan KPM: what waits — 2 products awaiting the Owner and the checklist’s draft version 2', async () => {
      expect((await overviewOf(runningOwner())).settings).toEqual({ productsAwaiting: 2, checklistDraftVersion: 2 });
      // KaiZen: nothing waits.
      expect((await overviewOf(kaizenOwner())).settings).toEqual({ productsAwaiting: 0, checklistDraftVersion: null });
    });

    it('P19.3-T2 AC-7 Overview case 8: on 3 Nov, October — missed, open until 7 Nov — and November are named; "this year" from January', async () => {
      const { ytd } = (await overviewOf(runningOwner())).production;
      expect(ytd).toMatchObject({ missingMonths: ['2026-10', '2026-11'], from: '2026-01' });
    });

    it('P19.3-T2 AC-7 a month locked by hand is not named: only months still open for upload', async () => {
      await wired.productionMonths.lock(runningOwner(), '2026-10');
      try {
        expect((await overviewOf(runningOwner())).production.ytd.missingMonths).toEqual(['2026-11']);
      } finally {
        await db().collection('productionMonths').deleteMany({ kpmId: RUNNING, month: '2026-10' });
      }
    });

    /*
     * *Changed 2026-11-06 (P19.5-T3; ADR-0214 §11, amending ADR-0050):* this read *"once 7 November has passed, October
     * closes and only November is named"*. A month of the required history that was never written stays open past its
     * schedule until its first upload — as Data upload keeps it — so the Overview names it still.
     */
    it('P19.5-T3 ADR-0214 §11 once 7 November has passed, a never-written October stays named, as Data upload keeps it open', async () => {
      (wired.clock as FixedClock).set(new Date('2026-11-08T03:00:00Z'));
      try {
        const { missingMonths } = (await overviewOf(runningOwner())).production.ytd;
        expect(missingMonths).toEqual(['2026-10', '2026-11']);
        expect((await wired.productionMonths.state(runningOwner(), '2026-10')).reason).toBe('history');
      } finally {
        (wired.clock as FixedClock).set(NOW);
      }
    });

    it('P19.5-T3 ADR-0214 §11 a month first written after its schedule closes its grace days after that write', async () => {
      await db().collection('productionMonths').insertOne({
        kpmId: RUNNING, month: '2026-10', revision: 1, firstWrittenOn: '2026-11-10', lockOverride: null, deletedAt: null,
      });
      try {
        // October's schedule closed on 7 November; its first write, on the 10th, opened it until the 17th.
        (wired.clock as FixedClock).set(new Date('2026-11-15T03:00:00Z'));
        expect((await overviewOf(runningOwner())).production.ytd.missingMonths).toContain('2026-10');
        (wired.clock as FixedClock).set(new Date('2026-11-20T03:00:00Z'));
        expect((await overviewOf(runningOwner())).production.ytd.missingMonths).not.toContain('2026-10');
      } finally {
        (wired.clock as FixedClock).set(NOW);
        await db().collection('productionMonths').deleteMany({ kpmId: RUNNING, month: '2026-10' });
      }
    });

    it('P19.3-T2 AC-8 UI-157: an agent’s own estimate never reaches the Overview’s production', async () => {
      const before = (await overviewOf(runningOwner())).production;
      const indah = as(RUNNING, 'INDAH', { role: 'agent' });
      await wired.goals.save(indah, {
        period: '2026', mode: 'direct', annualApeTargetMinor: 500 * M, savingsTargetMinor: 50 * M, commissionRatePct: 10,
        monthsLeft: null, apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30, closingRatePct: 30,
      } as never);
      const withGoal = (await overviewOf(runningOwner())).production;
      await wired.goals.saveEstimate(indah, '2026', { apeAchievedMinor: 120 * M });
      expect((await overviewOf(runningOwner())).production).toEqual(withGoal);
      expect(withGoal.ytd.achievedMinor).toBe(before.ytd.achievedMinor);
    });

    it('P19.3-T2 AC-9 OWN R3: the Overview serves no month-to-date logging figure, so nothing is set against a whole last month', async () => {
      const view = await overviewOf(runningOwner());
      expect(view.engagement).not.toHaveProperty('loggedThisMonth');
      expect(JSON.stringify(view)).not.toContain('lastMonthToDate');
    });

    it('P19.3-T2 AC-2 Overview case 5: the not-logged rows carry the role, the leader and the WhatsApp number', async () => {
      const list = await wired.kpmOverview.notLogged(runningOwner());
      const indah = list.members.find((m) => m.membershipId === ids.INDAH.membershipId)!;
      expect(indah).toMatchObject({ rung: { code: 'AGENT' }, leader: { membershipId: ids.SARI.membershipId, name: 'SARI' }, phone: '+6281211112222' });
      const wilson = list.members.find((m) => m.membershipId === ids.WILSON.membershipId)!;
      expect(wilson).toMatchObject({ leader: null, phone: null });
    });
  });

  describe('saving one of the four pages sets its flag too (AC-5; `@SavesSetupStep`)', () => {
    const savedOf = (controller: { prototype: object }, method: string) =>
      new Reflector().get<SetupStepSaved | undefined>(SETUP_STEP_SAVED, (controller.prototype as Record<string, () => unknown>)[method]);

    it('P19.3-T2 AC-5 every save route of the four pages declares its page; a read and another page’s route do not', () => {
      expect(savedOf(TenantConfigController, 'updateBranchInfo')?.page).toBe('branch-info');
      for (const method of ['createType', 'updateType', 'archiveType', 'restoreType', 'reorderTypes', 'createCategory', 'createRatio', 'updateRatio']) {
        expect([method, savedOf(TenantConfigController, method)?.page]).toEqual([method, 'activity-types']);
      }
      expect(savedOf(TenantConfigController, 'applyChanges')?.when).toBe(touchesActivityTypes);
      expect(savedOf(ActivationController, 'saveDraft')?.page).toBe('activation-checklist');
      expect(savedOf(ActivationController, 'publish')?.page).toBe('activation-checklist');
      for (const method of ['setActive', 'saveOverrides', 'resetOverride', 'setDocument', 'resetDocument']) {
        expect([method, savedOf(KpmProductController, method)?.page]).toEqual([method, 'products']);
      }
      // Asking for an upload link saves nothing: the document's own `PUT` does.
      expect(savedOf(KpmProductController, 'requestUpload')).toBeUndefined();
      expect(savedOf(TenantConfigController, 'readBranchInfo')).toBeUndefined();
      expect(savedOf(TenantConfigController, 'createLeadStatus')).toBeUndefined();
      expect(savedOf(ActivationController, 'read')).toBeUndefined();
    });

    it('P19.3-T2 AC-5 a staged batch saves Activity types when it holds an activity or ratio row, and not for training alone', () => {
      expect(touchesActivityTypes({ ops: [{ op: 'type.update' }] })).toBe(true);
      expect(touchesActivityTypes({ ops: [{ op: 'trainingModule.create' }, { op: 'ratio.archive' }] })).toBe(true);
      expect(touchesActivityTypes({ ops: [{ op: 'trainingSkill.update' }] })).toBe(false);
      expect(touchesActivityTypes({})).toBe(false);
      expect(touchesActivityTypes(null)).toBe(false);
    });

    /** What the interceptor sees: a handler carrying `saved`, a request with `ctx` and `body`. */
    const context = (saved: SetupStepSaved | undefined, ctx: RequestContext | undefined, body: unknown = {}) => {
      const handler = () => undefined;
      if (saved) Reflect.defineMetadata(SETUP_STEP_SAVED, saved, handler);
      return {
        getHandler: () => handler,
        switchToHttp: () => ({ getRequest: () => ({ context: ctx, body }) }),
      } as unknown as ExecutionContext;
    };
    const run = (interceptor: SetupStepSavedInterceptor, ctx: ExecutionContext, next: CallHandler) =>
      lastValueFrom(interceptor.intercept(ctx, next));

    it('P19.3-T2 AC-5 a successful save marks its page as saved, and answers the handler’s answer', async () => {
      const interceptor = new SetupStepSavedInterceptor(new Reflector(), wired.kpmSetup);
      const answer = await run(interceptor, context({ page: 'branch-info' }, otherOwner()), { handle: () => of({ saved: true }) });
      expect(answer).toEqual({ saved: true });
      // KPM B's branch info was marked reviewed above: the first mark stands.
      expect(await db().collection('kpmSetupMarks').findOne({ kpmId: OTHER, mark: 'branch-info' })).toMatchObject({ via: 'reviewed' });
      await run(interceptor, context({ page: 'products' }, otherOwner()), { handle: () => of({}) });
      expect(await db().collection('kpmSetupMarks').findOne({ kpmId: OTHER, mark: 'products' })).toMatchObject({ via: 'saved' });
      // A save writes no audit entry of its own: the save's is the record.
      expect(await db().collection('auditLog').countDocuments({ action: 'kpm_setup.page_reviewed', kpmId: OTHER })).toBe(1);
    });

    it('P19.3-T2 AC-5 a refused save marks nothing; a route that saves no setup page is passed straight through', async () => {
      const interceptor = new SetupStepSavedInterceptor(new Reflector(), wired.kpmSetup);
      await expect(run(interceptor, context({ page: 'activity-types' }, otherOwner()), { handle: () => throwError(() => new Error('refused')) }))
        .rejects.toThrow('refused');
      expect(await db().collection('kpmSetupMarks').countDocuments({ kpmId: OTHER, mark: 'activity-types' })).toBe(0);
      await run(interceptor, context({ page: 'activity-types', when: touchesActivityTypes }, otherOwner(), { ops: [{ op: 'trainingModule.update' }] }), { handle: () => of({}) });
      expect(await db().collection('kpmSetupMarks').countDocuments({ kpmId: OTHER, mark: 'activity-types' })).toBe(0);
      expect(await run(interceptor, context(undefined, otherOwner()), { handle: () => of('read') })).toBe('read');
      // No office in the context (a Super Admin outside a session): nothing to mark, and the answer stands.
      expect(await run(interceptor, context({ page: 'products' }, SUPER_ADMIN), { handle: () => of('ok') })).toBe('ok');
    });

    it('P19.3-T2 AC-5 a mark that cannot be written fails open: the save stands', async () => {
      const broken = new KpmSetup(
        { setOnce: () => Promise.reject(new Error('down')) } as never, wired.kpms as never, {} as never, {} as never,
        {} as never, {} as never, {} as never, wired.audit, wired.clock,
      );
      const interceptor = new SetupStepSavedInterceptor(new Reflector(), broken);
      expect(await run(interceptor, context({ page: 'products' }, otherOwner()), { handle: () => of('saved') })).toBe('saved');
    });
  });
});
