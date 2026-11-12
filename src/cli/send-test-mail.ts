import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import { isEmail } from 'class-validator';
import { createTransport } from 'nodemailer';
import { Clock, SystemClock } from '@/common/clock/clock.port';
import { toHtml } from '@/modules/notifications/email-html';
import {
  describeMail, isReservedAddress, MailConfigError, type MailSettings, mailSettingsFrom, type ResolvedMailSettings,
  transportOptionsFrom,
} from '@/modules/notifications/mail-provider';
import { type FetchLike, ResendClient } from '@/modules/notifications/resend-client';

/**
 * **One test email, sent with an environment's own mail settings** (P18.11-T18, ADR-0182).
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
 * - **With `MAIL_PROVIDER=resend`** (P19.12-T1 AC-3, ADR-0244) it posts the same message to Resend's API with the
 *   client the API uses (`resend-client.ts`) and prints Resend's id for it, by which Resend's dashboard finds the
 *   email. `RESEND_API_KEY` is masked as the password is. One attempt and no throttle: a person is waiting, and a
 *   refusal is what they came to read.
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

/** When it was sent, to the minute, for the subject and the body: `2026-11-02 03:59 UTC`. */
function sentAtLabel(sentAt: Date): string {
  return `${sentAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The subject when `--subject` names none: the API's own tag, and the minute, so two checks are told apart. */
export function testMailSubject(sentAt: Date): string {
  return `[AgencyBoost] Email check, ${sentAtLabel(sentAt)}`;
}

/**
 * What the message says, **shaped like the API's own mail** (`EMAIL_MESSAGES`): a greeting, a sentence, the app's
 * link and the sign-off. It predicts where the real emails land only if it reads like them.
 *
 * Its first version did not (staging, 2026-11-02: Gmail put it in spam, *"similar to messages that were identified
 * as spam in the past"*): it said *test email* in the subject and *spam* twice in the body, and named the SMTP server,
 * which Gmail made a link to another domain (`email-delivery.md` §7: every link is the app's own). So no word a
 * filter reads as a test or as spam, and no server: the provider, the host and the port are printed on the terminal.
 */
export function testMailText(settings: MailSettings, sentAt: Date, appOrigin: string | undefined): string {
  return [
    'Hello,',
    '',
    `AgencyBoost sent this email through ${settings.provider} on ${sentAtLabel(sentAt)}, to check that its email `
      + 'reaches you. No reply is needed.',
    ...(appOrigin ? ['', `The app: ${appOrigin.replace(/\/+$/, '')}`] : []),
    '',
    '— AgencyBoost',
  ].join('\n');
}

/** The SMTP fields nodemailer puts on an error, when it has them; `ResendError` carries the same. */
interface SmtpError {
  message: string;
  code?: string;
  responseCode?: number;
}

/** Resend's names for a key it refuses; an invalid key is a `validation_error` saying *API key is invalid*. */
const RESEND_KEY_REFUSALS = ['missing_api_key', 'restricted_api_key', 'suspended_api_key'];

/**
 * What to look at first when Resend refused the test message (P19.12-T1), by Resend's error `name`, status and words
 * (its *Errors* page, read 2026-11-11): the key, the domain, a field, the plan, or the network. `undefined` for
 * anything else, which is printed as it is.
 */
function resendHint(code: string | undefined, responseCode: number | undefined, message: string): string | undefined {
  if ((code !== undefined && RESEND_KEY_REFUSALS.includes(code)) || /api key/i.test(message)) {
    return 'Resend refused RESEND_API_KEY: missing, invalid, not active or suspended. Make a new key in Resend (API '
      + 'Keys, Create API key, Sending access) and put it in RESEND_API_KEY, unquoted.';
  }
  if (code === 'validation_error' && responseCode === 403) {
    return 'Resend refused the sender: MAIL_FROM\'s domain is not verified in Resend (Domains, then Verify DNS Records '
      + 'once its records are in DNS), or the key is limited to another domain.';
  }
  if (responseCode === 422 || (code === 'validation_error' && responseCode === 400)) {
    return 'Resend refused a field of the message: most often MAIL_FROM or MAIL_REPLY_TO is not an address. Write '
      + 'MAIL_FROM as AgencyBoost <no-reply@notify.agencyboost.id>, on the verified domain.';
  }
  if (code === 'daily_quota_exceeded' || code === 'monthly_quota_exceeded') {
    return 'Resend\'s plan has no email left for this period, shared by staging and production. Wait, or move to a '
      + 'larger plan (Resend, Settings, Billing).';
  }
  if (code === 'rate_limit_exceeded') return 'Too many requests a second to Resend. Try again in a moment.';
  if (code !== undefined && responseCode === undefined) {
    // No answer at all: `ETIMEDOUT`, or the network's own code (`ENOTFOUND`, `ECONNRESET` …).
    return 'Could not reach api.resend.com over HTTPS. Check the VM\'s outbound access to port 443.';
  }
  return undefined;
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
  if (settings.provider === 'resend') {
    const hint = resendHint(code, responseCode, message);
    return hint ? `${said}\n${hint}` : said;
  }
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
  /** How Resend is reached; Node's own `fetch` unless a spec answers for Resend. */
  fetch?: FetchLike;
}

/** The command, start to finish; resolves to its exit code. */
export async function run(argv: readonly string[], io: Io, clock: Clock = new SystemClock()): Promise<number> {
  // Masked in everything written, whatever produced the text: the password as configured, and as Gmail's is read, and
  // Resend's API key (P19.12-T1).
  const secrets = [
    io.env.SMTP_PASSWORD ?? '', (io.env.SMTP_PASSWORD ?? '').replace(/\s+/g, ''), (io.env.RESEND_API_KEY ?? '').trim(),
  ].filter((secret) => secret.trim() !== '');
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
        + 'Set MAIL_PROVIDER to resend, gmail, sendgrid, mailjet, clicksend, ses or smtp.');
    }
    for (const warning of resolved.warnings) write(io.stderr, `Warning: ${warning}\n`);
    if (resolved.provider !== 'smtp' && isReservedAddress(args.to)) {
      throw new CliError(`${args.to} is in a reserved domain no mail server receives for (RFC 2606): `
        + `${resolved.provider} would accept it and bounce it. Send to a real mailbox.`);
    }

    write(io.stderr, `Mail: ${describeMail(resolved)}\nSending to ${args.to}\n`);
    const sentAt = clock.now();
    const text = testMailText(resolved, sentAt, io.env.APP_ORIGIN);
    if (resolved.provider === 'resend') {
      const client = new ResendClient(resolved.apiKey, io.fetch ?? ((url, init) => fetch(url, init)));
      const { id } = await client.sendEmail({
        from: resolved.from,
        to: args.to,
        subject: args.subject ?? testMailSubject(sentAt),
        text,
        html: toHtml(text),
        replyTo: resolved.replyTo,
        template: 'send-test-mail',
      }, randomUUID());
      write(io.stdout, 'Sent. Resend accepted the message.\n'
        + `Resend id: ${id ?? '(none given)'}\n`
        + 'Now look for it in the inbox, and in the spam folder. Resend\'s dashboard, Emails, shows what became of it.\n');
      return 0;
    }
    const transport = createTransport(transportOptionsFrom(resolved));
    try {
      const info = await transport.sendMail({
        from: resolved.from,
        to: args.to,
        subject: args.subject ?? testMailSubject(sentAt),
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
