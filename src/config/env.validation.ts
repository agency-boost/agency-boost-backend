import { z } from 'zod';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';

/**
 * Configuration is validated at boot. A missing or malformed key stops the process
 * with a named error rather than letting the app start and connect somewhere
 * unexpected — see docs/03-engineering/environments-and-configuration.md.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_DB_NAME: z.string().min(1).default('agencyboost'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('30d'),

  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),
  CLOUDINARY_FOLDER_PREFIX: z.enum(['dev', 'staging', 'prod']).default('dev'),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  MAIL_FROM: z.string().min(1),

  APP_BASE_URL: z.string().url(),
  CORS_ORIGINS: z.string().default(''),

  RATE_LIMIT_LOGIN_PER_15M: z.coerce.number().int().positive().default(5),

  /**
   * Only the default applied when a Super Admin creates a tenant without specifying
   * one. Runtime code reads kpm.timezone — never this value.
   */
  DEFAULT_TENANT_TIMEZONE: z.string().default(DEFAULT_TENANT_TIMEZONE),
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
