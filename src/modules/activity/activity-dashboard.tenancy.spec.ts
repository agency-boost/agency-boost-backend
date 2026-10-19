import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { FixedClock } from '@/common/clock/clock.port';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

const NOW = new Date('2026-03-11T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

/** Today in Jakarta at `NOW` — 09:00 local. */
const TODAY = '2026-03-11';

const member = (kpmId: string, over: Record<string, unknown> = {}) => new RequestContext(
  'u1', 'none', {
    membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
    status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
  } as never,
);
const owner = (kpmId: string) => member(kpmId, { isKpmOwner: true });

/**
 * The Activity Dashboard (P10-T1): the reader's own days over a range, per type and per column.
 *
 * Days are written straight into the collection — the Dashboard reads what is stored, and a day
 * thirty days back is past ADR-0042's window for the save route.
 */
describe('the Activity Dashboard (P10-T1)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await wired.orgLevels.seedDefaultLadder(COMPANY);
    await provisionOffice(wired, KPM_A, COMPANY);
    await provisionOffice(wired, KPM_B, COMPANY);
  });

  const at = (instant: string) => (wired.clock as FixedClock).set(new Date(instant));
  afterEach(() => at(NOW.toISOString()));

  /** One stored day. */
  const day = (
    localDate: string, counts: Record<string, number>,
    { kpmId = KPM_A, membershipId = `mem-${KPM_A}`, corrections = [] as unknown[] } = {},
  ) => mongoose.connection.db!.collection('activityLogs').insertOne({
    kpmId, membershipId, localDate,
    entries: Object.entries(counts).map(([code, count]) => ({
      activityTypeId: `type-${code}`, activityTypeCode: code, count,
    })),
    totalCount: Object.values(counts).reduce((t, n) => t + n, 0),
    source: 'self', version: 1, frozenAt: null, corrections, deletedAt: null,
  } as never);

  const read = (input: Record<string, string> = {}, ctx = member(KPM_A)) =>
    wired.activityLogs.dashboard(ctx, input);
  const typeRow = (view: Awaited<ReturnType<typeof read>>, code: string) =>
    view.sections.flatMap((s) => s.types).find((t) => t.code === code);

  describe('AC-1, AC-2 — the ranges and their columns', () => {
    it('defaults to the last 7 days, a column a day, most recent first', async () => {
      await day(TODAY, { SELL_SUBMISSION: 2 });
      await day('2026-03-09', { LEADS_CONTACTED: 3 });

      const view = await read();

      expect(view).toMatchObject({ range: 'ROLLING_7D', from: '2026-03-05', to: TODAY, days: 7, today: TODAY });
      expect(view.buckets.map((b) => b.from)).toEqual([
        '2026-03-11', '2026-03-10', '2026-03-09', '2026-03-08', '2026-03-07', '2026-03-06', '2026-03-05',
      ]);
      expect(typeRow(view, 'SELL_SUBMISSION')).toMatchObject({ total: 2, counts: [2, 0, 0, 0, 0, 0, 0] });
      expect(typeRow(view, 'LEADS_CONTACTED')).toMatchObject({ total: 3, counts: [0, 0, 3, 0, 0, 0, 0] });
    });

    it('puts each day of the last 30 in its 7-day block, and the oldest two in the remainder', async () => {
      await day('2026-03-11', { SELL_PRESENTATION: 1 });
      await day('2026-03-04', { SELL_PRESENTATION: 2 }); // Week 2
      await day('2026-02-11', { SELL_PRESENTATION: 4 }); // the remainder
      await day('2026-02-09', { SELL_PRESENTATION: 8 }); // outside the range

      const view = await read({ range: 'ROLLING_30D' });

      expect(view.buckets.map((b) => b.kind)).toEqual(['week', 'week', 'week', 'week', 'remainder']);
      expect(view.buckets[4]).toMatchObject({ from: '2026-02-10', to: '2026-02-11', days: 2 });
      expect(typeRow(view, 'SELL_PRESENTATION')).toMatchObject({ total: 7, counts: [1, 2, 0, 0, 4] });
    });

    it('shows a long custom range in blocks, and refuses one it cannot show rather than cutting it', async () => {
      await day('2026-01-05', { LEADS_GEN_ACTIVITY: 5 });

      const view = await read({ range: 'CUSTOM', from: '2026-01-01', to: '2026-03-11' });
      expect(view.days).toBe(70);
      expect(view.buckets.every((b) => b.kind === 'week')).toBe(true);
      expect(view.total).toBe(5);

      await expect(read({ range: 'CUSTOM', from: '2026-03-01', to: '2026-03-12' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'to', today: TODAY } });
    });
  });

  describe('AC-5, AC-6 — the totals add up, every way', () => {
    it('sums types into sections, sections into the total, and each column the same way', async () => {
      await day(TODAY, { LEADS_CONTACTED: 4, SELL_PRESENTATION: 2, SELL_SUBMISSION: 1 });
      await day('2026-03-10', { SELL_FOLLOWUP: 3, DEV_TRAINING_ATTEND: 1 });

      const view = await read();
      const selling = view.sections.find((s) => s.code === 'SELLING')!;

      expect(selling).toMatchObject({ standing: 'shown', total: 6 });
      expect(selling.counts.slice(0, 2)).toEqual([3, 3]);
      expect(view.total).toBe(11);
      expect(view.counts.slice(0, 2)).toEqual([7, 4]);
      expect(view.sections.reduce((t, s) => t + s.total, 0)).toBe(view.total);
    });

    it('lists every section and type the reader logs against, at zero when nothing was logged (AC-11)', async () => {
      const view = await read();

      expect(view.sections.map((s) => s.code)).toEqual([
        'LEADS_GENERATION', 'SELLING', 'RECRUITMENT', 'PERSONAL_DEVELOPMENT', 'TEAM_DEVELOPMENT',
      ]);
      expect(view.sections.flatMap((s) => s.types)).toHaveLength(12);
      expect(view).toMatchObject({ total: 0, daysLogged: 0 });
      expect(typeRow(view, 'SELL_SUBMISSION')).toMatchObject({ displayOrder: 6, standing: 'shown', total: 0 });
    });

    it('counts a day of zeroes as a day logged, and adds nothing for it (ADR-0042)', async () => {
      await day('2026-03-10', { SELL_SUBMISSION: 0 });
      const view = await read();
      expect(view).toMatchObject({ daysLogged: 1, total: 0 });
    });
  });

  describe('AC-7 — a corrected day counts at its current figure, and says so', () => {
    it('counts what the day holds now, and how many corrected days the range has', async () => {
      await day('2026-02-20', { SELL_SUBMISSION: 5 }, {
        corrections: [{ entries: [{ activityTypeCode: 'SELL_SUBMISSION', count: 3 }], totalCount: 3, reason: 'Wrong day.' }],
      });
      await day('2026-02-21', { SELL_SUBMISSION: 1 });

      const view = await read({ range: 'ROLLING_30D' });

      expect(typeRow(view, 'SELL_SUBMISSION')!.total).toBe(6);
      expect(view.correctedDays).toBe(1);
    });
  });

  describe('AC-8 — history the office has since hidden still adds up', () => {
    it('keeps an archived type that holds counts, marked, and drops it when it holds none', async () => {
      // Not a cascade type: those three cannot be archived (ADR-0115 §2).
      await day(TODAY, { SELL_FOLLOWUP: 4 });
      const type = (await wired.activity.list(owner(KPM_A)))
        .flatMap((c) => c.types).find((t) => t.code === 'SELL_FOLLOWUP')!;
      await wired.activity.archiveType(owner(KPM_A), type.id);

      const withCounts = await read();
      expect(typeRow(withCounts, 'SELL_FOLLOWUP')).toMatchObject({ standing: 'archived', total: 4 });
      expect(withCounts.total).toBe(4);

      await mongoose.connection.db!.collection('activityLogs').deleteMany({});
      expect(typeRow(await read(), 'SELL_FOLLOWUP')).toBeUndefined();
    });

    it('keeps a section no longer shown to this rung, after the rows it counted, marked as such', async () => {
      await day(TODAY, { DEV_TEAM_ACTIVITY: 2, LEADS_CONTACTED: 1 });
      const team = (await wired.activity.list(owner(KPM_A))).find((c) => c.code === 'TEAM_DEVELOPMENT')!;
      await wired.activity.updateCategory(owner(KPM_A), team.id, { appliesToOrgLevelCodes: ['AB'] });

      const agent = await read();
      expect(agent.sections.at(-1)).toMatchObject({ code: 'TEAM_DEVELOPMENT', standing: 'not_shown', total: 2 });
      expect(agent.total).toBe(3);

      // A leader is shown it, as an ordinary section.
      const leader = await read({}, member(KPM_A, { orgLevelCode: 'AB', hierarchyRole: 'ab' }));
      expect(leader.sections.find((s) => s.code === 'TEAM_DEVELOPMENT')).toMatchObject({ standing: 'shown' });
    });

    it('does not show a section no longer shown to this rung when it holds nothing', async () => {
      const team = (await wired.activity.list(owner(KPM_A))).find((c) => c.code === 'TEAM_DEVELOPMENT')!;
      await wired.activity.updateCategory(owner(KPM_A), team.id, { appliesToOrgLevelCodes: ['AB'] });
      expect((await read()).sections.map((s) => s.code)).not.toContain('TEAM_DEVELOPMENT');
    });

    it('gives a count against a code no section holds a row of its own, rather than a gap in the total', async () => {
      await day(TODAY, { LEGACY_CODE: 3 });
      const view = await read();
      expect(view.sections.at(-1)).toMatchObject({ label: 'Other', standing: 'archived', total: 3 });
      expect(view.total).toBe(3);
    });
  });

  describe('AC-9 — your own, only', () => {
    it('never counts another member’s days, nor another office’s under the same member id', async () => {
      await day(TODAY, { SELL_SUBMISSION: 1 });
      await day(TODAY, { SELL_SUBMISSION: 50 }, { membershipId: 'mem-someone-else' });
      await day(TODAY, { SELL_SUBMISSION: 70 }, { kpmId: KPM_B, membershipId: `mem-${KPM_A}` });

      expect((await read()).total).toBe(1);
    });

    it('reads another office’s configuration never — its sections are its own', async () => {
      const team = (await wired.activity.list(owner(KPM_B))).find((c) => c.code === 'TEAM_DEVELOPMENT')!;
      await wired.activity.updateCategory(owner(KPM_B), team.id, { appliesToOrgLevelCodes: ['AB'] });

      expect((await read()).sections.map((s) => s.code)).toContain('TEAM_DEVELOPMENT');
    });

    it('refuses somebody with no membership — a Super Admin has no days of their own', async () => {
      await expect(read({}, RequestContext.platform('root')))
        .rejects.toMatchObject({ status: 403, code: 'TENANT_NO_MEMBERSHIP' });
    });
  });

  describe('AC-10 — the day is the office’s, whatever the server’s clock', () => {
    it('keeps today until midnight in Jakarta, and moves at it', async () => {
      at('2026-03-11T16:59:00Z'); // 23:59 in Jakarta
      await day('2026-03-11', { SELL_SUBMISSION: 1 });
      const late = await read();
      expect(late.today).toBe('2026-03-11');
      expect(late.counts[0]).toBe(1);

      at('2026-03-11T17:01:00Z'); // 00:01 on the 12th in Jakarta, still the 11th in UTC
      const early = await read();
      expect(early.today).toBe('2026-03-12');
      expect(early.buckets[0].from).toBe('2026-03-12');
      expect(early.counts.slice(0, 2)).toEqual([0, 1]);
    });
  });
});
