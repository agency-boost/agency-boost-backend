import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { toHtml } from './email-html';
import {
  describeMail, isSmtpProvider, mailSettingsFrom, type ResolvedMailSettings, transportOptionsFrom,
} from './mail-provider';
import {
  NotificationChannel, NotificationChannelAdapter, RenderedMessage, SendRequest,
} from './notification.types';
import { RecipientAddressBook, recipientAddress } from './recipient-address';

// Its home since P19.12-T1, which Resend's adapter shares; re-exported for the imports that name it here.
export { RecipientAddressBook };

/**
 * Delivery over SMTP (P4-T14, ADR-0019), through the provider the environment names (P18.11-T18, ADR-0182).
 *
 * *Since P19.12-T1 (ADR-0244), one of two senders:* `MAIL_PROVIDER=resend` sends through Resend's HTTP API
 * (`ResendEmailAdapter`) and this adapter then builds nothing and checks nothing at start-up. It stays for every SMTP
 * provider, Gmail above all, which is the manual rollback: an env edit and a redeploy.
 *
 * **Own SMTP rather than a vendor API**, decided 2026-09-11. **Which relay is `MAIL_PROVIDER`'s**: Gmail, SendGrid,
 * Mailjet, ClickSend, SES or any relay `SMTP_HOST` names, each a preset of host, port and TLS in `mail-provider.ts`,
 * so changing provider is a new env file and a redeploy. An env file written before that key still works:
 * `MAIL_TRANSPORT` decides when `MAIL_PROVIDER` is unset.
 *
 * **It verifies at start-up, and in production a failure is fatal.** Booting an API whose
 * mail transport is wrong is worse than not booting: registration answers `201`, the person
 * waits for an email that will never arrive, and nothing anywhere says so. Outside
 * production the same failure is a warning, because a developer without a local mail
 * catcher should still be able to run the thing. The start-up line names the provider and the host, never the
 * password, and a configuration likely to land in spam (Gmail sending as another address) is said there too.
 *
 * **Every message is multipart**: the rendered text, and an HTML alternative derived from it (`email-html.ts`), so the
 * text stays the one source of the words. `MAIL_REPLY_TO`, when set, is its Reply-To.
 *
 * **A failure in `send` never reaches the request.** `NotificationService` records a channel failure and
 * carries on by design — an unreachable mail server must not fail the approval, the removal
 * or the registration that triggered the message.
 */
@Injectable()
export class SmtpChannelAdapter extends NotificationChannelAdapter implements OnModuleInit {
  readonly channel: NotificationChannel = 'email';
  private readonly logger = new Logger(SmtpChannelAdapter.name);
  private readonly settings: ResolvedMailSettings;
  /**
   * `null` when the provider is not SMTP's — `log` or `resend` — so neither needs an `SMTP_HOST`. *Until P19.12-T1* only
   * `log` gave `null`, and with `resend` chosen this adapter would have checked an empty host at start-up: fatal in
   * production, for a transport nothing sends through.
   */
  private readonly transport: Transporter | null;

  constructor(
    config: ConfigService,
    private readonly addresses: RecipientAddressBook,
  ) {
    super();
    // Nest constructs every provider, chosen or not. Reading the settings is pure and `createTransport` opens no
    // connection, so a provider that is constructed but not chosen costs nothing; it is verified only when chosen.
    this.settings = mailSettingsFrom(config);
    this.transport = isSmtpProvider(this.settings.provider) ? createTransport(transportOptionsFrom(this.settings)) : null;
  }

  async onModuleInit(): Promise<void> {
    // Only the chosen transport has anything to verify. Dialling a fake `SMTP_HOST` on every local boot would cost a
    // connection timeout and teach developers to ignore a warning.
    if (!this.transport) return;

    this.logger.log(`Mail: ${describeMail(this.settings)}`);
    for (const warning of this.settings.warnings) this.logger.warn(warning);

    const verified = this.verifyTransport(this.transport);

    // **Production waits; nothing else does.**
    //
    // A failure here is fatal in production (ADR-0019 AC-3), so the process must not get
    // past this line until the answer is known. Everywhere else the same failure is only a
    // warning — and a warning must not cost start-up time, because `onModuleInit` blocks
    // `app.init()`. The warning still arrives; it just arrives on its own schedule.
    if (process.env.NODE_ENV === 'production') {
      await verified;
      return;
    }

    // Cannot reject outside production — `verifyTransport` only throws on the production
    // branch — so this floats safely rather than becoming an unhandled rejection.
    void verified;
  }

  private async verifyTransport(transport: Transporter): Promise<void> {
    try {
      await transport.verify();
      this.logger.log(`SMTP transport verified (${this.settings.provider}, ${this.settings.host})`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (process.env.NODE_ENV === 'production') {
        // Fatal on purpose (ADR-0019 AC-3). The alternative is an API that accepts
        // registrations it can never complete.
        throw new Error(
          `SMTP is unusable and this is production: ${detail}. `
            + 'Check MAIL_PROVIDER, SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASSWORD.',
        );
      }
      this.logger.warn(`SMTP is unusable (${detail}). Mail will fail until it is fixed.`);
    }
  }

  async send(to: SendRequest, rendered: RenderedMessage): Promise<void> {
    if (!this.transport) {
      // `app.module.ts` never chooses this adapter for `log` or `resend`; reaching here is a wiring defect, said as one.
      throw new Error(`the mail provider is ${this.settings.provider}: this adapter sends nothing`);
    }
    // The address the account has now, or the email change's `toAddress`; none, or a reserved one through a real
    // provider, is thrown and recorded `failed` with the reason (`recipient-address.ts`).
    const address = await recipientAddress(to, this.addresses, this.settings.provider);

    await this.transport.sendMail({
      from: this.settings.from,
      to: address,
      subject: rendered.subject,
      text: rendered.body,
      html: toHtml(rendered.body),
      ...(this.settings.replyTo ? { replyTo: this.settings.replyTo } : {}),
    });
  }
}
