import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { SMTP_TIMEOUT_MS_DEFAULT } from '@/config/env.validation';
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
/**
 * Transport timeouts, stated because nodemailer's defaults are two minutes.
 *
 * A start-up liveness check that can sit for two minutes is wrong on every platform: it
 * stalls `pnpm dev` behind an unreachable relay, and on Vercel it spends the whole
 * invocation budget before the first request is looked at. Measured on a network that
 * blocks outbound 587, `verify()` took 75s to reach ETIMEDOUT.
 *
 * **The dial and the greeting are bounded by `SMTP_TIMEOUT_MS`**, 5 s unless configured (P12.1-T1;
 * they were a fixed 10 s, which is what an invitation's save waited for on the dev server before
 * email left the request). A configuration that does not name it (a test's, or one written before
 * the key existed) gets the default.
 *
 * This one is inactivity during an exchange, which covers sending as well as verifying.
 */
const SMTP_SOCKET_TIMEOUT_MS = 30_000;

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
    const timeout = config.get<number>('SMTP_TIMEOUT_MS') ?? SMTP_TIMEOUT_MS_DEFAULT;
    // Captured here because `config` is read again in onModuleInit, and a provider that
    // is constructed but not chosen must not open a connection to prove it.
    this.transport = createTransport({
      host: config.getOrThrow<string>('SMTP_HOST'),
      port,
      // 465 is implicit TLS; everything else negotiates STARTTLS. Getting this backwards
      // is the single most common way an SMTP client hangs rather than failing.
      secure: port === 465,
      auth: user ? { user, pass: config.get<string>('SMTP_PASSWORD') ?? '' } : undefined,
      // Stated, because nodemailer's default connection timeout is two minutes and a
      // start-up check has no business taking that long anywhere. Measured against a
      // network that blocks outbound 587: verify() sat for 75s before ETIMEDOUT, which on
      // a serverless platform is the whole invocation budget spent before the first
      // request is looked at.
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    });
  }

  async onModuleInit(): Promise<void> {
    // Constructed either way — Nest builds every provider — but only the chosen transport
    // has anything to verify. Dialling a fake `SMTP_HOST` on every local boot would cost a
    // connection timeout and teach developers to ignore a warning.
    if (this.config.get<string>('MAIL_TRANSPORT') !== 'smtp') return;

    const verified = this.verifyTransport();

    // **Production waits; nothing else does.**
    //
    // A failure here is fatal in production (ADR-0019 AC-3), so the process must not get
    // past this line until the answer is known. Everywhere else the same failure is only a
    // warning — and a warning must not cost start-up time, because `onModuleInit` blocks
    // `app.init()`, which on Vercel blocks the first request behind it (ADR-0041). The
    // warning still arrives; it just arrives on its own schedule.
    if (process.env.NODE_ENV === 'production') {
      await verified;
      return;
    }

    // Cannot reject outside production — `verifyTransport` only throws on the production
    // branch — so this floats safely rather than becoming an unhandled rejection.
    void verified;
  }

  private async verifyTransport(): Promise<void> {
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
