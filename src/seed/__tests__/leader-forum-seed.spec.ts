import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { MeetingView } from '@/modules/leader-meetings/leader-meeting.view';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildForumServices, scorecardServiceOf, type ForumServices } from '../../../test/forum-office';
import { seedDemo, type SeedResult } from '../demo';
import { FORUM_REMARKS, FORUM_TOKENS, seedLeaderForumFixture } from '../leader-forum-fixture';

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

  it('P18.1-T2 AC-10, P18.9-T2 AC-4 #14: live; the ten items naming October, its own month; the four rows, the first remark dated from it', () => {
    const view = views[14];
    expect(view.scorecard.frozenAt).toBeNull();
    // In Bahasa Indonesia, as the service writes it for an Indonesian reader (P18.10-T7).
    expect(view.agenda.preparation.map((i) => i.text)[1]).toBe('Siapkan data kinerja Oktober');
    expect([view.agenda.preparation, view.agenda.during, view.agenda.post].map((s) => s.length)).toEqual([3, 5, 2]);
    expect([...view.agenda.preparation, ...view.agenda.during, ...view.agenda.post].every((i) => i.pic === '' && !i.done)).toBe(true);
    expect(view.actionItems.map((r) => [r.initiative, r.status])).toEqual([
      ['Adopsi Activity Tracking Tool', 'planned'], ['Adopsi Activity Tracking Tool', 'planned'],
      ['Playbook Leads Generation', 'not_planned'], ['Playbook Team Management', 'not_planned'],
    ]);
    // A week after #14's 13 October, where the prototype's *"Scheduled for 2 Sept"* stood still.
    expect(view.actionItems[0].remarks).toBe(FORUM_REMARKS.scheduled('20 Okt'));
  });

  it('P18.9-T1 AC-20, P19.3-T1 AC-15 #14’s targets are rates × its 7 units — the leaders who lead somebody; New AA’s kept, not drawn', async () => {
    const view = views[14];
    // P19.3-T1 (ADR-0203 §1): five ABs and four AABs, two of whom lead nobody — 7 units, where it read 9.
    expect(view.scorecard.chips).toMatchObject({ ab: 5, aab: 4, units: 7 });
    const units = view.scorecard.chips.units;
    expect(Object.fromEntries(view.scorecard.rows.map((r) => [r.key, r.monthlyTarget]))).toEqual({
      ape: { rate: null, value: null, typed: null, version: 1 },
      manpower: { rate: null, value: null, typed: null, version: 0 },
      flc: { rate: 1, value: units, typed: null, version: 1 },
      producing_agents: null,
      new_agent_3m: null,
      avg_monthly_aa: { rate: 3, value: 3 * units, typed: null, version: 1 },
      case_submission: { rate: null, value: null, typed: null, version: 1 },
      cases_per_producing_agent: null,
      average_case_size: null,
    });
    const stored = await col('leaderMeetings').findOne({ _id: new mongoose.Types.ObjectId(view.id) });
    expect(stored!.monthlyTargets.new_aa).toEqual({ value: 'TBD', version: 1 });
  });

  it('P18.9-T1 AC-20 0417’s file holds every month of last year, so Full Year and YTD 2025 read whole years: no (*) note on either', async () => {
    const months = (await col('productionMonths').find({ kpmId: owner.kpmId, month: { $regex: '^2025-' }, deletedAt: null }).toArray())
      .map((m) => m.month as string).sort();
    expect(months).toEqual(Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`));
    const view = views[14];
    expect(view.scorecard.partialPeriods.map((p) => p.column)).not.toEqual(expect.arrayContaining(['fy']));
    expect(view.scorecard.partialPeriods.map((p) => p.column)).not.toContain('ytdLastYear');
    for (const key of ['ape', 'producing_agents', 'avg_monthly_aa', 'case_submission', 'cases_per_producing_agent', 'average_case_size'] as const) {
      const row = view.scorecard.rows.find((r) => r.key === key)!;
      expect([key, row.cells.fy.kind, row.cells.ytdLastYear.kind]).toEqual([key, 'figure', 'figure']);
    }
    // *AS OF*: yesterday's corrected upload of this month's file.
    expect(view.scorecard.asOf).toEqual({ kind: 'date', date: '2026-10-09' });
    expect(view.scorecard.rows.find((r) => r.key === 'ape')!.ytdChange.kind).toBe('figure');
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
    const thatMorning = scorecardServiceOf(wired, new FixedClock(stored!.frozenAt as Date));
    const input = { kpmId: owner.kpmId!, timezone: 'Asia/Jakarta', meetingDate: '2026-09-26' };
    expect(stored!.frozenScorecard).toEqual(await thatMorning.compute(input));
    /*
     * Asked today, every row answers the same: the periods end at the meeting's date either way. *3M new agent %* reads
     * the office's file month by month since P19.3-T1 (`NEW_AGENT_ACTIVATION_3M_PCT`, ADR-0202), and the file has not
     * moved since that morning — so it reads 80% both, where New Hires' day-90 share moved from 88% to 89% overnight. A
     * live read would move with the file; the frozen one never does (ADR-0129 §7).
     */
    const again = await forum.scorecards.compute(input);
    const others = (card: { rows: { key: string }[] }) => ({ ...card, rows: card.rows.filter((r) => r.key !== 'new_agent_3m') });
    expect(others(stored!.frozenScorecard)).toEqual(others(again));
    const ytd = (card: { rows: { key: string; cells: Record<string, unknown> }[] }) => card.rows.find((r) => r.key === 'new_agent_3m')!.cells.ytd;
    expect([ytd(stored!.frozenScorecard), ytd(again)]).toEqual([
      { kind: 'figure', value: 80, leavesOut: [] }, { kind: 'figure', value: 80, leavesOut: [] },
    ]);
    // Frozen since P19.3-T1: it carries the definitions it was computed with, so its footnotes are D7's.
    expect([stored!.frozenScorecard.definitions, views[13].scorecard.definitions]).toEqual(['data_sources', 'data_sources']);
    expect(views[13].actionItems.map((r) => r.status)).toEqual(['not_planned', 'planned', 'implemented']);
    // P18.9-T2 AC-4: the follow-ups the session before's; the month item #13's own month.
    expect(views[13].agenda.preparation.map((i) => i.text)).toEqual(['Kumpulkan follow-up dari sesi Agustus', 'Siapkan data kinerja September']);
    expect(views[13].actionItems[1].remarks).toBe(FORUM_REMARKS.scheduled('3 Okt'));
    expect(views[12].openItems).toBe(0);
    expect(views[12].actionItems[0].remarks).toBe(FORUM_REMARKS.done('5 Sep'));
    expect(views[12].scorecard.frozenAt).toBe(new Date('2026-09-13T02:00:00Z').toISOString());
    // *3M new agent %* has a figure in FY: the cohort is seeded before the freeze.
    const threeMonths = views[13].scorecard.rows.find((r) => r.key === 'new_agent_3m')!;
    expect(threeMonths.cells.fy.kind).toBe('figure');
  });

  it('P18.9-T1 AC-19, AC-20 #12 keeps a scorecard frozen in the old shape, read tolerantly: — where it lacks, its own 5 units', async () => {
    const stored = await col('leaderMeetings').findOne({ _id: new mongoose.Types.ObjectId(views[12].id) });
    const frozen = stored!.frozenScorecard as { periods: Record<string, unknown>; chips: Record<string, number>; rows: { key: string; cells: Record<string, unknown> }[] };
    // The shape before the reference slide: five columns, nine rows with New AA, # of units the AB agencies, no AS OF.
    expect(frozen.periods).toEqual({ fy: '2025', ytd: '2026', thisMonthLastYear: '2025-09', lastMonth: '2026-08', thisMonth: '2026-09' });
    expect(frozen.rows.map((r) => r.key)).toEqual([
      'ape', 'manpower', 'flc', 'producing_agents', 'new_aa', 'new_agent_3m', 'avg_monthly_aa', 'case_submission', 'average_case_size',
    ]);
    expect(frozen.rows.every((r) => Object.keys(r.cells).join() === 'fy,ytd,thisMonthLastYear,lastMonth,thisMonth')).toBe(true);
    expect(frozen.chips.units).toBe(frozen.chips.ab);
    expect('asOf' in frozen).toBe(false);
    expect(frozen.rows.find((r) => r.key === 'new_aa')!.cells.fy).toMatchObject({ kind: 'figure' });

    const view = views[12].scorecard;
    expect(view.rows.map((r) => r.cells.ytdLastYear.kind)).toEqual(Array(9).fill('unrecorded'));
    expect(view.rows.find((r) => r.key === 'cases_per_producing_agent')!.cells.fy).toEqual({ kind: 'unrecorded' });
    expect(view.asOf).toEqual({ kind: 'unrecorded' });
    expect(view.chips.units).toBe(frozen.chips.ab);
    expect(view.rows.find((r) => r.key === 'flc')!.monthlyTarget).toMatchObject({ rate: 1, value: frozen.chips.ab });
    // #13 froze in today's shape, its AS OF the day of the upload before its morning.
    expect(views[13].scorecard.asOf.kind).toBe('date');
    expect(views[13].scorecard.rows.find((r) => r.key === 'cases_per_producing_agent')!.cells.fy.kind).toBe('figure');
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
