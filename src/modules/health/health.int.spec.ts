import { Controller, Get, INestApplication, VersioningType, Version } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthController } from './health.controller';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { APP_FILTER } from '@nestjs/core';
import mongoose, { Connection } from 'mongoose';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { listenOnLoopback } from '../../../test/listen';
import { startMongo, stopMongo } from '../../../test/mongo';

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
    await listenOnLoopback(app);
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

/**
 * **Readiness answers with its status, not only its body** (P18.4-T1, ADR-0152), over a real
 * connection and through the global error filter. A probe reads the status: `200` with `degraded`
 * in the body passed the container's healthcheck and the deploy's wait with no database behind
 * the API. And the filter must not rewrite the body into its error envelope, so whoever reads it
 * still sees which check failed.
 */
describe('readiness over a real connection (P18.4-T1)', () => {
  let app: INestApplication;
  let connection: Connection;

  beforeAll(async () => {
    const uri = await startMongo();
    const dbName = mongoose.connection.db?.databaseName;
    await mongoose.disconnect(); // hand the database to Nest's own connection

    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri, { dbName })],
      controllers: [HealthController],
      providers: [{ provide: APP_FILTER, useClass: DomainExceptionFilter }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    await listenOnLoopback(app);
    connection = app.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  it('P18.4-T1 answers 200 while the database is connected', async () => {
    await request(app.getHttpServer())
      .get('/api/health/ready')
      .expect(200, { status: 'ok', checks: { database: 'up' } });
  });

  it('P18.4-T1 answers 503 with the same body once the database is gone, and liveness stays 200', async () => {
    await connection.close();
    expect(connection.readyState).not.toBe(1);

    await request(app.getHttpServer())
      .get('/api/health/ready')
      .expect(503, { status: 'degraded', checks: { database: 'down' } });
    // Liveness says nothing about dependencies: the process is up, so a restart would not help.
    await request(app.getHttpServer()).get('/api/health').expect(200, { status: 'ok' });
  });
});
