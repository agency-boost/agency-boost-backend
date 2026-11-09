import { validateEnv } from './env.validation';
import { MONGODB_DB_NAME_DEFAULT } from './mongo-target';
import { MAIL_PROVIDERS, resolveMailProvider } from '@/modules/notifications/mail-provider';

/** Which provider a validated configuration sends through, as `app.module.ts` reads it. */
const providerOf = (env: Record<string, unknown>) => resolveMailProvider({ get: (key) => env[key] }).provider;

const valid = {
  MONGODB_URI: 'mongodb://localhost:27017',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  SMTP_HOST: 'smtp.example.test',
  MAIL_FROM: 'AgencyBoost <no-reply@example.test>',
  APP_BASE_URL: 'http://localhost:3000',
};

describe('environment validation', () => {
  describe('SMTP_TIMEOUT_MS (P12.1-T1)', () => {
    it('P12.1-T1 defaults to 5 s, so a configuration written before the key existed still boots', () => {
      expect(validateEnv(valid).SMTP_TIMEOUT_MS).toBe(5_000);
    });

    it('P12.1-T1 reads a configured value, as the environment spells it', () => {
      expect(validateEnv({ ...valid, SMTP_TIMEOUT_MS: '8000' }).SMTP_TIMEOUT_MS).toBe(8_000);
    });

    it.each(['999', '60001', '2.5', 'soon'])('P12.1-T1 refuses %s: bounded, whole milliseconds', (value) => {
      expect(() => validateEnv({ ...valid, SMTP_TIMEOUT_MS: value })).toThrow(/SMTP_TIMEOUT_MS/);
    });
  });

  describe('mail transport (P4-T14, ADR-0019)', () => {
    it('defaults to SMTP, so the safe thing is what you get by not deciding', () => {
      // P18.11-T18: neither MAIL_PROVIDER nor MAIL_TRANSPORT written is a plain relay, as MAIL_TRANSPORT's default was.
      expect(providerOf(validateEnv(valid))).toBe('smtp');
    });

    it('allows the log transport outside production, for a developer with no catcher', () => {
      const env = validateEnv({ ...valid, MAIL_TRANSPORT: 'log' });
      expect(env.MAIL_TRANSPORT).toBe('log');
    });

    it('refuses the log transport in production, by name', () => {
      /*
       * The failure this key exists to make impossible: an API that accepts a
       * registration and writes the verification link to stdout. It answers 201, the
       * person waits for mail that never comes, and nothing says so.
       */
      expect(() => validateEnv({ ...valid, NODE_ENV: 'production', MAIL_TRANSPORT: 'log' }))
        .toThrow(/MAIL_TRANSPORT/);
      expect(() => validateEnv({ ...valid, NODE_ENV: 'production', MAIL_TRANSPORT: 'log' }))
        .toThrow(/must be "smtp" in production/);
    });

    it('leaves production alone when the transport is right', () => {
      // P18.4-T2: production also needs its bucket and its key prefix.
      // P18.4-T1: and its TRUST_PROXY, stated.
      const production = {
        ...valid, NODE_ENV: 'production', GCS_BUCKET: 'agencyboost-prod-assets', STORAGE_KEY_PREFIX: 'prod', TRUST_PROXY: '1',
      };
      expect(providerOf(validateEnv(production))).toBe('smtp');
    });
  });

  describe('the mail provider (P18.11-T18, ADR-0182)', () => {
    const preset = (provider: string, extra: Record<string, string> = {}) => {
      const { SMTP_HOST: _none, ...withoutHost } = valid;
      return {
        ...withoutHost, MAIL_PROVIDER: provider, SMTP_USER: provider === 'sendgrid' ? 'apikey' : 'u', SMTP_PASSWORD: 'p', ...extra,
      };
    };

    it.each(['gmail', 'sendgrid', 'mailjet', 'clicksend', 'ses'])('P18.11-T18 boots %s with its credentials and no SMTP_HOST', (provider) => {
      const env = validateEnv(preset(provider));
      expect(env.MAIL_PROVIDER).toBe(provider);
      expect(env.SMTP_HOST).toBeUndefined();
      expect(providerOf(env)).toBe(provider);
    });

    it('P18.11-T18 accepts every provider the module knows, and refuses one it does not, by name', () => {
      expect(MAIL_PROVIDERS).toEqual(['gmail', 'sendgrid', 'mailjet', 'clicksend', 'ses', 'smtp', 'log']);
      expect(() => validateEnv({ ...valid, MAIL_PROVIDER: 'postmark' })).toThrow(/MAIL_PROVIDER/);
      expect(() => validateEnv({ ...valid, MAIL_PROVIDER: 'Gmail' })).toThrow(/MAIL_PROVIDER/);
    });

    it('P18.11-T18 requires SMTP_HOST for a plain relay alone, by name', () => {
      const { SMTP_HOST: _none, ...withoutHost } = valid;
      expect(() => validateEnv(withoutHost)).toThrow(/SMTP_HOST: is required when the mail provider is smtp/);
      expect(() => validateEnv({ ...withoutHost, MAIL_PROVIDER: 'smtp' })).toThrow(/SMTP_HOST/);
      expect(() => validateEnv({ ...withoutHost, MAIL_TRANSPORT: 'smtp', SMTP_HOST: ' ' })).toThrow(/SMTP_HOST/);
    });

    it('P18.11-T18 boots log with no SMTP_HOST at all — the container smoke\'s shape, less its fake host', () => {
      const { SMTP_HOST: _none, ...withoutHost } = valid;
      expect(providerOf(validateEnv({ ...withoutHost, MAIL_PROVIDER: 'log' }))).toBe('log');
      expect(providerOf(validateEnv({ ...withoutHost, MAIL_TRANSPORT: 'log' }))).toBe('log');
    });

    it('P18.11-T18 refuses a preset without its credentials, naming both keys', () => {
      expect(() => validateEnv(preset('gmail', { SMTP_USER: '', SMTP_PASSWORD: '' })))
        .toThrow(/SMTP_USER: is required when MAIL_PROVIDER is gmail[\s\S]*SMTP_PASSWORD: is required when MAIL_PROVIDER is gmail/);
    });

    it('P18.11-T18 refuses SendGrid with any user but the literal apikey', () => {
      expect(() => validateEnv(preset('sendgrid', { SMTP_USER: 'agencyboostid@gmail.com' })))
        .toThrow(/SMTP_USER: must be the literal word apikey when MAIL_PROVIDER is sendgrid/);
    });

    it('P18.11-T18 refuses MAIL_PROVIDER=log in production, by name', () => {
      const production = {
        ...valid, NODE_ENV: 'production', GCS_BUCKET: 'b', STORAGE_KEY_PREFIX: 'prod', TRUST_PROXY: '1', MAIL_PROVIDER: 'log',
      };
      expect(() => validateEnv(production)).toThrow(/MAIL_PROVIDER: may not be "log" in production/);
      // MAIL_PROVIDER decides, so a stale MAIL_TRANSPORT=smtp beside it does not let log through.
      expect(() => validateEnv({ ...production, MAIL_TRANSPORT: 'smtp' })).toThrow(/MAIL_PROVIDER/);
      expect(providerOf(validateEnv({ ...production, MAIL_PROVIDER: 'ses', SMTP_USER: 'u', SMTP_PASSWORD: 'p' }))).toBe('ses');
    });

    it('P18.11-T18 the env file staging ran before the key existed still boots, as the plain relay it named', () => {
      // `api-env-staging` as it stood on 2026-11-01: SES's host, written out, and MAIL_TRANSPORT=smtp.
      const staging = {
        ...valid, NODE_ENV: 'staging', GCS_BUCKET: 'agencyboost-staging-assets', STORAGE_KEY_PREFIX: 'staging', TRUST_PROXY: '1',
        SMTP_HOST: 'email-smtp.ap-southeast-3.amazonaws.com', SMTP_PORT: '587', SMTP_USER: 'AKIA', SMTP_PASSWORD: 'p',
        MAIL_TRANSPORT: 'smtp', APP_BASE_URL: 'https://staging.agencyboost.id',
      };
      const env = validateEnv(staging);
      expect(providerOf(env)).toBe('smtp');
      expect(env).toMatchObject({ SMTP_HOST: 'email-smtp.ap-southeast-3.amazonaws.com', SMTP_PORT: 587 });
      expect(env.MAIL_PROVIDER).toBeUndefined();
    });

    it('P18.11-T18 reads an empty optional mail key as unset, as `.env.example` writes it', () => {
      const env = validateEnv({ ...valid, MAIL_PROVIDER: '', MAIL_TRANSPORT: '', SMTP_PORT: '', MAIL_REPLY_TO: ' ' });
      expect(env).toMatchObject({ MAIL_PROVIDER: undefined, MAIL_TRANSPORT: undefined, SMTP_PORT: undefined, MAIL_REPLY_TO: undefined });
      expect(providerOf(env)).toBe('smtp');
    });

    it('P18.11-T18 keeps MAIL_REPLY_TO, trimmed', () => {
      expect(validateEnv({ ...valid, MAIL_REPLY_TO: ' support@agencyboost.id ' }).MAIL_REPLY_TO).toBe('support@agencyboost.id');
    });
  });

  describe('cross-site cookies (ADR-0041)', () => {
    it('defaults to same-site, the safer of the two', () => {
      expect(validateEnv(valid).COOKIE_CROSS_SITE).toBe(false);
    });

    it('reads "false" as false — the string a reader would expect to disable it', () => {
      // z.coerce.boolean() would make this true, silently turning the control on for
      // whoever wrote the obvious value.
      expect(validateEnv({ ...valid, COOKIE_CROSS_SITE: 'false' }).COOKIE_CROSS_SITE).toBe(false);
    });

    it('enables it over HTTPS, which is the Vercel staging shape', () => {
      const env = validateEnv({
        ...valid,
        COOKIE_CROSS_SITE: 'true',
        APP_ORIGIN: 'https://app.example',
      });
      expect(env.COOKIE_CROSS_SITE).toBe(true);
    });

    it('refuses it over plain http, where a Secure cookie is discarded', () => {
      expect(() =>
        validateEnv({ ...valid, COOKIE_CROSS_SITE: 'true', APP_ORIGIN: 'http://app.example' }),
      ).toThrow(/COOKIE_CROSS_SITE/);
    });

    it('rejects a value that is neither true nor false', () => {
      expect(() => validateEnv({ ...valid, COOKIE_CROSS_SITE: 'yes' })).toThrow(
        /COOKIE_CROSS_SITE/,
      );
    });
  });

  describe('TRUST_PROXY (P18.4-T1, ADR-0152)', () => {
    it('P18.4-T1 may be left unset in development and test, where nothing is in front: no proxy is trusted', () => {
      expect(validateEnv(valid).TRUST_PROXY).toBeUndefined();
      expect(validateEnv({ ...valid, NODE_ENV: 'test' }).TRUST_PROXY).toBeUndefined();
    });

    /*
     * The review's L2: a VM sits behind Caddy, and a key nobody wrote put every client on Caddy's address,
     * one login bucket for the whole office. Saying `false` is a decision; saying nothing is refused.
     */
    describe.each(['staging', 'production'] as const)('in %s', (NODE_ENV) => {
      const deployedEnv = {
        ...valid, NODE_ENV, GCS_BUCKET: 'agencyboost-assets', STORAGE_KEY_PREFIX: NODE_ENV === 'production' ? 'prod' : 'staging',
      };

      it(`P18.4-T1 refuses to boot ${NODE_ENV} with TRUST_PROXY unset, by name`, () => {
        expect(() => validateEnv(deployedEnv)).toThrow(`TRUST_PROXY: must be set when NODE_ENV is ${NODE_ENV}`);
      });

      it.each([['1', 1], ['false', false], ['0', false]])(`P18.4-T1 boots ${NODE_ENV} with TRUST_PROXY written as %j`, (value, parsed) => {
        expect(validateEnv({ ...deployedEnv, TRUST_PROXY: value }).TRUST_PROXY).toBe(parsed);
      });
    });

    it('P18.4-T1 reads "false" as false, not as a truthy string', () => {
      expect(validateEnv({ ...valid, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    });

    it.each([['1', 1], ['2', 2], [' 1 ', 1]])('P18.4-T1 reads the hop count %j as %d', (value, hops) => {
      expect(validateEnv({ ...valid, TRUST_PROXY: value }).TRUST_PROXY).toBe(hops);
    });

    it('P18.4-T1 reads 0 hops as false: no proxy is trusted either way', () => {
      expect(validateEnv({ ...valid, TRUST_PROXY: '0' }).TRUST_PROXY).toBe(false);
    });

    it('P18.4-T1 refuses "true", which would let a client set its own IP with a header', () => {
      expect(() => validateEnv({ ...valid, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
      expect(() => validateEnv({ ...valid, TRUST_PROXY: 'true' })).toThrow(/"true" is refused/);
    });

    it.each(['-1', '1.5', 'loopback', '10.0.0.0/8', 'yes', ''])('P18.4-T1 refuses %j', (value) => {
      expect(() => validateEnv({ ...valid, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
    });
  });

  it('P18.4-T1 the commands default to the database the API defaults to', () => {
    // The migrations, the seed and create-super-admin read MONGODB_DB_NAME without this schema.
    expect(valid).not.toHaveProperty('MONGODB_DB_NAME');
    expect(validateEnv(valid).MONGODB_DB_NAME).toBe(MONGODB_DB_NAME_DEFAULT);
  });

  it('accepts a complete configuration and applies defaults', () => {
    const env = validateEnv(valid);
    expect(env.PORT).toBe(3001);
    expect(env.NODE_ENV).toBe('development');
    expect(env.DEFAULT_TENANT_TIMEZONE).toBe('Asia/Jakarta');
    expect(env.STORAGE_KEY_PREFIX).toBe('dev');
    expect(env.GCS_BUCKET).toBeUndefined();
  });

  it('fails loudly on a missing required key, naming it', () => {
    const { MONGODB_URI: _omitted, ...incomplete } = valid;
    expect(() => validateEnv(incomplete)).toThrow(/MONGODB_URI/);
  });

  it('rejects a weak signing secret rather than starting with one', () => {
    expect(() => validateEnv({ ...valid, JWT_ACCESS_SECRET: 'short' })).toThrow(
      /at least 32 characters/,
    );
  });

  describe('storage (P18.4-T2, ADR-0153, D12)', () => {
    const deployed = (NODE_ENV: 'staging' | 'production', extra: Record<string, string> = {}) => ({
      // TRUST_PROXY is stated, as a VM's env file states it (P18.4-T1): these are storage's assertions.
      ...valid, NODE_ENV, STORAGE_KEY_PREFIX: NODE_ENV === 'production' ? 'prod' : 'staging', TRUST_PROXY: '1', ...extra,
    });

    it.each(['development', 'test'])('P18.4-T2 boots %s with no bucket at all — storage then refuses, nothing else does', (NODE_ENV) => {
      const env = validateEnv({ ...valid, NODE_ENV });
      expect(env.GCS_BUCKET).toBeUndefined();
      expect(env.GCS_PROJECT_ID).toBeUndefined();
    });

    it('P18.4-T2 reads an empty or blank bucket as unset, as `.env.example` writes it', () => {
      expect(validateEnv({ ...valid, GCS_BUCKET: '', GCS_PROJECT_ID: '  ' })).toMatchObject({ GCS_BUCKET: undefined, GCS_PROJECT_ID: undefined });
      expect(validateEnv({ ...valid, GCS_BUCKET: ' agencyboost-dev-assets ' }).GCS_BUCKET).toBe('agencyboost-dev-assets');
    });

    it.each(['staging', 'production'] as const)('P18.4-T2 refuses %s without a bucket, by name', (NODE_ENV) => {
      expect(() => validateEnv(deployed(NODE_ENV))).toThrow(/GCS_BUCKET: is required when NODE_ENV is/);
      expect(() => validateEnv(deployed(NODE_ENV, { GCS_BUCKET: ' ' }))).toThrow(/GCS_BUCKET/);
    });

    it.each(['staging', 'production'] as const)('P18.4-T2 boots %s with its bucket and its prefix', (NODE_ENV) => {
      const env = validateEnv(deployed(NODE_ENV, { GCS_BUCKET: `agencyboost-${NODE_ENV}-assets`, GCS_PROJECT_ID: 'agencyboost-x' }));
      expect(env).toMatchObject({ GCS_BUCKET: `agencyboost-${NODE_ENV}-assets`, GCS_PROJECT_ID: 'agencyboost-x' });
    });

    it.each(['dev', 'staging'])('P18.4-T2 refuses production writing keys prefixed %s', (prefix) => {
      expect(() => validateEnv(deployed('production', { GCS_BUCKET: 'b', STORAGE_KEY_PREFIX: prefix })))
        .toThrow(/STORAGE_KEY_PREFIX: must be "prod" in production/);
      // Left at its default, too: production names its prefix.
      const { STORAGE_KEY_PREFIX: _default, ...unnamed } = deployed('production', { GCS_BUCKET: 'b' });
      expect(() => validateEnv(unnamed)).toThrow(/STORAGE_KEY_PREFIX/);
    });

    it.each(['development', 'test', 'staging'])('P18.4-T2 refuses the prod prefix in %s', (NODE_ENV) => {
      expect(() => validateEnv({ ...valid, NODE_ENV, GCS_BUCKET: 'b', STORAGE_KEY_PREFIX: 'prod' }))
        .toThrow(/STORAGE_KEY_PREFIX: may be "prod" only in production/);
    });

    it('P18.4-T2 rejects a prefix outside the known environments', () => {
      expect(() => validateEnv({ ...valid, STORAGE_KEY_PREFIX: 'production' })).toThrow(/STORAGE_KEY_PREFIX/);
    });
  });

  it('coerces numeric strings from the environment', () => {
    expect(validateEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects a malformed APP_BASE_URL when one is written', () => {
    expect(() => validateEnv({ ...valid, APP_BASE_URL: 'not-a-url' })).toThrow(/APP_BASE_URL/);
  });

  it('P18.11-T18 boots without APP_BASE_URL, which nothing reads: links are built from APP_ORIGIN', () => {
    const { APP_BASE_URL: _unused, ...withoutBase } = valid;
    expect(validateEnv(withoutBase).APP_BASE_URL).toBeUndefined();
    expect(validateEnv({ ...valid, APP_BASE_URL: '' }).APP_BASE_URL).toBeUndefined();
  });
});
