import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
// Above AppModule: its import validates the configuration (test/boot-env.ts says why).
import '../test/boot-env';
import { AppModule } from './app.module';
import { startMongo, stopMongo } from '../test/mongo';
import { listenOnLoopback } from '../test/listen';
import { ActivationEvents } from './modules/activation/activation-events.port';
import { ActivationNav } from './modules/activation/activation-nav.port';
import { ActivationProgressService } from './modules/activation/activation-progress.service';
import { TrainingProgressService } from '@/modules/training/training-progress.service';
import { ActivityService } from './modules/activity/activity.service';
import { TenantConfigService } from './modules/config/tenant-config.service';
import { RatioDefinitionRepository } from './modules/config/activity.repository';
import { AuthController } from './modules/auth/auth.controller';
import { ProfileLineReader } from './modules/org/profile-line';
import { CalendarLeave } from './modules/calendar/calendar-leave';
import { GoalService } from './modules/goals/goal.service';
import { LeadService } from './modules/leads/lead.service';
import { ApprovalsService } from './modules/org/approvals.service';
import { ActivationStarter } from './modules/org/activation-starter.port';
import { LeaderCodeService } from './modules/org/leader-code.service';
import { MemberDeparture, MemberDepartures } from './modules/org/member-departure.port';
import { CampaignChaseDeparture } from './modules/campaigns/campaign-departure';
import { RemovalService } from './modules/org/removal.service';
import { InvitesService } from './modules/org/invites.service';
import { ModulesContainer } from '@nestjs/core';
import { OPTIONAL_DEPS_METADATA, PARAMTYPES_METADATA, SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import { DirectoryService } from './modules/org/directory.service';
import { PeopleService } from './modules/org/people.service';
import { AdminDelegationService } from './modules/org/admin-delegation.service';
import { RoleChangeService } from './modules/org/role-change.service';
import { TransfersService } from './modules/org/transfers.service';
import { OrgLevelService } from './modules/tenants/org-level.service';
import { RosterImportRecordRepository } from './modules/tenants/roster-import-record.schema';
import { AvatarLinks } from './modules/users/avatar.service';
import { OfficeGroups } from './modules/reporting/office-groups';
import { AnalyticsConfigReader } from './modules/config/analytics-config.reader';
import { BrandingReader } from './modules/branding/branding-reader';
import { ProductionImportService } from './modules/production/production-import.service';
import { ProductionCorrections } from './modules/production/production-correction.service';
import { UnregisteredAgentDataRepository } from './modules/production/unregistered-agent-data.repository';
import { DataUploadBatchRepository } from './modules/production/data-upload-batch.repository';
import { DataUploadRowRepository } from './modules/production/data-upload-row.repository';
import { CampaignService } from './modules/campaigns/campaign.service';

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
    // The configuration was fixed when AppModule was imported (test/boot-env.ts); this only makes sure the
    // run's server is up, and hands the connection back to the module.
    await startMongo();
    await mongoose.disconnect();

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
    // P18.5-T6 AC-1: the profile line's groups and office, read with the session.
    expect(port(AuthController, 'profileLine')).toBe(app.get(ProfileLineReader, { strict: false }));
    // P18.2-T7 AC-5: leaving answers the calendar and the campaigns' chases, both behind the one port.
    const departures = port(RemovalService, 'departures') as { each: unknown[] };
    expect(departures).toBe(app.get(MemberDeparture as never, { strict: false }));
    expect(departures.each[0] === app.get(CalendarLeave, { strict: false })).toBe(true);
    expect(departures.each[1] === app.get(CampaignChaseDeparture, { strict: false })).toBe(true);
    // P18.2-T3 AC-2: a module marked done reaches the hire's activation through the same port.
    expect(port(TrainingProgressService, 'activation')).toBe(activation);
    // P18.8-T3 AC-4: registration on an invite's link reaches the invites, by token.
    expect(port(AuthController, 'invites') === app.get(InvitesService, { strict: false })).toBe(true);
    expect(port(InvitesService, 'activations')).toBe(activation);
  });

  /*
   * **The same defect, found again 2026-11-20 by a walk in a real browser**, in fourteen parameters written
   * `@Optional() private readonly x: X | null = null` with no `@Inject(X)`. Every one stayed null in the running app
   * while its specs, building the service by hand, passed: *All members* had no Group and no photos, a member's role
   * choices came from the default ladder rather than the company's, a correction could not go back to the file's
   * figure, and an upload never wrote its *Belum terdaftar* rows. Each consumer's field is read off the real graph and
   * must be the one instance the container holds — compared with `===`, because a failing `toBe` prints the graph.
   */
  it('wires the fourteen optional dependencies the 2026-11-20 walk found null, each to its real instance', () => {
    const wiring: [consumer: unknown, field: string, token: unknown][] = [
      [DirectoryService, 'orgLevels', OrgLevelService],
      [DirectoryService, 'avatarLinks', AvatarLinks],
      [DirectoryService, 'officeGroups', OfficeGroups],
      [PeopleService, 'records', RosterImportRecordRepository],
      [PeopleService, 'avatarLinks', AvatarLinks],
      [AdminDelegationService, 'avatarLinks', AvatarLinks],
      [RoleChangeService, 'transfers', TransfersService],
      [InvitesService, 'analytics', AnalyticsConfigReader],
      [InvitesService, 'branding', BrandingReader],
      [ProductionImportService, 'unregistered', UnregisteredAgentDataRepository],
      [ProductionCorrections, 'analytics', AnalyticsConfigReader],
      [ProductionCorrections, 'batches', DataUploadBatchRepository],
      [ProductionCorrections, 'batchRows', DataUploadRowRepository],
      [CampaignService, 'orgLevels', OrgLevelService],
    ];
    const wrong = wiring
      .map(([consumer, field, token]) => {
        const held = (app.get(consumer as never, { strict: false }) as Record<string, unknown>)[field];
        const real = app.get(token as never, { strict: false });
        return { at: `${(consumer as { name: string }).name}.${field}`, ok: held != null && held === real };
      })
      .filter((row) => !row.ok)
      .map((row) => row.at);
    expect(wrong).toEqual([]);
  });

  /*
   * **And the class of defect, not only its fourteen instances.** Every provider and controller in the real graph is
   * read for the parameters it marks `@Optional()`: one whose design type reached the container as `Object` (a union
   * with `null` or `undefined`, or an interface) and that names no token with `@Inject` resolves to nothing, silently,
   * forever. A required one fails the boot on its own; an optional one has only this test.
   */
  it('names a token for every @Optional() constructor parameter whose design type is not a class', () => {
    const untyped: string[] = [];
    for (const module of app.get(ModulesContainer).values()) {
      for (const wrapper of [...module.providers.values(), ...module.controllers.values()]) {
        const type = wrapper.metatype as (abstract new (...args: never[]) => unknown) | null;
        if (typeof type !== 'function' || !type.prototype) continue;
        const optional: number[] = Reflect.getMetadata(OPTIONAL_DEPS_METADATA, type) ?? [];
        const design: unknown[] = Reflect.getMetadata(PARAMTYPES_METADATA, type) ?? [];
        const named = new Set(((Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, type) ?? []) as { index: number }[]).map((d) => d.index));
        for (const index of optional) {
          if (!named.has(index) && (design[index] === Object || design[index] === undefined)) untyped.push(`${type.name} parameter ${index}`);
        }
      }
    }
    expect([...new Set(untyped)]).toEqual([]);
  });

  /*
   * **P18.8-T3: `/new-hires/invites` and `/new-hires/transfers` are their own routes, not a hire's id.** Express takes
   * the first route that matches in the order they were registered, and `NewHiresController` declares
   * `GET /new-hires/:membershipId`: registered before *+ Add agent*'s controller, it would read `invites` as a
   * membership and answer 404. Both are guarded, so a request cannot tell them apart; the router's own order can.
   */
  it('P18.8-T3 registers GET /new-hires/invites and /new-hires/transfers before GET /new-hires/:membershipId', () => {
    const stack = (app.getHttpAdapter().getInstance() as { _router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } })
      ._router.stack;
    const at = (path: string) => stack.findIndex((layer) => layer.route?.path === path && layer.route.methods.get);
    const hire = at('/api/v1/new-hires/:membershipId');
    expect(hire).toBeGreaterThan(-1);
    expect(at('/api/v1/new-hires/invites')).toBeGreaterThan(-1);
    expect(at('/api/v1/new-hires/invites')).toBeLessThan(hire);
    expect(at('/api/v1/new-hires/transfers')).toBeLessThan(hire);
    expect(at('/api/v1/new-hires/transfers')).toBeGreaterThan(-1);
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
   * P18.5-T10 AC-1: a plan nobody saved opens on the office's benchmarks, read through an optional dependency
   * so a hand-built instance need not provide it. Optional means a graph that failed to would quietly open
   * every plan on `GOAL_DEFAULTS` again, so the real graph is asserted.
   */
  it('P18.5-T10 AC-1 hands GoalService the office’s ratio definitions, in the real graph', () => {
    const service = app.get(GoalService, { strict: false }) as unknown as Record<string, unknown>;
    expect(service.ratios === app.get(RatioDefinitionRepository, { strict: false })).toBe(true);
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
    expect(app.get(MemberDeparture as never, { strict: false })).toBeInstanceOf(MemberDepartures);
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

  it('answers a path no route serves 404 NOT_FOUND, through the real router — never INTERNAL_ERROR', async () => {
    for (const path of ['/api/v1/no-such-route', '/api/no-such-route', '/']) {
      const res = await request(app.getHttpServer()).get(path).expect(404);
      expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: `Cannot GET ${path}` });
    }
  });

  it('enforces permissions on the admin surface', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/admin/tenants').expect(401);
    expect(res.body.error.code).toBeDefined();
  });

  it('P19.17-T3 (ADR-0269) serves neither the Super Admin’s guide nor the linked-login routes: no route, 404', async () => {
    for (const path of ['/api/v1/admin/panduan', '/api/v1/admin/panduan/pdf']) {
      const res = await request(app.getHttpServer()).get(path).expect(404);
      expect([path, res.body.error.code]).toEqual([path, 'NOT_FOUND']);
    }
    for (const path of ['/api/v1/auth/links', '/api/v1/auth/links/confirm', '/api/v1/auth/links/switch']) {
      const res = await request(app.getHttpServer()).post(path).send({}).expect(404);
      expect([path, res.body.error.code]).toEqual([path, 'NOT_FOUND']);
    }
  });
});
