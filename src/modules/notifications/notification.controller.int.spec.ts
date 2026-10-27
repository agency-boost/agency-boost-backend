import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { FixedClock } from '@/common/clock/clock.port';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import {
  AGENT, declaredPermissions, EVERY_MEMBER, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationController } from './notification.controller';
import {
  Notification, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from './notification.schema';
import { NotificationRepository } from './notification.repository';
import { NotificationService, TemplateRenderer } from './notification.service';
import type { RenderedMessage } from './notification.types';

const NOW = new Date('2026-10-03T02:00:00Z');

class StubRenderer extends TemplateRenderer {
  render(templateId: string): RenderedMessage {
    return { subject: templateId, body: '' };
  }
}

/** Everybody who signs in, the platform included: every one of them has an inbox of their own. */
const EVERYBODY: [string, RequestContext][] = [...EVERY_MEMBER, ['a Super Admin', SUPER_ADMIN]];

const ITEM_KEYS = ['createdAt', 'detail', 'href', 'kpmId', 'notificationId', 'readAt', 'templateId', 'title'];

/**
 * **The inbox over HTTP** (P12.1-T4): the contract the frontend builds against — the page, its validation,
 * the read and unread marks and *Mark all read* — with the decorators, the production pipe and the
 * permission guard in front of the real service.
 */
describe('the inbox over HTTP (P12.1-T4)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  /** When a row was read, as the collection holds it. */
  const readAtOf = async (id: string) =>
    ((await mongoose.model(Notification.name).collection.findOne({ _id: new mongoose.Types.ObjectId(id) }))?.readAt ?? null) as Date | null;

  /** `count` inbox rows for `userId`, a minute apart, the newest last; the first `read` of them read. */
  const seed = async (userId: string, count: number, read = 0) => {
    const rows = Array.from({ length: count }, (_, i) => ({
      _id: new mongoose.Types.ObjectId(), userId, kpmId: null, membershipId: null,
      templateId: i % 2 ? 'calendar.invitation' : 'join_request.approved',
      payload: i % 2 ? { entryId: new mongoose.Types.ObjectId().toString(), date: '2026-10-05' } : {},
      delivery: {}, coalesceKey: null, deletedAt: null,
      readAt: i < read ? NOW : null,
      createdAt: new Date(NOW.getTime() + i * 60_000), updatedAt: NOW,
    }));
    await mongoose.model(Notification.name).collection.insertMany(rows);
    return rows.map((r) => String(r._id));
  };

  beforeAll(async () => {
    await startMongo();
    const model = mongoose.model(Notification.name, NotificationSchema);
    await syncIndexes();
    const service = new NotificationService(
      model as never,
      new NotificationRepository(model as never),
      mongoose.model(NotificationPreferences.name, NotificationPreferencesSchema) as never,
      new StubRenderer(),
      new FixedClock(NOW),
      new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never),
      [],
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationController],
      providers: [{ provide: NotificationService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication();
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
    session.current = AGENT;
    await clearCollections();
  });

  it('P12.1-T4 declares its permissions: reading the inbox, and one mark for read, unread and all', () => {
    // The unread toggle reuses `notification:mark_read`: no new permission.
    expect(declaredPermissions(NotificationController)).toEqual({
      inbox: 'notification:read_inbox',
      readAll: 'notification:mark_read',
      read: 'notification:mark_read',
      unread: 'notification:mark_read',
    });
  });

  describe.each(EVERYBODY)('P12.1-T4 %s', (_name, who) => {
    beforeEach(() => { session.current = who; });

    it('P12.1-T4 pages their own inbox, in exactly the contract’s shape', async () => {
      await seed(who.userId, 45, 10);
      await seed('u-somebody-else', 3);

      const first = (await http().get('/notifications').expect(200)).body;
      expect(Object.keys(first).sort()).toEqual(['items', 'page', 'pageSize', 'total', 'unread']);
      expect(first).toMatchObject({ page: 1, pageSize: 20, total: 45, unread: 35 });
      expect(first.items).toHaveLength(20);
      expect(Object.keys(first.items[0]).sort()).toEqual(ITEM_KEYS);

      const last = (await http().get('/notifications').query({ page: 3, pageSize: 20 }).expect(200)).body;
      expect(last).toMatchObject({ page: 3, pageSize: 20, total: 45, unread: 35 });
      expect(last.items).toHaveLength(5);
      const past = (await http().get('/notifications').query({ page: 4 }).expect(200)).body;
      expect(past).toEqual({ items: [], unread: 35, total: 45, page: 4, pageSize: 20 });
    });

    it('P12.1-T4 marks one read and unread, answering its state and the count; read-all answers { unread: 0 }', async () => {
      const [oldest, newer] = await seed(who.userId, 2);

      const read = (await http().post(`/notifications/${oldest}/read`).expect(200)).body;
      expect(read).toEqual({ notificationId: oldest, readAt: NOW.toISOString(), unread: 1 });
      // Pressing twice settles.
      expect((await http().post(`/notifications/${oldest}/read`).expect(200)).body).toEqual(read);

      const unread = (await http().post(`/notifications/${oldest}/unread`).expect(200)).body;
      expect(unread).toEqual({ notificationId: oldest, readAt: null, unread: 2 });
      expect((await http().post(`/notifications/${oldest}/unread`).expect(200)).body).toEqual(unread);

      expect((await http().post('/notifications/read-all').expect(200)).body).toEqual({ unread: 0 });
      expect((await http().get('/notifications').expect(200)).body.items.map((i: { notificationId: string; readAt: string }) =>
        [i.notificationId, i.readAt])).toEqual([[newer, NOW.toISOString()], [oldest, NOW.toISOString()]]);
    });

    it('P12.1-T4 a notification of somebody else’s is a 404 to read or unread, and is left as it was', async () => {
      const [theirs] = await seed(who === OWNER ? 'u-agent' : 'u-owner', 1, 1);
      for (const mark of ['read', 'unread']) {
        const res = await http().post(`/notifications/${theirs}/${mark}`).expect(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      expect(await readAtOf(theirs)).toEqual(NOW);
    });
  });

  it('P18.95-T7 AC-4 an event reminder reads its time and place over HTTP, from the payload in the office’s zone', async () => {
    await mongoose.model(Notification.name).collection.insertMany([
      {
        _id: new mongoose.Types.ObjectId(), userId: AGENT.userId, kpmId: AGENT.kpmId, membershipId: AGENT.membershipId,
        templateId: 'event.reminder',
        payload: {
          eventId: new mongoose.Types.ObjectId().toString(), title: 'Kickoff 2026',
          startsAt: '2026-11-09T02:00:00.000Z', timezone: 'Asia/Jakarta', location: 'Kantor KPM',
        },
        delivery: {}, coalesceKey: null, deletedAt: null, readAt: null, createdAt: NOW, updatedAt: NOW,
      },
      // Written before the payload carried them: its title alone, and the words it always had.
      {
        _id: new mongoose.Types.ObjectId(), userId: AGENT.userId, kpmId: AGENT.kpmId, membershipId: AGENT.membershipId,
        templateId: 'event.reminder', payload: { title: 'Town Hall' },
        delivery: {}, coalesceKey: null, deletedAt: null, readAt: null, createdAt: new Date(NOW.getTime() - 60_000), updatedAt: NOW,
      },
    ]);
    const { items } = (await http().get('/notifications').expect(200)).body;
    expect(items.map((i: { title: string; detail: string }) => [i.title, i.detail])).toEqual([
      ['Kickoff 2026 is coming up', '9 Nov 2026, 09.00 · Kantor KPM'],
      ['Town Hall is coming up', 'Check the time and where it is.'],
    ]);
  });

  it('P12.1-T4 a malformed or unknown id is a 404 too', async () => {
    for (const id of ['not-an-id', new mongoose.Types.ObjectId().toString()]) {
      for (const mark of ['read', 'unread']) {
        expect((await http().post(`/notifications/${id}/${mark}`).expect(404)).body.error.code).toBe('NOT_FOUND');
      }
    }
  });

  it.each([
    ['the retired limit', { limit: 10 }, 'limit'],
    ['an unknown parameter', { userId: 'u-owner' }, 'userId'],
    ['page 0', { page: 0 }, 'page'],
    ['a negative page', { page: -1 }, 'page'],
    ['a fractional page', { page: 1.5 }, 'page'],
    ['a page that is not a number', { page: 'two' }, 'page'],
    ['pageSize 0', { pageSize: 0 }, 'pageSize'],
    ['pageSize 51', { pageSize: 51 }, 'pageSize'],
    ['a pageSize that is not a number', { pageSize: 'all' }, 'pageSize'],
  ])('P12.1-T4 refuses %s with 400 VALIDATION_FAILED, naming it', async (_case, query, field) => {
    const res = await http().get('/notifications').query(query).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body.error.details)).toContain(field);
  });

  it('P12.1-T4 takes both bounds of pageSize', async () => {
    await seed(AGENT.userId, 60);
    expect((await http().get('/notifications').query({ pageSize: 1 }).expect(200)).body.items).toHaveLength(1);
    expect((await http().get('/notifications').query({ pageSize: 50 }).expect(200)).body).toMatchObject({ pageSize: 50, total: 60 });
  });

  it('P12.1-T4 a read-only support session reads the inbox and is refused every mark', async () => {
    const [mine] = await seed(AGENT.userId, 1);
    session.current = new RequestContext(
      AGENT.userId, 'none', AGENT.membership, 'u-support', null, false, true,
    );
    await http().get('/notifications').expect(200);
    for (const path of [`/notifications/${mine}/read`, `/notifications/${mine}/unread`, '/notifications/read-all']) {
      const res = await http().post(path).expect(403);
      expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'notification:mark_read' } });
    }
    expect(await readAtOf(mine)).toBeNull();
  });

  /** What the audit log holds, oldest first, as the support console reads it. */
  const audited = async () => (await mongoose.model(AuditLog.name).collection.find({}).sort({ _id: 1 }).toArray())
    .map((row) => ({
      action: row.action, actorUserId: row.actorUserId, effectiveUserId: row.effectiveUserId,
      targetCollection: row.targetCollection, targetId: row.targetId,
    }));

  it('Phase 12.1 exit review B1: an elevated support session’s every mark is audited with both actors, and no words', async () => {
    const [mine] = await seed(AGENT.userId, 1);
    session.current = new RequestContext(AGENT.userId, 'none', AGENT.membership, 'u-support', null, false, false);

    await http().post(`/notifications/${mine}/read`).expect(200);
    await http().post(`/notifications/${mine}/unread`).expect(200);
    await http().post('/notifications/read-all').expect(200);

    const both = { actorUserId: 'u-support', effectiveUserId: AGENT.userId, targetCollection: 'notifications' };
    expect(await audited()).toEqual([
      { action: 'notification.marked_read', targetId: mine, ...both },
      { action: 'notification.marked_unread', targetId: mine, ...both },
      { action: 'notification.marked_all_read', targetId: null, ...both },
    ]);
    // Ids only: nothing of what the notice says reaches the log.
    const [row] = await mongoose.model(AuditLog.name).collection.find({}).toArray();
    expect(row.before ?? null).toBeNull();
    expect(row.after ?? null).toBeNull();
  });

  it('Phase 12.1 exit review B1: a member marking their own inbox writes no audit row — it is their own reading', async () => {
    const [mine] = await seed(AGENT.userId, 1);
    await http().post(`/notifications/${mine}/read`).expect(200);
    await http().post(`/notifications/${mine}/unread`).expect(200);
    await http().post('/notifications/read-all').expect(200);
    expect(await audited()).toEqual([]);
  });

  it('Phase 12.1 exit review B1: a mark refused (another person’s notice) is not audited', async () => {
    const [theirs] = await seed('u-somebody-else', 1);
    session.current = new RequestContext(AGENT.userId, 'none', AGENT.membership, 'u-support', null, false, false);
    await http().post(`/notifications/${theirs}/read`).expect(404);
    expect(await audited()).toEqual([]);
  });

  it('Phase 12.1 exit review N3: Mark all read leaves an email-only auth row alone, as the single mark does', async () => {
    const [shown] = await seed(AGENT.userId, 1);
    const auth = new mongoose.Types.ObjectId();
    await mongoose.model(Notification.name).collection.insertOne({
      _id: auth, userId: AGENT.userId, kpmId: null, membershipId: null, templateId: 'auth.password_reset',
      payload: {}, delivery: {}, coalesceKey: null, deletedAt: null, readAt: null, createdAt: NOW, updatedAt: NOW,
    });
    await http().post('/notifications/read-all').expect(200);
    expect(await readAtOf(shown)).toEqual(NOW);
    expect(await readAtOf(String(auth))).toBeNull();
  });
});
