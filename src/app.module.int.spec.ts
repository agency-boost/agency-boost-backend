import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import { AppModule } from './app.module';
import { startMongo, stopMongo } from '../test/mongo';
import { listenOnLoopback } from '../test/listen';
import { ActivationEvents } from './modules/activation/activation-events.port';
import { ActivationNav } from './modules/activation/activation-nav.port';
import { ActivationProgressService } from './modules/activation/activation-progress.service';
import { ActivityService } from './modules/activity/activity.service';
import { TenantConfigService } from './modules/config/tenant-config.service';
import { AuthController } from './modules/auth/auth.controller';
import { CalendarLeave } from './modules/calendar/calendar-leave';
import { GoalService } from './modules/goals/goal.service';
import { LeadService } from './modules/leads/lead.service';
import { ApprovalsService } from './modules/org/approvals.service';
import { ActivationStarter } from './modules/org/activation-starter.port';
import { LeaderCodeService } from './modules/org/leader-code.service';
import { MemberDeparture } from './modules/org/member-departure.port';
import { RemovalService } from './modules/org/removal.service';

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
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
    await stopMongo();
  });

  it('resolves every provider in the real module graph', () => {
    expect(app).toBeDefined();
  });

  /*
   * **An optional port resolves to nothing, silently, unless it is injected by its token** (found
   * 2026-10-03). A parameter typed `Port | null` reaches the container as `Object`, and `@Optional()`
   * then hands it `undefined`: D-leave's `MemberDeparture` never ran in the app, while every spec — each
   * building `RemovalService` by hand — passed. So each consumer's port is read off the real graph here.
   */
  it('P13-T3 AC-5 wires every optional port to the module that answers it, in the real graph', () => {
    const port = (consumer: unknown, field: string) => (app.get(consumer as never, { strict: false }) as Record<string, unknown>)[field];
    const activation = app.get(ActivationProgressService, { strict: false });
    expect(port(GoalService, 'activation')).toBe(activation);
    expect(port(LeadService, 'activation')).toBe(activation);
    expect(port(ActivityService, 'activation')).toBe(activation);
    expect(port(ApprovalsService, 'activations')).toBe(activation);
    expect(port(LeaderCodeService, 'activations')).toBe(activation);
    expect(port(AuthController, 'activationNav')).toBe(activation);
    expect(port(RemovalService, 'departures')).toBe(app.get(CalendarLeave, { strict: false }));
  });

  /*
   * P13.1-T2: Log Activity's day and its save read the published copy through an optional dependency, so
   * a hand-built instance (the seed's) need not build the renderer. Optional means a graph that failed to
   * provide it would quietly read the draft again — the client's defect — so the real graph is asserted.
   */
  it('P13.1-T2 hands ActivityService the published configuration, in the real graph', () => {
    const service = app.get(ActivityService, { strict: false }) as unknown as Record<string, unknown>;
    // Compared, not matched: a failing `toBe` on a service prints its whole graph, configuration included.
    expect(service.published === app.get(TenantConfigService, { strict: false })).toBe(true);
  });

  /*
   * P13.1-T4 AC-10: a lead's move and its close are judged against the same published ladder the table
   * offers, read through `LeadService.config`. Required rather than optional, so it cannot be null; this
   * pins that it is the one configuration service, not a second instance reading another copy.
   */
  it('P13.1-T4 AC-10 hands LeadService the published configuration, in the real graph', () => {
    const service = app.get(LeadService, { strict: false }) as unknown as Record<string, unknown>;
    expect(service.config === app.get(TenantConfigService, { strict: false })).toBe(true);
  });

  /*
   * The Phase 13 exit review, N9: the three ports themselves, by token, resolve to the one service that
   * answers them — not to three instances, and not to nothing. The test above reads each consumer's field;
   * this one reads the container's own answer for the token, which a consumer added later injects.
   */
  it('Phase 13 exit review N9 resolves ActivationStarter, ActivationEvents and ActivationNav, by token, to the one ActivationProgressService', () => {
    const activation = app.get(ActivationProgressService, { strict: false });
    expect(activation).toBeInstanceOf(ActivationProgressService);
    for (const token of [ActivationStarter, ActivationEvents, ActivationNav]) {
      expect([token.name, app.get(token as never, { strict: false }) === activation]).toEqual([token.name, true]);
    }
    expect(app.get(MemberDeparture as never, { strict: false })).toBe(app.get(CalendarLeave, { strict: false }));
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
