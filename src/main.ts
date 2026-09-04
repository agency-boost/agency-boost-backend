import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const logger = new Logger('bootstrap');

  // The prefix carries no version. Versioning is per-controller, so v1 and v2 can be
  // served side by side from the same process — which docs/02-specs/api/conventions.md
  // already promises ("a breaking change means v2 alongside v1"). Baking the version
  // into a global prefix would make every route move at once.
  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1', // A controller declares @Version('2') when its contract breaks.
  });

  // Every response carries a request id, echoed into logs and into the error envelope,
  // so a user-reported failure is traceable without guessing.
  app.use((req: Request & { id?: string }, res: Response, next: NextFunction) => {
    req.id = String(req.headers['x-request-id'] ?? randomUUID());
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // An unknown field is a 400, never a silent drop — a typo'd field name that is
      // quietly ignored is the hardest kind of bug to find.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
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
