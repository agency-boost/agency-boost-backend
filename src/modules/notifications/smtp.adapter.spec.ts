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
import { RecipientAddressBook, SmtpChannelAdapter } from './smtp.adapter';
import { NotificationTemplate } from './notification.types';

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
    expect(sendMail).toHaveBeenCalledWith({
      from: 'AgencyBoost <no-reply@test>', to: 'rina@kpm.test', subject: 'S', text: 'B',
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
