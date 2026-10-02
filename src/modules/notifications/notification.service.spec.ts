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

function makeService(opts: {
  adapters: NotificationChannelAdapter[];
  prefs?: { optedOutChannels?: NotificationChannel[]; mutedTemplates?: string[] } | null;
}) {
  const created: Record<string, unknown>[] = [];
  const notifications = { create: jest.fn(async (d: Record<string, unknown>) => { created.push(d); return d; }) };
  const preferences = { findOne: () => ({ exec: async () => opts.prefs ?? null }) };
  const service = new NotificationService(
    notifications as never,
    new NotificationRepository(notifications as never),
    preferences as never,
    new StubRenderer(),
    new FixedClock(new Date('2026-09-04T00:00:00Z')),
    opts.adapters,
  );
  return { service, created };
}

describe('NotificationService', () => {
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
    const inApp = new RecordingAdapter('in_app');
    const email = new RecordingAdapter('email', true);
    const { service, created } = makeService({ adapters: [inApp, email] });

    await expect(
      service.send({
        userId: 'u1', templateId: NotificationTemplate.JOIN_REQUEST_APPROVED, payload: {},
      }),
    ).resolves.toBeUndefined();

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
});
