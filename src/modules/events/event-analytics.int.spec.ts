import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { MemberNames } from '@/modules/org/member-names.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { ROSTER_NOW } from '../../../test/coaching-office';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildEventsOffice, KPM_A, type EventKey, type EventsOffice, type EventsWho } from '../../../test/events-office';
import { productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { EventAnalyticsController } from './event-analytics.controller';
import { EventAnalytics, dayCount, periodOf } from './event-analytics.service';
import { checkDeclineReason } from './event-guest.service';
import { EventRepository, EventTypeRepository } from './event.repository';

/**
 * **Advanced analytics › *Event*** (P19.25-T1, T2; ADR-0281) on the events office (`test/events-office.ts`; now Mon 14 Sep
 * 2026, 10:00 Jakarta), with the roll call taken for *PAST_ALL* and *PAST_LEADERS*, not for *PAST_CHOSEN* or *ENDS_NOW*;
 * an informal group round AGUS; DODI a test account; and the answers to *UPCOMING*'s invitation.
 */
describe('P19.25-T1, T2 Advanced analytics › Event — Kehadiran and Feedback, on real rows', () => {
  let wired: ReturnType<typeof configModule>;
  let office: EventsOffice;
  let analytics: EventAnalytics;
  let app: INestApplication;
  let groupId: string;
  const db = () => mongoose.connection.db!;
  const oid = (id: string) => new mongoose.Types.ObjectId(id);
  const idOf = (key: EventKey) => office.event[key].id;
  const mark = (key: EventKey, who: EventsWho, attended: boolean | null, rsvp: 'going' | null = 'going') => ({
    kpmId: KPM_A, eventId: idOf(key), membershipId: office.id[who], rsvpStatus: rsvp, rsvpAt: null,
    cancelledAt: null, claimedAt: null, declineReason: null, confirmedAttended: attended,
    confirmedByMembershipId: attended === null ? null : office.id.ADMIN, confirmedAt: attended === null ? null : ROSTER_NOW,
    deletedAt: null,
  });
  const answer = (key: EventKey, who: EventsWho, score: number, why = `${who} why`, improve = '') => ({
    kpmId: KPM_A, eventId: idOf(key), membershipId: office.id[who], score, why, improve,
    submittedAt: new Date('2026-08-25T02:00:00Z'), deletedAt: null,
  });
  const coreLeader = (who: EventsWho) => {
    const member = office.as(who);
    return new RequestContext(member.userId, 'none', { ...member.membership!, isCoreLeader: true });
  };
  const superAdminIn = (kpmId = KPM_A) => RequestContext.superAdminInKpm(RequestContext.platform('u-root'), kpmId);

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildEventsOffice(wired);
    analytics = new EventAnalytics(
      new EventRepository(mongoose.model('Event') as never),
      new EventTypeRepository(mongoose.model('EventType') as never),
      wired.eventRsvps, wired.eventFeedback, wired.eventReadings, wired.eventAudiences, wired.officeGroups,
      wired.memberships, new MemberNames(wired.memberships, wired.users as never),
      new TenantDay(wired.kpms as never, wired.clock), wired.clock,
    );
    // DODI is a test account: counted nowhere, listed nowhere — even confirmed attended with a score.
    await db().collection('memberships').updateOne({ _id: oid(office.id.DODI) }, { $set: { testAccount: true } });
    // An informal group round AGUS's AB group; OWNER, ADMIN and PEER_AB are in none (*Tanpa group*).
    const inserted = await db().collection('groups').insertOne({
      kpmId: KPM_A, name: 'Top Producers 2026', leaderMembershipIds: [office.id.AGUS], status: 'active', archivedAt: null,
      createdByMembershipId: null, deletedAt: null,
    });
    groupId = String(inserted.insertedId);
    await db().collection('memberships').updateOne({ _id: oid(office.id.AGUS) }, { $set: { groupIds: [groupId] } });

    await db().collection('eventRsvps').insertMany([
      mark('PAST_ALL', 'RINA', true), mark('PAST_ALL', 'BUDI', true), mark('PAST_ALL', 'PEER_AGENT', true),
      mark('PAST_ALL', 'INDAH', null), mark('PAST_ALL', 'DIMAS', false), mark('PAST_ALL', 'DODI', true),
      mark('PAST_LEADERS', 'SARI', true),
      // A claim and an RSVP record nothing: PAST_CHOSEN's roll call has not been taken.
      { ...mark('PAST_CHOSEN', 'RINA', null), claimedAt: ROSTER_NOW },
    ]);
    await db().collection('eventFeedback').insertMany([
      answer('PAST_ALL', 'RINA', 10, 'Materinya langsung bisa dipakai.', 'Mulai tepat waktu.'),
      answer('PAST_ALL', 'BUDI', 6, '  ', 'Kurangi sambutan.'),
      answer('PAST_ALL', 'PEER_AGENT', 9),
      // Not counted: awaiting the roll call, and a test account.
      answer('PAST_ALL', 'INDAH', 0), answer('PAST_ALL', 'DODI', 0),
      answer('PAST_LEADERS', 'SARI', 8, 'Diskusi leader bermanfaat.'),
      answer('PAST_CHOSEN', 'RINA', 9),
    ]);
    // The invitation to UPCOMING: RINA comes, BUDI does not and says why; everybody else has not answered.
    await wired.eventGuests.rsvp(office.as('RINA'), idOf('UPCOMING'));
    await wired.eventGuests.cancelRsvp(office.as('BUDI'), idOf('UPCOMING'), { reason: '  ada janji nasabah ' });

    const moduleRef = await Test.createTestingModule({
      controllers: [EventAnalyticsController],
      providers: [{ provide: EventAnalytics, useValue: analytics }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await stopMongo();
  });

  // ------------------------------------------------------------------------------------------------ Kehadiran

  it('P19.25-T1 AC-1 the period: the year to date, or a month no later than this one', async () => {
    const ytd = await analytics.attendance(office.as('OWNER'), {});
    expect(ytd.period).toEqual({ kind: 'ytd', month: null, from: '2026-01-01', to: '2026-09-14' });
    expect(ytd.currentMonth).toBe('2026-09');
    const august = await analytics.attendance(office.as('OWNER'), { month: '2026-08' });
    expect(august.period).toEqual({ kind: 'month', month: '2026-08', from: '2026-08-01', to: '2026-08-31' });
    expect(august.past.map((e) => e.title)).toEqual(['PAST ALL', 'PAST CHOSEN', 'PAST LEADERS']);
    expect(periodOf('2026-09', { today: '2026-09-14', month: '2026-09' })).toMatchObject({ from: '2026-09-01', to: '2026-09-14' });
    for (const bad of ['2026-13', '2026-10', 'September']) {
      try {
        await analytics.attendance(office.as('OWNER'), { month: bad });
        throw new Error(`expected a refusal of ${bad}`);
      } catch (err) {
        expect([bad, (err as DomainException).getStatus()]).toEqual([bad, 400]);
      }
    }
  });

  it('P19.25-T1 AC-3 Sudah lewat: the period’s ended events, newest first; an archived one never; unrecorded ones in no average', async () => {
    const view = await analytics.attendance(office.as('OWNER'), {});
    expect(view.past.map((e) => [e.title, e.recorded])).toEqual([
      ['ENDS NOW', false], ['PAST ALL', true], ['PAST CHOSEN', false], ['PAST LEADERS', true],
    ]);
    const roll = await wired.eventRollCalls.rollCall(office.as('OWNER'), idOf('PAST_ALL'));
    // The test account is in no roll call either (ADR-0267 §1).
    expect(roll.people.map((p) => p.membershipId)).not.toContain(office.id.DODI);
    const pastAll = view.past.find((e) => e.title === 'PAST ALL')!;
    expect(pastAll.figure).toMatchObject({ hadir: 3, expected: roll.counts.audience, events: 1 });
    expect(pastAll.type).toEqual({ code: 'PRODUCT_LAUNCH', label: expect.any(String) });
    expect(view.past.find((e) => e.title === 'PAST CHOSEN')!.figure).toBeNull();
    expect(view.recordedEvents).toBe(2);
    expect(view.recentEvents).toBe(2);
  });

  it('P19.25-T1 AC-2 the navy card: the average hadir per event of the expected, the share from the sums', async () => {
    const view = await analytics.attendance(office.as('OWNER'), {});
    const all = view.past.find((e) => e.title === 'PAST ALL')!.figure!;
    const leaders = view.past.find((e) => e.title === 'PAST LEADERS')!.figure!;
    const expected = all.expected! + leaders.expected!;
    expect(view.summary).toEqual({
      hadir: 2, expected: Math.round(expected / 2), pct: Math.floor((200 * 4 + expected) / (2 * expected)),
      tone: 'red', events: 2,
    });
    // Seventeen active members, the test account never counted.
    expect(view.members).toBe(16);
  });

  it('P19.25-T1 AC-2, AC-4 a tile and a card per informal group, then Tanpa group; AB groups inside; recent and each event', async () => {
    const view = await analytics.attendance(office.as('OWNER'), {});
    expect(view.groups.map((g) => [g.key, g.group?.name ?? null, g.people])).toEqual([
      [groupId, 'Top Producers 2026', 11], ['none', null, 5],
    ]);
    const top = view.groups[0];
    expect(top.leaders.map((l) => l.membershipId)).toEqual([office.id.AGUS]);
    const iAll = view.past.findIndex((e) => e.title === 'PAST ALL');
    const iChosen = view.past.findIndex((e) => e.title === 'PAST CHOSEN');
    // At PAST_ALL: RINA and BUDI of the ten expected (LATE joined later; DODI is a test account): 20%, red.
    expect(top.byEvent[iAll]).toEqual({ hadir: 2, expected: 10, pct: 20, tone: 'red', events: 1 });
    expect(top.byEvent[iChosen]).toBeNull();
    // At PAST_LEADERS: SARI and AGUS were the group's leaders then; SARI came.
    const iLeaders = view.past.findIndex((e) => e.title === 'PAST LEADERS');
    expect(top.byEvent[iLeaders]).toMatchObject({ hadir: 1 });
    // Rata-rata · 2 event terakhir, to one decimal: (2 + 1) / 2.
    expect(top.recent).toMatchObject({ hadir: 1.5, events: 2 });
    expect(top.period).toMatchObject({ hadir: 2, events: 2 });
    expect(top.abGroups.map((a) => [a.ab.membershipId, a.ab.role, a.people])).toEqual([[office.id.AGUS, 'ab', 11]]);
    const none = view.groups[1];
    expect(none.byEvent[iAll]).toMatchObject({ hadir: 1 });
    expect(none.abGroups.map((a) => a.ab.membershipId).sort()).toEqual([office.id.OWNER, office.id.ADMIN, office.id.PEER_AB].sort());
  });

  it('P19.25-T1 AC-5 Per orang: every member’s marks, Hadir x dari n, Terakhir hadir, under half; no test account', async () => {
    const view = await analytics.attendance(office.as('OWNER'), {});
    const of = (who: EventsWho) => view.people.find((p) => p.membershipId === office.id[who]);
    expect(of('DODI')).toBeUndefined();
    // ENDS_NOW ?, PAST_ALL, PAST_CHOSEN ?, PAST_LEADERS.
    expect(of('RINA')).toMatchObject({ marks: '?1?.', attended: 1, expected: 1, pct: 100, tone: 'green', current: true, underHalf: false });
    // PAST_CHOSEN was for RINA and BUDI only: no mark for anybody else.
    expect(of('DIMAS')).toMatchObject({ marks: '?0..', attended: 0, expected: 1, lastEventId: null, underHalf: true, stale: false });
    expect(of('INDAH')).toMatchObject({ marks: '?0..', attended: 0 });
    expect(of('SARI')).toMatchObject({ marks: '?0.1', attended: 1, expected: 2, lastEventId: idOf('PAST_LEADERS') });
    // LATE joined on 1 September: expected only at ENDS_NOW, which is not recorded.
    expect(of('LATE')).toMatchObject({ marks: '?...', expected: 0, pct: null, stale: false });
    expect(of('RINA')!.name).toBe('Rina Wijaya');
    expect(of('AGUS')!.role).toBe('ab');
    expect(of('SARI')!.role).toBe('aab');
  });

  it('P19.25-T1 AC-3 Akan datang: the events not ended, soonest first, with Akan ikut / Tidak ikut (reason) / Belum jawab', async () => {
    const view = await analytics.attendance(office.as('OWNER'), {});
    expect(view.upcoming.map((e) => [e.title, e.running, e.daysUntil])).toEqual([['RUNNING LEADERS', true, 0], ['UPCOMING', false, 5]]);
    const upcoming = view.upcoming[1];
    expect(upcoming.going).toEqual([office.id.RINA]);
    expect(upcoming.declined).toEqual([{ membershipId: office.id.BUDI, reason: 'ada janji nasabah' }]);
    expect(upcoming.pending).toContain(office.id.LATE);
    expect(upcoming.pending).not.toContain(office.id.DODI);
    expect(upcoming.pending).not.toContain(office.id.RINA);
    expect(upcoming.pending.length + upcoming.going.length + upcoming.declined.length).toBe(16);
    expect(dayCount('2026-09-14', '2026-09-15')).toBe(1);
    expect(dayCount('2026-12-31', '2027-01-02')).toBe(2);
  });

  // ------------------------------------------------------------------------------------------------- Feedback

  it('P19.25-T2 AC-1, AC-2 Feedback: NPS over the answers of those hadir, lowest first, words tagged Leader / Agent', async () => {
    const view = await analytics.feedbackView(office.as('OWNER'), {});
    expect(view.rows.map((r) => [r.title, r.nps])).toEqual([
      ['PAST LEADERS', 0], ['PAST ALL', 33], ['ENDS NOW', null], ['PAST CHOSEN', null],
    ]);
    const all = view.rows.find((r) => r.title === 'PAST ALL')!;
    expect(all).toMatchObject({
      answers: 3, average: 8.3, few: false, tone: 'green', shares: { promoter: 67, passive: 0, detractor: 33 }, recorded: true,
    });
    expect(all.why).toEqual([
      { role: 'agent', text: 'Materinya langsung bisa dipakai.' }, { role: 'agent', text: 'PEER_AGENT why' },
    ]);
    expect(all.improve).toEqual([{ role: 'agent', text: 'Mulai tepat waktu.' }, { role: 'agent', text: 'Kurangi sambutan.' }]);
    const leaders = view.rows.find((r) => r.title === 'PAST LEADERS')!;
    expect(leaders).toMatchObject({ answers: 1, few: true, tone: 'yellow' });
    expect(leaders.why).toEqual([{ role: 'leader', text: 'Diskusi leader bermanfaat.' }]);
    // PAST_CHOSEN's answer waits for its roll call.
    expect(view.rows.find((r) => r.title === 'PAST CHOSEN')).toMatchObject({ answers: 0, recorded: false });
    // Pooled 10, 6, 9, 8: two promoters and one detractor of four; 4 of the 4 hadir answered.
    expect(view.summary).toMatchObject({ nps: 25, average: 8.3, answers: 4, hadir: 4, share: 100 });
    expect(view.events).toBe(4);
  });

  it('P19.25-T2 AC-2 no respondent is named or identified anywhere in the answer', async () => {
    const wire = JSON.stringify(await analytics.feedbackView(office.as('OWNER'), {}));
    for (const who of ['RINA', 'BUDI', 'PEER_AGENT', 'SARI', 'INDAH', 'DODI'] as const) {
      expect([who, wire.includes(office.id[who])]).toEqual([who, false]);
    }
    expect(wire).not.toContain('Rina');
    expect(wire).not.toContain('INDAH why');
  });

  // ------------------------------------------------------------------------------------------- who and where

  it('P19.25-T1 AC-1 cross-tenant: KPM B reads only its own events and people; none of KPM A’s', async () => {
    const view = await analytics.attendance(office.as('B_OWNER'), {});
    expect(view.past.map((e) => e.title)).toEqual(['B PAST']);
    expect(view.people.map((p) => p.membershipId)).not.toContain(office.id.RINA);
    expect(view.upcoming).toEqual([]);
    const feedback = await analytics.feedbackView(office.as('B_OWNER'), {});
    expect(feedback.summary.answers).toBe(0);
    expect(JSON.stringify(feedback)).not.toContain(idOf('PAST_ALL'));
  });

  describe('P19.25-T1 AC-1 permissions over HTTP, per role', () => {
    const cases: [string, () => RequestContext, number][] = [
      ['the Owner', () => office.as('OWNER'), 200],
      ['an Admin', () => office.as('ADMIN'), 200],
      ['a core leader', () => coreLeader('AGUS'), 200],
      ['the Super Admin inside the KPM', () => superAdminIn(), 200],
      ['an AB who is not a core leader', () => office.as('PEER_AB'), 404],
      ['an AAB who is not a core leader', () => office.as('SARI'), 404],
      ['an Agent', () => office.as('RINA'), 403],
      ['a Super Admin in no KPM', () => RequestContext.platform('u-root'), 403],
    ];
    it.each(cases)('%s reads Kehadiran and Feedback: %i', async (_who, ctx, status) => {
      session.current = ctx();
      for (const path of ['/kpm/advanced-analytics/events/attendance', '/kpm/advanced-analytics/events/feedback']) {
        const res = await request(app.getHttpServer()).get(path);
        expect([path, res.status]).toEqual([path, status]);
      }
    });
    it('a core leader reads the whole KPM, and may take the roll call; a read-only support session may not', async () => {
      session.current = coreLeader('AGUS');
      const res = await request(app.getHttpServer()).get('/kpm/advanced-analytics/events/attendance');
      expect(res.body.canRecord).toBe(true);
      expect(res.body.people.length).toBe(16);
      session.current = office.supported('OWNER');
      const read = await request(app.getHttpServer()).get('/kpm/advanced-analytics/events/attendance');
      expect(read.status).toBe(200);
      expect(read.body.canRecord).toBe(false);
    });
    it('validation: a malformed month, a later month and an unknown parameter are 400', async () => {
      session.current = office.as('OWNER');
      for (const q of ['month=2026-13', 'month=2026-10', 'ab=x']) {
        const res = await request(app.getHttpServer()).get(`/kpm/advanced-analytics/events/feedback?${q}`);
        expect([q, res.status, res.body.error?.code]).toEqual([q, 400, 'VALIDATION_FAILED']);
      }
    });
  });
});

/**
 * ***Tidak ikut* with its reason** (P19.25-T1 AC-3; ADR-0281 §2): the member's answer to the invitation, read back on
 * their own event and by the office's *Akan datang*.
 */
describe('P19.25-T1 AC-3 Tidak ikut with a reason — the member’s answer to the invitation', () => {
  let wired: ReturnType<typeof configModule>;
  let office: EventsOffice;
  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildEventsOffice(wired);
  }, 120_000);
  afterAll(stopMongo);

  it('the reason is trimmed and read back; a new one replaces it; Ikut and taking the answer back clear it', async () => {
    const id = office.event.UPCOMING.id;
    let mine = await wired.eventGuests.cancelRsvp(office.as('INDAH'), id, { reason: '  Ada janji nasabah  ' });
    expect(mine.me).toMatchObject({ rsvp: 'cancelled', declineReason: 'Ada janji nasabah' });
    mine = await wired.eventGuests.cancelRsvp(office.as('INDAH'), id, { reason: 'Sakit' });
    expect(mine.me.declineReason).toBe('Sakit');
    mine = await wired.eventGuests.rsvp(office.as('INDAH'), id);
    expect(mine.me).toMatchObject({ rsvp: 'going', declineReason: null });
    mine = await wired.eventGuests.cancelRsvp(office.as('INDAH'), id, {});
    expect(mine.me).toMatchObject({ rsvp: 'cancelled', declineReason: null });
    await wired.eventGuests.cancelRsvp(office.as('INDAH'), id, { reason: 'Lagi di luar kota' });
    mine = await wired.eventGuests.withdrawRsvp(office.as('INDAH'), id);
    expect(mine.me).toMatchObject({ rsvp: null, declineReason: null });
  });

  it('no body at all — the call before P19.25-T1, or a JSON null — declines without a reason', async () => {
    const id = office.event.UPCOMING.id;
    let mine = await wired.eventGuests.cancelRsvp(office.as('AGUS'), id);
    expect(mine.me).toMatchObject({ rsvp: 'cancelled', declineReason: null });
    expect((await wired.eventGuests.rsvp(office.as('AGUS'), id)).me.rsvp).toBe('going');
    mine = await wired.eventGuests.cancelRsvp(office.as('AGUS'), id, null);
    expect(mine.me).toMatchObject({ rsvp: 'cancelled', declineReason: null });
    expect(checkDeclineReason(undefined)).toBeNull();
  });

  it('the audit row says a reason was given, never its words (PDP)', async () => {
    const id = office.event.UPCOMING.id;
    await wired.eventGuests.cancelRsvp(office.as('DIMAS'), id, { reason: 'Ke rumah sakit' });
    const rows = await mongoose.connection.db!.collection('auditLog')
      .find({ action: 'event.rsvp_cancelled', targetMembershipId: office.id.DIMAS }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].after).toMatchObject({ rsvpStatus: 'cancelled', reasonGiven: true });
    expect(JSON.stringify(rows[0])).not.toContain('rumah sakit');
  });

  it('validation: a reason over 200 characters, a reason that is not text, an unknown field — 400, nothing written', async () => {
    const id = office.event.UPCOMING.id;
    for (const body of [{ reason: 'x'.repeat(201) }, { reason: 7 }, { why: 'x' }]) {
      try {
        await wired.eventGuests.cancelRsvp(office.as('SARI'), id, body);
        throw new Error('expected a refusal');
      } catch (err) {
        expect([JSON.stringify(body).slice(0, 20), (err as DomainException).getStatus()]).toEqual([JSON.stringify(body).slice(0, 20), 400]);
      }
    }
    const read = await wired.eventGuests.read(office.as('SARI'), id);
    expect(read.me.rsvp).toBeNull();
    // Exactly 200 is taken.
    const ok = await wired.eventGuests.cancelRsvp(office.as('SARI'), id, { reason: 'y'.repeat(200) });
    expect(ok.me.declineReason).toHaveLength(200);
  });

  it('refused once the event has ended, as every RSVP is', async () => {
    try {
      await wired.eventGuests.cancelRsvp(office.as('RINA'), office.event.PAST_ALL.id, { reason: 'x' });
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as DomainException).getStatus()).toBe(409);
    }
  });
});
