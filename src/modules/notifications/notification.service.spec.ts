import { Logger } from '@nestjs/common';
import { FixedClock } from '@/common/clock/clock.port';
import { NotificationRepository } from './notification.repository';
import { NotificationService, TemplateRenderer } from './notification.service';
import {
  NotificationChannel, NotificationChannelAdapter, NotificationTemplate,
  RenderedMessage, SendRequest,
} from './notification.types';

class StubRenderer extends TemplateRenderer {
  render(templateId: string): RenderedMessage {
    return { subject: `subject:${templateId}`, body: `body:${templateId}` };
  }
}

class RecordingAdapter extends NotificationChannelAdapter {
  sent: SendRequest[] = [];
  constructor(readonly channel: NotificationChannel, private readonly fail = false) {
    super();
  }
  async send(to: SendRequest): Promise<void> {
    if (this.fail) throw new Error('smtp unavailable');
    this.sent.push(to);
  }
}

/**
 * A mail server that does not answer until it is told to: `send` waits on the gate, then sends or
 * fails. What the dev server's SMTP relay did for ten seconds per invitation (P12.1-T1).
 */
class HangingAdapter extends NotificationChannelAdapter {
  readonly channel: NotificationChannel = 'email';
  calls = 0;
  sent = 0;
  private open!: (refusal?: Error) => void;
  private readonly gate = new Promise<Error | undefined>((resolve) => { this.open = resolve; });
  async send(): Promise<void> {
    this.calls += 1;
    const refusal = await this.gate;
    if (refusal) throw refusal;
    this.sent += 1;
  }
  answer(refusal?: Error): void {
    this.open(refusal);
  }
}

/** Let every settled promise run its continuations: the dispatched email's outcome, and its recording. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

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

type Row = Record<string, unknown> & { _id: string; delivery: Record<string, Record<string, unknown>> };

function makeService(opts: {
  adapters: NotificationChannelAdapter[];
  prefs?: { optedOutChannels?: NotificationChannel[]; mutedTemplates?: string[] } | null;
  /** The recording write fails: rejecting, or throwing before it returns a query. */
  recording?: 'rejects' | 'throws';
}) {
  const created: Row[] = [];
  /** The delivery map as it was when the row was written, before any outcome was recorded. */
  const written: Record<string, Record<string, unknown>>[] = [];
  const notifications = {
    create: jest.fn(async (d: Record<string, unknown>) => {
      const row = { ...d, _id: `n${created.length + 1}` } as Row;
      // A copy per channel: the recording below replaces a channel's entry, never edits it.
      written.push(Object.fromEntries(Object.entries(row.delivery).map(([channel, entry]) => [channel, { ...entry }])));
      created.push(row);
      return row;
    }),
    /** Applies a `$set` of `delivery.<channel>` to the row the filter names, as the collection would. */
    updateOne: jest.fn((filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
      if (opts.recording === 'throws') throw new Error('recording threw');
      return {
        exec: async () => {
          if (opts.recording === 'rejects') throw new Error('database unavailable');
          const row = created.find((r) => r._id === filter._id);
          const [[path, value]] = Object.entries(update.$set);
          const channel = path.split('.')[1];
          if (!row || row.delivery[channel]?.status !== filter[`${path}.status`]) return { matchedCount: 0 };
          row.delivery[channel] = value as Record<string, unknown>;
          return { matchedCount: 1 };
        },
      };
    }),
  };
  const preferences = { findOne: () => ({ exec: async () => opts.prefs ?? null }) };
  const service = new NotificationService(
    notifications as never,
    new NotificationRepository(notifications as never),
    preferences as never,
    new StubRenderer(),
    new FixedClock(new Date('2026-09-04T00:00:00Z')),
    { record: async () => undefined } as never,
    opts.adapters,
  );
  return { service, created, written, notifications };
}

describe('NotificationService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends a template on every channel it declares', async () => {
    const inApp = new RecordingAdapter('in_app');
    const email = new RecordingAdapter('email');
    const { service, created } = makeService({ adapters: [inApp, email] });

    await service.send({
      userId: 'u1', kpmId: 'kpm-a',
      templateId: NotificationTemplate.JOIN_REQUEST_RECEIVED, payload: { from: 'Rina' },
    });

    expect(inApp.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
    // The email is recorded when it settles, after `send` has resolved (P12.1-T1).
    await flush();
    expect(created[0].delivery).toEqual({
      in_app: { status: 'sent', at: expect.any(Date) },
      email: { status: 'sent', at: expect.any(Date) },
    });
  });

  it('sends an auth template on email only — an in-app message you cannot sign in to see is useless', async () => {
    const inApp = new RecordingAdapter('in_app');
    const email = new RecordingAdapter('email');
    const { service } = makeService({ adapters: [inApp, email] });

    await service.send({
      userId: 'u1', templateId: NotificationTemplate.PASSWORD_RESET, payload: { token: 't' },
    });

    expect(email.sent).toHaveLength(1);
    expect(inApp.sent).toHaveLength(0);
  });

  it('suppresses a channel the recipient opted out of, and records that it did', async () => {
    const inApp = new RecordingAdapter('in_app');
    const email = new RecordingAdapter('email');
    const { service, created } = makeService({
      adapters: [inApp, email], prefs: { optedOutChannels: ['email'] },
    });

    await service.send({
      userId: 'u1', templateId: NotificationTemplate.EVENT_REMINDER, payload: {},
    });

    expect(inApp.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(0);
    expect((created[0].delivery as Record<string, { status: string }>).email.status)
      .toBe('suppressed');
  });

  it('drops a muted template entirely, writing no record', async () => {
    const inApp = new RecordingAdapter('in_app');
    const { service, created } = makeService({
      adapters: [inApp],
      prefs: { mutedTemplates: [NotificationTemplate.EVENT_REMINDER] },
    });

    await service.send({
      userId: 'u1', templateId: NotificationTemplate.EVENT_REMINDER, payload: {},
    });

    expect(inApp.sent).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it('records a channel failure instead of throwing — a bad SMTP must not fail the operation', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const inApp = new RecordingAdapter('in_app');
    const email = new RecordingAdapter('email', true);
    const { service, created } = makeService({ adapters: [inApp, email] });

    await expect(
      service.send({
        userId: 'u1', templateId: NotificationTemplate.JOIN_REQUEST_APPROVED, payload: {},
      }),
    ).resolves.toBeUndefined();

    await flush();
    const delivery = created[0].delivery as Record<string, { status: string; error?: string }>;
    expect(delivery.in_app.status).toBe('sent');
    expect(delivery.email.status).toBe('failed');
    expect(delivery.email.error).toBe('smtp unavailable');
  });

  it('records a missing adapter as failed rather than silently doing nothing', async () => {
    const { service, created } = makeService({ adapters: [new RecordingAdapter('in_app')] });

    await service.send({
      userId: 'u1', templateId: NotificationTemplate.JOIN_REQUEST_RECEIVED, payload: {},
    });

    const delivery = created[0].delivery as Record<string, { status: string; error?: string }>;
    expect(delivery.email).toEqual({
      status: 'failed', at: expect.any(Date), error: 'no adapter',
    });
  });

  it('never persists a live token on the row, because nothing will ever read it (ADR-0019)', async () => {
    /*
     * `authTokens` stores only `tokenHash`, so that reading the database cannot reset
     * somebody's password. The notification row was storing the raw token beside it —
     * and `PASSWORD_RESET` has no `in_app` channel, so the row is never rendered by
     * anything. A plaintext credential at rest, for nobody.
     */
    const { service, created } = makeService({ adapters: [new RecordingAdapter('email')] });

    await service.send({
      userId: 'u1',
      templateId: NotificationTemplate.PASSWORD_RESET,
      payload: { token: 'raw-reset-token', fullName: 'Rina' },
    });

    expect(created[0].payload).toEqual({});
    expect(JSON.stringify(created[0])).not.toContain('raw-reset-token');
    // The delivery record is the point of the row, and it survives.
    expect(created[0].delivery).toHaveProperty('email');
  });

  it('keeps the payload of a row somebody can actually read', async () => {
    // The inbox renders its copy from the payload, so stripping every row would empty it.
    const { service, created } = makeService({ adapters: [new RecordingAdapter('in_app')] });

    await service.send({
      userId: 'u1',
      templateId: NotificationTemplate.JOIN_REQUEST_APPROVED,
      payload: { kpmLabel: 'KPM 0417' },
    });

    expect(created[0].payload).toEqual({ kpmLabel: 'KPM 0417' });
  });

  it('accepts an adapter registered after construction — the WhatsApp seam', async () => {
    const { service } = makeService({ adapters: [] });
    const late = new RecordingAdapter('in_app');
    service.registerAdapter(late);

    await service.send({
      userId: 'u1', templateId: NotificationTemplate.COACHING_SESSION_FINALIZED, payload: {},
    });

    expect(late.sent).toHaveLength(1);
  });

  /*
   * P12.1-T1: an invitation's save took 10–11 s on the dev server, because `send` awaited an SMTP relay
   * that timed out. The inbox row is written inside the request; the email is started at once and
   * recorded when it settles.
   */
  describe('the email is sent after send() has answered (P12.1-T1)', () => {
    it('P12.1-T1 an email adapter that hangs does not hold send(): the row is written, pending; sent when it answers', async () => {
      const inApp = new RecordingAdapter('in_app');
      const email = new HangingAdapter();
      const { service, created, written } = makeService({ adapters: [inApp, email] });

      const answer = await within(service.send({
        userId: 'u1', kpmId: 'kpm-a', templateId: NotificationTemplate.CALENDAR_INVITATION, payload: { entryId: 'e1' },
      }), 1_000);

      // Were send() waiting on the adapter it would never answer: nothing has opened the gate.
      expect(answer).toBeUndefined();
      // The inbox row exists, delivered in-app; the email was started at once, and is pending on it.
      expect(created).toHaveLength(1);
      expect(inApp.sent).toHaveLength(1);
      expect(email.calls).toBe(1);
      expect(written[0]).toEqual({
        in_app: { status: 'sent', at: expect.any(Date) },
        email: { status: 'pending', at: expect.any(Date) },
      });
      await flush();
      expect(created[0].delivery.email).toEqual({ status: 'pending', at: expect.any(Date) });

      email.answer();
      await flush();
      expect(email.sent).toBe(1);
      expect(created[0].delivery).toEqual({
        in_app: { status: 'sent', at: expect.any(Date) },
        email: { status: 'sent', at: expect.any(Date) },
      });
    });

    it('P12.1-T1 an adapter that hangs and then fails: send() has answered; failed, with the error, on the map, and logged', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const email = new HangingAdapter();
      const { service, created } = makeService({ adapters: [new RecordingAdapter('in_app'), email] });

      await expect(within(service.send({
        userId: 'u1', templateId: NotificationTemplate.JOIN_REQUEST_APPROVED, payload: {},
      }), 1_000)).resolves.toBeUndefined();
      expect(created[0].delivery.email.status).toBe('pending');

      email.answer(new Error('Connection timeout'));
      await flush();
      expect(created[0].delivery.email).toEqual({ status: 'failed', at: expect.any(Date), error: 'Connection timeout' });
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'email', templateId: NotificationTemplate.JOIN_REQUEST_APPROVED }),
        'delivery failed',
      );
    });

    it('P12.1-T1 an adapter that throws before it returns a promise is recorded failed and logged, never thrown', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const throwing = {
        channel: 'email',
        send: () => { throw new Error('transport not configured'); },
      } as unknown as NotificationChannelAdapter;
      const { service, created } = makeService({ adapters: [new RecordingAdapter('in_app'), throwing] });

      await expect(service.send({
        userId: 'u1', templateId: NotificationTemplate.JOIN_REQUEST_APPROVED, payload: {},
      })).resolves.toBeUndefined();
      await flush();
      expect(created[0].delivery.email).toEqual({ status: 'failed', at: expect.any(Date), error: 'transport not configured' });
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email' }), 'delivery failed');
    });

    it('P12.1-T1 an email-only template (an auth email) is dispatched the same way: the row first, the email after', async () => {
      const email = new HangingAdapter();
      const { service, created } = makeService({ adapters: [email] });

      await expect(within(service.send({
        userId: 'u1', templateId: NotificationTemplate.PASSWORD_RESET, payload: { token: 't' },
      }), 1_000)).resolves.toBeUndefined();
      expect(email.calls).toBe(1);
      expect(created[0].delivery).toEqual({ email: { status: 'pending', at: expect.any(Date) } });

      email.answer();
      await flush();
      expect(created[0].delivery).toEqual({ email: { status: 'sent', at: expect.any(Date) } });
    });

    it.each(['rejects', 'throws'] as const)(
      'P12.1-T1 a recording that %s is logged at error level, and never reaches the caller',
      async (recording) => {
        const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const email = new RecordingAdapter('email');
        const { service } = makeService({ adapters: [new RecordingAdapter('in_app'), email], recording });

        await expect(service.send({
          userId: 'u1', templateId: NotificationTemplate.JOIN_REQUEST_APPROVED, payload: {},
        })).resolves.toBeUndefined();
        await flush();
        expect(email.sent).toHaveLength(1);
        expect(logged).toHaveBeenCalledWith(
          expect.objectContaining({ channel: 'email', templateId: NotificationTemplate.JOIN_REQUEST_APPROVED }),
          'failed to record a delivery',
        );
      },
    );

    it('P12.1-T1 the recipient’s choices apply as before: an opted-out email is suppressed at once, its adapter never asked', async () => {
      const email = new HangingAdapter();
      const { service, created, notifications } = makeService({
        adapters: [new RecordingAdapter('in_app'), email], prefs: { optedOutChannels: ['email'] },
      });

      await service.send({ userId: 'u1', templateId: NotificationTemplate.CALENDAR_INVITATION, payload: {} });
      await flush();
      expect(email.calls).toBe(0);
      expect(created[0].delivery.email).toEqual({ status: 'suppressed', at: expect.any(Date) });
      // Nothing was dispatched, so nothing is recorded after the row.
      expect(notifications.updateOne).not.toHaveBeenCalled();
    });

    it('P12.1-T1 a missing email adapter is failed on the row as it is written, with nothing dispatched', async () => {
      const { service, written, notifications } = makeService({ adapters: [new RecordingAdapter('in_app')] });
      await service.send({ userId: 'u1', templateId: NotificationTemplate.CALENDAR_INVITATION, payload: {} });
      await flush();
      expect(written[0].email).toEqual({ status: 'failed', at: expect.any(Date), error: 'no adapter' });
      expect(notifications.updateOne).not.toHaveBeenCalled();
    });
  });
});
