import { z } from 'zod';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import {
  LEGACY_MAIL_TRANSPORTS, MAIL_PROVIDERS, mailConfigProblems, resolveMailProvider, SMTP_TIMEOUT_MS_DEFAULT,
  SMTP_TIMEOUT_MS_RANGE,
} from '@/modules/notifications/mail-provider';

/** An empty or blank value is unset, as `.env.example` writes an optional key: `KEY=`. */
const blankIsUnset = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

/**
 * Configuration is validated at boot. A missing or malformed key stops the process
 * with a named error rather than letting the app start and connect somewhere
 * unexpected — see docs/03-engineering/environments-and-configuration.md.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_DB_NAME: z.string().min(1).default('agencyboost'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('30d'),

  /**
   * **The private Cloud Storage bucket every file lives in** (P18.4-T2, ADR-0153): one per environment.
   * Required in staging and production (below, in `superRefine`). Unset in development or test, the API
   * still boots, with storage that refuses every upload and file link with `STORAGE_NOT_CONFIGURED`
   * (plan decision D12). An empty value is unset, as `.env.example`'s `GCS_BUCKET=` writes it.
   *
   * There are no storage credentials in configuration: the client uses Application Default
   * Credentials — the VM's service account when deployed, an impersonated one on a laptop.
   */
  GCS_BUCKET: z.string().trim().optional().transform((v) => v || undefined),
  /** Optional: the bucket's project, for when Application Default Credentials cannot tell. */
  GCS_PROJECT_ID: z.string().trim().optional().transform((v) => v || undefined),
  /**
   * **The first segment of every storage key** (`<prefix>/<owner>/<folder>/<id>`), naming the
   * environment that wrote it. `prod` in production and nowhere else (below, in `superRefine`), so a
   * laptop pointed at the wrong bucket still never writes where production's files are.
   */
  STORAGE_KEY_PREFIX: z.enum(['dev', 'staging', 'prod']).default('dev'),

  /**
   * **Which provider sends the mail** (P18.11-T18, ADR-0182): `gmail`, `sendgrid`, `mailjet`, `clicksend`, `ses`,
   * `smtp` (any relay, named by `SMTP_HOST`) or `log`. A preset fills the host, the port and TLS
   * (`mail-provider.ts`); `SMTP_HOST` and `SMTP_PORT`, when written, override it. Unset, `MAIL_TRANSPORT` decides,
   * and with neither it is `smtp`, so an env file written before this key boots as it did.
   *
   * `log` writes each message to the log instead of sending it, so a developer with no local mail catcher can still
   * read the link and finish a registration. **It is refused in production** (ADR-0019): an API that accepts a
   * registration and writes the verification link to stdout is the defect this was added to make impossible, not a
   * fallback. The refusal, and every rule that joins two keys, is below, in `superRefine`.
   *
   * *Since P19.12-T1 (ADR-0244):* `resend` too, which sends through Resend's HTTP API with `RESEND_API_KEY` and reads
   * no `SMTP_*` key. It is accepted in production.
   */
  MAIL_PROVIDER: z.preprocess(blankIsUnset, z.enum(MAIL_PROVIDERS).optional()),
  /**
   * **Resend's API key** (P19.12-T1, ADR-0244): required when `MAIL_PROVIDER` is `resend` and read by nothing else
   * (below, in `superRefine`). A *Sending access* key, each environment its own. Never logged and never printed.
   */
  RESEND_API_KEY: z.preprocess(blankIsUnset, z.string().trim().optional()),
  /** The key `MAIL_PROVIDER` replaces, read only when that is unset: `smtp` or `log`. */
  MAIL_TRANSPORT: z.preprocess(blankIsUnset, z.enum(LEGACY_MAIL_TRANSPORTS).optional()),
  /** Required for `smtp` alone (below); a preset has its own host. */
  SMTP_HOST: z.preprocess(blankIsUnset, z.string().trim().optional()),
  /** The preset's port unless written; 587 for a plain relay. 465 is implicit TLS, anything else STARTTLS. */
  SMTP_PORT: z.preprocess(blankIsUnset, z.coerce.number().int().positive().optional()),
  /** Required for every preset (below). SendGrid's is the literal `apikey`. */
  SMTP_USER: z.string().default(''),
  /** Required for every preset. A Gmail App Password is read without the spaces Google shows it with. */
  SMTP_PASSWORD: z.string().default(''),
  MAIL_FROM: z.string().min(1),
  /** Optional: where a reply goes, when not to `MAIL_FROM`. */
  MAIL_REPLY_TO: z.preprocess(blankIsUnset, z.string().trim().optional()),
  /** Connection and greeting timeout for SMTP, in milliseconds — see `SMTP_TIMEOUT_MS_DEFAULT`. */
  SMTP_TIMEOUT_MS: z.coerce.number().int()
    .min(SMTP_TIMEOUT_MS_RANGE.MIN).max(SMTP_TIMEOUT_MS_RANGE.MAX)
    .default(SMTP_TIMEOUT_MS_DEFAULT),

  /**
   * **Read by nothing** (P18.11-T18): every link an email carries is built from `APP_ORIGIN`. Optional since
   * 2026-11-01 and still checked as a URL when written, so an env file that has it boots as it did.
   */
  APP_BASE_URL: z.preprocess(blankIsUnset, z.string().url().optional()),
  CORS_ORIGINS: z.string().default(''),
  /**
   * Whether the browser treats a call to this API as cross-site.
   *
   * True when the app and the API sit on different registrable domains — which is exactly
   * the Vercel staging shape, where the frontend is one `*.vercel.app` host and the API is
   * another (ADR-0041). There, a `SameSite=Lax` refresh cookie is simply never sent, so
   * login appears to work and every refresh afterwards fails.
   *
   * It is a stated fact about the deployment rather than something inferred, because the
   * API cannot see its own public hostname reliably behind a proxy — and guessing wrong
   * in the permissive direction would weaken CSRF protection everywhere else.
   *
   * Spelled as an enum, not `z.coerce.boolean()`: coercion reads the string "false" as
   * true, and a security control that silently inverts when someone writes the obvious
   * value is not a control.
   */
  COOKIE_CROSS_SITE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Where a shared invite link points — the app's origin, not this API's. A joiner opens
   * a page, not an endpoint, and the two differ in every environment.
   */
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),

  RATE_LIMIT_LOGIN_PER_15M: z.coerce.number().int().positive().default(5),

  /**
   * **How many proxies stand between the client and this process** (P18.4-T1, ADR-0152), handed to
   * Express as `trust proxy`. `false` believes the socket: right when nothing is in front, as in
   * local development. Unset is `false` there, and **refused in staging and production** (below):
   * forgetting the key on a VM brought back the lockout described next, silently.
   *
   * Behind Caddy on the VM the socket is always Caddy, so `req.ip` is one address for everybody.
   * The login limiter keys on it, which meant five wrong passwords from anyone locked everyone out
   * for fifteen minutes, and every session row recorded the proxy's address instead of the
   * client's. `1` takes the last hop of `X-Forwarded-For`: the one Caddy wrote.
   *
   * A count rather than `true`. `true` trusts every hop, so the left-most entry, which is whatever
   * the client chose to send, becomes its IP and the limiter can be dodged by changing a header.
   * `0` is the same as `false`.
   */
  TRUST_PROXY: z
    .string()
    .trim()
    .optional()
    .refine((v) => v === undefined || v === 'false' || /^\d+$/.test(v), {
      message:
        'must be "false" or the number of proxies in front of the API (1 behind Caddy). '
        + '"true" is refused: it trusts every hop, so a client could set its own IP with a header.',
    })
    // `undefined` stays `undefined`, so the refinement below can tell "unset" from a written `false`.
    .transform((v): false | number | undefined => {
      if (v === undefined) return undefined;
      return v === 'false' || Number(v) === 0 ? false : Number(v);
    }),

  /**
   * Only the default applied when a Super Admin creates a tenant without specifying
   * one. Runtime code reads kpm.timezone — never this value.
   */
  DEFAULT_TENANT_TIMEZONE: z.string().default(DEFAULT_TENANT_TIMEZONE),
}).superRefine((env, ctx) => {
  if (env.COOKIE_CROSS_SITE && env.APP_ORIGIN.startsWith('http://')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['COOKIE_CROSS_SITE'],
      message:
        'requires HTTPS. A cross-site cookie is sent as "SameSite=None; Secure", and a '
        + 'browser discards a Secure cookie on a plain-http origin — the session would be '
        + 'dropped on every request with nothing in the logs to say why.',
    });
  }

  /*
   * Mail (P18.11-T18, ADR-0182): the provider either key chose, and the rules that join two keys — `SMTP_HOST` for a
   * plain relay, the credentials for a preset, SendGrid's `apikey` — written once, in `mail-provider.ts`, which the
   * adapter and the test command read too. Each is reported against its key. *Since P19.12-T1:* and Resend's, its key
   * and a `MAIL_FROM` it could send from.
   */
  const mail = { get: (key: string) => (env as Record<string, unknown>)[key] };
  const chosen = resolveMailProvider(mail);
  if (env.NODE_ENV === 'production' && chosen.provider === 'log') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [chosen.key ?? 'MAIL_PROVIDER'],
      message: chosen.key === 'MAIL_TRANSPORT'
        ? 'must be "smtp" in production. A production API that logs verification links '
          + 'instead of sending them accepts registrations it can never complete '
          + '(ADR-0019).'
        : 'may not be "log" in production. A production API that logs verification links instead of sending '
          + 'them accepts registrations it can never complete (ADR-0019). Name the provider that sends.',
    });
  }
  for (const problem of mailConfigProblems(mail)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [problem.key], message: problem.message });
  }

  /*
   * P18.4-T1 (the review's L2): a VM sits behind Caddy, so a missing `TRUST_PROXY` puts every client on
   * Caddy's address and one person's wrong passwords lock everybody out. Written as `false` is a decision
   * somebody took and is accepted; left out is refused.
   */
  if ((env.NODE_ENV === 'staging' || env.NODE_ENV === 'production') && env.TRUST_PROXY === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TRUST_PROXY'],
      message:
        `must be set when NODE_ENV is ${env.NODE_ENV}: 1 behind Caddy, or "false" if nothing stands in `
        + 'front. Left unset, every client would share the proxy\'s IP, and its login limit.',
    });
  }

  // P18.4-T2 (ADR-0153, D12): storage may be absent only where nobody depends on it.
  if ((env.NODE_ENV === 'staging' || env.NODE_ENV === 'production') && !env.GCS_BUCKET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['GCS_BUCKET'],
      message:
        `is required when NODE_ENV is ${env.NODE_ENV}. Without a bucket every upload and file `
        + 'link is refused (STORAGE_NOT_CONFIGURED), which only development and test accept.',
    });
  }

  if (env.NODE_ENV === 'production' && env.STORAGE_KEY_PREFIX !== 'prod') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STORAGE_KEY_PREFIX'],
      message: `must be "prod" in production, not "${env.STORAGE_KEY_PREFIX}": production's keys say so.`,
    });
  }

  if (env.NODE_ENV !== 'production' && env.STORAGE_KEY_PREFIX === 'prod') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STORAGE_KEY_PREFIX'],
      message:
        `may be "prod" only in production, and NODE_ENV is ${env.NODE_ENV}: nothing else may `
        + 'write keys that read as production\'s.',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid configuration — the process will not start.\n${problems}\n\n` +
        `Every key is documented in .env.example and in ` +
        `docs/03-engineering/environments-and-configuration.md.`,
    );
  }
  return result.data;
}
