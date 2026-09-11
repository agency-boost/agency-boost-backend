import { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { SMTPServer } from 'smtp-server';
import { RecipientAddressBook, SmtpChannelAdapter } from './smtp.adapter';
import { FixedClock } from '@/common/clock/clock.port';
import { EmailTemplateRenderer } from './email-renderer';
import { NotificationService } from './notification.service';
import { NotificationTemplate } from './notification.types';

/**
 * Delivery against a **real SMTP server**, not a stub (AC-7).
 *
 * The unit test mocks `nodemailer` and proves the adapter calls it correctly. That is not
 * the same claim: a client can call a library correctly and still never deliver, which is
 * the shape of every SMTP failure worth catching — the wrong `secure` flag for the port,
 * an auth handshake the server refuses, a message the server rejects at `RCPT TO`. Those
 * only appear against something that speaks the protocol back.
 */
/**
 * What the recipient reads, rather than what went over the wire.
 *
 * Nodemailer sends the body `quoted-printable`, which wraps at 76 characters with a soft
 * break — and a verification link is longer than that, so the raw message carries it split
 * across two lines as `…real-token-ab=\r\nc`. Every conforming client rejoins it, which is
 * what a soft break means; asserting on the raw bytes would be asserting that the encoding
 * did not happen. So the test decodes first and checks the link a person would actually
 * click.
 */
function decodeQuotedPrintable(raw: string): string {
  const joined = raw.replace(/=\r?\n/g, '');
  // Byte by byte, then decoded as UTF-8 in one go. Turning each `=XX` straight into a
  // character would give three Latin-1 characters where an em dash belongs, and the test
  // would then be asserting the mojibake rather than catching it.
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    if (joined[i] === '=' && /^[0-9A-F]{2}$/i.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(joined[i], 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

describe('SMTP, end to end (P4-T14 AC-7)', () => {
  let server: SMTPServer;
  let port: number;
  const delivered: Array<{ to: string[]; raw: string }> = [];

  beforeAll(async () => {
    server = new SMTPServer({
      // A local test server with no certificate. The adapter's own TLS decision is
      // exercised by the port it is given, which is the part that goes wrong in practice.
      authOptional: true,
      hideSTARTTLS: true,
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

  function adapter(address: string | null = 'rina@kpm.test') {
    const values: Record<string, unknown> = {
      SMTP_HOST: '127.0.0.1', SMTP_PORT: port, SMTP_USER: '', SMTP_PASSWORD: '',
      MAIL_FROM: 'AgencyBoost <no-reply@agencyboost.test>', MAIL_TRANSPORT: 'smtp',
      APP_ORIGIN: 'https://app.agencyboost.test',
    };
    const config = {
      get: (k: string) => values[k], getOrThrow: (k: string) => values[k],
    } as unknown as ConfigService;
    const book: RecipientAddressBook = { addressOf: async () => address };
    return { adapter: new SmtpChannelAdapter(config, book), config };
  }

  it('verifies a transport that is actually there', async () => {
    await expect(adapter().adapter.onModuleInit()).resolves.toBeUndefined();
  });

  it('delivers a verification mail a person could act on', async () => {
    const { adapter: smtp, config } = adapter();
    const rendered = new EmailTemplateRenderer(config)
      .render(NotificationTemplate.EMAIL_VERIFICATION, {
        token: 'real-token-abc', fullName: 'Rina Wijaya',
      });

    await smtp.send(
      { userId: 'u1', templateId: NotificationTemplate.EMAIL_VERIFICATION, payload: {} },
      rendered,
    );

    const mail = delivered.at(-1)!;
    const body = decodeQuotedPrintable(mail.raw);
    expect(mail.to).toEqual(['rina@kpm.test']);
    // The link is the whole product of this message. If it does not survive the transport
    // intact, the person cannot sign in — which is the failure the task exists to fix.
    expect(body).toContain('https://app.agencyboost.test/verify-email/real-token-abc');
    expect(body).toContain('Verify your email address');
    expect(body).toContain('no-reply@agencyboost.test');
    // The em dash in the sign-off is where a charset mistake would show up first.
    expect(body).toContain('— AgencyBoost');
  });

  it('carries a token from NotificationService to the delivered mail, and not to the row', async () => {
    /*
     * The seam, exercised whole: the service decides the channels, the renderer builds
     * the link, the adapter puts it on a socket. The e2e proves the other half — that a
     * token opened from a link verifies an account and lets it sign in — so between them
     * the journey is covered end to end.
     *
     * And ADR-0019's rule holds with a live adapter: the mail has the token, the stored
     * row does not.
     */
    const { adapter: smtp, config } = adapter('newcomer@kpm.test');
    const rows: Record<string, unknown>[] = [];
    const service = new NotificationService(
      { create: async (d: Record<string, unknown>) => { rows.push(d); return d; } } as never,
      { findOne: () => ({ exec: async () => null }) } as never,
      new EmailTemplateRenderer(config),
      new FixedClock(new Date('2026-09-11T00:00:00Z')),
      [smtp],
    );

    await service.send({
      userId: 'u-newcomer',
      templateId: NotificationTemplate.EMAIL_VERIFICATION,
      payload: { token: 'journey-token-xyz', fullName: 'Newcomer' },
    });

    const body = decodeQuotedPrintable(delivered.at(-1)!.raw);
    expect(body).toContain('https://app.agencyboost.test/verify-email/journey-token-xyz');
    expect((rows[0].delivery as Record<string, { status: string }>).email.status).toBe('sent');
    expect(rows[0].payload).toEqual({});
  });

  it('reports a refused connection rather than appearing to send', async () => {
    // A closed port, which is what a wrong SMTP_HOST looks like from here.
    const values: Record<string, unknown> = {
      SMTP_HOST: '127.0.0.1', SMTP_PORT: 1, SMTP_USER: '', SMTP_PASSWORD: '',
      MAIL_FROM: 'x@test', MAIL_TRANSPORT: 'smtp',
    };
    const config = {
      get: (k: string) => values[k], getOrThrow: (k: string) => values[k],
    } as unknown as ConfigService;
    const smtp = new SmtpChannelAdapter(config, { addressOf: async () => 'a@b.test' });

    await expect(smtp.send(
      { userId: 'u1', templateId: NotificationTemplate.PASSWORD_RESET, payload: {} },
      { subject: 'S', body: 'B' },
    )).rejects.toThrow();
  });
});
