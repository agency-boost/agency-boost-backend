import type { MailProvider } from './mail-provider';
import type { NotificationChannelAdapter } from './notification.types';

/** The three ways email can leave, one adapter each. */
export interface EmailAdapters {
  /** `LogEmailAdapter`: writes the message to the log, and sends none. */
  readonly log: NotificationChannelAdapter;
  /** `ResendEmailAdapter`: Resend's HTTP API (P19.12-T1, ADR-0244). */
  readonly resend: NotificationChannelAdapter;
  /** `SmtpChannelAdapter`: every preset and a plain relay. */
  readonly smtp: NotificationChannelAdapter;
}

/**
 * **The email adapter for a provider** (P4-T14, ADR-0019; P19.12-T1, ADR-0244): what the factory in `app.module.ts`
 * registers as the email channel. `log` writes, `resend` posts to Resend's API, and every other provider dials SMTP.
 * Exactly one is chosen, and there is no fallback between them: an SMTP provider sends from another domain than
 * Resend's, so a quiet fallback would fail DMARC, and a send that timed out at one could arrive twice.
 */
export function emailAdapterFor(provider: MailProvider, adapters: EmailAdapters): NotificationChannelAdapter {
  if (provider === 'log') return adapters.log;
  if (provider === 'resend') return adapters.resend;
  return adapters.smtp;
}
