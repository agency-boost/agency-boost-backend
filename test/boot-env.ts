/**
 * **The configuration a suite that imports the real AppModule boots with.** Import it above `AppModule`.
 *
 * `ConfigModule.forRoot()` runs when `app.module.ts` is first imported: it validates `process.env` there
 * and then, and keeps what it read (`test/setup.ts`). Values a suite assigns in `beforeAll` arrive after
 * that, so they were never the ones it ran with. On a laptop the developer's `.env` answered instead, its
 * database included; on CI, which has no `.env`, the import threw *"Invalid configuration"* — the
 * backend's first run on GitHub, 2026-10-23. Imports are evaluated in order, so this file, imported
 * first, is in time.
 *
 * The database is the run's one in-memory server (`test/global-setup.ts`); the secrets are filler. Under
 * Jest, `app.module.ts` reads no `.env` at all, so these keys and the schema's defaults are everything a
 * boot suite is configured by.
 */
const uri = process.env.MONGO_TEST_URI;
if (!uri) {
  throw new Error('MONGO_TEST_URI is unset — test/global-setup.ts did not run.');
}

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  MONGODB_URI: uri,
  MONGODB_DB_NAME: 'agencyboost_boot',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  // P18.7-T2: no storage key at all — a test boots without a bucket (D12).
  SMTP_HOST: 'smtp.test',
  MAIL_FROM: 'AgencyBoost <no-reply@test>',
  APP_BASE_URL: 'http://localhost:3000',
});

export {};
