import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

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
    SwaggerModule.setup(
      'api/docs',
      app,
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle('AgencyBoost API')
          .setDescription('Multi-tenant SaaS for insurance agency offices (KPM)')
          .setVersion('1.0')
          .addBearerAuth()
          .build(),
      ),
    );
  }

  const port = config.get<number>('PORT', 3001);
  await app.listen(port);
  logger.log(`AgencyBoost API listening on :${port}`);
}

void bootstrap();
