import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

/**
 * The listening entrypoint: local development, and the VM that will host production.
 *
 * Vercel staging does not come through here — it has no port to listen on. It uses
 * `serverless.ts`, and both share `configureApp` so the two cannot drift (ADR-0041).
 */
async function bootstrap(): Promise<void> {
  // abortOnError: false for the same reason as serverless.ts — Nest would otherwise
  // process.exit(1) inside NestFactory.create, before the handler below could turn a
  // configuration failure into the message it exists to print.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, abortOnError: false });
  // Route Nest's own logs through pino so every line is structured and carries the
  // request id.
  app.useLogger(app.get(PinoLogger));
  const config = app.get(ConfigService);
  const logger = new Logger('bootstrap');

  configureApp(app);

  const port = config.get<number>('PORT', 3001);
  await app.listen(port);
  logger.log(`AgencyBoost API listening on :${port}`);
}

/**
 * A failure to start is a message, not a stack trace.
 *
 * `void bootstrap()` left an unhandled rejection to print Node's raw dump — forty lines
 * of `@nestjs/platform-express` internals for the commonest development mistake there is,
 * a server already running. The port and the way out are the only two facts that matter,
 * and neither was in the first screenful.
 */
bootstrap().catch((err: NodeJS.ErrnoException) => {
  /*
   * **Written straight to stderr, not through the logger.**
   *
   * By the time this runs, `app.useLogger(pino)` has already redirected Nest's logger to
   * a transport that writes asynchronously — and `process.exit` does not wait for it. The
   * first version of this handler used `Logger.error` and printed nothing at all: the
   * stack trace was gone and nothing replaced it, which is worse than the stack trace.
   * A failure to start cannot depend on the logging stack still being alive.
   */
  const say = (line: string) => process.stderr.write(`${line}\n`);

  if (err?.code === 'EADDRINUSE') {
    const port = process.env.PORT ?? '3001';
    say(`Port ${port} is already in use.`);
    say('');
    say('Most likely an API you started earlier and left running. Either:');
    say(`  lsof -nP -iTCP:${port} -sTCP:LISTEN`.padEnd(42) + '# find it');
    say('  kill <pid>'.padEnd(42) + '# stop it');
    say('  PORT=<other> pnpm dev'.padEnd(42) + '# or start this one elsewhere');
    process.exit(1);
  }

  say(`AgencyBoost API failed to start: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) say(err.stack);
  process.exit(1);
});
