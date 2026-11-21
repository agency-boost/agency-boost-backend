import mongoose from 'mongoose';
import { byKode } from '@/modules/production/upload-columns';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { KPM_B, ROSTER_NOW } from '../../../test/coaching-office';
import { buildReportingOffice, type ReportingOffice } from '../../../test/reporting-office';

const M = 1_000_000 * 100;

/**
 * **Isolation** (invariant §1; P18-T1 AC-12, P18-T2 AC-10, P18-T8 AC-2): 0417 against 0555.
 *
 * Every report resolves its office from the reader's membership and reads every collection through the
 * tenant-scoped repository, so no route takes an id that could name another office — there is no 404 to give,
 * and the proof is that **nothing of 0555 reaches 0417's figures**: a heavy dose of 0555 records (members,
 * production, sessions, logging, leads, goals, a target) changes no figure of 0417's Overview — its people, usage,
 * coaching, production and *Performa vs target* (P19.19) — or directory, and 0555's Owner is answered 0555 alone.
 *
 * *Changed 2026-11-20:* the platform's three named cross-office reads (`adoptionPerOfficeAcrossTenants`,
 * `signInsPerOfficeAcrossTenants`, `distinctAccountsAcrossTenants`) went with `/admin/analytics`, which read them
 * (P19.23-T1; ADR-0277), and their test with them.
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
      performance: await wired.kpmOverview.performance(owner),
      august: await wired.kpmOverview.performance(owner, { month: '2026-08' }),
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
      ...byKode({
        apeMonthly: cell(500 * M), apeYtd: cell(5000 * M), persistencyMonthly: cell(99), policyCountMonthly: cell(9),
        // P19.3-T1: the upload's recruitment and a unit persistency, which no figure of 0417 may read.
        recruitmentMonthly: cell(1), unitPersistencyMonthly: cell(99),
      }),
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
    await wired.abGroupTargets.set(office.ownerOfB(), bAb, { month: '2026-09', activeAgentTarget: 99, rekrutTarget: 99 });

    const after = await snapshot();
    expect(after).toEqual(before);
    expect(after.performance.total).toMatchObject({ activeAgentTarget: 0, rekrutTarget: 0 });
  }, 60_000);

  it('P19.19-T1 0555’s Owner is answered 0555 alone, and writes 0555’s targets alone', async () => {
    const b = office.ownerOfB();
    const overview = await wired.kpmOverview.read(b);
    expect(overview.office.code).toBe('0555');
    expect(overview.usage.total.of).toBe(22);
    // 0555's own September file: its root AB and twenty members at Rp 500 M each.
    expect(overview.production.months[5]).toEqual({ month: '2026-09', apeMinor: 21 * 500 * M });
    const performance = await wired.kpmOverview.performance(b);
    expect(performance.total).toMatchObject({ activeAgentTarget: 99, rekrutTarget: 99, actual: { activeAgents: 21 } });
    const everyId = JSON.stringify([overview, performance]).match(/[0-9a-f]{24}/g) ?? [];
    const of0417 = ['OWNER', 'ADMIN', 'AGUS', 'INDAH', 'DIMAS', 'SARI', 'RINA', 'BUDI', 'NINA', 'DODI', 'DEWI', 'LUKAS', 'TARI']
      .map((who) => office.id[who as keyof typeof office.id]);
    expect(everyId.filter((id) => of0417.includes(id))).toEqual([]);
    expect(await db().collection('abGroupTargets').find({}, { projection: { _id: 0, kpmId: 1, activeAgentTarget: 1 } }).toArray())
      .toEqual([{ kpmId: KPM_B, activeAgentTarget: 99 }]);
  });

  it('P19.19-T1 a WhatsApp number on the Overview is only ever a member of the reader’s office’s', async () => {
    const userId = new mongoose.Types.ObjectId(String(
      (await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.B_AGENT) }))!.userId,
    ));
    const { phone } = (await db().collection('users').findOne({ _id: userId }))!;
    await db().collection('users').updateOne({ _id: userId }, { $set: { phone: '+6281299990001' } });
    try {
      const of0555 = (await wired.kpmOverview.read(office.ownerOfB())).people;
      expect(of0555.find((p) => p.membershipId === office.id.B_AGENT)?.phone).toBe('+6281299990001');
      const of0417 = JSON.stringify(await wired.kpmOverview.read(office.as('OWNER')));
      expect(of0417).not.toContain('+6281299990001');
    } finally {
      await db().collection('users').updateOne({ _id: userId }, phone === undefined ? { $unset: { phone: '' } } : { $set: { phone } });
    }
  });
});
