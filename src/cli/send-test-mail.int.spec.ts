import { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { SMTPServer } from 'smtp-server';
import { FixedClock } from '@/common/clock/clock.port';
import { MailSettings } from '@/modules/notifications/mail-provider';
import { explainSendError, Io, parseArgs, run, testMailSubject, testMailText, USAGE } from './send-test-mail';

/** A stream that keeps what was written to it. */
function capture(): Writable & { text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return Object.assign(stream, { text: () => chunks.join('') });
}

/** Quoted-printable undone, so a test reads what the recipient reads (`smtp.int.spec.ts` has the reasoning). */
function decoded(raw: string): string {
  return raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

const PASSWORD = 'local app password 123';
const SENT_AT = new Date('2026-11-01T03:04:05.000Z');

/**
 * **The test email, from the command line** (P18.11-T18, ADR-0182), against a real SMTP server on the loopback that
 * asks for a login, the way the API container runs it: `run()` with the environment it is given.
 */
describe('send-test-mail (P18.11-T18)', () => {
  let server: SMTPServer;
  let port: number;
  const delivered: Array<{ to: string[]; raw: string }> = [];

  beforeAll(async () => {
    server = new SMTPServer({
      // No certificate: a plain relay negotiates TLS only when offered, and this one offers none.
      hideSTARTTLS: true,
      allowInsecureAuth: true,
      onAuth(auth, _session, callback) {
        if (auth.username === 'tester' && auth.password === PASSWORD) callback(null, { user: 'tester' });
        else callback(new Error('Invalid username or password'));
      },
      onRcptTo(address, _session, callback) {
        if (address.address.startsWith('refused@')) {
          callback(Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 }));
        } else {
          callback();
        }
      },
      onData(stream, session, callback) {
        let raw = '';
        stream.on('data', (chunk) => { raw += String(chunk); });
        stream.on('end', () => {
          delivered.push({ to: session.envelope.rcptTo.map((r) => r.address), raw });
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function io(env: Record<string, string | undefined> = {}): Io & { out: ReturnType<typeof capture>; err: ReturnType<typeof capture> } {
    const out = capture();
    const err = capture();
    return {
      stdout: out,
      stderr: err,
      env: {
        MAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'tester', SMTP_PASSWORD: PASSWORD,
        MAIL_FROM: 'AgencyBoost <no-reply@agencyboost.test>', MAIL_REPLY_TO: 'support@agencyboost.test',
        APP_ORIGIN: 'https://staging.agencyboost.test/', ...env,
      },
      out,
      err,
    };
  }
  const clock = new FixedClock(SENT_AT);

  it('P18.11-T18 sends one multipart message with the environment\'s settings, prints the server\'s answer and exits 0', async () => {
    const call = io();
    expect(await run(['ops@agencyboost.test'], call, clock)).toBe(0);

    const mail = delivered.at(-1)!;
    expect(mail.to).toEqual(['ops@agencyboost.test']);
    const headers = mail.raw.slice(0, mail.raw.search(/\r?\n\r?\n/));
    expect(headers).toMatch(/^Subject: \[AgencyBoost\] Email check, 2026-11-01 03:04 UTC$/m);
    expect(headers).toMatch(/^From: AgencyBoost <no-reply@agencyboost\.test>$/m);
    expect(headers).toMatch(/^Reply-To: support@agencyboost\.test$/m);
    expect(headers).toMatch(/^Content-Type: multipart\/alternative;/m);
    expect(mail.raw).toContain('Content-Type: text/plain');
    expect(mail.raw).toContain('Content-Type: text/html');
    const body = decoded(mail.raw);
    expect(body).toContain('AgencyBoost sent this email through smtp on 2026-11-01 03:04 UTC');
    expect(body).not.toContain('127.0.0.1');
    expect(body).toContain('<a href="https://staging.agencyboost.test"');

    expect(call.err.text()).toContain(`Mail: provider smtp via 127.0.0.1:${port} (STARTTLS if offered), as tester`);
    expect(call.err.text()).toContain('Sending to ops@agencyboost.test');
    expect(call.out.text()).toMatch(/^Sent\. The server answered: 250 /);
    expect(call.out.text()).toContain('Message id: <');
    expect(call.out.text()).toContain('in the spam folder');
    expect(call.out.text() + call.err.text()).not.toContain(PASSWORD);
  });

  it('P18.11-T18 takes a subject from --subject', async () => {
    expect(await run(['ops@agencyboost.test', '--subject', 'Spam check 1'], io(), clock)).toBe(0);
    expect(delivered.at(-1)!.raw).toMatch(/^Subject: Spam check 1$/m);
  });

  it('P18.11-T18 a refused login exits 1, says which keys to check, and never prints the password', async () => {
    const wrong = 'wrong pass word 999';
    const call = io({ SMTP_PASSWORD: wrong });
    expect(await run(['ops@agencyboost.test'], call, clock)).toBe(1);
    expect(call.err.text()).toMatch(/Sending failed: .*\(EAUTH 535\)/);
    expect(call.err.text()).toContain('The server refused SMTP_USER or SMTP_PASSWORD');
    expect(call.out.text() + call.err.text()).not.toContain(wrong);
  });

  it('P18.11-T18 an unreachable relay exits 1 and says to check the host and the port', async () => {
    const call = io({ SMTP_PORT: '1' });
    expect(await run(['ops@agencyboost.test'], call, clock)).toBe(1);
    expect(call.err.text()).toContain('Could not reach 127.0.0.1:1');
    expect(call.err.text()).toContain('587 and 465 are open');
  });

  it('P18.11-T18 a refused recipient exits 1 with the server\'s own words', async () => {
    const call = io();
    expect(await run(['refused@agencyboost.test'], call, clock)).toBe(1);
    expect(call.err.text()).toMatch(/Sending failed: .*Mailbox unavailable.*550/);
    expect(call.err.text()).not.toContain('Could not reach');
  });

  it.each([
    [[], USAGE],
    [['a@agencyboost.test', 'b@agencyboost.test'], USAGE],
    [['not-an-address'], '"not-an-address" is not an email address.'],
    [['a@agencyboost.test', '--subject'], '--subject needs a value.'],
    [['a@agencyboost.test', '--subject', '  '], '--subject needs a value.'],
    [['a@agencyboost.test', '--to'], 'Unknown option --to.'],
    [['--help'], USAGE],
    [['-h'], USAGE],
  ])('P18.11-T18 %j is a usage error: exit 2, nothing sent', async (argv, said) => {
    const before = delivered.length;
    const call = io();
    expect(await run(argv, call, clock)).toBe(2);
    expect(call.err.text()).toContain(said);
    expect(delivered).toHaveLength(before);
  });

  it('P18.11-T18 settings that cannot send exit 1, naming each key, before anything is dialled', async () => {
    const call = io({ MAIL_PROVIDER: 'gmail', SMTP_HOST: undefined, SMTP_PORT: undefined, SMTP_USER: undefined, SMTP_PASSWORD: '' });
    expect(await run(['ops@agencyboost.test'], call, clock)).toBe(1);
    expect(call.err.text()).toContain('The mail settings cannot send:');
    expect(call.err.text()).toContain('  SMTP_USER is required when MAIL_PROVIDER is gmail');
    expect(call.err.text()).toContain('  SMTP_PASSWORD is required when MAIL_PROVIDER is gmail');

    const unknown = io({ MAIL_PROVIDER: 'postmark' });
    expect(await run(['ops@agencyboost.test'], unknown, clock)).toBe(1);
    expect(unknown.err.text()).toContain('MAIL_PROVIDER must be one of resend, gmail, sendgrid, mailjet, clicksend, ses, smtp, log');
  });

  it('P18.11-T18 the log provider exits 1: this environment sends no mail to test', async () => {
    const call = io({ MAIL_PROVIDER: 'log' });
    expect(await run(['ops@agencyboost.test'], call, clock)).toBe(1);
    expect(call.err.text()).toContain('The mail provider is log');
  });

  it('P18.11-T18 prints the Gmail warning, and refuses a reserved address through a real provider without dialling', async () => {
    const before = delivered.length;
    const call = io({
      MAIL_PROVIDER: 'gmail', SMTP_HOST: undefined, SMTP_PORT: undefined, SMTP_USER: 'agencyboostid@gmail.com',
      SMTP_PASSWORD: 'abcd efgh ijkl mnop',
    });
    expect(await run(['rina@kpm.test'], call, clock)).toBe(1);
    expect(call.err.text()).toMatch(/^Warning: MAIL_FROM is no-reply@agencyboost\.test, but Gmail is signed in as agencyboostid@gmail\.com/m);
    expect(call.err.text()).toContain('rina@kpm.test is in a reserved domain');
    expect(call.err.text()).not.toMatch(/abcd|mnop/);
    expect(delivered).toHaveLength(before);
  });

  /** **Through Resend** (P19.12-T1 AC-3, ADR-0244): the same command, Resend's API answered by a stub. */
  describe('through Resend (P19.12-T1)', () => {
    const KEY = 're_Ab12Cd34_secretpart';
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    function resendIo(answer: () => Response, env: Record<string, string | undefined> = {}) {
      const asked: Array<{ url: string; init: RequestInit }> = [];
      const call = io({
        MAIL_PROVIDER: 'resend', RESEND_API_KEY: KEY, MAIL_FROM: 'AgencyBoost <no-reply@notify.agencyboost.id>',
        MAIL_REPLY_TO: 'help@agencyboost.id', SMTP_HOST: undefined, SMTP_PORT: undefined, SMTP_USER: undefined,
        SMTP_PASSWORD: undefined, ...env,
      });
      call.fetch = async (url, init) => {
        asked.push({ url, init });
        return answer();
      };
      return { call, asked };
    }

    it('P19.12-T1 AC-3 sends the message through Resend\'s API, prints Resend\'s id, exits 0, and never the key', async () => {
      const before = delivered.length;
      const { call, asked } = resendIo(() => json(200, { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }));

      expect(await run(['ops@agencyboost.id'], call, clock)).toBe(0);

      expect(asked).toHaveLength(1);
      expect(asked[0].url).toBe('https://api.resend.com/emails');
      expect(asked[0].init.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, 'Idempotency-Key': expect.any(String) });
      const body = JSON.parse(String(asked[0].init.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        from: 'AgencyBoost <no-reply@notify.agencyboost.id>', to: ['ops@agencyboost.id'],
        subject: '[AgencyBoost] Email check, 2026-11-01 03:04 UTC', reply_to: 'help@agencyboost.id',
        tags: [{ name: 'template', value: 'send-test-mail' }],
      });
      expect(String(body.text)).toContain('AgencyBoost sent this email through resend on 2026-11-01 03:04 UTC');
      expect(String(body.html)).toContain('<a href="https://staging.agencyboost.test"');

      expect(call.err.text()).toContain('Mail: provider resend via the HTTP API at api.resend.com, from AgencyBoost <no-reply@notify.agencyboost.id>');
      expect(call.out.text()).toBe('Sent. Resend accepted the message.\nResend id: 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794\n'
        + 'Now look for it in the inbox, and in the spam folder. Resend\'s dashboard, Emails, shows what became of it.\n');
      expect(call.out.text() + call.err.text()).not.toContain(KEY);
      // Nothing went over SMTP.
      expect(delivered).toHaveLength(before);
    });

    it('P19.12-T1 AC-3 an id Resend did not give is said so', async () => {
      const { call } = resendIo(() => json(200, {}));
      expect(await run(['ops@agencyboost.id'], call, clock)).toBe(0);
      expect(call.out.text()).toContain('Resend id: (none given)');
    });

    it.each([
      [403, 'validation_error', 'MAIL_FROM\'s domain is not verified in Resend'],
      [401, 'missing_api_key', 'Resend refused RESEND_API_KEY'],
      [403, 'restricted_api_key', 'Resend refused RESEND_API_KEY'],
      [403, 'suspended_api_key', 'Resend refused RESEND_API_KEY'],
      [422, 'invalid_parameter', 'Resend refused a field of the message'],
      [400, 'validation_error', 'Resend refused a field of the message'],
      [429, 'daily_quota_exceeded', 'Resend\'s plan has no email left for this period'],
      [429, 'monthly_quota_exceeded', 'Resend\'s plan has no email left for this period'],
      [429, 'rate_limit_exceeded', 'Too many requests a second to Resend'],
    ])('P19.12-T1 AC-3 a %d %s exits 1 with Resend\'s words and what to check, the key masked', async (status, name, hint) => {
      const { call } = resendIo(() => json(status, { statusCode: status, name, message: `refused for ${KEY}` }));
      expect(await run(['ops@agencyboost.id'], call, clock)).toBe(1);
      expect(call.err.text()).toContain(`Sending failed: Resend answered ${status} ${name}: refused for re_******** (${name} ${status})`);
      expect(call.err.text()).toContain(hint);
      expect(call.out.text() + call.err.text()).not.toContain(KEY);
    });

    it('P19.12-T1 AC-3 an invalid key, which Resend calls a validation_error, is said to be the key', async () => {
      const { call } = resendIo(() => json(401, { statusCode: 401, name: 'validation_error', message: 'API key is invalid' }));
      expect(await run(['ops@agencyboost.id'], call, clock)).toBe(1);
      expect(call.err.text()).toContain('Sending failed: Resend answered 401 validation_error: API key is invalid');
      expect(call.err.text()).toContain('Resend refused RESEND_API_KEY: missing, invalid, not active or suspended.');
    });

    it('P19.12-T1 AC-3 no answer from Resend exits 1 and says to check the way out', async () => {
      const { call } = resendIo(() => { throw new DOMException('timeout', 'TimeoutError'); });
      expect(await run(['ops@agencyboost.id'], call, clock)).toBe(1);
      expect(call.err.text()).toContain('Sending failed: Resend did not answer within 10000 ms (ETIMEDOUT)');
      expect(call.err.text()).toContain('Could not reach api.resend.com over HTTPS');
    });

    it('P19.12-T1 AC-3 an answer it has no hint for is printed as it is', async () => {
      const { call } = resendIo(() => json(500, { name: 'application_error', message: 'An unexpected error occurred.' }));
      expect(await run(['ops@agencyboost.id'], call, clock)).toBe(1);
      expect(call.err.text()).toBe(
        'Mail: provider resend via the HTTP API at api.resend.com, from AgencyBoost <no-reply@notify.agencyboost.id>\n'
          + 'Sending to ops@agencyboost.id\n'
          + 'Sending failed: Resend answered 500 application_error: An unexpected error occurred. (application_error 500)\n',
      );
    });

    it('P19.12-T1 AC-3 settings that cannot send through Resend exit 1, naming each key, before anything is asked', async () => {
      const { call, asked } = resendIo(() => json(200, {}), { RESEND_API_KEY: undefined, MAIL_FROM: 'agencyboostid@gmail.com' });
      expect(await run(['ops@agencyboost.id'], call, clock)).toBe(1);
      expect(call.err.text()).toContain('  RESEND_API_KEY is required when MAIL_PROVIDER is resend');
      expect(call.err.text()).toContain('  MAIL_FROM may not be a gmail.com address when MAIL_PROVIDER is resend');
      expect(asked).toHaveLength(0);
    });

    it('P19.12-T1 AC-3 refuses a reserved address without asking Resend, and warns about a leftover SMTP login, masked', async () => {
      const { call, asked } = resendIo(() => json(200, {}), { SMTP_PASSWORD: 'abcd efgh ijkl mnop' });
      expect(await run(['rina@kpm.test'], call, clock)).toBe(1);
      expect(call.err.text()).toMatch(/^Warning: SMTP_PASSWORD is ignored: MAIL_PROVIDER=resend/m);
      expect(call.err.text()).toContain('rina@kpm.test is in a reserved domain no mail server receives for (RFC 2606): resend would accept it');
      expect(call.err.text()).not.toMatch(/abcd|mnop/);
      expect(asked).toHaveLength(0);
    });

    it('P19.12-T1 AC-3 the log provider\'s refusal names resend among the providers that send', async () => {
      const call = io({ MAIL_PROVIDER: 'log' });
      expect(await run(['ops@agencyboost.test'], call, clock)).toBe(1);
      expect(call.err.text()).toContain('Set MAIL_PROVIDER to resend, gmail, sendgrid, mailjet, clicksend, ses or smtp.');
    });

    it('P19.12-T1 AC-3 explains a Resend failure that is not Resend\'s answer as it is', () => {
      const settings: MailSettings = {
        provider: 'resend', host: 'api.resend.com', port: 443, secure: true, user: '', pass: '', apiKey: KEY,
        from: 'x', replyTo: undefined, timeoutMs: 5_000,
      };
      expect(explainSendError('boom', settings)).toBe('Sending failed: boom');
      expect(explainSendError(Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }), settings))
        .toContain('Could not reach api.resend.com over HTTPS');
      expect(explainSendError(Object.assign(new Error('API key is invalid'), { responseCode: 401 }), settings))
        .toContain('Resend refused RESEND_API_KEY');
      expect(explainSendError(Object.assign(new Error('odd'), { responseCode: 418 }), settings)).toBe('Sending failed: odd (418)');
    });
  });

  describe('its parts', () => {
    const settings: MailSettings = {
      provider: 'ses', host: 'email-smtp.ap-southeast-3.amazonaws.com', port: 587, secure: false, user: 'u', pass: 'p',
      apiKey: '', from: 'x', replyTo: undefined, timeoutMs: 5_000,
    };

    it('P18.11-T18 parses the recipient and the subject', () => {
      expect(parseArgs([' ops@agencyboost.id ', '--subject', ' Hi '])).toEqual({ to: 'ops@agencyboost.id', subject: 'Hi' });
      expect(parseArgs(['ops@agencyboost.id'])).toEqual({ to: 'ops@agencyboost.id', subject: undefined });
    });

    it('P18.11-T18 the message names the provider and the minute, and the app only when it is known', () => {
      const text = testMailText(settings, SENT_AT, undefined);
      expect(text).toBe('Hello,\n\nAgencyBoost sent this email through ses on 2026-11-01 03:04 UTC, to check that its '
        + 'email reaches you. No reply is needed.\n\n— AgencyBoost');
      expect(testMailText(settings, SENT_AT, 'https://staging.agencyboost.id/')).toContain('\n\nThe app: https://staging.agencyboost.id\n\n');
      expect(testMailSubject(SENT_AT)).toBe('[AgencyBoost] Email check, 2026-11-01 03:04 UTC');
    });

    // Staging, 2026-11-02: the first version went to Gmail's spam, "similar to messages that were identified as spam".
    it('P18.11-T18 reads like the API\'s own mail: no "spam", no "test", and no server for a client to make a link of', () => {
      const words = `${testMailSubject(SENT_AT)}\n${testMailText(settings, SENT_AT, 'https://staging.agencyboost.id')}`;
      expect(words).not.toMatch(/spam|test/i);
      expect(words).not.toContain(settings.host);
      expect(words).not.toContain(String(settings.port));
      expect(words.startsWith('[AgencyBoost] ')).toBe(true);
    });

    it('P18.11-T18 explains a failure that is not an Error, and one with no SMTP code', () => {
      expect(explainSendError('boom', settings)).toBe('Sending failed: boom');
      expect(explainSendError(new Error('odd'), settings)).toBe('Sending failed: odd');
      expect(explainSendError(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }), settings))
        .toContain('Could not reach email-smtp.ap-southeast-3.amazonaws.com:587');
      expect(explainSendError(Object.assign(new Error('auth'), { responseCode: 534 }), settings))
        .toContain('refused SMTP_USER or SMTP_PASSWORD');
    });
  });
});
