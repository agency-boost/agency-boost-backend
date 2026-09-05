import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import { AppModule } from './app.module';
import { startMongo, stopMongo } from '../test/mongo';

/**
 * Boots the real AppModule.
 *
 * The auth e2e wires providers by hand, so it cannot catch a provider missing from
 * app.module.ts — exactly the mistake that makes `pnpm dev` fail on a developer's
 * machine while every other test passes.
 */
describe('AppModule boots', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const uri = await startMongo();
    await mongoose.disconnect();

    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      MONGODB_URI: uri,
      MONGODB_DB_NAME: 'agencyboost_boot',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      CLOUDINARY_CLOUD_NAME: 'demo',
      CLOUDINARY_API_KEY: 'key',
      CLOUDINARY_API_SECRET: 'secret',
      SMTP_HOST: 'smtp.test',
      MAIL_FROM: 'AgencyBoost <no-reply@test>',
      APP_BASE_URL: 'http://localhost:3000',
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    // Listening once keeps supertest from cycling an ephemeral port per
    // request — see auth.e2e.int.spec.ts for what that causes.
    await app.listen(0);
  });

  afterAll(async () => {
    await app?.close();
    await stopMongo();
  });

  it('resolves every provider in the real module graph', () => {
    expect(app).toBeDefined();
  });

  it('serves health without a token', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200, { status: 'ok' });
  });

  it('protects a private route by default — the guard is global, not per-controller', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
  });

  it('leaves public auth routes reachable', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody@kpm.test' })
      .expect(202);
  });

  it('enforces permissions on the admin surface', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/admin/tenants').expect(401);
    expect(res.body.error.code).toBeDefined();
  });
});
