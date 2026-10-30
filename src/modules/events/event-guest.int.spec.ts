import { INestApplication } from '@nestjs/common';
import mongoose from 'mongoose';
import request from 'supertest';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { declaredPermissions, session } from '../../../test/http-permissions';
import { buildEventsOffice, eventsApp, type EventKey, type EventsOffice, type EventsWho } from '../../../test/events-office';
import { ROSTER_NOW } from '../../../test/coaching-office';
import { IN_INDONESIAN } from '../../../test/i18n';
import { EventGuestController } from './event-guest.controller';

/**
 * **Events, for the people they are for, over HTTP** (P18.5-T5, P18.5-T6): the agent's list, the modal, RSVP and
 * the claim; the Owner's roll call, the picker's people and the *Feedback Summary*; and the answer between them.
 * The real services over the real collections, the real `PermissionsGuard` and the production pipe.
 */
describe('events, for their audience (P18.5-T5, P18.5-T6)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: EventsOffice;
  const db = () => mongoose.connection.db!;
  const http = () => request(app.getHttpServer());
  const idOf = (key: EventKey) => office.event[key].id;
  const SA = RequestContext.platform('root');

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    app = await eventsApp(wired);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await clearCollections();
    office = await buildEventsOffice(wired);
  }, 60_000);

  const as = (who: EventsWho | 'B_OWNER') => { session.current = office.as(who); };
  const listed = async (who: EventsWho) => {
    as(who);
    return (await http().get('/events').expect(200)).body as { events: { code: string }[] };
  };
  const codesOf = async (who: EventsWho) => (await listed(who)).events.map((e) => e.code);
  const rollCall = async (key: EventKey, who: EventsWho = 'OWNER') => {
    as(who);
    return (await http().get(`/kpm/settings/events/${idOf(key)}/attendance`).expect(200)).body;
  };
  const rowOf = (call: { people: { membershipId: string }[] }, who: EventsWho) =>
    call.people.find((p) => p.membershipId === office.id[who]) as Record<string, unknown> | undefined;

  it('P18.5-T5 AC-1 declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(EventGuestController)).toEqual({
      list: 'event:read_list',
      read: 'event:read_list',
      rsvp: 'event:rsvp',
      cancelRsvp: 'event:cancel_rsvp',
      withdrawRsvp: 'event:cancel_rsvp',
      claim: 'event_attendance:self_claim',
      submitFeedback: 'event_feedback:submit',
    });
  });

  describe('P18.5-T5 AC-1 who reads and writes — a positive and a negative per role and route', () => {
    it.each(['OWNER', 'ADMIN', 'AGUS', 'SARI', 'RINA'] as const)('P18.5-T5 AC-1 %s reads the list and one event', async (who) => {
      as(who);
      await http().get('/events').expect(200);
      await http().get(`/events/${idOf('UPCOMING')}`).expect(200);
    });

    it('P18.5-T5 AC-1 a Super Admin outside a support session reads no office', async () => {
      session.current = SA;
      expect((await http().get('/events').expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
      // The writes are no Super Admin's at all: the guard refuses them before anything is looked up.
      expect((await http().post(`/events/${idOf('UPCOMING')}/rsvp`).expect(403)).body.error.code).toBe('PERM_DENIED');
    });

    it.each(['OWNER', 'ADMIN', 'AGUS', 'SARI', 'RINA'] as const)(
      'P18.5-T5 AC-1 %s RSVPs, cancels, claims and answers — the Owner and the Admin as the AB they are', async (who) => {
        as(who);
        await http().post(`/events/${idOf('UPCOMING')}/rsvp`).expect(201);
        await http().post(`/events/${idOf('UPCOMING')}/rsvp/cancel`).expect(201);
        await http().post(`/events/${idOf('UPCOMING')}/rsvp/withdraw`).expect(201);
        await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201);
        await http().post(`/events/${idOf('PAST_ALL')}/feedback`).send({ score: 8 }).expect(201);
      },
    );

    it('P18.5-T5 AC-1 a read-only support session reads, is told it may write nothing, and is refused every write', async () => {
      session.current = office.supported('RINA');
      const list = (await http().get('/events').expect(200)).body;
      expect(list.can).toEqual({ rsvp: false, cancelRsvp: false, claim: false, feedback: false });
      for (const call of [
        () => http().post(`/events/${idOf('UPCOMING')}/rsvp`),
        () => http().post(`/events/${idOf('UPCOMING')}/rsvp/cancel`),
        () => http().post(`/events/${idOf('UPCOMING')}/rsvp/withdraw`),
        () => http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`),
        () => http().post(`/events/${idOf('PAST_ALL')}/feedback`).send({ score: 9 }),
      ]) expect((await call().expect(403)).body.error.code).toBe('PERM_DENIED');
      expect(await db().collection('eventRsvps').countDocuments()).toBe(0);
    });

    it('P18.5-T5 AC-1 an elevated session reads, and never RSVPs, cancels, claims or answers in the member’s name (D-support)', async () => {
      session.current = office.supported('RINA', false);
      const list = (await http().get('/events').expect(200)).body;
      expect(list.can).toEqual({ rsvp: false, cancelRsvp: false, claim: false, feedback: false });
      await http().get(`/events/${idOf('UPCOMING')}`).expect(200);
      for (const call of [
        () => http().post(`/events/${idOf('UPCOMING')}/rsvp`),
        () => http().post(`/events/${idOf('UPCOMING')}/rsvp/cancel`),
        () => http().post(`/events/${idOf('UPCOMING')}/rsvp/withdraw`),
        () => http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`),
        () => http().post(`/events/${idOf('PAST_ALL')}/feedback`).send({ score: 9 }),
      ]) expect((await call().expect(403)).body.error.code).toBe('PERM_DENIED');
      expect(await db().collection('eventRsvps').countDocuments()).toBe(0);
    });

    it.each(['AGUS', 'SARI', 'RINA'] as const)('P18.5-T5 AC-1 %s is refused the roll call, its save, the picker and the summary', async (who) => {
      as(who);
      const id = idOf('PAST_ALL');
      for (const call of [
        () => http().get('/kpm/settings/events/invitees'),
        () => http().get(`/kpm/settings/events/${id}/attendance`),
        () => http().put(`/kpm/settings/events/${id}/attendance`).send({ entries: [{ membershipId: office.id.RINA, attended: true }] }),
        () => http().get(`/kpm/settings/events/${id}/feedback`),
      ]) expect((await call().expect(403)).body.error.code).toBe('PERM_DENIED');
    });

    it.each(['OWNER', 'ADMIN'] as const)('P18.5-T5 AC-1 %s reads the roll call, the picker and the summary, and saves the roll call', async (who) => {
      as(who);
      const id = idOf('PAST_ALL');
      await http().get('/kpm/settings/events/invitees').expect(200);
      await http().get(`/kpm/settings/events/${id}/attendance`).expect(200);
      await http().get(`/kpm/settings/events/${id}/feedback`).expect(200);
      await http().put(`/kpm/settings/events/${id}/attendance`)
        .send({ entries: [{ membershipId: office.id.RINA, attended: true }] }).expect(200);
    });

    it('P18.5-T5 AC-1 a read-only session as the Owner reads the list, the picker and the summary; the roll call, read and save, is the confirm’s and refused', async () => {
      session.current = office.supported('OWNER');
      await http().get('/kpm/settings/events').expect(200);
      await http().get('/kpm/settings/events/invitees').expect(200);
      await http().get(`/kpm/settings/events/${idOf('PAST_ALL')}/feedback`).expect(200);
      const read = await http().get(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`).expect(403);
      expect(read.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'event_attendance:confirm' } });
      await http().put(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`)
        .send({ entries: [{ membershipId: office.id.RINA, attended: true }] }).expect(403);
    });

    it('P18.5-T5 AC-1 an elevated session as the Owner reads the roll call and may confirm, both actors audited', async () => {
      session.current = office.supported('OWNER', false);
      const call = (await http().get(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`).expect(200)).body;
      expect(call.can).toEqual({ confirm: true });
      await http().put(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`)
        .send({ entries: [{ membershipId: office.id.RINA, attended: true }] }).expect(200);
      const audit = await db().collection('auditLog').findOne({ action: 'event.attendance_confirmed' });
      expect(audit).toMatchObject({ actorUserId: 'u-support' });
    });
  });

  describe('P18.5-T5 AC-3 the audience, as at the start', () => {
    it('P18.5-T5 AC-3 Dewi (an AAB leading nobody) and Rina do not see the running leaders’ event; Agus and Sari do', async () => {
      expect(await codesOf('AGUS')).toContain('RUNNING_LEADERS');
      expect(await codesOf('SARI')).toContain('RUNNING_LEADERS');
      expect(await codesOf('DEWI')).not.toContain('RUNNING_LEADERS');
      expect(await codesOf('RINA')).not.toContain('RUNNING_LEADERS');
      as('DEWI');
      expect((await http().get(`/events/${idOf('RUNNING_LEADERS')}`).expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it('P18.5-T5 AC-3 leaders by the edges valid then: Dewi led Tari on 10 August, Lukas leads her now', async () => {
      expect(await codesOf('DEWI')).toContain('PAST_LEADERS');
      expect(await codesOf('LUKAS')).not.toContain('PAST_LEADERS');
      expect(await codesOf('LUKAS')).toContain('RUNNING_LEADERS');
    });

    it('P18.5-T5 AC-3 somebody who joined later never sees an earlier event, nor claims in it', async () => {
      // ENDS_NOW began two hours ago, after she joined: hers. The August events are not.
      expect(await codesOf('LATE')).toEqual(['ENDS_NOW', 'UPCOMING']);
      as('LATE');
      await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(404);
      expect(rowOf(await rollCall('PAST_ALL'), 'LATE')).toBeUndefined();
    });

    it('P18.5-T5 AC-3 a chosen list holds only its people', async () => {
      expect(await codesOf('RINA')).toContain('PAST_CHOSEN');
      expect(await codesOf('DIMAS')).not.toContain('PAST_CHOSEN');
      const call = await rollCall('PAST_CHOSEN');
      expect(call.people.map((p: { name: string }) => p.name).sort()).toEqual(['Budi Santoso', 'Rina Wijaya']);
    });

    it('P18.5-T5 AC-3 no field reader’s payload carries an invitee list, nor a confirmation', async () => {
      as('OWNER');
      await http().put(`/kpm/settings/events/${idOf('PAST_CHOSEN')}/attendance`)
        .send({ entries: [{ membershipId: office.id.RINA, attended: true }] }).expect(200);
      for (const who of ['RINA', 'AGUS', 'OWNER'] as const) {
        as(who);
        const text = JSON.stringify((await http().get('/events').expect(200)).body)
          + JSON.stringify((await http().get(`/events/${idOf('UPCOMING')}`).expect(200)).body);
        expect(text).not.toContain('inviteeMembershipIds');
        expect(text).not.toMatch(/confirm/i);
        expect(text).not.toContain(office.id.BUDI);
      }
    });

    it('P18.5-T5 AC-9 an archived event is not listed and answers 404, its RSVP too', async () => {
      expect(await codesOf('RINA')).not.toContain('ARCHIVED');
      as('RINA');
      await http().get(`/events/${idOf('ARCHIVED')}`).expect(404);
      await http().post(`/events/${idOf('ARCHIVED')}/rsvp`).expect(404);
      await http().get('/events/not-an-id').expect(404);
    });
  });

  describe('P18.5-T5 AC-4, AC-5 the list and the modal', () => {
    it('P18.5-T5 AC-4 each event carries what the card draws, the day and time in the office’s zone, and the reader’s own part', async () => {
      const body = (await listed('RINA')) as unknown as {
        events: Record<string, unknown>[]; companyName: string; timezone: string; limits: unknown; can: unknown;
      };
      expect(body.companyName).toBe('Prudential');
      expect(body.timezone).toBe('Asia/Jakarta');
      expect(body.limits).toEqual({ feedbackTextMax: 1000, nps: { scaleMin: 0, scaleMax: 10, promoterMin: 9, detractorMax: 6 } });
      expect(body.can).toEqual({ rsvp: true, cancelRsvp: true, claim: true, feedback: true });
      const past = body.events.find((e) => e.code === 'PAST_ALL')!;
      expect(past).toMatchObject({
        title: 'PAST ALL', blurb: 'PAST_ALL blurb', description: 'PAST_ALL description',
        type: { code: 'PRODUCT_LAUNCH', label: 'Peluncuran produk', emoji: '🚀', color: '#F2994A' },
        audience: { issuer: 'company', scope: 'all_agents' },
        startsOn: '2026-08-24', startTime: '09:00', location: 'Kantor KPM', locationUrl: null,
        phase: 'past', ended: true, me: { rsvp: null, claimed: false, feedback: null },
      });
      // In start order; a running event is with the upcoming ones.
      expect(body.events.map((e) => e.code)).toEqual(['PAST_CHOSEN', 'PAST_ALL', 'ENDS_NOW', 'UPCOMING']);
      expect(body.events.find((e) => e.code === 'UPCOMING')).toMatchObject({ phase: 'upcoming', locationUrl: 'https://meet.example.test/x' });
    });

    it('P18.5-T5 AC-5 Join event, then Cancel RSVP — idempotent, and audited once each', async () => {
      as('RINA');
      const id = idOf('UPCOMING');
      expect((await http().post(`/events/${id}/rsvp`).expect(201)).body.me).toEqual({ rsvp: 'going', claimed: false, feedback: null });
      await http().post(`/events/${id}/rsvp`).expect(201);
      expect((await http().post(`/events/${id}/rsvp/cancel`).expect(201)).body.me.rsvp).toBe('cancelled');
      await http().post(`/events/${id}/rsvp/cancel`).expect(201);
      expect((await http().post(`/events/${id}/rsvp`).expect(201)).body.me.rsvp).toBe('going');
      const audits = await db().collection('auditLog').find({ action: /^event\.rsvp/ }).sort({ _id: 1 }).toArray();
      expect(audits.map((a) => a.action)).toEqual(['event.rsvp', 'event.rsvp_cancelled', 'event.rsvp']);
      expect(audits[1]).toMatchObject({ before: { rsvpStatus: 'going' }, after: { rsvpStatus: 'cancelled' } });
      expect(await db().collection('eventRsvps').countDocuments({ membershipId: office.id.RINA })).toBe(1);
    });

    it('UI-108 Tidak ikut from no answer makes the row, cancelled — audited once, from null', async () => {
      as('RINA');
      const id = idOf('UPCOMING');
      expect((await http().post(`/events/${id}/rsvp/cancel`).expect(201)).body.me.rsvp).toBe('cancelled');
      await http().post(`/events/${id}/rsvp/cancel`).expect(201);
      const audits = await db().collection('auditLog').find({ action: /^event\.rsvp/ }).sort({ _id: 1 }).toArray();
      expect(audits.map((a) => a.action)).toEqual(['event.rsvp_cancelled']);
      expect(audits[0]).toMatchObject({ before: { rsvpStatus: null }, after: { rsvpStatus: 'cancelled' } });
      expect(await db().collection('eventRsvps').countDocuments({ membershipId: office.id.RINA })).toBe(1);
    });

    it('UI-108 the chosen answer tapped again is undone: Ikut and Tidak ikut each withdraw to no answer, audited', async () => {
      as('RINA');
      const id = idOf('UPCOMING');
      await http().post(`/events/${id}/rsvp`).expect(201);
      expect((await http().post(`/events/${id}/rsvp/withdraw`).expect(201)).body.me).toEqual({ rsvp: null, claimed: false, feedback: null });
      await http().post(`/events/${id}/rsvp/withdraw`).expect(201);
      await http().post(`/events/${id}/rsvp/cancel`).expect(201);
      expect((await http().post(`/events/${id}/rsvp/withdraw`).expect(201)).body.me.rsvp).toBeNull();
      const audits = await db().collection('auditLog').find({ action: /^event\.rsvp/ }).sort({ _id: 1 }).toArray();
      expect(audits.map((a) => a.action)).toEqual(['event.rsvp', 'event.rsvp_withdrawn', 'event.rsvp_cancelled', 'event.rsvp_withdrawn']);
      expect(audits[1]).toMatchObject({ before: { rsvpStatus: 'going' }, after: { rsvpStatus: null } });
      expect(audits[3]).toMatchObject({ before: { rsvpStatus: 'cancelled' }, after: { rsvpStatus: null } });
      // One row throughout, never deleted: an answer withdrawn is a status, not an erasure.
      const rows = await db().collection('eventRsvps').find({ membershipId: office.id.RINA }).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ rsvpStatus: null, deletedAt: null });
    });

    it('UI-108 withdrawing with no answer changes nothing and makes no row', async () => {
      as('RINA');
      expect((await http().post(`/events/${idOf('UPCOMING')}/rsvp/withdraw`).expect(201)).body.me.rsvp).toBeNull();
      expect(await db().collection('eventRsvps').countDocuments({ membershipId: office.id.RINA })).toBe(0);
      expect(await db().collection('auditLog').countDocuments({ action: 'event.rsvp_withdrawn' })).toBe(0);
    });

    it('P18.5-T5 AC-5 a running event still takes an RSVP; from endsAt both are refused 409, at the exact boundary', async () => {
      as('AGUS');
      await http().post(`/events/${idOf('RUNNING_LEADERS')}/rsvp`).expect(201);
      as('RINA');
      // ENDS_NOW ended at ROSTER_NOW to the millisecond: closed — the card's undo too (UI-108).
      for (const path of ['rsvp', 'rsvp/cancel', 'rsvp/withdraw']) {
        const res = await http().post(`/events/${idOf('ENDS_NOW')}/${path}`).expect(409);
        expect(res.body.error.code).toBe('EVENT_RSVP_CLOSED');
      }
      expect((await http().get(`/events/${idOf('ENDS_NOW')}`).expect(200)).body).toMatchObject({ phase: 'past', ended: true });
    });

    it('P18.5-T5 AC-5 an RSVP or a claim takes no body', async () => {
      as('RINA');
      await http().post(`/events/${idOf('UPCOMING')}/rsvp`).send({ going: true }).expect(400);
      await http().get('/events?phase=past').expect(400);
    });
  });

  describe('P18.5-T5 AC-6 a claim is not attendance — exit test 2', () => {
    it('P18.5-T5 AC-6 attendance cannot be self-claimed without a confirming role', async () => {
      as('RINA');
      const claimed = (await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201)).body;
      expect(claimed.me).toEqual({ rsvp: null, claimed: true, feedback: null });
      as('BUDI');
      await http().post(`/events/${idOf('PAST_CHOSEN')}/attendance/claim`).expect(201);

      // An RSVP, a claim, and both together: never attended.
      let call = await rollCall('PAST_ALL');
      expect(rowOf(call, 'RINA')).toMatchObject({ said: 'claimed', attended: null, status: 'unconfirmed' });
      expect(call.counts.attended).toBe(0);
      expect(call.attendanceRate).toBe(0);

      // The member cannot confirm their own: the guard refuses a field member the save outright…
      as('RINA');
      await http().put(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`)
        .send({ entries: [{ membershipId: office.id.RINA, attended: true }] }).expect(403);
      // …a leader cannot either…
      as('SARI');
      await http().put(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`)
        .send({ entries: [{ membershipId: office.id.RINA, attended: true }] }).expect(403);
      // …and the Owner can.
      as('OWNER');
      call = (await http().put(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`)
        .send({ entries: [{ membershipId: office.id.RINA, attended: true }] }).expect(200)).body;
      expect(rowOf(call, 'RINA')).toMatchObject({ attended: true, status: 'attended', confirmedBy: 'Wilson Tanoto' });
      expect(call.counts.attended).toBe(1);
      expect(await db().collection('eventRsvps').countDocuments({ confirmedAttended: true })).toBe(1);
    });

    it('P18.5-T5 AC-6 a claim before the end is refused 409 EVENT_NOT_ENDED, and is idempotent after', async () => {
      as('RINA');
      expect((await http().post(`/events/${idOf('UPCOMING')}/attendance/claim`).expect(409)).body.error.code).toBe('EVENT_NOT_ENDED');
      await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201);
      await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201);
      expect(await db().collection('auditLog').countDocuments({ action: 'event.attendance_claimed' })).toBe(1);
    });
  });

  describe('P18.5-T5 AC-7 the roll call', () => {
    it('P18.5-T5 AC-7 lists the audience as at the start with name, rung and what they said; the caller’s own row is marked', async () => {
      as('RINA');
      await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201);
      const call = await rollCall('PAST_ALL');
      expect(call).toMatchObject({ title: 'PAST ALL', phase: 'past', ended: true, startsOn: '2026-08-24', can: { confirm: true } });
      // Everybody active since January in 0417, the removed one and the latecomer not: the two offices' people apart.
      expect(call.counts.audience).toBe(16);
      expect(rowOf(call, 'RINA')).toMatchObject({ name: 'Rina Wijaya', orgLevelCode: 'AGENT', said: 'claimed', self: false });
      expect(rowOf(call, 'OWNER')).toMatchObject({ self: true, said: null, status: 'not_registered' });
      expect(rowOf(call, 'SARI')!.rung).toBeTruthy();
    });

    it('P18.5-T5 AC-7 nobody confirms their own: 400 EVENT_ATTENDANCE_SELF, nothing written; the Admin confirms the Owner', async () => {
      as('OWNER');
      const res = await http().put(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`)
        .send({ entries: [{ membershipId: office.id.RINA, attended: true }, { membershipId: office.id.OWNER, attended: true }] })
        .expect(400);
      expect(res.body.error.code).toBe('EVENT_ATTENDANCE_SELF');
      expect(await db().collection('eventRsvps').countDocuments()).toBe(0);

      as('ADMIN');
      const call = (await http().put(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`)
        .send({ entries: [{ membershipId: office.id.OWNER, attended: true }] }).expect(200)).body;
      expect(rowOf(call, 'OWNER')).toMatchObject({ attended: true, confirmedBy: 'Maya Kusuma', self: false });
      expect(rowOf(call, 'ADMIN')).toMatchObject({ self: true });
    });

    it('P18.5-T5 AC-7 marks absent, clears back to unconfirmed, and audits each change with before, after and the confirmer', async () => {
      as('RINA');
      await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201);
      as('OWNER');
      const save = (attended: boolean | null) => http().put(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`)
        .send({ entries: [{ membershipId: office.id.RINA, attended }] }).expect(200);
      expect(rowOf((await save(false)).body, 'RINA')).toMatchObject({ attended: false, status: 'no_show' });
      expect(rowOf((await save(false)).body, 'RINA')).toMatchObject({ attended: false });
      expect(rowOf((await save(null)).body, 'RINA')).toMatchObject({ attended: null, status: 'unconfirmed', confirmedBy: null });
      const audits = await db().collection('auditLog').find({ action: /^event\.attendance_(marked|cleared|confirmed)/ }).sort({ _id: 1 }).toArray();
      expect(audits.map((a) => [a.action, a.before.attended, a.after.attended, a.after.confirmedByMembershipId])).toEqual([
        ['event.attendance_marked_absent', null, false, office.id.OWNER],
        ['event.attendance_cleared', false, null, office.id.OWNER],
      ]);
      expect(audits[0].targetMembershipId).toBe(office.id.RINA);
    });

    it('P18.5-T5 AC-7 before the end 409 EVENT_NOT_ENDED; somebody outside the audience 404; a malformed body 400', async () => {
      as('OWNER');
      const put = (key: EventKey, body: unknown) => http().put(`/kpm/settings/events/${idOf(key)}/attendance`).send(body as object);
      expect((await put('UPCOMING', { entries: [{ membershipId: office.id.RINA, attended: true }] }).expect(409)).body.error.code)
        .toBe('EVENT_NOT_ENDED');
      expect((await http().get(`/kpm/settings/events/${idOf('UPCOMING')}/attendance`).expect(200)).body.can).toEqual({ confirm: false });
      await put('PAST_CHOSEN', { entries: [{ membershipId: office.id.DIMAS, attended: true }] }).expect(404);
      await put('PAST_ALL', { entries: [{ membershipId: office.id.LATE, attended: true }] }).expect(404);
      for (const body of [
        {}, { entries: [] }, { entries: 'x' }, { entries: [{ membershipId: office.id.RINA }] },
        { entries: [{ membershipId: office.id.RINA, attended: 'yes' }] },
        { entries: [{ membershipId: office.id.RINA, attended: true }, { membershipId: office.id.RINA, attended: false }] },
        { entries: [{ membershipId: office.id.RINA, attended: true, note: 'x' }] },
        { entries: [{ membershipId: office.id.RINA, attended: true }], extra: 1 },
      ]) expect([body, (await put('PAST_ALL', body).expect(400)).body.error.code]).toEqual([body, 'VALIDATION_FAILED']);
    });

    it('P18.5-T5 AC-8 the rate over the audience as at the start: 2 of 2 chosen is 100, one absent of two is 50', async () => {
      as('OWNER');
      const put = (entries: unknown[]) => http().put(`/kpm/settings/events/${idOf('PAST_CHOSEN')}/attendance`).send({ entries }).expect(200);
      expect((await put([{ membershipId: office.id.RINA, attended: true }, { membershipId: office.id.BUDI, attended: true }])).body.attendanceRate).toBe(100);
      expect((await put([{ membershipId: office.id.BUDI, attended: false }])).body.attendanceRate).toBe(50);
      expect((await rollCall('UPCOMING')).attendanceRate).toBeNull();
    });
  });

  describe('P18.5-T5 AC-10 the picker', () => {
    it('P18.5-T5 AC-10 lists every active member with the rung and whether they lead somebody — by the graph', async () => {
      as('OWNER');
      const { people } = (await http().get('/kpm/settings/events/invitees').expect(200)).body as {
        people: { membershipId: string; name: string; leads: boolean; orgLevelCode: string; rung: string }[];
      };
      const by = (who: EventsWho) => people.find((p) => p.membershipId === office.id[who]);
      expect(people).toHaveLength(17);
      expect(by('LEFT')).toBeUndefined();
      expect(by('DEWI')).toMatchObject({ leads: false, orgLevelCode: 'AAB' });
      expect(by('LUKAS')).toMatchObject({ leads: true, orgLevelCode: 'AGENT' });
      expect(by('SARI')!.leads).toBe(true);
      expect(people.map((p) => p.name)).toEqual([...people.map((p) => p.name)].sort((a, b) => a.localeCompare(b)));
      await http().get('/kpm/settings/events/invitees?q=rina').expect(400);
    });

    it('P18.5-T5 AC-10 a chosen-leaders event takes somebody who leads, by the same graph, and refuses one who leads nobody', async () => {
      as('OWNER');
      const make = (code: string, who: EventsWho) => http().post('/kpm/settings/events').send({
        code, typeCode: 'TRAINING', title: 'Leaders', startsAt: '2026-10-01T02:00:00Z', endsAt: '2026-10-01T04:00:00Z',
        audience: { issuer: 'kpm', scope: 'select_leaders', inviteeMembershipIds: [office.id[who]] },
      });
      await make('LEADS_OK', 'LUKAS').expect(201);
      await make('LEADS_NOT', 'DEWI').expect(400);
    });
  });

  describe('P18.5-T6 the answer', () => {
    it('P18.5-T6 AC-2 only after the end, only for somebody who RSVP’d, claimed or was confirmed', async () => {
      as('RINA');
      expect((await http().post(`/events/${idOf('UPCOMING')}/feedback`).send({ score: 9 }).expect(409)).body.error.code)
        .toBe('EVENT_NOT_ENDED');
      expect((await http().post(`/events/${idOf('PAST_ALL')}/feedback`).send({ score: 9 }).expect(409)).body.error.code)
        .toBe('EVENT_NOT_ATTENDED');
      // Confirmed by the Owner with neither an RSVP nor a claim: walked in, and may answer.
      as('OWNER');
      await http().put(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`)
        .send({ entries: [{ membershipId: office.id.RINA, attended: true }] }).expect(200);
      as('RINA');
      await http().post(`/events/${idOf('PAST_ALL')}/feedback`).send({ score: 9 }).expect(201);
    });

    it('P18.5-T6 AC-3 one answer, kept whole: improve stored, both texts trimmed; a second submit 409', async () => {
      as('RINA');
      await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201);
      const answered = (await http().post(`/events/${idOf('PAST_ALL')}/feedback`)
        .send({ score: 7, why: '  <script>alert(1)</script> too long  ', improve: ' Shorter agenda. ' }).expect(201)).body;
      expect(answered.me.feedback).toMatchObject({ score: 7, why: '<script>alert(1)</script> too long', improve: 'Shorter agenda.' });
      const stored = await db().collection('eventFeedback').findOne({ membershipId: office.id.RINA });
      expect(stored).toMatchObject({ score: 7, improve: 'Shorter agenda.', eventId: idOf('PAST_ALL'), kpmId: expect.any(String) });
      expect((await http().post(`/events/${idOf('PAST_ALL')}/feedback`).send({ score: 9 }).expect(409)).body.error.code)
        .toBe('EVENT_FEEDBACK_ALREADY_SUBMITTED');
      expect(await db().collection('eventFeedback').countDocuments()).toBe(1);
    });

    it('P18.5-T6 AC-3 refuses a score that is not a whole number from 0 to 10, an over-long text and an unknown field — 400', async () => {
      as('RINA');
      await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201);
      for (const body of [
        {}, { score: 11 }, { score: -1 }, { score: 5.5 }, { score: '7' }, { score: null },
        { score: 7, why: 'x'.repeat(1001) }, { score: 7, improve: 'x'.repeat(1001) }, { score: 7, why: 3 }, { score: 7, rating: 2 },
      ]) {
        const res = await http().post(`/events/${idOf('PAST_ALL')}/feedback`).send(body);
        expect([JSON.stringify(body).slice(0, 40), res.status, res.body.error?.code]).toEqual([JSON.stringify(body).slice(0, 40), 400, 'VALIDATION_FAILED']);
      }
      await http().post(`/events/${idOf('PAST_ALL')}/feedback`).send({ score: 0, why: 'x'.repeat(1000) }).expect(201);
    });

    it('P18.5-T6 AC-7 the audit row carries ids and the score, never the words', async () => {
      as('RINA');
      await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201);
      await http().post(`/events/${idOf('PAST_ALL')}/feedback`).send({ score: 6, why: 'Secret words', improve: 'More secret' }).expect(201);
      const row = await db().collection('auditLog').findOne({ action: 'event.feedback_submitted' });
      expect(row!.after).toEqual({ eventId: idOf('PAST_ALL'), membershipId: office.id.RINA, score: 6 });
      expect(JSON.stringify(row)).not.toMatch(/secret/i);
    });

    it('P18.5-T6 AC-5, AC-6 the Feedback Summary: names shown, NPS over confirmed attendees, k awaiting, absent counted in neither', async () => {
      const answer = async (who: EventsWho, score: number, why = '', improve = '') => {
        as(who);
        await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201);
        await http().post(`/events/${idOf('PAST_ALL')}/feedback`).send({ score, why, improve }).expect(201);
      };
      as('OWNER');
      let summary = (await http().get(`/kpm/settings/events/${idOf('PAST_ALL')}/feedback`).expect(200)).body;
      expect(summary).toMatchObject({ nps: null, counted: 0, responses: 0, awaitingConfirmation: 0, rows: [] });
      expect(summary.constants).toEqual({ scaleMin: 0, scaleMax: 10, promoterMin: 9, detractorMax: 6 });

      await answer('RINA', 10, 'Great', 'Keep it');
      await answer('BUDI', 9);
      await answer('INDAH', 4, 'Long');
      await answer('DIMAS', 8);
      as('OWNER');
      await http().put(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`).send({ entries: [
        { membershipId: office.id.RINA, attended: true },
        { membershipId: office.id.INDAH, attended: true },
        { membershipId: office.id.DIMAS, attended: false },
      ] }).expect(200);
      summary = (await http().get(`/kpm/settings/events/${idOf('PAST_ALL')}/feedback`).expect(200)).body;
      // Rina (promoter) and Indah (detractor) confirmed: 100·(1 − 1)/2 = 0. Budi awaits; Dimas absent.
      expect(summary).toMatchObject({
        title: 'PAST ALL', nps: 0, counted: 2, responses: 4, awaitingConfirmation: 1, promoters: 1, passives: 0, detractors: 1,
      });
      expect(summary.rows.map((r: Record<string, unknown>) => [r.name, r.score, r.bucket, r.attendance, r.counted])).toEqual([
        ['Rina Wijaya', 10, 'promoter', 'confirmed', true],
        ['Budi Santoso', 9, 'promoter', 'unconfirmed', false],
        ['Dimas Pratama', 8, 'passive', 'absent', false],
        ['Indah Permatasari', 4, 'detractor', 'confirmed', true],
      ]);
      expect(summary.rows[0]).toMatchObject({ why: 'Great', improve: 'Keep it' });
      expect(summary.rows[3]).toMatchObject({ why: 'Long', improve: '' });
    });

    it('P18.5-T6 AC-4 the reader reads their own answer back in the list, and nobody else’s', async () => {
      as('RINA');
      await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201);
      await http().post(`/events/${idOf('PAST_ALL')}/feedback`).send({ score: 9, why: 'Clear' }).expect(201);
      const mine = (await listed('RINA')).events.find((e) => e.code === 'PAST_ALL') as unknown as { me: { feedback: unknown } };
      expect(mine.me.feedback).toMatchObject({ score: 9, why: 'Clear', improve: '' });
      const theirs = (await listed('BUDI')).events.find((e) => e.code === 'PAST_ALL') as unknown as { me: unknown };
      expect(theirs.me).toEqual({ rsvp: null, claimed: false, feedback: null });
    });
  });

  describe('P18.5-T5 AC-4 what an office missing a part of its record still reads', () => {
    it('P18.5-T5 AC-4 no company row: the issuer word is empty and every rung reads its code; a vanished type reads its code', async () => {
      await db().collection('companies').deleteMany({});
      await db().collection('kpms').updateOne(
        { _id: new mongoose.Types.ObjectId(office.as('OWNER').kpmId!) }, { $set: { companyId: '66f0000000000000000000ff' } },
      );
      await db().collection('eventTypes').updateMany({ code: 'TRAINING' }, { $set: { deletedAt: new Date() } });
      const body = (await listed('RINA')) as unknown as { companyName: string; events: Record<string, unknown>[] };
      expect(body.companyName).toBe('');
      expect(body.events.find((e) => e.code === 'UPCOMING')!.type).toEqual({ code: 'TRAINING', label: 'TRAINING', emoji: null, color: null });
      const call = await rollCall('PAST_ALL');
      expect(rowOf(call, 'SARI')).toMatchObject({ orgLevelCode: 'AAB', rung: 'AAB' });
      as('OWNER');
      const people = (await http().get('/kpm/settings/events/invitees').expect(200)).body.people as { rung: string; orgLevelCode: string }[];
      expect(people.every((p) => p.rung === p.orgLevelCode)).toBe(true);
    });

    it('P18.5-T5 AC-4 an office whose own row is gone, and a member whose account is gone: no company word, no rungs, names empty', async () => {
      as('RINA');
      await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201);
      await http().post(`/events/${idOf('PAST_ALL')}/feedback`).send({ score: 9 }).expect(201);
      const rina = await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.RINA) });
      await db().collection('users').deleteOne({ _id: new mongoose.Types.ObjectId(String(rina!.userId)) });
      await db().collection('kpms').deleteOne({ _id: new mongoose.Types.ObjectId(office.as('OWNER').kpmId!) });

      const body = (await listed('BUDI')) as unknown as { companyName: string; timezone: string };
      expect([body.companyName, body.timezone]).toEqual(['', 'Asia/Jakarta']);
      as('OWNER');
      const people = (await http().get('/kpm/settings/events/invitees').expect(200)).body.people as { membershipId: string; name: string; rung: string }[];
      expect(people.find((p) => p.membershipId === office.id.RINA)).toMatchObject({ name: '', rung: 'AGENT' });
      expect(rowOf(await rollCall('PAST_ALL'), 'RINA')).toMatchObject({ name: '', rung: 'AGENT' });
      const summary = (await http().get(`/kpm/settings/events/${idOf('PAST_ALL')}/feedback`).expect(200)).body;
      expect(summary.rows.map((r: { name: string }) => r.name)).toEqual(['']);
    });

    it('P18.5-T5 AC-7 the roll call of a running or upcoming event names an RSVP as RSVP’d, registered, and offers no confirm', async () => {
      as('RINA');
      await http().post(`/events/${idOf('UPCOMING')}/rsvp`).expect(201);
      const call = await rollCall('UPCOMING');
      expect(rowOf(call, 'RINA')).toMatchObject({ said: 'rsvp', status: 'registered', attended: null });
      expect(call).toMatchObject({ ended: false, attendanceRate: null, can: { confirm: false } });
      expect(call.counts.registered).toBe(1);
    });

    it('P18.5-T5 AC-7 a confirmer whose membership has gone is named by nobody, never by a placeholder', async () => {
      as('OWNER');
      await http().put(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`)
        .send({ entries: [{ membershipId: office.id.RINA, attended: true }] }).expect(200);
      await db().collection('memberships').updateOne(
        { _id: new mongoose.Types.ObjectId(office.id.OWNER) }, { $set: { deletedAt: new Date() } },
      );
      as('ADMIN');
      expect(rowOf(await rollCall('PAST_ALL', 'ADMIN'), 'RINA')).toMatchObject({ attended: true, confirmedBy: '' });
    });
  });

  describe('P18.5-T5 AC-9 the office’s zone and the refusal to reopen an answered event', () => {
    it('P18.5-T5 AC-9 the day and the time come from kpms.timezone, not a constant', async () => {
      // A column set to another zone moves the day: 16:30Z is 00:30 on the next day in Makassar.
      await db().collection('kpms').updateOne(
        { _id: new mongoose.Types.ObjectId(office.as('OWNER').kpmId!) }, { $set: { timezone: 'Asia/Makassar' } },
      );
      as('OWNER');
      await http().post('/kpm/settings/events').send({
        code: 'LATE_NIGHT', typeCode: 'TRAINING', title: 'Late', startsAt: '2026-10-01T16:30:00Z', endsAt: '2026-10-01T18:00:00Z',
        audience: { issuer: 'kpm', scope: 'all_agents' },
      }).expect(201);
      const event = (await listed('RINA') as unknown as { events: Record<string, string>[]; timezone: string });
      expect(event.timezone).toBe('Asia/Makassar');
      expect(event.events.find((e) => e.code === 'LATE_NIGHT')).toMatchObject({ startsOn: '2026-10-02', startTime: '00:30' });
      as('OWNER');
      const settings = (await http().get('/kpm/settings/events').expect(200)).body as { code: string; startsOn: string }[];
      expect(settings.find((e) => e.code === 'LATE_NIGHT')!.startsOn).toBe('2026-10-02');
    });

    it('P18.5-T5 AC-9 an answered event that has ended is not moved back into the future: 409 EVENT_HAS_RESPONSES', async () => {
      as('RINA');
      await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201);
      as('OWNER');
      const res = await http().patch(`/kpm/settings/events/${idOf('PAST_ALL')}`)
        .send({ startsAt: '2026-10-01T02:00:00Z', endsAt: '2026-10-01T04:00:00Z' }).expect(409);
      expect(res.body.error).toMatchObject({ code: 'EVENT_HAS_RESPONSES', details: { field: 'dates', changed: ['endsAt', 'startsAt'] } });
      // Renamed, re-typed, its issuer changed or its end moved within the past, it still saves; an unanswered past
      // event moves freely.
      await http().patch(`/kpm/settings/events/${idOf('PAST_ALL')}`).send({ title: 'Renamed', typeCode: 'COMMUNITY' }).expect(200);
      await http().patch(`/kpm/settings/events/${idOf('PAST_ALL')}`)
        .send({ audience: { issuer: 'kpm', scope: 'all_agents' } }).expect(200);
      await http().patch(`/kpm/settings/events/${idOf('PAST_ALL')}`).send({ endsAt: '2026-08-24T06:00:00Z' }).expect(200);
      await http().patch(`/kpm/settings/events/${idOf('PAST_LEADERS')}`)
        .send({ startsAt: '2026-10-01T02:00:00Z', endsAt: '2026-10-01T04:00:00Z' }).expect(200);
    });
  });

  describe('the Phase 18.5 exit review — an edit never shifts what an ended, answered event was', () => {
    const patch = (key: EventKey, body: Record<string, unknown>) => http().patch(`/kpm/settings/events/${idOf(key)}`).send(body);
    const answered = async (key: EventKey, who: EventsWho = 'RINA') => {
      as(who);
      await http().post(`/events/${idOf(key)}/attendance/claim`).expect(201);
      await http().post(`/events/${idOf(key)}/feedback`).send({ score: 9 }).expect(201);
      as('OWNER');
    };

    it('P18.5-T5 AC-9 a patch carrying startsAt alone is checked against the stored end: 400, never a bypass of the guard', async () => {
      await answered('PAST_ALL');
      const res = await patch('PAST_ALL', { startsAt: '2026-10-01T02:00:00Z' }).expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { violations: ['endsAt must be after startsAt.'] } });
      // The same patch on an upcoming event that would end before it starts.
      await patch('UPCOMING', { startsAt: '2026-12-01T02:00:00Z' }).expect(400);
    });

    it('P18.5-T5 AC-9 its start does not move, even within the past: 409, details.field "dates"', async () => {
      await answered('PAST_ALL');
      const res = await patch('PAST_ALL', { startsAt: '2026-08-24T01:00:00Z' }).expect(409);
      expect(res.body.error).toMatchObject({ code: 'EVENT_HAS_RESPONSES', details: { field: 'dates', changed: ['startsAt'] } });
    });

    it('P18.5-T5 AC-9 who it was for does not change — scope or invitees: 409, details.field "audience"; nothing drops from the summary', async () => {
      await answered('PAST_CHOSEN', 'RINA');
      await answered('PAST_CHOSEN', 'BUDI');
      for (const audience of [
        { issuer: 'kpm', scope: 'all_agents' },
        { issuer: 'kpm', scope: 'select_agents', inviteeMembershipIds: [office.id.RINA] },
        { issuer: 'kpm', scope: 'select_agents', inviteeMembershipIds: [office.id.RINA, office.id.BUDI, office.id.DIMAS] },
      ]) {
        const res = await patch('PAST_CHOSEN', { audience }).expect(409);
        expect(res.body.error).toMatchObject({ code: 'EVENT_HAS_RESPONSES', details: { field: 'audience', changed: ['audience'] } });
      }
      // The same people in another order is the same audience.
      await patch('PAST_CHOSEN', { audience: { issuer: 'company', scope: 'select_agents', inviteeMembershipIds: [office.id.BUDI, office.id.RINA] } })
        .expect(200);
      const summary = (await http().get(`/kpm/settings/events/${idOf('PAST_CHOSEN')}/feedback`).expect(200)).body;
      expect(summary.responses).toBe(2);
      expect((await rollCall('PAST_CHOSEN')).counts.audience).toBe(2);
    });

    it('P18.5-T5 AC-10 a past chosen event keeps an invitee who has since left; only the people a patch adds are checked', async () => {
      await db().collection('memberships').updateOne(
        { _id: new mongoose.Types.ObjectId(office.id.BUDI) }, { $set: { status: 'removed', removedAt: new Date('2026-09-01T02:00:00Z') } },
      );
      // Nobody answered PAST_CHOSEN, so its audience may change: Budi, gone, stays; Dimas, added, is checked and active.
      await patch('PAST_CHOSEN', { title: 'Still editable' }).expect(200);
      const kept = await patch('PAST_CHOSEN', {
        audience: { issuer: 'kpm', scope: 'select_agents', inviteeMembershipIds: [office.id.RINA, office.id.BUDI, office.id.DIMAS] },
      }).expect(200);
      expect(kept.body.audience.inviteeMembershipIds).toEqual([office.id.RINA, office.id.BUDI, office.id.DIMAS]);
      // Adding somebody who has left is refused; adding nobody new checks nobody.
      await patch('PAST_CHOSEN', {
        audience: { issuer: 'kpm', scope: 'select_agents', inviteeMembershipIds: [office.id.RINA, office.id.LEFT] },
      }).expect(404);
      // Under a new scope every invitee is checked: Rina leads nobody, so not as a chosen leader.
      await patch('PAST_CHOSEN', {
        audience: { issuer: 'kpm', scope: 'select_leaders', inviteeMembershipIds: [office.id.RINA] },
      }).expect(400);
    });

    it('P18.5-T5 AC-9 an invitee id that is not an id is 400, not a server fault; a location link must be a web address', async () => {
      const make = (over: Record<string, unknown>) => http().post('/kpm/settings/events').send({
        code: 'CHECKED', typeCode: 'TRAINING', title: 'Checked', startsAt: '2026-10-01T02:00:00Z', endsAt: '2026-10-01T04:00:00Z',
        audience: { issuer: 'kpm', scope: 'all_agents' }, ...over,
      });
      as('OWNER');
      const bad = await make({ audience: { issuer: 'kpm', scope: 'select_agents', inviteeMembershipIds: ['not-an-id'] } }).expect(400);
      expect(bad.body.error.code).toBe('VALIDATION_FAILED');
      for (const locationUrl of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://files.example.test/x', 'meet.example.test']) {
        const res = await make({ locationUrl }).expect(400);
        expect([locationUrl, res.body.error.details.violations]).toEqual([locationUrl, ['locationUrl must be a web address starting with http:// or https://.']]);
      }
      await make({ locationUrl: 'HTTPS://meet.example.test/x' }).expect(201);
      await patch('UPCOMING', { locationUrl: 'javascript:alert(1)' }).expect(400);
    });

    it('P18.5-T5 AC-5 three taps at once write one RSVP, one claim, one cancellation — and one audit row each', async () => {
      as('RINA');
      await Promise.all([1, 2, 3].map(() => http().post(`/events/${idOf('UPCOMING')}/rsvp`).expect(201)));
      await Promise.all([1, 2, 3].map(() => http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201)));
      expect(await db().collection('eventRsvps').countDocuments({ membershipId: office.id.RINA })).toBe(2);
      await Promise.all([1, 2, 3].map(() => http().post(`/events/${idOf('UPCOMING')}/rsvp/cancel`).expect(201)));
      const audits = await db().collection('auditLog').find({ targetMembershipId: office.id.RINA }).toArray();
      expect(audits.map((a) => a.action).sort()).toEqual(['event.attendance_claimed', 'event.rsvp', 'event.rsvp_cancelled']);
      expect(audits.every((a) => typeof a.targetId === 'string' && a.targetId.length === 24)).toBe(true);
    });

    it('P18.5-T6 AC-5 the summary orders by score, then by name — whatever order the answers came in', async () => {
      for (const who of ['SARI', 'INDAH', 'BUDI'] as const) {
        as(who);
        await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201);
        await http().post(`/events/${idOf('PAST_ALL')}/feedback`).send({ score: 8 }).expect(201);
      }
      as('OWNER');
      const summary = (await http().get(`/kpm/settings/events/${idOf('PAST_ALL')}/feedback`).expect(200)).body;
      expect(summary.rows.map((r: { name: string }) => r.name)).toEqual(['Budi Santoso', 'Indah Permatasari', 'Sari Puspita']);
    });

    it('P18.5-T5 AC-7 the refusal of one’s own row names the membership and none of OD-39’s words', async () => {
      as('OWNER');
      const res = await http().put(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`)
        .send({ entries: [{ membershipId: office.id.OWNER, attended: true }] }).expect(400);
      expect(res.body.error).toMatchObject({ code: 'EVENT_ATTENDANCE_SELF', details: { membershipId: office.id.OWNER } });
      expect(res.body.error.message).not.toMatch(/office|KPM|reports to|tagged to|untagged|unassigned/i);
    });

    it('P18.5-T5 AC-2 a Super Admin outside a support session is refused every settings read: no office', async () => {
      session.current = SA;
      for (const path of [
        '/kpm/settings/events', '/kpm/settings/events/types', '/kpm/settings/events/invitees',
        `/kpm/settings/events/${idOf('PAST_ALL')}/attendance`, `/kpm/settings/events/${idOf('PAST_ALL')}/feedback`,
      ]) {
        const res = await http().get(path);
        expect([path, res.status, res.body.error?.code]).toEqual([path, 403, 'TENANT_NO_MEMBERSHIP']);
      }
    });

    it('P18.5-T5 AC-3 a re-parent after the start: the single read and the list agree on who led then', async () => {
      // Dodi has no edge of his own (older than the history); on 1 September he moved from Lukas to Nina.
      await db().collection('membershipHistory').insertOne({
        kpmId: office.as('OWNER').kpmId, membershipId: office.id.DODI, eventType: 're_parented',
        fromLeaderId: office.id.LUKAS, toLeaderId: office.id.NINA,
        validFrom: new Date('2026-09-01T02:00:00Z'), validTo: null, deletedAt: null,
      });
      as('LUKAS');
      // On 10 August Lukas led Dodi (Tari was Dewi's): the leaders' event is his, read alone or in the list.
      await http().get(`/events/${idOf('PAST_LEADERS')}`).expect(200);
      expect(await codesOf('LUKAS')).toContain('PAST_LEADERS');
      const call = await rollCall('PAST_LEADERS');
      expect(rowOf(call, 'LUKAS')).toBeDefined();
    });
  });

  /**
   * **The member's and the roll call's refusals, in Bahasa Indonesia** (P18.98-T5 AC-7): the same code and details as
   * in English, the words the reader's — a refusal's message and every field sentence in `details.violations`.
   */
  describe('P18.98-T5 AC-7 the events’ refusals in Indonesian', () => {
    it('P18.98-T5 AC-7 one’s own row, before the end and a malformed roll call: the codes as in English, the words Indonesian', async () => {
      as('OWNER');
      const own = await http().put(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`).set(...IN_INDONESIAN)
        .send({ entries: [{ membershipId: office.id.OWNER, attended: true }] }).expect(400);
      expect(own.body.error).toMatchObject({
        code: 'EVENT_ATTENDANCE_SELF',
        message: 'Tidak ada yang mengonfirmasi kehadirannya sendiri. Administrator lain yang mengonfirmasi kehadiran Anda.',
        details: { membershipId: office.id.OWNER },
      });
      const early = await http().put(`/kpm/settings/events/${idOf('UPCOMING')}/attendance`).set(...IN_INDONESIAN)
        .send({ entries: [{ membershipId: office.id.RINA, attended: true }] }).expect(409);
      expect(early.body.error).toMatchObject({ code: 'EVENT_NOT_ENDED', message: 'Kehadiran dikonfirmasi setelah event berakhir.' });
      const malformed = await http().put(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`).set(...IN_INDONESIAN)
        .send({ entries: [
          { membershipId: office.id.RINA, attended: 'yes' }, { membershipId: office.id.BUDI, attended: true, note: 'x' },
        ] }).expect(400);
      const violations = ['entries[0].attended harus true, false, atau null.', 'properti entries[1].note tidak dikenal'];
      expect(malformed.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: violations.join('; '), details: { violations } });
      // A field the pipe refuses before the service reads the body is Indonesian too (`common/validation`).
      const extra = await http().put(`/kpm/settings/events/${idOf('PAST_ALL')}/attendance`).set(...IN_INDONESIAN)
        .send({ entries: [{ membershipId: office.id.RINA, attended: true }], extra: 1 }).expect(400);
      expect(extra.body.error.details.violations).toEqual(['properti extra tidak dikenal']);
    });

    it('P18.98-T5 AC-7 the answer: not ended, not attended, a score out of range and a second submit, in Indonesian', async () => {
      as('RINA');
      const say = async (key: EventKey, body: Record<string, unknown>, status: number) =>
        (await http().post(`/events/${idOf(key)}/feedback`).set(...IN_INDONESIAN).send(body).expect(status)).body.error;
      expect(await say('UPCOMING', { score: 9 }, 409)).toMatchObject({ code: 'EVENT_NOT_ENDED', message: 'Event ini belum berakhir.' });
      expect(await say('PAST_ALL', { score: 9 }, 409)).toMatchObject({
        code: 'EVENT_NOT_ATTENDED',
        message: 'Masukan hanya dikumpulkan dari orang yang ikut atau menyatakan hadir di event ini.',
      });
      await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201);
      expect(await say('PAST_ALL', { score: 11 }, 400)).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'score harus berupa bilangan bulat dari 0 sampai 10.',
        details: { violations: ['score harus berupa bilangan bulat dari 0 sampai 10.'] },
      });
      expect(await say('PAST_ALL', {}, 400)).toMatchObject({ details: { violations: ['score wajib diisi.'] } });
      await http().post(`/events/${idOf('PAST_ALL')}/feedback`).send({ score: 9 }).expect(201);
      expect(await say('PAST_ALL', { score: 9 }, 409)).toMatchObject({
        code: 'EVENT_FEEDBACK_ALREADY_SUBMITTED', message: 'Anda sudah memberikan masukan untuk event ini.',
      });
      // The RSVP once the event has ended, and the same refusal in English, unchanged.
      const closed = await http().post(`/events/${idOf('PAST_ALL')}/rsvp`).set(...IN_INDONESIAN).expect(409);
      expect(closed.body.error).toMatchObject({ code: 'EVENT_RSVP_CLOSED', message: 'Event ini sudah berakhir, jadi RSVP-nya ditutup.' });
      expect((await http().post(`/events/${idOf('PAST_ALL')}/rsvp`).expect(409)).body.error.message)
        .toBe('This event has ended, so its RSVP is closed.');
    });

    it('P18.98-T5 AC-7 an answered event moved into the future is refused in Indonesian, its details as in English', async () => {
      as('RINA');
      await http().post(`/events/${idOf('PAST_ALL')}/attendance/claim`).expect(201);
      as('OWNER');
      const res = await http().patch(`/kpm/settings/events/${idOf('PAST_ALL')}`).set(...IN_INDONESIAN)
        .send({ endsAt: '2027-01-01T02:00:00Z' }).expect(409);
      expect(res.body.error).toMatchObject({
        code: 'EVENT_HAS_RESPONSES',
        message: 'Sudah ada yang menanggapi event ini, jadi waktu mulai, audiens, dan waktu selesai di masa depan tidak '
          + 'dapat diubah. Tambahkan event baru sebagai gantinya.',
        details: { field: 'dates', changed: ['endsAt'] },
      });
    });
  });
});
