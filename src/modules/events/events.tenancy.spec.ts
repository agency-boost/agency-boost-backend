import { INestApplication } from '@nestjs/common';
import mongoose from 'mongoose';
import request from 'supertest';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { session } from '../../../test/http-permissions';
import { ROSTER_NOW } from '../../../test/coaching-office';
import { buildEventsOffice, eventsApp, KPM_A, KPM_B, type EventsOffice } from '../../../test/events-office';

/**
 * **Isolation** (invariant §1; P18.5-T5 AC-1, AC-9; P18.5-T6 AC-1; `ROUTE_MODULE['/events']`): 0417 against 0555,
 * **on every events route**, both ways. A member of one office addressing the other's event — the field routes, the
 * roll call, its save, the *Feedback Summary*, and the settings writes — is answered `404 NOT_FOUND`, the answer an
 * event that is not there gives, and nothing of the other office is read or written. The lists hold the reader's
 * own office alone. The two new repositories refuse a context with no office at all.
 */
describe('events, isolated (invariant §1)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: EventsOffice;
  const db = () => mongoose.connection.db!;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildEventsOffice(wired);
    app = await eventsApp(wired);
    // Something of each office's to leave untouched: an RSVP, a claim, a confirmation and an answer.
    session.current = office.as('RINA');
    await http().post(`/events/${office.event.PAST_ALL.id}/attendance/claim`).expect(201);
    await http().post(`/events/${office.event.PAST_ALL.id}/feedback`).send({ score: 9 }).expect(201);
    session.current = office.as('B_AGENT');
    await http().post(`/events/${office.event.B_PAST.id}/attendance/claim`).expect(201);
    await http().post(`/events/${office.event.B_PAST.id}/feedback`).send({ score: 3 }).expect(201);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  /** Every events route that names an event, aimed at `id`. */
  const routes = (id: string, someone: string) => [
    ['GET one event', () => http().get(`/events/${id}`)],
    ['POST an RSVP', () => http().post(`/events/${id}/rsvp`)],
    ['POST a cancellation', () => http().post(`/events/${id}/rsvp/cancel`)],
    ['POST a claim', () => http().post(`/events/${id}/attendance/claim`)],
    ['POST an answer', () => http().post(`/events/${id}/feedback`).send({ score: 9 })],
    ['GET the roll call', () => http().get(`/kpm/settings/events/${id}/attendance`)],
    ['PUT the roll call', () => http().put(`/kpm/settings/events/${id}/attendance`).send({ entries: [{ membershipId: someone, attended: true }] })],
    ['GET the summary', () => http().get(`/kpm/settings/events/${id}/feedback`)],
    ['PATCH the event', () => http().patch(`/kpm/settings/events/${id}`).send({ title: 'Mine now' })],
    ['POST its archive', () => http().post(`/kpm/settings/events/${id}/archive`).send({})],
    ['POST its restore', () => http().post(`/kpm/settings/events/${id}/restore`).send({})],
  ] as const;

  const everything = async () => ({
    events: await db().collection('events').find({}).sort({ _id: 1 }).toArray(),
    rsvps: await db().collection('eventRsvps').find({}).sort({ _id: 1 }).toArray(),
    feedback: await db().collection('eventFeedback').find({}).sort({ _id: 1 }).toArray(),
    audit: await db().collection('auditLog').countDocuments(),
  });

  it.each([['0555', '0417'], ['0417', '0555']] as const)(
    'P18.5-T5 AC-9 %s’s Owner is answered 404 on every events route of %s’s event, and nothing is written',
    async (reader, other) => {
      const before = await everything();
      session.current = reader === '0417' ? office.as('OWNER') : office.as('B_OWNER');
      const target = other === '0417' ? office.event.PAST_ALL : office.event.B_PAST;
      const someone = other === '0417' ? office.id.RINA : office.id.B_AGENT;
      for (const [name, call] of routes(target.id, someone)) {
        const res = await call();
        expect([name, res.status, res.body.error?.code]).toEqual([name, 404, 'NOT_FOUND']);
      }
      expect(await everything()).toEqual(before);
    },
  );

  it('P18.5-T5 AC-9 an agent of 0555 meets 404 on every field route of 0417’s event; 0417’s agent likewise on 0555’s', async () => {
    const before = await everything();
    for (const [who, target] of [['B_AGENT', office.event.PAST_ALL], ['RINA', office.event.B_PAST]] as const) {
      session.current = office.as(who);
      for (const [name, call] of routes(target.id, office.id.RINA).slice(0, 5)) {
        const res = await call();
        expect([who, name, res.status, res.body.error?.code]).toEqual([who, name, 404, 'NOT_FOUND']);
      }
    }
    expect(await everything()).toEqual(before);
  });

  it('P18.5-T5 AC-9 a roll-call save naming another office’s member is 404, and writes nothing', async () => {
    const before = await everything();
    session.current = office.as('OWNER');
    await http().put(`/kpm/settings/events/${office.event.PAST_ALL.id}/attendance`)
      .send({ entries: [{ membershipId: office.id.B_AGENT, attended: true }] }).expect(404);
    expect(await everything()).toEqual(before);
  });

  it.each([['0417', KPM_A], ['0555', KPM_B]] as const)('P18.5-T5 AC-9 %s’s lists are its own office’s alone', async (side, kpmId) => {
    session.current = side === '0417' ? office.as('OWNER') : office.as('B_OWNER');
    const own = (await db().collection('events').find({ kpmId, status: 'active', deletedAt: null }).toArray()).map((e) => String(e._id));
    const field = (await http().get('/events').expect(200)).body.events.map((e: { id: string }) => e.id);
    const settings = (await http().get('/kpm/settings/events').expect(200)).body.map((e: { id: string }) => e.id);
    const people = (await http().get('/kpm/settings/events/invitees').expect(200)).body.people.map((p: { membershipId: string }) => p.membershipId);
    expect(settings.sort()).toEqual(own.sort());
    expect(field.every((id: string) => own.includes(id))).toBe(true);
    const members = (await db().collection('memberships').find({ kpmId, status: 'active' }).toArray()).map((m) => String(m._id));
    expect(people.sort()).toEqual(members.sort());
    // 0555's summary reads 0555's answer alone, and the reverse.
    const summary = (await http().get(`/kpm/settings/events/${side === '0417' ? office.event.PAST_ALL.id : office.event.B_PAST.id}/feedback`)
      .expect(200)).body;
    expect(summary.rows.map((r: { name: string }) => r.name)).toEqual([side === '0417' ? 'Rina Wijaya' : 'Bayu Saputra']);
  });

  it('P18.5-T5 AC-9 the two new repositories refuse a read or a write with no office in the context', async () => {
    const nobody = RequestContext.platform('root');
    await expect(wired.eventRsvps.find(nobody, {})).rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(wired.eventFeedback.find(nobody, {})).rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(wired.eventRsvps.upsertOne(nobody, { eventId: 'x', membershipId: 'y' }, { $set: { claimedAt: new Date() } }))
      .rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(wired.eventFeedback.create(nobody, { eventId: 'x', membershipId: 'y', score: 1, submittedAt: new Date() }))
      .rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('P18.5-T5 AC-8 the readings port answers nothing for another office’s event', async () => {
    expect(await wired.eventReadings.attendance(office.as('OWNER'), office.event.B_PAST.id)).toBeNull();
    expect(await wired.eventReadings.feedbackSummary(office.as('B_OWNER'), office.event.PAST_ALL.id)).toBeNull();
    const between = await wired.eventReadings.eventsBetween(office.as('B_OWNER'), new Date('2026-01-01'), new Date('2027-01-01'));
    expect(between.map((e) => e.code)).toEqual(['B_PAST']);
  });
});
