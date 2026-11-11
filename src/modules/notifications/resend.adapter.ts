import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toHtml } from './email-html';
import { describeMail, domainOf, mailSettingsFrom, type ResolvedMailSettings } from './mail-provider';
import {
  DeliveryReceipt, NotificationChannel, NotificationChannelAdapter, RenderedMessage, SendRequest,
} from './notification.types';
import { RecipientAddressBook, recipientAddress } from './recipient-address';
import { ResendClient, type ResendDomain, ResendError } from './resend-client';

/**
 * **How many requests a second one API sends Resend.** Resend's default limit is 10 a second **per team**, and staging
 * and production share the team, so each keeps to half. A roster import invites everybody at once; spaced, an import of
 * 80 people leaves in about 16 seconds rather than meeting `429` after the tenth.
 */
export const RESEND_REQUESTS_PER_SECOND = 5;
const RESEND_REQUEST_SPACING_MS = 1_000 / RESEND_REQUESTS_PER_SECOND;
/** Attempts per email, the first included, all under one idempotency key. */
export const RESEND_MAX_ATTEMPTS = 3;
/** The wait before the second attempt; doubled before the third. */
export const RESEND_RETRY_BASE_MS = 1_000;
/** The longest a `429`'s `retry-after` is waited, so one email never holds a delivery `pending` for long. */
export const RESEND_RETRY_AFTER_CAP_MS = 5_000;
/** Resend's own failures (`500 application_error`, `503 service_unavailable`), and a gateway's: worth a second try. */
const RETRYABLE_STATUSES: readonly number[] = [500, 502, 503, 504];
/** How Resend refuses the start-up check's key (its *Errors* page, read 2026-11-11), `401 restricted_api_key` apart. */
const KEY_REFUSALS: readonly number[] = [400, 401, 403];

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * **How long to wait before trying an email again, or `null` when its failure is final** (P19.12-T1 AC-2). Retried:
 * no answer (a timeout, the network), `429 rate_limit_exceeded` (its `retry-after`, capped), `409
 * concurrent_idempotent_requests` (the first attempt is still being answered), and `500`, `502`, `503`, `504`. Never:
 * a spent quota (`429 daily_quota_exceeded`, `monthly_quota_exceeded`), which a minute does not cure, nor any other
 * client error — `400`, `401`, `403` (the domain not verified), `409` with another payload, `422` — which a second try
 * would only repeat. Nor anything that is not Resend's answer at all.
 */
export function retryDelayMs(err: unknown, attempt: number): number | null {
  if (attempt >= RESEND_MAX_ATTEMPTS || !(err instanceof ResendError)) return null;
  const backoff = RESEND_RETRY_BASE_MS * 2 ** (attempt - 1);
  const status = err.responseCode;
  if (status === undefined) return backoff;
  if (status === 429) return err.code.includes('quota') ? null : Math.min(err.retryAfterMs ?? backoff, RESEND_RETRY_AFTER_CAP_MS);
  if (status === 409) return err.code === 'concurrent_idempotent_requests' ? backoff : null;
  return RETRYABLE_STATUSES.includes(status) ? backoff : null;
}

/**
 * **Delivery through Resend's HTTP API** (P19.12-T1, ADR-0244), when `MAIL_PROVIDER=resend`: the owner's choice of 11
 * November 2026 for every email the product sends — the account's own, invitations, an import's burst and every
 * notice — all of which reach it through `NotificationService.send`, the one caller of this port.
 *
 * - **The same email as SMTP's**: from `MAIL_FROM`, to one address resolved as SMTP's is (`recipient-address.ts`, the
 *   reserved-domain guard included), the rendered text and the HTML derived from it (`email-html.ts`), `MAIL_REPLY_TO`
 *   when set. One tag, `template`, so Resend's log can be searched by the product's template. No open or click
 *   tracking: that is the domain's setting in Resend, and it stays off.
 * - **Throttled in the process** to `RESEND_REQUESTS_PER_SECOND`, every request in turn, the start-up check included.
 * - **Retried** as `retryDelayMs` says, at most `RESEND_MAX_ATTEMPTS` times, **under one `Idempotency-Key`**, so a
 *   first attempt Resend accepted but never answered is not sent a second time.
 * - **Resolves with Resend's id** for the email, which the delivery row records (`providerMessageId`); rejects with a
 *   `ResendError`, which `providerAnswerOf` records as it records an SMTP reply.
 * - **Never the key**: not in a log line, an error or the start-up line.
 *
 * **At start-up, when chosen, it asks Resend for the team's domains** (`GET /domains`), relaxing ADR-0019 AC-3 for an
 * HTTP API where an SMTP login proves nothing equivalent:
 *
 * - answered: the From domain is checked, and a domain not verified is a warning — Resend would refuse the mail;
 * - `401 restricted_api_key`: a *Sending access* key, the kind asked for, which may not list domains. It is a valid
 *   key, and passes;
 * - any other `400`, `401` or `403`: the key is refused — missing (`missing_api_key`), invalid (`validation_error`, *API
 *   key is invalid*), not active (`403 restricted_api_key`) or suspended (`suspended_api_key`); a request with no body
 *   and no parameter can be refused for nothing else. **Fatal in production**, a warning elsewhere;
 * - no answer, a `5xx` or a `429`: a warning only. Resend being slow at the moment of a deploy is no reason to keep
 *   an API down whose mail is retried anyway.
 */
@Injectable()
export class ResendEmailAdapter extends NotificationChannelAdapter implements OnModuleInit {
  readonly channel: NotificationChannel = 'email';
  private readonly logger = new Logger(ResendEmailAdapter.name);
  private readonly settings: ResolvedMailSettings;
  /** `null` unless `resend` is the provider: Nest constructs every adapter, and only the chosen one does anything. */
  private readonly client: ResendClient | null;
  /** Resolved when the next request may go: each request takes its turn and pushes the next one a spacing later. */
  private nextTurn: Promise<void> = Promise.resolve();

  constructor(
    config: ConfigService,
    private readonly addresses: RecipientAddressBook,
  ) {
    super();
    this.settings = mailSettingsFrom(config);
    this.client = this.settings.provider === 'resend'
      // Read when called, not when built, so a spec's stub of the global `fetch` is the one used.
      ? new ResendClient(this.settings.apiKey, (url, init) => fetch(url, init))
      : null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.client) return;

    this.logger.log(`Mail: ${describeMail(this.settings)}`);
    for (const warning of this.settings.warnings) this.logger.warn(warning);

    const checked = this.checkKey(this.client);
    // Production waits for the answer, which may be fatal; nothing else does, as `SmtpChannelAdapter` (ADR-0019 AC-3).
    if (process.env.NODE_ENV === 'production') {
      await checked;
      return;
    }
    // Cannot reject outside production: `checkKey` throws on the production branch alone.
    void checked;
  }

  async send(to: SendRequest, rendered: RenderedMessage): Promise<DeliveryReceipt> {
    if (!this.client) {
      // `app.module.ts` chooses this adapter for `resend` alone; reaching here is a wiring defect, said as one.
      throw new Error(`the mail provider is ${this.settings.provider}: this adapter sends nothing`);
    }
    const address = await recipientAddress(to, this.addresses, this.settings.provider);
    const email = {
      from: this.settings.from,
      to: address,
      subject: rendered.subject,
      text: rendered.body,
      html: toHtml(rendered.body),
      replyTo: this.settings.replyTo,
      template: to.templateId,
    };

    const idempotencyKey = randomUUID();
    for (let attempt = 1; ; attempt += 1) {
      await this.turn();
      try {
        const { id } = await this.client.sendEmail(email, idempotencyKey);
        return id ? { providerMessageId: id } : {};
      } catch (err) {
        const wait = retryDelayMs(err, attempt);
        if (wait === null) throw err;
        const { code, responseCode } = err as ResendError;
        // Never the address, the key or the words: the template, the attempt and what Resend answered.
        this.logger.warn({ templateId: to.templateId, attempt, code, responseCode, retryInMs: wait }, 'Resend send retried');
        await pause(wait);
      }
    }
  }

  /** Wait for this request's turn, and set the next one a spacing after it. */
  private turn(): Promise<void> {
    const mine = this.nextTurn;
    this.nextTurn = mine.then(() => pause(RESEND_REQUEST_SPACING_MS));
    return mine;
  }

  /** The start-up check, as the class comment lists its answers. Throws in production, on a refused key alone. */
  private async checkKey(client: ResendClient): Promise<void> {
    const domain = domainOf(this.settings.from);
    let domains: ResendDomain[];
    try {
      await this.turn();
      domains = await client.listDomains();
    } catch (err) {
      const answer = err instanceof ResendError ? err : undefined;
      if (answer?.responseCode === 401 && answer.code === 'restricted_api_key') {
        this.logger.log(
          `Resend API key accepted: a sending-only key, which may not list domains, so whether ${domain} is verified is `
            + 'not checked here (send-test-mail.sh does).',
        );
        return;
      }
      if (answer?.responseCode !== undefined && KEY_REFUSALS.includes(answer.responseCode)) {
        const said = `Resend refused RESEND_API_KEY (${answer.message})`;
        if (process.env.NODE_ENV === 'production') {
          // Fatal on purpose (ADR-0019 AC-3): every email would be refused, and registration would answer 201 anyway.
          throw new Error(`Resend is unusable and this is production: ${said}. Make a key in Resend and put it in RESEND_API_KEY.`);
        }
        this.logger.warn(`${said}. Mail will fail until it is fixed.`);
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Resend could not be checked at start-up (${detail}). Mail is sent, and retried, as usual.`);
      return;
    }

    const found = domains.find((d) => d.name === domain);
    if (found?.status === 'verified') {
      this.logger.log(`Resend API key accepted; ${domain} is verified`);
    } else if (found) {
      this.logger.warn(
        `${domain} is ${found.status || 'not verified'} in Resend: Resend refuses mail from it (403 validation_error) until `
          + `its DNS records are found. Resend, Domains, ${domain}, Verify DNS Records.`,
      );
    } else {
      this.logger.warn(
        `${domain} is not a domain of this Resend team (${domains.map((d) => d.name).join(', ') || 'it has none'}): `
          + 'Resend refuses mail from it. Add and verify it in Resend, or set MAIL_FROM to an address on a verified domain.',
      );
    }
  }
}
