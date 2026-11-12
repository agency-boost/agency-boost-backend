import { Logger } from '@nestjs/common';
import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import {
  Notification, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from './notification.schema';
import { NotificationRepository } from './notification.repository';
import { NotificationService, TemplateRenderer } from './notification.service';
import {
  DeliveryReceipt, NotificationChannel, NotificationChannelAdapter, NotificationTemplate, RenderedMessage, SendRequest,
} from './notification.types';

const NOW = new Date('2026-10-03T03:00:00Z');
const KPM = new mongoose.Types.ObjectId().toString();

class StubRenderer extends TemplateRenderer {
  render(templateId: string): RenderedMessage {
    return { subject: templateId, body: '' };
  }
}

/** A channel that answers at once. */
class InstantAdapter extends NotificationChannelAdapter {
  sent: SendRequest[] = [];
  constructor(readonly channel: NotificationChannel) {
    super();
  }
  async send(to: SendRequest): Promise<void> {
    this.sent.push(to);
  }
}

/**
 * A mail server that hangs until it is told to answer, as the dev server's SMTP relay did for ten seconds
 * per invitation. While `gate` is set a send waits on it; once it opens, a send fails with `refusal`, if set.
 */
class HangingEmail extends NotificationChannelAdapter {
  readonly channel: NotificationChannel = 'email';
  sent: SendRequest[] = [];
  calls = 0;
  gate: Promise<void> | null = null;
  refusal: Error | null = null;
  private opener: (() => void) | null = null;
  hang(): void {
    this.gate = new Promise<void>((resolve) => { this.opener = resolve; });
  }
  open(): void {
    this.opener?.();
  }
  async send(to: SendRequest): Promise<void> {
    this.calls += 1;
    if (this.gate) await this.gate;
    if (this.refusal) throw this.refusal;
    this.sent.push(to);
  }
}

/** Resolves with the promise's value, or with `'waited'` if it takes longer than `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'waited'> {
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<'waited'>((resolve) => { timer = setTimeout(() => resolve('waited'), ms); });
  try {
    return await Promise.race([promise, waited]);
  } finally {
    clearTimeout(timer);
  }
}

type Doc = Record<string, unknown> & { delivery: Record<string, Record<string, unknown>> };

/**
 * **A save never waits for an email** (P12.1-T1), on the real collection: `send` writes the inbox row inside
 * the request, starts the email and returns; the email's outcome lands on the row's delivery map when it
 * settles. Measured on the dev server before this: `POST /calendar/entries` with an invitee took 10–11 s,
 * because the SMTP relay timed out while the request waited for it.
 */
describe('notifications: the email leaves after the request (P12.1-T1)', () => {
  let service: NotificationService;
  let inApp: InstantAdapter;
  let email: HangingEmail;
  const rows = () => mongoose.model(Notification.name).find({}).sort({ _id: 1 }).lean().exec() as unknown as Promise<Doc[]>;
  /** The only row once its email reaches `status`. */
  async function emailReaches(status: string): Promise<Doc> {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const [row] = await rows();
      if (row?.delivery.email?.status === status) return row;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`The email never reached ${status}`);
  }
  const invite = () => service.send({
    userId: 'u-rina', kpmId: KPM, membershipId: 'm-rina',
    templateId: NotificationTemplate.CALENDAR_INVITATION, payload: { entryId: 'e1', date: '2026-10-05' },
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
    inApp = new InstantAdapter('in_app');
    email = new HangingEmail();
    service = new NotificationService(
      mongoose.model(Notification.name) as never,
      new NotificationRepository(mongoose.model(Notification.name) as never),
      mongoose.model(NotificationPreferences.name) as never,
      new StubRenderer(),
      new FixedClock(NOW),
      { record: async () => undefined } as never,
      [inApp, email],
    );
  });

  afterEach(() => {
    email.open();
    jest.restoreAllMocks();
  });

  it('P12.1-T1 an email adapter that hangs does not hold send(); the delivery map shows pending, then sent', async () => {
    email.hang();

    // Were send() waiting on the adapter it would never answer: nothing has opened the gate yet.
    expect(await within(invite(), 2_000)).toBeUndefined();

    // The row is written and in the inbox already; the email was asked for once, and is pending on it.
    const [row] = await rows();
    expect(row).toMatchObject({
      userId: 'u-rina', readAt: null, delivery: { in_app: { status: 'sent', at: NOW }, email: { status: 'pending', at: NOW } },
    });
    expect(inApp.sent).toHaveLength(1);
    expect(email.calls).toBe(1);
    expect(email.sent).toHaveLength(0);

    email.open();
    const settled = await emailReaches('sent');
    expect(settled.delivery).toEqual({ in_app: { status: 'sent', at: NOW }, email: { status: 'sent', at: NOW } });
    expect(email.sent).toHaveLength(1);
  });

  it('P19.12-T1 AC-2 a sent email keeps the provider\'s message id on the stored row: the free-form map needs no migration', async () => {
    class ReceiptEmail extends NotificationChannelAdapter {
      readonly channel: NotificationChannel = 'email';
      async send(): Promise<DeliveryReceipt> {
        return { providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' };
      }
    }
    service = new NotificationService(
      mongoose.model(Notification.name) as never,
      new NotificationRepository(mongoose.model(Notification.name) as never),
      mongoose.model(NotificationPreferences.name) as never,
      new StubRenderer(),
      new FixedClock(NOW),
      { record: async () => undefined } as never,
      [inApp, new ReceiptEmail()],
    );

    await invite();
    const settled = await emailReaches('sent');
    expect(settled.delivery).toEqual({
      in_app: { status: 'sent', at: NOW },
      email: { status: 'sent', at: NOW, providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' },
    });
  });

  it('P12.1-T1 a failing adapter records failed, with the error, on the delivery map, and logs at error level', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    email.hang();
    expect(await within(invite(), 2_000)).toBeUndefined();
    await emailReaches('pending');

    email.refusal = new Error('Greeting never received');
    email.open();
    const settled = await emailReaches('failed');
    expect(settled.delivery.email).toEqual({ status: 'failed', at: NOW, error: 'Greeting never received' });
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', templateId: NotificationTemplate.CALENDAR_INVITATION }),
      'delivery failed',
    );
  });

  it('P12.1-T1 each send records on its own row: two invitations waiting on one hanging relay are each recorded where they belong', async () => {
    email.hang();
    await invite();
    await service.send({
      userId: 'u-sari', kpmId: KPM, membershipId: 'm-sari',
      templateId: NotificationTemplate.CALENDAR_INVITATION, payload: { entryId: 'e1', date: '2026-10-05' },
    });
    email.open();
    for (let attempt = 0; attempt < 250; attempt += 1) {
      if ((await rows()).every((r) => r.delivery.email.status === 'sent')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await rows()).map((r) => [r.userId, r.delivery.email.status])).toEqual([['u-rina', 'sent'], ['u-sari', 'sent']]);
  });

  it('P12.1-T1 the coalesced path is unchanged: its email is held, never dispatched by the write, and released once', async () => {
    email.hang();
    await service.sendCoalesced({
      userId: 'u-rina', kpmId: KPM, membershipId: 'm-rina', coalesceKey: 'calendar:e1:m-rina:moved',
      templateId: NotificationTemplate.CALENDAR_ENTRY_CHANGED, payload: { entryId: 'e1', date: '2026-10-05', change: 'moved' },
    });
    expect((await rows())[0].delivery).toEqual({ in_app: { status: 'sent', at: NOW }, email: { status: 'held', at: NOW } });
    expect(email.calls).toBe(0);

    // Released as its callers release it — not awaited — and claimed `pending` while the adapter hangs.
    const released = service.releaseHeld(KPM, 'calendar:e1:m-rina:moved', NotificationTemplate.CALENDAR_ENTRY_CHANGED);
    await emailReaches('pending');
    email.open();
    await released;
    expect((await emailReaches('sent')).delivery.email).toEqual({ status: 'sent', at: NOW });
    expect(email.calls).toBe(1);
  });
});
