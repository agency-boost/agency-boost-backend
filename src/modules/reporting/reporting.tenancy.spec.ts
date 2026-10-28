import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { KPM_A, KPM_B, ROSTER_NOW } from '../../../test/coaching-office';
import { buildReportingOffice, type ReportingOffice } from '../../../test/reporting-office';

const M = 1_000_000 * 100;

/**
 * **Isolation** (invariant §1; P18-T1 AC-12, P18-T2 AC-10, P18-T8 AC-2): 0417 against 0555.
 *
 * Every report resolves its office from the reader's membership and reads every collection through the
 * tenant-scoped repository, so no route takes an id that could name another office — there is no 404 to give,
 * and the proof is that **nothing of 0555 reaches 0417's figures**: a heavy dose of 0555 records (members,
 * production, sessions, logging, leads, goals, a target) changes no figure of 0417's Overview, analytics or
 * directory, and 0555's Owner is answered 0555 alone. The platform's three named cross-office reads refuse anybody
 * but a Super Admin, as an unscoped read must, and so does the platform's service before it reads anything.
 */
describe('the Owner’s reporting, isolated (invariant §1)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: ReportingOffice;
  const db = () => mongoose.connection.db!;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildReportingOffice(wired);
  }, 120_000);

  afterAll(stopMongo);

  /** Everything 0417's Owner reads, with the audit entries' ids stripped of nothing but the reads themselves. */
  const snapshot = async () => {
    const owner = office.as('OWNER');
    return {
      overview: await wired.kpmOverview.read(owner),
      notLogged: await wired.kpmOverview.notLogged(owner),
      thisMonth: await wired.kpmAnalytics.read(owner, { period: 'this_month' }),
      previousMonth: await wired.kpmAnalytics.read(owner, { period: 'previous_month' }),
      directory: await wired.directoryColumns.decorate(owner, {
        members: [{ membershipId: office.id.RINA, status: 'active' } as never, { membershipId: office.id.TARI, status: 'active' } as never],
        nextCursor: null, counts: { directory: 0, pending: 0, removed: 0 },
      }),
    };
  };

  it('P18-T1 AC-12, P18-T2 AC-10 nothing of 0555 reaches any figure of 0417’s', async () => {
    const before = await snapshot();

    // 0555 grows: twenty members under its AB, a year of production, sessions, logging, leads, goals and a target.
    const bAb = office.id.B_AB;
    const people = Array.from({ length: 20 }, () => String(new mongoose.Types.ObjectId()));
    await db().collection('memberships').insertMany(people.map((id, i) => ({
      _id: new mongoose.Types.ObjectId(id), kpmId: KPM_B, userId: String(new mongoose.Types.ObjectId()), agentCode: `B${i}`,
      agentSeq: 100 + i, leaderCode: `BL${i}`, orgLevelId: 'x', orgLevelCode: i < 3 ? 'AAB' : 'AGENT', role: i < 3 ? 'aab' : 'agent',
      leaderId: bAb, ancestorIds: [bAb], depth: 1, status: 'active', joinedAt: new Date('2026-09-02T02:00:00Z'), deletedAt: null,
    })));
    const cell = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });
    await db().collection('monthlyAgentData').insertMany([bAb, ...people].flatMap((id) => ['2026-03', '2026-08', '2026-09'].map((month) => ({
      kpmId: KPM_B, membershipId: id, month, agentCode: 'B', deletedAt: null,
      apeMonthly: cell(500 * M), apeYtd: cell(5000 * M), persistencyMonthly: cell(99), policyCountMonthly: cell(9),
    }))));
    await db().collection('coachingSessions').insertMany(people.map((id) => ({
      kpmId: KPM_B, coachMembershipId: bAb, coacheeMembershipId: id, status: 'finalized', date: '2026-09-13',
      frozenAt: new Date('2026-09-13T04:00:00Z'), version: 3, deletedAt: null,
    })));
    await db().collection('activityLogs').insertMany(people.map((id) => ({
      kpmId: KPM_B, membershipId: id, localDate: '2026-09-13', entries: [], totalCount: 0, source: 'self',
      enteredByMembershipId: id, version: 1, frozenAt: null, corrections: [], deletedAt: null,
    })));
    await db().collection('leads').insertMany(people.map((id, i) => ({
      kpmId: KPM_B, ownerMembershipId: id, type: 'recruitment', name: `B lead ${i}`, statusCode: 'AAJI_LICENSED',
      outcome: i < 5 ? 'won' : null, outcomeAt: i < 5 ? new Date('2026-08-20T03:00:00Z') : null, commitments: [{ month: '2026-09' }],
      transitions: [], version: 1, deletedAt: null, dateRegistered: new Date('2026-08-01T02:00:00Z'),
    })));
    await db().collection('goals').insertMany(people.map((id) => ({
      kpmId: KPM_B, membershipId: id, period: '2026', mode: 'direct', annualApeTargetMinor: 9000 * M, savingsTargetMinor: 0,
      commissionRatePct: 0, monthsLeftOverride: null, apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30,
      closingRatePct: 30, savedAt: ROSTER_NOW, savedByMembershipId: id, version: 1, deletedAt: null,
      cascadeMapping: { leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION' },
    })));
    await wired.kpmOverview.setRecruitTarget(office.ownerOfB(), { month: '2026-09', target: 99 });

    const after = await snapshot();
    expect(after).toEqual(before);
    expect(after.overview.recruitment.target).toBeNull();
  }, 60_000);

  it('P18-T1 AC-12 0555’s Owner is answered 0555 alone, and writes 0555’s target alone', async () => {
    const b = office.ownerOfB();
    const overview = await wired.kpmOverview.read(b);
    expect(overview.office.code).toBe('0555');
    expect(overview.composition.total).toBe(22);
    expect(overview.recruitment).toMatchObject({ target: 99, closedLastMonth: 5, expectedToClose: 15 });
    const analytics = await wired.kpmAnalytics.read(b);
    expect(analytics.agencies.map((a) => a.head.membershipId)).toEqual([office.id.B_AB]);
    const ids = new Set(Object.values(office.id));
    const everyId = JSON.stringify([overview, analytics]).match(/[0-9a-f]{24}/g) ?? [];
    const of0417 = ['OWNER', 'ADMIN', 'AGUS', 'INDAH', 'DIMAS', 'SARI', 'RINA', 'BUDI', 'NINA', 'DODI', 'DEWI', 'LUKAS', 'TARI']
      .map((who) => office.id[who as keyof typeof office.id]);
    expect(everyId.filter((id) => ids.has(id) && of0417.includes(id))).toEqual([]);
    expect(await db().collection('kpmRecruitTargets').find({}, { projection: { _id: 0, kpmId: 1, target: 1 } }).toArray())
      .toEqual([{ kpmId: KPM_B, target: 99 }]);
  });

  it('P18.97-T3 AC-5, AC-10 every AB on a board is the reader’s office’s own; another office’s AB who leads nobody is never listed', async () => {
    // 0555 gains an AB under its root who leads nobody: a *No team* row of 0555's.
    const lonely = new mongoose.Types.ObjectId();
    await db().collection('memberships').insertOne({
      _id: lonely, kpmId: KPM_B, userId: String(new mongoose.Types.ObjectId()), agentCode: 'BLONE', agentSeq: 500, leaderCode: 'BLONE001',
      orgLevelId: 'x', orgLevelCode: 'AB', role: 'ab', leaderId: office.id.B_AB, ancestorIds: [office.id.B_AB], depth: 1,
      status: 'active', joinedAt: new Date('2026-01-05T02:00:00Z'), deletedAt: null,
    });

    const of0417 = (await wired.kpmOverview.read(office.as('OWNER'))).coaching.leaderboard;
    expect(of0417.map((row) => row.membershipId).sort())
      .toEqual([office.id.OWNER, office.id.ADMIN, office.id.AGUS, office.id.PEER_AB].sort());
    expect(of0417.find((row) => !row.leads)!.membershipId).toBe(office.id.ADMIN);

    const of0555 = (await wired.kpmOverview.read(office.ownerOfB())).coaching.leaderboard;
    expect(of0555.map((row) => [row.membershipId, row.leads, row.pct])).toEqual([
      [office.id.B_AB, true, expect.any(Number)], [String(lonely), false, null],
    ]);
    // The analytics' served shares stay each office's own: 0555's twenty-odd producers reach none of 0417's rows.
    const analytics = await wired.kpmAnalytics.read(office.as('OWNER'));
    expect(analytics.total).toMatchObject({ activeAgents: 5, activePct: 31, manpower: { total: 16 } });
  });

  it('P18-T1 AC-12 the target’s repository refuses a read or a write with no office in the context', async () => {
    const nobody = RequestContext.platform('root');
    await expect(wired.recruitTargets.standingFor(nobody, '2026-09')).rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(wired.recruitTargets.setTarget(nobody, '2026-09', 1)).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('P18-T8 AC-2 the platform’s three named reads refuse anybody but a Super Admin, and read every office for one', async () => {
    const owner = office.as('OWNER');
    const month = { start: new Date('2026-08-31T17:00:00Z'), endExclusive: new Date('2026-09-30T17:00:00Z') };
    await expect(wired.memberships.adoptionPerOfficeAcrossTenants(owner, month)).rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(wired.memberships.signInsPerOfficeAcrossTenants(owner, { days7: month.start, days30: month.start }))
      .rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(wired.memberships.distinctAccountsAcrossTenants(owner, [], { days7: month.start, days30: month.start }))
      .rejects.toBeInstanceOf(MissingTenantContextError);
    // No office listed: nobody counted, never a failure.
    const none = await wired.memberships.distinctAccountsAcrossTenants(RequestContext.platform('root'), [], { days7: month.start, days30: month.start });
    expect([[...none.companies], none.platform]).toEqual([[], { members: 0, signedIn7d: 0, signedIn30d: 0 }]);
    // The service asks first, before anything is read: a member, and the operator inside a support session of either kind.
    const supported = (readOnly: boolean) => new RequestContext(owner.userId, 'none', owner.membership, 'u-support', null, false, readOnly);
    for (const ctx of [owner, supported(true), supported(false)]) {
      await expect(wired.platformAnalytics.read(ctx)).rejects.toMatchObject({ code: 'PERM_DENIED' });
    }
    const platform = RequestContext.platform('root');
    const adoption = await wired.memberships.adoptionPerOfficeAcrossTenants(platform, month);
    expect(new Set(adoption.byRung.map((r) => r.kpmId))).toEqual(new Set([KPM_A, KPM_B]));
    expect(adoption.joined.get(KPM_B)).toBe(20);
    expect(adoption.joined.get(KPM_A)).toBeUndefined();
  });
});
