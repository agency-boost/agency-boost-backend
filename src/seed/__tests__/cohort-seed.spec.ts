import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { addDays } from '@/common/time/local-day';
import { cohortCompletionRate, lastFinishedYear } from '@/domain/metrics/activation-completion-rate';
import { activationEndsOn, activationState } from '@/modules/activation/activation-rules';
import type { ComputedScorecard } from '@/modules/leader-meetings/scorecard/scorecard.types';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { scorecardServiceOf } from '../../../test/forum-office';
import { COHORT_HIRES, seedActivationCohort, type CohortSeed } from '../cohort-fixture';
import { seedObjectId } from '../coaching-fixture';
import { seedDemo } from '../demo';
import type { ReportingKey } from '../reporting-fixture';

const RUN_MS = 300_000;
const TZ = 'Asia/Jakarta';
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

/** The account's membership in 0417 — the live one, or the one they left with. */
async function membershipOf(email: string) {
  const account = await col('users').findOne({ email });
  return (await col('memberships').find({ userId: String(account!._id) }).sort({ status: 1 }).toArray())[0];
}

async function as(email: string, flags: { owner?: boolean; admin?: boolean } = {}): Promise<RequestContext> {
  const member = await membershipOf(email);
  const directs = await col('memberships').countDocuments({ leaderId: String(member._id), status: 'active' });
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
    status: 'active', isKpmOwner: flags.owner ?? false, isKpmAdmin: flags.admin ?? false, directCount: directs,
  } as never);
}

/** A read's answer, or what it refused with: either way something to compare. */
const settled = async (read: () => Promise<unknown>) => {
  try {
    return { ok: JSON.parse(JSON.stringify(await read())) as unknown };
  } catch (err) {
    return { refused: (err as Error).message };
  }
};

/**
 * **The cohort seed** (P18.1-T1; `cohort-fixture.ts`): run after the demo as `demo.ts` runs it, then read back through
 * the scorecard's own service — so what is asserted is what the Owner sees in a meeting's *3M new agent %* — and
 * through every walk the contract names, which must not move.
 */
describe('P18.1-T1 the cohort seed — a run at 10:00 on 10 October 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-10-10T03:00:00Z'));
  const today = clock.localDateFor(TZ);
  let wired: ReturnType<typeof configModule>;
  let kpmId: string;
  let cast: Record<ReportingKey, { id: string }>;
  let first: CohortSeed;
  let before: Record<string, unknown>;
  let after: Record<string, unknown>;

  /** Every walk the contract keeps still: the New hires roster, activation page, nav, coaching roster and Unit Dashboard. */
  const walks = async () => {
    const out: Record<string, unknown> = {};
    for (const [who, flags] of [['owner', { owner: true }], ['agus', {}], ['sari', {}], ['arief', {}], ['dewi', {}]] as const) {
      const ctx = await as(`${who}@kpm0417.test`, flags);
      out[`${who} new hires`] = await settled(() => wired.newHires.roster(ctx));
      out[`${who} activation`] = await settled(() => wired.activationProgress.mine(ctx));
      out[`${who} nav`] = await settled(() => wired.activationProgress.factsFor(ctx));
      out[`${who} coaching roster`] = await settled(() => wired.coachingRoster.read(ctx));
      out[`${who} unit dashboard`] = await settled(() => wired.unitDashboard.read(ctx));
    }
    return out;
  };

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    kpmId = String((await col('kpms').findOne({ code: '0417' }))!._id);
    cast = {} as Record<ReportingKey, { id: string }>;
    for (const key of COHORT_HIRES) cast[key] = { id: String((await membershipOf(`${key}@kpm0417.test`))._id) };
    // Whether or not `demo.ts` already calls it, start from the demo without the cohort: what it adds is then measured.
    const ids = (kind: string) => COHORT_HIRES.map((key) => new mongoose.Types.ObjectId(seedObjectId('cohort-fixture', kind, kpmId, cast[key].id)));
    await col('activationProgress').deleteMany({ _id: { $in: ids('activation') } });
    await col('auditLog').deleteMany({ _id: { $in: ids('audit') } });

    before = await walks();
    first = await seedActivationCohort({ clock, kpmId, cast });
    after = await walks();
  }, RUN_MS);
  afterAll(stopMongo);

  it('P18.1-T1 seeds twelve graduated activations, each starting on its hire’s join day, with its graduation audited', async () => {
    expect(first.written).toBe(24);
    const rows = await col('activationProgress').find({ membershipId: { $in: COHORT_HIRES.map((k) => cast[k].id) } }).toArray();
    expect(rows).toHaveLength(12);
    for (const key of COHORT_HIRES) {
      const member = await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(cast[key].id) });
      const row = rows.find((r) => r.membershipId === cast[key].id)!;
      expect([key, row.startDate]).toEqual([key, clock.localDateFor(TZ, member!.joinedAt)]);
      expect([key, row.graduatedAt !== null, row.items.every((i: { done: boolean }) => i.done)]).toEqual([key, true, true]);
    }
    expect(await col('auditLog').countDocuments({ action: 'activation.graduated', targetMembershipId: { $in: COHORT_HIRES.map((k) => cast[k].id) } }))
      .toBe(12);
    // Nine started last year, three this year: the cohort the two columns read.
    expect(COHORT_HIRES.filter((k) => first.starts[k]!.startsWith('2025')).sort())
      .toEqual(['arini', 'bonar', 'cahya', 'damar', 'elsa', 'gilang', 'ikhsan', 'jihan', 'oscar']);
    expect(COHORT_HIRES.filter((k) => first.starts[k]!.startsWith('2026')).sort()).toEqual(['kemal', 'pandu', 'raka']);
  });

  /*
   * P18.6-T1 AC-7, exit test 3 (OD-159): the PRD's *"New hires completing the 90-day activation — ≥60% of the cohort"*
   * is `ACTIVATION_COMPLETION_RATE` over `ACTIVATION_COHORT` of the last finished calendar year — computed here over
   * every activation the seeded office holds, each in its state on the run's day, as the tree reads them. Drawn nowhere.
   */
  it('P18.6-T1 AC-7 exit test 3: the PRD’s figure on the seed — FY 2025’s cohort, every one graduated — and this year’s open hires outside it', async () => {
    const rows = await col('activationProgress').find({ kpmId, deletedAt: null }).toArray();
    const activations = rows.map((row) => ({
      membershipId: row.membershipId as string,
      startDate: row.startDate as string,
      state: activationState((row.graduatedAt as Date | null) ?? null, today, activationEndsOn(TZ, row.startDate as string)),
    }));
    expect(lastFinishedYear(today)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(cohortCompletionRate(activations, lastFinishedYear(today))).toEqual({ count: 9, of: 9, pct: 100 });
    // This year's cohort holds Phase 13's open and overdue hires: the same function reads lower over it.
    const thisYear = cohortCompletionRate(activations, { from: '2026-01-01', to: '2026-12-31' });
    expect(thisYear.of).toBeGreaterThan(thisYear.count);
  });

  it('P18.1-T1 each hire reads their own activation, complete and graduated', async () => {
    const view = await wired.activationProgress.mine(await as('arini@kpm0417.test'));
    expect(view).toMatchObject({ state: 'graduated', startDate: first.starts.arini, pct: 100 });
    expect(view.done).toBe(view.total);
  });

  it('P18.1-T1 moves no walk already reviewed: the New hires rosters, activation pages, nav, coaching rosters and Unit Dashboards', () => {
    // The walks answer — the comparison is of pages, not of two refusals.
    const answered = Object.entries(before).filter(([, v]) => 'ok' in (v as object)).map(([k]) => k);
    expect(answered).toEqual(expect.arrayContaining([
      'owner new hires', 'agus new hires', 'sari new hires', 'arief new hires', 'owner nav', 'agus nav',
      'owner coaching roster', 'agus coaching roster', 'sari coaching roster', 'owner unit dashboard', 'agus unit dashboard',
    ]));
    /*
     * P18.96-T6 (ADR-0173 §1): `/new-hires` lists the year's new hires by their 3M result, the cohort's among them, so the
     * one thing the cohort's activations add there is each such row's checklist — nothing else on any walk moves.
     */
    const cohortIds = new Set(COHORT_HIRES.map((key) => cast[key].id));
    const withoutCohortChecklists = (walk: Record<string, unknown>) => JSON.parse(JSON.stringify(walk, (_key, value) => (
      value && typeof value === 'object' && 'hire' in value && 'checklist' in value
        && cohortIds.has((value as { hire: { membershipId: string } }).hire.membershipId)
        ? { ...value, checklist: 'the cohort’s' } : value
    ))) as unknown;
    expect(withoutCohortChecklists(after)).toEqual(withoutCohortChecklists(before));
  });

  it('P18.1-T1 a re-run writes nothing', async () => {
    expect((await seedActivationCohort({ clock, kpmId, cast })).written).toBe(0);
  });

  describe('what a meeting in three days reads (the seed’s #14)', () => {
    let card: ComputedScorecard;
    beforeAll(async () => {
      const scorecard = scorecardServiceOf(wired);
      card = await scorecard.compute({ kpmId, timezone: TZ, meetingDate: addDays(today, 3) });
    });
    const cell = (column: 'fy' | 'ytd') => card.rows.find((r) => r.key === 'new_agent_3m')!.cells[column];

    /*
     * P18.96-T6 (ADR-0171 §2): the row reads `ACTIVATION_3M_PCT` — a first sale by day 90 of the join date — not the
     * retired four months of the file; frozen scorecards keep what they froze (ADR-0129 §7).
     */
    it('P18.96-T6 AC-2 3M new agent % in FY: last year’s nine new hires, every one with a first sale on their join day', () => {
      expect(cell('fy')).toEqual({ kind: 'figure', value: 100, leavesOut: [] });
    });

    it('UI-023 and in YTD: 8 of 9 decided — Indah, Dimas, Siti, Pandu, Novi, Wahyu, Budi and Rina activated; Kemal not', () => {
      // Rule A (UI V1): a first sale by day 90 counts at once — Novi, Wahyu, Budi and Rina, inside their 90 days. Raka's
      // day-120 and Lukman's day-96 sales are in neither part; Tari (marked left — it decides nothing) and Yanti, inside
      // their 90 days with no sale, are not counted yet. They wait on no month.
      expect(cell('ytd')).toEqual({ kind: 'figure', value: 89, leavesOut: [] });
    });

    it('P18.1-T1 AC-2 a meeting two weeks ago (the seed’s #13), frozen today, reads the same two cells', async () => {
      const scorecard = scorecardServiceOf(wired);
      const thirteen = await scorecard.compute({ kpmId, timezone: TZ, meetingDate: addDays(today, -14) });
      const at = (column: 'fy' | 'ytd') => thirteen.rows.find((r) => r.key === 'new_agent_3m')!.cells[column];
      expect([at('fy'), at('ytd')]).toEqual([
        { kind: 'figure', value: 100, leavesOut: [] },
        { kind: 'figure', value: 89, leavesOut: [] },
      ]);
    });

    it('P18.1-T1 the rest of the scorecard has the figures the seed’s files give it', () => {
      const kinds = Object.fromEntries(card.rows.map((r) => [r.key, Object.values(r.cells).map((x) => x.kind).join(' ')]));
      // P18.97-T1 AC-20: last year is on file every month (`reporting-fixture.ts`), so *YTD {Y−1}* reads figures too.
      expect(kinds).toMatchObject({
        ape: 'figure figure figure figure figure figure',
        manpower: 'figure figure figure figure figure figure',
        flc: 'pending pending pending pending pending pending',
        producing_agents: 'figure figure figure blocked blocked blocked',
        new_agent_3m: 'figure figure figure blocked blocked blocked',
        cases_per_producing_agent: 'figure figure figure blocked blocked blocked',
        average_case_size: 'figure figure figure blocked blocked blocked',
      });
      // A YTD cell names the month it leaves out: August, the month before last, empty.
      expect(card.rows.find((r) => r.key === 'case_submission')!.cells.ytd).toMatchObject({ kind: 'figure', leavesOut: ['2026-08'] });
    });
  });
});
