import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { TEMPLATE_HEADER_V1 } from '@/modules/production/production-template';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { ROSTER_NOW, type Who } from '../../../test/coaching-office';
import { buildForumOffice, KPM_A, type ForumOffice } from '../../../test/forum-office';
import { frozenBeforeTheSlide } from '../../../test/frozen-scorecard';
import { columnPeriods } from './scorecard/scorecard.service';

const M = 1_000_000 * 100;
/** The twelve value columns of a version 1 file, keyed `metric.cadence` as these specs name them (P19.5-T2). */
const VALUE_COLUMNS = (['monthly', 'ytd'] as const).flatMap((cadence) =>
  (['ape', 'persistency', 'recruitment', 'newActiveAgents', 'fyp', 'policyCount'] as const).map((metric) => ({ metric, cadence })));

/**
 * **Live, then frozen** (P18.1-T2 AC-4; ADR-0129 §6, §7; exit test 2): while a meeting is upcoming every read computes
 * its scorecard through `LeaderScorecardService` — the one function every figure goes through — and reads its editors
 * from the tag; the first read once it is *Completed* writes both onto it, once, however many first reads race; a
 * read-only support session writes nothing; and **after the freeze, a correction to a past month, an import, a revert,
 * a member removed and a member tagged change nothing in it**, while the same function asked again answers otherwise.
 *
 * Today is 10:00 on Monday 14 September 2026 in Jakarta. The office's file holds August and September.
 */
describe('the forum’s scorecard, live then frozen (P18.1-T2 AC-4, exit test 2)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: ForumOffice;
  const db = () => mongoose.connection.db!;
  const owner = () => office.as('OWNER');
  const make = async (title: string, date: string) => office.forum.create(owner(), { title, date });
  const frozenRows = (meetingId: string) => db().collection('auditLog').find({ action: 'leader_meeting.frozen', targetId: meetingId }).toArray();
  const stored = (meetingId: string) => db().collection('leaderMeetings').findOne({ _id: new mongoose.Types.ObjectId(meetingId) });
  const computed = (date: string) => office.scorecards.compute({ kpmId: KPM_A, timezone: 'Asia/Jakarta', meetingDate: date });
  /** The served scorecard without what the meeting lays over it. */
  const bare = (view: Awaited<ReturnType<ForumOffice['forum']['read']>>) => ({
    periods: view.scorecard.periods,
    chips: view.scorecard.chips,
    rows: view.scorecard.rows.map(({ key, unit, cells }) => ({ key, unit, cells })),
    asOf: view.scorecard.asOf.kind === 'date' ? view.scorecard.asOf.date : null,
    definitions: view.scorecard.definitions,
  });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildForumOffice(wired);
  }, 120_000);

  afterAll(stopMongo);
  afterEach(() => (wired.clock as FixedClock).set(ROSTER_NOW));

  it('P18.1-T2 AC-4 live while upcoming: every read is the scorecard function’s answer for the date, and writes nothing', async () => {
    const meeting = await make('Upcoming', '2026-09-17');
    const first = await office.forum.read(owner(), meeting.id);
    expect(first.scorecard.frozenAt).toBeNull();
    expect(bare(first)).toEqual(await computed('2026-09-17'));
    expect(first.scorecard.periods).toEqual(columnPeriods('2026-09-17'));
    expect(first.editors.frozen).toBe(false);
    // A member's figures move: the next read shows it.
    await db().collection('monthlyAgentData').updateOne(
      { kpmId: KPM_A, membershipId: office.id.INDAH, month: '2026-08' }, { $set: { 'values.APE.value': 25 * M } },
    );
    const again = await office.forum.read(owner(), meeting.id);
    expect(bare(again)).toEqual(await computed('2026-09-17'));
    expect(bare(again)).not.toEqual(bare(first));
    expect((await stored(meeting.id))!.frozenAt).toBeNull();
    expect(await frozenRows(meeting.id)).toEqual([]);
  });

  it('P18.1-T2 AC-4 the columns are named from the meeting’s own year: a 2025 meeting reads FY 2024 and YTD 2025', async () => {
    const meeting = await make('Last year', '2025-06-10');
    const view = await office.forum.read(office.supported('OWNER'), meeting.id);
    expect(view.scorecard.periods).toEqual({
      fy: { from: '2024-01', to: '2024-12' }, ytdLastYear: { from: '2024-01', to: '2024-06' }, ytd: { from: '2025-01', to: '2025-06' },
      thisMonthLastYear: { from: '2024-06', to: '2024-06' }, lastMonth: { from: '2025-05', to: '2025-05' }, thisMonth: { from: '2025-06', to: '2025-06' },
    });
  });

  it('P18.1-T2 AC-4 the first read once Completed writes the scorecard and the editors onto it, once, audited', async () => {
    const meeting = await make('Past', '2026-09-07');
    const view = await office.forum.read(office.as('SARI'), meeting.id);
    expect(view.state).toBe('completed');
    expect(view.scorecard.frozenAt).toBe(ROSTER_NOW.toISOString());
    expect(view.editors).toMatchObject({ frozen: true, coreLeaderCount: 2 });
    const row = (await stored(meeting.id))!;
    expect(row.frozenAt).toEqual(ROSTER_NOW);
    expect(row.frozenScorecard).toEqual(await computed('2026-09-07'));
    // P19.3-T1 AC-7 (ADR-0202 §4): the freeze stores the definitions its rows were computed with, and serves them.
    expect([row.frozenScorecard.definitions, view.scorecard.definitions]).toEqual(['data_sources', 'data_sources']);
    expect(row.frozenCoeditors).toEqual([
      { membershipId: office.id.OWNER, as: 'owner', rungCode: 'AB', tagged: false },
      { membershipId: office.id.ADMIN, as: 'admin', rungCode: 'AB', tagged: false },
      ...[office.id.AGUS, office.id.SARI].sort().map(() => expect.objectContaining({ as: 'core_leader', tagged: true })),
    ]);
    expect(row.frozenCoeditors.map((e: { membershipId: string }) => e.membershipId).sort())
      .toEqual([office.id.OWNER, office.id.ADMIN, office.id.AGUS, office.id.SARI].sort());
    const [entry] = await frozenRows(meeting.id);
    expect(entry).toMatchObject({
      targetCollection: 'leaderMeetings', before: null, actorMembershipId: office.id.SARI,
      after: { frozenAt: ROSTER_NOW.toISOString(), editors: row.frozenCoeditors.map((e: { membershipId: string }) => e.membershipId) },
    });
    // From then on nothing recomputes it: a later read a week on serves the same, and writes nothing.
    (wired.clock as FixedClock).set(new Date('2026-09-21T03:00:00Z'));
    const later = await office.forum.read(owner(), meeting.id);
    expect(later.scorecard).toEqual(view.scorecard);
    expect(await frozenRows(meeting.id)).toHaveLength(1);
  });

  it('P18.1-T2 AC-4 two first reads at once write once, and both are answered the one freeze', async () => {
    const meeting = await make('Raced', '2026-09-08');
    const [a, b] = await Promise.all([office.forum.read(owner(), meeting.id), office.forum.read(office.as('ADMIN'), meeting.id)]);
    expect(a.scorecard).toEqual(b.scorecard);
    expect(a.scorecard.frozenAt).not.toBeNull();
    expect(await frozenRows(meeting.id)).toHaveLength(1);
  });

  it('P18.1-T2 AC-1 a read-only support session’s read writes no freeze: computed as the freeze would, frozenAt null; the next member’s writes it', async () => {
    const meeting = await make('Supported', '2026-09-09');
    const supported = await office.forum.read(office.supported('OWNER'), meeting.id);
    expect(supported.state).toBe('completed');
    expect(supported.scorecard.frozenAt).toBeNull();
    expect(supported.editors.frozen).toBe(false);
    expect(bare(supported)).toEqual(await computed('2026-09-09'));
    expect((await stored(meeting.id))!.frozenAt).toBeNull();
    expect(await frozenRows(meeting.id)).toEqual([]);
    // By a link too.
    const link = await office.sharing.create(owner(), meeting.id);
    expect((await office.sharing.open(office.supported('RINA'), link.token)).scorecard.frozenAt).toBeNull();
    expect((await stored(meeting.id))!.frozenAt).toBeNull();
    const member = await office.forum.read(office.as('AGUS'), meeting.id);
    expect(member.scorecard.frozenAt).not.toBeNull();
    expect(await frozenRows(meeting.id)).toHaveLength(1);
  });

  it('P18.1-T2 AC-4 an elevated session’s read is a member’s read: it writes the freeze, both actors on its row', async () => {
    const meeting = await make('Elevated', '2026-09-10');
    await office.forum.read(office.supported('ADMIN', false), meeting.id);
    const [entry] = await frozenRows(meeting.id);
    expect(entry).toMatchObject({ actorUserId: 'u-support', effectiveUserId: office.as('ADMIN').userId });
  });

  it('P18.1-T2 AC-4 the frozen editors are its record of who could edit then: tagging somebody since moves the upcoming list, not it', async () => {
    const past = await make('Before the tag', '2026-09-11');
    await office.forum.read(owner(), past.id);
    const upcoming = await make('After the tag', '2026-09-25');
    await office.tag('PEER_AB', true);
    try {
      const pastView = await office.forum.read(owner(), past.id);
      const upcomingView = await office.forum.read(owner(), upcoming.id);
      expect(pastView.editors.coreLeaders.map((p) => p.name)).not.toContain('Hendra Gunawan');
      expect(pastView.editors.coreLeaderCount).toBe(2);
      expect(upcomingView.editors.coreLeaders.map((p) => p.name)).toContain('Hendra Gunawan');
      expect(upcomingView.editors.coreLeaderCount).toBe(3);
      // Who may edit **now** is the tag today, on every meeting: Hendra edits the past one.
      const row = await office.minutes.addActionItem(office.as('PEER_AB'), past.id);
      expect(row.status).toBe('not_planned');
      expect(pastView.accessNote).toEqual({ ownerName: 'Wilson Tanoto', adminNames: ['Maya Kusuma'] });
      // The list draws each card's own: the frozen past one, the live upcoming one.
      const list = await office.forum.list(owner());
      expect(list.meetings.find((m) => m.id === past.id)!.editors).toMatchObject({ frozen: true, coreLeaderCount: 2 });
      expect(list.meetings.find((m) => m.id === upcoming.id)!.editors).toMatchObject({ frozen: false, coreLeaderCount: 3 });
    } finally {
      await office.tag('PEER_AB', false);
    }
  });

  it('P18.1-T2 AC-4, P18.9-T1 AC-10 the Monthly Target is never frozen: typed after the freeze, its rate × the frozen units', async () => {
    const meeting = await make('Targets after', '2026-09-12');
    const frozen = await office.forum.read(owner(), meeting.id);
    const units = frozen.scorecard.chips.units;
    const saved = await office.minutes.saveMonthlyTarget(office.as('AGUS'), meeting.id, 'case_submission', { rate: 2, version: 0 });
    expect(saved).toEqual({ rate: 2, value: 2 * units, typed: null, version: 1 });
    const after = await office.forum.read(owner(), meeting.id);
    expect(after.scorecard.rows.find((r) => r.key === 'case_submission')!.monthlyTarget).toEqual(saved);
    expect(bare(after)).toEqual(bare(frozen));
    expect(after.scorecard.frozenAt).toBe(frozen.scorecard.frozenAt);
  });

  it('P18.9-T1 AC-19 a scorecard frozen before the reference slide is read tolerantly: — where it lacks, its own units, nothing recomputed or written', async () => {
    const meeting = await make('Kept before the slide', '2026-09-12');
    const editors = await office.people.liveEditors(owner(), await office.people.office(owner()));
    const frozenAt = new Date('2026-09-13T02:00:00Z');
    await db().collection('leaderMeetings').updateOne({ _id: new mongoose.Types.ObjectId(meeting.id) }, {
      $set: {
        frozenScorecard: frozenBeforeTheSlide(), frozenAt, frozenCoeditors: editors,
        // A rate typed since, and New AA's text from before, which stays.
        monthlyTargets: { flc: { rate: 2, typed: null, version: 1 }, new_aa: { value: 'TBD', version: 1 } },
      },
    });
    const before = { meeting: await stored(meeting.id), audit: await db().collection('auditLog').countDocuments() };

    const view = await office.forum.read(owner(), meeting.id);
    const row = (key: string) => view.scorecard.rows.find((r) => r.key === key)!;
    expect(view.scorecard.frozenAt).toBe(frozenAt.toISOString());
    // What it lacks reads —: last year's YTD on every row, Cases/producing agents' years, AS OF.
    expect(view.scorecard.rows.map((r) => r.cells.ytdLastYear.kind)).toEqual(Array(9).fill('unrecorded'));
    expect(Object.values(row('cases_per_producing_agent').cells).map((c) => c.kind))
      .toEqual(['unrecorded', 'unrecorded', 'unrecorded', 'blocked', 'blocked', 'blocked']);
    expect(view.scorecard.asOf).toEqual({ kind: 'unrecorded' });
    // P19.3-T1 AC-7 (ADR-0202 §4): it stores no definitions — frozen before the data sources — so it is served as the
    // reference slide's, and the screen draws those footnotes: its 3M figure is ADR-0171's, never recomputed as D7.
    expect(view.scorecard.definitions).toBe('reference_slide');
    // What it has that the table no longer draws is kept, and not served.
    expect(view.scorecard.rows.map((r) => r.key)).not.toContain('new_aa');
    expect(row('ape').cells.ytd).toEqual({ kind: 'figure', value: 5_800 * M, leavesOut: [] });
    // Its # of units is the five it froze with, and its target's multiplier follows: 2 per unit, 10.
    expect(view.scorecard.chips.units).toBe(5);
    expect(row('flc').monthlyTarget).toEqual({ rate: 2, value: 10, typed: null, version: 1 });
    expect(row('ape').ytdChange).toEqual({ kind: 'none' });
    // A target written now answers at the frozen units too.
    const saved = await office.minutes.saveMonthlyTarget(owner(), meeting.id, 'avg_monthly_aa', { rate: 3, version: 0 });
    expect(saved).toEqual({ rate: 3, value: 15, typed: null, version: 1 });

    // Nothing recomputed, nothing written but the target: the stored scorecard is the one it froze, New AA and all.
    const after = await stored(meeting.id);
    expect(after!.frozenScorecard).toEqual(before.meeting!.frozenScorecard);
    expect(after!.frozenScorecard).toEqual(frozenBeforeTheSlide());
    expect(after!.monthlyTargets.new_aa).toEqual({ value: 'TBD', version: 1 });
    expect(await frozenRows(meeting.id)).toEqual([]);
    expect(await db().collection('auditLog').countDocuments()).toBe(before.audit + 1);
  });

  describe('exit test 2 — frozen: what was discussed stays what was discussed', () => {
    const agentCodeOf = async (who: Who) =>
      (await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id[who]) }))!.agentCode as string;
    const file = async (...rows: [Who, Record<string, string>][]) => ({
      buffer: Buffer.from([
        TEMPLATE_HEADER_V1.join(','),
        ...(await Promise.all(rows.map(async ([who, cells]) =>
          [await agentCodeOf(who), '"x"', ...VALUE_COLUMNS.map((c) => cells[`${c.metric}.${c.cadence}`] ?? '')].join(',')))),
      ].join('\n')),
      originalname: 'f.csv',
      size: 0,
    });

    it('P18.1-T2 AC-4 exit test 2: a correction to a past month, an import, a revert and a member removed after the freeze change nothing in it', async () => {
      const meeting = await make('Exit test 2', '2026-09-13');
      const frozen = await office.forum.read(owner(), meeting.id);
      expect(frozen.scorecard.frozenAt).not.toBeNull();
      const before = (await stored(meeting.id))!.frozenScorecard;

      // A correction to a past month: August, reopened — its window is long closed.
      await wired.productionMonths.reopen(owner(), '2026-08');
      const revision = (await wired.productionMonths.state(owner(), '2026-08')).revision;
      await wired.productionCorrections.correct(owner(), {
        month: '2026-08', membershipId: office.id.INDAH, kode: 'APE', ytd: false, value: 90 * M, revision,
        reason: 'The carrier restated it by email',
      });
      // An import into this month, and a revert of it.
      const f = await file(['NINA', { 'ape.monthly': '12', 'ape.ytd': '40', 'policyCount.monthly': '3' }], ['DODI', { 'ape.monthly': '5', 'ape.ytd': '5' }]);
      const preview = await wired.production.preview(owner(), '2026-09', f);
      const batch = await wired.productionImport.commit(owner(), '2026-09', String(preview.revision), f);
      const afterImport = await office.forum.read(owner(), meeting.id);
      expect(afterImport.scorecard).toEqual(frozen.scorecard);
      await wired.productionImport.revert(owner(), batch.batch.id);
      // A member with production removed from the office.
      await db().collection('memberships').updateOne(
        { _id: new mongoose.Types.ObjectId(office.id.DIMAS) }, { $set: { status: 'removed', removedAt: new Date('2026-09-13T03:00:00Z') } },
      );

      const after = await office.forum.read(owner(), meeting.id);
      expect(after.scorecard).toEqual(frozen.scorecard);
      expect((await stored(meeting.id))!.frozenScorecard).toEqual(before);
      expect(await frozenRows(meeting.id)).toHaveLength(1);
      // The same function, asked again for the same date, answers otherwise: the changes were there to see.
      expect(await computed('2026-09-13')).not.toEqual(before);
    });
  });
});
