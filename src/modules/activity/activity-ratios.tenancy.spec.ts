import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { readerIn } from '@/common/i18n/reader';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

const NOW = new Date('2026-03-11T02:00:00Z');
const TODAY = '2026-03-11';
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

const ctxFor = (kpmId: string, over: Record<string, unknown> = {}) => new RequestContext('u1', 'none', {
  membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
} as never);
const agent = (kpmId = KPM_A) => ctxFor(kpmId);
const leader = () => ctxFor(KPM_A, { membershipId: 'mem-leader', orgLevelCode: 'AB', hierarchyRole: 'ab', directCount: 1 });
const owner = (kpmId = KPM_A) => ctxFor(kpmId, { isKpmOwner: true });

/**
 * The ratio engine (P10-T2) and who a ratio is a question about (P10-T3), over stored days.
 *
 * Days are written straight into the collection: the ratios read what is stored, and a day three weeks
 * back is past ADR-0042's window for the save route.
 */
describe('the office’s ratios, over a member’s last 30 days (P10-T2, P10-T3)', () => {
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

  const day = (
    localDate: string, counts: Record<string, number>, { kpmId = KPM_A, membershipId = `mem-${KPM_A}` } = {},
  ) => mongoose.connection.db!.collection('activityLogs').insertOne({
    kpmId, membershipId, localDate,
    entries: Object.entries(counts).map(([code, count]) => ({ activityTypeId: `type-${code}`, activityTypeCode: code, count })),
    totalCount: Object.values(counts).reduce((t, n) => t + n, 0),
    source: 'self', version: 1, frozenAt: null, corrections: [], deletedAt: null,
  } as never);

  const byCode = async (ctx: RequestContext) => Object.fromEntries(
    (await wired.activityLogs.ratios(ctx)).ratios.map((r) => [r.code, r]),
  );

  describe('AC-1 — the office’s definitions, over a fixed 30 days of stored entries', () => {
    it('sums both sides over the thirty days ending today, and nothing older', async () => {
      await day(TODAY, { SELL_SUBMISSION: 2, SELL_PRESENTATION: 6 });
      await day('2026-02-10', { SELL_SUBMISSION: 1, SELL_FOLLOWUP: 4 }); // the 30th day back
      await day('2026-02-09', { SELL_SUBMISSION: 50 }); // the 31st: outside

      const view = await wired.activityLogs.ratios(agent());
      const ssr = view.ratios.find((r) => r.code === 'SELLING_SUCCESS_RATE')!;

      expect(view).toMatchObject({ from: '2026-02-10', to: TODAY, days: 30, membershipId: `mem-${KPM_A}` });
      expect(ssr).toMatchObject({ numeratorCount: 3, denominatorCount: 10, value: 0.3, status: 'success' });
    });

    it('keeps counting a type the office has since archived, and still names it', async () => {
      await day(TODAY, { SELL_SUBMISSION: 1, SELL_FOLLOWUP: 9 });
      const type = (await wired.activity.list(owner())).flatMap((c) => c.types).find((t) => t.code === 'SELL_FOLLOWUP')!;
      await wired.activity.archiveType(owner(), type.id);

      const ssr = (await byCode(agent())).SELLING_SUCCESS_RATE;
      expect(ssr.denominatorCount).toBe(9);
      expect(ssr.denominator.map((t) => t.label)).toContain(type.label);
    });

    it('takes thirty days whatever an office’s stored setting says (ADR-0022)', async () => {
      await mongoose.connection.db!.collection('kpms').updateOne(
        { _id: new mongoose.Types.ObjectId(KPM_A) }, { $set: { 'settings.ratioWindowDays': 14 } },
      );
      expect((await wired.activityLogs.ratios(agent())).from).toBe('2026-02-10');
    });
  });

  describe('AC-2 — nothing logged is not enough data, for every ratio', () => {
    it('answers null and neutral, never zero', async () => {
      const view = await wired.activityLogs.ratios(agent());
      expect(view.ratios.length).toBeGreaterThan(0);
      for (const ratio of view.ratios) expect(ratio).toMatchObject({ value: null, status: 'neutral' });
    });
  });

  describe('AC-3 — judged against the office’s own benchmark (testing obligation 5)', () => {
    it('reads one office against its raised benchmark, and leaves the other on the default', async () => {
      for (const kpmId of [KPM_A, KPM_B]) {
        await day(TODAY, { SELL_SUBMISSION: 4, SELL_PRESENTATION: 10 }, { kpmId, membershipId: `mem-${kpmId}` });
      }
      const ssr = (await wired.ratios.list(owner())).find((r) => r.code === 'SELLING_SUCCESS_RATE')!;
      await wired.ratios.update(owner(), ssr.id, { benchmark: 0.45 });

      expect((await byCode(agent(KPM_A))).SELLING_SUCCESS_RATE).toMatchObject({ value: 0.4, benchmark: 0.45, status: 'alert' });
      // The default is 30% since ADR-0160 §2.
      expect((await byCode(agent(KPM_B))).SELLING_SUCCESS_RATE).toMatchObject({ value: 0.4, benchmark: 0.3, status: 'success' });
    });
  });

  describe('AC-4, AC-5 — the balance, the formula, and what each measures', () => {
    it('gives an AB the balance as a lean toward one side, with its share', async () => {
      await day(TODAY, { SELL_PRESENTATION: 9, RECRUIT_PRESENTATION: 1 }, { membershipId: 'mem-leader' });
      expect((await byCode(leader())).SELLING_VS_RECRUITMENT).toMatchObject({
        comparison: 'band', displayUnit: 'points', value: 80, share: 90, status: 'alert', tag: { label: 'Balance' },
        sides: { numerator: 'Selling', denominator: 'Recruitment' },
      });
      expect((await byCode(leader())).SELLING_SUCCESS_RATE.sides).toBeNull();
    });

    it('P18.98-T5 AC-4 tags the balance in the reader’s language; its sides are the office’s own labels, as typed', async () => {
      await day(TODAY, { SELL_PRESENTATION: 9, RECRUIT_PRESENTATION: 1 }, { membershipId: 'mem-leader' });
      expect((await byCode(leader().withReader(readerIn('id')))).SELLING_VS_RECRUITMENT).toMatchObject({
        tag: { code: null, label: 'Keseimbangan' }, sides: { numerator: 'Selling', denominator: 'Recruitment' },
      });
    });

    it('names each side’s terms as the office numbers them, tags the section, and says what it measures', async () => {
      const view = await byCode(agent());
      expect(view.SELLING_SUCCESS_RATE.numerator).toEqual([{ code: 'SELL_SUBMISSION', label: expect.any(String), displayOrder: 6 }]);
      expect(view.SELLING_SUCCESS_RATE.denominator.map((t) => t.displayOrder)).toEqual([4, 5]);
      expect(view.SELLING_SUCCESS_RATE.tag).toEqual({ code: 'SELLING', label: 'Selling' });
      expect(view.MEETING_PER_APPROACH.tag).toMatchObject({ code: 'LEADS_GENERATION' });
      expect(view.SELLING_SUCCESS_RATE.purpose).toBe('Mengukur tingkat konversi aktivitas selling menjadi submission');
      expect(view.SELLING_SUCCESS_RATE.divergesFromStandard).toBe(false);
    });

    it('drops the platform’s sentence once the office changes the formula, and shows the office’s', async () => {
      const lpa = (await wired.ratios.list(owner())).find((r) => r.code === 'LEADS_PER_ACTIVITY')!;
      await wired.ratios.update(owner(), lpa.id, { numerator: ['LEADS_CONTACTED'] });

      const view = (await byCode(agent())).LEADS_PER_ACTIVITY;
      expect(view).toMatchObject({ divergesFromStandard: true, purpose: null });
      expect(view.numerator.map((t) => t.code)).toEqual(['LEADS_CONTACTED']);
    });
  });

  describe('P10-T3 — only the ratios that are a question about the subject’s rung (ADR-0020)', () => {
    it('AC-2: shows an agent neither recruitment ratio, and an AB and an AAB all five', async () => {
      const agentCodes = Object.keys(await byCode(agent()));
      expect(agentCodes).toEqual(['SELLING_SUCCESS_RATE', 'LEADS_PER_ACTIVITY', 'MEETING_PER_APPROACH']);
      expect(Object.keys(await byCode(leader()))).toHaveLength(5);
      expect(Object.keys(await byCode(ctxFor(KPM_A, { orgLevelCode: 'AAB', hierarchyRole: 'aab' })))).toHaveLength(5);
    });

    it('AC-1: follows the office when it widens a ratio to every rung', async () => {
      const rsr = (await wired.ratios.list(owner())).find((r) => r.code === 'RECRUITMENT_SUCCESS_RATE')!;
      await wired.ratios.update(owner(), rsr.id, { appliesToOrgLevelCodes: [] });
      expect(Object.keys(await byCode(agent()))).toContain('RECRUITMENT_SUCCESS_RATE');
    });
  });

  describe('AC-7 — your own, only', () => {
    it('never counts another member’s days, nor another office’s under the same member id', async () => {
      await day(TODAY, { SELL_SUBMISSION: 1, SELL_PRESENTATION: 4 });
      await day(TODAY, { SELL_SUBMISSION: 40, SELL_PRESENTATION: 40 }, { membershipId: 'mem-someone-else' });
      await day(TODAY, { SELL_SUBMISSION: 70, SELL_PRESENTATION: 70 }, { kpmId: KPM_B, membershipId: `mem-${KPM_A}` });

      expect((await byCode(agent())).SELLING_SUCCESS_RATE).toMatchObject({ numeratorCount: 1, denominatorCount: 4 });
    });

    it('refuses somebody with no membership — a Super Admin has no ratios of their own', async () => {
      await expect(wired.activityLogs.ratios(RequestContext.platform('root')))
        .rejects.toMatchObject({ status: 403, code: 'TENANT_NO_MEMBERSHIP' });
    });
  });
});
