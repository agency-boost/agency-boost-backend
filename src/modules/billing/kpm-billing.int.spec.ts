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
import { EmailTemplateRenderer } from '@/modules/notifications/email-renderer';
import { NotificationRepository } from '@/modules/notifications/notification.repository';
import {
  Notification, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from '@/modules/notifications/notification.schema';
import { NotificationService } from '@/modules/notifications/notification.service';
import {
  NotificationChannelAdapter, NotificationTemplate, type NotificationChannel, type RenderedMessage, type SendRequest,
} from '@/modules/notifications/notification.types';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
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

/** 10:00 on 5 November 2026 in Jakarta. */
const NOW = new Date('2026-11-05T03:00:00Z');

/** Records what a channel was asked to send. */
class RecordingAdapter extends NotificationChannelAdapter {
  sent: { to: SendRequest; rendered: RenderedMessage }[] = [];
  constructor(readonly channel: NotificationChannel) {
    super();
  }
  async send(to: SendRequest, rendered: RenderedMessage): Promise<void> {
    this.sent.push({ to, rendered });
  }
}

/** A support session as the Owner: it acts as its member, so it holds no platform grant. */
const SUPPORT_SESSION = new RequestContext('u-owner', 'none', OWNER.membership, 'root', null, false, true);

/**
 * **Billing per KPM over HTTP** (ADR-0211; P19.4-T3 AC-10; SA case 8): `GET /admin/billing/kpms` and
 * `POST /admin/tenants/:kpmId/quote` — who may call them, what they answer, who receives the quote, what is recorded.
 * `BillingService` is real over a real database, and so is the notification service, with recording channels and the
 * real email renderer.
 */
describe('Billing per KPM (P19.4-T3 AC-10)', () => {
  let app: INestApplication;
  let kpms: mongoose.Model<Kpm>;
  let companies: mongoose.Model<Company>;
  let users: mongoose.Model<User>;
  let memberships: mongoose.Model<Membership>;
  let audit: mongoose.Model<AuditLog>;
  let rows: mongoose.Model<Notification>;
  let notifications: NotificationService;
  let inApp: RecordingAdapter;
  let email: RecordingAdapter;
  let seq = 0;

  beforeAll(async () => {
    await startMongo();
    const clock = new FixedClock(NOW);
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    companies = mongoose.model(Company.name, CompanySchema) as never;
    users = mongoose.model(User.name, UserSchema) as never;
    memberships = mongoose.model(Membership.name, MembershipSchema) as never;
    audit = mongoose.model(AuditLog.name, AuditLogSchema) as never;
    rows = mongoose.model(Notification.name, NotificationSchema) as never;
    inApp = new RecordingAdapter('in_app');
    email = new RecordingAdapter('email');
    notifications = new NotificationService(
      rows as never,
      new NotificationRepository(rows as never),
      mongoose.model(NotificationPreferences.name, NotificationPreferencesSchema) as never,
      new EmailTemplateRenderer({ getOrThrow: () => 'https://app.agencyboost.test' } as never),
      clock,
      new AuditService(audit as never),
      [inApp, email],
    );
    const billing = new BillingService(
      kpms as never, companies as never, users as never, new MembershipRepository(memberships as never), clock,
      new AuditService(audit as never), notifications,
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
    inApp.sent = [];
    email.sent = [];
    session.current = SUPER_ADMIN;
  });

  async function company(name: string) {
    return companies.create({ name, slug: `${name.toLowerCase()}-${seq += 1}` });
  }

  async function owner(over: Record<string, unknown> = {}) {
    seq += 1;
    return users.create({
      email: `owner${seq}@kpm.test`, fullName: `Owner ${seq}`, passwordHash: 'x', status: 'active',
      emailVerifiedAt: NOW, ...over,
    });
  }

  async function office(companyId: string, over: Record<string, unknown> = {}) {
    seq += 1;
    return kpms.create({
      companyId, code: `0${400 + seq}`, branchName: `Branch ${seq}`, timezone: 'Asia/Jakarta', ...over,
    });
  }

  async function leader(kpmId: string, userId: string, role: 'ab' | 'aab' = 'ab') {
    seq += 1;
    return memberships.create({
      kpmId, userId, agentCode: `PRU-${seq}`, agentSeq: seq, leaderCode: `LC${seq}`,
      orgLevelId: `lvl-${role}`, orgLevelCode: role.toUpperCase(), role, status: 'active',
    });
  }

  const QUOTE = {
    leaders: 13, plan: 'annual', discount: { type: 'percent', percent: '7' },
    startDate: '2026-11-12', endDate: '2027-11-11', pic: 'Wulan Kartika', salesBy: 'Maya',
  };
  const send = (kpmId: string, body: unknown = QUOTE) =>
    request(app.getHttpServer()).post(`/api/admin/tenants/${kpmId}/quote`).send(body as object);

  describe('GET /admin/billing/kpms (ADR-0211 §3; SA case 8)', () => {
    it('P19.4-T3 AC-10 lists each KPM: company, leaders, tier, plan, renewal and status — and nothing else', async () => {
      const pru = await company('Prudential');
      const a = await office(String(pru._id), {
        subscription: {
          startDate: '2026-05-01', endDate: '2027-04-30', pricePerLeaderMinor: 380_000_00, currency: 'IDR',
          maxLeaders: 20, keepActiveAfterEnd: false, plan: 'annual',
        },
      });
      await office(String(pru._id), {
        subscription: {
          startDate: '2026-01-01', endDate: '2026-06-30', pricePerLeaderMinor: null, currency: 'IDR',
          maxLeaders: null, keepActiveAfterEnd: true, plan: 'six_months',
        },
      });
      await office(String(pru._id));
      for (let i = 0; i < 12; i += 1) await leader(String(a._id), `u-${i}`, i % 2 ? 'aab' : 'ab');

      const res = await request(app.getHttpServer()).get('/api/admin/billing/kpms').expect(200);
      expect(res.body).toHaveLength(3);
      const [first, second, third] = res.body;
      // Exactly ADR-0211 §3's columns, as counts and codes: no member is named.
      expect(Object.keys(first).sort()).toEqual(
        ['branch', 'code', 'company', 'kpmId', 'leadersUsed', 'plan', 'renewalDate', 'status', 'tier'],
      );
      expect(first).toEqual({
        kpmId: String(a._id), code: a.code, branch: a.branchName,
        company: { id: String(pru._id), name: 'Prudential' },
        leadersUsed: 12, tier: { code: 'TIER_11_20', minLeaders: 11, maxLeaders: 20 },
        plan: 'annual', renewalDate: '2027-04-30', status: 'active',
      });
      expect(second).toMatchObject({ plan: 'six_months', renewalDate: '2026-06-30', status: 'ended_kept_active' });
      // No subscription: no plan, no renewal, *Belum ada langganan*; under one leader, the first tier.
      expect(third).toMatchObject({ plan: null, renewalDate: null, status: 'none', leadersUsed: 0, tier: { code: 'TIER_1_10' } });
    });

    it('P19.4-T3 AC-10 filters by company and sorts by a column, an empty renewal last', async () => {
      const pru = await company('Prudential');
      const man = await company('Manulife');
      await office(String(pru._id), { code: '0417', subscription: { startDate: '2026-01-01', endDate: '2027-01-31', pricePerLeaderMinor: null, currency: 'IDR', maxLeaders: null, keepActiveAfterEnd: false } });
      await office(String(pru._id), { code: '0233', subscription: { startDate: '2026-01-01', endDate: '2026-12-31', pricePerLeaderMinor: null, currency: 'IDR', maxLeaders: null, keepActiveAfterEnd: false } });
      await office(String(pru._id), { code: '0581' });
      await office(String(man._id), { code: '0100' });

      const pruOnly = await request(app.getHttpServer()).get(`/api/admin/billing/kpms?companyId=${pru._id}`).expect(200);
      expect(pruOnly.body.map((r: { code: string }) => r.code)).toEqual(['0233', '0417', '0581']);

      const byRenewal = await request(app.getHttpServer())
        .get(`/api/admin/billing/kpms?companyId=${pru._id}&sort=renewal&dir=desc`).expect(200);
      expect(byRenewal.body.map((r: { code: string }) => r.code)).toEqual(['0417', '0233', '0581']);

      const byCompany = await request(app.getHttpServer()).get('/api/admin/billing/kpms?sort=company').expect(200);
      expect(byCompany.body[0].company.name).toBe('Manulife');
    });

    it('P19.4-T3 AC-10 refuses an unknown sort, a malformed company and any other parameter (400)', async () => {
      for (const query of ['sort=price', 'dir=up', 'companyId=nope', 'page=2']) {
        const res = await request(app.getHttpServer()).get(`/api/admin/billing/kpms?${query}`).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it.each([
      ['the Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT],
      ['a support session', SUPPORT_SESSION],
    ])('P19.4-T3 AC-10 refuses %s the list (403)', async (_who, who) => {
      session.current = who;
      const res = await request(app.getHttpServer()).get('/api/admin/billing/kpms').expect(403);
      expect(res.body.error.code).toBe('PERM_DENIED');
    });
  });

  describe('POST /admin/tenants/:kpmId/quote (ADR-0211 §5)', () => {
    it('P19.4-T3 AC-10 prices the quote on the server and sends it to the KPM’s Owner, by email and in the app', async () => {
      const pru = await company('Prudential');
      const who = await owner({ fullName: 'Wulan Kartika' });
      const kpm = await office(String(pru._id), { code: '0602', branchName: 'Bandung Dago', ownerUserId: String(who._id) });
      const ownerMembership = await leader(String(kpm._id), String(who._id));

      // Figures sent with the inputs are not trusted: the DTO refuses an unknown field, so none can be sent at all.
      await send(String(kpm._id), { ...QUOTE, periodTotalMinor: 1 }).expect(400);

      const res = await send(String(kpm._id)).expect(200);
      // 13 leaders, annual, 7%: the 13-leader Fix of the shared fixture — Rp 331.313 a leader, exact totals.
      expect(res.body).toEqual({
        kpmId: String(kpm._id),
        recipient: { fullName: 'Wulan Kartika' },
        pricing: expect.objectContaining({
          leaders: 13, plan: 'annual', months: 12, tierCode: 'TIER_11_20',
          finalMinor: 331_313_00, monthlyTotalMinor: 4_307_069_00, periodTotalMinor: 51_684_828_00,
          annualDiscountMinor: 18_750_00, manualDiscountMinor: 24_937_00,
        }),
      });
      await notifications.drain();

      // The Owner alone, on both channels.
      const stored = await rows.find({ templateId: NotificationTemplate.BILLING_QUOTE_RECEIVED }).lean();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        userId: String(who._id), kpmId: String(kpm._id), membershipId: String(ownerMembership._id),
      });
      expect(inApp.sent.map((s) => s.to.userId)).toEqual([String(who._id)]);
      expect(email.sent.map((s) => s.to.userId)).toEqual([String(who._id)]);
      // The email is the printable quote's content, every figure the server's — in Indonesian, the language of an
      // Owner who has chosen none.
      const mail = email.sent[0].rendered;
      expect(mail.subject).toContain('Penawaran langganan untuk KPM 0602 · Bandung Dago');
      expect(mail.body).toContain('Wulan Kartika');
      expect(mail.body).toContain('Paket tahunan');
      expect(mail.body).toContain('Tingkat: 11–20 leaders');
      expect(mail.body).toMatch(/Harga akhir \/ leader \/ bln: Rp\s?331\.313/);
      expect(mail.body).toMatch(/Total tahunan \(semua leader\): Rp\s?51\.684\.828/);
      expect(mail.body).toMatch(/Diskon tahunan: -Rp\s?18\.750/);
      expect(mail.body).toContain('Diisi oleh sales: Maya');
      expect(mail.body).toContain('12 Nov 2026');
    });

    it('P19.4-T3 AC-10 records billing.quote_sent in the platform’s log and the KPM’s, and stores no quote', async () => {
      const pru = await company('Prudential');
      const who = await owner();
      const kpm = await office(String(pru._id), { ownerUserId: String(who._id) });
      await send(String(kpm._id)).expect(200);

      const entries = await audit.find({ action: 'billing.quote_sent' }).lean();
      expect(entries.map((e) => e.kpmId).sort()).toEqual([null, String(kpm._id)].sort());
      for (const entry of entries) {
        expect(entry).toMatchObject({ actorUserId: 'root', targetCollection: 'kpms', targetId: String(kpm._id) });
        expect(entry.after).toEqual({
          recipientUserId: String(who._id), leaders: 13, plan: 'annual', tierCode: 'TIER_11_20',
          rateMinor: 331_313_00, totalMinor: 51_684_828_00,
          discount: { type: 'percent', percent: '7', perLeaderMinor: 24_937_00 },
          startDate: '2026-11-12', endDate: '2027-11-11',
        });
      }
      // No quote collection: the only rows written are the notice and the two entries.
      const names = (await mongoose.connection.db!.listCollections().toArray()).map((c) => c.name);
      expect(names.some((n) => /quote/i.test(n))).toBe(false);
    });

    it('P19.4-T3 AC-10 a quote for KPM B reaches B’s Owner and never A’s', async () => {
      const pru = await company('Prudential');
      const ownerA = await owner();
      const ownerB = await owner();
      await office(String(pru._id), { ownerUserId: String(ownerA._id) });
      const b = await office(String(pru._id), { ownerUserId: String(ownerB._id) });
      await send(String(b._id)).expect(200);
      await notifications.drain();
      expect(await rows.countDocuments({ userId: String(ownerA._id) })).toBe(0);
      expect(email.sent.map((s) => s.to.userId)).toEqual([String(ownerB._id)]);
      // And the KPM-scoped entry is B's, so A's Owner never reads it in their log.
      const kpmEntries = await audit.find({ action: 'billing.quote_sent', kpmId: { $ne: null } }).lean();
      expect(kpmEntries.map((e) => e.kpmId)).toEqual([String(b._id)]);
    });

    it('P19.4-T3 AC-10 a KPM with no Owner is 409 BILLING_QUOTE_NO_OWNER, and nothing is sent or recorded', async () => {
      const pru = await company('Prudential');
      const kpm = await office(String(pru._id));
      const res = await send(String(kpm._id)).expect(409);
      expect(res.body.error).toMatchObject({ code: 'BILLING_QUOTE_NO_OWNER', details: { kpmId: String(kpm._id), reason: 'no_owner' } });
      expect(res.body.error.message).toMatch(/Print it or save it as a PDF/);
      await notifications.drain();
      expect(await rows.countDocuments()).toBe(0);
      expect(await audit.countDocuments({ action: 'billing.quote_sent' })).toBe(0);
    });

    it('P19.4-T3 AC-10 an Owner whose address is not verified is 409 too, and is sent nothing', async () => {
      const pru = await company('Prudential');
      const who = await owner({ emailVerifiedAt: null });
      const kpm = await office(String(pru._id), { ownerUserId: String(who._id) });
      const res = await send(String(kpm._id)).expect(409);
      expect(res.body.error).toMatchObject({ code: 'BILLING_QUOTE_NO_OWNER', details: { reason: 'unverified' } });
      await notifications.drain();
      expect(email.sent).toHaveLength(0);
      expect(await rows.countDocuments()).toBe(0);
    });

    it('P19.4-T3 AC-10 a deactivated Owner is no Owner', async () => {
      const pru = await company('Prudential');
      const who = await owner({ status: 'deactivated' });
      const kpm = await office(String(pru._id), { ownerUserId: String(who._id) });
      const res = await send(String(kpm._id)).expect(409);
      expect(res.body.error.details.reason).toBe('no_owner');
    });

    it('P19.4-T3 AC-10 an unknown or malformed KPM is 404', async () => {
      await send(new mongoose.Types.ObjectId().toString()).expect(404);
      await send('not-an-id').expect(404);
    });

    it.each([
      ['leaders below 1', { leaders: 0 }, 'leaders'],
      ['a plan it does not know', { plan: 'monthly' }, 'plan'],
      ['a percent above 100', { discount: { type: 'percent', percent: '100.5' } }, 'discount.percent'],
      ['an amount above the rate', { plan: 'six_months', discount: { type: 'flat', amountMinor: 40_000_100 } }, 'discount.amountMinor'],
      ['a date that is no day', { startDate: '2026-02-30' }, 'startDate'],
      ['an end before the start', { endDate: '2026-11-01' }, 'endDate'],
      ['an empty PIC', { pic: '   ' }, 'pic'],
    ])('P19.4-T3 AC-10 refuses %s (400), sending nothing', async (_what, over, fieldName) => {
      const pru = await company('Prudential');
      const who = await owner();
      const kpm = await office(String(pru._id), { ownerUserId: String(who._id) });
      const res = await send(String(kpm._id), { ...QUOTE, ...over }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.error.details)).toContain(fieldName.split('.')[0]);
      await notifications.drain();
      expect(await rows.countDocuments()).toBe(0);
    });

    it.each([
      ['the Owner of the KPM', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT],
      ['a support session as the Owner', SUPPORT_SESSION],
    ])('P19.4-T3 AC-10 refuses %s (403), sending nothing', async (_who, who) => {
      const pru = await company('Prudential');
      const ownerUser = await owner();
      const kpm = await office(String(pru._id), { ownerUserId: String(ownerUser._id) });
      session.current = who;
      const res = await send(String(kpm._id)).expect(403);
      expect(res.body.error.code).toBe('PERM_DENIED');
      await notifications.drain();
      expect(await rows.countDocuments()).toBe(0);
      expect(await audit.countDocuments({ action: 'billing.quote_sent' })).toBe(0);
    });
  });
});
