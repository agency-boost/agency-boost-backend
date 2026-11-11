import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toHtml } from './email-html';
import { NotificationTemplate, SendRequest } from './notification.types';
import { RecipientAddressBook } from './recipient-address';
import {
  RESEND_MAX_ATTEMPTS, RESEND_RETRY_AFTER_CAP_MS, RESEND_RETRY_BASE_MS, ResendEmailAdapter, retryDelayMs,
} from './resend.adapter';
import { ResendClient, ResendError } from './resend-client';

const KEY = 're_Ab12Cd34_secretpart';
const FROM = 'AgencyBoost <no-reply@notify.agencyboost.id>';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const sent = (id = 'resend-id-1') => json(200, { id });
const refused = (status: number, name: string, headers: Record<string, string> = {}) =>
  json(status, { statusCode: status, name, message: `${name} said by Resend` }, headers);
const timedOut = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };

/** Resend, answering each request with the next of `answers` (the last one repeats); what it was asked, kept. */
function resendAnswers(...answers: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit; at: number }> = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: String(url), init: init as RequestInit, at: Date.now() });
    return answers[Math.min(calls.length, answers.length) - 1]();
  });
  return calls;
}
const headersOf = (call: { init: RequestInit }) => call.init.headers as Record<string, string>;
const bodyOf = (call: { init: RequestInit }) => JSON.parse(String(call.init.body)) as Record<string, unknown>;

function make(env: Record<string, unknown> = {}, address: string | null = 'rina@agencyboost.id') {
  const values: Record<string, unknown> = { MAIL_PROVIDER: 'resend', RESEND_API_KEY: KEY, MAIL_FROM: FROM, ...env };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  const book = { addressOf: jest.fn(async (): Promise<string | null> => address) } satisfies RecipientAddressBook;
  return { adapter: new ResendEmailAdapter(config, book), book };
}

const RESET: SendRequest = { userId: 'u1', templateId: NotificationTemplate.PASSWORD_RESET, payload: {} };
const MESSAGE = { subject: 'Atur ulang kata sandi', body: 'Halo,\n\nhttps://agencyboost.id/reset' };

/** A promise's outcome, with its rejection handled at once: the suite fails on an unhandled one. */
function settled<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return promise.then((value) => ({ value }), (error: unknown) => ({ error }));
}

/** Every line the adapter logged, at any level, as text. */
function logged(): { text: () => string; log: jest.SpyInstance; warn: jest.SpyInstance } {
  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  return {
    log,
    warn,
    text: () => JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]),
  };
}

/**
 * **Delivery through Resend** (P19.12-T1, ADR-0244), with the global `fetch` stubbed and the clock faked: the message
 * it sends, the address it sends to, the retries and the throttle, the start-up check, and the key nowhere.
 */
describe('P19.12-T1 the Resend adapter', () => {
  const NODE_ENV = process.env.NODE_ENV;
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    process.env.NODE_ENV = NODE_ENV;
  });

  describe('sending', () => {
    it('P19.12-T1 AC-1 sends the rendered message, multipart, to the address the account has now, and answers Resend\'s id', async () => {
      const calls = resendAnswers(() => sent('49a3999c-0ce1'));
      const { adapter, book } = make({ MAIL_REPLY_TO: 'help@agencyboost.id' });

      expect(await adapter.send(RESET, MESSAGE)).toEqual({ providerMessageId: '49a3999c-0ce1' });

      expect(book.addressOf).toHaveBeenCalledWith('u1');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.resend.com/emails');
      expect(headersOf(calls[0])).toMatchObject({ Authorization: `Bearer ${KEY}`, 'Idempotency-Key': expect.any(String) });
      expect(bodyOf(calls[0])).toEqual({
        from: FROM, to: ['rina@agencyboost.id'], subject: MESSAGE.subject, text: MESSAGE.body, html: toHtml(MESSAGE.body),
        reply_to: 'help@agencyboost.id', tags: [{ name: 'template', value: 'auth_password_reset' }],
      });
    });

    it('P19.12-T1 AC-1 sends an email change\'s link to the address being proved, without looking the account up (ADR-0181)', async () => {
      const calls = resendAnswers(() => sent());
      const { adapter, book } = make();
      await adapter.send({ ...RESET, templateId: NotificationTemplate.EMAIL_CHANGE_VERIFICATION, toAddress: 'rina.baru@agencyboost.id' }, MESSAGE);
      expect(book.addressOf).not.toHaveBeenCalled();
      expect(bodyOf(calls[0])).toMatchObject({ to: ['rina.baru@agencyboost.id'] });
      expect(bodyOf(calls[0])).not.toHaveProperty('reply_to');
    });

    it('P19.12-T1 AC-1 an id Resend did not give is no id, and the send still counts', async () => {
      resendAnswers(() => json(200, {}));
      expect(await make().adapter.send(RESET, MESSAGE)).toEqual({});
    });

    it('P19.12-T1 AC-1 refuses to send to nobody, without asking Resend', async () => {
      const calls = resendAnswers(() => sent());
      await expect(make({}, null).adapter.send(RESET, MESSAGE)).rejects.toThrow('no email address for user u1');
      await expect(make().adapter.send({ ...RESET, userId: undefined }, MESSAGE)).rejects.toThrow('no email address for user (none)');
      expect(calls).toHaveLength(0);
    });

    it('P19.12-T1 AC-1 refuses a reserved address — the seed\'s .test people — without asking Resend, naming the kind and not the address', async () => {
      const calls = resendAnswers(() => sent());
      const sending = make({}, 'rina@kpm.test').adapter.send(RESET, MESSAGE);
      await expect(sending).rejects.toThrow(/^not sent: the address is in a reserved domain .*resend would only bounce it$/);
      await expect(sending).rejects.not.toThrow(/rina/);
      expect(calls).toHaveLength(0);
    });

    it('P19.12-T1 AC-3 sends nothing, and checks nothing, when Resend is not the provider', async () => {
      const calls = resendAnswers(() => sent());
      const { adapter } = make({ MAIL_PROVIDER: 'gmail', SMTP_USER: 'agencyboostid@gmail.com', SMTP_PASSWORD: 'x', MAIL_FROM: 'agencyboostid@gmail.com' });
      await adapter.onModuleInit();
      await expect(adapter.send(RESET, MESSAGE)).rejects.toThrow('the mail provider is gmail: this adapter sends nothing');
      expect(calls).toHaveLength(0);
    });

    it('P19.12-T1 AC-2 gives each email its own idempotency key', async () => {
      const calls = resendAnswers(() => sent());
      const { adapter } = make();
      await adapter.send(RESET, MESSAGE);
      await jest.advanceTimersByTimeAsync(1_000);
      await adapter.send(RESET, MESSAGE);
      expect(headersOf(calls[0])['Idempotency-Key']).not.toBe(headersOf(calls[1])['Idempotency-Key']);
    });
  });

  describe('retries (AC-2)', () => {
    it.each([
      ['429 rate_limit_exceeded', () => refused(429, 'rate_limit_exceeded')],
      ['409 concurrent_idempotent_requests', () => refused(409, 'concurrent_idempotent_requests')],
      ['500 application_error', () => refused(500, 'application_error')],
      ['502 from a gateway', () => new Response('Bad gateway', { status: 502 })],
      ['503 service_unavailable', () => refused(503, 'service_unavailable')],
      ['504 from a gateway', () => new Response('Gateway timeout', { status: 504 })],
      ['a timeout', timedOut],
    ])('P19.12-T1 AC-2 retries %s under the same idempotency key, and records the id it then gets', async (_, failure) => {
      const log = logged();
      const calls = resendAnswers(failure, () => sent('second-time'));
      const outcome = settled(make().adapter.send(RESET, MESSAGE));

      await jest.advanceTimersByTimeAsync(RESEND_RETRY_BASE_MS);

      expect(await outcome).toEqual({ value: { providerMessageId: 'second-time' } });
      expect(calls).toHaveLength(2);
      expect(headersOf(calls[1])['Idempotency-Key']).toBe(headersOf(calls[0])['Idempotency-Key']);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: 'auth.password_reset', attempt: 1, retryInMs: RESEND_RETRY_BASE_MS }),
        'Resend send retried',
      );
    });

    it('P19.12-T1 AC-2 gives up after three attempts, waiting 1 s then 2 s, and rejects with Resend\'s last answer', async () => {
      logged();
      const calls = resendAnswers(() => refused(503, 'service_unavailable'));
      const outcome = settled(make().adapter.send(RESET, MESSAGE));

      await jest.advanceTimersByTimeAsync(999);
      expect(calls).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(1_999);
      expect(calls).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(1);

      const { error } = await outcome;
      expect(calls).toHaveLength(RESEND_MAX_ATTEMPTS);
      expect(error).toBeInstanceOf(ResendError);
      expect(error).toMatchObject({ code: 'service_unavailable', responseCode: 503 });
      expect(new Set(calls.map((c) => headersOf(c)['Idempotency-Key'])).size).toBe(1);
    });

    it('P19.12-T1 AC-2 honours a rate limit\'s retry-after, capped at 5 s', async () => {
      logged();
      const calls = resendAnswers(() => refused(429, 'rate_limit_exceeded', { 'retry-after': '3' }), () => sent());
      const outcome = settled(make().adapter.send(RESET, MESSAGE));
      await jest.advanceTimersByTimeAsync(2_999);
      expect(calls).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
      await outcome;

      const capped = resendAnswers(() => refused(429, 'rate_limit_exceeded', { 'retry-after': '60' }), () => sent());
      const again = settled(make().adapter.send(RESET, MESSAGE));
      await jest.advanceTimersByTimeAsync(RESEND_RETRY_AFTER_CAP_MS);
      expect(capped).toHaveLength(2);
      expect(await again).toEqual({ value: { providerMessageId: 'resend-id-1' } });
    });

    it.each([
      [429, 'daily_quota_exceeded'],
      [429, 'monthly_quota_exceeded'],
      [400, 'invalid_idempotency_key'],
      [400, 'validation_error'],
      [401, 'missing_api_key'],
      [401, 'validation_error'],
      [403, 'restricted_api_key'],
      [403, 'suspended_api_key'],
      [403, 'validation_error'],
      [409, 'invalid_idempotent_request'],
      [422, 'invalid_parameter'],
      [422, 'missing_required_field'],
    ])('P19.12-T1 AC-2 never retries %d %s: one request, and the answer recorded', async (status, name) => {
      const calls = resendAnswers(() => refused(status, name), () => sent());
      const outcome = settled(make().adapter.send(RESET, MESSAGE));
      await jest.advanceTimersByTimeAsync(10_000);
      expect(calls).toHaveLength(1);
      expect((await outcome).error).toMatchObject({ code: name, responseCode: status, message: `Resend answered ${status} ${name}: ${name} said by Resend` });
    });

    describe('retryDelayMs', () => {
      const answer = (responseCode: number | undefined, code: string, retryAfterMs?: number) =>
        new ResendError('x', code, responseCode, undefined, retryAfterMs);

      it('P19.12-T1 AC-2 doubles from 1 s, and stops at the third attempt', () => {
        expect(retryDelayMs(answer(undefined, 'ETIMEDOUT'), 1)).toBe(1_000);
        expect(retryDelayMs(answer(undefined, 'ECONNRESET'), 2)).toBe(2_000);
        expect(retryDelayMs(answer(undefined, 'ETIMEDOUT'), 3)).toBeNull();
      });

      it('P19.12-T1 AC-2 takes a rate limit\'s retry-after, capped, or the backoff when there is none', () => {
        expect(retryDelayMs(answer(429, 'rate_limit_exceeded', 400), 1)).toBe(400);
        expect(retryDelayMs(answer(429, 'rate_limit_exceeded', 9_000), 1)).toBe(RESEND_RETRY_AFTER_CAP_MS);
        expect(retryDelayMs(answer(429, 'rate_limit_exceeded'), 2)).toBe(2_000);
        expect(retryDelayMs(answer(429, 'http_429'), 1)).toBe(1_000);
      });

      it('P19.12-T1 AC-2 never retries what is not Resend\'s answer', () => {
        expect(retryDelayMs(new Error('a bug'), 1)).toBeNull();
        expect(retryDelayMs('refused', 1)).toBeNull();
      });
    });
  });

  describe('the throttle (AC-2)', () => {
    it('P19.12-T1 AC-2 sends a burst — a roster import\'s invitations — at most five a second, each in turn', async () => {
      const calls = resendAnswers(() => sent());
      const { adapter } = make();
      const start = Date.now();
      const burst = Array.from({ length: 11 }, () => settled(adapter.send(RESET, MESSAGE)));

      await jest.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(999);
      expect(calls).toHaveLength(5);
      await jest.advanceTimersByTimeAsync(1_001);
      expect(calls).toHaveLength(11);

      const outcomes = await Promise.all(burst);
      expect(outcomes.every((o) => o.value !== undefined)).toBe(true);
      const offsets = calls.map((c) => c.at - start);
      expect(offsets).toEqual([0, 200, 400, 600, 800, 1_000, 1_200, 1_400, 1_600, 1_800, 2_000]);
    });

    it('P19.12-T1 AC-2 a retry waits its turn too', async () => {
      logged();
      const calls = resendAnswers(timedOut, () => sent());
      const { adapter } = make();
      const first = settled(adapter.send(RESET, MESSAGE));
      const second = settled(adapter.send(RESET, MESSAGE));
      await jest.advanceTimersByTimeAsync(RESEND_RETRY_BASE_MS + 200);
      await Promise.all([first, second]);
      expect(calls).toHaveLength(3);
      expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(200);
    });
  });

  describe('the key is never said (AC-1)', () => {
    it('P19.12-T1 AC-1 not in a refusal, a retry\'s line, nor the start-up line', async () => {
      const log = logged();
      resendAnswers(
        () => json(500, { name: 'application_error', message: `boom for ${KEY}` }),
        () => json(401, { name: 'validation_error', message: `API key ${KEY} is invalid` }),
      );
      const { adapter } = make();
      const outcome = settled(adapter.send(RESET, MESSAGE));
      await jest.advanceTimersByTimeAsync(RESEND_RETRY_BASE_MS);
      const { error } = await outcome;
      expect((error as Error).message).toBe('Resend answered 401 validation_error: API key re_******** is invalid');

      process.env.NODE_ENV = 'development';
      await adapter.onModuleInit();
      await jest.advanceTimersByTimeAsync(1_000);

      expect(log.text()).toContain('Mail: provider resend via the HTTP API at api.resend.com');
      expect(`${log.text()}${JSON.stringify(error)}${(error as Error).message}`).not.toContain(KEY);
      expect(log.text()).not.toContain('secretpart');
    });
  });

  describe('the start-up check (AC-1)', () => {
    const domains = (...list: Array<{ name: string; status: string }>) => () => json(200, { object: 'list', data: list });

    it('P19.12-T1 AC-1 says the provider and the sender, then that the key works and the From domain is verified', async () => {
      const log = logged();
      const calls = resendAnswers(domains({ name: 'notify.agencyboost.id', status: 'verified' }));
      process.env.NODE_ENV = 'production';
      await make().adapter.onModuleInit();

      expect(calls[0].url).toBe('https://api.resend.com/domains');
      expect(log.log).toHaveBeenCalledWith(`Mail: provider resend via the HTTP API at api.resend.com, from ${FROM}`);
      expect(log.log).toHaveBeenCalledWith('Resend API key accepted; notify.agencyboost.id is verified');
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('P19.12-T1 AC-1 warns, and does not stop, when the From domain is not verified or not the team\'s', async () => {
      const log = logged();
      process.env.NODE_ENV = 'production';
      resendAnswers(domains({ name: 'notify.agencyboost.id', status: 'pending' }));
      await expect(make().adapter.onModuleInit()).resolves.toBeUndefined();
      resendAnswers(domains({ name: 'notify.agencyboost.id', status: '' }));
      await make().adapter.onModuleInit();
      resendAnswers(domains({ name: 'mail.example.org', status: 'verified' }));
      await make().adapter.onModuleInit();
      resendAnswers(domains());
      await make().adapter.onModuleInit();

      const warnings = log.warn.mock.calls.map((call) => String(call[0]));
      expect(warnings[0]).toMatch(/^notify\.agencyboost\.id is pending in Resend: Resend refuses mail from it \(403 validation_error\)/);
      expect(warnings[1]).toMatch(/^notify\.agencyboost\.id is not verified in Resend/);
      expect(warnings[2]).toMatch(/^notify\.agencyboost\.id is not a domain of this Resend team \(mail\.example\.org\)/);
      expect(warnings[3]).toMatch(/\(it has none\)/);
    });

    it('P19.12-T1 AC-1 passes a sending-only key, which may not list domains, in production too', async () => {
      const log = logged();
      resendAnswers(() => refused(401, 'restricted_api_key'));
      process.env.NODE_ENV = 'production';
      await expect(make().adapter.onModuleInit()).resolves.toBeUndefined();
      expect(log.log).toHaveBeenCalledWith(expect.stringMatching(/^Resend API key accepted: a sending-only key/));
      expect(log.warn).not.toHaveBeenCalled();
    });

    it.each([
      [400, 'validation_error'], [401, 'missing_api_key'], [401, 'validation_error'], [403, 'restricted_api_key'],
      [403, 'suspended_api_key'],
    ])(
      'P19.12-T1 AC-1 is fatal in production when Resend refuses the key (%d %s), naming RESEND_API_KEY and never its value',
      async (status, name) => {
        logged();
        resendAnswers(() => refused(status, name));
        process.env.NODE_ENV = 'production';
        const booting = make().adapter.onModuleInit();
        await expect(booting).rejects.toThrow(
          new RegExp(`^Resend is unusable and this is production: Resend refused RESEND_API_KEY \\(Resend answered ${status} ${name}`),
        );
        await expect(booting).rejects.not.toThrow(new RegExp(KEY));
      },
    );

    it('P19.12-T1 AC-1 is a warning outside production when the key is refused, so the thing still runs', async () => {
      const log = logged();
      resendAnswers(() => refused(401, 'validation_error'));
      process.env.NODE_ENV = 'staging';
      await expect(make().adapter.onModuleInit()).resolves.toBeUndefined();
      await jest.advanceTimersByTimeAsync(0);
      expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^Resend refused RESEND_API_KEY .*Mail will fail until it is fixed\.$/));
    });

    it.each([
      ['a timeout', timedOut],
      ['a 500', () => refused(500, 'application_error')],
      ['a 429', () => refused(429, 'rate_limit_exceeded')],
      ['a 404, an API that moved', () => refused(404, 'not_found')],
      ['a network failure', () => { throw new TypeError('fetch failed'); }],
    ])('P19.12-T1 AC-1 only warns, in production too, on %s: Resend slow at a deploy is no reason to stay down', async (_, answer) => {
      const log = logged();
      resendAnswers(answer);
      process.env.NODE_ENV = 'production';
      await expect(make().adapter.onModuleInit()).resolves.toBeUndefined();
      expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^Resend could not be checked at start-up \(.*\)\. Mail is sent, and retried, as usual\.$/));
    });

    it('P19.12-T1 AC-1 only warns on a failure that is not Resend\'s answer at all', async () => {
      const log = logged();
      jest.spyOn(ResendClient.prototype, 'listDomains').mockRejectedValueOnce('a stray rejection');
      process.env.NODE_ENV = 'production';
      await expect(make().adapter.onModuleInit()).resolves.toBeUndefined();
      expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^Resend could not be checked at start-up \(a stray rejection\)/));
    });

    it('P19.12-T1 AC-1 waits for nothing outside production: a hung check costs no start-up time', async () => {
      logged();
      jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
      process.env.NODE_ENV = 'development';
      await expect(make().adapter.onModuleInit()).resolves.toBeUndefined();
    });

    it('P19.12-T1 AC-1 says the configuration\'s warnings once, after the Mail line', async () => {
      const log = logged();
      resendAnswers(domains({ name: 'notify.agencyboost.id', status: 'verified' }));
      process.env.NODE_ENV = 'production';
      await make({ SMTP_PASSWORD: 'abcd efgh ijkl mnop' }).adapter.onModuleInit();
      expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^SMTP_PASSWORD is ignored: MAIL_PROVIDER=resend/));
      expect(log.text()).not.toContain('abcd');
    });
  });
});
