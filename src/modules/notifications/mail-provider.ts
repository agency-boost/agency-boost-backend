import type SMTPTransport from 'nodemailer/lib/smtp-transport';

/**
 * **How mail leaves, decided by the environment alone** (P18.11-T18, ADR-0182).
 *
 * `MAIL_PROVIDER` names a provider and a preset fills its host, port and TLS, so switching from Gmail to SendGrid,
 * say, is a new version of the env file and a redeploy, never a code change. Pure: it reads a configuration and
 * answers, so the API (`SmtpChannelAdapter`, `app.module.ts`), boot validation (`env.validation.ts`) and the test
 * command (`cli/send-test-mail.ts`) all decide the same way from the same keys.
 *
 * `env.validation.ts` imports this file, so it imports nothing of the app's.
 */

/**
 * **How long a mail relay may take to answer a dial, or to greet once dialled** (P12.1-T1), unless
 * `SMTP_TIMEOUT_MS` says otherwise. nodemailer's own default is two minutes. Email is no longer awaited
 * inside a request, so this bounds how long a delivery stays `pending` and how long a start-up check
 * waits, not how long anybody waits for a save. *Moved here from `env.validation.ts` 2026-11-01 (P18.11-T18).*
 */
export const SMTP_TIMEOUT_MS_DEFAULT = 5_000;
/** The range `SMTP_TIMEOUT_MS` may take: long enough for a slow relay, never nodemailer's two minutes. */
export const SMTP_TIMEOUT_MS_RANGE = { MIN: 1_000, MAX: 60_000 } as const;
/**
 * Inactivity during an exchange, which covers sending as well as verifying. Measured on a network that blocks
 * outbound 587, nodemailer's defaults let `verify()` sit for 75 s before ETIMEDOUT.
 */
export const SMTP_SOCKET_TIMEOUT_MS = 30_000;

/** Every value `MAIL_PROVIDER` takes. `smtp` is any relay, named by `SMTP_HOST`; `log` sends nothing. */
export const MAIL_PROVIDERS = ['gmail', 'sendgrid', 'mailjet', 'clicksend', 'ses', 'smtp', 'log'] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];
/** The two values `MAIL_TRANSPORT`, the key `MAIL_PROVIDER` replaces, ever took. */
export const LEGACY_MAIL_TRANSPORTS = ['smtp', 'log'] as const;

type PresetProvider = Exclude<MailProvider, 'smtp' | 'log'>;

interface Preset {
  readonly host: string;
  readonly port: number;
  /** What `SMTP_USER` holds for this provider, in the words of the refusal that names it. */
  readonly user: string;
  /** What `SMTP_PASSWORD` holds. */
  readonly pass: string;
}

/**
 * **The relays a provider name stands for.** Port 465 is implicit TLS and 587 negotiates STARTTLS, which a preset
 * requires (`transportOptionsFrom`). `SMTP_HOST` and `SMTP_PORT`, when written, override the preset's.
 */
export const MAIL_PRESETS: Readonly<Record<PresetProvider, Preset>> = {
  gmail: {
    host: 'smtp.gmail.com',
    port: 465,
    user: 'the Gmail address itself',
    pass: 'a 16-letter App Password (Google Account, Security, App passwords), not the account\'s password',
  },
  sendgrid: {
    host: 'smtp.sendgrid.net',
    port: 587,
    user: 'the literal word apikey',
    pass: 'a SendGrid API key with the Mail Send permission',
  },
  mailjet: { host: 'in-v3.mailjet.com', port: 587, user: 'the Mailjet API key', pass: 'the Mailjet secret key' },
  clicksend: { host: 'smtp.clicksend.com', port: 587, user: 'the ClickSend username', pass: 'the ClickSend API key' },
  ses: {
    host: 'email-smtp.ap-southeast-3.amazonaws.com',
    port: 587,
    user: 'the SES SMTP user name',
    pass: 'the SES SMTP password',
  },
};

/** SendGrid authenticates every API key with this one user name. */
export const SENDGRID_SMTP_USER = 'apikey';

/** Where a plain `smtp` relay listens when `SMTP_PORT` does not say. */
const SMTP_PORT_DEFAULT = 587;

/** What the settings are read from: Nest's `ConfigService`, or the environment itself (the test command). */
export interface MailConfig {
  get(key: string): unknown;
}

export interface MailSettings {
  readonly provider: MailProvider;
  /** Empty for `log`, which dials nothing. */
  readonly host: string;
  /** `0` for `log`. */
  readonly port: number;
  /** Implicit TLS: port 465. */
  readonly secure: boolean;
  readonly user: string;
  /** Never logged and never printed. */
  readonly pass: string;
  readonly from: string;
  readonly replyTo: string | undefined;
  readonly timeoutMs: number;
}

export interface ResolvedMailSettings extends MailSettings {
  /** Said once at start-up, and by the test command: a configuration that works but will probably land in spam. */
  readonly warnings: readonly string[];
}

/** One key that is wrong, and why. */
export interface MailProblem {
  readonly key: string;
  readonly message: string;
}

/** A mail configuration that cannot send. Boot validation reports each problem against its key. */
export class MailConfigError extends Error {
  constructor(readonly problems: readonly MailProblem[]) {
    super(`The mail configuration is unusable: ${problems.map((p) => `${p.key} ${p.message}`).join('; ')}`);
  }
}

export interface ProviderChoice {
  readonly provider: MailProvider;
  /** The key that chose it, or `null` when neither was written and the default applied. */
  readonly key: 'MAIL_PROVIDER' | 'MAIL_TRANSPORT' | null;
}

/** A key's value as text, with an empty or blank one read as unset (`.env.example` writes `KEY=`). */
function text(config: MailConfig, key: string): string | undefined {
  const written = String(config.get(key) ?? '').trim();
  return written === '' ? undefined : written;
}

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

/**
 * **Which provider sends**: `MAIL_PROVIDER`, else the older `MAIL_TRANSPORT` (`smtp` or `log`), else `smtp`. So an
 * env file written before `MAIL_PROVIDER` existed boots exactly as it did. Throws on a value neither key takes, which
 * boot validation has already refused; the test command, which reads the raw environment, can meet one.
 */
export function resolveMailProvider(config: MailConfig): ProviderChoice {
  const named = text(config, 'MAIL_PROVIDER');
  if (named !== undefined) {
    if (!isOneOf(MAIL_PROVIDERS, named)) {
      throw new MailConfigError([{ key: 'MAIL_PROVIDER', message: `must be one of ${MAIL_PROVIDERS.join(', ')}, not "${named}".` }]);
    }
    return { provider: named, key: 'MAIL_PROVIDER' };
  }
  const legacy = text(config, 'MAIL_TRANSPORT');
  if (legacy !== undefined) {
    if (!isOneOf(LEGACY_MAIL_TRANSPORTS, legacy)) {
      throw new MailConfigError([{ key: 'MAIL_TRANSPORT', message: `must be smtp or log, not "${legacy}". MAIL_PROVIDER replaces it.` }]);
    }
    return { provider: legacy, key: 'MAIL_TRANSPORT' };
  }
  return { provider: 'smtp', key: null };
}

/** A whole, positive number of something, or a problem against its key. */
function wholeNumber(config: MailConfig, key: string, problems: MailProblem[]): number | undefined {
  const written = text(config, key);
  if (written === undefined) return undefined;
  const value = Number(written);
  if (Number.isInteger(value) && value > 0) return value;
  problems.push({ key, message: `must be a whole, positive number, not "${written}".` });
  return undefined;
}

/** The address inside `Name <address>`, or the whole value when it is a bare address; lower-cased. */
export function addressIn(mailbox: string): string {
  const angled = /<([^<>]*)>/.exec(mailbox);
  return (angled ? angled[1] : mailbox).trim().toLowerCase();
}

/** The domain an address is in, lower-cased and without a trailing dot; empty when it has no `@`. */
function domainOf(address: string): string {
  const bare = addressIn(address);
  const at = bare.lastIndexOf('@');
  return at < 0 ? '' : bare.slice(at + 1).replace(/\.$/, '');
}

/** The top-level domains RFC 2606 and RFC 6761 reserve, which no mail server on the internet receives for. */
const RESERVED_TLDS = ['test', 'example', 'invalid', 'localhost'];
/** And RFC 2606's three second-level names, kept for documentation. */
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

/**
 * **An address no relay on the internet can deliver to**: `rina@kpm.test`, `x@example.com`. The demo seed's people
 * have them. A real provider would accept each and bounce it a minute later, spending the sender's reputation and its
 * daily quota on mail nobody can read — the reason ADR-0152 kept staging in the SES sandbox. A plain `smtp` relay is
 * exempt: locally it is a mail catcher, where these are exactly the addresses wanted.
 */
export function isReservedAddress(address: string): boolean {
  const domain = domainOf(address);
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  return RESERVED_TLDS.includes(tld) || RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** The domains of Google's consumer mail: they publish DMARC, so nobody else may send as them. */
const GOOGLE_MAIL_DOMAINS = ['gmail.com', 'googlemail.com'];

/** A configuration that works but will probably land in spam, in the words the start-up log uses. */
function warningsFor(settings: MailSettings, choice: ProviderChoice, config: MailConfig): string[] {
  const warnings: string[] = [];
  const fromAddress = addressIn(settings.from);

  if (settings.provider === 'gmail' && fromAddress !== settings.user.toLowerCase()) {
    warnings.push(
      `MAIL_FROM is ${fromAddress}, but Gmail is signed in as ${settings.user}. Gmail rewrites From to the account `
        + 'that signed in, so DMARC will not align and the mail is likely to land in spam. Set MAIL_FROM to '
        + `"AgencyBoost <${settings.user}>".`,
    );
  }

  if (settings.provider !== 'gmail' && settings.provider !== 'smtp' && GOOGLE_MAIL_DOMAINS.includes(domainOf(fromAddress))) {
    warnings.push(
      `MAIL_FROM is a ${domainOf(fromAddress)} address sent through ${settings.provider}. Google's DMARC policy makes `
        + 'receivers distrust mail from that domain sent by anybody but Google, so it is likely to land in spam or be '
        + 'refused. Send from an address on a domain authenticated with the provider: agencyboost.id.',
    );
  }

  // The likeliest slip in a switch: the old relay's SMTP_HOST left in the file, dialled with the new provider's login.
  const preset = settings.provider === 'smtp' || settings.provider === 'log' ? undefined : MAIL_PRESETS[settings.provider];
  if (preset && settings.host !== preset.host) {
    warnings.push(
      `SMTP_HOST=${settings.host} overrides the ${settings.provider} preset's ${preset.host}. If it is left from another `
        + 'provider, remove SMTP_HOST and SMTP_PORT: the preset fills both.',
    );
  }

  const legacy = text(config, 'MAIL_TRANSPORT');
  if (choice.key === 'MAIL_PROVIDER' && legacy !== undefined && (legacy === 'log') !== (settings.provider === 'log')) {
    warnings.push(`MAIL_TRANSPORT=${legacy} is ignored: MAIL_PROVIDER=${settings.provider} decides. Remove MAIL_TRANSPORT.`);
  }
  return warnings;
}

/**
 * **The settings mail is sent with**, from `MAIL_PROVIDER` (or `MAIL_TRANSPORT`), `SMTP_HOST`, `SMTP_PORT`,
 * `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`, `MAIL_REPLY_TO` and `SMTP_TIMEOUT_MS`, plus any warning worth a line at
 * start-up. Throws `MailConfigError` naming every key that is wrong:
 *
 * - `SMTP_HOST` is required for `smtp` alone; a preset has its own, which a written value overrides.
 * - `SMTP_USER` and `SMTP_PASSWORD` are required for every preset; a plain relay may need neither. SendGrid's user is
 *   the literal `apikey`.
 * - A Gmail App Password is shown in four groups of four with spaces, and is read without them.
 */
export function mailSettingsFrom(config: MailConfig): ResolvedMailSettings {
  const choice = resolveMailProvider(config);
  const { provider } = choice;
  const problems: MailProblem[] = [];

  const from = text(config, 'MAIL_FROM') ?? '';
  if (!from) problems.push({ key: 'MAIL_FROM', message: 'is required: the sender, as "AgencyBoost <address>".' });
  const replyTo = text(config, 'MAIL_REPLY_TO');
  const timeoutMs = wholeNumber(config, 'SMTP_TIMEOUT_MS', problems) ?? SMTP_TIMEOUT_MS_DEFAULT;
  const port = wholeNumber(config, 'SMTP_PORT', problems);

  if (provider === 'log') {
    if (problems.length > 0) throw new MailConfigError(problems);
    return { provider, host: '', port: 0, secure: false, user: '', pass: '', from, replyTo, timeoutMs, warnings: [] };
  }

  const preset = provider === 'smtp' ? undefined : MAIL_PRESETS[provider];
  const host = text(config, 'SMTP_HOST') ?? preset?.host;
  if (!host) {
    problems.push({
      key: 'SMTP_HOST',
      message: 'is required when the mail provider is smtp: a plain relay has no preset host. Name the relay, or set '
        + `MAIL_PROVIDER to one with a preset: ${Object.keys(MAIL_PRESETS).join(', ')}.`,
    });
  }

  const user = text(config, 'SMTP_USER') ?? '';
  // Not trimmed: a relay's password may be anything. Gmail's alone is known to be letters, shown with spaces.
  const rawPass = String(config.get('SMTP_PASSWORD') ?? '');
  const pass = provider === 'gmail' ? rawPass.replace(/\s+/g, '') : rawPass;
  if (preset) {
    if (!user) problems.push({ key: 'SMTP_USER', message: `is required when MAIL_PROVIDER is ${provider}: ${preset.user}.` });
    if (!pass.trim()) problems.push({ key: 'SMTP_PASSWORD', message: `is required when MAIL_PROVIDER is ${provider}: ${preset.pass}.` });
  }
  if (provider === 'sendgrid' && user && user !== SENDGRID_SMTP_USER) {
    problems.push({
      key: 'SMTP_USER',
      message: `must be the literal word ${SENDGRID_SMTP_USER} when MAIL_PROVIDER is sendgrid, not "${user}": `
        + 'SendGrid signs every API key in with that one user name, and the key goes in SMTP_PASSWORD.',
    });
  }

  if (problems.length > 0) throw new MailConfigError(problems);

  const resolvedPort = port ?? preset?.port ?? SMTP_PORT_DEFAULT;
  const settings: MailSettings = {
    provider,
    host: host as string,
    port: resolvedPort,
    // 465 is implicit TLS; everything else negotiates STARTTLS. Getting this backwards is the single most common way
    // an SMTP client hangs rather than failing.
    secure: resolvedPort === 465,
    user,
    pass,
    from,
    replyTo,
    timeoutMs,
  };
  return { ...settings, warnings: warningsFor(settings, choice, config) };
}

/** Every problem `mailSettingsFrom` would throw, for boot validation to report against its key. */
export function mailConfigProblems(config: MailConfig): readonly MailProblem[] {
  try {
    mailSettingsFrom(config);
    return [];
  } catch (err) {
    if (err instanceof MailConfigError) return err.problems;
    throw err;
  }
}

/**
 * **The nodemailer transport for these settings**, the one place its options are written, so the API and the test
 * command dial the same way.
 *
 * - **A preset requires TLS before it authenticates**: on 587 a relay on the internet that stops offering STARTTLS is
 *   refused rather than sent the password in clear. A plain `smtp` relay negotiates TLS when offered, because locally
 *   it is a mail catcher with none.
 * - **Timeouts are stated**, because nodemailer's defaults are two minutes: the dial and the greeting are bounded by
 *   `SMTP_TIMEOUT_MS`, and inactivity during an exchange by `SMTP_SOCKET_TIMEOUT_MS`.
 */
export function transportOptionsFrom(settings: MailSettings): SMTPTransport.Options {
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    requireTLS: !settings.secure && settings.provider !== 'smtp',
    auth: settings.user ? { user: settings.user, pass: settings.pass } : undefined,
    connectionTimeout: settings.timeoutMs,
    greetingTimeout: settings.timeoutMs,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
  };
}

/** One line for a log or a terminal: the provider, where it dials, as whom and from what. Never the password. */
export function describeMail(settings: MailSettings): string {
  if (settings.provider === 'log') return 'provider log: email is written to the API log, and none is sent';
  const tls = settings.secure ? 'TLS' : settings.provider === 'smtp' ? 'STARTTLS if offered' : 'STARTTLS';
  return `provider ${settings.provider} via ${settings.host}:${settings.port} (${tls}), `
    + `as ${settings.user || '(no login)'}, from ${settings.from}`;
}
