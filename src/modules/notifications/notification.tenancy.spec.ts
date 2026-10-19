import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  Notification, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from './notification.schema';
import { NotificationRepository } from './notification.repository';
import { NotificationService } from './notification.service';
import { TemplateRenderer } from './notification.service';
import { RenderedMessage } from './notification.types';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';

const NOW = new Date('2026-09-06T02:00:00Z');
const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();

/**
 * Isolation for a collection that belongs to a **person**, not a tenant.
 *
 * `notifications.kpmId` is nullable by design — email verification and password reset are
 * sent before anybody has joined an office — so the inbox is filtered by `userId` and
 * never by `kpmId`. That is not an exemption from the isolation rule; it is the rule
 * applied to the thing this collection actually is.
 *
 * The guarantee is therefore stronger and simpler than a tenant filter: **no route takes
 * an id that selects whose inbox to read.** These tests assert the absence of that door,
 * not that a door is locked.
 */
function person(userId: string, kpmId: string | null) {
  return new RequestContext(
    userId,
    'none',
    kpmId
      ? {
          membershipId: `mem-${userId}`, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
          isKpmOwner: false, isKpmAdmin: false, directCount: 0,
        }
      : null,
  );
}

/** The words are not what this file is about; isolation is. */
class StubRenderer extends TemplateRenderer {
  render(templateId: string): RenderedMessage {
    return { subject: templateId, body: '' };
  }
}

describe('notifications — one inbox per person (P3.5-T10)', () => {
  let service: NotificationService;
  let clock: FixedClock;

  beforeAll(async () => {
    await startMongo();
    const model = mongoose.model(Notification.name, NotificationSchema);
    await syncIndexes();
    clock = new FixedClock(NOW);
    service = new NotificationService(
      model as never,
      new NotificationRepository(model as never),
      mongoose.model(NotificationPreferences.name, NotificationPreferencesSchema) as never,
      new StubRenderer(),
      clock,
      { record: async () => undefined } as never,
      [],
    );
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    clock.set(NOW);
    await clearCollections();
  });

  const seed = (
    userId: string,
    kpmId: string | null,
    readAt: Date | null = null,
    templateId = 'join_request.approved',
  ) =>
    mongoose.model(Notification.name).create({
      userId, kpmId, membershipId: null, templateId,
      payload: {}, delivery: {}, readAt,
    });

  it('AC-1: gives somebody their own, newest first, with the unread count', async () => {
    await seed('u-a', KPM_A, NOW);
    await seed('u-a', KPM_A);
    await seed('u-b', KPM_A);

    const inbox = await service.inbox(person('u-a', KPM_A));
    expect(inbox.items).toHaveLength(2);
    expect(inbox.unread).toBe(1);
    // P12.1-T4: the first page, of twenty, unless asked otherwise.
    expect(inbox).toMatchObject({ total: 2, page: 1, pageSize: 20 });
  });

  it('AC-3: never returns another person’s, even in the same office', async () => {
    // The sharpest case: same tenant, so a kpmId filter would let both through. The
    // filter is the reader's own userId, taken from the context and never from a
    // parameter — there is no id a caller could supply.
    await seed('u-b', KPM_A);
    expect((await service.inbox(person('u-a', KPM_A))).items).toEqual([]);
  });

  it('AC-3: nor from another office', async () => {
    await seed('u-b', KPM_B);
    expect((await service.inbox(person('u-a', KPM_A))).items).toEqual([]);
  });

  it('AC-3: reads somebody who belongs to no office, rather than refusing them', async () => {
    // The reason this is per-user and not per-tenant: `kpmId` is nullable, and a tenant
    // filter would refuse a person who has one but is not in an office. They see an
    // empty inbox, not an error.
    await expect(service.inbox(person('u-new', null))).resolves.toMatchObject({
      items: [], unread: 0,
    });
  });

  it('keeps email-only templates out of the inbox', async () => {
    // `auth.password_reset` is `email` only (`TEMPLATE_CHANNELS`). A row saying "we
    // emailed you a link" is noise at best; at worst it is somewhere a token surfaces.
    await seed('u-a', KPM_A, null, 'auth.password_reset');
    await seed('u-a', KPM_A);

    const inbox = await service.inbox(person('u-a', KPM_A));
    expect(inbox.items).toHaveLength(1);
    expect(inbox.unread).toBe(1);
    expect(inbox.items[0].templateId).toBe('join_request.approved');
  });

  it('says what a notification means, in words, from the server', async () => {
    // ADR-0010 makes the in-app inbox the authoritative channel, so what a row says is
    // product copy — one source, quoted by the manuals, never improvised by a client.
    await seed('u-a', KPM_A);
    const [item] = (await service.inbox(person('u-a', KPM_A))).items;
    expect(item.title).toBe('You are in');
    expect(item.detail).toBe('Your request was approved. You now have a leader.');
    // No address: only a finalized coaching session opens somewhere (P11-T10 AC-8).
    expect(item.href).toBeNull();
  });

  it('P11-T10 AC-8 the finalize notice opens /coaching/me on its session, composed on the server', async () => {
    // ADR-0078: the notice an Agent reaches `/coaching/me` through. Its payload is `{ sessionId }` alone.
    const sessionId = new mongoose.Types.ObjectId().toString();
    await mongoose.model(Notification.name).create({
      userId: 'u-a', kpmId: KPM_A, membershipId: 'mem-u-a', templateId: 'coaching.session_finalized',
      payload: { sessionId }, delivery: {}, readAt: null,
    });
    await seed('u-a', KPM_A);

    const items = (await service.inbox(person('u-a', KPM_A))).items;
    expect(items.map((i) => [i.templateId, i.href])).toEqual(expect.arrayContaining([
      ['coaching.session_finalized', `/coaching/me?session=${sessionId}`],
      ['join_request.approved', null],
    ]));
    expect(items.find((i) => i.href !== null)).toMatchObject({
      title: 'A coaching session was finalized', detail: 'What was agreed is now on the record.',
    });
  });

  it('AC-2: marking one read drops the unread count', async () => {
    const n = await seed('u-a', KPM_A);
    await seed('u-a', KPM_A);
    const after = await service.markRead(person('u-a', KPM_A), String(n._id));

    // P12.1-T4: the row's own state and the inbox's count, never the page.
    expect(after).toEqual({ notificationId: String(n._id), readAt: NOW.toISOString(), unread: 1 });
  });

  it('AC-2: marking one twice settles rather than complaining, and keeps when it was first read', async () => {
    const n = await seed('u-a', KPM_A);
    await service.markRead(person('u-a', KPM_A), String(n._id));
    clock.advance(60_000);
    await expect(service.markRead(person('u-a', KPM_A), String(n._id))).resolves.toEqual({
      notificationId: String(n._id), readAt: NOW.toISOString(), unread: 0,
    });
  });

  it('AC-3: 404s somebody else’s notification, never 403', async () => {
    // A 403 would confirm it exists. Same reasoning as a member in another office.
    const theirs = await seed('u-b', KPM_A);
    await expect(
      service.markRead(person('u-a', KPM_A), String(theirs._id)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // And it is still unread for the person it belongs to.
    expect((await service.inbox(person('u-b', KPM_A))).unread).toBe(1);
  });

  it('AC-3: 404s a malformed id rather than failing', async () => {
    await expect(service.markRead(person('u-a', KPM_A), 'not-an-id')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('AC-2: marking all read touches only the reader’s own', async () => {
    await seed('u-a', KPM_A);
    await seed('u-a', KPM_A);
    await seed('u-b', KPM_A);

    // P12.1-T4: it answers the count it leaves, and nothing else.
    expect(await service.markAllRead(person('u-a', KPM_A))).toEqual({ unread: 0 });
    expect((await service.inbox(person('u-b', KPM_A))).unread).toBe(1);
  });

  it('P12.1-T4 clamps the page and its size rather than trusting them', async () => {
    for (let i = 0; i < 3; i += 1) await seed('u-a', KPM_A);
    // The HTTP query refuses these with a 400; a caller in code is clamped. A caller asking for a
    // million rows gets fifty; asking for none gets one; page zero is page one.
    expect(await service.inbox(person('u-a', KPM_A), 1, 10_000)).toMatchObject({ pageSize: 50, total: 3 });
    expect((await service.inbox(person('u-a', KPM_A), 1, 10_000)).items).toHaveLength(3);
    expect(await service.inbox(person('u-a', KPM_A), 0, 0)).toMatchObject({ page: 1, pageSize: 1, total: 3 });
    expect((await service.inbox(person('u-a', KPM_A), 0, 0)).items).toHaveLength(1);
  });

  // ------------------------------------------------------------------ P12.1-T4: pages and unread

  describe('P12.1-T4 the inbox in pages, and an item marked unread again', () => {
    /** `count` rows for `userId`, the newest last, each a minute after the one before; every third read. */
    const many = async (userId: string, count: number, at = (i: number) => new Date(NOW.getTime() + i * 60_000)) => {
      const rows = Array.from({ length: count }, (_, i) => ({
        _id: new mongoose.Types.ObjectId(), userId, kpmId: KPM_A, membershipId: null, templateId: 'join_request.approved',
        payload: {}, delivery: {}, coalesceKey: null, deletedAt: null,
        readAt: i % 3 === 0 ? NOW : null, createdAt: at(i), updatedAt: at(i),
      }));
      // Straight into the collection, so each row keeps the `createdAt` it is given.
      await mongoose.model(Notification.name).collection.insertMany(rows);
      return rows;
    };
    const ids = (items: { notificationId: string }[]) => items.map((i) => i.notificationId);

    it('P12.1-T4 pages of twenty, newest first; a page past the last is empty with the true total; unread counts the whole inbox', async () => {
      const rows = await many('u-a', 45);
      await many('u-b', 5);
      const newestFirst = rows.map((r) => String(r._id)).reverse();
      const unreadInAll = rows.filter((r) => r.readAt === null).length;

      const pages = await Promise.all([1, 2, 3, 4].map((page) => service.inbox(person('u-a', KPM_A), page)));
      expect(pages.map((p) => [p.page, p.pageSize, p.items.length, p.total, p.unread])).toEqual([
        [1, 20, 20, 45, unreadInAll], [2, 20, 20, 45, unreadInAll], [3, 20, 5, 45, unreadInAll], [4, 20, 0, 45, unreadInAll],
      ]);
      // Every item once, in order, across the pages: nothing skipped or repeated at a boundary.
      expect(pages.flatMap((p) => ids(p.items))).toEqual(newestFirst);
      // The default is page one of twenty.
      expect(ids((await service.inbox(person('u-a', KPM_A))).items)).toEqual(newestFirst.slice(0, 20));
      // A page far past the last is empty, never an error, whatever its number.
      await expect(service.inbox(person('u-a', KPM_A), Number.MAX_SAFE_INTEGER, 50))
        .resolves.toMatchObject({ items: [], total: 45, unread: unreadInAll });
    });

    it('P12.1-T4 notices written in one millisecond keep their places: ties are broken by id, newest first', async () => {
      const rows = await many('u-a', 7, () => NOW);
      const byIdDesc = rows.map((r) => String(r._id)).sort().reverse();
      const [first, second] = await Promise.all([1, 2].map((page) => service.inbox(person('u-a', KPM_A), page, 4)));
      expect([...ids(first.items), ...ids(second.items)]).toEqual(byIdDesc);
    });

    it('P12.1-T4 the total counts only the reader’s inbox: not another person’s, not email-only, not deleted', async () => {
      await many('u-a', 3);
      await seed('u-b', KPM_A);
      await seed('u-a', KPM_A, null, 'auth.password_reset');
      await mongoose.model(Notification.name).create({
        userId: 'u-a', kpmId: KPM_A, membershipId: null, templateId: 'join_request.approved',
        payload: {}, delivery: {}, readAt: null, deletedAt: NOW,
      });
      expect(await service.inbox(person('u-a', KPM_A))).toMatchObject({ total: 3, unread: 2 });
    });

    it('P12.1-T4 a page is read off the inbox index, newest first, with no sort in memory', async () => {
      await many('u-a', 45);
      await many('u-b', 45);
      const plan = await mongoose.model(Notification.name)
        .find({ userId: 'u-a', deletedAt: null, templateId: { $in: ['join_request.approved'] } })
        .sort({ createdAt: -1, _id: -1 }).skip(20).limit(20)
        .explain('queryPlanner');
      const winning = JSON.stringify((plan as unknown as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan);
      expect(winning).toContain('userId_1_deletedAt_1_createdAt_-1__id_-1');
      expect(winning).not.toContain('"stage":"SORT"');
    });

    it('P12.1-T4 marking one unread counts it again; pressing twice settles', async () => {
      const n = await seed('u-a', KPM_A, NOW);
      await seed('u-a', KPM_A);

      const after = await service.markUnread(person('u-a', KPM_A), String(n._id));
      expect(after).toEqual({ notificationId: String(n._id), readAt: null, unread: 2 });
      await expect(service.markUnread(person('u-a', KPM_A), String(n._id))).resolves.toEqual(after);
      expect((await service.inbox(person('u-a', KPM_A))).items.find((i) => i.notificationId === String(n._id))?.readAt)
        .toBeNull();

      // And read again, at the moment it is read this time.
      clock.advance(60_000);
      await expect(service.markRead(person('u-a', KPM_A), String(n._id))).resolves.toEqual({
        notificationId: String(n._id), readAt: new Date(NOW.getTime() + 60_000).toISOString(), unread: 1,
      });
    });

    it('P12.1-T4 marking unread 404s somebody else’s, in the same office or another, and leaves it as it was', async () => {
      const sameOffice = await seed('u-b', KPM_A, NOW);
      const otherOffice = await seed('u-c', KPM_B, NOW);
      for (const theirs of [sameOffice, otherOffice]) {
        await expect(service.markUnread(person('u-a', KPM_A), String(theirs._id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(service.markRead(person('u-a', KPM_A), String(theirs._id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
      expect((await service.inbox(person('u-b', KPM_A))).unread).toBe(0);
      expect((await service.inbox(person('u-c', KPM_B))).unread).toBe(0);
    });

    it('P12.1-T4 marking 404s what is not an item of the reader’s inbox: malformed, email-only, deleted, nobody’s', async () => {
      const emailOnly = await seed('u-a', KPM_A, null, 'auth.email_verification');
      const deleted = await mongoose.model(Notification.name).create({
        userId: 'u-a', kpmId: KPM_A, membershipId: null, templateId: 'join_request.approved',
        payload: {}, delivery: {}, readAt: NOW, deletedAt: NOW,
      });
      const nobodys = new mongoose.Types.ObjectId().toString();
      for (const id of ['not-an-id', String(emailOnly._id), String(deleted._id), nobodys]) {
        await expect(service.markUnread(person('u-a', KPM_A), id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(service.markRead(person('u-a', KPM_A), id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
    });

    it('P12.1-T4 a read-only support session reads the inbox but marks nothing, read or unread', async () => {
      const n = await seed('u-a', KPM_A);
      const supporting = new RequestContext(
        'u-a', 'none', person('u-a', KPM_A).membership, 'u-support', null, false, true,
      );
      await expect(service.inbox(supporting)).resolves.toMatchObject({ total: 1, unread: 1 });
      for (const mark of [
        () => service.markRead(supporting, String(n._id)),
        () => service.markUnread(supporting, String(n._id)),
        () => service.markAllRead(supporting),
      ]) {
        await expect(mark()).rejects.toMatchObject({ code: 'PERM_DENIED' });
      }
      expect((await service.inbox(person('u-a', KPM_A))).unread).toBe(1);
    });

    it('P12.1-T4 a person in no office pages, marks and unmarks their own', async () => {
      const n = await seed('u-new', null);
      const nobody = person('u-new', null);
      await expect(service.inbox(nobody)).resolves.toMatchObject({ total: 1, unread: 1, page: 1, pageSize: 20 });
      await expect(service.markRead(nobody, String(n._id))).resolves.toMatchObject({ unread: 0 });
      await expect(service.markUnread(nobody, String(n._id))).resolves.toMatchObject({ readAt: null, unread: 1 });
      await expect(service.markAllRead(nobody)).resolves.toEqual({ unread: 0 });
    });
  });
});
