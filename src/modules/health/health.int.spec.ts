import { Controller, Get, INestApplication, VersioningType, Version } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthController } from './health.controller';
import { getConnectionToken } from '@nestjs/mongoose';

/**
 * Proves the routing contract the frontend depends on:
 *  - versioned routes live under /api/v{n}
 *  - v1 and v2 can be served side by side from one process
 *  - health is version-neutral, so a probe never tracks the contract version
 */

@Controller({ path: 'leads' })
class LeadsV1Controller {
  @Get()
  list() {
    return { version: 'v1' };
  }
}

@Controller({ path: 'leads' })
class LeadsV2Controller {
  @Version('2')
  @Get()
  list() {
    return { version: 'v2' };
  }
}

describe('API versioning', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController, LeadsV1Controller, LeadsV2Controller],
      // Provide the connection token directly: MongooseModule is not imported here,
      // so there is nothing to override. This suite tests routing, not the database.
      providers: [{ provide: getConnectionToken(), useValue: { readyState: 1 } }],
    }).compile();

    app = moduleRef.createNestApplication();
    // Exactly what main.ts does.
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    // Listening once keeps supertest from cycling an ephemeral port per
    // request — see auth.e2e.int.spec.ts for what that causes.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves an unannotated controller at v1 by default', async () => {
    await request(app.getHttpServer()).get('/api/v1/leads').expect(200, { version: 'v1' });
  });

  it('serves v1 and v2 side by side — the reason the version is not in the base URL', async () => {
    await request(app.getHttpServer()).get('/api/v1/leads').expect(200, { version: 'v1' });
    await request(app.getHttpServer()).get('/api/v2/leads').expect(200, { version: 'v2' });
  });

  it('does not expose an unversioned route for a versioned controller', async () => {
    await request(app.getHttpServer()).get('/api/leads').expect(404);
  });

  it('serves health without a version', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200, { status: 'ok' });
  });

  it('exposes health at exactly one URL, which never moves with the contract version', async () => {
    // VERSION_NEUTRAL under URI versioning means the route is served *without* a
    // version segment — not duplicated under every one. That is the behaviour we want:
    // an uptime monitor or k8s probe is configured once and never revisited when v2
    // ships. Verified empirically rather than assumed.
    await request(app.getHttpServer()).get('/api/health').expect(200);
    await request(app.getHttpServer()).get('/api/v1/health').expect(404);
    await request(app.getHttpServer()).get('/api/v2/health').expect(404);
  });

  it('reports readiness with the database check', async () => {
    await request(app.getHttpServer())
      .get('/api/health/ready')
      .expect(200, { status: 'ok', checks: { database: 'up' } });
  });
});
