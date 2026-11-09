import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import {
  AAB, AB, ADMIN, AGENT, FIXTURE_KPM, OWNER, productionPipe, savedLanguage, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { IN_INDONESIAN } from '../../../test/i18n';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { AdminController } from './admin.controller';
import { PlatformReads } from '@/modules/reporting/platform/platform-reads.service';
import { Company, CompanySchema } from './company.schema';
import { KpmRequest, KpmRequestSchema } from './kpm-request.schema';
import { Kpm, KpmSchema } from './kpm.schema';
import { TenantService } from './tenant.service';

/** 10:00 on 8 October 2026 in Jakarta. */
const NOW = new Date('2026-10-08T03:00:00Z');

/** A support session as the Owner, elevated to write: it still may not touch a subscription. */
const SUPPORT_SESSION = new RequestContext(
  'u-owner', 'none', OWNER.membership, 'root', null, false, false,
);
/** The same session before a second Super Admin approved writing: it may not read one either. */
const READ_ONLY_SUPPORT_SESSION = new RequestContext(
  'u-owner', 'none', OWNER.membership, 'root', null, false, true,
);

/**
 * **An office's subscription over HTTP** (ADR-0112 §2, P13.2-T3 AC-1 to AC-3; ADR-0113 §3, P13.2-T4
 * AC-7, AC-9): who may write it, what the write refuses, what it records, and what the offices list and
 * detail read back — *Leaders used* counted per office through the named unscoped method.
 *
 * `TenantService` is real over a real database; the controller's other collaborators are inert,
 * since no route here reaches them.
 */
describe('PATCH /admin/tenants/:kpmId/subscription, and the reads (P13.2-T3)', () => {
  let app: INestApplication;
  let kpms: mongoose.Model<Kpm>;
  let memberships: mongoose.Model<Membership>;
  let audit: mongoose.Model<AuditLog>;
  let seq = 0;

  beforeAll(async () => {
    await startMongo();
    const clock = new FixedClock(NOW);
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    memberships = mongoose.model(Membership.name, MembershipSchema) as never;
    audit = mongoose.model(AuditLog.name, AuditLogSchema) as never;
    const repo = new MembershipRepository(memberships as never);

    // Only what these routes read is real. Built through a widened constructor so a collaborator added
    // for another route does not have to be invented here.
    const Service = TenantService as unknown as new (...deps: unknown[]) => TenantService;
    const tenants = new Service(
      kpms, mongoose.model(Company.name, CompanySchema), mongoose.model(User.name, UserSchema),
      mongoose.model(KpmRequest.name, KpmRequestSchema), new AuditService(audit as never), clock,
      // The ladder is read for the Super Admin's *Ringkasan* counts (P19.4-T3 AC-9): none here, so codes stand for labels.
      {}, repo, { laddersByCompany: async () => new Map() }, {}, {}, {}, {},
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: TenantService, useValue: tenants },
        // *Data terakhir* (P19.4-T3 AC-8) is the platform reads'; these offices hold no file.
        { provide: PlatformReads, useValue: { dataStatusAcrossTenants: async () => new Map() } },
      ],
    })
      .useMocker(() => ({}))
      .compile();

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

  async function office(over: Record<string, unknown> = {}) {
    seq += 1;
    return kpms.create({
      // A real id: the view joins the company's name by it.
      companyId: new mongoose.Types.ObjectId().toString(), code: `0${600 + seq}`, branchName: `Branch ${seq}`,
      timezone: 'Asia/Jakarta', ...over,
    });
  }

  /** A membership at a rung and a state, written straight to the model: these specs read counts. */
  async function member(kpmId: string, code: 'AB' | 'AAB' | 'AGENT', over: Record<string, unknown> = {}) {
    seq += 1;
    return memberships.create({
      kpmId, userId: `user-${seq}`, agentCode: `PRU-${seq}`, agentSeq: seq, leaderCode: `LC${seq}`,
      orgLevelId: `lvl-${code}`, orgLevelCode: code, role: code.toLowerCase(), status: 'active', ...over,
    });
  }

  const BODY = {
    startDate: '2026-10-01', endDate: '2027-09-30', pricePerLeaderMinor: 350_000_00,
    maxLeaders: 10, keepActiveAfterEnd: false,
  };
  const patch = (kpmId: string, body: unknown = BODY) =>
    request(app.getHttpServer()).patch(`/api/admin/tenants/${kpmId}/subscription`).send(body as object);

  it('AC-2: the Super Admin sets it, and is answered the office as the list reads it', async () => {
    const kpm = await office();
    await member(String(kpm._id), 'AB');
    await member(String(kpm._id), 'AAB');
    await member(String(kpm._id), 'AGENT');

    const res = await patch(String(kpm._id)).expect(200);
    expect(res.body).toMatchObject({
      _id: String(kpm._id),
      subscription: { ...BODY, currency: 'IDR', plan: null },
      leadersUsed: 2,
      subscriptionState: 'active',
    });
    const stored = await kpms.findById(kpm._id).lean().exec();
    expect(stored?.subscription).toEqual({ ...BODY, currency: 'IDR', plan: null });
  });

  it('P19.4-T3 AC-10 sets the plan, audits it with the rest, and keeps it when a body leaves it out', async () => {
    const kpm = await office();
    const set = await patch(String(kpm._id), { ...BODY, plan: 'annual' }).expect(200);
    expect(set.body.subscription.plan).toBe('annual');
    // An older client sends the five fields alone: the plan the office has stays.
    await patch(String(kpm._id), { ...BODY, keepActiveAfterEnd: true }).expect(200);
    expect((await kpms.findById(kpm._id).lean().exec())?.subscription?.plan).toBe('annual');
    // `null` clears it.
    await patch(String(kpm._id), { ...BODY, plan: null }).expect(200);
    expect((await kpms.findById(kpm._id).lean().exec())?.subscription?.plan).toBeNull();
    await patch(String(kpm._id), { ...BODY, plan: 'monthly' }).expect(400);

    const rows = await audit.find({ action: 'kpm.subscription_updated', targetId: String(kpm._id) })
      .sort({ createdAt: 1, _id: 1 }).lean().exec();
    expect(rows.map((r) => (r.after as { subscription: { plan: unknown } }).subscription.plan)).toEqual(['annual', 'annual', null]);
    expect((rows[2].before as { subscription: { plan: unknown } }).subscription.plan).toBe('annual');
  });

  it('AC-2: writes one audit row with the five fields before and after', async () => {
    const kpm = await office();
    await patch(String(kpm._id)).expect(200);
    await patch(String(kpm._id), { ...BODY, keepActiveAfterEnd: true }).expect(200);

    const rows = await audit.find({ action: 'kpm.subscription_updated', targetId: String(kpm._id) })
      .sort({ createdAt: 1, _id: 1 }).lean().exec();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ before: { subscription: null }, after: { subscription: { ...BODY, currency: 'IDR', plan: null } } });
    expect(rows[1]).toMatchObject({
      before: { subscription: { keepActiveAfterEnd: false } },
      after: { subscription: { keepActiveAfterEnd: true } },
    });
  });

  it.each<[string, RequestContext]>([
    ['the Owner', OWNER], ['the Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT],
    ['a support session, elevated', SUPPORT_SESSION],
  ])('AC-2: refuses %s 403, and writes nothing', async (_who, ctx) => {
    const kpm = await office({ _id: FIXTURE_KPM });
    session.current = ctx;
    const res = await patch(String(kpm._id)).expect(403);
    expect(res.body.error.code).toBe('PERM_DENIED');
    expect((await kpms.findById(kpm._id).lean().exec())?.subscription ?? null).toBeNull();
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['an end before the start', { endDate: '2026-09-30' }, 'endDate'],
    ['a start with no end', { endDate: null }, 'endDate'],
    ['a date that is no day', { startDate: '2026-02-30' }, 'startDate'],
    ['a fraction of a rupiah', { pricePerLeaderMinor: 350_000_50 }, 'pricePerLeaderMinor'],
    // The bounds are the service's since the exit review, so they reach the dialog with their field.
    ['a negative price', { pricePerLeaderMinor: -100 }, 'pricePerLeaderMinor'],
    ['a price over the bound', { pricePerLeaderMinor: 100_000_001_00 }, 'pricePerLeaderMinor'],
    ['a limit of 0', { maxLeaders: 0 }, 'maxLeaders'],
    ['a limit over the bound', { maxLeaders: 10_001 }, 'maxLeaders'],
  ])('AC-1: refuses %s, 400 VALIDATION_FAILED naming the field', async (_what, over, field) => {
    const kpm = await office();
    const res = await patch(String(kpm._id), { ...BODY, ...over }).expect(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field } });
    // Said to the Super Admin under that field: neither the field's name nor an amount in sen.
    expect(res.body.error.message).not.toContain(field);
  });

  it('exit review: a price over the bound is refused in rupiah, the words the dialog shows', async () => {
    const kpm = await office();
    const res = await patch(String(kpm._id), { ...BODY, pricePerLeaderMinor: 100_000_001_00 }).expect(400);
    // In the English reader's figures (`test/setup.ts`; P18.10-T5 AC-1, live): the Indonesian dialog's are pinned below.
    expect(res.body.error.message).toBe('The price per leader must be from IDR 0 to IDR 100,000,000 a month.');
  });

  it('P18.10-T5 AC-7 refuses a price, and a date the DTO cannot read, in Indonesian for an Indonesian reader', async () => {
    const kpm = await office();
    const price = await patch(String(kpm._id), { ...BODY, pricePerLeaderMinor: 100_000_001_00 })
      .set(...IN_INDONESIAN).expect(400);
    expect(price.body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Harga per leader harus dari Rp 0 sampai Rp 100.000.000 per bulan.',
      details: { field: 'pricePerLeaderMinor' },
    });

    // The DTO's own sentence (`field`): the message and the violation alike, the field named as the API names it.
    const date = await patch(String(kpm._id), { ...BODY, startDate: '01/10/2026' }).set(...IN_INDONESIAN).expect(400);
    expect(date.body.error.code).toBe('VALIDATION_FAILED');
    expect(date.body.error.details.violations).toEqual(['startDate harus berupa tanggal dengan format YYYY-MM-DD']);
    expect(date.body.error.message).toBe('startDate harus berupa tanggal dengan format YYYY-MM-DD');
  });

  it('P18.10-T5 AC-1 writes a bound’s figures in English for a reader who chose English', async () => {
    const kpm = await office();
    savedLanguage.current = 'en';
    try {
      const res = await patch(String(kpm._id), { ...BODY, pricePerLeaderMinor: 100_000_001_00 }).expect(400);
      expect(res.body.error.message).toBe('The price per leader must be from IDR 0 to IDR 100,000,000 a month.');
    } finally {
      savedLanguage.current = null;
    }
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a field left out', { maxLeaders: undefined }, 'maxLeaders'],
    ['a price as text', { pricePerLeaderMinor: '350000' }, 'pricePerLeaderMinor'],
    ['keep active as null', { keepActiveAfterEnd: null }, 'keepActiveAfterEnd'],
    ['a field it does not take', { seats: 4 }, 'seats'],
  ])('AC-1: refuses %s at the door, 400 VALIDATION_FAILED naming it', async (_what, over, field) => {
    const kpm = await office();
    const res = await patch(String(kpm._id), { ...BODY, ...over }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.message).toContain(field);
  });

  it('AC-1: takes no subscription at all, and clears one', async () => {
    const kpm = await office();
    await patch(String(kpm._id)).expect(200);
    const res = await patch(String(kpm._id), {
      startDate: null, endDate: null, pricePerLeaderMinor: null, maxLeaders: null, keepActiveAfterEnd: false,
    }).expect(200);
    expect(res.body).toMatchObject({ subscriptionState: 'none', subscription: { endDate: null, maxLeaders: null } });
  });

  it('AC-1: an unknown office is 404, and a malformed id too', async () => {
    await patch(new mongoose.Types.ObjectId().toString()).expect(404);
    await patch('not-an-id').expect(404);
  });

  it('T4 AC-7: a limit below Leaders used is taken, and demotes nobody', async () => {
    const kpm = await office();
    for (let i = 0; i < 3; i += 1) await member(String(kpm._id), 'AB');
    const res = await patch(String(kpm._id), { ...BODY, maxLeaders: 1 }).expect(200);
    expect(res.body).toMatchObject({ leadersUsed: 3, subscription: { maxLeaders: 1 } });
    expect(await memberships.countDocuments({ kpmId: String(kpm._id), orgLevelCode: 'AB', status: 'active' })).toBe(3);
  });

  describe('the reads (AC-3)', () => {
    it('lists each office with its subscription, Leaders used and state, computed from its today', async () => {
      const ended = await office({ subscription: { ...BODY, currency: 'IDR', endDate: '2026-10-07' } });
      const kept = await office({ subscription: { ...BODY, currency: 'IDR', endDate: '2026-10-07', keepActiveAfterEnd: true } });
      const running = await office({ subscription: { ...BODY, currency: 'IDR', endDate: '2026-10-08' } });
      const bare = await office();

      const res = await request(app.getHttpServer()).get('/api/admin/tenants').expect(200);
      const state = (id: unknown) => res.body.find((row: { _id: string }) => row._id === String(id));
      expect(state(ended._id)).toMatchObject({ subscriptionState: 'ended' });
      expect(state(kept._id)).toMatchObject({ subscriptionState: 'ended_kept_active' });
      expect(state(running._id)).toMatchObject({ subscriptionState: 'active' });
      expect(state(bare._id)).toMatchObject({ subscriptionState: 'none', subscription: null, leadersUsed: 0 });
    });

    it('T4 AC-1, AC-9: counts each office’s active ABs and AABs, never another office’s, nor a pending, removed or deleted one', async () => {
      const a = await office();
      const b = await office();
      await member(String(a._id), 'AB');
      await member(String(a._id), 'AAB');
      await member(String(a._id), 'AAB', { adminAccess: { isKpmAdmin: true } });
      await member(String(a._id), 'AGENT');
      await member(String(a._id), 'AAB', { status: 'pending' });
      await member(String(a._id), 'AB', { status: 'removed' });
      await member(String(a._id), 'AB', { deletedAt: NOW });
      await member(String(b._id), 'AB');

      const res = await request(app.getHttpServer()).get('/api/admin/tenants').expect(200);
      const used = (id: unknown) => res.body.find((row: { _id: string }) => row._id === String(id)).leadersUsed;
      expect(used(a._id)).toBe(3);
      expect(used(b._id)).toBe(1);
    });

    it('AC-8: the detail carries the same, to the Super Admin', async () => {
      const kpm = await office({ subscription: { ...BODY, currency: 'IDR', endDate: '2026-10-07' } });
      await member(String(kpm._id), 'AB');
      const res = await request(app.getHttpServer()).get(`/api/admin/tenants/${kpm._id}`).expect(200);
      expect(res.body).toMatchObject({ subscriptionState: 'ended', leadersUsed: 1, subscription: { endDate: '2026-10-07' } });
    });

    it.each<[string, RequestContext]>([
      ['an Owner', OWNER],
      ['an Admin', ADMIN],
      ['a read-only support session', READ_ONLY_SUPPORT_SESSION],
      ['an elevated support session', SUPPORT_SESSION],
    ])('%s reading their own office there is not shown the subscription', async (_who, ctx) => {
      await office({ _id: FIXTURE_KPM, subscription: { ...BODY, currency: 'IDR' } });
      session.current = ctx;
      const res = await request(app.getHttpServer()).get(`/api/admin/tenants/${FIXTURE_KPM}`).expect(200);
      expect(res.body._id).toBe(FIXTURE_KPM);
      expect(res.body).not.toHaveProperty('subscription');
      expect(res.body).not.toHaveProperty('leadersUsed');
      expect(res.body).not.toHaveProperty('subscriptionState');
    });
  });
});
