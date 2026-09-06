import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/openapi';

/**
 * Writes `openapi.json` from the application's own metadata.
 *
 * The app is created but never listens — the document comes from decorators, not from
 * traffic — and the same URI versioning `main.ts` applies is applied here, so the paths
 * in the file are the paths a client calls.
 *
 * It brings its own database. `AppModule` connects on creation, and pointing it at a
 * `mongodb://localhost` that is not there does not fail: Mongoose retries, so the script
 * hangs rather than erroring. An in-memory server makes generating the document
 * something anybody can do from a clean checkout.
 */
async function main(): Promise<void> {
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.JWT_SECRET ??= 'openapi-generation-only';
  process.env.NODE_ENV ??= 'test';

  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  const target = join(__dirname, '..', 'openapi.json');
  writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`);

  await app.close();
  await mongo.stop();
  process.stdout.write(`wrote ${target}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
