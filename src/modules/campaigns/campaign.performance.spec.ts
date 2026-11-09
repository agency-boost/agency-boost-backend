import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { byKode } from '@/modules/production/upload-columns';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

/** 10:00 on 14 September in Jakarta: August on file and locked, September open and half logged. */
const NOW = new Date('2026-09-14T03:00:00Z');
const BIG = '66f0000000000000000000a1';
const SMALL = '66f0000000000000000000a2';
const COMPANY = '66f0000000000000000000c1';
const M = 1_000_000 * 100;
const wib = (local: string) => new Date(`${local}+07:00`).toISOString();

/**
 * **Campaigns at the 500-member ceiling** (P18.2-T8 AC-9; `performance-and-scale.md`): the standings port Phase 18.3
 * reads, the agent's dialog and the list, over an office of 500 — one AB, ten AABs, forty-nine agents each — and an
 * office of 50 beside it, with the seeded kinds of campaign: dated over the file, a calendar year, the rolling twelve
 * months, activity with a ratio, and one final and frozen. **The same queries for fifty as for five hundred: none per
 * member.**
 */
describe('campaigns, measured (P18.2-T8 AC-9)', () => {
  let wired: ReturnType<typeof configModule>;
  const heads: Record<string, string> = {};
  const owner = (kpmId: string) => new RequestContext(`u-${kpmId}`, 'none', {
    membershipId: heads[kpmId], kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
    isKpmOwner: true, isKpmAdmin: false, directCount: 10,
  } as never);

  const build = async (kpmId: string, code: string, units: number, perUnit: number) => {
    const db = mongoose.connection.db!;
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create(
      { _id: kpmId, companyId: COMPANY, code, branchName: code, timezone: 'Asia/Jakarta' },
    );
    await provisionOffice(wired, kpmId, COMPANY);
    const members: Record<string, unknown>[] = [];
    let seq = 0;
    const place = (role: 'ab' | 'aab' | 'agent', leader: string | null, ancestors: string[]) => {
      seq += 1;
      const id = new mongoose.Types.ObjectId();
      members.push({
        _id: id, kpmId, userId: `u${code}${seq}`, agentCode: `${code}-${seq}`, agentSeq: seq, leaderCode: `${code}${seq}`,
        orgLevelId: 'x', orgLevelCode: role.toUpperCase(), role, leaderId: leader, ancestorIds: ancestors,
        depth: ancestors.length, status: 'active', deletedAt: null,
      });
      return String(id);
    };
    const ab = place('ab', null, []);
    heads[kpmId] = ab;
    const everyone = [ab];
    for (let u = 0; u < units; u += 1) {
      const aab = place('aab', ab, [ab]);
      everyone.push(aab);
      for (let a = 0; a < perUnit; a += 1) everyone.push(place('agent', aab, [ab, aab]));
    }
    await db.collection('memberships').insertMany(members);
    const cell = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });
    const months: Record<string, unknown>[] = [];
    const logs: Record<string, unknown>[] = [];
    const chases: Record<string, unknown>[] = [];
    everyone.forEach((id, i) => {
      ['2026-07', '2026-08', '2026-09'].forEach((month, m) => months.push({
        kpmId, membershipId: id, month, agentCode: `${code}-${i}`, deletedAt: null,
        ...byKode({
          apeMonthly: cell(20 * M), apeYtd: cell(20 * M * (m + 7)), policyCountMonthly: cell(1),
          persistencyMonthly: cell(90), recruitmentMonthly: cell(1), newActiveAgentsMonthly: cell(0),
        }),
      }));
      for (let d = 1; d <= 5; d += 1) {
        logs.push({
          kpmId, membershipId: id, localDate: `2026-09-0${d}`, source: 'self', enteredByMembershipId: id, version: 1,
          frozenAt: null, corrections: [], deletedAt: null, totalCount: 2,
          entries: [
            { activityTypeId: 't-l', activityTypeCode: 'LEADS_CONTACTED', count: 1 },
            { activityTypeId: 't-r', activityTypeCode: 'RECRUIT_FOLLOWUP', count: 1 },
          ],
        });
      }
      for (const campaignCode of ['APE_SPRINT', 'MDRT_QUALIFICATION', 'JULY_PUSH']) {
        if (i % 2 === 0) chases.push({ kpmId, membershipId: id, campaignCode, chasing: true, deletedAt: null });
      }
    });
    await db.collection('monthlyAgentData').insertMany(months);
    // The months as an upload writes them (ADR-0214 §11): a month never written stays open whatever its date, so July and
    // August — written at their ends — lock on schedule, and September, written on the 10th, is open.
    await db.collection('productionMonths').insertMany([['2026-07', '2026-07-31'], ['2026-08', '2026-08-31'], ['2026-09', '2026-09-10']]
      .map(([month, on]) => ({ kpmId, month, revision: 1, firstWrittenOn: on, deletedAt: null })));
    await db.collection('activityLogs').insertMany(logs);
    await db.collection('campaignChases').insertMany(chases);

    const o = owner(kpmId);
    const make = (body: Record<string, unknown>) => wired.campaigns.create(o, body);
    await make({
      code: 'APE_SPRINT', title: 'APE Sprint', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-09-30T23:59:00'),
      requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 30 * M }, { metricKey: 'NEW_HIRES', comparator: 'gte', value: 1 }],
    });
    await make({
      code: 'JULY_PUSH', title: 'July Push', startsAt: wib('2026-07-01T00:00:00'), endsAt: wib('2026-07-31T23:59:00'),
      requirements: [{ metricKey: 'ROLLING_PERSISTENCY', comparator: 'gte', value: 85 }],
    });
    await make({
      code: 'MDRT_QUALIFICATION', title: 'MDRT', kind: 'structural', subtype: 'ongoing', window: 'calendar_year',
      startsAt: wib('2026-01-01T00:00:00'), endsAt: null, requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 100 * M }],
    });
    await make({
      code: 'PROMOTION_AAB_AB', title: 'Promotion', kind: 'structural', subtype: 'promotion', window: 'rolling_12m',
      startsAt: wib('2026-01-01T00:00:00'), endsAt: null, appliesToOrgLevelCodes: ['AAB'],
      requirements: [{ metricKey: 'MAA_COUNT_IN_UNIT', comparator: 'gte', value: 5 }, { metricKey: 'NEW_ACTIVE_AGENTS', comparator: 'gte', value: 3 }],
    });
    await make({
      code: 'RECRUIT_SPRINT', title: 'Recruit', startsAt: wib('2026-09-01T00:00:00'), endsAt: wib('2026-09-30T23:59:00'),
      requirements: [{ metricKey: 'RECRUITMENT_SUCCESS_RATE', comparator: 'gte', value: 0.3 }, { metricKey: 'CASCADE_ACTIVITY_TOUCHES', comparator: 'gte', value: 5 }],
    });
    return everyone;
  };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await clearCollections();
    await wired.orgLevels.seedDefaultLadder(COMPANY);
    await build(BIG, '0417', 10, 49);
    await build(SMALL, '0418', 1, 49);
    await Promise.all(['Membership', 'MonthlyAgentData', 'ActivityLog', 'CampaignChase', 'CampaignStanding', 'Campaign']
      .filter((name) => mongoose.modelNames().includes(name))
      .map((name) => mongoose.model(name).syncIndexes()));
    // Freeze July once in each, so the measured reads read standings rather than writing them.
    await wired.campaignStandingsReader.ofOffice(owner(BIG));
    await wired.campaignStandingsReader.ofOffice(owner(SMALL));
  }, 240_000);

  afterAll(async () => {
    mongoose.set('debug', false);
    await stopMongo();
  });

  const counted = async <T>(run: () => Promise<T>): Promise<{ result: T; queries: string[] }> => {
    const queries: string[] = [];
    mongoose.set('debug', (collection: string, method: string) => { queries.push(`${collection}.${method}`); });
    try {
      return { result: await run(), queries };
    } finally {
      mongoose.set('debug', false);
    }
  };

  const p95 = async (run: () => Promise<unknown>): Promise<number> => {
    await run();
    const times: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const started = process.hrtime.bigint();
      await run();
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    times.sort((a, b) => a - b);
    return times[Math.ceil(0.95 * times.length) - 1];
  };

  it('P18.2-T8 AC-9 the standings port reads 500 members and five campaigns in the same queries as 50', async () => {
    const small = await counted(() => wired.campaignStandingsReader.ofOffice(owner(SMALL)));
    const large = await counted(() => wired.campaignStandingsReader.ofOffice(owner(BIG)));
    expect(large.result.standings).toHaveLength(5 * 501);
    expect(small.result.standings).toHaveLength(5 * 51);
    expect(large.queries.sort()).toEqual(small.queries.sort());
    // eslint-disable-next-line no-console
    console.log(`  standings port: ${large.queries.length} queries — ${large.queries.join(', ')}`);
    expect(large.queries.length).toBeLessThanOrEqual(25);
    // July is final and frozen: its chasers read from their standings, nothing written again.
    expect(large.queries.filter((q) => q.startsWith('campaignstandings.insert') || q.startsWith('campaignStandings.insert'))).toEqual([]);
    const july = large.result.standings.filter((s) => s.campaignCode === 'JULY_PUSH');
    expect(new Set(july.map((s) => s.status))).toEqual(new Set(['qualified', 'not_joined']));
  }, 60_000);

  it('P18.3-T2 AC-9 the tree’s path — the members asked for, over the year — is the same queries for 50 as for 500', async () => {
    const year = { start: new Date('2026-01-01T00:00:00+07:00'), end: new Date('2027-01-01T00:00:00+07:00') };
    const membersOf = async (kpmId: string) => (await mongoose.connection.db!.collection('memberships')
      .find({ kpmId, status: 'active' }).toArray()).map((m) => String(m._id));
    const [idsSmall, idsBig] = [await membersOf(SMALL), await membersOf(BIG)];
    const small = await counted(() => wired.campaignStandingsReader.ofOffice(owner(SMALL), { memberIds: idsSmall, window: year }));
    const large = await counted(() => wired.campaignStandingsReader.ofOffice(owner(BIG), { memberIds: idsBig, window: year }));
    expect(large.result.standings).toHaveLength(large.result.campaigns.length * 501);
    expect(large.queries.sort()).toEqual(small.queries.sort());
    // eslint-disable-next-line no-console
    console.log(`  standings port, the tree's path: ${large.queries.length} queries`);
    // One fewer than the office-wide read: the office's memberships are not listed.
    expect(large.queries.length).toBeLessThanOrEqual(24);
  }, 60_000);

  it('P18.2-T8 AC-9 the dialog and the list are a fixed number of queries for any office', async () => {
    const ctxSmall = owner(SMALL);
    const ctxBig = owner(BIG);
    const small = await counted(() => wired.campaignAgent.detail(ctxSmall, 'PROMOTION_AAB_AB'));
    const large = await counted(() => wired.campaignAgent.detail(ctxBig, 'PROMOTION_AAB_AB'));
    expect(large.queries.sort()).toEqual(small.queries.sort());
    const listSmall = await counted(() => wired.campaignAgent.list(ctxSmall));
    const listBig = await counted(() => wired.campaignAgent.list(ctxBig));
    expect(listBig.queries.sort()).toEqual(listSmall.queries.sort());
  });

  it('P18.2-T8 AC-9 records the ceiling’s cost', async () => {
    const port = await p95(() => wired.campaignStandingsReader.ofOffice(owner(BIG)));
    const dialog = await p95(() => wired.campaignAgent.detail(owner(BIG), 'APE_SPRINT'));
    // eslint-disable-next-line no-console
    console.log(`  campaigns p95 of 10 at 501 people: standings port ${port.toFixed(1)} ms; dialog ${dialog.toFixed(1)} ms`);
    // Recorded, not budgeted here; the bounds catch a read gone per-member.
    expect(port).toBeLessThan(5000);
    expect(dialog).toBeLessThan(2000);
  }, 120_000);
});
