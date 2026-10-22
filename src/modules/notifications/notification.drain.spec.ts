import { Logger } from '@nestjs/common';
import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import {
  Notification, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from './notification.schema';
import { NotificationRepository } from './notification.repository';
import { NOTIFICATION_DRAIN_TIMEOUT_MS, NotificationService, TemplateRenderer } from './notification.service';
import {
  NotificationChannel, NotificationChannelAdapter, NotificationTemplate, RenderedMessage, SendRequest,
} from './notification.types';

const NOW = new Date('2026-10-19T03:00:00Z');
const KPM = new mongoose.Types.ObjectId().toString();

class StubRenderer extends TemplateRenderer {
  render(templateId: string): RenderedMessage {
    return { subject: templateId, body: '' };
  }
}

class InstantAdapter extends NotificationChannelAdapter {
  constructor(readonly channel: NotificationChannel) {
    super();
  }
  async send(): Promise<void> {
    return undefined;
  }
}

/** A mail server that answers only when told to, or never. */
class GatedEmail extends NotificationChannelAdapter {
  readonly channel: NotificationChannel = 'email';
  sent: SendRequest[] = [];
  private gate: Promise<void> | null = null;
  private opener: (() => void) | null = null;
  hang(): void {
    this.gate = new Promise<void>((resolve) => { this.opener = resolve; });
  }
  open(): void {
    this.opener?.();
  }
  async send(to: SendRequest): Promise<void> {
    if (this.gate) await this.gate;
    this.sent.push(to);
  }
}

type Doc = { _id: unknown; delivery: Record<string, { status: string }> };

/**
 * **A deploy waits for the email a save just started** (P18.7-T1, ADR-0152). A save answers before its
 * email is sent (P12.1-T1), so a SIGTERM a second after a registration found the send in flight; Node
 * exited, and the row stayed `pending` for good. The shutdown now waits for it, bounded: `drain`, which
 * `GracefulShutdown` calls once the HTTP server has stopped (`src/graceful-shutdown.int.spec.ts` drives that
 * order). On the real collection, because the wait is only worth anything if the outcome is recorded before
 * the database closes.
 */
describe('notifications: the drain at shutdown (P18.7-T1)', () => {
  let service: NotificationService;
  let email: GatedEmail;
  const rows = () => mongoose.model(Notification.name).find({}).sort({ _id: 1 }).lean().exec() as unknown as Promise<Doc[]>;
  const register = (userId: string) => service.send({
    userId, templateId: NotificationTemplate.EMAIL_VERIFICATION, payload: { token: 't', fullName: 'Rina' },
  });

  beforeAll(async () => {
    await startMongo();
    mongoose.model(Notification.name, NotificationSchema);
    mongoose.model(NotificationPreferences.name, NotificationPreferencesSchema);
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    // The drain says when it starts waiting; that line is for an operator, not for this output.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    email = new GatedEmail();
    service = new NotificationService(
      mongoose.model(Notification.name) as never,
      new NotificationRepository(mongoose.model(Notification.name) as never),
      mongoose.model(NotificationPreferences.name) as never,
      new StubRenderer(),
      new FixedClock(NOW),
      { record: async () => undefined } as never,
      [new InstantAdapter('in_app'), email],
    );
  });

  afterEach(() => {
    email.open();
    jest.restoreAllMocks();
  });

  it('P18.7-T1 waits ten seconds at most, by default', () => {
    expect(NOTIFICATION_DRAIN_TIMEOUT_MS).toBe(10_000);
  });

  it('P18.7-T1 answers at once when nothing is in flight', async () => {
    const started = Date.now();
    await expect(service.drain(5_000)).resolves.toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('P18.7-T1 waits for an email in flight, and its outcome is recorded before the wait ends', async () => {
    email.hang();
    await register('u-rina');
    expect((await rows())[0].delivery.email.status).toBe('pending');

    const shutdown = service.drain(5_000, 'SIGTERM');
    let finished = false;
    void shutdown.then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finished).toBe(false); // still waiting on the relay

    email.open();
    await shutdown;
    expect(email.sent).toHaveLength(1);
    expect((await rows())[0].delivery.email.status).toBe('sent');
  });

  it('P18.7-T1 waits for a held email released just before the signal', async () => {
    await service.sendCoalesced({
      userId: 'u-rina', kpmId: KPM, membershipId: 'm-rina', coalesceKey: 'session-1:1',
      templateId: NotificationTemplate.GOAL_SET_BY_LEADER, payload: { sessionId: 'session-1' },
    });
    email.hang();
    // Released as finalize releases it: started, never awaited.
    void service.releaseHeld(KPM, 'session-1:1', NotificationTemplate.GOAL_SET_BY_LEADER);

    const drained = service.drain(5_000);
    email.open();
    await expect(drained).resolves.toEqual([]);
    expect((await rows())[0].delivery.email.status).toBe('sent');
  });

  it('P18.7-T1 waits for a delivery that starts while it is waiting', async () => {
    email.hang();
    await register('u-rina');
    const drained = service.drain(5_000);
    await register('u-sari'); // a request the server was still finishing
    email.open();
    await expect(drained).resolves.toEqual([]);
    expect((await rows()).map((r) => r.delivery.email.status)).toEqual(['sent', 'sent']);
  });

  it('P18.7-T1 gives up after the timeout rather than hanging, and names what is still pending', async () => {
    const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    email.hang(); // and never opened while the drain waits
    await register('u-rina');
    const [row] = await rows();

    const started = Date.now();
    const pending = await service.drain(100);
    expect(Date.now() - started).toBeLessThan(2_000);

    const expected = [{ templateId: NotificationTemplate.EMAIL_VERIFICATION, channel: 'email', notificationId: String(row._id) }];
    expect(pending).toEqual(expected);
    expect(warned).toHaveBeenCalledWith(
      { pending: expected, timeoutMs: 100 },
      'shutting down with deliveries still in flight; their rows stay pending',
    );
    expect((await rows())[0].delivery.email.status).toBe('pending');
  });

  it('P18.7-T1 a delivery that fails still counts as settled, and the drain ends', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(email, 'send').mockRejectedValue(new Error('Greeting never received'));
    await register('u-rina');
    await expect(service.drain(5_000)).resolves.toEqual([]);
    expect((await rows())[0].delivery.email.status).toBe('failed');
  });

  it('P18.7-T1 a release that fails is still the caller\'s rejection, and the drain is not stuck on it', async () => {
    const failing = new NotificationService(
      mongoose.model(Notification.name) as never,
      { claimHeld: async () => { throw new Error('database gone'); } } as never,
      mongoose.model(NotificationPreferences.name) as never,
      new StubRenderer(),
      new FixedClock(NOW),
      { record: async () => undefined } as never,
      [],
    );
    const release = failing.releaseHeld(KPM, 'session-1:1', NotificationTemplate.GOAL_SET_BY_LEADER);
    await expect(release).rejects.toThrow('database gone');
    await expect(failing.drain(5_000)).resolves.toEqual([]);
  });
});
