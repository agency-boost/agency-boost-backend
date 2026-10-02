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
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';

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

  beforeAll(async () => {
    await startMongo();
    const model = mongoose.model(Notification.name, NotificationSchema);
    service = new NotificationService(
      model as never,
      new NotificationRepository(model as never),
      mongoose.model(NotificationPreferences.name, NotificationPreferencesSchema) as never,
      new StubRenderer(),
      new FixedClock(NOW),
      [],
    );
  });
  afterAll(stopMongo);
  beforeEach(clearCollections);

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
    const after = await service.markRead(person('u-a', KPM_A), String(n._id));

    expect(after.unread).toBe(0);
    expect(after.items[0].readAt).toBe(NOW.toISOString());
  });

  it('AC-2: marking one twice settles rather than complaining', async () => {
    const n = await seed('u-a', KPM_A);
    await service.markRead(person('u-a', KPM_A), String(n._id));
    await expect(service.markRead(person('u-a', KPM_A), String(n._id))).resolves.toMatchObject({
      unread: 0,
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

    expect((await service.markAllRead(person('u-a', KPM_A))).unread).toBe(0);
    expect((await service.inbox(person('u-b', KPM_A))).unread).toBe(1);
  });

  it('clamps the page size rather than trusting it', async () => {
    for (let i = 0; i < 3; i += 1) await seed("u-a", KPM_A);
    // A caller asking for a million rows gets a hundred; asking for none gets one. The
    // ceiling is the reader's own inbox either way, so this is about the response size,
    // not about what they may see.
    expect((await service.inbox(person('u-a', KPM_A), 10_000)).items).toHaveLength(3);
    expect((await service.inbox(person('u-a', KPM_A), 0)).items).toHaveLength(1);
  });
});
