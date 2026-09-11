import { validateEnv } from './env.validation';

const valid = {
  MONGODB_URI: 'mongodb://localhost:27017',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  CLOUDINARY_CLOUD_NAME: 'demo',
  CLOUDINARY_API_KEY: 'key',
  CLOUDINARY_API_SECRET: 'secret',
  SMTP_HOST: 'smtp.example.test',
  MAIL_FROM: 'AgencyBoost <no-reply@example.test>',
  APP_BASE_URL: 'http://localhost:3000',
};

describe('environment validation', () => {
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
      expect(validateEnv({ ...valid, NODE_ENV: 'production' }).MAIL_TRANSPORT).toBe('smtp');
    });
  });

  it('accepts a complete configuration and applies defaults', () => {
    const env = validateEnv(valid);
    expect(env.PORT).toBe(3001);
    expect(env.NODE_ENV).toBe('development');
    expect(env.DEFAULT_TENANT_TIMEZONE).toBe('Asia/Jakarta');
    expect(env.CLOUDINARY_FOLDER_PREFIX).toBe('dev');
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

  it('rejects a Cloudinary folder prefix outside the known environments', () => {
    expect(() => validateEnv({ ...valid, CLOUDINARY_FOLDER_PREFIX: 'production' })).toThrow();
  });

  it('coerces numeric strings from the environment', () => {
    expect(validateEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects a malformed base URL, which would break verification links', () => {
    expect(() => validateEnv({ ...valid, APP_BASE_URL: 'not-a-url' })).toThrow();
  });
});
