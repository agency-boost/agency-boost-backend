import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import {
  NotificationChannel, NotificationChannelAdapter, RenderedMessage, SendRequest,
} from './notification.types';

/** Where a message is addressed. The service knows the recipient; the adapter needs an address. */
export abstract class RecipientAddressBook {
  abstract addressOf(userId: string): Promise<string | null>;
}

/**
 * Delivery over the office's own SMTP (P4-T14, ADR-0019).
 *
 * **Own SMTP rather than a vendor API**, decided 2026-09-11. The environment it reads —
 * `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` — has been validated
 * in `env.validation.ts` since Phase 1; it was the implementation behind it that never
 * existed, which is how a product shipped three phases with no way for a registered person
 * to sign in.
 *
 * **It verifies at start-up, and in production a failure is fatal.** Booting an API whose
 * mail transport is wrong is worse than not booting: registration answers `201`, the person
 * waits for an email that will never arrive, and nothing anywhere says so. Outside
 * production the same failure is a warning, because a developer without a local mail
 * catcher should still be able to run the thing.
 *
 * **Never throws out of `send`.** `NotificationService` records a channel failure and
 * carries on by design — an unreachable mail server must not fail the approval, the removal
 * or the registration that triggered the message.
 */
@Injectable()
export class SmtpChannelAdapter extends NotificationChannelAdapter implements OnModuleInit {
  readonly channel: NotificationChannel = 'email';
  private readonly logger = new Logger(SmtpChannelAdapter.name);
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(
    private readonly config: ConfigService,
    private readonly addresses: RecipientAddressBook,
  ) {
    super();
    const port = config.getOrThrow<number>('SMTP_PORT');
    const user = config.get<string>('SMTP_USER') ?? '';
    this.from = config.getOrThrow<string>('MAIL_FROM');
    // Captured here because `config` is read again in onModuleInit, and a provider that
    // is constructed but not chosen must not open a connection to prove it.
    this.transport = createTransport({
      host: config.getOrThrow<string>('SMTP_HOST'),
      port,
      // 465 is implicit TLS; everything else negotiates STARTTLS. Getting this backwards
      // is the single most common way an SMTP client hangs rather than failing.
      secure: port === 465,
      auth: user ? { user, pass: config.get<string>('SMTP_PASSWORD') ?? '' } : undefined,
    });
  }

  async onModuleInit(): Promise<void> {
    // Constructed either way — Nest builds every provider — but only the chosen transport
    // has anything to verify. Dialling a fake `SMTP_HOST` on every local boot would cost a
    // connection timeout and teach developers to ignore a warning.
    if (this.config.get<string>('MAIL_TRANSPORT') !== 'smtp') return;
    try {
      await this.transport.verify();
      this.logger.log('SMTP transport verified');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (process.env.NODE_ENV === 'production') {
        // Fatal on purpose (ADR-0019 AC-3). The alternative is an API that accepts
        // registrations it can never complete.
        throw new Error(
          `SMTP is unusable and this is production: ${detail}. `
            + 'Check SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASSWORD.',
        );
      }
      this.logger.warn(`SMTP is unusable (${detail}). Mail will fail until it is fixed.`);
    }
  }

  async send(to: SendRequest, rendered: RenderedMessage): Promise<void> {
    const address = to.userId ? await this.addresses.addressOf(to.userId) : null;
    if (!address) {
      // Thrown rather than swallowed: `NotificationService` turns it into a recorded
      // `failed` with this reason on it, which is exactly the audit trail wanted.
      throw new Error(`no email address for user ${to.userId ?? '(none)'}`);
    }

    await this.transport.sendMail({
      from: this.from,
      to: address,
      subject: rendered.subject,
      text: rendered.body,
    });
  }
}
