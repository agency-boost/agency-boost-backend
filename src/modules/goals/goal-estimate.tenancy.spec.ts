import 'reflect-metadata';
import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildCoachingOffice, KPM_A, KPM_B, ROSTER_NOW, type CoachingOffice } from '../../../test/coaching-office';
import { scorecardServiceOf } from '../../../test/forum-office';
import { OfficialApe } from '@/modules/production/official-ape';
import { ProductionReadings } from '@/modules/production/production-readings';
import { TEMPLATE_HEADER_V1 } from '@/modules/production/production-template';
import { replacedEstimate, SummaryService } from '@/modules/summary/summary.service';
import { FixedClock } from '@/common/clock/clock.port';
import { UnitDashboardService } from '@/modules/unit-dashboard/unit-dashboard.service';
import { KpmOverviewService } from '@/modules/reporting/kpm-overview.service';
import { KpmAnalyticsService } from '@/modules/reporting/kpm-analytics.service';
import { PaceStatusReadings } from '@/modules/coaching/pace-status';
import { LeaderScorecardService } from '@/modules/leader-meetings/scorecard/scorecard.service';
import { ActivityService } from '@/modules/activity/activity.service';
import { GoalService } from './goal.service';

const M = 1_000_000 * 100;
const MONTH = '2026-09';
/** The twelve value columns of a version 1 file, keyed `metric.cadence` as these specs name them. */
const VALUE_COLUMNS = (['monthly', 'ytd'] as const).flatMap((cadence) =>
  (['ape', 'persistency', 'recruitment', 'newActiveAgents', 'fyp', 'policyCount'] as const).map((metric) => ({ metric, cadence })));

/**
 * **The member's own estimate, and the official APE** (P19.1-T4; the 6 November handover's UI-157 items 4 to 6; OD-250's
 * default; ADR-0195).
 *
 * The office is `test/coaching-office.ts`'s. **Budi** — an agent in Sari's unit, under Agus — holds no production at all,
 * so his only APE produced is what he types: *Isi produksi sementara* on the Summary, *APE yang sudah dicapai tahun ini*
 * on Goal Settings, one field (`goals.apeAchievedMinor`). His own screens read it, labelled; **no leader's and no
 * office's screen does**, which each reader below proves by answering the same with and without it.
 */
describe('P19.1-T4 the member’s own estimate of the APE produced (UI-157)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
  }, 120_000);
  afterAll(stopMongo);
  const at = (instant: string) => (wired.clock as FixedClock).set(new Date(instant));
  afterEach(() => at(ROSTER_NOW.toISOString()));

  beforeEach(async () => {
    await clearCollections();
    office = await buildCoachingOffice(wired);
    // Budi's plan: Rp 500 M for the year, nothing typed, nothing uploaded.
    await wired.goals.save(office.as('BUDI'), plan());
  }, 120_000);

  const plan = (over: Record<string, unknown> = {}) => ({
    period: '2026', mode: 'direct', annualApeTargetMinor: 500 * M, savingsTargetMinor: 50 * M, commissionRatePct: 10,
    monthsLeft: null, apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30, closingRatePct: 30, ...over,
  });
  const budi = () => office.as('BUDI');
  const estimate = (minor: number, who: RequestContext = budi()) => wired.goals.saveEstimate(who, '2026', { apeAchievedMinor: minor });

  /** A file for September holding Budi's figures, imported and committed as the Owner would. */
  const importBudi = async (cells: Record<string, string>) => {
    const agentCode = (await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.BUDI) }))!.agentCode;
    const buffer = Buffer.from([
      TEMPLATE_HEADER_V1.join(','),
      [agentCode, '"Budi"', ...VALUE_COLUMNS.map((c) => cells[`${c.metric}.${c.cadence}`] ?? '')].join(','),
    ].join('\n'));
    const file = { buffer, originalname: 'september.csv', size: buffer.length };
    const owner = office.as('OWNER');
    const preview = await wired.production.preview(owner, MONTH, file as never);
    await wired.productionImport.commit(owner, MONTH, String(preview.revision), file as never);
  };

  describe('the member’s own screens read it, as theirs (AC-10)', () => {
    it('P19.1-T4 AC-10 an estimate entered on the Summary is Goal Settings’ APE produced: one value, perkiraan Anda', async () => {
      const saved = await estimate(120 * M);
      expect(saved.apeAchievedMinor).toBe(120 * M);
      expect(saved.achieved).toEqual({ minor: 120 * M, provenance: 'self_reported', month: null });

      // Goal Settings reads the same figure, and its plan recalculates from it: (500 − 120) over the 4 months left.
      const goal = await wired.goals.readOrDefaults(budi(), '2026');
      expect(goal.achieved).toEqual({ minor: 120 * M, provenance: 'self_reported', month: null });
      expect(goal.projected).toMatchObject({ remainingApeMinor: 380 * M });

      // The Summary: the year is his estimate; this month's target is taken from it, and nothing is uploaded for it.
      const summary = await wired.summary.read(budi());
      expect(summary.yearly).toMatchObject({ actualMinor: 120 * M, production: 'estimate', withoutProduction: null });
      expect(summary.monthly).toMatchObject({
        targetMinor: 95 * M, actualMinor: null, production: 'none',
        // UI-157 item 2: what was achieved this month counted as 0 — the whole Rp 95 M, and 95 ÷ 18 → 6 policies.
        withoutProduction: { gapMinor: 95 * M, policiesNeeded: 6 },
      });
      expect(summary.estimateReplaced).toBeNull();
    });

    it('P19.1-T4 AC-10 entered on Goal Settings, the Summary shows it — and Ubah and Hapus change the one figure', async () => {
      await wired.goals.save(budi(), plan({ apeAchievedMinor: 200 * M }));
      expect((await wired.summary.read(budi())).yearly).toMatchObject({ actualMinor: 200 * M, production: 'estimate' });

      await estimate(150 * M);
      expect((await wired.goals.readOrDefaults(budi(), '2026')).apeAchievedMinor).toBe(150 * M);

      // *Hapus*: 0, nothing typed — the Summary says nothing is held, and counts the year's helpers from 0.
      const cleared = await estimate(0);
      expect(cleared.apeAchievedMinor).toBe(0);
      const summary = await wired.summary.read(budi());
      expect(summary.yearly).toMatchObject({ production: 'none', withoutProduction: { gapMinor: 500 * M, policiesNeeded: 28 } });
    });

    it('P19.1-T4 AC-10 an estimate is the member’s own save of one field: a revision kept, the rest of the plan as agreed', async () => {
      const before = await wired.goals.readOrDefaults(budi(), '2026');
      at('2026-09-14T05:00:00Z');
      const after = await estimate(120 * M);
      // Not a re-plan: the agreed snapshot, `savedAt` and the target stay.
      expect({ savedAt: after.savedAt, snapshot: after.snapshot, annual: after.annualApeTargetMinor })
        .toEqual({ savedAt: before.savedAt, snapshot: before.snapshot, annual: before.annualApeTargetMinor });
      // ADR-0195 §2: the plan as it stood is a revision, and the version moves on, as a save's does.
      expect(after.version).toBe(2);
      expect(after.apeAchievedTypedAt).toBe('2026-09-14T05:00:00.000Z');
      const stored = await db().collection('goals').findOne({ membershipId: office.id.BUDI, period: '2026' });
      expect(stored!.revisions.map((r: { version: number; apeAchievedMinor: number }) => [r.version, r.apeAchievedMinor])).toEqual([[1, 0]]);
    });

    it('P19.1-T4 AC-10 null is Hapus, as 0 is', async () => {
      await estimate(120 * M);
      const cleared = await wired.goals.saveEstimate(budi(), '2026', { apeAchievedMinor: null });
      expect(cleared.apeAchievedMinor).toBe(0);
      await expect(wired.goals.saveEstimate(budi(), '2026', { apeAchievedMinor: null, period: '2026' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('P19.1-T4 AC-10 the audit says it was set and cleared, and never the amount', async () => {
      await estimate(120 * M);
      await estimate(120 * M); // the same figure again writes nothing
      await estimate(0);
      const entries = await db().collection('auditLog')
        .find({ action: { $in: ['goal.estimate_set', 'goal.estimate_cleared'] } }).sort({ _id: 1 }).toArray();
      expect(entries.map((e) => [e.action, e.after])).toEqual([
        ['goal.estimate_set', { period: '2026' }],
        ['goal.estimate_cleared', { period: '2026' }],
      ]);
    });

    it('P19.1-T4 AC-12 the member’s own plan, read by their coach, shows the estimate as the member’s (labelled, not hidden)', async () => {
      await estimate(120 * M);
      const read = await wired.goals.readOrDefaults(office.as('SARI'), '2026', office.id.BUDI);
      expect(read.achieved).toEqual({ minor: 120 * M, provenance: 'self_reported', month: null });
      // The coachee's Summary tab is the member's own page: it says whose the figure is, too.
      expect((await wired.summary.read(office.as('SARI'), office.id.BUDI)).yearly).toMatchObject({ production: 'estimate' });
    });
  });

  describe('stored apart from the office’s production, and replaced by it (AC-11, AC-13)', () => {
    it('P19.1-T4 AC-13 the estimate lives on the member’s plan, never in the office’s monthly rows', async () => {
      await estimate(120 * M);
      expect(await db().collection('monthlyAgentData').countDocuments({ membershipId: office.id.BUDI })).toBe(0);
      const stored = await db().collection('goals').findOne({ membershipId: office.id.BUDI, period: '2026' });
      expect(stored).toMatchObject({ apeAchievedMinor: 120 * M, apeAchievedTypedBy: null });
    });

    it('P19.5-T2 AC-7 P19.1-T4 AC-11 the month imported replaces it on the Summary and Goal Settings, and the card can say when', async () => {
      await estimate(120 * M);
      at('2026-09-14T06:00:00Z');
      await importBudi({ 'ape.monthly': '30', 'ape.ytd': '90' });

      /*
       * P19.5-T2 AC-7 (ADR-0214 §10): the year is the months held, summed — September's Rp 30 M is all Budi holds — and
       * the file's YTD column (Rp 90 M) is read by no figure. It was the year these assertions read before.
       */
      const summary = await wired.summary.read(budi());
      expect(summary.yearly).toMatchObject({ actualMinor: 30 * M, production: 'official', source: { provenance: 'imported' } });
      expect(summary.monthly).toMatchObject({ actualMinor: 30 * M, production: 'official', withoutProduction: null });
      // *Diganti data produksi resmi (diunggah 14 Sep)*: the upload's own day, in the office's calendar.
      expect(summary.estimateReplaced).toEqual({ uploadedOn: '2026-09-14' });

      const goal = await wired.goals.readOrDefaults(budi(), '2026');
      expect(goal.achieved).toEqual({ minor: 30 * M, provenance: 'imported', month: MONTH });
      expect(goal.projected).toMatchObject({ remainingApeMinor: 470 * M });
    });

    it('P19.1-T4 AC-11 nothing replaced, nothing said: a member who never typed one has no note under the office’s figure', async () => {
      await importBudi({ 'ape.monthly': '30', 'ape.ytd': '90' });
      expect((await wired.summary.read(budi())).estimateReplaced).toBeNull();
    });

    it('P19.1-T4 AC-11 replacedEstimate: only a figure written after the estimate replaced it — a correction by its moment', () => {
      const tz = 'Asia/Jakarta';
      const imported = { provenance: 'imported' as const, correctedAt: null };
      const corrected = { provenance: 'corrected' as const, correctedAt: new Date('2026-12-05T03:00:00Z') };
      const typedAt = '2026-12-01T03:00:00.000Z';
      expect(replacedEstimate({ typedMinor: 120 * M, typedAt, official: imported, latestImport: new Date('2026-12-05T03:00:00Z'), timezone: tz }))
        .toEqual({ uploadedOn: '2026-12-05' });
      expect(replacedEstimate({ typedMinor: 120 * M, typedAt, official: corrected, latestImport: null, timezone: tz }))
        .toEqual({ uploadedOn: '2026-12-05' });
      // Typed after the office's figure, nothing typed, nothing official, or a moment unknown: nothing to say.
      expect(replacedEstimate({ typedMinor: 120 * M, typedAt, official: imported, latestImport: new Date('2026-11-30T03:00:00Z'), timezone: tz })).toBeNull();
      expect(replacedEstimate({ typedMinor: 0, typedAt, official: imported, latestImport: new Date('2026-12-05T03:00:00Z'), timezone: tz })).toBeNull();
      expect(replacedEstimate({ typedMinor: 120 * M, typedAt, official: null, latestImport: new Date('2026-12-05T03:00:00Z'), timezone: tz })).toBeNull();
      expect(replacedEstimate({ typedMinor: 120 * M, typedAt: null, official: imported, latestImport: new Date('2026-12-05T03:00:00Z'), timezone: tz })).toBeNull();
      expect(replacedEstimate({ typedMinor: 120 * M, typedAt, official: { provenance: 'corrected', correctedAt: null }, latestImport: null, timezone: tz })).toBeNull();
    });
  });

  describe('no estimate reaches a leader’s or the office’s screen (AC-12, UI-157 item 5)', () => {
    /** Every leader's and the office's read Budi is in, as one object: equal with and without his estimate. */
    const everyLeaderRead = async () => ({
      agusMonth: await wired.unitDashboard.read(office.as('AGUS')),
      agusYear: await wired.unitDashboard.read(office.as('AGUS'), { period: 'year' }),
      sariMonth: await wired.unitDashboard.read(office.as('SARI')),
      sariYear: await wired.unitDashboard.read(office.as('SARI'), { period: 'year' }),
      roster: await wired.coachingRoster.read(office.as('SARI')),
      pace: await wired.paceStatus.paceOf(office.as('SARI'), [office.id.BUDI], { today: '2026-09-14', month: MONTH, onTrackRatio: 0.7 }),
      overview: await wired.kpmOverview.read(office.as('OWNER')),
      analyticsThisMonth: await wired.kpmAnalytics.read(office.as('OWNER'), { period: 'this_month' }),
      analyticsPreviousMonth: await wired.kpmAnalytics.read(office.as('OWNER'), { period: 'previous_month' }),
      scorecard: await scorecardServiceOf(wired).compute({ kpmId: KPM_A, timezone: 'Asia/Jakarta', meetingDate: '2026-09-14' }),
    });

    it('P19.1-T4 AC-12 every leader’s and the office’s read is the same with Budi’s estimate as without it', async () => {
      const without = await everyLeaderRead();
      await estimate(120 * M);
      // His own Summary did change: the estimate is real, and his.
      expect((await wired.summary.read(budi())).yearly).toMatchObject({ actualMinor: 120 * M, production: 'estimate' });
      expect(await everyLeaderRead()).toEqual(without);
    });

    it('P19.1-T4 AC-12 the Unit Dashboard: Budi’s year is Belum diunggah, with no source, and his month’s target is the office’s', async () => {
      await estimate(120 * M);
      const rowOf = (view: Awaited<ReturnType<typeof wired.unitDashboard.read>>) => [
        ...view.yourUnit.rows, ...view.units.flatMap(function rows(u): typeof view.yourUnit.rows {
          return [u.head, ...u.members, ...u.units.flatMap(rows)];
        }),
      ].find((r) => r.membershipId === office.id.BUDI)!;
      const year = rowOf(await wired.unitDashboard.read(office.as('SARI'), { period: 'year' }));
      expect(year.goal).toMatchObject({ targetMinor: 500 * M, actualMinor: null, attainmentPct: null, source: null });
      // Nothing uploaded and no estimate read: 500 over the 4 months left, where his own Summary says (500 − 120) ÷ 4.
      const month = rowOf(await wired.unitDashboard.read(office.as('SARI')));
      expect(month.goal).toMatchObject({ targetMinor: 125 * M, actualMinor: null });
      expect((await wired.summary.read(budi())).monthly.targetMinor).toBe(95 * M);
    });

    it('P19.1-T4 AC-12 the roster’s status reads no estimate: the month’s target is the office’s figures’', async () => {
      await estimate(120 * M);
      const pace = await wired.paceStatus.paceOf(office.as('SARI'), [office.id.BUDI], { today: '2026-09-14', month: MONTH, onTrackRatio: 0.7 });
      expect(pace.get(office.id.BUDI)!.monthlyTargetMinor).toBe(125 * M);
    });

    it('P19.1-T4 AC-12 a coach’s typing is an estimate too: it reaches no leader’s screen either (ADR-0183)', async () => {
      const without = await everyLeaderRead();
      await wired.goals.save(office.as('SARI'), plan({ apeAchievedMinor: 120 * M }), office.id.BUDI);
      expect(await everyLeaderRead()).toEqual(without);
    });
  });

  describe('tenancy (invariant §1)', () => {
    it('P19.1-T4 AC-13 another office’s member writes their own plan’s estimate, and never this office’s', async () => {
      // A member of office B with Budi's very membership id: the tenant scoping, not the id, keeps them apart.
      const intruder = new RequestContext('u-b', 'none', {
        ...budi().membership!, kpmId: KPM_B,
      } as never);
      await expect(estimate(999 * M, intruder)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await wired.goals.readOrDefaults(budi(), '2026')).apeAchievedMinor).toBe(0);
    });

    it('P19.1-T4 AC-13 a member with no saved plan has nothing to estimate against: 404, and nothing written', async () => {
      await expect(estimate(10 * M, office.as('TARI'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await db().collection('goals').countDocuments({ membershipId: office.id.TARI })).toBe(0);
    });
  });
});

/**
 * **One port for the official APE** (P19.1-T4 AC-13, ADR-0195): every reader of a goal's figures is handed `OfficialApe`
 * by the container, and the application answers it with `ProductionReadings` until Phase 19.5 gives it another source.
 */
describe('P19.1-T4 AC-13 the official APE is one port', () => {
  it.each([
    GoalService, SummaryService, UnitDashboardService, KpmOverviewService, KpmAnalyticsService, PaceStatusReadings,
    LeaderScorecardService, ActivityService,
  ] as const)('P19.1-T4 AC-13 %p asks the port, not the file’s reader', (service) => {
    const params = Reflect.getMetadata('design:paramtypes', service) as unknown[];
    expect(params).toContain(OfficialApe);
    expect(params).not.toContain(ProductionReadings);
  });

  it('P19.1-T4 AC-13 ProductionReadings answers the port today', () => {
    // The class implements every method the port declares, so `useExisting` serves it whole.
    const port = Object.getOwnPropertyNames(OfficialApe.prototype).filter((name) => name !== 'constructor');
    const implemented = new Set(Object.getOwnPropertyNames(ProductionReadings.prototype));
    for (const name of ['apeYearToDate', 'apeYearToDateThrough', 'apeForMonth', 'ledgersFor', 'standingsFor', 'monthCellsAndYearToDateFor', 'officeMonths']) {
      expect(implemented.has(name)).toBe(true);
    }
    expect(port.every((name) => implemented.has(name))).toBe(true);
  });
});
