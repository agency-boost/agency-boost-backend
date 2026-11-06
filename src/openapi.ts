import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, getSchemaPath } from '@nestjs/swagger';
import type { OpenAPIObject, OperationObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { IS_PUBLIC, REQUIRED_PERMISSION } from './common/auth/auth.decorators';
import { ApiErrorBody, ApiErrorEnvelope } from './common/errors/error-envelope.dto';
import { RESPONSE_MODELS, RESPONSE_SHAPES } from './common/api/response-map';

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
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('AgencyBoost API')
      .setDescription(
        'Multi-tenant SaaS for insurance agency offices (KPM).\n\n' +
          'Every failure uses one envelope — `{ error: { code, message, details?, requestId } }` ' +
          '— and every `code` has a row in `docs/02-specs/api/error-catalog.md`. **Branch on the ' +
          'code, never on the message.**\n\n' +
          'A resource in another tenant answers `404`, not `403`: a `403` would confirm the id ' +
          'exists.\n\n' +
          '**Every sentence is in the request\'s language** — a refusal\'s `message`, its `details.violations`, a ' +
          'notice: `Accept-Language` (`id` or `en`, exactly), else the signed-in person\'s saved language, else ' +
          'Bahasa Indonesia, the default since 2026-10-29 (`docs/02-specs/api/conventions.md`). `code` and every other ' +
          'detail are the same in both.',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .build(),
    { extraModels: [ApiErrorEnvelope, ApiErrorBody, ...RESPONSE_MODELS] },
  );

  return describeFailuresAndPermissions(app, document);
}

/**
 * Adds, to **every** operation, the failures it can produce and the permission it needs.
 *
 * Done here rather than by decorating 69 handlers, and that is not laziness. These facts
 * are already declared — `@RequirePermission` sets metadata the guard reads, `@Public`
 * marks what needs no token, a `requestBody` means the `ValidationPipe` can refuse it —
 * so restating them in a second decorator would create two sources that can disagree. A
 * new route gets its failures documented by existing, not by somebody remembering.
 *
 * Endpoint-specific codes — `TENANT_CODE_TAKEN`, `COMPANY_SLUG_TAKEN` and their kin —
 * are not derivable, so they stay on the handler as `@ApiConflictResponse`. What is
 * derivable is derived; what is not is written down once.
 */
function describeFailuresAndPermissions(
  app: INestApplication,
  document: OpenAPIObject,
): OpenAPIObject {
  const meta = handlerMetadata(app);
  const envelope = { $ref: getSchemaPath(ApiErrorEnvelope) };

  const failure = (description: string) => ({
    description,
    content: { 'application/json': { schema: envelope } },
  });

  for (const [path, item] of Object.entries(document.paths)) {
    for (const operation of Object.values(item)) {
      if (typeof operation !== 'object' || operation === null) continue;
      const op = operation as OperationObject & { 'x-required-permission'?: string };
      // `Controller_method_v1` for a versioned route and `Controller_method` for a
      // version-neutral one, so the suffix is stripped rather than assumed. Assuming it
      // matched nothing on `/api/health`, which is `VERSION_NEUTRAL` — and a lookup that
      // silently misses reads as "no permission, needs a token", which is the opposite of
      // what that route is.
      const key = op.operationId?.replace(/_v\d+$/, '');
      const found = key ? meta.get(key) : undefined;
      const responses = (op.responses ??= {});

      // The success body. `2xx` already exists with a description and no content —
      // Swagger writes one per handler — so this fills the content in rather than
      // replacing the entry, keeping whatever status the handler actually answers with.
      const shape = key ? RESPONSE_SHAPES[key] : undefined;
      const success = Object.keys(responses).find((c) => c.startsWith('2') && c !== '204');
      if (shape && success) {
        const ref = shape.type ? { $ref: getSchemaPath(shape.type) } : null;
        const existing = responses[success] as { description?: string } | undefined;
        responses[success] = {
          description: existing?.description ?? '',
          content: {
            // A shape with no class answers only as a file (P19.7-T3: the proposal's PDF).
            ...(ref ? { 'application/json': { schema: shape.isArray ? { type: 'array', items: ref } : ref } } : {}),
            // A template asked for as a file is answered as that file (ADR-0184).
            ...Object.fromEntries((shape.files ?? []).map((type) => [type, { schema: { type: 'string', format: 'binary' } }])),
          },
        };
      }

      // A body or a query object means the ValidationPipe stands in front of it, and it
      // refuses with the same envelope as everything else.
      if (op.requestBody || (op.parameters ?? []).some((p) => 'in' in p && p.in === 'query')) {
        responses['400'] ??= failure('`VALIDATION_FAILED` — a field is missing, malformed, or not on the DTO.');
      }

      if (!found?.isPublic) {
        responses['401'] ??= failure(
          '`AUTH_TOKEN_EXPIRED` or `AUTH_TOKEN_INVALID` — no bearer token, or one that is spent.',
        );
      }

      if (!found?.permission && !found?.isPublic) {
        // Authenticated, and that is the whole gate: `/auth/me`, changing your own
        // password, reading your own join state. Saying so beats saying nothing, which
        // reads as an oversight.
        op.description = [op.description, '**Any signed-in user.** No further permission.']
          .filter(Boolean)
          .join('\n\n');
      }

      if (found?.permission) {
        op['x-required-permission'] = found.permission;
        op.description = [
          op.description,
          `**Requires \`${found.permission}\`.** See \`docs/00-product/roles-and-permissions.md\`.`,
        ]
          .filter(Boolean)
          .join('\n\n');
        responses['403'] ??= failure(
          `\`PERM_DENIED\` — the caller does not hold \`${found.permission}\`. ` +
            '`details.permission` names it.',
        );
      }

      // A path parameter is something that can fail to resolve — and, for anything
      // tenant-scoped, something in another office answers the same way.
      if (path.includes('{')) {
        responses['404'] ??= failure(
          '`NOT_FOUND` — no such resource, **or** it belongs to another office. The two are ' +
            'deliberately indistinguishable: a `403` here would confirm the id exists.',
        );
      }

      responses['500'] ??= failure('`INTERNAL_ERROR` — quote `requestId`; the detail is in the log.');
    }
  }

  return document;
}

/**
 * `operationId` → what the decorators on that handler already say.
 *
 * Swagger names an operation `Controller_method_v1`, which is what lets a document walk
 * meet the metadata again. The controllers come from the application's own container, so
 * this stays true as routes are added — and it works under `preview: true`, which is how
 * `pnpm openapi` runs without a database.
 */
function handlerMetadata(
  app: INestApplication,
): Map<string, { permission?: string; isPublic: boolean }> {
  const container = (
    app as unknown as {
      container: {
        getModules(): Map<string, { controllers: Map<unknown, { metatype?: new (...a: never[]) => object }> }>;
      };
    }
  ).container;

  const found = new Map<string, { permission?: string; isPublic: boolean }>();
  for (const [, module] of container.getModules()) {
    for (const [, wrapper] of module.controllers) {
      const controller = wrapper.metatype;
      if (!controller) continue;
      const proto = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        // The **descriptor**, never `proto[name]`: a controller may define a getter, and
        // reading it here would invoke it against a prototype with no injected
        // dependencies. `OnboardingController.appOrigin` does exactly that.
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (typeof descriptor?.value !== 'function') continue;
        const handler = descriptor.value as object;
        const permission = Reflect.getMetadata(REQUIRED_PERMISSION, handler) as string | undefined;
        const isPublic = Boolean(
          Reflect.getMetadata(IS_PUBLIC, handler) ?? Reflect.getMetadata(IS_PUBLIC, controller),
        );
        found.set(`${controller.name}_${name}`, { permission, isPublic });
      }
    }
  }
  return found;
}
