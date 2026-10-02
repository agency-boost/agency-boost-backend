import { INestApplication, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { FixedClock } from '@/common/clock/clock.port';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { CoachingController } from '@/modules/coaching/coaching.controller';
import { CoachingRosterService } from '@/modules/coaching/coaching-roster.service';
import { CoacheeService } from '@/modules/coaching/coachee.service';
import { CoachingSessionService } from '@/modules/coaching/coaching-session.service';
import {
  Notification, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from '@/modules/notifications/notification.schema';
import { NotificationRepository } from '@/modules/notifications/notification.repository';
import { NotificationService, TemplateRenderer } from '@/modules/notifications/notification.service';
import {
  NotificationChannel, NotificationChannelAdapter, NotificationTemplate, RenderedMessage, SendRequest,
} from '@/modules/notifications/notification.types';
import { SummaryController } from '@/modules/summary/summary.controller';
import { SummaryService } from '@/modules/summary/summary.service';
import { startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { buildCoachingOffice, KPM_A, ROSTER_NOW, type CoachingOffice, type Who } from '../../../test/coaching-office';
import { GoalController } from './goal.controller';
import { GoalService } from './goal.service';

type Doc = Record<string, unknown>;
const M = 1_000_000 * 100;

class PayloadRenderer extends TemplateRenderer {
  render(templateId: string, payload: Record<string, unknown>): RenderedMessage {
    return { subject: templateId, body: JSON.stringify(payload) };
  }
}

class RecordingAdapter extends NotificationChannelAdapter {
  sent: { to: SendRequest; rendered: RenderedMessage }[] = [];
  /** How many times a send was asked of it, whatever came of it. */
  calls = 0;
  /** While set, a send waits on it: a mail server that hangs, as the browser walk's did. */
  gate: Promise<void> | null = null;
  /** Once the gate opens, a send fails with this: a mail server that timed out. */
  refusal: Error | null = null;
  constructor(readonly channel: NotificationChannel) {
    super();
  }
  async send(to: SendRequest, rendered: RenderedMessage): Promise<void> {
    this.calls += 1;
    if (this.gate) await this.gate;
    if (this.refusal) throw this.refusal;
    this.sent.push({ to, rendered });
  }
}

/** Resolves with the promise's value, or with `'waited'` if it takes longer than `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'waited'> {
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<'waited'>((resolve) => { timer = setTimeout(() => resolve('waited'), ms); });
  try {
    return await Promise.race([promise, waited]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * **The Goal card's save, through a coaching session** — `PUT /goals/:period?for=&session=` (P11-T8 AC-4,
 * ADR-0075; `functional/coaching.md`, *The Goal card, and one notice per session*).
 *
 * Over HTTP, with the real `NotificationService` on the real collection and a recording adapter on each
 * channel, so what is counted is what reached the coachee's inbox and email — not whether a write
 * announced itself.
 */
describe('a goal saved through a coaching session (P11-T8)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  let inApp: RecordingAdapter;
  let email: RecordingAdapter;
  let notifications: NotificationService;
  const kept: Record<string, Doc[]> = {};
  const RESTORED = ['coachingSessions', 'goals'];

  const col = (name: string) => mongoose.connection.db!.collection(name);
  const http = () => request(app.getHttpServer());
  const as = (who: Who) => { session.current = office.as(who); };
  const id = (who: Who) => office.id[who];
  const userOf = async (who: Who) =>
    (await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id(who)) }))!.userId as string;
  const plan = (annualApeTargetMinor: number) => ({
    mode: 'direct', annualApeTargetMinor, savingsTargetMinor: 0, commissionRatePct: 0, monthsLeft: 4,
    apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30, closingRatePct: 30,
  });
  const put = (query: string, annual = 600 * M) => http().put(`/goals/2026?${query}`).send(plan(annual));
  const goalNotices = async (who: Who) => col('notifications')
    .find({ userId: await userOf(who), templateId: NotificationTemplate.GOAL_SET_BY_LEADER }).toArray();
  const goalVersion = async (who: Who) => (await col('goals').findOne({ membershipId: id(who) }))?.version ?? 0;
  const sent = (adapter: RecordingAdapter, templateId: string) => adapter.sent.filter((s) => s.to.templateId === templateId);
  /**
   * The coachee's goal notice once its email reaches `status`. Finalize releases the held email without
   * waiting for it (`announceFinalized`), so what the adapter did is read when it has done it, not when
   * the finalize answered.
   */
  async function emailReaches(who: Who, status: string): Promise<Doc> {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const [notice] = await goalNotices(who);
      if ((notice?.delivery as Record<string, { status: string }> | undefined)?.email?.status === status) return notice;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`The goal email never reached ${status}`);
  }

  async function started(coach: Who, coachee: Who): Promise<{ sessionId: string; version: number }> {
    as(coach);
    return (await http().post(`/coaching/coachees/${id(coachee)}/sessions`)).body;
  }

  async function finalize(sessionId: string, version: number) {
    const saved = (await http().put(`/coaching/sessions/${sessionId}`).send({
      version, lastWeekItems: [], actionItems: [{ text: 'Book two presentations', dueDate: '2026-09-20' }], tips: [],
    }).expect(200)).body;
    return (await http().post(`/coaching/sessions/${sessionId}/finalize`).send({ version: saved.version }).expect(200)).body;
  }

  beforeAll(async () => {
    await startMongo();
    inApp = new RecordingAdapter('in_app');
    email = new RecordingAdapter('email');
    const notificationModel = mongoose.model(Notification.name, NotificationSchema);
    notifications = new NotificationService(
      notificationModel as never,
      new NotificationRepository(notificationModel as never),
      mongoose.model(NotificationPreferences.name, NotificationPreferencesSchema) as never,
      new PayloadRenderer(),
      new FixedClock(ROSTER_NOW),
      [inApp, email],
    );
    wired = configModule(ROSTER_NOW, { notifications });
    office = await buildCoachingOffice(wired);
    await syncIndexes();
    for (const name of RESTORED) kept[name] = await col(name).find().toArray();

    const moduleRef = await Test.createTestingModule({
      controllers: [GoalController, CoachingController, SummaryController],
      providers: [
        { provide: GoalService, useValue: wired.goals },
        { provide: SummaryService, useValue: wired.summary },
        { provide: CoachingRosterService, useValue: wired.coachingRoster },
        { provide: CoacheeService, useValue: wired.coachee },
        { provide: CoachingSessionService, useValue: wired.coachingSession },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 120_000);

  beforeEach(async () => {
    (wired.clock as FixedClock).set(ROSTER_NOW);
    for (const name of RESTORED) {
      await col(name).deleteMany({});
      if (kept[name].length) await col(name).insertMany(kept[name].map((doc) => ({ ...doc })));
    }
    for (const name of ['notifications', 'notificationPreferences', 'auditLog']) await col(name).deleteMany({});
    for (const adapter of [inApp, email]) {
      adapter.sent.splice(0);
      Object.assign(adapter, { calls: 0, gate: null, refusal: null });
    }
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  it('P11-T8 AC-4 three saves in one session reach the coachee as one notice: in the app at once, by email at finalize, each carrying the third value', async () => {
    const s = await started('AGUS', 'INDAH');
    const query = `for=${id('INDAH')}&session=${s.sessionId}`;

    await put(query, 600 * M).expect(200);
    // Indah reads the first value…
    await col('notifications').updateMany({}, { $set: { readAt: ROSTER_NOW } });
    await put(query, 700 * M).expect(200);
    const third = await put(query, 800 * M).expect(200);
    expect(third.body).toMatchObject({ annualApeTargetMinor: 800 * M, savedByMembershipId: id('AGUS') });

    let notices = await goalNotices('INDAH');
    expect(notices).toHaveLength(1);
    // …and finds it unread again, saying the last value. A draft never finalized would send no email.
    expect(notices[0]).toMatchObject({
      coalesceKey: `${s.sessionId}:0`, readAt: null, membershipId: id('INDAH'),
      payload: { byName: 'Agus Salim', period: '2026', annualApeTargetMinor: 800 * M },
      delivery: { in_app: { status: 'sent' }, email: { status: 'held' } },
    });
    expect(sent(inApp, NotificationTemplate.GOAL_SET_BY_LEADER)).toHaveLength(1);
    expect(sent(email, NotificationTemplate.GOAL_SET_BY_LEADER)).toHaveLength(0);

    await finalize(s.sessionId, s.version);

    await emailReaches('INDAH', 'sent');
    notices = await goalNotices('INDAH');
    expect(notices).toHaveLength(1);
    expect(notices[0].delivery).toMatchObject({ in_app: { status: 'sent' }, email: { status: 'sent' } });
    const emailed = sent(email, NotificationTemplate.GOAL_SET_BY_LEADER);
    expect(emailed).toHaveLength(1);
    expect(JSON.parse(emailed[0].rendered.body)).toEqual({ byName: 'Agus Salim', period: '2026', annualApeTargetMinor: 800 * M });
    expect(sent(inApp, NotificationTemplate.GOAL_SET_BY_LEADER)).toHaveLength(1);
    // The finalize notice beside it: in-app only, and `{ sessionId }`, nothing a leader typed.
    const finalizedNotice = await col('notifications').find({ templateId: NotificationTemplate.COACHING_SESSION_FINALIZED }).toArray();
    expect(finalizedNotice.map((n) => [n.userId, n.payload, Object.keys(n.delivery)])).toEqual([
      [await userOf('INDAH'), { sessionId: s.sessionId }, ['in_app']],
    ]);
    // Every save is still a goal save on the record: three of them, each naming the leader.
    expect(await col('auditLog').countDocuments({ action: { $in: ['goal.created', 'goal.updated'] } })).toBe(3);
  });

  it('P11-T8 AC-4 a reopened session is a new round: its saves are a new notice, emailed when the correction is finalized', async () => {
    const s = await started('AGUS', 'INDAH');
    await put(`for=${id('INDAH')}&session=${s.sessionId}`, 600 * M).expect(200);
    const done = await finalize(s.sessionId, s.version);
    await emailReaches('INDAH', 'sent');
    await http().post(`/coaching/sessions/${s.sessionId}/reopen`).send({ version: done.version, reason: 'The target was wrong.' }).expect(200);

    await put(`for=${id('INDAH')}&session=${s.sessionId}`, 650 * M).expect(200);
    const notices = await goalNotices('INDAH');
    expect(notices.map((n) => [n.coalesceKey, n.delivery.email.status, n.payload.annualApeTargetMinor]).sort()).toEqual([
      [`${s.sessionId}:0`, 'sent', 600 * M], [`${s.sessionId}:1`, 'held', 650 * M],
    ]);
  });

  it('P11-T8 without session=, the Goal Setting tab keeps one notice per save, on both channels at once', async () => {
    as('AGUS');
    await put(`for=${id('INDAH')}`, 600 * M).expect(200);
    await put(`for=${id('INDAH')}`, 700 * M).expect(200);

    const notices = await goalNotices('INDAH');
    expect(notices.map((n) => [n.coalesceKey, n.payload, n.delivery.email.status])).toEqual([
      [null, { byName: 'Agus Salim', period: '2026' }, 'sent'],
      [null, { byName: 'Agus Salim', period: '2026' }, 'sent'],
    ]);
    expect(sent(email, NotificationTemplate.GOAL_SET_BY_LEADER)).toHaveLength(2);
  });

  describe('session= names the caller’s own open session with that coachee', () => {
    it.each([
      ['an id that is nobody’s', async () => `for=${id('INDAH')}&session=${new mongoose.Types.ObjectId()}`],
      ['not an id at all', async () => `for=${id('INDAH')}&session=not-a-session`],
      ['somebody else’s session with the same coachee', async () => {
        const sari = (await col('coachingSessions').findOne({ coacheeMembershipId: id('RINA'), coachMembershipId: id('SARI') }))!;
        return `for=${id('RINA')}&session=${sari._id}`;
      }],
      ['the caller’s session with somebody else', async () => {
        const dimas = (await col('coachingSessions').findOne({ coacheeMembershipId: id('DIMAS'), status: 'draft' }))!;
        return `for=${id('INDAH')}&session=${dimas._id}`;
      }],
      ['their session, with no `for` naming its coachee', async () => `session=${(await started('AGUS', 'INDAH')).sessionId}`],
      ['another office’s session', async () => `for=${id('INDAH')}&session=${(await started('B_AB', 'B_AGENT')).sessionId}`],
    ] as [string, () => Promise<string>][])('P11-T8 %s is 404, and nothing is saved or sent', async (_what, query) => {
      const q = await query();
      as('AGUS');
      const before = await goalVersion('INDAH');
      const res = await put(q).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(await goalVersion('INDAH')).toBe(before);
      expect(await goalNotices('INDAH')).toHaveLength(0);
    });

    it('P11-T8 another current coach — the Owner, the root AB — saving through the coach’s session is 404', async () => {
      const s = await started('AGUS', 'INDAH');
      as('OWNER');
      await put(`for=${id('INDAH')}&session=${s.sessionId}`).expect(404);
    });

    it('P11-T8 a coach whose edge has closed saves through no session of theirs', async () => {
      const s = await started('AGUS', 'INDAH');
      const memberships = col('memberships');
      const indah = { _id: new mongoose.Types.ObjectId(id('INDAH')) };
      const before = await memberships.findOne(indah);
      await memberships.updateOne(indah, { $set: { leaderId: id('PEER_AB'), ancestorIds: [id('OWNER'), id('PEER_AB')] } });
      try {
        as('AGUS');
        await put(`for=${id('INDAH')}&session=${s.sessionId}`).expect(404);
      } finally {
        await memberships.updateOne(indah, { $set: { leaderId: before!.leaderId, ancestorIds: before!.ancestorIds } });
      }
    });

    it('P11-T8 a finalized session is COACHING_SESSION_FINALIZED, and nothing is saved', async () => {
      const s = await started('AGUS', 'INDAH');
      await finalize(s.sessionId, s.version);
      const before = await goalVersion('INDAH');
      const res = await put(`for=${id('INDAH')}&session=${s.sessionId}`).expect(409);
      expect(res.body.error.code).toBe('COACHING_SESSION_FINALIZED');
      expect(await goalVersion('INDAH')).toBe(before);
    });

    it('P11-T8 the query is validated as every query field is', async () => {
      as('AGUS');
      expect((await put(`for=${id('INDAH')}&session=${'x'.repeat(65)}`).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await put(`for=${id('INDAH')}&notify=false`).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  /*
   * Found on the browser walk: the email adapter timed out on the developer's machine and *Finalize*
   * answered after ten seconds, because finalize awaited the held email's delivery. It no longer does.
   */
  describe('finalize never waits on the held email (P11-T8 AC-4)', () => {
    const GOAL = NotificationTemplate.GOAL_SET_BY_LEADER;

    it('P11-T8 AC-4 an email adapter that hangs does not hold the finalize; the email is sent, once, when the adapter returns', async () => {
      const s = await started('AGUS', 'INDAH');
      await put(`for=${id('INDAH')}&session=${s.sessionId}`, 600 * M).expect(200);
      let open!: () => void;
      email.gate = new Promise<void>((resolve) => { open = resolve; });
      try {
        // Were the finalize waiting on the adapter it would never answer, because nothing opens the gate yet.
        const answer = await within(finalize(s.sessionId, s.version), 5_000);
        expect(answer).toMatchObject({ sessionId: s.sessionId, status: 'finalized' });

        // Claimed while the adapter hangs: pending on the notice, asked of the adapter once, not yet sent.
        await emailReaches('INDAH', 'pending');
        expect(email.calls).toBe(1);
        expect(sent(email, GOAL)).toHaveLength(0);
      } finally {
        open();
      }

      const notice = await emailReaches('INDAH', 'sent');
      expect(notice.delivery).toMatchObject({ in_app: { status: 'sent' }, email: { status: 'sent' } });
      expect(sent(email, GOAL)).toHaveLength(1);
      // Released once: the key holds nothing now, so a second release asks nothing of the adapter.
      await notifications.releaseHeld(KPM_A, `${s.sessionId}:0`, GOAL);
      expect(email.calls).toBe(1);
    });

    it('P11-T8 AC-4 an email adapter that hangs and then fails: the finalize has answered, and the failure is on the delivery map and logged', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const s = await started('AGUS', 'INDAH');
      await put(`for=${id('INDAH')}&session=${s.sessionId}`, 600 * M).expect(200);
      let open!: () => void;
      email.gate = new Promise<void>((resolve) => { open = resolve; });
      try {
        const answer = await within(finalize(s.sessionId, s.version), 5_000);
        expect(answer).toMatchObject({ status: 'finalized' });

        email.refusal = new Error('SMTP timed out after 10000 ms');
        open();
        const notice = await emailReaches('INDAH', 'failed');
        expect((notice.delivery as Doc).email).toMatchObject({ status: 'failed', error: 'SMTP timed out after 10000 ms' });
        expect(logged).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email', templateId: GOAL }), 'delivery failed');
        // The session stays finalized: the email's failure is the notice's, never the session's.
        expect((await col('coachingSessions').findOne({ _id: new mongoose.Types.ObjectId(s.sessionId) }))!.status)
          .toBe('finalized');
        expect(sent(email, GOAL)).toHaveLength(0);
      } finally {
        open();
        logged.mockRestore();
      }
    });

    it.each([
      ['rejects', () => Promise.reject(new Error('notifications unavailable'))],
      ['throws before it returns a promise', () => { throw new Error('notifications unavailable'); }],
    ] as [string, () => Promise<void>][])(
      'P11-T8 AC-4 a release that %s is logged at error level, and the finalize answers 200',
      async (_how, failure) => {
        const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const release = jest.spyOn(notifications, 'releaseHeld').mockImplementationOnce(failure);
        try {
          const s = await started('AGUS', 'INDAH');
          await put(`for=${id('INDAH')}&session=${s.sessionId}`, 600 * M).expect(200);
          const answer = await finalize(s.sessionId, s.version);

          expect(answer.status).toBe('finalized');
          expect(release).toHaveBeenCalledWith(KPM_A, `${s.sessionId}:0`, GOAL);
          expect(logged).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: s.sessionId, coalesceKey: `${s.sessionId}:0` }),
            'failed to send the session’s held goal email',
          );
        } finally {
          release.mockRestore();
          logged.mockRestore();
        }
      },
    );
  });

  describe('the notice never fails the save (P11-T8 AC-4)', () => {
    it('P11-T8 AC-4 a coalesced notice write that throws is logged at error level, and the save answers 200', async () => {
      const s = await started('AGUS', 'INDAH');
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const write = jest.spyOn(mongoose.model(Notification.name), 'findOneAndUpdate')
        .mockImplementationOnce(() => { throw new Error('notifications unavailable'); });
      try {
        const before = await goalVersion('INDAH');
        const res = await put(`for=${id('INDAH')}&session=${s.sessionId}`, 900 * M).expect(200);
        expect(res.body.annualApeTargetMinor).toBe(900 * M);
        expect(await goalVersion('INDAH')).toBe(before + 1);
        expect(logged).toHaveBeenCalledWith(
          expect.objectContaining({ coalesceKey: `${s.sessionId}:0` }), 'failed to notify the member of a goal set for them',
        );
      } finally {
        write.mockRestore();
        logged.mockRestore();
      }
    });

    it('P11-T8 AC-4 announce() is non-fatal too: a preferences read that throws leaves the save at 200', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const read = jest.spyOn(mongoose.model(NotificationPreferences.name), 'findOne')
        .mockImplementationOnce(() => { throw new Error('preferences unavailable'); });
      try {
        as('AGUS');
        await put(`for=${id('INDAH')}`, 950 * M).expect(200);
        expect((await col('goals').findOne({ membershipId: id('INDAH') }))!.annualApeTargetMinor).toBe(950 * M);
        expect(logged).toHaveBeenCalledWith(
          expect.objectContaining({ coalesceKey: null }), 'failed to notify the member of a goal set for them',
        );
      } finally {
        read.mockRestore();
        logged.mockRestore();
      }
    });
  });

  /*
   * Phase 11 exit review, B2 (ADR-0075, ADR-0058): the APE achieved so far is the carrier's figure or the
   * member's own, never somebody else's typing. Lukas has no production on file, so the figure his goal
   * and his Summary are measured against is the one he typed.
   */
  describe('B2 a leader’s save keeps the member’s own APE achieved (ADR-0075, ADR-0058)', () => {
    const body = (annual: number, apeAchievedMinor: number) => ({ ...plan(annual), apeAchievedMinor });
    const stored = async (who: Who) => (await col('goals').findOne({ membershipId: id(who) }))?.apeAchievedMinor;
    const ownSave = async (who: Who, apeAchievedMinor: number) => {
      as(who);
      return (await http().put('/goals/2026').send(body(500 * M, apeAchievedMinor)).expect(200)).body;
    };

    it.each([
      ['from Goal Settings, without session=', async () => `for=${id('LUKAS')}`],
      ['through a coaching session, with session=', async () => `for=${id('LUKAS')}&session=${(await started('AGUS', 'LUKAS')).sessionId}`],
    ] as [string, () => Promise<string>][])('B2 a leader’s save %s keeps the stored figure and ignores the body’s', async (_how, query) => {
      await ownSave('LUKAS', 120 * M);
      const q = await query();
      as('AGUS');

      const res = await http().put(`/goals/2026?${q}`).send(body(600 * M, 999 * M)).expect(200);

      // The target is the leader's to set; the figure achieved is still Lukas's own.
      expect(res.body).toMatchObject({
        annualApeTargetMinor: 600 * M, apeAchievedMinor: 120 * M, savedByMembershipId: id('AGUS'),
        achieved: { minor: 120 * M, provenance: 'self_reported' },
      });
      expect(await stored('LUKAS')).toBe(120 * M);
      // His Summary, and his leader's copy of it, read the figure he typed.
      as('LUKAS');
      expect((await http().get('/summary').expect(200)).body.yearly)
        .toMatchObject({ actualMinor: 120 * M, source: { provenance: 'self_reported' } });
      as('AGUS');
      expect((await http().get('/summary').query({ for: id('LUKAS') }).expect(200)).body.yearly.actualMinor).toBe(120 * M);
    });

    it('B2 a leader’s first save for somebody with no plan stores 0, never the body’s figure', async () => {
      as('AGUS');
      const res = await http().put(`/goals/2026?for=${id('TARI')}`).send(body(600 * M, 250 * M)).expect(200);
      expect(res.body).toMatchObject({ apeAchievedMinor: 0, achieved: { minor: 0, provenance: 'self_reported' } });
      expect(await stored('TARI')).toBe(0);
    });

    it('B2 the Owner and the Admin, own-kpm, keep it too', async () => {
      await ownSave('LUKAS', 120 * M);
      for (const who of ['OWNER', 'ADMIN'] as Who[]) {
        as(who);
        await http().put(`/goals/2026?for=${id('LUKAS')}`).send(body(700 * M, 1 * M)).expect(200);
        expect([who, await stored('LUKAS')]).toEqual([who, 120 * M]);
      }
    });

    it('B2 the member’s own save is unchanged: the figure they type is stored and measured against', async () => {
      await ownSave('LUKAS', 120 * M);
      const mine = await ownSave('LUKAS', 130 * M);
      expect(mine).toMatchObject({ apeAchievedMinor: 130 * M, achieved: { minor: 130 * M, provenance: 'self_reported' } });
      expect(await stored('LUKAS')).toBe(130 * M);
    });
  });

  /*
   * Phase 11 exit review, N4: `own-kpm` reaches a member who has left for a read — the office's history
   * (§6.7) — and for no write. Fajar (LEFT) was removed; the cache still names his leaders.
   */
  describe('N4 a member who has left is read, never written for', () => {
    it.each(['OWNER', 'ADMIN'] as Who[])('N4 %s, own-kpm, saving a goal for a member who has left is 404, and nothing is written', async (who) => {
      as(who);
      const res = await put(`for=${id('LEFT')}`).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(await col('goals').countDocuments({ membershipId: id('LEFT') })).toBe(0);
      expect(await goalNotices('LEFT')).toHaveLength(0);
      // The read is not refused: the history belongs to the office.
      await http().get('/goals/2026').query({ for: id('LEFT') }).expect(200);
      // An active member is saved for as before.
      await put(`for=${id('LUKAS')}`).expect(200);
    });
  });
});
