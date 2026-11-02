import { INestApplication } from '@nestjs/common';
import mongoose from 'mongoose';
import request from 'supertest';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { session } from '../../../test/http-permissions';
import { ROSTER_NOW } from '../../../test/coaching-office';
import { buildForumOffice, forumApp, KPM_A, KPM_B, type ForumOffice } from '../../../test/forum-office';
import type { MeetingView } from './leader-meeting.view';

/**
 * **Isolation** (invariant §1; P18.1-T2 AC-9, P18.1-T3 AC-3; `ROUTE_MODULE['/leader-meetings']`): 0417 against 0555,
 * **on every forum route**, both ways. Each office's Owner — an editor of every meeting of their own — addressing the
 * other's meeting, its items, its targets and its links is answered `404 NOT_FOUND`, the answer a meeting that is not
 * there gives, and nothing of the other office is read or written. A shared link is looked up inside the reader's own
 * office, so another office's token is simply unknown. The repositories refuse a context with no office at all.
 */
describe('the Strategic Leader Forum, isolated (invariant §1)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: ForumOffice;
  const db = () => mongoose.connection.db!;
  const http = () => request(app.getHttpServer());
  const sides: Record<'0417' | '0555', { owner: () => RequestContext; view: MeetingView; token: string }> = {} as never;

  /** One meeting per office with an agenda, a row, a target and a live link. */
  const furnish = async (owner: RequestContext, title: string) => {
    const card = await office.forum.create(owner, { title, date: '2026-09-28' });
    await office.minutes.addActionItem(owner, card.id);
    await office.minutes.saveMonthlyTarget(owner, card.id, 'flc', { rate: 1, version: 0 });
    const { token } = await office.sharing.create(owner, card.id);
    return { view: await office.forum.read(owner, card.id), token };
  };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildForumOffice(wired);
    app = await forumApp(office);
    sides['0417'] = { owner: () => office.as('OWNER'), ...(await furnish(office.as('OWNER'), '0417’s meeting')) };
    sides['0555'] = { owner: () => office.ownerOfB(), ...(await furnish(office.ownerOfB(), '0555’s meeting')) };
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  /** Every forum route that names a meeting or a link, aimed at `view` and `token`. */
  const routes = (view: MeetingView, token: string) => {
    const id = view.id;
    const item = view.agenda.during[0];
    const row = view.actionItems[0];
    return [
      ['GET a meeting', () => http().get(`/leader-meetings/${id}`)],
      ['PATCH the head', () => http().patch(`/leader-meetings/${id}`).send({ title: 'Mine now', version: view.version })],
      ['DELETE the meeting', () => http().delete(`/leader-meetings/${id}`).query({ version: view.version })],
      ['POST an agenda item', () => http().post(`/leader-meetings/${id}/agenda-items`).send({ section: 'post' })],
      ['PATCH an agenda item', () => http().patch(`/leader-meetings/${id}/agenda-items/${item.id}`).send({ text: 'Mine now', version: item.version })],
      ['POST an action item', () => http().post(`/leader-meetings/${id}/action-items`)],
      ['PATCH an action item', () => http().patch(`/leader-meetings/${id}/action-items/${row.id}`).send({ pic: 'Mine', version: row.version })],
      ['DELETE an action item', () => http().delete(`/leader-meetings/${id}/action-items/${row.id}`).query({ version: row.version })],
      ['PUT the order', () => http().put(`/leader-meetings/${id}/action-items/order`).send({ itemIds: [row.id] })],
      ['PUT a Monthly Target', () => http().put(`/leader-meetings/${id}/monthly-targets/flc`).send({ rate: 9, version: 1 })],
      ['POST a share link', () => http().post(`/leader-meetings/${id}/share-links`)],
      ['DELETE the share links', () => http().delete(`/leader-meetings/${id}/share-links`)],
      ['GET the shared link', () => http().get(`/leader-meetings/shared/${token}`)],
    ] as const;
  };

  const everything = async () => ({
    meetings: await db().collection('leaderMeetings').find({}).sort({ _id: 1 }).toArray(),
    links: await db().collection('leaderMeetingShareLinks').find({}).sort({ _id: 1 }).toArray(),
    audit: await db().collection('auditLog').countDocuments(),
  });

  it.each([['0555', '0417'], ['0417', '0555']] as const)(
    'P18.1-T2 AC-9, P18.1-T3 AC-3 %s’s Owner is answered 404 on every route of %s’s meeting and link, and nothing is written',
    async (reader, other) => {
      const before = await everything();
      session.current = sides[reader].owner();
      for (const [name, call] of routes(sides[other].view, sides[other].token)) {
        const res = await call();
        expect([name, res.status, res.body.error?.code]).toEqual([name, 404, 'NOT_FOUND']);
      }
      expect(await everything()).toEqual(before);
    },
  );

  it('P18.1-T2 AC-9, P18.1-T3 AC-3 a Core Leader tagged in 0555 edits 0555’s meeting and meets 404 on every route of 0417’s', async () => {
    const row = { _id: new mongoose.Types.ObjectId(office.id.B_AGENT) };
    const memberships = mongoose.connection.db!.collection('memberships');
    await office.tag('B_AGENT', true);
    try {
      session.current = office.as('B_AGENT');
      // Tagged on an Agent's rung, in their own office: no Core Leader (ADR-0159 §1, P18.8-T5 AC-1).
      expect((await http().get(`/leader-meetings/${sides['0555'].view.id}`).expect(404)).body.error.code).toBe('NOT_FOUND');
      // Moved to a leader rung, the same tag makes one.
      await memberships.updateOne(row, { $set: { role: 'aab' } });
      // Tagged, in their own office: an editor.
      await http().get(`/leader-meetings/${sides['0555'].view.id}`).expect(200);
      await http().post(`/leader-meetings/${sides['0555'].view.id}/agenda-items`).send({ section: 'post' }).expect(201);
      const before = await everything();
      // Moving and deleting are no Core Leader's: the guard refuses them before anything is looked up, so its 403
      // names the permission and confirms no meeting. Every other route is the meeting's 404.
      const guarded = new Set(['PATCH the head', 'DELETE the meeting']);
      for (const [name, call] of routes(sides['0417'].view, sides['0417'].token)) {
        const res = await call();
        expect([name, res.status, res.body.error?.code])
          .toEqual(guarded.has(name) ? [name, 403, 'PERM_DENIED'] : [name, 404, 'NOT_FOUND']);
      }
      expect(await everything()).toEqual(before);
    } finally {
      await office.tag('B_AGENT', false);
      await memberships.updateOne(row, { $set: { role: 'agent' } });
    }
  });

  it.each([['0417', KPM_A], ['0555', KPM_B]] as const)('P18.1-T2 AC-9 %s’s list is its own meetings alone', async (side, kpmId) => {
    session.current = sides[side].owner();
    const list = (await http().get('/leader-meetings').expect(200)).body;
    const own = await db().collection('leaderMeetings').find({ kpmId, deletedAt: null }).toArray();
    expect(list.meetings.map((m: { id: string }) => m.id).sort()).toEqual(own.map((m) => String(m._id)).sort());
    expect(list.meetings.map((m: { id: string }) => m.id)).toContain(sides[side].view.id);
    // Its editors are its own office's people: 0555's Owner is Lina Marlina, 0417's Wilson Tanoto.
    expect(list.meetings[0].editors.owner.name).toBe(side === '0417' ? 'Wilson Tanoto' : 'Lina Marlina');
  });

  it('P18.1-T3 AC-3 a member of 0555 below its Owner opens none of 0417’s links; 0417’s Agent none of 0555’s', async () => {
    session.current = office.as('B_AGENT');
    expect((await http().get(`/leader-meetings/shared/${sides['0417'].token}`).expect(404)).body.error.code).toBe('NOT_FOUND');
    await http().get(`/leader-meetings/shared/${sides['0555'].token}`).expect(200);
    session.current = office.as('RINA');
    expect((await http().get(`/leader-meetings/shared/${sides['0555'].token}`).expect(404)).body.error.code).toBe('NOT_FOUND');
    await http().get(`/leader-meetings/shared/${sides['0417'].token}`).expect(200);
  });

  it('P18.1-T2 AC-9 the two repositories refuse a read or a write with no office in the context', async () => {
    const nobody = RequestContext.platform('root');
    const id = sides['0417'].view.id;
    await expect(office.meetings.list(nobody)).rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(office.meetings.findById(nobody, id)).rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(office.meetings.freeze(nobody, id, { frozenScorecard: {}, frozenAt: new Date(), frozenCoeditors: [] }))
      .rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(office.links.findLive(nobody, 'x', new Date())).rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(office.links.revoke(nobody, id, new Date())).rejects.toBeInstanceOf(MissingTenantContextError);
  });
});
