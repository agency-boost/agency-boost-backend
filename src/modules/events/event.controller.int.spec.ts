import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { RequestContext } from '@/common/context/request-context';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, NOT_ADMINISTRATORS, OWNER, session,
  productionPipe, StubAuth,
} from '../../../test/http-permissions';
import { EventController } from './event.controller';
import { EventService } from './event.service';
import { EventRollCallService } from './event-roll-call.service';
import { listenOnLoopback } from '../../../test/listen';
import { IN_INDONESIAN } from '../../../test/i18n';
import { EVENT_ISSUERS } from '@/domain/constants';

const NOW = new Date('2026-09-18T02:00:00Z');

/** A read-only support session as the Owner (P4-T10): reads what the Owner reads, writes nothing. */
const READ_ONLY_OWNER = new RequestContext(
  OWNER.userId, 'none', OWNER.membership, 'u-support', null, false, true,
);

/** Every route, and the permission it must declare. */
const ROUTES: Record<string, string> = {
  // The Phase 18.2 exit review (B1): archived types and per-type counts are the office's administration's.
  listTypes: 'event_settings:read',
  createType: 'tenant_config:write',
  updateType: 'tenant_config:write',
  archiveType: 'tenant_config:write',
  restoreType: 'tenant_config:write',
  // P18.2-T5 AC-2: the list is the office's administration's (the leak), with the roll call and the picker's people.
  list: 'event_settings:read',
  create: 'tenant_config:write',
  update: 'tenant_config:write',
  archive: 'tenant_config:write',
  restore: 'tenant_config:write',
  invitees: 'event_settings:read',
  // The roll call's read is guarded by the confirm it serves (the phase file's *Settled already*).
  rollCall: 'event_attendance:confirm',
  saveRollCall: 'event_attendance:confirm',
  feedbackSummary: 'event_feedback:read',
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
      providers: [
        { provide: EventService, useValue: wired.events },
        { provide: EventRollCallService, useValue: wired.eventRollCalls },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
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
    it.each([['the Owner', OWNER], ['the Admin', ADMIN], ['a read-only session as the Owner', READ_ONLY_OWNER]])(
      'shows %s the types with their counts, archived ones on request', async (_name, who) => {
        session.current = who;

        const types = await request(app.getHttpServer()).get(`${url}/types?includeArchived=true`).expect(200);

        expect(types.body).toHaveLength(5);
        expect(types.body[0]).toHaveProperty('events');
      },
    );

    /*
     * The Phase 18.2 exit review (B1): every member read archived types and how many events — leader-only and
     * chosen-people ones included — named each. Members read the active types, with no counts, in `/kpm/config`.
     */
    it.each([['an AB', AB], ['an AAB', AAB], ['an agent', AGENT]])(
      'P18.2-T5 AC-2 refuses %s the types, archived ones and counts included', async (_name, who) => {
        session.current = who;
        const res = await request(app.getHttpServer()).get(`${url}/types?includeArchived=true`).expect(403);
        expect(res.body.error.code).toBe('PERM_DENIED');
        expect(JSON.stringify(res.body)).not.toContain('TRAINING');
      },
    );

    /*
     * P18.2-T5 AC-2 — **the leak, closed.** This test asserted the opposite until Phase 18.2: every member read the
     * office's events, leader-only ones and their invitee lists included, against ADR-0039 and the Owner's own manual.
     */
    it.each([['an AB', AB], ['an AAB', AAB], ['an agent', AGENT]])(
      'P18.2-T5 AC-2 refuses %s the events list, 403 with no event in the body', async (_name, who) => {
        session.current = OWNER;
        await request(app.getHttpServer()).post(url).send(anEvent({
          audience: { issuer: 'kpm', scope: 'leaders' },
        })).expect(201);

        session.current = who;
        const res = await request(app.getHttpServer()).get(url).expect(403);

        expect(res.body.error.code).toBe('PERM_DENIED');
        expect(JSON.stringify(res.body)).not.toContain('KICKOFF');
        expect(JSON.stringify(res.body)).not.toContain('inviteeMembershipIds');
      },
    );

    it.each([['the Owner', OWNER], ['the Admin', ADMIN], ['a read-only session as the Owner', READ_ONLY_OWNER]])(
      'P18.2-T5 AC-2 shows %s the events list', async (_name, who) => {
        session.current = who;
        await request(app.getHttpServer()).get(url).expect(200);
      },
    );

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

  /**
   * **The Owner's refusals, in Bahasa Indonesia** (P18.10-T5 AC-7): a code taken and an archived type — Nest's
   * `BadRequestException` once, the same `400 VALIDATION_FAILED` now — and a malformed event's field sentences.
   */
  describe('P18.10-T5 AC-7 the Owner’s refusals in Indonesian', () => {
    const post = (body: Record<string, unknown>) => request(app.getHttpServer()).post(url).set(...IN_INDONESIAN).send(body);

    it('P18.10-T5 AC-7 a code taken and an archived type answer 400 VALIDATION_FAILED, the words Indonesian', async () => {
      await request(app.getHttpServer()).post(url).send(anEvent()).expect(201);
      const taken = await post(anEvent()).expect(400);
      expect(taken.body.error).toEqual({
        code: 'VALIDATION_FAILED', message: 'KPM ini sudah memiliki event dengan kode KICKOFF.', requestId: expect.any(String),
      });
      // The same refusal, in English, word for word as before.
      expect((await request(app.getHttpServer()).post(url).send(anEvent()).expect(400)).body.error.message)
        .toBe('This office already has an event with the code KICKOFF.');

      const types = (await request(app.getHttpServer()).get(`${url}/types`).expect(200)).body as { id: string; code: string }[];
      await request(app.getHttpServer()).post(`${url}/types/${types.find((t) => t.code === 'TRAINING')!.id}/archive`).send({})
        .expect(201);
      expect((await post(anEvent({ code: 'SECOND' })).expect(400)).body.error.message)
        .toBe('TRAINING diarsipkan, jadi tidak ada event baru yang dapat dicatat dengan jenis ini. Pulihkan dulu.');
      expect((await post(anEvent({ code: 'THIRD', typeCode: 'NO_SUCH_TYPE' })).expect(400)).body.error.message)
        .toBe('NO_SUCH_TYPE bukan jenis event di KPM ini.');
      const typeTaken = await request(app.getHttpServer()).post(`${url}/types`).set(...IN_INDONESIAN)
        .send({ code: 'TRAINING', label: 'Training again' }).expect(400);
      expect(typeTaken.body.error.message).toBe('KPM ini sudah memiliki jenis event dengan kode TRAINING.');
    });

    it('P18.10-T5 AC-7 a malformed event: every field sentence in Indonesian, joined as in English', async () => {
      const res = await post(anEvent({
        endsAt: '2026-10-01T01:00:00Z', locationUrl: 'javascript:alert(1)', audience: { issuer: 'x', scope: 'all_agents' },
      })).expect(400);
      const violations = [
        'locationUrl harus berupa alamat web yang diawali http:// atau https://.',
        'endsAt harus setelah startsAt.',
        `audience.issuer harus salah satu dari: ${EVENT_ISSUERS.join(', ')}.`,
      ];
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: violations.join('; '), details: { violations } });
      const select = await post(anEvent({ audience: { issuer: 'kpm', scope: 'select_agents', inviteeMembershipIds: [] } }))
        .expect(400);
      expect(select.body.error.message)
        .toBe('Audiens "select" memerlukan paling sedikit satu orang. Pilih semua orang jika itu yang Anda maksud.');
      const color = await request(app.getHttpServer()).post(`${url}/types`).set(...IN_INDONESIAN)
        .send({ code: 'CLINIC', label: 'Clinic', color: 'blue' }).expect(400);
      expect(color.body.error.details.violations).toEqual(['color harus berupa nilai hex, misalnya #2D9CDB.']);
    });
  });
});
