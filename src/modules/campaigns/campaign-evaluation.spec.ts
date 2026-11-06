import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildCoachingOffice, KPM_A, ROSTER_NOW, type CoachingOffice, type Who } from '../../../test/coaching-office';
import { TEMPLATE_HEADER_V1 } from '../production/production-template';
import { byKode } from '../production/upload-columns';
import type { EvaluatedCampaignInput } from './campaign-evaluation';

const M = 1_000_000 * 100;
/** The twelve value columns of a version 1 file, keyed `metric.cadence` as these specs name them (P19.5-T2). */
const VALUE_COLUMNS = (['monthly', 'ytd'] as const).flatMap((cadence) =>
  (['ape', 'persistency', 'recruitment', 'newActiveAgents', 'fyp', 'policyCount'] as const).map((metric) => ({ metric, cadence })));
const wib = (local: string) => new Date(`${local}+07:00`);

/** A campaign as the evaluation reads it. */
const campaign = (over: Partial<EvaluatedCampaignInput> & { code: string }): EvaluatedCampaignInput => ({
  version: 1, window: 'campaign_dates', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-09-30T23:59:59.999'),
  appliesToOrgLevelCodes: [], requirements: [], frozenWindows: [], ...over,
});
const APE = (value: number) => ({ metricKey: 'APE_ACHIEVED', comparator: 'gte', value });

/**
 * **The evaluator over real records** (P18.2-T8 AC-2 to AC-5): the coaching office — August on file for four, September
 * for four, a fortnight of log — read through production's and activity's own functions. At 10:00 on Monday 14
 * September 2026 in Jakarta, August has locked (7 September) and September is open.
 */
describe('campaign evaluation over the office’s records (P18.2-T8)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const clock = () => wired.clock as FixedClock;
  const db = () => mongoose.connection.db!;
  const owner = () => office.as('OWNER');
  /** The campaign stored as the office's (its frozen windows read back from it), then evaluated, as the services do. */
  const evaluate = async (c: EvaluatedCampaignInput, who: Who[], ctx: RequestContext = owner()) => {
    const campaigns = db().collection('campaigns');
    if (!(await campaigns.findOne({ kpmId: KPM_A, code: c.code }))) {
      await campaigns.insertOne({
        kpmId: KPM_A, code: c.code, title: c.code, version: 1, status: 'active', frozenWindows: [], deletedAt: null,
      });
    }
    const stored = (await campaigns.findOne({ kpmId: KPM_A, code: c.code }))!;
    const frozenWindows = ((stored.frozenWindows ?? []) as { key: string }[]).map((w) => w.key);
    return wired.campaignEvaluation.evaluate(ctx, [{ ...c, frozenWindows }], who.map((w) => office.id[w])).then((m) => m.get(c.code)!);
  };
  /**
   * **A month the office has written** (P19.5-T2; ADR-0214 §11): a month of the required history never written stays
   * open whatever its date, so a month these specs read as locked on schedule is one an upload wrote. The office holds
   * January, August and September (`writtenMonthRows`); a later month a spec reads as locked is written here.
   */
  const writtenMonth = (month: string, on: string) => db().collection('productionMonths').insertOne(
    { kpmId: KPM_A, month, revision: 1, firstWrittenOn: on, deletedAt: null },
  );
  /** A chase, made early in the year unless said otherwise — before every window these specs freeze ends. */
  const chase = async (code: string, who: Who, chasedAt = wib('2026-01-05T09:00:00')) => db().collection('campaignChases').insertOne({
    kpmId: KPM_A, membershipId: office.id[who], campaignCode: code, chasing: true, chasedAt,
    unchasedAt: null, closedBy: null, deletedAt: null,
  });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    clock().set(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
  });

  describe('exit test 1 — campaign progress computes against real production data (AC-3)', () => {
    const SPRINT = campaign({ code: 'APE_SPRINT', requirements: [APE(150 * M)] });
    const MDRT = campaign({
      code: 'MDRT_QUALIFICATION', window: 'calendar_year', startsAt: wib('2026-01-01T00:00:00'), endsAt: null,
      requirements: [APE(2_400 * M)],
    });

    /** The month table's own figures for Rina's months: `GET /kpm/data-upload/:month`. */
    const tableSum = async (months: string[]) => {
      let sum = 0;
      for (const month of months) {
        const view = await wired.production.readMonth(owner(), month);
        const row = view.rows.find((r) => r.membershipId === office.id.RINA);
        sum += row?.values.APE?.value ?? 0;
      }
      return sum;
    };
    const summaryYear = async () => (await wired.summary.read(office.as('RINA'))).yearly.actualMinor;
    const current = async (c: EvaluatedCampaignInput) => (await evaluate(c, ['RINA'])).members.get(office.id.RINA)!.rows[0].current;

    const agentCode = async (who: Who) =>
      (await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id[who]) }))!.agentCode as string;
    const file = async (rows: [Who, Record<string, string>][]) => ({
      buffer: Buffer.from([
        TEMPLATE_HEADER_V1.join(','),
        ...(await Promise.all(rows.map(async ([who, cells]) =>
          [await agentCode(who), '"x"', ...VALUE_COLUMNS.map((c) => cells[`${c.metric}.${c.cadence}`] ?? '')].join(',')))),
      ].join('\n')),
      originalname: 'f.csv',
      size: 0,
    });
    const importFile = async (rows: [Who, Record<string, string>][], replace?: string) => {
      const f = await file(rows);
      const preview = await wired.production.preview(owner(), '2026-09', f);
      return wired.productionImport.commit(owner(), '2026-09', String(preview.revision), f, replace);
    };

    it('P18.2-T8 AC-3 a requirement’s current equals the month table for the same months, and a year’s the Summary’s', async () => {
      expect(await current(SPRINT)).toBe(await tableSum(['2026-08', '2026-09']));
      expect(await current(SPRINT)).toBe(100 * M);
      expect(await current(MDRT)).toBe(await summaryYear());
      expect(await current(MDRT)).toBe(240 * M);
    });

    it('P19.5-T2 AC-7 P18.2-T8 AC-3 an import, the Owner’s correction, a leader’s Update production and a revert each show on the next read', async () => {
      const check = async () => {
        expect(await current(SPRINT)).toBe(await tableSum(['2026-08', '2026-09']));
        expect(await current(MDRT)).toBe(await summaryYear());
      };
      // 1. The carrier restates Rina's September, ticked to replace.
      const imported = await importFile([['RINA', { 'ape.monthly': '90', 'ape.ytd': '250' }]]);
      await check();
      expect(await current(SPRINT)).toBe(110 * M);

      // 2. The Owner corrects September's own APE at the month table.
      const state = await wired.productionMonths.state(owner(), '2026-09');
      await wired.productionCorrections.correct(owner(), {
        month: '2026-09', membershipId: office.id.RINA, kode: 'APE', ytd: false, value: 95 * M,
        revision: state.revision, reason: 'Carrier adjustment',
      });
      await check();
      expect(await current(SPRINT)).toBe(115 * M);

      // 3. Sari, her leader, updates it from the Unit Dashboard — the month alone: a year to date is the months' sum
      // since P19.5-T2, never entered (AC-7).
      const now = await wired.productionMonths.state(owner(), '2026-09');
      await wired.unitDashboard.updateProduction(office.as('SARI'), {
        month: '2026-09', revision: now.revision, rows: [{ membershipId: office.id.RINA, apeMonthlyMinor: 97 * M }],
      });
      await check();
      expect(await current(SPRINT)).toBe(117 * M);
      // January's 140 M, August's 20 M and September's 97 M: the year moves with the month (it was the 260 M Sari typed).
      expect(await current(MDRT)).toBe(257 * M);

      // 4. Reverting the import puts back what it replaced; the corrections made since stand.
      await wired.productionImport.revert(owner(), imported.batch.id);
      await check();
    }, 60_000);

    it('P18.2-T8 AC-3 a month not held reads Not uploaded yet, never ✕ — even once the window is over', async () => {
      // July is held by nobody: a window of July and August, short of its target, is not a miss.
      const summer = campaign({
        code: 'SUMMER', startsAt: wib('2026-07-01T00:00:00'), endsAt: wib('2026-08-31T23:59:00'), requirements: [APE(30 * M)],
      });
      await chase('SUMMER', 'RINA');
      const e = await evaluate(summer, ['RINA']);
      expect(e.members.get(office.id.RINA)!.rows[0]).toMatchObject({ current: 20 * M, met: null, state: 'not_uploaded' });
      // August locked, so the window is final — and July's absence leaves it unknown, never not met.
      expect(e.final).toBe(true);
      expect(e.members.get(office.id.RINA)!.status).toBe('unknown');
      // A window nothing of which is held at all.
      const empty = campaign({
        code: 'EMPTY', startsAt: wib('2026-05-01T00:00:00'), endsAt: wib('2026-06-30T23:59:00'), requirements: [APE(1)],
      });
      expect((await evaluate(empty, ['RINA'])).members.get(office.id.RINA)!.rows[0]).toMatchObject({ current: null, state: 'not_uploaded' });
    });
  });

  describe('finality (AC-5, OD-154)', () => {
    const AUGUST = campaign({
      code: 'AUGUST_PUSH', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-08-31T23:59:00'), requirements: [APE(15 * M)],
    });

    it('P18.2-T8 AC-5 freezes a window on the first read after its last month locks — its chasers’ standings, once', async () => {
      await chase('AUGUST_PUSH', 'RINA');
      await chase('AUGUST_PUSH', 'BUDI');
      const e = await evaluate(AUGUST, ['RINA', 'BUDI', 'INDAH']);
      expect(e.final).toBe(true);
      expect(Object.fromEntries([...e.members].map(([id, m]) => [id, m.status]))).toEqual({
        // Rina chased and cleared it; Budi chased and holds nothing for August; Indah cleared it and never chased.
        [office.id.RINA]: 'qualified', [office.id.BUDI]: 'not_met', [office.id.INDAH]: 'not_joined',
      });
      // Only a chaser's standing is stored (ADR-0143 §4).
      const stored = await db().collection('campaignStandings').find({ campaignCode: 'AUGUST_PUSH' }).toArray();
      const active = 2;
      expect(stored.map((s) => s.membershipId).sort()).toEqual([office.id.RINA, office.id.BUDI].sort());
      expect(await db().collection('auditLog').countDocuments({ action: 'campaign_standing.finalised' })).toBe(1);
      expect(stored.every((s) => s.windowKey === '2026-08..2026-08' && s.kpmId === KPM_A)).toBe(true);
      // No rank, anywhere on it.
      expect(stored.some((s) => 'rank' in s)).toBe(false);

      // A second read writes nothing.
      await evaluate(AUGUST, ['RINA']);
      expect(await db().collection('campaignStandings').countDocuments({ campaignCode: 'AUGUST_PUSH' })).toBe(active);
    });

    it('P18.2-T8 AC-5 a reopen and a correction after finality change nothing in it; before it, they show', async () => {
      await chase('AUGUST_PUSH', 'RINA');
      // Before: August reopened (no longer locked), Rina's August corrected down — not final, and the figure moves.
      await wired.productionMonths.reopen(owner(), '2026-08');
      let state = await wired.productionMonths.state(owner(), '2026-08');
      await wired.productionCorrections.correct(owner(), {
        month: '2026-08', membershipId: office.id.RINA, kode: 'APE', ytd: false, value: 10 * M,
        revision: state.revision, reason: 'Clawback',
      });
      let e = await evaluate(AUGUST, ['RINA']);
      expect(e.final).toBe(false);
      expect(e.members.get(office.id.RINA)!).toMatchObject({ status: 'in_progress', rows: [{ current: 10 * M, state: 'in_progress' }] });
      expect(await db().collection('campaignStandings').countDocuments({})).toBe(0);

      // Locked again: final, and frozen at 10 M.
      await wired.productionMonths.lock(owner(), '2026-08');
      e = await evaluate(AUGUST, ['RINA']);
      expect(e.members.get(office.id.RINA)!).toMatchObject({ final: true, status: 'not_met', rows: [{ current: 10 * M, state: 'not_met' }] });

      // After: reopened and corrected back up — the standing does not move (a rewarded result cannot flip either way).
      await wired.productionMonths.reopen(owner(), '2026-08');
      state = await wired.productionMonths.state(owner(), '2026-08');
      await wired.productionCorrections.correct(owner(), {
        month: '2026-08', membershipId: office.id.RINA, kode: 'APE', ytd: false, value: 30 * M,
        revision: state.revision, reason: 'Clawback reversed',
      });
      await wired.productionMonths.lock(owner(), '2026-08');
      e = await evaluate(AUGUST, ['RINA']);
      expect(e.members.get(office.id.RINA)!).toMatchObject({ final: true, status: 'not_met', rows: [{ current: 10 * M, met: false }] });
    });

    it('P18.2-T8 AC-5 a running window is never stored, and the rolling twelve months never become final', async () => {
      const rolling = campaign({
        code: 'PROMOTION_AGENT_AAB', window: 'rolling_12m', startsAt: wib('2025-01-01T00:00:00'), endsAt: null,
        requirements: [APE(1), { metricKey: 'NEW_ACTIVE_AGENTS', comparator: 'gte', value: 3 }],
      });
      clock().set(wib('2027-06-01T10:00:00'));
      const e = await evaluate(rolling, ['RINA']);
      expect(e.final).toBe(false);
      expect(e.window.months).toHaveLength(12);
      expect(await db().collection('campaignStandings').countDocuments({})).toBe(0);
      clock().set(ROSTER_NOW);
      expect((await evaluate(campaign({ code: 'NOW', requirements: [APE(1)] }), ['RINA'])).final).toBe(false);
      expect(await db().collection('campaignStandings').countDocuments({})).toBe(0);
    });

    it('P18.2-T8 AC-5 freezes a calendar year in the January after it, once its December locks', async () => {
      const MDRT = campaign({
        code: 'MDRT_QUALIFICATION', window: 'calendar_year', startsAt: wib('2026-01-01T00:00:00'), endsAt: null, requirements: [APE(200 * M)],
      });
      await chase('MDRT_QUALIFICATION', 'RINA');
      // December 2026's file written on its last day (P19.5-T2: a month never written stays open).
      await writtenMonth('2026-12', '2026-12-31');
      // 3 January 2027: December 2026 still open — nothing frozen; 9 January: locked, 2026 frozen; the answer is 2027's.
      clock().set(wib('2027-01-03T10:00:00'));
      expect((await evaluate(MDRT, ['RINA'])).window.key).toBe('2027');
      expect(await db().collection('campaignStandings').countDocuments({ windowKey: '2026' })).toBe(0);
      clock().set(wib('2027-01-09T10:00:00'));
      await evaluate(MDRT, ['RINA']);
      const rina = await db().collection('campaignStandings').findOne({ windowKey: '2026', membershipId: office.id.RINA });
      expect(rina).toMatchObject({ status: 'qualified', chasing: true, requirements: [{ current: 240 * M, met: true }] });
    });

    it('P18.2-T8 AC-5 a window of activity alone is final once its last day’s backdating grace has passed', async () => {
      const blitz = campaign({
        code: 'TOUCH_BLITZ', startsAt: wib('2026-09-01T00:00:00'), endsAt: wib('2026-09-10T23:59:00'),
        requirements: [{ metricKey: 'CASCADE_ACTIVITY_TOUCHES', comparator: 'gte', value: 20 }],
      });
      // September's days stay editable until 7 October.
      clock().set(wib('2026-10-07T23:59:00'));
      expect((await evaluate(blitz, ['INDAH'])).final).toBe(false);
      clock().set(wib('2026-10-08T00:01:00'));
      expect((await evaluate(blitz, ['INDAH'])).final).toBe(true);
    });
  });

  describe('what each requirement reads (AC-1, D-evaluable)', () => {
    it('P18.2-T8 AC-1 counts the goal’s three activities over the window’s days, and the office’s ratio by its engine', async () => {
      const window = { startsAt: wib('2026-09-01T00:00:00'), endsAt: wib('2026-09-30T23:59:00') };
      const e = await evaluate(campaign({
        code: 'ACTIVITY', ...window,
        requirements: [
          { metricKey: 'CASCADE_ACTIVITY_TOUCHES', comparator: 'gte', value: 20 },
          { metricKey: 'RECRUITMENT_SUCCESS_RATE', comparator: 'gte', value: 0.3 },
        ],
      }), ['INDAH', 'RINA']);
      // Indah logged two LEADS_CONTACTED on each of ten days: twenty touches, met while the window still runs.
      expect(e.members.get(office.id.INDAH)!.rows[0]).toMatchObject({ current: 20, state: 'met' });
      // Rina recruits and closes nobody: 0 of the office's 0.3, in progress until September ends.
      const ratios = await wired.activityLogs.ratiosOf(owner(), { membershipId: office.id.RINA, orgLevelCode: 'AB' });
      const theirs = ratios.ratios.find((r) => r.code === 'RECRUITMENT_SUCCESS_RATE')!;
      expect(e.members.get(office.id.RINA)!.rows[1]).toMatchObject({ current: theirs.value, state: 'in_progress' });
      expect(theirs.value).toBe(0);
    });

    it('P18.2-T8 AC-1 counts a Direct Unit’s active agents for the latest month held, by MAA’s one definition', async () => {
      // Agus's Direct Unit: Indah (Rp 80 M in September), Dimas (Rp 20 M), Lukas (no row) — and Agus (no row).
      const e = await evaluate(campaign({
        code: 'UNIT', requirements: [{ metricKey: 'MAA_COUNT_IN_UNIT', comparator: 'gte', value: 2 }],
      }), ['AGUS', 'SARI']);
      expect(e.members.get(office.id.AGUS)!.rows[0]).toMatchObject({ current: 2, state: 'met' });
      // Sari's: Rina (Rp 80 M) and Budi (no row), and Sari herself (Rp 90 M).
      expect(e.members.get(office.id.SARI)!.rows[0]).toMatchObject({ current: 2 });
    });

    it('P18.2-T8 AC-1 reads persistency as the latest month held, and New Hire from the file’s recruitment column', async () => {
      await db().collection('monthlyAgentData').updateOne(
        { kpmId: KPM_A, membershipId: office.id.RINA, month: '2026-08' },
        { $set: { 'values.PERSISTENCY': { value: 91, provenance: 'imported' }, 'values.RECRUITMENT': { value: 2, provenance: 'imported' } } },
      );
      await db().collection('monthlyAgentData').updateOne(
        { kpmId: KPM_A, membershipId: office.id.RINA, month: '2026-09' },
        { $set: { 'values.PERSISTENCY': { value: 88, provenance: 'imported' }, 'values.RECRUITMENT': { value: 1, provenance: 'imported' } } },
      );
      const e = await evaluate(campaign({
        code: 'FILE', requirements: [
          { metricKey: 'ROLLING_PERSISTENCY', comparator: 'gte', value: 90 },
          { metricKey: 'NEW_HIRES', comparator: 'gte', value: 3 },
        ],
      }), ['RINA']);
      expect(e.members.get(office.id.RINA)!.rows.map((r) => [r.current, r.state])).toEqual([[88, 'in_progress'], [3, 'met']]);
    });

    it('P18.2-T8 AC-1 reads a stored requirement outside the set as Not measured yet, and a stored rung by its code', async () => {
      const e = await evaluate(campaign({
        code: 'OLD', appliesToOrgLevelCodes: ['AAB'], requirements: [{ metricKey: 'EVENT_NPS', comparator: 'gte', value: 50 }],
      }), ['RINA', 'SARI']);
      expect(e.members.get(office.id.RINA)!).toMatchObject({ eligible: false, rows: [{ state: 'not_measured', current: null }] });
      expect(e.members.get(office.id.SARI)!.eligible).toBe(true);
    });

    it('P18.2-T8 AC-7 refuses to read a requirement against its metric’s period, naming it', async () => {
      const registry = await import('@/domain/metrics/registry');
      const real = registry.metric;
      const spy = jest.spyOn(registry, 'metric').mockImplementation((id: string) =>
        (id === 'APE_ACHIEVED' ? { ...real(id), period: 'ROLLING_7D' } : real(id)));
      await expect(evaluate(campaign({ code: 'X', requirements: [APE(1)] }), ['RINA'])).rejects.toThrow(/APE_ACHIEVED is read as sum of file/);
      spy.mockRestore();
    });
  });

  describe('edges (AC-1, AC-3)', () => {
    it('P18.2-T8 AC-9 asks nothing of nobody: no campaign, no member', async () => {
      expect((await wired.campaignEvaluation.evaluate(owner(), [], [office.id.RINA])).size).toBe(0);
      const e = await wired.campaignEvaluation.evaluate(owner(), [campaign({ code: 'X', requirements: [APE(1)] })], []);
      expect(e.get('X')!.members.size).toBe(0);
    });

    it('P18.2-T8 AC-1 reads no day before a window begins, and a ratio the office has archived, as nothing logged (review item 7)', async () => {
      await db().collection('ratioDefinitions').updateMany({ kpmId: KPM_A, code: 'SELLING_SUCCESS_RATE' }, { $set: { status: 'archived' } });
      const e = await evaluate(campaign({
        code: 'LATER', startsAt: wib('2026-11-01T00:00:00'), endsAt: wib('2026-11-30T23:59:00'),
        requirements: [{ metricKey: 'CASCADE_ACTIVITY_TOUCHES', comparator: 'gte', value: 1 }],
      }), ['INDAH']);
      expect(e.members.get(office.id.INDAH)!.rows[0]).toMatchObject({ current: null, state: 'nothing_logged' });
      const ratio = await evaluate(campaign({
        code: 'RATIO', startsAt: wib('2026-09-01T00:00:00'), requirements: [{ metricKey: 'SELLING_SUCCESS_RATE', comparator: 'gte', value: 0.1 }],
      }), ['INDAH']);
      expect(ratio.members.get(office.id.INDAH)!.rows[0]).toMatchObject({ current: null, state: 'nothing_logged', met: null });
    });

    it('P18.2-T8 AC-3 a member with no row in a held month holds nothing there: 0 summed, no persistency, no year to date', async () => {
      const e = await evaluate(campaign({
        code: 'BUDI', requirements: [APE(1), { metricKey: 'ROLLING_PERSISTENCY', comparator: 'gte', value: 1 }],
      }), ['BUDI']);
      expect(e.members.get(office.id.BUDI)!.rows.map((r) => [r.current, r.state])).toEqual([[0, 'in_progress'], [null, 'not_uploaded']]);
      const mdrt = await evaluate(campaign({
        code: 'MDRT', window: 'calendar_year', startsAt: wib('2026-01-01T00:00:00'), endsAt: null, requirements: [APE(1)],
      }), ['BUDI']);
      expect(mdrt.members.get(office.id.BUDI)!.rows[0].current).toBe(0);
    });

    it('P18.2-T8 AC-5 a frozen standing reads back as it was frozen — an undecided row Not uploaded yet', async () => {
      const summer = campaign({
        code: 'SUMMER', startsAt: wib('2026-07-01T00:00:00'), endsAt: wib('2026-08-31T23:59:00'), requirements: [APE(30 * M)],
      });
      await chase('SUMMER', 'RINA');
      await evaluate(summer, ['RINA']);
      const again = (await evaluate(summer, ['RINA'])).members.get(office.id.RINA)!;
      expect(again).toMatchObject({ status: 'unknown', final: true, rows: [{ current: 20 * M, met: null, state: 'not_uploaded' }] });
      // A frozen requirement no campaign can measure any more reads Not measured yet.
      await db().collection('campaignStandings').updateOne({ campaignCode: 'SUMMER' }, { $set: { 'requirements.0.metricKey': 'EVENT_NPS' } });
      expect((await evaluate(summer, ['RINA'])).members.get(office.id.RINA)!.rows[0].state).toBe('not_measured');
    });

    it('P18.2-T7 AC-2 an office with no campaign reads an empty list; a removed metric keeps its stored unit', async () => {
      expect((await wired.campaignAgent.list(office.as('B_AGENT'))).campaigns).toEqual([]);
      await db().collection('campaigns').insertOne({
        kpmId: KPM_A, code: 'OLD_METRIC', title: 'Old', description: '', startsAt: new Date('2026-09-01T00:00:00+07:00'),
        endsAt: new Date('2026-09-30T23:59:00+07:00'), kind: 'seasonal', subtype: null, window: 'campaign_dates',
        appliesToOrgLevelCodes: [], poster: { emoji: '🎯', color: 'navy' }, blurb: '', reward: '',
        requirements: [{ metricKey: 'GONE_METRIC', comparator: 'gte', value: 5, unit: 'count' }],
        version: 1, status: 'active', archivedAt: null, deletedAt: null,
      });
      const detail = await wired.campaignAgent.detail(office.as('RINA'), 'OLD_METRIC');
      expect(detail.requirements[0]).toMatchObject({ metricName: 'GONE_METRIC', unit: 'count', measured: false });
      expect(detail.progress!.rows[0]).toMatchObject({ unit: 'count', state: 'not_measured' });
    });
  });

  describe('P18.2-T8 review — the freeze', () => {
    const MDRT = campaign({
      code: 'MDRT_QUALIFICATION', window: 'calendar_year', startsAt: wib('2026-01-01T00:00:00'), endsAt: null, requirements: [APE(200 * M)],
    });
    const AUGUST = campaign({
      code: 'AUGUST_PUSH', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-08-31T23:59:59.999'), requirements: [APE(15 * M)],
    });

    it('P18.2-T8 review item 1 a chase made after the year ended never enters it; a window frozen with no chaser stays frozen', async () => {
      // December 2026's file written on its last day (P19.5-T2: a month never written stays open).
      await writtenMonth('2026-12', '2026-12-31');
      clock().set(wib('2027-01-09T10:00:00'));
      await evaluate(MDRT, ['RINA']);
      expect(await db().collection('campaignStandings').countDocuments({})).toBe(0);
      expect((await db().collection('campaigns').findOne({ code: 'MDRT_QUALIFICATION' }))!.frozenWindows.map((w: { key: string }) => w.key))
        .toEqual(['2026']);
      // Rina chases in February 2027: the 2026 window was decided without her, and is not frozen again.
      clock().set(wib('2027-02-01T10:00:00'));
      await chase('MDRT_QUALIFICATION', 'RINA', wib('2027-02-01T10:00:00'));
      await evaluate(MDRT, ['BUDI']);
      expect(await db().collection('campaignStandings').countDocuments({})).toBe(0);
      expect(await db().collection('auditLog').countDocuments({ action: 'campaign_standing.finalised' })).toBe(1);
    });

    it('P18.2-T8 review item 1 a chase dropped after the end still counts in it; one dropped before it does not', async () => {
      await db().collection('campaignChases').insertMany([
        { kpmId: KPM_A, membershipId: office.id.RINA, campaignCode: 'AUGUST_PUSH', chasing: false, chasedAt: wib('2026-08-02T09:00:00'),
          unchasedAt: wib('2026-09-03T09:00:00'), closedBy: 'member', deletedAt: null },
        { kpmId: KPM_A, membershipId: office.id.BUDI, campaignCode: 'AUGUST_PUSH', chasing: false, chasedAt: wib('2026-08-02T09:00:00'),
          unchasedAt: wib('2026-08-20T09:00:00'), closedBy: 'member', deletedAt: null },
      ]);
      const e = await evaluate(AUGUST, ['RINA', 'BUDI']);
      expect([e.members.get(office.id.RINA)!.status, e.members.get(office.id.BUDI)!.status]).toEqual(['qualified', 'not_joined']);
      expect((await db().collection('campaignStandings').find({}).toArray()).map((r) => r.membershipId)).toEqual([office.id.RINA]);
    });

    it('P18.2-T8 review item 3 a leaver who chased to the end and left before the freeze keeps their standing; the close is audited', async () => {
      await chase('AUGUST_PUSH', 'DIMAS', wib('2026-08-02T09:00:00'));
      await wired.campaignDeparture.left(owner(), office.id.DIMAS);
      await db().collection('memberships').updateOne(
        { _id: new mongoose.Types.ObjectId(office.id.DIMAS) }, { $set: { status: 'removed', removedAt: ROSTER_NOW } },
      );
      await evaluate(AUGUST, ['RINA']);
      expect(await db().collection('campaignStandings').findOne({ membershipId: office.id.DIMAS }))
        .toMatchObject({ chasing: true, status: 'qualified' });
      expect(await db().collection('auditLog').findOne({ action: 'campaign.unchased', targetMembershipId: office.id.DIMAS }))
        .toMatchObject({ before: { campaignCode: 'AUGUST_PUSH', chasing: true }, after: { chasing: false, closedBy: 'departure' } });
    });

    it('P18.2-T8 review item 2 a read-only support session is answered the frozen view and writes nothing', async () => {
      await chase('AUGUST_PUSH', 'RINA');
      const c = office.as('RINA');
      const readOnly = new RequestContext(c.userId, 'none', c.membership, 'sa-1', null, false, true);
      const e = await evaluate(AUGUST, ['RINA'], readOnly);
      expect(e.members.get(office.id.RINA)!).toMatchObject({ final: true, status: 'qualified' });
      expect(await db().collection('campaignStandings').countDocuments({})).toBe(0);
      expect((await db().collection('campaigns').findOne({ code: 'AUGUST_PUSH' }))!.frozenWindows).toEqual([]);
      expect(await db().collection('auditLog').countDocuments({ action: 'campaign_standing.finalised' })).toBe(0);
    });

    it('P18.2-T8 review item 6 two first reads at once freeze once and audit once', async () => {
      await chase('AUGUST_PUSH', 'RINA');
      await db().collection('campaigns').insertOne({
        kpmId: KPM_A, code: 'AUGUST_PUSH', title: 'August', version: 1, status: 'active', frozenWindows: [], deletedAt: null,
      });
      const input = { ...AUGUST, frozenWindows: [] };
      await Promise.all([1, 2, 3].map(() => wired.campaignEvaluation.evaluate(owner(), [input], [office.id.RINA])));
      expect(await db().collection('campaignStandings').countDocuments({})).toBe(1);
      expect(await db().collection('auditLog').countDocuments({ action: 'campaign_standing.finalised' })).toBe(1);
    });
  });

  describe('P18.2-T8 review — what a requirement reads', () => {
    it('P18.2-T8 review item 4 a Direct Unit is its members at the month’s end: a leaver until they left, nobody who joined after', async () => {
      // Lukas joins Agus's Direct Unit with Rp 50 M in August — but only in October; Indah left on 20 August.
      await db().collection('memberships').updateOne(
        { _id: new mongoose.Types.ObjectId(office.id.LUKAS) }, { $set: { joinedAt: wib('2026-10-01T09:00:00') } },
      );
      await db().collection('memberships').updateOne(
        { _id: new mongoose.Types.ObjectId(office.id.INDAH) }, { $set: { status: 'removed', removedAt: wib('2026-08-20T09:00:00') } },
      );
      await db().collection('monthlyAgentData').insertOne({
        kpmId: KPM_A, membershipId: office.id.LUKAS, month: '2026-08', agentCode: 'L', deletedAt: null,
        ...byKode({ apeMonthly: { value: 50 * M, provenance: 'imported' }, apeYtd: { value: 50 * M, provenance: 'imported' } }),
      });
      const e = await evaluate(campaign({
        code: 'UNIT_AUG', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-08-31T23:59:59.999'),
        requirements: [{ metricKey: 'MAA_COUNT_IN_UNIT', comparator: 'gte', value: 1 }],
      }), ['AGUS']);
      // August: Dimas (Rp 20 M) only — Indah had left by its end, Lukas had not joined.
      expect(e.members.get(office.id.AGUS)!.rows[0].current).toBe(1);
    });

    it('P18.2-T8 review item 5 the rolling twelve months count the activity of their own months, not to today', async () => {
      // 20 January 2027, the file's latest month still September 2026 (a stale file early in the year): the window is
      // October 2025 – September 2026, and its figures are fetched from the resolved window, not from thirteen months back.
      clock().set(wib('2027-01-20T10:00:00'));
      const e = await evaluate(campaign({
        code: 'ROLLING', window: 'rolling_12m', startsAt: wib('2025-01-01T00:00:00'), endsAt: null,
        requirements: [{ metricKey: 'CASCADE_ACTIVITY_TOUCHES', comparator: 'gte', value: 1 }, APE(1)],
      }), ['INDAH']);
      expect(e.window.months[11]).toBe('2026-09');
      expect(e.window.days).toEqual({ from: '2025-10-01', to: '2026-09-30' });
      // Indah's APE: January's 140 M — the month that makes the office's summed year to date its file's (P19.5-T2) — with
      // August's 20 M and September's 80 M, all inside October 2025 – September 2026.
      expect(e.members.get(office.id.INDAH)!.rows.map((r) => r.current)).toEqual([20, 240 * M]);
    });

    it('P18.2-T8 review item 7 once final, a chaser with nothing logged is not met, never unknown', async () => {
      await chase('RATIO_SEPT', 'BUDI');
      clock().set(wib('2026-10-20T10:00:00'));
      const e = await evaluate(campaign({
        code: 'RATIO_SEPT', startsAt: wib('2026-09-01T00:00:00'), endsAt: wib('2026-09-30T23:59:59.999'),
        requirements: [{ metricKey: 'SELLING_SUCCESS_RATE', comparator: 'gte', value: 0.1 }],
      }), ['BUDI']);
      expect(e.members.get(office.id.BUDI)!).toMatchObject({ final: true, status: 'not_met', rows: [{ current: null, met: false, state: 'nothing_logged' }] });
    });

    it('P18.2-T8 review item 21 a met figure that can still fall is in progress until final; a met running sum is qualified', async () => {
      await chase('NOW', 'RINA');
      await db().collection('monthlyAgentData').updateOne(
        { kpmId: KPM_A, membershipId: office.id.RINA, month: '2026-09' }, { $set: { 'values.PERSISTENCY': { value: 95, provenance: 'imported' } } },
      );
      const live = (requirements: EvaluatedCampaignInput['requirements']) => evaluate(campaign({ code: 'NOW', requirements }), ['RINA'])
        .then((e) => e.members.get(office.id.RINA)!.status);
      expect(await live([APE(1)])).toBe('qualified');
      expect(await live([{ metricKey: 'ROLLING_PERSISTENCY', comparator: 'gte', value: 90 }])).toBe('in_progress');
      expect(await live([{ ...APE(500 * M), comparator: 'lte' }])).toBe('in_progress');
      expect(await live([{ metricKey: 'RECRUITMENT_SUCCESS_RATE', comparator: 'gte', value: 0 }])).toBe('in_progress');
    });
  });

  describe('a leaver (ADR-0136)', () => {
    it('P18.2-T7 AC-5 a leaver’s chases close through MemberDeparture, and a standing frozen before they left stays', async () => {
      const AUGUST = campaign({
        code: 'AUGUST_PUSH', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-08-31T23:59:00'), requirements: [APE(15 * M)],
      });
      await chase('AUGUST_PUSH', 'DIMAS');
      await chase('APE_SPRINT', 'DIMAS');
      // Frozen while Dimas is a member.
      await evaluate(AUGUST, ['DIMAS']);
      await wired.campaignDeparture.left(owner(), office.id.DIMAS);
      const chases = await db().collection('campaignChases').find({ membershipId: office.id.DIMAS }).toArray();
      expect(chases.map((c) => [c.chasing, c.closedBy])).toEqual([[false, 'departure'], [false, 'departure']]);
      expect(await db().collection('campaignStandings').findOne({ campaignCode: 'AUGUST_PUSH', membershipId: office.id.DIMAS }))
        .toMatchObject({ chasing: true, status: 'qualified' });
      // A running campaign no longer counts them as a chaser.
      const sprint = await evaluate(campaign({ code: 'APE_SPRINT', requirements: [APE(1)] }), ['DIMAS']);
      expect(sprint.members.get(office.id.DIMAS)!.chasing).toBe(false);
    });
  });
});
