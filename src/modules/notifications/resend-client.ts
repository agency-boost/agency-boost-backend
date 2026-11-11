import { RESEND_API_HOST } from './mail-provider';

/**
 * **Resend's HTTP API, the two calls the product makes** (P19.12-T1, ADR-0244): send one email, and list the domains
 * a key can see, which is the start-up check. Pure: `fetch` is handed in, so a spec answers for Resend, and nothing
 * here reads the environment, waits or retries — `ResendEmailAdapter` and the test command decide those.
 *
 * No SDK: two requests do not need one, and the `resend` package would be one more dependency carrying the key.
 *
 * **The API key travels in the `Authorization` header and nowhere else.** It is never in an error, a message or a log
 * line: an error is built from Resend's answer, and any text that quoted the key is masked before it is kept.
 */

export const RESEND_API_ORIGIN = `https://${RESEND_API_HOST}`;

/**
 * **How long one request to Resend may take**, the whole of it, before it is abandoned as a timeout. Resend answers in
 * well under a second; ten covers a slow moment without letting a hung connection hold a delivery `pending` for long.
 * A send that timed out is retried with the same idempotency key, so one Resend did accept is not sent twice.
 */
export const RESEND_TIMEOUT_MS = 10_000;

/** The one `fetch` call this module makes, as a spec stubs it. Node's global `fetch` fits it. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** One email, as the product hands it to Resend. */
export interface ResendEmail {
  /** `AgencyBoost <address>`, on a domain verified in Resend. */
  readonly from: string;
  /** One recipient: every product email is addressed to one person. */
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly replyTo?: string;
  /** The product's template, sent as Resend's tag `template`, so Resend's log can be searched by it. */
  readonly template?: string;
}

/** A domain as `GET /domains` lists it. `status` is `verified` once its DNS records are found. */
export interface ResendDomain {
  readonly name: string;
  readonly status: string;
}

/**
 * **What Resend answered a request it refused, or that never got an answer.** Shaped as nodemailer's errors are, so
 * `providerAnswerOf` records it unchanged on the delivery row and in the log:
 *
 * - `code`: Resend's error `name` (`validation_error`, `rate_limit_exceeded`, `daily_quota_exceeded` …); without an
 *   answer, `ETIMEDOUT`, or the network's own code (`ENOTFOUND`, `ECONNRESET` …), else `ENETWORK`;
 * - `responseCode`: the HTTP status, when there was one;
 * - `response`: Resend's message, when it gave one;
 * - `retryAfterMs`: from a `429`'s `retry-after`, for the adapter's wait.
 */
export class ResendError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly responseCode?: number,
    readonly response?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ResendError';
  }
}

/**
 * The value of Resend's `template` tag: a tag may hold ASCII letters, digits, `_` and `-` only, so the template id's
 * dots (`auth.password_reset`) become `_`.
 */
export function templateTag(template: string): string {
  return template.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);
}

/** The request body `POST /emails` takes, in Resend's field names. */
export function emailBody(email: ResendEmail): Record<string, unknown> {
  return {
    from: email.from,
    to: [email.to],
    subject: email.subject,
    text: email.text,
    html: email.html,
    ...(email.replyTo ? { reply_to: email.replyTo } : {}),
    ...(email.template ? { tags: [{ name: 'template', value: templateTag(email.template) }] } : {}),
  };
}

/** `retry-after` in milliseconds, when it is a number of seconds; an HTTP date, or nothing, is no hint. */
function retryAfterOf(headers: Headers): number | undefined {
  const written = headers.get('retry-after');
  if (written === null || written.trim() === '') return undefined;
  const seconds = Number(written);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

/** A body read as JSON, or `undefined` when it is not (a proxy's HTML page, an empty `204`). */
function parsed(body: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export class ResendClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchLike,
    private readonly timeoutMs: number = RESEND_TIMEOUT_MS,
  ) {}

  /**
   * **Send one email**: `POST /emails`, under `idempotencyKey`, so the same key sent again — a retry after a timeout —
   * is answered with the first send's id rather than sending it twice (Resend keeps a key for 24 hours). Resolves with
   * Resend's id for the email; throws `ResendError` with Resend's answer otherwise.
   */
  async sendEmail(email: ResendEmail, idempotencyKey: string): Promise<{ id: string | undefined }> {
    const answer = await this.request('POST', '/emails', { body: emailBody(email), idempotencyKey });
    return { id: typeof answer?.id === 'string' ? answer.id : undefined };
  }

  /** **The domains this key's team has**: `GET /domains`. A sending-only key is refused it: `401 restricted_api_key`. */
  async listDomains(): Promise<ResendDomain[]> {
    const answer = await this.request('GET', '/domains', {});
    const data = Array.isArray(answer?.data) ? (answer.data as unknown[]) : [];
    return data
      .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
      .map((d) => ({ name: String(d.name ?? '').toLowerCase(), status: String(d.status ?? '') }));
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    { body, idempotencyKey }: { body?: Record<string, unknown>; idempotencyKey?: string },
  ): Promise<Record<string, unknown> | undefined> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetchFn(`${RESEND_API_ORIGIN}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'User-Agent': 'agencyboost-api',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (err) {
      throw this.unanswered(err);
    }

    const answer = parsed(text);
    if (response.ok) return answer;
    const name = typeof answer?.name === 'string' ? answer.name : `http_${response.status}`;
    const said = typeof answer?.message === 'string' && answer.message.trim() ? this.masked(answer.message.trim()) : undefined;
    throw new ResendError(
      `Resend answered ${response.status} ${name}${said ? `: ${said}` : ''}`,
      name,
      response.status,
      said,
      response.status === 429 ? retryAfterOf(response.headers) : undefined,
    );
  }

  /** A request with no answer: abandoned at `timeoutMs`, or failed on the network, named by the network's own code. */
  private unanswered(err: unknown): ResendError {
    const failure = err as { name?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } };
    if (failure?.name === 'TimeoutError' || failure?.name === 'AbortError') {
      return new ResendError(`Resend did not answer within ${this.timeoutMs} ms`, 'ETIMEDOUT');
    }
    const cause = failure?.cause;
    const code = typeof cause?.code === 'string' ? cause.code : 'ENETWORK';
    const detail = typeof cause?.message === 'string' ? cause.message : String(failure?.message ?? err);
    return new ResendError(`Resend could not be reached: ${this.masked(detail)}`, code);
  }

  /** The text with the key masked, should anything ever quote it back. */
  private masked(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join('re_********') : text;
  }
}
