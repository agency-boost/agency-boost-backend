import type { Writable } from 'node:stream';
import { isEmail } from 'class-validator';
import { createTransport } from 'nodemailer';
import { Clock, SystemClock } from '@/common/clock/clock.port';
import { toHtml } from '@/modules/notifications/email-html';
import {
  describeMail, isReservedAddress, MailConfigError, type MailSettings, mailSettingsFrom, type ResolvedMailSettings,
  transportOptionsFrom,
} from '@/modules/notifications/mail-provider';

/**
 * **One test email, sent with an environment's own mail settings** (P18.99-T18, ADR-0182).
 *
 * After the provider changes (a new version of `api-env-<env>` and a redeploy), this is how the operator learns
 * whether mail leaves, without registering anybody:
 *
 *   node dist/cli/send-test-mail.js <to> [--subject "<subject>"]
 *
 * run inside the environment's API container by `deploy/bin/send-test-mail.sh <env> <to>`, so it reads the settings
 * that API booted with.
 *
 * - **The same settings as the API**: `mailSettingsFrom` and `transportOptionsFrom`, the two the adapter uses, over
 *   the same environment keys. Plain, with no Nest application: booting the API's module would ask for its whole
 *   configuration (the database, the JWT secrets, storage) to send one email.
 * - **The same shape as the API's mail**: multipart, the text and the HTML derived from it, `MAIL_REPLY_TO` when set.
 * - **It prints** the provider, the host and the port, then the server's answer or its error with a hint, and
 *   **never the password**: the configured one is masked in everything it writes.
 * - Exits `0` when the server accepted the message, `2` on a usage error and `1` on any other failure.
 */
export const USAGE = 'Usage: node dist/cli/send-test-mail.js <to> [--subject "<subject>"]\n'
  + '       Reads the mail settings from the environment, as the API does: run it where the API runs.';

/** A failure the person running the command can act on: printed as it is, with no stack. */
export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

export interface SendTestMailArgs {
  to: string;
  subject?: string;
}

/** The arguments after `node` and the script. */
export function parseArgs(argv: readonly string[]): SendTestMailArgs {
  const positional: string[] = [];
  let subject: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--subject') {
      const value = argv[i + 1]?.trim();
      if (!value) throw new CliError(`--subject needs a value.\n${USAGE}`, 2);
      subject = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      throw new CliError(USAGE, 2);
    } else if (arg.startsWith('-')) {
      throw new CliError(`Unknown option ${arg}.\n${USAGE}`, 2);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) throw new CliError(USAGE, 2);
  const to = positional[0].trim();
  if (!isEmail(to)) throw new CliError(`"${positional[0]}" is not an email address.\n${USAGE}`, 2);
  return { to, subject };
}

/** What the message says: who sent it, through what, and when, and where to look if it went to spam. */
export function testMailText(settings: MailSettings, sentAt: Date, appOrigin: string | undefined): string {
  return [
    'This is a test email from AgencyBoost, sent by send-test-mail.',
    '',
    `Provider: ${settings.provider}`,
    `Server: ${settings.host}:${settings.port}`,
    `Sent at: ${sentAt.toISOString()}`,
    ...(appOrigin ? ['', `The app: ${appOrigin.replace(/\/+$/, '')}`] : []),
    '',
    'If you are reading this in the inbox, mail from this environment arrives. If it landed in spam, see '
      + '"Staying out of spam" in docs/03-engineering/email-delivery.md.',
    '',
    '— AgencyBoost',
  ].join('\n');
}

/** The SMTP fields nodemailer puts on an error, when it has them. */
interface SmtpError {
  message: string;
  code?: string;
  responseCode?: number;
}

/**
 * The error, and what to look at first: the failures every provider produces. Read by its shape rather than by
 * `instanceof Error`, which a socket's error, made in another realm, can fail.
 */
export function explainSendError(err: unknown, settings: MailSettings): string {
  const { message, code, responseCode } = (
    typeof err === 'object' && err !== null && 'message' in err ? err : { message: String(err) }
  ) as SmtpError;
  const detail = [code, responseCode].filter((part) => part !== undefined).join(' ');
  const said = `Sending failed: ${message}${detail ? ` (${detail})` : ''}`;
  if (code === 'EAUTH' || responseCode === 535 || responseCode === 534) {
    return `${said}\nThe server refused SMTP_USER or SMTP_PASSWORD. Gmail takes an App Password, made after 2-Step `
      + 'Verification is on, never the account\'s own password; SendGrid\'s SMTP_USER is the word apikey.';
  }
  if (code !== undefined && ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED', 'EDNS'].includes(code)) {
    return `${said}\nCould not reach ${settings.host}:${settings.port}. Check SMTP_HOST and SMTP_PORT. Compute Engine `
      + 'blocks outbound port 25; 587 and 465 are open.';
  }
  return said;
}

export interface Io {
  stdout: Writable;
  stderr: Writable;
  env: Readonly<Record<string, string | undefined>>;
}

/** The command, start to finish; resolves to its exit code. */
export async function run(argv: readonly string[], io: Io, clock: Clock = new SystemClock()): Promise<number> {
  // Masked in everything written, whatever produced the text: the password as configured, and as Gmail's is read.
  const secrets = [io.env.SMTP_PASSWORD ?? '', (io.env.SMTP_PASSWORD ?? '').replace(/\s+/g, '')]
    .filter((secret) => secret.trim() !== '');
  const write = (stream: Writable, text: string) => {
    stream.write(secrets.reduce((masked, secret) => masked.split(secret).join('********'), text));
  };

  let settings: ResolvedMailSettings | null = null;
  try {
    const args = parseArgs(argv);
    try {
      settings = mailSettingsFrom({ get: (key) => io.env[key] });
    } catch (err) {
      if (!(err instanceof MailConfigError)) throw err;
      throw new CliError(`The mail settings cannot send:\n${err.problems.map((p) => `  ${p.key} ${p.message}`).join('\n')}`);
    }
    const resolved: ResolvedMailSettings = settings;
    if (resolved.provider === 'log') {
      throw new CliError('The mail provider is log: this environment writes email to its log and sends none. '
        + 'Set MAIL_PROVIDER to gmail, sendgrid, mailjet, clicksend, ses or smtp.');
    }
    for (const warning of resolved.warnings) write(io.stderr, `Warning: ${warning}\n`);
    if (resolved.provider !== 'smtp' && isReservedAddress(args.to)) {
      throw new CliError(`${args.to} is in a reserved domain no mail server receives for (RFC 2606): `
        + `${resolved.provider} would accept it and bounce it. Send to a real mailbox.`);
    }

    write(io.stderr, `Mail: ${describeMail(resolved)}\nSending to ${args.to}\n`);
    const sentAt = clock.now();
    const text = testMailText(resolved, sentAt, io.env.APP_ORIGIN);
    const transport = createTransport(transportOptionsFrom(resolved));
    try {
      const info = await transport.sendMail({
        from: resolved.from,
        to: args.to,
        subject: args.subject ?? `AgencyBoost test email (${resolved.provider}, ${resolved.host}, ${sentAt.toISOString()})`,
        text,
        html: toHtml(text),
        ...(resolved.replyTo ? { replyTo: resolved.replyTo } : {}),
      });
      write(io.stdout, `Sent. The server answered: ${info.response}\n`
        + `Message id: ${info.messageId}\n`
        + 'Now look for it in the inbox, and in the spam folder.\n');
      return 0;
    } finally {
      transport.close();
    }
  } catch (err) {
    if (err instanceof CliError) {
      write(io.stderr, `${err.message}\n`);
      return err.exitCode;
    }
    write(io.stderr, `${settings ? explainSendError(err, settings) : `send-test-mail failed: ${String(err)}`}\n`);
    return 1;
  }
}

// Run as the command, never on import: the spec imports `run` and drives it itself.
if (require.main === module) {
  void run(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env })
    .then((code) => process.exit(code));
}
