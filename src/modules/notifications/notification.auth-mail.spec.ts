import { Logger } from '@nestjs/common';
import { FixedClock } from '@/common/clock/clock.port';
import { NotificationRepository } from './notification.repository';
import { NotificationService, providerAnswerOf, TemplateRenderer } from './notification.service';
import {
  AUTH_TEMPLATES, DeliveryReceipt, isAuthTemplate, NotificationChannel, NotificationChannelAdapter, NotificationTemplate,
  RenderedMessage, SendRequest, TEMPLATE_CHANNELS,
} from './notification.types';
import { ResendError } from './resend-client';

class StubRenderer extends TemplateRenderer {
  render(templateId: string): RenderedMessage {
    return { subject: `subject:${templateId}`, body: `body:${templateId}` };
  }
}

class EmailAdapter extends NotificationChannelAdapter {
  readonly channel: NotificationChannel = 'email';
  sent: SendRequest[] = [];
  constructor(private readonly refusal?: Error) {
    super();
  }
  async send(to: SendRequest): Promise<void> {
    if (this.refusal) throw this.refusal;
    this.sent.push(to);
  }
}

/** An email adapter that answers the provider's id for each message, as Resend's does (P19.12-T1). */
class ReceiptAdapter extends NotificationChannelAdapter {
  readonly channel: NotificationChannel = 'email';
  async send(): Promise<DeliveryReceipt> {
    return { providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' };
  }
}

/** What nodemailer throws when Gmail refuses the login: the server's reply and its code on the error. */
function gmailRefusal(): Error {
  return Object.assign(new Error('Invalid login'), {
    code: 'EAUTH', responseCode: 535, response: '535-5.7.8 Username and Password not accepted.',
  });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

type Row = { _id: string; templateId: string; delivery: Record<string, Record<string, unknown>> };

function makeService(adapters: NotificationChannelAdapter[], prefs: Record<string, unknown> | null) {
  const created: Row[] = [];
  const notifications = {
    create: jest.fn(async (d: Record<string, unknown>) => {
      const row = { ...d, _id: `n${created.length + 1}` } as unknown as Row;
      created.push(row);
      return row;
    }),
    updateOne: jest.fn((filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => ({
      exec: async () => {
        const row = created.find((r) => r._id === filter._id)!;
        const [[path, value]] = Object.entries(update.$set);
        row.delivery[path.split('.')[1]] = value as Record<string, unknown>;
        return { matchedCount: 1 };
      },
    })),
  };
  const preferences = { findOne: jest.fn(() => ({ exec: async () => prefs })) };
  const service = new NotificationService(
    notifications as never,
    new NotificationRepository(notifications as never),
    preferences as never,
    new StubRenderer(),
    new FixedClock(new Date('2026-11-04T00:00:00Z')),
    { record: async () => undefined } as never,
    adapters,
  );
  return { service, created, preferences };
}

/**
 * **The account's own mail** (P19-T1; UI-163, ADR-0190 §5): sent whatever the recipient chose for notification email
 * (AC-6), and every send's outcome recorded on its row and logged — a failure with what the provider answered (AC-7).
 */
describe('P19-T1 the account’s own mail', () => {
  afterEach(() => jest.restoreAllMocks());

  /** A recipient who turned notification email off, and muted every template besides. */
  const OPTED_OUT = { optedOutChannels: ['email'], mutedTemplates: [...AUTH_TEMPLATES, NotificationTemplate.JOIN_REQUEST_APPROVED] };

  it('P19-T1 AC-6 names verification, reset, the password changed and the email change as the account’s own, all email only', () => {
    expect([...AUTH_TEMPLATES].sort()).toEqual([
      // P19.2-T1 AC-8 (ADR-0199 §2): a linked login's link and its two notices are the account's own mail too.
      'auth.account_link_request', 'auth.account_link_requested', 'auth.account_linked',
      'auth.email_change_requested', 'auth.email_change_verification', 'auth.email_verification',
      'auth.password_changed', 'auth.password_reset',
    ]);
    for (const id of AUTH_TEMPLATES) expect(TEMPLATE_CHANNELS[id]).toEqual(['email']);
    expect(isAuthTemplate(NotificationTemplate.JOIN_REQUEST_APPROVED)).toBe(false);
  });

  it.each(AUTH_TEMPLATES)('P19-T1 AC-6 sends %s although the recipient turned notification email off', async (templateId) => {
    const email = new EmailAdapter();
    const { service, created, preferences } = makeService([email], OPTED_OUT);

    await service.send({ userId: 'u1', templateId, payload: { token: 't' } });
    await flush();

    expect(email.sent).toHaveLength(1);
    expect(created[0].delivery.email).toEqual({ status: 'sent', at: expect.any(Date) });
    // Not even read: the choices are about notices.
    expect(preferences.findOne).not.toHaveBeenCalled();
  });

  it('P19-T1 AC-6 still honours the opt-out for a notice', async () => {
    const email = new EmailAdapter();
    const { service, created } = makeService([email], { optedOutChannels: ['email'] });

    await service.send({ userId: 'u1', templateId: NotificationTemplate.MEMBER_REMOVED, payload: {} });
    await flush();

    expect(email.sent).toHaveLength(0);
    expect(created[0].delivery.email).toEqual({ status: 'suppressed', at: expect.any(Date) });
  });

  it('P19-T1 AC-7 records a sent auth mail on its row and logs it, naming the template and the row', async () => {
    const logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, created } = makeService([new EmailAdapter()], null);

    await service.send({ userId: 'u1', templateId: NotificationTemplate.PASSWORD_RESET, payload: { token: 'secret-token' } });
    await flush();

    expect(created[0].delivery.email).toEqual({ status: 'sent', at: expect.any(Date) });
    expect(logged).toHaveBeenCalledWith(
      { templateId: 'auth.password_reset', notificationId: 'n1', channel: 'email', status: 'sent' }, 'auth mail sent',
    );
    // Never the token.
    expect(JSON.stringify(logged.mock.calls)).not.toContain('secret-token');
  });

  it('P19-T1 AC-7 records a refused send as failed with the provider’s answer, and logs it at error level', async () => {
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, created } = makeService([new EmailAdapter(gmailRefusal())], null);

    await service.send({ userId: 'u1', templateId: NotificationTemplate.PASSWORD_CHANGED, payload: { fullName: 'Rina' } });
    await flush();

    const error = 'Invalid login (535-5.7.8 Username and Password not accepted.)';
    expect(created[0].delivery.email).toEqual({ status: 'failed', at: expect.any(Date), error });
    expect(errors).toHaveBeenCalledWith(
      { templateId: 'auth.password_changed', notificationId: 'n1', channel: 'email', status: 'failed', error },
      'auth mail not sent',
    );
    // The adapter's failure itself, with the reply's code and nodemailer's kind beside it.
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', code: 'EAUTH', responseCode: 535 }), 'delivery failed',
    );
  });

  it('P19.12-T1 AC-2 records Resend\'s message id on the row, and logs it with the sent line', async () => {
    const logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, created } = makeService([new ReceiptAdapter()], null);

    await service.send({ userId: 'u1', templateId: NotificationTemplate.EMAIL_VERIFICATION, payload: { token: 'secret-token' } });
    await flush();

    expect(created[0].delivery.email).toEqual({
      status: 'sent', at: expect.any(Date), providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794',
    });
    expect(logged).toHaveBeenCalledWith(
      {
        templateId: 'auth.email_verification', notificationId: 'n1', channel: 'email', status: 'sent',
        providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794',
      },
      'auth mail sent',
    );
    expect(JSON.stringify(logged.mock.calls)).not.toContain('secret-token');
  });

  it('P19.12-T1 AC-2 records a Resend refusal as it records an SMTP reply: its words, its name and its status', async () => {
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const refusal = new ResendError(
      'Resend answered 403 validation_error: The notify.agencyboost.id domain is not verified.',
      'validation_error', 403, 'The notify.agencyboost.id domain is not verified.',
    );
    const { service, created } = makeService([new EmailAdapter(refusal)], null);

    await service.send({ userId: 'u1', templateId: NotificationTemplate.PASSWORD_RESET, payload: { token: 't' } });
    await flush();

    const error = 'Resend answered 403 validation_error: The notify.agencyboost.id domain is not verified.';
    expect(created[0].delivery.email).toEqual({ status: 'failed', at: expect.any(Date), error });
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', code: 'validation_error', responseCode: 403 }), 'delivery failed',
    );
  });

  it('P19-T1 AC-7 records and logs a mail that had no way out at all: no email adapter', async () => {
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, created } = makeService([], null);

    await service.send({ userId: 'u1', templateId: NotificationTemplate.EMAIL_VERIFICATION, payload: { token: 't' } });

    expect(created[0].delivery.email).toEqual({ status: 'failed', at: expect.any(Date), error: 'no adapter' });
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'auth.email_verification', status: 'failed', error: 'no adapter' }),
      'auth mail not sent',
    );
  });

  it('P19-T1 AC-7 logs no outcome line for a notice: that is the auth mail’s', async () => {
    const logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service } = makeService([new EmailAdapter()], null);
    await service.send({ userId: 'u1', templateId: NotificationTemplate.MEMBER_REMOVED, payload: {} });
    await flush();
    expect(logged.mock.calls.filter(([, message]) => String(message).startsWith('auth mail'))).toEqual([]);
  });

  describe('providerAnswerOf', () => {
    it('P19-T1 AC-7 adds the reply where the message does not quote it, and never twice', () => {
      expect(providerAnswerOf(gmailRefusal())).toEqual({
        error: 'Invalid login (535-5.7.8 Username and Password not accepted.)',
        code: 'EAUTH', responseCode: 535, response: '535-5.7.8 Username and Password not accepted.',
      });
      const quoted = Object.assign(new Error('Message failed: 550 5.1.1 No such user'), { response: '550 5.1.1 No such user' });
      expect(providerAnswerOf(quoted).error).toBe('Message failed: 550 5.1.1 No such user');
      expect(providerAnswerOf(new Error('connect ETIMEDOUT'))).toEqual({ error: 'connect ETIMEDOUT' });
      expect(providerAnswerOf('refused')).toEqual({ error: 'refused' });
    });
  });
});
