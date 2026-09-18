/**
 * Mail defaults to the log transport for the whole suite.
 *
 * A suite that boots the real AppModule imports it at module scope, and that evaluates
 * `ConfigModule.forRoot()` — freezing the validated configuration before any `beforeAll`
 * can touch `process.env`. So a spec cannot turn this off from inside itself; setting it
 * there looks like it works and does nothing.
 *
 * It matters because those suites point `SMTP_HOST` at a fake host while the schema's
 * default transport is `smtp`, so `SmtpChannelAdapter.onModuleInit` dials it for real and
 * `app.init()` becomes a DNS timeout. That made the boot suites pass or fail on the
 * developer's own `.env` and resolver rather than on the code.
 *
 * `setupFilesAfterEnv` runs before the test module is loaded, which is what makes this the
 * only place it can go. A spec that genuinely exercises SMTP builds its own ConfigService
 * stub (see smtp.int.spec.ts) and is unaffected; an explicit value still wins.
 */
process.env.MAIL_TRANSPORT = process.env.MAIL_TRANSPORT ?? 'log';

// Fail a test that leaves a floating promise or an unhandled rejection, rather than
// letting it surface as a confusing failure in an unrelated test.
process.on('unhandledRejection', (reason) => {
  throw reason;
});

jest.setTimeout(30_000);
