import { z } from 'zod';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';

/**
 * **How long a mail relay may take to answer a dial, or to greet once dialled** (P12.1-T1), unless
 * `SMTP_TIMEOUT_MS` says otherwise. nodemailer's own default is two minutes. Email is no longer awaited
 * inside a request, so this bounds how long a delivery stays `pending` and how long a start-up check
 * waits, not how long anybody waits for a save.
 */
export const SMTP_TIMEOUT_MS_DEFAULT = 5_000;
/** The range `SMTP_TIMEOUT_MS` may take: long enough for a slow relay, never nodemailer's two minutes. */
export const SMTP_TIMEOUT_MS_RANGE = { MIN: 1_000, MAX: 60_000 } as const;

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
   * **The private Cloud Storage bucket every file lives in** (P18.7-T2, ADR-0153): one per environment.
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

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  MAIL_FROM: z.string().min(1),
  /** Connection and greeting timeout for SMTP, in milliseconds — see `SMTP_TIMEOUT_MS_DEFAULT`. */
  SMTP_TIMEOUT_MS: z.coerce.number().int()
    .min(SMTP_TIMEOUT_MS_RANGE.MIN).max(SMTP_TIMEOUT_MS_RANGE.MAX)
    .default(SMTP_TIMEOUT_MS_DEFAULT),
  /**
   * How mail leaves: over SMTP, or into the log.
   *
   * `log` exists so a developer with no local mail catcher can still read the link and
   * finish a registration. **It is refused in production** (ADR-0019): an API that accepts
   * a registration and writes the verification link to stdout is the defect this key was
   * added to make impossible, not a fallback. The refusal is below, in `superRefine`.
   */
  MAIL_TRANSPORT: z.enum(['smtp', 'log']).default('smtp'),

  APP_BASE_URL: z.string().url(),
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
   * **How many proxies stand between the client and this process** (P18.7-T1, ADR-0152), handed to
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

  if (env.NODE_ENV === 'production' && env.MAIL_TRANSPORT === 'log') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MAIL_TRANSPORT'],
      message:
        'must be "smtp" in production. A production API that logs verification links '
        + 'instead of sending them accepts registrations it can never complete '
        + '(ADR-0019).',
    });
  }

  /*
   * P18.7-T1 (the review's L2): a VM sits behind Caddy, so a missing `TRUST_PROXY` puts every client on
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

  // P18.7-T2 (ADR-0153, D12): storage may be absent only where nobody depends on it.
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
