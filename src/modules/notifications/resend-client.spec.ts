import { providerAnswerOf } from './notification.service';
import {
  emailBody, FetchLike, RESEND_TIMEOUT_MS, ResendClient, ResendEmail, ResendError, templateTag,
} from './resend-client';

const KEY = 're_Ab12Cd34_secretpart';

/** A `fetch` that answers every request with `answer`, and keeps what it was asked. */
function stub(answer: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn: FetchLike = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  });
  return { fetchFn, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const EMAIL: ResendEmail = {
  from: 'AgencyBoost <no-reply@notify.agencyboost.id>',
  to: 'rina@agencyboost.id',
  subject: 'Atur ulang kata sandi',
  text: 'Halo,\n\nhttps://agencyboost.id/reset',
  html: '<p>Halo,</p>',
  replyTo: 'help@agencyboost.id',
  template: 'auth.password_reset',
};

/** What a call threw. */
async function refusal(call: Promise<unknown>): Promise<ResendError> {
  try {
    await call;
  } catch (err) {
    return err as ResendError;
  }
  throw new Error('it did not throw');
}

/**
 * **Resend's HTTP API, as the product calls it** (P19.12-T1, ADR-0244): the request it makes, the id it keeps, and a
 * refusal shaped so the delivery row records what Resend said — with `fetch` stubbed, so no request leaves.
 */
describe('P19.12-T1 the Resend client', () => {
  describe('sending one email', () => {
    it('P19.12-T1 AC-1 posts to /emails with the key as a bearer token, the idempotency key, and Resend\'s field names', async () => {
      const { fetchFn, calls } = stub(() => json(200, { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }));

      const sent = await new ResendClient(KEY, fetchFn).sendEmail(EMAIL, 'idem-1');

      expect(sent).toEqual({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });
      expect(calls).toHaveLength(1);
      const [{ url, init }] = calls;
      expect(url).toBe('https://api.resend.com/emails');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        Authorization: `Bearer ${KEY}`,
        'User-Agent': 'agencyboost-api',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-1',
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(init.body))).toEqual({
        from: 'AgencyBoost <no-reply@notify.agencyboost.id>',
        to: ['rina@agencyboost.id'],
        subject: 'Atur ulang kata sandi',
        text: 'Halo,\n\nhttps://agencyboost.id/reset',
        html: '<p>Halo,</p>',
        reply_to: 'help@agencyboost.id',
        tags: [{ name: 'template', value: 'auth_password_reset' }],
      });
    });

    it('P19.12-T1 AC-1 sends no reply_to and no tag when there is none, and an id Resend did not give is undefined', async () => {
      expect(emailBody({ ...EMAIL, replyTo: undefined, template: undefined })).toEqual({
        from: EMAIL.from, to: [EMAIL.to], subject: EMAIL.subject, text: EMAIL.text, html: EMAIL.html,
      });
      const { fetchFn } = stub(() => json(200, {}));
      expect(await new ResendClient(KEY, fetchFn).sendEmail(EMAIL, 'idem-1')).toEqual({ id: undefined });
    });

    it('P19.12-T1 a tag holds letters, digits, _ and - alone', () => {
      expect(templateTag('auth.password_reset')).toBe('auth_password_reset');
      expect(templateTag('member.role_changed')).toBe('member_role_changed');
      expect(templateTag('send-test-mail')).toBe('send-test-mail');
      expect(templateTag('a b/c:é')).toBe('a_b_c__');
      expect(templateTag('x'.repeat(300))).toHaveLength(256);
    });
  });

  describe('a refusal', () => {
    it('P19.12-T1 AC-2 carries Resend\'s name, status and message where providerAnswerOf reads them', async () => {
      const { fetchFn } = stub(() => json(403, {
        statusCode: 403, name: 'validation_error', message: 'The notify.agencyboost.id domain is not verified.',
      }));

      const err = await refusal(new ResendClient(KEY, fetchFn).sendEmail(EMAIL, 'idem-1'));

      expect(err).toBeInstanceOf(ResendError);
      expect(err).toMatchObject({
        name: 'ResendError', code: 'validation_error', responseCode: 403,
        response: 'The notify.agencyboost.id domain is not verified.', retryAfterMs: undefined,
      });
      expect(err.message).toBe('Resend answered 403 validation_error: The notify.agencyboost.id domain is not verified.');
      // Recorded on the row as an SMTP reply is, the message quoting the answer once.
      expect(providerAnswerOf(err)).toEqual({
        error: 'Resend answered 403 validation_error: The notify.agencyboost.id domain is not verified.',
        code: 'validation_error', responseCode: 403, response: 'The notify.agencyboost.id domain is not verified.',
      });
    });

    it('P19.12-T1 AC-2 reads a 429\'s retry-after in seconds, and nothing from a date or from another status', async () => {
      const limited = (headers: Record<string, string>) => stub(() => json(429, { name: 'rate_limit_exceeded', message: 'Too many requests.' }, headers));
      expect(await refusal(new ResendClient(KEY, limited({ 'retry-after': '2' }).fetchFn).sendEmail(EMAIL, 'k')))
        .toMatchObject({ code: 'rate_limit_exceeded', responseCode: 429, retryAfterMs: 2_000 });
      expect(await refusal(new ResendClient(KEY, limited({ 'retry-after': '0.5' }).fetchFn).sendEmail(EMAIL, 'k')))
        .toMatchObject({ retryAfterMs: 500 });
      expect((await refusal(new ResendClient(KEY, limited({ 'retry-after': 'Wed, 11 Nov 2026 03:00:00 GMT' }).fetchFn)
        .sendEmail(EMAIL, 'k'))).retryAfterMs).toBeUndefined();
      expect((await refusal(new ResendClient(KEY, limited({}).fetchFn).sendEmail(EMAIL, 'k'))).retryAfterMs).toBeUndefined();
      expect((await refusal(new ResendClient(KEY, limited({ 'retry-after': ' ' }).fetchFn).sendEmail(EMAIL, 'k'))).retryAfterMs)
        .toBeUndefined();
      const busy = stub(() => json(503, { name: 'service_unavailable', message: 'API is temporarily unavailable' }, { 'retry-after': '3' }));
      expect((await refusal(new ResendClient(KEY, busy.fetchFn).sendEmail(EMAIL, 'k'))).retryAfterMs).toBeUndefined();
    });

    it('P19.12-T1 AC-2 a body that is not Resend\'s JSON is named by its status, with no message', async () => {
      const { fetchFn } = stub(() => new Response('<html>Bad gateway</html>', { status: 502 }));
      const err = await refusal(new ResendClient(KEY, fetchFn).sendEmail(EMAIL, 'k'));
      expect(err).toMatchObject({ code: 'http_502', responseCode: 502, response: undefined });
      expect(err.message).toBe('Resend answered 502 http_502');
      const blank = await refusal(new ResendClient(KEY, stub(() => json(500, { message: '  ' })).fetchFn).sendEmail(EMAIL, 'k'));
      expect(blank).toMatchObject({ code: 'http_500', response: undefined });
      const scalar = await refusal(new ResendClient(KEY, stub(() => json(500, 'oops')).fetchFn).sendEmail(EMAIL, 'k'));
      expect(scalar).toMatchObject({ code: 'http_500' });
    });

    it('P19.12-T1 AC-2 no answer within the timeout is ETIMEDOUT, with no status', async () => {
      const { fetchFn } = stub(() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
      const err = await refusal(new ResendClient(KEY, fetchFn).sendEmail(EMAIL, 'k'));
      expect(err).toMatchObject({ code: 'ETIMEDOUT', responseCode: undefined });
      expect(err.message).toBe(`Resend did not answer within ${RESEND_TIMEOUT_MS} ms`);
      const aborted = stub(() => { throw new DOMException('aborted', 'AbortError'); });
      expect(await refusal(new ResendClient(KEY, aborted.fetchFn, 2_500).sendEmail(EMAIL, 'k')))
        .toMatchObject({ code: 'ETIMEDOUT', message: 'Resend did not answer within 2500 ms' });
    });

    it('P19.12-T1 AC-2 a network failure is named by the network\'s own code, else ENETWORK', async () => {
      const dns = stub(() => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.resend.com'), { code: 'ENOTFOUND' }) });
      });
      expect(await refusal(new ResendClient(KEY, dns.fetchFn).sendEmail(EMAIL, 'k'))).toMatchObject({
        code: 'ENOTFOUND', responseCode: undefined, message: 'Resend could not be reached: getaddrinfo ENOTFOUND api.resend.com',
      });
      const bare = stub(() => { throw new TypeError('fetch failed'); });
      expect(await refusal(new ResendClient(KEY, bare.fetchFn).sendEmail(EMAIL, 'k')))
        .toMatchObject({ code: 'ENETWORK', message: 'Resend could not be reached: fetch failed' });
      const odd = stub(() => { throw 'socket hang up'; }); // eslint-disable-line @typescript-eslint/only-throw-error
      expect(await refusal(new ResendClient(KEY, odd.fetchFn).sendEmail(EMAIL, 'k')))
        .toMatchObject({ code: 'ENETWORK', message: 'Resend could not be reached: socket hang up' });
    });

    it('P19.12-T1 AC-1 never carries the key, even where an answer quotes it', async () => {
      const quoting = stub(() => json(401, { name: 'validation_error', message: `API key ${KEY} is invalid` }));
      const err = await refusal(new ResendClient(KEY, quoting.fetchFn).sendEmail(EMAIL, 'k'));
      expect(err.message).toBe('Resend answered 401 validation_error: API key re_******** is invalid');
      expect(JSON.stringify({ ...err, message: err.message })).not.toContain(KEY);
      const network = stub(() => { throw new TypeError('fetch failed', { cause: new Error(`refused for ${KEY}`) }); });
      expect((await refusal(new ResendClient(KEY, network.fetchFn).sendEmail(EMAIL, 'k'))).message).not.toContain(KEY);
      // With no key there is nothing to mask, and the answer is kept as it was said.
      const missing = stub(() => json(401, { name: 'missing_api_key', message: 'Missing API key in the authorization header' }));
      expect((await refusal(new ResendClient('', missing.fetchFn).listDomains())).response)
        .toBe('Missing API key in the authorization header');
    });
  });

  describe('listing the domains', () => {
    it('P19.12-T1 AC-1 gets /domains with the key and nothing else, and reads each domain\'s name and status', async () => {
      const { fetchFn, calls } = stub(() => json(200, {
        object: 'list',
        data: [
          { id: 'd1', name: 'Notify.AgencyBoost.id', status: 'verified', region: 'ap-northeast-1' },
          { id: 'd2', name: 'mail.example.org', status: 'pending' },
          { id: 'd3' },
          'not a domain',
        ],
      }));

      expect(await new ResendClient(KEY, fetchFn).listDomains()).toEqual([
        { name: 'notify.agencyboost.id', status: 'verified' },
        { name: 'mail.example.org', status: 'pending' },
        { name: '', status: '' },
      ]);
      expect(calls[0].url).toBe('https://api.resend.com/domains');
      expect(calls[0].init).toMatchObject({ method: 'GET', headers: { Authorization: `Bearer ${KEY}`, 'User-Agent': 'agencyboost-api' } });
      expect(calls[0].init.body).toBeUndefined();
      expect(calls[0].init.headers).not.toHaveProperty('Idempotency-Key');
    });

    it('P19.12-T1 AC-1 an answer with no list is no domains; a sending-only key is refused with restricted_api_key', async () => {
      expect(await new ResendClient(KEY, stub(() => json(200, {})).fetchFn).listDomains()).toEqual([]);
      const restricted = stub(() => json(401, { name: 'restricted_api_key', message: 'This API key is restricted to only send emails' }));
      expect(await refusal(new ResendClient(KEY, restricted.fetchFn).listDomains()))
        .toMatchObject({ code: 'restricted_api_key', responseCode: 401 });
    });
  });
});
