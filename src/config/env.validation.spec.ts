import { validateEnv } from './env.validation';
import { MONGODB_DB_NAME_DEFAULT } from './mongo-target';

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
      expect(validateEnv(valid).MAIL_TRANSPORT).toBe('smtp');
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
      // P18.7-T2: production also needs its bucket and its key prefix.
      // P18.7-T1: and its TRUST_PROXY, stated.
      const production = {
        ...valid, NODE_ENV: 'production', GCS_BUCKET: 'agencyboost-prod-assets', STORAGE_KEY_PREFIX: 'prod', TRUST_PROXY: '1',
      };
      expect(validateEnv(production).MAIL_TRANSPORT).toBe('smtp');
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

  describe('TRUST_PROXY (P18.7-T1, ADR-0152)', () => {
    it('P18.7-T1 may be left unset in development and test, where nothing is in front: no proxy is trusted', () => {
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

      it(`P18.7-T1 refuses to boot ${NODE_ENV} with TRUST_PROXY unset, by name`, () => {
        expect(() => validateEnv(deployedEnv)).toThrow(`TRUST_PROXY: must be set when NODE_ENV is ${NODE_ENV}`);
      });

      it.each([['1', 1], ['false', false], ['0', false]])(`P18.7-T1 boots ${NODE_ENV} with TRUST_PROXY written as %j`, (value, parsed) => {
        expect(validateEnv({ ...deployedEnv, TRUST_PROXY: value }).TRUST_PROXY).toBe(parsed);
      });
    });

    it('P18.7-T1 reads "false" as false, not as a truthy string', () => {
      expect(validateEnv({ ...valid, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    });

    it.each([['1', 1], ['2', 2], [' 1 ', 1]])('P18.7-T1 reads the hop count %j as %d', (value, hops) => {
      expect(validateEnv({ ...valid, TRUST_PROXY: value }).TRUST_PROXY).toBe(hops);
    });

    it('P18.7-T1 reads 0 hops as false: no proxy is trusted either way', () => {
      expect(validateEnv({ ...valid, TRUST_PROXY: '0' }).TRUST_PROXY).toBe(false);
    });

    it('P18.7-T1 refuses "true", which would let a client set its own IP with a header', () => {
      expect(() => validateEnv({ ...valid, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
      expect(() => validateEnv({ ...valid, TRUST_PROXY: 'true' })).toThrow(/"true" is refused/);
    });

    it.each(['-1', '1.5', 'loopback', '10.0.0.0/8', 'yes', ''])('P18.7-T1 refuses %j', (value) => {
      expect(() => validateEnv({ ...valid, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
    });
  });

  it('P18.7-T1 the commands default to the database the API defaults to', () => {
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

  describe('storage (P18.7-T2, ADR-0153, D12)', () => {
    const deployed = (NODE_ENV: 'staging' | 'production', extra: Record<string, string> = {}) => ({
      // TRUST_PROXY is stated, as a VM's env file states it (P18.7-T1): these are storage's assertions.
      ...valid, NODE_ENV, STORAGE_KEY_PREFIX: NODE_ENV === 'production' ? 'prod' : 'staging', TRUST_PROXY: '1', ...extra,
    });

    it.each(['development', 'test'])('P18.7-T2 boots %s with no bucket at all — storage then refuses, nothing else does', (NODE_ENV) => {
      const env = validateEnv({ ...valid, NODE_ENV });
      expect(env.GCS_BUCKET).toBeUndefined();
      expect(env.GCS_PROJECT_ID).toBeUndefined();
    });

    it('P18.7-T2 reads an empty or blank bucket as unset, as `.env.example` writes it', () => {
      expect(validateEnv({ ...valid, GCS_BUCKET: '', GCS_PROJECT_ID: '  ' })).toMatchObject({ GCS_BUCKET: undefined, GCS_PROJECT_ID: undefined });
      expect(validateEnv({ ...valid, GCS_BUCKET: ' agencyboost-dev-assets ' }).GCS_BUCKET).toBe('agencyboost-dev-assets');
    });

    it.each(['staging', 'production'] as const)('P18.7-T2 refuses %s without a bucket, by name', (NODE_ENV) => {
      expect(() => validateEnv(deployed(NODE_ENV))).toThrow(/GCS_BUCKET: is required when NODE_ENV is/);
      expect(() => validateEnv(deployed(NODE_ENV, { GCS_BUCKET: ' ' }))).toThrow(/GCS_BUCKET/);
    });

    it.each(['staging', 'production'] as const)('P18.7-T2 boots %s with its bucket and its prefix', (NODE_ENV) => {
      const env = validateEnv(deployed(NODE_ENV, { GCS_BUCKET: `agencyboost-${NODE_ENV}-assets`, GCS_PROJECT_ID: 'agencyboost-x' }));
      expect(env).toMatchObject({ GCS_BUCKET: `agencyboost-${NODE_ENV}-assets`, GCS_PROJECT_ID: 'agencyboost-x' });
    });

    it.each(['dev', 'staging'])('P18.7-T2 refuses production writing keys prefixed %s', (prefix) => {
      expect(() => validateEnv(deployed('production', { GCS_BUCKET: 'b', STORAGE_KEY_PREFIX: prefix })))
        .toThrow(/STORAGE_KEY_PREFIX: must be "prod" in production/);
      // Left at its default, too: production names its prefix.
      const { STORAGE_KEY_PREFIX: _default, ...unnamed } = deployed('production', { GCS_BUCKET: 'b' });
      expect(() => validateEnv(unnamed)).toThrow(/STORAGE_KEY_PREFIX/);
    });

    it.each(['development', 'test', 'staging'])('P18.7-T2 refuses the prod prefix in %s', (NODE_ENV) => {
      expect(() => validateEnv({ ...valid, NODE_ENV, GCS_BUCKET: 'b', STORAGE_KEY_PREFIX: 'prod' }))
        .toThrow(/STORAGE_KEY_PREFIX: may be "prod" only in production/);
    });

    it('P18.7-T2 rejects a prefix outside the known environments', () => {
      expect(() => validateEnv({ ...valid, STORAGE_KEY_PREFIX: 'production' })).toThrow(/STORAGE_KEY_PREFIX/);
    });
  });

  it('coerces numeric strings from the environment', () => {
    expect(validateEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects a malformed base URL, which would break verification links', () => {
    expect(() => validateEnv({ ...valid, APP_BASE_URL: 'not-a-url' })).toThrow();
  });
});
