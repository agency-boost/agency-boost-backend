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
      { record: async () => undefined } as never,
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

    // Each email is sent after its save has answered (P12.1-T1): read the notices once neither is pending.
    let notices = await goalNotices('INDAH');
    for (let attempt = 0; attempt < 250 && notices.some((n) => n.delivery.email.status === 'pending'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      notices = await goalNotices('INDAH');
    }
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
   * Phase 11 exit review, B2 (ADR-0075, ADR-0058), **partly reversed by ADR-0183** (OD-242; the owner's staging review
   * SR-07, P18.11-T17): the APE achieved so far is the carrier's figure where the office holds one, and otherwise the
   * figure typed — by the member, **or by anybody who may save their plan** (a leader who coaches them, the Owner, the
   * Admin). Lukas, Tari and Budi have no production on file; Indah has August and September.
   */
  describe('ADR-0183 a coach types the member’s APE produced while the office has not uploaded it', () => {
    const body = (annual: number, apeAchievedMinor: number) => ({ ...plan(annual), apeAchievedMinor });
    const stored = async (who: Who) => (await col('goals').findOne({ membershipId: id(who) }))?.apeAchievedMinor;
    const ownSave = async (who: Who, apeAchievedMinor: number) => {
      as(who);
      return (await http().put('/goals/2026').send(body(500 * M, apeAchievedMinor)).expect(200)).body;
    };

    it.each([
      ['from Goal Settings, without session=', async () => `for=${id('LUKAS')}`],
      ['through a coaching session, with session=', async () => `for=${id('LUKAS')}&session=${(await started('AGUS', 'LUKAS')).sessionId}`],
    ] as [string, () => Promise<string>][])('ADR-0183 a leader’s save %s stores the figure they typed, and the member reads it', async (_how, query) => {
      await ownSave('LUKAS', 120 * M);
      const q = await query();
      as('AGUS');

      const res = await http().put(`/goals/2026?${q}`).send(body(600 * M, 150 * M)).expect(200);

      expect(res.body).toMatchObject({
        annualApeTargetMinor: 600 * M, apeAchievedMinor: 150 * M, savedByMembershipId: id('AGUS'),
        achieved: { minor: 150 * M, provenance: 'self_reported' },
      });
      expect(await stored('LUKAS')).toBe(150 * M);
      // Lukas's own Goal Settings and Summary read it, and so does his leader's copy.
      as('LUKAS');
      expect((await http().get('/goals/2026').expect(200)).body)
        .toMatchObject({ apeAchievedMinor: 150 * M, achieved: { minor: 150 * M, provenance: 'self_reported' } });
      expect((await http().get('/summary').expect(200)).body.yearly)
        .toMatchObject({ actualMinor: 150 * M, source: { provenance: 'self_reported' } });
      as('AGUS');
      expect((await http().get('/summary').query({ for: id('LUKAS') }).expect(200)).body.yearly.actualMinor).toBe(150 * M);
    });

    it('ADR-0183 records who typed it: the saver on the plan, the figure replaced in its revision, and the audit entry', async () => {
      await ownSave('LUKAS', 120 * M);
      as('AGUS');
      await http().put(`/goals/2026?for=${id('LUKAS')}`).send(body(600 * M, 150 * M)).expect(200);

      const goal = (await col('goals').findOne({ membershipId: id('LUKAS') }))!;
      expect(goal).toMatchObject({ apeAchievedMinor: 150 * M, savedByMembershipId: id('AGUS') });
      expect((goal.revisions as Doc[]).at(-1)).toMatchObject({ apeAchievedMinor: 120 * M, byMembershipId: id('LUKAS') });
      const entry = await col('auditLog').findOne({ action: 'goal.updated', targetId: String(goal._id) }, { sort: { _id: -1 } });
      expect(entry?.after).toMatchObject({ savedByMembershipId: id('AGUS'), apeAchievedChanged: true });
      // No figure in the audit entry: the plan holds it.
      expect(JSON.stringify(entry?.after)).not.toMatch(/15000000000/);

      // A later save that leaves the figure alone does not claim to have typed it.
      await http().put(`/goals/2026?for=${id('LUKAS')}`).send(body(650 * M, 150 * M)).expect(200);
      const next = await col('auditLog').findOne({ action: 'goal.updated', targetId: String(goal._id) }, { sort: { _id: -1 } });
      expect(next?.after).not.toHaveProperty('apeAchievedChanged');
    });

    it('ADR-0183 a leader’s first save for somebody with no plan stores the figure they typed', async () => {
      as('AGUS');
      const res = await http().put(`/goals/2026?for=${id('TARI')}`).send(body(600 * M, 250 * M)).expect(200);
      expect(res.body).toMatchObject({ apeAchievedMinor: 250 * M, achieved: { minor: 250 * M, provenance: 'self_reported' } });
      expect(await stored('TARI')).toBe(250 * M);
    });

    it.each([
      ['an AAB, their own unit’s agent', 'SARI', 'BUDI'],
      ['an AAB, a nested unit’s agent', 'SARI', 'DODI'],
      ['the Owner, own-kpm', 'OWNER', 'LUKAS'],
      ['the Admin, own-kpm', 'ADMIN', 'LUKAS'],
      // P19.9-T6 (ADR-0234): every upline coaches — an Agent who leads, for their own report.
      ['an Agent who leads, for their own report', 'LUKAS', 'TARI'],
    ] as [string, Who, Who][])('ADR-0183 %s types it too', async (_name, caller, member) => {
      as(caller);
      await http().put(`/goals/2026?for=${id(member)}`).send(body(700 * M, 42 * M)).expect(200);
      expect(await stored(member)).toBe(42 * M);
    });

    it('ADR-0183 an office figure stays locked: a leader’s typing is ignored, the stored figure kept, the plan still saved', async () => {
      await ownSave('INDAH', 120 * M);
      for (const who of ['AGUS', 'OWNER'] as Who[]) {
        as(who);
        const res = await http().put(`/goals/2026?for=${id('INDAH')}`).send(body(600 * M, 999 * M)).expect(200);
        // Ignored, not refused: the target is saved, the figure is Indah's, and the plan is measured against the file's.
        expect([who, res.body.annualApeTargetMinor, res.body.apeAchievedMinor]).toEqual([who, 600 * M, 120 * M]);
        expect(res.body.achieved).toEqual({ minor: 240 * M, provenance: 'imported', month: '2026-09' });
        expect(await stored('INDAH')).toBe(120 * M);
      }
    });

    it.each([
      ['an Agent who leads, for somebody outside their downline', 'LUKAS', 'INDAH'],
      ['an Agent, for a colleague', 'INDAH', 'DIMAS'],
      ['a peer AAB, for an agent of another unit', 'PEER_AAB', 'BUDI'],
      ['a peer AB, for somebody beside their line', 'PEER_AB', 'LUKAS'],
      ['an AAB, for their own leader’s direct agent', 'SARI', 'LUKAS'],
      ['office B’s AB, for a member of office A (cross-tenant)', 'B_AB', 'LUKAS'],
    ] as [string, Who, Who][])('ADR-0183 %s is 404, and nothing is typed', async (_name, caller, member) => {
      await ownSave(member, 120 * M);
      as(caller);
      const res = await http().put(`/goals/2026?for=${id(member)}`).send(body(700 * M, 999 * M)).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(await stored(member)).toBe(120 * M);
    });

    it('ADR-0183 the preview works the plan out against what the leader types, and against the file once it is held', async () => {
      as('AGUS');
      const typed = (await http().post('/goals/2026/preview').query({ for: id('LUKAS') }).send(body(500 * M, 100 * M)).expect(200)).body;
      // The figure the leader typed would be theirs (S2), and the preview says so as a save would record it.
      expect(typed.achieved).toEqual({
        minor: 100 * M, provenance: 'self_reported', month: null, typedBy: { membershipId: id('AGUS'), name: 'Agus Salim' },
      });
      const held = (await http().post('/goals/2026/preview').query({ for: id('INDAH') }).send(body(500 * M, 999 * M)).expect(200)).body;
      expect(held.achieved).toEqual({ minor: 240 * M, provenance: 'imported', month: '2026-09' });
    });

    /*
     * **S1 (the T17–T20 permission review): a coach's save never reverts the member's newer figure.** The screens send
     * the figure only when the reader changed it in this edit; a body that leaves it out keeps the stored one. One that
     * carries it is an edit, and the last write wins.
     */
    const withoutApe = (annual: number) => {
      const { apeAchievedMinor, ...rest } = plan(annual);
      expect(apeAchievedMinor).toBe(0);
      return rest;
    };

    it.each([
      ['from the Goal Setting tab', async () => `for=${id('LUKAS')}`],
      ['through the session’s Goal card', async () => `for=${id('LUKAS')}&session=${(await started('AGUS', 'LUKAS')).sessionId}`],
    ] as [string, () => Promise<string>][])(
      'S1 the member types a newer figure, then the coach saves the target %s without touching it: the member’s figure stays',
      async (_how, query) => {
        await ownSave('LUKAS', 120 * M);
        // The coach's screen read 120; Lukas has since typed 130 on his phone.
        await ownSave('LUKAS', 130 * M);
        const q = await query();
        as('AGUS');
        const res = await http().put(`/goals/2026?${q}`).send(withoutApe(700 * M)).expect(200);
        expect(res.body).toMatchObject({
          annualApeTargetMinor: 700 * M, apeAchievedMinor: 130 * M, achieved: { minor: 130 * M, provenance: 'self_reported' },
        });
        // Still Lukas's own figure: the coach typed nothing.
        expect(res.body.achieved).not.toHaveProperty('typedBy');
        expect(await stored('LUKAS')).toBe(130 * M);
        expect((await col('goals').findOne({ membershipId: id('LUKAS') }))!.apeAchievedTypedBy).toBe(id('LUKAS'));
      },
    );

    it('S1 a coach’s explicit edit is still taken: the last write wins', async () => {
      await ownSave('LUKAS', 130 * M);
      as('AGUS');
      const res = await http().put(`/goals/2026?for=${id('LUKAS')}`).send(body(700 * M, 150 * M)).expect(200);
      expect(res.body.apeAchievedMinor).toBe(150 * M);
      expect(await stored('LUKAS')).toBe(150 * M);
    });

    it('S1 the member’s own save that leaves it out keeps it too, and a first save that leaves it out stores 0', async () => {
      await ownSave('LUKAS', 130 * M);
      as('LUKAS');
      await http().put('/goals/2026').send(withoutApe(800 * M)).expect(200);
      expect(await stored('LUKAS')).toBe(130 * M);
      as('AGUS');
      await http().put(`/goals/2026?for=${id('TARI')}`).send(withoutApe(800 * M)).expect(200);
      expect(await stored('TARI')).toBe(0);
    });

    /*
     * **S2 (the T17–T20 permission review): a figure a coach typed is never called the member's own.** The plan records
     * who typed it (`apeAchievedTypedBy`), and every read of the typed figure names the coach while it stands.
     */
    it('S2 records who typed it, and the member’s goal, their Summary and the coach’s copy name the coach', async () => {
      await ownSave('LUKAS', 120 * M);
      as('AGUS');
      await http().put(`/goals/2026?for=${id('LUKAS')}`).send(body(600 * M, 150 * M)).expect(200);
      expect((await col('goals').findOne({ membershipId: id('LUKAS') }))!.apeAchievedTypedBy).toBe(id('AGUS'));

      const coach = { membershipId: id('AGUS'), name: 'Agus Salim' };
      as('LUKAS');
      expect((await http().get('/goals/2026').expect(200)).body.achieved)
        .toEqual({ minor: 150 * M, provenance: 'self_reported', month: null, typedBy: coach });
      expect((await http().get('/summary').expect(200)).body.yearly.source)
        .toMatchObject({ provenance: 'self_reported', typedBy: coach });
      as('OWNER');
      expect((await http().get('/summary').query({ for: id('LUKAS') }).expect(200)).body.yearly.source.typedBy).toEqual(coach);
      // The Unit Dashboard's bulk read names them the same way.
      const plans = await wired.goals.plansOf(office.as('AGUS'), '2026', [id('LUKAS')], new Map());
      expect(plans.get(id('LUKAS'))!.achieved.typedBy).toEqual(coach);
    });

    it('S2 once the member types their own again, it is theirs: nobody is named', async () => {
      as('AGUS');
      await http().put(`/goals/2026?for=${id('LUKAS')}`).send(body(600 * M, 150 * M)).expect(200);
      const mine = await ownSave('LUKAS', 160 * M);
      expect(mine.achieved).toEqual({ minor: 160 * M, provenance: 'self_reported', month: null });
      expect((await col('goals').findOne({ membershipId: id('LUKAS') }))!.apeAchievedTypedBy).toBe(id('LUKAS'));
    });

    it('S2 a plan saved before the field reads as the member’s own figure', async () => {
      await ownSave('LUKAS', 120 * M);
      await col('goals').updateOne({ membershipId: id('LUKAS') }, { $unset: { apeAchievedTypedBy: '' } });
      as('LUKAS');
      expect((await http().get('/goals/2026').expect(200)).body.achieved).not.toHaveProperty('typedBy');
      expect((await http().get('/summary').expect(200)).body.yearly.source).not.toHaveProperty('typedBy');
    });

    it('S2 a coach who can no longer be named is still not the member: typedBy with no name', async () => {
      await ownSave('LUKAS', 120 * M);
      await col('goals').updateOne({ membershipId: id('LUKAS') }, { $set: { apeAchievedTypedBy: '66f0000000000000000000ff' } });
      as('LUKAS');
      expect((await http().get('/goals/2026').expect(200)).body.achieved.typedBy)
        .toEqual({ membershipId: '66f0000000000000000000ff', name: null });
      // The Unit Dashboard's bulk read says the same, and an office figure held says nothing of who typed.
      const plans = await wired.goals.plansOf(office.as('AGUS'), '2026', [id('LUKAS')], new Map());
      expect(plans.get(id('LUKAS'))!.achieved.typedBy).toEqual({ membershipId: '66f0000000000000000000ff', name: null });
      const held = await wired.goals.plansOf(office.as('AGUS'), '2026', [id('LUKAS')], new Map([
        [id('LUKAS'), { minor: 240 * M, provenance: 'imported' as const, month: '2026-08' }],
      ]));
      expect(held.get(id('LUKAS'))!.achieved).toEqual({ minor: 240 * M, provenance: 'imported', month: '2026-08' });
    });

    it('S2 the member’s own preview of a figure they type names nobody: it would be theirs', async () => {
      as('AGUS');
      await http().put(`/goals/2026?for=${id('LUKAS')}`).send(body(600 * M, 150 * M)).expect(200);
      as('LUKAS');
      const mine = (await http().post('/goals/2026/preview').send(body(600 * M, 170 * M)).expect(200)).body;
      expect(mine.achieved).toEqual({ minor: 170 * M, provenance: 'self_reported', month: null });
      // Leaving it out previews the stored figure, still the coach's.
      const { apeAchievedMinor: _left, ...rest } = body(600 * M, 0);
      const kept = (await http().post('/goals/2026/preview').send(rest).expect(200)).body;
      expect(kept.achieved).toEqual({
        minor: 150 * M, provenance: 'self_reported', month: null, typedBy: { membershipId: id('AGUS'), name: 'Agus Salim' },
      });
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
