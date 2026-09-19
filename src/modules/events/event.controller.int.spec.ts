import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  ADMIN, AGENT, declaredPermissions, EVERY_MEMBER, NOT_ADMINISTRATORS, OWNER, session,
  productionPipe, StubAuth,
} from '../../../test/http-permissions';
import { EventController } from './event.controller';
import { EventService } from './event.service';

const NOW = new Date('2026-09-18T02:00:00Z');

/** Every route, and the permission it must declare. */
const ROUTES: Record<string, string> = {
  listTypes: 'tenant_config:read',
  createType: 'tenant_config:write',
  updateType: 'tenant_config:write',
  archiveType: 'tenant_config:write',
  restoreType: 'tenant_config:write',
  list: 'tenant_config:read',
  create: 'tenant_config:write',
  update: 'tenant_config:write',
  archive: 'tenant_config:write',
  restore: 'tenant_config:write',
};

const anEvent = (over: Record<string, unknown> = {}) => ({
  code: 'KICKOFF', typeCode: 'TRAINING', title: 'Kickoff 2026',
  startsAt: '2026-10-01T02:00:00Z', endsAt: '2026-10-01T06:00:00Z',
  location: 'Jakarta',
  audience: { issuer: 'kpm', scope: 'all_agents' },
  ...over,
});

/**
 * The events an office runs, over HTTP (P5-T6).
 *
 * `event.tenancy.spec.ts` proves the isolation and the audience rules by calling the service, so
 * until this file existed nothing executed a single one of this controller's ten decorators. Two
 * things only a request can answer live here: **who the API refuses**, and whether `types` is
 * still a literal segment rather than something `:id` swallows — the routes are declared in an
 * order that makes that true, and an order is not a guarantee.
 */
describe('an office’s events over HTTP (P5-T6)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  const url = '/kpm/settings/events';

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);

    const moduleRef = await Test.createTestingModule({
      controllers: [EventController],
      providers: [{ provide: EventService, useValue: wired.events }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    session.current = OWNER;
    await clearCollections();
    await wired.events.seedForOffice(OWNER);
  });

  it('declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(EventController)).toEqual(ROUTES);
  });

  describe('who may reach it', () => {
    it.each(EVERY_MEMBER)('shows %s the types and the events', async (_name, who) => {
      session.current = who;

      const types = await request(app.getHttpServer()).get(`${url}/types`).expect(200);
      await request(app.getHttpServer()).get(url).expect(200);

      expect(types.body).toHaveLength(5);
    });

    it.each(NOT_ADMINISTRATORS)('refuses %s every write', async (_name, who) => {
      session.current = who;
      const server = app.getHttpServer();

      await request(server).post(`${url}/types`)
        .send({ code: 'X', label: 'X' }).expect(403);
      await request(server).patch(`${url}/types/whatever`).send({ label: 'X' }).expect(403);
      await request(server).post(`${url}/types/whatever/archive`).send({}).expect(403);
      await request(server).post(`${url}/types/whatever/restore`).send({}).expect(403);
      await request(server).post(url).send(anEvent()).expect(403);
      await request(server).patch(`${url}/whatever`).send({ title: 'X' }).expect(403);
      await request(server).post(`${url}/whatever/archive`).send({}).expect(403);
      await request(server).post(`${url}/whatever/restore`).send({}).expect(403);
    });

    it.each([['the Owner', OWNER], ['the Admin', ADMIN]])(
      'lets %s run the office’s events', async (_name, who) => {
        session.current = who;

        const made = await request(app.getHttpServer()).post(url).send(anEvent()).expect(201);
        const archived = await request(app.getHttpServer())
          .post(`${url}/${made.body.id}/archive`).send({}).expect(201);

        expect(made.body).toMatchObject({ code: 'KICKOFF', typeCode: 'TRAINING' });
        expect(archived.body.status).toBe('archived');
      },
    );
  });

  describe('the routing', () => {
    it('keeps `types` a literal, not an event id', async () => {
      /*
       * `GET types` and `GET /` differ by one segment, but `PATCH types/:id` and `PATCH :id` do
       * not — the first only wins because it is declared first. Swap the two blocks and renaming
       * an event type starts renaming an *event* whose id happens to be the string `types`.
       */
      await request(app.getHttpServer()).post(url).send(anEvent({ code: 'TYPES' })).expect(201);

      const types = await request(app.getHttpServer()).get(`${url}/types`).expect(200);

      expect(types.body.map((t: { code: string }) => t.code)).toContain('TRAINING');
      expect(types.body.some((t: { title?: string }) => t.title === 'Kickoff 2026')).toBe(false);
    });

    it('archives a type through its own path, leaving the events alone', async () => {
      const training = (await request(app.getHttpServer()).get(`${url}/types`).expect(200))
        .body.find((t: { code: string }) => t.code === 'TRAINING');

      const res = await request(app.getHttpServer())
        .post(`${url}/types/${training.id}/archive`).send({}).expect(201);

      expect(res.body.status).toBe('archived');
    });
  });

  describe('every route answers, not just the ones a role test reaches', () => {
    /*
     * A 403 test proves the guard refused — it never enters the handler. Without these, half
     * this controller's methods were still never executed, which is the state the whole file
     * exists to end.
     */
    it('adds a type, renames it, archives it and brings it back', async () => {
      const clinic = (await request(app.getHttpServer()).post(`${url}/types`)
        .send({ code: 'clinic', label: 'Product clinic', emoji: '🩺', color: '#27AE60' })
        .expect(201)).body;
      expect(clinic).toMatchObject({ code: 'CLINIC', label: 'Product clinic', emoji: '🩺' });

      const renamed = await request(app.getHttpServer())
        .patch(`${url}/types/${clinic.id}`).send({ label: 'Clinic' }).expect(200);
      expect(renamed.body.label).toBe('Clinic');

      const archived = await request(app.getHttpServer())
        .post(`${url}/types/${clinic.id}/archive`).send({}).expect(201);
      expect(archived.body.status).toBe('archived');

      const restored = await request(app.getHttpServer())
        .post(`${url}/types/${clinic.id}/restore`).send({}).expect(201);
      expect(restored.body.status).toBe('active');
    });

    it('edits an event and brings an archived one back', async () => {
      const made = await request(app.getHttpServer()).post(url).send(anEvent()).expect(201);

      const edited = await request(app.getHttpServer())
        .patch(`${url}/${made.body.id}`).send({ title: 'Kickoff 2027' }).expect(200);
      expect(edited.body.title).toBe('Kickoff 2027');

      await request(app.getHttpServer()).post(`${url}/${made.body.id}/archive`).send({})
        .expect(201);
      const restored = await request(app.getHttpServer())
        .post(`${url}/${made.body.id}/restore`).send({}).expect(201);
      expect(restored.body.status).toBe('active');
    });

    it('lists the archived ones only when asked', async () => {
      const made = await request(app.getHttpServer()).post(url).send(anEvent()).expect(201);
      await request(app.getHttpServer()).post(`${url}/${made.body.id}/archive`).send({})
        .expect(201);

      expect((await request(app.getHttpServer()).get(url).expect(200)).body).toHaveLength(0);
      expect((await request(app.getHttpServer()).get(`${url}?includeArchived=true`).expect(200))
        .body).toHaveLength(1);
    });
  });

  describe('the guard runs before the body is trusted', () => {
    it('refuses an agent a malformed write without telling them it was malformed', async () => {
      // 403 rather than 400: what the body said is none of their business, and an error that
      // grades somebody's payload before checking their right to send one is a disclosure.
      session.current = AGENT;

      await request(app.getHttpServer()).post(url).send({ nonsense: true }).expect(403);
    });
  });
});
