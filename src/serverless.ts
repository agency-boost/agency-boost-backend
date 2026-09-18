import type { IncomingMessage, ServerResponse } from 'node:http';

import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

/**
 * The serverless entrypoint: Vercel staging (ADR-0041).
 *
 * The difference from `main.ts` is one line — `app.init()` instead of `app.listen()`.
 * Everything a request sees is `configureApp`, shared with the listening path.
 */

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Held across invocations on purpose.
 *
 * A warm Vercel container reuses this module, so the Nest graph — and with it the
 * Mongoose connection pool — is built once per container rather than once per request.
 * Rebuilding it per request would open a new Atlas connection every time and exhaust the
 * cluster's connection limit under any real traffic.
 */
let serverPromise: Promise<RequestListener> | undefined;

async function createServer(): Promise<RequestListener> {
  /*
   * `abortOnError: false` is load-bearing here, not a preference.
   *
   * By default Nest wraps initialisation in an exceptions zone that calls
   * `process.exit(1)` when a provider fails to construct — an unreachable database on a
   * cold start, say. In a function that kills the whole container: the platform reports
   * an opaque crash rather than an error, and the `catch` below never runs because
   * nothing is left to run it.
   *
   * With it off the failure is an ordinary rejection, which becomes a 500 that says what
   * went wrong and leaves the container able to try again.
   */
  const app = await NestFactory.create(AppModule, { bufferLogs: true, abortOnError: false });
  app.useLogger(app.get(PinoLogger));

  configureApp(app);

  // init(), never listen(): the platform owns the socket. listen() here would bind a
  // port nothing routes to and hold the invocation open until it timed out.
  await app.init();

  // The adapter's own `getInstance()` is typed by the adapter's generic, which this
  // call site does not carry; the instance is the Express app Nest built.
  return app.getHttpAdapter().getInstance() as RequestListener;
}

export const handler = async (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  if (!serverPromise) {
    /*
     * A rejected promise must not be cached.
     *
     * Leaving a rejection in `serverPromise` would make every later invocation on this
     * container replay the same stale error long after the cause had cleared — a brief
     * Atlas outage during a cold start would take the container out for its whole life
     * rather than for one request.
     *
     * Note what this does *not* cover: `validateEnv` runs inside `ConfigModule.forRoot()`,
     * which is evaluated when `app.module.ts` is imported at the top of this file. A
     * misconfigured deployment therefore fails while the module is loading, before any of
     * this runs, and Vercel reports it as a function that could not start — with the name
     * of the offending variable in the log.
     */
    serverPromise = createServer().catch((err: unknown) => {
      serverPromise = undefined;
      throw err;
    });
  }

  const server = await serverPromise;
  server(req, res);
};

export default handler;
