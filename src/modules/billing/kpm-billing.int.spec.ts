import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { BILLING_LAPSE_SUSPENSION_REASON } from '@/domain/constants';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import type { PlatformSettingsService } from '@/modules/platform-settings/platform-settings.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import {
  AAB, AB, ADMIN, AGENT, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { BillingService } from './billing.service';
import { KpmBillingController } from './kpm-billing.controller';

/** 10:00 on 20 November 2026 in Jakarta. */
const NOW = new Date('2026-11-20T03:00:00Z');
const TODAY = '2026-11-20';
const rp = (major: number) => major * 100;

/** A support session as the Owner: it acts as its member, so it holds no platform grant. */
const SUPPORT_SESSION = new RequestContext('u-owner', 'none', OWNER.membership, 'root', null, false, true);

/** A binary body, read whole: supertest leaves `application/pdf` unparsed otherwise. */
const binary = (res: request.Response, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

const TENANT_ROLES: [string, RequestContext][] = [
  ['the KPM Owner', OWNER], ['a KPM Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT],
  ['a support session', SUPPORT_SESSION],
];

/** Frame 50's inputs: 11 leaders, Tahunan, Rp 375.000 — Rp 47.025.000. */
const PACKAGE = {
  leaders: 11, agents: null, plan: 'annual', price: { mode: 'per_leader', rateMinor: rp(375_000) }, bulk: null,
  startDate: '2026-11-20', endDate: '2027-11-19', note: '  KPM baru, komitmen 1 tahun  ',
};

/**
 * **Langganan & akses over HTTP** (P19.23-T5 AC-2, AC-4; ADR-0279 §3, §6, §7): `GET /admin/billing/kpms`,
 * `PUT /admin/billing/kpms/:kpmId/subscription` and `POST /admin/billing/offer` — who may call them, what they answer,
 * what is stored and what is recorded. `BillingService` is real over a real database; the platform's WhatsApp number is
 * a stub.
 */
describe('Langganan & akses per KPM (P19.23-T5)', () => {
  let app: INestApplication;
  let kpms: mongoose.Model<Kpm>;
  let companies: mongoose.Model<Company>;
  let users: mongoose.Model<User>;
  let memberships: mongoose.Model<Membership>;
  let audit: mongoose.Model<AuditLog>;
  let seq = 0;

  beforeAll(async () => {
    await startMongo();
    const clock = new FixedClock(NOW);
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    companies = mongoose.model(Company.name, CompanySchema) as never;
    users = mongoose.model(User.name, UserSchema) as never;
    memberships = mongoose.model(Membership.name, MembershipSchema) as never;
    audit = mongoose.model(AuditLog.name, AuditLogSchema) as never;
    const platform = { whatsappNumber: async () => '0811 2000 300' } as unknown as PlatformSettingsService;
    const billing = new BillingService(
      kpms as never, companies as never, users as never, new MembershipRepository(memberships as never), clock,
      new AuditService(audit as never), platform,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [KpmBillingController],
      providers: [{ provide: BillingService, useValue: billing }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await clearCollections();
    session.current = SUPER_ADMIN;
  });

  const http = () => request(app.getHttpServer());

  async function company(name: string) {
    return companies.create({ name, slug: `${name.toLowerCase()}-${seq += 1}` });
  }

  async function office(companyId: string, over: Record<string, unknown> = {}) {
    seq += 1;
    return kpms.create({
      companyId, code: `0${400 + seq}`, branchName: `Branch ${seq}`, timezone: 'Asia/Jakarta', ...over,
    });
  }

  async function leaders(kpmId: string, n: number, over: Record<string, unknown> = {}) {
    for (let i = 0; i < n; i += 1) {
      seq += 1;
      await memberships.create({
        kpmId, userId: `u-${seq}`, agentCode: `PRU-${seq}`, agentSeq: seq, leaderCode: `LC${seq}`,
        orgLevelId: 'lvl-ab', orgLevelCode: 'AB', role: i % 2 ? 'aab' : 'ab', status: 'active', ...over,
      });
    }
  }

  const sub = (over: Record<string, unknown>) => ({
    startDate: '2026-01-01', endDate: '2027-01-31', pricePerLeaderMinor: rp(400_000), currency: 'IDR',
    maxLeaders: 10, keepActiveAfterEnd: false, plan: 'six_months', ...over,
  });

  describe('GET /admin/billing/kpms (AC-4)', () => {
    it('P19.23-T5 AC-4 a row per KPM: leaders used / limit, price, per bulan, per periode, berlaku hingga, the one pill', async () => {
      const pru = await company('Prudential');
      const owner = await users.create({
        email: 'o@kpm.test', fullName: 'Hendra Gunawan', passwordHash: 'x', status: 'active', phone: '+6281111111111',
      });
      const over = await office(String(pru._id), {
        branchName: 'Tangerang Branch', ownerUserId: String(owner._id),
        subscription: sub({ endDate: '2027-03-15', plan: 'annual', periodTotalMinor: rp(50_160_000) }),
      });
      await leaders(String(over._id), 11);
      // A test account at a leader rung is never counted (ADR-0267 §1).
      await leaders(String(over._id), 1, { testAccount: true });

      const res = await http().get('/api/admin/billing/kpms').expect(200);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0]).toEqual({
        kpmId: String(over._id), code: over.code, branch: 'Tangerang Branch',
        company: { id: String(pru._id), name: 'Prudential' },
        kpmStatus: 'active', owner: { fullName: 'Hendra Gunawan', phone: '+6281111111111' },
        leadersUsed: 11, maxLeaders: 10, tier: { code: 'TIER_1_10', minLeaders: 1, maxLeaders: 10 },
        rateMinor: rp(400_000), customPrice: false, plan: 'annual', trial: false,
        startDate: '2026-01-01', endDate: '2027-03-15',
        perMonthMinor: rp(4_180_000), periodTotalMinor: rp(50_160_000),
        graceEndsOn: null, attention: 'over', needsAction: true, agents: null, bulkDiscount: null, note: null,
      });
    });

    it('P19.23-T5 AC-4 each state reads its pill, and Perlu tindakan counts the four that need an action', async () => {
      const pru = await company('Prudential');
      const running = await office(String(pru._id), { branchName: 'A Running', subscription: sub({}) });
      await leaders(String(running._id), 9);
      await office(String(pru._id), { branchName: 'B Soon', subscription: sub({ endDate: '2026-12-10' }) });
      await office(String(pru._id), {
        branchName: 'C Trial',
        subscription: sub({ startDate: '2026-11-10', endDate: '2026-12-09', pricePerLeaderMinor: null, maxLeaders: null, plan: null, trial: true }),
      });
      await office(String(pru._id), { branchName: 'D Ended', subscription: sub({ endDate: '2026-11-15' }) });
      await office(String(pru._id), {
        branchName: 'E Suspended', status: 'suspended', suspendedReason: BILLING_LAPSE_SUSPENSION_REASON,
        subscription: sub({ endDate: '2026-11-01' }),
      });
      await office(String(pru._id), { branchName: 'F Archived', status: 'archived', subscription: sub({}) });
      await office(String(pru._id), { branchName: 'G None' });

      const all = await http().get('/api/admin/billing/kpms').expect(200);
      const pills = Object.fromEntries(all.body.rows.map((r: { branch: string; attention: string | null }) => [r.branch, r.attention]));
      // An archived KPM is not listed.
      expect(pills).toEqual({
        'A Running': null, 'B Soon': 'ending_soon', 'C Trial': 'trial', 'D Ended': 'ended', 'E Suspended': 'suspended', 'G None': null,
      });
      expect(all.body.rows.find((r: { branch: string }) => r.branch === 'D Ended').graceEndsOn).toBe('2026-11-22');
      expect(all.body.summary).toEqual({
        // Two paying: A and B, each 10 × Rp 400.000 a month.
        monthlyRevenueMinor: rp(8_000_000), payingKpms: 2, leadersBilled: 20, endingSoon: 2, needsAction: 3, kpms: 6,
      });
      expect(all.body.total).toEqual({
        kpms: 6, leadersUsed: 9, weightedRateMinor: rp(400_000), perMonthMinor: rp(8_000_000),
        periodTotalMinor: rp(48_000_000), needsAction: 3,
      });

      const action = await http().get('/api/admin/billing/kpms?filter=needs_action').expect(200);
      expect(action.body.rows.map((r: { branch: string }) => r.branch)).toEqual(['B Soon', 'C Trial', 'D Ended']);
      // The Total row follows the filter; the summary never does.
      expect(action.body.total).toMatchObject({ kpms: 3, needsAction: 3, perMonthMinor: rp(4_000_000) });
      expect(action.body.summary.kpms).toBe(6);
    });

    it('P19.23-T5 AC-4 refuses a filter it does not know, and a parameter of any other name', async () => {
      await http().get('/api/admin/billing/kpms?filter=soon').expect(400);
      await http().get('/api/admin/billing/kpms?sort=kpm').expect(400);
    });

    it.each(TENANT_ROLES)('P19.23-T5 AC-4 refuses %s', async (_who, ctx) => {
      session.current = ctx;
      await http().get('/api/admin/billing/kpms').expect(403);
    });
  });

  describe('PUT /admin/billing/kpms/:kpmId/subscription — Konfirmasi paket (AC-2, AC-4)', () => {
    const confirm = (kpmId: string, body: unknown = PACKAGE) =>
      http().put(`/api/admin/billing/kpms/${kpmId}/subscription`).send(body as object);

    it('P19.23-T5 AC-2 prices the inputs on the server and writes them as the subscription; the trial ends', async () => {
      const pru = await company('Prudential');
      const kpm = await office(String(pru._id), {
        subscription: sub({ startDate: '2026-11-01', endDate: '2026-11-30', pricePerLeaderMinor: null, maxLeaders: null, plan: null, trial: true }),
      });
      await leaders(String(kpm._id), 11);

      const res = await confirm(String(kpm._id)).expect(200);
      expect(res.body).toMatchObject({
        kpmId: String(kpm._id), rateMinor: rp(375_000), maxLeaders: 11, plan: 'annual', trial: false,
        periodTotalMinor: rp(47_025_000), perMonthMinor: rp(3_918_750), endDate: '2027-11-19', attention: null,
        note: 'KPM baru, komitmen 1 tahun',
      });
      const saved = await kpms.findById(kpm._id).lean();
      expect(saved?.subscription).toEqual({
        startDate: '2026-11-20', endDate: '2027-11-19', pricePerLeaderMinor: rp(375_000), currency: 'IDR', maxLeaders: 11,
        keepActiveAfterEnd: false, plan: 'annual', trial: false, periodTotalMinor: rp(47_025_000), bulkDiscount: null,
        agents: null, note: 'KPM baru, komitmen 1 tahun',
      });
    });

    it('P19.23-T5 AC-2 the total typed (isi total) and a bulk discount are the server’s arithmetic too', async () => {
      const kpm = await office(String((await company('Prudential'))._id));
      const res = await confirm(String(kpm._id), {
        ...PACKAGE, plan: 'six_months', endDate: '2027-05-19', price: { mode: 'total', totalMinor: rp(24_750_000) },
        bulk: { type: 'amount', amountMinor: rp(750_000) },
      }).expect(200);
      expect(res.body).toMatchObject({
        rateMinor: rp(375_000), periodTotalMinor: rp(24_000_000), bulkDiscount: { type: 'amount', amountMinor: rp(750_000) },
      });
    });

    it('P19.23-T5 AC-4 audits the subscription before and after', async () => {
      const kpm = await office(String((await company('Prudential'))._id), { subscription: sub({}) });
      await confirm(String(kpm._id)).expect(200);
      const rows = await audit.find({ action: 'kpm.subscription_updated' }).lean();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ targetCollection: 'kpms', targetId: String(kpm._id), actorUserId: 'root' });
      expect((rows[0].before as { subscription: { endDate: string } }).subscription.endDate).toBe('2027-01-31');
      expect((rows[0].after as { subscription: { endDate: string } }).subscription.endDate).toBe('2027-11-19');
    });

    it('P19.23-T5 AC-5 reactivates a KPM the daily run suspended, and audits it; a Super Admin’s own suspension stays', async () => {
      const pru = await company('Prudential');
      const lapsed = await office(String(pru._id), {
        status: 'suspended', suspendedReason: BILLING_LAPSE_SUSPENSION_REASON, suspendedAt: NOW,
        subscription: sub({ endDate: '2026-11-01' }),
      });
      const manual = await office(String(pru._id), {
        status: 'suspended', suspendedReason: 'Tidak membayar', suspendedAt: NOW, subscription: sub({ endDate: '2026-11-01' }),
      });

      const back = await confirm(String(lapsed._id)).expect(200);
      expect(back.body).toMatchObject({ kpmStatus: 'active', attention: null });
      expect(await kpms.findById(lapsed._id).lean()).toMatchObject({ status: 'active', suspendedReason: null, suspendedAt: null });
      expect(await audit.countDocuments({ action: 'kpm.active', targetId: String(lapsed._id) })).toBe(1);

      const kept = await confirm(String(manual._id)).expect(200);
      expect(kept.body).toMatchObject({ kpmStatus: 'suspended', attention: 'suspended' });
    });

    it('P19.23-T5 AC-5 a package already past its own grace reactivates nothing', async () => {
      const kpm = await office(String((await company('Prudential'))._id), {
        status: 'suspended', suspendedReason: BILLING_LAPSE_SUSPENSION_REASON, subscription: sub({ endDate: '2026-11-01' }),
      });
      await confirm(String(kpm._id), { ...PACKAGE, startDate: '2026-05-01', endDate: '2026-11-01' }).expect(200);
      expect((await kpms.findById(kpm._id).lean())?.status).toBe('suspended');
    });

    it.each([
      ['leaders below 1', { leaders: 0 }, 'leaders'],
      ['a price in a fraction of a rupiah', { price: { mode: 'per_leader', rateMinor: 37_500_050 } }, 'price.rateMinor'],
      ['a price over the ceiling', { price: { mode: 'per_leader', rateMinor: rp(100_000_001) } }, 'price.rateMinor'],
      ['a bulk percent over 100', { bulk: { type: 'percent', percent: 101 } }, 'bulk.percent'],
      ['a bulk amount over the total', { bulk: { type: 'amount', amountMinor: rp(50_000_000) } }, 'bulk.amountMinor'],
      ['a date that is no day', { startDate: '2026-02-30' }, 'startDate'],
      ['an end before the start', { endDate: '2026-11-19' }, 'endDate'],
    ])('P19.23-T5 AC-2 refuses %s, naming the field, and writes nothing', async (_what, change, field) => {
      const kpm = await office(String((await company('Prudential'))._id));
      const res = await confirm(String(kpm._id), { ...PACKAGE, ...change }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details?.field ?? JSON.stringify(res.body.error)).toContain(field.split('.')[0]);
      expect((await kpms.findById(kpm._id).lean())?.subscription ?? null).toBeNull();
      expect(await audit.countDocuments({})).toBe(0);
    });

    it('P19.23-T5 AC-2 refuses a plan it does not know and a note over 500 characters', async () => {
      const kpm = await office(String((await company('Prudential'))._id));
      await confirm(String(kpm._id), { ...PACKAGE, plan: 'monthly' }).expect(400);
      await confirm(String(kpm._id), { ...PACKAGE, note: 'x'.repeat(501) }).expect(400);
    });

    it('P19.23-T5 AC-4 an unknown, malformed, archived or deleted KPM is 404', async () => {
      const pru = await company('Prudential');
      const archived = await office(String(pru._id), { status: 'archived' });
      const deleted = await office(String(pru._id), { deletedAt: NOW });
      await confirm('66f0000000000000000000ff').expect(404);
      await confirm('not-an-id').expect(404);
      await confirm(String(archived._id)).expect(404);
      await confirm(String(deleted._id)).expect(404);
    });

    it('P19.23-T5 AC-4 writes the KPM named and no other', async () => {
      const pru = await company('Prudential');
      const a = await office(String(pru._id), { subscription: sub({}) });
      const b = await office(String(pru._id), { subscription: sub({ endDate: '2027-02-28' }) });
      await confirm(String(a._id)).expect(200);
      expect((await kpms.findById(b._id).lean())?.subscription?.endDate).toBe('2027-02-28');
    });

    it.each(TENANT_ROLES)('P19.23-T5 AC-4 refuses %s, and writes nothing', async (_who, ctx) => {
      const kpm = await office(String((await company('Prudential'))._id));
      session.current = ctx;
      await confirm(String(kpm._id)).expect(403);
      expect((await kpms.findById(kpm._id).lean())?.subscription ?? null).toBeNull();
    });
  });

  describe('POST /admin/billing/offer — Buat PDF (AC-2)', () => {
    const offer = (body: unknown) => http().post('/api/admin/billing/offer').send(body as object).buffer(true).parse(binary);

    it('P19.23-T5 AC-2 answers the offer as a PDF, named for the KPM picked', async () => {
      const kpm = await office(String((await company('Prudential'))._id), { branchName: 'BSD City Branch' });
      const res = await offer({ ...PACKAGE, kpmId: String(kpm._id) }).expect(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toContain(`Penawaran-BSD-City-Branch-${TODAY}.pdf`);
      expect((res.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // Nothing is stored or audited.
      expect(await audit.countDocuments({})).toBe(0);
    });

    it('P19.23-T5 AC-2 for a new KPM, by the name typed', async () => {
      const res = await offer({ ...PACKAGE, kpmName: 'Serpong Branch' }).expect(200);
      expect(res.headers['content-disposition']).toContain('Penawaran-Serpong-Branch');
    });

    it('P19.23-T5 AC-2 refuses an offer for nobody, and a KPM that is not there', async () => {
      await http().post('/api/admin/billing/offer').send({ ...PACKAGE }).expect(400);
      await http().post('/api/admin/billing/offer').send({ ...PACKAGE, kpmId: '66f0000000000000000000ff' }).expect(404);
      await http().post('/api/admin/billing/offer').send({ ...PACKAGE, kpmName: 'x', leaders: 0 }).expect(400);
    });

    it.each(TENANT_ROLES)('P19.23-T5 AC-2 refuses %s', async (_who, ctx) => {
      session.current = ctx;
      await http().post('/api/admin/billing/offer').send({ ...PACKAGE, kpmName: 'Serpong Branch' }).expect(403);
    });
  });
});
