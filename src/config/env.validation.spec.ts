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
