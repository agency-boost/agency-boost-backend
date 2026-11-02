import { ConfigService } from '@nestjs/config';

const sendMail = jest.fn();
const verify = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail, verify })),
}));

/* eslint-disable @typescript-eslint/no-var-requires */
// Imported after `jest.mock`, deliberately: the adapter builds its transport in the
// constructor, so the mock has to be in place before the module is evaluated.
import { createTransport } from 'nodemailer';
import { Logger } from '@nestjs/common';
import { RecipientAddressBook, SmtpChannelAdapter } from './smtp.adapter';
import { NotificationTemplate } from './notification.types';
import { toHtml } from './email-html';

function make(env: Record<string, unknown> = {}, address: string | null = 'rina@kpm.test') {
  const values: Record<string, unknown> = {
    SMTP_HOST: 'smtp.test', SMTP_PORT: 587, SMTP_USER: 'u', SMTP_PASSWORD: 'p',
    MAIL_FROM: 'AgencyBoost <no-reply@test>', MAIL_TRANSPORT: 'smtp', ...env,
  };
  const config = {
    get: (k: string) => values[k],
    getOrThrow: (k: string) => values[k],
  } as unknown as ConfigService;
  const book: RecipientAddressBook = { addressOf: async () => address };
  return new SmtpChannelAdapter(config, book);
}

describe('SMTP delivery (P4-T14)', () => {
  const NODE_ENV = process.env.NODE_ENV;
  afterEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = NODE_ENV;
  });

  it('sends the rendered message to the address the account has now', async () => {
    // AC-1. Resolved at send time rather than carried in a payload: a changed address
    // must not be sent the mail its old one would have received.
    const adapter = make();
    await adapter.send(
      { userId: 'u1', templateId: NotificationTemplate.EMAIL_VERIFICATION, payload: {} },
      { subject: 'S', body: 'B' },
    );
    // P18.99-T18: multipart — the text, and the HTML derived from it.
    expect(sendMail).toHaveBeenCalledWith({
      from: 'AgencyBoost <no-reply@test>', to: 'rina@kpm.test', subject: 'S', text: 'B', html: toHtml('B'),
    });
  });

  it('UI-111 sends an email change’s link to the address being proved, not the one the account has (ADR-0181)', async () => {
    const adapter = make();
    await adapter.send(
      {
        userId: 'u1', templateId: NotificationTemplate.EMAIL_CHANGE_VERIFICATION, payload: {}, toAddress: 'rina.baru@kpm.test',
      },
      { subject: 'S', body: 'B' },
    );
    expect(sendMail).toHaveBeenCalledWith({
      from: 'AgencyBoost <no-reply@test>', to: 'rina.baru@kpm.test', subject: 'S', text: 'B', html: toHtml('B'),
    });
  });

  it('refuses to send to nobody, loudly enough to be recorded', async () => {
    // The service turns a throw into `failed` with this reason on it, which is the audit
    // trail wanted. Silently doing nothing would record a success that never happened.
    const adapter = make({}, null);
    await expect(adapter.send(
      { userId: 'u1', templateId: NotificationTemplate.PASSWORD_RESET, payload: {} },
      { subject: 'S', body: 'B' },
    )).rejects.toThrow('no email address for user u1');
    expect(sendMail).not.toHaveBeenCalled();
  });

  describe('the provider the environment names (P18.99-T18, ADR-0182)', () => {
    const transportOptions = () => (createTransport as jest.Mock).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const gmail = {
      MAIL_TRANSPORT: undefined, MAIL_PROVIDER: 'gmail', SMTP_HOST: undefined, SMTP_PORT: undefined,
      SMTP_USER: 'agencyboostid@gmail.com', SMTP_PASSWORD: 'abcd efgh ijkl mnop', MAIL_FROM: 'AgencyBoost <agencyboostid@gmail.com>',
    };

    it('P18.99-T18 dials the preset: Gmail on 465 with implicit TLS, the App Password without its spaces', () => {
      make(gmail);
      expect(transportOptions()).toMatchObject({
        host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: 'agencyboostid@gmail.com', pass: 'abcdefghijklmnop' },
      });
    });

    it('P18.99-T18 sets Reply-To when MAIL_REPLY_TO is configured', async () => {
      await make({ MAIL_REPLY_TO: 'support@agencyboost.id' }).send(
        { userId: 'u1', templateId: NotificationTemplate.PASSWORD_RESET, payload: {} },
        { subject: 'S', body: 'B' },
      );
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ replyTo: 'support@agencyboost.id' }));
    });

    it('P18.99-T18 a log setup needs no SMTP_HOST, builds no transport, and sends nothing if it is ever asked', async () => {
      const adapter = make({ MAIL_TRANSPORT: undefined, MAIL_PROVIDER: 'log', SMTP_HOST: undefined });
      expect(createTransport).not.toHaveBeenCalled();
      await adapter.onModuleInit();
      expect(verify).not.toHaveBeenCalled();
      await expect(adapter.send(
        { userId: 'u1', templateId: NotificationTemplate.PASSWORD_RESET, payload: {} },
        { subject: 'S', body: 'B' },
      )).rejects.toThrow('the mail provider is log: this adapter sends nothing');
    });

    it('P18.99-T18 a real provider refuses a reserved address — the seed\'s .test people — naming the domain kind, not the address', async () => {
      const adapter = make({ ...gmail }, 'rina@kpm.test');
      const sending = adapter.send(
        { userId: 'u1', templateId: NotificationTemplate.EMAIL_VERIFICATION, payload: {} },
        { subject: 'S', body: 'B' },
      );
      await expect(sending).rejects.toThrow(/not sent: the address is in a reserved domain .*gmail would only bounce it/);
      await expect(sending).rejects.not.toThrow(/rina/);
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('P18.99-T18 a plain relay still delivers to a reserved address: locally it is a mail catcher', async () => {
      await make({}, 'rina@kpm.test').send(
        { userId: 'u1', templateId: NotificationTemplate.EMAIL_VERIFICATION, payload: {} },
        { subject: 'S', body: 'B' },
      );
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'rina@kpm.test' }));
    });

    it('P18.99-T18 says at start-up which provider and host it sends through, and any warning — never the password', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        verify.mockResolvedValueOnce(true);
        await make({ ...gmail, MAIL_FROM: 'AgencyBoost <no-reply@agencyboost.id>' }).onModuleInit();
        const said = [...log.mock.calls, ...warn.mock.calls].map((call) => String(call[0])).join('\n');
        expect(said).toContain('Mail: provider gmail via smtp.gmail.com:465 (TLS), as agencyboostid@gmail.com');
        expect(said).toMatch(/Gmail rewrites From .* likely to land in spam/);
        expect(said).not.toMatch(/abcd|mnop/);
      } finally {
        log.mockRestore();
        warn.mockRestore();
      }
    });
  });

  describe('timeouts (P12.1-T1)', () => {
    const transportOptions = () => (createTransport as jest.Mock).mock.calls.at(-1)?.[0] as Record<string, unknown>;

    it('P12.1-T1 bounds the dial and the greeting at 5 s when the configuration does not name SMTP_TIMEOUT_MS', () => {
      // A test's configuration, or one written before the key existed: the default, never nodemailer's two minutes.
      make();
      expect(transportOptions()).toMatchObject({ connectionTimeout: 5_000, greetingTimeout: 5_000, socketTimeout: 30_000 });
    });

    it('P12.1-T1 takes SMTP_TIMEOUT_MS when it is configured', () => {
      make({ SMTP_TIMEOUT_MS: 2_500 });
      expect(transportOptions()).toMatchObject({ connectionTimeout: 2_500, greetingTimeout: 2_500 });
    });
  });

  describe('start-up', () => {
    it('is fatal in production when the transport is unusable', async () => {
      /*
       * AC-3, and the whole point of the task. An API that boots with a broken mailer
       * answers 201 to a registration it can never complete, and nothing anywhere says
       * so — which is exactly what happened for three phases.
       */
      process.env.NODE_ENV = 'production';
      verify.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(make().onModuleInit()).rejects.toThrow(/unusable and this is production/);
    });

    it('is a warning outside production, so the thing still runs', async () => {
      process.env.NODE_ENV = 'development';
      verify.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(make().onModuleInit()).resolves.toBeUndefined();
    });

    it('does not dial anything when it is not the chosen transport', async () => {
      // Nest constructs every provider. A provider nobody selected must not spend a
      // connection timeout proving it — that is how a warning becomes background noise.
      await make({ MAIL_TRANSPORT: 'log' }).onModuleInit();
      expect(verify).not.toHaveBeenCalled();
    });

    it('verifies when it is the chosen transport', async () => {
      verify.mockResolvedValueOnce(true);
      await make().onModuleInit();
      expect(verify).toHaveBeenCalled();
    });
  });
});
