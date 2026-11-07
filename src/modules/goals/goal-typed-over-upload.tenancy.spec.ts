import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { FixedClock } from '@/common/clock/clock.port';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { RequestContext } from '@/common/context/request-context';
import { TEMPLATE_HEADER_V1 } from '@/modules/production/production-template';
import { SummaryController } from '@/modules/summary/summary.controller';
import { SummaryService } from '@/modules/summary/summary.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { buildCoachingOffice, KPM_A, KPM_B, ROSTER_NOW, type CoachingOffice, type Who } from '../../../test/coaching-office';
import { scorecardServiceOf } from '../../../test/forum-office';
import { GoalController } from './goal.controller';
import { GoalService } from './goal.service';

const M = 1_000_000 * 100;
const MONTH = '2026-09';
/** The twelve value columns of a version 1 file, keyed `metric.cadence` as these specs name them. */
const VALUE_COLUMNS = (['monthly', 'ytd'] as const).flatMap((cadence) =>
  (['ape', 'persistency', 'recruitment', 'newActiveAgents', 'fyp', 'policyCount'] as const).map((metric) => ({ metric, cadence })));

/** A September file naming each person with their figures (Rp juta), imported and committed by the Owner. */
async function importSeptember(
  wired: ReturnType<typeof configModule>, office: CoachingOffice, rows: Partial<Record<Who, number>>,
): Promise<void> {
  const db = mongoose.connection.db!;
  const lines = [TEMPLATE_HEADER_V1.join(',')];
  for (const [who, millions] of Object.entries(rows) as [Who, number][]) {
    const agentCode = (await db.collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id[who]) }))!.agentCode;
    const cells: Record<string, string> = { 'ape.monthly': String(millions), 'ape.ytd': String(millions) };
    lines.push([agentCode, `"${who}"`, ...VALUE_COLUMNS.map((c) => cells[`${c.metric}.${c.cadence}`] ?? '')].join(','));
  }
  const buffer = Buffer.from(lines.join('\n'));
  const file = { buffer, originalname: 'september.csv', size: buffer.length };
  const owner = office.as('OWNER');
  const preview = await wired.production.preview(owner, MONTH, file as never);
  await wired.productionImport.commit(owner, MONTH, String(preview.revision), file as never);
}

/**
 * **P19.8-T5 — the member types over the automatic APE, and the newer wins** (MOB UI-190, D-36; OQ3 and OD-279's
 * default; ADR-0230, amending ADR-0195 §1–§3 and ADR-0183 for the member).
 *
 * The office is `test/coaching-office.ts`'s, on 14 September 2026. **Budi** (an agent in Sari's unit, under Agus) holds no
 * production until a file names him; **Sari** (an AAB) and **Agus** (an AB) are named on the same file where a test types
 * over their own figure. A file is imported and committed as the Owner would (`importFile`), so the office's write is
 * dated by its upload — the moment the newer-wins rule reads (`officialWrittenAt`).
 */
describe('P19.8-T5 MOB UI-190 a member types over the automatic APE, and the newer wins (ADR-0230)', () => {
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
    at('2026-09-14T03:00:00Z');
    office = await buildCoachingOffice(wired);
    // Budi's plan: Rp 500 M for the year, nothing typed, nothing uploaded.
    await wired.goals.save(office.as('BUDI'), plan());
  }, 120_000);

  const plan = (over: Record<string, unknown> = {}) => ({
    period: '2026', mode: 'direct', annualApeTargetMinor: 500 * M, savingsTargetMinor: 50 * M, commissionRatePct: 10,
    monthsLeft: null, caseSizeMinor: 18 * M, leadsToApptPct: 30, closingRatePct: 30, ...over,
  });
  const as = (who: Who) => office.as(who);
  const typeOwn = (who: Who, apeAchievedMinor: number | null) => wired.goals.save(as(who), plan({ apeAchievedMinor }));

  const importFile = (rows: Partial<Record<Who, number>>) => importSeptember(wired, office, rows);

  describe('the member’s own screens: the newer of the two (AC-1, AC-4, AC-5)', () => {
    it('P19.8-T5 AC-1 MOB UI-190 an agent types over the uploaded figure: stored, in force, the office’s figure beside it', async () => {
      at('2026-09-14T06:00:00Z');
      await importFile({ BUDI: 30 });
      // Before he types: the office's figure, which is also the automatic one.
      const before = await wired.goals.readOrDefaults(as('BUDI'), '2026');
      expect(before.achieved).toEqual({ minor: 30 * M, provenance: 'imported', month: MONTH });
      expect(before.official).toEqual({ minor: 30 * M, provenance: 'imported', month: MONTH });

      at('2026-09-14T07:00:00Z');
      const saved = await typeOwn('BUDI', 67 * M);
      expect(saved).toMatchObject({
        apeAchievedMinor: 67 * M, apeAchievedTypedAt: '2026-09-14T07:00:00.000Z',
        achieved: { minor: 67 * M, provenance: 'self_reported', month: null },
        official: { minor: 30 * M, provenance: 'imported', month: MONTH },
      });
      // Goal Settings reads it, and works the plan out from it: 500 − 67.
      const read = await wired.goals.readOrDefaults(as('BUDI'), '2026');
      expect(read.achieved).toEqual({ minor: 67 * M, provenance: 'self_reported', month: null });
      expect(read.projected).toMatchObject({ apeAchievedMinor: 67 * M, remainingApeMinor: 433 * M });
    });

    it('P19.8-T5 AC-3 the preview works the plan out from a figure typed over the upload at once — and from the office’s when cleared', async () => {
      at('2026-09-14T06:00:00Z');
      await importFile({ BUDI: 30 });
      at('2026-09-14T07:00:00Z');
      const typed = await wired.goals.preview(as('BUDI'), '2026', plan({ apeAchievedMinor: 120 * M }));
      expect(typed.achieved).toEqual({ minor: 120 * M, provenance: 'self_reported', month: null });
      expect(typed.projected).toMatchObject({ remainingApeMinor: 380 * M });
      // *Pakai otomatis*: the typed figure gone, the office's again.
      const cleared = await wired.goals.preview(as('BUDI'), '2026', plan({ apeAchievedMinor: null }));
      expect(cleared.achieved).toEqual({ minor: 30 * M, provenance: 'imported', month: MONTH });
      // Nothing written by either.
      expect((await wired.goals.readOrDefaults(as('BUDI'), '2026')).apeAchievedMinor).toBe(0);
    });

    it('P19.8-T5 AC-4 Pakai otomatis saved: null clears the typed figure, and the office’s is read again', async () => {
      at('2026-09-14T06:00:00Z');
      await importFile({ BUDI: 30 });
      at('2026-09-14T07:00:00Z');
      await typeOwn('BUDI', 67 * M);
      at('2026-09-14T08:00:00Z');
      const cleared = await typeOwn('BUDI', null);
      expect(cleared).toMatchObject({ apeAchievedMinor: 0, achieved: { minor: 30 * M, provenance: 'imported', month: MONTH } });
      // The plan it replaced keeps the figure (ADR-0042); the audit says it changed, never the amount.
      const stored = await db().collection('goals').findOne({ membershipId: office.id.BUDI, period: '2026' });
      expect(stored!.revisions.at(-1)).toMatchObject({ apeAchievedMinor: 67 * M });
      const entry = await db().collection('auditLog').findOne({ action: 'goal.updated', targetId: String(stored!._id) }, { sort: { _id: -1 } });
      expect(entry?.after).toMatchObject({ apeAchievedChanged: true });
      expect(JSON.stringify(entry?.after)).not.toMatch(/6700000000/);
    });

    it('P19.8-T5 AC-4 with nothing uploaded there is no automatic figure: official is null', async () => {
      const read = await wired.goals.readOrDefaults(as('BUDI'), '2026');
      expect(read.official).toBeNull();
      expect((await typeOwn('BUDI', 67 * M)).official).toBeNull();
    });

    it('P19.8-T5 AC-5 OD-279 typed after the upload: shown and measured against on Goal Settings and the Summary (perkiraan Anda)', async () => {
      at('2026-09-14T06:00:00Z');
      await importFile({ BUDI: 30 });
      at('2026-09-14T07:00:00Z');
      await typeOwn('BUDI', 67 * M);

      const summary = await wired.summary.read(as('BUDI'));
      expect(summary.yearly).toMatchObject({ actualMinor: 67 * M, production: 'estimate', source: { provenance: 'self_reported' } });
      expect(summary.estimateReplaced).toBeNull();
      // The month's own APE is the office's, as it always is: the estimate is the year to date (OD-250).
      expect(summary.monthly).toMatchObject({ actualMinor: 30 * M, production: 'official' });
    });

    it('P19.8-T5 AC-5 OD-279 an import after the typed figure replaces it, with Diganti data produksi resmi (diunggah …)', async () => {
      at('2026-09-14T06:00:00Z');
      await importFile({ BUDI: 30 });
      at('2026-09-14T07:00:00Z');
      await typeOwn('BUDI', 67 * M);
      // The office's file again, later — a corrected September.
      at('2026-09-15T02:00:00Z');
      await importFile({ BUDI: 40 });

      const goal = await wired.goals.readOrDefaults(as('BUDI'), '2026');
      expect(goal.achieved).toEqual({ minor: 40 * M, provenance: 'imported', month: MONTH });
      // Replaced, not erased: the typed figure is still stored.
      expect(goal.apeAchievedMinor).toBe(67 * M);
      const summary = await wired.summary.read(as('BUDI'));
      expect(summary.yearly).toMatchObject({ actualMinor: 40 * M, production: 'official' });
      expect(summary.estimateReplaced).toEqual({ uploadedOn: '2026-09-15' });
    });

    it('P19.8-T5 AC-5 OD-279 a correction after the typed figure replaces it too — and typing again wins again', async () => {
      at('2026-09-14T06:00:00Z');
      await importFile({ BUDI: 30 });
      at('2026-09-14T07:00:00Z');
      await typeOwn('BUDI', 67 * M);
      at('2026-09-14T08:00:00Z');
      const month = await db().collection('productionMonths').findOne({ kpmId: KPM_A, month: MONTH, deletedAt: null });
      await wired.productionCorrections.correct(as('OWNER'), {
        month: MONTH, membershipId: office.id.BUDI, kode: 'APE', ytd: false, value: 45 * M, revision: month!.revision,
        reason: 'The carrier restated it',
      });
      expect((await wired.goals.readOrDefaults(as('BUDI'), '2026')).achieved)
        .toEqual({ minor: 45 * M, provenance: 'corrected', month: MONTH });
      expect((await wired.summary.read(as('BUDI'))).estimateReplaced).toEqual({ uploadedOn: '2026-09-14' });

      // The same figure typed again is a typing now: newer than the correction, so it is the one in force.
      at('2026-09-14T09:00:00Z');
      const again = await typeOwn('BUDI', 67 * M);
      expect(again.achieved).toEqual({ minor: 67 * M, provenance: 'self_reported', month: null });
      expect(again.apeAchievedTypedAt).toBe('2026-09-14T09:00:00.000Z');
    });

    it('P19.8-T5 AC-5 ADR-0230 §6 the Summary’s estimate sent again over a newer upload is a typing now: re-stamped, in force', async () => {
      const estimate = (minor: number) => wired.goals.saveEstimate(as('BUDI'), '2026', { apeAchievedMinor: minor });
      const stored = () => db().collection('goals').findOne({ membershipId: office.id.BUDI, period: '2026' });
      at('2026-09-14T06:00:00Z');
      await importFile({ BUDI: 30 });
      at('2026-09-14T07:00:00Z');
      await estimate(67 * M);
      // While it is the newer of the two, the same figure again writes nothing, as before.
      const typed = await stored();
      at('2026-09-14T07:30:00Z');
      expect((await estimate(67 * M)).apeAchievedTypedAt).toBe('2026-09-14T07:00:00.000Z');
      expect((await stored())!.version).toBe(typed!.version);

      // The office's file lands after it: the office's figure is in force.
      at('2026-09-15T02:00:00Z');
      await importFile({ BUDI: 40 });
      expect((await wired.goals.readOrDefaults(as('BUDI'), '2026')).achieved)
        .toEqual({ minor: 40 * M, provenance: 'imported', month: MONTH });

      // The member sends the same 67 again from the Summary: newer than that upload, so it wins — as the plan's save does.
      at('2026-09-15T03:00:00Z');
      const again = await estimate(67 * M);
      expect(again).toMatchObject({
        apeAchievedMinor: 67 * M, apeAchievedTypedAt: '2026-09-15T03:00:00.000Z',
        achieved: { minor: 67 * M, provenance: 'self_reported', month: null },
        official: { minor: 40 * M, provenance: 'imported', month: MONTH },
      });
      const after = await stored();
      expect(after!.version).toBe(typed!.version + 1);
      expect(after!.revisions.at(-1)).toMatchObject({ apeAchievedMinor: 67 * M });
      expect(await db().collection('auditLog').countDocuments({ action: 'goal.estimate_set', targetId: String(after!._id) })).toBe(2);
      expect((await wired.summary.read(as('BUDI'))).yearly).toMatchObject({ actualMinor: 67 * M, production: 'estimate' });
    });

    it.each([
      ['an AAB', 'SARI'],
      ['an AB', 'AGUS'],
    ] as [string, Who][])('P19.8-T5 AC-1 %s types over their own uploaded figure too', async (_role, who) => {
      at('2026-09-14T06:00:00Z');
      await importFile({ [who]: 50 });
      at('2026-09-14T07:00:00Z');
      const saved = await typeOwn(who, 70 * M);
      expect(saved.achieved).toEqual({ minor: 70 * M, provenance: 'self_reported', month: null });
      // The office's year to date beside it — September's file and any month it held before.
      expect(saved.official).toMatchObject({ provenance: 'imported', month: MONTH });
    });
  });

  describe('the coach’s view of the member’s plan (AC-5, AC-7)', () => {
    it.each([
      ['his AAB', 'SARI'],
      ['his AB', 'AGUS'],
      ['the Owner', 'OWNER'],
      ['an Admin', 'ADMIN'],
    ] as [string, Who][])('P19.8-T5 AC-5 ADR-0230 §6 %s reading ?for=BUDI sees the figure he typed over the upload as his: the plan, its preview and the Summary', async (_name, coach) => {
      at('2026-09-14T06:00:00Z');
      await importFile({ BUDI: 30 });
      at('2026-09-14T07:00:00Z');
      await typeOwn('BUDI', 67 * M);

      const read = await wired.goals.readOrDefaults(as(coach), '2026', office.id.BUDI);
      // The member's own figure — no `typedBy` — with the office's beside it.
      expect(read.achieved).toEqual({ minor: 67 * M, provenance: 'self_reported', month: null });
      expect(read.official).toEqual({ minor: 30 * M, provenance: 'imported', month: MONTH });
      // The preview of a plan that leaves the figure out works it out from his, as the save would.
      const preview = await wired.goals.preview(as(coach), '2026', plan({ annualApeTargetMinor: 600 * M }), office.id.BUDI);
      expect(preview.achieved).toEqual({ minor: 67 * M, provenance: 'self_reported', month: null });
      expect((await wired.summary.read(as(coach), office.id.BUDI)).yearly)
        .toMatchObject({ actualMinor: 67 * M, production: 'estimate' });
    });

    it.each([
      ['a peer AB', 'PEER_AB'],
      ['an AAB beside his', 'NINA'],
      ['an agent of the same unit', 'RINA'],
    ] as [string, Who][])('P19.8-T5 AC-5 ADR-0230 §6 %s, out of reach, reading ?for=BUDI is 404 on the plan, its preview and the Summary', async (_name, reader) => {
      at('2026-09-14T06:00:00Z');
      await importFile({ BUDI: 30 });
      at('2026-09-14T07:00:00Z');
      await typeOwn('BUDI', 67 * M);
      await expect(wired.goals.readOrDefaults(as(reader), '2026', office.id.BUDI)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.goals.preview(as(reader), '2026', plan(), office.id.BUDI)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.summary.read(as(reader), office.id.BUDI)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it.each([
      ['his AAB', 'SARI'],
      ['his AB', 'AGUS'],
      ['the Owner', 'OWNER'],
      ['the Admin', 'ADMIN'],
    ] as [string, Who][])('P19.8-T5 AC-7 ADR-0183 %s still cannot type over an upload: ignored, the member’s figure kept', async (_name, coach) => {
      at('2026-09-14T06:00:00Z');
      await importFile({ BUDI: 30 });
      at('2026-09-14T07:00:00Z');
      const saved = await wired.goals.save(as(coach), plan({ annualApeTargetMinor: 600 * M, apeAchievedMinor: 99 * M }), office.id.BUDI);
      expect(saved).toMatchObject({ annualApeTargetMinor: 600 * M, apeAchievedMinor: 0 });
      expect(saved.achieved).toEqual({ minor: 30 * M, provenance: 'imported', month: MONTH });
      const preview = await wired.goals.preview(as(coach), '2026', plan({ apeAchievedMinor: 99 * M }), office.id.BUDI);
      expect(preview.achieved).toEqual({ minor: 30 * M, provenance: 'imported', month: MONTH });
    });

    it('P19.8-T5 AC-7 ADR-0183 a coach types it while the office holds none (the positive case)', async () => {
      const saved = await wired.goals.save(as('SARI'), plan({ apeAchievedMinor: 42 * M }), office.id.BUDI);
      expect(saved.achieved).toMatchObject({ minor: 42 * M, provenance: 'self_reported', typedBy: { membershipId: office.id.SARI } });
    });

    it('P19.8-T5 AC-7 a coach’s save that leaves the figure out keeps the member’s newer one in force (S1)', async () => {
      at('2026-09-14T06:00:00Z');
      await importFile({ BUDI: 30 });
      at('2026-09-14T07:00:00Z');
      await typeOwn('BUDI', 67 * M);
      at('2026-09-14T08:00:00Z');
      // No `apeAchievedMinor` in the body: the screen sends it only when its reader changed it.
      const saved = await wired.goals.save(as('SARI'), plan({ annualApeTargetMinor: 600 * M }), office.id.BUDI);
      expect(saved.achieved).toEqual({ minor: 67 * M, provenance: 'self_reported', month: null });
      expect(saved.apeAchievedTypedAt).toBe('2026-09-14T07:00:00.000Z');
    });
  });

  describe('leaders’ and the office’s reads take the office’s figure in both orders (AC-5; ADR-0230 §7)', () => {
    /** Every leader's and the office's read Budi is in, as one object. */
    const everyLeaderRead = async () => ({
      agusMonth: await wired.unitDashboard.read(as('AGUS')),
      agusYear: await wired.unitDashboard.read(as('AGUS'), { period: 'year' }),
      sariYear: await wired.unitDashboard.read(as('SARI'), { period: 'year' }),
      roster: await wired.coachingRoster.read(as('SARI')),
      overview: await wired.kpmOverview.read(as('OWNER')),
      analytics: await wired.kpmAnalytics.read(as('OWNER'), { period: 'this_month' }),
      scorecard: await scorecardServiceOf(wired).compute({ kpmId: KPM_A, timezone: 'Asia/Jakarta', meetingDate: '2026-09-14' }),
    });

    it('P19.8-T5 AC-5 typed after the upload: every leader’s and the office’s read is the same as without it', async () => {
      at('2026-09-14T06:00:00Z');
      await importFile({ BUDI: 30 });
      at('2026-09-14T07:00:00Z');
      const without = await everyLeaderRead();
      await typeOwn('BUDI', 67 * M);
      // His own Summary did change.
      expect((await wired.summary.read(as('BUDI'))).yearly).toMatchObject({ actualMinor: 67 * M, production: 'estimate' });
      expect(await everyLeaderRead()).toEqual(without);
    });

    it('P19.8-T5 AC-5 typed before the upload: the same as without it, once the file lands', async () => {
      at('2026-09-14T05:00:00Z');
      await typeOwn('BUDI', 67 * M);
      at('2026-09-14T06:00:00Z');
      await importFile({ BUDI: 30 });
      at('2026-09-14T07:00:00Z');
      const withTyped = await everyLeaderRead();
      await typeOwn('BUDI', null);
      expect(await everyLeaderRead()).toEqual(withTyped);
    });

    it('P19.8-T5 AC-5 the Unit Dashboard’s row reads the office’s figure while Budi’s own screen reads his', async () => {
      at('2026-09-14T06:00:00Z');
      await importFile({ BUDI: 30 });
      at('2026-09-14T07:00:00Z');
      await typeOwn('BUDI', 67 * M);
      const view = await wired.unitDashboard.read(as('SARI'), { period: 'year' });
      const rows = [...view.yourUnit.rows, ...view.units.flatMap(function all(u): typeof view.yourUnit.rows {
        return [u.head, ...u.members, ...u.units.flatMap(all)];
      })];
      expect(rows.find((r) => r.membershipId === office.id.BUDI)!.goal)
        .toMatchObject({ actualMinor: 30 * M, source: { provenance: 'imported' } });
    });
  });

  describe('tenancy (invariant §1)', () => {
    it('P19.8-T5 AC-5 another office’s upload never dates this office’s figure: Budi’s typed figure stays in force', async () => {
      at('2026-09-14T06:00:00Z');
      await importFile({ BUDI: 30 });
      at('2026-09-14T07:00:00Z');
      await typeOwn('BUDI', 67 * M);
      // Office B commits a file after Budi typed: it is B's, and says nothing of office A's figures.
      await db().collection('dataUploadBatches').insertOne({
        kpmId: KPM_B, month: MONTH, status: 'committed', committedAt: new Date('2026-09-14T08:00:00Z'), deletedAt: null,
      });
      at('2026-09-14T09:00:00Z');
      expect((await wired.goals.readOrDefaults(as('BUDI'), '2026')).achieved)
        .toEqual({ minor: 67 * M, provenance: 'self_reported', month: null });
    });

    it('P19.8-T5 AC-5 office B reads nothing of Budi’s plan, and types nothing over it', async () => {
      const intruder = as('B_AB');
      await expect(wired.goals.readOrDefaults(intruder, '2026', office.id.BUDI)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.goals.save(intruder, plan({ apeAchievedMinor: 99 * M }), office.id.BUDI)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // A member of office B holding Budi's very membership id writes their own office's plan, never Budi's.
      const twin = new RequestContext('u-b', 'none', { ...as('BUDI').membership!, kpmId: KPM_B } as never);
      await expect(wired.goals.preview(twin, '2026', plan({ apeAchievedMinor: 99 * M }))).resolves.toMatchObject({
        achieved: { minor: 99 * M, provenance: 'self_reported' },
      });
      expect((await wired.goals.readOrDefaults(as('BUDI'), '2026')).apeAchievedMinor).toBe(0);
    });
  });
});

/**
 * **Over HTTP** (P19.8-T5): the three routes ADR-0230 changes — `GET /goals/:period` answers `official`, `PUT` takes
 * `apeAchievedMinor: null`, and the preview works out the typed figure over an upload — through the production pipe,
 * the permission guard and the error filter, per role and across offices.
 */
describe('P19.8-T5 the goal routes over HTTP (ADR-0230)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const http = () => request(app.getHttpServer());
  const as = (who: Who) => { session.current = office.as(who); };
  const body = (apeAchievedMinor?: number | null) => ({
    mode: 'direct', annualApeTargetMinor: 500 * M, savingsTargetMinor: 0, commissionRatePct: 0, monthsLeft: 4,
    caseSizeMinor: 18 * M, leadsToApptPct: 30, closingRatePct: 30,
    ...(apeAchievedMinor === undefined ? {} : { apeAchievedMinor }),
  });

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    wired = configModule(ROSTER_NOW);
    office = await buildCoachingOffice(wired);
    // Indah's September on a file the Owner uploaded at 06:00; the routes are called an hour later.
    (wired.clock as FixedClock).set(new Date('2026-09-14T06:00:00Z'));
    await importSeptember(wired, office, { INDAH: 85 });
    (wired.clock as FixedClock).set(new Date('2026-09-14T07:00:00Z'));
    const moduleRef = await Test.createTestingModule({
      controllers: [GoalController, SummaryController],
      providers: [
        { provide: GoalService, useValue: wired.goals },
        { provide: SummaryService, useValue: wired.summary },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await stopMongo();
  });

  it('P19.8-T5 AC-1 GET answers official: Indah’s office figure beside the figure in force; null for somebody with none', async () => {
    as('INDAH');
    const indah = (await http().get('/goals/2026').expect(200)).body;
    expect(indah.official).toMatchObject({ provenance: 'imported', month: MONTH });
    expect(indah.official.minor).toBe(indah.achieved.minor);
    as('BUDI');
    expect((await http().get('/goals/2026').expect(200)).body.official).toBeNull();
  });

  it.each(['BUDI', 'SARI', 'AGUS'] as Who[])('P19.8-T5 AC-4 PUT takes apeAchievedMinor: null from %s — the typed figure cleared', async (who) => {
    as(who);
    await http().put('/goals/2026').send(body(67 * M)).expect(200);
    const cleared = (await http().put('/goals/2026').send(body(null)).expect(200)).body;
    expect(cleared.apeAchievedMinor).toBe(0);
  });

  it('P19.8-T5 AC-4 a figure that is not whole sen is still refused, null or not', async () => {
    as('BUDI');
    const res = await http().put('/goals/2026').send(body(1.5)).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('P19.8-T5 AC-3 the preview answers the typed figure over the upload for the member, and the office’s for a coach', async () => {
    as('INDAH');
    const own = (await http().post('/goals/2026/preview').send(body(300 * M)).expect(200)).body;
    expect(own.achieved).toEqual({ minor: 300 * M, provenance: 'self_reported', month: null });
    as('AGUS');
    const coach = (await http().post('/goals/2026/preview').query({ for: office.id.INDAH }).send(body(999 * M)).expect(200)).body;
    expect(coach.achieved.provenance).not.toBe('self_reported');
  });

  it.each([
    ['office B’s AB reads', () => http().get('/goals/2026').query({ for: office.id.BUDI })],
    ['office B’s AB saves', () => http().put('/goals/2026').query({ for: office.id.BUDI }).send(body(99 * M))],
    ['office B’s AB previews', () => http().post('/goals/2026/preview').query({ for: office.id.BUDI }).send(body(99 * M))],
  ] as [string, () => request.Test][])('P19.8-T5 AC-5 cross-tenant: %s office A’s plan — 404', async (_what, call) => {
    as('B_AB');
    const res = await call().expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('P19.8-T5 AC-7 an Agent who leads cannot type for somebody else: 404 (own only)', async () => {
    as('LUKAS');
    await http().put('/goals/2026').query({ for: office.id.TARI }).send(body(99 * M)).expect(404);
  });
});
