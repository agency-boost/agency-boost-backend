/**
 * **The configuration the OpenAPI document is generated under.** `write-openapi.ts` imports it above
 * `AppModule`, because that import is where `ConfigModule.forRoot()` validates and keeps the configuration
 * (`test/boot-env.ts` has the history): stubs assigned inside `main()` came too late, so generating the
 * document read the developer's `.env` and, on CI, which has none, failed. Assigned outright rather than
 * `??=`, so a shell's own `NODE_ENV` cannot bring the `.env` back.
 *
 * `NODE_ENV=test` also stops `app.module.ts` reading a `.env`, so nothing a laptop holds reaches the
 * document. Preview mode instantiates nothing, so nothing dials the URI or the mail host: generating the
 * contract needs no credentials for anything.
 */
Object.assign(process.env, {
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/openapi-generation-only',
  MONGODB_DB_NAME: 'openapi-generation-only',
  JWT_ACCESS_SECRET: 'openapi-generation-only-'.padEnd(40, 'a'),
  JWT_REFRESH_SECRET: 'openapi-generation-only-'.padEnd(40, 'b'),
  SMTP_HOST: 'smtp.openapi-generation-only',
  MAIL_FROM: 'AgencyBoost <no-reply@openapi-generation-only>',
  APP_BASE_URL: 'http://localhost:3000',
});

export {};
