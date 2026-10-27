import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { BadRequestException, INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsString } from 'class-validator';
import { SwaggerModule } from '@nestjs/swagger';

import { configureApp } from './bootstrap';

jest.mock('@nestjs/swagger', () => ({
  SwaggerModule: { setup: jest.fn() },
}));
jest.mock('node:fs', () => ({
  ...jest.requireActual<typeof import('node:fs')>('node:fs'),
  existsSync: jest.fn(),
}));
jest.mock('./openapi', () => ({
  buildOpenApiDocument: jest.fn(() => ({ openapi: '3.0.0' })),
}));

/**
 * `configureApp` is what `main.ts` and `serverless.ts` share. Everything asserted here is
 * a contract the frontend depends on, so a change that breaks one entrypoint cannot pass
 * by breaking only the other (ADR-0041).
 */

class Dto {
  @IsString()
  name!: string;
}

type Recorded = {
  app: INestApplication;
  use: jest.Mock;
  setGlobalPrefix: jest.Mock;
  enableVersioning: jest.Mock;
  useGlobalPipes: jest.Mock;
  enableCors: jest.Mock;
  /** The Express instance's `set`, where `trust proxy` goes. */
  expressSet: jest.Mock;
};

/** `env` holds what `ConfigService` hands back: validated values, so `TRUST_PROXY` is `false` or a number. */
function recordingApp(env: Record<string, unknown>): Recorded {
  const use = jest.fn();
  const setGlobalPrefix = jest.fn();
  const enableVersioning = jest.fn();
  const useGlobalPipes = jest.fn();
  const enableCors = jest.fn();
  const expressSet = jest.fn();

  const config = {
    get: (key: string, fallback?: unknown) => env[key] ?? fallback,
  } as unknown as ConfigService;

  const app = {
    get: () => config,
    getHttpAdapter: () => ({ getInstance: () => ({ set: expressSet }) }),
    use,
    setGlobalPrefix,
    enableVersioning,
    useGlobalPipes,
    enableCors,
  } as unknown as INestApplication;

  return { app, use, setGlobalPrefix, enableVersioning, useGlobalPipes, enableCors, expressSet };
}

describe('configureApp', () => {
  beforeEach(() => jest.clearAllMocks());

  it('serves every route under /api', () => {
    const r = recordingApp({ NODE_ENV: 'production' });
    configureApp(r.app);
    expect(r.setGlobalPrefix).toHaveBeenCalledWith('api');
  });

  it('versions in the URI and defaults to v1', () => {
    const r = recordingApp({ NODE_ENV: 'production' });
    configureApp(r.app);
    expect(r.enableVersioning).toHaveBeenCalledWith({
      type: VersioningType.URI,
      defaultVersion: '1',
    });
  });

  it('parses cookies — the refresh token lives in an httpOnly cookie', () => {
    const r = recordingApp({ NODE_ENV: 'production' });
    configureApp(r.app);
    expect(r.use).toHaveBeenCalledTimes(1);
    expect(typeof r.use.mock.calls[0][0]).toBe('function');
  });

  describe('the global ValidationPipe', () => {
    function pipeFrom(env: Record<string, string>): ValidationPipe {
      const r = recordingApp(env);
      configureApp(r.app);
      const pipe = r.useGlobalPipes.mock.calls[0][0] as ValidationPipe;
      expect(pipe).toBeInstanceOf(ValidationPipe);
      return pipe;
    }

    it('rejects an unknown field rather than dropping it silently', async () => {
      const pipe = pipeFrom({ NODE_ENV: 'production' });
      await expect(
        pipe.transform({ name: 'ok', typo: 'x' }, { type: 'body', metatype: Dto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not coerce a number into a string — implicit conversion stays off', async () => {
      const pipe = pipeFrom({ NODE_ENV: 'production' });
      await expect(
        pipe.transform({ name: 42 }, { type: 'body', metatype: Dto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a valid body', async () => {
      const pipe = pipeFrom({ NODE_ENV: 'production' });
      await expect(
        pipe.transform({ name: 'ok' }, { type: 'body', metatype: Dto }),
      ).resolves.toEqual({ name: 'ok' });
    });
  });

  describe('CORS', () => {
    it('allows the configured origins with credentials', () => {
      const r = recordingApp({
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://a.example, https://b.example',
      });
      configureApp(r.app);
      expect(r.enableCors).toHaveBeenCalledWith({
        origin: ['https://a.example', 'https://b.example'],
        credentials: true,
        maxAge: 600,
      });
    });

    it('P18.95-T5 (UI-030) lets a browser keep a preflight for ten minutes, not Chrome’s five seconds', () => {
      const r = recordingApp({ NODE_ENV: 'production', CORS_ORIGINS: 'https://a.example' });
      configureApp(r.app);
      expect(r.enableCors.mock.calls[0][0]).toMatchObject({ maxAge: 600 });
    });

    it('allows no origin at all when none is configured', () => {
      // `false`, not `*`. Credentialed requests plus a wildcard origin is the combination
      // that leaks an authenticated session to any site that asks.
      const r = recordingApp({ NODE_ENV: 'production' });
      configureApp(r.app);
      expect(r.enableCors).toHaveBeenCalledWith({ origin: false, credentials: true, maxAge: 600 });
    });
  });

  /*
   * P18.7-T1 (ADR-0152): behind Caddy the socket is always the proxy, so without this every client
   * shares one `req.ip`, one login bucket, and one address on every session row.
   */
  describe('trust proxy (P18.7-T1)', () => {
    it('P18.7-T1 trusts no proxy by default', () => {
      const r = recordingApp({ NODE_ENV: 'production', TRUST_PROXY: false });
      configureApp(r.app);
      expect(r.expressSet).toHaveBeenCalledWith('trust proxy', false);
    });

    it('P18.7-T1 trusts the configured number of hops', () => {
      const r = recordingApp({ NODE_ENV: 'production', TRUST_PROXY: 1 });
      configureApp(r.app);
      expect(r.expressSet).toHaveBeenCalledWith('trust proxy', 1);
    });

    it.each([undefined, 'true', true, '1', 0, -1])(
      'P18.7-T1 trusts nothing when handed %j, which validation never produces',
      (value) => {
        const r = recordingApp({ NODE_ENV: 'production', TRUST_PROXY: value });
        configureApp(r.app);
        expect(r.expressSet).toHaveBeenCalledWith('trust proxy', false);
      },
    );
  });

  describe('Swagger', () => {
    const exists = existsSync as jest.MockedFunction<typeof existsSync>;

    it('is not served in production', () => {
      const r = recordingApp({ NODE_ENV: 'production' });
      configureApp(r.app);
      expect(SwaggerModule.setup).not.toHaveBeenCalled();
    });

    it('is served in staging, where a reader needs the contract', () => {
      const r = recordingApp({ NODE_ENV: 'staging' });
      configureApp(r.app);
      expect(SwaggerModule.setup).toHaveBeenCalledWith(
        'api/docs',
        r.app,
        expect.anything(),
        expect.anything(),
      );
    });

    /*
     * The UI's stylesheet and bundles are served by `express.static`, not by a route, so
     * Vercel's require-tracing never pulled them into the function bundle: staging
     * rendered the page and 404'd every asset. `pnpm build` now copies them beside the
     * compiled app, and this is the pair of assertions that keeps both paths honest.
     */
    it('points at the assets copied beside the build when they are there', () => {
      exists.mockReturnValue(true);

      const r = recordingApp({ NODE_ENV: 'staging' });
      configureApp(r.app);

      expect(SwaggerModule.setup).toHaveBeenCalledWith(
        'api/docs',
        r.app,
        expect.anything(),
        { customSwaggerUiPath: join(__dirname, 'swagger-ui') },
      );
    });

    it('lets the package resolve its own assets when the build copy is absent', () => {
      // Local development: neither `nest start --watch` nor jest runs the copy step, and
      // `node_modules` is a real tree there rather than a traced bundle.
      exists.mockReturnValue(false);

      const r = recordingApp({ NODE_ENV: 'development' });
      configureApp(r.app);

      expect(SwaggerModule.setup).toHaveBeenCalledWith('api/docs', r.app, expect.anything(), {
        customSwaggerUiPath: undefined,
      });
    });
  });
});
