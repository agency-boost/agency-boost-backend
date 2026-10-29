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

/**
 * **Every integration suite reads the API in English unless a test asks for Indonesian** (ADR-0179 §9; P18.98-T5
 * AC-7). The app sends `Accept-Language` on every request (P18.98-T2 AC-6), so a suite sends the one an English screen
 * sends: `en`. Every assertion written before the phase stands — English words, and the figures in them as the API
 * wrote them for a reader who has chosen nothing — and keeps standing when `LANGUAGE_LIVE` turns a request with no
 * header Indonesian. A test that sets the header itself is left alone: `.set('Accept-Language', 'id')` for Indonesian,
 * or `''` for none at all (`common/i18n/reader.ts` reads an empty header as none).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the class supertest builds every request from
const SupertestTest = require('supertest/lib/test') as {
  prototype: { end(this: SupertestRequest, fn?: unknown): unknown };
};
interface SupertestRequest {
  get(field: string): string | undefined;
  set(field: string, value: string): unknown;
}
const sendRequest = SupertestTest.prototype.end;
SupertestTest.prototype.end = function end(this: SupertestRequest, fn?: unknown) {
  if (this.get('Accept-Language') === undefined) this.set('Accept-Language', 'en');
  return sendRequest.call(this, fn);
};
