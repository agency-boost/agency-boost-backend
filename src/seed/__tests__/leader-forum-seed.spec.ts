import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { MeetingView } from '@/modules/leader-meetings/leader-meeting.view';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildForumServices, type ForumServices } from '../../../test/forum-office';
import { seedDemo, type SeedResult } from '../demo';
import { FORUM_TOKENS, seedLeaderForumFixture } from '../leader-forum-fixture';
import { LeaderScorecardService } from '@/modules/leader-meetings/scorecard/scorecard.service';
import { MonthlyAgentData } from '@/modules/production/monthly-agent-data.schema';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';

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
 * **Phase 18.1 — the Strategic Leader Forum, seeded** (P18.1-T2 AC-10, P18.1-T4 AC-1; `leader-forum-fixture.ts`).
 *
 * The seed run as the command runs it, at 10:00 on Saturday 10 October 2026 in Jakarta, then read back through the
 * forum's own services, so what is asserted is what each account of the fixture's header table sees on a fresh seed.
 */
describe('Phase 18.1 the Strategic Leader Forum seed — a run at 10:00 on 10 October 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-10-10T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;
  let forum: ForumServices;
  let seeded: SeedResult;
  let owner: RequestContext;
  let views: Record<12 | 13 | 14, MeetingView>;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    seeded = await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    forum = await buildForumServices(wired);
    owner = await as('0417', 'owner@kpm0417.test', { owner: true });
    const ids = seeded.forum.meetings['0417'];
    views = {
      12: await forum.forum.read(owner, ids[12]),
      13: await forum.forum.read(owner, ids[13]),
      14: await forum.forum.read(owner, ids[14]),
    };
  }, RUN_MS);
  afterAll(stopMongo);

  it('P18.1-T2 AC-10 0417’s Owner lists three meetings, newest first: #14 in three days, #13 two weeks ago, #12 four', async () => {
    const list = await forum.forum.list(owner);
    expect(list.meetings.map((m) => [m.number, m.date, m.state, m.openItems])).toEqual([
      [14, '2026-10-13', 'upcoming', 4], [13, '2026-09-26', 'completed', 2], [12, '2026-09-12', 'completed', 0],
    ]);
    expect(list.meetings.map((m) => m.title)).toEqual(['Strategic Check-in — #14', 'Strategic Check-in — #13', 'Strategic Check-in — #12']);
    expect(list.can.create).toBe(true);
  });

  it('P18.1-T2 AC-10 #14: live; the ten items naming September; the prototype’s four rows; Monthly Target as drawn, Manpower empty', () => {
    const view = views[14];
    expect(view.scorecard.frozenAt).toBeNull();
    expect(view.agenda.preparation.map((i) => i.text)[1]).toBe('Prepare September performance data');
    expect([view.agenda.preparation, view.agenda.during, view.agenda.post].map((s) => s.length)).toEqual([3, 5, 2]);
    expect([...view.agenda.preparation, ...view.agenda.during, ...view.agenda.post].every((i) => i.pic === '' && !i.done)).toBe(true);
    expect(view.actionItems.map((r) => [r.initiative, r.status])).toEqual([
      ['Activity tracking tool adoption', 'planned'], ['Activity tracking tool adoption', 'planned'],
      ['Leads Generation Playbook', 'not_planned'], ['Team Management Playbook', 'not_planned'],
    ]);
    expect(Object.fromEntries(view.scorecard.rows.map((r) => [r.key, r.monthlyTarget?.value ?? null]))).toEqual({
      ape: 'TBD', manpower: '', flc: '8 (1 @ unit)', producing_agents: null, new_aa: 'TBD', new_agent_3m: null,
      avg_monthly_aa: '22 (3 @ unit)', case_submission: 'TBD', average_case_size: null,
    });
    expect(view.scorecard.rows.find((r) => r.key === 'manpower')!.monthlyTarget).toEqual({ value: '', version: 0 });
  });

  it('P18.1-T2 AC-10 the editors: live on #14 — the Owner, Maya Halim, Agus, Sari and Yosef, "3 core leaders tagged"; #13’s frozen before Yosef', () => {
    const live = views[14].editors;
    expect(live.owner!.name).toBe('Wilson Tanoto');
    expect(live.admins.map((p) => p.name)).toEqual(['Maya Halim']);
    expect(live.coreLeaders.map((p) => p.name)).toEqual(['Agus Prasetyo', 'Sari Puspita', 'Yosef Tambunan']);
    expect([live.coreLeaderCount, live.frozen]).toEqual([3, false]);
    for (const past of [views[13], views[12]]) {
      expect(past.editors.coreLeaders.map((p) => p.name)).toEqual(['Agus Prasetyo', 'Sari Puspita']);
      expect([past.editors.coreLeaderCount, past.editors.frozen]).toEqual([2, true]);
    }
  });

  it('P18.1-T2 AC-10 #13: frozen the morning after its day by the function a read runs; its three rows; #12 All clear', async () => {
    const stored = await col('leaderMeetings').findOne({ _id: new mongoose.Types.ObjectId(views[13].id) });
    expect(stored!.frozenAt).toEqual(new Date('2026-09-27T02:00:00Z'));
    // The same function over the same records, asked that morning: what was frozen.
    const thatMorning = new LeaderScorecardService(
      wired.officePeople, wired.productionReadings,
      new MonthlyAgentDataRepository(mongoose.model(MonthlyAgentData.name) as never), wired.memberships,
      new FixedClock(stored!.frozenAt as Date),
    );
    const input = { kpmId: owner.kpmId!, timezone: 'Asia/Jakarta', meetingDate: '2026-09-26' };
    expect(stored!.frozenScorecard).toEqual(await thatMorning.compute(input));
    /*
     * Asked today, every row but *3M new agent %* answers the same: the periods end at the meeting's date either way.
     * That row reads each new hire's 3M activation as it stands (P18.96-T6, `ACTIVATION_3M_PCT`), and three of the
     * year's — Indah, Dimas and Siti — passed day 90 since that morning: a live read would count them. The frozen one does
     * not move (ADR-0129 §7): 1 of 4 that morning, Pandu; 4 of 8 today.
     */
    const again = await forum.scorecards.compute(input);
    const others = (card: { rows: { key: string }[] }) => ({ ...card, rows: card.rows.filter((r) => r.key !== 'new_agent_3m') });
    expect(others(stored!.frozenScorecard)).toEqual(others(again));
    const ytd = (card: { rows: { key: string; cells: Record<string, unknown> }[] }) => card.rows.find((r) => r.key === 'new_agent_3m')!.cells.ytd;
    expect([ytd(stored!.frozenScorecard), ytd(again)]).toEqual([
      { kind: 'figure', value: 25, leavesOut: [] }, { kind: 'figure', value: 50, leavesOut: [] },
    ]);
    expect(views[13].actionItems.map((r) => r.status)).toEqual(['not_planned', 'planned', 'implemented']);
    expect(views[13].agenda.preparation.map((i) => i.text)).toEqual(['Compile follow-ups from August session', 'Prepare August performance data']);
    expect(views[12].openItems).toBe(0);
    expect(views[12].scorecard.frozenAt).toBe(new Date('2026-09-13T02:00:00Z').toISOString());
    // *3M new agent %* has a figure in FY: the cohort is seeded before the freeze.
    const threeMonths = views[13].scorecard.rows.find((r) => r.key === 'new_agent_3m')!;
    expect(threeMonths.cells.fy.kind).toBe('figure');
  });

  it('P18.1-T3 AC-1 the links: #13’s opens read-only for Rina, not tagged; #12’s expired; the raw tokens are nowhere stored', async () => {
    const rina = await as('0417', 'rina@kpm0417.test');
    const shared = await forum.sharing.open(rina, FORUM_TOKENS.live13);
    expect([shared.id, shared.via, shared.can.edit, shared.can.print]).toEqual([views[13].id, 'link', false, true]);
    await expect(forum.sharing.open(rina, FORUM_TOKENS.expired12)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(forum.forum.read(rina, views[14].id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(forum.forum.list(rina)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const links = await col('leaderMeetingShareLinks').find({}).toArray();
    expect(links.map((l) => l.tokenHash).sort()).toEqual(
      [FORUM_TOKENS.live13, FORUM_TOKENS.expired12].map((t) => createHash('sha256').update(t).digest('hex')).sort(),
    );
    const live = links.find((l) => l.meetingId === views[13].id)!;
    expect([live.createdAt, live.expiresAt]).toEqual([new Date('2026-10-08T03:00:00Z'), new Date('2026-10-22T03:00:00Z')]);
    expect(JSON.stringify(await col('leaderMeetingShareLinks').find({}).toArray())).not.toContain(FORUM_TOKENS.live13);
  });

  it('P18.1-T2 AC-10 Agus edits #14 by its address; 0555 has one meeting of its own; 0701 none; #15 comes next', async () => {
    const agus = await as('0417', 'agus@kpm0417.test');
    const row = views[14].actionItems[2];
    expect((await forum.minutes.saveActionItem(agus, views[14].id, row.id, { status: 'planned', version: row.version })).status).toBe('planned');
    const b = await as('0555', 'owner@kpm0555.test', { owner: true });
    expect((await forum.forum.list(b)).meetings.map((m) => [m.number, m.state])).toEqual([[1, 'upcoming']]);
    await expect(forum.forum.read(b, views[14].id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(forum.sharing.open(b, FORUM_TOKENS.live13)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const hadi = await as('0701', 'owner@kpm0701.test', { owner: true });
    expect((await forum.forum.list(hadi)).meetings).toEqual([]);
    expect((await forum.forum.create(owner, { title: 'Strategic Check-in — #15', date: '2026-10-27' })).number).toBe(15);
  });

  it('P18.1-T4 AC-1 every _id derived: the fixture run again writes nothing', async () => {
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
    expect(seeded.forum.written).toBeGreaterThan(0);
    expect(seeded.written.leaderMeetings).toBe(4);
    expect(seeded.written.leaderMeetingShareLinks).toBe(2);
  });
});
