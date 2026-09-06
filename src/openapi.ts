import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * The API description, built once and used twice.
 *
 * `docs-and-tests-required.md` has always said an endpoint change updates "the OpenAPI
 * document", and until 2026-09-06 there was no document — only a Swagger UI served at
 * `/api/docs` in non-production, which exists while a process is running and cannot be
 * read in a diff. `pnpm openapi` writes `openapi.json` from this same builder, so the
 * file a reviewer reads is the surface the server serves.
 *
 * It lives here rather than in `main.ts` because `main.ts` calls `bootstrap()` at module
 * scope: importing it to reach the builder starts a real server on the real port.
 */
export function buildOpenApiDocument(app: INestApplication) {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('AgencyBoost API')
      .setDescription('Multi-tenant SaaS for insurance agency offices (KPM)')
      .setVersion('1.0')
      .addBearerAuth()
      .build(),
  );
}
