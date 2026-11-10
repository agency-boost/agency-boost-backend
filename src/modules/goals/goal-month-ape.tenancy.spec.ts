import 'reflect-metadata';
import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildCoachingOffice, KPM_A, KPM_B, ROSTER_NOW, type CoachingOffice } from '../../../test/coaching-office';
import { scorecardServiceOf } from '../../../test/forum-office';
import { TEMPLATE_HEADER_V1 } from '@/modules/production/production-template';
import { FixedClock } from '@/common/clock/clock.port';

const M = 1_000_000 * 100;
/** The office's current month at `ROSTER_NOW`, 14 September 2026 in Jakarta. */
const MONTH = '2026-09';
/** The twelve value columns of a version 1 file, keyed `metric.cadence` as these specs name them. */
const VALUE_COLUMNS = (['monthly', 'ytd'] as const).flatMap((cadence) =>
  (['ape', 'persistency', 'recruitment', 'newActiveAgents', 'fyp', 'policyCount'] as const).map((metric) => ({ metric, cadence })));

/**
 * **P19.11-T4 — a month's APE, typed by the member over the office's upload** (UX-12; UXQ2's default, decided by the
 * project lead until the owner answers): `PUT /goals/:period/ape-month`, the Summary's headline on *Bulanan*.
 *
 * The office is `test/coaching-office.ts`'s. **Budi** — an agent in Sari's unit, under Agus — holds a plan of Rp 500 M
 * for the year and, until a test imports one, no production at all: September's target is Rp 125 M (500 over the four
 * months left). His own Summary reads the figure he types for a month **over** the upload — the manual figure, then the
 * upload, then *Belum diunggah* — and **no leader's and no office's screen does**, which each reader below proves by
 * answering the same with and without it.
 */
describe('P19.11-T4 a month’s APE typed over the upload (UX-12)', () => {
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
    // The office opened in January, so the Summary — and this route — reach back to it whatever the run's own date.
    await db().collection('kpms').updateOne({ _id: new mongoose.Types.ObjectId(KPM_A) }, { $set: { createdAt: new Date('2026-01-05T02:00:00Z') } });
    await wired.goals.save(budi(), plan());
  }, 120_000);

  const plan = (over: Record<string, unknown> = {}) => ({
    period: '2026', mode: 'direct', annualApeTargetMinor: 500 * M, savingsTargetMinor: 50 * M, commissionRatePct: 10,
    monthsLeft: null, apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30, closingRatePct: 30, ...over,
  });
  const budi = () => office.as('BUDI');
  const typeMonth = (minor: number | null, month = MONTH, who: RequestContext = budi(), period = '2026') =>
    wired.goals.saveMonthApe(who, period, { month, apeAchievedMinor: minor });

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
  const stored = () => db().collection('goals').findOne({ membershipId: office.id.BUDI, period: '2026' });

  describe('the member’s own Summary reads it over the upload (AC-3, AC-4)', () => {
    it('P19.11-T4 AC-4 typed over the upload it is in force: the gap, the policies and the bar from it, the upload beneath', async () => {
      await importBudi({ 'ape.monthly': '30', 'ape.ytd': '30' });
      at('2026-09-14T05:00:00Z');
      const saved = await typeMonth(100 * M);
      expect(saved).toEqual({ period: '2026', month: MONTH, manual: { minor: 100 * M, typedAt: '2026-09-14T05:00:00.000Z' } });

      const summary = await wired.summary.read(budi());
      expect(summary.monthly).toMatchObject({
        targetMinor: 125 * M, actualMinor: 100 * M, attainmentPct: 80, gapMinor: 25 * M, policiesNeeded: 2, targetMet: false,
        production: 'estimate', withoutProduction: null, source: { provenance: 'self_reported', month: MONTH },
        realised: { source: 'manual', uploaded: true, manual: { minor: 100 * M } },
      });
      // The pace sentence's policies are the card's: one number on one page.
      expect(summary.pace).toMatchObject({ policiesNeeded: 2 });
      // *Tahunan* keeps its year to date: the office's file, untouched by a month's figure.
      expect(summary.yearly).toMatchObject({ actualMinor: 30 * M, production: 'official' });
    });

    it('P19.11-T4 AC-4 never negative: past the month’s target it is reached — Rp 0 left and no policies', async () => {
      await typeMonth(216.5 * M);
      expect((await wired.summary.read(budi())).monthly).toMatchObject({
        actualMinor: 216.5 * M, gapMinor: 0, policiesNeeded: 0, targetMet: true, overMinor: 91.5 * M,
      });
    });

    it('P19.11-T4 AC-4 an upload arriving later does not replace it; cleared, the upload is read again', async () => {
      await typeMonth(100 * M);
      expect((await wired.summary.read(budi())).monthly.realised).toEqual({
        source: 'manual', uploaded: false, manual: { minor: 100 * M, typedAt: ROSTER_NOW.toISOString() },
      });
      at('2026-09-14T06:00:00Z');
      await importBudi({ 'ape.monthly': '30', 'ape.ytd': '30' });
      const after = await wired.summary.read(budi());
      expect(after.monthly).toMatchObject({ actualMinor: 100 * M, realised: { source: 'manual', uploaded: true } });

      // *Kembalikan ke data unggahan*.
      expect(await typeMonth(null)).toEqual({ period: '2026', month: MONTH, manual: null });
      expect((await wired.summary.read(budi())).monthly).toMatchObject({
        actualMinor: 30 * M, production: 'official', source: { provenance: 'imported' },
        realised: { source: 'uploaded', uploaded: true, manual: null },
      });
    });

    it('P19.11-T4 AC-4 with nothing uploaded, cleared is Belum diunggah again — the helpers counting 0', async () => {
      await typeMonth(18.5 * M);
      expect((await wired.summary.read(budi())).monthly).toMatchObject({ actualMinor: 18.5 * M, realised: { source: 'manual', uploaded: false } });
      await typeMonth(null);
      expect((await wired.summary.read(budi())).monthly).toMatchObject({
        actualMinor: null, production: 'none', withoutProduction: { gapMinor: 125 * M, policiesNeeded: 7 },
        realised: { source: 'none', uploaded: false, manual: null },
      });
    });

    it('P19.11-T4 AC-4 a month’s figure is that month’s: it follows the month selector, and no other month reads it', async () => {
      await typeMonth(40 * M, '2026-08');
      const august = await wired.summary.read(budi(), undefined, { month: '2026-08' });
      expect(august.monthly).toMatchObject({ actualMinor: 40 * M, realised: { source: 'manual', uploaded: false } });
      expect((await wired.summary.read(budi())).monthly).toMatchObject({ actualMinor: null, realised: { source: 'none' } });
    });

    it('P19.11-T4 AC-6 their coach reads it on the member’s Summary tab, with its source, as the member does', async () => {
      await typeMonth(100 * M);
      const own = await wired.summary.read(budi());
      const coach = await wired.summary.read(office.as('SARI'), office.id.BUDI);
      expect(coach.monthly).toEqual(own.monthly);
    });
  });

  describe('stored on the plan, apart from the upload (AC-3)', () => {
    it('P19.11-T4 AC-3 per member per month on the plan for the year, never in the office’s monthly rows', async () => {
      await importBudi({ 'ape.monthly': '30', 'ape.ytd': '30' });
      const before = await db().collection('monthlyAgentData').find({ membershipId: office.id.BUDI }).toArray();
      await typeMonth(100 * M);
      await typeMonth(40 * M, '2026-08');
      expect(await db().collection('monthlyAgentData').find({ membershipId: office.id.BUDI }).toArray()).toEqual(before);
      expect((await stored())!.apeByMonth).toEqual({
        [MONTH]: { minor: 100 * M, typedAt: ROSTER_NOW }, '2026-08': { minor: 40 * M, typedAt: ROSTER_NOW },
      });
    });

    it('P19.11-T4 AC-3 not a plan input: no revision, the version, savedAt, the snapshot and the year’s figure as they were', async () => {
      const before = (await stored())!;
      await typeMonth(100 * M);
      const after = (await stored())!;
      expect({ version: after.version, revisions: after.revisions, savedAt: after.savedAt, snapshot: after.snapshot, ytd: after.apeAchievedMinor })
        .toEqual({ version: before.version, revisions: before.revisions, savedAt: before.savedAt, snapshot: before.snapshot, ytd: before.apeAchievedMinor });
    });

    it('P19.11-T4 AC-3 audited set and cleared with the month, never the amount; the same figure again records nothing', async () => {
      await typeMonth(100 * M);
      await typeMonth(100 * M);
      await typeMonth(0);
      await typeMonth(null);
      await typeMonth(null);
      const entries = await db().collection('auditLog')
        .find({ action: { $in: ['goal.month_ape_set', 'goal.month_ape_cleared'] } }).sort({ _id: 1 }).toArray();
      expect(entries.map((e) => [e.action, e.after])).toEqual([
        ['goal.month_ape_set', { period: '2026', month: MONTH }],
        // 0 is a figure — nothing this month — and changing to it is a typing.
        ['goal.month_ape_set', { period: '2026', month: MONTH }],
        ['goal.month_ape_cleared', { period: '2026', month: MONTH }],
      ]);
    });
  });

  describe('refused (AC-3)', () => {
    it('P19.11-T4 AC-3 a month after the office’s current one, before it opened, or of another year: 400, nothing written', async () => {
      await expect(typeMonth(1 * M, '2026-10')).rejects.toMatchObject({
        code: 'VALIDATION_FAILED', status: 400, details: { field: 'month', earliest: '2026-01', latest: MONTH },
      });
      await expect(typeMonth(1 * M, '2025-12')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await db().collection('kpms').updateOne({ _id: new mongoose.Types.ObjectId(KPM_A) }, { $set: { createdAt: new Date('2026-05-10T02:00:00Z') } });
      await expect(typeMonth(1 * M, '2026-04')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'month', earliest: '2026-05' } });
      expect((await stored())!.apeByMonth ?? {}).toEqual({});
    });

    it('P19.11-T4 AC-3 a plan for next year has no month begun yet: refused, as a month after this one is', async () => {
      await wired.goals.save(budi(), plan({ period: '2027' }));
      await expect(typeMonth(1 * M, '2027-01', budi(), '2027')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'month' } });
    });

    it('P19.11-T4 AC-3 a locked plan — a year that has ended — is GOAL_PERIOD_LOCKED', async () => {
      await db().collection('goals').insertOne({
        kpmId: KPM_A, membershipId: office.id.BUDI, period: '2025', mode: 'direct', annualApeTargetMinor: 1, savingsTargetMinor: 0,
        commissionRatePct: 0, monthsLeftOverride: null, apeAchievedMinor: 0, caseSizeMinor: 1, leadsToApptPct: 30,
        closingRatePct: 30, version: 1, savedAt: ROSTER_NOW, deletedAt: null,
      });
      await expect(typeMonth(1 * M, '2025-11', budi(), '2025')).rejects.toMatchObject({ code: 'GOAL_PERIOD_LOCKED', status: 409 });
    });

    it('P19.11-T4 AC-3 a member with no saved plan: 404, and nothing written', async () => {
      await expect(typeMonth(1 * M, MONTH, office.as('TARI'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await db().collection('goals').countDocuments({ membershipId: office.id.TARI })).toBe(0);
    });

    it('P19.11-T4 AC-6 the caller’s own plan only: their coach typing it writes their own — none here, 404 — never the member’s', async () => {
      await expect(typeMonth(1 * M, MONTH, office.as('SARI'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await stored())!.apeByMonth ?? {}).toEqual({});
    });
  });

  describe('no leader’s or office’s screen reads it (AC-6)', () => {
    /** Every leader's and the office's read Budi is in, as one object: equal with and without his figure. */
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

    it('P19.11-T4 AC-6 every leader’s and the office’s read is the same with Budi’s month typed as without it', async () => {
      await importBudi({ 'ape.monthly': '30', 'ape.ytd': '30' });
      const without = await everyLeaderRead();
      await typeMonth(100 * M);
      await typeMonth(40 * M, '2026-08');
      // His own Summary did change: the figure is real, and his.
      expect((await wired.summary.read(budi())).monthly).toMatchObject({ actualMinor: 100 * M, realised: { source: 'manual' } });
      expect(await everyLeaderRead()).toEqual(without);
    });

    it('P19.11-T4 AC-6 a coaching snapshot keeps the office’s figure, never Budi’s typed month, and no lead rows', async () => {
      await importBudi({ 'ape.monthly': '30', 'ape.ytd': '30' });
      await typeMonth(100 * M);
      const subject = { membershipId: office.id.BUDI, orgLevelCode: budi().membership!.orgLevelCode, self: false };
      const snapshot = await wired.coachingSnapshots.build(office.as('SARI'), subject);
      expect(snapshot.goal!.monthly.actualMinor).toBe(30 * M);
      // The coach's live tab still shows his figure, marked — the snapshot is the record a leader keeps.
      const tab = await wired.summary.read(office.as('SARI'), office.id.BUDI);
      expect(tab.monthly).toMatchObject({ actualMinor: 100 * M, realised: { source: 'manual' } });
    });

    it('P19.11-T4 AC-6 the Unit Dashboard: Budi’s month is the office’s upload, with its source', async () => {
      await importBudi({ 'ape.monthly': '30', 'ape.ytd': '30' });
      await typeMonth(100 * M);
      const view = await wired.unitDashboard.read(office.as('SARI'));
      const rows = [...view.yourUnit.rows, ...view.units.flatMap(function rows(u): typeof view.yourUnit.rows {
        return [u.head, ...u.members, ...u.units.flatMap(rows)];
      })];
      expect(rows.find((r) => r.membershipId === office.id.BUDI)!.goal)
        .toMatchObject({ actualMinor: 30 * M, source: { provenance: 'imported' } });
    });
  });

  describe('tenancy (invariant §1)', () => {
    it('P19.11-T4 AC-3 another office’s member with Budi’s very membership id writes nothing here: 404', async () => {
      const intruder = new RequestContext('u-b', 'none', { ...budi().membership!, kpmId: KPM_B } as never);
      await expect(typeMonth(999 * M, MONTH, intruder)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await stored())!.apeByMonth ?? {}).toEqual({});
    });

    it('P19.11-T4 AC-6 another office’s Summary of the same membership id reads nothing typed here', async () => {
      await typeMonth(100 * M);
      expect(await wired.goals.monthApeOf(budi(), office.id.BUDI, MONTH)).toMatchObject({ minor: 100 * M });
      const intruder = new RequestContext('u-b', 'none', { ...budi().membership!, kpmId: KPM_B } as never);
      expect(await wired.goals.monthApeOf(intruder, office.id.BUDI, MONTH)).toBeNull();
    });
  });
});
