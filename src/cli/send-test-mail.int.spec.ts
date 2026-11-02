import { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { SMTPServer } from 'smtp-server';
import { FixedClock } from '@/common/clock/clock.port';
import { MailSettings } from '@/modules/notifications/mail-provider';
import { explainSendError, Io, parseArgs, run, testMailText, USAGE } from './send-test-mail';

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
 * **The test email, from the command line** (P18.99-T18, ADR-0182), against a real SMTP server on the loopback that
 * asks for a login, the way the API container runs it: `run()` with the environment it is given.
 */
describe('send-test-mail (P18.99-T18)', () => {
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

  it('P18.99-T18 sends one multipart message with the environment\'s settings, prints the server\'s answer and exits 0', async () => {
    const call = io();
    expect(await run(['ops@agencyboost.test'], call, clock)).toBe(0);

    const mail = delivered.at(-1)!;
    expect(mail.to).toEqual(['ops@agencyboost.test']);
    const headers = mail.raw.slice(0, mail.raw.search(/\r?\n\r?\n/));
    expect(headers).toMatch(/^Subject: AgencyBoost test email \(smtp, 127\.0\.0\.1, 2026-11-01T03:04:05\.000Z\)$/m);
    expect(headers).toMatch(/^From: AgencyBoost <no-reply@agencyboost\.test>$/m);
    expect(headers).toMatch(/^Reply-To: support@agencyboost\.test$/m);
    expect(headers).toMatch(/^Content-Type: multipart\/alternative;/m);
    expect(mail.raw).toContain('Content-Type: text/plain');
    expect(mail.raw).toContain('Content-Type: text/html');
    const body = decoded(mail.raw);
    expect(body).toContain('Provider: smtp');
    expect(body).toContain(`Server: 127.0.0.1:${port}`);
    expect(body).toContain('Sent at: 2026-11-01T03:04:05.000Z');
    expect(body).toContain('<a href="https://staging.agencyboost.test"');

    expect(call.err.text()).toContain(`Mail: provider smtp via 127.0.0.1:${port} (STARTTLS if offered), as tester`);
    expect(call.err.text()).toContain('Sending to ops@agencyboost.test');
    expect(call.out.text()).toMatch(/^Sent\. The server answered: 250 /);
    expect(call.out.text()).toContain('Message id: <');
    expect(call.out.text()).toContain('in the spam folder');
    expect(call.out.text() + call.err.text()).not.toContain(PASSWORD);
  });

  it('P18.99-T18 takes a subject from --subject', async () => {
    expect(await run(['ops@agencyboost.test', '--subject', 'Spam check 1'], io(), clock)).toBe(0);
    expect(delivered.at(-1)!.raw).toMatch(/^Subject: Spam check 1$/m);
  });

  it('P18.99-T18 a refused login exits 1, says which keys to check, and never prints the password', async () => {
    const wrong = 'wrong pass word 999';
    const call = io({ SMTP_PASSWORD: wrong });
    expect(await run(['ops@agencyboost.test'], call, clock)).toBe(1);
    expect(call.err.text()).toMatch(/Sending failed: .*\(EAUTH 535\)/);
    expect(call.err.text()).toContain('The server refused SMTP_USER or SMTP_PASSWORD');
    expect(call.out.text() + call.err.text()).not.toContain(wrong);
  });

  it('P18.99-T18 an unreachable relay exits 1 and says to check the host and the port', async () => {
    const call = io({ SMTP_PORT: '1' });
    expect(await run(['ops@agencyboost.test'], call, clock)).toBe(1);
    expect(call.err.text()).toContain('Could not reach 127.0.0.1:1');
    expect(call.err.text()).toContain('587 and 465 are open');
  });

  it('P18.99-T18 a refused recipient exits 1 with the server\'s own words', async () => {
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
  ])('P18.99-T18 %j is a usage error: exit 2, nothing sent', async (argv, said) => {
    const before = delivered.length;
    const call = io();
    expect(await run(argv, call, clock)).toBe(2);
    expect(call.err.text()).toContain(said);
    expect(delivered).toHaveLength(before);
  });

  it('P18.99-T18 settings that cannot send exit 1, naming each key, before anything is dialled', async () => {
    const call = io({ MAIL_PROVIDER: 'gmail', SMTP_HOST: undefined, SMTP_PORT: undefined, SMTP_USER: undefined, SMTP_PASSWORD: '' });
    expect(await run(['ops@agencyboost.test'], call, clock)).toBe(1);
    expect(call.err.text()).toContain('The mail settings cannot send:');
    expect(call.err.text()).toContain('  SMTP_USER is required when MAIL_PROVIDER is gmail');
    expect(call.err.text()).toContain('  SMTP_PASSWORD is required when MAIL_PROVIDER is gmail');

    const unknown = io({ MAIL_PROVIDER: 'postmark' });
    expect(await run(['ops@agencyboost.test'], unknown, clock)).toBe(1);
    expect(unknown.err.text()).toContain('MAIL_PROVIDER must be one of gmail, sendgrid, mailjet, clicksend, ses, smtp, log');
  });

  it('P18.99-T18 the log provider exits 1: this environment sends no mail to test', async () => {
    const call = io({ MAIL_PROVIDER: 'log' });
    expect(await run(['ops@agencyboost.test'], call, clock)).toBe(1);
    expect(call.err.text()).toContain('The mail provider is log');
  });

  it('P18.99-T18 prints the Gmail warning, and refuses a reserved address through a real provider without dialling', async () => {
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

  describe('its parts', () => {
    const settings: MailSettings = {
      provider: 'ses', host: 'email-smtp.ap-southeast-3.amazonaws.com', port: 587, secure: false, user: 'u', pass: 'p',
      from: 'x', replyTo: undefined, timeoutMs: 5_000,
    };

    it('P18.99-T18 parses the recipient and the subject', () => {
      expect(parseArgs([' ops@agencyboost.id ', '--subject', ' Hi '])).toEqual({ to: 'ops@agencyboost.id', subject: 'Hi' });
      expect(parseArgs(['ops@agencyboost.id'])).toEqual({ to: 'ops@agencyboost.id', subject: undefined });
    });

    it('P18.99-T18 the message names the provider, the server and the time, and the app only when it is known', () => {
      const text = testMailText(settings, SENT_AT, undefined);
      expect(text).toContain('Provider: ses\nServer: email-smtp.ap-southeast-3.amazonaws.com:587\nSent at: 2026-11-01T03:04:05.000Z');
      expect(text).not.toContain('The app:');
    });

    it('P18.99-T18 explains a failure that is not an Error, and one with no SMTP code', () => {
      expect(explainSendError('boom', settings)).toBe('Sending failed: boom');
      expect(explainSendError(new Error('odd'), settings)).toBe('Sending failed: odd');
      expect(explainSendError(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }), settings))
        .toContain('Could not reach email-smtp.ap-southeast-3.amazonaws.com:587');
      expect(explainSendError(Object.assign(new Error('auth'), { responseCode: 534 }), settings))
        .toContain('refused SMTP_USER or SMTP_PASSWORD');
    });
  });
});
