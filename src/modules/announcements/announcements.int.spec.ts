import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { describeNotification } from '@/modules/notifications/inbox-copy';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { EmailTemplateRenderer } from '@/modules/notifications/email-renderer';
import { NotificationRepository } from '@/modules/notifications/notification.repository';
import {
  Notification, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from '@/modules/notifications/notification.schema';
import { NotificationService } from '@/modules/notifications/notification.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { readerIn } from '@/common/i18n/reader';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { Announcement, AnnouncementSchema } from './announcement.schema';
import { AnnouncementsController } from './announcements.controller';
import { AnnouncementsService } from './announcements.service';

const NOW = new Date('2026-11-20T03:00:00Z');
const PRU = '66f0000000000000000000c1';
const MANU = '66f0000000000000000000c2';
const [KPM_A, KPM_B, KPM_C, KPM_SUSPENDED, KPM_DELETED] = ['a1', 'a2', 'a3', 'a4', 'a5'].map((s) => `66f0000000000000000000${s}`);
const id = (n: number) => `66f00000000000000000${String(n).padStart(4, '0')}`;
/** Owners of A, B, C, the suspended KPM, the deleted one; then members; one test account; one deactivated owner. */
const [OWNER_A, OWNER_B, OWNER_C, OWNER_S, OWNER_D] = [1, 2, 3, 4, 5].map(id);
const [M1, M2, M3, M4, TEST] = [11, 12, 13, 14, 15].map(id);
const SENDER = id(99);
const SUPPORT_SESSION = new RequestContext('u-owner', 'none', OWNER.membership, 'root', null, false, true);

/**
 * ***Pengumuman* over HTTP** (P19.23-T6 AC-4; ADR-0279): who an audience reaches — each person once, live and active
 * KPMs only, test accounts never — what *Pratinjau* counts, what *Kirim* writes, and who may.
 */
describe('Pengumuman (P19.23-T6 AC-4)', () => {
  let app: INestApplication;
  let audit: mongoose.Model<AuditLog>;
  let rows: mongoose.Model<Notification>;
  let sent: mongoose.Model<Announcement>;

  beforeAll(async () => {
    await startMongo();
    const clock = new FixedClock(NOW);
    audit = mongoose.model(AuditLog.name, AuditLogSchema) as never;
    rows = mongoose.model(Notification.name, NotificationSchema) as never;
    sent = mongoose.model(Announcement.name, AnnouncementSchema) as never;
    const notifications = new NotificationService(
      rows as never,
      new NotificationRepository(rows as never),
      mongoose.model(NotificationPreferences.name, NotificationPreferencesSchema) as never,
      new EmailTemplateRenderer({ getOrThrow: () => 'https://app.agencyboost.test' } as never),
      clock,
      new AuditService(audit as never),
      [],
    );
    const service = new AnnouncementsService(
      sent as never,
      mongoose.model(Kpm.name, KpmSchema) as never,
      mongoose.model(Company.name, CompanySchema) as never,
      mongoose.model(User.name, UserSchema) as never,
      new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never),
      notifications,
      new AuditService(audit as never),
      clock,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [AnnouncementsController],
      providers: [{ provide: AnnouncementsService, useValue: service }],
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
    session.current = RequestContext.platform(SENDER);
    const db = mongoose.connection.db!;
    const oid = (s: string) => new mongoose.Types.ObjectId(s);
    await db.collection('companies').insertMany([
      { _id: oid(PRU), name: 'Prudential', slug: 'prudential', deletedAt: null },
      { _id: oid(MANU), name: 'Manulife', slug: 'manulife', deletedAt: null },
    ]);
    const kpm = (k: string, companyId: string, ownerUserId: string, code: string, over: Record<string, unknown> = {}) => ({
      _id: oid(k), companyId, ownerUserId, code, branchName: `Branch ${code}`, status: 'active', deletedAt: null, ...over,
    });
    await db.collection('kpms').insertMany([
      kpm(KPM_A, PRU, OWNER_A, '0417'),
      kpm(KPM_B, PRU, OWNER_B, '0603'),
      kpm(KPM_C, MANU, OWNER_C, '0001'),
      kpm(KPM_SUSPENDED, PRU, OWNER_S, '0999', { status: 'suspended' }),
      kpm(KPM_DELETED, PRU, OWNER_D, '0555', { deletedAt: NOW }),
    ]);
    const person = (u: string, fullName: string, over: Record<string, unknown> = {}) => ({
      _id: oid(u), email: `${u}@x.test`, fullName, passwordHash: 'x', status: 'active', deletedAt: null, ...over,
    });
    await db.collection('users').insertMany([
      person(OWNER_A, 'Owner A'), person(OWNER_B, 'Owner B'), person(OWNER_C, 'Owner C', { testAccount: true }),
      person(OWNER_S, 'Owner S'), person(OWNER_D, 'Owner D'),
      person(M1, 'Member 1'), person(M2, 'Member 2'), person(M3, 'Member 3'), person(M4, 'Member 4'), person(TEST, 'FMT Tes', { testAccount: true }),
      person(SENDER, 'PLATFORM OPERATOR', { platformRole: 'super_admin' }),
    ]);
    const member = (kpmId: string, userId: string, over: Record<string, unknown> = {}) => ({
      kpmId, userId, status: 'active', deletedAt: null, testAccount: false, agentCode: userId.slice(-4),
      // Unique, as the memberships schema's own index requires once another suite has built it in this database.
      leaderCode: `L${kpmId.slice(-2)}${userId.slice(-4)}`, ...over,
    });
    await db.collection('memberships').insertMany([
      member(KPM_A, OWNER_A), member(KPM_A, M1), member(KPM_A, TEST, { testAccount: true }),
      // Member 1 is in C too: one notice for one person.
      member(KPM_B, OWNER_B), member(KPM_B, M2), member(KPM_C, M1), member(KPM_C, M3),
      member(KPM_C, M4, { status: 'removed' }),
      member(KPM_SUSPENDED, OWNER_S), member(KPM_DELETED, OWNER_D),
    ]);
  });

  const api = () => request(app.getHttpServer());
  const preview = async (body: Record<string, unknown>) =>
    (await api().post('/api/admin/platform/announcements/preview').send(body).expect(200)).body.recipients;

  it('P19.23-T6 AC-4 each route names the permission it is guarded by', () => {
    expect(declaredPermissions(AnnouncementsController)).toEqual({
      list: 'announcement:read', preview: 'announcement:send', send: 'announcement:send',
    });
  });

  describe('who it reaches (Pratinjau)', () => {
    it('P19.23-T6 AC-4 Semua owner: the Owner of every live, active KPM — a suspended or deleted one’s not, a test account not', async () => {
      expect(await preview({ audience: 'owners' })).toBe(2);
    });

    it('P19.23-T6 AC-4 Semua anggota: every active member of the live, active KPMs, each person once, test accounts not', async () => {
      // Owner A, Member 1 (A and C), Owner B, Member 2, Member 3. Not the removed one, the test account, or S and D's.
      expect(await preview({ audience: 'members' })).toBe(5);
    });

    it('P19.23-T6 AC-4 Pilih perusahaan / KPM: the members of the companies and the KPMs chosen', async () => {
      expect(await preview({ audience: 'selected', companyIds: [MANU] })).toBe(2);
      expect(await preview({ audience: 'selected', kpmIds: [KPM_B] })).toBe(2);
      expect(await preview({ audience: 'selected', companyIds: [MANU], kpmIds: [KPM_B] })).toBe(4);
      // A suspended KPM chosen reaches nobody.
      expect(await preview({ audience: 'selected', kpmIds: [KPM_SUSPENDED] })).toBe(0);
    });

    it('P19.23-T6 AC-4 Pratinjau writes nothing', async () => {
      await preview({ audience: 'members' });
      expect(await rows.countDocuments()).toBe(0);
      expect(await sent.countDocuments()).toBe(0);
      expect(await audit.countDocuments()).toBe(0);
    });

    it.each([
      ['an audience it does not know', { audience: 'everyone' }],
      ['Pilih with nothing chosen', { audience: 'selected' }],
      ['an id that is not one', { audience: 'selected', kpmIds: ['nope'] }],
    ])('P19.23-T6 AC-4 refuses %s, 400', async (_label, body) => {
      const refused = (await api().post('/api/admin/platform/announcements/preview').send(body).expect(400)).body;
      expect(refused.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('Kirim', () => {
    it('P19.23-T6 AC-4 sends each person one in-app notice with the message, records the send and audits it', async () => {
      const { body } = await api()
        .post('/api/admin/platform/announcements')
        .send({ audience: 'selected', companyIds: [MANU], kpmIds: [KPM_B], message: '  Fitur proposal baru sudah tersedia di menu Leads.  ' })
        .expect(201);
      expect(body).toMatchObject({
        message: 'Fitur proposal baru sudah tersedia di menu Leads.',
        audience: 'selected',
        chosen: ['Manulife', 'KPM 0603 · Branch 0603'],
        recipientCount: 4,
        sentBy: { userId: SENDER, fullName: 'PLATFORM OPERATOR' },
        sentAt: NOW.toISOString(),
      });

      const notices = await rows.find().lean();
      expect(notices.map((n) => n.userId).sort()).toEqual([OWNER_B, M1, M2, M3].sort());
      expect(notices.every((n) => n.templateId === 'platform.announcement')).toBe(true);
      const words = describeNotification('platform.announcement', notices[0].payload, readerIn('id'));
      expect(words).toEqual({ title: 'Pengumuman dari AgencyBoost', detail: 'Fitur proposal baru sudah tersedia di menu Leads.' });

      const [entry] = await audit.find({ action: 'announcement.sent' }).lean();
      expect(entry).toMatchObject({
        kpmId: null, actorUserId: SENDER, targetCollection: 'announcements', targetId: body.announcementId,
        after: { audience: 'selected', companyIds: [MANU], kpmIds: [KPM_B], recipientCount: 4 },
      });

      const list = (await api().get('/api/admin/platform/announcements').expect(200)).body;
      expect(list).toHaveLength(1);
      expect(list[0].announcementId).toBe(body.announcementId);
    });

    it.each([
      ['an empty message', { audience: 'owners', message: '   ' }],
      ['a message past 500 characters', { audience: 'owners', message: 'a'.repeat(501) }],
      ['no message at all', { audience: 'owners' }],
    ])('P19.23-T6 AC-4 refuses %s, 400, and sends nothing', async (_label, body) => {
      expect((await api().post('/api/admin/platform/announcements').send(body).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect(await rows.countDocuments()).toBe(0);
    });

    it('P19.23-T6 AC-4 an audience of nobody is 409 ANNOUNCEMENT_NO_RECIPIENTS: nothing sent, recorded or audited', async () => {
      const { body } = await api().post('/api/admin/platform/announcements')
        .send({ audience: 'selected', kpmIds: [KPM_SUSPENDED], message: 'Halo' }).expect(409);
      expect(body.error.code).toBe('ANNOUNCEMENT_NO_RECIPIENTS');
      expect(await rows.countDocuments()).toBe(0);
      expect(await sent.countDocuments()).toBe(0);
      expect(await audit.countDocuments()).toBe(0);
    });
  });

  describe('who may', () => {
    it.each([['the Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an agent', AGENT], ['a support session', SUPPORT_SESSION]])(
      'P19.23-T6 AC-4 refuses %s every route, 403 PERM_DENIED',
      async (_label, ctx) => {
        session.current = ctx;
        expect((await api().get('/api/admin/platform/announcements').expect(403)).body.error.code).toBe('PERM_DENIED');
        expect((await api().post('/api/admin/platform/announcements/preview').send({ audience: 'owners' }).expect(403)).body.error.code)
          .toBe('PERM_DENIED');
        expect((await api().post('/api/admin/platform/announcements').send({ audience: 'owners', message: 'x' }).expect(403)).body.error.code)
          .toBe('PERM_DENIED');
        expect(await rows.countDocuments()).toBe(0);
      },
    );

    it('P19.23-T6 AC-4 the Super Admin of the stubs reads the list', async () => {
      session.current = SUPER_ADMIN;
      expect((await api().get('/api/admin/platform/announcements').expect(200)).body).toEqual([]);
    });
  });
});
