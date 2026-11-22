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
 * **Isolation** (invariant §1; P18.1-T2 AC-9, P18.1-T3 AC-3, P19.22-T8; `ROUTE_MODULE['/leader-meetings']`): 0417 against
 * 0555, **on every forum route**, both ways. Each office's Owner — and the Super Admin inside one office — addressing the
 * other's forum, its agenda lines, its action items and its links is answered `404 NOT_FOUND`, the answer a forum that
 * is not there gives, and nothing of the other office is read or written. A shared link is looked up inside the reader's
 * own office. The repositories refuse a context with no office at all.
 */
describe('the Strategic Leader Forum, isolated (invariant §1)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: ForumOffice;
  const db = () => mongoose.connection.db!;
  const http = () => request(app.getHttpServer());
  const sides: Record<'0417' | '0555', { owner: () => RequestContext; view: MeetingView; token: string }> = {} as never;

  /** One forum per office with an agenda line, an action item and a live link. */
  const furnish = async (owner: RequestContext) => {
    const card = await office.forum.create(owner, { date: '2026-09-28', time: '14:00' });
    await office.minutes.addActionItem(owner, card.id, { text: 'Aktifkan 3 agent' });
    const { token } = await office.sharing.create(owner, card.id);
    return { view: await office.forum.read(owner, card.id), token };
  };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildForumOffice(wired);
    app = await forumApp(office);
    sides['0417'] = { owner: () => office.as('OWNER'), ...(await furnish(office.as('OWNER'))) };
    sides['0555'] = { owner: () => office.ownerOfB(), ...(await furnish(office.ownerOfB())) };
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  /** Every forum route that names a forum or a link, aimed at `view` and `token`. */
  const routes = (view: MeetingView, token: string) => {
    const id = view.id;
    const item = view.agenda[0];
    const row = view.actionItems[0];
    return [
      ['GET a forum', () => http().get(`/leader-meetings/${id}`)],
      ['PATCH the head', () => http().patch(`/leader-meetings/${id}`).send({ time: '09:00', version: view.version })],
      ['DELETE the forum', () => http().delete(`/leader-meetings/${id}`).query({ version: view.version })],
      ['POST an agenda line', () => http().post(`/leader-meetings/${id}/agenda-items`).send({ text: 'Mine' })],
      ['PATCH an agenda line', () => http().patch(`/leader-meetings/${id}/agenda-items/${item.id}`).send({ text: 'Mine now', version: item.version })],
      ['POST an action item', () => http().post(`/leader-meetings/${id}/action-items`).send({ text: 'Mine' })],
      ['PATCH an action item', () => http().patch(`/leader-meetings/${id}/action-items/${row.id}`).send({ status: 'done', version: row.version })],
      ['DELETE an action item', () => http().delete(`/leader-meetings/${id}/action-items/${row.id}`).query({ version: row.version })],
      ['POST a share link', () => http().post(`/leader-meetings/${id}/share-links`)],
      ['GET the shared link', () => http().get(`/leader-meetings/shared/${token}`)],
    ] as const;
  };

  const everything = async () => ({
    meetings: await db().collection('leaderMeetings').find({}).sort({ _id: 1 }).toArray(),
    links: await db().collection('leaderMeetingShareLinks').find({}).sort({ _id: 1 }).toArray(),
    audit: await db().collection('auditLog').countDocuments(),
  });

  it.each([['0555', '0417'], ['0417', '0555']] as const)(
    'P19.22-T8 AC-1 cross-tenant: %s’s Owner is answered 404 on every route of %s’s forum and link, and nothing is written',
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

  it('P19.22-T8 AC-1 cross-tenant: the Super Admin inside 0555 is answered 404 on every route of 0417’s forum, and writes nothing', async () => {
    const before = await everything();
    session.current = office.superAdminIn(KPM_B);
    for (const [name, call] of routes(sides['0417'].view, sides['0417'].token)) {
      const res = await call();
      expect([name, res.status, res.body.error?.code]).toEqual([name, 404, 'NOT_FOUND']);
    }
    expect(await everything()).toEqual(before);
  });

  it('P19.22-T8 AC-1 cross-tenant: a core leader of 0555 edits 0555’s forum and meets 404 on every route of 0417’s', async () => {
    const row = { _id: new mongoose.Types.ObjectId(office.id.B_AGENT) };
    const memberships = db().collection('memberships');
    await office.tag('B_AGENT', true);
    try {
      session.current = office.as('B_AGENT');
      // Tagged on an Agent's rung: no core leader (ADR-0159 §1).
      expect((await http().get(`/leader-meetings/${sides['0555'].view.id}`).expect(404)).body.error.code).toBe('NOT_FOUND');
      await memberships.updateOne(row, { $set: { role: 'aab' } });
      await http().get(`/leader-meetings/${sides['0555'].view.id}`).expect(200);
      await http().post(`/leader-meetings/${sides['0555'].view.id}/agenda-items`).send({ text: 'Agenda 0555' }).expect(201);
      const before = await everything();
      for (const [name, call] of routes(sides['0417'].view, sides['0417'].token)) {
        const res = await call();
        // An Agent's rung holds no `leader_meeting:create/reschedule/delete` grant of its own: the guard answers those
        // two before anything is looked up, naming the permission and confirming no forum.
        const guarded = name === 'PATCH the head' || name === 'DELETE the forum';
        expect([name, res.status, res.body.error?.code])
          .toEqual(guarded && res.status === 403 ? [name, 403, 'PERM_DENIED'] : [name, 404, 'NOT_FOUND']);
      }
      expect(await everything()).toEqual(before);
    } finally {
      await office.tag('B_AGENT', false);
      await memberships.updateOne(row, { $set: { role: 'agent' } });
    }
  });

  it.each([['0417', KPM_A], ['0555', KPM_B]] as const)('P19.22-T8 AC-1 %s’s list is its own forums alone, its core leaders its own', async (side, kpmId) => {
    session.current = sides[side].owner();
    const list = (await http().get('/leader-meetings').expect(200)).body;
    const own = await db().collection('leaderMeetings').find({ kpmId, deletedAt: null }).toArray();
    expect(list.meetings.map((m: { id: string }) => m.id).sort()).toEqual(own.map((m) => String(m._id)).sort());
    const leaders = list.coreLeaders.map((p: { name: string }) => p.name);
    expect(leaders).toEqual(side === '0417' ? ['Agus Salim', 'Sari Puspita'] : []);
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
    await expect(office.meetings.after(nobody, 1)).rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(office.meetings.syncLineage(nobody, [id], 'x', { status: 'done' })).rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(office.meetings.pullLineage(nobody, [id], 'x')).rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(office.links.findLive(nobody, 'x', new Date())).rejects.toBeInstanceOf(MissingTenantContextError);
  });
});
