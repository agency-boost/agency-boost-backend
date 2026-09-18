import { ConfigService } from '@nestjs/config';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';

import { buildOpenApiDocument } from './openapi';

/**
 * Everything the API is, apart from how it starts listening.
 *
 * Two entrypoints call this: `main.ts`, which listens on a port (local development and
 * the VM that will host production), and `serverless.ts`, which hands an initialised
 * Express instance to a Vercel function for staging (ADR-0041).
 *
 * It is one function rather than two copies deliberately. A global pipe or a prefix that
 * is set on one path and not the other produces exactly the defect
 * `.claude/rules/backend-then-frontend.md` describes — two halves implementing a contract
 * the other does not — and it would show up only in the environment nobody was testing.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);

  // The request id is generated and echoed by the pino http logger (LoggingModule),
  // which also puts it on every log line. The error filter reads the same value.
  app.use(cookieParser());

  // The prefix carries no version. Versioning is per-controller, so v1 and v2 can be
  // served side by side from the same process — which docs/02-specs/api/conventions.md
  // already promises ("a breaking change means v2 alongside v1"). Baking the version
  // into a global prefix would make every route move at once.
  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1', // A controller declares @Version('2') when its contract breaks.
  });

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
}
