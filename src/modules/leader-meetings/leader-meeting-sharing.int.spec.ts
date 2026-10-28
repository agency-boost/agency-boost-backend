import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import mongoose from 'mongoose';
import request from 'supertest';
import { FixedClock } from '@/common/clock/clock.port';
import { LEADER_MEETING_SHARE_DAYS, TIME } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { session } from '../../../test/http-permissions';
import { ROSTER_NOW, type Who } from '../../../test/coaching-office';
import { buildForumOffice, forumApp, KPM_A, type ForumOffice } from '../../../test/forum-office';

/**
 * **Exit test 3 — the link** (P18.1-T3 AC-1 to AC-3; OD-146, ADR-0131, D-share): *Share* makes a fresh link whose
 * token is in its answer and nowhere else; it opens the meeting **read-only for a signed-in member of its office** —
 * any rung, tagged or not — while it lives; an expired, revoked, deleted or another office's link, and an unknown one,
 * are one answer, 404; every opening is one audit row; *Stop sharing* revokes every live link.
 */
describe('a meeting’s shared link (P18.1-T3, exit test 3)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: ForumOffice;
  let meetingId: string;
  const db = () => mongoose.connection.db!;
  const http = () => request(app.getHttpServer());
  const as = (who: Who) => { session.current = office.as(who); };
  const clock = () => wired.clock as FixedClock;
  const share = async (id = meetingId, who: Who = 'OWNER') => {
    as(who);
    return (await http().post(`/leader-meetings/${id}/share-links`).expect(201)).body as { token: string; expiresAt: string };
  };
  const open = (token: string) => http().get(`/leader-meetings/shared/${encodeURIComponent(token)}`);
  const openings = () => db().collection('auditLog').find({ action: 'leader_meeting_share_link.opened' }).toArray();
  /** A 404's body without the request id: what the reader is told. */
  const notFound = async (token: string) => {
    const res = await open(token).expect(404);
    return { ...res.body.error, requestId: undefined };
  };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildForumOffice(wired);
    app = await forumApp(office);
    meetingId = (await office.forum.create(office.as('OWNER'), { title: 'Strategic Check-in — #13', date: '2026-09-21' })).id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  afterEach(() => clock().set(ROSTER_NOW));

  it('P18.1-T3 AC-1 LEADER_MEETING_SHARE_DAYS is 14, the forum’s two-week cadence', () => {
    expect(LEADER_MEETING_SHARE_DAYS).toBe(14);
  });

  it('P18.1-T3 AC-1 Share makes a fresh link each time: a random base64url token valid 14 days; only its hash kept; audited without it', async () => {
    const first = await share();
    const second = await share(meetingId, 'AGUS');
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.token).not.toBe(first.token);
    expect(first.expiresAt).toBe(new Date(ROSTER_NOW.getTime() + LEADER_MEETING_SHARE_DAYS * TIME.MS_PER_DAY).toISOString());
    const rows = await db().collection('leaderMeetingShareLinks').find({ meetingId }).toArray();
    expect(rows.map((r) => r.tokenHash).sort()).toEqual(
      [first.token, second.token].map((t) => createHash('sha256').update(t).digest('hex')).sort(),
    );
    // The raw token is in the answer that made it and nowhere else: not on the link, not on any audit row.
    const everything = JSON.stringify([rows, await db().collection('auditLog').find({}).toArray(), await db().collection('leaderMeetings').find({}).toArray()]);
    expect(everything).not.toContain(first.token);
    expect(everything).not.toContain(second.token);
    const created = await db().collection('auditLog').find({ action: 'leader_meeting_share_link.created' }).toArray();
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ targetCollection: 'leaderMeetingShareLinks', before: null, after: { meetingId, expiresAt: first.expiresAt } });
    expect(created[1].actorMembershipId).toBe(office.id.AGUS);
  });

  it.each(['OWNER', 'ADMIN', 'AGUS', 'SARI', 'RINA', 'DEWI', 'PEER_AB'] as Who[])(
    'P18.1-T3 AC-2 positive: %s, signed in to the office, opens it read-only — every can false but print — and the opening is audited',
    async (who) => {
      const { token } = await share();
      const before = (await openings()).length;
      as(who);
      const view = (await open(token).expect(200)).body;
      expect(view).toMatchObject({ id: meetingId, title: 'Strategic Check-in — #13', via: 'link', branch: 'BSD City Branch' });
      expect(view.can).toEqual({ edit: false, share: false, reschedule: false, delete: false, manageTags: false, print: true });
      const rows = await openings();
      expect(rows).toHaveLength(before + 1);
      const link = await db().collection('leaderMeetingShareLinks').findOne({ tokenHash: createHash('sha256').update(token).digest('hex') });
      expect(rows.at(-1)).toMatchObject({
        targetCollection: 'leaderMeetingShareLinks', targetId: String(link!._id), after: { meetingId },
        actorMembershipId: office.id[who], kpmId: KPM_A,
      });
    },
  );

  it('P18.1-T3 AC-2 every write is impossible through a link: no write route takes a token, and the meeting’s address still answers a member not tagged 404', async () => {
    const { token } = await share();
    as('RINA');
    await open(token).expect(200);
    for (const res of [
      await http().post(`/leader-meetings/shared/${token}/action-items`),
      await http().patch(`/leader-meetings/shared/${token}`).send({ title: 'x', version: 1 }),
      await http().put(`/leader-meetings/shared/${token}/monthly-targets/ape`).send({ rate: 1, version: 0 }),
    ]) {
      expect(res.status).toBe(404);
    }
    expect((await http().post(`/leader-meetings/${meetingId}/action-items`).expect(404)).body.error.code).toBe('NOT_FOUND');
    expect((await http().get(`/leader-meetings/${meetingId}`).expect(404)).body.error.code).toBe('NOT_FOUND');
    expect((await office.meetings.findById(office.as('OWNER'), meetingId))!.actionItems).toEqual([]);
  });

  it('P18.1-T3 AC-1 the link opens strictly before it expires: a millisecond before LEADER_MEETING_SHARE_DAYS, and not at it', async () => {
    const { token, expiresAt } = await share();
    as('RINA');
    clock().set(new Date(new Date(expiresAt).getTime() - 1));
    await open(token).expect(200);
    clock().set(new Date(expiresAt));
    await open(token).expect(404);
  });

  it('P18.1-T3 AC-1, AC-2, AC-3 expired, revoked, a deleted meeting’s, another office’s and an unknown link: one answer, 404, nothing recorded', async () => {
    const live = await share();
    as('RINA');
    const opened = (await open(live.token).expect(200)).body;
    expect(opened.id).toBe(meetingId);
    const answers: unknown[] = [];

    // Expired.
    const expiring = await share();
    as('RINA');
    clock().set(new Date(new Date(expiring.expiresAt).getTime() + 1));
    answers.push(await notFound(expiring.token));
    clock().set(ROSTER_NOW);

    // Revoked.
    const revoked = await share();
    await http().delete(`/leader-meetings/${meetingId}/share-links`).expect(200);
    as('RINA');
    answers.push(await notFound(revoked.token));

    // A deleted meeting's.
    const doomed = await office.forum.create(office.as('OWNER'), { title: 'Doomed', date: '2026-10-01' });
    const ofDoomed = await share(doomed.id);
    await http().delete(`/leader-meetings/${doomed.id}`).query({ version: 1 }).expect(204);
    as('RINA');
    answers.push(await notFound(ofDoomed.token));

    // Another office's, both ways.
    const theirs = await office.forum.create(office.ownerOfB(), { title: '0555’s own', date: '2026-10-01' });
    const theirLink = await office.sharing.create(office.ownerOfB(), theirs.id);
    answers.push(await notFound(theirLink.token));
    const ours = await share();
    session.current = office.as('B_AGENT');
    answers.push(await notFound(ours.token));
    session.current = office.ownerOfB();
    answers.push(await notFound(ours.token));
    expect((await open(theirLink.token).expect(200)).body.id).toBe(theirs.id);

    // Unknown, and not a token at all.
    as('RINA');
    const before = (await openings()).length;
    answers.push(await notFound('x'.repeat(43)));
    answers.push(await notFound('nonsense'));
    expect((await openings()).length).toBe(before);

    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('P18.1-T3 AC-1 Stop sharing revokes every live link to the meeting, one audit row each, and only an editor may', async () => {
    const meeting = await office.forum.create(office.as('OWNER'), { title: 'Stop', date: '2026-10-02' });
    const a = await share(meeting.id);
    const b = await share(meeting.id, 'SARI');
    // A third, past its time already: *Stop sharing* revokes the live ones and leaves it as it was.
    const expired = await share(meeting.id);
    await db().collection('leaderMeetingShareLinks').updateOne(
      { tokenHash: createHash('sha256').update(expired.token).digest('hex') }, { $set: { expiresAt: new Date(ROSTER_NOW.getTime() - 1) } },
    );
    as('RINA');
    expect((await http().delete(`/leader-meetings/${meeting.id}/share-links`).expect(404)).body.error.code).toBe('NOT_FOUND');
    as('AGUS');
    expect((await http().delete(`/leader-meetings/${meeting.id}/share-links`).expect(200)).body).toEqual({ revoked: 2 });
    expect((await http().delete(`/leader-meetings/${meeting.id}/share-links`).expect(200)).body).toEqual({ revoked: 0 });
    const rows = await db().collection('leaderMeetingShareLinks').find({ meetingId: meeting.id }).toArray();
    expect(rows.filter((r) => r.revokedAt).map((r) => r.revokedBy)).toEqual([office.id.AGUS, office.id.AGUS]);
    const audit = await db().collection('auditLog').find({ action: 'leader_meeting_share_link.revoked', 'before.meetingId': meeting.id }).toArray();
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ targetCollection: 'leaderMeetingShareLinks', after: { revokedAt: ROSTER_NOW.toISOString() } });
    as('RINA');
    for (const token of [a.token, b.token]) await open(token).expect(404);
  });

  it('P18.1-T3 AC-2 a read-only support session opens a link as its member: answered, recorded with both actors', async () => {
    const { token } = await share();
    session.current = office.supported('RINA');
    await open(token).expect(200);
    expect((await openings()).at(-1)).toMatchObject({ actorUserId: 'u-support', effectiveUserId: office.as('RINA').userId });
  });

  it('P18.1-T3 AC-2 an opening after the meeting’s date by a member can be the read that freezes it', async () => {
    const past = await office.forum.create(office.as('OWNER'), { title: 'Past, shared', date: '2026-09-03' });
    const { token } = await share(past.id);
    as('RINA');
    const view = (await open(token).expect(200)).body;
    expect([view.state, view.scorecard.frozenAt]).toEqual(['completed', ROSTER_NOW.toISOString()]);
    expect(await db().collection('auditLog').countDocuments({ action: 'leader_meeting.frozen', targetId: past.id, actorMembershipId: office.id.RINA })).toBe(1);
  });
});
