import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './openapi';


async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // Route Nest's own logs through pino so every line is structured and carries the
  // request id.
  app.useLogger(app.get(PinoLogger));
  const config = app.get(ConfigService);
  const logger = new Logger('bootstrap');

  // The prefix carries no version. Versioning is per-controller, so v1 and v2 can be
  // served side by side from the same process — which docs/02-specs/api/conventions.md
  // already promises ("a breaking change means v2 alongside v1"). Baking the version
  // into a global prefix would make every route move at once.
  app.use(cookieParser());

  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1', // A controller declares @Version('2') when its contract breaks.
  });

  // The request id is generated and echoed by the pino http logger (LoggingModule),
  // which also puts it on every log line. The error filter reads the same value.

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // An unknown field is a 400, never a silent drop — a typo'd field name that is
      // quietly ignored is the hardest kind of bug to find.
      forbidNonWhitelisted: true,
      transform: true,
      // Implicit conversion is OFF. With it on, class-transformer coerces 42 to "42"
      // before validation runs, so @IsString() passes for a number and @IsInt() passes
      // for a numeric string — body type validation becomes decorative.
      //
      // Query and param DTOs, which genuinely arrive as strings, opt in per field with
      // @Type(() => Number). That is more typing and it is the right trade: this
      // product's premise is that a silently wrong number is worse than a crash.
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const origins = config.get<string>('CORS_ORIGINS', '');
  app.enableCors({
    origin: origins ? origins.split(',').map((o) => o.trim()) : false,
    credentials: true,
  });

  if (config.get('NODE_ENV') !== 'production') {
    SwaggerModule.setup('api/docs', app, buildOpenApiDocument(app));
  }

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
