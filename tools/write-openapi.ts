import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
// Above AppModule: its import validates the configuration (openapi-env.ts says why).
import './openapi-env';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/openapi';

/**
 * Writes `openapi.json` from the application's own metadata.
 *
 * **Preview mode is what makes this cheap.** `NestFactory.create(..., { preview: true })`
 * builds the module graph without instantiating providers, so `MongooseModule` never
 * opens a connection. The document comes from decorators, not from traffic, so nothing
 * is lost by never resolving a provider — the output is byte-identical to the version
 * that booted a real database, and it takes about two seconds instead of tens.
 *
 * That matters beyond convenience. The first version of this script started a
 * `MongoMemoryServer`, which meant regenerating the document needed a downloaded mongod
 * binary; a CI step would have had to carry the same `actions/cache` block the
 * integration jobs use. Without a database it is `pnpm openapi` and nothing else, which
 * is what lets the freshness check be a two-line step.
 *
 * The same global prefix and URI versioning `main.ts` applies are applied here, so the
 * paths in the file are the paths a client calls.
 *
 * The environment is stubbed rather than read (`openapi-env.ts`): `validateEnv` still runs over
 * the config, and in preview mode nothing ever dials the URI. Generating the contract must not
 * depend on having credentials for anything.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false, preview: true });
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  const target = join(__dirname, '..', 'openapi.json');
  writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`);

  await app.close();
  process.stdout.write(`wrote ${target}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
