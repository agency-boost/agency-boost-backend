import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { MeetingView } from '@/modules/leader-meetings/leader-meeting.view';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildForumServices, type ForumServices } from '../../../test/forum-office';
import { seedDemo, type SeedResult } from '../demo';
import { FORUM_TOKENS, seedLeaderForumFixture } from '../leader-forum-fixture';

const RUN_MS = 300_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

/** The account's live membership in an office, as a signed-in context. */
async function as(code: string, email: string, flags: { owner?: boolean; admin?: boolean } = {}): Promise<RequestContext> {
  const kpm = await col('kpms').findOne({ code });
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').findOne({ kpmId: String(kpm!._id), userId: String(account!._id), status: 'active' }))!;
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
    status: 'active', isKpmOwner: flags.owner ?? false, isKpmAdmin: flags.admin ?? false, directCount: 0,
  } as never);
}

/**
 * **P19.22-T8 — the Strategic Leader Forum, seeded** (`leader-forum-fixture.ts`; ADR-0276). The seed run as the command
 * runs it, at 10:00 on Friday 20 November 2026 in Jakarta, then read back through the forum's own services.
 */
describe('P19.22-T8 the Strategic Leader Forum seed — a run at 10:00 on 20 November 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-11-20T03:00:00Z'));
  let forum: ForumServices;
  let seeded: SeedResult;
  let owner: RequestContext;
  let views: Record<12 | 13 | 14 | 15, MeetingView>;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    seeded = await seedDemo({ clock, log: quiet });
    const wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    forum = await buildForumServices(wired);
    owner = await as('0417', 'owner@kpm0417.test', { owner: true });
    const ids = seeded.forum.meetings['0417'];
    views = {
      12: await forum.forum.read(owner, ids[12]),
      13: await forum.forum.read(owner, ids[13]),
      14: await forum.forum.read(owner, ids[14]),
      15: await forum.forum.read(owner, ids[15]),
    };
  }, RUN_MS);
  afterAll(stopMongo);

  it('P19.22-T8 AC-1 0417 lists four forums, newest first, every two weeks at 14:00; #15 is Forum berikutnya, in eight days', async () => {
    const list = await forum.forum.list(owner);
    expect(list.meetings.map((m) => [m.number, m.date, m.time, m.state])).toEqual([
      [15, '2026-11-28', '14:00', 'upcoming'], [14, '2026-11-15', '14:00', 'completed'],
      [13, '2026-11-01', '14:00', 'completed'], [12, '2026-10-18', '14:00', 'completed'],
    ]);
    expect(list.nextId).toBe(views[15].id);
    expect(list.meetings[0]).toMatchObject({ daysUntil: 8, agendaCount: 3 });
    expect(list.meetings[1].actionProgress).toEqual({ done: 1, total: 5 });
    expect(list.meetings[3].actionProgress).toEqual({ done: 3, total: 3 });
    expect(list.coreLeaders.map((p) => p.firstName).sort()).toEqual(['Agus', 'Sari', 'Yosef']);
  });

  it('P19.22-T8 AC-4 #14 carries #13’s two open items as the same lineage, dari forum #13; #15 carries #14’s four open ones', () => {
    const carried14 = views[14].actionItems.filter((i) => i.fromNumber === 13);
    expect(carried14.map((i) => [i.text, i.status])).toEqual([
      ['Aktifkan 3 agent yang belum aktif di Tanpa group', 'doing'],
      ['Coaching 1-on-1 tiap minggu untuk agent baru', 'done'],
    ]);
    const lineages13 = new Set(views[13].actionItems.map((i) => i.lineageId));
    expect(carried14.every((i) => lineages13.has(i.lineageId))).toBe(true);
    expect(views[15].actionItems.map((i) => i.fromNumber)).toEqual([13, 14, 14, 14]);
    expect(views[15].actionItems.every((i) => i.status !== 'done')).toBe(true);
    expect(views[14].agenda.map((l) => l.done)).toEqual([true, true, true, false, false]);
    expect(views[14].agenda[1].picAll).toBe(true);
    // Every PIC is somebody the screen can draw.
    for (const view of Object.values(views)) {
      const known = new Set(view.people.map((p) => p.membershipId));
      for (const id of [...view.agenda, ...view.actionItems].map((i) => i.picMembershipId).filter((x): x is string => x !== null)) {
        expect(known.has(id)).toBe(true);
      }
    }
  });

  it('P19.22-T8 AC-4 a status on #14 reaches #15; the trash on #14 removes #15’s copy too', async () => {
    const item = views[14].actionItems.find((i) => i.text.startsWith('Siapkan Closing'))!;
    await forum.minutes.saveActionItem(owner, views[14].id, item.id, { status: 'doing', version: item.version });
    const fifteen = await forum.forum.read(owner, views[15].id);
    expect(fifteen.actionItems.find((i) => i.lineageId === item.lineageId)!.status).toBe('doing');
    const other = views[14].actionItems.find((i) => i.text.startsWith('Naikkan'))!;
    await forum.minutes.removeActionItem(owner, views[14].id, other.id, other.version);
    expect((await forum.forum.read(owner, views[15].id)).actionItems.some((i) => i.lineageId === other.lineageId)).toBe(false);
  });

  it('P19.22-T8 AC-2 #14’s link opens read-only for Rina; #12’s is expired; 0555 has one forum of its own; 0701 none', async () => {
    const rina = await as('0417', 'rina@kpm0417.test');
    expect((await forum.sharing.open(rina, FORUM_TOKENS.live14)).id).toBe(views[14].id);
    await expect(forum.sharing.open(rina, FORUM_TOKENS.expired12)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(forum.forum.list(rina)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const b = await as('0555', 'owner@kpm0555.test', { owner: true });
    expect((await forum.forum.list(b)).meetings.map((m) => [m.number, m.state, m.actionProgress.total])).toEqual([[1, 'upcoming', 0]]);
    await expect(forum.forum.read(b, views[14].id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const hadi = await as('0701', 'owner@kpm0701.test', { owner: true });
    expect((await forum.forum.list(hadi)).meetings).toEqual([]);
  });

  it('P19.22-T8 every _id derived: the fixture run again writes nothing; + Forum baru makes #16', async () => {
    const ids = async (code: string, email: string) => {
      const ctx = await as(code, email);
      return { membershipId: ctx.membershipId!, userId: ctx.userId };
    };
    const again = await seedLeaderForumFixture({
      clock,
      '0417': {
        kpmId: owner.kpmId!, owner: await ids('0417', 'owner@kpm0417.test'), admin: await ids('0417', 'admin@kpm0417.test'),
        agus: await ids('0417', 'agus@kpm0417.test'), sari: await ids('0417', 'sari@kpm0417.test'),
      },
      '0555': { kpmId: (await as('0555', 'owner@kpm0555.test')).kpmId!, owner: await ids('0555', 'owner@kpm0555.test') },
    });
    expect(again.written).toBe(0);
    expect(again.meetings['0417']).toEqual(seeded.forum.meetings['0417']);
    expect(seeded.written.leaderMeetings).toBe(5);
    expect(seeded.written.leaderMeetingShareLinks).toBe(2);
    expect((await forum.forum.create(owner, { date: '2026-12-12', time: '14:00' })).number).toBe(16);
  });
});
