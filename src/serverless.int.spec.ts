import request from 'supertest';
import mongoose from 'mongoose';

import { startMongo, stopMongo } from '../test/mongo';

/**
 * Drives the Vercel entrypoint exactly as the platform does: call the exported handler
 * with a request and a response, nothing else (ADR-0041).
 *
 * This is the test the deploy needed and did not have. `main.ts` was covered by running
 * it; the serverless path has no equivalent — a broken handler shows up as a 500 on a
 * staging URL, after a deploy, with the cause several layers down. Asserting on it here
 * means the Nest graph, the global prefix, the versioning and the handler's own caching
 * are all exercised before anything is pushed.
 */
describe('the serverless handler', () => {
  let handler: (req: unknown, res: unknown) => Promise<void>;

  beforeAll(async () => {
    const uri = await startMongo();
    await mongoose.disconnect();

    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      MONGODB_URI: uri,
      MONGODB_DB_NAME: 'agencyboost_serverless',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      CLOUDINARY_CLOUD_NAME: 'demo',
      CLOUDINARY_API_KEY: 'key',
      CLOUDINARY_API_SECRET: 'secret',
      SMTP_HOST: 'smtp.test',
      MAIL_FROM: 'AgencyBoost <no-reply@test>',
      APP_BASE_URL: 'http://localhost:3000',
    });

    // Imported after the environment is set: the module builds the Nest graph on first
    // request, and validateEnv runs with whatever is in process.env at that moment.
    handler = (await import('./serverless')).handler as typeof handler;
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await stopMongo();
  });

  it('answers the liveness probe through the handler alone', async () => {
    await request(handler).get('/api/health').expect(200, { status: 'ok' });
  });

  it('keeps the global prefix and URI versioning that main.ts applies', async () => {
    // A versioned route resolves, and the unversioned spelling does not. This is the pair
    // that proves configureApp ran on this path too — a handler that skipped it would
    // answer both, or neither.
    await request(handler).get('/api/v1/health').expect(404);
    await request(handler).get('/health').expect(404);
  });

  it('reports readiness with a live database connection', async () => {
    await request(handler)
      .get('/api/health/ready')
      .expect(200, { status: 'ok', checks: { database: 'up' } });
  });

  it('builds the application once and reuses it across invocations', async () => {
    // What makes the function affordable: a warm container must not rebuild the Nest
    // graph — and with it a fresh Atlas connection pool — for every request.
    const connectionsBefore = mongoose.connections.length;
    await request(handler).get('/api/health').expect(200);
    await request(handler).get('/api/health').expect(200);
    expect(mongoose.connections.length).toBe(connectionsBefore);
  });
});
