import { emailAdapterFor } from './email-channel';
import { MAIL_PROVIDERS } from './mail-provider';
import { NotificationChannel, NotificationChannelAdapter } from './notification.types';

class Named extends NotificationChannelAdapter {
  readonly channel: NotificationChannel = 'email';
  constructor(readonly name: string) {
    super();
  }
  async send(): Promise<void> {}
}

/** **Which adapter the email channel is** (P19.12-T1, ADR-0244): what `app.module.ts`'s factory registers. */
describe('P19.12-T1 the email adapter the environment chooses', () => {
  const adapters = { log: new Named('log'), resend: new Named('resend'), smtp: new Named('smtp') };
  const chosen = (provider: (typeof MAIL_PROVIDERS)[number]) => (emailAdapterFor(provider, adapters) as Named).name;

  it('P19.12-T1 AC-1 chooses Resend for resend', () => {
    expect(chosen('resend')).toBe('resend');
  });

  it('P19.12-T1 AC-3 chooses the log for log, and SMTP for every preset and a plain relay', () => {
    expect(Object.fromEntries(MAIL_PROVIDERS.map((provider) => [provider, chosen(provider)]))).toEqual({
      resend: 'resend', gmail: 'smtp', sendgrid: 'smtp', mailjet: 'smtp', clicksend: 'smtp', ses: 'smtp', smtp: 'smtp', log: 'log',
    });
  });
});
