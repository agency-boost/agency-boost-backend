import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  buildCoachingOffice, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { LeadController } from './lead.controller';
import type { LeadRepository } from './lead.repository';
import { LeadService } from './lead.service';

/**
 * **The coaching session's Leads card, over HTTP, per role** (P11-T4 AC-3, AC-5, AC-9;
 * `functional/coaching.md`, *The Leads card* and the Data contract).
 *
 * `GET /leads?owner=`, the three writes with the version a leader must now pin, and `POST /leads?owner=`
 * — through the real `PermissionsGuard`, the production pipe and the real service over
 * `test/coaching-office.ts`'s office: who is answered, who is not found, what is refused before anything
 * is written, whose name each write carries, and the one §3.5 entry a coachee's list writes.
 */
describe('P11-T4 — a coachee’s leads, over HTTP', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;

  const as = (who: Who) => { session.current = office.as(who); };
  const http = () => request(app.getHttpServer());
  const db = () => mongoose.connection.db!;
  const reads = () => db().collection('auditLog')
    .find({ action: SUBJECT_READ_ACTION, 'after.surface': 'leads' }).sort({ createdAt: 1, _id: 1 }).toArray();
  /** A lead of `who`'s own, created as them, with a stage so it can be moved and closed. */
  const leadOf = async (who: Who, name = 'Pak Budi', over: Record<string, unknown> = {}) =>
    wired.leadRecords.create(office.as(who), { name, type: 'sales', ...over });
  const stored = async (id: string) => db().collection('leads').findOne({ _id: new mongoose.Types.ObjectId(id) });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);

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
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await db().collection('leads').deleteMany({});
    await db().collection('auditLog').deleteMany({});
  });

  describe('GET /leads?owner= (AC-3)', () => {
    it('P11-T4 AC-3 answers an AB one nested coachee’s leads — theirs alone, not the rest of the downline', async () => {
      await leadOf('RINA', 'Rina’s first');
      await leadOf('RINA', 'Rina’s second');
      await leadOf('BUDI', 'Budi’s');
      await leadOf('AGUS', 'Agus’s own');

      as('AGUS');
      const res = await http().get('/leads').query({ owner: office.id.RINA }).expect(200);

      expect(res.body.total).toBe(2);
      expect(res.body.rows.map((r: { name: string }) => r.name).sort()).toEqual(['Rina’s first', 'Rina’s second']);
      expect(res.body.rows.every((r: { ownerMembershipId: string }) => r.ownerMembershipId === office.id.RINA)).toBe(true);
    });

    it('P11-T4 AC-3 takes the card’s search and type filter beside it', async () => {
      await leadOf('RINA', 'Ibu Wati', { remarks: 'Hobi golf' });
      await leadOf('RINA', 'Pak Joko', { type: 'recruitment' });
      await leadOf('RINA', 'Pak Wawan');

      as('SARI');
      const searched = await http().get('/leads').query({ owner: office.id.RINA, search: 'golf' }).expect(200);
      expect(searched.body.rows.map((r: { name: string }) => r.name)).toEqual(['Ibu Wati']);
      const typed = await http().get('/leads').query({ owner: office.id.RINA, type: 'recruitment' }).expect(200);
      expect(typed.body.rows.map((r: { name: string }) => r.name)).toEqual(['Pak Joko']);
    });

    it('P11-T4 AC-5 writes one `leads` entry per read, from no date to today — an empty answer included', async () => {
      await leadOf('RINA');

      as('AGUS');
      await http().get('/leads').query({ owner: office.id.RINA }).expect(200);
      const none = await http().get('/leads').query({ owner: office.id.RINA, search: 'nobody by this name' }).expect(200);
      expect(none.body.total).toBe(0);

      const written = await reads();
      expect(written).toHaveLength(2);
      for (const entry of written) {
        expect(entry).toMatchObject({
          actorMembershipId: office.id.AGUS,
          targetMembershipId: office.id.RINA,
          after: { surface: 'leads', from: null, to: ROSTER_TODAY },
        });
      }
    });

    it('P11-T4 AC-5 naming yourself is your own list — your leads alone, and no entry', async () => {
      await leadOf('AGUS', 'Agus’s own');
      await leadOf('INDAH', 'Indah’s');

      as('AGUS');
      const res = await http().get('/leads').query({ owner: office.id.AGUS }).expect(200);

      expect(res.body.rows.map((r: { name: string }) => r.name)).toEqual(['Agus’s own']);
      expect(await reads()).toHaveLength(0);
    });

    it('P11-T4 keeps `lastEditedBy` to a change that was not the owner’s: a leader is not told the agent changed their own lead', async () => {
      const lead = await leadOf('RINA');
      await wired.leadRecords.update(office.as('RINA'), lead.id, { remarks: 'Mine.' });

      as('SARI');
      const res = await http().get('/leads').query({ owner: office.id.RINA }).expect(200);
      expect(res.body.rows[0].lastEditedBy).toBeNull();
    });

    it.each([
      ['a peer AAB, an agent of another unit', 'PEER_AAB', 'RINA'],
      ['an Agent, a colleague', 'INDAH', 'DIMAS'],
      // P19.9-T6 (ADR-0234): an Agent who leads reaches their own report now — below — and nobody else.
      ['an Agent who leads, a colleague outside their downline', 'LUKAS', 'INDAH'],
      ['an Agent who leads, their own leader', 'LUKAS', 'AGUS'],
      ['the Admin, who leads nobody: `lead:read` reaches no row of anybody else (§3.7)', 'ADMIN', 'RINA'],
      ['an AB, a member who has left', 'AGUS', 'LEFT'],
      ['office B’s AB, a member of office A (cross-tenant)', 'B_AB', 'RINA'],
    ] as [string, Who, Who][])('P11-T4 AC-3 is 404 for %s, and writes nothing', async (_name, reader, owner) => {
      await leadOf('RINA');
      as(reader);
      const res = await http().get('/leads').query({ owner: office.id[owner] }).expect(404);

      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(await reads()).toHaveLength(0);
    });

    it('P19.9-T6 AC-2 an Agent who leads reads their report’s leads, as an AB does, and the read is recorded', async () => {
      await leadOf('TARI', 'Tari’s');
      await leadOf('INDAH', 'Indah’s');
      as('LUKAS');
      const res = await http().get('/leads').query({ owner: office.id.TARI }).expect(200);

      expect(res.body.rows.map((r: { name: string }) => r.name)).toEqual(['Tari’s']);
      expect(await reads()).toEqual([expect.objectContaining({
        actorMembershipId: office.id.LUKAS, targetMembershipId: office.id.TARI,
      })]);
    });

    it('P11-T4 refuses a Super Admin by name, not by a 500', async () => {
      session.current = SUPER_ADMIN;
      const res = await http().get('/leads').query({ owner: office.id.RINA }).expect(403);
      expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('P11-T4 validates `owner` as a string of at most 64 characters', async () => {
      as('AGUS');
      expect((await http().get('/leads').query({ owner: 'x'.repeat(65) }).expect(400)).body.error.code)
        .toBe('VALIDATION_FAILED');
      await http().get('/leads?owner[$ne]=x').expect(400);
      expect(await reads()).toHaveLength(0);
    });
  });

  /*
   * Phase 11 exit review, N2: a lead opened by its id is the owner's data as much as their list is, so a
   * leader's read of one writes the §3.5 entry `GET /leads?owner=` writes.
   */
  describe('N2 GET /leads/:id of a lead the reader does not own', () => {
    it('N2 writes one `leads` entry, the owner as the subject, from no date to today, after the read', async () => {
      const lead = await leadOf('RINA');

      for (const who of ['SARI', 'AGUS'] as Who[]) {
        as(who);
        expect((await http().get(`/leads/${lead.id}`).expect(200)).body.id).toBe(lead.id);
      }

      expect((await reads()).map((e) => [e.actorMembershipId, e.targetMembershipId, e.targetCollection, e.after])).toEqual([
        [office.id.SARI, office.id.RINA, 'memberships', { surface: 'leads', from: null, to: ROSTER_TODAY }],
        [office.id.AGUS, office.id.RINA, 'memberships', { surface: 'leads', from: null, to: ROSTER_TODAY }],
      ]);
    });

    it('N2 the owner’s own read writes none', async () => {
      const lead = await leadOf('RINA');
      as('RINA');
      await http().get(`/leads/${lead.id}`).expect(200);
      expect(await reads()).toHaveLength(0);
    });

    it('N2 a refused read writes none: a lead the reader may not reach is 404, and nothing is recorded', async () => {
      const lead = await leadOf('RINA');
      await db().collection('auditLog').deleteMany({});
      for (const who of ['PEER_AAB', 'DIMAS', 'ADMIN', 'B_AB'] as Who[]) {
        as(who);
        expect([who, (await http().get(`/leads/${lead.id}`)).status]).toEqual([who, 404]);
      }
      expect(await db().collection('auditLog').countDocuments({})).toBe(0);
    });
  });

  describe('a leader’s write pins the version it read (AC-3)', () => {
    const writes = (id: string) => [
      ['PATCH /leads/:id', () => http().patch(`/leads/${id}`), { remarks: 'Coached.' }],
      ['PATCH /leads/:id/status', () => http().patch(`/leads/${id}/status`), { statusCode: 'FOLLOW_UP' }],
      ['PATCH /leads/:id/outcome', () => http().patch(`/leads/${id}/outcome`), { outcome: 'lost' }],
    ] as const;

    it('P11-T4 AC-3 refuses a leader’s unpinned write on each route — 400, and nothing is written', async () => {
      const lead = await leadOf('RINA');
      as('AGUS');

      for (const [route, call, body] of writes(lead.id)) {
        const res = await call().send(body).expect(400);
        expect({ route, code: res.body.error.code }).toEqual({ route, code: 'VALIDATION_FAILED' });
        expect(res.body.error.details.violations).toEqual(['version is required when the lead is not yours']);
      }
      expect(await stored(lead.id)).toMatchObject({ version: lead.version, remarks: null, statusCode: null, outcome: null });
    });

    it('P11-T4 AC-3 refuses a stale pin on each route — 409 VERSION_CONFLICT', async () => {
      const lead = await leadOf('RINA');
      await wired.leadRecords.update(office.as('RINA'), lead.id, { remarks: 'Moved on.' });
      as('AGUS');

      for (const [route, call, body] of writes(lead.id)) {
        const res = await call().send({ ...body, version: lead.version }).expect(409);
        expect({ route, code: res.body.error.code }).toEqual({ route, code: 'VERSION_CONFLICT' });
      }
    });

    it('P11-T4 AC-3 refuses a version that is not a whole number, before anything else', async () => {
      const lead = await leadOf('RINA');
      as('AGUS');
      await http().patch(`/leads/${lead.id}/status`).send({ statusCode: 'FOLLOW_UP', version: '1' }).expect(400);
      await http().patch(`/leads/${lead.id}/outcome`).send({ outcome: 'lost', version: 0 }).expect(400);
    });

    it('P11-T4 AC-3 takes a pinned write and attributes it to the leader (ADR-0044)', async () => {
      const lead = await leadOf('RINA');
      as('AGUS');

      const moved = await http().patch(`/leads/${lead.id}/status`)
        .send({ statusCode: 'FOLLOW_UP', version: lead.version }).expect(200);
      const edited = await http().patch(`/leads/${lead.id}`)
        .send({ remarks: 'Coached.', version: moved.body.version }).expect(200);

      expect(edited.body).toMatchObject({ remarks: 'Coached.', lastEditedBy: { membershipId: office.id.AGUS, name: 'Agus Salim' } });
      expect((await stored(lead.id))!.transitions[0]).toMatchObject({ toStatusCode: 'FOLLOW_UP', byMembershipId: office.id.AGUS });
      // On the owner's own screen, the ✎ names who moved it.
      expect((await wired.leadRecords.read(office.as('RINA'), lead.id)).lastEditedBy)
        .toEqual({ membershipId: office.id.AGUS, name: 'Agus Salim' });
    });

    it('P11-T4 AC-3 keeps the pin optional for the owner, as P7-T7 built it', async () => {
      const lead = await leadOf('RINA');
      as('RINA');

      for (const [, call, body] of writes(lead.id)) await call().send(body).expect(200);
      expect(await stored(lead.id)).toMatchObject({ remarks: 'Coached.', statusCode: 'FOLLOW_UP', outcome: 'lost' });
    });

    it('P11-T4 AC-9 answers another office’s lead with 404 on /status and /outcome, pinned or not', async () => {
      const lead = await leadOf('RINA');
      as('B_AB');

      for (const body of [{ statusCode: 'FOLLOW_UP' }, { statusCode: 'FOLLOW_UP', version: lead.version }]) {
        const res = await http().patch(`/leads/${lead.id}/status`).send(body).expect(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      for (const body of [{ outcome: 'lost' }, { outcome: 'lost', version: lead.version }]) {
        const res = await http().patch(`/leads/${lead.id}/outcome`).send(body).expect(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      expect(await stored(lead.id)).toMatchObject({ version: lead.version, statusCode: null, outcome: null });
    });

    it('P11-T4 AC-3 answers a peer AAB’s pinned write with 404 — reach comes before the version', async () => {
      const lead = await leadOf('RINA');
      as('PEER_AAB');

      for (const [, call, body] of writes(lead.id)) {
        await call().send({ ...body, version: lead.version + 5 }).expect(404);
      }
    });

    /*
     * **S3 (the T17–T20 permission review): clearing a next action is an edit under `lead:update`.** The calendar's
     * *Hapus tugas* sends exactly this body on the reader's own lead; a coach clears a coachee's by editing it on the
     * coachee's Leads tab — the reach SR-08 already gives them, pinned like every other leader's write. The tick goes
     * with the task: `update` clears `nextActionDone`, because there is no longer an action to have done.
     */
    describe('S3 clearing a coachee’s next action — Hapus tugas’s body, as a coach’s edit', () => {
      const CLEAR = { nextActionDate: null, nextActionNote: null };
      const withTask = () => leadOf('RINA', 'Pak Budi', { nextActionDate: '2026-09-20', nextActionNote: 'Kirim proposal' });

      it.each([['an AB two levels up', 'AGUS'], ['the AAB they report to', 'SARI']] as const)(
        'S3 lets %s clear it, pinned, and the tick goes with it',
        async (_who, coach) => {
          const lead = await withTask();
          await db().collection('leads').updateOne(
            { _id: new mongoose.Types.ObjectId(lead.id) },
            { $set: { nextActionDone: { date: '2026-09-13', note: 'Telepon', at: new Date(), byMembershipId: office.id.RINA } } },
          );
          as(coach);
          const res = await http().patch(`/leads/${lead.id}`).send({ ...CLEAR, version: lead.version }).expect(200);
          expect(res.body).toMatchObject({ nextActionDate: null, nextActionNote: null, lastEditedBy: { membershipId: office.id[coach] } });
          expect(await stored(lead.id)).toMatchObject({ nextActionDate: null, nextActionNote: null, nextActionDone: null });
        },
      );

      it('S3 answers a peer AAB 404, and the task stays', async () => {
        const lead = await withTask();
        as('PEER_AAB');
        await http().patch(`/leads/${lead.id}`).send({ ...CLEAR, version: lead.version }).expect(404);
        expect(await stored(lead.id)).toMatchObject({ nextActionDate: '2026-09-20', nextActionNote: 'Kirim proposal', version: lead.version });
      });

      it('S3 refuses a coach’s unpinned clear, as every leader’s write is', async () => {
        const lead = await withTask();
        as('SARI');
        await http().patch(`/leads/${lead.id}`).send(CLEAR).expect(400);
        expect(await stored(lead.id)).toMatchObject({ nextActionDate: '2026-09-20' });
      });
    });

    describe('the check and the write are one operation', () => {
      const repository = () => (wired.leadRecords as unknown as { leads: LeadRepository }).leads;

      it('P11-T4 AC-3 refuses a write the lead moved past between its read and its write — 409, and the other change survives', async () => {
        const lead = await leadOf('RINA');
        const read = await repository().findById(office.as('RINA'), lead.id);
        // The agent saves on her phone after the leader's write was checked and before it landed.
        await wired.leadRecords.update(office.as('RINA'), lead.id, { remarks: 'Typed in front of you.' });
        jest.spyOn(repository(), 'findById').mockResolvedValueOnce(read);

        as('AGUS');
        const res = await http().patch(`/leads/${lead.id}`).send({ remarks: 'Coached.', version: lead.version }).expect(409);

        expect(res.body.error).toMatchObject({
          code: 'VERSION_CONFLICT', details: { expectedVersion: lead.version, actualVersion: lead.version + 1 },
        });
        expect((await stored(lead.id))!.remarks).toBe('Typed in front of you.');
      });

      it('P11-T4 answers 404 when the lead is removed between its read and its write', async () => {
        const lead = await leadOf('RINA');
        const read = await repository().findById(office.as('RINA'), lead.id);
        await wired.leadRecords.remove(office.as('RINA'), lead.id);
        jest.spyOn(repository(), 'findById').mockResolvedValueOnce(read);

        as('AGUS');
        await http().patch(`/leads/${lead.id}/outcome`).send({ outcome: 'lost', version: lead.version }).expect(404);
      });
    });
  });

  describe('POST /leads?owner= — *+ Add lead* in the coachee’s pipeline', () => {
    it('P11-T4 creates the lead in the coachee’s pipeline, attributed to the leader, and notifies nobody', async () => {
      const sent = wired.sentNotifications.length;
      as('AGUS');

      const res = await http().post('/leads').query({ owner: office.id.RINA })
        .send({ name: 'Pak Hendra', type: 'sales', thisMonth: true }).expect(201);

      expect(res.body).toMatchObject({
        ownerMembershipId: office.id.RINA, name: 'Pak Hendra', statusCode: null, version: 1, thisMonth: true,
        lastEditedBy: { membershipId: office.id.AGUS, name: 'Agus Salim' },
      });
      const row = await stored(res.body.id);
      expect(row).toMatchObject({ createdBy: office.id.AGUS, updatedBy: office.id.AGUS });
      expect(row!.commitments[0]).toMatchObject({ byMembershipId: office.id.AGUS });
      expect(await db().collection('auditLog').findOne({ action: 'lead.created' })).toMatchObject({
        actorMembershipId: office.id.AGUS, targetId: res.body.id, after: { ownerMembershipId: office.id.RINA },
      });
      expect(wired.sentNotifications.length).toBe(sent);

      // Hers now: on her own list, and the ✎ there names who added it.
      const hers = await wired.leadRecords.list(office.as('RINA'));
      expect(hers.rows.map((r) => [r.name, r.lastEditedBy?.name])).toEqual([['Pak Hendra', 'Agus Salim']]);

      // Its first move, made in the same 1-on-1, is the leader's too.
      await http().patch(`/leads/${res.body.id}/status`).send({ statusCode: 'FOLLOW_UP', version: 1 }).expect(200);
      expect((await stored(res.body.id))!.transitions[0]).toMatchObject({ fromStatusCode: null, byMembershipId: office.id.AGUS });
    });

    it('P11-T4 lets an AAB add to their own agent’s pipeline', async () => {
      as('SARI');
      const res = await http().post('/leads').query({ owner: office.id.RINA }).send({ name: 'Ibu Ratna' }).expect(201);
      expect(res.body.ownerMembershipId).toBe(office.id.RINA);
    });

    /*
     * The staging review of 2026-10-31 (the coachee's Leads tab writes: add and edit, never delete). The route the tab
     * calls, end to end for an AAB in their own unit: the add, then an edit pinned to the version it answered, which the
     * agent reads as the leader's — and no delete.
     */
    it('staging review 2026-10-31: an AAB adds to their own agent’s pipeline, edits it pinned, and the agent reads both; no delete', async () => {
      as('SARI');
      const added = (await http().post('/leads').query({ owner: office.id.RINA })
        .send({ name: 'Ibu Ratna', type: 'sales', nextActionDate: '2026-09-20', nextActionNote: 'Call back' }).expect(201)).body;
      const edited = (await http().patch(`/leads/${added.id}`)
        .send({ remarks: 'Two kids.', nextActionNote: 'Bring the brochure', version: added.version }).expect(200)).body;
      expect(edited).toMatchObject({
        ownerMembershipId: office.id.RINA, remarks: 'Two kids.', nextActionNote: 'Bring the brochure', version: added.version + 1,
        lastEditedBy: { membershipId: office.id.SARI },
      });

      as('RINA');
      expect((await http().get(`/leads/${added.id}`).expect(200)).body)
        .toMatchObject({ remarks: 'Two kids.', lastEditedBy: { membershipId: office.id.SARI } });

      // `lead:delete` is the owner's alone (§3.7): the leader's delete is a 404, and the lead stays.
      as('SARI');
      await http().delete(`/leads/${added.id}`).expect(404);
      expect(await stored(added.id)).toMatchObject({ deletedAt: null });
    });

    it('P19.9-T6 AC-2 an Agent who leads adds to their report’s pipeline and edits it pinned, under their own name (ADR-0234)', async () => {
      as('LUKAS');
      const added = (await http().post('/leads').query({ owner: office.id.TARI }).send({ name: 'Ibu Ratna' }).expect(201)).body;
      const edited = (await http().patch(`/leads/${added.id}`)
        .send({ remarks: 'Coached by Lukas.', version: added.version }).expect(200)).body;

      expect(await stored(added.id)).toMatchObject({
        ownerMembershipId: office.id.TARI, createdBy: office.id.LUKAS, updatedBy: office.id.LUKAS, remarks: 'Coached by Lukas.',
      });
      expect(edited.version).toBe(added.version + 1);
      // Never a delete: `lead:delete` stays the owner's alone (§3.7).
      await http().delete(`/leads/${added.id}`).expect(404);
    });

    it.each([
      ['a peer AAB, an agent of another unit', 'PEER_AAB'],
      ['an Agent, a colleague', 'INDAH'],
      ['an Agent who leads, outside their downline (P19.9-T6)', 'LUKAS'],
      ['office B’s AB (cross-tenant)', 'B_AB'],
    ] as [string, Who][])('staging review 2026-10-31: %s cannot edit a lead an AAB added for their agent — 404, unchanged', async (_name, caller) => {
      as('SARI');
      const added = (await http().post('/leads').query({ owner: office.id.RINA }).send({ name: 'Ibu Ratna' }).expect(201)).body;
      as(caller);
      await http().patch(`/leads/${added.id}`).send({ remarks: 'Not mine.', version: added.version }).expect(404);
      expect(await stored(added.id)).toMatchObject({ remarks: null, version: added.version });
    });

    it.each([
      ['the caller named as owner', 'AGUS', 'AGUS'],
      ['a peer AAB, an agent of another unit', 'PEER_AAB', 'RINA'],
      ['an Agent, a colleague', 'INDAH', 'DIMAS'],
      ['an Agent who leads, a colleague outside their downline (P19.9-T6)', 'LUKAS', 'DIMAS'],
      ['an AB, a member who has left', 'AGUS', 'LEFT'],
      ['office B’s AB, a member of office A (cross-tenant)', 'B_AB', 'RINA'],
    ] as [string, Who, Who][])('P11-T4 is 404 outside COACH: %s — and nothing is created', async (_name, caller, owner) => {
      as(caller);
      const res = await http().post('/leads').query({ owner: office.id[owner] }).send({ name: 'Pak Hendra' }).expect(404);

      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(await db().collection('leads').countDocuments()).toBe(0);
    });

    /*
     * ADR-0076's four negatives, over HTTP (its propagation's P11-T3 line): the resolver proves them on the
     * service, and this proves them on the route a browser calls. A refusal must write **nothing** — no
     * lead, no commitment on one, no `lead.created` entry, no §3.5 entry and no notice — and must read
     * exactly as an id that is nobody's does, so the 404 discloses nothing about who exists.
     */
    describe('ADR-0076: who a create in somebody’s pipeline refuses', () => {
      const written = async () => ({
        leads: await db().collection('leads').countDocuments(),
        auditLog: await db().collection('auditLog').countDocuments(),
        notifications: await db().collection('notifications').countDocuments(),
        notices: wired.sentNotifications.length,
      });

      it.each([
        ['a peer AAB’s agent, to an AAB', 'SARI', 'PEER_AGENT'],
        ['a peer AAB’s agent, to the AB beside their unit', 'AGUS', 'PEER_AGENT'],
        ['another office’s member', 'AGUS', 'B_AGENT'],
        ['another office’s member, to that office’s own AB naming this office’s', 'B_AB', 'INDAH'],
        ['a member who has left', 'AGUS', 'LEFT'],
        ['the leader naming themselves, an AB', 'AGUS', 'AGUS'],
        ['the leader naming themselves, an AAB', 'SARI', 'SARI'],
      ] as [string, Who, Who][])('ADR-0076 POST /leads?owner= is 404 for %s, and nothing is written', async (_name, caller, owner) => {
        const before = await written();
        expect(before).toMatchObject({ leads: 0, auditLog: 0 });
        as(caller);
        const res = await http().post('/leads').query({ owner: office.id[owner] })
          .send({ name: 'Pak Hendra', type: 'sales', thisMonth: true }).expect(404);
        const nobody = await http().post('/leads').query({ owner: new mongoose.Types.ObjectId().toString() })
          .send({ name: 'Pak Hendra', type: 'sales', thisMonth: true }).expect(404);

        expect(res.body.error.code).toBe('NOT_FOUND');
        // The same refusal as an id that is nobody's: the 404 says nothing about who exists, or where.
        expect([res.body.error.code, res.body.error.message]).toEqual([nobody.body.error.code, nobody.body.error.message]);
        expect(await written()).toEqual(before);
      });
    });

    it('P11-T4 names nobody with an empty owner: 404, not the caller’s own lead', async () => {
      as('AGUS');
      await http().post('/leads?owner=').send({ name: 'Pak Hendra' }).expect(404);
      expect(await db().collection('leads').countDocuments()).toBe(0);
    });

    it('P11-T4 refuses the body before it resolves the owner: 400, not 404', async () => {
      as('AGUS');
      const res = await http().post('/leads').query({ owner: office.id.PEER_AGENT }).send({ name: 'x' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P11-T4 validates `owner`, and refuses any other query field by name', async () => {
      as('AGUS');
      await http().post('/leads').query({ owner: 'x'.repeat(65) }).send({ name: 'Pak Hendra' }).expect(400);
      const res = await http().post('/leads').query({ for: office.id.RINA }).send({ name: 'Pak Hendra' }).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/for/);
    });
  });
});
