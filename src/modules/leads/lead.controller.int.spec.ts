import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import {
  AGENT, declaredPermissions, EVERY_MEMBER, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth,
  SUPER_ADMIN,
} from '../../../test/http-permissions';
import { LeadController } from './lead.controller';
import { LeadService } from './lead.service';

const NOW = new Date('2026-09-25T02:00:00Z');
const COMPANY = '66f0000000000000000000c1';

/** Every route, and the permission it must declare. */
const ROUTES: Record<string, string> = {
  list: 'lead:read',
  read: 'lead:read',
  create: 'lead:create',
  update: 'lead:update',
  setStatus: 'lead:update',
  setOutcome: 'lead:mark_outcome',
  remove: 'lead:delete',
};

/**
 * Leads over HTTP (P7-T2, P7-T3).
 *
 * `lead.tenancy.spec.ts` proves the rules by calling the service. What only a request can answer
 * lives here: the decorators, and **the pipe**.
 *
 * The pipe is the reason this file exists at all. Three event and campaign DTOs shipped unable to
 * accept the fields they documented, because a property with no validation decorator is stripped
 * by `forbidNonWhitelisted` before a service sees it — green service tests, a dead API. A lead's
 * rules need the stored row beside the patch, so they cannot live in decorators; `@Allow()` is
 * what keeps the body intact, and nothing but a request proves it.
 */
describe('leads over HTTP (P7-T2, P7-T3)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  const url = '/leads';

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);

    const moduleRef = await Test.createTestingModule({
      controllers: [LeadController],
      providers: [{ provide: LeadService, useValue: wired.leadRecords }],
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
    session.current = AGENT;
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create({
      _id: FIXTURE_KPM, companyId: COMPANY, code: '0417', branchName: 'A',
      timezone: 'Asia/Jakarta',
    });
    await provisionOffice(wired, FIXTURE_KPM, COMPANY);
  });

  const http = () => request(app.getHttpServer());
  const add = (body: Record<string, unknown> = {}) =>
    http().post(url).send({ name: 'Pak Budi', ...body });

  it('declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(LeadController)).toEqual(ROUTES);
  });

  describe('the body survives the pipe', () => {
    it('takes every field the DTO documents, not a stripped subset', async () => {
      // The Phase 5 defect, in one assertion: a decorator-free property never reaches the
      // service, so a green service suite says nothing about what the API accepts.
      const res = await add({
        type: 'sales',
        contact: { phone: '0812-3456-7890' },
        lawfulBasis: 'consent',
        remarks: 'Hot button: the eldest starts university.',
        nextActionDate: '2026-10-02',
        nextActionNote: 'Coffee at 10:00.',
        source: 'Referral',
        thisMonth: true,
      }).expect(201);

      expect(res.body).toMatchObject({
        type: 'sales',
        contact: { phone: '0812-3456-7890', email: null },
        lawfulBasis: 'consent',
        nextActionDate: '2026-10-02',
        thisMonth: true,
        version: 1,
        statusCode: null,
      });
    });

    it('refuses a field nobody defined, rather than dropping it', async () => {
      const res = await add({ statusCode: 'FOLLOW_UP' }).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/statusCode/);
    });
  });

  describe('the lawful basis, over the wire', () => {
    it('refuses contact details with no ground, with a code a client can branch on', async () => {
      const res = await add({ contact: { phone: '0812' } }).expect(422);
      expect(res.body.error.code).toBe('LEAD_CONSENT_REQUIRED');
      expect(res.body.error.details.allowed).toContain('consent');
    });

    it('takes a lead with a name alone', async () => {
      const res = await add().expect(201);
      expect(res.body).toMatchObject({ lawfulBasis: null, flags: expect.any(Array) });
    });
  });

  describe('moving and closing are separate acts, on separate routes', () => {
    const staged = async (code: string) => {
      const { body } = await add({ type: 'sales' }).expect(201);
      await http().patch(`${url}/${body.id}/status`).send({ statusCode: code }).expect(200);
      return body.id as string;
    };

    it('jumps to the last stage in one request', async () => {
      const id = await staged('PAID_AND_ISSUED');
      const res = await http().get(`${url}/${id}`).expect(200);
      expect(res.body.statusCode).toBe('PAID_AND_ISSUED');
    });

    it('refuses the other ladder’s stage with its own code', async () => {
      const { body } = await add({ type: 'sales' }).expect(201);
      const res = await http().patch(`${url}/${body.id}/status`)
        .send({ statusCode: 'AAJI_LICENSED' }).expect(422);
      expect(res.body.error.code).toBe('LEAD_STATUS_WRONG_PIPELINE');
    });

    it('refuses won below the closing stage, and takes it at the stage', async () => {
      const early = await staged('FOLLOW_UP');
      const refused = await http().patch(`${url}/${early}/outcome`)
        .send({ outcome: 'won' }).expect(422);
      expect(refused.body.error.code).toBe('LEAD_STATUS_NOT_FINAL');

      const done = await staged('PAID_AND_ISSUED');
      await http().patch(`${url}/${done}/outcome`).send({ outcome: 'won' }).expect(200);
    });

    it('refuses a second outcome, and reopens on null', async () => {
      const id = await staged('FOLLOW_UP');
      await http().patch(`${url}/${id}/outcome`).send({ outcome: 'lost' }).expect(200);

      const again = await http().patch(`${url}/${id}/outcome`)
        .send({ outcome: 'won' }).expect(409);
      expect(again.body.error.code).toBe('LEAD_ALREADY_CLOSED');

      const reopened = await http().patch(`${url}/${id}/outcome`)
        .send({ outcome: null }).expect(200);
      expect(reopened.body).toMatchObject({ outcome: null, statusCode: 'FOLLOW_UP' });
    });
  });

  describe('editing and removing, over the wire', () => {
    it('patches one field and leaves the rest alone', async () => {
      const { body } = await add({ remarks: 'Golf on Sundays.' }).expect(201);

      const patched = await http().patch(`${url}/${body.id}`)
        .send({ nextActionNote: 'Ring on Tuesday.' }).expect(200);

      expect(patched.body).toMatchObject({
        remarks: 'Golf on Sundays.', nextActionNote: 'Ring on Tuesday.', version: 2,
      });
    });

    it('refuses clearing the ground from a lead that still holds details', async () => {
      // The two-step version of adding a number with no basis. Checked against the lead as it
      // will be, not as the patch arrived.
      const { body } = await add({ contact: { phone: '0812' }, lawfulBasis: 'consent' })
        .expect(201);

      const res = await http().patch(`${url}/${body.id}`)
        .send({ lawfulBasis: null }).expect(422);
      expect(res.body.error.code).toBe('LEAD_CONSENT_REQUIRED');
    });

    it('removes softly, and the lead leaves the list without leaving the database', async () => {
      const { body } = await add().expect(201);

      const removed = await http().delete(`${url}/${body.id}`).expect(200);
      expect(removed.body).toMatchObject({ id: body.id, deletedAt: expect.any(String) });

      expect((await http().get(url).expect(200)).body.rows).toEqual([]);
      await http().get(`${url}/${body.id}`).expect(404);
    });
  });

  describe('the list the screen reads', () => {
    it('searches, filters and pages from the query string', async () => {
      await add({ name: 'Ibu Dewi', type: 'sales', remarks: 'Golf.' }).expect(201);
      await add({ name: 'Sdri. Maya', type: 'recruitment' }).expect(201);

      const searched = await http().get(url).query({ search: 'golf' }).expect(200);
      expect(searched.body.rows.map((l: { name: string }) => l.name)).toEqual(['Ibu Dewi']);

      const paged = await http().get(url).query({ pageSize: 1, page: 1 }).expect(200);
      expect(paged.body).toMatchObject({ total: 2, page: 1, pageSize: 1 });
      expect(paged.body.rows).toHaveLength(1);
    });
  });

  describe('who may do what', () => {
    it.each(EVERY_MEMBER)('lets %s keep their own leads', async (_name, who) => {
      session.current = who;
      await add().expect(201);
      await http().get(url).expect(200);
    });

    it('refuses an Owner the delete, which is the agent’s alone', async () => {
      // §3.7: not the coach, not the admin. Soft, with a retention window.
      const { body } = await add().expect(201);
      session.current = OWNER;
      await http().delete(`${url}/${body.id}`).expect(403);
    });

    it('refuses a Super Admin by name rather than by a 500', async () => {
      /*
       * §3.7 grants Super Admin `all`, and ADR-0044 records why that is not access: the routes
       * resolve `kpmId` from the caller's membership, which they have none of. The guard passes
       * and the service refuses — cleanly. `org_tree:read` once answered 500 INTERNAL_ERROR here,
       * which is the failure this asserts against.
       */
      session.current = SUPER_ADMIN;
      const res = await http().get(url).expect(403);
      expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });
  });

  it('is 404, never 403, for another office’s lead', async () => {
    await http().get(`${url}/66f00000000000000000ffff`).expect(404);
  });
});
