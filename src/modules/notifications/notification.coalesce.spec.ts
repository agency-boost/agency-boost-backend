import { Logger } from '@nestjs/common';
import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { startMongo, stopMongo, syncIndexes, clearCollections } from '../../../test/mongo';
import {
  Notification, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from './notification.schema';
import { NotificationRepository } from './notification.repository';
import { NotificationService, TemplateRenderer } from './notification.service';
import {
  NotificationChannel, NotificationChannelAdapter, NotificationTemplate, RenderedMessage, SendRequest,
} from './notification.types';

const NOW = new Date('2026-09-14T03:00:00Z');
const KPM = new mongoose.Types.ObjectId().toString();
const KEY = 'session-1:0';

/** Renders the payload into the body, so a test can read which value an email carried. */
class PayloadRenderer extends TemplateRenderer {
  render(templateId: string, payload: Record<string, unknown>): RenderedMessage {
    return { subject: templateId, body: JSON.stringify(payload) };
  }
}

class RecordingAdapter extends NotificationChannelAdapter {
  sent: { to: SendRequest; rendered: RenderedMessage }[] = [];
  fail = false;
  constructor(readonly channel: NotificationChannel) {
    super();
  }
  async send(to: SendRequest, rendered: RenderedMessage): Promise<void> {
    if (this.fail) throw new Error('smtp unavailable');
    this.sent.push({ to, rendered });
  }
}

/**
 * **One notice for several writes, emailed once** (P11-T8; `functional/coaching.md`, *One notice per
 * session*): `NotificationService.sendCoalesced` and `releaseHeld`, on the real collection and its unique
 * index, with recording adapters for both channels.
 */
describe('a coalesced notice (P11-T8)', () => {
  let service: NotificationService;
  let inApp: RecordingAdapter;
  let email: RecordingAdapter;
  let clock: FixedClock;
  const rows = () => mongoose.model(Notification.name).find({}).lean().exec() as Promise<Record<string, unknown>[]>;
  const prefs = (over: Record<string, unknown>) =>
    mongoose.model(NotificationPreferences.name).create({ userId: 'u-coachee', ...over });
  const goalSet = (annualApeTargetMinor: number, coalesceKey = KEY) => service.sendCoalesced({
    userId: 'u-coachee', kpmId: KPM, membershipId: 'm-coachee', coalesceKey,
    templateId: NotificationTemplate.GOAL_SET_BY_LEADER,
    payload: { byName: 'Agus Salim', period: '2026', annualApeTargetMinor },
  });
  const release = (coalesceKey = KEY) => service.releaseHeld(KPM, coalesceKey, NotificationTemplate.GOAL_SET_BY_LEADER);

  beforeAll(async () => {
    await startMongo();
    mongoose.model(Notification.name, NotificationSchema);
    mongoose.model(NotificationPreferences.name, NotificationPreferencesSchema);
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    clock = new FixedClock(NOW);
    inApp = new RecordingAdapter('in_app');
    email = new RecordingAdapter('email');
    service = new NotificationService(
      mongoose.model(Notification.name) as never,
      new NotificationRepository(mongoose.model(Notification.name) as never),
      mongoose.model(NotificationPreferences.name) as never,
      new PayloadRenderer(),
      clock,
      [inApp, email],
    );
  });

  it('P11-T8 AC-4 the first write delivers it in-app at once and holds its email', async () => {
    await goalSet(500);

    const [row] = await rows();
    expect(row).toMatchObject({
      kpmId: KPM, userId: 'u-coachee', membershipId: 'm-coachee', coalesceKey: KEY,
      templateId: NotificationTemplate.GOAL_SET_BY_LEADER, readAt: null,
      payload: { byName: 'Agus Salim', period: '2026', annualApeTargetMinor: 500 },
      delivery: { in_app: { status: 'sent', at: NOW }, email: { status: 'held', at: NOW } },
    });
    expect(inApp.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(0);
  });

  it('P11-T8 AC-4 a later write updates the same notice to the last value and marks it unread again; finalize emails it once', async () => {
    await goalSet(500);
    await mongoose.model(Notification.name).updateMany({}, { $set: { readAt: NOW } });
    clock.advance(60_000);
    await goalSet(600);
    await goalSet(700);

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ readAt: null, payload: { annualApeTargetMinor: 700 }, delivery: { email: { status: 'held' } } });
    expect(inApp.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(0);

    await release();
    await release();

    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toMatchObject({ userId: 'u-coachee', membershipId: 'm-coachee', templateId: NotificationTemplate.GOAL_SET_BY_LEADER });
    expect(JSON.parse(email.sent[0].rendered.body)).toMatchObject({ annualApeTargetMinor: 700 });
    expect((await rows())[0].delivery).toEqual({
      in_app: { status: 'sent', at: NOW }, email: { status: 'sent', at: new Date(NOW.getTime() + 60_000) },
    });
  });

  it('P11-T8 AC-4 a new round is a new notice: a correction’s saves are emailed when the correction is finalized', async () => {
    await goalSet(500, 'session-1:0');
    await release('session-1:0');
    await goalSet(800, 'session-1:1');

    const all = await rows();
    expect(all.map((r) => [r.coalesceKey, (r.delivery as Record<string, { status: string }>).email.status]).sort())
      .toEqual([['session-1:0', 'sent'], ['session-1:1', 'held']]);
    // A key with nothing held is a no-op, and so is one nobody wrote.
    await release('session-1:0');
    await release('nobody:0');
    expect(email.sent).toHaveLength(1);
  });

  it('P11-T8 AC-4 two first writes racing in one round write one notice', async () => {
    await Promise.all([goalSet(500), goalSet(600)]);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect([500, 600]).toContain((all[0].payload as Record<string, number>).annualApeTargetMinor);
  });

  it('P11-T8 the recipient’s choices apply: a muted template writes nothing; an opted-out email is suppressed, not held', async () => {
    await prefs({ mutedTemplates: [NotificationTemplate.GOAL_SET_BY_LEADER] });
    await goalSet(500);
    expect(await rows()).toHaveLength(0);

    await mongoose.model(NotificationPreferences.name).updateOne(
      { userId: 'u-coachee' }, { $set: { mutedTemplates: [], optedOutChannels: ['email'] } },
    );
    await goalSet(500);
    expect((await rows())[0].delivery).toMatchObject({ email: { status: 'suppressed' } });
    await release();
    expect(email.sent).toHaveLength(0);
  });

  it('P11-T8 choices made while the session was open apply when the held email would go', async () => {
    await goalSet(500);
    await prefs({ optedOutChannels: ['email'] });
    await release();
    expect((await rows())[0].delivery).toMatchObject({ email: { status: 'suppressed' } });

    await clearCollections();
    await goalSet(500);
    await prefs({ mutedTemplates: [NotificationTemplate.GOAL_SET_BY_LEADER] });
    await release();
    expect((await rows())[0].delivery).toMatchObject({ email: { status: 'suppressed' } });
    expect(email.sent).toHaveLength(0);
  });

  it('P11-T8 a failing adapter is recorded and logged, and never thrown; no adapter is a failure too', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await goalSet(500);
      email.fail = true;
      await expect(release()).resolves.toBeUndefined();
      expect((await rows())[0].delivery).toMatchObject({ email: { status: 'failed', error: 'smtp unavailable' } });
      expect(logged).toHaveBeenCalled();

      await clearCollections();
      service = new NotificationService(
        mongoose.model(Notification.name) as never, new NotificationRepository(mongoose.model(Notification.name) as never),
        mongoose.model(NotificationPreferences.name) as never, new PayloadRenderer(), clock, [inApp],
      );
      await goalSet(500);
      await release();
      expect((await rows())[0].delivery).toMatchObject({ email: { status: 'failed', error: 'no adapter' } });
    } finally {
      logged.mockRestore();
    }
  });

  it('P11-T8 a write that fails for any other reason than the race is the caller’s to contain', async () => {
    // The insert goes through the tenant repository, which saves a new document (N3).
    const create = jest.spyOn(mongoose.model(Notification.name).prototype, 'save').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(goalSet(500)).rejects.toThrow('disk full');
    } finally {
      create.mockRestore();
    }
  });

  it('P11-T8 a notice that is one per write keeps no key, and its email goes at once, as before', async () => {
    await service.send({
      userId: 'u-coachee', kpmId: KPM, membershipId: 'm-coachee',
      templateId: NotificationTemplate.GOAL_SET_BY_LEADER, payload: { byName: 'Agus Salim', period: '2026' },
    });
    const [row] = await rows();
    expect(row).toMatchObject({ coalesceKey: null, delivery: { in_app: { status: 'sent' }, email: { status: 'sent' } } });
    expect(email.sent).toHaveLength(1);
  });

  /*
   * Phase 11 exit review, N3: a coalesced notice always concerns an office, so its writes go through the
   * tenant repository — the office injected, never written into a filter by hand.
   */
  describe('N3 the coalesced writes are the office’s, through the tenant repository', () => {
    const OTHER = new mongoose.Types.ObjectId().toString();
    const elsewhere = (annualApeTargetMinor: number) => service.sendCoalesced({
      userId: 'u-coachee', kpmId: OTHER, membershipId: 'm-elsewhere', coalesceKey: KEY,
      templateId: NotificationTemplate.GOAL_SET_BY_LEADER,
      payload: { byName: 'Lina Marlina', period: '2026', annualApeTargetMinor },
    });
    const byOffice = async () => Object.fromEntries((await rows()).map((r) => [String(r.kpmId), r]));

    it('N3 another office’s notice under the same key is a notice of its own: never refreshed, never released', async () => {
      await goalSet(500);
      await elsewhere(900);
      await mongoose.model(Notification.name).updateMany({}, { $set: { readAt: NOW } });

      await goalSet(600);
      await release();

      const notices = await byOffice();
      expect(Object.keys(notices).sort()).toEqual([KPM, OTHER].sort());
      expect(notices[KPM]).toMatchObject({ readAt: null, payload: { annualApeTargetMinor: 600 }, delivery: { email: { status: 'sent' } } });
      // The other office's is as it was: read, its own value, its email still held.
      expect(notices[OTHER]).toMatchObject({ readAt: NOW, payload: { annualApeTargetMinor: 900 }, delivery: { email: { status: 'held' } } });
      expect(email.sent).toHaveLength(1);
      expect(JSON.parse(email.sent[0].rendered.body)).toMatchObject({ annualApeTargetMinor: 600 });
    });

    it('N3 a notice written through the repository is scoped the moment it exists: the office, and not deleted', async () => {
      await goalSet(500);
      expect((await rows())[0]).toMatchObject({ kpmId: KPM, deletedAt: null });
    });

    it('N3 a soft-deleted notice is neither refreshed nor released', async () => {
      await goalSet(500);
      await mongoose.model(Notification.name).updateMany({}, { $set: { deletedAt: NOW } });

      await release();
      expect(email.sent).toHaveLength(0);
      expect((await rows())[0].delivery).toMatchObject({ email: { status: 'held' } });
    });

    it('N3 the repository fails closed with no office to scope to', async () => {
      const repository = new NotificationRepository(mongoose.model(Notification.name) as never);
      const nowhere = RequestContext.platform('root');
      const key = { userId: 'u-coachee', coalesceKey: KEY, templateId: NotificationTemplate.GOAL_SET_BY_LEADER };

      await expect(repository.refreshCoalesced(nowhere, key, {})).rejects.toBeInstanceOf(MissingTenantContextError);
      await expect(repository.claimHeld(nowhere, key, 'email', NOW)).rejects.toBeInstanceOf(MissingTenantContextError);
      await expect(repository.recordDelivery(nowhere, new mongoose.Types.ObjectId().toString(), 'email', { status: 'sent' }))
        .rejects.toBeInstanceOf(MissingTenantContextError);
    });
  });
});
