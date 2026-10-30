import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import {
  AGENT, declaredPermissions, EVERY_MEMBER, FIXTURE_KPM, productionPipe, session, StubAuth,
  SUPER_ADMIN,
} from '../../../test/http-permissions';
import { LeadController } from './lead.controller';
import { LeadService } from './lead.service';
import { listenOnLoopback } from '../../../test/listen';

const NOW = new Date('2026-09-25T02:00:00Z');
const COMPANY = '66f0000000000000000000c1';

/** Every route, and the permission it must declare. */
const ROUTES: Record<string, string> = {
  list: 'lead:read',
  read: 'lead:read',
  create: 'lead:create',
  // P18.8-T7: the owner's own order. `lead-order.int.spec.ts` asks whose list it writes.
  reorder: 'lead:update',
  // UI V1 (UI-104): the owner's tick on a next action, from Calendar.
  setNextActionDone: 'lead:update',
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
    await listenOnLoopback(app);
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
        remarks: 'Hot button: the eldest starts university.',
        nextActionDate: '2026-10-02',
        nextActionNote: 'Coffee at 10:00.',
        source: 'Referral',
        thisMonth: true,
      }).expect(201);

      expect(res.body).toMatchObject({
        type: 'sales',
        contact: { phone: '0812-3456-7890', email: null },
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

  describe('P13.1-T4 AC-1 — no lawful basis, over the wire (ADR-0108 §1)', () => {
    it('P13.1-T4 AC-1 creates a lead with a phone and an email and no ground', async () => {
      const res = await add({ contact: { phone: '0812', email: 'budi@example.com' } }).expect(201);
      expect(res.body.contact).toEqual({ phone: '0812', email: 'budi@example.com' });
    });

    it('P13.1-T4 AC-1 answers with neither lawfulBasis nor consentAt', async () => {
      const res = await add().expect(201);
      expect(res.body).toMatchObject({ flags: expect.any(Array) });
      expect(res.body).not.toHaveProperty('lawfulBasis');
      expect(res.body).not.toHaveProperty('consentAt');
      const read = await http().get(`${url}/${res.body.id}`).expect(200);
      expect(read.body).not.toHaveProperty('lawfulBasis');
      const list = await http().get(url).expect(200);
      expect(list.body.rows[0]).not.toHaveProperty('consentAt');
    });

    it('P13.1-T4 AC-1 refuses lawfulBasis on a create or a patch as a field nobody defined', async () => {
      const created = await add({ lawfulBasis: 'consent' }).expect(400);
      expect(created.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(created.body)).toMatch(/lawfulBasis/);

      const { body } = await add().expect(201);
      const patched = await http().patch(`${url}/${body.id}`).send({ lawfulBasis: null }).expect(400);
      expect(patched.body.error.code).toBe('VALIDATION_FAILED');
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

    it('UI-105 answers one lead with its moves, oldest first, and the list without them', async () => {
      const id = await staged('FOLLOW_UP');
      await http().patch(`${url}/${id}/status`).send({ statusCode: 'POLICY_SUBMITTED' }).expect(200);
      // A reopen moves nothing, so it adds nothing to the history.
      await http().patch(`${url}/${id}/outcome`).send({ outcome: 'lost' }).expect(200);
      await http().patch(`${url}/${id}/outcome`).send({ outcome: null }).expect(200);

      const one = await http().get(`${url}/${id}`).expect(200);
      expect(one.body.history).toEqual([
        { at: NOW.toISOString(), fromStatusCode: null, toStatusCode: 'FOLLOW_UP' },
        { at: NOW.toISOString(), fromStatusCode: 'FOLLOW_UP', toStatusCode: 'POLICY_SUBMITTED' },
      ]);
      const list = await http().get(url).expect(200);
      expect(list.body.rows[0]).not.toHaveProperty('history');
    });

    it('UI-105 answers a lead that has never moved with an empty history', async () => {
      const { body } = await add({ type: 'sales' }).expect(201);
      const one = await http().get(`${url}/${body.id}`).expect(200);
      expect(one.body.history).toEqual([]);
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

  /*
   * **The same refusals in Indonesian** (P18.98-T5 AC-7): the words follow the request's `Accept-Language`; the
   * code, the status and every detail that is no sentence are the same in both. A field is named as the API names it.
   */
  describe('P18.98-T5 AC-7 in Indonesian', () => {
    const inIndonesian = () => request(app.getHttpServer());

    it('P18.98-T5 AC-7 refuses a lead field by field, every violation in Indonesian, joined as the message', async () => {
      const res = await inIndonesian().post(url).set('Accept-Language', 'id')
        .send({ name: 'B', thisMonth: 'yes', contact: { email: 'nope', whatsapp: '0812' } }).expect(400);

      const violations = [
        'name harus 2–120 karakter.',
        'thisMonth harus true atau false.',
        'properti contact.whatsapp tidak dikenal',
        'contact.email harus berupa alamat email.',
      ];
      expect(res.body.error).toEqual({
        code: 'VALIDATION_FAILED', message: violations.join('; '), details: { violations }, requestId: expect.any(String),
      });

      // The same request in English reads as it always has.
      const english = await http().post(url)
        .send({ name: 'B', thisMonth: 'yes', contact: { email: 'nope', whatsapp: '0812' } }).expect(400);
      expect(english.body.error.details.violations).toEqual([
        'name must be 2–120 characters.',
        'thisMonth must be true or false.',
        'property contact.whatsapp should not exist',
        'contact.email must be an email address.',
      ]);
    });

    it('P18.98-T5 AC-7 refuses a second outcome, and the other ladder’s stage, in Indonesian', async () => {
      const { body } = await add({ type: 'sales' }).expect(201);
      await http().patch(`${url}/${body.id}/status`).send({ statusCode: 'FOLLOW_UP' }).expect(200);
      await http().patch(`${url}/${body.id}/outcome`).send({ outcome: 'lost' }).expect(200);

      const again = await inIndonesian().patch(`${url}/${body.id}/outcome`).set('Accept-Language', 'id')
        .send({ outcome: 'won' }).expect(409);
      expect(again.body.error).toMatchObject({
        code: 'LEAD_ALREADY_CLOSED',
        message: 'Lead ini sudah ditandai tidak berhasil. Buka kembali sebelum menutupnya lagi.',
        details: { outcome: 'lost' },
      });

      // Won, the other outcome, in both languages.
      const { body: won } = await add({ type: 'sales' }).expect(201);
      await http().patch(`${url}/${won.id}/status`).send({ statusCode: 'PAID_AND_ISSUED' }).expect(200);
      await http().patch(`${url}/${won.id}/outcome`).send({ outcome: 'won' }).expect(200);
      const wonAgain = await inIndonesian().patch(`${url}/${won.id}/outcome`).set('Accept-Language', 'id')
        .send({ outcome: 'lost' }).expect(409);
      expect(wonAgain.body.error.message).toBe('Lead ini sudah ditandai berhasil. Buka kembali sebelum menutupnya lagi.');
      expect((await http().patch(`${url}/${won.id}/outcome`).send({ outcome: 'lost' }).expect(409)).body.error.message)
        .toBe('This lead is already won. Reopen it before closing it again.');

      const { body: fresh } = await add({ type: 'sales' }).expect(201);
      const wrong = await inIndonesian().patch(`${url}/${fresh.id}/status`).set('Accept-Language', 'id')
        .send({ statusCode: 'AAJI_LICENSED' }).expect(422);
      expect(wrong.body.error).toMatchObject({
        code: 'LEAD_STATUS_WRONG_PIPELINE',
        message: 'AAJI_LICENSED termasuk pipeline recruitment; ini lead sales.',
        details: { code: 'AAJI_LICENSED', pipeline: 'recruitment', leadType: 'sales' },
      });
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

    it('P13.1-T4 AC-1 adds a phone number to a lead that has none, with no ground', async () => {
      const { body } = await add().expect(201);

      const res = await http().patch(`${url}/${body.id}`)
        .send({ contact: { phone: '0812-1100-2200', email: null } }).expect(200);
      expect(res.body).toMatchObject({ contact: { phone: '0812-1100-2200', email: null }, version: 2 });
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

    it('P10.1-T4 AC-3: takes the Type and Status sorts through the pipe', async () => {
      // The decorator is `@IsIn` now, so the list it names is the whole vocabulary over the wire —
      // a key left out of it would be a 400 on a header the screen offers.
      await add({ name: 'Sdri. Maya', type: 'recruitment' }).expect(201);
      await add({ name: 'Ibu Dewi', type: 'sales' }).expect(201);
      await add({ name: 'Pak Budi' }).expect(201);

      const byType = await http().get(url).query({ sort: 'type', dir: 'asc' }).expect(200);
      expect(byType.body.rows.map((l: { name: string }) => l.name))
        .toEqual(['Pak Budi', 'Ibu Dewi', 'Sdri. Maya']);

      for (const sort of ['status', 'name', 'dateRegistered', 'nextActionDate']) {
        await http().get(url).query({ sort, dir: 'desc' }).expect(200);
      }
    });

    it('P10.1-T4: refuses a sort key it does not have, rather than answering in some order', async () => {
      // With `@Allow()` this reached the database as a sort on a field no lead has, and answered
      // 200. That looks like a sort that works.
      const res = await http().get(url).query({ sort: 'nextAction' }).expect(400);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.error.details)).toMatch(/sort/);
    });

    describe('2026-10-01: every query field is validated as what it is, so an operator cannot ride in', () => {
      /*
       * Express parses `?search[$ne]=x` into `{ search: { $ne: 'x' } }`, and `@Allow()` passed it
       * through: `search` reached `.trim()` and answered 500, and `statusCode` would have reached
       * the database as an operator on the field (the Phase 10.1 exit review). Neither leaves the
       * caller's scope — the owner filter is the service's — so this is a wrong answer rather than
       * a leak, and the fix is the decorator every other query DTO already carries.
       */
      const refused = async (query: string, field: string) => {
        const res = await http().get(url).query(query).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(JSON.stringify(res.body.error.details)).toMatch(new RegExp(field));
      };

      it('refuses an object where `search` is a string, rather than crashing on it', () =>
        refused('search[$ne]=x', 'search'));

      it('refuses an object where `statusCode` is a string, rather than handing it to the database', () =>
        refused('statusCode[$ne]=x', 'statusCode'));

      it.each([
        ['type', 'type[$ne]=x'],
        ['outcome', 'outcome[$ne]=x'],
        ['attention', 'attention[$ne]=x'],
        ['dir', 'dir[$ne]=x'],
        ['page', 'page[$ne]=1'],
        ['pageSize', 'pageSize[$ne]=1'],
      ])('refuses an object in `%s` the same way', (field, query) => refused(query, field));

      it.each([
        ['type', 'type=wholesale'],
        ['outcome', 'outcome=maybe'],
        ['attention', 'attention=urgent'],
        ['dir', 'dir=sideways'],
        ['page', 'page=0'],
        ['pageSize', 'pageSize=many'],
      ])('refuses a value outside `%s`’s vocabulary', (field, query) => refused(query, field));

      it('takes every field in its own shape, and answers the page with real numbers', async () => {
        const { body } = await add({ name: 'Ibu Dewi', type: 'sales', remarks: 'Golf.' }).expect(201);
        await http().patch(`${url}/${body.id}/status`).send({ statusCode: 'FOLLOW_UP' }).expect(200);
        await add({ name: 'Sdri. Maya', type: 'recruitment' }).expect(201);

        const res = await http().get(url).query({
          search: 'golf', type: 'sales', statusCode: 'FOLLOW_UP', outcome: 'open',
          attention: 'no-next-action', sort: 'name', dir: 'asc', page: 1, pageSize: 50,
        }).expect(200);

        // `page` and `pageSize` arrive as the strings "1" and "50" and are answered as numbers:
        // the conversion is the DTO's, not a coincidence of `Math.max`.
        expect(res.body).toEqual(expect.objectContaining({ total: 1, page: 1, pageSize: 50 }));
        expect(res.body.rows.map((l: { name: string }) => l.name)).toEqual(['Ibu Dewi']);
      });
    });
  });

  it('P10.1-T4 AC-13: GET /leads/summary is retired, and reads as a lead that does not exist', async () => {
    // Its only caller was the counts strip on `/leads`. Nothing is declared above `:id` now, so
    // the word *summary* is read as an id — the 404 the controller's route note describes.
    const res = await http().get(`${url}/summary`).expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body).not.toHaveProperty('open');
  });

  describe('who may do what', () => {
    it.each(EVERY_MEMBER)('lets %s keep their own leads', async (_name, who) => {
      session.current = who;
      await add().expect(201);
      await http().get(url).expect(200);
    });

    it('lets every rung that carries leads delete one of their own (P7-T7)', async () => {
      /*
       * This asserted a **403 for the Owner**, and passed for the wrong reason: `lead:delete` was
       * granted to `AGENT` and to nobody else, so an AB and an AAB could not delete their own
       * leads either. §3.7's *"soft, and the agent's alone"* meant the **owner's** alone, and what
       * refuses a coach is the `own` scope rather than a missing grant.
       *
       * **Whose lead is whose cannot be asked here.** Every fixture in `http-permissions.ts` is
       * `mem-a` wearing a different rung — one person, six hats — which is right for asking what a
       * *decorator* refuses and useless for asking what an *owner* does. That is
       * `lead-access.tenancy.spec.ts`, where five real memberships stand in a real hierarchy.
       */
      for (const [, who] of EVERY_MEMBER) {
        session.current = who;
        const { body } = await add().expect(201);
        await http().delete(`${url}/${body.id}`).expect(200);
      }
    });

    it('pins a version, and refuses a write the record has moved past', async () => {
      const { body } = await add().expect(201);
      await http().patch(`${url}/${body.id}`).send({ remarks: 'First.' }).expect(200);

      const stale = await http().patch(`${url}/${body.id}`)
        .send({ remarks: 'Second.', version: body.version }).expect(409);

      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
      expect((await http().get(`${url}/${body.id}`).expect(200)).body.remarks).toBe('First.');
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
