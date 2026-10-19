import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
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
const owner = (kpmId = KPM_A) => ctxFor(kpmId, { isKpmOwner: true });

/**
 * **A balance an office builds names its own ends** (P13.1-T6, AC-6).
 *
 * The client could not see how to make a ratio like *Selling vs Recruitment*, and the Add-a-ratio form
 * now offers one plainly. Every balance it makes is read on *Activity Ratios* as *{s}% {first} ·
 * {100 − s}% {second}*, so `sides` has to be right for any of them, not only the seeded one: each end is
 * the section its activity types share, and `null` where they span sections — which the screen calls
 * *Side A* or *Side B*.
 */
describe('a balance an office builds, read with its own ends (P13.1-T6)', () => {
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

  const day = (counts: Record<string, number>, kpmId = KPM_A) => mongoose.connection.db!.collection('activityLogs').insertOne({
    kpmId, membershipId: `mem-${kpmId}`, localDate: TODAY,
    entries: Object.entries(counts).map(([code, count]) => ({ activityTypeId: `type-${code}`, activityTypeCode: code, count })),
    totalCount: Object.values(counts).reduce((t, n) => t + n, 0),
    source: 'self', version: 1, frozenAt: null, corrections: [], deletedAt: null,
  } as never);

  const balance = (code: string, numerator: string[], denominator: string[]) => wired.ratios.create(owner(), {
    code, label: code, numerator, denominator, benchmark: 30, comparison: 'band', appliesToOrgLevelCodes: [],
  });

  const read = async (code: string, kpmId = KPM_A) =>
    (await wired.activityLogs.ratios(agent(kpmId))).ratios.find((r) => r.code === code);

  it('AC-6: names each end by the section its codes share, and splits two to three as 40% to 60%', async () => {
    await balance('PROSPECTING_VS_SELLING', ['LEADS_GEN_ACTIVITY', 'LEADS_CONTACTED'], ['SELL_PRESENTATION']);
    await day({ LEADS_GEN_ACTIVITY: 1, LEADS_CONTACTED: 1, SELL_PRESENTATION: 3 });

    expect(await read('PROSPECTING_VS_SELLING')).toMatchObject({
      comparison: 'band', displayUnit: 'points', tag: { label: 'Balance' },
      sides: { numerator: 'Leads Generation', denominator: 'Selling' },
      numeratorCount: 2, denominatorCount: 3, value: -20, share: 40, status: 'success',
    });
  });

  it('AC-6: leaves an end unnamed when its codes span sections, for the screen to call Side A or B', async () => {
    await balance('MIXED_VS_RECRUITING', ['LEADS_CONTACTED', 'SELL_PRESENTATION'], ['RECRUIT_PRESENTATION', 'RECRUIT_FOLLOWUP']);
    expect((await read('MIXED_VS_RECRUITING'))!.sides).toEqual({ numerator: null, denominator: 'Recruitment' });
  });

  it('AC-6: names both ends by their one section when both count it, which the screen will not repeat', async () => {
    await balance('PRESENTING_VS_SUBMITTING', ['SELL_PRESENTATION'], ['SELL_SUBMISSION']);
    expect((await read('PRESENTING_VS_SUBMITTING'))!.sides).toEqual({ numerator: 'Selling', denominator: 'Selling' });
  });

  it('AC-6: follows a section the office renames, rather than the words it was seeded with', async () => {
    await balance('PROSPECTING_VS_SELLING', ['LEADS_CONTACTED'], ['SELL_PRESENTATION']);
    const selling = (await wired.activity.list(owner())).find((c) => c.code === 'SELLING')!;
    await wired.activity.updateCategory(owner(), selling.id, { label: 'Penjualan' });

    expect((await read('PROSPECTING_VS_SELLING'))!.sides).toEqual({ numerator: 'Leads Generation', denominator: 'Penjualan' });
  });

  it('AC-6: is one office’s own — another office has no such ratio, and its counts never reach it', async () => {
    await balance('PROSPECTING_VS_SELLING', ['LEADS_CONTACTED'], ['SELL_PRESENTATION']);
    await day({ LEADS_CONTACTED: 9, SELL_PRESENTATION: 1 }, KPM_B);

    expect(await read('PROSPECTING_VS_SELLING', KPM_B)).toBeUndefined();
    expect(await read('PROSPECTING_VS_SELLING')).toMatchObject({ value: null, share: null, status: 'neutral' });
  });
});
